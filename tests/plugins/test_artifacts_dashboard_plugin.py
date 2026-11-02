"""Tests for the Artifacts dashboard plugin backend (plugins/artifacts/dashboard/plugin_api.py).

The plugin mounts as /api/plugins/artifacts/ inside the dashboard's FastAPI app,
but here we attach its router to a bare FastAPI instance so we can test the
REST surface and security invariants without spinning up the whole dashboard.

14 test cases covering:
  Security (8):
    - root 밖 relpath → 403
    - 심링크(leaf) → 403
    - open 전/후 inode 불일치(swap) → 403
    - 중간 디렉터리 심링크 교체 → 403
    - 민감 파일 → 403
    - orphan / 캐시 미스 → 404
    - id 충돌 시 scan 실패 → 500
    - svg·html → attachment + nosniff

  Contract (4):
    - png·md → inline + nosniff
    - limit·cursor·422

  Auth note: auth is NOT tested here (bare router has no middleware).
  See tests/hermes_cli/test_web_server_artifacts.py for auth integration.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import stat
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Loader — dynamically loads plugin_api.py as a fresh module per session.
# ---------------------------------------------------------------------------

def _load_plugin_api(monkeypatch, hermes_home: Path):
    """Load plugin_api.py with HERMES_HOME pointed at hermes_home.

    We reload the module each time to ensure the process-local cache is fresh.
    """
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    repo_root = Path(__file__).resolve().parents[2]
    plugin_file = repo_root / "plugins" / "artifacts" / "dashboard" / "plugin_api.py"
    assert plugin_file.exists(), f"plugin file missing: {plugin_file}"

    # Force a fresh module each invocation so the id cache is isolated.
    mod_name = f"hermes_artifacts_plugin_api_{os.getpid()}_{time.monotonic_ns()}"
    spec = importlib.util.spec_from_file_location(mod_name, plugin_file)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _make_client(mod, hermes_home: Path) -> TestClient:
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/artifacts")
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def artifacts_env(monkeypatch, tmp_path):
    """Isolated HERMES_HOME with standard directory structure."""
    home = tmp_path / ".hermes"
    staging = home / "task-staging"
    reports = home / "reports"
    briefs = home / "kanban" / "briefs"
    staging.mkdir(parents=True)
    reports.mkdir(parents=True)
    briefs.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return home, staging, reports, briefs


@pytest.fixture
def api(monkeypatch, artifacts_env):
    home, staging, reports, briefs = artifacts_env
    mod = _load_plugin_api(monkeypatch, home)
    client = _make_client(mod, home)
    return client, mod, home, staging, reports, briefs


# ---------------------------------------------------------------------------
# Helper: seed a file and ensure it is in the cache via /items
# ---------------------------------------------------------------------------

def _seed_and_cache(client, staging, relpath, content=b"hello", *, call_items=True):
    """Write a file and trigger /items scan to populate the cache. Returns item id."""
    fpath = staging / relpath
    fpath.parent.mkdir(parents=True, exist_ok=True)
    fpath.write_bytes(content)
    if call_items:
        r = client.get("/api/plugins/artifacts/items")
        assert r.status_code == 200, r.text
        for item in r.json()["items"]:
            if item["name"] == fpath.name:
                return item["id"]
    return None


# ---------------------------------------------------------------------------
# 1. 루트 밖 relpath → 403
# ---------------------------------------------------------------------------

def test_root_escape_via_relpath_returns_403(api):
    """Content served for a cache entry whose relpath points outside root must 403."""
    client, mod, home, staging, reports, briefs = api

    # Manually inject a cache entry with a crafted relpath that escapes root.
    evil_relpath = "../../etc/passwd"
    evil_id = mod._make_id("staging", "", evil_relpath)
    ok = mod._cache_put(evil_id, "staging", "", staging, evil_relpath)
    assert ok

    r = client.get(f"/api/plugins/artifacts/content/{evil_id}")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# 2. 심링크(leaf) → 403
# ---------------------------------------------------------------------------

def test_symlink_leaf_returns_403(api, tmp_path):
    """A symlink at the leaf of the path must be refused (O_NOFOLLOW)."""
    client, mod, home, staging, reports, briefs = api

    # Create the real target outside staging
    target = tmp_path / "real.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\n")

    link = staging / "img" / "symlink.png"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(target)

    item_id = mod._make_id("staging", "", "img/symlink.png")
    mod._cache_put(item_id, "staging", "", staging, "img/symlink.png")

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# 3. open 전/후 inode 불일치(swap) → 403
# ---------------------------------------------------------------------------

def test_inode_swap_returns_403(api, monkeypatch):
    """If the inode changes between lstat and open (file swap), return 403.

    Protocol: lstat records (dev, ino) BEFORE open.  A swap that happens
    between lstat and os.open puts a new inode at the path.  When fstat on
    the open fd returns a different (dev, ino), the server must return 403.
    """
    client, mod, home, staging, reports, briefs = api

    real = staging / "swap_test.png"
    real.write_bytes(b"\x89PNG\r\n\x1a\nDATA")
    item_id = mod._make_id("staging", "", "swap_test.png")
    mod._cache_put(item_id, "staging", "", staging, "swap_test.png")

    # Intercept os.lstat to perform the swap AFTER lstat returns (so the pre-
    # open stat records inode A) but BEFORE os.open (so open sees inode B).
    real_os_lstat = os.lstat
    real_os_open = os.open
    _swapped = [False]

    def _intercept_lstat(path, *args, **kwargs):
        result = real_os_lstat(path, *args, **kwargs)
        if not _swapped[0] and "swap_test.png" in str(path):
            # Atomically replace the file with a new inode.
            replacement = staging / "_replacement.png"
            replacement.write_bytes(b"REPLACEMENT_CONTENT_DIFFERENT_INODE")
            os.rename(str(replacement), str(path))
            _swapped[0] = True
        return result

    monkeypatch.setattr(os, "lstat", _intercept_lstat)

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# 4. 중간 디렉터리 심링크 교체 → 403
# ---------------------------------------------------------------------------

def test_intermediate_directory_symlink_returns_403(api, tmp_path):
    """A symlink in an intermediate directory component must be caught by resolve()."""
    client, mod, home, staging, reports, briefs = api

    # Real directory outside staging
    real_dir = tmp_path / "real_dir"
    real_dir.mkdir()
    (real_dir / "secret.png").write_bytes(b"\x89PNG\r\n\x1a\nSECRET")

    # staging/sub → real_dir (symlink at intermediate directory level)
    link_dir = staging / "sub"
    link_dir.symlink_to(real_dir)

    item_id = mod._make_id("staging", "", "sub/secret.png")
    mod._cache_put(item_id, "staging", "", staging, "sub/secret.png")

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# 5. 민감 파일 → 403
# ---------------------------------------------------------------------------

def test_sensitive_file_returns_403(api):
    """Files matched by the real _is_sensitive_path guard must return 403.

    This exercises the real web_server._is_sensitive_path function rather
    than a stub — the .env denylist is authoritative from web_server.
    """
    client, mod, home, staging, reports, briefs = api

    # Verify the real guard is importable (test would be vacuous without it).
    try:
        from hermes_cli.web_server import _is_sensitive_path
    except ImportError:
        pytest.skip("web_server unavailable — sensitive guard not testable")

    # Write a .env file inside staging.
    env_file = staging / ".env"
    env_file.write_text("SECRET_KEY=hunter2\n")

    # Confirm the real guard considers this file sensitive.
    assert _is_sensitive_path(env_file), (
        "_is_sensitive_path must return True for .env; check web_server denylist"
    )

    item_id = mod._make_id("staging", "", ".env")
    mod._cache_put(item_id, "staging", "", staging, ".env")

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# 6. orphan / 캐시 미스 → 404
# ---------------------------------------------------------------------------

def test_cache_miss_returns_404(api):
    """An id not present in the cache must return 404."""
    client, mod, home, staging, reports, briefs = api

    r = client.get("/api/plugins/artifacts/content/deadbeefdeadbeefdeadbeef")
    assert r.status_code == 404, r.text


def test_orphan_file_missing_returns_404(api):
    """An id in the cache but file deleted must return 404."""
    client, mod, home, staging, reports, briefs = api

    ghost = staging / "gone.png"
    ghost.write_bytes(b"\x89PNG")
    item_id = mod._make_id("staging", "", "gone.png")
    mod._cache_put(item_id, "staging", "", staging, "gone.png")
    ghost.unlink()  # delete after caching

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 7. id 충돌 시 scan 실패 → 500
# ---------------------------------------------------------------------------

def test_id_collision_aborts_scan(api):
    """When two different (root_key, board, relpath) tuples hash to the same id,
    the scan must fail with 500 rather than silently serving the wrong file.
    """
    client, mod, home, staging, reports, briefs = api

    # Compute what id staging/foo.png would get.
    relpath = "foo.png"
    collision_id = mod._make_id("staging", "", relpath)

    # Pre-fill cache with a DIFFERENT tuple for the same id.
    (staging / relpath).write_bytes(b"\x89PNG\r\n\x1a\n")
    mod._cache_put(collision_id, "staging", "", staging, "DIFFERENT_relpath.png")

    # Create the file so the scanner would try to insert it.
    (staging / relpath).write_bytes(b"\x89PNG\r\n\x1a\nDATA")

    # Override _make_id to always return collision_id for staging/foo.png
    original_make_id = mod._make_id

    def _collision_id(rk, board, rp):
        if rp == relpath and rk == "staging":
            return collision_id
        return original_make_id(rk, board, rp)

    mod._make_id = _collision_id

    r = client.get("/api/plugins/artifacts/items")
    # Collision must surface as a 500.
    assert r.status_code == 500, r.text


# ---------------------------------------------------------------------------
# 8. svg·html → attachment + nosniff
# ---------------------------------------------------------------------------

def test_svg_served_as_attachment_with_nosniff(api):
    """SVG files must be served as application/octet-stream + attachment, never inline."""
    client, mod, home, staging, reports, briefs = api

    f = staging / "image.svg"
    f.write_bytes(b"<svg><script>alert(1)</script></svg>")
    item_id = _seed_and_cache(client, staging, "image.svg", b"<svg/>")

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", ""), r.headers
    assert r.headers.get("content-type", "").startswith("application/octet-stream"), r.headers
    assert r.headers.get("x-content-type-options") == "nosniff", r.headers


def test_html_served_as_attachment_with_nosniff(api):
    """HTML files must be served as octet-stream + attachment."""
    client, mod, home, staging, reports, briefs = api

    item_id = _seed_and_cache(client, staging, "page.html", b"<html><body>hi</body></html>")
    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", ""), r.headers
    assert r.headers.get("x-content-type-options") == "nosniff", r.headers


# ---------------------------------------------------------------------------
# 9. png·md → inline + nosniff
# ---------------------------------------------------------------------------

def test_png_served_inline_with_nosniff(api):
    """PNG files must be served inline as image/png with nosniff."""
    client, mod, home, staging, reports, briefs = api

    item_id = _seed_and_cache(client, staging, "photo.png", b"\x89PNG\r\n\x1a\nDATA")
    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 200, r.text
    assert r.headers.get("content-disposition", "") == "inline", r.headers
    assert r.headers.get("content-type", "").startswith("image/png"), r.headers
    assert r.headers.get("x-content-type-options") == "nosniff", r.headers


def test_md_served_inline_as_text_plain_with_nosniff(api):
    """Markdown files must be served inline as text/plain with nosniff."""
    client, mod, home, staging, reports, briefs = api

    item_id = _seed_and_cache(client, staging, "README.md", b"# Hello")
    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 200, r.text
    assert r.headers.get("content-disposition", "") == "inline", r.headers
    ct = r.headers.get("content-type", "")
    assert ct.startswith("text/plain"), f"Expected text/plain, got {ct}"
    assert r.headers.get("x-content-type-options") == "nosniff", r.headers


# ---------------------------------------------------------------------------
# 10. limit·cursor·422
# ---------------------------------------------------------------------------

def test_items_invalid_kind_returns_422(api):
    client, mod, home, staging, reports, briefs = api
    r = client.get("/api/plugins/artifacts/items", params={"kind": "banana"})
    assert r.status_code == 422, r.text


def test_items_invalid_source_returns_422(api):
    client, mod, home, staging, reports, briefs = api
    r = client.get("/api/plugins/artifacts/items", params={"source": "s3"})
    assert r.status_code == 422, r.text


def test_items_q_too_long_returns_422(api):
    client, mod, home, staging, reports, briefs = api
    r = client.get("/api/plugins/artifacts/items", params={"q": "x" * 101})
    assert r.status_code == 422, r.text


def test_items_limit_and_cursor_pagination(api):
    """Verify that limit and cursor produce non-overlapping pages."""
    client, mod, home, staging, reports, briefs = api

    # Create 5 files.
    for i in range(5):
        (staging / f"file{i:02d}.png").write_bytes(b"\x89PNG")

    # First page: limit=2
    r1 = client.get("/api/plugins/artifacts/items", params={"limit": 2})
    assert r1.status_code == 200, r1.text
    d1 = r1.json()
    assert len(d1["items"]) == 2
    assert d1["next_cursor"] is not None

    # Second page
    r2 = client.get("/api/plugins/artifacts/items", params={"limit": 2, "cursor": d1["next_cursor"]})
    assert r2.status_code == 200, r2.text
    d2 = r2.json()
    assert len(d2["items"]) == 2

    # No overlap
    ids1 = {i["id"] for i in d1["items"]}
    ids2 = {i["id"] for i in d2["items"]}
    assert ids1.isdisjoint(ids2), f"Pages overlap: {ids1 & ids2}"

    # Last page
    r3 = client.get("/api/plugins/artifacts/items", params={"limit": 2, "cursor": d2["next_cursor"]})
    assert r3.status_code == 200, r3.text
    d3 = r3.json()
    assert len(d3["items"]) == 1
    assert d3["next_cursor"] is None


def test_items_invalid_cursor_returns_422(api):
    client, mod, home, staging, reports, briefs = api
    r = client.get("/api/plugins/artifacts/items", params={"cursor": "not-valid-base64-garbage!!!"})
    assert r.status_code == 422, r.text


# ---------------------------------------------------------------------------
# 11. openat 중간 디렉터리 심링크 race → 403
# ---------------------------------------------------------------------------

def test_intermediate_dir_symlink_race_returns_403(api, monkeypatch, tmp_path):
    """openat walk catches a symlink race on an intermediate directory.

    Demonstrates that _open_component_walk()'s per-component O_NOFOLLOW walk
    catches a TOCTOU attack where:
      1. Containment check (normpath) passes while staging/racetest is a real dir.
      2. Between os.open(root) and the first component open, the adversary swaps
         staging/racetest with a symlink pointing outside staging.
      3. os.open("racetest", O_RDONLY|O_NOFOLLOW|O_DIRECTORY, dir_fd=root_fd)
         sees the symlink and fails with ELOOP → 403.

    The old path-based resolve()+open() approach would miss this race:
    resolve() can succeed before the swap, but open() would follow the now-
    symlinked path after it.
    """
    client, mod, home, staging, reports, briefs = api

    # Set up a real subdirectory with a file.
    sub = staging / "racetest"
    sub.mkdir()
    target_file = sub / "photo.png"
    target_file.write_bytes(b"\x89PNG\r\n\x1a\nDATA")

    # Evil directory outside staging.
    evil_dir = tmp_path / "evil"
    evil_dir.mkdir()
    (evil_dir / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\nEVIL")

    item_id = mod._make_id("staging", "", "racetest/photo.png")
    mod._cache_put(item_id, "staging", "", staging, "racetest/photo.png")

    # Intercept os.open: after opening the root (staging) directory, atomically
    # replace staging/racetest with a symlink to evil_dir.
    real_os_open = os.open
    _swapped = [False]

    def _intercept_open(path_or_name, flags, mode=0o777, *, dir_fd=None):
        result = real_os_open(path_or_name, flags, mode, dir_fd=dir_fd)
        # Only trigger the swap once — after opening the root directory itself.
        if not _swapped[0] and dir_fd is None and str(path_or_name) == str(staging):
            # Empty then remove the real subdirectory, replace with a symlink.
            target_file.unlink()
            sub.rmdir()
            sub.symlink_to(evil_dir)
            _swapped[0] = True
        return result

    monkeypatch.setattr(os, "open", _intercept_open)

    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    # The symlink race must be caught — the response must be a security rejection.
    assert r.status_code == 403, (
        f"Expected 403 for intermediate-dir symlink race, got {r.status_code}: {r.text}"
    )


# ---------------------------------------------------------------------------
# 12. TTL 만료 → 404
# ---------------------------------------------------------------------------

def test_cache_ttl_expiry_returns_404(api, monkeypatch):
    """After the cache TTL expires the entry is evicted and content returns 404."""
    client, mod, home, staging, reports, briefs = api

    f = staging / "ttl_test.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\nDATA")

    # Use an imperceptibly small TTL so the entry expires immediately.
    monkeypatch.setattr(mod, "_CACHE_TTL", 0.0)

    item_id = mod._make_id("staging", "", "ttl_test.png")
    mod._cache_put(item_id, "staging", "", staging, "ttl_test.png")

    # The TTL was 0 s — the entry is already expired.
    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 13. .htm → attachment + nosniff
# ---------------------------------------------------------------------------

def test_htm_served_as_attachment_with_nosniff(api):
    """.htm files must be served as application/octet-stream + attachment + nosniff."""
    client, mod, home, staging, reports, briefs = api

    item_id = _seed_and_cache(client, staging, "report.htm", b"<html>hi</html>")
    r = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", ""), r.headers
    assert r.headers.get("content-type", "").startswith("application/octet-stream"), r.headers
    assert r.headers.get("x-content-type-options") == "nosniff", r.headers


# ---------------------------------------------------------------------------
# 14. /projects id 충돌 → 500
# ---------------------------------------------------------------------------

def test_projects_id_collision_returns_500(api):
    """ID collision during /projects scan must surface as 500.

    Previously get_projects() discarded collision_errors from _scan_root().
    This test confirms the fix: a collision now raises HTTPException(500) from
    /projects just as it does from /items.
    """
    client, mod, home, staging, reports, briefs = api

    relpath = "proj_collision.png"
    collision_id = mod._make_id("staging", "", relpath)

    # Pre-fill cache with a DIFFERENT tuple for the same id (fake collision).
    (staging / relpath).write_bytes(b"\x89PNG\r\n\x1a\n")
    mod._cache_put(collision_id, "staging", "", staging, "DIFFERENT.png")

    original_make_id = mod._make_id

    def _collision_id(rk, board, rp):
        if rp == relpath and rk == "staging":
            return collision_id
        return original_make_id(rk, board, rp)

    mod._make_id = _collision_id

    r = client.get("/api/plugins/artifacts/projects")
    assert r.status_code == 500, r.text


# ---------------------------------------------------------------------------
# 15. process-home override — behavioral: get_process_hermes_home() 호출 증명
# ---------------------------------------------------------------------------

def test_process_hermes_home_ignores_contextvar_override(monkeypatch, tmp_path):
    """plugin_api._get_roots() must call get_process_hermes_home(), not read env directly.

    Proof by substitution:
      - HERMES_HOME env var → req_home  (no file; a buggy plugin reading env gets this)
      - mod.get_process_hermes_home monkeypatched → launch_home  (has the file)

    /items: if plugin calls get_process_hermes_home() → launch_home → real.png found.
            if plugin reads HERMES_HOME directly      → req_home   → real.png missing → assertion fails.
    /content: verifies the cached entry is served correctly.

    Module-level name bindings are shared across threads, so monkeypatching
    mod.get_process_hermes_home is visible inside the TestClient worker thread
    without requiring ContextVar propagation across thread boundaries.
    """
    # Launch home — contains the file we'll serve.
    launch_home = tmp_path / "launch"
    (launch_home / "task-staging").mkdir(parents=True)
    (launch_home / "reports").mkdir(parents=True)
    (launch_home / "kanban" / "briefs").mkdir(parents=True)
    f = launch_home / "task-staging" / "real.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\nRESULT")

    # Request-scoped home — different, does NOT contain the file.
    req_home = tmp_path / "request"
    (req_home / "task-staging").mkdir(parents=True)
    (req_home / "reports").mkdir(parents=True)
    (req_home / "kanban" / "briefs").mkdir(parents=True)

    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    # Load the plugin module (this also sets HERMES_HOME=launch_home via monkeypatch).
    mod = _load_plugin_api(monkeypatch, launch_home)

    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/artifacts")
    client = TestClient(app, raise_server_exceptions=False)

    # Now point HERMES_HOME to req_home (no file).
    # A buggy plugin reading os.environ["HERMES_HOME"] directly would scan req_home.
    monkeypatch.setenv("HERMES_HOME", str(req_home))

    # Override get_process_hermes_home in the fresh module's namespace to return
    # launch_home — simulating "process was launched under launch_home; env was
    # later changed by a per-request profile override".
    monkeypatch.setattr(mod, "get_process_hermes_home", lambda: launch_home)

    # /items: plugin must call mod.get_process_hermes_home() → launch_home → real.png found.
    r = client.get("/api/plugins/artifacts/items")
    assert r.status_code == 200
    items = r.json()["items"]
    item = next((i for i in items if i["name"] == "real.png"), None)
    assert item is not None, (
        f"real.png must appear: plugin must call get_process_hermes_home() "
        f"(→ launch_home). HERMES_HOME env now points to req_home (no file). "
        f"Items: {[i['name'] for i in items]}"
    )
    item_id = item["id"]

    # /content: cached entry references launch_home path — must return 200.
    r2 = client.get(f"/api/plugins/artifacts/content/{item_id}")
    assert r2.status_code == 200, (
        f"Expected 200 — plugin must use get_process_hermes_home() (launch_home={launch_home}), "
        f"not HERMES_HOME env (→ req_home={req_home}). "
        f"Got {r2.status_code}: {r2.text}"
    )
