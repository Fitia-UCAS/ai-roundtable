const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../shared/core.js');

const messages = [
  { id: 'u1', role: 'user', text: '第一问' },
  { id: 'a1', role: 'assistant', text: '第一答' },
  { id: 'u2', role: 'user', text: '第二问' },
  { id: 'a2', role: 'assistant', text: '第二答' },
  { id: 'u3', role: 'user', text: '第三问' },
  { id: 'a3', role: 'assistant', text: '第三答' },
];

test('没有书签时复制最后一轮', () => {
  const plan = core.getCopyPlan(messages, null);
  assert.equal(plan.kind, 'last-round');
  assert.deepEqual(plan.messages.map((item) => item.id), ['u3', 'a3']);
});

test('书签后有多轮时复制全部新增内容', () => {
  const cursor = core.makeCursor(messages[1], 1, 'chatgpt:1');
  const plan = core.getCopyPlan(messages, cursor);
  assert.equal(plan.kind, 'fresh');
  assert.deepEqual(plan.messages.map((item) => item.id), ['u2', 'a2', 'u3', 'a3']);
});

test('优先用消息 ID 定位书签', () => {
  const cursor = { messageId: 'a2', messageHash: core.messageHash(messages[3]), messageIndex: 3, role: 'assistant' };
  assert.deepEqual(core.findCursorIndex(messages, cursor), { index: 3, method: 'id' });
});

test('重复的内容和 ID 无法用旧索引消歧，虚拟列表会改变位置', () => {
  const duplicated = [
    { id: 'same', role: 'assistant', text: '相同回答' },
    { id: 'u1', role: 'user', text: '中间问题' },
    { id: 'same', role: 'assistant', text: '相同回答' },
  ];
  const cursor = {
    messageId: 'same',
    messageHash: core.messageHash(duplicated[2]),
    messageIndex: 2,
    role: 'assistant',
    preview: '相同回答',
  };
  assert.deepEqual(core.findCursorIndex(duplicated, cursor), { index: -1, method: 'ambiguous' });
});

test('a synthetic bookmark never selects a duplicate by its old occurrence or index', () => {
  const same = { id: 'project-assistant:hash-1', role: 'assistant', text: 'Same answer.' };
  const cursor = core.makeStartCursor([same], 0, 'chatgpt:1');
  const changed = [same, { ...same, id: 'project-assistant:hash-2' }];
  assert.equal(core.findCursorIndex(changed, cursor).method, 'ambiguous');
  assert.equal(core.getRelayPlan(changed, cursor, 'chatgpt:1').kind, 'invalid-cursor');
  assert.equal(core.findCursorIndex(changed, { ...cursor, messageId: 'old-native-id' }).method, 'ambiguous');
});

test('legacy preview or bare id cannot authorize forwarding from a recycled position', () => {
  const messages = [{ id: 'same-id', role: 'assistant', text: 'Shared prefix but different ending.' }];
  for (const cursor of [
    { messageIndex: 0, role: 'assistant', preview: 'Shared prefix' },
    { messageIndex: 0, role: 'assistant', messageId: 'same-id' },
  ]) assert.equal(core.findCursorIndex(messages, cursor).index, -1);
});

test('ID 变化后使用内容哈希恢复书签', () => {
  const cursor = core.makeCursor(messages[3], 3, 'chatgpt:1');
  const changed = messages.map((item) => ({ ...item, id: `new-${item.id}` }));
  assert.deepEqual(core.findCursorIndex(changed, cursor), { index: 3, method: 'hash' });
});

test('找不到旧消息时明确标记书签失效', () => {
  const cursor = core.makeCursor({ id: 'gone', role: 'assistant', text: '已删除' }, 9, 'chatgpt:1');
  assert.equal(core.getCopyPlan(messages, cursor).kind, 'invalid-cursor');
});

test('相同内容出现多次且索引不可用时不猜测位置', () => {
  const duplicated = [
    { id: 'u1', role: 'user', text: '同一句重复内容' },
    { id: 'a1', role: 'assistant', text: '回答' },
    { id: 'u2', role: 'user', text: '同一句重复内容' },
  ];
  const cursor = {
    messageId: 'missing',
    messageHash: core.messageHash(duplicated[0]),
    messageIndex: 99,
    role: 'user',
    preview: '同一句重复内容',
  };
  assert.equal(core.findCursorIndex(duplicated, cursor).method, 'ambiguous');
  assert.equal(core.getCopyPlan(duplicated, cursor).kind, 'invalid-cursor');
});

test('没有新增内容时再次复制最近一轮', () => {
  const cursor = core.makeCursor(messages[5], 5, 'chatgpt:1');
  const plan = core.getCopyPlan(messages, cursor);
  assert.equal(plan.kind, 'repeat-last-round');
  assert.deepEqual(plan.messages.map((item) => item.id), ['u3', 'a3']);
});

test('粘贴消息片段可以定位，多处匹配会全部返回', () => {
  const withDuplicates = [
    ...messages,
    { id: 'a4', role: 'assistant', text: '这是第二个回答的完整补充内容' },
  ];
  const result = core.locateAnchor(withDuplicates, '这是第二个回答的完整补充内容');
  assert.equal(result.reason, 'exact');
  assert.equal(result.matches.length, 1);
  const partial = core.locateAnchor(withDuplicates, '第二个回答的完整补充');
  assert.equal(partial.matches[0].message.id, 'a4');
});

test('格式化结果保留角色顺序', () => {
  const result = core.formatMessages(messages.slice(0, 2), 'ChatGPT', { title: 'ChatGPT 对话片段' });
  assert.match(result, /【我】\n第一问/);
  assert.match(result, /【ChatGPT】\n第一答/);
  assert.match(result, /继续讨论/);
});

