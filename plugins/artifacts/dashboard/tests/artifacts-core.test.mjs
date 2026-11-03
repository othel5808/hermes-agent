import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
// 의도적으로 production 파일을 직접 require한다. 테스트용 로직 복제 금지.
const Core = require("../dist/artifacts-core.js");

function params(query) {
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

const original = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  name: "same-name.txt",
  kind: "text",
  mime: "text/plain; charset=utf-8",
  source: "reports",
  group: "daily/run-1",
  project: "project-a",
  task: null,
};

test("production core는 브라우저 전역과 CommonJS에 같은 API를 노출한다", () => {
  assert.equal(typeof Core, "object");
  for (const name of [
    "buildItemsQuery",
    "buildRefetchQuery",
    "selectRefetchedItem",
    "shouldRetryContent",
    "previewKind",
    "isDownloadOnly",
    "badgeForItem",
  ]) {
    assert.equal(typeof Core[name], "function", `${name} must be exported`);
  }
});

test("items query는 project/source/q/kind와 cursor를 손실 없이 전달한다", () => {
  const query = Core.buildItemsQuery({
    project: "project-a",
    source: "reports",
    q: "same name & 한글",
    kind: "text",
    cursor: "cursor+/=value",
    limit: 50,
  });
  const p = params(query);
  assert.equal(p.get("project"), "project-a");
  assert.equal(p.get("source"), "reports");
  assert.equal(p.get("q"), "same name & 한글");
  assert.equal(p.get("kind"), "text");
  assert.equal(p.get("cursor"), "cursor+/=value");
  assert.equal(p.get("limit"), "50");
});

test("404 refetch query도 현재 project/source/q/kind를 모두 보존한다", () => {
  const query = Core.buildRefetchQuery(original, {
    project: "project-a",
    source: "reports",
    q: "same name",
    kind: "text",
  });
  const p = params(query);
  assert.equal(p.get("project"), "project-a");
  assert.equal(p.get("source"), "reports");
  assert.equal(p.get("q"), "same name");
  assert.equal(p.get("kind"), "text");
  assert.ok(Number(p.get("limit")) >= 20);
});

test("404 뒤 목록 재조회 성공 시 같은 id여도 정확히 한 번 재시도한다", () => {
  assert.equal(Core.shouldRetryContent({
    status: 404,
    alreadyRetried: false,
    originalItem: original,
    refreshedItem: { ...original },
  }), true);
  assert.equal(Core.shouldRetryContent({
    status: 404,
    alreadyRetried: true,
    originalItem: original,
    refreshedItem: { ...original },
  }), false);
  assert.equal(Core.shouldRetryContent({
    status: 500,
    alreadyRetried: false,
    originalItem: original,
    refreshedItem: { ...original },
  }), false);
  assert.equal(Core.shouldRetryContent({
    status: 404,
    alreadyRetried: false,
    originalItem: original,
    refreshedItem: null,
  }), false);
});

test("재조회 결과에 기존 id가 있으면 다른 동명 항목보다 우선한다", () => {
  const wrongRoot = {
    ...original,
    id: "bbbbbbbbbbbbbbbbbbbbbbbb",
    source: "staging",
  };
  const exact = { ...original };
  assert.deepEqual(Core.selectRefetchedItem([wrongRoot, exact], original), exact);
});

test("id가 바뀐 경우 공개 identity가 유일할 때만 재식별한다", () => {
  const moved = { ...original, id: "cccccccccccccccccccccccc" };
  const otherRoot = {
    ...original,
    id: "dddddddddddddddddddddddd",
    source: "staging",
  };
  assert.deepEqual(Core.selectRefetchedItem([otherRoot, moved], original), moved);
});

test("루트가 다른데 공개 필드가 모두 같은 후보는 모호하므로 오파일을 고르지 않는다", () => {
  const candidateA = { ...original, id: "eeeeeeeeeeeeeeeeeeeeeeee" };
  const candidateB = { ...original, id: "ffffffffffffffffffffffff" };
  assert.equal(Core.selectRefetchedItem([candidateA, candidateB], original), null);
});

test("task identity에는 board와 task id가 모두 포함된다", () => {
  const taskItem = {
    ...original,
    task: { id: "task-a", board: "board-a", title: "same" },
  };
  const wrongBoard = {
    ...taskItem,
    id: "111111111111111111111111",
    task: { id: "task-a", board: "board-b", title: "same" },
  };
  const right = { ...taskItem, id: "222222222222222222222222" };
  assert.deepEqual(Core.selectRefetchedItem([wrongBoard, right], taskItem), right);
});

test("renderer mapping은 SVG를 img 전용, PDF를 download-only로 결정한다", () => {
  assert.equal(Core.previewKind({ name: "safe.png", kind: "image" }), "image");
  assert.equal(Core.previewKind({ name: "active.svg", kind: "other" }), "svg-img");
  assert.equal(Core.previewKind({ name: "notes.md", kind: "text" }), "markdown");
  assert.equal(Core.previewKind({ name: "table.csv", kind: "text" }), "text");
  assert.equal(Core.previewKind({ name: "document.pdf", kind: "doc" }), "download");
  assert.equal(Core.previewKind({ name: "page.html", kind: "other" }), "download");
});

test("download-only 배지는 SVG에는 없고 PDF/HTML/unknown에는 있다", () => {
  assert.equal(Core.isDownloadOnly({ name: "active.svg", kind: "other" }), false);
  assert.equal(Core.badgeForItem({ name: "active.svg", kind: "other" }), null);
  for (const item of [
    { name: "document.pdf", kind: "doc" },
    { name: "page.html", kind: "other" },
    { name: "archive.bin", kind: "other" },
  ]) {
    assert.equal(Core.isDownloadOnly(item), true);
    assert.equal(Core.badgeForItem(item), "download-only");
  }
});
