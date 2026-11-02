/**
 * retry-logic.mjs
 *
 * refetchItem 재시도 결정 로직 - 순수 함수 분리.
 * dist/index.js (IIFE) 에서 DOM 없이 Node 에서도 테스트 가능하도록 분리.
 *
 * 핵심 규칙:
 *  - 서버 재시작 후 _make_id 가 sha256 결정적 ID 를 반환하므로
 *    refreshed.id 가 기존 item.id 와 동일해도 재시도해야 한다.
 *  - API 응답에 rel_path 가 없으므로 name + group 조합으로 항목을 식별한다.
 *  - 루트 간 동일 name 오선택을 막기 위해 kind 필터를 전달한다.
 */

/**
 * 404 재시도 여부를 결정한다.
 *
 * @param {object|null} refreshed - refetchItem 이 반환한 항목 (없으면 null)
 * @returns {boolean} true 이면 content 재시도, false 이면 포기
 */
export function shouldRetry(refreshed) {
  // refreshed 가 null/undefined 이면 목록에서 항목을 찾지 못한 것 → 포기.
  // refreshed.id 가 기존 id 와 같더라도 목록 재조회 성공 → 재시도.
  return refreshed !== null && refreshed !== undefined;
}

/**
 * refetchItem 에 전달할 필터 params 를 item 에서 도출한다.
 *
 * @param {object} item - 항목 객체 (kind 필드 필요)
 * @returns {object} params - refetchItem 에 전달할 필터
 */
export function buildRefetchParams(item) {
  // kind 필터: 루트 간 동일 name 에서 다른 kind 항목 오선택 방지.
  return { kind: item.kind || null };
}

/**
 * API 응답 항목 목록에서 item 과 동일한 항목을 찾는다.
 * API 응답에 rel_path 가 없으므로 name + group 조합으로 식별한다.
 *
 * @param {object[]} items - API 응답의 items 배열
 * @param {object} item - 찾을 항목 (name, group 필드 필요)
 * @returns {object|null} 매칭 항목, 없으면 null
 */
export function findItemInList(items, item) {
  return (items || []).find(function (i) {
    return i.name === item.name && i.group === item.group;
  }) || null;
}
