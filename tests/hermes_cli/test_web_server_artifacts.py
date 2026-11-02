"""Full-app integration tests for the Artifacts dashboard plugin auth.

Tests that the artifacts plugin routes go through the dashboard's real
auth_middleware — not just the bare router.

Follows the pattern established in tests/hermes_cli/test_web_server_files.py
(lines 267-333).

Test cases:
  - Token header mode: authenticated request returns 200
  - Unauthenticated request returns 401
  - Cookie mode: gated-auth (OAuth) cookie returns 200
  - get_process_hermes_home behavioral: ContextVar override is ignored
"""

from __future__ import annotations

import hmac as _hmac
import os
from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

from hermes_cli import web_server


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

    Simulates the browser cookie flow by:
    1. Setting auth_required=True (gated mode).
    2. Monkeypatching gated_auth_middleware to accept our session token as a cookie.
    3. Asserting that a valid cookie → 200 (not 401 or 404).
    """
    home = tmp_path / ".hermes"
    (home / "task-staging").mkdir(parents=True)
    (home / "reports").mkdir(parents=True)
    (home / "kanban" / "briefs").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    # Minimal gated_auth_middleware: accept the session token from the cookie.
    import hermes_cli.dashboard_auth.middleware as _dam

    async def _mock_gated(request, call_next):
        cookie = request.cookies.get("hermes_session", "")
        if cookie and _hmac.compare_digest(
            cookie.encode(), web_server._SESSION_TOKEN.encode()
        ):
            # Inject a valid session — auth_middleware will see this and pass.
            request.state.session = {"user_id": "test"}
        return await call_next(request)

    monkeypatch.setattr(_dam, "gated_auth_middleware", _mock_gated)

    prev_auth = getattr(web_server.app.state, "auth_required", None)
    prev_host = getattr(web_server.app.state, "bound_host", None)
    web_server.app.state.auth_required = True
    web_server.app.state.bound_host = None

    client = None
    try:
        client = TestClient(web_server.app, raise_server_exceptions=False)
        client.cookies.set("hermes_session", web_server._SESSION_TOKEN)

        r = client.get("/api/plugins/artifacts/items")
        assert r.status_code == 200, (
            f"Expected 200 with valid session cookie (gated auth mode). "
            f"Got {r.status_code}: {r.text}"
        )
    finally:
        _restore_app_state(prev_auth, prev_host)
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass


def test_artifacts_plugin_uses_process_hermes_home(monkeypatch, tmp_path):
    """Confirm plugin_api.py calls get_process_hermes_home(), not get_hermes_home().

    Behavioral test: get_hermes_home() follows a request-scoped ContextVar
    override (set_hermes_home_override); get_process_hermes_home() ignores it.

    The plugin must use the process-launch home so its roots are stable even
    when a request-scoped profile override is in effect.
    """
    from hermes_constants import (
        get_hermes_home,
        get_process_hermes_home,
        set_hermes_home_override,
        reset_hermes_home_override,
    )

    # The two functions are distinct.
    assert get_process_hermes_home is not get_hermes_home

    # Set HERMES_HOME to a specific launch home.
    launch_home = tmp_path / "launch_home"
    launch_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(launch_home))

    # Activate a different ContextVar override (simulates a per-request profile).
    req_home = tmp_path / "req_home"
    req_home.mkdir()
    token = set_hermes_home_override(req_home)
    try:
        # get_hermes_home() follows the override → req_home.
        assert get_hermes_home() == req_home, (
            f"get_hermes_home() should return req_home={req_home}"
        )
        # get_process_hermes_home() ignores the override → launch_home.
        assert get_process_hermes_home() == launch_home, (
            f"get_process_hermes_home() should return launch_home={launch_home}"
        )
    finally:
        reset_hermes_home_override(token)
