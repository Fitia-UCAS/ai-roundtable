const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../shared/core.js');
const { loadBackground } = require('./load-background.cjs');

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function makeHarness({ noAck = false, mountDelayMs = 0, alteredText = false, unrelated = false,
  contradictoryReceipt = false, receiptOnly = false, initialStorage = {}, alreadyDelivered = '',
  collapsedAck = false, badCollapsedAck = false, queued = false,
  flattenParagraphs = false, renderNewlinesAsSpaces = false, collapseWords = false } = {}) {
  let listener;
  const storage = clone(initialStorage);
  const pending = [];
  const tabs = [
    { id: 11, url: 'https://chatgpt.com/c/chat-1', title: '来源对话', windowId: 1, active: true },
    { id: 22, url: 'https://gemini.google.com/app/gem-1', title: 'Gemini', windowId: 1, active: false },
  ];
  const messages = {
    11: [
      { id: 'a-user', role: 'user', text: 'SOURCE_PROMPT_KEEP_OUT_OF_STORAGE', complete: true },
      { id: 'a-answer', role: 'assistant', text: 'SOURCE_ANSWER_KEEP_OUT_OF_STORAGE', complete: true },
    ],
    22: [
      { id: 'b-user', role: 'user', text: 'OLD_GEMINI_PROMPT', complete: true },
      { id: 'b-answer', role: 'assistant', text: 'OLD_GEMINI_ANSWER', complete: true },
    ],
  };
  if (alreadyDelivered) messages[22].push({ id: 'b-recovered', role: 'user',
    text: alreadyDelivered, complete: true });
  const generating = { 11: false, 22: false };
  const conversationKeys = { 11: 'chatgpt:chat-1', 22: 'gemini:gem-1' };
  const historyMessages = {};
  const inspections = [];
  const dispatches = [];
  const watchers = [];
  const callbacks = () => ({ addListener() {} });
  function snapshot(id) {
    return {
      provider: id === 11 ? 'chatgpt' : 'gemini',
      providerName: id === 11 ? 'ChatGPT' : 'Gemini',
      conversationKey: conversationKeys[id],
      title: id === 11 ? '来源对话' : 'Gemini',
      url: tabs.find((tab) => tab.id === id).url,
      messages: clone(messages[id]),
      generating: generating[id],
      strategy: 'dom', truncated: false,
    };
  }
  const chrome = {
    runtime: { lastError: null,
      onMessage: { addListener(fn) { listener = fn; } },
      onConnect: callbacks(), onInstalled: callbacks(), onStartup: callbacks(),
      sendMessage(_message, cb) { cb?.(); },
    },
    storage: { local: {
      get(keys, cb) { cb(Object.fromEntries(keys.map((key) => [key, clone(storage[key])]))); },
      set(values, cb) { Object.assign(storage, clone(values)); cb(); },
    } },
    tabs: {
      query(_q, cb) { cb(clone(tabs)); },
      get(id, cb) { cb(clone(tabs.find((tab) => tab.id === id))); },
      update(id, patch, cb) {
        if (patch.active) tabs.forEach((tab) => { tab.active = tab.id === id; });
        cb(clone(tabs.find((tab) => tab.id === id)));
      },
      sendMessage(id, message, cb) {
        if (message.type === 'RT_INSPECT' || message.type === 'AI_ROUNDTABLE_INSPECT') {
          inspections.push({ id, ...clone(message) });
          cb({ ok: true, snapshot: { ...snapshot(id),
            ...((message.relayRead || message.relayRecheckId) && historyMessages[id] ? { messages: clone(historyMessages[id]), source: 'api', relayReadId: message.relayOperationId || message.relayRecheckId } : {}),
          } });
        } else if (message.type === 'RT_RELAY_DISPATCH') {
          dispatches.push({ id, prompt: message.prompt, operationId: message.operationId });
          const newUser = { id: `${id}-received-${dispatches.length}`, role: 'user',
            text: contradictoryReceipt ? 'DOM_CONTRADICTS_THE_RECEIPT'
              : unrelated ? 'SOMEONE_ELSE_POSTED_A_DIFFERENT_PROMPT'
              : flattenParagraphs ? message.prompt.replace(/\n+/gu, '')
              : renderNewlinesAsSpaces ? message.prompt.replace(/\n(?=<)/gu, ' ')
              : collapseWords ? message.prompt.replace('foo bar', 'foobar')
              : alteredText ? message.prompt.replace(/\s+/gu, ' ') : message.prompt,
            complete: true };
          if (!noAck && !receiptOnly && !queued) {
            if (mountDelayMs) setTimeout(() => messages[id].push(newUser), mountDelayMs);
            else messages[id].push(newUser);
          }
          generating[id] = queued || !noAck; // The target has NOT finished answering.
          const immediate = !noAck && !queued && (!mountDelayMs || receiptOnly);
          const croppedMessage = collapsedAck || badCollapsedAck
            ? { ...newUser, folded: true, text: badCollapsedAck
              ? '无关的另一条用户消息，绝不能算作本次发送的确认。'
              : newUser.text.slice(0, 120) + '…' }
            : newUser;
          const receiptMessage = contradictoryReceipt
            ? { id: newUser.id, role: 'user', text: message.prompt, complete: true }
            : immediate ? clone(croppedMessage) : null;
          cb({ ok: true, result: { submitted: true, sent: immediate, confirmed: immediate,
            confirmation: immediate ? 'user-message' : 'composer-cleared',
            matchType: collapsedAck || badCollapsedAck ? 'collapsed-preview'
              : flattenParagraphs || renderNewlinesAsSpaces ? 'reflow' : 'exact',
            collapsedEvidence: Boolean(collapsedAck || badCollapsedAck),
            userMessageId: immediate ? newUser.id : '',
            insertedMessage: receiptMessage,
            snapshot: snapshot(id) } });
        } else if (message.type === 'RT_RELAY_RESUME') {
          pending.push('unexpected-remote-answer-wait');
          cb({ ok: false, error: 'must not wait for an answer' });
        } else if (message.type === 'RT_RELAY_WATCH_DELIVERY') {
          watchers.push({ id, operationId: message.operationId });
          cb({ ok: true, result: { watching: true, operationId: message.operationId } });
        } else if (message.type === 'RT_RELAY_CANCEL') cb({ ok: true });
        else throw new Error(`unhandled content command: ${message.type}`);
      },
      onActivated: callbacks(), onUpdated: callbacks(), onRemoved: callbacks(),
    },
    windows: { update(_id, _opts, cb) { cb({}); } },
    scripting: { executeScript(_opts, cb) { cb([]); } },
    sidePanel: { setPanelBehavior: async () => undefined },
  };
  const context = { console, chrome, URL, crypto: webcrypto, structuredClone,
    setTimeout, clearTimeout };
  context.globalThis = context;
  loadBackground(context, core);
  async function command(type, data = {}) {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), 14000);
      assert.equal(listener({ type, ...data }, {}, (response) => {
        clearTimeout(timer);
        resolve(clone(response));
      }), true);
    });
  }
  async function emit(message, sender = { tab: { id: 22 } }) {
    return await new Promise((resolve) => {
      const returned = listener(message, sender, (response) => resolve(clone(response)));
      if (!returned) resolve(undefined);
    });
  }
  async function probe(id = 22) {
    const watcher = [...watchers].reverse().find((item) => item.id === id);
    if (!watcher) throw new Error(`no delivery watcher for tab ${id}`);
    return emit({
      type: 'RT_RELAY_EVENT', event: 'DELIVERY_PROBE', operationId: watcher.operationId,
      result: { snapshot: snapshot(id) },
    }, { tab: clone(tabs.find((tab) => tab.id === id)) });
  }
  return { command, emit, probe, storage, messages, generating, dispatches, pending,
    watchers, tabs, conversationKeys, historyMessages, inspections, context };
}

