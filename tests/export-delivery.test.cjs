const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sidepanel = read('sidepanel.js');
const sidepanelHtml = read('sidepanel.html');
const platform = read('background/platform.js');
const commands = read('background/commands.js');

test('copying a message never opens a toast above the conversation', () => {
  assert.doesNotMatch(sidepanel, /已复制/);
  assert.match(sidepanel, /navigator\.clipboard\.writeText/);
});

test('export goes through the download API and overwrites the same file', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.match(platform, /chrome\.downloads\.download/);
  assert.match(platform, /conflictAction: 'overwrite'/);
  assert.match(platform, /saveAs: false/);
  assert.match(commands, /case 'RT_EXPORT_FILE'/);
  assert.match(sidepanel, /send\('RT_EXPORT_FILE'/);
  // The old anchor download is what produced "(1)", "(2)" suffixes.
  assert.doesNotMatch(sidepanel, /link\.download/);
});

test('side panel loads the pure export formatter before using it', () => {
  const coreAt = sidepanelHtml.indexOf('shared/core.js');
  const formatterAt = sidepanelHtml.indexOf('shared/export-format.js');
  const panelAt = sidepanelHtml.indexOf('sidepanel.js');
  assert.ok(coreAt >= 0 && coreAt < formatterAt && formatterAt < panelAt);
  assert.match(sidepanel, /RoundtableExport\.buildExportDocument/);
  assert.match(sidepanel, /RoundtableExport\.formatMarkdown/);
  assert.match(sidepanel, /RoundtableExport\.formatJson/);
  assert.doesNotMatch(sidepanel, /已采集网页历史|来源 AI 的转达内容/);
});

test('archive keeps export identities without changing delivery receipts', () => {
  const storage = read('background/storage.js');
  const relay = read('background/relay.js');
  assert.match(storage, /sourceMessages:/);
  assert.match(storage, /answerMessageId/);
  assert.match(storage, /answerMessageHash/);
  assert.match(relay, /capturedMessages: relayMessages\.map/);
});

test('delivery reconciliation is event-driven instead of a fixed polling window', () => {
  const relay = read('background/relay.js');
  assert.doesNotMatch(relay, /reconcileDeadline|now\(\) \+ 10000/);
  assert.match(relay, /OPERATION_STATES\.WAITING/);
  assert.match(relay, /armDeliveryWatcher/);
  assert.doesNotMatch(relay, /const deadlineAt = Number\(active\.deadlineAt\)/);
  const receipts = read('background/receipts.js');
  assert.match(receipts, /sendResult\.submitted === true/);
  assert.match(receipts, /foldedFresh/);
});
