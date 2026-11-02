"""Artifacts dashboard plugin — backend API routes.

Mounted at /api/plugins/artifacts/ by the dashboard plugin system.

Trusted boundary
----------------
Files are served only from four roots anchored to the process-launch
HERMES_HOME (``get_process_hermes_home()``):

  * ``<home>/task-staging/``   — root_key "staging"
  * ``<home>/reports/``        — root_key "reports"
  * ``<home>/kanban/briefs/``  — root_key "briefs"
  * Kanban attachment dirs      — root_key "kanban:<board-slug>"

``_is_sensitive_path`` (from web_server) is a secondary defence against
known-sensitive filenames and credential directories.  The primary defence
is that every served path must be reachable within one of the four roots.

Verified-FD serving
--------------------
For every ``GET /content/{id}`` request the handler:
  1. Resolves id → (root_key, board, root, relpath) from the process-local
     TTL cache (populated during /items scans).
  2. ``lstat`` the target — records (st_dev, st_ino).
  3. ``resolve().relative_to(root)`` — detects symlink escape via full
     path resolution.
  4. ``os.open(path, O_RDONLY | O_NOFOLLOW)`` — refuses a symlink leaf.
  5. ``fstat(fd)`` — compares (st_dev, st_ino) against step 2 (swap
     detection); mismatch → 403.
  6. Streams via ``StreamingResponse`` on the verified fd.
  ``FileResponse(path)`` is never used — it would re-open the path and
  lose the verified fd.

Security note
-------------
Plugin HTTP routes go through the dashboard's session-token auth
middleware (``web_server.auth_middleware``) just like core API routes.
"""

from __future__ import annotations

import errno
import hashlib
import logging
import os
import stat
import threading
import time
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from hermes_constants import get_process_hermes_home

log = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_CONTENT_SIZE_LIMIT = 100 * 1024 * 1024  # 100 MB

_INLINE_MIME: dict[str, str] = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".webp": "image/webp",
    ".md":   "text/plain; charset=utf-8",
    ".txt":  "text/plain; charset=utf-8",
    ".csv":  "text/plain; charset=utf-8",
    ".log":  "text/plain; charset=utf-8",
    ".json": "text/plain; charset=utf-8",
    ".yaml": "text/plain; charset=utf-8",
    ".yml":  "text/plain; charset=utf-8",
    ".pdf":  "application/pdf",
}

# Extensions that must never be served inline (active content risk).
_FORCE_DOWNLOAD_EXTS: frozenset[str] = frozenset({".svg", ".html", ".htm"})

# ---------------------------------------------------------------------------
# Process-local TTL id cache
# ---------------------------------------------------------------------------
# Maps opaque id → (root_key, board, root_path, relpath_str)
# TTL: 60 s.  Protected by a threading.Lock for thread-safety.

_CACHE_TTL = 60.0

_cache_lock = threading.Lock()
_id_cache: dict[str, tuple[Any, ...]] = {}   # id → (root_key, board, root, relpath, expire_at)


def _cache_put(item_id: str, root_key: str, board: str, root: Path, relpath: str) -> bool:
    """Insert (root_key, board, root, relpath) into the cache.

    Returns False and logs a warning if the id already maps to a DIFFERENT
    tuple (hash collision / root_key mismatch → scan must fail).
    Returns True on success or when the exact same tuple is re-inserted.
    """
    entry = (root_key, board, str(root), relpath)
    expire_at = time.monotonic() + _CACHE_TTL
    with _cache_lock:
        existing = _id_cache.get(item_id)
        if existing is not None:
            stored = existing[:4]
            if stored != entry:
                log.error(
                    "Artifacts id collision: id=%s maps to %r but scan produced %r — "
                    "aborting scan to prevent ambiguous content serving",
                    item_id, stored, entry,
                )
                return False
        _id_cache[item_id] = (*entry, expire_at)
        return True


def _cache_get(item_id: str) -> Optional[tuple[str, str, Path, str]]:
    """Retrieve (root_key, board, root, relpath) or None on miss/expiry."""
    with _cache_lock:
        entry = _id_cache.get(item_id)
        if entry is None:
            return None
        root_key, board, root_str, relpath, expire_at = entry
        if time.monotonic() > expire_at:
            del _id_cache[item_id]
            return None
        return root_key, board, Path(root_str), relpath


def _make_id(root_key: str, board: str, relpath: str) -> str:
    """Compute the opaque id for a (root_key, board, relpath) tuple."""
    data = f"{root_key}\x00{board}\x00{relpath}".encode()
    return hashlib.sha256(data).hexdigest()[:24]


# ---------------------------------------------------------------------------
# MIME / content-disposition helpers
# ---------------------------------------------------------------------------