test('bookmark chosen on a mounted answer sends through the last answer in complete history', async () => {
  const h = makeHarness();
  h.historyMessages[11] = [...h.messages[11],
    { id: 'later-user', role: 'user', text: '还没有挂载的新问题' },
    { id: 'last-answer', role: 'assistant', text: '对话最末尾的新回答', complete: true }];
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const selected = await h.emit({ type: 'RT_BOOKMARK_SET', conversationKey: 'chatgpt:chat-1',
    messageId: 'a-answer', messageHash: core.messageHash(h.messages[11][1]),
  }, { tab: { id: 11 } });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(h.inspections.some((item) => item.relayRead), false, 'saving a bookmark must not fetch history');
  const sent = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22,
    expectedSourceConversationKey: 'chatgpt:chat-1' });
  assert.equal(sent.operationState, 'COMPLETED', JSON.stringify(sent.error));
  assert.equal(h.inspections.filter((item) => item.relayRead).length, 1);
  assert.equal(h.inspections.filter((item) => item.relayRecheckId).length, 1);
  assert.equal(h.inspections.find((item) => item.relayRead)?.relayBookmark?.messageId, 'a-answer');
  assert.match(h.dispatches[0].prompt, /对话最末尾的新回答/);
  assert.equal(sent.state.bookmarks['chatgpt:chat-1'].messageId, 'last-answer');
});

