#!/usr/bin/env python3
"""격리 포트의 Artifacts UI에서 재현 가능한 브라우저 증거를 캡처한다.

필수 환경변수:
  DASH_URL             Artifacts 탭 URL(포트 9119 금지)
  DASH_SESSION_COOKIE  ``name=value`` 또는 ``name=value; name2=value2``

선택 환경변수:
  ARTIFACT_PROJECT_A/B, ARTIFACT_STALE_NAME, ARTIFACT_SVG_NAME, ARTIFACT_PDF_NAME
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

OUTPUT = Path.home() / ".hermes" / "task-staging" / "artifacts-ui-FE"
# X-Hermes-Session-Token: Hermes 루프백 부트스트랩 인증 헤더.
# Cookie/Authorization 등 표준 민감 헤더와 함께 반드시 제거한다.
SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-hermes-session-token",  # Hermes loopback bootstrap auth — R3 fix
}
SENSITIVE_QUERY_KEYS = {"token", "access_token", "refresh_token", "session", "ticket", "auth"}

# bootstrap 토큰 추출용 패턴: web_server.py가 gated 모드가 아닐 때 삽입한다.
_BOOTSTRAP_TOKEN_RE = re.compile(
    r'window\.__HERMES_SESSION_TOKEN__\s*=\s*["\']([^"\']{7,})["\']'
)


def fail(message: str) -> None:
    raise AssertionError(message)


def write_json(name: str, payload: dict[str, Any]) -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / name).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def redact_url(raw: str) -> str:
    parsed = urlparse(raw)
    query = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        query.append((key, "[REDACTED]" if key.lower() in SENSITIVE_QUERY_KEYS else value))
    return urlunparse(parsed._replace(query=urlencode(query)))


def _extract_bootstrap_tokens(data: dict) -> set[str]:
    """HAR 응답 본문에서 Hermes bootstrap 세션 토큰 값을 추출한다.

    sanitize_har()에서 헤더 제거 전에 호출해 토큰 값을 먼저 수집하고,
    이후 응답 본문에서 해당 값을 [REDACTED]로 치환하는 데 사용한다.
    """
    tokens: set[str] = set()
    for entry in data.get("log", {}).get("entries", []):
        text = (entry.get("response", {}).get("content", {}).get("text") or "")
        for m in _BOOTSTRAP_TOKEN_RE.finditer(text):
            tokens.add(m.group(1))
    return tokens


def sanitize_har(raw_path: Path, final_name: str) -> None:
    data = json.loads(raw_path.read_text(encoding="utf-8"))

    # R3: 응답 본문에서 bootstrap 세션 토큰 값을 먼저 수집한다.
    # 헤더 제거 후에는 값을 복원할 수 없으므로 반드시 먼저 추출해야 한다.
    bootstrap_tokens = _extract_bootstrap_tokens(data)

    for entry in data.get("log", {}).get("entries", []):
        request = entry.get("request", {})
        response = entry.get("response", {})
        request["url"] = redact_url(request.get("url", ""))
        # SENSITIVE_HEADERS에 x-hermes-session-token 포함 — R3 fix
        request["headers"] = [
            h for h in request.get("headers", [])
            if h.get("name", "").lower() not in SENSITIVE_HEADERS
        ]
        response["headers"] = [
            h for h in response.get("headers", [])
            if h.get("name", "").lower() not in SENSITIVE_HEADERS
        ]
        request.pop("cookies", None)
        response.pop("cookies", None)
        request.pop("postData", None)

        # R3: 응답 본문에서 bootstrap 토큰 값도 제거한다.
        # 헤더만 제거하면 HTML 본문의 window.__HERMES_SESSION_TOKEN__ 값이 잔존한다.
        if bootstrap_tokens:
            content = response.get("content", {})
            text = content.get("text") or ""
            for token in bootstrap_tokens:
                text = text.replace(token, "[REDACTED]")
            content["text"] = text

    (OUTPUT / final_name).write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    raw_path.unlink(missing_ok=True)


def parse_cookie_header(raw: str, dash_url: str) -> list[dict[str, Any]]:
    if raw.lower().startswith("cookie:"):
        raw = raw.split(":", 1)[1].strip()
    host = urlparse(dash_url).hostname
    if not host:
        fail("DASH_URL에 hostname이 없다")
    cookies = []
    for chunk in raw.split(";"):
        if "=" not in chunk:
            continue
        name, value = chunk.strip().split("=", 1)
        if name and value:
            cookies.append({
                "name": name,
                "value": value,
                "domain": host,
                "path": "/",
                "secure": dash_url.startswith("https://"),
                "sameSite": "Lax",
            })
    if not cookies:
        fail("DASH_SESSION_COOKIE에서 쿠키를 파싱하지 못했다")
    return cookies


def context(browser: Browser, cookies: list[dict[str, Any]], har: Path | None = None) -> BrowserContext:
    kwargs: dict[str, Any] = {"viewport": {"width": 1440, "height": 1000}}
    if har is not None:
        kwargs.update(record_har_path=str(har), record_har_mode="full", record_har_content="embed")
    ctx = browser.new_context(**kwargs)
    ctx.add_cookies(cookies)
    return ctx


def open_artifacts(page: Page, dash_url: str) -> None:
    page.goto(dash_url, wait_until="domcontentloaded")
    page.locator(".art-shell").wait_for(state="visible", timeout=20_000)
    page.locator(".art-topbar .art-tab").first.wait_for(state="visible", timeout=20_000)


def tab(page: Page, name: str):
    return page.locator(".art-topbar .art-tab").filter(has_text=name).first


def select_project(page: Page, name: str) -> None:
    target = tab(page, name)
    target.wait_for(state="visible", timeout=10_000)
    target.click()
    page.wait_for_function(
        "name => Array.from(document.querySelectorAll('.art-tab.active')).some(x => x.textContent.includes(name))",
        arg=name,
    )
    page.wait_for_timeout(300)


def set_filter(page: Page, label: str, value: str) -> None:
    group = page.locator(f'.art-filter-group[aria-label="{label}"]')
    group.get_by_role("button", name=value, exact=True).click()
    page.wait_for_timeout(250)


def search(page: Page, text: str) -> None:
    field = page.locator(".art-search-input")
    field.fill(text)
    page.wait_for_timeout(700)


def row_by_name(page: Page, name: str):
    label = page.locator(".art-row-name", has_text=name).filter(has_text=name).first
    label.wait_for(state="visible", timeout=15_000)
    return label.locator("xpath=ancestor::*[contains(@class,'art-file-row')][1]")


def query_map(url: str) -> dict[str, str]:
    return dict(parse_qsl(urlparse(url).query, keep_blank_values=True))


def capture_tabs(browser: Browser, cookies: list[dict[str, Any]], dash_url: str, project_a: str, project_b: str) -> None:
    ctx = context(browser, cookies)
    page = ctx.new_page()
    item_urls: list[str] = []
    page.on("request", lambda req: item_urls.append(req.url) if "/api/plugins/artifacts/items?" in req.url else None)
    open_artifacts(page, dash_url)
    select_project(page, project_a)
    page.screenshot(path=str(OUTPUT / "cap-01a-project-a.png"), full_page=True)
    select_project(page, project_b)
    page.screenshot(path=str(OUTPUT / "cap-01b-project-b.png"), full_page=True)
    seen = {query_map(url).get("project") for url in item_urls}
    report = {
        "project_a": project_a,
        "project_b": project_b,
        "project_a_requested": project_a in seen,
        "project_b_requested": project_b in seen,
        "pass": project_a in seen and project_b in seen,
    }
    write_json("cap-01-project-switch-report.json", report)
    ctx.close()
    if not report["pass"]:
        fail("두 프로젝트 탭의 items 요청이 모두 관측되지 않았다")


def capture_cursor(browser: Browser, cookies: list[dict[str, Any]], dash_url: str, project_a: str) -> None:
    raw_har = Path(tempfile.mkstemp(prefix="artifacts-cursor-", suffix=".har")[1])
    ctx = context(browser, cookies, raw_har)
    page = ctx.new_page()
    urls: list[str] = []
    page.on("request", lambda req: urls.append(req.url) if "/api/plugins/artifacts/items?" in req.url else None)
    open_artifacts(page, dash_url)
    select_project(page, project_a)
    page.wait_for_function(
        "p => Array.from(document.querySelectorAll('.art-file-row')).length >= 50",
        arg=project_a,
        timeout=20_000,
    )
    page.locator(".art-list-scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
    page.wait_for_function(
        "p => performance.getEntriesByType('resource').filter(e => e.name.includes('/api/plugins/artifacts/items?') && new URL(e.name).searchParams.get('project') === p).length >= 2",
        arg=project_a,
        timeout=20_000,
    )
    page.screenshot(path=str(OUTPUT / "cap-02-two-page-cursor.png"), full_page=True)
    relevant = [url for url in urls if query_map(url).get("project") == project_a]
    cursor_requests = [url for url in relevant if query_map(url).get("cursor")]
    report = {
        "project": project_a,
        "page_request_count": len(relevant),
        "cursor_bearing_request_count": len(cursor_requests),
        "second_request_has_cursor": len(relevant) >= 2 and bool(query_map(relevant[1]).get("cursor")),
        "pass": len(relevant) >= 2 and len(cursor_requests) >= 1,
    }
    write_json("cap-02-two-page-cursor-report.json", report)
    ctx.close()
    sanitize_har(raw_har, "cap-02-two-page-cursor.har")
    if not report["pass"]:
        fail("2-page cursor 요청을 관측하지 못했다")


def capture_stale(browser: Browser, cookies: list[dict[str, Any]], dash_url: str, project_a: str, stale_name: str) -> None:
    raw_har = Path(tempfile.mkstemp(prefix="artifacts-stale-", suffix=".har")[1])
    ctx = context(browser, cookies, raw_har)
    page = ctx.new_page()
    events: list[dict[str, Any]] = []
    page.on("request", lambda req: events.append({"type": "request", "url": req.url}) if "/api/plugins/artifacts/" in req.url else None)
    page.on("response", lambda res: events.append({"type": "response", "url": res.url, "status": res.status}) if "/api/plugins/artifacts/" in res.url else None)
    open_artifacts(page, dash_url)
    select_project(page, project_a)
    set_filter(page, "Source", "staging")
    set_filter(page, "Kind", "text")
    search(page, stale_name)
    row = row_by_name(page, stale_name)
    item_id = row.get_attribute("data-id")
    if not item_id:
        fail("stale fixture의 data-id가 없다")

    intercepted = {"done": False}

    def route_content(route) -> None:
        if not intercepted["done"]:
            intercepted["done"] = True
            route.fulfill(status=404, content_type="application/json", body='{"detail":"forced stale cache"}')
        else:
            route.continue_()

    page.route(re.compile(rf".*/api/plugins/artifacts/content/{re.escape(item_id)}(?:\?.*)?$"), route_content)
    start = len(events)
    row.click()
    page.wait_for_function(
        "() => document.querySelector('.art-text-content') && document.querySelector('.art-text-content').textContent.includes('stale cache retry fixture')",
        timeout=20_000,
    )
    scenario = events[start:]
    content_responses = [e for e in scenario if e["type"] == "response" and f"/content/{item_id}" in e["url"]]
    statuses = [e["status"] for e in content_responses]
    item_requests = [e for e in scenario if e["type"] == "request" and "/items?" in e["url"]]
    propagated = False
    if item_requests:
        p = query_map(item_requests[-1]["url"])
        propagated = all([
            p.get("project") == project_a,
            p.get("source") == "staging",
            p.get("kind") == "text",
            p.get("q") == stale_name,
        ])
    report = {
        "same_id": item_id,
        "content_statuses": statuses,
        "refetch_items_request_count": len(item_requests),
        "filters_propagated": propagated,
        "pass": statuses[:2] == [404, 200] and len(item_requests) >= 1 and propagated,
    }
    write_json("cap-03-stale-404-refetch-200-report.json", report)
    page.screenshot(path=str(OUTPUT / "cap-03-stale-404-refetch-200.png"), full_page=True)
    ctx.close()
    sanitize_har(raw_har, "cap-03-stale-404-refetch-200.har")
    if not report["pass"]:
        fail("stale-id 404→items refetch→same-id 200 또는 필터 전파 조건이 실패했다")


def capture_token_absence(browser: Browser, cookies: list[dict[str, Any]], dash_url: str) -> None:
    # R4 fix: Artifacts API 요청을 헤더 포함 전체 수집한다.
    ctx = context(browser, cookies)
    page = ctx.new_page()
    artifact_reqs: list[dict[str, Any]] = []

    def on_request(req) -> None:
        if "/api/plugins/artifacts/" in req.url:
            artifact_reqs.append({"url": req.url, "headers": dict(req.headers)})

    page.on("request", on_request)
    open_artifacts(page, dash_url)
    page.wait_for_timeout(800)

    # R4 fix: 실제 인증 수단인 bootstrap 세션 토큰 값을 추출한다.
    # web_server.py가 gated 모드가 아닐 때 window.__HERMES_SESSION_TOKEN__ 으로 삽입한다.
    # DOM의 bootstrap <script> 에는 이 값이 의도적으로 존재하므로 full outerHTML 검사는 false green.
    # 대신 Artifacts 플러그인 셸(.art-shell) 내부만 검사한다.
    bootstrap_token: str = page.evaluate(
        "() => (typeof window.__HERMES_SESSION_TOKEN__ === 'string' "
        "       && window.__HERMES_SESSION_TOKEN__.length >= 7) "
        "      ? window.__HERMES_SESSION_TOKEN__ : ''"
    )

    # 검사 대상 비밀 값: 제공된 쿠키 값 + bootstrap 토큰(있는 경우)
    secret_values: list[str] = [c["value"] for c in cookies if len(c["value"]) >= 7]
    if bootstrap_token:
        secret_values.append(bootstrap_token)

    artifact_urls = [r["url"] for r in artifact_reqs]

    # Artifacts 플러그인이 렌더링한 DOM 영역만 검사 (bootstrap <script> 제외)
    artifact_shell_html: str = page.evaluate(
        "() => { const el = document.querySelector('.art-shell'); "
        "        return el ? el.innerHTML : ''; }"
    )

    value_in_artifact_dom = any(v in artifact_shell_html for v in secret_values)
    value_in_url = any(v in url for v in secret_values for url in artifact_urls)

    # R4 fix: x-hermes-session-token 헤더가 Artifacts API 요청에 포함되는지 확인.
    # 브라우저가 서버 인증을 위해 보내는 것은 정상이나, 플러그인이 직접 삽입하면 안 된다.
    # 여기서는 헤더 키 존재 여부만 확인 (값은 로그에 기록하지 않음).
    session_header_in_artifact_req = any(
        "x-hermes-session-token" in {k.lower() for k in r["headers"]}
        for r in artifact_reqs
    )

    token_query_urls = []
    for url in artifact_urls:
        keys = {key.lower() for key, _ in parse_qsl(urlparse(url).query, keep_blank_values=True)}
        if keys & SENSITIVE_QUERY_KEYS:
            token_query_urls.append(redact_url(url))
    dom_token_attrs = page.locator("[src*='token='],[href*='token='],[src*='access_token='],[href*='access_token=']").count()

    report = {
        "artifact_request_count": len(artifact_reqs),
        "bootstrap_token_found_in_page": bool(bootstrap_token),
        "secret_value_in_artifact_dom": value_in_artifact_dom,
        "secret_value_in_artifact_url": value_in_url,
        # NOTE: session_header_in_artifact_req=true는 브라우저가 서버에 인증 헤더를 보내는
        # 정상 동작이므로 단독으로 fail 조건이 되지 않는다. 토큰이 URL/DOM으로 누출되는지가 핵심.
        "session_header_present_in_artifact_api": session_header_in_artifact_req,
        "sensitive_query_url_count": len(token_query_urls),
        "dom_sensitive_url_attribute_count": dom_token_attrs,
        "pass": (
            not value_in_artifact_dom
            and not value_in_url
            and not token_query_urls
            and dom_token_attrs == 0
        ),
    }
    write_json("cap-04-dom-network-token-absence.json", report)
    ctx.close()
    if not report["pass"]:
        fail("Artifacts 플러그인 DOM 또는 네트워크 URL에서 세션 값/토큰 query가 발견됐다")


def capture_svg(browser: Browser, cookies: list[dict[str, Any]], dash_url: str, project_a: str, svg_name: str) -> None:
    ctx = context(browser, cookies)
    page = ctx.new_page()
    dialogs: list[str] = []
    console_markers: list[str] = []

    def on_dialog(dialog) -> None:
        dialogs.append(dialog.message)
        dialog.dismiss()

    page.on("dialog", on_dialog)
    page.on("console", lambda msg: console_markers.append(msg.text) if "SVG_EXECUTED" in msg.text else None)
    open_artifacts(page, dash_url)
    select_project(page, project_a)
    search(page, svg_name)
    row_by_name(page, svg_name).click()
    image = page.locator(".art-preview-body img").first
    image.wait_for(state="visible", timeout=20_000)
    page.wait_for_timeout(1200)
    src = image.get_attribute("src") or ""
    active_nodes = page.locator(".art-preview-body iframe, .art-preview-body object, .art-preview-body embed, .art-preview-body svg").count()
    report = {
        "preview_tag": image.evaluate("el => el.tagName"),
        "blob_src": src.startswith("blob:"),
        "dialog_count": len(dialogs),
        "console_execution_marker_count": len(console_markers),
        "active_preview_node_count": active_nodes,
        "pass": src.startswith("blob:") and not dialogs and not console_markers and active_nodes == 0,
    }
    write_json("cap-05-svg-script-nonexecution-report.json", report)
    page.screenshot(path=str(OUTPUT / "cap-05-svg-script-nonexecution.png"), full_page=True)
    ctx.close()
    if not report["pass"]:
        fail("SVG는 <img blob:> 전용이어야 하며 script/dialog/active node 실행이 없어야 한다")


def capture_pdf(browser: Browser, cookies: list[dict[str, Any]], dash_url: str, project_a: str, pdf_name: str) -> None:
    ctx = context(browser, cookies)
    page = ctx.new_page()
    open_artifacts(page, dash_url)
    select_project(page, project_a)
    search(page, pdf_name)
    row_by_name(page, pdf_name).click()
    fallback = page.locator(".art-no-preview")
    fallback.wait_for(state="visible", timeout=15_000)
    text = fallback.inner_text()
    active_nodes = page.locator(".art-preview-body iframe, .art-preview-body object, .art-preview-body embed").count()
    download_buttons = fallback.get_by_role("button").count()
    report = {
        "fallback_visible": fallback.is_visible(),
        "download_only_text": "다운로드" in text,
        "active_pdf_node_count": active_nodes,
        "download_button_count": download_buttons,
        "pass": fallback.is_visible() and "다운로드" in text and active_nodes == 0 and download_buttons >= 1,
    }
    write_json("cap-06-pdf-download-only-report.json", report)
    page.screenshot(path=str(OUTPUT / "cap-06-pdf-download-only.png"), full_page=True)
    ctx.close()
    if not report["pass"]:
        fail("PDF download-only fallback 조건이 실패했다")


def main() -> int:
    dash_url = os.environ.get("DASH_URL", "").strip()
    cookie_header = os.environ.get("DASH_SESSION_COOKIE", "").strip()
    if not dash_url or not cookie_header:
        print("DASH_URL과 DASH_SESSION_COOKIE가 필요하다", file=sys.stderr)
        return 2
    parsed = urlparse(dash_url)
    if parsed.port == 9119:
        print("production 기본 포트 9119에서는 실행을 거부한다", file=sys.stderr)
        return 2
    if parsed.scheme not in {"http", "https"}:
        print("DASH_URL은 http(s) URL이어야 한다", file=sys.stderr)
        return 2

    project_a = os.environ.get("ARTIFACT_PROJECT_A", "fixture-alpha")
    project_b = os.environ.get("ARTIFACT_PROJECT_B", "fixture-beta")
    stale_name = os.environ.get("ARTIFACT_STALE_NAME", "stale-target.txt")
    svg_name = os.environ.get("ARTIFACT_SVG_NAME", "active-script.svg")
    pdf_name = os.environ.get("ARTIFACT_PDF_NAME", "download-only.pdf")
    cookies = parse_cookie_header(cookie_header, dash_url)
    OUTPUT.mkdir(parents=True, exist_ok=True)

    started = time.time()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            capture_tabs(browser, cookies, dash_url, project_a, project_b)
            capture_cursor(browser, cookies, dash_url, project_a)
            capture_stale(browser, cookies, dash_url, project_a, stale_name)
            capture_token_absence(browser, cookies, dash_url)
            capture_svg(browser, cookies, dash_url, project_a, svg_name)
            capture_pdf(browser, cookies, dash_url, project_a, pdf_name)
        finally:
            browser.close()

    write_json("cap-00-run-summary.json", {
        "duration_seconds": round(time.time() - started, 3),
        "port": parsed.port,
        "production_port_refused": True,
        "pass": True,
    })
    print(OUTPUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
