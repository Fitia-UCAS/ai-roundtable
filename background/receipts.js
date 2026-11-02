'use strict';

// Pure delivery evidence checks, shared by dispatch, page probes, and recovery.
function deliveryWindow(snapshot, operation, sendResult = {}) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const baselineIds = new Set([
    ...(operation.target.baselineMessageIds || []), ...(sendResult.baselineMessageIds || []),
    operation.target.baselineLastMessage?.id,
  ].filter(Boolean).map(String));
  const baselineKeys = new Set([
    ...(operation.target.baselineMessageKeys || []), ...(sendResult.baselineMessageKeys || []),
  ].map(String));
  const fingerprints = new Set(operation.target.baselineFingerprints || []);
  const isPriorTurn = (message) => baselineIds.has(String(message.id || ''))
    || baselineKeys.has(`${message.id || ''}|${message.role}|${core.hashText(message.text || '')}`)
    || fingerprints.has(`${message.role}|${core.semanticHash(message.text)}`);
  const before = operation.target.baselineLastMessage;
  // A remounted history window is not evidence of new input. Establish order
  // against the last pre-send turn, allowing its id to change on a DOM redraw.
  const anchors = messages.map((message, index) => ({ message, index })).filter(({ message }) => (
    before && message.role === before.role
    && (before.hash ? core.messageHash(message) === before.hash : before.id && message.id === before.id)
  ));
  const beforeIndex = anchors.length === 1 ? anchors[0].index : -1;
  const freshUsers = messages.filter((message, index) => message.role === 'user'
    && (beforeIndex < 0 || index > beforeIndex) && !isPriorTurn(message));
  return { messages, baselineIds, baselineKeys, isPriorTurn, beforeIndex, freshUsers };
}