test('接力首次只发送最后一个完整回合并记录真实末尾位置', () => {
  const plan = core.getRelayPlan(messages, null, 'chatgpt:1');
  assert.equal(plan.kind, 'initial');
  assert.deepEqual(plan.messages.map((item) => item.id), ['u3', 'a3']);
  assert.equal(plan.endCursor.messageId, 'a3');
  assert.equal(plan.endCursor.messageIndex, 5);
  assert.equal(plan.endCursor.conversationKey, 'chatgpt:1');
});

test('从第一条设置书签时按起点语义发送整段内容', () => {
  const cursor = core.makeStartCursor(messages, 0, 'chatgpt:1');
  assert.equal(cursor.atStart, true);
  assert.equal(cursor.messageId, 'u1');
  const plan = core.getRelayPlan(messages, cursor, 'chatgpt:1');
  assert.equal(plan.kind, 'incremental');
  assert.deepEqual(plan.messages.map((item) => item.id), messages.map((item) => item.id));
  assert.equal(plan.endCursor.messageId, 'a3');
});

test('点击中间消息时书签直接锚定所选消息并包含它', () => {
  const cursor = core.makeStartCursor(messages, 2, 'chatgpt:1');
  assert.equal(cursor.messageId, 'u2');
  assert.equal(cursor.messageIndex, 2);
  assert.equal(cursor.atStart, true);
  const plan = core.getRelayPlan(messages, cursor, 'chatgpt:1');
  assert.deepEqual(plan.messages.map((item) => item.id), ['u2', 'a2', 'u3', 'a3']);
});

test('selected answer stays usable when its preceding long user bubble folds or unmounts', () => {
  const cursor = core.makeStartCursor(messages, 3, 'chatgpt:1');
  const window = [messages[3], messages[4], messages[5]];
  const plan = core.getRelayPlan(window, cursor, 'chatgpt:1');
  assert.deepEqual(plan.messages.map((item) => item.id), ['a2', 'u3', 'a3']);
  assert.equal(plan.endCursor.messageId, 'a3');
});

test('legacy nested relay envelopes do not bounce back, while outer human additions survive', () => {
  const first = core.formatRelayMessages([{ role: 'assistant', text: '已经传过的老内容' }], 'Gemini');
  // Reproduce an old payload with nested transport messages.
  const nested = `接续 ChatGPT 的讨论：\n\n用户：\n${first}\n\nChatGPT：\n历史回复\n\n请继续回应。\n\n用户补充：\n请保留我的新要求`;
  const input = [
    { id: 'old', role: 'user', text: nested },
    { id: 'reply', role: 'assistant', text: '这次的新回复' },
    { id: 'correction', role: 'user', text: '我又做了一个修正' },
    { id: 'latest', role: 'assistant', text: '修正后的最终回复' },
  ];
  const cursor = core.makeStartCursor(input, 0, 'chatgpt:1');
  const plan = core.getRelayPlan(input, cursor, 'chatgpt:1');
  const text = core.formatRelayMessages(plan.messages, 'ChatGPT');
  assert.doesNotMatch(text, /已经传过|历史回复|接续 Gemini/);
  assert.match(text, /请保留我的新要求/);
  assert.match(text, /我又做了一个修正/);
  assert.match(text, /这次的新回复/);
  assert.equal((text.match(/请继续回应/g) || []).length, 1);
  assert.equal(plan.endCursor.messageId, 'latest');
});

test('same-line legacy relay envelopes are dropped instead of nested again', () => {
  // Pasted packages commonly collapse the newline after the colon:
  // "接续 ChatGPT 的讨论：ChatGPT：…" must still be treated as transport.
  const sameLine = '接续 ChatGPT 的讨论：ChatGPT：这是旧回答的全文。\n\n请继续回应。';
  const input = [
    { id: 'start', role: 'assistant', text: '从这条回答开始' },
    { id: 'envelope', role: 'user', text: sameLine },
    { id: 'answer', role: 'assistant', text: 'Gemini 的新回答' },
  ];
  const cursor = core.makeStartCursor(input, 0, 'gemini:1');
  const plan = core.getRelayPlan(input, cursor, 'gemini:1');
  assert.deepEqual(plan.messages.map((item) => item.id), ['start', 'answer']);
  const text = core.formatRelayMessages(plan.messages, 'Gemini');
  assert.doesNotMatch(text, /这是旧回答的全文|接续 ChatGPT/);
  assert.match(text, /从这条回答开始/);
  assert.match(text, /Gemini 的新回答/);
});

test('same-line relay envelope keeps only the human addition after its closing line', () => {
  const sameLine = '接续 ChatGPT 的讨论：ChatGPT：这是旧回答的全文。\n\n请继续回应。\n\n用户补充：\n请把这段改得更冷一些';
  const input = [
    { id: 'start', role: 'assistant', text: '起点回答' },
    { id: 'envelope', role: 'user', text: sameLine },
    { id: 'answer', role: 'assistant', text: '新的回答' },
  ];
  const cursor = core.makeStartCursor(input, 0, 'gemini:1');
  const plan = core.getRelayPlan(input, cursor, 'gemini:1');
  const text = core.formatRelayMessages(plan.messages, 'Gemini');
  assert.doesNotMatch(text, /这是旧回答的全文|接续 ChatGPT/);
  assert.match(text, /用户：\n请把这段改得更冷一些/);
});

test('ordinary user text mentioning a relay header is not treated as a package', () => {
  const ordinary = '我想讨论“接续 ChatGPT 的讨论：”这种格式。';
  const noEnding = '接续 ChatGPT 的讨论：ChatGPT：一段引用，没有结束标记。';
  const input = [
    { id: 'start', role: 'assistant', text: '起点回答' },
    { id: 'ordinary', role: 'user', text: ordinary },
    { id: 'no-ending', role: 'user', text: noEnding },
    { id: 'answer', role: 'assistant', text: '新的回答' },
  ];
  const cursor = core.makeStartCursor(input, 0, 'gemini:1');
  const plan = core.getRelayPlan(input, cursor, 'gemini:1');
  assert.deepEqual(plan.messages.map((item) => item.id), ['start', 'ordinary', 'no-ending', 'answer']);
});

