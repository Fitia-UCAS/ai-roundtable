(function installDeepSeekRoundtableAdapter() {
  'use strict';

  const ADAPTER_KEY = '__AI_ROUNDTABLE_DEEPSEEK_ADAPTER__';

  const recentSends = new Map();
  const RECENT_SEND_TTL = 15 * 1000;
  let sendInFlight = null;

  function matches(currentLocation) {
    return /(^|\.)chat\.deepseek\.com$/i.test(currentLocation.hostname);
  }

  function makeError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function abortError() {
    const error = makeError('操作已取消。', 'cancelled');
    error.name = 'AbortError';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      function onAbort() {
        clearTimeout(timer);
        reject(abortError());
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
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

  function hashText(value) {
    const text = normalizeText(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function getConversationId(urlValue = location.href) {
    try {
      const url = new URL(urlValue, location.href);
      const queryId = url.searchParams.get('chat_session_id');
      if (queryId) return queryId;
      const match = url.pathname.match(/(?:^|\/)(?:a\/)?chat\/s\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return '';
    }
  }

  function stringId(value) {
    return value == null || value === '' ? '' : String(value);
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return element.getClientRects().length > 0;
  }

  function isGenerating() {
    const selectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止"]',
      'button[title*="Stop" i]',
      'button[title*="停止"]',
      '[role="button"][aria-label*="Stop" i]',
      '[role="button"][aria-label*="停止"]',
      '[role="button"][title*="Stop" i]',
      '[role="button"][title*="停止"]',
      '[data-testid*="stop" i]',
    ];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible));
  }

  function readMessage(element, role = 'assistant') {
    return globalThis.RoundtableDomText.message(element, role, { exclude: '.ds-think-content, .ds-think-toggle' });
  }

  function dedupeDomMessages(messages) {
    const seenNative = new Set();
    const occurrences = new Map();
    return messages.filter((message) => {
      if (!message?.text) return false;
      if (message.id.startsWith('deepseek-dom-')) return true;
      if (seenNative.has(message.id)) return false;
      seenNative.add(message.id);
      return true;
    }).map((message) => {
      if (!message.id.startsWith('deepseek-dom-')) return message;
      const ordinal = (occurrences.get(message.id) || 0) + 1;
      occurrences.set(message.id, ordinal);
      return ordinal === 1 ? message : { ...message, id: `${message.id}:${ordinal}` };
    });
  }

  const ITEM_SELECTOR = '[data-virtual-list-item-key]';
  const QUESTION_BODY_SELECTOR = '.ds-collapsible-text, .fbb737a4, [class*="user-message"]';
  const ANSWER_BODY_SELECTOR = '.ds-assistant-message-main-content, .ds-markdown';

  function itemKeyOf(node) {
    return node?.closest?.('[data-virtual-list-item-key]')?.getAttribute('data-virtual-list-item-key') || '';
  }

  function nativeIdOf(node) {
    return stringId(
      node?.getAttribute?.('data-message-id')
      || node?.closest?.('[data-message-id]')?.getAttribute?.('data-message-id')
      || node?.getAttribute?.('data-turn-id')
      || node?.closest?.('[data-turn-id]')?.getAttribute?.('data-turn-id'),
    );
  }

  function hasFoldEvidence(node) {
    if (!node || typeof node.closest !== 'function') return false;
    const row = node.closest('.ds-message') || node.parentElement;
    if (!row) return false;
    const insideBody = (element) => element !== node && node.contains(element);
    const nestedQuote = (element) => Boolean(element.closest?.(
      '[class*="quote" i], [class*="reference" i], blockquote, [data-quote]'));
    const controls = [...row.querySelectorAll('button, [role="button"]')]
      .filter((control) => isVisible(control)
        && !insideBody(control) && !nestedQuote(control)
        && (!row.matches?.('.ds-message') || control.closest('.ds-message') === row))
      .some((control) => /展开|展开全文|Show more|Read more/i.test(accessibleName(control)));
    const state = [...row.querySelectorAll(
      '[aria-expanded="false"], [data-collapsed="true"], [data-expanded="false"]',
    )].filter((element) => isVisible(element)
      && !insideBody(element) && !nestedQuote(element)).length > 0;
    const classState = /\b(?:collapsed|truncated|is-collapsed|folded)\b/i.test(
      `${row.className || ''} ${node.className || ''}`);
    return Boolean(controls || state || classState);
  }

  function domRow(node, role, itemKey = '') {
    if (!node) return null;
    const { text, contentAliases, renderedHash } = readMessage(node, role);
    if (!text) return null;
    const nativeId = nativeIdOf(node);
    const key = String(itemKey || itemKeyOf(node) || '');
    const roleKey = role === 'user' ? 'q' : 'a';
    const id = key
      ? `deepseek-item:${key}:${roleKey}`
      : nativeId
        ? `deepseek-native:${nativeId}:${roleKey}`
        : `deepseek-dom-${role}-${hashText(`${role}\n${text}`)}`;
    const thinking = role === 'assistant'
      ? normalizeText([...node.querySelectorAll('.ds-think-content')]
        .map((child) => child.innerText || child.textContent || '').join('\n\n'))
      : '';
    return {
      id,
      domKey: key ? `${key}:${roleKey}` : '',
      nativeId: nativeId || '',
      identity: key ? 'virtual-key' : nativeId ? 'native-id' : 'text-hash',
      folded: role === 'user' ? hasFoldEvidence(node) : false,
      role,
      text,
      contentAliases,
      renderedHash,
      thinking,
      timestamp: null,
    };
  }

  function annotateTurns(rows) {
    let userTurn = 0;
    let lastAssistantHash = '';
    for (const row of rows) {
      if (row.role === 'assistant') {
        lastAssistantHash = hashText(`assistant\n${row.text}`);
        row.assistantHash = lastAssistantHash;
        row.turnOrdinal = null;
        row.previousAssistantHash = '';
      } else {
        row.turnOrdinal = userTurn;
        row.previousAssistantHash = lastAssistantHash;
        userTurn += 1;
      }
    }
    return rows;
  }

  function domMessages() {
    const rows = [];

    // Current DeepSeek renders each message as a virtual-list row. The row key
    // can help identify a mounted turn across folded/expanded rendering,
    // but it is not a permanent server ID and must be checked against content.
    // User content: .ds-collapsible-text; assistant: .ds-assistant-message-main-content.
    const items = [...document.querySelectorAll(ITEM_SELECTOR)]
      .filter((node) => !node.parentElement?.closest(ITEM_SELECTOR));
    for (const item of items) {
      const message = item.querySelector(':scope > .ds-message') || item.querySelector('.ds-message') || item;
      const question = message.querySelector(QUESTION_BODY_SELECTOR);
      const answer = message.querySelector(ANSWER_BODY_SELECTOR);
      const key = item.getAttribute('data-virtual-list-item-key') || '';
      if (question) {
        const row = domRow(question, 'user', key);
        if (row) rows.push(row);
      }
      if (answer) {
        const row = domRow(answer, 'assistant', key);
        if (row) rows.push(row);
      }
    }

    // Older or A/B variants may not expose the virtual-list item key.
    if (!rows.length) {
      const containers = [...document.querySelectorAll(
        '[data-message-id], .ds-message-row, .message-row, .ds-message',
      )].filter((node) => !node.parentElement?.closest(
        '[data-message-id], .ds-message-row, .message-row, .ds-message',
      ));
      for (const container of containers) {
        const className = String(container.className || '');
        const roleAttribute = String(
          container.getAttribute('data-role') || container.getAttribute('data-message-author-role') || '',
        ).toLowerCase();
        let role = '';
        if (roleAttribute.includes('user') || /(?:^|\s)ds-user-message(?:\s|$)/i.test(className)) role = 'user';
        else if (roleAttribute.includes('assistant') || container.querySelector(ANSWER_BODY_SELECTOR)) role = 'assistant';
        if (!role) continue;
        const body = role === 'assistant'
          ? container.querySelector(ANSWER_BODY_SELECTOR)
          : container.querySelector(QUESTION_BODY_SELECTOR) || container;
        const row = domRow(body || container, role, itemKeyOf(container));
        if (row) rows.push(row);
      }
    }

    // Last-resort compatibility with the older flat body selectors.
    if (!rows.length) {
      const fallback = [];
      const seen = new Set();
      document.querySelectorAll(`${QUESTION_BODY_SELECTOR}, ${ANSWER_BODY_SELECTOR}`).forEach((node) => {
        if (seen.has(node) || node.closest('.ds-think-content')) return;
        seen.add(node);
        const role = node.matches(QUESTION_BODY_SELECTOR) ? 'user' : 'assistant';
        const row = domRow(node, role, itemKeyOf(node));
        if (row) fallback.push({ node, row });
      });
      fallback
        .sort((left, right) => (
          left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
        ))
        .forEach((item) => rows.push(item.row));
    }

    return dedupeDomMessages(annotateTurns(rows));
  }

  function pageTitle(messages, apiTitle = '') {
    if (apiTitle) return apiTitle;
    const fromDocument = document.title.replace(/\s*[|\-–—]\s*DeepSeek\s*$/i, '').trim();
    const firstPrompt = messages.find((message) => message.role === 'user')?.text;
    return fromDocument || firstPrompt?.slice(0, 80) || 'DeepSeek 对话';
  }

  async function inspect(options = {}) {
    throwIfAborted(options.signal);
    let conversationId = getConversationId();
    // A brand-new DeepSeek conversation updates the URL only after the first
    // message. When the caller knows the expected conversation id, wait briefly
    // for the SPA route to catch up instead of labelling the page as "new".
    if (!conversationId && options.expectedConversationId) {
      const deadline = Date.now() + 800;
      while (!conversationId && Date.now() < deadline) {
        await delay(100, options.signal);
        conversationId = getConversationId();
      }
    }
    const messages = domMessages();
    if (!messages.length && conversationId) {
      throw makeError('DeepSeek 对话正文尚未挂载，无法读取；请刷新页面后重试。', 'dom-empty');
    }

    return {
      provider: 'deepseek',
      providerName: 'DeepSeek',
      conversationKey: conversationId ? `deepseek:${conversationId}` : `deepseek:new:${location.pathname}`,
      conversationId,
      currentMessageId: '',
      title: pageTitle(messages),
      url: location.href,
      messages,
      generating: isGenerating(),
      source: 'dom',
      strategy: 'deepseek-dom',
      truncated: false,
      diagnostics: { parsedCount: messages.length, itemRows: document.querySelectorAll(ITEM_SELECTOR).length },
    };
  }

  function composerText(composer) {
    if ('value' in composer) return String(composer.value || '');
    return String(composer.innerText || composer.textContent || '');
  }

  function findComposer() {
    const selectors = [
      'textarea[placeholder="Message DeepSeek"]',
      'textarea[placeholder*="DeepSeek" i]',
      'form textarea:not([disabled]):not([readonly])',
      'textarea:not([aria-hidden="true"]):not([tabindex="-1"])',
      '[contenteditable="true"][role="textbox"]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element) && !element.disabled && !element.readOnly) return element;
      }
    }
    return null;
  }

  function setComposerText(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
    } else {
      const selection = getSelection();
      selection?.selectAllChildren(composer);
      let inserted = false;
      try {
        if (text.includes('\n')) {
          const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/\n/g, '<br>');
          inserted = document.execCommand('insertHTML', false, html);
        } else {
          inserted = document.execCommand('insertText', false, text);
        }
      } catch {}
      if (!inserted) composer.textContent = text;
    }
    try {
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }));
    } catch {
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function accessibleName(element) {
    return [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.textContent,
    ].filter(Boolean).join(' ').trim();
  }

  function submitOnce(composer) {
    const form = composer.closest('form');
    const root = form || composer.parentElement || document;
    const submitButton = [...root.querySelectorAll('button[type="submit"]:not([disabled])')].find(isVisible);
    if (submitButton) {
      submitButton.click();
      return 'submit-button';
    }
    const labelledButton = [...root.querySelectorAll('button:not([disabled]), [role="button"]')]
      .find((button) => isVisible(button)
        && /发送|send/i.test(accessibleName(button))
        && !/停止|stop/i.test(accessibleName(button)));
    if (labelledButton) {
      labelledButton.click();
      return 'labelled-button';
    }
    if (form?.requestSubmit) {
      form.requestSubmit();
      return 'request-submit';
    }
    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
    return 'enter';
  }

  function requestedText(options) {
    return globalThis.RoundtableDomText.body(
      options.text ?? options.prompt ?? options.content ?? options.message
      ?? options.request?.text ?? options.request?.prompt ?? '',
    );
  }

  function sentTextMatch(messageText, prompt, folded = false) {
    // Preserve word boundaries. Collapsing whitespace to nothing would treat
    // "foo bar" and "foobar" as identical messages.
    const semantic = (value) => {
      const text = normalizeText(value);
      const cjkEdge = (char) => /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(char || '');
      let output = '';
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '\n') { output += text[index]; continue; }
        const before = output.slice(-1);
        const after = text[index + 1] || '';
        if (!before || !after) continue;
        const removeBreak = cjkEdge(after)
          && (cjkEdge(before) || /[,.;:!?，。；：！？]/u.test(before));
        if (!removeBreak) output += ' ';
      }
      return output.replace(/[ \t]+/gu, ' ')
      .replace(/\s*([,.;:!?，。；：！？、])\s*/gu, '$1')
      .trim();
    };
    const actual = semantic(messageText);
    const expected = semantic(prompt);
    if (!actual || !expected) return '';
    if (actual === expected) return 'exact';
    const suffix = /(?:…|\.\.\.|\.\.．)$/u.test(actual);
    const prefix = actual.replace(/(?:…|\.\.\.|\.\.．)$/u, '');
    // A folded user bubble is a real rendering of the same turn. Require at
    // least 24 compact characters and an actual prefix of the sent payload.
    if (folded && prefix.length >= 24 && prefix.length < expected.length
      && expected.startsWith(prefix) && (suffix || actual.length < expected.length)) {
      return 'collapsed-preview';
    }
    return '';
  }

  async function confirmUserMessage(prompt, baselineIds, baselineCount, composer, signal,
    timeoutMs = 6 * 1000, expectedConversationKey = '', lockedConversationId = '') {
    const deadline = Date.now() + timeoutMs;
    let clearedPolls = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const conversationId = getConversationId();
      const currentKey = conversationId
        ? `deepseek:${conversationId}`
        : `deepseek:new:${location.pathname}`;
      if (expectedConversationKey && !/^deepseek:new:/.test(expectedConversationKey)) {
        if (currentKey !== expectedConversationKey) {
          throw makeError('目标 DeepSeek 对话在确认过程中发生变化，本次未推进书签。', 'target-conversation-changed');
        }
      } else if (expectedConversationKey && conversationId) {
        if (lockedConversationId && lockedConversationId !== conversationId) {
          throw makeError('目标 DeepSeek 对话在确认过程中发生变化，本次未推进书签。', 'target-conversation-changed');
        }
        lockedConversationId = conversationId;
      }
      const messages = domMessages();
      const overlap = messages.some((message) => baselineIds.has(message.id));
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'user' || baselineIds.has(message.id)) continue;
        const freshPosition = index >= baselineCount;
        const newItem = Boolean(message.domKey) || message.id.startsWith('deepseek-item:');
        if (!freshPosition && !(newItem && overlap)) continue;
        const match = sentTextMatch(message.text, prompt, message.folded === true);
        if (match) {
          return { conversationId,
            message: { ...message, index }, match, reason: 'user-message' };
        }
      }

      const activeComposer = findComposer();
      const cleared = (!composer.isConnected && !activeComposer)
        || !normalizeText(composerText(activeComposer || composer));
      clearedPolls = cleared ? clearedPolls + 1 : 0;
      await delay(150, signal);
    }
    return {
      conversationId: getConversationId(),
      message: null,
      confirmed: false,
      lastError: null,
      reason: clearedPolls ? 'composer-cleared-unconfirmed' : 'no-user-message',
    };
  }

  async function performSend(options) {
    const clock = () => (typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now());
    const startedAt = clock();
    const signal = options.signal;
    throwIfAborted(signal);
    const prompt = requestedText(options);
    if (!prompt) throw makeError('没有要发送的内容。', 'empty-prompt');
    if (isGenerating()) throw makeError('DeepSeek 正在回答，请等待当前回答结束。', 'provider-busy');

    const currentConversationKey = () => {
      const id = getConversationId();
      return id ? `deepseek:${id}` : `deepseek:new:${location.pathname}`;
    };
    const initialConversationKey = currentConversationKey();
    const expectedConversationKey = String(options.expectedConversationKey || initialConversationKey);
    const assertTargetConversation = (phase) => {
      const actual = currentConversationKey();
      const expectedIsNew = /^deepseek:new:/.test(expectedConversationKey);
      if (!expectedIsNew) {
        if (actual !== expectedConversationKey) {
          throw makeError('目标 DeepSeek 对话已经变化，本次未发送。', 'target-conversation-changed');
        }
        return;
      }
      if (/^deepseek:new:/.test(actual)) {
        if (actual !== expectedConversationKey) {
          throw makeError('目标 DeepSeek 对话已经变化，本次未发送。', 'target-conversation-changed');
        }
        return;
      }
      // A brand-new chat may acquire its real URL only after the first submit.
      if (phase !== 'after-submit') {
        throw makeError('目标 DeepSeek 对话在发送前已经变化，本次未发送。', 'target-conversation-changed');
      }
    };
    const providedBaseline = options.baseline;
    const baselineStartedAt = clock();
    let baselineIds;
    let baselineCount = 0;
    if (providedBaseline
      && providedBaseline.conversationKey === expectedConversationKey
      && Array.isArray(providedBaseline.messageIds)) {
      baselineIds = new Set(providedBaseline.messageIds.map(String).filter(Boolean));
      const baselineDom = domMessages();
      baselineCount = baselineDom.length;
      baselineDom.forEach((message) => baselineIds.add(message.id));
    } else {
      const baselineDom = domMessages();
      baselineCount = baselineDom.length;
      baselineIds = new Set(baselineDom.map((message) => message.id));
    }
    const baselineMs = clock() - baselineStartedAt;

    assertTargetConversation('before-write');
    const composerStartedAt = clock();
    const composer = findComposer();
    if (!composer) throw makeError('没有找到 DeepSeek 输入框。', 'composer-not-found');
    const composerMs = clock() - composerStartedAt;

    assertTargetConversation('before-write');
    const writeStartedAt = clock();
    setComposerText(composer, prompt);
    await delay(120, signal);
    const comparablePrompt = normalizeText(prompt);
    const comparableComposer = normalizeText(composerText(composer));
    const composerOk = globalThis.RoundtableDomText?.composerMatch
      ? globalThis.RoundtableDomText.composerMatch(prompt, composerText(composer))
      : comparablePrompt === comparableComposer;
    if (!composerOk) {
      throw makeError('内容未能完整写入 DeepSeek 输入框。', 'composer-verify-failed');
    }
    const writeMs = clock() - writeStartedAt;

    assertTargetConversation('before-submit');
    const submitStartedAt = clock();
    const submitMethod = submitOnce(composer);
    assertTargetConversation('after-submit');
    const submitMs = clock() - submitStartedAt;

    const confirmStartedAt = clock();
    const confirmBudget = Math.min(6 * 1000, Math.max(1000, Number(options.sendTimeoutMs) || 6 * 1000));
    const lockedConversationId = getConversationId();
    const confirmation = await confirmUserMessage(
      prompt, baselineIds, baselineCount, composer, signal, confirmBudget,
      expectedConversationKey, lockedConversationId);
    const confirmMs = clock() - confirmStartedAt;
    if (lockedConversationId && confirmation.conversationId
      && confirmation.conversationId !== lockedConversationId) {
      throw makeError('目标 DeepSeek 对话在确认过程中发生变化，本次未推进书签。',
        'target-conversation-changed');
    }

    let conversationId = confirmation.conversationId || getConversationId();
    const urlWaitStartedAt = clock();
    if (!conversationId) {
      const deadline = Date.now() + 800;
      while (!conversationId && Date.now() < deadline) {
        await delay(100, signal);
        conversationId = getConversationId();
      }
    }
    const urlWaitMs = clock() - urlWaitStartedAt;
    const confirmed = Boolean(confirmation.message || confirmation.confirmed);
    const result = {
      sent: confirmed,
      submitted: true,
      confirmed,
      confirmation: confirmation.message ? 'user-message' : (confirmation.reason || ''),
      matchType: confirmation.match || '',
      submitMethod,
      prompt,
      promptHash: hashText(prompt),
      conversationId,
      conversationKey: conversationId
        ? `deepseek:${conversationId}`
        : `deepseek:new:${location.pathname}`,
      initialConversationKey,
      conversationTransition: /^deepseek:new:/.test(expectedConversationKey)
        && conversationId ? 'new-to-real' : 'same',
      userMessageId: confirmation.message?.id || '',
      collapsedEvidence: Boolean(confirmation.message?.folded),
      insertedMessage: confirmation.message || null,
      baselineMessageIds: [...baselineIds],
      baselineMessageCount: baselineCount,
      currentMessageId: '',
      snapshot: null,
      timings: {
        baselineMs: Math.round(baselineMs),
        composerMs: Math.round(composerMs),
        writeMs: Math.round(writeMs),
        submitMs: Math.round(submitMs),
        confirmMs: Math.round(confirmMs),
        urlWaitMs: Math.round(urlWaitMs),
        totalMs: Math.round(clock() - startedAt),
      },
    };
    if (!confirmed) {
      result.reason = 'send-unconfirmed';
      result.error = '已执行一次发送，但目标页面尚未出现本次新增用户消息；为避免重复，没有再次发送。';
    }
    return result;
  }

  async function send(options = {}) {
    const prompt = requestedText(options);
    const dedupeKey = String(
      options.idempotencyKey || options.requestId
      || `${getConversationId() || location.pathname}:${hashText(prompt)}`,
    );
    const recent = recentSends.get(dedupeKey);
    if (recent && Date.now() - recent.createdAt < RECENT_SEND_TTL) {
      return { ...recent.result, repeated: true };
    }
    if (sendInFlight) {
      if (sendInFlight.key === dedupeKey) return sendInFlight.promise;
      throw makeError('已有一条消息正在发送。', 'send-in-progress');
    }

    const promise = performSend(options)
      .then((result) => {
        recentSends.set(dedupeKey, { createdAt: Date.now(), result });
        return result;
      })
      .finally(() => {
        if (sendInFlight?.promise === promise) sendInFlight = null;
      });
    sendInFlight = { key: dedupeKey, promise };
    return promise;
  }

  function waitSource(options) {
    return options.sendResult && typeof options.sendResult === 'object'
      ? { ...options, ...options.sendResult }
      : options;
  }

  function findAnchorIndex(messages, options) {
    if (options.userMessageId) {
      const index = messages.findIndex((message) => message.id === String(options.userMessageId));
      if (index >= 0) return index;
    }
    const prompt = normalizeText(options.prompt ?? options.text ?? '');
    if (prompt) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user' && normalizeText(messages[index].text) === prompt) return index;
      }
    }
    if (options.afterMessageId) {
      const index = messages.findIndex((message) => message.id === String(options.afterMessageId));
      if (index >= 0) return index;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return index;
    }
    return -1;
  }

  function assistantAfterAnchor(messages, anchorIndex, baselineIds) {
    if (anchorIndex < 0) return null;
    let candidate = null;
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role === 'user') break;
      if (message.role === 'assistant' && message.text && !baselineIds.has(message.id)) candidate = message;
    }
    return candidate;
  }

  function conversationRoot() {
    return document.querySelector('.ds-chat, .chat-container, main') || document.body;
  }

  function createActivityMonitor() {
    const api = globalThis.RoundtableContent;
    if (api?.createDomActivityMonitor) return api.createDomActivityMonitor(conversationRoot());
    return {
      lastActivity: () => 0,
      next: (signal, timeoutMs) => delay(timeoutMs, signal),
      disconnect() {},
    };
  }

  async function wait(options = {}) {
    const source = waitSource(options);
    const signal = options.signal;
    const requestedTimeout = source.timeoutMs ?? source.maxWaitMs;
    const timeoutMs = Math.min(10 * 60 * 1000, Math.max(5000, Number(requestedTimeout) || 6 * 60 * 1000));
    const pollMs = Math.min(3000, Math.max(150, Number(source.pollMs) || 400));
    const stablePolls = Math.min(4, Math.max(2, Number(source.stablePolls) || 2));
    const idleMs = Math.min(3000, Math.max(300, Number(source.stableMilliseconds) || 900));
    const baselineIds = new Set((source.baselineMessageIds || []).map(String));
    const baselineKeys = new Set((source.baselineMessageKeys || []).map(String));
    const expectedConversationId = String(source.conversationId || getConversationId() || '');
    const deadline = Date.now() + timeoutMs;
    let stableKey = '';
    let stableCount = 0;
    let candidateSince = 0;
    let idleWithoutAnswerSince = 0;
    let sawGeneration = false;
    let lastError = null;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const conversationId = getConversationId();
      if (!conversationId) {
        await delay(pollMs, signal);
        continue;
      }
      if (expectedConversationId && expectedConversationId !== conversationId) {
        throw makeError('DeepSeek 页面已经切换到另一条对话，等待已停止。', 'conversation-changed');
      }
      if (isGenerating()) {
        sawGeneration = true;
        idleWithoutAnswerSince = 0;
        await delay(pollMs, signal);
        continue;
      }

      let snapshot;
      try {
        snapshot = await inspect({ signal });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
        await delay(pollMs, signal);
        continue;
      }
      const messages = snapshot.messages;
      const anchorIndex = findAnchorIndex(messages, source);
      const candidate = assistantAfterAnchor(messages, anchorIndex, baselineIds);
      const key = candidate
        ? `${candidate.id || ''}|assistant|${hashText(candidate.text)}` : '';
      const newlyGenerated = candidate && !baselineKeys.has(key)
        && !baselineIds.has(String(candidate.id || ''));
      if (newlyGenerated) {
        const identity = `${candidate.id}\n${hashText(candidate.text)}`;
        if (identity === stableKey) stableCount += 1;
        else {
          stableKey = identity;
          stableCount = 1;
          candidateSince = Date.now();
        }
        idleWithoutAnswerSince = 0;
        if (!snapshot.generating && stableCount >= stablePolls
          && Date.now() - candidateSince >= idleMs) {
          return {
            completed: true,
            conversationId,
            conversationKey: `deepseek:${conversationId}`,
            userMessageId: messages[anchorIndex]?.id || source.userMessageId || '',
            message: candidate,
            answer: candidate.text,
            snapshot,
          };
        }
      } else {
        stableKey = '';
        stableCount = 0;
        if (!idleWithoutAnswerSince) idleWithoutAnswerSince = Date.now();
        if (Date.now() - idleWithoutAnswerSince > (sawGeneration ? 6500 : 18000)) {
          throw makeError('DeepSeek 已停止生成，但未能定位本轮新增回答；请检查目标对话。', 'answer-not-found');
        }
      }
      await delay(pollMs, signal);
    }
    throw makeError(lastError
      ? `等待 DeepSeek 回答超时（页面读取失败）：${lastError.message}`
      : '等待 DeepSeek 回答超时（目标仍可能在生成）。', 'wait-timeout');
  }

  const installed = globalThis.RoundtableContent?.install({
    id: 'deepseek',
    matches,
    inspect,
    readMessage,
    send,
    wait,
  });
  if (installed) globalThis[ADAPTER_KEY] = true;
})();
