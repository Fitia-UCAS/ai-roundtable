'use strict';

// Relay transaction state machine, delivery confirmation, and recovery.
function transitionActive(nextState, patch = {}) {
  const operation = workerState.runtimeState.activeOperation;
  if (!operation) throw codedError('NO_ACTIVE_OPERATION', '当前没有进行中的接力。');
  workerState.runtimeState.activeOperation = core.transitionOperation(operation, nextState, patch, now());
  return workerState.runtimeState.activeOperation;
}

function operationIsActive(operationId) {
  return Boolean(workerState.runtimeState?.activeOperation?.id === operationId);
}

function operationIsStale(operation, at = now()) {
  if (!operation || core.isTerminalOperationState(operation.state)) return false;
  const stageElapsed = at - Number(operation.updatedAt || operation.createdAt || at);
  if (['CAPTURING', 'PREPARED'].includes(operation.state)) {
    return stageElapsed > OPERATION_PREPARE_TIMEOUT_MS;
  }
  // Once a send may have happened, elapsed wall-clock time is not evidence of
  // failure. Some providers queue the user turn behind a long generation. The
  // operation remains recoverable until a matching receipt, counter-evidence,
  // or an explicit user cancellation arrives.
  return false;
}

async function expireStaleOperation() {
  const operation = workerState.runtimeState?.activeOperation;
  if (!operationIsStale(operation)) return false;
  // Only pre-send work expires. Once dispatch starts, elapsed time can never
  // prove non-delivery and recovery must use the target-page receipt watcher.
  await failActiveOperation(codedError('OPERATION_TIMEOUT',
    '发送前确认超时，本次没有传递，可以重新发送。', true, 'watchdog'));
  return true;
}

function cancelledRelayResult(operationId) {
  return { operationId, operationState: core.OPERATION_STATES.CANCELLED, cancelled: true };
}

function cleanSessionTitle(value) {
  const title = core.normalizeText(value)
    .replace(/\s*[-–—|·]\s*(?:ChatGPT|Google\s+Gemini|Gemini|DeepSeek).*$/i, '')
    .replace(/\s*[-–—|·]\s*(?:OpenAI|Google).*$/i, '')
    .trim();
  return Array.from(title || '新讨论').slice(0, 30).join('');
}

function maybeNameSessionFromSource(source) {
  const title = core.normalizeText(workerState.runtimeState?.session?.title || '');
  if (workerState.runtimeState.timeline.length
    || !['', 'AI 接力', 'AI 圆桌', 'AI ROUND TABLE', '新讨论'].includes(title)) return;
  workerState.runtimeState.session = {
    ...workerState.runtimeState.session,
    title: cleanSessionTitle(source?.title),
    updatedAt: now(),
  };
}

function upsertTimeline(operation, patch = {}) {
  const existing = workerState.runtimeState.timeline.find((item) => item.operationId === operation.id);
  const entry = {
    operationId: operation.id,
    index: existing?.index || workerState.runtimeState.timeline.length + 1,
    sessionId: operation.sessionId,
    source: conversationMeta(operation.source.conversation) || tabMeta(operation.source.tabId),
    target: conversationMeta(operation.target.conversation) || tabMeta(operation.target.tabId),
    sourceTabId: operation.source.tabId,
    targetTabId: operation.target.tabId,
    charCount: operation.payload.charCount || 0,
    status: patch.status || existing?.status || 'sending',
    startedAt: operation.createdAt,
    completedAt: patch.completedAt ?? existing?.completedAt ?? null,
    error: patch.error ?? existing?.error ?? null,
    ...patch,
  };
  // Persist receipt fingerprints and identities only, never source prompts or full answers.
  const receipt = receiptOnly(entry);
  workerState.runtimeState.timeline = core.upsertTimelineEntry(workerState.runtimeState.timeline, receipt)
    .slice(-MAX_TIMELINE_ENTRIES);
  workerState.runtimeState.session = { ...workerState.runtimeState.session, updatedAt: now() };
}

function markLastAndClear(operation) {
  workerState.runtimeState.lastOperation = operationWithoutContent(operation);
  workerState.runtimeState.activeOperation = null;
}