test('twenty alternating relays stay bounded even after bookmark reset', () => {
  let payload = '原始用户问题';
  for (let turn = 0; turn < 20; turn++) {
    const messages = [
      { id: `u${turn}`, role: 'user', text: payload },
      { id: `a${turn}`, role: 'assistant', text: `第 ${turn} 轮的新回复` },
    ];
    payload = core.formatRelayMessages(core.getRelayPlan(messages, null).messages,
      turn % 2 ? 'Gemini' : 'ChatGPT');
    assert.ok(payload.length < 120, payload);
    assert.equal((payload.match(/请继续回应/g) || []).length, 1);
    if (turn) assert.doesNotMatch(payload, new RegExp(`第 ${turn - 1} 轮的新回复`));
  }
});

test('canonical history bookmark also locates its mounted rendered-text alias', () => {
  const rendered = { id: 'native-1', role: 'assistant', text: '这是重点' };
  const canonical = { ...rendered, text: '这是**重点**', contentAliases: [core.messageHash(rendered)] };
  const cursor = core.makeStartCursor([canonical], 0, 'chatgpt:1');
  assert.equal(core.findCursorIndex([rendered], cursor).index, 0);
  assert.equal(core.findCursorIndex([canonical], cursor).index, 0);
  assert.equal(core.findCursorIndex([{ ...rendered, text: '内容已被修改' }], cursor).index, -1);
});

test('bookmark survives whitespace-only API/DOM projection differences', () => {
  // The page renders paragraphs; the API returns Markdown. Both describe the
  // same answer, but their rendered previews differ by line breaks/spaces.
  const dom = {
    id: 'gemini-dom-assistant-1', role: 'assistant',
    text: '答案\n\n第一段\n\n第二段',
    renderedHash: core.semanticHash('答案 第一段 第二段'),
    renderedCompactHash: core.compactHash('答案第一段第二段'),
  };
  const api = {
    id: 'a1', role: 'assistant', text: '**答案**\n\n第一段\n\n第二段',
    renderedHash: core.semanticHash('答案第一段第二段'),
    renderedCompactHash: core.compactHash('答案第一段第二段'),
  };
  const cursor = core.makeStartCursor([dom], 0, 'gemini:1');
  assert.equal(core.findCursorIndex([api], cursor).index, 0);
  assert.equal(core.findCursorIndex([{ ...api, renderedCompactHash: core.compactHash('完全不同的回答') }], cursor).index, -1);
});

test('revision changes when a stable native message id gets different text', () => {
  assert.notEqual(core.conversationRevision([{ id: 'a', role: 'assistant', text: '旧内容' }]),
    core.conversationRevision([{ id: 'a', role: 'assistant', text: '新内容' }]));
});

test('增量接力截止到最后一个完整助手回答', () => {
  const stream = [
    ...messages.slice(0, 2),
    { id: 'u2', role: 'user', text: '完整的新问题' },
    { id: 'a2', role: 'assistant', text: '完整的新回答', complete: true },
    { id: 'u3', role: 'user', text: '还在等待的问题' },
    { id: 'a3', role: 'assistant', text: '仍在生成', complete: false },
  ];
  const cursor = core.makeCursor(stream[1], 1, 'chatgpt:1');
  const plan = core.getRelayPlan(stream, cursor, 'chatgpt:1');
  assert.equal(plan.kind, 'incremental');
  assert.deepEqual(plan.messages.map((item) => item.id), ['u2', 'a2']);
  assert.equal(plan.endCursor.messageId, 'a2');
});

test('手动接力没有新增时不重复最近一轮', () => {
  const cursor = core.makeCursor(messages[5], 5, 'chatgpt:1');
  const plan = core.getRelayPlan(messages, cursor, 'chatgpt:1');
  assert.equal(plan.kind, 'no-new');
  assert.equal(plan.messages.length, 0);
});

test('书签属于另一条对话时直接标记失效', () => {
  const cursor = core.makeCursor(messages[1], 1, 'chatgpt:old');
  const plan = core.getRelayPlan(messages, cursor, 'chatgpt:new');
  assert.equal(plan.kind, 'invalid-cursor');
  assert.equal(plan.reason, 'conversation-mismatch');
});

test('接力格式不暴露内部事务标记', () => {
  const result = core.formatRelayMessages(messages.slice(0, 2), 'Gemini');
  assert.match(result, /^接续 Gemini 的讨论：/);
  assert.match(result, /用户：\n第一问/);
  assert.match(result, /Gemini：\n第一答/);
  assert.doesNotMatch(result, /operation|roundtable|<!--/i);
});

test('事务状态只允许按定义推进', () => {
  const operation = core.createRelayOperation({
    id: 'op-1', sessionId: 'session-1', sourceTabId: 1, targetTabId: 2, now: 100,
  });
  const prepared = core.transitionOperation(operation, core.OPERATION_STATES.PREPARED, {
    payload: { text: '消息' },
  }, 200);
  assert.equal(prepared.state, 'PREPARED');
  assert.equal(prepared.payload.text, '消息');
  assert.throws(
    () => core.transitionOperation(prepared, core.OPERATION_STATES.COMPLETED),
    /不允许/
  );
});

test('恢复动作区分安全失败、目标对账和继续等待', () => {
  const base = core.createRelayOperation({ id: 'op-1', sourceTabId: 1, targetTabId: 2 });
  assert.equal(core.recoveryActionForOperation(base), 'FAIL_SAFE');
  const prepared = core.transitionOperation(base, core.OPERATION_STATES.PREPARED);
  const dispatched = core.transitionOperation(prepared, core.OPERATION_STATES.DISPATCHED);
  assert.equal(core.recoveryActionForOperation(dispatched), 'RECONCILE_TARGET');
  const acked = core.transitionOperation(dispatched, core.OPERATION_STATES.TARGET_ACKED);
  const waiting = core.transitionOperation(acked, core.OPERATION_STATES.WAITING);
  assert.equal(core.recoveryActionForOperation(waiting), 'RESUME_TARGET');
});