test('remounted older users without the last baseline turn do not contradict an awaiting delivery', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const started = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  h.messages[22].splice(0, h.messages[22].length,
    { id: 'history-user', role: 'user', text: '这是一条刚挂载的更早历史，并非刚刚发送' },
    { id: 'history-answer', role: 'assistant', text: '历史回答' });
  const waiting = await h.probe();
  assert.equal(waiting.watching, true);
  assert.equal(h.dispatches.length, 1);
  assert.equal((await h.command('RT_BOOTSTRAP')).state.bookmarks['chatgpt:chat-1'], undefined);
  h.messages[22].push({ id: 'actual-delivery', role: 'user', text: h.dispatches[0].prompt });
  const confirmed = await h.probe();
  assert.equal(confirmed.accepted, true);
  assert.equal((await h.command('RT_BOOTSTRAP')).state.bookmarks['chatgpt:chat-1'].lastOperationId, started.operationId);
});

test('incomplete new bubble is inconclusive until full text is mounted', async () => {
  const h = makeHarness({ queued: true });
  h.messages[11][1].text = '这是一段需要完整发送的很长回复。'.repeat(30);
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  const partial = { id: 'partial', role: 'user', text: h.dispatches[0].prompt.slice(0, 100) };
  h.messages[22].push(partial);
  assert.equal((await h.probe()).watching, true);
  partial.text = h.dispatches[0].prompt;
  assert.equal((await h.probe()).accepted, true);
  assert.equal(h.dispatches.length, 1);
});

test('an unanchored folded history bubble sharing the payload prefix is not a receipt', async () => {
  const h = makeHarness({ queued: true });
  h.messages[11][1].text = '很长的来源回答，包含足够多的正文。'.repeat(30);
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  h.messages[22].splice(0, h.messages[22].length,
    { id: 'older-folded', role: 'user', folded: true, text: h.dispatches[0].prompt.slice(0, 100) + '…' });
  assert.equal((await h.probe()).watching, true);
  h.messages[22].push({ id: 'delivered-full', role: 'user', text: h.dispatches[0].prompt });
  assert.equal((await h.probe()).accepted, true);
});

test('real unrelated input after the last baseline turn still terminates confirmation safely', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  h.messages[22].push({ id: 'other', role: 'user', text: '这是另一条完整的新用户消息' });
  assert.equal((await h.probe()).failed, true);
  assert.equal((await h.command('RT_BOOTSTRAP')).state.bookmarks['chatgpt:chat-1'], undefined);
});

test('old users changing DOM ids do not become a new user turn', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  h.messages[22].forEach((message) => { message.id += '-remounted'; });
  assert.equal((await h.probe()).watching, true);
  h.messages[22].push({ id: 'delivered', role: 'user', text: h.dispatches[0].prompt });
  assert.equal((await h.probe()).accepted, true);
});

test('refresh during waiting recovers delivery without dispatching again', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  h.messages[22].push({ id: 'after-refresh', role: 'user', text: h.dispatches[0].prompt });
  const refreshed = await h.command('RT_BOOTSTRAP', { windowId: 1, force: true });
  assert.equal(refreshed.state.busy, false);
  assert.equal(h.dispatches.length, 1);
  assert.equal(refreshed.state.bookmarks['chatgpt:chat-1'].messageId, 'a-answer');
});

test('megaphone completes after receiving the user message without waiting for target answer', async () => {
  const h = makeHarness();
  const boot = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(boot.ok, true);
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.operationState, 'COMPLETED');
  assert.equal(result.state.busy, false);
  assert.equal(result.state.activeOperation, null);
  assert.equal(result.state.timeline[0].status, 'sent');
  assert.equal(result.state.sourceTabId, 22);
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.generating[22], true);
  assert.deepEqual(h.pending, []);
  assert.equal(result.state.bookmarks['chatgpt:chat-1'].messageId, 'a-answer');
  assert.equal(result.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');
  const stored = JSON.stringify(h.storage);
  for (const secret of ['SOURCE_PROMPT_KEEP_OUT_OF_STORAGE',
    'SOURCE_ANSWER_KEEP_OUT_OF_STORAGE', 'OLD_GEMINI_PROMPT', 'OLD_GEMINI_ANSWER']) {
    assert.equal(stored.includes(secret), false, `persisted message text: ${secret}`);
  }
  assert.equal(JSON.stringify(result.state).includes('SOURCE_ANSWER_KEEP_OUT_OF_STORAGE'), false);
});

test('trusted collapsed-preview ACK accepts a new user bubble without waiting for the AI reply', async () => {
  const h = makeHarness({ collapsedAck: true });
  // The relay is long enough to produce a substantial folded preview.
  h.messages[11][1].text = 'SOURCE_ANSWER_KEEP_OUT_OF_STORAGE'.repeat(12);
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.operationState, 'COMPLETED');
  assert.equal(h.dispatches.length, 1);
  assert.equal(result.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');
});

