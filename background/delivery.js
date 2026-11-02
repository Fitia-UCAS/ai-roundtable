'use strict';

// Delivery acknowledgement, bookmark commit, cancellation, and MV3 recovery.
function normalizeEventMessage(raw) {
  const clean = core.cleanMessages([raw])[0];
  if (!clean) return null;
  const explicitIndex = Number.isInteger(raw?.ordinal)
    ? raw.ordinal
    : Number.isInteger(raw?.index) ? raw.index : clean.index;
  return { ...clean, index: explicitIndex };
}

function migrateConversationKey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return false;
  const oldBookmark = workerState.runtimeState.bookmarks[oldKey];
  if (!oldBookmark) return false;
  const existing = workerState.runtimeState.bookmarks[newKey];
  // Only an idempotent copy for the same operation and the same message may
  // coexist. A matching operation id alone is not proof of identity: another
  // bookmark may carry a different message fingerprint under the same op.
  if (existing && (existing.lastOperationId !== oldBookmark.lastOperationId
    || !core.bookmarkIdentityCompatible(oldBookmark, existing))) {
    return false;
  }
  if (!existing) {
    workerState.runtimeState.bookmarks[newKey] = {
      ...oldBookmark,
      conversationKey: newKey,
    };
  }
  delete workerState.runtimeState.bookmarks[oldKey];
  return true;
}

function operationForBookmark(operationId) {
  if (!operationId) return null;
  if (workerState.runtimeState.activeOperation?.id === operationId) return workerState.runtimeState.activeOperation;
  if (workerState.runtimeState.lastOperation?.id === operationId) return workerState.runtimeState.lastOperation;
  const entry = (workerState.runtimeState.timeline || []).find((item) => item.operationId === operationId);
  if (!entry) return null;
  return {
    id: entry.operationId,
    target: {
      tabId: entry.targetTabId,
      conversation: entry.target || null,
    },
  };
}

