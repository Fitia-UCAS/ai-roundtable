(function installRelayHistory(root) {
  'use strict';
  const core = root.RoundtableCore;
  const error = (message) => Object.assign(new Error(message), { code: 'SOURCE_HISTORY_UNAVAILABLE' });

  function attachIdentity(target, dom) {
    target.contentAliases = [...new Set([
      ...(target.contentAliases || []),
      core.messageHash(dom),
      ...(dom.contentAliases || []),
    ])];
    // The page DOM is the view the user actually bookmarked. Its rendered
    // fingerprints win over the API projection so the stored bookmark can be
    // found even when Markdown serialization differs slightly.
    if (dom.renderedHash) target.renderedHash = String(dom.renderedHash);
    if (dom.renderedCompactHash) {
      target.renderedCompactHash = String(dom.renderedCompactHash);
    }
  }

  function matchesAt(messages, index, dom) {
    if (!messages[index]) return false;
    return core.findCursorIndex([messages[index]], core.makeCursor(dom, 0, '')).index === 0;
  }

  function mergeIdentities(history, mounted) {
    const messages = history.map(root.RoundtableMarkdownIdentity.annotate);
    const domList = (mounted || []).filter((message) => message
      && (message.role === 'user' || message.role === 'assistant') && message.text);
    const anchors = new Map(); // DOM index -> API index
    const used = new Set();

    // Pass 1 (ordered): exact/fingerprint identity.
    let from = 0;
    domList.forEach((dom, domIndex) => {
      for (let index = from; index < messages.length; index += 1) {
        if (used.has(index)) continue;
        if (!matchesAt(messages, index, dom)) continue;
        anchors.set(domIndex, index);
        used.add(index);
        attachIdentity(messages[index], dom);
        from = index + 1;
        return;
      }
    });

    // Pass 2: whole-body identity ignoring whitespace and invisible format
    // characters. This recovers messages whose API Markdown and DOM
    // serialization disagree on line breaks. Candidates stay between the
    // nearest anchored neighbours so the final mapping remains monotonic.
    domList.forEach((dom, domIndex) => {
      if (anchors.has(domIndex) || dom.role !== 'assistant' || !dom.renderedCompactHash) return;
      let lower = -1;
      for (let index = domIndex - 1; index >= 0; index -= 1) {
        if (!anchors.has(index)) continue;
        lower = anchors.get(index);
        break;
      }
      let upper = messages.length;
      for (let index = domIndex + 1; index < domList.length; index += 1) {
        if (!anchors.has(index)) continue;
        upper = anchors.get(index);
        break;
      }
      const candidates = [];
      for (let index = lower + 1; index < upper; index += 1) {
        if (used.has(index)) continue;
        if (messages[index].role !== dom.role) continue;
        if (messages[index].renderedCompactHash !== dom.renderedCompactHash
          && !messages[index].renderedCompactAliases?.includes(dom.renderedCompactHash)) continue;
        candidates.push(index);
      }
      if (candidates.length !== 1) return;
      const index = candidates[0];
      anchors.set(domIndex, index);
      used.add(index);
      attachIdentity(messages[index], dom);
    });

    // Pass 3: fill gaps only when the number of API messages and mounted DOM
    // messages between two anchors is identical and every role lines up.
    const ordered = [...anchors.entries()].sort((left, right) => left[0] - right[0]);
    function fill(domStart, domEnd, apiStart, apiEnd) {
      const domIndexes = [];
      for (let index = domStart; index < domEnd; index += 1) {
        if (!anchors.has(index)) domIndexes.push(index);
      }
      const apiIndexes = [];
      for (let index = apiStart; index < apiEnd; index += 1) {
        if (!used.has(index)) apiIndexes.push(index);
      }
      if (domIndexes.length !== apiIndexes.length) return;
      if (domIndexes.some((domIndex, offset) => (
        messages[apiIndexes[offset]]?.role !== domList[domIndex].role
      ))) return;
      domIndexes.forEach((domIndex, offset) => {
        const apiIndex = apiIndexes[offset];
        anchors.set(domIndex, apiIndex);
        used.add(apiIndex);
        attachIdentity(messages[apiIndex], domList[domIndex]);
      });
    }
    let previousDom = -1;
    let previousApi = -1;
    for (const [domIndex, apiIndex] of ordered) {
      fill(previousDom + 1, domIndex, previousApi + 1, apiIndex);
      previousDom = domIndex;
      previousApi = apiIndex;
    }
    fill(previousDom + 1, domList.length, previousApi + 1, messages.length);
    if (!ordered.length && domList.length === messages.length) {
      fill(0, domList.length, 0, messages.length);
    }
    return messages;
  }

  function create({ readDom, readHistory, getKey, isGenerating }) {
    let capture = null;
    let inFlight = null;
    let blockedUntil = 0;
    const revision = (messages) => core.conversationRevision(messages);
    function validate(id, mounted) {
      if (!capture || capture.id !== id || capture.key !== getKey()
        || Date.now() - capture.at > 30000 || isGenerating()
        || revision(mounted) !== capture.domRevision) {
        throw error('来源网页在读取后发生变化，请重新发送。');
      }
      return capture.snapshot;
    }
    // When the API list and the mounted DOM cannot be reconciled, the mounted
    // list is a safe source only if it reaches the same last message as the
    // complete history. It is exactly what the user sees, and it contains the
    // bookmark that the page itself marks as selected.
    function mountedFallback(merged, mounted, bookmark) {
      if (!bookmark || core.findCursorIndex(merged, bookmark).index >= 0) return null;
      if (core.findCursorIndex(mounted, bookmark).index < 0) return null;
      // Returning only the mounted tail would silently omit unmounted turns.
      // Use the DOM list only when it covers the whole API message sequence.
      if (mounted.length !== merged.length
        || mounted.some((message, index) => message.role !== merged[index].role)) return null;
      const lastHistory = merged[merged.length - 1];
      const lastMounted = mounted[mounted.length - 1];
      if (!lastHistory || !lastMounted) return null;
      const reachesEnd = core.findCursorIndex(
        [lastHistory], core.makeCursor(lastMounted, 0, ''),
      ).index === 0;
      if (!reachesEnd) return null;
      return mounted.map((message) => ({ ...message }));
    }
    async function read(options, mounted) {
      if (options.relayRecheckId) return validate(options.relayRecheckId, mounted);
      const id = String(options.relayOperationId || `read-${Date.now()}`);
      if (capture?.id === id) return validate(id, mounted);
      if (inFlight) return inFlight;
      if (Date.now() < blockedUntil) throw error(`历史接口正在冷却，请约 ${Math.ceil((blockedUntil - Date.now()) / 1000)} 秒后重试。`);
      const key = getKey();
      const domRevision = revision(mounted);
      if (isGenerating()) throw error('来源仍在回答，请等它完成后再发送。');
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 15000);
      options.signal?.addEventListener('abort', abort, { once: true });
      inFlight = (async () => {
        try {
          if (options.signal?.aborted) abort();
          const snapshot = await readHistory(controller.signal);
          if (getKey() !== key || revision(readDom()) !== domRevision || isGenerating()) {
            throw error('读取完整历史时来源网页发生变化，本次未发送。');
          }
          if (!snapshot.messages?.length) throw error('历史接口没有返回完整消息，本次未发送。');
          const merged = mergeIdentities(snapshot.messages, mounted);
          const bookmark = options.relayBookmark || null;
          const fallback = mountedFallback(merged, mounted, bookmark);
          if (bookmark && core.findCursorIndex(mounted, bookmark).index >= 0
            && core.findCursorIndex(fallback || merged, bookmark).index < 0) {
            throw error('书签仍在来源网页中，但完整历史尚未与页面对齐；请稍后重试，避免遗漏中间消息。');
          }
          capture = { id, key, at: Date.now(), domRevision, snapshot: {
            ...snapshot,
            messages: fallback || merged,
            source: fallback ? 'dom' : 'api',
            strategy: fallback ? 'dom' : 'api',
            relayReadId: id,
          } };
          return capture.snapshot;
        } catch (cause) {
          if (cause?.status === 429) blockedUntil = Date.now() + Math.max(30000, Number(cause.retryAfterMs) || 0);
          capture = null;
          throw error(controller.signal.aborted ? '读取完整历史已取消或超时，本次未发送。'
            : `无法读取完整历史，本次未发送。${cause.message || ''}`);
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          inFlight = null;
        }
      })();
      return inFlight;
    }
    return { read };
  }
  root.RoundtableRelayHistory = Object.freeze({ create, mergeIdentities });
})(globalThis);