test('next manual relay reads the newly completed reply directly from recipient page', async () => {
  const h = makeHarness();
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  const early = await h.command('RT_RELAY_START', { sourceTabId: 22, targetTabId: 11 });
  assert.equal(early.ok, false);
  assert.equal(early.error.code, 'SOURCE_GENERATING');
  assert.equal(h.dispatches.length, 1);

  h.generating[22] = false;
  h.messages[22].push({ id: 'gemini-new-answer', role: 'assistant',
    text: 'GEMINI_NEW_ANSWER_FROM_DOM', complete: true });
  const back = await h.command('RT_RELAY_START', { sourceTabId: 22, targetTabId: 11 });
  assert.equal(back.ok, true, JSON.stringify(back.error));
  assert.equal(back.operationState, 'COMPLETED');
  assert.equal(h.dispatches.length, 2);
  assert.match(h.dispatches[1].prompt, /GEMINI_NEW_ANSWER_FROM_DOM/);
  assert.doesNotMatch(h.dispatches[1].prompt, /OLD_GEMINI_ANSWER/);
  assert.equal(h.storage.roundtableRuntime.activeOperation, null);
  assert.equal(JSON.stringify(h.storage).includes('GEMINI_NEW_ANSWER_FROM_DOM'), false);
});


test('unconfirmed composer clear waits without advancing bookmarks or resending', async () => {
  const h = makeHarness({ noAck: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const outcome = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.operationState, 'WAITING');
  assert.equal(outcome.awaitingConfirmation, true);
  assert.equal(outcome.state.busy, true);
  assert.equal(outcome.state.activeOperation.state, 'WAITING');
  assert.deepEqual(Object.keys(outcome.state.bookmarks), []);
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.watchers.length, 1);
});

test('stopping an unconfirmed waiting send keeps the delivery warning', async () => {
  const h = makeHarness({ noAck: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const waiting = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  const stopped = await h.command('RT_RELAY_CANCEL', {
    operationId: waiting.state.activeOperation.id,
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.deliveryUncertain, true);
  assert.match(stopped.state.lastOperation.error.message, /可能已经收到/);
  assert.deepEqual(Object.keys(stopped.state.bookmarks), []);
  assert.equal(h.dispatches.length, 1);
});

test('queued send can wait through a long generation and complete from a late page probe', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const waiting = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(waiting.operationState, 'WAITING');
  assert.equal(waiting.state.activeOperation.target.generating, true);
  assert.equal(h.dispatches.length, 1);

  const check = await h.command('RT_OPERATION_CHECK');
  assert.equal(check.ok, true);
  assert.equal(check.state.activeOperation.state, 'WAITING');
  assert.equal(h.dispatches.length, 1, 'checking a queued send must never retransmit');

  h.messages[22].push({ id: 'queued-user', role: 'user',
    text: h.dispatches[0].prompt, complete: true });
  h.generating[22] = false;
  const late = await h.probe();
  assert.equal(late.ok, true, JSON.stringify(late.error));
  const completed = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(completed.state.activeOperation, null);
  assert.equal(completed.state.lastOperation.state, 'COMPLETED');
  assert.equal(completed.state.bookmarks['gemini:gem-1'].messageId, 'queued-user');
  assert.equal(h.dispatches.length, 1);
});

test('late USER_ACK is accepted while delivery is still waiting', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const waiting = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  const operationId = waiting.state.activeOperation.id;
  const prompt = h.dispatches[0].prompt;
  const late = await h.emit({
    type: 'RT_RELAY_EVENT', event: 'USER_ACK', operationId,
    result: {
      submitted: true, confirmed: true, confirmation: 'user-message', matchType: 'exact',
      userMessageId: 'late-user',
      insertedMessage: { id: 'late-user', role: 'user', text: prompt },
      snapshot: {
        provider: 'gemini', providerName: 'Gemini', conversationKey: 'gemini:gem-1',
        url: 'https://gemini.google.com/app/gem-1', generating: true,
        messages: [...h.messages[22], { id: 'late-user', role: 'user', text: prompt }],
      },
    },
  });
  assert.equal(late.ok, true, JSON.stringify(late.error));
  const completed = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(completed.state.lastOperation.state, 'COMPLETED');
  assert.equal(completed.state.bookmarks['gemini:gem-1'].messageId, 'late-user');
  assert.equal(h.dispatches.length, 1);
});


test('delayed target DOM mounting is reconciled without waiting for the assistant answer', async () => {
  const h = makeHarness({ mountDelayMs: 1100 });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.operationState, 'WAITING');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const receipt = await h.probe();
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error));
  const completed = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(completed.state.lastOperation.state, 'COMPLETED');
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.generating[22], true);
  assert.equal(completed.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');
});

test('rich-text paragraph flattening still confirms the actual submitted prompt', async () => {
  const h = makeHarness({ alteredText: true, mountDelayMs: 600 });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.operationState, 'WAITING');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await h.probe();
  const completed = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(completed.state.lastOperation.state, 'COMPLETED');
  assert.equal(h.dispatches.length, 1);
});

