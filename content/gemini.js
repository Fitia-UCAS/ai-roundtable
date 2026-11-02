(function installGeminiRoundtableAdapter() {
  'use strict';

  const ADAPTER_KEY = '__AI_ROUNDTABLE_GEMINI_ADAPTER__';

  const READ_CHAT_RPC = 'hNvQHb';
  const PAGE_SIZE = 100;
  const MAX_PAGES = 200;
  const RECENT_SEND_TTL = 15 * 1000;
  const recentSends = new Map();
  let sendInFlight = null;

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

  function matches(currentLocation) {
    return /(^|\.)gemini\.google\.com$/i.test(currentLocation.hostname);
  }

  function getAccountPrefix() {
    return location.pathname.match(/^\/u\/\d+/i)?.[0] || '';
  }

  function getConversationId() {
    return location.pathname.match(/^(?:\/u\/\d+)?\/app\/([^/?#]+)/i)?.[1] || '';
  }

  function decodeEmbeddedString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
    }
  }

  function extractEmbeddedValue(source, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(source).match(new RegExp(`"${escaped}":"((?:\\\\.|[^"\\\\])*)"`));
    return match ? decodeEmbeddedString(match[1]) : '';
  }

  async function getTokens(signal) {
    throwIfAborted(signal);
    const fromPage = [...document.scripts].map((script) => script.textContent || '').join('\n');
    let tokens = {
      accessToken: extractEmbeddedValue(fromPage, 'SNlM0e'),
      buildLabel: extractEmbeddedValue(fromPage, 'cfb2h'),
      sessionId: extractEmbeddedValue(fromPage, 'FdrFJe'),
    };
    if (tokens.accessToken) return tokens;

    const response = await fetch(`${getAccountPrefix()}/app`, {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw Object.assign(new Error(`无法初始化 Gemini 会话（${response.status}）。`),
      { status: response.status, retryAfterMs: Number(response.headers?.get('retry-after')) * 1000 });
    const source = await response.text();
    tokens = {
      accessToken: extractEmbeddedValue(source, 'SNlM0e'),
      buildLabel: extractEmbeddedValue(source, 'cfb2h'),
      sessionId: extractEmbeddedValue(source, 'FdrFJe'),
    };
    if (!tokens.accessToken) throw new Error('未能读取 Gemini 登录状态，请刷新页面后重试。');
    return tokens;
  }

  function parseFrames(responseText) {
    const source = String(responseText).replace(/^\)\]\}'\r?\n/, '');
    const frames = [];
    let cursor = 0;
    while (cursor < source.length) {
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      if (cursor >= source.length) break;
      const newline = source.indexOf('\n', cursor);
      if (newline < 0) break;
      const lengthText = source.slice(cursor, newline).trim();
      if (!/^\d+$/.test(lengthText)) break;
      const length = Number(lengthText);
      const start = newline + 1;
      try {
        frames.push(JSON.parse(source.slice(start, start + length)));
      } catch {
        break;
      }
      cursor = start + length;
    }
    if (frames.length) return frames;
    return source.split(/\r?\n/).flatMap((line) => {
      try {
        return line.trim().startsWith('[') ? [JSON.parse(line.trim())] : [];
      } catch {
        return [];
      }
    });
  }

  function findRpcPayload(value, rpcId) {
    if (!Array.isArray(value)) return null;
    const envelope = (value[0] === 'wrb.fr' && value[1] === rpcId) || value[0] === rpcId || value[1] === rpcId;
    if (envelope && typeof value[2] === 'string') {
      try {
        return JSON.parse(value[2]);
      } catch {
        return null;
      }
    }
    for (const child of value) {
      const found = findRpcPayload(child, rpcId);
      if (found !== null) return found;
    }
    return null;
  }

  async function callRpc(rpcId, rpcArguments, tokens, signal) {
    throwIfAborted(signal);
    const query = new URLSearchParams({
      rpcids: rpcId,
      'source-path': location.pathname.replace(/\/+$/, ''),
      hl: document.documentElement.lang || 'zh-CN',
      _reqid: String(Math.floor(1000 + Math.random() * 8999)),
      rt: 'c',
    });
    if (tokens.buildLabel) query.set('bl', tokens.buildLabel);
    if (tokens.sessionId) query.set('f.sid', tokens.sessionId);
    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(rpcArguments), null, 'generic']]]),
      at: tokens.accessToken,
    });
    const response = await fetch(`${getAccountPrefix()}/_/BardChatUi/data/batchexecute?${query}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
      },
      body: `${body.toString()}&`,
      signal,
    });
    if (!response.ok) throw Object.assign(new Error(`无法读取 Gemini 对话（${response.status}）。`), { status: response.status, retryAfterMs: Number(response.headers?.get('retry-after')) * 1000 });
    for (const frame of parseFrames(await response.text())) {
      const payload = findRpcPayload(frame, rpcId);
      if (payload !== null) return payload;
    }
    throw new Error('Gemini 返回的数据格式已变化。');
  }

  function turnId(turn) {
    return String(turn?.[0]?.[1] || turn?.[1]?.[1] || '');
  }

  async function fetchConversation(chatId, signal) {
    const tokens = await getTokens(signal);
    const key = chatId.startsWith('c_') ? chatId : `c_${chatId}`;
    const turns = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      throwIfAborted(signal);
      const payload = await callRpc(
        READ_CHAT_RPC,
        [key, PAGE_SIZE, cursor, 1, [0], [4], null, 1],
        tokens,
        signal,
      );
      if (!Array.isArray(payload) || !Array.isArray(payload[0])) throw new Error('Gemini 对话数据无法识别。');
      let added = 0;
      for (const turn of payload[0]) {
        if (!Array.isArray(turn)) continue;
        const id = turnId(turn);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        turns.push(turn);
        added += 1;
      }
      const nextCursor = typeof payload[1] === 'string' && payload[1] ? payload[1] : null;
      if (!nextCursor) return turns;
      if (!added || seenCursors.has(nextCursor)) throw new Error('Gemini 分页读取中断，请刷新页面后重试。');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error('Gemini 对话过长，未能完整读取。');
  }

  function firstString(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    for (const child of value) {
      const found = firstString(child);
      if (found) return found;
    }
    return '';
  }

  function timestampValue(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    if (typeof value[0] !== 'number' || typeof value[1] !== 'number') return null;
    return (value[0] * 1000) + (value[1] / 1000000);
  }

  function parseTurns(turns) {
    const blocks = [];
    turns.forEach((turn, sourceIndex) => {
      const id = turnId(turn) || `turn-${sourceIndex}`;
      const prompt = firstString(turn?.[2]?.[0]).replace(/\r\n?/g, '\n').trim();
      const candidates = Array.isArray(turn?.[3]?.[0]) ? turn[3][0] : [];
      const activeResponseId = turn?.[1]?.[2];
      const candidate = candidates.find((item) => Array.isArray(item) && item[0] === activeResponseId)
        || candidates.find(Array.isArray);
      const response = firstString(candidate?.[1]).replace(/\r\n?/g, '\n').trim();
      if (prompt || response) {
        blocks.push({ id, prompt, response, timestamp: timestampValue(turn?.[4]), sourceIndex });
      }
    });

    const timed = blocks.filter((block) => Number.isFinite(block.timestamp));
    const ordered = timed.length >= 2
      ? [...blocks].sort((left, right) => left.timestamp - right.timestamp)
      : [...blocks].reverse();

    return ordered.flatMap((block) => {
      const messages = [];
      if (block.prompt) messages.push({
        id: `${block.id}:user`, role: 'user', text: block.prompt, timestamp: block.timestamp,
      });
      if (block.response) messages.push({
        id: `${block.id}:assistant`, role: 'assistant', text: block.response, timestamp: block.timestamp,
      });
      return messages;
    });
  }

  function readMessage(element, role = 'assistant') {
    const content = element?.querySelector?.('message-content .markdown.markdown-main-panel, message-content .markdown, message-content') || element;
    return globalThis.RoundtableDomText.message(content, role, { exclude:
      'follow-up, .follow-up-container, .thoughts-container, .thoughts-wrapper, model-thoughts, '
      + '.table-footer, message-actions, election-info-disclaimer, finance-info-disclaimer, '
      + '.sources-list, [class*="screen-reader"], user-query-file-carousel' });
  }

  function domMessages() {
    const found = [];
    const seenNodes = new Set();
    function push(node, role, content) {
      if (!node || seenNodes.has(node)) return;
      seenNodes.add(node);
      const { text, contentAliases, renderedHash, renderedCompactHash } = readMessage(content || node, role);
      if (!text) return;
      const id = node.getAttribute?.('data-message-id') || node.id
        || `gemini-dom-${role}-${hashText(text)}`;
      found.push({ node, id, role, text, contentAliases, renderedHash, renderedCompactHash });
    }

    document.querySelectorAll('user-query, .user-query-container, [data-test-id="user-query"]')
      .forEach((node) => {
        if (node.parentElement?.closest('user-query, .user-query-container, [data-test-id="user-query"]')) return;
        push(node, 'user', node.querySelector('.query-text, user-query-content') || node);
      });
    document.querySelectorAll('model-response, [data-test-id="model-response"]')
      .forEach((node) => {
        if (node.parentElement?.closest('model-response, [data-test-id="model-response"]')) return;
        const content = node.querySelector('message-content') || node;
        const markdown = content.querySelector('.markdown.markdown-main-panel, .markdown') || content;
        push(node, 'assistant', markdown);
      });

    const seenNative = new Set();
    const occurrences = new Map();
    return found
      .sort((left, right) => {
        const position = left.node.compareDocumentPosition(right.node);
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      // A user can send an identical prompt more than once.  Hash-derived ids
      // must not collapse two different DOM turns into a single message.
      .filter((message) => {
        if (message.id.startsWith('gemini-dom-')) return true;
        if (seenNative.has(message.id)) return false;
        seenNative.add(message.id);
        return true;
      })
      .map(({ id, role, text, contentAliases, renderedHash, renderedCompactHash }) => {
        if (id.startsWith('gemini-dom-')) {
          const ordinal = (occurrences.get(id) || 0) + 1;
          occurrences.set(id, ordinal);
          if (ordinal > 1) id += `:${ordinal}`;
        }
        return { id, role, text, contentAliases, renderedHash, renderedCompactHash };
      });
  }

  function titleFromPage(chatId, messages) {
    const expected = new Set([`/app/${chatId}`, `${getAccountPrefix()}/app/${chatId}`]);
    const link = [...document.querySelectorAll('a[href]')].find((candidate) => {
      try {
        return expected.has(new URL(candidate.href, location.href).pathname);
      } catch {
        return false;
      }
    });
    const sidebar = link?.textContent?.replace(/\s+/g, ' ').trim();
    if (sidebar) return sidebar;
    const firstPrompt = messages.find((message) => message.role === 'user')?.text;
    return firstPrompt?.replace(/\s+/g, ' ').slice(0, 80)
      || document.title.replace(/\s*[|\-–—]\s*(?:Google\s+)?Gemini\s*$/i, '').trim()
      || 'Gemini 对话';
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
      'button[mattooltip*="Stop" i]',
      'button[mattooltip*="停止"]',
      '[data-test-id*="stop" i]',
    ];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible));
  }

  async function readDomMessages(signal, timeoutMs = 800) {
    const deadline = Date.now() + timeoutMs;
    let messages = domMessages();
    while (!messages.length && Date.now() < deadline) {
      await delay(120, signal);
      messages = domMessages();
    }
    return messages;
  }

  const relayHistory = globalThis.RoundtableRelayHistory.create({
    readDom: domMessages,
    getKey: getConversationId,
    isGenerating,
    readHistory: async (signal) => {
      const chatId = getConversationId();
      const messages = parseTurns(await fetchConversation(chatId, signal));
      return { title: titleFromPage(chatId, messages), messages };
    },
  });

  async function inspect(options = {}) {
    throwIfAborted(options.signal);
    const chatId = getConversationId();
    let messages = await readDomMessages(options.signal, chatId ? 800 : 0);
    let source = 'dom';
    if (chatId && (options.relayRead || options.relayRecheckId)) {
      const captured = await relayHistory.read(options, messages);
      return { ...captured, provider: 'gemini', providerName: 'Gemini',
        conversationKey: `gemini:${chatId}`, url: location.href, generating: false,
        source: captured.source || 'api', strategy: captured.strategy || 'api', truncated: false };
    }

    if (!messages.length) {
      messages = await readDomMessages(options.signal, chatId ? 800 : 0);
      if (messages.length) source = 'dom';
    }

    if (!messages.length) {
      const diagnostics = {
        userQueries: document.querySelectorAll('user-query, [data-test-id="user-query"]').length,
        responses: document.querySelectorAll('model-response, [data-test-id="model-response"]').length,
        conversationContainers: document.querySelectorAll('.conversation-container').length,
        main: document.querySelectorAll('main').length,
        iframes: document.querySelectorAll('iframe').length,
        shadowRoots: [...document.querySelectorAll('*')].filter((element) => element.shadowRoot).length,
        mainText: document.querySelector('main')?.innerText?.trim().length || 0,
      };
      // A brand-new chat legitimately has no messages. Reporting it as an error
      // logged a warning on every empty Gemini tab and marked the tab
      // disconnected, so the panel could not even use it as a relay target.
      if (!chatId) {
        return {
          provider: 'gemini',
          providerName: 'Gemini',
          conversationKey: `gemini:new:${location.pathname}`,
          conversationId: '',
          title: titleFromPage('', []),
          url: location.href,
          messages: [],
          generating: isGenerating(),
          source: 'dom',
          strategy: 'dom',
          truncated: false,
          empty: true,
          diagnostics,
        };
      }
      const summary = Object.entries(diagnostics)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      throw makeError(`Gemini 页面内容未读取（${summary}），请刷新页面后重试。`, 'dom-empty');
    }

    return {
      provider: 'gemini',
      providerName: 'Gemini',
      conversationKey: chatId ? `gemini:${chatId}` : `gemini:new:${location.pathname}`,
      title: titleFromPage(chatId, messages),
      url: location.href,
      messages,
      generating: isGenerating(),
      source,
    };
  }

  function composerText(composer) {
    if ('value' in composer) return String(composer.value || '');
    return String(composer.innerText || composer.textContent || '');
  }

  function comparableText(value) {
    return globalThis.RoundtableDomText?.identity
      ? globalThis.RoundtableDomText.identity(value)
      : String(value ?? '').normalize('NFKC').replace(/\s+/gu, '');
  }

  function composerMatchesPrompt(composer, prompt) {
    const matches = globalThis.RoundtableDomText?.composerMatch;
    if (matches) {
      return [
        'value' in composer ? composer.value : '',
        composer.innerText,
        globalThis.RoundtableDomText.read(composer, { markdown: false }),
        composer.textContent,
      ].some((value) => matches(prompt, value)
        && globalThis.RoundtableDomText.lineBreaksPreserved(prompt, value));
    }
    const expected = comparableText(prompt);
    if (!expected) return false;
    const candidates = [
      'value' in composer ? composer.value : '',
      composer.innerText,
      composer.textContent,
    ];
    return candidates.some((value) => comparableText(value) === expected);
  }

  function findComposer() {
    const selectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"][role="textbox"]',
      '[data-test-id="input-area"] [contenteditable="true"]',
      'form [contenteditable="true"][role="textbox"]',
      'textarea:not([disabled]):not([readonly])',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)
          && element.getAttribute('aria-disabled') !== 'true'
          && !element.disabled
          && !element.readOnly) {
          return element;
        }
      }
    }
    return null;
  }

  function dispatchComposerInput(composer, text) {
    try {
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text,
      }));
    } catch {
      composer.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function editableHtml(text) {
    const escapeHtml = (line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // One <p> per Markdown paragraph; a <br> inside it represents a single
    // line break. An empty <p> introduces several extra newlines in innerText.
    const chunks = String(text).split(/(\n{2,})/u);
    const paragraphs = [];
    for (let index = 0; index < chunks.length; index += 2) {
      const lines = chunks[index].split('\n').map(escapeHtml).join('<br>');
      const extraBreaks = chunks[index + 1] ? Math.max(0, chunks[index + 1].length - 2) : 0;
      paragraphs.push(`<p>${lines || '<br>'}${'<br>'.repeat(extraBreaks)}</p>`);
    }
    return paragraphs.join('');
  }

  function replaceEditableContents(composer, text) {
    const template = document.createElement('template');
    template.innerHTML = editableHtml(text);
    composer.replaceChildren(template.content.cloneNode(true));
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
      dispatchComposerInput(composer, text);
      return;
    }

    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try {
      if (text.includes('\n')) {
        inserted = document.execCommand('insertHTML', false, editableHtml(text));
      } else {
        inserted = document.execCommand('insertText', false, text);
      }
    } catch {}
    if (!inserted || !composerMatchesPrompt(composer, text)) {
      replaceEditableContents(composer, text);
    }
    dispatchComposerInput(composer, text);
  }

  // Quill/rich-textarea may repaint asynchronously after execCommand. Give the
  // editor a short window to settle instead of failing on the first frame.
  async function waitForComposerMatch(composer, prompt, signal, timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const live = composer?.isConnected ? composer : findComposer();
      if (live && composerMatchesPrompt(live, prompt)) return live;
      await delay(100, signal);
    }
    return null;
  }

  function accessibleName(element) {
    return [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('data-tooltip'),
      element.getAttribute?.('mattooltip'),
      element.getAttribute?.('title'),
      element.textContent,
    ].filter(Boolean).join(' ').trim();
  }

  function enabledButton(button) {
    return isVisible(button)
      && !button.disabled
      && button.getAttribute?.('aria-disabled') !== 'true';
  }

  function findSendButton(composer) {
    const directSelectors = [
      'button.send-button',
      '[data-test-id="send-button"]',
      '[data-test-id="send-message-button"]',
      'button[aria-label="Send" i]',
      'button[aria-label="发送"]',
      'button[aria-label*="Send message" i]',
      'button[aria-label*="发送消息"]',
      'button[aria-label*="Submit" i]',
      'button[mattooltip*="Send" i]',
      'button[mattooltip*="发送"]',
      '.send-button-container button',
    ];
    const root = composer.closest('form, input-container, .input-area-container, .text-input-field')
      || composer.parentElement
      || document;
    for (const scope of root === document ? [document] : [root, document]) {
      for (const selector of directSelectors) {
        const button = [...scope.querySelectorAll(selector)].find(enabledButton);
        if (button) return button;
      }
    }

    return [...root.querySelectorAll('button, [role="button"]')].find((button) => (
      enabledButton(button)
      && /发送|send/i.test(accessibleName(button))
      && !/停止|stop/i.test(accessibleName(button))
    )) || null;
  }

  async function waitForSendButton(composer, signal, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const button = findSendButton(composer);
      if (button) return button;
      await delay(100, signal);
    }
    return null;
  }

  function requestedText(options) {
    return globalThis.RoundtableDomText.body(
      options.text ?? options.prompt ?? options.content ?? options.message
      ?? options.request?.text ?? options.request?.prompt ?? '',
    );
  }

  function messageKey(message) {
    return `${message?.id || ''}|${message?.role || ''}|${hashText(message?.text || '')}`;
  }

  // The target message may render with different paragraph whitespace, or Gemini
  // may show only an abbreviated bubble until it is expanded.  A partial bubble
  // is eligible ONLY if it is new relative to the pre-send snapshot and it
  // shows a substantial exact prefix of this particular outgoing payload.
  // In particular, the repeated "接续 X 的讨论" heading alone is insufficient.
  function semanticText(value) {
    const text = normalizeText(value);
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
      const punctuation = /[,.;:!?，。；：！？]/u.test(before);
      const removeBreak = punctuation || (cjkEdge(after) && cjkEdge(before));
      if (!removeBreak) output += ' ';
    }
    return output.replace(/[ \t]+/gu, ' ')
      .replace(/\s*([,.;:!?，。；：！？、])\s*/gu, '$1')
      .trim();
  }

  function sentTextMatch(messageText, prompt) {
    const actual = semanticText(messageText);
    const expected = semanticText(prompt);
    if (!actual || !expected) return '';
    if (actual === expected) return 'exact';
    if (globalThis.RoundtableCore.reflowEquivalent(prompt, messageText)) return 'reflow';
    const prefix = actual.replace(/(?:…|\.\.\.|\.\.．)$/u, '');
    if (expected.length >= 120 && prefix.length >= 80 && prefix.length < expected.length
      && expected.startsWith(prefix)) return 'collapsed-preview';
    return '';
  }

  function findNewUserMessage(messages, prompt, baselineKeys, baselineCount) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      // A hash-derived DOM id can be reused when the user sends identical text.
      // The position must advance, or a new non-baseline message key must appear.
      if (index < baselineCount && baselineKeys.has(messageKey(message))) continue;
      const match = sentTextMatch(message.text, prompt);
      if (match) return { message, match };
    }
    return null;
  }

  async function confirmUserMessage(prompt, baseline, composer, signal, timeoutMs = 12 * 1000) {
    const deadline = Date.now() + timeoutMs;
    const baselineKeys = new Set(
      baseline.messageKeys || baseline.messages.map(messageKey),
    );
    const baselineCount = Number(baseline.messageCount) || baseline.messages.length;
    let inputCleared = false;
    let clearedPolls = 0;
    let latestSnapshot = null;
    let lastError = null;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const liveComposer = composer.isConnected ? composer : findComposer();
      const clearedNow = Boolean(liveComposer) && normalizeText(composerText(liveComposer)) === '';
      inputCleared ||= clearedNow;
      clearedPolls = clearedNow ? clearedPolls + 1 : 0;
      try {
        latestSnapshot = await inspect({ signal });
        const found = findNewUserMessage(
          latestSnapshot.messages,
          prompt,
          baselineKeys,
          baselineCount,
        );
        if (found) return { confirmed: true, inputCleared,
          message: found.message, match: found.match, snapshot: latestSnapshot };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
      }
      // Clearing the composer happens BEFORE the user bubble mounts on some
      // Gemini builds. Never abort confirmation after just two empty polls:
      // continue observing, but do not treat clearing as an acknowledgement.
      await delay(600, signal);
    }
    return {
      confirmed: false,
      inputCleared,
      message: null,
      snapshot: latestSnapshot,
      lastError,
      reason: inputCleared ? 'composer-cleared-unconfirmed' : 'no-user-message',
    };
  }

  async function performSend(options) {
    const signal = options.signal;
    throwIfAborted(signal);
    const prompt = requestedText(options);
    if (!prompt) throw makeError('没有要发送的内容。', 'empty-prompt');
    if (isGenerating()) throw makeError('Gemini 正在回答，请等待当前回答结束。', 'provider-busy');

    const currentConversationId = getConversationId();
    const currentConversationKey = currentConversationId
      ? `gemini:${currentConversationId}`
      : `gemini:new:${location.pathname}`;
    const providedBaseline = options.baseline;
    let baseline;
    if (providedBaseline
      && providedBaseline.conversationKey === currentConversationKey
      && Array.isArray(providedBaseline.messageIds)) {
      baseline = {
        conversationKey: providedBaseline.conversationKey,
        messages: providedBaseline.messageIds.map((id) => ({ id: String(id), role: '', text: '' })),
        messageKeys: Array.isArray(providedBaseline.messageKeys) ? providedBaseline.messageKeys : [],
        messageCount: Number(providedBaseline.messageCount) || providedBaseline.messageIds.length,
      };
    } else {
      try {
        baseline = await inspect({ signal });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        baseline = {
          conversationKey: `gemini:new:${location.pathname}`,
          messages: domMessages(),
        };
      }
    }
    if (providedBaseline?.generating || baseline.generating || isGenerating()) {
      throw makeError('Gemini 正在回答，请等待当前回答结束。', 'provider-busy');
    }
    const composer = findComposer();
    if (!composer) throw makeError('没有找到 Gemini 输入框。', 'composer-not-found');
    setComposerText(composer, prompt);
    let liveComposer = await waitForComposerMatch(composer, prompt, signal);
    if (!liveComposer) {
      // One retry using the other insertion path is safer than rejecting a
      // prompt that the user can already see in the box.
      const retry = composer.isConnected ? composer : findComposer();
      if (retry) setComposerText(retry, prompt);
      liveComposer = await waitForComposerMatch(retry || composer, prompt, signal);
    }
    if (!liveComposer) {
      const visible = composerText(composer);
      const hasText = globalThis.RoundtableDomText?.composerMatch?.(prompt, visible)
        || globalThis.RoundtableDomText?.composerMatch?.(prompt,
          globalThis.RoundtableDomText.read(composer, { markdown: false }));
      throw makeError(
        hasText
          ? 'Gemini 输入框已写入正文，但换行没有保留；本次未发送，请检查输入框。'
          : `内容未能完整写入 Gemini 输入框（已写入 ${visible.length} / 应为 ${prompt.length} 字）。`,
        hasText ? 'composer-format-failed' : 'composer-verify-failed',
      );
    }

    const sendButton = await waitForSendButton(liveComposer, signal);
    if (!sendButton) throw makeError('没有找到可用的 Gemini 发送按钮。', 'send-button-not-found');
    throwIfAborted(signal);
    try { sendButton.focus({ preventScroll: true }); } catch {}
    sendButton.click();

    const confirmation = await confirmUserMessage(prompt, baseline, liveComposer, signal);
    const chatId = getConversationId();
    const confirmed = confirmation.confirmed;
    const result = {
      sent: confirmed,
      submitted: true,
      submitMethod: 'button-click',
      confirmed,
      confirmation: confirmation.message ? 'user-message' : (confirmation.reason || 'send-unconfirmed'),
      matchType: confirmation.match || '',
      inputCleared: confirmation.inputCleared,
      prompt,
      promptHash: hashText(prompt),
      conversationId: chatId,
      conversationKey: chatId ? `gemini:${chatId}` : `gemini:new:${location.pathname}`,
      userMessageId: confirmation.message?.id || '',
      baselineMessageIds: baseline.messages.map((message) => message.id),
      baselineMessageKeys: baseline.messageKeys || baseline.messages.map(messageKey),
      baselineMessageCount: Number(baseline.messageCount) || baseline.messages.length,
      snapshot: confirmation.snapshot || null,
    };
    if (!confirmed) {
      result.reason = 'send-unconfirmed';
      result.error = confirmation.lastError?.message
        || '已点击一次发送，但未能确认提交；为避免重复，没有再次发送。';
    }
    return result;
  }

  async function send(options = {}) {
    const prompt = requestedText(options);
    const dedupeKey = String(
      options.operationId || options.idempotencyKey || options.requestId
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

  function findAnchorIndex(messages, source) {
    if (source.userMessageId) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].id === String(source.userMessageId)) return index;
      }
    }
    const prompt = normalizeText(source.prompt ?? source.text ?? '');
    const baselineCount = Number(source.baselineMessageCount) || 0;
    if (prompt) {
      for (let index = messages.length - 1; index >= baselineCount; index -= 1) {
        if (messages[index].role === 'user' && normalizeText(messages[index].text) === prompt) return index;
      }
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user' && normalizeText(messages[index].text) === prompt) return index;
      }
    }
    if (source.afterMessageId) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].id === String(source.afterMessageId)) return index;
      }
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return index;
    }
    return -1;
  }

  function assistantAfterAnchor(messages, anchorIndex, baselineKeys) {
    if (anchorIndex < 0) return null;
    let candidate = null;
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role === 'user') break;
      if (message.role === 'assistant'
        && normalizeText(message.text)
        && !baselineKeys.has(messageKey(message))) {
        candidate = message;
      }
    }
    return candidate;
  }

  function lastNewAssistant(messages, baselineKeys, source = {}) {
    const last = source.baselineLastMessage || source.baseline?.lastMessage || {};
    const baselineIndex = last.id
      ? messages.findIndex((message) => message.id === last.id) : -1;
    const baselineHashes = new Set([...baselineKeys].map((key) => key.split('|').slice(-2).join('|')));
    const sameContent = (message) => baselineHashes.has(`${message.role}|${hashText(message.text)}`);
    const hasOverlap = messages.some((message) => baselineKeys.has(messageKey(message)) || sameContent(message));
    if (!hasOverlap && baselineIndex < 0) return null;
    let newUserIndex = -1;
    for (let index = Math.max(0, baselineIndex + 1); index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role === 'user' && !baselineKeys.has(messageKey(message))
        && (baselineIndex >= 0 || !sameContent(message))) newUserIndex = index;
    }
    if (newUserIndex < 0) return null;
    for (let index = messages.length - 1; index > newUserIndex; index -= 1) {
      const message = messages[index];
      if (message.role === 'user') return null;
      if (message.role === 'assistant' && normalizeText(message.text)
        && !baselineKeys.has(messageKey(message))) return message;
    }
    return null;
  }

  function conversationRoot() {
    return document.querySelector('chat-window, .conversation-container, main') || document.body;
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
    const timeoutMs = Math.min(10 * 60 * 1000, Math.max(5000, Number(source.timeoutMs) || 6 * 60 * 1000));
    const pollMs = Math.min(3000, Math.max(150, Number(source.pollMs) || 350));
    const stablePolls = Math.min(4, Math.max(2, Number(source.stablePolls) || 2));
    const idleMs = Math.min(3000, Math.max(300, Number(source.stableMilliseconds) || 800));
    const baselineKeys = new Set((source.baselineMessageKeys || []).map(String));
    const expectedConversationId = String(source.conversationId || getConversationId() || '');
    const deadline = Date.now() + timeoutMs;
    const monitor = createActivityMonitor();
    let stableKey = '';
    let stableCount = 0;
    let lastError = null;
    let candidateSince = 0;
    let idleWithoutAnswerSince = 0;
    let sawGeneration = false;

    try {
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        const chatId = getConversationId();
        if (expectedConversationId && chatId && expectedConversationId !== chatId) {
          throw makeError('Gemini 页面已经切换到另一条对话，等待已停止。', 'conversation-changed');
        }

        if (isGenerating()) {
          sawGeneration = true;
          idleWithoutAnswerSince = 0;
          await monitor.next(signal, pollMs);
          continue;
        }

        let snapshot;
        try {
          snapshot = await inspect({ signal });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          lastError = error;
          await monitor.next(signal, pollMs);
          continue;
        }

        const anchorIndex = findAnchorIndex(snapshot.messages, source);
        const candidate = assistantAfterAnchor(snapshot.messages, anchorIndex, baselineKeys)
          || lastNewAssistant(snapshot.messages, baselineKeys, source);
        if (candidate) {
          const key = `${candidate.id}\n${hashText(candidate.text)}`;
          if (key === stableKey) stableCount += 1;
          else {
            stableKey = key;
            stableCount = 1;
            candidateSince = Date.now();
          }
          idleWithoutAnswerSince = 0;
          if (!snapshot.generating
            && stableCount >= stablePolls
            && Date.now() - candidateSince >= idleMs) {
            return {
              completed: true,
              conversationId: chatId,
              conversationKey: snapshot.conversationKey,
              userMessageId: snapshot.messages[anchorIndex]?.id || source.userMessageId || '',
              message: candidate,
              answer: candidate.text,
              snapshot: { ...snapshot, generating: false },
            };
          }
        } else {
          stableKey = '';
          stableCount = 0;
          if (!snapshot.generating) {
            if (!idleWithoutAnswerSince) idleWithoutAnswerSince = Date.now();
            if (Date.now() - idleWithoutAnswerSince > (sawGeneration ? 6500 : 18000)) {
              throw makeError('Gemini 已停止生成，但未能定位本轮新增回答；请检查目标对话。', 'answer-not-found');
            }
          }
        }
        await delay(pollMs, signal);
      }
    } finally {
      monitor.disconnect();
    }

    throw makeError(
      lastError ? `等待 Gemini 完整回答超时：${lastError.message}` : '等待 Gemini 完整回答超时。',
      'wait-timeout',
    );
  }

  const installed = globalThis.RoundtableContent?.install({
    id: 'gemini',
    matches,
    inspect,
    readMessage,
    send,
    wait,
  });
  if (installed) globalThis[ADAPTER_KEY] = true;
})();
