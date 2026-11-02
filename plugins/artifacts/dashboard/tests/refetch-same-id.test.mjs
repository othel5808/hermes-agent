/**
 * refetch-same-id.test.mjs
 *
 * 테스트: 동일 ID 재시도
 *
 * 서버 재시작 후 _make_id 가 sha256 결정적 ID 를 반환하므로
 * refreshed.id === item.id 여도 shouldRetry 가 true 를 반환해야 한다.
 *
 * node --test 로 실행 가능.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRetry } from "./retry-logic.mjs";

describe("shouldRetry - 동일 ID 재시도", () => {
  it("refreshed 가 null 이면 false (포기)", () => {
    assert.equal(shouldRetry(null), false);
  });

  it("refreshed 가 undefined 이면 false (포기)", () => {
    assert.equal(shouldRetry(undefined), false);
  });

  it("refreshed ID 가 기존 ID 와 동일해도 true (재시도)", () => {
    // 서버 재시작 후 _make_id sha256 결정적 ID → 동일 ID 반환이 정상.
    // ID 동일 여부와 무관하게 목록 재조회 성공이면 content 재시도해야 함.
    const originalItem = { id: "abc123def456789012345678", rel_path: "output/img.png", kind: "image" };
    const refreshedItem = { id: "abc123def456789012345678", rel_path: "output/img.png", kind: "image" };
    assert.equal(shouldRetry(refreshedItem), true,
      "동일 ID 여도 목록 재조회 성공 시 재시도해야 한다 (서버 재시작 복구)");
  });

  it("refreshed ID 가 다르면 true (재시도)", () => {
    const refreshedItem = { id: "newid001002003004005006", rel_path: "output/img.png", kind: "image" };
    assert.equal(shouldRetry(refreshedItem), true);
  });
});