test('Gemini removing paragraph breaks still completes one submitted relay', async () => {
  const h = makeHarness({ flattenParagraphs: true });
  h.messages[11][1].text = '第一段：关于人物。\n\n第二段：**继续推进**。\n\n请继续回应。';
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.operationState, 'COMPLETED', JSON.stringify(result.error));
  assert.equal(h.dispatches.length, 1);
  assert.equal(result.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');
});

test('Gemini rendering Markdown tag newlines as spaces confirms one submitted relay', async () => {
  const h = makeHarness({ renderNewlinesAsSpaces: true });
  h.messages[11][1].text = 'ChatGPT：\n\n<box border radius="lg" padding={3}>\n<text weight="medium">正文</text>';
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.operationState, 'COMPLETED', JSON.stringify(result.error));
  assert.equal(h.dispatches.length, 1);
  assert.equal((h.dispatches[0].prompt.match(/ChatGPT：/gu) || []).length, 1);
  assert.equal(result.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');
});

test('a restarted worker verifies Gemini reflow from a persisted layout signature', async () => {
  const first = makeHarness({ queued: true });
  first.messages[11][1].text = '<box border radius="lg" padding={3}>\n<text weight="medium">正文</text>';
  await first.command('RT_BOOTSTRAP', { windowId: 1 });
  const sent = await first.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(sent.operationState, 'WAITING');
  const delivered = first.dispatches[0].prompt.replace(/\n(?=<)/gu, ' ');
  const recovered = makeHarness({ initialStorage: first.storage, alreadyDelivered: delivered });
  recovered.messages[22].push({ id: 'gemini-answer', role: 'assistant', text: '已回答' });
  const boot = await recovered.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(boot.state.lastOperation.state, 'COMPLETED');
  assert.equal(boot.state.bookmarks['gemini:gem-1'].messageId, 'b-recovered');
  assert.equal(recovered.dispatches.length, 0);
});

test('panel status check reads target DOM when the delivery watcher misses an event', async () => {
  const h = makeHarness({ queued: true });
  h.messages[11][1].text = '甲\n\n乙';
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const sent = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(sent.operationState, 'WAITING');
  h.messages[22].push({ id: 'arrived', role: 'user',
    text: h.dispatches[0].prompt.replace('甲\n\n乙', '甲 乙') });
  vm.runInContext('workerState.runtimeState.activeOperation.target.lastProbeAt = 0', h.context);
  const checked = await h.command('RT_OPERATION_CHECK');
  assert.equal(checked.state.lastOperation.state, 'COMPLETED');
  assert.equal(checked.state.bookmarks['gemini:gem-1'].messageId, 'arrived');
  assert.equal(h.dispatches.length, 1);
});

test('an older waiting relay can be manually reconciled without another submission', async () => {
  const first = makeHarness({ queued: true });
  first.messages[11][1].text = '甲\n\n乙';
  await first.command('RT_BOOTSTRAP', { windowId: 1 });
  const sent = await first.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  const persisted = clone(first.storage);
  delete persisted.roundtableRuntime.activeOperation.payload.reflowSignature;
  const delivered = first.dispatches[0].prompt.replace('甲\n\n乙', '甲 乙');
  const recovered = makeHarness({ initialStorage: persisted, alreadyDelivered: delivered });
  recovered.messages[22].push({ id: 'gemini-answer', role: 'assistant', text: '已经回答' });
  const boot = await recovered.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(boot.state.activeOperation.state, 'WAITING');
  const verified = await recovered.command('RT_RELAY_VERIFY_DELIVERY', { operationId: sent.operationId });
  assert.equal(verified.ok, true, JSON.stringify(verified.error));
  assert.equal(verified.state.lastOperation.state, 'COMPLETED');
  assert.equal(verified.state.bookmarks['gemini:gem-1'].messageId, 'b-recovered');
  assert.equal(recovered.dispatches.length, 0);
});