function findInsertedUserMessage(snapshot, operation, sendResult = {}) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const direct = sendResult.insertedMessage || sendResult.userMessage;
  // Native adapter ACKs are evidence only when they identify this exact turn.
  // Rich-text user bubbles sometimes flatten newline/paragraph whitespace.
  const expectedHash = String(operation.payload?.hash || core.hashText(operation.payload?.text || ''));
  const expectedSemanticHash = String(operation.payload?.semanticHash
    || core.semanticHash(operation.payload?.text || ''));
  const geminiReflow = snapshot?.provider === 'gemini' && sendResult.submitted === true;
  const sameContent = (message) => Boolean(message?.role === 'user' && (
    core.hashText(message.text || '') === expectedHash
    || (expectedSemanticHash && core.semanticHash(message.text) === expectedSemanticHash)
    || (geminiReflow && (operation.payload?.text
      ? core.reflowEquivalent(operation.payload.text, message.text)
      : core.reflowMatchesSignature(operation.payload?.reflowSignature, message.text)))
  ));
  const { baselineIds, baselineKeys, isPriorTurn, beforeIndex, freshUsers }
    = deliveryWindow(snapshot, operation, sendResult);
  const semantic = (value) => core.semanticText(value || '');
  const validCollapsed = (message) => {
    if (message?.role !== 'user' || !sendResult.confirmed
      || sendResult.confirmation !== 'user-message'
      || sendResult.matchType !== 'collapsed-preview'
      || sendResult.collapsedEvidence !== true
      || message.folded !== true) return false;
    const displayed = semantic(message.text).replace(/(?:…|\.\.\.|\.\.．)$/u, '');
    const expected = semantic(operation.payload?.text);
    return expected.length >= 120 && displayed.length >= 80
      && displayed.length < expected.length && expected.startsWith(displayed);
  };
  const expectedId = String(sendResult.userMessageId || sendResult.messageId || '');
  const byId = expectedId
    ? messages.find((message) => message.role === 'user' && message.id === expectedId)
    : null;
  const hasBaselineOverlap = messages.some(isPriorTurn);
  const exactFresh = freshUsers.filter(sameContent);
  // A long user turn can be mounted as a collapsed preview, so its tail never
  // matches. Only a meaningful prefix of the exact relay payload counts.
  const expectedText = semantic(operation.payload?.text);
  const expectedPrefixHash = String(operation.payload?.prefixHash || '');
  const foldedFresh = expectedText.length >= 80 ? freshUsers.filter((message) => {
    const displayed = semantic(message.text).replace(/(?:…|\.\.\.|\.\.．)$/u, '');
    return message.folded === true && displayed.length >= 80 && displayed.length < expectedText.length
      && expectedText.startsWith(displayed);
  }) : expectedPrefixHash ? freshUsers.filter((message) => {
    const displayed = semantic(message.text).replace(/(?:…|\.\.\.|\.\.．)$/u, '');
    return message.folded === true && displayed.length >= 80
      && core.hashText(displayed.slice(0, 80)) === expectedPrefixHash;
  }) : [];
  const contradictingFresh = freshUsers.filter((message) => (
    beforeIndex >= 0 && !sameContent(message) && !validCollapsed(message) && !foldedFresh.includes(message)
  ));

  // The DOM message carrying the acknowledged id is authoritative. If it
  // exists and its content contradicts the expected payload, do not synthesize
  // a success receipt from the adapter's "exact" flag.
  if (byId && !isPriorTurn(byId)) {
    if (sameContent(byId) || validCollapsed(byId)
      || (sendResult.submitted === true && foldedFresh.includes(byId))) return byId;
    return null;
  }

  if (direct && !isPriorTurn(direct)) {
    const directDom = messages.find((message) => (
      message.role === 'user' && message.id === direct.id
    ));
    if (directDom) {
      if (sameContent(directDom) || validCollapsed(directDom)) return directDom;
      return null;
    }
    if (sameContent(direct) || validCollapsed(direct)) {
      if (contradictingFresh.length && !exactFresh.length) return null;
      return direct;
    }
  }

  if (exactFresh.length === 1
    && (hasBaselineOverlap || sendResult.submitted === true
      || (!baselineIds.size && !baselineKeys.size))) {
    return exactFresh[0];
  }
  if (exactFresh.length > 1) return null;
  // An unrelated new user turn is explicit counter-evidence: do not let an
  // adapter receipt synthesize a different message over it.
  if (contradictingFresh.length) return null;
  if (foldedFresh.length === 1 && sendResult.submitted === true && beforeIndex >= 0) {
    return { ...foldedFresh[0], folded: true };
  }

  if (expectedId && !baselineIds.has(expectedId)
    && sendResult.confirmation === 'user-message' && sendResult.confirmed) {
    if (sendResult.matchType === 'exact') {
      return {
        id: expectedId,
        role: 'user',
        text: operation.payload.text || '',
        index: messages.length,
        complete: true,
      };
    }
    if (sendResult.matchType === 'collapsed-preview' && validCollapsed(direct)) {
      return {
        id: expectedId,
        role: 'user',
        text: operation.payload.text || '',
        index: messages.length,
        complete: true,
        folded: true,
      };
    }
  }
  return null;
}

function hasContradictingUserMessage(snapshot, operation, sendResult = {}) {
  if (findInsertedUserMessage(snapshot, operation, sendResult)) return false;
  const { freshUsers, beforeIndex } = deliveryWindow(snapshot, operation, sendResult);
  const expectedId = String(sendResult.userMessageId || sendResult.messageId || '');
  const expected = core.semanticText(operation.payload?.text || '');
  const compactExpected = String(operation.payload?.compactHash || '');
  return freshUsers.some((message) => {
    if (beforeIndex < 0 && (!expectedId || message.id !== expectedId)) return false;
    // A folded/partially mounted bubble is inconclusive, not another user.
    const displayed = core.semanticText(message.text).replace(/(?:…|\.\.\.)$/u, '');
    if (message.folded || (displayed && expected.startsWith(displayed))) return false;
    // A Gemini bubble can mount with all paragraph breaks removed. If its
    // entire non-whitespace body matches the outgoing payload, wait for a
    // stronger receipt instead of falsely declaring a different user turn.
    if (snapshot?.provider === 'gemini' && compactExpected
      && core.compactHash(message.text) === compactExpected) return false;
    return true;
  });
}

