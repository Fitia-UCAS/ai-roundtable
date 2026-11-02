'use strict';

// Reconcile a legacy WAITING operation at the user's request. This is the
// only path that reads target history when its DOM folds the sent user bubble.
async function verifyDeliveredRelay(payload = {}) {
  await ensureHydrated();
  const operation = workerState.runtimeState.activeOperation;
  if (!operation || (payload.operationId && payload.operationId !== operation.id)
    || !['WAITING', 'SUSPENDED', 'UNCERTAIN'].includes(operation.state)) {
    throw codedError('OPERATION_MISMATCH', '当前没有可核对的等待接力。');
  }
  if (operation.target?.conversation?.provider !== 'gemini'
    || operation.target?.sendResult?.submitted !== true) {
    throw codedError('DELIVERY_NOT_SUBMITTED', '目标页面尚无可核对的 Gemini 发送记录。');
  }
  const expectedHash = String(operation.payload?.compactHash || '');
  if (!expectedHash) throw codedError('DELIVERY_HASH_MISSING', '这条接力缺少正文指纹，无法安全核对。');

  const candidateIn = (snapshot) => {
    const expectedKey = String(operation.target.expectedConversationKey || '');
    if (snapshot.conversationKey !== expectedKey && !/^\w+:new:/.test(expectedKey)) return null;
    const { freshUsers } = deliveryWindow(snapshot, operation, operation.target.sendResult);
    const matching = freshUsers.filter((message) => message.complete !== false
      && core.compactHash(message.text) === expectedHash);
    return matching.length === 1 ? matching[0] : null;
  };
  let snapshot = await inspectTab(operation.target.tabId, { force: true });
  let candidate = candidateIn(snapshot);
  if (!candidate) {
    snapshot = await inspectTab(operation.target.tabId, { relayRead: true, force: true });
    candidate = candidateIn(snapshot);
  }
  if (!candidate) {
    throw codedError('DELIVERY_STILL_UNCONFIRMED',
      '目标对话中尚未找到唯一且正文完整一致的新用户消息；书签未移动，也没有重新发送。');
  }
  await acceptTargetMessage(operation.id, operation.target.tabId, {
    conversation: snapshot,
    insertedMessage: candidate,
  });
  return { verified: true, operationId: operation.id };
}
