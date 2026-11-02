(function installChatGptDomReader(root) {
  'use strict';

  // Project conversations have h4 speaker labels, even when article/role/markdown classes are absent.
  // Read only mounted DOM turns; never scroll or request network resources here.
  const LABEL = /^(你说|ChatGPT\s*说|You\s+said|ChatGPT\s+said)\s*[：:]?\s*$/i;
  const EARLIER = /正在加载更早的消息|Loading (?:older|earlier) messages/i;
  const IGNORE = /^(?:复制|编辑|分享|朗读|重新生成|Copy|Edit|Share|Read aloud|Regenerate)$/i;
  let mountedRecords = [];
  const normalize = (value) => String(value ?? '').normalize('NFKC')
    .replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\t\u00A0\u3000 ]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  const hash = (value) => {
    let h = 0x811c9dc5;
    const text = normalize(value);
    for (let index = 0; index < text.length; index += 1) {
      h ^= text.charCodeAt(index);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };
  const roleFor = (heading) => {
    const match = normalize(heading.textContent).match(LABEL);
    return match ? (/^(?:你说|You)/i.test(match[1]) ? 'user' : 'assistant') : '';
  };
  const labeledHeadings = (node) => [...node.querySelectorAll('h4')].filter((h) => roleFor(h));

  function bodyText(node) {
    return globalThis.RoundtableDomText.read(node, { markdown: false });
  }

  function visibleText(wrapper) {
    const clone = wrapper.cloneNode(true);
    clone.querySelectorAll('h4, button, [role="button"], script, style, template, .sr-only, [aria-hidden="true"]')
      .forEach((item) => item.remove());
    return normalize((clone.innerText || clone.textContent || '').split('\n')
      .filter((line) => !IGNORE.test(normalize(line)) && !EARLIER.test(line)).join('\n'));
  }

  function copiedText(node) {
    return globalThis.RoundtableDomText.read(node);
  }

  function readMessage(wrapper, role = 'assistant') {
    const serializer = globalThis.RoundtableDomText;
    if (role === 'assistant') {
      const copies = [...wrapper.querySelectorAll('[data-markdown-copy-text]')];
      const outermost = copies.filter((node) => !copies.some((other) => other !== node && other.contains(node)));
      const richText = outermost.map(copiedText).filter(Boolean).join('\n\n');
      if (richText) {
        const aliases = outermost.length === 1 ? serializer.message(outermost[0], role).contentAliases : [
          hash(`${role}\n${outermost.map((node) => node.innerText || node.textContent || '').join('\n\n')}`),
        ];
        return { text: richText, contentAliases: aliases, renderedHash: root.RoundtableCore.semanticHash(
          outermost.map((node) => serializer.read(node, { markdown: false })).join('\n\n')) };
      }
    }
    if (role === 'user') {
      const bubble = wrapper.querySelector('[data-user-message-bubble], [data-user-message-copy]');
      if (bubble) {
        const message = serializer.message(bubble, role);
        if (message.text) return message;
      }
    }
    const clone = wrapper.cloneNode(true);
    labeledHeadings(clone).forEach((node) => node.remove());
    const preferred = clone.querySelector('.markdown, .prose, [data-assistant-markdown], [data-assistant-markdown-root]') || clone;
    const message = serializer.message(preferred, role);
    message.contentAliases.push(hash(`${role}\n${visibleText(wrapper)}`));
    return message;
  }

  function extract(wrapper, role) {
    return readMessage(wrapper, role).text;
  }

  function headingWrapper(heading, role) {
    let node = heading.parentElement;
    let fallback = null;
    for (let depth = 0; depth < 18 && node; depth += 1, node = node.parentElement) {
      // Never traverse into another turn, the composer, or the whole conversation.
      if (labeledHeadings(node).length !== 1) break;
      const text = extract(node, role);
      if (text) fallback = node;
      const desiredSelector = role === 'assistant'
        ? '[data-markdown-copy-text]' : '[data-user-message-bubble], [data-user-message-copy]';
      if (node.querySelector(desiredSelector) && text) return node;
      if (node.tagName === 'MAIN' || node.tagName === 'BODY') break;
    }
    return fallback;
  }

  function read(doc = document) {
    mountedRecords = [];
    const main = doc.querySelector('main') || doc.body || doc;
    const headings = labeledHeadings(main);
    const messages = [];
    const occurrences = new Map();
    for (const heading of headings) {
      const role = roleFor(heading);
      const wrapper = headingWrapper(heading, role);
      const content = wrapper ? readMessage(wrapper, role) : { text: '' };
      const text = content.text;
      if (!text || (EARLIER.test(text) && text.length < 100)) continue;
      const contentKey = `${role}:${hash(text)}`;
      const occurrence = (occurrences.get(contentKey) || 0) + 1;
      occurrences.set(contentKey, occurrence);
      const nodeWithId = heading.closest('[data-message-id]') || wrapper?.closest('[data-message-id]')
        || wrapper?.querySelector('[data-message-id]');
      const nativeId = nodeWithId && labeledHeadings(nodeWithId).length <= 1
        ? nodeWithId.getAttribute('data-message-id') : '';
      const folded = role === 'user' && [...wrapper.querySelectorAll('button, [role="button"]')]
        .some((button) => /^(?:展开|展开更多|显示更多|Expand|Show more|Read more)$/i
          .test(normalize(button.textContent || button.getAttribute('aria-label'))));
      const message = {
        id: nativeId || `project-${contentKey}-${occurrence}`,
        role,
        text,
        contentAliases: content.contentAliases || [],
        renderedHash: content.renderedHash || '',
        complete: true,
        ...(folded ? { folded: true } : {}),
      };
      messages.push(message);
      mountedRecords.push({ wrapper, message });
    }
    const loadingText = normalize(main?.innerText || main?.textContent || '');
    return {
      messages,
      strategy: headings.length ? 'chatgpt-project-h4' : 'chatgpt-project-not-found',
      truncated: EARLIER.test(loadingText),
      diagnostics: { headingCount: headings.length, parsedCount: messages.length,
        assistantCopyNodes: main.querySelectorAll?.('[data-markdown-copy-text]').length || 0 },
    };
  }

  function messageForElement(node) {
    const matches = mountedRecords.filter(({ wrapper, message }) => message.role === 'assistant'
      && (node === wrapper || node?.contains(wrapper) || wrapper.contains(node)));
    return matches.length === 1 ? matches[0].message : null;
  }

  root.RoundtableChatGptReader = Object.freeze({ read, bodyText, readMessage, messageForElement });
})(globalThis);
