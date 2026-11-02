const assert = require('node:assert/strict');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

const core = require('../shared/core.js');
const { loadBackground } = require('./load-background.cjs');

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createHarness(initialStorage = {}) {
  const storage = copy(initialStorage);
  let onMessage = null;
  const event = () => ({ addListener() {} });
  const context = {
    console,
    URL,
    crypto: webcrypto,
    structuredClone,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  context.chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of keys) result[key] = copy(storage[key]);
          callback(result);
        },
        set(values, callback) {
          Object.assign(storage, copy(values));
          callback();
        },
      },
    },
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          onMessage = listener;
        },
      },
      onConnect: event(),
      onInstalled: event(),
      onStartup: event(),
      sendMessage(_message, callback) {
        callback?.();
      },
    },
    tabs: {
      query(_query, callback) {
        callback([]);
      },
      get(_tabId, callback) {
        callback(null);
      },
      update(_tabId, _update, callback) {
        callback(null);
      },
      sendMessage(_tabId, _message, callback) {
        callback(null);
      },
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
    },
    windows: {
      update(_windowId, _update, callback) {
        callback(null);
      },
    },
    scripting: {
      executeScript(_options, callback) {
        callback([]);
      },
    },
    sidePanel: {
      setPanelBehavior: async () => undefined,
    },
  };

  loadBackground(context, core);
  assert.equal(typeof onMessage, 'function');

  async function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Command timed out: ${type}`)), 2000);
      const keepAlive = onMessage({ type, payload, requestId: `request-${type}` }, {}, (response) => {
        clearTimeout(timeout);
        resolve(copy(response));
      });
      assert.equal(keepAlive, true);
    });
  }

  return { send, storage, context };
}

test('refresh finds an AI tab after Edge moves the panel away from its saved window', async () => {
  for (const closedWindow of [false, true]) {
    const harness = createHarness();
    const gemini = { id: 9, windowId: 23, active: true,
      url: 'https://gemini.google.com/app/abc', title: 'Gemini' };
    harness.context.chrome.tabs.query = (query, callback) => {
      if (query.windowId === 77) {
        if (closedWindow) harness.context.chrome.runtime.lastError = { message: 'No window with id: 77' };
        callback([]);
        harness.context.chrome.runtime.lastError = null;
      } else callback([gemini]);
    };
    harness.context.inspectTab = async () => ({
      provider: 'gemini', providerName: 'Gemini', conversationKey: 'gemini:abc',
      url: gemini.url, title: 'Gemini', messages: [], revision: 'empty', generating: false,
    });
    const boot = await harness.send('RT_BOOTSTRAP', { windowId: 77, force: true });
    assert.equal(boot.ok, true);
    const response = await harness.send('RT_LIST_TABS');
    assert.equal(response.ok, true);
    assert.equal(response.tabs.length, 1);
    assert.equal(response.tabs[0].tabId, 9);
    assert.equal(response.tabs[0].connected, true);
  }
});

test('relay status remains readable while a long relay owns the background queue', async () => {
  const harness = createHarness();
  await harness.send('RT_BOOTSTRAP');
  let release;
  const blocked = harness.context.enqueue(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const status = await harness.send('RT_RELAY_STATUS');
  assert.equal(status.ok, true);
  assert.equal(status.activeOperation, null);
  release();
  await blocked;
});

test('旧版单会话数据会迁移成可切换的会话库', async () => {
  const oldSession = {
    id: 'session-old',
    title: '旧会议',
    status: 'active',
    createdAt: 100,
    updatedAt: 200,
  };
  const harness = createHarness({
    roundtableRuntime: {
      schemaVersion: core.PROTOCOL_VERSION,
      session: oldSession,
      bookmarks: { 'chatgpt:one': { messageId: 'a1' } },
      timeline: [{ operationId: 'op-old', status: 'done' }],
      lastOperation: { id: 'op-old', state: 'COMPLETED' },
      activeOperation: null,
      updatedAt: 200,
    },
    roundtableBookmarks: { 'gemini:legacy': { messageId: 'a2' } },
  });

  const boot = await harness.send('RT_BOOTSTRAP');
  assert.equal(boot.ok, true);
  assert.equal(boot.state.activeSessionId, 'session-old');
  assert.deepEqual(boot.state.sessions.map((item) => item.id), ['session-old']);
  assert.equal(boot.state.sessions[0].entryCount, 1);
  assert.equal(boot.state.bookmarks['chatgpt:one'].messageId, 'a1');
  assert.equal(boot.state.bookmarks['gemini:legacy'].messageId, 'a2');
});

test('新建、重命名、切换和删除都保留各自记录', async () => {
  const harness = createHarness({
    roundtableRuntime: {
      schemaVersion: core.PROTOCOL_VERSION,
      session: {
        id: 'session-first', title: '第一场', status: 'active', createdAt: 100, updatedAt: 200,
      },
      bookmarks: { 'chatgpt:first': { messageId: 'first' } },
      timeline: [{ operationId: 'op-first', status: 'done' }],
      lastOperation: null,
      activeOperation: null,
      updatedAt: 200,
    },
  });

  await harness.send('RT_BOOTSTRAP');
  const created = await harness.send('RT_SESSION_NEW', { title: '第二场' });
  assert.equal(created.ok, true);
  const secondId = created.state.activeSessionId;
  assert.notEqual(secondId, 'session-first');
  assert.equal(created.state.sessions.length, 2);

  const renamed = await harness.send('RT_SESSION_RENAME', {
    sessionId: secondId,
    title: '第二场圆桌会议',
  });
  assert.equal(renamed.state.session.title, '第二场圆桌会议');

  const switched = await harness.send('RT_SESSION_SWITCH', { sessionId: 'session-first' });
  assert.equal(switched.state.session.title, '第一场');
  assert.equal(switched.state.timeline[0].operationId, 'op-first');
  assert.equal(switched.state.bookmarks['chatgpt:first'].messageId, 'first');

  const deleted = await harness.send('RT_SESSION_DELETE', { sessionId: 'session-first' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.state.activeSessionId, secondId);
  assert.equal(deleted.state.session.title, '第二场圆桌会议');
  assert.equal(deleted.state.sessions.length, 1);

  const recreated = await harness.send('RT_SESSION_DELETE', { sessionId: secondId });
  assert.equal(recreated.ok, true);
  assert.equal(recreated.state.sessions.length, 1);
  assert.notEqual(recreated.state.activeSessionId, secondId);
});

test('会话库持久化后重新启动仍能恢复', async () => {
  const first = createHarness();
  await first.send('RT_BOOTSTRAP');
  const originalId = (await first.send('RT_SESSION_RENAME', { title: '保留的会议' }))
    .state.activeSessionId;
  const secondId = (await first.send('RT_SESSION_NEW', { title: '当前会议' }))
    .state.activeSessionId;

  const restarted = createHarness(first.storage);
  const boot = await restarted.send('RT_BOOTSTRAP');
  assert.equal(boot.state.activeSessionId, secondId);
  assert.equal(boot.state.sessions.length, 2);
  assert.ok(boot.state.sessions.some((item) => item.id === originalId && item.title === '保留的会议'));
  assert.ok(boot.state.sessions.some((item) => item.id === secondId && item.title === '当前会议'));
});

test('正在等待的讨论可以直接删除，并自动取消其操作', async () => {
  const timestamp = Date.now();
  const current = core.createSession('session-current', timestamp);
  const waiting = core.createRelayOperation({
    id: 'op-pending', sessionId: current.id, sourceTabId: 1,
    targetTabId: 2, now: timestamp,
  });
  waiting.state = core.OPERATION_STATES.WAITING;
  const harness = createHarness({
    roundtableRuntime: {
      schemaVersion: core.PROTOCOL_VERSION,
      session: current, bookmarks: {}, timeline: [], lastOperation: null,
      activeOperation: waiting, updatedAt: timestamp,
    },
  });
  const response = await harness.send('RT_SESSION_DELETE', { sessionId: current.id });
  assert.equal(response.ok, true);
  assert.equal(response.state.activeOperation, null);
  assert.notEqual(response.state.activeSessionId, current.id);
  assert.ok(!response.state.sessions.some((session) => session.id === current.id));
});

test('等待中的接力不阻止切换和新建讨论', async () => {
  const timestamp = Date.now();
  const first = core.createSession('session-first', timestamp);
  const second = core.createSession('session-second', timestamp);
  const waiting = core.createRelayOperation({
    id: 'op-pending', sessionId: first.id, sourceTabId: 1,
    targetTabId: 2, now: timestamp,
  });
  waiting.state = core.OPERATION_STATES.WAITING;
  const harness = createHarness({
    roundtableRuntime: {
      schemaVersion: core.PROTOCOL_VERSION,
      activeSessionId: first.id,
      sessions: [
        { session: first, bookmarks: {}, timeline: [], lastOperation: null },
        { session: second, bookmarks: {}, timeline: [], lastOperation: null },
      ],
      activeOperation: waiting, updatedAt: timestamp,
    },
  });
  const switched = await harness.send('RT_SESSION_SWITCH', { sessionId: second.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.state.activeSessionId, second.id);
  assert.equal(switched.state.activeOperation, null);
  const created = await harness.send('RT_SESSION_NEW', { title: '接下来的讨论' });
  assert.equal(created.ok, true);
  assert.equal(created.state.session.title, '接下来的讨论');
});

test('已有用户消息确认的旧版等待操作经检查直接完成并释放 BUSY', async () => {
  const timestamp = Date.now();
  const current = core.createSession('session-timeout', timestamp);
  const operation = core.createRelayOperation({
    id: 'op-stale', sessionId: current.id, sourceTabId: 1,
    targetTabId: 2, now: timestamp - 9 * 60 * 1000,
  });
  operation.state = core.OPERATION_STATES.WAITING;
  operation.target.insertedMessage = { id: 'user-new', role: 'user', text: 'new question', index: 2 };
  const harness = createHarness({
    roundtableRuntime: {
      schemaVersion: core.PROTOCOL_VERSION,
      session: current, bookmarks: {}, timeline: [], lastOperation: null,
      activeOperation: operation, updatedAt: timestamp,
    },
  });
  const checked = await harness.send('RT_OPERATION_CHECK');
  assert.equal(checked.ok, true);
  assert.equal(checked.state.activeOperation, null);
  assert.equal(checked.state.lastOperation.state, core.OPERATION_STATES.COMPLETED);
  assert.equal(checked.state.busy, false);
});
