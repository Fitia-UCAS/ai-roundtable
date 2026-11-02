'use strict';

// Conversation normalization, tab inspection, and connection refresh.
let tabRefreshTimer = null;
let tabRefreshAt = 0;
let tabRefreshPromise = null;

function messageRef(message) {
  if (!message) return null;
  return {
    id: String(message.id || message.nativeId || ''),
    role: message.role,
    hash: core.messageHash(message),
    index: Number.isInteger(message.index)
      ? message.index
      : Number.isInteger(message.ordinal) ? message.ordinal : 0,
  };
}

function conversationMeta(snapshot) {
  if (!snapshot) return null;
  return {
    provider: snapshot.provider,
    providerName: snapshot.providerName,
    conversationKey: snapshot.conversationKey,
    conversationId: snapshot.conversationId,
    title: snapshot.title,
    url: snapshot.url,
    revision: snapshot.revision,
    strategy: snapshot.strategy,
    truncated: snapshot.truncated,
    generating: Boolean(snapshot.generating),
    temporary: Boolean(snapshot.temporary),
  };
}

function tabMeta(tabId) {
  const tab = workerState.tabCache.find((item) => item.tabId === Number(tabId));
  if (!tab) return null;
  return {
    provider: tab.provider,
    providerName: tab.providerName,
    conversationKey: tab.conversationKey,
    title: tab.title,
    url: tab.url,
  };
}

function sendResultMeta(result) {
  if (!result || typeof result !== 'object') return {};
  const allowed = [
    'sent', 'submitted', 'confirmed', 'confirmation', 'reason', 'submitMethod',
    'promptHash', 'conversationId', 'conversationKey', 'userMessageId',
    'messageId', 'baselineMessageIds', 'baselineMessageKeys', 'baselineMessageCount',
    'currentMessageId', 'inputCleared', 'matchType', 'collapsedEvidence', 'operationId', 'timings',
    'initialConversationKey', 'conversationTransition',
  ];
  return Object.fromEntries(allowed
    .filter((key) => result[key] !== undefined)
    .map((key) => [key, result[key]]));
}

function unwrapContentResult(response) {
  return response?.result || response?.data || response || {};
}

// Resolve the conversation identity from the actual browser URL, not from a
// previously selected tab or a cached DOM reply. SPA navigation can change the
// address before the old message tree is replaced.
function conversationIdFromKey(key) {
  const match = /^[a-z]+:([0-9a-f-]{36})$/i.exec(String(key || ''));
  return match ? match[1] : '';
}

