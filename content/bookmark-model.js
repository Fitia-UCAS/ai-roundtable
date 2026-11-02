(function initRoundtableBookmarkModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoundtableBookmarkModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBookmarkModel() {
  'use strict';

  function resolveAnchor(messages, cursor, locateCursor, isSelectable = () => true) {
    const list = Array.isArray(messages) ? messages : [];
    if (!cursor || !list.length) return null;
    const cursorIndex = Number(locateCursor?.(list, cursor));
    if (!Number.isInteger(cursorIndex) || cursorIndex < 0 || cursorIndex >= list.length) return null;
    const start = cursor.atStart === true ? cursorIndex : cursorIndex + 1;
    for (let index = start; index < list.length; index += 1) {
      if (isSelectable(list[index], index)) return { index, state: 'pending' };
    }
    return isSelectable(list[cursorIndex], cursorIndex)
      ? { index: cursorIndex, state: 'synced' }
      : null;
  }

  return { resolveAnchor };
});
