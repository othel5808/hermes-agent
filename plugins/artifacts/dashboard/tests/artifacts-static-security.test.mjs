import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "..");
const indexPath = path.join(dashboard, "dist", "index.js");
const loaderPath = path.join(dashboard, "dist", "artifacts-loader.js");
const manifestPath = path.join(dashboard, "manifest.json");

function source(file) {
  return fs.readFileSync(file, "utf8");
}

// 현재 staging 실행에서는 production 파일이 없으므로 파일당 한 번만 명확히 실패한다.
// target repo에 복사된 뒤에는 아래 모든 behavior/static assertion이 실행된다.
const manifest = JSON.parse(source(manifestPath));
const loader = source(loaderPath);
const index = source(indexPath);

test("manifest는 plugin-local loader를 단일 entry로 선언한다", () => {
  assert.equal(manifest.entry, "dist/artifacts-loader.js");
});

test("loader는 artifacts-core.js 성공 뒤에만 index.js를 로드한다", () => {
  const corePos = loader.indexOf("artifacts-core.js");
  const indexPos = loader.indexOf("index.js");
  assert.ok(corePos >= 0, "loader must name artifacts-core.js");
  assert.ok(indexPos > corePos, "core must be declared before index");
  assert.match(loader, /onload\s*=\s*[^;]*(?:loadIndex|index)/i);
  assert.match(loader, /appendChild\s*\(/);
});

test("index.js는 production ArtifactsCore를 필수로 사용한다", () => {
  const index = source(indexPath);
  assert.match(index, /window\.ArtifactsCore/);
  for (const fn of [
    "buildItemsQuery",
    "buildRefetchQuery",
    "selectRefetchedItem",
    "shouldRetryContent",
    "previewKind",
    "isDownloadOnly",
    "badgeForItem",
  ]) {
    assert.match(index, new RegExp(`(?:ArtifactsCore|Core)\\.${fn}\\s*\\(`), `${fn} must be consumed by index.js`);
  }
});

test("HTML 주입 sink를 사용하지 않는다", () => {
  const index = source(indexPath);
  assert.doesNotMatch(index, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(index, /\.innerHTML\s*=/);
  assert.doesNotMatch(index, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(index, /document\.write\s*\(/);
  assert.doesNotMatch(index, /DOMParser\s*\(/);
});

test("PDF는 download-only이며 iframe/object/embed renderer가 없다", () => {
  const index = source(indexPath);
  assert.doesNotMatch(index, /allow-scripts\s+allow-same-origin|allow-same-origin\s+allow-scripts/);
  assert.doesNotMatch(index, /h\s*\(\s*["']iframe["']/);
  assert.doesNotMatch(index, /h\s*\(\s*["']object["']/);
  assert.doesNotMatch(index, /h\s*\(\s*["']embed["']/);
});

test("SVG Blob URL은 img src 외 능동 컨텍스트로 노출하지 않는다", () => {
  const index = source(indexPath);
  assert.match(index, /h\s*\(\s*["']img["']\s*,\s*\{[^}]*\bsrc\s*:/s);
  assert.doesNotMatch(index, /window\.open\s*\(/);
  assert.doesNotMatch(index, /h\s*\(\s*["']a["']\s*,\s*\{[^}]*href\s*:\s*(?:blobUrl|svgUrl|svgBlobUrl)/s);
  assert.doesNotMatch(index, /h\s*\(\s*["'](?:iframe|object|embed)["']/);
});

// ── R2 fence: cursor pagination AbortController ───────────────────────────
// 필터/탭 전환 시 in-flight cursor fetch stale 응답이 새 목록을 오염시켜선 안 된다.

test("cursor pagination — loadItems 호출 시 in-flight cursor fetch를 abort하고 loadingMoreRef를 리셋한다", () => {
  // R2 체크리스트 §4: loadItems 호출 시 in-flight cursor fetch abort
  // R2 체크리스트 §3: loadingMoreRef.current = false 리셋 (stuck 방지)
  assert.match(index, /cursorAcRef\.current\.abort\s*\(\s*\)/, "loadItems must abort cursorAcRef on reset");
  assert.match(index, /cursorAcRef\.current\s*=\s*null/, "loadItems must clear cursorAcRef");
  // loadItems 함수 내에 loadingMoreRef.current = false 가 있어야 한다 (abort 직후 리셋)
  // cursorAcRef.current = null; 바로 뒤에 loadingMoreRef reset이 이어지는 패턴 확인
  assert.match(
    index,
    /cursorAcRef\.current\s*=\s*null;\s*\}\s*\n?\s*loadingMoreRef\.current\s*=\s*false/,
    "loadItems must reset loadingMoreRef.current immediately after aborting cursor fetch"
  );
});

test("cursor pagination — signal.aborted 체크 후 setItems를 skip한다 (stale fence)", () => {
  // R2 체크리스트 §3: signal.aborted 체크 후 setItems skip
  // fetchItems(...).then(function(data) { if (cursorAc && cursorAc.signal.aborted) return; setItems(...) })
  assert.match(
    index,
    /cursorAc\s*&&\s*cursorAc\.signal\.aborted\)\s*return;[\s\S]{0,120}setItems\s*\(/,
    "setItems concat must be guarded by cursorAc.signal.aborted check"
  );
});

test("cursor pagination — effect cleanup 시 cursorAcRef abort와 loadingMoreRef 리셋을 모두 수행한다", () => {
  // R2 체크리스트: 필터 전환(effect cleanup) 시 stale cursor abort + stuck 방지
  // cleanup: observer.disconnect() ... cursorAcRef.current.abort() ... loadingMoreRef.current = false
  assert.match(
    index,
    /observer\.disconnect\s*\(\s*\)[\s\S]{0,200}cursorAcRef\.current\s*=\s*null[\s\S]{0,100}loadingMoreRef\.current\s*=\s*false/,
    "IntersectionObserver cleanup must abort cursorAcRef and reset loadingMoreRef"
  );
});
