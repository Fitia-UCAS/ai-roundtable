'use strict';

// Tab activation, discussion sessions, bookmarks, and bootstrap.
async function activateTab(payload = {}) {
  const tabId = Number(payload.tabId);
  if (!Number.isInteger(tabId)) throw codedError('INVALID_TAB', '缺少要打开的标签页。');
  const tab = await tabsUpdate(tabId, { active: true });
  if (Number.isInteger(tab?.windowId)) {
    try {
      await windowsUpdate(tab.windowId, { focused: true });
    } catch {
      // Activating the tab is sufficient when Edge refuses focus.
    }
  }
  workerState.activeTabId = tabId;
  if (core.providerFromUrl(tab?.url)) workerState.selectedSourceTabId = tabId;
  scheduleTabRefresh();
  return { tabId };
}

async function newSession(payload = {}) {
  await ensureHydrated();
  await expireStaleOperation();
  if (workerState.runtimeState.activeOperation
    && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)) {
    await cancelRelay({ force: true });
  }
  syncActiveSessionRecord();
  const timestamp = now();
  const session = {
    ...core.createSession(randomId('session'), timestamp),
    title: cleanSessionTitle(payload.title || '新讨论'),
  };
  const record = createSessionRecord(session);
  workerState.runtimeState.sessions.push(record);
  applySessionRecord(record);
  workerState.runtimeState.activeOperation = null;
  workerState.selectedSourceTabId = workerState.tabCache.some((tab) => tab.tabId === workerState.activeTabId && tab.online)
    ? workerState.activeTabId
    : null;
  await persistAndBroadcast();
  return { session: workerState.runtimeState.session };
}

async function listSessions() {
  await ensureHydrated();
  return {
    activeSessionId: workerState.runtimeState.activeSessionId,
    sessions: sessionSummaries(),
  };
}

async function switchSession(payload = {}) {
  await ensureHydrated();
  await expireStaleOperation();
  if (workerState.runtimeState.activeOperation
    && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)) {
    await cancelRelay({ force: true });
  }
  const sessionId = String(payload.sessionId || payload.id || '');
  if (!sessionId) throw codedError('MISSING_SESSION_ID', '缺少要打开的会议。');
  syncActiveSessionRecord();
  const record = workerState.runtimeState.sessions.find((item) => item.session.id === sessionId);
  if (!record) throw codedError('SESSION_NOT_FOUND', '这场会议已经不存在。');
  applySessionRecord(record);
  workerState.runtimeState.activeOperation = null;
  const suggested = Number(workerState.runtimeState.session.suggestedSourceTabId);
  workerState.selectedSourceTabId = workerState.tabCache.some((tab) => tab.tabId === suggested && tab.online)
    ? suggested
    : null;
  await persistAndBroadcast();
  return { session: workerState.runtimeState.session };
}

async function renameSession(payload = {}) {
  await ensureHydrated();
  const sessionId = String(payload.sessionId || payload.id || workerState.runtimeState.activeSessionId || '');
  const title = cleanSessionTitle(payload.title);
  if (!core.normalizeText(payload.title)) throw codedError('INVALID_SESSION_TITLE', '会议名称不能为空。');
  syncActiveSessionRecord();
  const record = workerState.runtimeState.sessions.find((item) => item.session.id === sessionId);
  if (!record) throw codedError('SESSION_NOT_FOUND', '这场会议已经不存在。');
  const timestamp = now();
  record.session = { ...record.session, title, updatedAt: timestamp };
  record.updatedAt = timestamp;
  if (sessionId === workerState.runtimeState.activeSessionId) workerState.runtimeState.session = record.session;
  await persistAndBroadcast();
  return { session: record.session };
}

async function deleteSession(payload = {}) {
  await ensureHydrated();
  const sessionId = String(payload.sessionId || payload.id || workerState.runtimeState.activeSessionId || '');
  if (!sessionId) throw codedError('MISSING_SESSION_ID', '缺少要删除的会议。');
  const deletingCurrent = sessionId === workerState.runtimeState.activeSessionId;
  if (deletingCurrent && workerState.runtimeState.activeOperation
    && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)) {
    await cancelRelay({ force: true });
  }
  syncActiveSessionRecord();
  if (!workerState.runtimeState.sessions.some((item) => item.session.id === sessionId)) {
    throw codedError('SESSION_NOT_FOUND', '这场会议已经不存在。');
  }
  workerState.runtimeState.sessions = workerState.runtimeState.sessions.filter((item) => item.session.id !== sessionId);
  if (deletingCurrent) {
    const replacement = workerState.runtimeState.sessions
      .sort((left, right) => Number(right.session.updatedAt || 0) - Number(left.session.updatedAt || 0))[0]
      || createSessionRecord();
    if (!workerState.runtimeState.sessions.length) workerState.runtimeState.sessions.push(replacement);
    applySessionRecord(replacement);
    workerState.runtimeState.activeOperation = null;
    workerState.selectedSourceTabId = null;
  }
  await persistAndBroadcast();
  try { await deleteArchive(sessionId); } catch (error) { console.warn('Archive deletion failed', error); }
  return {
    deletedSessionId: sessionId,
    activeSessionId: workerState.runtimeState.activeSessionId,
    session: workerState.runtimeState.session,
  };
}

