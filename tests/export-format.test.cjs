'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../shared/core.js');
const formatter = require('../shared/export-format.js');

const START = Date.parse('2026-10-21T01:00:00.000Z');

function hash(role, text) {
  return core.messageHash({ role, text });
}

function fixture(overrides = {}) {
  const relayToChatGpt = '接续 DeepSeek 的讨论：\n\nDeepSeek：\nDeepSeek 第一答\n\n请继续回应。';
  const relayToDeepSeek = '接续 ChatGPT 的讨论：\n\nChatGPT：\nChatGPT 第一答\n\n请继续回应。';
  const archive = {
    transfers: [
      {
        operationId: 'op-1',
        sourceProvider: 'deepseek',
        provider: 'chatgpt',
        sourceConversationKey: 'deepseek:novel',
        targetConversationKey: 'chatgpt:novel',
        sourceUrl: 'https://chat.deepseek.com/a/chat/s/novel',
        targetUrl: 'https://chatgpt.com/c/novel',
        targetMessageId: 'relay-chatgpt-1',
        targetMessageHash: hash('user', relayToChatGpt),
        createdAt: START,
        instruction: '',
        sourceMessages: [
          { id: 'user-1', role: 'user', text: '从人物动机开始。',
            messageHash: hash('user', '从人物动机开始。'), messageIndex: 0 },
          { id: 'deepseek-1', role: 'assistant', text: 'DeepSeek 第一答',
            messageHash: hash('assistant', 'DeepSeek 第一答'), messageIndex: 1 },
        ],
        sourceText: 'DeepSeek 第一答',
        answerText: 'ChatGPT 第一答',
        answerMessageId: 'chatgpt-1',
        answerMessageHash: hash('assistant', 'ChatGPT 第一答'),
        answerMessageIndex: 1,
        answerObservedAt: START + 1000,
      },
      {
        operationId: 'op-2',
        sourceProvider: 'chatgpt',
        provider: 'deepseek',
        sourceConversationKey: 'chatgpt:novel',
        targetConversationKey: 'deepseek:novel',
        sourceUrl: 'https://chatgpt.com/c/novel',
        targetUrl: 'https://chat.deepseek.com/a/chat/s/novel',
        targetMessageId: 'relay-deepseek-2',
        targetMessageHash: hash('user', relayToDeepSeek),
        createdAt: START + 2000,
        instruction: '',
        sourceMessages: [
          { id: 'relay-chatgpt-1', role: 'user', text: relayToChatGpt,
            messageHash: hash('user', relayToChatGpt), messageIndex: 0 },
          { id: 'chatgpt-1', role: 'assistant', text: 'ChatGPT 第一答',
            messageHash: hash('assistant', 'ChatGPT 第一答'), messageIndex: 1 },
        ],
        sourceText: 'ChatGPT 第一答',
        answerText: 'DeepSeek 第二答',
        answerMessageId: 'deepseek-2',
        answerMessageHash: hash('assistant', 'DeepSeek 第二答'),
        answerMessageIndex: 3,
        answerObservedAt: START + 3000,
      },
    ],
    history: [],
  };
  const timeline = [
    { operationId: 'op-1', status: 'sent', startedAt: START,
      source: { provider: 'deepseek', conversationKey: 'deepseek:novel' },
      target: { provider: 'chatgpt', conversationKey: 'chatgpt:novel' } },
    { operationId: 'op-2', status: 'sent', startedAt: START + 2000,
      source: { provider: 'chatgpt', conversationKey: 'chatgpt:novel' },
      target: { provider: 'deepseek', conversationKey: 'deepseek:novel' } },
    { operationId: 'op-3', status: 'error', startedAt: START + 4000,
      source: { provider: 'deepseek', conversationKey: 'deepseek:novel' },
      target: { provider: 'chatgpt', conversationKey: 'chatgpt:novel' },
      error: { message: '目标页面未确认新用户消息' } },
  ];
  const bookmarks = {
    'chatgpt:novel': {
      conversationKey: 'chatgpt:novel',
      messageId: 'relay-chatgpt-1',
      messageHash: hash('user', relayToChatGpt),
      role: 'user',
      updatedAt: START + 5000,
    },
    'deepseek:novel': {
      conversationKey: 'deepseek:novel',
      messageId: 'deepseek-2',
      messageHash: hash('assistant', 'DeepSeek 第二答'),
      role: 'assistant',
      updatedAt: START + 5000,
    },
  };
  return formatter.buildExportDocument({
    session: { title: '小说讨论' },
    archive,
    timeline,
    bookmarks,
    exportedAt: START + 6000,
    includeTime: false,
    includeLinks: false,
    timeZone: 'Asia/Shanghai',
    ...overrides,
  });
}