test('讨论记录按 operationId 幂等更新', () => {
  let timeline = core.upsertTimelineEntry([], { operationId: 'op-1', status: 'sending' });
  timeline = core.upsertTimelineEntry(timeline, { operationId: 'op-1', status: 'done' });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].status, 'done');
});

test('仅识别三个支持站点', () => {
  assert.equal(core.providerFromUrl('https://chatgpt.com/c/1'), 'chatgpt');
  assert.equal(core.providerFromUrl('https://gemini.google.com/app/1'), 'gemini');
  assert.equal(core.providerFromUrl('https://chat.deepseek.com/a/chat/s/1'), 'deepseek');
  assert.equal(core.providerFromUrl('https://example.com/'), '');
});


test('不存正文预览的书签仍必须匹配消息哈希，不能只猜索引', () => {
  const before = [
    { id: 'u1', role: 'user', text: '原来的问题' },
    { id: 'a1', role: 'assistant', text: '原来的回答' },
  ];
  const cursor = core.makeCursor(before[1], 1, 'chatgpt:one');
  assert.equal('preview' in cursor, false);
  const changed = [
    { id: 'u2', role: 'user', text: '另一条问题' },
    { id: 'a2', role: 'assistant', text: '不相干的回答' },
  ];
  assert.equal(core.findCursorIndex(changed, cursor).method, 'invalid');
  assert.equal(core.getRelayPlan(changed, cursor, 'chatgpt:one').kind, 'invalid-cursor');
});

test('visual collapsed or expanded rendering of the same full text remains recoverable', () => {
  const original = [{ id: 'synthetic-short', role: 'user', text:
    '接续 Gemini 的讨论：用户发言关于设计。这里是完整的三十多字描述，正文完整。' }];
  const cursor = core.makeCursor(original[0], 0, 'gemini:thread');
  const visuallyFolded = [{ id: 'synthetic-expanded', role: 'user', folded: true,
    text: original[0].text }];
  assert.equal(core.findCursorIndex(visuallyFolded, cursor).method, 'hash');
  assert.equal(core.getRelayPlan(visuallyFolded, cursor, 'gemini:thread').kind, 'no-new');
  const visuallyExpanded = [{ id: 'synthetic-expanded-plain', role: 'user', folded: false,
    text: original[0].text }];
  assert.equal(core.findCursorIndex(visuallyExpanded, cursor).method, 'hash');
  const ambiguous = [{ ...original[0], id: 'synthetic-a' }, { ...original[0], id: 'synthetic-b' }];
  assert.equal(core.getRelayPlan(ambiguous, { ...cursor, messageIndex: 99 }, 'gemini:thread').kind,
    'invalid-cursor');
  const mismatched = [{ id:'other',role:'user',text:'完全不相关的消息' }];
  assert.equal(core.getRelayPlan(mismatched, cursor, 'gemini:thread').kind, 'invalid-cursor');
});

test('whitespace and Markdown line-break changes match a semantic cursor hash', () => {
  const full = '第一段内容，需要保持。\n\n第二段内容，也需要保持。';
  const cursor = core.makeCursor({ id: 'compact-old', role: 'user', text: full }, 0, 'deepseek:thread');
  const changed = [{ id: 'compact-new', role: 'user',
    text: '第一段内容，需要保持。  第二段内容，也需要保持。' }];
  assert.equal(core.findCursorIndex(changed, cursor).method, 'semantic-hash');
});

test('DeepSeek delivery bookmark survives folded user bubble expanding to the actual submitted text', () => {
  const full = '接续 Gemini 的讨论：\n\n用户：\n这是一个用于确认书签稳定性的测试。\n\nGemini：\n回复内容非常完整。';
  const folded = '接续 Gemini 的讨论：\n\n用户：\n这是一个用于确认书签稳定性…';
  const original = { id: 'deepseek-dom-user-folded', role: 'user', folded: true, text: folded };
  const cursor = {
    ...core.makeCursor(original, 0, 'deepseek:thread'),
    sentMessageHash: core.messageHash({ role: 'user', text: full }),
    sentCompactHash: core.hashText(core.normalizeText(full).replace(/\s+/gu, '')),
  };
  const expanded = [{ id: 'deepseek-dom-user-expanded', role: 'user', text: full },
    { id: 'a1', role: 'assistant', text: '我已收到。' }];
  assert.deepEqual(core.findCursorIndex(expanded, cursor), { index: 0, method: 'sent-fingerprint' });
  assert.equal(core.getRelayPlan(expanded, cursor, 'deepseek:thread').kind, 'incremental');
});

test('submitted semantic fingerprint handles whitespace changes but never guesses across duplicates', () => {
  const full = '这是一个测试，\n有几行文本、要保留。';
  const cursor = {
    ...core.makeCursor({ id: 'old', role: 'user', text: '这是一条不完整的显示内容' }, 0, 'deepseek:thread'),
    sentMessageHash: core.messageHash({ role: 'user', text: full }),
    sentSemanticHash: core.semanticHash(full),
  };
  const changed = [{ id: 'new', role: 'user', text: '这是一个测试，有几行文本、要保留。' }];
  assert.equal(core.findCursorIndex(changed, cursor).method, 'sent-fingerprint');
  assert.equal(core.findCursorIndex([...changed, { ...changed[0], id: 'another' }], cursor).method, 'ambiguous');
  assert.equal(core.findCursorIndex([{ id: 'new', role: 'assistant', text: full }], cursor).method, 'invalid');
  assert.equal(core.getRelayPlan(changed, cursor, 'deepseek:another').kind, 'invalid-cursor');
});

