(function initRoundtableContentBridge() {
  'use strict';

  const BRIDGE_KEY = '__AI_ROUNDTABLE_CONTENT_BRIDGE__';
  if (globalThis[BRIDGE_KEY]) {
    const existing = globalThis[BRIDGE_KEY].publicApi;
    if (existing && typeof existing.createDomActivityMonitor !== 'function') {
      try {
        existing.createDomActivityMonitor = createDomActivityMonitor;
      } catch {}
    }
    globalThis.RoundtableContent = existing;
    return;
  }

  const adapters = new Map();
  const operations = new Map();
  const deliveryWatchers = new Map();
  const completedSends = new Map();
  const inspectCache = new Map();
  const inspectInFlight = new Map();
  let previousThreadRead = null;
  const SEND_CACHE_TTL = 2 * 60 * 1000;
  const INSPECT_CACHE_TTL = 400;

  function install(adapter) {
    if (!adapter?.id || typeof adapter.matches !== 'function' || typeof adapter.inspect !== 'function') {
      return false;
    }
    adapters.set(String(adapter.id), adapter);
    return true;
  }

  function currentAdapter() {
    for (const adapter of adapters.values()) {
      try {
        if (adapter.matches(location)) return adapter;
      } catch {}
    }
    return null;
  }

  function normalizeCommand(message) {
    const value = String(message?.type || message?.action || message?.command || '')
      .trim()
      .toLowerCase();
    const aliases = new Map([
      ['ping', 'ping'],
      ['ai_roundtable_ping', 'ping'],
      ['rt_ping', 'ping'],
      ['content.ping', 'ping'],
      ['inspect', 'inspect'],
      ['ai_roundtable_inspect', 'inspect'],
      ['rt_inspect', 'inspect'],
      ['content.inspect', 'inspect'],
      ['send', 'send'],
      ['ai_roundtable_send', 'send'],
      ['rt_send', 'send'],
      ['rt_relay_dispatch', 'send'],
      ['content.send', 'send'],
      ['rt_relay_watch_delivery', 'watch-delivery'],
      ['content.watch-delivery', 'watch-delivery'],
      ['wait', 'wait'],
      ['ai_roundtable_wait', 'wait'],
      ['rt_wait', 'wait'],
      ['rt_relay_resume', 'wait'],
      ['content.wait', 'wait'],
      ['cancel', 'cancel'],
      ['ai_roundtable_cancel', 'cancel'],
      ['rt_cancel', 'cancel'],
      ['rt_relay_cancel', 'cancel'],
      ['content.cancel', 'cancel'],
    ]);
    return aliases.get(value) || '';
  }

  function messagePayload(message) {
    const nested = message?.payload && typeof message.payload === 'object' ? message.payload : {};
    return { ...message, ...nested };
  }

  function operationIdFor(command, payload) {
    const explicit = payload.operationId || payload.requestId || payload.idempotencyKey;
    return explicit ? String(explicit) : `${command}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
  }

  function abortError(message = '操作已取消。') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'cancelled';
    return error;
  }

  function cleanSendCache() {
    const cutoff = Date.now() - SEND_CACHE_TTL;
    for (const [key, entry] of completedSends) {
      if (!entry || entry.createdAt < cutoff) completedSends.delete(key);
    }
  }

  function inspectCacheKey(adapter, payload = {}) {
    const bookmark = payload?.relayBookmark;
    const bookmarkKey = bookmark
      ? globalThis.RoundtableCore?.hashText(JSON.stringify([
        bookmark.messageId, bookmark.messageHash, bookmark.renderedHash,
        bookmark.renderedCompactHash, bookmark.messageIndex,
      ])) : '';
    return `${adapter?.id || ''}|${location.href}|${payload?.deep ? 'deep' : 'normal'}|${Boolean(payload?.relayRead)}|${payload?.relayOperationId || ''}|${payload?.relayRecheckId || ''}|${payload?.expectedConversationId || ''}|${bookmarkKey}`;
  }

  function inspectWithCache(adapter, payload) {
    const selectionIssue = (payload?.relayRead || payload?.relayRecheckId)
      && globalThis.__roundtableBookmarkPicker?.selectionIssue?.();
    if (selectionIssue) return Promise.reject(Object.assign(new Error(selectionIssue), { code: 'BOOKMARK_SELECTION_REQUIRED' }));
    const key = inspectCacheKey(adapter, payload);
    const cached = inspectCache.get(key);
    if (!payload?.force && cached && Date.now() - cached.at < INSPECT_CACHE_TTL) {
      return Promise.resolve(cached.value);
    }
    const inFlight = inspectInFlight.get(key);
    if (inFlight) return inFlight;

    const inspectedUrl = location.href;
    const promise = Promise.resolve()
      .then(() => adapter.inspect(payload))
      .then((value) => {
        const finalUrl = location.href;
        const expectedConversationId = String(payload?.expectedConversationId || '');
        const snapshotKey = String(value?.conversationKey || value?.conversation?.conversationKey || '');
        // DeepSeek creates the real conversation id after the first submit.
        // Allow only root -> the expected real id; existing -> existing stays blocked.
        const allowedNewRoute = Boolean(expectedConversationId
          && /^https?:\/\/chat\.deepseek\.com\/?$/i.test(inspectedUrl)
          && snapshotKey === `deepseek:${expectedConversationId}`);
        if ((finalUrl !== inspectedUrl || (value?.url && value.url !== inspectedUrl))
          && !allowedNewRoute) {
          const error = new Error('网页对话在读取过程中切换，请等待加载后重试。');
          error.code = 'NAVIGATION_IN_PROGRESS';
          throw error;
        }
        const snapshot = value && typeof value === 'object' ? {
          ...value,
          strategy: String(value.strategy || value.source || 'dom'),
          truncated: Boolean(value.truncated),
          generating: Boolean(value.generating),
          diagnostics: value.diagnostics && typeof value.diagnostics === 'object'
            ? value.diagnostics : {},
        } : value;
        // A React SPA may keep the old DOM attached briefly after pushState.
        // URL-derived conversation IDs alone do NOT prove the DOM belongs to it.
        const fingerprint = JSON.stringify((snapshot?.messages || []).map((item) => [
          item?.id || '', item?.role || '', item?.text || '',
        ]));
        if (!allowedNewRoute && previousThreadRead?.url !== finalUrl && previousThreadRead?.fingerprint
          && fingerprint && fingerprint !== '[]' && previousThreadRead.fingerprint === fingerprint) {
          const error = new Error('新对话网页仍显示上一条对话的消息；请等待内容更新后重试。');
          error.code = 'NAVIGATION_IN_PROGRESS';
          throw error;
        }
        previousThreadRead = { url: finalUrl, fingerprint };
        inspectCache.set(key, { at: Date.now(), value: snapshot });
        if (inspectCache.size > 32) {
          const oldest = [...inspectCache.entries()]
            .sort((left, right) => left[1].at - right[1].at)[0];
          if (oldest) inspectCache.delete(oldest[0]);
        }
        return snapshot;
      })
      .finally(() => inspectInFlight.delete(key));
    inspectInFlight.set(key, promise);
    return promise;
  }

  function createDomActivityMonitor(root) {
    const target = root || (typeof document !== 'undefined' ? document.body : null);
    function fallbackNext(signal, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve('timeout');
        }, Math.max(50, Number(timeoutMs) || 500));
        function onAbort() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(abortError());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (!target || typeof MutationObserver !== 'function') {
      return {
        lastActivity: () => 0,
        next: fallbackNext,
        disconnect() {},
      };
    }

    let lastActivity = Date.now();
    let resolveNext = null;
    const observer = new MutationObserver(() => {
      lastActivity = Date.now();
      const resolve = resolveNext;
      resolveNext = null;
      resolve?.('activity');
    });
    try {
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    } catch {
      return {
        lastActivity: () => lastActivity,
        next: fallbackNext,
        disconnect() { observer.disconnect(); },
      };
    }

    return {
      lastActivity: () => lastActivity,
      next(signal, timeoutMs) {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
          let settled = false;
          let timer = 0;
          const finish = (reason, aborted = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (resolveNext === onActivity) resolveNext = null;
            if (aborted) reject(abortError());
            else resolve(reason);
          };
          const onActivity = () => finish('activity');
          const onAbort = () => finish('abort', true);
          resolveNext = onActivity;
          timer = setTimeout(() => finish('timeout'), Math.max(50, Number(timeoutMs) || 500));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      disconnect() {
        const resolve = resolveNext;
        resolveNext = null;
        observer.disconnect();
        resolve?.('disconnect');
      },
    };
  }

  function capabilities(adapter) {
    return {
      inspect: typeof adapter?.inspect === 'function',
      send: typeof adapter?.send === 'function',
      wait: typeof adapter?.wait === 'function',
      cancel: true,
    };
  }

  function cancelOperations(adapter, payload) {
    const requestedId = payload.operationId || payload.requestId;
    let cancelled = 0;
    for (const [id, operation] of operations) {
      if (requestedId && id !== String(requestedId)) continue;
      if (!requestedId && adapter && operation.adapterId !== adapter.id) continue;
      operation.controller.abort(abortError());
      operations.delete(id);
      cancelled += 1;
    }
    for (const [id, watcher] of deliveryWatchers) {
      if (requestedId && id !== String(requestedId)) continue;
      if (!requestedId && adapter && watcher.adapterId !== adapter.id) continue;
      watcher.stop();
      deliveryWatchers.delete(id);
      cancelled += 1;
    }
    try {
      if (typeof adapter?.cancel === 'function') adapter.cancel(payload);
    } catch {}
    return { cancelled: cancelled > 0, count: cancelled };
  }

  function stopDeliveryWatcher(operationId) {
    const watcher = deliveryWatchers.get(String(operationId || ''));
    if (!watcher) return false;
    watcher.stop();
    deliveryWatchers.delete(String(operationId));
    return true;
  }

  function compactDeliverySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages.slice(-32) : [];
    return {
      provider: snapshot.provider,
      providerName: snapshot.providerName,
      conversationKey: snapshot.conversationKey,
      conversationId: snapshot.conversationId,
      title: snapshot.title,
      url: snapshot.url || location.href,
      messages,
      generating: Boolean(snapshot.generating),
      strategy: snapshot.strategy || snapshot.source || 'dom',
      truncated: Boolean(snapshot.truncated),
    };
  }

  function emitDeliveryProbe(operationId, adapter, snapshot) {
    try {
      chrome.runtime.sendMessage({
        type: 'RT_RELAY_EVENT',
        event: 'DELIVERY_PROBE',
        operationId,
        provider: adapter?.id || null,
        result: { snapshot: compactDeliverySnapshot(snapshot) },
      }, (response) => {
        void chrome.runtime.lastError;
        if (response?.ignored || response?.terminal || response?.accepted || response?.failed) {
          stopDeliveryWatcher(operationId);
        }
      });
    } catch {}
  }

  function startDeliveryWatcher(adapter, payload = {}) {
    const operationId = String(payload.operationId || '');
    if (!operationId) throw new Error('送达监视缺少 operationId。');
    const existing = deliveryWatchers.get(operationId);
    if (existing) {
      existing.probe();
      return { watching: true, repeated: true, operationId };
    }

    // One page can be the destination of only one active relay. Remove stale
    // observers left by a service-worker restart; this never submits content.
    for (const [id, watcher] of deliveryWatchers) {
      watcher.stop();
      deliveryWatchers.delete(id);
    }

    const intervalMs = Math.min(5000, Math.max(800, Number(payload.probeIntervalMs) || 1800));
    let stopped = false;
    let probing = false;
    let queued = false;
    let debounceTimer = 0;
    let intervalTimer = 0;
    let observer = null;

    async function probe() {
      if (stopped) return;
      if (probing) {
        queued = true;
        return;
      }
      probing = true;
      try {
        const snapshot = await adapter.inspect({ deliveryProbe: true });
        if (!stopped) emitDeliveryProbe(operationId, adapter, snapshot);
      } catch {
        // DOM can be temporarily unreadable during a SPA redraw. The observer
        // and low-frequency fallback remain active; no failure is inferred.
      } finally {
        probing = false;
        if (queued && !stopped) {
          queued = false;
          setTimeout(probe, 0);
        }
      }
    }

    function scheduleProbe() {
      if (stopped || debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = 0;
        void probe();
      }, 450);
    }

    const root = document.querySelector('main') || document.body || document.documentElement;
    if (root && typeof MutationObserver === 'function') {
      observer = new MutationObserver(scheduleProbe);
      try { observer.observe(root, { childList: true, subtree: true, characterData: true }); }
      catch { observer.disconnect(); observer = null; }
    }
    intervalTimer = setInterval(() => void probe(), intervalMs);
    const watcher = {
      adapterId: adapter.id,
      probe,
      stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(debounceTimer);
        clearInterval(intervalTimer);
        observer?.disconnect();
      },
    };
    deliveryWatchers.set(operationId, watcher);
    void probe();
    return { watching: true, operationId };
  }

  function runOperation(command, adapter, payload) {
    const operationId = operationIdFor(command, payload);
    const existing = operations.get(operationId);
    if (existing) return existing.promise;

    cleanSendCache();
    if (command === 'send') {
      const cached = completedSends.get(operationId);
      if (cached) return Promise.resolve({ ...cached.result, repeated: true, operationId });
    }

    const controller = new AbortController();
    const method = adapter?.[command];
    if (typeof method !== 'function') {
      return Promise.reject(new Error(`${adapter?.id || '当前页面'} 暂不支持${command === 'send' ? '发送' : '等待'}。`));
    }

    const context = {
      ...payload,
      operationId,
      signal: controller.signal,
    };
    const promise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw abortError();
        return method.call(adapter, context);
      })
      .then((result) => {
        const value = result && typeof result === 'object' ? result : { value: result };
        const enriched = { ...value, operationId };
        if (command === 'send') {
          completedSends.set(operationId, { createdAt: Date.now(), result: enriched });
        }
        return enriched;
      })
      .catch((error) => {
        try { error.operationId ||= operationId; } catch {}
        throw error;
      })
      .finally(() => operations.delete(operationId));

    operations.set(operationId, { adapterId: adapter.id, controller, promise });
    return promise;
  }

  function okResponse(command, value) {
    if (command === 'inspect') return { ok: true, snapshot: value, data: value };
    return { ok: true, result: value, data: value };
  }

  function errorResponse(error) {
    return {
      ok: false,
      cancelled: error?.name === 'AbortError' || error?.code === 'cancelled',
      error: {
        code: String(error?.code || (error?.name === 'AbortError' ? 'cancelled' : 'content-error')),
        message: error?.message || String(error),
        stage: String(error?.stage || 'content'),
        recoverable: error?.recoverable !== false,
      },
      code: error?.code || (error?.name === 'AbortError' ? 'cancelled' : 'content-error'),
    };
  }

  function emitRelayEvent(command, adapter, value, error = null) {
    if (command !== 'send' && command !== 'wait') return;
    let event = '';
    if (error) event = 'FAILED';
    else if (command === 'wait' && value?.completed !== false) event = 'COMPLETED';
    else if (command === 'send') {
      const hasConcreteAck = Boolean(
        value?.userMessageId || value?.messageId || value?.insertedMessage || value?.userMessage
      );
      if (hasConcreteAck && value?.confirmed !== false && value?.sent !== false) event = 'USER_ACK';
      // Composer-cleared means the site accepted one click, but providers may
      // queue the user turn behind an existing generation. The delivery watcher
      // will confirm it later; this is not a failure event.
      else if (value?.submitted === true) return;
      else if (value?.confirmed === false || value?.sent === false) event = 'FAILED';
      else return;
    }
    if (!event) return;
    const operationId = String(value?.operationId || error?.operationId || '');
    const message = {
      type: 'RT_RELAY_EVENT',
      event,
      operationId,
      provider: adapter?.id || null,
      result: value || null,
    };
    if (error) {
      message.error = error?.message || String(error);
      message.code = error?.code || (error?.name === 'AbortError' ? 'cancelled' : 'content-error');
    }
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const command = normalizeCommand(message);
    if (!command) return undefined;

    const adapter = currentAdapter();
    const payload = messagePayload(message);

    if (command === 'ping') {
      sendResponse({
        ok: true,
        bridge: 'ai-roundtable-content',
        version: 1,
        provider: adapter?.id || null,
        capabilities: capabilities(adapter),
        url: location.href,
      });
      return undefined;
    }

    if (!adapter) {
      sendResponse({ ok: false, code: 'unsupported-page', error: '当前页面暂不支持。' });
      return undefined;
    }

    if (command === 'cancel') {
      sendResponse({ ok: true, ...cancelOperations(adapter, payload) });
      return undefined;
    }

    if (command === 'watch-delivery') {
      try {
        sendResponse({ ok: true, result: startDeliveryWatcher(adapter, payload) });
      } catch (error) {
        sendResponse(errorResponse(error));
      }
      return undefined;
    }

    const task = command === 'inspect'
      ? inspectWithCache(adapter, payload)
      : runOperation(command, adapter, payload);
    task
      .then((value) => {
        emitRelayEvent(command, adapter, value);
        sendResponse(okResponse(command, value));
      })
      .catch((error) => {
        emitRelayEvent(command, adapter, null, error);
        sendResponse(errorResponse(error));
      });
    return true;
  });

  const publicApi = { install, currentAdapter, createDomActivityMonitor };
  globalThis.RoundtableContent = publicApi;
  globalThis[BRIDGE_KEY] = { publicApi, operations };
})();
