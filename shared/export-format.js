(function initRoundtableExport(root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./core.js')
    : root?.RoundtableCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoundtableExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRoundtableExport(core) {
  'use strict';

  if (!core) throw new Error('RoundtableCore is required before RoundtableExport.');

  const PROVIDER_NAMES = Object.freeze({
    chatgpt: 'ChatGPT',
    gemini: 'Gemini',
    deepseek: 'DeepSeek',
  });
  const SUCCESS_STATES = new Set(['SENT', 'COMPLETED', 'COMPLETE', 'DONE']);

  function providerId(value) {
    const text = String(value || '').toLowerCase();
    return Object.keys(PROVIDER_NAMES).find((provider) => text.includes(provider)) || '';
  }

  function providerName(provider) {
    return PROVIDER_NAMES[providerId(provider)] || String(provider || 'AI');
  }

  function cleanText(value) {
    return core.normalizeText(value || '');
  }

  function isRelayEnvelope(value) {
    const text = cleanText(value);
    return /^接续\s+.+?\s+的讨论[：:]/u.test(text)
      && /请继续回应[。.]?(?:\n|$)/u.test(text);
  }

  function numericTime(value, fallback = 0) {
    if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function isoTime(value) {
    const time = numericTime(value);
    return time ? new Date(time).toISOString() : '';
  }

  function formatTime(value, options = {}) {
    const time = numericTime(value);
    if (!time) return '';
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: options.seconds === false ? undefined : '2-digit',
      hourCycle: 'h23',
    });
    return formatter.format(new Date(time)).replaceAll('/', '-');
  }

  function conversationProviderMap(archive, timeline, tabs) {
    const map = new Map();
    const set = (conversationKey, provider) => {
      const key = String(conversationKey || '');
      const id = providerId(provider);
      if (key && id) map.set(key, id);
    };
    for (const transfer of archive?.transfers || []) {
      set(transfer.sourceConversationKey, transfer.sourceProvider);
      set(transfer.targetConversationKey, transfer.provider || transfer.targetProvider);
    }
    for (const entry of timeline || []) {
      set(entry?.source?.conversationKey || entry?.sourceConversationKey,
        entry?.source?.provider || entry?.sourceProvider);
      set(entry?.target?.conversationKey || entry?.targetConversationKey,
        entry?.target?.provider || entry?.targetProvider);
    }
    for (const tab of tabs || []) set(tab.conversationKey, tab.provider);
    return map;
  }

  function collectSources(archive, timeline, tabs) {
    const sources = {};
    const remember = (provider, url) => {
      const id = providerId(provider || url);
      const href = String(url || '');
      if (id && href && !sources[id]) sources[id] = href;
    };
    for (const transfer of archive?.transfers || []) {
      remember(transfer.sourceProvider, transfer.sourceUrl);
      remember(transfer.provider || transfer.targetProvider, transfer.targetUrl);
    }
    for (const entry of timeline || []) {
      remember(entry?.source?.provider || entry?.sourceProvider,
        entry?.source?.url || entry?.sourceUrl);
      remember(entry?.target?.provider || entry?.targetProvider,
        entry?.target?.url || entry?.targetUrl);
    }
    for (const tab of tabs || []) remember(tab.provider, tab.url);
    return sources;
  }

  function createEventCollector() {
    const events = [];
    let serial = 0;
    const add = (raw) => {
      const role = raw.role === 'user' ? 'user' : 'assistant';
      const text = cleanText(raw.text);
      if (!text || (role === 'user' && isRelayEnvelope(text))) return null;
      const provider = providerId(raw.provider);
      const event = {
        id: `message-${++serial}`,
        role,
        provider,
        conversationKey: String(raw.conversationKey || ''),
        messageId: String(raw.messageId || raw.id || ''),
        messageHash: String(raw.messageHash || ''),
        messageIndex: Number.isInteger(raw.messageIndex) ? raw.messageIndex : null,
        text,
        at: numericTime(raw.at),
        operationId: String(raw.operationId || ''),
        relayFromEventId: String(raw.relayFromEventId || ''),
        source: String(raw.source || 'archive'),
      };
      if (!event.messageHash) event.messageHash = core.messageHash(event);
      events.push(event);
      return event;
    };
    return { events, add };
  }

  function sameMessage(event, raw) {
    if (!event || event.role !== raw.role || event.provider !== providerId(raw.provider)) return false;
    const rawConversation = String(raw.conversationKey || '');
    if (event.conversationKey && rawConversation && event.conversationKey !== rawConversation) return false;
    const rawId = String(raw.messageId || raw.id || '');
    if (event.messageId && rawId && event.messageId === rawId) return true;
    return event.text === cleanText(raw.text);
  }

  function enrichEvent(event, raw) {
    if (!event) return event;
    if (!event.conversationKey && raw.conversationKey) event.conversationKey = String(raw.conversationKey);
    if (!event.messageId && (raw.messageId || raw.id)) event.messageId = String(raw.messageId || raw.id);
    if (raw.messageHash) event.messageHash = String(raw.messageHash);
    if (!event.at && raw.at) event.at = numericTime(raw.at);
    if (Number.isInteger(raw.messageIndex)) event.messageIndex = raw.messageIndex;
    if (!event.operationId && raw.operationId) event.operationId = String(raw.operationId);
    return event;
  }

  function transferMessages(archive) {
    const transfers = [...(archive?.transfers || [])]
      .map((transfer, index) => ({ ...transfer, __index: index }))
      .sort((left, right) => (
        numericTime(left.createdAt) - numericTime(right.createdAt)
        || left.__index - right.__index
      ));
    const collector = createEventCollector();
    let previous = null;

    for (const transfer of transfers) {
      const operationId = String(transfer.operationId || '');
      const sourceProvider = providerId(transfer.sourceProvider);
      const targetProvider = providerId(transfer.provider || transfer.targetProvider);
      const sourceConversationKey = String(transfer.sourceConversationKey || '');
      const targetConversationKey = String(transfer.targetConversationKey || '');
      const createdAt = numericTime(transfer.createdAt);
      const captured = Array.isArray(transfer.sourceMessages)
        ? transfer.sourceMessages.filter(Boolean)
        : [];
      const sourceAssistants = [];

      const addSourceAssistant = (raw) => {
        const data = {
          role: 'assistant',
          provider: sourceProvider,
          conversationKey: sourceConversationKey,
          messageId: raw.id || raw.messageId,
          messageHash: raw.messageHash || raw.hash,
          messageIndex: Number.isInteger(raw.index) ? raw.index : raw.messageIndex,
          text: raw.text,
          at: raw.timestamp || createdAt,
          operationId,
          source: captured.length ? 'source-message' : 'legacy-source',
        };
        let event = null;
        if (previous?.targetProvider === sourceProvider
          && previous.targetConversationKey === sourceConversationKey
          && previous.answerEvent && sameMessage(previous.answerEvent, data)) {
          event = enrichEvent(previous.answerEvent, data);
        } else {
          const relayFromEventId = previous?.targetProvider === sourceProvider
            && previous.targetConversationKey === sourceConversationKey
            && !previous.answerEvent && !previous.recoveredAnswer
            ? previous.sourceEvent?.id || '' : '';
          event = collector.add({ ...data, relayFromEventId });
          if (relayFromEventId) previous.recoveredAnswer = event;
        }
        if (event && !sourceAssistants.includes(event)) sourceAssistants.push(event);
        return event;
      };

      if (captured.length) {
        for (const message of captured) {
          if (message.role === 'user') {
            collector.add({
              role: 'user',
              provider: sourceProvider,
              conversationKey: sourceConversationKey,
              messageId: message.id || message.messageId,
              messageHash: message.messageHash || message.hash,
              messageIndex: Number.isInteger(message.index) ? message.index : message.messageIndex,
              text: message.text,
              at: message.timestamp || createdAt,
              operationId,
              source: 'source-message',
            });
          } else if (message.role === 'assistant') addSourceAssistant(message);
        }
      } else {
        if (transfer.userText && transfer.instruction === undefined) {
          collector.add({
            role: 'user', provider: sourceProvider, conversationKey: sourceConversationKey,
            text: transfer.userText, at: createdAt, operationId, source: 'legacy-user',
          });
        }
        if (transfer.sourceText) addSourceAssistant({
          text: transfer.sourceText,
          id: transfer.sourceMessageId,
          messageHash: transfer.sourceMessageHash,
          timestamp: createdAt,
        });
      }

      if (transfer.instruction) {
        collector.add({
          role: 'user', provider: sourceProvider, conversationKey: sourceConversationKey,
          text: transfer.instruction, at: createdAt, operationId, source: 'instruction',
        });
      }

      const sourceEvent = sourceAssistants[sourceAssistants.length - 1] || null;
      const answerEvent = transfer.answerText ? collector.add({
        role: 'assistant',
        provider: targetProvider,
        conversationKey: targetConversationKey,
        messageId: transfer.answerMessageId,
        messageHash: transfer.answerMessageHash,
        messageIndex: transfer.answerMessageIndex,
        text: transfer.answerText,
        at: transfer.answerObservedAt || createdAt,
        operationId,
        relayFromEventId: sourceEvent?.id || '',
        source: 'target-answer',
      }) : null;
      transfer.__sourceEventId = sourceEvent?.id || '';
      transfer.__answerEventId = answerEvent?.id || '';
      previous = {
        transfer,
        sourceEvent,
        answerEvent,
        targetProvider,
        targetConversationKey,
        recoveredAnswer: null,
      };
    }
    return { transfers, events: collector.events, collector };
  }

  function mergeHistory(archive, built) {
    const history = archive?.history || [];
    for (let index = 0; index < history.length; index += 1) {
      const item = history[index];
      const role = item?.role === 'user' ? 'user' : 'assistant';
      if (!item?.text || (role === 'user' && isRelayEnvelope(item.text))) continue;
      const raw = {
        role,
        provider: item.provider,
        conversationKey: item.conversationKey,
        messageId: item.messageId || item.id,
        messageHash: item.messageHash || item.hash,
        messageIndex: Number.isInteger(item.messageIndex) ? item.messageIndex : item.index,
        text: item.text,
        at: item.timestamp || item.observedAt,
        source: 'history',
      };
      const existing = built.events.find((event) => sameMessage(event, raw));
      if (existing) enrichEvent(existing, raw);
      else built.collector.add(raw);
    }
  }

  function participantOrder(events, transfers, timeline) {
    const result = [];
    const add = (provider) => {
      const id = providerId(provider);
      if (id && !result.includes(id)) result.push(id);
    };
    for (const event of events) if (event.role === 'assistant') add(event.provider);
    for (const transfer of transfers) {
      add(transfer.sourceProvider);
      add(transfer.provider || transfer.targetProvider);
    }
    for (const entry of timeline || []) {
      add(entry?.source?.provider || entry?.sourceProvider);
      add(entry?.target?.provider || entry?.targetProvider);
    }
    return result;
  }

  function numberAssistantMessages(events) {
    const counts = {};
    for (const event of events) {
      if (event.role !== 'assistant') continue;
      counts[event.provider] = (counts[event.provider] || 0) + 1;
      event.providerIndex = counts[event.provider];
    }
  }

  function groupRounds(events, participants) {
    const rounds = [];
    let current = null;
    const begin = () => ({ index: rounds.length + 1, user: null, messages: [] });
    const finish = () => {
      if (!current || (!current.user && !current.messages.length)) return;
      const spoken = new Set(current.messages.map((message) => message.provider));
      current.missingProviders = participants.filter((provider) => !spoken.has(provider));
      rounds.push(current);
      current = null;
    };

    for (const event of events) {
      if (event.role === 'user') {
        if (!current) current = begin();
        else if (current.messages.length) {
          finish();
          current = begin();
        }
        if (!current.user) current.user = { ...event };
        else {
          current.user.text = `${current.user.text}\n\n${event.text}`;
          current.user.parts = [...(current.user.parts || [current.user.id]), event.id];
        }
        continue;
      }

      if (!current) current = begin();
      const spoken = new Set(current.messages.map((message) => message.provider));
      if (spoken.has(event.provider)
        || (participants.length && spoken.size >= participants.length)) {
        finish();
        current = begin();
      }
      current.messages.push(event);
    }
    finish();
    const spokenCounts = {};
    for (const round of rounds) {
      for (const message of round.messages) {
        spokenCounts[message.provider] = Math.max(
          Number(spokenCounts[message.provider] || 0),
          Number(message.providerIndex || 0)
        );
      }
      round.missingProviderIndexes = Object.fromEntries(round.missingProviders.map((provider) => (
        [provider, Number(spokenCounts[provider] || 0) + 1]
      )));
    }
    return rounds;
  }

  function relayRecords(timeline, transfers) {
    const transferByOperation = new Map(transfers
      .filter((item) => item.operationId)
      .map((item) => [String(item.operationId), item]));
    const records = [];
    const seen = new Set();
    for (const raw of [...(timeline || [])].sort((left, right) => (
      numericTime(left.startedAt || left.createdAt) - numericTime(right.startedAt || right.createdAt)
      || Number(left.index || 0) - Number(right.index || 0)
    ))) {
      const operationId = String(raw.operationId || raw.id || '');
      if (operationId) seen.add(operationId);
      const transfer = transferByOperation.get(operationId);
      const status = String(raw.status || '').toUpperCase();
      const source = providerId(raw?.source?.provider || raw.sourceProvider || transfer?.sourceProvider);
      const target = providerId(raw?.target?.provider || raw.targetProvider
        || transfer?.provider || transfer?.targetProvider);
      const assistantCount = Array.isArray(transfer?.sourceMessages)
        ? transfer.sourceMessages.filter((message) => message?.role === 'assistant').length
        : transfer?.sourceText ? 1 : 0;
      records.push({
        operationId,
        at: numericTime(raw.startedAt || raw.createdAt || transfer?.createdAt),
        completedAt: numericTime(raw.completedAt),
        from: source,
        to: target,
        status: SUCCESS_STATES.has(status) ? 'sent' : status.toLowerCase() || 'unknown',
        statusLabel: SUCCESS_STATES.has(status) ? '成功'
          : status === 'CANCELLED' || status === 'CANCELED' ? '已取消'
            : status === 'UNCERTAIN' ? '未确认'
              : status === 'SUSPENDED' ? '已中断' : '未完成',
        detail: SUCCESS_STATES.has(status)
          ? `转达 ${Math.max(assistantCount, 1)} 条回答`
          : cleanText(raw?.error?.message || raw.errorText || '本次接力未完成'),
      });
    }
    for (const transfer of transfers) {
      const operationId = String(transfer.operationId || '');
      if (operationId && seen.has(operationId)) continue;
      records.push({
        operationId,
        at: numericTime(transfer.createdAt),
        completedAt: 0,
        from: providerId(transfer.sourceProvider),
        to: providerId(transfer.provider || transfer.targetProvider),
        status: 'sent',
        statusLabel: '成功',
        detail: `转达 ${Math.max(Array.isArray(transfer.sourceMessages)
          ? transfer.sourceMessages.filter((message) => message?.role === 'assistant').length
          : transfer.sourceText ? 1 : 0, 1)} 条回答`,
      });
    }
    return records.sort((left, right) => left.at - right.at);
  }

  function locateBookmarks(bookmarks, events, transfers, conversationProviders) {
    const result = [];
    for (const [conversationKey, rawCursor] of Object.entries(bookmarks || {})) {
      const cursor = rawCursor || {};
      const provider = conversationProviders.get(conversationKey) || '';
      const item = {
        conversationKey,
        provider,
        messageId: String(cursor.messageId || ''),
        messageHash: String(cursor.messageHash || ''),
        updatedAt: numericTime(cursor.updatedAt),
        state: 'unavailable',
        beforeEventId: '',
        afterEventId: '',
        answerIndex: null,
      };

      const anchoredTransfer = transfers.find((transfer) => (
        transfer.targetConversationKey === conversationKey
        && ((cursor.messageId && transfer.targetMessageId
          && String(cursor.messageId) === String(transfer.targetMessageId))
          || (cursor.messageHash && transfer.targetMessageHash
            && String(cursor.messageHash) === String(transfer.targetMessageHash)))
      ));
      if (anchoredTransfer) {
        const answer = events.find((event) => event.id === anchoredTransfer.__answerEventId)
          || events.find((event) => event.conversationKey === conversationKey
            && event.role === 'assistant'
            && event.operationId === String(anchoredTransfer.operationId || ''));
        const source = events.find((event) => event.id === anchoredTransfer.__sourceEventId);
        if (answer) {
          item.state = 'pending';
          item.beforeEventId = answer.id;
          item.answerIndex = Math.max(0, Number(answer.providerIndex || 1) - 1);
        } else if (source) {
          const sourcePosition = events.findIndex((event) => event.id === source.id);
          const previousAnswer = events.slice(0, sourcePosition + 1).reverse().find((event) => (
            event.role === 'assistant' && event.provider === provider
          ));
          item.state = 'pending';
          item.afterEventId = source.id;
          item.answerIndex = Number(previousAnswer?.providerIndex || 0);
        }
        result.push(item);
        continue;
      }

      const conversationEvents = events.filter((event) => event.conversationKey === conversationKey);
      const messages = conversationEvents.map((event) => ({
        id: event.messageId,
        role: event.role,
        text: event.text,
        index: event.messageIndex,
      }));
      const located = core.findCursorIndex(messages, cursor);
      if (located.index >= 0) {
        const start = cursor.atStart === true ? located.index : located.index + 1;
        let pendingIndex = -1;
        for (let index = start; index < conversationEvents.length; index += 1) {
          if (conversationEvents[index].role === 'assistant') {
            pendingIndex = index;
            break;
          }
        }
        if (pendingIndex >= 0) {
          const pending = conversationEvents[pendingIndex];
          item.state = 'pending';
          item.beforeEventId = pending.id;
          item.answerIndex = Math.max(0, Number(pending.providerIndex || 1) - 1);
        } else {
          const synced = [...conversationEvents.slice(0, located.index + 1)]
            .reverse().find((event) => event.role === 'assistant') || conversationEvents[located.index];
          item.state = 'synced';
          item.afterEventId = synced?.id || '';
          item.answerIndex = synced?.providerIndex || null;
        }
      }
      result.push(item);
    }
    return result;
  }

  function buildExportDocument(input = {}) {
    const archive = input.archive || { transfers: [], history: [] };
    const timeline = Array.isArray(input.timeline) ? input.timeline : [];
    const tabs = Array.isArray(input.tabs) ? input.tabs : [];
    const built = transferMessages(archive);
    mergeHistory(archive, built);
    numberAssistantMessages(built.events);
    const participants = participantOrder(built.events, built.transfers, timeline);
    const rounds = groupRounds(built.events, participants);
    const conversations = conversationProviderMap(archive, timeline, tabs);
    const relays = relayRecords(timeline, built.transfers);
    const bookmarkItems = locateBookmarks(
      input.bookmarks || {}, built.events, built.transfers, conversations
    );
    const exportedAt = numericTime(input.exportedAt, Date.now());
    return {
      title: cleanText(input.session?.title || input.title || '新讨论') || '新讨论',
      exportedAt: new Date(exportedAt).toISOString(),
      participants,
      sources: collectSources(archive, timeline, tabs),
      rounds,
      bookmarks: bookmarkItems,
      relays,
      options: {
        includeTime: input.includeTime !== false,
        includeLinks: input.includeLinks !== false,
        timeZone: input.timeZone || '',
      },
    };
  }

  function bookmarkProgress(bookmark) {
    if (bookmark.state === 'pending') {
      return bookmark.answerIndex
        ? `已同步到第 ${bookmark.answerIndex} 条回答，以下内容尚未传递`
        : '尚未同步回答，以下内容尚未传递';
    }
    if (bookmark.state === 'synced') return '已同步到这里';
    return '书签不在当前导出范围';
  }

  function markerText(bookmark) {
    return `${providerName(bookmark.provider)} ${bookmarkProgress(bookmark)}`;
  }

  function markerLines(bookmark) {
    const attributes = [
      `conversation="${String(bookmark.conversationKey || '').replaceAll('"', '&quot;')}"`,
      `message="${String(bookmark.messageId || bookmark.messageHash || '').replaceAll('"', '&quot;')}"`,
      `state="${bookmark.state}"`,
    ].join(' ');
    return [`> 🔖 接力位置：${markerText(bookmark)}`, '', `<!-- roundtable-bookmark ${attributes} -->`, ''];
  }

  function tableText(value) {
    return cleanText(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  }

  function formatMarkdown(document) {
    const options = document.options || {};
    const lines = [`# ${document.title}`, ''];
    lines.push(`- 导出时间：${formatTime(document.exportedAt, { timeZone: options.timeZone, seconds: false })}`);
    lines.push(`- 参与者：${document.participants.map(providerName).join('、') || '暂无'}`);
    const successCount = document.relays.filter((relay) => relay.status === 'sent').length;
    lines.push(`- 接力：${successCount} 次成功 / ${document.relays.length - successCount} 次未完成`);
    if (document.bookmarks.length) {
      lines.push('- 当前进度：');
      for (const bookmark of document.bookmarks) {
        lines.push(`  - ${providerName(bookmark.provider)}：${bookmarkProgress(bookmark)}`);
      }
    }
    if (options.includeLinks && Object.keys(document.sources).length) {
      lines.push('- 来源：');
      for (const provider of document.participants) {
        if (document.sources[provider]) {
          lines.push(`  - ${providerName(provider)}：${document.sources[provider]}`);
        }
      }
    }
    lines.push('', '---', '');

    const before = new Map();
    const after = new Map();
    const unavailable = [];
    for (const bookmark of document.bookmarks) {
      if (bookmark.beforeEventId) before.set(bookmark.beforeEventId, bookmark);
      else if (bookmark.afterEventId) after.set(bookmark.afterEventId, bookmark);
      else unavailable.push(bookmark);
    }
    const renderBefore = (event) => {
      const marker = before.get(event?.id);
      if (marker) lines.push(...markerLines(marker));
    };
    const renderAfter = (event) => {
      const marker = after.get(event?.id);
      if (marker) lines.push(...markerLines(marker));
    };

    if (!document.rounds.length) {
      lines.push('这场讨论尚无已缓存的正文。', '', '---', '');
    }
    const byId = new Map(document.rounds.flatMap((round) => round.messages)
      .map((message) => [message.id, message]));
    for (const round of document.rounds) {
      lines.push(`## 第 ${round.index} 轮`, '', '### 用户', '');
      if (round.user) {
        renderBefore(round.user);
        lines.push(round.user.text, '');
        renderAfter(round.user);
      } else lines.push('_本轮没有新的用户输入_', '');

      for (const message of round.messages) {
        renderBefore(message);
        lines.push(`### ${providerName(message.provider)} ${message.providerIndex}`, '');
        const relayFrom = byId.get(message.relayFromEventId)
          || document.rounds.flatMap((item) => item.messages)
            .find((item) => item.id === message.relayFromEventId);
        if (relayFrom) {
          const time = options.includeTime ? formatTime(message.at, { timeZone: options.timeZone }) : '';
          lines.push(`> 转达自 ${providerName(relayFrom.provider)} ${relayFrom.providerIndex}${time ? ` · ${time}` : ''}`, '');
        } else if (options.includeTime && message.at) {
          lines.push(`> 来源：${providerName(message.provider)} · ${formatTime(message.at, { timeZone: options.timeZone })}`, '');
        }
        lines.push(message.text, '');
        renderAfter(message);
      }
      for (const provider of round.missingProviders) {
        const missingIndex = round.missingProviderIndexes?.[provider];
        lines.push(`### ${providerName(provider)}${missingIndex ? ` ${missingIndex}` : ''}`,
          '', '_尚未回复_', '');
      }
      lines.push('---', '');
    }

    if (unavailable.length) {
      lines.push('## 书签', '');
      for (const bookmark of unavailable) lines.push(...markerLines(bookmark));
    }

    if (document.relays.length) {
      lines.push('## 接力记录', '', '| 时间 | 方向 | 状态 | 说明 |', '|---|---|---|---|');
      for (const relay of document.relays) {
        const time = options.includeTime
          ? formatTime(relay.at, { timeZone: options.timeZone }) : '—';
        lines.push(`| ${time || '—'} | ${providerName(relay.from)} → ${providerName(relay.to)} | ${relay.statusLabel} | ${tableText(relay.detail)} |`);
      }
      lines.push('');
    }
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  }

  function formatJson(document) {
    const cleanRounds = document.rounds.map((round) => ({
      index: round.index,
      user: round.user ? {
        text: round.user.text,
        provider: round.user.provider || null,
        conversationKey: round.user.conversationKey || null,
        messageId: round.user.messageId || null,
        at: isoTime(round.user.at) || null,
      } : null,
      messages: round.messages.map((message) => ({
        provider: message.provider,
        role: 'assistant',
        index: message.providerIndex,
        text: message.text,
        conversationKey: message.conversationKey || null,
        messageId: message.messageId || null,
        at: isoTime(message.at) || null,
        relayFrom: message.relayFromEventId ? (() => {
          const source = document.rounds.flatMap((item) => item.messages)
            .find((item) => item.id === message.relayFromEventId);
          return source ? {
            provider: source.provider,
            index: source.providerIndex,
            at: isoTime(message.at) || null,
          } : null;
        })() : null,
      })),
      missingProviders: [...round.missingProviders],
    }));
    return JSON.stringify({
      title: document.title,
      exportedAt: document.exportedAt,
      participants: document.participants,
      sources: document.sources,
      rounds: cleanRounds,
      bookmarks: document.bookmarks.map((bookmark) => ({
        conversationKey: bookmark.conversationKey,
        provider: bookmark.provider || null,
        messageId: bookmark.messageId || null,
        messageHash: bookmark.messageHash || null,
        state: bookmark.state,
        at: isoTime(bookmark.updatedAt) || null,
      })),
      relays: document.relays.map((relay) => ({
        operationId: relay.operationId || null,
        at: isoTime(relay.at) || null,
        from: relay.from || null,
        to: relay.to || null,
        status: relay.status,
        error: relay.status === 'sent' ? null : relay.detail,
      })),
    }, null, 2);
  }

  return {
    isRelayEnvelope,
    buildExportDocument,
    formatMarkdown,
    formatJson,
  };
});