test('same folded preview after a refresh is recoverable by content hash', () => {
  const preview = '固定开头：这是一个折叠预览，长度超过三十二个字符，刷新后仍应可恢复。';
  const cursor = core.makeCursor({
    id: 'deepseek-item:-2:q', role: 'user', folded: true, text: preview },
  1, 'deepseek:novel');
  const refreshed = [
    { id: 'a0', role: 'assistant', text: '上一轮回答' },
    { id: 'deepseek-item:211:q', role: 'user', folded: true, text: preview },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  assert.equal(core.findCursorIndex(refreshed, cursor).method, 'hash');
});

test('folded target bookmark expands with its full sent fingerprint', () => {
  const folded = '接续 Gemini 的讨论：用户发言关于设计，这里是折叠时能看到的前半段。';
  const full = `${folded} 展开后才会显示的完整正文。`;
  const cursor = core.makeCursor(
    { id: 'deepseek-dom-user-folded', role: 'user', folded: true, text: folded }, 0, 'deepseek:thread');
  cursor.sentMessageHash = core.messageHash({ role: 'user', text: full });
  const apiMessages = [
    { id: 'server-u1', role: 'user', text: full },
    { id: 'server-a1', role: 'assistant', text: '已收到。' },
  ];
  assert.equal(core.findCursorIndex(apiMessages, cursor).method, 'sent-fingerprint');
  assert.equal(core.getRelayPlan(apiMessages, cursor, 'deepseek:thread').kind, 'incremental');
});

test('native-id bookmark can be recovered from a DOM-only snapshot', () => {
  const full = '这是一个已经由 DeepSeek 历史接口确认过的稳定用户消息，长度足够做指纹。';
  const cursor = core.makeCursor(
    { id: 'server-u1', role: 'user', text: full }, 0, 'deepseek:thread');
  const domMessages = [
    { id: 'deepseek-dom-user-localhash', role: 'user', text: full },
    { id: 'deepseek-dom-assistant-localhash', role: 'assistant', text: '回答。' },
  ];
  assert.equal(core.findCursorIndex(domMessages, cursor).method, 'hash');
  assert.equal(core.getRelayPlan(domMessages, cursor, 'deepseek:thread').kind, 'incremental');
  const duplicated = domMessages.concat({ ...domMessages[0], id: 'deepseek-dom-user-other' });
  const ambiguousCursor = { ...cursor, messageIndex: 99 };
  assert.equal(core.findCursorIndex(duplicated, ambiguousCursor).method, 'ambiguous');
  assert.equal(core.getRelayPlan(duplicated, ambiguousCursor, 'deepseek:thread').kind, 'invalid-cursor');
});

test('API recovery still rejects a different conversation and missing messages', () => {
  const full = '这条消息只属于原来的 DeepSeek 对话，不能被迁移到另一条对话。';
  const cursor = core.makeCursor(
    { id: 'server-u1', role: 'user', text: full }, 0, 'deepseek:thread-a');
  const apiMessages = [
    { id: 'server-u1', role: 'user', text: full },
    { id: 'server-a1', role: 'assistant', text: '回答。' },
  ];
  assert.equal(core.getRelayPlan(apiMessages, cursor, 'deepseek:thread-b').kind, 'invalid-cursor');
  assert.equal(core.getRelayPlan(
    [{ id: 'server-x', role: 'user', text: '完全无关的另一条消息' }],
    cursor, 'deepseek:thread-a').kind, 'invalid-cursor');
});

test('DeepSeek DOM item bookmark keeps structural identity across re-render', () => {
  const before = [
    { id: 'deepseek-item:-4:q', role: 'user', text: '更早的问题' },
    { id: 'deepseek-item:-4:a', role: 'assistant', text: '更早的回答' },
    { id: 'deepseek-item:-1:q', role: 'user', folded: true, text: '折叠中的用户问题，这是一个足够长的前半段正文，长度超过三十二个字符。', domKey: '-1:q',
      turnOrdinal: 1, previousAssistantHash: core.messageHash({ role: 'assistant', text: '更早的回答' }) },
    { id: 'deepseek-item:1:a', role: 'assistant', text: '本轮回答' },
  ];
  const cursor = core.makeCursor(before[2], 2, 'deepseek:thread');
  cursor.sentMessageHash = core.messageHash({ role: 'user',
    text: '折叠中的用户问题，这是一个足够长的前半段正文，长度超过三十二个字符。 展开后的完整正文' });
  assert.equal(cursor.turnOrdinal, 1);
  assert.ok(cursor.previousAssistantHash);
  assert.equal(cursor.domKey, '-1:q');
  const rerendered = [
    { id: 'deepseek-item:-4:q', role: 'user', text: '更早的问题' },
    { id: 'deepseek-item:-4:a', role: 'assistant', text: '更早的回答' },
    { id: 'deepseek-item:9:q', role: 'user', text: '折叠中的用户问题，这是一个足够长的前半段正文，长度超过三十二个字符。 展开后的完整正文' },
    { id: 'deepseek-item:9:a', role: 'assistant', text: '本轮回答' },
  ];
  assert.equal(core.findCursorIndex(rerendered, cursor).method, 'turn-structure');
  assert.equal(core.getRelayPlan(rerendered, cursor, 'deepseek:thread').kind, 'incremental');
});

test('new conversation unanchored replacement is rejected even with one user turn', () => {
  const cursor = core.makeCursor(
    { id: 'deepseek-item:-2:q', role: 'user', text: '折叠前', domKey: '-2:q', turnOrdinal: 0 }, 0, 'deepseek:new');
  const dom = [
    { id: 'deepseek-item:7:q', role: 'user', text: '折叠后显示的另一段正文' },
    { id: 'deepseek-item:7:a', role: 'assistant', text: '回答' },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).method, 'invalid');
  assert.equal(core.getRelayPlan(dom, cursor, 'deepseek:new').kind, 'invalid-cursor');
});

