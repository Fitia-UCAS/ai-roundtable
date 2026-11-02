'use strict';

// Command routing and browser event registration.
async function handlePanelCommand(message) {
  const payload = message?.payload || message || {};
  switch (message?.type) {
    case 'RT_BOOTSTRAP':
      return enqueue(() => bootstrap(payload));
    case 'RT_LIST_TABS':
      await ensureHydrated();
      await refreshSupportedTabs({ force: true });
      return { tabs: workerState.tabCache, activeTabId: workerState.activeTabId };
    case 'RT_RELAY_STATUS':
      // Read-only and deliberately outside the serialized relay queue. The
      // panel can inspect progress while a slow source read is still running.
      await ensureHydrated();
      return { activeOperation: workerState.runtimeState.activeOperation,
        lastOperation: workerState.runtimeState.lastOperation };
    case 'RT_OPERATION_CHECK':
      return enqueue(async () => {
        await ensureHydrated();
        await expireStaleOperation();
        let operation = workerState.runtimeState.activeOperation;
        if (operation?.target?.insertedMessage) {
          await finalizeSentOperation();
          operation = workerState.runtimeState.activeOperation;
        }
        if (operation && ['WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operation.state)
          && now() - Number(operation.target?.lastWatchArmAt || 0) > 15000) {
          operation.target.lastWatchArmAt = now();
          await persistState();
          await armDeliveryWatcher(operation).catch(() => undefined);
        }
        // Browser mutation events can be missed after a page redraw or worker
        // restart. Recheck the target DOM occasionally while the panel is open;
        // this never submits again and never requests full AI history.
        operation = workerState.runtimeState.activeOperation;
        if (operation && ['WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operation.state)
          && now() - Math.max(Number(operation.target?.lastProbeAt || 0),
            Number(operation.target?.lastDirectCheckAt || 0)) > 6000) {
          operation.target.lastDirectCheckAt = now();
          try {
            const snapshot = await inspectTab(operation.target.tabId, { force: true });
            await handleDeliveryProbe(operation.id, operation.target.tabId, { snapshot });
          } catch (error) {
            console.warn('[AI ROUND TABLE] delivery DOM recheck skipped', error);
          }
        }
        return { activeOperation: workerState.runtimeState.activeOperation };
      });
    case 'RT_RELAY_START':
      return enqueue(() => startRelay(payload));
    case 'RT_RELAY_CANCEL':
      return cancelRelay(payload);
    case 'RT_RELAY_VERIFY_DELIVERY':
      return enqueue(() => verifyDeliveredRelay(payload));
    case 'RT_TAB_ACTIVATE':
      return activateTab(payload);
    case 'RT_SESSION_NEW':
      return enqueue(() => newSession(payload));
    case 'RT_SESSION_LIST':
      return enqueue(() => listSessions());
    case 'RT_SESSION_SWITCH':
      return enqueue(() => switchSession(payload));
    case 'RT_SESSION_DELETE':
      return enqueue(() => deleteSession(payload));
    case 'RT_SESSION_RENAME':
      return enqueue(() => renameSession(payload));
    case 'RT_SESSION_CLEAR':
      return enqueue(() => clearSession());
    case 'RT_BOOKMARK_RESET':
      return enqueue(() => resetBookmark(payload));
    case 'RT_ARCHIVE_READ':
      return enqueue(() => archiveRead());
    case 'RT_ARCHIVE_REFRESH':
      return enqueue(() => archiveRefresh());
    case 'RT_ARCHIVE_CLEAR':
      return enqueue(async () => { await ensureHydrated(); await deleteArchive(workerState.runtimeState.session.id); return { cleared: true }; });
    case 'RT_SESSION_MODE_SET':
      return enqueue(() => setSessionSaveMode(payload));
    case 'RT_SETTINGS_GET':
      return enqueue(async () => { const stored = await storageGet([PREFS_KEY]);
        const saved = stored[PREFS_KEY] || {};
        return { preferences: { defaultSaveMode: saved.defaultSaveMode || 'relay',
          exportFormat: saved.exportFormat === 'json' ? 'json' : 'markdown',
          includeTime: saved.includeTime !== false, includeLinks: saved.includeLinks !== false } }; });
    case 'RT_SETTINGS_SET':
      return enqueue(() => setGlobalPreferences(payload));
    case 'RT_EXPORT_STATE':
      await ensureHydrated();
      return {
        filename: `ai-roundtable-${workerState.runtimeState.session.id}.json`,
        state: currentViewState(),
        json: JSON.stringify(currentViewState(), null, 2),
      };
    case 'RT_EXPORT_FILE':
      return downloadFile(payload);
    default:
      throw codedError('UNKNOWN_COMMAND', `无法识别命令：${message?.type || ''}`);
  }
}

function commandResponse(message, result) {
  return {
    type: `${message.type}_RESULT`,
    requestId: message.requestId || null,
    ok: true,
    ...result,
    ...(workerState.runtimeState ? { state: currentViewState() } : {}),
  };
}

function commandErrorResponse(message, error) {
  return {
    type: `${message?.type || 'RT_COMMAND'}_RESULT`,
    requestId: message?.requestId || null,
    ok: false,
    error: errorData(error),
    ...(workerState.runtimeState ? { state: currentViewState() } : {}),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'RT_BOOKMARK_SET') {
    enqueue(() => setBookmarkFromPage(message, sender))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: errorData(error) }));
    return true;
  }
  const isContentEvent = message?.type === 'RT_RELAY_EVENT'
    || CONTENT_EVENT_TYPES.has(message?.type);
  if (isContentEvent) {
    enqueue(() => handleContentEvent(message, sender))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: errorData(error) }));
    return true;
  }

  if (!String(message?.type || '').startsWith('RT_')) return undefined;
  Promise.resolve(handlePanelCommand(message))
    .then((result) => sendResponse(commandResponse(message, result)))
    .catch((error) => sendResponse(commandErrorResponse(message, error)));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  workerState.panelPorts.add(port);
  port.onDisconnect.addListener(() => workerState.panelPorts.delete(port));
  port.onMessage.addListener((message) => {
    Promise.resolve(handlePanelCommand(message))
      .then((result) => port.postMessage(commandResponse(message, result)))
      .catch((error) => port.postMessage(commandErrorResponse(message, error)));
  });
  void ensureHydrated().then(() => {
    port.postMessage({ type: 'RT_STATE_CHANGED', state: currentViewState() });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueue(async () => {
    await ensureHydrated();
    await persistState();
    try {
      await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
    } catch {
      // Side Panel fallback is handled by the UI package.
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  void enqueue(async () => {
    await ensureHydrated();
    await refreshSupportedTabs();
    await recoverActiveOperation();
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (Number.isInteger(workerState.panelWindowId) && activeInfo.windowId !== workerState.panelWindowId) return;
  workerState.activeTabId = activeInfo.tabId;
  if (workerState.tabCache.some((tab) => tab.tabId === activeInfo.tabId)) {
    workerState.selectedSourceTabId = activeInfo.tabId;
  }
  scheduleTabRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const operationTarget = workerState.runtimeState?.activeOperation?.target.tabId === tabId;
  const relevantTab = Boolean(core.providerFromUrl(tab?.url)
    || workerState.tabCache.some((item) => item.tabId === tabId)
    || operationTarget);
  if (relevantTab && (changeInfo.status === 'complete' || changeInfo.url)) {
    scheduleTabRefresh();
    void enqueue(async () => {
      await ensureHydrated();
      if (workerState.runtimeState.activeOperation?.target.tabId === tabId
        && [core.OPERATION_STATES.SUSPENDED, core.OPERATION_STATES.WAITING,
          core.OPERATION_STATES.DISPATCHED].includes(workerState.runtimeState.activeOperation.state)) {
        await recoverActiveOperation();
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scheduleTabRefresh();
  void enqueue(async () => {
    await ensureHydrated();
    const operation = workerState.runtimeState.activeOperation;
    if (!operation || operation.target.tabId !== tabId) return;
    if ([core.OPERATION_STATES.DISPATCHED, core.OPERATION_STATES.TARGET_ACKED,
      core.OPERATION_STATES.WAITING].includes(operation.state)) {
      transitionActive(core.OPERATION_STATES.SUSPENDED, {
        error: {
          code: 'TARGET_TAB_CLOSED',
          message: '目标标签页已关闭，重新打开同一对话后可以继续。',
          recoverable: true,
        },
      });
      await persistAndBroadcast();
    }
  });
});

// MV3 workers can be suspended; alarms keep the watchdog effective without an open side panel.
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== WATCHDOG_ALARM) return;
    void enqueue(async () => {
      await ensureHydrated();
      const expired = await expireStaleOperation();
      if (!expired && workerState.runtimeState.activeOperation) await recoverActiveOperation();
    });
  });
  try {
    chrome.alarms.get(WATCHDOG_ALARM, (existing) => {
      if (!existing) chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
    });
  } catch {
    try { chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 }); } catch {}
  }
}

