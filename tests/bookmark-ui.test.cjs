const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pickerSource = read('content/bookmark-picker.js');
const bookmarkModel = require('../content/bookmark-model.js');
const backgroundSource = ['commands.js', 'platform.js', 'sessions.js']
  .map((file) => read(`background/${file}`)).join('\n');

test('bookmark marker loads last on every supported chat page', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.content_scripts.length, 3);
  for (const entry of manifest.content_scripts) {
    assert.equal(entry.js.at(-1), 'content/bookmark-picker.js');
    assert.equal(entry.js.at(-2), 'content/bookmark-model.js');
  }
});

test('bookmark marker is inline, persistent, and follows stored relay progress', () => {
  assert.match(pickerSource, /dataset\.roundtableBookmarkChoice/);
  assert.match(pickerSource, /changes\.roundtableBookmarks/);
  assert.match(pickerSource, /new MutationObserver/);
  assert.match(pickerSource, /state === 'pending'/);
  assert.match(pickerSource, /state === 'synced'/);
  // Only a failed-selection notice may float; the bookmark itself stays inline.
  const controlSource = pickerSource.slice(pickerSource.indexOf('function createControl('),
    pickerSource.indexOf('function sendRuntime('));
  assert.doesNotMatch(controlSource, /position:fixed/);
  assert.doesNotMatch(pickerSource, /prefers-color-scheme/);
  assert.doesNotMatch(pickerSource, /\.title\s*=/);
});

test('bookmark marker anchors only to assistant answers on every site', () => {
  assert.match(pickerSource, /\[data-turn-key\] \.turn-action-controls/);
  assert.match(pickerSource, /article \[data-testid\*="copy-turn-action-button"\]/);
  assert.match(pickerSource, /message-actions div\[class\*="buttons-container"\]/);
  assert.match(pickerSource, /'\._965abe9'/);
  assert.match(pickerSource, /\.ds-assistant-message-main-content/);
  assert.match(pickerSource, /message\?\.role === 'assistant'/);
  assert.match(pickerSource, /conversation-turn/);
  assert.match(pickerSource, /className\.includes\('user-message'\)/);
  assert.match(pickerSource, /role === 'user'/);
  assert.doesNotMatch(pickerSource, /fallbackActionHost/);
});

test('message bookmark has one direct write path and no expiring selection session', () => {
  assert.match(pickerSource, /type: 'RT_BOOKMARK_SET'/);
  assert.match(pickerSource, /clear: true/);
  assert.doesNotMatch(pickerSource, /RT_BOOKMARK_PICKED/);
  assert.doesNotMatch(backgroundSource, /RT_BOOKMARK_PICKED/);
  assert.doesNotMatch(backgroundSource, /pendingBookmarkPick|INVALID_BOOKMARK_SELECTION/);
  assert.match(backgroundSource, /async function setBookmarkFromPage/);
});

test('bookmark marker is repaired together with the content bridge', () => {
  const files = read('background/platform.js');
  const block = files.match(/const CONTENT_SCRIPT_FILES = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0] || '';
  assert.equal((block.match(/content\/bookmark-picker\.js/g) || []).length, 3);
  assert.equal((block.match(/content\/bookmark-model\.js/g) || []).length, 3);
});

test('bookmark display advances by complete assistant answers, never user turns', () => {
  const rows = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' },
  ];
  const locate = (_items, cursor) => cursor.index;
  const assistantOnly = (item) => item.role === 'assistant';
  assert.deepEqual(bookmarkModel.resolveAnchor(rows, { index: 1 }, locate, assistantOnly),
    { index: 3, state: 'pending' });
  assert.deepEqual(bookmarkModel.resolveAnchor(rows.slice(0, 3), { index: 1 }, locate, assistantOnly),
    { index: 1, state: 'synced' });
  assert.deepEqual(bookmarkModel.resolveAnchor(rows, { atStart: true, index: 0 }, locate, assistantOnly),
    { index: 1, state: 'pending' });
  assert.deepEqual(bookmarkModel.resolveAnchor(rows, { index: 2 }, locate, assistantOnly),
    { index: 3, state: 'pending' });
  assert.equal(bookmarkModel.resolveAnchor(rows.slice(0, 3), { index: 2 }, locate, assistantOnly), null);
  assert.equal(bookmarkModel.resolveAnchor(rows, null, locate, assistantOnly), null);
});

test('bookmark observer always repairs a native action row replaced by the site', () => {
  assert.match(pickerSource, /new MutationObserver/);
  assert.match(pickerSource, /scheduleRefresh\(80\)/);
  assert.match(pickerSource, /mutation\.addedNodes/);
  assert.match(pickerSource, /isRelevantAddedNode/);
  assert.match(pickerSource, /childList: true/);
  assert.match(pickerSource, /subtree: true/);
  assert.doesNotMatch(pickerSource, /if \(!rendering\)/);
});

test('bookmark mounts before message inspection just like the reference injector', () => {
  const immediateMount = pickerSource.indexOf('render(null, null);');
  const inspect = pickerSource.indexOf('Promise.resolve(adapter.inspect({}))');
  assert.ok(immediateMount >= 0 && inspect > immediateMount);
  assert.match(pickerSource, /host\.prepend\(mount\)/);
  assert.match(pickerSource, /dataset\.roundtableBookmarkActions = 'true'/);
});

test('a native row without an assistant answer never receives a bookmark', () => {
  assert.match(pickerSource, /if \(!node\) continue;/);
  assert.doesNotMatch(pickerSource, /suffixOffset/);
  assert.match(bookmarkModel.resolveAnchor.toString(), /isSelectable\(list\[cursorIndex\]/);
});

test('bookmark write trusts only durable server ids beside the content hash', () => {
  const sessions = read('background/sessions.js');
  assert.match(sessions, /inferredIdentity\(id\) === 'native-id'/);
  assert.match(sessions, /core\.messageHash\(item\) === hash/);
  assert.match(sessions, /core\.makeStartCursor\(/);
  assert.match(sessions, /message\.clear === true/);
  assert.match(sessions, /resetBookmark\(\{ tabId, conversationKey:/);
});

test('page-side message hash stays byte-compatible with the background', () => {
  const core = read('shared/core.js');
  for (const source of [core, pickerSource]) {
    assert.match(source, /0x811c9dc5/);
    assert.match(source, /0x01000193/);
    assert.match(source, />>> 0\)\.toString\(36\)/);
    assert.match(source, /normalize\('NFKC'\)/);
  }
});