test('same text with several user turns still recovers by content', () => {
  const cursor = core.makeCursor(
    { id: 'deepseek-item:-2:q', role: 'user', text: '第一问', turnOrdinal: 0 }, 0, 'deepseek:thread');
  const dom = [
    { id: 'deepseek-item:-2:q', role: 'user', text: '第一问' },
    { id: 'deepseek-item:1:a', role: 'assistant', text: '第一答' },
    { id: 'deepseek-item:2:q', role: 'user', text: '第二问' },
    { id: 'deepseek-item:2:a', role: 'assistant', text: '第二答' },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).method, 'id');
  const changed = dom.map((message) => ({ ...message, id: `new-${message.id}` }));
  const located = core.findCursorIndex(changed, cursor);
  assert.equal(located.index, 0);
  assert.ok(['turn-structure', 'hash', 'hash-index'].includes(located.method));
  assert.notEqual(located.index, 2);
});

test('identical user texts are separated by previous assistant anchor', () => {
  const shared = '完全相同的用户问题';
  const before = [
    { id: 'a1', role: 'assistant', text: '第一答' },
    { id: 'u2', role: 'user', text: shared },
    { id: 'a2', role: 'assistant', text: '第二答' },
    { id: 'u3', role: 'user', text: shared },
  ];
  const cursor = core.makeCursor({
    ...before[3],
    turnOrdinal: 1,
    previousAssistantHash: core.messageHash({ role: 'assistant', text: '第二答' }),
  }, 3, 'deepseek:thread');
  const changed = before.map((message) => ({ ...message, id: `changed-${message.id}` }));
  const located = core.findCursorIndex(changed, cursor);
  assert.ok(['turn-structure', 'hash-index'].includes(located.method));
  assert.equal(located.index, 3);
  assert.equal(core.getRelayPlan(changed, cursor, 'deepseek:thread').kind, 'no-new');
});

test('recycled virtual-list key with unrelated content is not accepted by id alone', () => {
  const old = { id: 'deepseek-item:-2:q', role: 'user', text: '原来的用户问题' };
  const cursor = core.makeCursor(old, 0, 'deepseek:thread');
  const recycled = [
    { id: 'deepseek-item:-2:q', role: 'user', text: '完全不同的替换消息' },
    { id: 'deepseek-item:2:a', role: 'assistant', text: '回答' },
  ];
  assert.notEqual(core.findCursorIndex(recycled, cursor).method, 'id');
  assert.equal(core.getRelayPlan(recycled, cursor, 'deepseek:thread').kind, 'invalid-cursor');
});

test('single unanchored user turn with unrelated content is rejected', () => {
  const cursor = core.makeCursor(
    { id: 'old', role: 'user', text: '旧的第一轮问题', turnOrdinal: 0 }, 0, 'deepseek:thread');
  const replaced = [
    { id: 'new', role: 'user', text: '完全无关的替换问题' },
    { id: 'answer', role: 'assistant', text: '回答' },
  ];
  assert.equal(core.getRelayPlan(replaced, cursor, 'deepseek:thread').kind, 'invalid-cursor');
});

test('single unanchored turn with confirmed sent fingerprint still recovers', () => {
  const full = '这是本次实际发送的完整正文，页面折叠后只显示一部分。';
  const cursor = {
    ...core.makeCursor(
      { id: 'old', role: 'user', text: '折叠预览…', turnOrdinal: 0 }, 0, 'deepseek:thread'),
    sentMessageHash: core.messageHash({ role: 'user', text: full }),
    sentCompactHash: core.hashText(core.normalizeText(full).replace(/\s+/gu, '')),
  };
  const rendered = [
    { id: 'new', role: 'user', text: full },
    { id: 'answer', role: 'assistant', text: '回答' },
  ];
  assert.ok(['sent-fingerprint', 'turn-structure'].includes(
    core.findCursorIndex(rendered, cursor).method));
  assert.equal(core.getRelayPlan(rendered, cursor, 'deepseek:thread').kind, 'incremental');
});

test('temporary bookmark migration requires the same tab, operation and a non-conflicting real key', () => {
  const oldKey = 'deepseek:new:/';
  const newKey = 'deepseek:244f81b8-e392-4f13-90da-fa5dd05c3eaf';
  const bookmark = { conversationKey: oldKey, lastOperationId: 'op-1' };
  const operation = { id: 'op-1', target: { tabId: 7, conversation: { conversationKey: oldKey } } };
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark, operation, tabId: 7 }), true);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark,
    operation: { id: 'op-1', target: { tabId: 8, conversation: { conversationKey: oldKey } } }, tabId: 7 }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark,
    operation: { id: 'op-1', target: { tabId: 7, conversation: { conversationKey: 'deepseek:other' } } }, tabId: 7 }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark, operation, tabId: 7,
    existingBookmark: { lastOperationId: 'op-2' } }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark, operation, tabId: 7,
    existingBookmark: {} }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark, operation, tabId: 7,
    existingBookmark: { lastOperationId: 'op-1' } }), true);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey: 'deepseek:real', newKey, bookmark,
    operation: { id: 'op-1', target: { tabId: 7, conversation: { conversationKey: 'deepseek:real' } } }, tabId: 7 }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey: 'deepseek:new:/x', bookmark, operation, tabId: 7 }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey: 'gemini:244f81b8-e392-4f13-90da-fa5dd05c3eaf', bookmark, operation, tabId: 7 }), false);
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark,
    operation: { id: 'op-2', target: { tabId: 7, conversation: { conversationKey: oldKey } } }, tabId: 7 }), false);
});

test('shared 32-character prefix without fold evidence is not identity', () => {
  const prefix = '这是一段完全相同的前缀文字，长度超过三十二个字符，后面才出现不同内容。';
  const old = { id: 'old', role: 'user', text: `${prefix} 原来的后半段正文。` };
  const cursor = core.makeCursor(old, 0, 'deepseek:thread');
  const other = [
    { id: 'new', role: 'user', text: `${prefix} 完全不同的另一条后半段，并且长度刻意不同。` },
    { id: 'answer', role: 'assistant', text: '回答' },
  ];
  assert.notEqual(core.findCursorIndex(other, cursor).method, 'user-reformatted');
  assert.equal(core.getRelayPlan(other, cursor, 'deepseek:thread').kind, 'invalid-cursor');
});

