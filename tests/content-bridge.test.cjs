const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'common.js'),
  'utf8',
);

function createBridge(adapter) {
  let listener = null;
  const emitted = [];
  const context = {
    AbortController,
    Date,
    Error,
    Map,
    Math,
    Promise,
    Set,
    String,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => undefined,
    document: {
      body: { nodeType: 1 },
      documentElement: { nodeType: 1 },
      querySelector: () => null,
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    location: { hostname: 'example.test', href: 'https://example.test/chat' },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(value) { listener = value; },
        },
        sendMessage(message, callback) {
          emitted.push(message);
          callback?.();
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(bridgeSource, context, { filename: 'content/common.js' });
  assert.equal(context.RoundtableContent.install(adapter), true);

  function dispatch(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('bridge response timeout')), 1000);
      const returned = listener(message, {}, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      if (returned !== true && !['RT_CANCEL', 'RT_RELAY_WATCH_DELIVERY'].includes(message.type)) {
        clearTimeout(timeout);
        reject(new Error(`unexpected synchronous result: ${returned}`));
      }
    });
  }

  return { context, dispatch, emitted };
}

test('forced inspection bypasses stale cache and relay history does not share the DOM cache', async () => {
  const calls = [];
  const h = createBridge({ id: 'fixture', matches: () => true, inspect: async (options) => {
    calls.push(options);
    return { conversationKey: 'fixture:one', messages: [
      { id: 'a', role: 'assistant', text: options.relayRead ? '完整历史' : `页面 ${calls.length}` },
    ] };
  } });
  await h.dispatch({ type: 'RT_INSPECT' });
  await h.dispatch({ type: 'RT_INSPECT' });
  assert.equal(calls.length, 1);
  const fresh = await h.dispatch({ type: 'RT_INSPECT', force: true });
  assert.equal(fresh.snapshot.messages[0].text, '页面 2');
  const full = await h.dispatch({ type: 'RT_INSPECT', relayRead: true });
  assert.equal(full.snapshot.messages[0].text, '完整历史');
  assert.equal(calls.length, 3);
});

test('canonical dispatch command reaches the adapter and emits a concrete USER_ACK', async () => {
  const calls = [];
  const bridge = createBridge({
    id: 'test',
    matches: () => true,
    inspect: async () => ({ messages: [] }),
    send: async (context) => {
      calls.push(context);
      return { sent: true, confirmed: true, userMessageId: 'user-1' };
    },
    wait: async () => ({ completed: true }),
  });

  const response = await bridge.dispatch({
    type: 'RT_RELAY_DISPATCH',
    operationId: 'op-1',
    prompt: 'hello',
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.operationId, 'op-1');
  assert.equal(calls[0].prompt, 'hello');
  assert.equal(calls[0].operationId, 'op-1');
  assert.equal(bridge.emitted[0].event, 'USER_ACK');
  assert.equal(bridge.emitted[0].operationId, 'op-1');
});

test('composer-cleared confirmation without a message id does not emit a false USER_ACK', async () => {
  const bridge = createBridge({
    id: 'test',
    matches: () => true,
    inspect: async () => ({ messages: [] }),
    send: async () => ({ sent: true, confirmed: true, confirmation: 'composer-cleared' }),
    wait: async () => ({ completed: true }),
  });

  const response = await bridge.dispatch({ type: 'RT_RELAY_DISPATCH', operationId: 'op-2' });
  assert.equal(response.ok, true);
  assert.equal(bridge.emitted.length, 0);
});

test('submitted but unconfirmed send is handed to the watcher instead of emitting FAILED', async () => {
  const bridge = createBridge({
    id: 'test',
    matches: () => true,
    inspect: async () => ({ messages: [] }),
    send: async () => ({ submitted: true, sent: false, confirmed: false,
      confirmation: 'composer-cleared' }),
  });
  const response = await bridge.dispatch({ type: 'RT_RELAY_DISPATCH', operationId: 'op-queued' });
  assert.equal(response.ok, true);
  assert.equal(bridge.emitted.length, 0);
});

test('delivery watcher responds immediately and reports page snapshots without submitting again', async () => {
  let inspections = 0;
  let sends = 0;
  const bridge = createBridge({
    id: 'test',
    matches: () => true,
    inspect: async () => {
      inspections += 1;
      return { provider: 'test', conversationKey: 'test:one', generating: true,
        messages: [{ id: 'u1', role: 'user', text: 'queued' }] };
    },
    send: async () => { sends += 1; return { submitted: true }; },
  });
  const response = await bridge.dispatch({
    type: 'RT_RELAY_WATCH_DELIVERY', operationId: 'op-watch', probeIntervalMs: 1000,
  });
  assert.equal(response.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(inspections, 1);
  assert.equal(sends, 0);
  assert.equal(bridge.emitted[0].event, 'DELIVERY_PROBE');
  assert.equal(bridge.emitted[0].operationId, 'op-watch');
  assert.equal(bridge.emitted[0].result.snapshot.generating, true);
});

test('canonical resume command emits COMPLETED with the original operation id', async () => {
  const bridge = createBridge({
    id: 'test',
    matches: () => true,
    inspect: async () => ({ messages: [] }),
    send: async () => ({ sent: true }),
    wait: async () => ({
      completed: true,
      message: { id: 'assistant-1', role: 'assistant', text: 'done' },
    }),
  });

  const response = await bridge.dispatch({ type: 'RT_RELAY_RESUME', operationId: 'op-3' });
  assert.equal(response.ok, true);
  assert.equal(response.result.message.text, 'done');
  assert.equal(bridge.emitted[0].event, 'COMPLETED');
  assert.equal(bridge.emitted[0].operationId, 'op-3');
});
