(function installRoundtableBookmarkPicker() {
  'use strict';

  const existing = globalThis.__roundtableBookmarkPicker;
  if (existing) {
    existing.refresh?.();
    return;
  }
  const bookmarkModel = globalThis.RoundtableBookmarkModel;
  if (!bookmarkModel) return;

  // A repaired content-script context may inherit DOM left by the previous
  // context. Remove those inert mounts before claiming the native rows again.
  document.querySelectorAll('[data-roundtable-bookmark-choice]')
    .forEach((element) => element.remove());
  document.querySelectorAll('[data-roundtable-bookmark-actions]')
    .forEach((element) => delete element.dataset.roundtableBookmarkActions);

  // These are the same native action rows used by AI Exporter 4.6.0. Mounting
  // directly into them is more durable than finding a message by its text and
  // then guessing which nearby row belongs to it.
  const siteId = /(^|\.)chatgpt\.com$/i.test(location.hostname)
    || /(^|\.)chat\.openai\.com$/i.test(location.hostname)
    ? 'chatgpt'
    : /(^|\.)gemini\.google\.com$/i.test(location.hostname)
      ? 'gemini'
      : /(^|\.)chat\.deepseek\.com$/i.test(location.hostname)
        ? 'deepseek'
        : '';
  const observedSelectors = {
    chatgpt: ['.turn-action-controls', '[data-testid*="copy-turn-action-button"]'],
    gemini: ['message-actions div[class*="buttons-container"]'],
    deepseek: ['._965abe9'],
  }[siteId] || [];
  const controlProfile = {
    chatgpt: { size: 32, iconSize: 18, strokeWidth: 1.9, opacity: .9, radius: '50%' },
    gemini: { size: 32, iconSize: 17, strokeWidth: 1.8, opacity: .8, radius: '50%' },
    deepseek: { size: 32, iconSize: 18, strokeWidth: 1.9, opacity: .9, radius: '50%' },
  }[siteId] || { size: 32, iconSize: 18, strokeWidth: 1.9, opacity: .9, radius: '50%' };
  const controls = new Map();
  let currentSnapshot = null;
  let currentBookmarks = {};
  let selectedCursor = null;
  let refreshTimer = 0;
  let refreshTask = null;
  let refreshAgain = false;
  let selectionSaving = false;
  let selectionError = null;
  let selectionNotice = null;

  globalThis.__roundtableBookmarkPicker = {
    refresh() { scheduleRefresh(0); },
    selectionIssue() {
      if (selectionSaving) return '书签正在保存，请稍后再发送。';
      return selectionError?.url === location.href ? selectionError.message : '';
    },
  };

  function showSelectionIssue(message) {
    selectionError = { url: location.href, message };
    selectionNotice?.remove();
    selectionNotice = document.createElement('div');
    selectionNotice.dataset.roundtableBookmarkNotice = 'true';
    selectionNotice.setAttribute('role', 'status');
    selectionNotice.style.cssText = 'position:fixed;right:20px;bottom:110px;max-width:360px;padding:12px 16px;border-radius:10px;background:#fff;color:#b42318;box-shadow:0 2px 18px #0003;z-index:2147483647;font:14px/1.6 sans-serif;';
    selectionNotice.textContent = `书签未设置：${message}`;
    document.body.append(selectionNotice);
  }

  function normalize(value) {
    return String(value || '').normalize('NFKC')
      .replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ').trim();
  }

  function normalizeCore(value) {
    return String(value ?? '').normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\t\u00A0\u3000 ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function hashText(value) {
    const text = normalizeCore(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function hashMessage(message) {
    return hashText(`${message.role || ''}\n${message.text || ''}`);
  }

  function unique(nodes) {
    return [...new Set(nodes.filter((node) => node?.isConnected))];
  }

  function chatGptTurn(host, maximumDepth = 30) {
    let node = host;
    for (let depth = 0; node && depth < maximumDepth; depth += 1, node = node.parentElement) {
      const className = String(node.getAttribute?.('class') || '');
      const role = String(node.getAttribute?.('data-message-author-role')
        || node.getAttribute?.('data-message-role') || node.getAttribute?.('data-turn') || '');
      if (className.includes('user-message') || role === 'user') return null;
      if (node.hasAttribute?.('data-turn-key') || role === 'assistant'
        || node.matches?.('article[data-testid^="conversation-turn-"]')) return node;
    }
    return null;
  }

  function actionHosts() {
    if (siteId === 'chatgpt') {
      const modern = [...document.querySelectorAll('[data-turn-key] .turn-action-controls')]
        .filter((host) => chatGptTurn(host));
      if (modern.length) return unique(modern);
      const legacyButtons = [...document.querySelectorAll(
        'article [data-testid*="copy-turn-action-button"], '
        + '[data-turn="assistant"] [data-testid*="copy-turn-action-button"]',
      )];
      return unique(legacyButtons.map((button) => button.parentElement)
        .filter((host) => host && chatGptTurn(host, 10)));
    }
    if (siteId === 'gemini') {
      return unique([...document.querySelectorAll(
        'message-actions div[class*="buttons-container"]',
      )]);
    }
    if (siteId === 'deepseek') {
      return unique([...document.querySelectorAll('._965abe9')]);
    }
    return [];
  }

  function messageNodeForHost(host) {
    if (siteId === 'chatgpt') {
      const turn = chatGptTurn(host);
      if (!turn) return null;
      // A project turn can contain both the user's question and several
      // assistant branches. The action row belongs to the nearest preceding
      // assistant answer, not to the whole data-turn-key container.
      const labels = [...turn.querySelectorAll('h4')].filter((heading) =>
        /^(?:ChatGPT\s*说|ChatGPT\s+said)\s*[：:]?\s*$/i.test(
          normalize(heading.textContent))
        && (heading.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING));
      const heading = labels.at(-1);
      if (!heading) return turn;
      let answer = heading.parentElement;
      while (answer?.parentElement && answer.parentElement !== turn) {
        const speakerLabels = [...answer.parentElement.querySelectorAll('h4')]
          .filter((label) => /^(?:你说|ChatGPT\s*说|You\s+said|ChatGPT\s+said)\s*[：:]?\s*$/i
            .test(normalize(label.textContent)));
        if (speakerLabels.length !== 1) break;
        answer = answer.parentElement;
      }
      return answer || turn;
    }
    if (siteId === 'gemini') {
      return host.closest('model-response, [data-test-id="model-response"]');
    }
    if (siteId === 'deepseek') {
      const item = host.closest('[data-virtual-list-item-key]');
      return item?.querySelector('.ds-assistant-message-main-content, .ds-markdown')
        || host.closest('.ds-message')?.querySelector('.ds-assistant-message-main-content, .ds-markdown')
        || null;
    }
    return null;
  }

  function cleanMessageText(node) {
    return normalize(globalThis.RoundtableContent?.currentAdapter?.()?.readMessage?.(node)?.text || '');
  }

  function candidateIds(host, node) {
    const ids = new Set();
    for (const element of [node, host, node?.closest?.('[data-message-id], [data-turn-id], [data-turn-key]')]) {
      if (!element) continue;
      for (const name of ['data-message-id', 'data-turn-id', 'data-turn-key', 'id']) {
        const value = String(element.getAttribute?.(name) || '');
        if (value) ids.add(value);
      }
    }
    if (siteId === 'deepseek') {
      const key = host.closest('[data-virtual-list-item-key]')
        ?.getAttribute('data-virtual-list-item-key');
      if (key) ids.add(`deepseek-item:${key}:a`);
    }
    return ids;
  }

  function matchAssistantItem(items, used, ids, text) {
    if (!text) return null;
    const exact = items.filter((candidate) => !used.has(candidate) && normalize(candidate.text) === text);
    const byId = exact.filter((candidate) => ids.has(String(candidate.id || '')));
    if (byId.length === 1) return byId[0];
    return exact.length === 1 ? exact[0] : null;
  }

  function rowsForSnapshot(snapshot) {
    const items = (snapshot?.messages || []).filter((message) => message?.role === 'assistant');
    const used = new Set();
    const rows = [];
    for (const host of actionHosts()) {
      // Only an assistant turn owns a bookmark. A native row that resolves to no
      // answer (for example DeepSeek's user row) must never get a control.
      const node = messageNodeForHost(host);
      if (!node) continue;
      // The first pass only mounts the control. Extracting answer text is
      // expensive, so it runs once message inspection has produced items.
      const bound = globalThis.RoundtableContent?.currentAdapter?.()?.messageForElement?.(node);
      const boundItems = bound ? items.filter((candidate) => !used.has(candidate)
        && candidate.id === bound.id && hashMessage(candidate) === hashMessage(bound)) : [];
      const item = boundItems.length === 1 ? boundItems[0] : items.length
        ? matchAssistantItem(items, used, candidateIds(host, node), cleanMessageText(node)) : null;
      if (item) used.add(item);
      rows.push({ host, node, item });
    }
    return rows;
  }

  function locateCursorIndex(items, cursor) {
    return globalThis.RoundtableCore.findCursorIndex(items, cursor).index;
  }

  function currentAnchor() {
    return bookmarkModel.resolveAnchor(
      currentSnapshot?.messages,
      selectedCursor,
      locateCursorIndex,
      (item) => item?.role === 'assistant',
    );
  }

  function setControlState(control, state) {
    const selected = state === 'pending' || state === 'synced';
    control.state = state;
    control.mount.dataset.bookmarkState = state;
    control.button.setAttribute('aria-pressed', String(selected));
    control.button.setAttribute('aria-label', state === 'pending'
      ? '当前接力起点，再次点击取消'
      : state === 'synced' ? '已同步到这里，再次点击取消' : '从这条消息开始接力');
    control.button.style.background = 'transparent';
    control.button.style.color = state === 'pending' ? control.selectedColor : control.baseColor;
    control.button.style.opacity = state === 'pending'
      ? '1' : state === 'synced' ? '.34' : String(controlProfile.opacity);
    control.button.style.transform = '';
    control.bookmark.setAttribute('fill', selected ? 'currentColor' : 'none');
    control.bookmark.setAttribute('stroke-width', selected
      ? String(Math.max(controlProfile.strokeWidth, 1.9))
      : String(controlProfile.strokeWidth));
  }

  function applySelection() {
    const anchor = currentAnchor();
    for (const control of controls.values()) {
      const index = currentSnapshot?.messages?.indexOf(control.row?.item) ?? -1;
      setControlState(control, anchor?.index === index ? anchor.state : 'idle');
    }
  }

  function createControl(row) {
    const host = row.host;
    if (!host || host.dataset.roundtableBookmarkActions === 'true') return null;
    const peer = host.querySelector('button:not([data-roundtable-bookmark-choice]), svg');
    const peerColor = peer ? getComputedStyle(peer).color : '';
    const baseColor = peerColor && peerColor !== 'rgba(0, 0, 0, 0)' ? peerColor : '#8b9099';
    const selectedColor = getComputedStyle(row.node).color || '#171717';
    host.dataset.roundtableBookmarkActions = 'true';

    const mount = document.createElement('span');
    mount.dataset.roundtableBookmarkChoice = 'true';
    mount.style.cssText = `display:inline-flex;width:${controlProfile.size}px;height:${controlProfile.size}px;flex:0 0 ${controlProfile.size}px;position:relative;overflow:visible;vertical-align:middle;color:inherit;z-index:1;`;
    const shadow = mount.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{display:inline-flex;overflow:visible!important;position:relative;z-index:1}button{all:unset;box-sizing:border-box;display:inline-grid;width:${controlProfile.size}px;height:${controlProfile.size}px;place-items:center;border-radius:${controlProfile.radius};color:inherit;cursor:pointer;transition:background .12s,opacity .12s,transform .12s}button:hover{background:rgba(128,128,128,.14)}button:focus-visible{outline:2px solid currentColor;outline-offset:1px}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.style.color = baseColor;
    button.style.opacity = String(controlProfile.opacity);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(controlProfile.iconSize));
    svg.setAttribute('height', String(controlProfile.iconSize));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.pointerEvents = 'none';
    const bookmark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bookmark.setAttribute('d', 'M6.5 4.5h11v15.75L12 16.7l-5.5 3.55z');
    bookmark.setAttribute('fill', 'none');
    bookmark.setAttribute('stroke', 'currentColor');
    bookmark.setAttribute('stroke-width', String(controlProfile.strokeWidth));
    bookmark.setAttribute('stroke-linecap', 'round');
    bookmark.setAttribute('stroke-linejoin', 'round');
    svg.append(bookmark);
    button.append(svg);
    shadow.append(style, button);

    const control = {
      row, mount, host, button, bookmark, baseColor, selectedColor, state: 'idle',
    };
    button.addEventListener('pointerenter', () => {
      if (control.saving) return;
      button.style.opacity = '1';
    });
    button.addEventListener('pointerleave', () => {
      if (control.saving) return;
      setControlState(control, control.state);
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void saveSelection(control);
    });
    host.prepend(mount);
    return control;
  }

  function sendRuntime(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          resolve(error ? { ok: false, error: { message: error.message } } : response);
        });
      } catch (error) {
        resolve({ ok: false, error: { message: String(error?.message || error) } });
      }
    });
  }

  async function saveSelection(initialControl) {
    let control = initialControl;
    if (selectionSaving) return;
    selectionSaving = true;
    control.button.setAttribute('aria-busy', 'true');
    try {
      if (!control.row?.item) {
        await refreshNow();
        control = controls.get(control.host) || control;
      }
      const clickedIndex = currentSnapshot?.messages?.indexOf(control.row?.item) ?? -1;
      if (clickedIndex < 0) {
        showSelectionIssue('无法把这个按钮对应到完整回答，请等待正文加载后再点击。当前不会按最近一轮发送。');
        control.button.setAttribute('aria-label', '消息仍在加载，请稍后再试');
        return;
      }
      const clearing = currentAnchor()?.index === clickedIndex;
      const conversationKey = currentSnapshot?.conversationKey || '';
      const response = await sendRuntime({
        type: 'RT_BOOKMARK_SET',
        conversationKey,
        ...(clearing ? { clear: true } : {
          messageId: control.row.item.id,
          messageHash: hashMessage(control.row.item),
        }),
      });
      if (!response?.ok) {
        applySelection();
        showSelectionIssue(String(response?.error?.message || '保存失败，请重新选择起点。'));
        control.button.setAttribute('aria-label', String(response?.error?.message || '书签未保存'));
        return;
      }
      if (currentSnapshot?.conversationKey === conversationKey) {
        const confirmed = clearing ? null : response.bookmark || response.state?.bookmarks?.[conversationKey] || null;
        if (!clearing && !confirmed) {
          showSelectionIssue('后台未确认保存，请重新选择起点。');
          return;
        }
        selectedCursor = confirmed;
        selectionError = null;
        selectionNotice?.remove();
        selectionNotice = null;
        currentBookmarks[conversationKey] = selectedCursor;
        applySelection();
      }
    } finally {
      selectionSaving = false;
      initialControl.button.removeAttribute('aria-busy');
      control.button.removeAttribute('aria-busy');
    }
  }

  function render(snapshot, bookmark) {
    if (Array.isArray(snapshot?.messages)) {
      currentSnapshot = snapshot;
      selectedCursor = bookmark || null;
    }
    const rows = rowsForSnapshot(snapshot);
    const liveHosts = new Set(rows.map((row) => row.host));
    for (const [host, control] of controls) {
      if (!host.isConnected || !liveHosts.has(host) || !control.mount.isConnected) {
        control.mount.remove();
        if (control.host?.dataset.roundtableBookmarkActions) {
          delete control.host.dataset.roundtableBookmarkActions;
        }
        controls.delete(host);
      }
    }
    for (const row of rows) {
      const existingControl = controls.get(row.host);
      if (existingControl) existingControl.row = row;
      else {
        const control = createControl(row);
        if (control) controls.set(row.host, control);
      }
    }
    applySelection();
    return rows.length;
  }

  function readBookmarks() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['roundtableBookmarks'], (stored) => {
          if (chrome.runtime.lastError) resolve({});
          else resolve(stored?.roundtableBookmarks || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function refreshNow() {
    if (refreshTask) {
      refreshAgain = true;
      // A click during the initial storage read must await that same refresh,
      // rather than treating its still-unbound row as a failed selection.
      return refreshTask;
    }
    refreshTask = refreshSnapshot().finally(() => {
      refreshTask = null;
      if (refreshAgain) {
        refreshAgain = false;
        scheduleRefresh(120);
      }
    });
    return refreshTask;
  }

  async function refreshSnapshot() {
    try {
      if (!chrome?.runtime?.id) return;
      if (selectionError && selectionError.url !== location.href) {
        selectionError = null;
        selectionNotice?.remove();
        selectionNotice = null;
      }
      // Match AI Exporter's behavior: make the inline control appear as soon as
      // the native action row exists. Message inspection only enriches it with
      // the durable bookmark identity afterwards.
      render(null, null);
      const adapter = globalThis.RoundtableContent?.currentAdapter?.();
      if (!adapter?.inspect) return;
      const [snapshot, bookmarks] = await Promise.all([
        Promise.resolve(adapter.inspect({})),
        readBookmarks(),
      ]);
      currentBookmarks = bookmarks;
      render(snapshot, bookmarks?.[snapshot?.conversationKey] || null);
    } catch {
      // SPA transitions can briefly expose stale message data. Keep the native
      // row control mounted; the observer will retry identity resolution.
      render(null, null);
    }
  }

  function scheduleRefresh(delay = 220) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshNow(), delay);
  }

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.roundtableBookmarks) return;
    currentBookmarks = changes.roundtableBookmarks.newValue || {};
    selectedCursor = currentBookmarks?.[currentSnapshot?.conversationKey] || null;
    applySelection();
    scheduleRefresh(80);
  });

  function isRelevantAddedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node;
    return observedSelectors.some((selector) => (
      element.matches?.(selector) || element.querySelector?.(selector)
    ));
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => [...mutation.addedNodes].some(isRelevantAddedNode))) {
      scheduleRefresh(80);
    }
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
  scheduleRefresh(0);
})();
