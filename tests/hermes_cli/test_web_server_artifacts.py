"""Full-app integration tests for the Artifacts dashboard plugin auth.

Tests that the artifacts plugin routes go through the dashboard's real
auth_middleware — not just the bare router.

Follows the pattern established in tests/hermes_cli/test_web_server_files.py
(lines 267-333) and tests/hermes_cli/test_dashboard_auth_middleware.py.

Test cases:
  - Token header mode: authenticated request returns 200
  - Unauthenticated request returns 401
  - Cookie mode: real OAuth round-trip (StubAuthProvider) returns 200
  - Invalid / expired cookie returns 401
  - process-home behavioral: plugin route uses get_process_hermes_home()
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider


# ---------------------------------------------------------------------------
# Shared helpers (mirror test_web_server_files.py pattern)
# ---------------------------------------------------------------------------

def _client_with_app_state():
    prev_auth_required = getattr(web_server.app.state, "auth_required", None)
    prev_bound_host = getattr(web_server.app.state, "bound_host", None)
    web_server.app.state.auth_required = False
    web_server.app.state.bound_host = None

    client = TestClient(web_server.app, raise_server_exceptions=False)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, prev_auth_required, prev_bound_host


def _restore_app_state(prev_auth_required, prev_bound_host):
    if prev_auth_required is None:
        if hasattr(web_server.app.state, "auth_required"):
            delattr(web_server.app.state, "auth_required")
    else:
        web_server.app.state.auth_required = prev_auth_required
    if prev_bound_host is None:
        if hasattr(web_server.app.state, "bound_host"):
            delattr(web_server.app.state, "bound_host")
    else:
        web_server.app.state.bound_host = prev_bound_host


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def artifacts_fullapp_client(monkeypatch, tmp_path):
    """Full web_server.app client with HERMES_HOME isolated to tmp_path."""
    home = tmp_path / ".hermes"
    staging = home / "task-staging"
    staging.mkdir(parents=True)
    (home / "reports").mkdir(parents=True)
    (home / "kanban" / "briefs").mkdir(parents=True)

    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    client, prev_auth_required, prev_bound_host = _client_with_app_state()
    try:
        yield client, home, staging
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass
        _restore_app_state(prev_auth_required, prev_bound_host)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_artifacts_items_authenticated_via_token_header(artifacts_fullapp_client):
    """Authenticated request (token header) to /api/plugins/artifacts/items returns 200.

    The route must be mounted (404 would mean the plugin wasn't discovered).
    """
    client, home, staging = artifacts_fullapp_client

    r = client.get("/api/plugins/artifacts/items")
    assert r.status_code == 200, (
        f"Expected 200 — plugin must be mounted and auth must pass. "
        f"Got {r.status_code}: {r.text}"
    )


def test_artifacts_items_unauthenticated_returns_401(artifacts_fullapp_client):
    """Unauthenticated request (no token) to /api/plugins/artifacts/items returns 401."""
    client, home, staging = artifacts_fullapp_client

    # Remove the session header so the request has no credentials.
    del client.headers[web_server._SESSION_HEADER_NAME]

    r = client.get("/api/plugins/artifacts/items")
    assert r.status_code == 401, (
        f"Expected 401 without auth, got {r.status_code}: {r.text}"
    )


def test_artifacts_items_authenticated_via_cookie(monkeypatch, tmp_path):
    """Cookie-based session auth (gated/OAuth mode) returns 200.

    Walks the full stub OAuth round trip (StubAuthProvider →
    /auth/login → /auth/callback) so the TestClient's cookie jar
    carries real hermes_session_at / hermes_session_rt cookies.
    No middleware mocks — the production gated_auth_middleware is
    exercised end-to-end.
    """
    home = tmp_path / ".hermes"
    (home / "task-staging").mkdir(parents=True)
    (home / "reports").mkdir(parents=True)
    (home / "kanban" / "briefs").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    clear_providers()
    register_provider(StubAuthProvider())

    prev_auth = getattr(web_server.app.state, "auth_required", None)
    prev_host = getattr(web_server.app.state, "bound_host", None)
    web_server.app.state.auth_required = True
    web_server.app.state.bound_host = None

    client = None
    try:
        client = TestClient(web_server.app, raise_server_exceptions=False)
        # Walk the stub OAuth round trip to populate the cookie jar with
        # real hermes_session_at / hermes_session_rt cookies.
        r1 = client.get("/auth/login?provider=stub", follow_redirects=False)
        assert r1.status_code == 302, (
            f"Stub login start failed: {r1.status_code} {r1.text}"
        )
        state = r1.headers["location"].split("state=")[1]
        r2 = client.get(
            f"/auth/callback?code=stub_code&state={state}",
            follow_redirects=False,
        )
        assert r2.status_code == 302, (
            f"Stub login callback failed: {r2.status_code} {r2.text}"
        )

        # Cookie jar now holds hermes_session_at — production gate must pass.
        r = client.get("/api/plugins/artifacts/items")
        assert r.status_code == 200, (
            f"Expected 200 with valid session cookie (gated auth mode). "
            f"Got {r.status_code}: {r.text}"
        )
    finally:
        _restore_app_state(prev_auth, prev_host)
        clear_providers()
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass


def test_artifacts_items_expired_cookie_returns_401(monkeypatch, tmp_path):
    """Invalid / expired session cookie → 401 in gated auth mode.

    Sets a garbage hermes_session_at cookie with no refresh token.
    The middleware verifies the AT (fails), attempts refresh (no RT
    present), and returns 401.
    """
    home = tmp_path / ".hermes"
    (home / "task-staging").mkdir(parents=True)
    (home / "reports").mkdir(parents=True)
    (home / "kanban" / "briefs").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    clear_providers()
    register_provider(StubAuthProvider())

    prev_auth = getattr(web_server.app.state, "auth_required", None)
    prev_host = getattr(web_server.app.state, "bound_host", None)
    web_server.app.state.auth_required = True
    web_server.app.state.bound_host = None

    client = None
    try:
        client = TestClient(web_server.app, raise_server_exceptions=False)
        # Set a garbage access-token cookie (not a real signed stub token).
        client.cookies.set("hermes_session_at", "this-is-not-a-valid-token")

        r = client.get("/api/plugins/artifacts/items")
        assert r.status_code == 401, (
            f"Expected 401 with invalid session cookie (no valid AT, no RT). "
            f"Got {r.status_code}: {r.text}"
        )
    finally:
        _restore_app_state(prev_auth, prev_host)
        clear_providers()
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass


def test_artifacts_plugin_uses_process_hermes_home(monkeypatch, tmp_path):
    """Full-app behavioral test: plugin route must call get_process_hermes_home().

    Proof by substitution: monkeypatch get_process_hermes_home in the plugin
    module to return launch_home (which has a file), while HERMES_HOME env var
    points to req_home (no file).

    If the plugin calls get_process_hermes_home() [correct]:
        → launch_home → file found → 200 with evidence.txt in items.
    If the plugin bypasses the function and reads HERMES_HOME directly [bug]:
        → req_home → file absent → evidence.txt not in items → assertion fails.

    web_server._mount_plugin_api_routes() loads the plugin under the module
    name ``hermes_dashboard_plugin_artifacts`` (not the dotted package path).
    We patch that module — the same namespace the route handlers use.
    """
    import sys
    _plugin_api = sys.modules.get("hermes_dashboard_plugin_artifacts")
    if _plugin_api is None:
        pytest.skip("hermes_dashboard_plugin_artifacts not loaded in web_server.app")

    # Launch home: process was launched here; contains the artifact.
    launch_home = tmp_path / "launch_home"
    (launch_home / "task-staging").mkdir(parents=True)
    (launch_home / "reports").mkdir(parents=True)
    (launch_home / "kanban" / "briefs").mkdir(parents=True)
    (launch_home / "task-staging" / "evidence.txt").write_bytes(b"from launch home")

    # Request-scoped home: no artifacts — a buggy plugin reading env would land here.
    req_home = tmp_path / "req_home"
    (req_home / "task-staging").mkdir(parents=True)
    (req_home / "reports").mkdir(parents=True)
    (req_home / "kanban" / "briefs").mkdir(parents=True)

    # Point the env var at req_home; correct plugin must NOT read it directly.
    monkeypatch.setenv("HERMES_HOME", str(req_home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    # Override get_process_hermes_home at the plugin module level so it
    # returns launch_home (simulating: process launched with launch_home,
    # env var later changed to req_home by per-request profile override).
    # Module-level bindings are shared across threads, so the request handler
    # sees this patch even when TestClient dispatches in its worker thread.
    monkeypatch.setattr(_plugin_api, "get_process_hermes_home", lambda: launch_home)

    client, prev_auth, prev_host = _client_with_app_state()
    try:
        r = client.get("/api/plugins/artifacts/items")
        assert r.status_code == 200, (
            f"Expected 200 from full-app artifacts route. "
            f"Got {r.status_code}: {r.text}"
        )
        items = r.json()["items"]
        names = [i["name"] for i in items]
        assert "evidence.txt" in names, (
            f"Plugin must call get_process_hermes_home() (→ launch_home, has file). "
            f"HERMES_HOME env points to req_home (no file). "
            f"Items returned (should include evidence.txt): {names}"
        )
    finally:
        _restore_app_state(prev_auth, prev_host)
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass
