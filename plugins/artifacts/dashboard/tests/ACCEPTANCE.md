# Artifacts FE fix3 인수 규격

## 1. 구현 경계

허용 변경은 `plugins/artifacts/**`와 `tests/**`뿐이다. 코어 파일 변경, 운영 대시보드/운영 `HERMES_HOME` 사용, 커밋, 테스트 완화·복제 로직 추가를 금지한다. 이 디렉터리의 테스트와 캡처 스크립트는 그대로 복사해야 한다.

## 2. production 결정 로직 추출

`plugins/artifacts/dashboard/dist/artifacts-core.js`를 plain script로 추가한다. 아래 함수를 가진 하나의 `ArtifactsCore` 객체를 만들고 반드시 둘 다 노출한다.

```js
window.ArtifactsCore = ArtifactsCore;
if (typeof module !== "undefined") module.exports = ArtifactsCore;
```

필수 함수:

- `buildItemsQuery(filters)`: `project/source/q/kind/cursor/limit` 보존
- `buildRefetchQuery(item, filters)`: 현재 `project/source/q/kind`와 충분한 `limit` 보존
- `selectRefetchedItem(candidates, original)`: 기존 `id`를 우선한다. ID가 달라졌다면 `name/source/group/project/kind/task.id/task.board`가 모두 같은 후보가 정확히 하나일 때만 반환하고, 0개 또는 복수면 `null`
- `shouldRetryContent(state)`: 최초 404이고 재식별 성공일 때만 1회 재시도. 새 ID가 기존 ID와 같아도 `true`
- `previewKind(item)`, `isDownloadOnly(item)`, `badgeForItem(item)`: SVG=`svg-img`/배지 없음, PDF·HTML·unknown=`download`/`download-only`

`dist/index.js`는 위 함수를 실제 목록 요청, 404 복구, renderer 선택, 배지 렌더에 호출해야 한다. 같은 결정을 index.js에 복제하면 실패다. 비동기 content 요청은 effect별 취소 상태 또는 `AbortController`를 써서 이전 응답이 현재 항목을 덮거나 revoke되지 않은 Blob URL을 만들지 못하게 한다.

## 3. 스크립트 로드 순서

현재 host 계약은 `manifest.json`의 단일 문자열 `entry`만 지원한다(`web_server.py` discovery와 `web/src/plugins/usePlugins.ts`). 코어 변경 없이 배열 `scripts`를 추가하면 로드되지 않는다. 따라서 정확히 다음처럼 한다.

1. `dist/artifacts-loader.js` 추가
2. loader가 같은 plugin base의 `artifacts-core.js`를 `<script>`로 붙임
3. core의 `onload` 안에서만 `index.js`를 붙임; 오류 시 index를 실행하지 않음
4. `manifest.json`의 `"entry": "dist/index.js"`를 `"entry": "dist/artifacts-loader.js"`로 변경

## 4. 보안 및 PDF 결정

PDF는 **download-only fallback**으로 확정한다. 인수 기준은 PDF 선택 시 “다운로드 전용” UI와 다운로드 버튼이 보이고 preview pane에 `iframe/object/embed`가 0개인 것이다. 따라서 sandbox 렌더링은 허용하지 않는다.

SVG는 인증 fetch 결과를 `image/svg+xml` Blob URL로 만들되 오직 React의 `<img src>`에만 넣는다. `iframe/object/embed`, inline SVG, 새 창, anchor href에 SVG Blob URL을 넣지 않는다. `innerHTML`, `dangerouslySetInnerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`를 금지한다.

## 5. 실행

단위/정적 테스트:

```sh
node --test plugins/artifacts/dashboard/tests/*.test.mjs
```

격리 fixture 및 별도 포트 서버:

```sh
export REPO=/path/to/artifacts-ui-worktree
export VENV=/path/to/hermes-agent/venv
export FIXTURE_HOME="$(mktemp -d)"
"$VENV/bin/python" plugins/artifacts/dashboard/tests/prepare-evidence-fixture.py --home "$FIXTURE_HOME"
HERMES_HOME="$FIXTURE_HOME" PYTHONPATH="$REPO" \
  "$VENV/bin/python" -m hermes_cli.main dashboard \
  --host 127.0.0.1 --port 19129 --no-open --skip-build
```

별도 셸에서 격리 서버에 로그인해 받은 세션 쿠키만 환경변수로 전달한다. 값은 파일이나 명령 기록에 남기지 않는다.

```sh
export DASH_URL='http://127.0.0.1:19129/#/artifacts'
export DASH_SESSION_COOKIE='cookie_name=cookie_value'
"$VENV/bin/python" plugins/artifacts/dashboard/tests/capture-evidence.py
```

캡처 스크립트는 9119를 거부하며 HAR의 Cookie/Authorization/Set-Cookie/**X-Hermes-Session-Token** 헤더를 제거하고, 응답 본문의 `window.__HERMES_SESSION_TOKEN__` 값도 `[REDACTED]`로 치환한다. 성공은 두 프로젝트 전환, 2-page cursor, same-id 404→refetch→200와 4필터 전파, Artifacts 플러그인 DOM/URL 토큰 부재(bootstrap 세션 토큰 포함), SVG script/dialog 0, PDF download-only를 모두 assertion으로 확인한 경우뿐이다.