test('generated relay envelopes are never exported as human speech', () => {
  assert.equal(formatter.isRelayEnvelope(
    '接续 ChatGPT 的讨论：\n\nChatGPT：\n回答\n\n请继续回应。'
  ), true);
  assert.equal(formatter.isRelayEnvelope('我想让你继续讨论人物动机。'), false);
  const document = fixture();
  const humanTexts = document.rounds.map((round) => round.user?.text).filter(Boolean);
  assert.deepEqual(humanTexts, ['从人物动机开始。']);
});

test('legacy archives also filter a relay payload stored in userText', () => {
  const document = formatter.buildExportDocument({
    session: { title: '旧记录' },
    archive: {
      transfers: [{
        operationId: 'legacy-op',
        sourceProvider: 'chatgpt',
        provider: 'deepseek',
        sourceConversationKey: 'chatgpt:legacy',
        targetConversationKey: 'deepseek:legacy',
        userText: '接续 DeepSeek 的讨论：\n\nDeepSeek：\n旧回答\n\n请继续回应。',
        sourceText: 'ChatGPT 的真实回答',
        answerText: 'DeepSeek 的真实回答',
        createdAt: START,
      }],
      history: [],
    },
    timeline: [],
    bookmarks: {},
    exportedAt: START,
    includeTime: false,
    includeLinks: false,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(document.rounds[0].user, null);
  assert.deepEqual(document.rounds[0].messages.map((message) => message.text), [
    'ChatGPT 的真实回答',
    'DeepSeek 的真实回答',
  ]);
});

test('one exchange becomes one round and repeated handoff answers appear once', () => {
  const document = fixture();
  assert.equal(document.rounds.length, 2);
  assert.deepEqual(document.rounds[0].messages.map((message) => (
    [message.provider, message.text]
  )), [
    ['deepseek', 'DeepSeek 第一答'],
    ['chatgpt', 'ChatGPT 第一答'],
  ]);
  assert.deepEqual(document.rounds[1].messages.map((message) => message.text), [
    'DeepSeek 第二答',
  ]);
  assert.equal(document.rounds.flatMap((round) => round.messages)
    .filter((message) => message.text === 'ChatGPT 第一答').length, 1);
  assert.deepEqual(document.rounds[1].missingProviders, ['chatgpt']);
});

test('pending and synced bookmarks use the existing cursor identities', () => {
  const document = fixture();
  const chatgpt = document.bookmarks.find((bookmark) => bookmark.provider === 'chatgpt');
  const deepseek = document.bookmarks.find((bookmark) => bookmark.provider === 'deepseek');
  assert.equal(chatgpt.state, 'pending');
  assert.equal(chatgpt.beforeEventId,
    document.rounds[0].messages.find((message) => message.provider === 'chatgpt').id);
  assert.equal(deepseek.state, 'synced');
  assert.equal(deepseek.afterEventId,
    document.rounds[1].messages.find((message) => message.provider === 'deepseek').id);
});

test('failed operations are retained in the relay appendix', () => {
  const document = fixture();
  assert.equal(document.relays.length, 3);
  assert.equal(document.relays[2].status, 'error');
  assert.equal(document.relays[2].detail, '目标页面未确认新用户消息');
  const markdown = formatter.formatMarkdown(document);
  assert.match(markdown, /DeepSeek → ChatGPT \| 未完成 \| 目标页面未确认新用户消息/);
});

test('round placeholders remain visible when no human or one AI is missing', () => {
  const markdown = formatter.formatMarkdown(fixture());
  assert.match(markdown, /## 第 2 轮[\s\S]*### 用户\n\n_本轮没有新的用户输入_/);
  assert.match(markdown, /### ChatGPT 2\n\n_尚未回复_/);
});

test('markdown golden snapshot stays compact and chronological', () => {
  const markdown = formatter.formatMarkdown(fixture());
  const expected = `# 小说讨论

- 导出时间：2026-10-21 09:00
- 参与者：DeepSeek、ChatGPT
- 接力：2 次成功 / 1 次未完成
- 当前进度：
  - ChatGPT：尚未同步回答，以下内容尚未传递
  - DeepSeek：已同步到这里

---

## 第 1 轮

### 用户

从人物动机开始。

### DeepSeek 1

DeepSeek 第一答

> 🔖 接力位置：ChatGPT 尚未同步回答，以下内容尚未传递

<!-- roundtable-bookmark conversation="chatgpt:novel" message="relay-chatgpt-1" state="pending" -->

### ChatGPT 1

> 转达自 DeepSeek 1

ChatGPT 第一答

---

## 第 2 轮

### 用户

_本轮没有新的用户输入_

### DeepSeek 2

> 转达自 ChatGPT 1

DeepSeek 第二答

> 🔖 接力位置：DeepSeek 已同步到这里

<!-- roundtable-bookmark conversation="deepseek:novel" message="deepseek-2" state="synced" -->

### ChatGPT 2

_尚未回复_

---

## 接力记录

| 时间 | 方向 | 状态 | 说明 |
|---|---|---|---|
| — | DeepSeek → ChatGPT | 成功 | 转达 1 条回答 |
| — | ChatGPT → DeepSeek | 成功 | 转达 1 条回答 |
| — | DeepSeek → ChatGPT | 未完成 | 目标页面未确认新用户消息 |
`;
  assert.equal(markdown, expected);
  assert.equal((markdown.match(/ChatGPT 第一答/g) || []).length, 1);
  assert.doesNotMatch(markdown, /已采集网页历史|来源 AI 的转达内容/);
});

test('JSON export exposes rounds, bookmarks and relay failures', () => {
  const parsed = JSON.parse(formatter.formatJson(fixture()));
  assert.deepEqual(parsed.participants, ['deepseek', 'chatgpt']);
  assert.equal(parsed.rounds[0].user.text, '从人物动机开始。');
  assert.equal(parsed.rounds[0].messages[1].relayFrom.provider, 'deepseek');
  assert.deepEqual(parsed.rounds[1].missingProviders, ['chatgpt']);
  assert.equal(parsed.bookmarks[0].state, 'pending');
  assert.equal(parsed.relays[2].error, '目标页面未确认新用户消息');
});

test('an out-of-range bookmark degrades explicitly instead of guessing', () => {
  const document = fixture({
    bookmarks: {
      'chatgpt:novel': {
        conversationKey: 'chatgpt:novel',
        messageId: 'not-mounted',
        messageHash: 'not-mounted',
        role: 'assistant',
      },
    },
  });
  assert.equal(document.bookmarks[0].state, 'unavailable');
  assert.match(formatter.formatMarkdown(document), /书签不在当前导出范围/);
});

test('a delivered relay with no answer is still pending the target reply', () => {
  const base = fixture();
  const archive = {
    transfers: [{
      operationId: 'pending-op',
      sourceProvider: 'deepseek',
      provider: 'chatgpt',
      sourceConversationKey: 'deepseek:pending',
      targetConversationKey: 'chatgpt:pending',
      targetMessageId: 'pending-relay',
      targetMessageHash: 'pending-hash',
      createdAt: START,
      instruction: '',
      sourceMessages: [{
        id: 'deepseek-pending', role: 'assistant', text: '等待 ChatGPT 回答',
        messageHash: hash('assistant', '等待 ChatGPT 回答'), messageIndex: 0,
      }],
      sourceText: '等待 ChatGPT 回答',
      answerText: '',
    }],
    history: [],
  };
  const document = formatter.buildExportDocument({
    session: { title: base.title },
    archive,
    timeline: [{
      operationId: 'pending-op', status: 'sent', startedAt: START,
      source: { provider: 'deepseek', conversationKey: 'deepseek:pending' },
      target: { provider: 'chatgpt', conversationKey: 'chatgpt:pending' },
    }],
    bookmarks: {
      'chatgpt:pending': {
        conversationKey: 'chatgpt:pending', messageId: 'pending-relay',
        messageHash: 'pending-hash', role: 'user',
      },
    },
    exportedAt: START,
    includeTime: false,
    includeLinks: false,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(document.bookmarks[0].state, 'pending');
  assert.match(formatter.formatMarkdown(document), /ChatGPT 尚未同步回答，以下内容尚未传递/);
});
