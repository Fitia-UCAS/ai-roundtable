(function installChatGptRoundtableAdapter() {
  'use strict';

  const ADAPTER_KEY = '__AI_ROUNDTABLE_CHATGPT_ADAPTER__';

  const recentSends = new Map();
  const RECENT_SEND_TTL = 15 * 1000;
  const TOKEN_CACHE_TTL = 5 * 60 * 1000;
  const RATE_LIMIT_COOLDOWN = 30 * 1000;
  let sendInFlight = null;
  let tokenCache = { value: '', expiresAt: 0 };
  let apiBlockedUntil = 0;
  let lastDomRead = { strategy: 'unknown', truncated: false, diagnostics: {} };
  let domBindings = [];

  function matches(currentLocation) {
    return /(^|\.)chatgpt\.com$/i.test(currentLocation.hostname)
      || /(^|\.)chat\.openai\.com$/i.test(currentLocation.hostname);
  }

  function getConversationLocation() {
    const conversation = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
    if (conversation) return { id: conversation[1], shared: false };
    const shared = location.pathname.match(/^\/share\/([^/?#]+)/i);
    if (shared) return { id: shared[1], shared: true };
    return null;
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

  async function getAccessToken(signal) {
    throwIfAborted(signal);
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
    const response = await fetch('/api/auth/session', {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    if (response.status === 429) throw rateLimitError(response);
    if (!response.ok) return '';
    const session = await response.json();
    const token = session?.accessToken || '';
    tokenCache = token
      ? { value: token, expiresAt: Date.now() + TOKEN_CACHE_TTL }
      : { value: '', expiresAt: 0 };
    return token;
  }

  function rateLimitError(response) {
    const header = response.headers?.get('retry-after');
    const waitMs = Math.max(RATE_LIMIT_COOLDOWN,
      Number(header) > 0 ? Number(header) * 1000 : Date.parse(header) - Date.now() || 0);
    apiBlockedUntil = Date.now() + waitMs;
    return Object.assign(makeError(`ChatGPT 历史接口限流，请约 ${Math.ceil(waitMs / 1000)} 秒后再试。`, 'rate-limited'),
      { status: 429, retryAfterMs: waitMs });
  }

  async function fetchConversation(current, signal) {
    throwIfAborted(signal);
    if (Date.now() < apiBlockedUntil) {
      throw makeError('ChatGPT 历史接口仍在冷却，请稍后再试。', 'rate-limited');
    }
    const headers = {};
    if (!current.shared) {
      const token = await getAccessToken(signal);
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const endpoint = current.shared
      ? `/backend-api/share/${encodeURIComponent(current.id)}`
      : `/backend-api/conversation/${encodeURIComponent(current.id)}`;
    const request = () => fetch(endpoint, {
      credentials: 'include',
      cache: 'no-store',
      headers,
      signal,
    });
    let response = await request();
    if (response.status === 401 && !current.shared) {
      tokenCache = { value: '', expiresAt: 0 };
      const token = await getAccessToken(signal);
      if (token) {
        headers.authorization = `Bearer ${token}`;
        response = await request();
      }
    }
    if (response.status === 429) throw rateLimitError(response);
    if (!response.ok) throw new Error(`无法读取 ChatGPT 对话（${response.status}）。`);
    apiBlockedUntil = 0;
    const payload = await response.json();
    return payload?.mapping ? payload : payload?.data?.mapping ? payload.data : payload;
  }

  function activeNodes(conversation) {
    const mapping = conversation?.mapping || {};
    const ordered = [];
    const visited = new Set();
    let nodeId = conversation?.current_node;
    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      visited.add(nodeId);
      ordered.push({ nodeId, node: mapping[nodeId] });
      nodeId = mapping[nodeId].parent;
    }
    if (ordered.length) return ordered.reverse();
    return Object.entries(mapping)
      .map(([key, node]) => ({ nodeId: key, node }))
      .sort((left, right) => (
        (left.node?.message?.create_time || 0) - (right.node?.message?.create_time || 0)
      ));
  }

  function serializePart(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    const name = part.name || part.filename || part.title;
    if (part.content_type === 'image_asset_pointer' || part.asset_pointer) return name ? `[图片：${name}]` : '[图片]';
    return name ? `[附件：${name}]` : '';
  }

  function serializeMessage(message) {
    const content = message?.content || {};
    let text = '';
    if (typeof content.text === 'string') text = content.text;
    else if (Array.isArray(content.parts)) text = content.parts.map(serializePart).filter(Boolean).join('\n\n');
    return text.replace(/\r\n?/g, '\n').trim();
  }

  function parseMessages(conversation) {
    return activeNodes(conversation)
      .map(({ nodeId, node }) => {
        const message = node?.message;
        const role = message?.author?.role;
        const metadata = message?.metadata || {};
        if ((role !== 'user' && role !== 'assistant')
          || metadata.is_visually_hidden_from_conversation
          || metadata.is_user_system_message
          || (role === 'assistant' && ((message.channel && message.channel !== 'final')
            || (message.recipient && message.recipient !== 'all')))) return null;
        const text = serializeMessage(message);
        if (!text) return null;
        return {
          id: String(message.id || nodeId || ''),
          role,
          text,
          timestamp: Number(message.create_time || 0) * 1000 || null,
          complete: !message.status || message.status === 'finished_successfully',
        };
      })
      .filter(Boolean);
  }

  const DOM_TURN_SELECTOR = 'article, [data-testid^="conversation-turn-"], section[data-turn-id], [data-message-author-role], [data-message-role]';
  const DOM_FALLBACK_SELECTOR = [
    '[data-user-message-bubble]',
    '[data-user-message-copy]',
    '[data-assistant-markdown]',
    '[data-assistant-markdown-root]',
    '.markdown',
    '.prose',
    '.whitespace-pre-wrap',
  ].join(', ');

  function turnOrder(element) {
    const testId = String(element?.getAttribute?.('data-testid') || '');
    const match = testId.match(/^conversation-turn-(\d+)/);
    if (match) return Number(match[1]);
    const turnId = element?.getAttribute?.('data-turn-id');
    if (turnId && /^\d+$/.test(turnId)) return Number(turnId);
    return Number.POSITIVE_INFINITY;
  }

  function collectDomRoots() {
    const roots = [document];
    const seen = new Set([document]);
    const queue = [document];
    while (queue.length && roots.length < 16) {
      const root = queue.shift();
      let elements = [];
      try {
        elements = [...root.querySelectorAll('*')];
      } catch {
        continue;
      }
      for (const element of elements) {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          roots.push(element.shadowRoot);
          queue.push(element.shadowRoot);
        }
        if (element.tagName === 'IFRAME') {
          try {
            const frameDocument = element.contentDocument;
            if (frameDocument && !seen.has(frameDocument)) {
              seen.add(frameDocument);
              roots.push(frameDocument);
              queue.push(frameDocument);
            }
          } catch {}
        }
      }
    }
    return roots;
  }

  function sortDomTurns(nodes) {
    const all = nodes.filter((element) => !element.matches('[data-conversation-recovery]'));
    const outermost = all.filter((element) => (
      !all.some((other) => other !== element && other.contains(element))
    ));
    return outermost.sort((left, right) => {
      const leftOrder = turnOrder(left);
      const rightOrder = turnOrder(right);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function turnsInRoot(root) {
    let nodes = [...root.querySelectorAll(DOM_TURN_SELECTOR)];
    if (!nodes.length) nodes = [...root.querySelectorAll('[data-message-id]')];
    return sortDomTurns(nodes);
  }

  function collectDomTurns() {
    const top = turnsInRoot(document);
    if (top.length) return top;
    for (const root of collectDomRoots().slice(1)) {
      const turns = turnsInRoot(root);
      if (turns.length) return turns;
    }
    return [];
  }

  function readDomContent(element, role = 'assistant') {
    return globalThis.RoundtableDomText.message(element, role, { exclude:
      '.control-panel, [data-input-selector-group], [data-input-selector-variable], '
      + '[role="slider"], [data-message-attribution], [data-testid*="citation-pill"]' });
  }

  function roleElementsFor(container) {
    if (!container) return [];
    if (container.matches?.('[data-message-author-role], [data-message-role]')) return [container];
    return [...(container.querySelectorAll?.('[data-message-author-role], [data-message-role]') || [])];
  }

  function contentElementFor(container, roleElement, role) {
    if (!container) return null;
    if (role === 'user') {
      return container.querySelector?.('[data-user-message-bubble], [data-user-message-copy]')
        || roleElement;
    }
    for (const selector of [
      '[data-assistant-markdown]',
      '[data-assistant-markdown-root]',
      '.markdown',
      '.prose',
      '.whitespace-pre-wrap',
    ]) {
      const found = container.querySelector?.(selector);
      if (found) return found;
    }
    return roleElement || (container.matches?.('article') ? container : null);
  }

  function extractDomTurn(container, index) {
    if (!container) return null;
    const roleElements = roleElementsFor(container);
    const firstRoleElement = roleElements[0]
      || (container.matches?.('[data-message-author-role], [data-message-role]') ? container : null);
    const roleValue = firstRoleElement?.getAttribute?.('data-message-author-role')
      || firstRoleElement?.getAttribute?.('data-message-role')
      || '';
    const isUserBubble = container.matches?.('[data-user-message-bubble], [data-user-message-copy]');
    let role = isUserBubble ? 'user' : roleValue === 'user' ? 'user' : roleValue ? 'assistant' : '';

    const contentElements = [];
    for (const roleElement of (roleElements.length ? roleElements : [firstRoleElement])) {
      const content = contentElementFor(container, roleElement, role);
      if (content) contentElements.push(content);
    }
    if (!contentElements.length) contentElements.push(container);
    const outermost = contentElements.filter((element) => (
      !contentElements.some((other) => other !== element && other.contains(element))
    ));

    const parts = outermost.map((element) => readDomContent(element, role || 'assistant'));
    const text = parts.map((part) => part.text).filter(Boolean).join('\n\n');
    const contentAliases = parts.length === 1 ? parts[0].contentAliases : [];
    const renderedHash = parts.length === 1 ? parts[0].renderedHash : '';
    const renderedCompactHash = parts.length === 1 ? parts[0].renderedCompactHash : '';
    if (!text) return null;
    if (!role) role = /^(You said|You)\b/i.test(text) ? 'user' : 'assistant';

    const idElement = container.closest?.('[data-message-id]')
      || container.querySelector?.('[data-message-id]');
    const id = idElement?.getAttribute?.('data-message-id')
      || container.getAttribute?.('id')
      || container.getAttribute?.('data-testid')
      || `dom-${role}-${hashText(`${role}\n${text}`)}`;
    const message = { id, role, text, contentAliases, renderedHash, renderedCompactHash };
    domBindings.push({ container, message });
    return message;
  }

  function dedupeDomMessages(messages) {
    const seen = new Set();
    return messages.filter((message) => {
      if (!message?.text) return false;
      const key = message.id
        ? `id:${message.id}`
        : `${message.role}:${hashText(message.text)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractMessagesFromRoot(root) {
    let nodes = turnsInRoot(root);
    if (!nodes.length) {
      nodes = sortDomTurns([...root.querySelectorAll(DOM_FALLBACK_SELECTOR)]);
    }
    return dedupeDomMessages(nodes
      .map((turn, index) => extractDomTurn(turn, index))
      .filter(Boolean));
  }

  function findLabeledWrapper(label) {
    let node = label?.parentElement || null;
    for (let depth = 0; depth < 14 && node && node !== document.body; depth += 1) {
      if (node.classList?.contains('group')) return node;
      node = node.parentElement;
    }
    return label?.parentElement || null;
  }

  function parseLabeledMessages(root = document) {
    const labels = [...root.querySelectorAll('h4')].filter((label) => (
      /^(你说|You said|ChatGPT\s*说|ChatGPT said)[：:]/i.test(
        normalizeText(label.textContent || ''),
      )
    ));
    const seen = new Set();
    const messages = [];
    labels.forEach((label) => {
      const wrapper = findLabeledWrapper(label);
      if (!wrapper) return;
      const labelText = normalizeText(label.textContent || '');
      const role = label.dataset?.conversationRole === 'user'
        || /^(你说|You said)/i.test(labelText) ? 'user' : 'assistant';
      const content = globalThis.RoundtableChatGptReader.readMessage(wrapper, role);
      const text = content.text;
      if (!text) return;
      const key = `${role}:${hashText(text)}`;
      if (seen.has(key)) return;
      seen.add(key);
      messages.push({
        id: `labeled-${role}-${hashText(text)}`,
        role,
        ...content,
      });
    });
    return messages;
  }

  function parseTextMessages() {
    const main = document.querySelector('main') || document.body;
    const raw = main?.innerText || '';
    if (!raw) return [];

    // Relay bodies contain literal "用户:" headings. Only native ChatGPT
    // speaker labels delimit turns; transport labels are ordinary body text.
    const labelPattern = /^(你说|You said|ChatGPT\s*说|ChatGPT said)[：:]\s*(.*)$/i;
    const uiPattern = /^(正在加载更早的消息…?|跳转到内容|分享|复制|编辑|朗读|重新生成|Stop|Copy|Edit|Read aloud|Regenerate|Share|Like|Dislike|ChatGPT 可能会出错.*|Can make mistakes.*)$/i;
    const messages = [];
    let current = null;
    const finish = () => {
      if (!current) return;
      const text = normalizeText(current.lines.join('\n'));
      if (text) {
        messages.push({
          id: `dom-text-${current.role}-${hashText(text)}`,
          role: current.role,
          text,
        });
      }
      current = null;
    };

    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        if (current) current.lines.push('');
        continue;
      }
      const label = line.match(labelPattern);
      if (label) {
        finish();
        const role = /^(你说|You said|用户|User)$/i.test(label[1]) ? 'user' : 'assistant';
        current = { role, lines: [label[2] || ''] };
        continue;
      }
      if (uiPattern.test(line)) continue;
      if (current) current.lines.push(line);
    }
    finish();
    return messages;
  }

  function parseDomMessages() {
    domBindings = [];
    const project = globalThis.RoundtableChatGptReader?.read(document);
    if (project?.messages?.length) {
      lastDomRead = project;
      return project.messages;
    }
    lastDomRead = {
      strategy: 'chatgpt-legacy-dom',
      truncated: Boolean(project?.truncated),
      diagnostics: project?.diagnostics || {},
    };
    let labeledMessages = parseLabeledMessages(document);
    if (labeledMessages.some((message) => message.role === 'user')
      && labeledMessages.some((message) => message.role === 'assistant')) {
      return labeledMessages;
    }

    if (!labeledMessages.length) {
      for (const root of collectDomRoots().slice(1)) {
        labeledMessages = parseLabeledMessages(root);
        if (labeledMessages.some((message) => message.role === 'user')
          && labeledMessages.some((message) => message.role === 'assistant')) {
          return labeledMessages;
        }
      }
    }

    const topMessages = extractMessagesFromRoot(document);
    if (topMessages.some((message) => message.role === 'user')
      && topMessages.some((message) => message.role === 'assistant')) {
      return topMessages;
    }

    const groups = [];
    if (topMessages.length) groups.push(topMessages);
    for (const root of collectDomRoots().slice(1)) {
      const messages = extractMessagesFromRoot(root);
      if (messages.length) groups.push(messages);
    }
    if (!groups.length) return parseTextMessages();

    const score = (messages) => {
      const roles = new Set(messages.map((message) => message.role));
      return (roles.has('user') && roles.has('assistant') ? 1000 : 0) + messages.length;
    };
    groups.sort((left, right) => score(right) - score(left));
    const best = groups[0];
    const bestRoles = new Set(best.map((message) => message.role));
    if (bestRoles.has('user') && bestRoles.has('assistant')) return best;

    const textMessages = parseTextMessages();
    if (textMessages.some((message) => message.role === 'user')
      && textMessages.some((message) => message.role === 'assistant')) {
      return textMessages;
    }

    const users = dedupeDomMessages(groups.flatMap((group) => (
      group.filter((message) => message.role === 'user')
    )));
    const assistants = dedupeDomMessages(groups.flatMap((group) => (
      group.filter((message) => message.role === 'assistant')
    )));
    if (!users.length || !assistants.length) {
      return textMessages.length > best.length ? textMessages : best;
    }

    const merged = [];
    const total = Math.max(users.length, assistants.length);
    for (let index = 0; index < total; index += 1) {
      if (users[index]) merged.push(users[index]);
      if (assistants[index]) merged.push(assistants[index]);
    }
    return dedupeDomMessages(merged);
  }

  function conversationScrollRoot() {
    let node = document.querySelector('main');
    while (node) {
      if (node.scrollHeight > node.clientHeight + 80) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  async function parseDomMessagesDeep(signal) {
    const root = conversationScrollRoot();
    const mounted = parseDomMessages();
    if (!root) return mounted;
    const initialTurns = collectDomTurns();

    const originalTop = root.scrollTop;
    const originalBehavior = root.style?.scrollBehavior || '';
    const seen = new Map();
    const add = (message) => {
      if (!message?.text) return;
      const key = message.id
        ? `id:${message.id}`
        : `${message.role}:${hashText(message.text)}`;
      if (!seen.has(key)) seen.set(key, message);
    };
    const collectMounted = () => {
      parseDomMessages().forEach(add);
    };

    try {
      if (root.style) root.style.scrollBehavior = 'auto';
      root.scrollTop = 0;
      await delay(160, signal);
      collectMounted();

      const turns = [...new Set([...initialTurns, ...collectDomTurns()])].slice(0, 500);
      for (let index = 0; index < turns.length; index += 1) {
        throwIfAborted(signal);
        const turn = turns[index];
        try {
          turn.scrollIntoView({ block: 'center' });
        } catch {}
        let message = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await delay(160, signal);
          collectMounted();
          message = extractDomTurn(turn, index);
          if (message?.text) break;
        }
        add(message);
      }
      collectMounted();
    } finally {
      if (root.style) root.style.scrollBehavior = originalBehavior;
      root.scrollTop = originalTop;
    }
    return [...seen.values()];
  }

  function isGenerating() {
    const selectors = [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止"]',
      'button[title*="Stop" i]',
      'button[title*="停止"]',
    ];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible));
  }

  async function readDomMessages(signal, timeoutMs = 800) {
    const deadline = Date.now() + timeoutMs;
    let messages = parseDomMessages();
    while (!messages.length && Date.now() < deadline) {
      await delay(120, signal);
      messages = parseDomMessages();
    }
    return messages;
  }

  const relayHistory = globalThis.RoundtableRelayHistory.create({
    readDom: parseDomMessages,
    getKey: () => getConversationLocation()?.id || '',
    isGenerating,
    readHistory: async (signal) => {
      const current = getConversationLocation();
      const conversation = await fetchConversation(current, signal);
      if (!conversation?.mapping?.[conversation.current_node]
        || (conversation.conversation_id && conversation.conversation_id !== current.id)) {
        throw makeError('无法确认 ChatGPT 当前对话分支。', 'SOURCE_HISTORY_UNAVAILABLE');
      }
      return { title: String(conversation.title || document.title), messages: parseMessages(conversation) };
    },
  });

  async function inspect(options = {}) {
    throwIfAborted(options.signal);
    const current = getConversationLocation();
    let title = document.title.replace(/\s*[|\-–—]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT 对话';
    let messages = await readDomMessages(options.signal, current ? 800 : 0);
    let source = 'dom';

    if (options.deep) {
      const deepMessages = await parseDomMessagesDeep(options.signal);
      if (deepMessages.length >= messages.length && deepMessages.length) {
        messages = deepMessages;
        source = 'dom-deep';
      }
    }

    if (current && (options.relayRead || options.relayRecheckId)) {
      const captured = await relayHistory.read(options, messages);
      return { ...captured, provider: 'chatgpt', providerName: 'ChatGPT',
        conversationKey: `chatgpt:${current.id}`, url: location.href, generating: false,
        source: captured.source || 'api', strategy: captured.strategy || 'api', truncated: false };
    }

    if (!messages.length) {
      messages = await readDomMessages(options.signal, current ? 800 : 0);
      if (messages.length) source = 'dom';
    }

    if (!messages.length) {
      const diagnostics = {
        turns: collectDomTurns().length,
        roleNodes: document.querySelectorAll('[data-message-author-role], [data-message-role]').length,
        articles: document.querySelectorAll('article').length,
        messageIds: document.querySelectorAll('[data-message-id]').length,
        userBubbles: document.querySelectorAll('[data-user-message-bubble], [data-user-message-copy]').length,
        markdown: document.querySelectorAll('.markdown').length,
        main: document.querySelectorAll('main').length,
        iframes: document.querySelectorAll('iframe').length,
        shadowRoots: [...document.querySelectorAll('*')].filter((element) => element.shadowRoot).length,
        roots: collectDomRoots().length,
        mainText: document.querySelector('main')?.innerText?.trim().length || 0,
      };
      // An empty new chat is a normal, connected page; only an existing
      // conversation without mounted messages is an actual read failure.
      if (!current) {
        return {
          provider: 'chatgpt',
          providerName: 'ChatGPT',
          conversationKey: `chatgpt:new:${location.pathname}`,
          conversationId: '',
          title,
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
      throw makeError(`ChatGPT 页面内容未读取（${summary}），请刷新页面后重试。`, 'dom-empty');
    }

    return {
      provider: 'chatgpt',
      providerName: 'ChatGPT',
      conversationKey: current ? `chatgpt:${current.id}` : `chatgpt:new:${location.pathname}`,
      title,
      url: location.href,
      messages,
      generating: isGenerating(),
      source,
      strategy: source === 'dom' ? lastDomRead.strategy : source,
      truncated: Boolean(lastDomRead.truncated && source !== 'api'),
      diagnostics: lastDomRead.diagnostics || {},
    };
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return element.getClientRects().length > 0;
  }

  function composerText(composer) {
    if ('value' in composer) return String(composer.value || '');
    return String(composer.innerText || composer.textContent || '');
  }

  function composerContentMatches(composer, expected) {
    if (globalThis.RoundtableDomText?.composerMatch) {
      const text = composerText(composer);
      return globalThis.RoundtableDomText.composerMatch(expected, text)
        && globalThis.RoundtableDomText.lineBreaksPreserved(expected, text);
    }
    const comparable = (value) => normalizeText(value).replace(/\s+/g, ' ');
    return comparable(composerText(composer)) === comparable(expected);
  }

  function findComposer() {
    const selectors = [
      '#prompt-textarea',
      'form[data-chatgpt-composer] .ProseMirror[contenteditable="true"]',
      'form .ProseMirror[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-virtualkeyboard]',
      'form [contenteditable="true"][role="textbox"]',
      'form textarea:not([disabled]):not([readonly])',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element) && !element.disabled && !element.readOnly) return element;
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
    composer.dispatchEvent(new Event('change', { bubbles: true }));
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
      // Chromium turns insertText newlines into nested divs, which duplicate
      // empty lines when the editor reads innerText. Insert escaped text and
      // explicit breaks so Markdown and code whitespace survive unchanged.
      if (text.includes('\n')) {
        const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        inserted = document.execCommand('insertHTML', false, html);
      } else {
        inserted = document.execCommand('insertText', false, text);
      }
    } catch {}
    if (!inserted) {
      composer.replaceChildren();
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (index) composer.append(document.createElement('br'));
        composer.append(document.createTextNode(line));
      });
    }
    dispatchComposerInput(composer, text);
  }

  function buttonEnabled(button) {
    return isVisible(button)
      && !button.disabled
      && button.getAttribute('aria-disabled') !== 'true';
  }

  function accessibleName(element) {
    return [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.textContent,
    ].filter(Boolean).join(' ').trim();
  }

  function findSendButton(composer) {
    const composerForm = composer.closest('form');
    const roots = [composerForm, composer.parentElement, document].filter(Boolean);
    const selectors = [
      'button[data-testid="fruitjuice-send-button"]',
      'button[data-testid="composer-submit-btn"]',
      'button[data-testid="composer-submit-button"]',
      '[data-testid="send-button"]',
      '#composer-submit-btn',
      '#composer-submit-button',
      'button.composer-submit-btn',
      'form[data-chatgpt-composer] button[aria-label="Send"]',
      'button[data-testid*="composer-send" i]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[aria-label*="发送"]',
    ];
    for (const root of roots) {
      for (const selector of selectors) {
        const button = [...root.querySelectorAll(selector)].find(buttonEnabled);
        if (button) return button;
      }
      if (root === composerForm) {
        const submit = [...root.querySelectorAll('button[type="submit"]')].find(buttonEnabled);
        if (submit) return submit;
      }
      const labelled = [...root.querySelectorAll('button:not([disabled])')].find((button) => (
        buttonEnabled(button)
        && /发送|send(?: prompt| message)?/i.test(accessibleName(button))
        && !/停止|stop/i.test(accessibleName(button))
      ));
      if (labelled) return labelled;
    }
    return null;
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

  function submitComposer(composer, sendButton) {
    // ChatGPT currently wires the composer action to the visible button. A
    // bare form.requestSubmit() can fire a submit event without the button's
    // React handler, leaving the prompt visible while the extension waits.
    // Activate the confirmed-enabled button exactly once and never fall back
    // to a second submission attempt, which could duplicate a delayed send.
    try { sendButton.focus({ preventScroll: true }); } catch {}
    sendButton.click();
    return 'button-click';
  }

  function requestedText(options) {
    return globalThis.RoundtableDomText.body(
      options.text ?? options.prompt ?? options.content ?? options.message
      ?? options.request?.text ?? options.request?.prompt ?? '',
    );
  }

  function findFreshUser(snapshot, prompt, baselineIds) {
    return [...(snapshot?.messages || [])].reverse().find((message) => (
      message.role === 'user'
      && !baselineIds.has(String(message.id || ''))
      && normalizeText(message.text) === normalizeText(prompt)
    )) || null;
  }

  async function confirmSubmission(prompt, baselineIds, composer, signal, timeoutMs = 12 * 1000) {
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = null;
    let sawComposerClear = false;
    let lastError = null;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        const snapshot = await inspect({ signal });
        lastSnapshot = snapshot;
        const message = findFreshUser(snapshot, prompt, baselineIds);
        if (message) return { confirmed: true, reason: 'user-message', message, snapshot };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
      }

      const activeComposer = findComposer();
      if ((activeComposer && !normalizeText(composerText(activeComposer)))
        || (!composer.isConnected && !activeComposer)) {
        sawComposerClear = true;
        return {
          confirmed: false,
          reason: 'composer-cleared',
          message: null,
          snapshot: lastSnapshot,
          lastError,
        };
      }
      await delay(450, signal);
    }
    return {
      confirmed: sawComposerClear,
      reason: sawComposerClear ? 'composer-cleared' : 'send-unconfirmed',
      message: null,
      snapshot: lastSnapshot,
      lastError,
    };
  }

  async function performSend(options) {
    const signal = options.signal;
    throwIfAborted(signal);
    const prompt = requestedText(options);
    if (!prompt) throw makeError('没有要发送的内容。', 'empty-prompt');
    if (isGenerating()) throw makeError('ChatGPT 正在回答，请等待当前回答结束。', 'provider-busy');

    const currentConversation = getConversationLocation();
    const currentConversationKey = currentConversation
      ? `chatgpt:${currentConversation.id}`
      : `chatgpt:new:${location.pathname}`;
    const providedBaseline = options.baseline;
    let baseline = null;
    let baselineIds;
    let baselineKeys = [];
    if (providedBaseline
      && providedBaseline.conversationKey === currentConversationKey
      && Array.isArray(providedBaseline.messageIds)) {
      baseline = { conversationKey: providedBaseline.conversationKey, messages: [], generating: false };
      baselineIds = new Set(providedBaseline.messageIds.map(String).filter(Boolean));
      baselineKeys = Array.isArray(providedBaseline.messageKeys) ? providedBaseline.messageKeys : [];
    } else {
      try {
        baseline = await inspect({ signal });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'cancelled') throw error;
        baseline = { messages: parseDomMessages(), conversationKey: '', generating: isGenerating() };
      }
      baselineIds = new Set((baseline.messages || [])
        .map((message) => String(message.id || ''))
        .filter(Boolean));
      baselineKeys = (baseline.messages || []).map((message) =>
        `${message.id || ''}|${message.role}|${hashText(message.text)}`);
    }
    if (providedBaseline?.generating || baseline.generating || isGenerating()) {
      throw makeError('ChatGPT 正在回答，请等待当前回答结束。', 'provider-busy');
    }

    const composer = findComposer();
    if (!composer) throw makeError('没有找到 ChatGPT 输入框。', 'composer-not-found');
    setComposerText(composer, prompt);
    await delay(150, signal);
    if (!composerContentMatches(composer, prompt)) {
      const wordsIntact = globalThis.RoundtableDomText?.composerMatch?.(
        prompt, composerText(composer));
      throw makeError(wordsIntact
        ? 'ChatGPT 输入框已写入正文，但换行或空行没有保留；本次未发送，请检查输入框。'
        : '内容未能完整写入 ChatGPT 输入框。',
      wordsIntact ? 'composer-format-failed' : 'composer-verify-failed');
    }

    const sendButton = await waitForSendButton(composer, signal);
    if (!sendButton) throw makeError('ChatGPT 发送按钮当前不可用。', 'send-button-unavailable');
    const submitMethod = submitComposer(composer, sendButton);

    const confirmation = await confirmSubmission(prompt, baselineIds, composer, signal);
    const current = getConversationLocation();
    const snapshot = confirmation.snapshot;
    const conversationKey = snapshot?.conversationKey
      || (current ? `chatgpt:${current.id}` : baseline.conversationKey || `chatgpt:new:${location.pathname}`);
    const result = {
      sent: confirmation.confirmed,
      submitted: true,
      confirmed: confirmation.confirmed,
      confirmation: confirmation.reason,
      prompt,
      promptHash: hashText(prompt),
      submitMethod,
      conversationId: current?.id || '',
      conversationKey,
      userMessageId: confirmation.message?.id || '',
      insertedMessage: confirmation.message || null,
      baselineMessageIds: [...baselineIds],
      baselineMessageKeys: baselineKeys,
      baselineMessageCount: providedBaseline?.messageCount ?? (baseline.messages || []).length,
      snapshot: snapshot || null,
    };
    if (!confirmation.confirmed) {
      result.reason = 'send-unconfirmed';
      result.error = confirmation.lastError?.message
        || '已点击一次发送，但未能确认提交；为避免重复，没有再次发送。';
    }
    return result;
  }

  async function send(options = {}) {
    const prompt = requestedText(options);
    const current = getConversationLocation();
    const dedupeKey = String(
      options.operationId || options.idempotencyKey || options.requestId
      || `${current?.id || location.pathname}:${hashText(prompt)}`,
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
    const insertedId = options.insertedMessage?.id;
    const expectedId = options.userMessageId || insertedId;
    if (expectedId) {
      const index = messages.findIndex((message) => String(message.id) === String(expectedId));
      if (index >= 0) return index;
    }
    const prompt = normalizeText(options.prompt ?? options.text ?? options.insertedMessage?.text ?? '');
    if (prompt) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user' && normalizeText(messages[index].text) === prompt) return index;
      }
    }
    const afterMessageId = options.afterMessageId || options.baseline?.lastMessage?.id
      || options.baselineLastMessage?.id;
    if (afterMessageId) {
      const baselineIndex = messages.findIndex((message) => String(message.id) === String(afterMessageId));
      if (baselineIndex >= 0) {
        for (let index = baselineIndex + 1; index < messages.length; index += 1) {
          if (messages[index].role === 'user') return index;
        }
        return -1;
      }
    }
    // Without an exact prompt or a visible baseline, the last mounted user can be historical.
    // Only use a distinctly new user outside the pre-dispatch baseline.
    const baselineIds = new Set((options.baselineMessageIds || []).map(String));
    const baselineKeys = new Set((options.baselineMessageKeys || []).map(String));
    if (!baselineIds.size && !baselineKeys.size) return -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if (baselineIds.has(String(message.id || ''))) continue;
      if (baselineKeys.has(`${message.id || ''}|${message.role}|${hashText(message.text)}`)) continue;
      return index;
    }
    return -1;
  }

  function assistantAfterAnchor(messages, anchorIndex, baselineIds, baselineKeys = new Set()) {
    if (anchorIndex < 0) return null;
    let candidate = null;
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role === 'user') break;
      const key = `${message.id || ''}|${message.role}|${hashText(message.text)}`;
      if (message.role === 'assistant' && normalizeText(message.text)
        && !baselineIds.has(String(message.id || '')) && !baselineKeys.has(key)) candidate = message;
    }
    return candidate;
  }

  function lastNewAssistant(messages, baselineIds, baselineKeys = new Set(), baselineLastMessage = null) {
    // Only a demonstrably new assistant turn is a safe fallback when the sent prompt was reformatted.
    const baselineIndex = baselineLastMessage?.id
      ? messages.findIndex((message) => message.id === baselineLastMessage.id) : -1;
    const baselineHashes = new Set([...baselineKeys].map((key) => key.split('|').slice(-2).join('|')));
    const hasOverlap = messages.some((message) => baselineIds.has(String(message.id || ''))
      || baselineKeys.has(`${message.id || ''}|${message.role}|${hashText(message.text)}`)
      || baselineHashes.has(`${message.role}|${hashText(message.text)}`));
    if (!hasOverlap && baselineIndex < 0) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant' || !normalizeText(message.text)) continue;
      const key = `${message.id || ''}|${message.role}|${hashText(message.text)}`;
      if (baselineIndex >= 0 && index <= baselineIndex) continue;
      if (baselineIds.has(String(message.id || '')) || baselineKeys.has(key)) continue;
      // If the baseline entry moved or regenerated its id, identical content is not a new answer.
      if (baselineIndex < 0 && baselineHashes.has(`${message.role}|${hashText(message.text)}`)) continue;
      const userSinceBaseline = messages.slice(Math.max(0, baselineIndex + 1), index)
        .some((turn) => turn.role === 'user'
          && !baselineIds.has(String(turn.id || ''))
          && !baselineKeys.has(`${turn.id || ''}|${turn.role}|${hashText(turn.text)}`));
      if (baselineIndex >= 0 && !userSinceBaseline) continue;
      return message;
    }
    return null;
  }

  function conversationRoot() {
    return document.querySelector('main') || document.body;
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

  function promptMatchText(value) {
    return normalizeText(value)
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ''))
      .replace(/[*_`#>~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fallbackAnswerFromPage(prompt) {
    const main = document.querySelector('main');
    if (!main) return null;
    const pageText = normalizeText(main.innerText || '').replace(/\s+/g, ' ').trim();
    const normalizedPrompt = promptMatchText(prompt);
    if (!pageText || normalizedPrompt.length < 30) return null;

    let start = -1;
    for (const length of [240, 160, 100, 60]) {
      const needle = normalizedPrompt.slice(-length);
      if (needle.length < 20) continue;
      const index = pageText.lastIndexOf(needle);
      if (index >= 0) {
        start = index + needle.length;
        break;
      }
    }
    if (start < 0) return null;

    const answer = pageText
      .slice(start)
      .replace(/^(Copy|Edit|Read aloud|Regenerate|Share|Like|Dislike|Stop|复制|编辑|朗读|重新生成|分享|点赞|点踩|停止)\s*/i, '')
      .replace(/\s*(ChatGPT 可能会出错.*|Can make mistakes.*)$/i, '')
      .trim();
    if (answer.length < 20) return null;
    return {
      id: `dom-answer-${hashText(answer)}`,
      role: 'assistant',
      text: answer,
      complete: true,
    };
  }

  function fallbackWaitResult(source, message, snapshot = null) {
    return {
      completed: true,
      conversationId: getConversationLocation()?.id || source.conversationId || '',
      conversationKey: snapshot?.conversationKey
        || (getConversationLocation()?.id ? `chatgpt:${getConversationLocation().id}` : ''),
      userMessageId: source.userMessageId || '',
      message,
      answer: message.text,
      snapshot,
    };
  }

  async function wait(options = {}) {
    const source = waitSource(options);
    const signal = options.signal;
    const requestedTimeout = source.timeoutMs ?? source.maxWaitMs;
    const timeoutMs = Math.min(10 * 60 * 1000, Math.max(5000, Number(requestedTimeout) || 6 * 60 * 1000));
    const pollMs = Math.min(3000, Math.max(150, Number(source.pollMs) || 350));
    const stablePolls = Math.min(4, Math.max(2, Number(source.stablePolls) || 2));
    const idleMs = Math.min(3000, Math.max(300, Number(source.stableMilliseconds) || 800));
    const baselineIds = new Set((source.baselineMessageIds || []).map(String).filter(Boolean));
    const baselineKeys = new Set((source.baselineMessageKeys || []).map(String));
    const baselineLastMessage = source.baseline?.lastMessage || source.baselineLastMessage || null;
    const expectedConversationKey = String(source.conversationKey || source.expectedConversationKey || '');
    const enforceConversation = expectedConversationKey && !expectedConversationKey.startsWith('chatgpt:new:');
    const deadline = Date.now() + timeoutMs;
    const monitor = createActivityMonitor();
    let stableKey = '';
    let stableCount = 0;
    let lastError = null;
    let emptyReads = 0;
    let idleWithoutAnswerSince = 0;
    let sawGeneration = false;
    let candidateSince = 0;

    try {
      while (Date.now() < deadline) {
        throwIfAborted(signal);

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
          // The page-text fallback can concatenate the prompt with historical answers.
          // An unverified answer is worse than a clear inspection error.
          emptyReads = error?.code === 'dom-empty' ? emptyReads + 1 : 0;
          if (emptyReads >= 5 && !isGenerating()) {
            throw makeError(
              '无法读取 ChatGPT 页面上的回答，请刷新页面后重试。',
              'dom-empty',
            );
          }
          await monitor.next(signal, pollMs);
          continue;
        }
        if (enforceConversation && snapshot.conversationKey !== expectedConversationKey) {
          throw makeError('ChatGPT 页面已经切换到另一条对话，等待已停止。', 'conversation-changed');
        }

        const anchorIndex = findAnchorIndex(snapshot.messages, source);
        const candidate = assistantAfterAnchor(snapshot.messages, anchorIndex, baselineIds, baselineKeys)
          || lastNewAssistant(snapshot.messages, baselineIds, baselineKeys, baselineLastMessage);
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
              conversationId: getConversationLocation()?.id || source.conversationId || '',
              conversationKey: snapshot.conversationKey,
              userMessageId: snapshot.messages[anchorIndex]?.id || source.userMessageId || '',
              message: candidate,
              answer: candidate.text,
              snapshot,
            };
          }
        } else {
          stableKey = '';
          stableCount = 0;
          if (!snapshot.generating) {
            if (!idleWithoutAnswerSince) idleWithoutAnswerSince = Date.now();
            // A dispatched user message with no visible answer should not occupy the panel for five minutes.
            if (Date.now() - idleWithoutAnswerSince > (sawGeneration ? 6500 : 18000)) {
              throw makeError(
                snapshot.truncated
                  ? '目标页面只挂载了部分对话，未能定位新回答；请滚动到最新消息后重试。'
                  : 'ChatGPT 已停止生成，但没有找到本轮新增的完整回答；请检查目标对话。',
                'answer-not-found',
              );
            }
          }
        }
        // Poll the actual answer text. Other DOM mutations must not indefinitely postpone completion.
        await delay(pollMs, signal);
      }
    } finally {
      monitor.disconnect();
    }

    throw makeError(
      lastError
        ? `等待 ChatGPT 回答超时（页面读取失败）：${lastError.message}`
        : '等待 ChatGPT 回答超时（目标可能仍在生成，或新回答未挂载到页面）。',
      'wait-timeout',
    );
  }

  const installed = globalThis.RoundtableContent?.install({
    id: 'chatgpt',
    matches,
    inspect,
    readMessage: (node) => globalThis.RoundtableChatGptReader.readMessage(node),
    messageForElement: (node) => {
      const project = globalThis.RoundtableChatGptReader.messageForElement(node);
      if (project) return project;
      const matches = domBindings.filter(({ container, message }) => message.role === 'assistant'
        && (node === container || node?.contains(container) || container.contains(node)));
      const unique = new Map(matches.map(({ message }) => [`${message.id}:${hashText(message.text)}`, message]));
      return unique.size === 1 ? [...unique.values()][0] : null;
    },
    send,
    wait,
  });
  if (installed) globalThis[ADAPTER_KEY] = true;
})();
