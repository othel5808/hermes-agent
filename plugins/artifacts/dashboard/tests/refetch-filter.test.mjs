/**
 * refetch-filter.test.mjs
 *
 * 테스트: 필터 전달 + name+group 항목 식별
 *
 * 1. buildRefetchParams 가 item.kind 를 포함한 params 를 반환해야 한다.
 *    루트 간 동일 name 에서 다른 kind 항목 오선택 방지 목적.
 * 2. findItemInList 가 name+group 조합으로 올바른 항목을 찾아야 한다.
 *    API 응답에 rel_path 가 없으므로 rel_path 비교는 사용 불가.
 *
 * node --test 로 실행 가능.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRefetchParams, findItemInList } from "./retry-logic.mjs";

describe("buildRefetchParams - 필터 전달", () => {
  it("kind 필터를 반환한다", () => {
    const item = { id: "abc", name: "img.png", group: "output", kind: "image" };
    const params = buildRefetchParams(item);
    assert.equal(params.kind, "image",
      "루트 간 동일 name 오선택 방지를 위해 kind 필터를 전달해야 한다");
  });

  it("kind 가 없으면 null 반환", () => {
    const item = { id: "abc", name: "file.txt" };
    const params = buildRefetchParams(item);
    assert.equal(params.kind, null);
  });

  it("kind 가 'text' 이면 kind: 'text'", () => {
    const item = { id: "xyz", name: "readme.md", group: "notes", kind: "text" };
    const params = buildRefetchParams(item);
    assert.equal(params.kind, "text");
  });

  it("kind 가 'pdf' 이면 kind: 'pdf'", () => {
    const item = { id: "ppp", name: "spec.pdf", group: "docs", kind: "pdf" };
    const params = buildRefetchParams(item);
    assert.equal(params.kind, "pdf");
  });
});

describe("findItemInList - name+group 항목 식별", () => {
  const mockItems = [
    { id: "aaa111", name: "img.png", group: "project-a", kind: "image" },
    { id: "bbb222", name: "img.png", group: "project-b", kind: "image" },
    { id: "ccc333", name: "doc.md",  group: "project-a", kind: "text" },
  ];

  it("name 과 group 이 모두 일치하는 항목을 찾는다", () => {
    const item = { id: "aaa111", name: "img.png", group: "project-a" };
    const found = findItemInList(mockItems, item);
    assert.ok(found, "항목을 찾아야 한다");
    assert.equal(found.id, "aaa111");
  });

  it("같은 name 이라도 group 이 다르면 구별한다 (루트 간 오선택 방지)", () => {
    const item = { id: "bbb222", name: "img.png", group: "project-b" };
    const found = findItemInList(mockItems, item);
    assert.ok(found);
    assert.equal(found.id, "bbb222",
      "group 이 다른 동명 파일은 구별되어야 한다");
  });

  it("서버 재시작 후 동일 ID 가 반환되어도 올바른 항목을 찾는다", () => {
    // _make_id sha256 결정적 ID: 서버 재시작 후에도 동일 ID 반환 정상.
    const refreshedItems = [
      // 서버 재시작 후 스캔: 동일 id, 동일 name, 동일 group
      { id: "aaa111", name: "img.png", group: "project-a", kind: "image" },
    ];
    const item = { id: "aaa111", name: "img.png", group: "project-a" };
    const found = findItemInList(refreshedItems, item);
    assert.ok(found, "동일 ID 여도 항목을 찾아야 한다");
    assert.equal(found.id, "aaa111");
  });

  it("항목이 없으면 null 반환", () => {
    const item = { id: "xxx", name: "notexist.png", group: "project-a" };
    const found = findItemInList(mockItems, item);
    assert.equal(found, null);
  });

  it("빈 목록이면 null 반환", () => {
    const item = { id: "aaa111", name: "img.png", group: "project-a" };
    assert.equal(findItemInList([], item), null);
    assert.equal(findItemInList(null, item), null);
  });
});