async function finishNoContent(message) {
  const operation = transitionActive(core.OPERATION_STATES.NO_CONTENT, {
    error: { code: 'NO_NEW_MESSAGES', message, recoverable: true },
  });
  markLastAndClear(operation);
  await persistAndBroadcast();
  return operation;
}

async function failActiveOperation(error, status = core.OPERATION_STATES.FAILED) {
  if (!workerState.runtimeState.activeOperation) return null;
  const data = errorData(error);
  let operation = workerState.runtimeState.activeOperation;
  if (!core.isTerminalOperationState(operation.state)) {
    operation = transitionActive(status, { error: data });
  }
  upsertTimeline(operation, {
    status: status === core.OPERATION_STATES.UNCERTAIN ? 'uncertain' : 'error',
    error: data,
    completedAt: status === core.OPERATION_STATES.UNCERTAIN ? null : now(),
  });
  if (status !== core.OPERATION_STATES.UNCERTAIN
    && status !== core.OPERATION_STATES.SUSPENDED) markLastAndClear(operation);
  await persistAndBroadcast();
  return operation;
}

function assertRelayTabs(sourceTabId, targetTabId) {
  if (!Number.isInteger(sourceTabId) || !Number.isInteger(targetTabId)) {
    throw codedError('INVALID_TAB', '请选择来源和目标 AI 标签页。');
  }
  if (sourceTabId === targetTabId) {
    throw codedError('SAME_TAB', '来源和目标不能是同一个标签页。');
  }
}