def _mime_and_disposition(name: str) -> tuple[str, str]:
    """Return (content_type, disposition) determined solely from filename extension."""
    ext = Path(name).suffix.lower()
    if ext in _FORCE_DOWNLOAD_EXTS:
        return "application/octet-stream", "attachment"
    mime = _INLINE_MIME.get(ext)
    if mime is not None:
        return mime, "inline"
    return "application/octet-stream", "attachment"


# ---------------------------------------------------------------------------
# Sensitive path guard (re-uses the web_server helper)
# ---------------------------------------------------------------------------


def _check_sensitive(path: Path) -> None:
    """Raise HTTPException 403 if path is sensitive.

    Imports lazily to avoid a circular import at module load time.
    """
    try:
        from hermes_cli.web_server import _is_sensitive_path  # type: ignore[import]
        if _is_sensitive_path(path):
            raise HTTPException(status_code=403, detail="Forbidden")
    except ImportError:
        pass


# ---------------------------------------------------------------------------
# Verified-FD content serving
# ---------------------------------------------------------------------------


def _serve_fd(path: Path, root: Path) -> StreamingResponse:
    """Open path with full verified-FD protocol and return a StreamingResponse.

    Protocol (see module docstring for details):
      1. lstat → record dev/ino, confirm S_ISREG.
      2. resolve().relative_to(root) — symlink escape detection.
      3. os.open with O_RDONLY|O_NOFOLLOW — refuse symlink at leaf.
      4. fstat → compare dev/ino (swap detection).
      5. _is_sensitive_path check.
      6. Stream via os.fdopen / StreamingResponse.

    FileResponse(path) is intentionally NOT used.
    """
    # Step 0: containment check via normpath (no FS access, catches ../.. escapes)
    try:
        normalized = Path(os.path.normpath(root / path.relative_to(root)))
    except ValueError:
        raise HTTPException(status_code=403, detail="Forbidden")
    try:
        normalized.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Forbidden")

    # Step 1: lstat (follows no symlinks itself — we want the leaf info)
    try:
        pre_stat = os.lstat(path)
    except OSError as exc:
        if exc.errno in (errno.ENOENT, errno.ENOTDIR):
            raise HTTPException(status_code=404, detail="Not found")
        raise HTTPException(status_code=403, detail="Forbidden") from exc

    if not stat.S_ISREG(pre_stat.st_mode):
        raise HTTPException(status_code=403, detail="Forbidden")

    pre_dev, pre_ino = pre_stat.st_dev, pre_stat.st_ino

    # Step 2: resolve full path — detects intermediate symlinks too
    try:
        resolved = path.resolve()
        resolved.relative_to(root.resolve())
    except (ValueError, OSError):
        raise HTTPException(status_code=403, detail="Forbidden")

    # Step 3: open with O_NOFOLLOW to refuse a symlink at the final component
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOENT, errno.ENOTDIR):
            raise HTTPException(status_code=403, detail="Forbidden")
        raise HTTPException(status_code=403, detail="Forbidden") from exc

    try:
        # Step 4: fstat and compare dev/ino (TOCTOU / swap detection)
        post_stat = os.fstat(fd)
        if (post_stat.st_dev, post_stat.st_ino) != (pre_dev, pre_ino):
            log.warning("Artifacts: inode mismatch for %s — rejecting (possible swap)", path)
            raise HTTPException(status_code=403, detail="Forbidden")

        if not stat.S_ISREG(post_stat.st_mode):
            raise HTTPException(status_code=403, detail="Forbidden")

        if post_stat.st_size > _CONTENT_SIZE_LIMIT:
            raise HTTPException(status_code=413, detail="File too large")

        # Step 5: sensitive-path check
        _check_sensitive(path)

        # Step 6: stream on the verified fd
        content_type, disposition_type = _mime_and_disposition(path.name)
        file_size = post_stat.st_size

        file_obj = os.fdopen(fd, "rb")
        fd = -1  # ownership transferred — don't double-close

        async def _gen() -> AsyncGenerator[bytes, None]:
            try:
                while True:
                    chunk = file_obj.read(65536)
                    if not chunk:
                        break
                    yield chunk
            finally:
                file_obj.close()

        filename_safe = path.name.replace('"', "_")
        if disposition_type == "attachment":
            content_disposition = f'attachment; filename="{filename_safe}"'
        else:
            content_disposition = "inline"

        return StreamingResponse(
            _gen(),
            media_type=content_type,
            headers={
                "Content-Disposition": content_disposition,
                "Content-Length": str(file_size),
                "X-Content-Type-Options": "nosniff",
            },
        )

    except HTTPException:
        raise
    finally:
        if fd != -1:
            os.close(fd)


