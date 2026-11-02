(function installRoundtableDomText(root) {
  'use strict';

  // Read semantic DOM, including detached clones. innerText on a detached clone
  // falls back to textContent and silently joins adjacent paragraphs together.
  const UI = 'button, [role="button"], script, style, template, svg, .sr-only, '
    + '.cdk-visually-hidden, [hidden], [aria-hidden="true"], [data-roundtable-bookmark-choice], [data-roundtable-bookmark-notice]';
  const body = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
  // Comparison-only projection: editors may drop line breaks, zero-width
  // characters or emoji variation selectors even though the visible text is
  // identical. Never use this for the text that is stored or relayed.
  const identity = (value) => String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, '');
  // Composer verification: a rich-text editor may repaint line breaks or add
  // invisible markers. Reuse the delivery comparison so same-line spaces in
  // any script remain meaningful.
  const cleaned = (value) => String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/\p{Cf}/gu, '');
  const composerMatch = (expected, actual) => {
    const left = cleaned(expected);
    const right = cleaned(actual);
    return root.RoundtableCore.reflowEquivalent(left, right);
  };
  // Track each newline run by its position in the non-whitespace body. This
  // walks long relays once, including code blocks with several empty lines.
  const lineBreaksPreserved = (expected, actual) => {
    const gaps = (value) => {
      const text = cleaned(value);
      const positions = new Map();
      let cursor = 0;
      let offset = 0;
      for (const match of text.matchAll(/\n(?:[^\S\n]*\n)*/gu)) {
        offset += text.slice(cursor, match.index).replace(/\s+/gu, '').length;
        const size = [...match[0].matchAll(/\n/gu)].length;
        positions.set(offset, Math.max(positions.get(offset) || 0, size));
        cursor = match.index + match[0].length;
      }
      return positions;
    };
    const required = gaps(expected);
    const present = gaps(actual);
    for (const [position, size] of required) {
      if ((present.get(position) || 0) < size) return false;
    }
    return true;
  };
  const normalize = (value) => body(value).normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\t\u00A0\u3000 ]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  function hash(value) {
    const text = normalize(value);
    let result = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      result ^= text.charCodeAt(index);
      result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(36);
  }
  function join(parts) {
    return parts.reduce((text, part) => {
      if (/\n$/.test(text) && /^\n/.test(part)) {
        const breaks = Math.max(text.match(/\n+$/)[0].length, part.match(/^\n+/)[0].length);
        return text.replace(/\n+$/, '') + '\n'.repeat(breaks) + part.replace(/^\n+/, '');
      }
      return text + part;
    }, '');
  }
  function copyAttribute(node) {
    const value = body(node.getAttribute?.('data-markdown-copy-text'));
    return value && !/^(?:true|false|1|0)$/i.test(value) ? value : '';
  }
  const escape = (text) => text.replace(/([\\`*_[\]])/g, '\\$1')
    .replace(/(^|\n)([ \t]*)(#{1,6} |>|[-+] |\d+\. )/g, '$1$2\\$3');
  const block = (text, count = 2) => body(text) ? '\n'.repeat(count) + body(text) + '\n'.repeat(count) : '';
  function url(value) {
    const text = String(value || '');
    return /^(?:https?:|mailto:|\/|#)/i.test(text) ? text.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29') : '';
  }

  function read(element, options = {}) {
    if (!element) return '';
    const markdown = options.markdown !== false;
    const clone = element.cloneNode(true);
    clone.querySelectorAll([UI, options.exclude].filter(Boolean).join(',')).forEach((node) => node.remove());
    function children(node) { return join([...node.childNodes].map(render)); }
    function render(node) {
      if (node.nodeType === 3) {
        const text = node.textContent || '';
        const blockSibling = (sibling) => sibling?.nodeType === 1
          && /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|H[1-6]|LI|TR|UL|OL|TABLE|PRE)$/.test(sibling.tagName);
        // HTML source indentation between blocks is not message whitespace.
        // Actual text nodes (and PRE/CODE bodies below) retain their whitespace.
        if (/^[\t\r\n ]+$/.test(text) && /[\r\n]/.test(text)
          && (blockSibling(node.previousSibling) || blockSibling(node.nextSibling))) return '';
        return markdown ? escape(text) : text;
      }
      if (node.nodeType !== 1) return '';
      const tag = node.tagName;
      const copied = copyAttribute(node);
      if (copied) return block(markdown ? copied : root.RoundtableMarkdownIdentity?.plain(copied) || copied);
      if (markdown) {
        const tex = node.matches('.katex, math')
          ? node.querySelector('annotation[encoding="application/x-tex"]')?.textContent : '';
        if (tex) return node.matches('math[display="block"]') || node.parentElement?.classList.contains('katex-display')
          ? block(`\\[${tex}\\]`) : `\\(${tex}\\)`;
      }
      if (tag === 'BR') return markdown ? '  \n' : '\n';
      if (tag === 'PRE') {
        const code = node.querySelector('code') || node;
        const value = (code.textContent || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
        if (!markdown) return block(value);
        const language = (code.className || '').match(/(?:language|lang)-([\w+-]+)/)?.[1]
          || code.getAttribute('data-language') || '';
        const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        return `\n\n${fence}${language}\n${value}\n${fence}\n\n`;
      }
      if (tag === 'CODE' && markdown) {
        const value = node.textContent || '';
        const fence = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        const pad = /^`|`$|^ .* $/s.test(value) ? ' ' : '';
        return `${fence}${pad}${value}${pad}${fence}`;
      }
      if ((tag === 'UL' || tag === 'OL') && markdown) {
        let number = Number(node.getAttribute('start')) || 1;
        const lines = [...node.children].filter((child) => child.tagName === 'LI').map((li) => {
          if (li.hasAttribute('value')) number = Number(li.getAttribute('value'));
          const marker = tag === 'OL' ? `${number++}. ` : '- ';
          return marker + body(children(li)).replace(/\n/g, '\n' + ' '.repeat(marker.length));
        });
        return block(lines.join('\n'));
      }
      if (tag === 'TABLE' && markdown) {
        const rows = [...node.querySelectorAll('tr')].filter((row) => row.closest('table') === node)
          .map((row) => [...row.children].filter((cell) => /^(TH|TD)$/.test(cell.tagName))
            .map((cell) => body(children(cell)).replace(/\|/g, '\\|').replace(/\n+/g, '<br>')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row) => '| ' + Array.from({ length: width }, (_, index) => row[index] || '').join(' | ') + ' |';
        return block([line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n'));
      }
      if (tag === 'IMG') {
        const alt = node.getAttribute('alt') || '图片';
        const src = url(node.getAttribute('src'));
        return markdown && src ? `![${escape(alt)}](${src})` : `[${alt}]`;
      }
      if (tag === 'INPUT') return markdown && node.getAttribute('type') === 'checkbox'
        ? `[${node.checked ? 'x' : ' '}] ` : '';
      const text = children(node);
      if (!markdown && /^(TD|TH)$/.test(tag)) return text + ' ';
      // An explicit empty paragraph creates a visible gap between paragraphs.
      // Without this, <p>one</p><p><br></p><p>two</p> serializes exactly like
      // <p>one</p><p>two</p> and the user's extra blank line disappears.
      if (tag === 'P' && !body(text).replace(/[\u200B-\u200D\uFEFF]/gu, '')) return '\n\n\n';
      if (markdown) {
        if (/^(STRONG|B)$/.test(tag)) return text ? `**${text}**` : '';
        if (/^(EM|I)$/.test(tag)) return text ? `*${text}*` : '';
        if (/^(DEL|S|STRIKE)$/.test(tag)) return text ? `~~${text}~~` : '';
        if (/^H[1-6]$/.test(tag)) return block(`${'#'.repeat(Number(tag[1]))} ${body(text)}`);
        if (tag === 'BLOCKQUOTE') return block(body(text).split('\n').map((line) => `> ${line}`).join('\n'));
        if (tag === 'A') {
          const href = url(node.getAttribute('href'));
          return href && text ? `[${text}](${href})` : text;
        }
        if (tag === 'HR') return block('---');
      }
      if (/^(P|BLOCKQUOTE|H[1-6])$/.test(tag)) return block(text);
      if (/^(DIV|SECTION|ARTICLE|LI|TR|UL|OL|TABLE)$/.test(tag)) return block(text, 1);
      return text;
    }
    return body(render(clone));
  }

  function message(element, role, options = {}) {
    const text = read(element, { ...options, markdown: role === 'assistant' });
    if (!element) return { text, contentAliases: [] };
    const clone = element.cloneNode(true);
    clone.querySelectorAll([UI, options.exclude].filter(Boolean).join(',')).forEach((node) => node.remove());
    // Migrate bookmarks made before DOM -> Markdown serialization. These are
    // whole-message fingerprints, never prefix or position-only guesses.
    const alternatives = [read(element, { ...options, markdown: false }), clone.textContent, element.innerText];
    return { text, contentAliases: [...new Set(alternatives.filter((value) => body(value))
      .map((value) => hash(`${role}\n${value}`)))],
    renderedHash: root.RoundtableCore.semanticHash(alternatives[0]),
    renderedCompactHash: root.RoundtableCore.compactHash(alternatives[0]) };
  }
  root.RoundtableDomText = Object.freeze({ read, message, copyAttribute, body, identity,
    composerMatch, lineBreaksPreserved, normalize });
})(globalThis);