async function acceptTargetMessage(operationId, senderTabId, payload = {}) {
  const operation = workerState.runtimeState.activeOperation;
  if (!operation || operation.id !== operationId) return { ignored: true };
  if (operation.target.tabId !== senderTabId) {
    throw codedError('EVENT_TAB_MISMATCH', '目标页面事件来自错误的标签页。', false);
  }
  if ([core.OPERATION_STATES.TARGET_ACKED,
    core.OPERATION_STATES.RESPONSE_CAPTURED].includes(operation.state)
    && operation.target?.insertedMessage) {
    return { duplicate: true };
  }

  const inserted = normalizeEventMessage(payload.insertedMessage);
  if (!inserted || inserted.role !== 'user') {
    throw codedError('INVALID_USER_ACK', '目标页面没有返回已插入的用户消息。');
  }
  const rawConversation = payload.conversation || operation.target.conversation;
  const returnedConversationId = String(
    payload.conversationId || rawConversation?.conversationId || ''
  );
  const targetProvider = rawConversation?.provider || operation.target.conversation?.provider;
  const returnedConversationKey = rawConversation?.conversationKey
    || (returnedConversationId && targetProvider
      ? `${targetProvider}:${returnedConversationId}`
      : operation.target.expectedConversationKey);
  const targetConversation = normalizeSnapshot({
    ...rawConversation,
    provider: targetProvider,
    providerName: rawConversation?.providerName || operation.target.conversation?.providerName,
    conversationId: returnedConversationId,
    conversationKey: returnedConversationKey,
    messages: rawConversation?.messages || [],
  });

  const previousKey = operation.target.expectedConversationKey;
  // The only expected key change is an unsaved new conversation receiving its
  // first message and acquiring a real server-side ID. Switching between two
  // existing threads must never ACK or move bookmarks.
  const newThreadKey = /^\w+:new:/.test(previousKey);
  const sendMeta = operation.target.sendResult || {};
  const sendInitialKey = String(sendMeta.initialConversationKey || previousKey || '');
  if (sendInitialKey && previousKey && sendInitialKey !== previousKey) {
    throw codedError('TARGET_CONVERSATION_CHANGED',
      '发送开始时目标对话与当前操作不一致；书签保持不变。');
  }
  if (previousKey && targetConversation.conversationKey !== previousKey) {
    if (!newThreadKey || sendMeta.conversationTransition !== 'new-to-real') {
      throw codedError('TARGET_CONVERSATION_CHANGED',
        '目标页面切换到了其他对话；无法确认这条消息送达原目标，书签保持不变。');
    }
  }
  if (previousKey && previousKey !== targetConversation.conversationKey
    && workerState.runtimeState.bookmarks[previousKey]) {
    const migrated = migrateConversationKey(previousKey, targetConversation.conversationKey);
    if (!migrated) {
      throw codedError('TARGET_BOOKMARK_CONFLICT',
        '目标正式会话已有其他操作的书签，本次不覆盖，也不推进书签。');
    }
  }

  const acked = transitionActive(core.OPERATION_STATES.TARGET_ACKED, {
    target: {
      conversation: conversationMeta(targetConversation),
      expectedConversationKey: targetConversation.conversationKey,
      insertedMessage: messageRef(inserted),
    },
  });
  if (operation.timings) {
    const totalMs = now() - operation.timings.startedAt;
    acked.timings = { ...operation.timings, ackMs: totalMs, totalMs };
    workerState.runtimeState.activeOperation.timings = acked.timings;
  }
  // Commit both bookmark updates and the sent receipt together.
  // A crash before this point leaves DISPATCHED to be reconciled safely.
  const sourceKey = acked.source.conversation.conversationKey;
  if (acked.source.endBookmark
    && workerState.runtimeState.bookmarks[sourceKey]?.lastOperationId !== acked.id) {
    workerState.runtimeState.bookmarks[sourceKey] = {
      ...acked.source.endBookmark,
      conversationKey: sourceKey,
      lastOperationId: acked.id,
      updatedAt: now(),
    };
  }

  const targetKey = targetConversation.conversationKey;
  const domInserted = (targetConversation.messages || []).find((message) => (
    message.role === 'user' && String(message.id || '') === String(inserted.id || '')
  )) || null;
  const bookmarkMessage = domInserted
    ? { ...inserted, text: domInserted.text, index: domInserted.index }
    : inserted;
  if (workerState.runtimeState.bookmarks[targetKey]?.lastOperationId !== acked.id) {
    workerState.runtimeState.bookmarks[targetKey] = {
      ...core.makeCursor(bookmarkMessage, bookmarkMessage.index, targetKey, {
        lastOperationId: acked.id,
        updatedAt: now(),
      }),
      ...(acked.payload?.text && inserted.role === 'user' ? {
        sentMessageHash: core.messageHash({ role: 'user', text: acked.payload.text }),
        sentSemanticHash: core.semanticHash(acked.payload.text),
        sentCompactHash: core.hashText(core.normalizeText(acked.payload.text).replace(/\s+/gu, '')),
      } : {}),
    };
  }

  // Delivery/bookmark commit is authoritative; an archive write must never undo it.
  try { await archiveConfirmedRelay(acked, inserted, targetConversation); }
  catch (error) { console.warn('[AI ROUND TABLE] archive write skipped', error); }
  await finalizeSentOperation();
  return { accepted: true, sent: true };
}

async function finalizeSentOperation() {
  const operation = workerState.runtimeState.activeOperation;
  if (!operation || !operation.target?.insertedMessage) return null;
  if (!['TARGET_ACKED', 'WAITING', 'SUSPENDED', 'UNCERTAIN', 'RESPONSE_CAPTURED']
    .includes(operation.state)) return null;

  // A relay is complete when the TARGET USER MESSAGE is confirmed. The recipient
  // may keep generating; the next manual relay reads its full answer from the page.
  const completed = transitionActive(core.OPERATION_STATES.COMPLETED);
  upsertTimeline(completed, {
    status: 'sent',
    completedAt: now(),
    error: null,
    ...(completed.timings ? { timings: completed.timings } : {}),
  });
  workerState.runtimeState.session = {
    ...workerState.runtimeState.session,
    suggestedSourceTabId: completed.target.tabId,
    updatedAt: now(),
  };
  workerState.selectedSourceTabId = completed.target.tabId;
  workerState.tabCache = workerState.tabCache.map((tab) => {
    if (tab.tabId === completed.source.tabId) {
      return { ...tab, freshCount: 0, preview: { count: 0, mode: 'no-new', text: '' } };
    }
    if (tab.tabId === completed.target.tabId) {
      return {
        ...tab,
        conversationKey: completed.target.expectedConversationKey || tab.conversationKey,
        // Do not display a cached answer: the next source inspection is authoritative.
        freshCount: 0,
        preview: { count: 0, mode: 'no-new', text: '' },
      };
    }
    return tab;
  });
  markLastAndClear(completed);
  await persistAndBroadcast();
  scheduleTabRefresh();
  return completed;
}