test('same turn structure with unrelated content cannot restore the bookmark', () => {
  const answer = '相同的上一轮助手回答';
  const before = [
    { id: 'a0', role: 'assistant', text: answer },
    { id: 'u1', role: 'user', text: '原来的用户问题正文', turnOrdinal: 0,
      previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }) },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  const cursor = core.makeCursor(before[1], 1, 'deepseek:thread');
  const replaced = [
    { id: 'a0', role: 'assistant', text: answer },
    { id: 'different-id', role: 'user', text: '完全不同的替换正文' },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  assert.equal(core.getRelayPlan(replaced, cursor, 'deepseek:thread').kind, 'invalid-cursor');
});

test('folded bookmark with a saved full sent fingerprint rejects a different full message sharing its 32-char prefix', () => {
  const fixed = '相同固定开头：请继续修改这部小说，并保持人物关系一致，具体要求如下。';
  const foldedA = `${fixed} 小说修改要求 A：调整第三章的节奏。`;
  const fullA = `${fixed} 小说修改要求 A：调整第三章的节奏，并补足结尾伏笔。`;
  const fullB = `${fixed} 小说修改要求 B：把第四章改成倒叙，并删掉所有支线。`;
  const answer = '上一轮助手回答';
  const before = [
    { id: 'a0', role: 'assistant', text: answer },
    { id: 'deepseek-item:-2:q', role: 'user', folded: true, text: foldedA,
      domKey: '-2:q', turnOrdinal: 0,
      previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }) },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  const cursor = core.makeCursor(before[1], 1, 'deepseek:novel');
  cursor.sentMessageHash = core.messageHash({ role: 'user', text: fullA });
  const candidate = [
    { id: 'a0', role: 'assistant', text: answer },
    { id: 'deepseek-item:211:q', role: 'user', text: fullB,
      domKey: '211:q', turnOrdinal: 0,
      previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }) },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  const located = core.findCursorIndex(candidate, cursor);
  assert.notEqual(located.method, 'turn-structure');
  assert.equal(located.index, -1);
  assert.equal(core.getRelayPlan(candidate, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('same-operation bookmarks with different message fingerprints are not migration-compatible', () => {
  const oldKey = 'deepseek:new:/';
  const newKey = 'deepseek:244f81b8-e392-4f13-90da-fa5dd05c3eaf';
  const operation = { id: 'op-1', target: { tabId: 7, conversation: { conversationKey: oldKey } } };
  const first = { id: 'u1', role: 'user', text: '小说修改要求 A：调整第三章节奏。' };
  const second = { id: 'u2', role: 'user', text: '小说修改要求 B：把第四章改成倒叙。' };
  const bookmark = { ...core.makeCursor(first, 0, oldKey), lastOperationId: 'op-1',
    sentMessageHash: core.messageHash(first) };
  const conflicting = { ...core.makeCursor(second, 0, newKey), lastOperationId: 'op-1',
    sentMessageHash: core.messageHash(second) };
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark,
    operation, tabId: 7, existingBookmark: conflicting }), false);
  const equivalent = { ...core.makeCursor(first, 0, newKey), lastOperationId: 'op-1',
    sentMessageHash: core.messageHash(first) };
  assert.equal(core.canMigrateTemporaryBookmark({ oldKey, newKey, bookmark,
    operation, tabId: 7, existingBookmark: equivalent }), true);
});