test('manual verification reads target history once when Gemini folds the delivered prompt', async () => {
  const first = makeHarness({ queued: true });
  first.messages[11][1].text = '甲\n\n乙'.repeat(40);
  await first.command('RT_BOOTSTRAP', { windowId: 1 });
  const sent = await first.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  const persisted = clone(first.storage);
  delete persisted.roundtableRuntime.activeOperation.payload.reflowSignature;
  const delivered = first.dispatches[0].prompt.replace('甲\n\n乙', '甲 乙');
  const recovered = makeHarness({ initialStorage: persisted });
  recovered.messages[22].push({ id: 'folded-user', role: 'user', folded: true,
    text: `${delivered.slice(0, 95)}…` });
  recovered.messages[22].push({ id: 'gemini-answer', role: 'assistant', text: '已经回答' });
  recovered.historyMessages[22] = [...recovered.messages[22].slice(0, 2),
    { id: 'full-user', role: 'user', text: delivered },
    { id: 'gemini-answer', role: 'assistant', text: '已经回答' }];
  const boot = await recovered.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(boot.state.activeOperation.state, 'WAITING');
  const verified = await recovered.command('RT_RELAY_VERIFY_DELIVERY', { operationId: sent.operationId });
  assert.equal(verified.ok, true, JSON.stringify(verified.error));
  assert.equal(verified.state.bookmarks['gemini:gem-1'].messageId, 'full-user');
  assert.equal(recovered.inspections.filter((item) => item.relayRead && item.id === 22).length, 1);
  assert.equal(recovered.dispatches.length, 0);
});

test('manual delivery verification rejects a different user message', async () => {
  const h = makeHarness({ queued: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const sent = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  h.messages[22].push({ id: 'different-user', role: 'user', text: '另一个不同的问题' });
  const result = await h.command('RT_RELAY_VERIFY_DELIVERY', { operationId: sent.operationId });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DELIVERY_STILL_UNCONFIRMED');
  assert.equal(result.state.bookmarks['chatgpt:chat-1'], undefined);
  assert.equal(h.dispatches.length, 1);
});

test('Gemini removing a Latin word separator is not an exact delivery receipt', async () => {
  const h = makeHarness({ collapseWords: true });
  h.messages[11][1].text = '请保留 foo bar 两个单词。';
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.operationState, 'WAITING');
  assert.equal(result.state.bookmarks['gemini:gem-1'], undefined);
  assert.equal(h.dispatches.length, 1);
});

test('unrelated post-baseline user message never becomes delivery ACK', async () => {
  const h = makeHarness({ unrelated: true, mountDelayMs: 200 });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.operationState, 'WAITING');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await h.probe();
  const failed = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(failed.state.lastOperation.error.code, 'DELIVERY_CONTRADICTED');
  assert.deepEqual(Object.keys(failed.state.bookmarks), []);
  assert.equal(h.dispatches.length, 1);
});

test('repeating the same source without newly completed content does not send twice', async () => {
  const h = makeHarness();
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const first = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(first.operationState, 'COMPLETED');
  h.generating[22] = false;
  const again = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(again.operationState, 'NO_CONTENT');
  assert.equal(h.dispatches.length, 1);
});


test('MV3 recovery uses persisted hash to confirm post-baseline user turn without storing text', async () => {
  const prompt = '接续 ChatGPT 的讨论：\n\n用户：\nOriginal payload text must remain private';
  const timestamp = Date.now();
  const cursor = core.makeCursor({ id: 'a-answer', role: 'assistant', text: 'SOURCE_ANSWER_KEEP_OUT_OF_STORAGE' },
    1, 'chatgpt:chat-1');
  const operation = {
    id: 'op-recovered', sessionId: 's1', state: 'DISPATCHED', createdAt: timestamp,
    updatedAt: timestamp,
    source: { tabId: 11, conversation: { provider: 'chatgpt', conversationKey: 'chatgpt:chat-1' },
      endBookmark: cursor },
    target: { tabId: 22, conversation: { provider: 'gemini', conversationKey: 'gemini:gem-1' },
      expectedConversationKey: 'gemini:gem-1', baselineMessageIds: ['b-user', 'b-answer'],
      baselineMessageKeys: [
        `b-user|user|${core.hashText('OLD_GEMINI_PROMPT')}`,
        `b-answer|assistant|${core.hashText('OLD_GEMINI_ANSWER')}`,
      ], baselineLastMessage: { id: 'b-answer', role: 'assistant' } },
    payload: { hash: core.hashText(prompt),
      compactHash: core.hashText(core.normalizeText(prompt).replace(/\s+/gu, '')) },
  };
  const h = makeHarness({
    alreadyDelivered: prompt,
    initialStorage: { roundtableRuntime: {
      schemaVersion: core.PROTOCOL_VERSION,
      activeSessionId: 's1',
      sessions: [{ session: { id: 's1', title: '延续讨论', createdAt: timestamp,
        updatedAt: timestamp }, bookmarks: {}, timeline: [], lastOperation: null }],
      activeOperation: operation,
    } },
  });
  const boot = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(boot.ok, true, JSON.stringify(boot.error));
  assert.equal(boot.state.busy, false);
  assert.equal(boot.state.lastOperation.state, 'COMPLETED');
  assert.equal(boot.state.bookmarks['chatgpt:chat-1'].messageId, 'a-answer');
  assert.equal(boot.state.bookmarks['gemini:gem-1'].messageId, 'b-recovered');
  assert.equal(h.dispatches.length, 0, 'recovery must never retransmit');
  assert.equal(JSON.stringify(h.storage).includes(prompt), false);
});