function urlConversationKey(url) {
  try {
    const parsed = new URL(String(url || ''));
    const provider = core.providerFromUrl(parsed.href);
    const pathname = decodeURI(parsed.pathname);
    if (provider === 'chatgpt') {
      const match = pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
      return match ? `chatgpt:${match[1]}` : '';
    }
    if (provider === 'gemini') {
      const match = pathname.match(/^(?:\/u\/\d+)?\/app\/([^/?#]+)/i);
      return match ? `gemini:${match[1]}` : '';
    }
    return ''; // DeepSeek conversation IDs may be in the SPA state, not the URL.
  } catch { return ''; }
}

function assertConversationMatchesTab(snapshot, tab) {
  const browserKey = urlConversationKey(tab?.url);
  const pageKey = urlConversationKey(snapshot?.url);
  if ((browserKey && pageKey && browserKey !== pageKey)
    || (browserKey && snapshot?.conversationKey !== browserKey)
    || (pageKey && snapshot?.conversationKey !== pageKey)) {
    throw codedError('CONVERSATION_CHANGED',
      '网页已经切换对话，但聊天内容尚未同步；请等待新对话加载完成，然后重新检测网页再发送。');
  }
}

function normalizeSnapshot(raw, tab = null) {
  const snapshot = raw?.snapshot || raw?.data?.snapshot || raw?.data || raw;
  if (!snapshot || typeof snapshot !== 'object') {
    throw codedError('INVALID_SNAPSHOT', '页面返回了无法识别的对话数据。');
  }
  const provider = String(
    snapshot.provider
      || snapshot.adapterId
      || snapshot.conversation?.adapterId
      || core.providerFromUrl(snapshot.url || tab?.url)
  );
  if (!['chatgpt', 'gemini', 'deepseek'].includes(provider)) {
    throw codedError('UNSUPPORTED_TAB', '当前页面不是支持的 AI 对话。');
  }
  const conversationKey = String(
    snapshot.conversationKey
      || snapshot.conversation?.conversationKey
      || snapshot.conversation?.key
      || `${provider}:tab:${tab?.id || 'unknown'}:draft`
  );
  const normalized = core.normalizeSnapshot(snapshot);
  const messages = normalized.messages;
  return {
    provider,
    providerName: String(snapshot.providerName || ({
      chatgpt: 'ChatGPT', gemini: 'Gemini', deepseek: 'DeepSeek',
    })[provider]),
    conversationKey,
    conversationId: String(snapshot.conversationId || snapshot.conversation?.conversationId || ''),
    title: String(snapshot.title || snapshot.conversation?.title || tab?.title || 'AI 对话'),
    url: String(snapshot.url || snapshot.conversation?.url || tab?.url || ''),
    messages,
    revision: String(snapshot.revision || core.conversationRevision(messages)),
    strategy: String(snapshot.strategy || snapshot.source || 'unknown'),
    truncated: Boolean(snapshot.truncated),
    diagnostics: snapshot.diagnostics && typeof snapshot.diagnostics === 'object'
      ? snapshot.diagnostics : {},
    generating: Boolean(snapshot.generating),
    source: String(snapshot.source || ''),
    relayReadId: String(snapshot.relayReadId || ''),
    temporary: Boolean(snapshot.temporary || /:tab:\d+:draft$/.test(conversationKey)),
  };
}

function normalizeSnapshotOrNull(raw, tab = null) {
  if (!raw || typeof raw !== 'object') return null;
  try {
    return normalizeSnapshot(raw, tab);
  } catch {
    return null;
  }
}

async function inspectTab(tabId, options = {}) {
  const tab = await tabsGet(tabId);
  const provider = core.providerFromUrl(tab?.url);
  if (!provider) throw codedError('UNSUPPORTED_TAB', '当前标签页不是支持的 AI 页面。');

  async function inspectOnce() {
    let lastError = null;
    for (const type of [CONTENT_COMMANDS.INSPECT, CONTENT_COMMANDS.LEGACY_INSPECT]) {
      try {
        const response = await sendTabMessage(tabId, {
          type,
          version: core.PROTOCOL_VERSION,
          deep: Boolean(options.deep),
          relayRead: Boolean(options.relayRead),
          relayOperationId: String(options.relayOperationId || ''),
          relayRecheckId: String(options.relayRecheckId || ''),
          relayBookmark: options.relayBookmark && typeof options.relayBookmark === 'object'
            ? options.relayBookmark : null,
          force: Boolean(options.force),
          expectedConversationId: String(options.expectedConversationId || ''),
        });
        if (!response) throw codedError('EMPTY_CONTENT_RESPONSE', '页面没有返回对话数据。');
        if (response.ok === false) throw codedError(
          response.code || response.error?.code || 'INSPECT_FAILED',
          response.error?.message || response.error || '无法读取当前对话。'
        );
        const snapshot = normalizeSnapshot(response, tab);
        const latestTab = await tabsGet(tabId);
        // tabs.get may observe a different route after an asynchronous DOM read.
        const beforeKey = urlConversationKey(tab.url);
        const afterKey = urlConversationKey(latestTab?.url);
        if (beforeKey && afterKey && beforeKey !== afterKey) {
          throw codedError('CONVERSATION_CHANGED',
            '读取过程中切换了网页对话；请等待新对话加载完成后重新检测网页。');
        }
        assertConversationMatchesTab(snapshot, latestTab || tab);
        const old = workerState.tabCache.find((item) => item.tabId === tabId);
        if (old?.conversationKey && old.conversationKey !== snapshot.conversationKey
          && old.revision && old.revision === snapshot.revision) {
          throw codedError('NAVIGATION_IN_PROGRESS',
            '网页刚刚切换到另一条对话，但正文尚未更新；本次不读取旧消息。');
        }
        // A brand-new DeepSeek chat gets its server id after the first send.
        // Promote any bookmark saved under the temporary "new:" key instead of
        // leaving it attached to the root URL.
        if (old?.conversationKey
          && /^[a-z]+:new:/.test(old.conversationKey)
          && !/^[a-z]+:new:/.test(snapshot.conversationKey)
          && old.conversationKey !== snapshot.conversationKey) {
          const bookmark = workerState.runtimeState.bookmarks[old.conversationKey];
          const related = operationForBookmark(bookmark?.lastOperationId);
          if (core.canMigrateTemporaryBookmark({
            oldKey: old.conversationKey,
            newKey: snapshot.conversationKey,
            bookmark,
            operation: related,
            tabId,
            existingBookmark: workerState.runtimeState.bookmarks[snapshot.conversationKey],
          })) {
            const migrated = migrateConversationKey(old.conversationKey, snapshot.conversationKey);
            if (migrated) await persistState();
          }
        }
        return snapshot;
      } catch (error) {
        lastError = error;
        if (responseErrorIsFinal(error)) break;
      }
    }
    throw lastError || codedError('CONTENT_SCRIPT_UNAVAILABLE', '页面没有响应。');
  }

  try {
    return await inspectOnce();
  } catch (error) {
    // Reinjection cannot fix a stale SPA route and must not mask this error.
    if (responseErrorIsFinal(error)) {
      throw error;
    }
    const canRepair = shouldRepairContentBridge(error);
    const lastRepair = workerState.tabRepairAt.get(tabId) || 0;
    // Reinjection is only useful for a missing/stale content bridge. Retrying
    // arbitrary inspection errors used to hide their real cause and could run
    // the same content scripts twice on a healthy page.
    if (!canRepair || Date.now() - lastRepair < 15000) {
      throw codedError('INSPECT_FAILED', error?.message || '无法读取当前对话。');
    }

    workerState.tabRepairAt.set(tabId, Date.now());
    try {
      await injectContentBridge(tabId, provider);
      return await inspectOnce();
    } catch (repairError) {
      throw codedError(
        canRepair ? 'CONTENT_SCRIPT_UNAVAILABLE' : 'INSPECT_FAILED',
        repairError?.message || error?.message || '无法连接当前 AI 页面，请刷新页面后重试。'
      );
    }
  }
}

function responseErrorIsFinal(error) {
  return ['SOURCE_HISTORY_UNAVAILABLE', 'BOOKMARK_SELECTION_REQUIRED', 'CONVERSATION_CHANGED', 'NAVIGATION_IN_PROGRESS'].includes(error?.code);
}

async function runTabRefresh(options = {}) {
  // Prefer this window's chats, but recover when Edge reparented the side
  // panel and its saved window id no longer contains the visible AI tabs.
  let inPanelWindow = [];
  if (Number.isInteger(workerState.panelWindowId)) {
    try {
      inPanelWindow = await tabsQuery({ windowId: workerState.panelWindowId });
    } catch {
      // Edge may have closed that window while keeping this panel alive.
    }
  }
  const tabs = inPanelWindow.some((tab) => core.providerFromUrl(tab.url))
    ? inPanelWindow : await tabsQuery({});
  const supported = tabs.filter((tab) => core.providerFromUrl(tab.url));
  const active = tabs.find((tab) => tab.active && tab.windowId === workerState.panelWindowId)
    || tabs.find((tab) => tab.id === workerState.activeTabId && tab.active)
    || tabs.find((tab) => tab.active && tab.windowId !== undefined);
  workerState.activeTabId = active?.id || null;

  workerState.tabCache = await Promise.all(supported.map(async (tab) => {
    const provider = core.providerFromUrl(tab.url);
    try {
      const snapshot = await inspectTab(tab.id, { force: Boolean(options.force) });
      const bookmark = workerState.runtimeState?.bookmarks?.[snapshot.conversationKey] || null;
      const old = workerState.tabCache.find((item) => item.tabId === tab.id);
      if (old?.conversationKey && old.conversationKey !== snapshot.conversationKey
        && old.revision && old.revision === snapshot.revision) {
        throw codedError('NAVIGATION_IN_PROGRESS',
          '网页地址已经换到新对话，但页面仍显示旧消息；请稍候再重新检测网页。');
      }
      const plan = core.getRelayPlan(snapshot.messages, bookmark, snapshot.conversationKey);
      const stale = plan.kind === 'invalid-cursor' || Boolean(snapshot.truncated && bookmark
        && plan.kind === 'no-new');
      const previewMessages = stale ? [] : plan.messages;
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        active: Boolean(tab.active),
        provider,
        providerName: snapshot.providerName,
        title: snapshot.title,
        url: tab.url,
        conversationKey: snapshot.conversationKey,
        revision: snapshot.revision,
        generating: snapshot.generating,
        online: true,
        connected: true,
        freshCount: previewMessages.length,
        preview: {
          count: previewMessages.length,
          mode: stale ? 'stale' : plan.kind,
          text: previewMessages.map((message) => message.text).join('\n\n'),
        },
      };
    } catch (error) {
      const previous = workerState.tabCache.find((item) => item.tabId === tab.id);
      console.warn(
        '[AI ROUND TABLE] tab inspect failed',
        tab.id,
        provider,
        error?.code || '',
        error?.message || String(error),
      );
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        active: Boolean(tab.active),
        provider,
        providerName: ({ chatgpt: 'ChatGPT', gemini: 'Gemini', deepseek: 'DeepSeek' })[provider],
        title: previous?.title || tab.title || 'AI 对话',
        url: tab.url,
        // Never display a previous conversation's identity/preview after a
        // navigation, even when the content script is temporarily unavailable.
        conversationKey: previous?.url === tab.url ? previous?.conversationKey || '' : '',
        revision: previous?.revision || '', // hash only; never reuse prior message text
        generating: false,
        online: false,
        connected: false,
        stale: true,
        freshCount: 0,
        preview: { count: 0, mode: 'stale', text: '' },
        error: errorData(error),
      };
    }
  }));
  return workerState.tabCache;
}

async function refreshSupportedTabs(options = {}) {
  const force = Boolean(options?.force);
  // Serialize refreshes, including forced ones. An older DOM inspection must
  // never finish later and overwrite a newer post-reload connection snapshot.
  if (tabRefreshPromise) {
    if (!force) return tabRefreshPromise;
    await tabRefreshPromise.catch(() => undefined);
    return refreshSupportedTabs(options);
  }
  if (!force) {
    if (Date.now() - tabRefreshAt < 2500) return workerState.tabCache;
  }
  const task = runTabRefresh(options).then((value) => {
    tabRefreshAt = Date.now();
    return value;
  });
  tabRefreshPromise = task.finally(() => {
    tabRefreshPromise = null;
  });
  return tabRefreshPromise;
}

function scheduleTabRefresh() {
  if (tabRefreshTimer) clearTimeout(tabRefreshTimer);
  tabRefreshTimer = setTimeout(() => {
    tabRefreshTimer = null;
    void refreshSupportedTabs().then(broadcastState).catch(() => undefined);
  }, 120);
}


