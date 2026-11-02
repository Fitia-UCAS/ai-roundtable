(function initRoundtableCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoundtableCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRoundtableCore() {
  'use strict';

  const PROTOCOL_VERSION = 1;

  class AppError extends Error {
    constructor(code, message, stage = 'unknown', recoverable = true) {
      super(String(message || '发生未知错误。'));
      this.name = 'AppError';
      this.code = String(code || 'UNKNOWN_ERROR');
      this.stage = String(stage || 'unknown');
      this.recoverable = recoverable !== false;
    }
    toJSON() {
      return { code: this.code, message: this.message,
        stage: this.stage, recoverable: this.recoverable };
    }
  }

  function normalizeSnapshot(snapshot, fallback = {}) {
    const data = snapshot?.snapshot || snapshot?.data?.snapshot || snapshot?.data || snapshot;
    if (!data || typeof data !== 'object') {
      throw new AppError('INVALID_SNAPSHOT', '页面返回了无法识别的对话数据。', 'inspect');
    }
    const messages = cleanMessages(data.messages || data.conversation?.messages || []);
    return {
      ...data,
      provider: String(data.provider || fallback.provider || ''),
      conversationKey: String(data.conversationKey || fallback.conversationKey || ''),
      messages,
      revision: String(data.revision || conversationRevision(messages)),
      strategy: String(data.strategy || data.source || 'unknown'),
      truncated: Boolean(data.truncated),
      generating: Boolean(data.generating),
      diagnostics: data.diagnostics && typeof data.diagnostics === 'object'
        ? data.diagnostics : {},
    };
  }


  const OPERATION_STATES = Object.freeze({
    CAPTURING: 'CAPTURING',
    PREPARED: 'PREPARED',
    DISPATCHED: 'DISPATCHED',
    TARGET_ACKED: 'TARGET_ACKED',
    WAITING: 'WAITING',
    RESPONSE_CAPTURED: 'RESPONSE_CAPTURED',
    COMPLETED: 'COMPLETED',
    NO_CONTENT: 'NO_CONTENT',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    UNCERTAIN: 'UNCERTAIN',
    SUSPENDED: 'SUSPENDED',
  });

  const TERMINAL_OPERATION_STATES = new Set([
    OPERATION_STATES.COMPLETED,
    OPERATION_STATES.NO_CONTENT,
    OPERATION_STATES.FAILED,
    OPERATION_STATES.CANCELLED,
  ]);

  const OPERATION_TRANSITIONS = Object.freeze({
    [OPERATION_STATES.CAPTURING]: new Set([
      OPERATION_STATES.PREPARED,
      OPERATION_STATES.NO_CONTENT,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
    ]),
    [OPERATION_STATES.PREPARED]: new Set([
      OPERATION_STATES.DISPATCHED,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
    ]),
    [OPERATION_STATES.DISPATCHED]: new Set([
      OPERATION_STATES.TARGET_ACKED,
      OPERATION_STATES.WAITING,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
      OPERATION_STATES.UNCERTAIN,
      OPERATION_STATES.SUSPENDED,
    ]),
    [OPERATION_STATES.TARGET_ACKED]: new Set([
      OPERATION_STATES.COMPLETED,
      OPERATION_STATES.WAITING,
      OPERATION_STATES.RESPONSE_CAPTURED,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
      OPERATION_STATES.SUSPENDED,
    ]),
    [OPERATION_STATES.WAITING]: new Set([
      OPERATION_STATES.COMPLETED,
      OPERATION_STATES.TARGET_ACKED,
      OPERATION_STATES.RESPONSE_CAPTURED,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
      OPERATION_STATES.SUSPENDED,
    ]),
    [OPERATION_STATES.RESPONSE_CAPTURED]: new Set([
      OPERATION_STATES.COMPLETED,
      OPERATION_STATES.FAILED,
    ]),
    [OPERATION_STATES.SUSPENDED]: new Set([
      OPERATION_STATES.COMPLETED,
      OPERATION_STATES.DISPATCHED,
      OPERATION_STATES.TARGET_ACKED,
      OPERATION_STATES.WAITING,
      OPERATION_STATES.RESPONSE_CAPTURED,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
      OPERATION_STATES.UNCERTAIN,
    ]),
    [OPERATION_STATES.UNCERTAIN]: new Set([
      OPERATION_STATES.COMPLETED,
      OPERATION_STATES.TARGET_ACKED,
      OPERATION_STATES.WAITING,
      OPERATION_STATES.FAILED,
      OPERATION_STATES.CANCELLED,
      OPERATION_STATES.SUSPENDED,
    ]),
  });

  function bodyText(value) {
    // Payloads are Markdown, not comparison keys. Keep indentation, hard line
    // breaks, blank code lines and full-width characters exactly as written.
    return String(value ?? '').replace(/\r\n?/g, '\n').trim();
  }

  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\t\u00A0\u3000 ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function compactText(value) {
    return normalizeText(value).replace(/\s+/g, '');
  }

  // A rich-text user bubble may remove paragraph breaks or render them as
  // spaces. Keep only separator positions and a whole-body hash in persistent
  // state; a restarted worker must be able to verify delivery without storing
  // the relay text. Explicit same-line spaces remain meaningful.
  function reflowSignature(value) {
    const body = normalizeText(value);
    const all = [];
    const horizontal = [];
    let position = 0;
    for (let index = 0; index < body.length;) {
      if (!/\s/u.test(body[index])) { position += 1; index += 1; continue; }
      const start = index;
      while (index < body.length && /\s/u.test(body[index])) index += 1;
      if (start === 0 || index === body.length) continue;
      all.push(position);
      if (!body.slice(start, index).includes('\n')) horizontal.push(position);
    }
    return { compactHash: compactHash(body), all, horizontal };
  }

  function reflowMatchesSignature(expected, actual) {
    if (!expected || !Array.isArray(expected.all) || !Array.isArray(expected.horizontal)
      || !expected.compactHash || !normalizeText(actual)) return false;
    const observed = reflowSignature(actual);
    if (expected.compactHash !== observed.compactHash) return false;
    const expectedAll = new Set(expected.all);
    const observedAll = new Set(observed.all);
    return expected.horizontal.every((position) => observedAll.has(position))
      && observed.horizontal.every((position) => expectedAll.has(position));
  }

  function reflowEquivalent(expected, actual) {
    const left = normalizeText(expected);
    const right = normalizeText(actual);
    if (!left || !right) return false;
    if (left === right || semanticText(left) === semanticText(right)) return true;
    return reflowMatchesSignature(reflowSignature(expected), actual);
  }

  // Preserve word boundaries and meaningful spaces while treating runs of
  // whitespace/newlines as one separator. Unlike compactText, this never turns
  // "foo bar" into "foobar".
  function semanticText(value) {
    const text = normalizeText(value).replace(/\n+/g, '\n');
    if (!text) return '';
    const cjkEdge = (char) => /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(char || '');
    let output = '';
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '\n') {
        output += text[index];
        continue;
      }
      const before = output.slice(-1);
      const after = text[index + 1] || '';
      if (!before || !after) continue;
      // A line break between CJK characters is usually DOM/Markdown wrapping.
      // Between Latin words it remains a separator; explicit spaces are never
      // removed, so "foo bar" and "foobar" stay distinct.
      const punctuation = /[,.;:!?，。；：！？]/u.test(before);
      const removeBreak = punctuation || (cjkEdge(after) && cjkEdge(before));
      if (!removeBreak) output += ' ';
    }
    return output.replace(/[ \t]+/gu, ' ')
      .replace(/\s*([,.;:!?，。；：！？、])\s*/gu, '$1')
      .trim();
  }

  function hashText(value) {
    const text = normalizeText(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function cleanMessages(messages) {
    const list = (Array.isArray(messages) ? messages : [])
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
      .map((message, index) => ({
        id: String(message.id || message.nativeId || ''),
        role: message.role,
        text: bodyText(message.text),
        timestamp: Number.isFinite(message.timestamp) ? message.timestamp : null,
        complete: message.complete !== false,
        index,
        ...(message.identity ? { identity: String(message.identity) } : {}),
        ...(message.folded === true ? { folded: true } : {}),
        ...(Number.isInteger(message.turnOrdinal) ? { turnOrdinal: message.turnOrdinal } : {}),
        ...(message.previousAssistantHash
          ? { previousAssistantHash: String(message.previousAssistantHash) } : {}),
        ...(message.domKey ? { domKey: String(message.domKey) } : {}),
        ...(message.contentAliases ? { contentAliases: message.contentAliases } : {}),
        ...(message.renderedHash ? { renderedHash: String(message.renderedHash) } : {}),
        ...(message.renderedAliases?.length
          ? { renderedAliases: message.renderedAliases.map(String) } : {}),
        ...(message.renderedCompactHash
          ? { renderedCompactHash: String(message.renderedCompactHash) } : {}),
        ...(message.renderedCompactAliases?.length
          ? { renderedCompactAliases: message.renderedCompactAliases.map(String) } : {}),
      }))
      .filter((message) => message.text);
    for (const message of list) {
      if (!message.identity) message.identity = inferredIdentity(message.id);
    }
    return list;
  }

  function messageHash(message) {
    return hashText(`${message?.role || ''}\n${message?.text || ''}`);
  }

  function compactHash(text) {
    return hashText(normalizeText(text).replace(/\s+/gu, ''));
  }

  function semanticHash(text) {
    return hashText(semanticText(text));
  }

  function inferredIdentity(id) {
    const value = String(id || '');
    if (/^deepseek-item:/.test(value)) return 'virtual-key';
    if (/^(?:deepseek|gemini|chatgpt)-dom-/.test(value)) return 'text-hash';
    if (/^(?:project-(?:user|assistant):|labeled-(?:user|assistant)-)/.test(value)) return 'text-hash';
    if (/:dom-|dom-/.test(value)) return 'text-hash';
    return value ? 'native-id' : '';
  }

  // An identity must be corroborated by content. Structure only narrows the
  // candidate. A raw virtual-list row key is not a permanent server id: the
  // same key can be reused after a re-render for a different message.
  function contentMatches(message, cursor) {
    if (!message) return false;
    // Role is part of identity. A cursor without a stored role can rely on
    // exact stored fingerprints, never a role-agnostic compact-only guess.
    if (cursor.role && message.role !== cursor.role) return false;
    if (cursor.messageHash && messageHash(message) === cursor.messageHash) return true;
    if (cursor.sentMessageHash && messageHash(message) === cursor.sentMessageHash) return true;
    if (cursor.role && message.role === cursor.role) {
      if (cursor.sentSemanticHash
        && semanticHash(message.text) === cursor.sentSemanticHash) return true;
      if (cursor.messageSemanticHash
        && semanticHash(message.text) === cursor.messageSemanticHash) return true;
      if (cursor.renderedHash && message.renderedHash) {
        if ([cursor.renderedHash, ...(cursor.renderedAliases || [])]
          .some((fingerprint) => [message.renderedHash,
            ...(message.renderedAliases || [])].includes(fingerprint))) return true;
        // A disagreement between rendered projections is not proof of a
        // different message: the API Markdown and the page DOM can serialize
        // emphasis, citations or whitespace differently. Exact whole-body
        // hashes below still provide byte-level proof; only those fallbacks run.
      }
      // Compact rendered text is needed for assistant Markdown projections.
      // User prompts and delivery receipts must preserve meaningful spaces.
      if (cursor.role === 'assistant' && message.role === 'assistant'
        && [cursor.renderedCompactHash, ...(cursor.renderedCompactAliases || [])]
          .filter(Boolean).some((fingerprint) => [message.renderedCompactHash,
            ...(message.renderedCompactAliases || [])].includes(fingerprint))) return true;
      if (!cursor.renderedHash && message.renderedHash && cursor.messageSemanticHash
        && (cursor.identity || inferredIdentity(cursor.messageId)) === 'text-hash'
        && cursor.messageSemanticHash === message.renderedHash) return true;
      const hashes = [messageHash(message), ...(message.contentAliases || [])];
      if ([cursor.messageHash, ...(cursor.contentAliases || [])].some((hash) => hashes.includes(hash))) return true;
    }
    return false;
  }

  function makeCursor(message, index, conversationKey, options = {}) {
    if (!message) return null;
    return {
      conversationKey: String(conversationKey || ''),
      messageId: String(message.id || ''),
      messageHash: messageHash(message),
      messageSemanticHash: semanticHash(message.text),
      messageCompactHash: compactHash(message.text),
      ...(message.role === 'user' && normalizeText(message.text).length >= 16 ? {
        prefixChars: Math.min(32, normalizeText(message.text).length),
        prefixHash: hashText(normalizeText(message.text).slice(0, Math.min(32, normalizeText(message.text).length))),
        messageLength: normalizeText(message.text).length,
      } : {}),
      messageIndex: Number.isInteger(index) ? index : Number(message.index || 0),
      role: message.role,
      ...(message.identity ? { identity: String(message.identity) } : {}),
      ...(message.folded === true ? { folded: true } : {}),
      ...(Number.isInteger(message.turnOrdinal) ? { turnOrdinal: message.turnOrdinal } : {}),
      ...(message.previousAssistantHash
        ? { previousAssistantHash: String(message.previousAssistantHash) } : {}),
      ...(message.domKey ? { domKey: String(message.domKey) } : {}),
      ...(message.contentAliases ? { contentAliases: message.contentAliases } : {}),
      ...(message.renderedHash ? { renderedHash: String(message.renderedHash) } : {}),
      ...(message.renderedAliases?.length
        ? { renderedAliases: message.renderedAliases.map(String) } : {}),
      ...(message.renderedCompactHash
        ? { renderedCompactHash: String(message.renderedCompactHash) } : {}),
      ...(message.renderedCompactAliases?.length
        ? { renderedCompactAliases: message.renderedCompactAliases.map(String) } : {}),
      previousHash: String(options.previousHash || ''),
      lastOperationId: String(options.lastOperationId || ''),
      updatedAt: Number.isFinite(options.updatedAt) ? options.updatedAt : Date.now(),
    };
  }

  function makeStartCursor(messages, startIndex, conversationKey, options = {}) {
    const list = cleanMessages(messages);
    const index = Number(startIndex);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
    // Anchor the selected answer itself. The preceding user bubble can fold or
    // be unmounted independently, even while this answer remains on screen.
    return { ...makeCursor(list[index], index, conversationKey, options), atStart: true };
  }

  function findCursorIndex(messages, cursor) {
    const list = cleanMessages(messages);
    if (!cursor) return { index: -1, method: 'none' };

    const textIdentity = (cursor.identity || inferredIdentity(cursor.messageId)) === 'text-hash';
    if (cursor.messageId && !textIdentity) {
      const matches = [];
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].id && list[index].id === cursor.messageId) matches.push(index);
      }
      if (matches.length === 1) {
        const index = matches[0];
        if (contentMatches(list[index], cursor)) return { index, method: 'id' };
        // A recycled virtual-list key with unrelated content is not this message.
      }
      if (matches.length > 1) {
        const hashMatches = matches.filter((index) => contentMatches(list[index], cursor));
        if (hashMatches.length === 1) return { index: hashMatches[0], method: 'id-hash' };
        if (hashMatches.length > 1) return { index: -1, method: 'ambiguous' };
      }
    }

    // DOM-first identity for a user turn: the ordinals and the neighbouring
    // assistant hash survive folded/expanded user bubbles and DOM re-renders.
    // The stored index is used only as a completeness guard, never as the sole
    // identity. If the page renders a virtual window with shifted indices, this
    // returns invalid instead of matching another turn.
    if (cursor.role === 'user' && Number.isInteger(cursor.turnOrdinal)
      && Number.isInteger(cursor.messageIndex)) {
      let turn = 0;
      let previousAssistantHash = '';
      let structuralIndex = -1;
      for (let index = 0; index < list.length; index += 1) {
        const message = list[index];
        if (message.role === 'assistant') {
          previousAssistantHash = messageHash(message);
          continue;
        }
        if (message.role !== 'user') continue;
        if (turn === cursor.turnOrdinal
          && (!cursor.previousAssistantHash
            || cursor.previousAssistantHash === previousAssistantHash)) {
          structuralIndex = index;
        }
        turn += 1;
      }
      const contentCorroborated = structuralIndex >= 0
        && contentMatches(list[structuralIndex], cursor);
      // Structure only narrows the candidate. It can never prove identity by
      // itself: the same turn/index/previous-assistant anchor with different
      // content is a different message. Restoration requires corroborating
      // exact or semantic content identity, not a shared compact prefix.
      if (structuralIndex === cursor.messageIndex && contentCorroborated) {
        return { index: structuralIndex, method: 'turn-structure' };
      }
    }

    if (cursor.messageHash) {
      const matches = [];
      for (let index = 0; index < list.length; index += 1) {
        if (messageHash(list[index]) === cursor.messageHash) matches.push(index);
      }
      if (matches.length === 1) return { index: matches[0], method: 'hash' };
      if (matches.length > 1) return { index: -1, method: 'ambiguous' };
    }

    if (cursor.role && (cursor.contentAliases?.length || cursor.renderedHash
      || list.some((message) => message.contentAliases?.length || message.renderedHash))) {
      const aliases = list.map((message, index) => ({ message, index }))
        .filter(({ message }) => contentMatches(message, cursor));
      if (aliases.length === 1) return { index: aliases[0].index, method: 'content-alias' };
      if (aliases.length > 1) {
        return { index: -1, method: 'ambiguous' };
      }
    }

    // A target's delivery acknowledgement can see a shortened user bubble,
    // while the next inspection sees the fully mounted message. The submitted
    // payload is independently fingerprinted when delivery is confirmed.
    if (cursor.role === 'user' && (cursor.sentMessageHash || cursor.sentSemanticHash)) {
      const matches = list.map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === 'user' && (
          (cursor.sentMessageHash && messageHash(message) === cursor.sentMessageHash)
          || (cursor.sentSemanticHash && semanticHash(message.text) === cursor.sentSemanticHash)
        ));
      if (matches.length === 1) return { index: matches[0].index, method: 'sent-fingerprint' };
      if (matches.length > 1) return { index: -1, method: 'ambiguous' };
    }

    // Semantic whitespace normalization preserves word boundaries. It can
    // recover Markdown/DOM line-break changes, but it is still role-bound.
    if (cursor.role && cursor.messageSemanticHash) {
      const matching = list.map((message, index) => ({ message, index })).filter(({ message }) => (
        message.role === cursor.role
        && semanticHash(message.text) === cursor.messageSemanticHash
      ));
      if (matching.length === 1) return { index: matching[0].index, method: 'semantic-hash' };
      if (matching.length > 1) return { index: -1, method: 'ambiguous' };
    }

    // Mounted indices shift after virtualization. A legacy preview or a bare
    // id at the old position cannot substitute for complete content evidence.
    return { index: -1, method: 'invalid' };
  }

  function getLastCompleteRound(messages) {
    const list = cleanMessages(messages);
    for (let assistantIndex = list.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
      if (list[assistantIndex].role !== 'assistant' || !list[assistantIndex].complete) continue;
      for (let userIndex = assistantIndex - 1; userIndex >= 0; userIndex -= 1) {
        if (list[userIndex].role === 'assistant') break;
        if (list[userIndex].role === 'user') {
          return {
            messages: [list[userIndex], list[assistantIndex]],
            startIndex: userIndex,
            endIndex: assistantIndex,
          };
        }
      }
      return {
        messages: [list[assistantIndex]],
        startIndex: assistantIndex,
        endIndex: assistantIndex,
      };
    }
    return { messages: [], startIndex: -1, endIndex: -1 };
  }

  function getCopyPlan(messages, cursor) {
    const list = cleanMessages(messages);
    if (!list.length) return { kind: 'empty', messages: [], list, cursorIndex: -1 };

    if (!cursor) {
      const round = getLastCompleteRound(list);
      return { kind: 'last-round', messages: round.messages, list, cursorIndex: -1 };
    }

    const located = findCursorIndex(list, cursor);
    if (located.method === 'invalid' || located.method === 'ambiguous') {
      return { kind: 'invalid-cursor', messages: [], list, cursorIndex: -1 };
    }

    const fresh = list.slice(located.index + 1);
    if (fresh.length) {
      return { kind: 'fresh', messages: fresh, list, cursorIndex: located.index };
    }

    const round = getLastCompleteRound(list);
    return { kind: 'repeat-last-round', messages: round.messages, list, cursorIndex: located.index };
  }

  function getRelayPlan(messages, cursor, conversationKey = '') {
    const list = cleanMessages(messages);
    const key = String(conversationKey || '');
    if (!list.length) {
      return { kind: 'empty', messages: [], list, cursorIndex: -1, endCursor: null };
    }

    if (cursor?.conversationKey && key && cursor.conversationKey !== key) {
      return {
        kind: 'invalid-cursor',
        reason: 'conversation-mismatch',
        messages: [],
        list,
        cursorIndex: -1,
        endCursor: null,
      };
    }

    let cursorIndex = -1;
    let candidates = list;
    let kind = 'initial';

    if (cursor?.atStart === true) {
      const located = findCursorIndex(list, cursor);
      if (located.index < 0) {
        return {
          kind: 'invalid-cursor',
          reason: located.method,
          messages: [],
          list,
          cursorIndex: -1,
          endCursor: null,
        };
      }
      cursorIndex = located.index - 1;
      candidates = list.slice(located.index);
      kind = 'incremental';
    } else if (cursor) {
      const located = findCursorIndex(list, cursor);
      if (located.index < 0) {
        return {
          kind: 'invalid-cursor',
          reason: located.method,
          messages: [],
          list,
          cursorIndex: -1,
          endCursor: null,
        };
      }
      cursorIndex = located.index;
      candidates = list.slice(cursorIndex + 1);
      kind = 'incremental';
    }

    let lastCompleteAssistant = -1;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (candidates[index].role === 'assistant' && candidates[index].complete) {
        lastCompleteAssistant = index;
        break;
      }
    }

    if (lastCompleteAssistant < 0) {
      return {
        kind: 'no-new',
        messages: [],
        list,
        cursorIndex,
        endCursor: null,
      };
    }

    let selected = candidates
      .slice(0, lastCompleteAssistant + 1)
      .filter((message) => message.complete);

    if (!cursor) {
      const round = getLastCompleteRound(selected);
      selected = round.messages;
    }

    if (!selected.length) {
      return {
        kind: 'no-new',
        messages: [],
        list,
        cursorIndex,
        endCursor: null,
      };
    }

    const lastMessage = selected[selected.length - 1];
    let endIndex = -1;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if ((lastMessage.id && list[index].id === lastMessage.id)
        || (!lastMessage.id && messageHash(list[index]) === messageHash(lastMessage))) {
        endIndex = index;
        break;
      }
    }
    const previous = endIndex > 0 ? list[endIndex - 1] : null;

    // A relay envelope is a transport record, not another human prompt. Keep
    // only additions outside its outer closing line; never nest the payload.
    const outgoing = relayMessagesWithoutEcho(selected);
    return {
      kind,
      messages: outgoing,
      list,
      cursorIndex,
      endCursor: makeCursor(lastMessage, endIndex, key, {
        previousHash: previous ? messageHash(previous) : '',
      }),
    };
  }

  function roleLabel(message, providerName) {
    return message.role === 'user' ? '我' : providerName;
  }

  function formatMessages(messages, providerName, options = {}) {
    const list = cleanMessages(messages);
    const title = options.title ? `【${normalizeText(options.title)}】\n\n` : '';
    const body = list.map((message) => (
      `【${roleLabel(message, providerName)}】\n${message.text}`
    )).join('\n\n');
    const ending = options.withContinuation === false ? '' : '\n\n请结合以上内容继续讨论。';
    return `${title}${body}${ending}`.trim();
  }

  function formatRelayMessages(messages, providerName) {
    const name = normalizeText(providerName) || 'AI';
    const list = relayMessagesWithoutEcho(messages);
    if (!list.length) return '';
    const body = list.map((message) => {
      const label = message.role === 'user' ? '用户' : name;
      let text = message.text;
      if (message.role === 'assistant') {
        // An AI sometimes starts its own answer with its name. The relay
        // envelope already supplies that role, so discard only repeated
        // leading self-labels, never labels elsewhere in the answer.
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lead = new RegExp(`^${escaped}[：:]\\s*`, 'iu');
        while (lead.test(text)) text = text.replace(lead, '');
      }
      return `${label}：\n${text}`;
    }).join('\n\n');
    return `接续 ${name} 的讨论：\n\n${body}\n\n请继续回应。`;
  }

  function relayMessagesWithoutEcho(messages) {
    return cleanMessages(messages).flatMap((message) => {
      // Recognise a relay envelope even when the header was pasted on one line
      // with the role label ("接续 ChatGPT 的讨论：ChatGPT：…"), or carries a
      // leading quote marker. Older builds required a newline after the colon
      // and therefore forwarded these pasted envelopes again and again.
      if (message.role !== 'user'
        || !/^\uFEFF?\s*>?\s*接续\s*(?:ChatGPT|Gemini|DeepSeek)\s*的讨论\s*[：:]\s*/u
          .test(message.text)) return [message];
      // The closing marker can also be pasted inline. Use the LAST occurrence:
      // a nested package may contain its own "请继续回应。" in the middle.
      const endings = [...message.text.matchAll(/请继续回应[。.]?/gu)];
      if (!endings.length) return [message]; // An ordinary quotation is not a relay receipt.
      const last = endings[endings.length - 1];
      const addition = bodyText(message.text.slice(last.index + last[0].length))
        .replace(/^用户补充[：:]\s*/u, '').trim();
      return addition ? [{ ...message, text: addition }] : [];
    });
  }

  function conversationRevision(messages) {
    return hashText(cleanMessages(messages)
      .map((message) => `${message.id}:${messageHash(message)}:${message.complete ? 1 : 0}`)
      .join('|'));
  }

  function providerFromUrl(value) {
    let hostname = '';
    try {
      hostname = new URL(String(value || '')).hostname.toLowerCase();
    } catch {
      return '';
    }
    if (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
      || hostname === 'chat.openai.com' || hostname.endsWith('.chat.openai.com')) return 'chatgpt';
    if (hostname === 'gemini.google.com' || hostname.endsWith('.gemini.google.com')) return 'gemini';
    if (hostname === 'chat.deepseek.com' || hostname.endsWith('.chat.deepseek.com')) return 'deepseek';
    return '';
  }

  function isTerminalOperationState(state) {
    return TERMINAL_OPERATION_STATES.has(state);
  }

  function createSession(id, now = Date.now()) {
    return {
      id: String(id || `session-${now}`),
      title: '新讨论',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  function createRelayOperation(options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    return {
      id: String(options.id || `op-${now}`),
      sessionId: String(options.sessionId || ''),
      state: OPERATION_STATES.CAPTURING,
      source: {
        tabId: Number(options.sourceTabId),
        conversation: null,
        snapshotRevision: '',
        startBookmark: null,
        messageRefs: [],
        endBookmark: null,
      },
      target: {
        tabId: Number(options.targetTabId),
        expectedConversationKey: '',
        conversation: null,
        baselineRevision: '',
        baselineLastMessage: null,
        insertedMessage: null,
      },
      payload: { text: '', hash: '', charCount: 0 },
      answer: null,
      createdAt: now,
      updatedAt: now,
      error: null,
      recoveryAttempts: 0,
    };
  }

  function transitionOperation(operation, nextState, patch = {}, now = Date.now()) {
    if (!operation || !operation.state) throw new TypeError('缺少操作状态。');
    if (operation.state !== nextState) {
      const allowed = OPERATION_TRANSITIONS[operation.state];
      if (!allowed?.has(nextState)) {
        const error = new Error(`不允许从 ${operation.state} 转到 ${nextState}。`);
        error.code = 'INVALID_OPERATION_TRANSITION';
        throw error;
      }
    }

    return {
      ...operation,
      ...patch,
      source: patch.source ? { ...operation.source, ...patch.source } : operation.source,
      target: patch.target ? { ...operation.target, ...patch.target } : operation.target,
      payload: patch.payload ? { ...operation.payload, ...patch.payload } : operation.payload,
      state: nextState,
      updatedAt: Number.isFinite(now) ? now : Date.now(),
    };
  }

  function recoveryActionForOperation(operation) {
    if (!operation || isTerminalOperationState(operation.state)) return 'NONE';
    if (operation.state === OPERATION_STATES.CAPTURING
      || operation.state === OPERATION_STATES.PREPARED) return 'FAIL_SAFE';
    if (operation.state === OPERATION_STATES.DISPATCHED) return 'RECONCILE_TARGET';
    if (operation.state === OPERATION_STATES.TARGET_ACKED
      || operation.state === OPERATION_STATES.WAITING
      || operation.state === OPERATION_STATES.SUSPENDED) return 'RESUME_TARGET';
    if (operation.state === OPERATION_STATES.RESPONSE_CAPTURED) return 'FINALIZE';
    if (operation.state === OPERATION_STATES.UNCERTAIN) return 'WAIT_USER';
    return 'FAIL_SAFE';
  }

  function upsertTimelineEntry(entries, entry) {
    const list = Array.isArray(entries) ? [...entries] : [];
    const index = list.findIndex((item) => item?.operationId === entry?.operationId);
    if (index >= 0) list[index] = { ...list[index], ...entry };
    else list.push(entry);
    return list;
  }

  function locateAnchor(messages, query) {
    const list = cleanMessages(messages);
    const raw = normalizeText(query);
    if (!raw) return { matches: [], reason: 'empty' };

    const idMatches = list
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.id && message.id === raw);
    if (idMatches.length) return { matches: idMatches, reason: 'id' };

    const needle = compactText(raw);
    if (needle.length < 8) return { matches: [], reason: 'too-short' };

    const exact = list
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => compactText(message.text) === needle);
    if (exact.length) return { matches: exact, reason: 'exact' };

    const partial = list
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => compactText(message.text).includes(needle));
    return { matches: partial, reason: partial.length ? 'partial' : 'not-found' };
  }

  function bookmarkIdentityCompatible(current, existing) {
    if (!current || !existing) return false;
    if (current.role && existing.role && current.role !== existing.role) return false;
    if (current.sentSemanticHash && existing.sentSemanticHash
      && current.sentSemanticHash === existing.sentSemanticHash) return true;
    if (current.messageSemanticHash && existing.messageSemanticHash
      && current.messageSemanticHash === existing.messageSemanticHash) return true;
    const currentFull = [current.messageHash, current.sentMessageHash].filter(Boolean);
    const existingFull = [existing.messageHash, existing.sentMessageHash].filter(Boolean);
    if (currentFull.length && existingFull.length) {
      return currentFull.some((hash) => existingFull.includes(hash));
    }
    if (currentFull.length || existingFull.length) return false;
    // Legacy bookmarks may carry no fingerprints. Two empty identities can be
    // treated as an idempotent copy; a lone legacy id is not enough to delete
    // or merge a different record.
    if (!current.messageId && !existing.messageId) return true;
    return Boolean(current.messageId && existing.messageId
      && current.messageId === existing.messageId
      && (!current.messageLength || !existing.messageLength
        || current.messageLength === existing.messageLength));
  }

  function canMigrateTemporaryBookmark(options = {}) {
    const oldKey = String(options.oldKey || '');
    const newKey = String(options.newKey || '');
    const bookmark = options.bookmark;
    const operation = options.operation;
    const tabId = Number(options.tabId);
    if (!oldKey || !newKey || oldKey === newKey) return false;
    if (!/^[a-z]+:new:/.test(oldKey) || /^[a-z]+:new:/.test(newKey)) return false;
    const oldProvider = oldKey.split(':', 1)[0];
    const newProvider = newKey.split(':', 1)[0];
    if (!oldProvider || oldProvider !== newProvider) return false;
    if (!bookmark || !operation) return false;
    if (!bookmark.lastOperationId || operation.id !== bookmark.lastOperationId) return false;
    if (operation.target?.tabId !== tabId) return false;
    if (operation.target?.conversation?.conversationKey !== oldKey) return false;
    const existing = options.existingBookmark;
    if (existing && existing.lastOperationId !== bookmark.lastOperationId) return false;
    if (existing && !bookmarkIdentityCompatible(bookmark, existing)) return false;
    return true;
  }

  return {
    PROTOCOL_VERSION,
    AppError,
    normalizeSnapshot,
    OPERATION_STATES,
    normalizeText,
    bodyText,
    compactText,
    reflowEquivalent,
    reflowSignature,
    reflowMatchesSignature,
    compactHash,
    semanticText,
    semanticHash,
    hashText,
    cleanMessages,
    messageHash,
    makeCursor,
    makeStartCursor,
    inferredIdentity,
    bookmarkIdentityCompatible,
    findCursorIndex,
    getLastCompleteRound,
    getCopyPlan,
    getRelayPlan,
    formatMessages,
    formatRelayMessages,
    relayMessagesWithoutEcho,
    locateAnchor,
    conversationRevision,
    providerFromUrl,
    isTerminalOperationState,
    createSession,
    createRelayOperation,
    transitionOperation,
    recoveryActionForOperation,
    upsertTimelineEntry,
    canMigrateTemporaryBookmark,
  };
});
