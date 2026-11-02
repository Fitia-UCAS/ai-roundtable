'use strict';

// Archives, session persistence, queueing, and panel state projection.
const volatileArchives = new Map();
const archiveDatabaseName = 'ai-roundtable-archives';
let archiveDbPromise = null;
let hydratePromise = null;
let workQueue = Promise.resolve();

// Content archives are independent from bookmarks and operation recovery.
// IndexedDB avoids chrome.storage.local's small quota for long conversations.
function archiveDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null); // Node test harness only.
  if (archiveDbPromise) return archiveDbPromise;
  archiveDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(archiveDatabaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return archiveDbPromise;
}
async function readArchive(sessionId) {
  if (volatileArchives.has(sessionId)) return clone(volatileArchives.get(sessionId));
  const db = await archiveDb();
  if (!db) return { sessionId, transfers: [], history: [] }; // Node tests: no persistent body storage.

  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const request = tx.objectStore('sessions').get(sessionId);
    request.onsuccess = () => resolve(clone(request.result || { sessionId, transfers: [], history: [] }));
    request.onerror = () => reject(request.error);
  });
}
async function writeArchive(data, volatile = false) {
  if (volatile) { volatileArchives.set(data.sessionId, clone(data)); return; }
  volatileArchives.delete(data.sessionId);
  const db = await archiveDb();
  if (!db) { volatileArchives.set(data.sessionId, clone(data)); return; }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(clone(data));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function deleteArchive(sessionId) {
  volatileArchives.delete(sessionId);
  const db = await archiveDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function activeSaveMode() {
  return SAVE_MODES.includes(workerState.runtimeState?.session?.saveMode)
    ? workerState.runtimeState.session.saveMode : 'relay';
}
function archiveHistory(snapshot, archive) {
  if (!snapshot || snapshot.generating) return 0;
  const existing = new Set(archive.history.map((m) => m.key));
  let added = 0;
  for (const message of snapshot.messages || []) {
    if (!message.complete) continue;
    const key = `${snapshot.conversationKey}|${message.role}|${message.id || core.messageHash(message)}`;
    if (existing.has(key)) continue;
    existing.add(key);
    archive.history.push({
      key,
      provider: snapshot.provider,
      conversationKey: snapshot.conversationKey,
      role: message.role,
      text: message.text,
      messageId: String(message.id || ''),
      messageHash: core.messageHash(message),
      messageIndex: Number.isInteger(message.index) ? message.index : null,
      timestamp: Number.isFinite(message.timestamp) ? message.timestamp : null,
      observedAt: now(),
    });
    added++;
  }
  return added;
}
function resolveArchivedAnswers(snapshot, archive) {
  for (const transfer of archive.transfers) {
    if (transfer.answerText || transfer.targetConversationKey !== snapshot.conversationKey) continue;
    const anchor = snapshot.messages.findIndex((m) => (
      transfer.targetMessageId && String(m.id) === transfer.targetMessageId
    ) || (transfer.targetMessageHash && core.messageHash(m) === transfer.targetMessageHash));
    if (anchor < 0) continue; // Never guess an answer across a virtualized boundary.
    for (const message of snapshot.messages.slice(anchor + 1)) {
      if (message.role === 'user') break;
      if (message.role === 'assistant' && message.complete && !snapshot.generating) {
        transfer.answerText = message.text;
        transfer.answerMessageId = String(message.id || '');
        transfer.answerMessageHash = core.messageHash(message);
        transfer.answerMessageIndex = Number.isInteger(message.index) ? message.index : null;
        transfer.answerObservedAt = now();
        break;
      }
    }
  }
}
async function archiveConfirmedRelay(operation, inserted, targetConversation) {
  const sessionId = operation.sessionId;
  const mode = activeSaveMode();
  const archive = mode === 'none'
    ? clone(volatileArchives.get(sessionId) || { sessionId, transfers: [], history: [] })
    : await readArchive(sessionId);
  if (!archive.transfers.some((item) => item.operationId === operation.id)) {
    const relayed = operation.source?.capturedMessages || [];
    const latestUser = [...relayed].reverse().find((m) => m.role === 'user');
    const latestAssistant = [...relayed].reverse().find((m) => m.role === 'assistant');
    archive.transfers.push({
      operationId: operation.id, provider: targetConversation.provider,
      sourceProvider: operation.source?.conversation?.provider || '',
      sourceConversationKey: operation.source?.conversation?.conversationKey || '',
      sourceUrl: operation.source?.conversation?.url || '',
      targetConversationKey: targetConversation.conversationKey,
      targetUrl: targetConversation.url || operation.target?.conversation?.url || '',
      targetMessageId: String(inserted.id || ''), targetMessageHash: core.messageHash(inserted),
      targetMessageIndex: Number.isInteger(inserted.index) ? inserted.index : null,
      instruction: operation.source?.instruction || '',
      sourceMessages: relayed.map((message) => ({
        id: String(message.id || ''),
        role: message.role,
        text: message.text,
        messageHash: String(message.messageHash || core.messageHash(message)),
        messageIndex: Number.isInteger(message.messageIndex) ? message.messageIndex : null,
        timestamp: Number.isFinite(message.timestamp) ? message.timestamp : null,
      })),
      sourceMessageId: String(latestAssistant?.id || ''),
      sourceMessageHash: String(latestAssistant?.messageHash || ''),
      userText: operation.source?.instruction || latestUser?.text || '',
      sourceText: relayed.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n\n'),
      answerText: '', createdAt: operation.createdAt,
      targetTabId: operation.target.tabId,
    });
  }
  if (mode === 'full') archiveHistory(operation.source?.fullSnapshot, archive);
  await writeArchive(archive, mode === 'none');
}
async function archiveRefresh() {
  await ensureHydrated();
  const archive = await readArchive(workerState.runtimeState.session.id);
  const mode = activeSaveMode();
  const interested = new Set(archive.transfers.flatMap((t) => [t.targetConversationKey, t.sourceConversationKey]).filter(Boolean));
  let scanned = 0;
  const tabs = await tabsQuery({});
  for (const tab of tabs) {
    if (!core.providerFromUrl(tab.url)) continue;
    try {
      const snapshot = await inspectTab(tab.id);
      if (mode === 'full' && interested.has(snapshot.conversationKey)) { archiveHistory(snapshot, archive); scanned++; }
      if (interested.has(snapshot.conversationKey)) resolveArchivedAnswers(snapshot, archive);
    } catch { /* Closed, unsupported, or virtualized conversations remain untouched. */ }
  }
  await writeArchive(archive, mode === 'none');
  return { archive, scanned };
}
async function archiveRead() {
  await ensureHydrated();
  const archive = await readArchive(workerState.runtimeState.session.id);
  return { archive, saveMode: activeSaveMode(), session: workerState.runtimeState.session };
}
async function setSessionSaveMode(payload) {
  await ensureHydrated();
  const mode = String(payload.mode || '');
  if (!SAVE_MODES.includes(mode)) throw codedError('INVALID_SAVE_MODE', '未知的消息保存模式。');
  // Switching away from the non-persistent mode drops only its in-memory
  // discussion cache. Previously saved IndexedDB records remain intact.
  // Otherwise a volatile no-save cache could shadow/overwrite older records.
  if (activeSaveMode() === 'none' && mode !== 'none') {
    volatileArchives.delete(workerState.runtimeState.session.id);
  }
  workerState.runtimeState.session = { ...workerState.runtimeState.session, saveMode: mode };
  await persistAndBroadcast();
  return { mode };
}
async function setGlobalPreferences(payload) {
  const stored = await storageGet([PREFS_KEY]);
  const current = stored[PREFS_KEY] || {};
  const mode = payload.defaultSaveMode || current.defaultSaveMode || 'relay';
  if (!SAVE_MODES.includes(mode)) throw codedError('INVALID_SAVE_MODE', '未知的默认模式。');
  workerState.defaultSaveMode = mode;
  const prefs = { defaultSaveMode: mode,
    exportFormat: ['markdown', 'json'].includes(payload.exportFormat)
      ? payload.exportFormat : (current.exportFormat === 'json' ? 'json' : 'markdown'),
    includeTime: payload.includeTime === undefined ? current.includeTime !== false : Boolean(payload.includeTime),
    includeLinks: payload.includeLinks === undefined ? current.includeLinks !== false : Boolean(payload.includeLinks),
  };
  await storageSet({ [PREFS_KEY]: prefs });
  return { preferences: prefs };
}

function createSessionRecord(session = null, options = {}) {
  const timestamp = now();
  const value = session && typeof session === 'object'
    ? { ...session }
    : core.createSession(randomId('session'), timestamp);
  return {
    session: {
      ...value,
      id: String(value.id || randomId('session')),
      title: String(value.title || '新讨论'),
      createdAt: Number(value.createdAt || timestamp),
      updatedAt: Number(value.updatedAt || timestamp),
      saveMode: SAVE_MODES.includes(value.saveMode) ? value.saveMode : workerState.defaultSaveMode,
    },
    bookmarks: options.bookmarks && typeof options.bookmarks === 'object'
      ? bookmarksWithoutPreviews(options.bookmarks)
      : {},
    timeline: Array.isArray(options.timeline) ? options.timeline.slice(-MAX_TIMELINE_ENTRIES).map(receiptOnly) : [],
    lastOperation: operationWithoutContent(options.lastOperation),
    updatedAt: Number(options.updatedAt || value.updatedAt || timestamp),
  };
}

function normalizeSessionRecord(raw, fallbackBookmarks = {}) {
  if (!raw || typeof raw !== 'object') return createSessionRecord(null, {
    bookmarks: fallbackBookmarks,
  });
  const session = raw.session || (raw.id ? raw : null);
  return createSessionRecord(session, {
    bookmarks: { ...fallbackBookmarks, ...(raw.bookmarks || {}) },
    timeline: raw.timeline,
    lastOperation: raw.lastOperation,
    updatedAt: raw.updatedAt,
  });
}

function applySessionRecord(record) {
  const normalized = normalizeSessionRecord(record);
  workerState.runtimeState.session = normalized.session;
  workerState.runtimeState.bookmarks = normalized.bookmarks;
  workerState.runtimeState.timeline = normalized.timeline;
  workerState.runtimeState.lastOperation = normalized.lastOperation;
  workerState.runtimeState.activeSessionId = normalized.session.id;
}

function syncActiveSessionRecord() {
  if (!workerState.runtimeState?.session) return;
  if (!Array.isArray(workerState.runtimeState.sessions)) workerState.runtimeState.sessions = [];
  const timestamp = Number(workerState.runtimeState.session.updatedAt || workerState.runtimeState.updatedAt || now());
  const record = createSessionRecord(workerState.runtimeState.session, {
    bookmarks: workerState.runtimeState.bookmarks,
    timeline: workerState.runtimeState.timeline,
    lastOperation: workerState.runtimeState.lastOperation,
    updatedAt: timestamp,
  });
  const index = workerState.runtimeState.sessions.findIndex(
    (item) => item?.session?.id === workerState.runtimeState.session.id
  );
  if (index >= 0) workerState.runtimeState.sessions[index] = record;
  else workerState.runtimeState.sessions.push(record);
  workerState.runtimeState.activeSessionId = workerState.runtimeState.session.id;
}

function sessionSummaries() {
  syncActiveSessionRecord();
  return workerState.runtimeState.sessions
    .map((record) => ({
      id: record.session.id,
      title: record.session.title || '新讨论',
      createdAt: Number(record.session.createdAt || 0),
      updatedAt: Number(record.session.updatedAt || record.updatedAt || 0),
      entryCount: Array.isArray(record.timeline) ? record.timeline.length : 0,
      active: record.session.id === workerState.runtimeState.activeSessionId,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function defaultRuntime(bookmarks = {}) {
  const timestamp = now();
  const record = createSessionRecord(core.createSession(randomId('session'), timestamp), {
    bookmarks,
  });
  return {
    schemaVersion: core.PROTOCOL_VERSION,
    panelSchemaVersion: 1,
    session: record.session,
    bookmarks: record.bookmarks,
    timeline: record.timeline,
    activeOperation: null,
    lastOperation: record.lastOperation,
    sessions: [record],
    activeSessionId: record.session.id,
    updatedAt: timestamp,
  };
}

async function ensureHydrated() {
  if (workerState.runtimeState) return workerState.runtimeState;
  if (!hydratePromise) {
    hydratePromise = (async () => {
      const stored = await storageGet([STATE_KEY, LEGACY_BOOKMARKS_KEY, PREFS_KEY]);
      workerState.defaultSaveMode = SAVE_MODES.includes(stored[PREFS_KEY]?.defaultSaveMode)
        ? stored[PREFS_KEY].defaultSaveMode : 'relay';
      const persisted = stored[STATE_KEY];
      const legacyBookmarks = stored[LEGACY_BOOKMARKS_KEY] || {};
      if (persisted && persisted.schemaVersion === core.PROTOCOL_VERSION) {
        const base = defaultRuntime();
        const hasSessionLibrary = Array.isArray(persisted.sessions) && persisted.sessions.length > 0;
        if (hasSessionLibrary) {
          const sessions = persisted.sessions
            .map((record) => normalizeSessionRecord(record))
            .filter((record) => record.session?.id);
          let activeSessionId = String(persisted.activeSessionId || '');
          let activeRecord = sessions.find((record) => record.session.id === activeSessionId);
          if (!activeRecord) {
            activeRecord = sessions[0] || createSessionRecord();
            if (!sessions.length) sessions.push(activeRecord);
            activeSessionId = activeRecord.session.id;
          }
          workerState.runtimeState = {
            ...base,
            schemaVersion: core.PROTOCOL_VERSION,
            sessions,
            activeSessionId,
            activeOperation: operationWithoutContent(persisted.activeOperation),
            updatedAt: Number(persisted.updatedAt || now()),
          };
          applySessionRecord(activeRecord);
          workerState.runtimeState.bookmarks = {
            ...legacyBookmarks,
            ...workerState.runtimeState.bookmarks,
          };
        } else {
          const migratedRecord = createSessionRecord(
            persisted.session || core.createSession(randomId('session')),
            {
              bookmarks: { ...legacyBookmarks, ...(persisted.bookmarks || {}) },
              timeline: persisted.timeline,
              lastOperation: persisted.lastOperation,
              updatedAt: persisted.updatedAt,
            }
          );
          workerState.runtimeState = {
            ...base,
            ...persisted,
            session: migratedRecord.session,
            bookmarks: migratedRecord.bookmarks,
            timeline: migratedRecord.timeline,
            lastOperation: migratedRecord.lastOperation,
            sessions: [migratedRecord],
            activeSessionId: migratedRecord.session.id,
          };
        }
      } else {
        workerState.runtimeState = defaultRuntime(legacyBookmarks);
      }
      workerState.runtimeState.bookmarks = bookmarksWithoutPreviews(workerState.runtimeState.bookmarks);
      syncActiveSessionRecord();
      return workerState.runtimeState;
    })().finally(() => {
      hydratePromise = null;
    });
  }
  return hydratePromise;
}

async function persistState() {
  syncActiveSessionRecord();
  const activeId = workerState.runtimeState.activeSessionId;
  const activeRecord = workerState.runtimeState.sessions.find((item) => item.session.id === activeId);
  const remaining = workerState.runtimeState.sessions
    .filter((item) => item.session.id !== activeId)
    .sort((left, right) => Number(right.session.updatedAt || 0) - Number(left.session.updatedAt || 0));
  workerState.runtimeState.sessions = [activeRecord, ...remaining]
    .filter(Boolean)
    .slice(0, MAX_SESSIONS)
    .map((record) => ({
      ...record,
      timeline: (Array.isArray(record.timeline) ? record.timeline : []).slice(-MAX_TIMELINE_ENTRIES).map(receiptOnly),
      lastOperation: operationWithoutContent(record.lastOperation),
      bookmarks: bookmarksWithoutPreviews(record.bookmarks),
    }));

  const persisted = {
    schemaVersion: core.PROTOCOL_VERSION,
    activeSessionId: workerState.runtimeState.activeSessionId,
    sessions: clone(workerState.runtimeState.sessions),
    activeOperation: operationWithoutContent(workerState.runtimeState.activeOperation),
    updatedAt: now(),
  };
  while (JSON.stringify(persisted).length > MAX_PERSISTED_STATE_CHARACTERS) {
    const candidates = persisted.sessions
      .filter((record) => record.timeline.length)
      .sort((left, right) => Number(left.session.updatedAt || 0) - Number(right.session.updatedAt || 0));
    if (candidates.length) {
      candidates[0].timeline.shift();
      continue;
    }
    const disposable = persisted.sessions
      .filter((record) => record.session.id !== persisted.activeSessionId);
    if (disposable.length) {
      const oldest = disposable.sort(
        (left, right) => Number(left.session.updatedAt || 0) - Number(right.session.updatedAt || 0)
      )[0];
      persisted.sessions = persisted.sessions.filter(
        (record) => record.session.id !== oldest.session.id
      );
      continue;
    }
    break;
  }
  workerState.runtimeState.sessions = persisted.sessions;
  const liveRecord = workerState.runtimeState.sessions.find((record) => record.session.id === activeId);
  if (liveRecord) applySessionRecord(liveRecord);
  workerState.runtimeState.updatedAt = now();
  persisted.updatedAt = workerState.runtimeState.updatedAt;
  await storageSet({
    [STATE_KEY]: persisted,
    [LEGACY_BOOKMARKS_KEY]: bookmarksWithoutPreviews(workerState.runtimeState.bookmarks),
  });
}

function enqueue(task) {
  const run = workQueue.then(task, task);
  workQueue = run.catch(() => undefined);
  return run;
}

function currentViewState() {
  const supportedIds = new Set(workerState.tabCache.map((tab) => tab.tabId));
  // If the chosen tab is temporarily offline during SPA navigation, expose it
  // as offline rather than silently replacing the SOURCE with another AI.
  const sourceTabId = [
    workerState.selectedSourceTabId,
    workerState.runtimeState?.session?.suggestedSourceTabId,
    workerState.activeTabId,
  ].find((tabId) => supportedIds.has(tabId)) || workerState.tabCache.find((tab) => tab.online)?.tabId || null;
  return clone({
    schemaVersion: core.PROTOCOL_VERSION,
    panelSchemaVersion: 1,
    session: workerState.runtimeState?.session || null,
    activeSessionId: workerState.runtimeState?.activeSessionId || workerState.runtimeState?.session?.id || null,
    sessions: workerState.runtimeState ? sessionSummaries() : [],
    bookmarks: workerState.runtimeState?.bookmarks || {},
    timeline: (workerState.runtimeState?.timeline || []).map(receiptOnly),
    activeOperation: operationWithoutContent(workerState.runtimeState?.activeOperation),
    lastOperation: operationWithoutContent(workerState.runtimeState?.lastOperation),
    supportedTabs: workerState.tabCache,
    connections: {
      source: workerState.tabCache.length === 0 ? 'NO_SOURCE_TAB'
        : workerState.tabCache.some((tab) => tab.online) ? 'CONNECTED' : 'CONTENT_SCRIPT_UNAVAILABLE',
      tabs: workerState.tabCache.map((tab) => ({ tabId: tab.tabId, provider: tab.provider,
        connected: Boolean(tab.online), error: tab.error || null })),
    },
    activeTabId: workerState.activeTabId,
    sourceTabId,
    busy: Boolean(workerState.runtimeState?.activeOperation
      && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)),
    updatedAt: workerState.runtimeState?.updatedAt || now(),
  });
}

function broadcastState() {
  if (!workerState.runtimeState) return;
  const message = { type: 'RT_STATE_CHANGED', state: currentViewState() };
  for (const port of [...workerState.panelPorts]) {
    try {
      port.postMessage(message);
    } catch {
      workerState.panelPorts.delete(port);
    }
  }
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    // Side Panel may be closed; persisted state remains authoritative.
  }
}

async function persistAndBroadcast() {
  await persistState();
  broadcastState();
}