async function handleContentFailure(operationId, senderTabId, payload = {}) {
  const operation = workerState.runtimeState.activeOperation;
  if (!operation || operation.id !== operationId) return { ignored: true };
  if (operation.target.tabId !== senderTabId) {
    throw codedError('EVENT_TAB_MISMATCH', '失败事件来自错误的标签页。', false);
  }
  const error = codedError(
    payload.error?.code || payload.code || 'TARGET_FAILED',
    payload.error?.message || (typeof payload.error === 'string' ? payload.error : '')
      || payload.message || '目标页面执行失败。',
    payload.error?.recoverable !== false
  );
  await failActiveOperation(error);
  return { failed: true };
}

async function armDeliveryWatcher(operation = workerState.runtimeState.activeOperation) {
  if (!operation || !['DISPATCHED', 'WAITING', 'SUSPENDED', 'UNCERTAIN']
    .includes(operation.state)) return { watching: false };
  const response = await sendTabMessage(operation.target.tabId, {
    type: CONTENT_COMMANDS.WATCH_DELIVERY,
    operationId: operation.id,
    expectedConversationKey: operation.target.expectedConversationKey,
    probeIntervalMs: 1800,
  });
  if (response?.ok === false) {
    throw codedError(response?.error?.code || response?.code || 'WATCH_INSTALL_FAILED',
      response?.error?.message || response?.error || '目标页面无法启动送达监视。');
  }
  return unwrapContentResult(response);
}