# ---------------------------------------------------------------------------
# Root helpers
# ---------------------------------------------------------------------------


def _get_roots() -> dict[str, tuple[str, str, Path]]:
    """Return {root_key: (root_key, board, root_path)} for the four trusted roots.

    board is "" for non-kanban roots; populated from the kanban DB for
    kanban attachment roots (handled separately in the indexer).
    """
    home = get_process_hermes_home()
    return {
        "staging": ("staging", "", home / "task-staging"),
        "reports":  ("reports",  "", home / "reports"),
        "briefs":   ("briefs",   "", home / "kanban" / "briefs"),
    }


# ---------------------------------------------------------------------------
# Shallow scanner helpers (used by /items)
# ---------------------------------------------------------------------------


_KIND_BY_EXT: dict[str, str] = {
    ".png": "image", ".jpg": "image", ".jpeg": "image",
    ".gif": "image", ".webp": "image",
    ".pdf": "doc",
    ".md": "text", ".txt": "text", ".csv": "text",
    ".log": "text", ".json": "text", ".yaml": "text", ".yml": "text",
}

_VALID_KINDS = frozenset({"image", "doc", "text", "other", "all"})
_VALID_SOURCES = frozenset({"staging", "kanban", "reports", "all"})

# Default topic_map used if config override not present.
_DEFAULT_TOPIC_MAP = [
    {"prefix": "grand-voyage", "project": "sinhangro"},
    {"prefix": "hermes-",     "project": "hermes-stab"},
    {"prefix": "claude-",     "project": "hermes-stab"},
]


def _load_topic_map() -> list[dict]:
    try:
        from hermes_cli.config import load_config  # type: ignore[import]
        cfg = load_config()
        override = (
            cfg.get("dashboard", {})
            .get("artifacts", {})
            .get("topic_map")
        )
        if override and isinstance(override, list):
            # Validate: each entry must have prefix and project strings.
            validated = [
                e for e in override
                if isinstance(e, dict) and isinstance(e.get("prefix"), str) and isinstance(e.get("project"), str)
            ]
            if len(validated) != len(override):
                log.warning("Artifacts: topic_map override has invalid entries; using defaults for those")
            return validated or _DEFAULT_TOPIC_MAP
    except Exception:  # noqa: BLE001
        pass
    return _DEFAULT_TOPIC_MAP


def _map_project(group: str, topic_map: list[dict]) -> str:
    for rule in topic_map:
        if group.startswith(rule["prefix"]):
            return rule["project"]
    return "_unassigned"


def _file_kind(ext: str) -> str:
    return _KIND_BY_EXT.get(ext.lower(), "other")


def _scan_root(
    root_key: str,
    board: str,
    root: Path,
    topic_map: list[dict],
    *,
    max_depth: int = 3,
    max_items: int = 2000,
    deadline_secs: float = 2.0,
) -> tuple[list[dict], bool, list[str]]:
    """Walk root up to max_depth, max_items items, within deadline.

    Returns (items, truncated, collision_errors).
    collision_errors is non-empty if a hash collision was detected.
    """
    items: list[dict] = []
    truncated = False
    collision_errors: list[str] = []
    deadline = time.monotonic() + deadline_secs

    def _walk(path: Path, depth: int) -> bool:
        nonlocal truncated
        if time.monotonic() > deadline:
            truncated = True
            return False
        if depth > max_depth:
            return True
        try:
            entries = list(path.iterdir())
        except PermissionError:
            return True

        for entry in entries:
            if time.monotonic() > deadline:
                truncated = True
                return False
            if len(items) >= max_items:
                truncated = True
                return False
            # Skip symlinks entirely.
            try:
                lst = entry.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(lst.st_mode):
                continue
            if stat.S_ISDIR(lst.st_mode):
                if not _walk(entry, depth + 1):
                    return False
            elif stat.S_ISREG(lst.st_mode):
                try:
                    relpath = str(entry.relative_to(root))
                except ValueError:
                    continue
                ext = entry.suffix.lower()
                item_id = _make_id(root_key, board, relpath)
                mime, _ = _mime_and_disposition(entry.name)
                kind = _file_kind(ext)
                # Group = immediate parent relative to root (or root_key if at top)
                parts = Path(relpath).parts
                group = str(Path(*parts[:-1])) if len(parts) > 1 else root_key
                project = _map_project(parts[0] if parts else "", topic_map)

                item = {
                    "id":      item_id,
                    "name":    entry.name,
                    "kind":    kind,
                    "mime":    mime,
                    "size":    lst.st_size,
                    "mtime":   int(lst.st_mtime),
                    "source":  root_key if root_key in ("staging", "reports", "briefs") else "kanban",
                    "group":   group,
                    "project": project,
                    "task":    None,
                    "orphan":  False,
                }
                ok = _cache_put(item_id, root_key, board, root, relpath)
                if not ok:
                    collision_errors.append(item_id)
                else:
                    items.append(item)
        return True

    _walk(root, 0)
    return items, truncated, collision_errors


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/projects")
def get_projects() -> dict:
    """List known projects for the artifacts browser."""
    home = get_process_hermes_home()
    topic_map = _load_topic_map()

    projects: dict[str, int] = {}
    unassigned_count = 0

    roots = _get_roots()
    for root_key, (_, board, root) in roots.items():
        if not root.exists():
            continue
        items, _, _ = _scan_root(root_key, board, root, topic_map, max_items=2000)
        for item in items:
            proj = item["project"]
            if proj == "_unassigned":
                unassigned_count += 1
            else:
                projects[proj] = projects.get(proj, 0) + 1

    project_list = [
        {"slug": slug, "name": slug, "count": count}
        for slug, count in sorted(projects.items())
    ]

    import socket
    profile = home.name if home.name != ".hermes" else "default"

    return {
        "profile": profile,
        "projects": project_list,
        "unassigned_count": unassigned_count,
    }