test('MV3 interrupted dispatch resumes delivery watching without retransmitting', async () => {
  const timestamp = Date.now();
  const h = makeHarness({ initialStorage: { roundtableRuntime: {
    schemaVersion: core.PROTOCOL_VERSION, activeSessionId: 's2',
    sessions: [{ session: { id: 's2', title: '保持书签', createdAt: timestamp,
      updatedAt: timestamp }, bookmarks: {}, timeline: [] }],
    activeOperation: { id: 'op-missing', sessionId: 's2', state: 'DISPATCHED',
      createdAt: timestamp, updatedAt: timestamp,
      source: { tabId: 11, conversation: { provider: 'chatgpt', conversationKey: 'chatgpt:chat-1' } },
      target: { tabId: 22, conversation: { provider: 'gemini', conversationKey: 'gemini:gem-1' },
        expectedConversationKey: 'gemini:gem-1', baselineMessageIds: ['b-user', 'b-answer'] },
      payload: { hash: core.hashText('not present') },
    },
  } } });
  const boot = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.equal(boot.ok, true);
  assert.equal(boot.state.busy, true);
  assert.equal(boot.state.activeOperation.state, 'WAITING');
  assert.deepEqual(Object.keys(boot.state.bookmarks), []);
  assert.equal(h.dispatches.length, 0);
});


test('new ChatGPT URL with old conversation DOM is blocked before any send', async () => {
  const h = makeHarness();
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  h.tabs[0].url = 'https://chatgpt.com/c/chat-2';
  // The URL changes first in a SPA; the adapter is still returning old chat-1.
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONVERSATION_CHANGED');
  assert.equal(h.dispatches.length, 0);
  assert.deepEqual(Object.keys(result.state.bookmarks), []);
});

test('outdated side panel click is refused after a conversation switch', async () => {
  const h = makeHarness();
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  h.tabs[0].url = 'https://chatgpt.com/c/chat-2';
  h.conversationKeys[11] = 'chatgpt:chat-2';
  h.messages[11] = [
    { id: 'new-user', role: 'user', text: 'NEW_PROMPT', complete: true },
    { id: 'new-assistant', role: 'assistant', text: 'NEW_ANSWER', complete: true },
  ];
  const stale = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22,
    expectedSourceConversationKey: 'chatgpt:chat-1' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'SOURCE_CONVERSATION_CHANGED');
  assert.equal(h.dispatches.length, 0);
  const fresh = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22,
    expectedSourceConversationKey: 'chatgpt:chat-2',
    expectedTargetConversationKey: 'gemini:gem-1' });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.error));
  assert.equal(fresh.operationState, 'COMPLETED');
  assert.equal(h.dispatches.length, 1);
  assert.match(h.dispatches[0].prompt, /NEW_ANSWER/);
  assert.doesNotMatch(h.dispatches[0].prompt, /SOURCE_ANSWER_KEEP_OUT_OF_STORAGE/);
  assert.equal(fresh.state.bookmarks['chatgpt:chat-2'].messageId, 'new-assistant');
  assert.equal(fresh.state.bookmarks['chatgpt:chat-1'], undefined);
});

test('changed destination conversation is blocked before sending', async () => {
  const h = makeHarness();
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  h.tabs[1].url = 'https://gemini.google.com/app/gem-2';
  h.conversationKeys[22] = 'gemini:gem-2';
  h.messages[22] = [
    { id: 'other-user', role: 'user', text: 'OTHER_GEMINI_USER', complete: true },
    { id: 'other-answer', role: 'assistant', text: 'OTHER_GEMINI_REPLY', complete: true },
  ];
  const stale = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22,
    expectedTargetConversationKey: 'gemini:gem-1' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'TARGET_CONVERSATION_CHANGED');
  assert.equal(h.dispatches.length, 0);
  assert.deepEqual(Object.keys(stale.state.bookmarks), []);
});