async function resetBookmark(payload = {}) {
  await ensureHydrated();
  await expireStaleOperation();
  if (workerState.runtimeState.activeOperation
    && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)) {
    throw codedError('BUSY', '接力进行中，暂时不能修改书签。');
  }
  if (payload.all) {
    throw codedError('RESET_ALL_DISABLED', '请逐个对话重置书签，避免误清除其他讨论。');
  }
  const tabId = Number(payload.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw codedError('MISSING_SOURCE_TAB', '请先打开需要重置的来源网页。');
  }
  const current = await inspectTab(tabId);
  const key = String(payload.conversationKey || '');
  if (!key || current.conversationKey !== key) {
    throw codedError('SOURCE_CONVERSATION_CHANGED',
      '来源网页已经切换对话，书签没有被重置。请重新检测网页并确认来源。');
  }
  if (!workerState.runtimeState.bookmarks[key]) {
    return { cleared: false, conversationKey: key, bookmarks: workerState.runtimeState.bookmarks };
  }
  delete workerState.runtimeState.bookmarks[key];
  await persistAndBroadcast();
  return { cleared: true, conversationKey: key, bookmarks: workerState.runtimeState.bookmarks };
}

async function clearSession() {
  await ensureHydrated();
  await expireStaleOperation();
  if (workerState.runtimeState.activeOperation
    && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)) {
    await cancelRelay({ force: true });
  }
  workerState.runtimeState.timeline = [];
  workerState.runtimeState.lastOperation = null;
  workerState.runtimeState.session = {
    ...workerState.runtimeState.session,
    updatedAt: now(),
  };
  await persistAndBroadcast();
  await deleteArchive(workerState.runtimeState.session.id);
  return { cleared: true };
}

function hasRunningOperation() {
  const operation = workerState.runtimeState.activeOperation;
  return Boolean(operation && !core.isTerminalOperationState(operation.state));
}

async function saveBookmarkSelection(tabId, message, expectedConversationKey = '') {
  await ensureHydrated();
  if (hasRunningOperation()) {
    throw codedError('BUSY', '有接力正在进行，不能修改书签。');
  }
  const snapshot = await inspectTab(tabId, { force: true });
  if (expectedConversationKey && snapshot.conversationKey !== expectedConversationKey) {
    throw codedError('CONVERSATION_CHANGED', '网页切换了对话，请重新选择书签。');
  }
  const hash = String(message.messageHash || '');
  const id = String(message.messageId || '');
  // A virtual-list DOM key can be reassigned on re-render; only a native
  // server id is stable enough to corroborate the content hash.
  const requireId = core.inferredIdentity(id) === 'native-id';
  const matches = snapshot.messages.filter((item) =>
    core.messageHash(item) === hash && (!requireId || item.id === id));
  if (matches.length !== 1) {
    if (!matches.length && requireId && snapshot.messages.some((item) => item.id === id)) {
      throw codedError('BOOKMARK_TEXT_CHANGED', '这条消息的内容还在变化，请等它完成后再设置书签。');
    }
    throw codedError('BOOKMARK_AMBIGUOUS', '无法唯一定位所选消息，可能有重复内容或页面虚拟列表已更新。');
  }
  const selected = matches[0];
  const selectedIndex = snapshot.messages.indexOf(selected);
  const bookmark = core.makeStartCursor(snapshot.messages, selectedIndex,
    snapshot.conversationKey, { updatedAt: now() });
  workerState.runtimeState.bookmarks[snapshot.conversationKey] = bookmark;
  await persistAndBroadcast();
  return { selected: true, conversationKey: snapshot.conversationKey,
    messageId: selected.id, startIndex: selectedIndex, bookmark };
}

async function setBookmarkFromPage(message, sender) {
  const tabId = Number(sender.tab?.id);
  if (!Number.isInteger(tabId)) throw codedError('NO_SOURCE_TAB', '无法识别当前 AI 网页。');
  if (message.clear === true) {
    return resetBookmark({ tabId, conversationKey: String(message.conversationKey || '') });
  }
  return saveBookmarkSelection(tabId, message, String(message.conversationKey || ''));
}

async function bootstrap(payload = {}) {
  if (Number.isInteger(Number(payload.windowId))) workerState.panelWindowId = Number(payload.windowId);
  await ensureHydrated();
  await refreshSupportedTabs({ force: Boolean(payload.force) });
  await recoverActiveOperation();
  return { state: currentViewState() };
}