@router.get("/items")
def get_items(
    project: str = Query("all"),
    kind: str = Query("all"),
    source: str = Query("all"),
    q: str = Query(""),
    limit: int = Query(50, ge=1, le=200),
    cursor: str = Query(""),
) -> dict:
    """List artifact items with pagination."""
    if kind not in _VALID_KINDS:
        raise HTTPException(status_code=422, detail=f"Invalid kind: {kind!r}. Must be one of {sorted(_VALID_KINDS)}")
    if source not in _VALID_SOURCES:
        raise HTTPException(status_code=422, detail=f"Invalid source: {source!r}. Must be one of {sorted(_VALID_SOURCES)}")
    if len(q) > 100:
        raise HTTPException(status_code=422, detail="q must be ≤ 100 characters")

    home = get_process_hermes_home()
    topic_map = _load_topic_map()
    profile = home.name if home.name != ".hermes" else "default"

    t0 = time.monotonic()
    all_items: list[dict] = []
    truncated = False

    roots = _get_roots()
    for root_key, (rk, board, root) in roots.items():
        if source != "all":
            # Map source filter to root_keys
            if source == "staging" and root_key != "staging":
                continue
            if source == "reports" and root_key not in ("reports", "briefs"):
                continue
            if source == "kanban":
                continue  # kanban handled separately (no root here)
        if not root.exists():
            continue
        items, trunc, collisions = _scan_root(rk, board, root, topic_map)
        if trunc:
            truncated = True
        if collisions:
            raise HTTPException(status_code=500, detail="ID collision detected during scan")
        all_items.extend(items)

    # Apply filters
    filtered = all_items
    if kind != "all":
        filtered = [i for i in filtered if i["kind"] == kind]
    if project != "all":
        filtered = [i for i in filtered if i["project"] == project]
    if q:
        ql = q.lower()
        filtered = [
            i for i in filtered
            if ql in i["name"].lower() or ql in i["group"].lower()
        ]

    # Sort: mtime DESC, id ASC (stable)
    filtered.sort(key=lambda i: (-i["mtime"], i["id"]))
    total_count = len(filtered)

    # Cursor pagination
    start = 0
    if cursor:
        import base64
        try:
            decoded = base64.urlsafe_b64decode(cursor + "==").decode()
            cur_mtime, cur_id = decoded.split(":", 1)
            cur_mtime_int = int(cur_mtime)
            for idx, item in enumerate(filtered):
                if item["mtime"] == cur_mtime_int and item["id"] == cur_id:
                    start = idx + 1
                    break
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="Invalid cursor")

    page = filtered[start : start + limit]
    next_cursor = None
    if start + limit < len(filtered):
        last = page[-1]
        import base64
        raw = f"{last['mtime']}:{last['id']}"
        next_cursor = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")

    scan_ms = int((time.monotonic() - t0) * 1000)

    return {
        "items": page,
        "count": total_count,
        "next_cursor": next_cursor,
        "truncated": truncated,
        "scan_ms": scan_ms,
        "profile": profile,
    }


@router.get("/content/{item_id}")
def get_content(item_id: str) -> StreamingResponse:
    """Serve a file by its opaque id using the verified-FD protocol."""
    entry = _cache_get(item_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found or cache expired")

    root_key, board, root, relpath = entry
    path = root / relpath

    return _serve_fd(path, root)
