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
