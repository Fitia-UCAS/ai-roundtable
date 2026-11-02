const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const BACKGROUND = path.join(ROOT, 'background');
const MODULES = [
  'platform.js',
  'state.js',
  'storage.js',
  'tabs.js',
  'receipts.js',
  'relay.js',
  'delivery.js',
  'manual-delivery.js',
  'sessions.js',
  'commands.js',
];

test('background entry declares one intentional module order', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const imports = [...entry.matchAll(/'([^']+\.js)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, [
    'shared/core.js',
    ...MODULES.map((file) => `background/${file}`),
  ]);
  for (const file of imports) assert.equal(fs.existsSync(path.join(ROOT, file)), true, file);
});

test('cross-module mutable state has one owner', () => {
  const state = fs.readFileSync(path.join(BACKGROUND, 'state.js'), 'utf8');
  for (const field of [
    'defaultSaveMode', 'panelPorts', 'runtimeState', 'tabCache',
    'activeTabId', 'selectedSourceTabId', 'tabRepairAt', 'panelWindowId',
  ]) {
    assert.match(state, new RegExp(`\\b${field}:`), field);
  }

  for (const file of MODULES.filter((name) => name !== 'state.js')) {
    const source = fs.readFileSync(path.join(BACKGROUND, file), 'utf8');
    assert.doesNotMatch(source, /^(?:let|const)\s+(?:runtimeState|tabCache|activeTabId|selectedSourceTabId|panelWindowId|panelPorts|tabRepairAt|defaultSaveMode)\b/m, file);
  }
});

test('background modules stay bounded by responsibility', () => {
  for (const file of MODULES) {
    const lines = fs.readFileSync(path.join(BACKGROUND, file), 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 500, `${file} has grown to ${lines} lines; split the responsibility first`);
  }
});
