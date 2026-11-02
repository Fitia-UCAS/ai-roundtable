(function installMarkdownIdentity(root) {
  'use strict';
  // Only project whole bodies for identity checks. Never render API Markdown
  // into the live page, and never alter the original payload sent to the AI.
  function decode(text) {
    const node = document.createElement('textarea');
    node.innerHTML = String(text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return node.value;
  }
  function plain(markdown) {
    const walk = (tokens) => (tokens || []).map((token) => {
      if (token.type === 'space') return '\n\n';
      if (token.type === 'br') return '\n';
      if (token.type === 'hr') return '';
      if (token.type === 'code') return `\n\n${token.text}\n\n`;
      if (token.type === 'codespan') return token.text;
      if (token.type === 'image') return `[${decode(token.text || '图片')}]`;
      if (token.type === 'list') return '\n' + token.items.map((item) => walk(item.tokens).trim()).join('\n') + '\n';
      if (token.type === 'table') return '\n' + [token.header, ...token.rows]
        .map((row) => row.map((cell) => walk(cell.tokens)).join(' ')).join('\n') + '\n';
      if (token.type === 'html') return decode(token.text.replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, '\n').replace(/<[^>]*>/g, ''));
      const text = token.tokens ? walk(token.tokens) : decode(token.text);
      return /^(paragraph|heading|blockquote)$/.test(token.type) ? `\n\n${text.trim()}\n\n` : text;
    }).join('');
    return walk(root.marked.lexer(String(markdown || ''))).replace(/\n{3,}/g, '\n\n').trim();
  }
  function annotate(message) {
    if (message.role !== 'assistant') return message;
    const text = plain(message.text);
    // Gemini's RPC body can include citation tokens that its visible answer
    // renders as buttons. Keep the original text for relay, but allow either
    // whole-body projection to identify the same bookmarked answer.
    const withoutCitations = text.replace(/\[cite:\s*\d+(?:\s*,\s*\d+)*\]/giu, '');
    const renderedAliases = [...new Set([
      root.RoundtableCore.semanticHash(text),
      root.RoundtableCore.semanticHash(withoutCitations),
    ])];
    const renderedCompactAliases = [...new Set([
      root.RoundtableCore.compactHash(text),
      root.RoundtableCore.compactHash(withoutCitations),
    ])];
    return { ...message, renderedHash: renderedAliases[0], renderedAliases,
      renderedCompactHash: renderedCompactAliases[0], renderedCompactAliases };
  }
  root.RoundtableMarkdownIdentity = Object.freeze({ plain, annotate });
})(globalThis);