test('stale Gemini cursor does not send, and resetting only the current source cursor allows a deliberate new round', async () => {
  const h = makeHarness();
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const first = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(first.ok, true);
  const oldChatgptBookmark = first.state.bookmarks['chatgpt:chat-1'].messageId;
  h.generating[22] = false;
  h.messages[22] = [
    { id: 'b-user', role: 'user', text: 'OLD_GEMINI_PROMPT', complete: true },
    { id: 'b-answer', role: 'assistant', text: 'OLD_GEMINI_ANSWER', complete: true },
    { id: 'gemini-next-user', role: 'user', text: '手动新问题', complete: true },
    { id: 'gemini-next-answer', role: 'assistant', text: 'Gemini 最新回答', complete: true },
  ];
  const stale = await h.command('RT_RELAY_START', { sourceTabId: 22, targetTabId: 11 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'BOOKMARK_STALE');
  assert.match(stale.error.message, /尚未与本次读取的完整历史对齐/);
  assert.equal(h.dispatches.length, 1, 'stale bookmark cannot dispatch');

  const wrong = await h.command('RT_BOOKMARK_RESET', {
    tabId: 22, conversationKey: 'gemini:another-conversation',
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'SOURCE_CONVERSATION_CHANGED');
  assert.equal(wrong.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');

  const reset = await h.command('RT_BOOKMARK_RESET', { tabId: 22, conversationKey: 'gemini:gem-1' });
  assert.equal(reset.ok, true, JSON.stringify(reset.error));
  assert.equal(reset.cleared, true);
  assert.equal(reset.state.bookmarks['gemini:gem-1'], undefined);
  assert.equal(reset.state.bookmarks['chatgpt:chat-1'].messageId, oldChatgptBookmark);
  assert.equal(h.dispatches.length, 1);

  const retry = await h.command('RT_RELAY_START', { sourceTabId: 22, targetTabId: 11 });
  assert.equal(retry.ok, true, JSON.stringify(retry.error));
  assert.equal(h.dispatches.length, 2);
  assert.match(h.dispatches[1].prompt, /Gemini 最新回答/);
  assert.doesNotMatch(h.dispatches[1].prompt, /OLD_GEMINI_ANSWER/);
});

test('a folded target user receipt remains a valid reverse-relay bookmark after the page re-renders the full text', async () => {
  const h = makeHarness({ collapsedAck: true });
  h.messages[11][1].text = 'SOURCE_ANSWER_KEEP_OUT_OF_STORAGE'.repeat(12);
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const first = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.operationState, 'COMPLETED');
  const cursor = first.state.bookmarks['gemini:gem-1'];
  assert.ok(cursor.sentMessageHash);
  assert.ok(cursor.sentSemanticHash);
  assert.equal(JSON.stringify(cursor).includes('SOURCE_ANSWER_KEEP_OUT_OF_STORAGE'), false);

  const confirmed = h.messages[22].at(-1);
  confirmed.id = 'rerendered-user-id';
  confirmed.text = confirmed.text.replace(/\s+/gu, ' ');
  h.messages[22].push({ id: 'reply', role: 'assistant', text: '完成回复，继续反向接力。', complete: true });
  h.generating[22] = false;

  const reverse = await h.command('RT_RELAY_START', { sourceTabId: 22, targetTabId: 11 });
  assert.equal(reverse.ok, true, JSON.stringify(reverse.error));
  assert.equal(reverse.operationState, 'COMPLETED');
  assert.equal(h.dispatches.length, 2);
  assert.match(h.dispatches[1].prompt, /完成回复.继续反向接力。/);
});

test('adapter exact receipt cannot overwrite contradictory DOM message', async () => {
  const h = makeHarness({ contradictoryReceipt: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.operationState, 'FAILED');
  assert.equal(result.state.lastOperation.error.code, 'DELIVERY_CONTRADICTED');
  assert.deepEqual(Object.keys(result.state.bookmarks), []);
  assert.equal(h.dispatches.length, 1);
});

test('a trusted receipt with no mounted DOM message is accepted once without a resend', async () => {
  const h = makeHarness({ receiptOnly: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const result = await h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.operationState, 'COMPLETED');
  assert.equal(h.dispatches.length, 1);
  assert.equal(result.state.bookmarks['gemini:gem-1'].messageId, '22-received-1');
  assert.equal(h.messages[22].some((message) => message.id === '22-received-1'), false);
});

test('late USER_ACK after cancellation cannot advance bookmarks', async () => {
  const h = makeHarness({ noAck: true });
  await h.command('RT_BOOTSTRAP', { windowId: 1 });
  const startPromise = h.command('RT_RELAY_START', { sourceTabId: 11, targetTabId: 22 });
  for (let attempt = 0; attempt < 80 && !h.dispatches.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(h.dispatches.length, 1);
  const operationId = h.dispatches[0].operationId;
  assert.ok(operationId);
  const cancelled = await h.command('RT_RELAY_CANCEL', { operationId });
  assert.equal(cancelled.cancelled, true);
  await Promise.race([
    startPromise.catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  const late = await h.emit({
    type: 'RT_RELAY_EVENT',
    event: 'USER_ACK',
    operationId,
    result: {
      userMessageId: 'late-message',
      insertedMessage: { id: 'late-message', role: 'user', text: '迟到的确认' },
    },
  });
  assert.equal(late.ignored, true);
  const boot = await h.command('RT_BOOTSTRAP', { windowId: 1 });
  assert.deepEqual(Object.keys(boot.state.bookmarks), []);
  assert.equal(boot.state.timeline[0].status, 'cancelled');
});