async function handleDeliveryProbe(operationId, senderTabId, payload = {}) {
  const operation = workerState.runtimeState.activeOperation;
  if (!operation || operation.id !== operationId) return { ignored: true };
  if (operation.target.tabId !== senderTabId) {
    throw codedError('EVENT_TAB_MISMATCH', '送达监视来自错误的标签页。', false);
  }
  if (!['DISPATCHED', 'WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operation.state)) {
    return { ignored: true };
  }

  const snapshot = normalizeSnapshotOrNull(payload.snapshot, { id: senderTabId });
  if (!snapshot) return { watching: true, unreadable: true };
  const expectedKey = String(operation.target.expectedConversationKey || '');
  const changedExistingConversation = expectedKey && snapshot.conversationKey !== expectedKey
    && !/^\w+:new:/.test(expectedKey);
  if (changedExistingConversation) {
    await failActiveOperation(codedError('TARGET_CONVERSATION_CHANGED',
      '目标网页已切换到其他对话；本次未推进书签。', true, 'confirm'));
    return { failed: true, terminal: true };
  }

  const sendResult = operation.target.sendResult || {};
  const inserted = findInsertedUserMessage(snapshot, operation, sendResult);
  if (inserted) {
    await acceptTargetMessage(operationId, senderTabId, {
      conversation: snapshot,
      insertedMessage: inserted,
    });
    return { accepted: true, terminal: true };
  }
  if (hasContradictingUserMessage(snapshot, operation, sendResult)) {
    await failActiveOperation(codedError('DELIVERY_CONTRADICTED',
      '目标对话出现了另一条新用户消息，无法确认本次接力送达；书签保持不变。',
      true, 'confirm'));
    return { failed: true, terminal: true };
  }

  const previousGenerating = Boolean(operation.target.generating);
  if (operation.state !== core.OPERATION_STATES.WAITING) {
    transitionActive(core.OPERATION_STATES.WAITING, { error: null });
  }
  const active = workerState.runtimeState.activeOperation;
  active.target.awaitingConfirmation = true;
  active.target.generating = Boolean(snapshot.generating);
  active.target.lastProbeAt = now();
  active.updatedAt = now();
  if (previousGenerating !== active.target.generating || operation.state !== core.OPERATION_STATES.WAITING) {
    await persistAndBroadcast();
  }
  return { watching: true, generating: active.target.generating };
}

async function handleContentEvent(message, sender) {
  await ensureHydrated();
  const senderTabId = sender.tab?.id;
  if (!Number.isInteger(senderTabId)) {
    throw codedError('MISSING_SENDER_TAB', '内容事件缺少来源标签页。', false);
  }
  const event = message.type === 'RT_RELAY_EVENT'
    ? String(message.event || message.payload?.event || '').toUpperCase().replace(/[-.]/g, '_')
    : CONTENT_EVENT_TYPES.get(message.type);
  const operationId = String(message.operationId || message.payload?.operationId || '');
  const payload = message.payload?.data || message.payload || message.result || message.data || message;

  if (event === 'USER_ACK') {
    const operation = workerState.runtimeState.activeOperation;
    if (!operation || operation.id !== operationId) return { ignored: true };
    let snapshot = normalizeSnapshotOrNull(payload.snapshot, sender.tab);
    if (!snapshot) {
      snapshot = operation.target.conversation;
      try {
        snapshot = await inspectTab(senderTabId);
      } catch {
        // The native id returned by send is enough for a provisional bookmark.
      }
    }
    const insertedMessage = findInsertedUserMessage(snapshot, operation, payload);
    if (!insertedMessage) {
      throw codedError('SEND_NOT_ACKNOWLEDGED', '目标页面没有出现已发送的用户消息。');
    }
    return acceptTargetMessage(operationId, senderTabId, {
      conversation: snapshot,
      conversationId: payload.conversationId,
      insertedMessage,
    });
  }
  if (event === 'COMPLETED') {
    // Late completion notifications must not hold the relay open. If they also
    // contain a user ACK, it can reconcile an unconfirmed send.
    const operation = workerState.runtimeState.activeOperation;
    if (!operation || operation.id !== operationId) return { ignored: true };
    const snapshot = normalizeSnapshotOrNull(payload.snapshot, sender.tab);
    const inserted = findInsertedUserMessage(snapshot, operation, {
      ...(operation.target.sendResult || {}), ...payload,
    });
    if (inserted) return acceptTargetMessage(operationId, senderTabId, {
      conversation: snapshot || operation.target.conversation,
      insertedMessage: inserted,
    });
    return { ignored: true };
  }
  if (event === 'DELIVERY_PROBE') {
    return handleDeliveryProbe(operationId, senderTabId, payload);
  }
  if (event === 'FAILED') return handleContentFailure(operationId, senderTabId, payload);
  if (event === 'PROGRESS') {
    const operation = workerState.runtimeState.activeOperation;
    if (operation?.id === operationId && operation.target.tabId === senderTabId) {
      operation.progress = {
        textLength: Number(payload.textLength || 0),
        updatedAt: now(),
      };
      operation.target.waitStartedAt = now();
      operation.updatedAt = now();
      broadcastState();
    }
    return { accepted: true };
  }
  throw codedError('UNKNOWN_CONTENT_EVENT', `无法识别内容事件：${event || message.type}`);
}

async function cancelRelay(payload = {}) {
  await ensureHydrated();
  const operation = workerState.runtimeState.activeOperation;
  if (!operation) return { cancelled: false };
  if (payload.operationId && payload.operationId !== operation.id) {
    throw codedError('OPERATION_MISMATCH', '指定的接力已经不是当前操作。');
  }

  const deliveryUncertain = [
    core.OPERATION_STATES.DISPATCHED,
    core.OPERATION_STATES.WAITING,
    core.OPERATION_STATES.SUSPENDED,
    core.OPERATION_STATES.UNCERTAIN,
  ].includes(operation.state) && !operation.target.insertedMessage;
  const cancelSignal = sendTabMessage(operation.target.tabId, {
      type: CONTENT_COMMANDS.CANCEL,
      operationId: operation.id,
    }).catch(() => undefined);

  const cancelError = {
    code: 'OPERATION_CANCELLED',
    message: deliveryUncertain
      ? '本轮接力已停止；目标页面可能已经收到内容。'
      : '本轮接力已停止。',
    recoverable: true,
  };
  let cancelled;
  try {
    cancelled = transitionActive(core.OPERATION_STATES.CANCELLED, { error: cancelError });
  } catch {
    // RESPONSE_CAPTURED normally only finalizes, but an explicit force-stop must still clear busy.
    cancelled = {
      ...operation,
      state: core.OPERATION_STATES.CANCELLED,
      error: cancelError,
      updatedAt: now(),
    };
    workerState.runtimeState.activeOperation = cancelled;
  }
  upsertTimeline(cancelled, {
    status: 'cancelled',
    completedAt: now(),
    error: cancelled.error,
  });
  markLastAndClear(cancelled);
  // Clear the panel's busy state before waiting on storage or the page bridge.
  broadcastState();
  await persistState();
  void cancelSignal;
  return { cancelled: true, forced: Boolean(payload.force), deliveryUncertain };
}

async function findTabForConversation(conversationKey) {
  await refreshSupportedTabs({ force: true });
  const matches = workerState.tabCache.filter((tab) => tab.conversationKey === conversationKey && tab.online);
  return matches.length === 1 ? matches[0] : null;
}

async function recoverActiveOperation() {
  await ensureHydrated();
  if (await expireStaleOperation()) return { action: 'EXPIRED' };
  const operation = workerState.runtimeState.activeOperation;
  if (!operation) return { action: 'NONE' };
  if (['CAPTURING', 'PREPARED'].includes(operation.state)) {
    await failActiveOperation(codedError('OPERATION_INTERRUPTED',
      '发送前被中断，本次没有传递，可以重新发送。', true, 'recovery'));
    return { action: 'FAILED_SAFE' };
  }
  if (operation.target?.insertedMessage) {
    await finalizeSentOperation();
    return { action: 'CONFIRMED_SENT' };
  }
  // Never submit again in recovery: a suspended worker may have dispatched.
  try {
    let targetTabId = operation.target.tabId;
    try { await tabsGet(targetTabId); }
    catch {
      const rebound = await findTabForConversation(operation.target.expectedConversationKey);
      if (!rebound) throw codedError('TARGET_TAB_MISSING', '目标对话标签页已关闭。');
      targetTabId = rebound.tabId;
      operation.target.tabId = targetTabId;
    }
    const snapshot = await inspectTab(targetTabId);
    const inserted = findInsertedUserMessage(snapshot, operation, operation.target.sendResult || {});
    if (inserted) {
      if (operation.state === 'WAITING') {
        transitionActive(core.OPERATION_STATES.TARGET_ACKED);
      }
      await acceptTargetMessage(operation.id, targetTabId, {
        conversation: snapshot,
        insertedMessage: inserted,
      });
      return { action: 'CONFIRMED_SENT' };
    }
    if (hasContradictingUserMessage(snapshot, operation, operation.target.sendResult || {})) {
      await failActiveOperation(codedError('DELIVERY_CONTRADICTED',
        '目标对话出现了另一条新用户消息，无法确认本次接力送达；书签保持不变。',
        true, 'recovery'));
      return { action: 'DELIVERY_CONTRADICTED' };
    }
    if (operation.state !== core.OPERATION_STATES.WAITING) {
      transitionActive(core.OPERATION_STATES.WAITING, { error: null });
    }
    workerState.runtimeState.activeOperation.target.awaitingConfirmation = true;
    workerState.runtimeState.activeOperation.target.generating = Boolean(snapshot.generating);
    workerState.runtimeState.activeOperation.target.lastProbeAt = now();
    workerState.runtimeState.activeOperation.updatedAt = now();
    await persistAndBroadcast();
    await armDeliveryWatcher(workerState.runtimeState.activeOperation).catch(() => undefined);
    return { action: 'WAITING_CONFIRMATION' };
  } catch (error) {
    const current = workerState.runtimeState.activeOperation;
    if (current && current.state !== core.OPERATION_STATES.SUSPENDED) {
      transitionActive(core.OPERATION_STATES.SUSPENDED, {
        target: { awaitingConfirmation: true },
        error: {
          code: error?.code || 'TARGET_TEMPORARILY_UNAVAILABLE',
          message: '目标页面暂时无法读取；重新打开同一对话后会继续确认。',
          recoverable: true,
        },
      });
      await persistAndBroadcast();
    }
    return { action: 'SUSPENDED' };
  }
}