test('a currently folded different message cannot match only by shared 32-char prefix', () => {
  const fixed = '相同的固定开头：请修改这部小说，并保持所有人物关系与时间线一致。';
  const previewA = `${fixed} 要求 A：调整第三章节奏。`;
  const fullA = `${fixed} 要求 A：调整第三章节奏，并补足结尾伏笔。`;
  const previewB = `${fixed} 要求 B：把第四章改成倒叙。`;
  const answer = '上一轮回答';
  const cursor = core.makeCursor({
    id: 'deepseek-item:-2:q', role: 'user', folded: true, text: previewA,
    domKey: '-2:q', turnOrdinal: 0,
    previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }),
  }, 1, 'deepseek:novel');
  cursor.sentMessageHash = core.messageHash({ role: 'user', text: fullA });
  const candidate = [
    { id: 'a0', role: 'assistant', text: answer },
    { id: 'deepseek-item:211:q', role: 'user', folded: true, text: previewB,
      domKey: '211:q', turnOrdinal: 0,
      previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }) },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  assert.equal(core.findCursorIndex(candidate, cursor).index, -1);
  assert.equal(core.getRelayPlan(candidate, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('a full candidate cannot reuse the old folded preview with a different remainder', () => {
  const fixed = '相同的固定开头：请修改这部小说，并保持所有人物关系与时间线一致。';
  const preview = `${fixed} 折叠预览：第三章的原始段落。`;
  const fullA = `${preview} 修改要求 A：调整节奏。`;
  const fullB = `${preview} 修改要求 B：改成倒叙。`;
  const answer = '上一轮回答';
  const cursor = core.makeCursor({
    id: 'deepseek-item:-2:q', role: 'user', folded: true, text: preview,
    domKey: '-2:q', turnOrdinal: 0,
    previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }),
  }, 1, 'deepseek:novel');
  cursor.sentMessageHash = core.messageHash({ role: 'user', text: fullA });
  const candidate = [
    { id: 'a0', role: 'assistant', text: answer },
    { id: 'deepseek-item:211:q', role: 'user', text: fullB,
      domKey: '211:q', turnOrdinal: 0,
      previousAssistantHash: core.messageHash({ role: 'assistant', text: answer }) },
    { id: 'a1', role: 'assistant', text: '本轮回答' },
  ];
  assert.equal(core.findCursorIndex(candidate, cursor).index, -1);
  assert.equal(core.getRelayPlan(candidate, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('user bookmark cannot match an assistant message with the same compact hash', () => {
  const cursor = core.makeCursor(
    { id: 'old-user', role: 'user', text: '修改 小说' }, 0, 'deepseek:novel');
  const dom = [
    { id: 'assistant-1', role: 'assistant', text: '修改小说', complete: true },
    { id: 'assistant-2', role: 'assistant', text: '回答', complete: true },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).index, -1);
  assert.equal(core.getRelayPlan(dom, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('assistant bookmark cannot match a user message with the same compact hash', () => {
  const cursor = core.makeCursor(
    { id: 'old-assistant', role: 'assistant', text: '修改 小说', complete: true },
    0, 'deepseek:novel');
  const dom = [
    { id: 'user-1', role: 'user', text: '修改小说', complete: true },
    { id: 'assistant-2', role: 'assistant', text: '回答', complete: true },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).index, -1);
  assert.equal(core.getRelayPlan(dom, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('foo bar and foobar are different messages even when compact hashes collide', () => {
  const cursor = core.makeCursor(
    { id: 'old-user', role: 'user', text: 'foo bar' }, 0, 'deepseek:novel');
  const dom = [
    { id: 'new-user', role: 'user', text: 'foobar', complete: true },
    { id: 'new-answer', role: 'assistant', text: '回答', complete: true },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).index, -1);
  assert.equal(core.getRelayPlan(dom, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('delivery reflow matches complete paragraph text but keeps same-line spaces', () => {
  assert.equal(core.reflowEquivalent('接续 ChatGPT 的讨论：\n\n第一段。\n\n第二段。',
    '接续 ChatGPT 的讨论：第一段。第二段。'), true);
  assert.equal(core.reflowEquivalent(
    'ChatGPT：\n\n<box border radius="lg" padding={3}>\n<text weight="medium">下一段</text>',
    'ChatGPT：<box border radius="lg" padding={3}> <text weight="medium">下一段</text>'), true);
  assert.equal(core.reflowEquivalent('请保留 foo bar 两个词。', '请保留 foobar 两个词。'), false);
  assert.equal(core.reflowEquivalent('请保留 foo bar baz。', '请保留 foo barbaz。'), false);
  assert.equal(core.reflowEquivalent('请修改 小说。', '请修改小说。'), false);
  assert.equal(core.reflowEquivalent('foobar', 'foo bar'), false);
  assert.equal(core.reflowEquivalent('第一段。\n\n第二段。', '第一段。另一段。'), false);
});

test('relay envelope removes only repeated leading assistant self-labels', () => {
  const body = 'ChatGPT：\n\nChatGPT：正文中提到 Gemini：这句话。';
  const relay = core.formatRelayMessages([{ role: 'assistant', text: body }], 'ChatGPT');
  assert.match(relay, /^接续 ChatGPT 的讨论：\n\nChatGPT：\n正文中提到 Gemini：这句话。/u);
  assert.equal((relay.match(/ChatGPT：/gu) || []).length, 1);
  const user = core.formatRelayMessages([{ role: 'user', text: 'ChatGPT：这是用户原话。' }], 'ChatGPT');
  assert.match(user, /用户：\nChatGPT：这是用户原话。/u);
});

test('Chinese spaces are meaningful even when compact hashes collide', () => {
  const cursor = core.makeCursor(
    { id: 'old-user', role: 'user', text: '修改 小说' }, 0, 'deepseek:novel');
  const dom = [
    { id: 'new-user', role: 'user', text: '修改小说', complete: true },
    { id: 'new-answer', role: 'assistant', text: '回答', complete: true },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).index, -1);
  assert.equal(core.getRelayPlan(dom, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});

test('rendered Chinese list paragraphs tolerate one or several DOM line breaks', () => {
  assert.equal(core.semanticHash('段落（补充说明）\n下一段'),
    core.semanticHash('段落（补充说明）\n\n下一段'));
  assert.notEqual(core.semanticHash('修改 小说'), core.semanticHash('修改小说'));
  assert.notEqual(core.semanticHash('foo\n\nbar'), core.semanticHash('foobar'));
});

test('Gemini compact hash cannot merge foo bar and foobar', () => {
  const cursor = core.makeCursor(
    { id: 'old-user', role: 'user', text: 'foo bar' }, 0, 'gemini:thread');
  const dom = [
    { id: 'new-user', role: 'user', text: 'foobar', complete: true },
    { id: 'new-answer', role: 'assistant', text: '回答', complete: true },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).index, -1);
  assert.equal(core.getRelayPlan(dom, cursor, 'gemini:thread').kind, 'invalid-cursor');
});

test('a user cursor cannot use rendered compact text to erase a word boundary', () => {
  const old = { id: 'old-user', role: 'user', text: 'foo bar',
    renderedCompactHash: core.compactHash('foo bar') };
  const changed = { id: 'new-user', role: 'user', text: 'foobar',
    renderedCompactHash: core.compactHash('foobar') };
  assert.equal(core.findCursorIndex([changed], core.makeCursor(old, 0, 'gemini:thread')).index, -1);
});

test('compact hash cannot override a conflicting full sent fingerprint', () => {
  const fixed = '相同固定提示词开头：修改小说要求 A。';
  const cursor = core.makeCursor({
    id: 'old-user', role: 'user', text: '修改 小说', turnOrdinal: 0,
    previousAssistantHash: core.messageHash({ role: 'assistant', text: '上一轮回答' }),
  }, 1, 'deepseek:novel');
  cursor.sentMessageHash = core.messageHash({ role: 'user', text: `${fixed} A` });
  const dom = [
    { id: 'a0', role: 'assistant', text: '上一轮回答' },
    { id: 'new-user', role: 'user', text: '修改小说', complete: true },
    { id: 'a1', role: 'assistant', text: '回答', complete: true },
  ];
  assert.equal(core.findCursorIndex(dom, cursor).index, -1);
  assert.equal(core.getRelayPlan(dom, cursor, 'deepseek:novel').kind, 'invalid-cursor');
});
