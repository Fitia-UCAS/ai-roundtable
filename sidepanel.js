(() => {
  'use strict';

  const PROVIDERS = {
    chatgpt: { name: 'ChatGPT', icon: 'icons/chatgpt.png' },
    gemini: { name: 'Gemini', icon: 'icons/gemini.png' },
    deepseek: { name: 'DeepSeek', icon: 'icons/deepseek.png' },
  };
  const PROVIDER_ORDER = Object.keys(PROVIDERS);
  const TARGET_PREFERENCES_KEY = 'aiRoundtableTargetPreferences';
  const TERMINAL_STATES = new Set([
    'COMPLETED', 'COMPLETE', 'DONE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED',
    'NO_CONTENT',
  ]);

  const elements = {
    meetingName: document.getElementById('meeting-name'),
    sessionSwitcher: document.getElementById('session-switcher'),
    sessionMenu: document.getElementById('session-menu'),
    sessionList: document.getElementById('session-list'),
    newSession: document.getElementById('new-session'),
    exportDiscussion: document.getElementById('export-discussion'),
    refreshConnection: document.getElementById('refresh-connection'),
    moreButton: document.getElementById('more-button'),
    moreMenu: document.getElementById('more-menu'),
    timeline: document.getElementById('timeline'),
    emptyState: document.getElementById('empty-state'),
    instruction: document.getElementById('instruction'),
    modelPicker: document.getElementById('model-picker'),
    sendButton: document.getElementById('send-button'),
    swapDirection: document.getElementById('swap-direction'),
    operationBar: document.getElementById('operation-bar'),
    operationText: document.getElementById('operation-text'),
    operationVerify: document.getElementById('operation-verify'),
    operationStop: document.getElementById('operation-stop'),
    noticeBar: document.getElementById('notice-bar'),
    noticeText: document.getElementById('notice-text'),
    noticeClose: document.getElementById('notice-close'),
  };

  let viewState = createEmptyState();
  let selectedProvider = '';
  let selectedForSourceProvider = '';
  let targetPreferences = {};
  let targetPreferencesLoaded = false;
  let targetPreferencesPromise = null;
  let locallyBusy = false;
  let reconnecting = false;
  let cancelling = false;
  let verifyingDelivery = false;
  let deleteConfirmId = '';
  let deleteConfirmTimer = 0;
  let bootstrapTimer = 0;
  let archiveState = { sessionId: '', transfers: [], history: [] };
  let archiveReadPromise = null;
  let archiveUpdateTimer = 0;
  let operationCheckTimer = 0;
  let operationCheckPending = false;
  const openDetails = new Set();
  const closedDetails = new Set();

  function createEmptyState() {
    return {
      tabs: [],
      sourceTabId: null,
      activeTabId: null,
      session: null,
      sessions: [],
      entries: [],
      activeOperation: null,
    };
  }

  function providerId(value) {
    const source = String(value || '').toLowerCase();
    return PROVIDER_ORDER.find((key) => source.includes(key)) || '';
  }

  function numericTabId(tab) {
    return Number(tab?.tabId ?? tab?.id ?? 0) || null;
  }

  function normalizeTab(tab) {
    const provider = providerId(tab?.provider || tab?.adapterId || tab?.providerName || tab?.url);
    return {
      ...tab,
      tabId: numericTabId(tab),
      provider,
      title: tab?.title || `${PROVIDERS[provider]?.name || 'AI'} 对话`,
      connected: tab?.connected !== false && tab?.online !== false,
      generating: Boolean(tab?.generating || tab?.busy),
    };
  }

  function normalizeSessions(raw, activeSession) {
    const source = raw?.sessions || raw?.sessionHistory || raw?.savedSessions || viewState.sessions || [];
    const sessions = (Array.isArray(source) ? source : Object.values(source || {}))
      .filter(Boolean)
      .map((session) => ({
        ...session,
        id: String(session.id || session.sessionId || ''),
        title: String(session.title || session.name || '新讨论'),
      }))
      .filter((session) => session.id);
    const activeId = String(activeSession?.id || activeSession?.sessionId || '');
    if (activeId && !sessions.some((session) => session.id === activeId)) {
      sessions.unshift({ ...activeSession, id: activeId, title: activeSession.title || activeSession.name || '新讨论' });
    }
    return sessions;
  }

  function normalizeState(payload) {
    const embedded = payload?.state;
    const raw = embedded && typeof embedded === 'object'
      ? embedded
      : payload?.data?.state && typeof payload.data.state === 'object'
        ? payload.data.state
        : payload?.data && typeof payload.data === 'object'
          ? payload.data
          : payload && typeof payload === 'object' ? payload : {};
    const session = raw.session || raw.activeSession || viewState.session;
    const entries = raw.timeline || raw.entries || raw.discussionEntries
      || session?.entries || viewState.entries || [];
    const tabs = (raw.tabs || raw.supportedTabs || viewState.tabs || [])
      .map(normalizeTab)
      .filter((tab) => tab.provider && tab.tabId);
    const activeOperation = Object.prototype.hasOwnProperty.call(raw, 'activeOperation')
      ? raw.activeOperation
      : Object.prototype.hasOwnProperty.call(raw, 'operation')
        ? raw.operation
        : viewState.activeOperation;
    return {
      ...viewState,
      ...raw,
      tabs,
      session,
      sessions: normalizeSessions(raw, session),
      entries: Array.isArray(entries) ? entries : Object.values(entries || {}),
      sourceTabId: Number(raw.sourceTabId ?? raw.activeSourceTabId ?? viewState.sourceTabId) || null,
      activeTabId: Number(raw.activeTabId ?? viewState.activeTabId) || null,
      activeOperation,
    };
  }

  function send(type, payload = {}, timeout = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false,
        error: '等待后台响应超时，正在核对接力状态。', timedOut: true }), timeout);
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) finish({ ok: false, error: error.message });
        else finish(response || { ok: true });
      });
    });
  }

  function providerMeta(provider) {
    return PROVIDERS[provider] || { name: provider || 'AI', icon: 'icons/icon48.png' };
  }

  function activeSessionId() {
    return String(viewState.session?.id || viewState.session?.sessionId || '');
  }

  function sessionTitle(session) {
    const title = String(session?.title || session?.name || '新讨论').trim();
    return /^(?:AI\s*)?(?:接力|圆桌|ROUND\s*TABLE)$/i.test(title) ? '新讨论' : title;
  }

  function sourceTab() {
    const chosen = viewState.tabs.find((tab) => tab.tabId === viewState.sourceTabId);
    // No implicit fallback while the selected conversation is loading.
    if (chosen) return chosen.connected ? chosen : null;
    const active = viewState.tabs.find((tab) => tab.tabId === viewState.activeTabId);
    if (active) return active.connected ? active : null;
    return viewState.tabs.find((tab) => tab.connected) || null;
  }

  function cleanTargetPreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([source, target]) => PROVIDERS[source] && PROVIDERS[target]));
  }

  function loadTargetPreferences() {
    if (targetPreferencesLoaded) return Promise.resolve(targetPreferences);
    if (targetPreferencesPromise) return targetPreferencesPromise;
    const storage = chrome.storage?.local;
    if (!storage?.get) {
      targetPreferencesLoaded = true;
      return Promise.resolve(targetPreferences);
    }
    targetPreferencesPromise = new Promise((resolve) => {
      const finish = () => {
        targetPreferencesLoaded = true;
        targetPreferencesPromise = null;
        resolve(targetPreferences);
      };
      try {
        storage.get(TARGET_PREFERENCES_KEY, (result) => {
          if (!chrome.runtime?.lastError) {
            targetPreferences = cleanTargetPreferences(result?.[TARGET_PREFERENCES_KEY]);
          }
          finish();
        });
      } catch {
        finish();
      }
    });
    return targetPreferencesPromise;
  }

  function rememberTargetPreference(sourceProvider, targetProvider) {
    if (!PROVIDERS[sourceProvider] || !PROVIDERS[targetProvider]) return;
    targetPreferences = { ...targetPreferences, [sourceProvider]: targetProvider };
    const storage = chrome.storage?.local;
    if (!storage?.set) return;
    try {
      storage.set({ [TARGET_PREFERENCES_KEY]: targetPreferences }, () => {
        void chrome.runtime?.lastError;
      });
    } catch {
      // The in-memory preference still applies when storage is unavailable.
    }
  }

  function targetTab(provider = selectedProvider) {
    const source = sourceTab();
    const candidates = viewState.tabs.filter((tab) => (
      tab.provider === provider
      && tab.connected
      && tab.tabId !== source?.tabId
    ));
    return candidates.find((tab) => tab.tabId === viewState.activeTabId) || candidates[0] || null;
  }

  function ensureSelectedProvider() {
    const source = sourceTab();
    const sourceProvider = source?.provider || '';
    if (sourceProvider !== selectedForSourceProvider) {
      selectedForSourceProvider = sourceProvider;
      selectedProvider = targetPreferences[sourceProvider] || '';
    }
    if (selectedProvider) return;
    selectedProvider = PROVIDER_ORDER.find((provider) => targetTab(provider))
      || PROVIDER_ORDER.find((provider) => provider !== sourceProvider)
      || PROVIDER_ORDER[0];
  }

  function operationState(operation = viewState.activeOperation) {
    return String(operation?.state || operation?.status || '').toUpperCase();
  }

  function operationBusy() {
    if (locallyBusy || cancelling) return true;
    return Boolean(viewState.activeOperation && !TERMINAL_STATES.has(operationState()));
  }

  async function checkOperation() {
    if (!viewState.activeOperation || TERMINAL_STATES.has(operationState())
      || cancelling || operationCheckPending) return;
    operationCheckPending = true;
    try {
      const kind = ['WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operationState())
        ? 'RT_OPERATION_CHECK' : 'RT_RELAY_STATUS';
      const response = await send(kind, {}, 8000);
      if (response?.state) {
        viewState = normalizeState(response);
        render();
      }
    } finally {
      operationCheckPending = false;
    }
  }

  function stopOperationCheck() {
    if (!operationCheckTimer) return;
    clearInterval(operationCheckTimer);
    operationCheckTimer = 0;
  }

  function startOperationCheck() {
    if (operationCheckTimer) return;
    operationCheckTimer = setInterval(checkOperation, 3000);
  }

  function operationLabel() {
    if (cancelling) return '正在停止…';
    if (locallyBusy && !viewState.activeOperation) return '正在发送…';
    const operation = viewState.activeOperation;
    if (!operation || TERMINAL_STATES.has(operationState(operation))) return '';
    const target = providerMeta(providerId(
      operation?.target?.conversation?.provider
      || operation?.target?.provider
      || operation?.target?.adapterId
    )).name;
    const state = operationState(operation);
    if (['CAPTURING', 'READING', 'PREPARED'].includes(state)) return '正在读取当前对话…';
    if (['DISPATCHED', 'SENDING'].includes(state)) return `正在发送给 ${target}…`;
    if (state === 'WAITING') return operation?.target?.generating
      ? `已发送，等待 ${target} 确认（目标仍在生成）`
      : `已发送，等待 ${target} 确认…`;
    if (state === 'UNCERTAIN') return '发送结果不确定，请检查目标页面后强制结束';
    if (state === 'SUSPENDED') return '目标页面暂不可用，可强制结束当前接力';
    return `${target} 正在确认接收…`;
  }

  function resizeComposer() {
    elements.instruction.style.height = 'auto';
    elements.instruction.style.height = `${Math.min(elements.instruction.scrollHeight, 150)}px`;
  }

  // One-off feedback is shown in a dedicated strip above the composer. It stays
  // until the user closes it or a new relay starts, so a message can never look
  // like a relay record that appears and then vanishes from the list.
  function flash(tone, text) {
    elements.noticeBar.hidden = false;
    elements.noticeBar.dataset.tone = tone;
    elements.noticeText.textContent = text;
  }

  function dismissNotice() {
    elements.noticeBar.hidden = true;
    elements.noticeText.textContent = '';
  }

  function renderOperation() {
    const busy = operationBusy();
    if (viewState.activeOperation && !TERMINAL_STATES.has(operationState())) startOperationCheck();
    else stopOperationCheck();
    elements.sendButton.classList.toggle('is-busy', busy);
    elements.sendButton.setAttribute('aria-label', busy ? '停止接力' : '发送');
    elements.sendButton.title = busy ? '停止' : '发送';
    elements.refreshConnection.disabled = (busy && !deliveryCanReconnect()) || reconnecting;
    elements.newSession.disabled = busy || reconnecting;
    elements.refreshConnection.classList.toggle('is-refreshing', reconnecting);
    if (busy) {
      elements.operationBar.hidden = false;
      elements.operationBar.dataset.tone = 'busy';
      elements.operationText.textContent = operationLabel();
      elements.operationStop.hidden = false;
      elements.operationStop.disabled = cancelling;
      const targetProvider = viewState.activeOperation?.target?.conversation?.provider;
      elements.operationVerify.hidden = targetProvider !== 'gemini'
        || !['WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operationState());
      elements.operationVerify.disabled = cancelling || verifyingDelivery;
    } else {
      elements.operationBar.hidden = true;
      elements.operationStop.hidden = true;
      elements.operationVerify.hidden = true;
    }
  }

  function renderModelPicker() {
    ensureSelectedProvider();
    elements.modelPicker.querySelectorAll('.model-button').forEach((button) => {
      const provider = button.dataset.provider;
      const selected = provider === selectedProvider;
      button.setAttribute('aria-checked', String(selected));
      button.classList.remove('is-unavailable');
      button.title = providerMeta(provider).name;
    });
  }

  async function loadArchive(refresh = false) {
    if (archiveReadPromise) return archiveReadPromise;
    const sessionId = activeSessionId();
    if (!sessionId) return;
    archiveReadPromise = (async () => {
      const response = await send(refresh ? 'RT_ARCHIVE_REFRESH' : 'RT_ARCHIVE_READ', {}, refresh ? 25000 : 14000);
      if (response?.ok && response.archive && sessionId === activeSessionId()) {
        archiveState = { ...response.archive, sessionId };
        renderTimeline();
      }
    })();
    try { await archiveReadPromise; } finally { archiveReadPromise = null; }
  }

  function scheduleArchiveUpdate(refresh = false) {
    clearTimeout(archiveUpdateTimer);
    archiveUpdateTimer = setTimeout(() => { void loadArchive(refresh); }, 160);
  }

  async function exportCurrentDiscussion() {
    await loadArchive(true);
    const settings = await send('RT_SETTINGS_GET');
    const prefs = settings?.preferences || {};
    const base = `AI-ROUND-TABLE-${(sessionTitle(viewState.session) || 'discussion').replace(/[\\/:*?"<>|]/g, '_')}`;
    const exportDocument = globalThis.RoundtableExport.buildExportDocument({
      session: { ...viewState.session, title: sessionTitle(viewState.session) },
      archive: archiveState,
      timeline: viewState.entries,
      bookmarks: viewState.bookmarks,
      tabs: viewState.tabs,
      exportedAt: Date.now(),
      includeTime: prefs.includeTime !== false,
      includeLinks: prefs.includeLinks !== false,
    });
    const body = prefs.exportFormat === 'json'
      ? globalThis.RoundtableExport.formatJson(exportDocument)
      : globalThis.RoundtableExport.formatMarkdown(exportDocument);
    // Download from the background so the same conversation overwrites its own
    // file instead of piling up "(1)", "(2)" copies.
    const response = await send('RT_EXPORT_FILE', {
      filename: base + (prefs.exportFormat === 'json' ? '.json' : '.md'),
      text: body,
      mime: prefs.exportFormat === 'json'
        ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8',
    }, 30000);
    if (response?.ok === false) {
      flash('error', response.error?.message || '导出失败');
      return;
    }
    flash('success', '已导出当前讨论');
  }

  function entryValue(entry, paths) {
    for (const path of paths) {
      let value = entry;
      for (const key of path.split('.')) value = value?.[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
  }

  function normalizeEntry(entry) {
    const sourceProvider = providerId(entryValue(entry, ['source.provider', 'source.adapterId', 'sourceProvider', 'from']));
    const targetProvider = providerId(entryValue(entry, ['target.provider', 'target.adapterId', 'targetProvider', 'to']));
    const rawAnswer = entryValue(entry, ['answer.text', 'answerText', 'response.text', 'response', 'result.text', 'result']);
    const rawError = entryValue(entry, ['error.message', 'error', 'failure.message']);
    return {
      ...entry,
      sourceProvider,
      targetProvider,
      sentText: String(entryValue(entry, ['sentText', 'payload.text', 'payload.prompt', 'prompt', 'text']) || ''),
      answerText: typeof rawAnswer === 'string' ? rawAnswer : '',
      errorText: typeof rawError === 'string' ? rawError : '',
      targetTabId: Number(entryValue(entry, ['target.tabId', 'targetTabId'])) || null,
      targetConversationKey: String(entryValue(entry, ['target.conversationKey', 'targetConversationKey']) || ''),
      targetUrl: String(entryValue(entry, ['target.url', 'targetUrl']) || ''),
      createdAt: Number(entryValue(entry, ['createdAt', 'timestamp', 'updatedAt'])) || Date.now(),
      status: String(entry?.status || '').toUpperCase(),
    };
  }

  function timelineEntry(rawEntry) {
    const entry = normalizeEntry(rawEntry);
    const node = document.getElementById('timeline-template').content.firstElementChild.cloneNode(true);
    const archived = (archiveState.transfers || []).find((transfer) => transfer.operationId === String(entry.id || entry.operationId || '')) || {};
    const sourceProvider = entry.sourceProvider || providerId(archived.sourceProvider);
    const targetProvider = entry.targetProvider || providerId(archived.provider);
    const systemError = /FAIL|ERROR|CANCEL|UNCERTAIN|SUSPEND/.test(entry.status);
    const sourceText = String(archived.sourceText || '');
    const targetAnswer = String(archived.answerText || '');
    const speakerProvider = sourceText ? sourceProvider : targetProvider;
    const speakerMeta = systemError
      ? { name: '接力', icon: 'icons/icon48.png' }
      : providerMeta(speakerProvider);
    const sourceName = sourceProvider ? providerMeta(sourceProvider).name : '来源';
    const targetName = targetProvider ? providerMeta(targetProvider).name : '目标';
    const entryKey = String(entry.id || entry.operationId || `${entry.createdAt}-${entry.targetTabId || 'entry'}`);

    const prompt = systemError ? `${sourceName} → ${targetName} · 接力未完成` : String(archived.userText || '');
    const answer = systemError
      ? String(entry.errorText || '本次接力未完成，未推进书签。')
      : sourceText || targetAnswer;
    const route = systemError ? `${sourceName} → ${targetName}`
      : speakerProvider === targetProvider ? `← ${sourceName}` : `→ ${targetName}`;
    node.dataset.entryId = entryKey;
    node.classList.toggle('is-system', systemError);
    node.dataset.targetTabId = entry.targetTabId || '';
    node.querySelector('.entry-avatar img').src = speakerMeta.icon;
    node.querySelector('.entry-avatar img').alt = speakerMeta.name;
    node.querySelector('.entry-model-name').textContent = speakerMeta.name;
    const routeElement = node.querySelector('.entry-route');
    routeElement.textContent = route;
    routeElement.hidden = systemError || !(sourceProvider && targetProvider);
    node.querySelector('.entry-summary').setAttribute('aria-label', `展开 ${speakerMeta.name} 接力记录`);
    const promptElement = node.querySelector('.entry-prompt');
    const answerElement = node.querySelector('.entry-answer');
    promptElement.textContent = prompt;
    answerElement.textContent = answer;
    promptElement.hidden = !prompt;
    answerElement.hidden = !answer;
    node.querySelector('.entry-unavailable').hidden = Boolean(prompt || answer);
    node.querySelector('.entry-note').hidden = true;
    node.querySelector('.entry-time').textContent = new Date(entry.createdAt).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    node.querySelector('[data-entry-action="open"]').hidden = systemError || (!entry.targetTabId && !entry.targetUrl);
    node.querySelector('[data-entry-action="copy"]').hidden = systemError || (!prompt && !answer);
    // Timeline cards retain the model header, instruction, response and folding state.
    node.open = openDetails.has(entryKey) || (!closedDetails.has(entryKey) && Boolean(prompt || answer));
    node.addEventListener('toggle', () => {
      if (node.open) { openDetails.add(entryKey); closedDetails.delete(entryKey); }
      else { openDetails.delete(entryKey); closedDetails.add(entryKey); }
    });
    node.__entry = entry;
    node.__copyText = [prompt, answer].filter(Boolean).join('\n\n');
    return node;
  }

  function renderTimeline() {
    const scrollPositions = new Map(
      [...elements.timeline.querySelectorAll('.relay-entry')].map((node) => [
        node.dataset.entryId, node.querySelector('.entry-content').scrollTop,
      ])
    );
    const focusedEntry = document.activeElement?.matches('.entry-content')
      ? document.activeElement.closest('.relay-entry').dataset.entryId : '';
    const wasNearBottom = elements.timeline.parentElement.scrollHeight
      - elements.timeline.parentElement.scrollTop
      - elements.timeline.parentElement.clientHeight < 90;
    const entries = (viewState.entries || []).filter((entry) => (
      /^(SENT|COMPLETED|COMPLETE|DONE|FAILED|ERROR|CANCELLED|CANCELED|UNCERTAIN|SUSPENDED)$/i.test(String(entry.status || ''))
    )).sort((a, b) => (
      Number(a.createdAt || a.timestamp || 0) - Number(b.createdAt || b.timestamp || 0)
    ));
    if (!entries.length) {
      elements.emptyState.hidden = false;
      elements.timeline.replaceChildren(elements.emptyState);
      return;
    }
    elements.emptyState.hidden = true;
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => fragment.append(timelineEntry(entry)));
    elements.timeline.replaceChildren(fragment);
    elements.timeline.querySelectorAll('.relay-entry').forEach((node) => {
      const content = node.querySelector('.entry-content');
      content.scrollTop = scrollPositions.get(node.dataset.entryId) || 0;
      if (node.open && node.dataset.entryId === focusedEntry) content.focus({ preventScroll: true });
    });
    if (wasNearBottom) requestAnimationFrame(() => {
      elements.timeline.parentElement.scrollTop = elements.timeline.parentElement.scrollHeight;
    });
  }

  function sessionTimestamp(session) {
    const value = Number(session.updatedAt || session.createdAt || 0);
    if (!value) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
  }

  function renderSessions() {
    const fragment = document.createDocumentFragment();
    const sessions = viewState.sessions || [];
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '暂无历史讨论';
      fragment.append(empty);
    } else {
      sessions.forEach((session) => {
        const row = document.getElementById('session-template').content.firstElementChild.cloneNode(true);
        row.dataset.sessionId = session.id;
        row.classList.toggle('is-active', session.id === activeSessionId());
        row.querySelector('.session-row-title').textContent = sessionTitle(session);
        row.querySelector('.session-row-meta').textContent = sessionTimestamp(session);
        const deleteButton = row.querySelector('.session-delete');
        const confirming = deleteConfirmId === session.id;
        deleteButton.classList.toggle('is-confirming', confirming);
        deleteButton.setAttribute('aria-label', confirming ? '再次点击确认删除' : '删除讨论');
        deleteButton.title = confirming ? '再次点击确认删除' : '删除讨论';
        fragment.append(row);
      });
    }
    elements.sessionList.replaceChildren(fragment);
  }

  function render() {
    elements.meetingName.textContent = sessionTitle(viewState.session);
    renderSessions();
    renderTimeline();
    renderModelPicker();
    renderOperation();
    const menuStop = elements.moreMenu.querySelector('[data-action="force-stop"]');
    if (menuStop) menuStop.hidden = !operationBusy();
  }

  async function bootstrap(force = false) {
    await loadTargetPreferences();
    const windowInfo = await chrome.windows.getCurrent();
    const response = await send('RT_BOOTSTRAP', { windowId: windowInfo.id, force }, 20000);
    if (response?.ok === false) {
      flash('error', response.error?.message || response.error || '连接失败');
      return;
    }
    viewState = normalizeState(response);
    locallyBusy = false;
    cancelling = false;
    if (archiveState.sessionId !== activeSessionId()) {
      archiveState = { sessionId: activeSessionId(), transfers: [], history: [] };
    }
    render();
    scheduleArchiveUpdate();
  }

  async function startRelay() {
    if (reconnecting) { flash('error', '请等待网页重新连接'); return; }
    if (operationBusy()) {
      await cancelRelay();
      return;
    }
    const source = sourceTab();
    if (!source) {
      flash('error', viewState.tabs.length
        ? '已找到 AI 标签页，但内容脚本未连接；请刷新对应网页并点击“重新检测网页”。'
        : '没有可用的来源 AI 标签页；请先打开 ChatGPT、Gemini 或 DeepSeek 对话。');
      return;
    }
    const target = targetTab();
    if (!target) {
      const opened = viewState.tabs.some((tab) => tab.provider === selectedProvider
        && tab.tabId !== source.tabId);
      flash('error', opened
        ? `${providerMeta(selectedProvider).name} 标签页已打开，但内容脚本未连接；请刷新该网页。`
        : `目标标签页未打开：请先打开 ${providerMeta(selectedProvider).name} 对话。`);
      return;
    }
    const instruction = elements.instruction.value.trim();
    dismissNotice();
    locallyBusy = true;
    renderOperation();
    const startedAt = Date.now();
    const response = await send('RT_RELAY_START', {
      sourceTabId: source.tabId,
      targetTabId: target.tabId,
      // Bind the click to the conversations visible in the side panel; a
      // delayed SPA navigation must not silently send an older reply.
      expectedSourceConversationKey: source.conversationKey || '',
      expectedTargetConversationKey: target.conversationKey || '',
      instruction,
    }, 120000);
    locallyBusy = false;
    if (response?.timedOut) {
      const status = await send('RT_RELAY_STATUS', {}, 10000);
      if (status?.state) {
        viewState = normalizeState(status);
        render();
        const active = viewState.activeOperation;
        const last = viewState.lastOperation;
        if (active && !TERMINAL_STATES.has(operationState(active))) return;
        if (last && Number(last.createdAt || 0) >= startedAt - 1000
          && Number(last.sourceTabId) === source.tabId
          && Number(last.targetTabId) === target.tabId) {
          if (operationState(last) === 'COMPLETED' && instruction) {
            elements.instruction.value = '';
            resizeComposer();
          }
          scheduleArchiveUpdate();
          return;
        }
      }
      flash('error', '接力结果尚未确认，请查看目标网页；确认前不要再次发送。');
      return;
    }
    if (response?.state) viewState = normalizeState(response);
    if (response?.ok === false || response?.accepted === false) {
      const message = response?.error?.message || response?.error || '发送失败';
      render();
      const last = (viewState.entries || []).findLast((entry) =>
        /^(FAILED|ERROR|UNCERTAIN|SUSPENDED)$/i.test(String(entry.status || ''))
        && (String(entry.error?.message || entry.error || '') === String(message)));
      if (!last) flash('error', message);
      if (/CONVERSATION_CHANGED|对话已经变化|对话发生变化|网页已经切换|对话在读取/.test(
        String(response?.error?.code || '') + ' ' + message)) {
        // Get fresh tab-to-conversation bindings before another click.
        void bootstrap(true);
      }
      return;
    }
    if (response?.operationState === 'NO_CONTENT') {
      flash('error', '当前没有可接力的新增内容');
    }
    if (instruction) {
      elements.instruction.value = '';
      resizeComposer();
    }
    render();
    scheduleArchiveUpdate();
  }

  async function cancelRelay() {
    if (cancelling) return;
    cancelling = true;
    locallyBusy = false;
    renderOperation();
    const operationId = viewState.activeOperation?.id || viewState.activeOperation?.operationId;
    const response = await send('RT_RELAY_CANCEL', { operationId, force: true }, 8000);
    cancelling = false;
    if (response?.state) viewState = normalizeState(response);
    else if (response?.ok !== false) viewState.activeOperation = null;
    render();
    if (response?.ok === false) flash('error', response.error?.message || response.error || '停止失败');
    else flash('success', '已停止');
  }

  async function verifyDelivery() {
    if (verifyingDelivery || !viewState.activeOperation) return;
    verifyingDelivery = true;
    renderOperation();
    const operationId = viewState.activeOperation.id;
    const response = await send('RT_RELAY_VERIFY_DELIVERY', { operationId }, 30000);
    verifyingDelivery = false;
    if (response?.state) viewState = normalizeState(response);
    render();
    const alreadyCompleted = viewState.lastOperation?.id === operationId
      && operationState(viewState.lastOperation) === 'COMPLETED';
    if (response?.ok === false && !alreadyCompleted) {
      flash('error', response.error?.message || response.error || '尚未确认送达');
    } else {
      flash('success', '已核对目标消息并完成接力，没有再次发送。');
      scheduleArchiveUpdate();
    }
  }

  // Reload the selected conversation pages before refreshing their bindings.
  function deliveryCanReconnect() {
    return ['WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operationState());
  }

  function reloadAndWait(tabId, timeoutMs = 18000) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated?.removeListener?.(onUpdated);
      };
      const finish = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onUpdated = (updatedId, changeInfo) => {
        if (updatedId === tabId && changeInfo?.status === 'complete') finish();
      };
      chrome.tabs.onUpdated?.addListener?.(onUpdated);
      timer = setTimeout(() => finish(new Error('网页加载超时')), timeoutMs);
      try {
        chrome.tabs.reload(tabId, {}, () => {
          if (chrome.runtime.lastError) finish(new Error(chrome.runtime.lastError.message));
        });
      } catch (error) { finish(error); }
    });
  }

  async function refreshAndReconnect() {
    if ((operationBusy() && !deliveryCanReconnect()) || reconnecting) return;
    closeMenus();
    if (deliveryCanReconnect()) {
      // Reattach the delivery watcher without interrupting a reply or sending
      // the same payload again. Waiting confirmation must not disable repair.
      reconnecting = true;
      renderOperation();
      try { await bootstrap(true); }
      catch (error) { flash('error', String(error?.message || '重新检测失败')); }
      finally { reconnecting = false; renderOperation(); }
      return;
    }
    const pickRefreshTabs = () => {
      const source = viewState.tabs.find((tab) => tab.tabId === viewState.sourceTabId)
        || viewState.tabs.find((tab) => tab.tabId === viewState.activeTabId)
        || viewState.tabs.find((tab) => tab.connected);
      const target = targetTab() || viewState.tabs.find((tab) =>
        tab.provider === selectedProvider && tab.tabId !== source?.tabId);
      return [...new Map([source, target].filter(Boolean).map((tab) => [tab.tabId, tab])).values()];
    };
    let tabs = pickRefreshTabs();
    if (!tabs.length) {
      // The panel can start before any content script answered. Ask the worker
      // to rescan real browser tabs before concluding that nothing is open.
      const listed = await send('RT_LIST_TABS', {}, 20000);
      const fresh = (listed?.tabs || []).map(normalizeTab).filter((tab) => tab.provider && tab.tabId);
      if (fresh.length) {
        viewState = {
          ...viewState,
          tabs: fresh,
          activeTabId: Number(listed.activeTabId) || viewState.activeTabId,
        };
        tabs = pickRefreshTabs();
      }
    }
    if (!tabs.length) {
      flash('error', '没有找到可刷新的 AI 网页。请先在 ChatGPT、Gemini 或 DeepSeek 标签页中打开对话。');
      return;
    }
    reconnecting = true;
    renderOperation();
    try {
      await Promise.allSettled(tabs.map((tab) => reloadAndWait(tab.tabId)));
      await bootstrap(true);
      for (let attempt = 0; attempt < 3 && tabs.some((tab) =>
        !viewState.tabs.some((fresh) => fresh.tabId === tab.tabId && fresh.connected)); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        await bootstrap(true);
      }
      const disconnected = tabs.filter((tab) => !viewState.tabs.some((fresh) => fresh.tabId === tab.tabId && fresh.connected));
      if (disconnected.length) {
        const problem = disconnected[0];
        flash('error', `${providerMeta(problem?.provider).name} 尚未重新连接，请检查网页加载状态。`);
      } else flash('success', '网页已重新连接');
    } catch (error) {
      flash('error', String(error?.message || error || '重新连接失败'));
    } finally {
      reconnecting = false;
      renderOperation();
    }
  }

  function closeMenus() {
    elements.moreMenu.hidden = true;
    elements.sessionMenu.hidden = true;
    elements.moreButton.setAttribute('aria-expanded', 'false');
    elements.sessionSwitcher.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu(menu) {
    const willOpen = menu.hidden;
    closeMenus();
    menu.hidden = !willOpen;
    if (menu === elements.moreMenu) elements.moreButton.setAttribute('aria-expanded', String(willOpen));
    if (menu === elements.sessionMenu) elements.sessionSwitcher.setAttribute('aria-expanded', String(willOpen));
  }

  elements.sessionSwitcher.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu(elements.sessionMenu);
  });

  elements.moreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu(elements.moreMenu);
  });

  document.addEventListener('click', (event) => {
    if (!elements.moreMenu.contains(event.target)
      && !elements.sessionMenu.contains(event.target)
      && !elements.moreButton.contains(event.target)
      && !elements.sessionSwitcher.contains(event.target)) closeMenus();
  });

  elements.refreshConnection.addEventListener('click', refreshAndReconnect);
  elements.exportDiscussion.addEventListener('click', exportCurrentDiscussion);

  elements.newSession.addEventListener('click', async () => {
    if (reconnecting || operationBusy()) return;
    const response = await send('RT_SESSION_NEW');
    if (response?.ok === false) {
      flash('error', response.error?.message || response.error || '新建失败');
      return;
    }
    viewState = normalizeState(response);
    render();
  });

  elements.sessionList.addEventListener('click', async (event) => {
    const control = event.target.closest('[data-session-action]');
    const row = control?.closest('.session-row');
    const sessionId = row?.dataset.sessionId;
    if (!control || !sessionId) return;
    event.stopPropagation();
    if (control.dataset.sessionAction === 'switch') {
      if (sessionId === activeSessionId()) {
        closeMenus();
        return;
      }
      const response = await send('RT_SESSION_SWITCH', { sessionId });
      if (response?.ok === false) flash('error', response.error?.message || response.error || '切换失败');
      else {
        viewState = normalizeState(response);
        closeMenus();
        archiveState = { sessionId: activeSessionId(), transfers: [], history: [] };
        render();
        scheduleArchiveUpdate();
      }
      return;
    }
    if (deleteConfirmId !== sessionId) {
      deleteConfirmId = sessionId;
      clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = setTimeout(() => {
        deleteConfirmId = '';
        renderSessions();
      }, 4000);
      renderSessions();
      return;
    }
    clearTimeout(deleteConfirmTimer);
    deleteConfirmId = '';
    const response = await send('RT_SESSION_DELETE', { sessionId });
    if (response?.ok === false) flash('error', response.error?.message || response.error || '删除失败');
    else {
      viewState = normalizeState(response);
      archiveState = { sessionId: activeSessionId(), transfers: [], history: [] };
      render();
      scheduleArchiveUpdate();
    }
  });

  elements.moreMenu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closeMenus();
    if (action === 'force-stop') await cancelRelay();
    if (action === 'settings') chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });

  elements.modelPicker.addEventListener('click', (event) => {
    const button = event.target.closest('.model-button');
    if (!button) return;
    selectedProvider = button.dataset.provider;
    selectedForSourceProvider = sourceTab()?.provider || '';
    rememberTargetPreference(selectedForSourceProvider, selectedProvider);
    renderModelPicker();
    elements.instruction.focus();
  });

  elements.swapDirection.addEventListener('click', async () => {
    if (operationBusy()) { flash('error', '请先结束当前接力'); return; }
    const oldSource = sourceTab();
    const oldTarget = targetTab();
    if (!oldSource || !oldTarget) { flash('error', '请先打开并连接来源和目标 AI 对话'); return; }
    const response = await send('RT_TAB_ACTIVATE', { tabId: oldTarget.tabId });
    if (response?.ok === false) { flash('error', response.error?.message || '切换失败'); return; }
    selectedForSourceProvider = oldTarget.provider;
    selectedProvider = oldSource.provider;
    rememberTargetPreference(oldTarget.provider, oldSource.provider);
    await bootstrap(true);
    flash('success', `${providerMeta(oldTarget.provider).name} → ${providerMeta(oldSource.provider).name}`);
  });

  elements.sendButton.addEventListener('click', startRelay);
  elements.operationStop.addEventListener('click', cancelRelay);
  elements.operationVerify.addEventListener('click', verifyDelivery);
  elements.noticeClose.addEventListener('click', dismissNotice);

  elements.instruction.addEventListener('input', resizeComposer);
  elements.instruction.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      startRelay();
    }
  });

  elements.timeline.addEventListener('click', (event) => {
    const control = event.target.closest('[data-entry-action]');
    const row = control?.closest('.relay-entry');
    if (!control || !row) return;
    if (control.dataset.entryAction === 'open') {
      const entry = row.__entry;
      const live = viewState.tabs.find((tab) => tab.connected
        && tab.conversationKey && tab.conversationKey === entry?.targetConversationKey);
      if (live) {
        void send('RT_TAB_ACTIVATE', { tabId: live.tabId });
      } else if (entry?.targetUrl) {
        // The old tab may have navigated to a different conversation. Open the
        // exact recorded URL instead of activating an unrelated new thread.
        try {
          const url = new URL(entry.targetUrl);
          const host = url.hostname.toLowerCase();
          const actualProvider = host === 'gemini.google.com' ? 'gemini'
            : host === 'chatgpt.com' || host === 'chat.openai.com' ? 'chatgpt'
              : host === 'chat.deepseek.com' ? 'deepseek' : '';
          if (url.protocol !== 'https:' || actualProvider !== entry.targetProvider) {
            throw new Error('untrusted history URL');
          }
          chrome.tabs.create({ url: url.href });
        } catch {
          flash('error', '原始对话链接无效，无法安全打开。');
        }
      } else {
        flash('error', '历史记录未保存原始对话链接。');
      }
    }
    if (control.dataset.entryAction === 'copy') {
      // Copy silently: the card's pressed state and the clipboard itself are
      // enough feedback. No toast above the conversation.
      void navigator.clipboard.writeText(row.__copyText || '')
        .catch(() => flash('error', '复制失败，请检查剪贴板权限'));
    }
    if (control.dataset.entryAction === 'collapse') row.open = false;
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!['RT_STATE_CHANGED', 'RT_STATE', 'RT_RELAY_EVENT'].includes(message?.type)) return;
    viewState = normalizeState(message);
    locallyBusy = false;
    cancelling = false;
    render();
    if (!operationBusy()) scheduleArchiveUpdate();
  });

  function scheduleBootstrap() {
    if (reconnecting) return;
    clearTimeout(bootstrapTimer);
    bootstrapTimer = setTimeout(bootstrap, 220);
  }

  chrome.tabs?.onActivated?.addListener(scheduleBootstrap);
  chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) scheduleBootstrap();
  });
  chrome.tabs?.onRemoved?.addListener(scheduleBootstrap);

  resizeComposer();
  bootstrap();
})();