async function startRelay(payload = {}) {
  await ensureHydrated();
  await expireStaleOperation();
  if (workerState.runtimeState.activeOperation
    && !core.isTerminalOperationState(workerState.runtimeState.activeOperation.state)) {
    throw codedError('BUSY', '上一轮接力还没有结束。');
  }

  const sourceTabId = Number(payload.sourceTabId);
  const targetTabId = Number(payload.targetTabId);
  assertRelayTabs(sourceTabId, targetTabId);

  const operation = core.createRelayOperation({
    id: randomId('op'),
    sessionId: workerState.runtimeState.session.id,
    sourceTabId,
    targetTabId,
    now: now(),
  });
  workerState.runtimeState.activeOperation = operation;
  const relayStartedAt = now();
  workerState.runtimeState.activeOperation.timings = { startedAt: relayStartedAt };
  await persistAndBroadcast();

  try {
    // A fresh DeepSeek conversation updates its URL only after the first
    // message. Pass the known id so the content script can wait briefly for the
    // SPA route instead of treating the page as a different/new conversation.
    const expectedSourceConversationId = conversationIdFromKey(payload.expectedSourceConversationKey);
    const expectedBookmarkKey = payload.expectedSourceConversationKey
      || workerState.tabCache.find((tab) => tab.tabId === sourceTabId)?.conversationKey
      || '';
    const expectedBookmark = expectedBookmarkKey
      ? workerState.runtimeState.bookmarks[expectedBookmarkKey] || null
      : null;
    const sourceStartedAt = now();
    const source = await inspectTab(sourceTabId, {
      expectedConversationId: expectedSourceConversationId, relayRead: true, relayOperationId: operation.id,
      relayBookmark: expectedBookmark, force: true,
    });
    if (!operationIsActive(operation.id)) return cancelledRelayResult(operation.id);
    workerState.runtimeState.activeOperation.timings.sourceInspectMs = now() - sourceStartedAt;
    if (payload.expectedSourceConversationKey && source.conversationKey !== payload.expectedSourceConversationKey) {
      throw codedError('SOURCE_CONVERSATION_CHANGED',
        '来源对话已经变化；本次未发送，请重新检测网页后核对来源。');
    }
    if (source.generating) {
      throw codedError('SOURCE_GENERATING', `${source.providerName} 仍在回答，请稍后再发送。`);
    }
    const instruction = core.bodyText(payload.instruction || '');
    const sourceBookmark = workerState.runtimeState.bookmarks[source.conversationKey] || null;
    const planStartedAt = now();
    const plan = core.getRelayPlan(source.messages, sourceBookmark, source.conversationKey);
    workerState.runtimeState.activeOperation.timings.planMs = now() - planStartedAt;
    if (plan.kind === 'invalid-cursor' && source.truncated) {
      throw codedError('SOURCE_TRUNCATED',
        '来源网页当前只挂载了部分历史消息，书签未出现在页面上。请手动滚动到书签附近后重新检测网页，不会自动深度滚动。');
    }
    if (plan.kind === 'invalid-cursor') {
      const message = plan.reason === 'ambiguous'
        ? '来源对话中有多条内容相同的消息，无法确认书签对应哪条，本次未发送。请从更早、可唯一识别的 AI 回答重新选择起点。'
        : plan.reason === 'conversation-mismatch'
          ? '来源书签属于另一条对话，本次未发送。请确认当前来源对话并重新选择起点。'
          : '来源书签尚未与本次读取的完整历史对齐，本次未发送。请等待网页加载完成后，在所需 AI 回答下方重新选择书签。';
      throw codedError(
        'BOOKMARK_STALE',
        message,
      );
    }
    const relayMessages = plan.kind === 'invalid-cursor' ? [] : plan.messages;
    if (!relayMessages.length) {
      if (!instruction) {
        await finishNoContent('当前对话没有可接力的完整新增内容。');
        return { operationId: operation.id, operationState: core.OPERATION_STATES.NO_CONTENT };
      }
      throw codedError(
        'NO_NEW_MESSAGES',
        '来源没有新增的完整 AI 回答，本次未发送。请等待新回答，或在来源网页点击其他 AI 回答下方的书签。',
      );
    }

    const targetStartedAt = now();
    const target = await inspectTab(targetTabId);
    if (!operationIsActive(operation.id)) return cancelledRelayResult(operation.id);
    workerState.runtimeState.activeOperation.timings.targetInspectMs = now() - targetStartedAt;
    if (payload.expectedTargetConversationKey && target.conversationKey !== payload.expectedTargetConversationKey) {
      throw codedError('TARGET_CONVERSATION_CHANGED',
        '目标对话已经变化；本次未发送，请重新检测网页后核对目标。');
    }
    if (target.generating) {
      throw codedError('TARGET_GENERATING', `${target.providerName} 仍在回答，请稍后再发送。`);
    }
    if (source.conversationKey === target.conversationKey) {
      throw codedError('SAME_CONVERSATION', '来源和目标不能是同一条对话。');
    }

    // The other tab can take long enough to inspect that the user navigates
    // away from the source. Capture the entire source from ONE stable thread.
    const sourceRecheckStartedAt = now();
    const sourceRecheck = await inspectTab(sourceTabId, { relayRecheckId: source.relayReadId, force: true });
    if (!operationIsActive(operation.id)) return cancelledRelayResult(operation.id);
    workerState.runtimeState.activeOperation.timings.sourceRecheckMs = now() - sourceRecheckStartedAt;
    if (sourceRecheck.conversationKey !== source.conversationKey
      || sourceRecheck.revision !== source.revision || sourceRecheck.generating) {
      throw codedError('SOURCE_CONVERSATION_CHANGED',
        '来源网页在读取过程中发生变化；本次未发送，请确认当前对话后重试。');
    }

    const relayBody = relayMessages.length
      ? core.formatRelayMessages(relayMessages, source.providerName)
      : '';
    const relayText = relayBody && instruction
      ? `${relayBody}\n\n用户补充：\n${instruction}`
      : relayBody || instruction;
    if (!relayText) throw codedError('NO_NEW_MESSAGES', '没有可发送的内容。');
    if (relayText.length > MAX_RELAY_CHARACTERS) {
      throw codedError('CONTENT_TOO_LARGE', '本次新增内容过长，请缩小书签范围后再试。');
    }

    const endCursor = relayMessages.length && plan.endCursor ? {
      ...plan.endCursor,
      lastOperationId: operation.id,
      updatedAt: now(),
    } : null;
    maybeNameSessionFromSource(source);
    const prepareStartedAt = now();
    transitionActive(core.OPERATION_STATES.PREPARED, {
      source: {
        conversation: conversationMeta(source),
        snapshotRevision: source.revision,
        startBookmark: sourceBookmark,
        messageRefs: relayMessages.map(messageRef),
        capturedMessages: relayMessages.map((m, index) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          messageHash: core.messageHash(m),
          messageIndex: Number.isInteger(m.index) ? m.index : index,
          timestamp: Number.isFinite(m.timestamp) ? m.timestamp : null,
        })),
        instruction,
        fullSnapshot: activeSaveMode() === 'full' ? source : null,
        endBookmark: endCursor,
      },
      target: {
        conversation: conversationMeta(target),
        expectedConversationKey: target.conversationKey,
        baselineRevision: target.revision,
        baselineLastMessage: messageRef(target.messages[target.messages.length - 1]),
        baselineMessageIds: target.messages.map((message) => String(message.id || '')).filter(Boolean),
        baselineMessageKeys: target.messages.map((message) =>
          `${message.id || ''}|${message.role || ''}|${core.hashText(message.text || '')}`),
        baselineFingerprints: target.messages.map((message) =>
          `${message.role}|${core.semanticHash(message.text)}`),
      },
      payload: {
        text: relayText,
        hash: core.hashText(relayText),
        semanticHash: core.semanticHash(relayText),
        prefixHash: core.hashText(core.semanticText(relayText).slice(0, 80)),
        compactHash: core.hashText(core.normalizeText(relayText).replace(/\s+/gu, '')),
        reflowSignature: core.reflowSignature(relayText),
        charCount: relayText.length,
      },
    });
    workerState.runtimeState.activeOperation.timings.prepareMs = now() - prepareStartedAt;
    upsertTimeline(workerState.runtimeState.activeOperation, { status: 'sending' });
    await persistAndBroadcast();
    if (!operationIsActive(operation.id)) return cancelledRelayResult(operation.id);

    let active = workerState.runtimeState.activeOperation;
    const focusStartedAt = now();
    try {
      const activated = await tabsUpdate(targetTabId, { active: true });
      workerState.activeTabId = targetTabId;
      if (Number.isInteger(activated?.windowId)) {
        try {
          await windowsUpdate(activated.windowId, { focused: true });
        } catch {}
      }
      await delay(180);
    } catch {
      // The content bridge can still try the send if Edge refuses to focus the tab.
    }
    if (!operationIsActive(active.id)) return cancelledRelayResult(active.id);
    workerState.runtimeState.activeOperation.timings.focusMs = now() - focusStartedAt;
    // Focus and route transitions may change the intended destination.
    const recheckStartedAt = now();
    const targetRecheck = await inspectTab(targetTabId);
    if (!operationIsActive(active.id)) return cancelledRelayResult(active.id);
    workerState.runtimeState.activeOperation.timings.targetRecheckMs = now() - recheckStartedAt;
    if (targetRecheck.conversationKey !== active.target.expectedConversationKey
      || targetRecheck.revision !== active.target.baselineRevision) {
      throw codedError('TARGET_CONVERSATION_CHANGED',
        '目标网页已切换对话或新增消息；本次未发送，请重新检测网页确认目标。');
    }
    // Mark the operation as possibly sent only after the last target check and
    // immediately before the one allowed submission. This minimizes the crash
    // window in which recovery must conservatively wait instead of resending.
    active = transitionActive(core.OPERATION_STATES.DISPATCHED);
    active.deadlineAt = now() + 15000;
    await persistAndBroadcast();
    if (!operationIsActive(active.id)) return cancelledRelayResult(active.id);
    const dispatchStartedAt = now();
    const response = await sendTabMessage(targetTabId, {
      type: CONTENT_COMMANDS.DISPATCH,
      version: core.PROTOCOL_VERSION,
      operationId: active.id,
      sessionId: active.sessionId,
      prompt: active.payload.text,
      promptHash: active.payload.hash,
      expectedConversationKey: active.target.expectedConversationKey,
      sendTimeoutMs: Math.max(1000, Number(active.deadlineAt) - now()),
      baseline: {
        revision: active.target.baselineRevision,
        lastMessage: active.target.baselineLastMessage,
        conversationKey: active.target.expectedConversationKey,
        generating: Boolean(target.generating),
        messageIds: target.messages
          .map((message) => String(message.id || ''))
          .filter(Boolean),
        messageKeys: target.messages
          .map((message) => `${message.id || ''}|${message.role || ''}|${core.hashText(message.text || '')}`),
        messageCount: target.messages.length,
      },
    });

    if (!workerState.runtimeState.activeOperation || workerState.runtimeState.activeOperation.id !== active.id) {
      return { operationId: active.id, operationState: core.OPERATION_STATES.CANCELLED };
    }

    if (!response) {
      throw codedError('EMPTY_DISPATCH_RESPONSE', '目标页面没有确认发送结果。');
    }

    const sendResult = unwrapContentResult(response);
    workerState.runtimeState.activeOperation.timings.dispatchMs = now() - dispatchStartedAt;
    workerState.runtimeState.activeOperation.timings.sendConfirmMs =
      Number(sendResult?.timings?.confirmMs) || null;
    if (response?.ok === false || sendResult?.accepted === false
      || (sendResult?.submitted === false && !sendResult?.confirmed && !sendResult?.sent)) {
      throw codedError(
        response?.error?.code || response?.code || 'DISPATCH_REJECTED',
        response?.error?.message || response?.error || sendResult?.error || '目标页面拒绝了本次发送。'
      );
    }

    workerState.runtimeState.activeOperation.target.sendResult = sendResultMeta(sendResult);
    await persistState();

    const sendSnapshot = normalizeSnapshotOrNull(sendResult.snapshot, {
      id: targetTabId,
      url: target.url,
      title: target.title,
    });
    const confirmedTarget = sendSnapshot || target;
    let insertedMessage = findInsertedUserMessage(confirmedTarget, active, sendResult);
    if (insertedMessage) {
      await acceptTargetMessage(active.id, targetTabId, {
        conversation: {
          ...confirmedTarget,
          conversationId: sendResult.conversationId || confirmedTarget.conversationId,
          conversationKey: sendResult.conversationKey || confirmedTarget.conversationKey,
        },
        insertedMessage,
      });
    }
    if (!insertedMessage && hasContradictingUserMessage(confirmedTarget, active, sendResult)) {
      await failActiveOperation(codedError('DELIVERY_CONTRADICTED',
        '目标对话出现了另一条新用户消息，无法确认本次接力送达；书签保持不变。',
        true, 'confirm'));
      return { operationId: active.id, operationState: 'FAILED', deliveryContradicted: true };
    }
    if (!insertedMessage && workerState.runtimeState.activeOperation?.id === active.id) {
      transitionActive(core.OPERATION_STATES.WAITING, {
        target: {
          awaitingConfirmation: true,
          generating: Boolean(confirmedTarget.generating),
          waitStartedAt: now(),
          lastProbeAt: now(),
        },
        error: null,
      });
      upsertTimeline(workerState.runtimeState.activeOperation, {
        status: 'waiting-confirmation',
        completedAt: null,
        error: null,
      });
      await persistAndBroadcast();
      await armDeliveryWatcher(workerState.runtimeState.activeOperation).catch(() => undefined);
      return {
        operationId: active.id,
        operationState: core.OPERATION_STATES.WAITING,
        sent: true,
        awaitingConfirmation: true,
      };
    }

    return { operationId: active.id, operationState: 'COMPLETED', sent: true };
  } catch (error) {
    if (!operationIsActive(operation.id)) return cancelledRelayResult(operation.id);
    const state = workerState.runtimeState.activeOperation.state;
    const ambiguousDelivery = state === core.OPERATION_STATES.DISPATCHED && (
      error?.code === 'EMPTY_DISPATCH_RESPONSE'
      || /port closed|channel closed|response|receiving end|could not establish connection/i
        .test(error?.message || '')
    );
    await failActiveOperation(ambiguousDelivery
      ? codedError('DELIVERY_UNCERTAIN',
        '发送通道中断，目标可能已经收到内容；未推进书签，请先检查目标对话，不要直接重发。',
        true, 'dispatch')
      : error);
    throw error;
  }
}

