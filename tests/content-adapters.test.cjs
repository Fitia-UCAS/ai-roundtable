const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const core = require('../shared/core.js');
// Browser tests can use the ordinary playwright package or an explicit test-only module path.
// No Playwright dependency is required by the browser extension itself.
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  if (process.env.PLAYWRIGHT_MODULE_PATH) {
    try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH)); } catch {}
  }
}
const skipBrowser = chromium ? false
  : 'Playwright unavailable; install playwright or set PLAYWRIGHT_MODULE_PATH to run DOM tests';

const ROOT = path.join(__dirname, '..');
const EDGE = process.env.BROWSER_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : '/usr/bin/chromium');

async function withProviderPage(url, html, adapter, run) {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE,
    args: process.platform === 'win32' ? [] : ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      globalThis.__roundtableListeners = [];
      globalThis.chrome = {
        runtime: {
          lastError: null,
          onMessage: {
            addListener(listener) { globalThis.__roundtableListeners.push(listener); },
          },
          sendMessage(_message, callback) { callback?.({ ok: true }); },
        },
      };
    });
    // Use an isolated DOM fixture; corporate/sandbox policies can block navigation
    // to live AI domains even when route.fulfill() is configured.
    await page.goto('about:blank');
    await page.setContent(html);
    for (const dependency of ['shared/core.js', 'vendor/marked/marked.min.js', 'content/markdown-identity.js', 'content/relay-history.js', 'content/dom-text.js']) {
      await page.addScriptTag({ path: path.join(ROOT, dependency) });
    }
    await page.addScriptTag({ path: path.join(ROOT, 'content', 'common.js') });
    if (adapter === 'chatgpt.js') {
      await page.addScriptTag({ path: path.join(ROOT, 'content', 'chatgpt-reader.js') });
    }
    // Bypass domain recognition only in the fixture; real site matching is unchanged.
    const source = fs.readFileSync(path.join(ROOT, 'content', adapter), 'utf8');
    const fixtureSource = source.replace(/  function matches\(currentLocation\) \{[\s\S]*?\n  \}/,
      '  function matches() { return true; }');
    if (fixtureSource === source) throw new Error(`No site matcher found in ${adapter}`);
    await page.addScriptTag({ content: fixtureSource });
    return await run(page);
  } finally {
    await browser.close();
  }
}

async function withProviderPageAt(url, html, adapter, run) {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE,
    args: process.platform === 'win32' ? [] : ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      globalThis.__roundtableListeners = [];
      globalThis.chrome = {
        runtime: {
          lastError: null,
          onMessage: { addListener(listener) { globalThis.__roundtableListeners.push(listener); } },
          sendMessage(_message, callback) { callback?.({ ok: true }); },
        },
      };
    });
    await page.route(`${new URL(url).origin}/**`, (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8', body: html,
    }));
    await page.goto(url);
    for (const dependency of ['shared/core.js', 'vendor/marked/marked.min.js', 'content/markdown-identity.js', 'content/relay-history.js', 'content/dom-text.js']) {
      await page.addScriptTag({ path: path.join(ROOT, dependency) });
    }
    await page.addScriptTag({ path: path.join(ROOT, 'content', 'common.js') });
    if (adapter === 'chatgpt.js') {
      await page.addScriptTag({ path: path.join(ROOT, 'content', 'chatgpt-reader.js') });
    }
    const source = fs.readFileSync(path.join(ROOT, 'content', adapter), 'utf8');
    const fixtureSource = source.replace(/  function matches\(currentLocation\) \{[\s\S]*?\n  \}/,
      '  function matches() { return true; }');
    if (fixtureSource === source) throw new Error(`No site matcher found in ${adapter}`);
    await page.addScriptTag({ content: fixtureSource });
    return await run(page);
  } finally {
    await browser.close();
  }
}

async function contentCommand(page, type, payload = {}) {
  return page.evaluate(({ commandType, commandPayload }) => new Promise((resolve) => {
    const listener = globalThis.__roundtableListeners[0];
    listener({ type: commandType, payload: commandPayload }, {}, resolve);
  }), { commandType: type, commandPayload: payload });
}

test('ChatGPT adapter sends once and captures a stable answer', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    #prompt-textarea { display:block; min-height:40px; width:300px; white-space:pre-wrap; }
    button { display:block; width:80px; height:30px; }
  </style></head><body>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <button type="button" data-testid="fruitjuice-send-button" disabled>Send</button></form>
    <main id="turns"></main>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('#prompt-textarea');
      const sendButton = document.querySelector('[data-testid="fruitjuice-send-button"]');
      composer.addEventListener('input', () => {
        sendButton.disabled = !composer.innerText.trim();
      });
      sendButton.addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const prompt = composer.innerText.trim();
        composer.replaceChildren();
        const user = document.createElement('article');
        user.dataset.messageId = 'u-new';
        user.innerHTML = '<div data-message-author-role="user"></div>';
        user.firstElementChild.textContent = prompt;
        document.querySelector('#turns').append(user);
        const stop = document.createElement('button');
        stop.dataset.testid = 'stop-button';
        stop.textContent = 'Stop';
        document.body.append(stop);
        setTimeout(() => {
          const answer = document.createElement('article');
          answer.dataset.messageId = 'a-new';
          answer.innerHTML = '<div data-message-author-role="assistant"><div class="markdown">ChatGPT answer</div></div>';
          document.querySelector('#turns').append(answer);
          stop.remove();
        }, 120);
      });
    </script>
  </body></html>`;

  await withProviderPage('https://chatgpt.com/', html, 'chatgpt.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'chatgpt-send',
      text: '标题：\n\n```js\nif (a < b && ok) {\n    run("a  b");\n\n\n}\n```',
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, true);
    assert.ok(sent.result.insertedMessage.text.includes('    run("a  b");\n\n\n}'), JSON.stringify(sent.result.insertedMessage.text));
    assert.equal(sent.result.insertedMessage.text, sent.result.prompt);
    assert.ok(sent.result.prompt.startsWith('标题：\n\n'));
    assert.equal(sent.result.submitMethod, 'button-click');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
    const repeated = await contentCommand(page, 'RT_SEND', {
      operationId: 'chatgpt-send',
      text: '标题：\n\n```js\nif (a < b && ok) {\n    run("a  b");\n\n\n}\n```',
    });
    assert.equal(repeated.result.repeated, true);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);

    const completed = await contentCommand(page, 'RT_WAIT', {
      operationId: 'chatgpt-wait',
      sendResult: sent.result,
      timeoutMs: 5000,
      pollMs: 400,
      stableMilliseconds: 500,
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.result.answer, 'ChatGPT answer');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('ChatGPT does not send when its editor removes a blank line', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    #prompt-textarea { white-space: pre-wrap; }
  </style></head><body>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <button type="button" data-testid="fruitjuice-send-button">Send</button></form>
    <main></main><script>
      globalThis.__sendClicks = 0;
      document.execCommand = () => {
        document.querySelector('#prompt-textarea').textContent = '甲\\n乙';
        return true;
      };
      document.querySelector('button').addEventListener('click', () => { globalThis.__sendClicks += 1; });
    </script>
  </body></html>`;
  await withProviderPage('https://chatgpt.com/', html, 'chatgpt.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', { operationId: 'chatgpt-blank-line-lost', text: '甲\n\n乙' });
    assert.equal(sent.ok, false);
    assert.equal(sent.error?.code, 'composer-format-failed');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('ChatGPT DOM fallback reads turns in order and strips UI text', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body><main>
    <article data-message-id="u1" data-testid="conversation-turn-1">
      <div data-message-author-role="user"><div data-user-message-copy>第一问<button>Copy</button></div></div>
    </article>
    <article data-message-id="a1" data-testid="conversation-turn-2">
      <div data-message-role="assistant"><div data-assistant-markdown><p>第一答</p><button>Copy</button></div></div>
    </article>
    <article data-message-id="u2" data-testid="conversation-turn-3">
      <div data-message-role="user"><div data-user-message-bubble>第二问</div></div>
    </article>
    <article data-message-id="a2" data-testid="conversation-turn-4">
      <div data-message-author-role="assistant"><div class="markdown"><p>第二答</p>
        <span data-testid="webpage-citation-pill">citation</span>
      </div></div>
    </article>
  </main></body></html>`;

  await withProviderPage('https://chatgpt.com/c/dom-test', html, 'chatgpt.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT');
    assert.equal(inspected.ok, true);
    assert.equal(inspected.snapshot.source, 'dom');
    assert.deepEqual(
      inspected.snapshot.messages.map((message) => [message.role, message.text]),
      [
        ['user', '第一问'],
        ['assistant', '第一答'],
        ['user', '第二问'],
        ['assistant', '第二答'],
      ],
    );
  });
});

test('ChatGPT falls back to 你说 / ChatGPT 说 text blocks on the new Project UI', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body><main>
    <div>你说：</div><div>第一问</div>
    <div>ChatGPT 说：</div><div>第一答</div>
    <div>你说：</div><div>第二问</div>
    <div>ChatGPT 说：</div><div>第二答</div>
  </main></body></html>`;

  await withProviderPage('https://chatgpt.com/c/text-fallback', html, 'chatgpt.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT');
    assert.equal(inspected.ok, true);
    assert.equal(inspected.snapshot.source, 'dom');
    assert.deepEqual(
      inspected.snapshot.messages.map((message) => [message.role, message.text]),
      [
        ['user', '第一问'],
        ['assistant', '第一答'],
        ['user', '第二问'],
        ['assistant', '第二答'],
      ],
    );
  });
});

test('ChatGPT reads the new Project h4 labels and data-markdown-copy-text', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <div class="thread-scroll-container">
      <div class="group"><h4>你说：</h4><div>第一问</div></div>
      <div class="group"><h4>ChatGPT 说：</h4>
        <div data-markdown-copy-text="第一答 **重点**"></div>
      </div>
      <div class="group"><h4>你说：</h4><div>第二问</div></div>
      <div class="group"><h4>ChatGPT 说：</h4>
        <div data-markdown-copy-text="第二答"></div>
      </div>
    </div>
  </body></html>`;

  await withProviderPage('https://chatgpt.com/c/labeled-test', html, 'chatgpt.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT');
    assert.equal(inspected.ok, true);
    assert.equal(inspected.snapshot.source, 'dom');
    assert.deepEqual(
      inspected.snapshot.messages.map((message) => [message.role, message.text]),
      [
        ['user', '第一问'],
        ['assistant', '第一答 **重点**'],
        ['user', '第二问'],
        ['assistant', '第二答'],
      ],
    );
  });
});

test('ChatGPT text fallback keeps relay role labels inside a single user message', { skip: skipBrowser }, async () => {
  const html = `<main><div>你说：</div><div>接续 Gemini 的讨论：<br>用户：<br>原来的问题<br>Gemini：<br>原来的答复<br>请继续回应。</div>
    <div>ChatGPT 说：</div><div>这才是真正的助手回复</div></main>`;
  await withProviderPage('https://chatgpt.com/c/text-relay', html, 'chatgpt.js', async (page) => {
    const result = await contentCommand(page, 'RT_INSPECT');
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot.messages.map((message) => message.role), ['user', 'assistant']);
    assert.match(result.snapshot.messages[0].text, /用户:/);
    assert.match(result.snapshot.messages[0].text, /请继续回应。/);
  });
});

test('ChatGPT Project user extraction strips fold controls and keeps nested native ids and paragraphs', { skip: skipBrowser }, async () => {
  const html = `<main>
    <section><h4>你说：</h4><div data-message-id="u-long" data-user-message-bubble>
      <p>第一段的实际正文。</p><p>two separate words</p><p>请继续回应。</p><button>收起</button>
    </div></section>
    <section><h4>ChatGPT 说：</h4><div data-message-id="a-long"><div data-markdown-copy-text="答复"></div></div></section>
  </main>`;
  await withProviderPage('https://chatgpt.com/c/fold-test', html, 'chatgpt.js', async (page) => {
    const result = await contentCommand(page, 'RT_INSPECT');
    const user = result.snapshot.messages[0];
    assert.equal(user.id, 'u-long');
    assert.equal(result.snapshot.messages[1].id, 'a-long');
    assert.doesNotMatch(user.text, /收起/);
    assert.equal(core.semanticText(user.text), core.semanticText('第一段的实际正文。\n\ntwo separate words\n\n请继续回应。'));
    await page.locator('button').evaluate((button) => { button.textContent = '展开'; });
    const folded = await contentCommand(page, 'RT_INSPECT', { force: true });
    assert.equal(folded.snapshot.messages[0].folded, true);
    assert.equal(folded.snapshot.messages[0].text, user.text);
  });
});

test('ChatGPT relay reads the current branch through the last answer while the page is in the middle', { skip: skipBrowser }, async () => {
  const html = `<main><p>Loading earlier messages</p>
    <section><h4>ChatGPT 说：</h4><div data-markdown-copy-text="true"><p><strong>中间回答</strong></p><p>下一段。</p></div></section>
  </main>`;
  await withProviderPageAt('https://chatgpt.com/c/history-test', html, 'chatgpt.js', async (page) => {
    await page.evaluate(() => {
      const entry = (id, parent, role, text, extra = {}) => ({ parent,
        message: { id, author: { role }, content: { parts: [text] }, status: 'finished_successfully', ...extra } });
      window.__history = { conversation_id: 'history-test', current_node: 'a2', mapping: {
        u1: entry('u1', null, 'user', '第一问'), a1: entry('a1', 'u1', 'assistant', '**中间回答**\n\n下一段。'),
        u2: entry('u2', 'a1', 'user', '第二问'), thinking: entry('thinking', 'u2', 'assistant', '不应转发的推理', { channel: 'analysis' }),
        a2: entry('a2', 'thinking', 'assistant', '最后一条完整回复', { channel: 'final' }),
        abandoned: entry('abandoned', 'u2', 'assistant', '不在当前分支'),
      } };
      window.__requests = 0;
      globalThis.fetch = async (url) => {
        window.__requests++;
        return { ok: true, status: 200, json: async () => url === '/api/auth/session' ? { accessToken: 'fixture-token' } : window.__history };
      };
    });
    const dom = await contentCommand(page, 'RT_INSPECT');
    assert.equal(dom.ok, true, JSON.stringify(dom));
    assert.equal(dom.snapshot.messages.length, 1);
    assert.equal(await page.evaluate(() => window.__requests), 0);
    const full = await contentCommand(page, 'RT_INSPECT', { relayRead: true, relayOperationId: 'one-relay' });
    assert.equal(full.ok, true, JSON.stringify(full.error));
    assert.equal(full.snapshot.source, 'api');
    assert.deepEqual(full.snapshot.messages.map((message) => message.id), ['u1', 'a1', 'u2', 'a2']);
    const cursor = core.makeStartCursor(dom.snapshot.messages, 0, full.snapshot.conversationKey);
    const plan = core.getRelayPlan(full.snapshot.messages, cursor, full.snapshot.conversationKey);
    assert.equal(plan.kind, 'incremental');
    assert.equal(plan.endCursor.messageId, 'a2');
    assert.deepEqual(plan.messages.map((message) => message.id), ['a1', 'u2', 'a2']);
    assert.equal(dom.snapshot.messages[0].id.startsWith('project-assistant:'), true);
    // Also recover the old plain-text bookmark, with neither a native id nor
    // the new rendered fingerprint. No positional/prefix guess is involved.
    const legacy = core.makeStartCursor([{ id: 'project-assistant:old-1', role: 'assistant', text: '中间回答\n\n下一段。' }], 0, full.snapshot.conversationKey);
    assert.equal(core.getRelayPlan(full.snapshot.messages, legacy, full.snapshot.conversationKey).endCursor.messageId, 'a2');
    for (let index = 0; index < 4; index++) {
      const checked = await contentCommand(page, 'RT_INSPECT', { relayRecheckId: full.snapshot.relayReadId, force: true });
      assert.equal(checked.ok, true, JSON.stringify(checked.error));
      await contentCommand(page, 'RT_INSPECT', { force: true });
    }
    assert.equal(await page.evaluate(() => window.__requests), 2, 'one auth and one history request; DOM checks never refetch');
    // Do not send an arbitrary concatenation of branches or fall back to the
    // mounted middle when complete history is unavailable.
    await page.evaluate(() => { delete window.__history.current_node; });
    const unknownBranch = await contentCommand(page, 'RT_INSPECT', { relayRead: true, force: true });
    assert.equal(unknownBranch.ok, false);
    assert.equal(unknownBranch.error.code, 'SOURCE_HISTORY_UNAVAILABLE');
  });
});

test('DOM serialization preserves Markdown structure and literal user input on all providers', { skip: skipBrowser }, async () => {
  const rich = '<h3>标题</h3><p>第一段<strong>重要</strong>。</p><p>第二段<br>下一行。</p>'
    + '<ul><li>第一项<ul><li>子项</li></ul></li><li>第二项</li></ul><blockquote><p>引用</p></blockquote>'
    + '<pre><code class="language-js">if (ready) {\n    run("a  b");\n\n\n}\n</code></pre>'
    + '<p><a href="https://example.com/docs">文档</a> 和 <code>*literal*</code></p>'
    + '<table><tr><th>列一</th><th>列二</th></tr><tr><td>甲</td><td>乙</td></tr></table>';
  const cases = [
    ['chatgpt.js', `<main><section><h4>你说：</h4><div data-user-message-bubble><p>**原样输入**</p><p>下一段</p></div></section><section><h4>ChatGPT 说：</h4><div data-markdown-copy-text="true">${rich}</div></section></main>`],
    ['gemini.js', `<main><user-query><div class="query-text"><p>**原样输入**</p><p>下一段</p></div></user-query><model-response><message-content><div class="markdown">${rich}</div></message-content></model-response></main>`],
    ['deepseek.js', `<main><div data-virtual-list-item-key="1"><div class="ds-message"><div class="ds-collapsible-text"><p>**原样输入**</p><p>下一段</p></div></div></div><div data-virtual-list-item-key="2"><div class="ds-message"><div class="ds-markdown">${rich}</div></div></div></main>`],
  ];
  for (const [adapter, html] of cases) await withProviderPage('', html, adapter, async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT');
    assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
    const [user, assistant] = core.cleanMessages(inspected.snapshot.messages);
    assert.equal(user.text, '**原样输入**\n\n下一段');
    const text = assistant.text;
    assert.match(text, /### 标题\n\n第一段\*\*重要\*\*。\n\n第二段  \n下一行。/);
    assert.match(text, /- 第一项\n(?: *\n)? {2}- 子项/);
    assert.match(text, /> 引用/);
    assert.ok(text.includes('```js\nif (ready) {\n    run("a  b");\n\n\n}\n```'), adapter);
    assert.ok(text.includes('[文档](https://example.com/docs) 和 `*literal*`'));
    assert.ok(text.includes('| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |'));
    assert.ok(core.formatRelayMessages([assistant], 'AI').includes(text), 'formatting must survive relay assembly');
    const mismatch = await page.evaluate(() => {
      const node = document.createElement('p'); node.innerHTML = '<em>word</em>';
      const dom = { id: 'project-assistant:x-1', role: 'assistant', ...RoundtableDomText.message(node, 'assistant') };
      const api = RoundtableMarkdownIdentity.annotate({ id: 'server', role: 'assistant', text: '`*word*`' });
      return RoundtableCore.findCursorIndex([api], RoundtableCore.makeCursor(dom, 0, '')).index;
    });
    assert.equal(mismatch, -1, 'literal code is not interchangeable with rendered emphasis');
  });
});

test('DOM reading retains an explicitly empty paragraph in relayed text', { skip: skipBrowser }, async () => {
  const body = '<p>第一段。</p><p><br></p><p>第二段。</p>';
  const cases = [
    ['https://gemini.google.com/app', 'gemini.js',
      `<main><model-response><message-content><div class="markdown">${body}</div></message-content></model-response></main>`],
    ['https://chatgpt.com/', 'chatgpt.js',
      `<main><article data-message-id="a1"><div data-message-author-role="assistant"><div data-markdown-copy-text="true">${body}</div></div></article></main>`],
  ];
  for (const [url, adapter, html] of cases) await withProviderPage(url, html, adapter, async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT');
    assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
    const answer = inspected.snapshot.messages.find((message) => message.role === 'assistant');
    assert.equal(answer.text, '第一段。\n\n\n第二段。');
    assert.match(core.formatRelayMessages([answer], 'AI'), /第一段。\n\n\n第二段。/u);
  });
});

test('ChatGPT rejects changed DOM during local source recheck without another API call', { skip: skipBrowser }, async () => {
  await withProviderPageAt('https://chatgpt.com/c/recheck', '<main><section><h4>ChatGPT 说：</h4><div data-markdown-copy-text="true"><p>Original</p></div></section></main>', 'chatgpt.js', async (page) => {
    await page.evaluate(() => {
      window.__requests = 0;
      window.fetch = async (url) => {
        window.__requests++;
        return { ok: true, status: 200, json: async () => url === '/api/auth/session' ? { accessToken: 'test' }
          : { current_node: 'a', mapping: { a: { message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['Original'] } } } } } };
      };
    });
    const captured = await contentCommand(page, 'RT_INSPECT', { relayRead: true, relayOperationId: 'recheck' });
    assert.equal(captured.ok, true, JSON.stringify(captured.error));
    await page.evaluate(() => { document.querySelector('[data-markdown-copy-text] p').textContent = 'Changed'; });
    const checked = await contentCommand(page, 'RT_INSPECT', { relayRecheckId: captured.snapshot.relayReadId, force: true });
    assert.equal(checked.ok, false);
    assert.equal(await page.evaluate(() => window.__requests), 2);
  });
});

test('Gemini reads each history page once per relay and rechecks locally', { skip: skipBrowser }, async () => {
  const html = '<script type="application/json">{"SNlM0e":"fixture"}</script><main><model-response><message-content><div class="markdown"><p><strong>中间回答</strong></p></div></message-content></model-response></main>';
  await withProviderPageAt('https://gemini.google.com/app/paged', html, 'gemini.js', async (page) => {
    await page.evaluate(() => {
      window.__rpcRequests = 0;
      window.fetch = async (_url, options) => {
        window.__rpcRequests++;
        const args = JSON.parse(JSON.parse(new URLSearchParams(options.body).get('f.req'))[0][0][1]);
        const turn = (id, prompt, answer, time) => [[null, id], [null, null, 'chosen'], [[prompt]], [[['chosen', [answer]]]], [time, 0]];
        const payload = args[2] ? [[turn('t1', '第一问', '**中间回答**', 100)], null]
          : [[turn('t2', '最新问题', '最新回答\n\n第二段', 200)], 'older'];
        return { ok: true, status: 200, text: async () => JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(payload)]]) };
      };
    });
    const dom = await contentCommand(page, 'RT_INSPECT');
    assert.equal(await page.evaluate(() => window.__rpcRequests), 0);
    const full = await contentCommand(page, 'RT_INSPECT', { relayRead: true, relayOperationId: 'gemini-pages' });
    assert.equal(full.ok, true, JSON.stringify(full.error));
    const cursor = core.makeStartCursor(dom.snapshot.messages, 0, full.snapshot.conversationKey);
    const plan = core.getRelayPlan(full.snapshot.messages, cursor, full.snapshot.conversationKey);
    assert.equal(plan.kind, 'incremental');
    assert.equal(plan.endCursor.messageId, 't2:assistant');
    assert.equal(plan.messages.at(-1).text, '最新回答\n\n第二段');
    const recheck = await contentCommand(page, 'RT_INSPECT', { relayRecheckId: full.snapshot.relayReadId, force: true });
    assert.equal(recheck.ok, true, JSON.stringify(recheck.error));
    assert.equal(await page.evaluate(() => window.__rpcRequests), 2, 'only the two required pages, with no re-fetch on recheck');
  });
});

test('ChatGPT history 429 cools down repeat clicks and leaves ordinary DOM checks usable', { skip: skipBrowser }, async () => {
  await withProviderPageAt('https://chatgpt.com/c/cooldown', '<main><section><h4>ChatGPT 说：</h4><div data-markdown-copy-text="true"><p>Visible</p></div></section></main>', 'chatgpt.js', async (page) => {
    await page.evaluate(() => {
      window.__requests = [];
      window.fetch = async (url) => {
        window.__requests.push(url);
        return url === '/api/auth/session' ? { ok: true, status: 200, json: async () => ({ accessToken: 'test' }) }
          : { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
      };
    });
    for (let index = 0; index < 3; index++) {
      const failed = await contentCommand(page, 'RT_INSPECT', { relayRead: true, relayOperationId: `op-${index}`, force: true });
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, 'SOURCE_HISTORY_UNAVAILABLE');
      assert.equal((await contentCommand(page, 'RT_INSPECT', { force: true })).snapshot.messages[0].text, 'Visible');
    }
    assert.equal(await page.evaluate(() => window.__requests.length), 2, '429 never causes automatic retries');
  });
});

test('bookmark marker uses the same DOM text and waits for successful persistence', { skip: skipBrowser }, async () => {
  const html = '<main><section><h4>你说：</h4><div data-user-message-bubble>Previous user</div></section>'
    + '<section data-turn-key="answer"><aside data-markdown-copy-text="true">Reasoning outside the answer</aside>'
    + '<div><h4>ChatGPT 说：</h4><div data-markdown-copy-text="true"><p>First <strong>bold</strong>.</p><p>Second paragraph.</p></div></div>'
    + '<div class="turn-action-controls"><button>Copy</button></div></section>'
    + '<section><h4>你说：</h4><div data-user-message-bubble>Later discussion</div></section>'
    + '<section data-turn-key="later"><h4>ChatGPT 说：</h4><div data-markdown-copy-text="true"><p>First <strong>bold</strong>.</p><p>Different ending.</p></div>'
    + '<div class="turn-action-controls"><button>Copy</button></div></section></main>';
  await withProviderPageAt('https://chatgpt.com/c/bookmark', html, 'chatgpt.js', async (page) => {
    await page.evaluate(() => {
      window.__bookmarks = {}; window.__saveAllowed = false; window.__requests = 0;
      window.fetch = async () => { window.__requests++; throw new Error('bookmarks never use the API'); };
      chrome.runtime.id = 'fixture';
      chrome.storage = { local: { get(_keys, callback) {
        if (!window.__storageReady) window.__releaseBookmarks = () => {
          window.__storageReady = true;
          callback({ roundtableBookmarks: window.__bookmarks });
        };
        else callback({ roundtableBookmarks: window.__bookmarks });
      } }, onChanged: { addListener() {} } };
      chrome.runtime.sendMessage = async (message, callback) => {
        if (message.type !== 'RT_BOOKMARK_SET') { callback?.({ ok: true }); return; }
        await new Promise((resolve) => setTimeout(resolve, 180));
        if (!window.__saveAllowed) { callback({ ok: false, error: { message: 'Save failed' } }); return; }
        const snapshot = await RoundtableContent.currentAdapter().inspect({});
        const index = snapshot.messages.findIndex((item) => RoundtableCore.messageHash(item) === message.messageHash);
        const bookmark = RoundtableCore.makeStartCursor(snapshot.messages, index, snapshot.conversationKey);
        window.__bookmarks[snapshot.conversationKey] = bookmark;
        callback({ ok: true, bookmark });
      };
    });
    await page.addScriptTag({ path: path.join(ROOT, 'content/bookmark-model.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'content/bookmark-picker.js') });
    const button = page.locator('[data-turn-key="answer"] [data-roundtable-bookmark-choice] button');
    await button.waitFor();
    await page.waitForFunction(() => Boolean(window.__releaseBookmarks));
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.equal(await button.getAttribute('aria-busy'), 'true', 'a click waits for an ongoing first refresh');
    const pending = await contentCommand(page, 'RT_INSPECT', { relayRead: true, relayOperationId: 'pending-selection', force: true });
    assert.equal(pending.error.code, 'BOOKMARK_SELECTION_REQUIRED');
    await page.evaluate(() => window.__releaseBookmarks());
    await page.waitForTimeout(260);
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('[data-roundtable-bookmark-notice]').innerText(), /Save failed/);
    const blocked = await contentCommand(page, 'RT_INSPECT', { relayRead: true, relayOperationId: 'failed-selection', force: true });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'BOOKMARK_SELECTION_REQUIRED');
    await page.evaluate(() => { window.__saveAllowed = true; });
    await button.click();
    await page.waitForTimeout(260);
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    const stored = await page.evaluate(() => window.__bookmarks['chatgpt:bookmark']);
    assert.equal(stored.role, 'assistant');
    assert.equal(stored.atStart, true);
    const range = await page.evaluate(async () => {
      const snapshot = await RoundtableContent.currentAdapter().inspect({});
      const cursor = window.__bookmarks[snapshot.conversationKey];
      const index = RoundtableCore.findCursorIndex(snapshot.messages, cursor).index;
      return { texts: snapshot.messages.slice(index).map((item) => item.text), issue: __roundtableBookmarkPicker.selectionIssue() };
    });
    assert.deepEqual(range.texts, ['First **bold**.\n\nSecond paragraph.', 'Later discussion', 'First **bold**.\n\nDifferent ending.']);
    assert.equal(range.issue, '');
    assert.equal(await page.locator('[data-roundtable-bookmark-notice]').count(), 0);
    assert.equal(await page.locator('[data-turn-key="later"] [data-roundtable-bookmark-choice] button').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.__requests), 0);
  });
});

test('ChatGPT project bookmark selects the answer beside its action row when a turn has branches',
  { skip: skipBrowser }, async () => {
    const html = '<main><section data-turn-key="branched">'
      + '<div><h4>你说：</h4><div data-user-message-bubble>Which draft?</div>'
      + '<div class="group/user-message"><div class="turn-action-controls"><button>Copy message</button></div></div></div>'
      + '<div class="answer"><h4>ChatGPT 说：</h4><p>Older answer branch.</p></div>'
      + '<div class="answer"><h4>ChatGPT 说：</h4><p>Chosen answer branch.</p></div>'
      + '<div class="turn-action-controls"><button>Copy answer</button></div>'
      + '</section></main>';
    await withProviderPageAt('https://chatgpt.com/c/project-branches', html, 'chatgpt.js', async (page) => {
      await page.evaluate(() => {
        window.__savedBookmark = null;
        // Reproduce the real failure path: the DOM reader has an answer in its
        // snapshot, but its temporary element binding is unavailable.
        RoundtableContent.currentAdapter().messageForElement = () => null;
        chrome.runtime.id = 'fixture';
        chrome.storage = { local: { get(_keys, callback) { callback({ roundtableBookmarks: {} }); } },
          onChanged: { addListener() {} } };
        chrome.runtime.sendMessage = async (message, callback) => {
          const snapshot = await RoundtableContent.currentAdapter().inspect({});
          const index = snapshot.messages.findIndex((item) => item.id === message.messageId
            && RoundtableCore.messageHash(item) === message.messageHash);
          if (index < 0) { callback({ ok: false, error: { message: 'Wrong answer' } }); return; }
          const bookmark = RoundtableCore.makeStartCursor(snapshot.messages, index, snapshot.conversationKey);
          window.__savedBookmark = { text: snapshot.messages[index].text, bookmark };
          callback({ ok: true, bookmark });
        };
      });
      await page.addScriptTag({ path: path.join(ROOT, 'content/bookmark-model.js') });
      await page.addScriptTag({ path: path.join(ROOT, 'content/bookmark-picker.js') });
      const button = page.locator('[data-turn-key="branched"] > .turn-action-controls '
        + '[data-roundtable-bookmark-choice] button');
      await button.waitFor();
      assert.equal(await page.locator('.group\\/user-message [data-roundtable-bookmark-choice]').count(), 0);
      await button.click();
      await page.waitForFunction(() => Boolean(window.__savedBookmark));
      assert.equal((await page.evaluate(() => window.__savedBookmark)).text, 'Chosen answer branch.');
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-roundtable-bookmark-notice]').count(), 0);
    });
  });

test('ChatGPT pending confirmation is cancelled immediately without a second click', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    .ProseMirror { display:block; min-height:40px; width:300px; }
    button { display:block; width:80px; height:30px; }
  </style></head><body>
    <form data-chatgpt-composer><div class="ProseMirror" contenteditable="true" role="textbox"></div>
    <button type="button" class="composer-submit-btn">Send</button></form>
    <script>
      globalThis.__sendClicks = 0;
      document.querySelector('.composer-submit-btn').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
      });
    </script>
  </body></html>`;

  await withProviderPage('https://chatgpt.com/', html, 'chatgpt.js', async (page) => {
    const pendingSend = contentCommand(page, 'RT_SEND', {
      operationId: 'chatgpt-cancel-send',
      text: 'Cancel this pending submission',
    });
    await page.waitForTimeout(350);
    const cancelled = await contentCommand(page, 'RT_CANCEL', {
      operationId: 'chatgpt-cancel-send',
    });
    const result = await pendingSend;

    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.count, 1);
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.code, 'cancelled');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('Gemini adapter sends once and captures a stable answer', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    .ql-editor { display:block; min-height:40px; width:300px; }
    button { display:block; width:80px; height:30px; }
  </style></head><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button type="button" class="send-button" aria-label="Send message">Send</button>
    <main id="turns"></main>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('.ql-editor');
      const sendButton = document.querySelector('button.send-button');
      sendButton.disabled = true;
      composer.addEventListener('input', () => {
        const lines = composer.innerText.replace(/\\n{2,}/g, '\\n').split('\\n');
        const fragment = document.createDocumentFragment();
        for (const line of lines) {
          const paragraph = document.createElement('p');
          paragraph.textContent = line;
          fragment.append(paragraph);
        }
        composer.replaceChildren(fragment);
        sendButton.disabled = !composer.textContent.trim();
      });
      sendButton.addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const prompt = composer.textContent.trim();
        composer.replaceChildren();
        const user = document.createElement('user-query');
        user.dataset.messageId = 'u-new';
        user.textContent = prompt;
        document.querySelector('#turns').append(user);
        const stop = document.createElement('button');
        stop.setAttribute('aria-label', 'Stop response');
        stop.textContent = 'Stop';
        document.body.append(stop);
        setTimeout(() => {
          const answer = document.createElement('model-response');
          answer.dataset.messageId = 'a-new';
          answer.innerHTML = '<div class="model-response-text">Gemini answer</div>';
          document.querySelector('#turns').append(answer);
          stop.remove();
        }, 120);
      });
    </script>
  </body></html>`;

  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-send',
      text: '接续 ChatGPT 的讨论：\n\n用户：\nRoundtable prompt',
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, true);
    assert.equal(sent.result.submitMethod, 'button-click');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
    const repeated = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-send',
      text: '接续 ChatGPT 的讨论：\n\n用户：\nRoundtable prompt',
    });
    assert.equal(repeated.result.repeated, true);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);

    const completed = await contentCommand(page, 'RT_WAIT', {
      operationId: 'gemini-wait',
      sendResult: sent.result,
      timeoutMs: 6000,
      pollMs: 500,
      stableMilliseconds: 1000,
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.result.answer, 'Gemini answer');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('Gemini and DeepSeek composers preserve Markdown whitespace through submission', { skip: skipBrowser }, async () => {
  const prompt = '标题：\n\n**重点**\n\n```js\nif (a < b && ok) {\n    run("a  b");\n\n\n}\n```';
  for (const [provider, textarea] of [['gemini', false], ['deepseek', false], ['deepseek', true]]) {
    const editor = textarea ? '<textarea placeholder="Message DeepSeek"></textarea>'
      : '<div class="ql-editor" contenteditable="true" role="textbox"></div>';
    const html = `<style>.ql-editor, textarea { min-height:40px; width:300px; white-space:pre-wrap; }</style>
      <form><rich-textarea>${editor}</rich-textarea><button id="send" type="submit" class="send-button" aria-label="Send message">Send</button></form><main id="turns"></main>`;
    await withProviderPage('about:blank', html, `${provider}.js`, async (page) => {
      await page.evaluate((site) => {
        const composer = document.querySelector('textarea, .ql-editor');
        document.querySelector('#send').addEventListener('click', (event) => {
          event.preventDefault();
          const text = 'value' in composer ? composer.value : composer.innerText;
          window.__submitted = text;
          if ('value' in composer) composer.value = '';
          else composer.replaceChildren();
          const user = document.createElement(site === 'gemini' ? 'user-query' : 'div');
          if (site === 'gemini') {
            user.dataset.messageId = 'u-new';
            user.innerHTML = '<div class="query-content"><div class="query-text"></div></div>';
            user.querySelector('.query-text').textContent = text;
          } else {
            user.dataset.virtualListItemKey = '1';
            user.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div></div>';
            user.querySelector('.ds-collapsible-text').textContent = text;
          }
          document.querySelector('#turns').append(user);
        });
      }, provider);
      const sent = await contentCommand(page, 'RT_SEND', { operationId: `${provider}-format`, text: prompt });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      assert.equal(sent.result.confirmed, true);
      assert.equal(await page.evaluate(() => window.__submitted), prompt);
      const inspected = await contentCommand(page, 'RT_INSPECT', { force: true });
      assert.equal(inspected.snapshot.messages.at(-1).text, prompt);
    });
  }
});

test('Gemini adapter does not click when rich-text content is actually incomplete', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    .ql-editor { display:block; min-height:40px; width:300px; }
    button { display:block; width:80px; height:30px; }
  </style></head><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button type="button" data-test-id="send-message-button" aria-label="Send">Send</button>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('.ql-editor');
      composer.addEventListener('input', () => {
        const current = composer.textContent;
        composer.textContent = current.slice(0, -1);
      });
      document.querySelector('button').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
      });
    </script>
  </body></html>`;

  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-incomplete',
      text: 'This must remain complete',
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, 'composer-verify-failed');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('Gemini adapter does not treat a missing word separator as rich-text reflow', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    .ql-editor { display:block; min-height:40px; width:300px; }
    button { display:block; width:80px; height:30px; }
  </style></head><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button type="button" class="send-button" aria-label="Send message">Send</button>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('.ql-editor');
      composer.addEventListener('input', () => {
        composer.textContent = composer.textContent.replace('Chat GPT', 'ChatGPT');
      });
      document.querySelector('button').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
      });
    </script>
  </body></html>`;

  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-missing-space',
      text: 'Send to Chat GPT now',
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, 'composer-verify-failed');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('DeepSeek DOM adapter confirms by virtual-list item and keeps a stable bookmark id', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><head><style>
    textarea, #send { display:block; width:300px; min-height:30px; }
  </style></head><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <div id="send" role="button" class="ds-button--primary ds-button--filled ds-button--circle">发送</div>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('textarea');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const prompt = composer.value;
        composer.value = '';
        const row = document.createElement('div');
        row.dataset.virtualListItemKey = '-2';
        row.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div></div>';
        row.querySelector('.ds-collapsible-text').textContent = prompt;
        document.querySelector('#conversation').append(row);
        history.replaceState({}, '', '?chat_session_id=0ce51650-28fe-4918-b64d-bffb6e08a404');
      });
    </script>
  </body></html>`;

  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-send',
      text: '这里是一段足够长的 DeepSeek 测试消息，用来验证虚拟列表行身份。',
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, true);
    assert.match(sent.result.conversationKey, /^deepseek:/);
    assert.equal(sent.result.userMessageId, 'deepseek-item:-2:q');
    assert.equal(sent.result.insertedMessage.domKey, '-2:q');
    assert.equal(sent.result.insertedMessage.turnOrdinal, 0);
    assert.equal(Number.isInteger(sent.result.timings.confirmMs), true);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);

    const inspected = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(inspected.ok, true);
    assert.equal(inspected.snapshot.messages[0].id, 'deepseek-item:-2:q');
    assert.equal(inspected.snapshot.messages[0].domKey, '-2:q');
    assert.equal(inspected.snapshot.strategy, 'deepseek-dom');

    const repeated = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-send',
      text: '这里是一段足够长的 DeepSeek 测试消息，用来验证虚拟列表行身份。',
    });
    assert.equal(repeated.result.repeated, true);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('DeepSeek real-DOM extractor keeps virtual-list identity and strips thinking/UI', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <section id="conversation">
      <div data-virtual-list-item-key="1">
        <div class="ds-message"><div class="ds-collapsible-text">第一问<button>复制</button></div></div>
      </div>
      <div data-virtual-list-item-key="2">
        <div class="ds-message"><div class="ds-assistant-message-main-content">
          <div class="ds-think-content">隐藏的思考过程</div>
          <div class="ds-markdown"><p>第一答</p></div>
        </div></div>
        <div role="button" aria-label="朗读">朗读</div>
      </div>
      <div data-virtual-list-item-key="3">
        <div class="ds-message"><div class="ds-collapsible-text">第二问</div></div>
      </div>
      <div data-virtual-list-item-key="4">
        <div class="ds-message"><div class="ds-assistant-message-main-content">
          <div class="ds-markdown"><p>第二答</p></div>
        </div></div>
        <div role="button" aria-label="朗读">朗读</div>
      </div>
    </section>
  </body></html>`;

  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(inspected.ok, true);
    const messages = inspected.snapshot.messages;
    assert.deepEqual(messages.map((message) => message.id), [
      'deepseek-item:1:q', 'deepseek-item:2:a', 'deepseek-item:3:q', 'deepseek-item:4:a',
    ]);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(messages[0].turnOrdinal, 0);
    assert.equal(messages[0].identity, 'virtual-key');
    assert.equal(messages[1].identity, 'virtual-key');
    assert.equal(messages[2].turnOrdinal, 1);
    assert.equal(messages[2].previousAssistantHash, core.messageHash(messages[1]));
    assert.equal(messages[1].text, '第一答');
    assert.equal(messages[3].text, '第二答');
    assert.ok(!messages[1].text.includes('隐藏的思考过程'));
    assert.equal(messages[1].thinking, '隐藏的思考过程');
    assert.ok(!JSON.stringify(messages).includes('朗读'));
    assert.equal(inspected.snapshot.strategy, 'deepseek-dom');
  });
});

test('DeepSeek folded DOM re-render resolves the target bookmark by sent fingerprint', { skip: skipBrowser }, async () => {
  const full = '这是完整的用户消息，页面初次只显示折叠后的短预览。';
  const folded = '这是完整的用户消息…';
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <section id="conversation">
      <div data-virtual-list-item-key="-2"><div class="ds-message"><div class="ds-collapsible-text">${folded}</div></div></div>
      <div data-virtual-list-item-key="2"><div class="ds-message"><div class="ds-assistant-message-main-content"><div class="ds-markdown">回答</div></div></div><div role="button" aria-label="朗读">朗读</div></div>
    </section>
  </body></html>`;

  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const before = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(before.ok, true);
    const cursor = {
      ...core.makeCursor(before.snapshot.messages[0], 0, 'deepseek:thread'),
      sentMessageHash: core.messageHash({ role: 'user', text: full }),
      sentCompactHash: core.hashText(core.normalizeText(full).replace(/\s+/gu, '')),
    };
    await page.evaluate(({ full }) => {
      const item = document.querySelector('[data-virtual-list-item-key="-2"]');
      item.setAttribute('data-virtual-list-item-key', '7');
      item.querySelector('.ds-collapsible-text').textContent = full;
      const answer = document.querySelector('[data-virtual-list-item-key="2"]');
      answer.setAttribute('data-virtual-list-item-key', '8');
    }, { full });
    await page.waitForTimeout(500);
    const after = await contentCommand(page, 'RT_INSPECT', {});
    const messages = after.snapshot.messages;
    assert.deepEqual(messages.map((message) => message.id), ['deepseek-item:7:q', 'deepseek-item:8:a']);
    assert.ok(['sent-fingerprint', 'turn-structure'].includes(core.findCursorIndex(messages, cursor).method));
    assert.equal(core.getRelayPlan(messages, cursor, 'deepseek:thread').kind, 'incremental');
  });
});

test('DeepSeek virtual window after refresh resolves a bookmarked user turn', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <section id="conversation">
      <div data-virtual-list-item-key="1"><div class="ds-message"><div class="ds-collapsible-text">更早的问题</div></div></div>
      <div data-virtual-list-item-key="2"><div class="ds-message"><div class="ds-assistant-message-main-content"><div class="ds-markdown">更早的回答</div></div></div><div role="button" aria-label="朗读">朗读</div></div>
      <div data-virtual-list-item-key="3"><div class="ds-message"><div class="ds-collapsible-text">当前书签问题</div></div></div>
      <div data-virtual-list-item-key="4"><div class="ds-message"><div class="ds-assistant-message-main-content"><div class="ds-markdown">当前书签回答</div></div></div><div role="button" aria-label="朗读">朗读</div></div>
    </section>
  </body></html>`;

  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const before = await contentCommand(page, 'RT_INSPECT', {});
    const bookmarkMessage = before.snapshot.messages[2];
    const cursor = {
      ...core.makeCursor(bookmarkMessage, 2, 'deepseek:thread'),
      sentMessageHash: core.messageHash({ role: 'user', text: '当前书签问题' }),
      sentCompactHash: core.hashText(core.normalizeText('当前书签问题').replace(/\s+/gu, '')),
    };
    // Refresh/virtualization keeps only the current message pair and renumbers rows.
    await page.evaluate(() => {
      const conversation = document.querySelector('#conversation');
      conversation.innerHTML = `
        <div data-virtual-list-item-key="5"><div class="ds-message"><div class="ds-collapsible-text">当前书签问题</div></div></div>
        <div data-virtual-list-item-key="6"><div class="ds-message"><div class="ds-assistant-message-main-content"><div class="ds-markdown">当前书签回答</div></div></div><div role="button" aria-label="朗读">朗读</div></div>`;
    });
    await page.waitForTimeout(500);
    const after = await contentCommand(page, 'RT_INSPECT', {});
    const messages = after.snapshot.messages;
    assert.deepEqual(messages.map((message) => message.id), ['deepseek-item:5:q', 'deepseek-item:6:a']);
    assert.equal(core.findCursorIndex(messages, cursor).method, 'hash');
    assert.equal(core.getRelayPlan(messages, cursor, 'deepseek:thread').kind, 'incremental');
  });
});

test('DeepSeek partial send without folding evidence is not confirmed', { skip: skipBrowser }, async () => {
  const full = '这是一条用于验证部分发送不会被误认为折叠预览的完整测试消息，长度足够长。';
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <div id="send" role="button" class="ds-button--primary">发送</div>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('textarea');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const prompt = composer.value;
        composer.value = '';
        const row = document.createElement('div');
        row.dataset.virtualListItemKey = '-2';
        row.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div></div>';
        row.querySelector('.ds-collapsible-text').textContent = prompt.slice(0, 30);
        document.querySelector('#conversation').append(row);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-partial-no-fold',
      text: full,
      sendTimeoutMs: 1000,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, false);
    assert.equal(sent.result.sent, false);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('DeepSeek partial send with explicit fold control can be confirmed', { skip: skipBrowser }, async () => {
  const full = '这是一条用于验证折叠预览确认的完整测试消息，长度足够长，后面还有更多正文。';
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <div id="send" role="button" class="ds-button--primary">发送</div>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('textarea');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const prompt = composer.value;
        composer.value = '';
        const row = document.createElement('div');
        row.dataset.virtualListItemKey = '-2';
        row.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div><button type="button">展开</button></div>';
        row.querySelector('.ds-collapsible-text').textContent = prompt.slice(0, 30);
        document.querySelector('#conversation').append(row);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-partial-with-fold',
      text: full,
      sendTimeoutMs: 2000,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, true);
    assert.equal(sent.result.matchType, 'collapsed-preview');
    assert.equal(sent.result.collapsedEvidence, true);
    assert.equal(sent.result.insertedMessage.folded, true);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('DeepSeek rejects a target conversation mismatch before writing or submitting', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <div id="send" role="button" class="ds-button--primary">发送</div>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      document.querySelector('#send').addEventListener('click', () => { globalThis.__sendClicks += 1; });
    </script>
  </body></html>`;
  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-target-mismatch',
      text: '不应被写入的目标测试消息。',
      expectedConversationKey: 'deepseek:244f81b8-e392-4f13-90da-fa5dd05c3eaf',
    });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error?.code || ''), /target-conversation-changed/i);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('DeepSeek rejects a conversation switch after submit before delivery confirmation', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <form><textarea placeholder="Message DeepSeek"></textarea>
    <button id="send" type="submit">Send</button></form>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      document.querySelector('#send').addEventListener('click', (event) => {
        event.preventDefault();
        globalThis.__sendClicks += 1;
        document.querySelector('textarea').value = '';
        history.replaceState({}, '', '/a/chat/s/first-conversation');
        setTimeout(() => history.replaceState({}, '', '/a/chat/s/other-conversation'), 350);
      });
    </script>
  </body></html>`;
  await withProviderPageAt('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-switch-after-submit',
      text: '提交后切换对话的测试消息。',
      expectedConversationKey: 'deepseek:new:/',
      sendTimeoutMs: 2000,
    });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error?.code || ''), /target-conversation-changed/i);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('DeepSeek legal new-chat URL update still confirms without history API', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <form><textarea placeholder="Message DeepSeek"></textarea>
    <button id="send" type="submit">Send</button></form>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      globalThis.__fetchCalls = 0;
      globalThis.fetch = () => {
        globalThis.__fetchCalls += 1;
        return Promise.resolve(new Response('rate limited', { status: 429 }));
      };
      document.querySelector('#send').addEventListener('click', (event) => {
        event.preventDefault();
        globalThis.__sendClicks += 1;
        const composer = document.querySelector('textarea');
        const prompt = composer.value;
        composer.value = '';
        const row = document.createElement('div');
        row.dataset.virtualListItemKey = '-2';
        row.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div></div>';
        row.querySelector('.ds-collapsible-text').textContent = prompt;
        document.querySelector('#conversation').append(row);
        history.replaceState({}, '', '/a/chat/s/first-conversation');
      });
    </script>
  </body></html>`;
  await withProviderPageAt('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-legal-new-route',
      text: '新对话第一次发送的测试消息。',
      expectedConversationKey: 'deepseek:new:/',
      sendTimeoutMs: 2000,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, true);
    assert.equal(sent.result.conversationKey, 'deepseek:first-conversation');
    assert.equal(sent.result.conversationTransition, 'new-to-real');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
    assert.equal(await page.evaluate(() => globalThis.__fetchCalls), 0);
  });
});

test('DeepSeek root-to-real SPA route update is allowed during inspect', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <section id="conversation">
      <div data-virtual-list-item-key="-2"><div class="ds-message"><div class="ds-collapsible-text">第一问</div></div></div>
      <div data-virtual-list-item-key="2"><div class="ds-message"><div class="ds-assistant-message-main-content"><div class="ds-markdown">回答</div></div></div><div role="button" aria-label="朗读">朗读</div></div>
    </section>
  </body></html>`;
  await withProviderPageAt('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const id = '0ce51650-28fe-4918-b64d-bffb6e08a404';
    await page.evaluate(({ id }) => {
      setTimeout(() => history.replaceState({}, '', `/a/chat/s/${id}`), 120);
    }, { id });
    const inspected = await contentCommand(page, 'RT_INSPECT', { expectedConversationId: id });
    assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
    assert.equal(inspected.snapshot.conversationKey, `deepseek:${id}`);
    assert.equal(page.url(), `https://chat.deepseek.com/a/chat/s/${id}`);
  });
});



test('DeepSeek legacy DOM fallback is explicitly marked as text-hash identity', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <section id="conversation">
      <div class="fbb737a4">旧版用户消息</div>
      <div class="ds-markdown">旧版助手消息</div>
    </section>
  </body></html>`;
  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(inspected.ok, true);
    assert.deepEqual(inspected.snapshot.messages.map((message) => message.identity),
      ['text-hash', 'text-hash']);
    assert.match(inspected.snapshot.messages[0].id, /^deepseek-dom-user-/);
  });
});

test('DeepSeek unrelated expand control in the same virtual row is not fold evidence', { skip: skipBrowser }, async () => {
  const full = '这是一条用于验证同一虚拟行其他展开按钮不能作为正文折叠证据的完整消息，长度足够长。';
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <div id="send" role="button" class="ds-button--primary">发送</div>
    <section id="conversation"></section>
    <script>
      const composer = document.querySelector('textarea');
      document.querySelector('#send').addEventListener('click', () => {
        const prompt = composer.value;
        composer.value = '';
        const row = document.createElement('div');
        row.dataset.virtualListItemKey = '-2';
        row.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div></div><button type="button">展开</button>';
        row.querySelector('.ds-collapsible-text').textContent = prompt.slice(0, 30);
        document.querySelector('#conversation').append(row);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-partial-row-fold-control',
      text: full,
      sendTimeoutMs: 1000,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, false);
    assert.equal(sent.result.sent, false);
  });
});

test('DeepSeek nested quote aria-expanded is not evidence that the user body was folded', { skip: skipBrowser }, async () => {
  const full = '这是一条应当完整发送的长消息，但页面实际只显示了开头，正文并没有折叠，因此不能确认送达。'.repeat(2);
  const html = `<!doctype html><html><body>
    <textarea placeholder="Message DeepSeek"></textarea>
    <div id="send" role="button" class="ds-button--primary">发送</div>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const composer = document.querySelector('textarea');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const prompt = composer.value;
        composer.value = '';
        const row = document.createElement('div');
        row.dataset.virtualListItemKey = '-2';
        row.innerHTML = '<div class="ds-message"><div class="ds-collapsible-text"></div></div>';
        const body = row.querySelector('.ds-collapsible-text');
        body.textContent = prompt.slice(0, 30);
        const quote = document.createElement('span');
        quote.className = 'quoted-reference';
        quote.setAttribute('aria-expanded', 'false');
        quote.style.cssText = 'display:inline-block;width:6px;height:6px';
        body.append(quote);
        document.querySelector('#conversation').append(row);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://chat.deepseek.com/', html, 'deepseek.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'deepseek-nested-quote-fold-state',
      text: full,
      sendTimeoutMs: 1000,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, false);
    assert.equal(sent.result.sent, false);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});


test('Gemini send confirmation rejects foo bar vs foobar', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        box.innerHTML = '';
        const node = document.createElement('user-query');
        node.innerHTML = '<div class="query-content"><div class="query-text">foobar</div></div>';
        document.querySelector('#conversation').append(node);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', { operationId: 'gemini-space-collision', text: 'foo bar', sendTimeoutMs: 1000 });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, false);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('Gemini send confirmation rejects Chinese space collision', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        box.innerHTML = '';
        const node = document.createElement('user-query');
        node.innerHTML = '<div class="query-content"><div class="query-text">修改小说</div></div>';
        document.querySelector('#conversation').append(node);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', { operationId: 'gemini-cn-space-collision', text: '修改 小说', sendTimeoutMs: 1000 });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, false);
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('Gemini send confirmation accepts semantic line wrapping', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        box.innerHTML = '';
        const node = document.createElement('user-query');
        node.innerHTML = '<div class="query-content"><div class="query-text">alpha beta</div></div>';
        document.querySelector('#conversation').append(node);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', { operationId: 'gemini-line-wrap', text: 'alpha\nbeta', sendTimeoutMs: 1000 });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.confirmed, true);
  });
});

test('Gemini confirms its submitted user bubble after the site removes paragraph breaks', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        const text = box.innerText;
        box.replaceChildren();
        const node = document.createElement('user-query');
        node.innerHTML = '<div class="query-text"></div>';
        node.querySelector('.query-text').textContent = text.replace(/\\n+/g, '');
        document.querySelector('#conversation').append(node);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-reflow-receipt', text: '第一段：alpha\n\nbeta', sendTimeoutMs: 2000,
    });
    assert.equal(sent.ok, true, JSON.stringify(sent.error));
    assert.equal(sent.result.confirmed, true);
    assert.equal(sent.result.matchType, 'reflow');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
  });
});

test('Gemini restores paragraph breaks after an editor drops them on the first insertion', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.execCommand = (command) => {
        if (command !== 'insertHTML') return false;
        // Simulate Quill collapsing blank lines and inserting a zero-width space.
        box.textContent = '甲乙\\u200B';
        return true;
      };
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        globalThis.__submittedHtml = box.innerHTML;
        box.innerHTML = '';
        const node = document.createElement('user-query');
        node.innerHTML = '<div class="query-content"><div class="query-text">甲乙</div></div>';
        document.querySelector('#conversation').append(node);
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', { operationId: 'gemini-invisible-marker', text: '甲\n\n乙', sendTimeoutMs: 1200 });
    assert.equal(sent.ok, true, JSON.stringify(sent.error));
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
    assert.match(await page.evaluate(() => globalThis.__submittedHtml || ''), /<p>甲<\/p><p>乙<\/p>/);
  });
});

test('Gemini does not send when its editor reduces a blank line to one break', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button type="button" class="send-button" aria-label="Send message">Send</button>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.execCommand = () => { box.textContent = '甲\\n乙'; return true; };
      box.replaceChildren = () => { box.textContent = '甲\\n乙'; };
      document.querySelector('button').addEventListener('click', () => { globalThis.__sendClicks += 1; });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-blank-line-lost', text: '甲\n\n乙', sendTimeoutMs: 1200,
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.error?.code, 'composer-format-failed');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('Gemini sends with multiple original blank lines still in its editor', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.querySelector('button').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
        globalThis.__submittedText = box.innerText;
        const node = document.createElement('user-query');
        node.innerHTML = '<div class="query-content"><div class="query-text"></div></div>';
        node.querySelector('.query-text').textContent = globalThis.__submittedText;
        document.querySelector('#conversation').append(node);
        box.replaceChildren();
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-multiple-blank-lines', text: '第一段\n\n\n第二段', sendTimeoutMs: 1200,
    });
    assert.equal(sent.ok, true, JSON.stringify(sent.error));
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 1);
    assert.match(await page.evaluate(() => globalThis.__submittedText), /第一段\n{3,}第二段/u);
  });
});

test('Gemini leaves a flattened long relay unsent when its editor refuses paragraph markup', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.execCommand = () => { box.textContent = '接续 ChatGPT 的讨论：The first answer.第二段'; return true; };
      box.replaceChildren = () => { box.textContent = '接续 ChatGPT 的讨论：The first answer.第二段'; };
      document.querySelector('#send').addEventListener('click', () => { globalThis.__sendClicks += 1; });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', {
      operationId: 'gemini-flattened-paragraphs',
      text: '接续 ChatGPT 的讨论：\n\nThe first answer.\n\n第二段',
      sendTimeoutMs: 1200,
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.error?.code, 'composer-format-failed');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('Gemini composer verification keeps English word boundaries while tolerating repainted paragraphs', { skip: skipBrowser }, async () => {
  await withProviderPage('https://gemini.google.com/app', '<!doctype html><html><body></body></html>', 'gemini.js', async (page) => {
    const result = await page.evaluate(() => ({
      complete: RoundtableDomText.composerMatch(
        '接续 ChatGPT 的讨论：\n\nThe first answer.\n\n第二段',
        '接续 ChatGPT 的讨论：The first answer.第二段',
      ),
      missingWordBoundary: RoundtableDomText.composerMatch(
        '接续 ChatGPT 的讨论：\n\nThe first answer.\n\n第二段',
        '接续 ChatGPT 的讨论：The firstanswer.第二段',
      ),
      missingLaterWordBoundary: RoundtableDomText.composerMatch('foo bar baz', 'foo barbaz'),
      missingChineseSpace: RoundtableDomText.composerMatch('修改 小说', '修改小说'),
      missingBlankLine: RoundtableDomText.lineBreaksPreserved('甲\n\n乙', '甲\n乙'),
      missingWhitespaceOnlyLine: RoundtableDomText.lineBreaksPreserved('甲\n \n乙', '甲\n乙'),
      missingLaterBlankLine: RoundtableDomText.lineBreaksPreserved(
        '甲\n\n乙\n\n\n丙', '甲\n\n乙\n\n丙'),
      missingContent: RoundtableDomText.composerMatch('甲\n\n乙', '甲'),
    }));
    assert.equal(result.complete, true);
    assert.equal(result.missingWordBoundary, false);
    assert.equal(result.missingLaterWordBoundary, false);
    assert.equal(result.missingChineseSpace, false);
    assert.equal(result.missingBlankLine, false);
    assert.equal(result.missingWhitespaceOnlyLine, false);
    assert.equal(result.missingLaterBlankLine, false);
    assert.equal(result.missingContent, false);
  });
});

test('Gemini DOM bookmark identity reaches the full-history merge', { skip: skipBrowser }, async () => {
  const html = '<!doctype html><html><body><user-query><div class="query-text">问题</div></user-query><model-response><message-content><div class="markdown"><p><strong>答案</strong></p><p>第一段</p><p>第二段</p></div></message-content></model-response></body></html>';
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const result = await page.evaluate(async () => {
      const dom = (await RoundtableContent.currentAdapter().inspect({})).messages;
      const answer = dom.find((message) => message.role === 'assistant');
      const api = [
        { id: 'server-u1', role: 'user', text: '问题' },
        { id: 'server-a1', role: 'assistant', text: '**答案**[cite: 3, 5]\n\n第一段\n\n第二段' },
      ];
      const bookmark = RoundtableCore.makeStartCursor(dom, 1, 'gemini:thread');
      const oldBookmark = { ...bookmark };
      delete oldBookmark.renderedCompactHash;
      const merged = RoundtableRelayHistory.mergeIdentities(api, dom);
      const apiOnly = api.map(RoundtableMarkdownIdentity.annotate);
      return {
        hasCompactIdentity: Boolean(answer.renderedCompactHash),
        bookmarkFound: RoundtableCore.findCursorIndex(merged, bookmark).index,
        unmountedBookmarkFound: RoundtableCore.findCursorIndex(apiOnly, bookmark).index,
        oldBookmarkFound: RoundtableCore.findCursorIndex(apiOnly, oldBookmark).index,
        preservedCitation: merged[1].text.includes('[cite: 3, 5]'),
      };
    });
    assert.equal(result.hasCompactIdentity, true);
    assert.equal(result.bookmarkFound, 1);
    assert.equal(result.unmountedBookmarkFound, 1);
    assert.equal(result.oldBookmarkFound, 1);
    assert.equal(result.preservedCitation, true);
  });
});

test('Gemini still rejects a composer that really lost content', { skip: skipBrowser }, async () => {
  const html = `<!doctype html><html><body>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" class="send-button" aria-label="Send message">Send</button>
    <section id="conversation"></section>
    <script>
      globalThis.__sendClicks = 0;
      const box = document.querySelector('.ql-editor');
      document.execCommand = (command) => {
        if (command !== 'insertHTML') return false;
        box.textContent = '甲';
        return true;
      };
      // Also defeat the paragraph fallback so this editor really lost content.
      box.replaceChildren = () => { box.textContent = '甲'; };
      document.querySelector('#send').addEventListener('click', () => {
        globalThis.__sendClicks += 1;
      });
    </script>
  </body></html>`;
  await withProviderPage('https://gemini.google.com/app', html, 'gemini.js', async (page) => {
    const sent = await contentCommand(page, 'RT_SEND', { operationId: 'gemini-really-lost', text: '甲\n\n乙', sendTimeoutMs: 1200 });
    assert.equal(sent.ok, false);
    assert.equal(sent.error?.code, 'composer-verify-failed');
    assert.equal(await page.evaluate(() => globalThis.__sendClicks), 0);
  });
});

test('relay merge keeps a bookmark when API and DOM whitespace differ', { skip: skipBrowser }, async () => {
  const html = '<!doctype html><html><body></body></html>';
  await withProviderPage('https://gemini.google.com/app/x', html, 'gemini.js', async (page) => {
    const result = await page.evaluate(() => {
      const api = [
        { id: 'u1', role: 'user', text: '问题一' },
        { id: 'a1', role: 'assistant', text: '**答案**\n\n第一段\n\n第二段' },
        { id: 'u2', role: 'user', text: '继续' },
        { id: 'a2', role: 'assistant', text: '第二答案' },
      ];
      const dom = [{
        id: 'gemini-dom-assistant-1', role: 'assistant', text: '答案\n\n第一段\n\n第二段',
        contentAliases: [],
        renderedHash: RoundtableCore.semanticHash('答案 第一段 第二段'),
        renderedCompactHash: RoundtableCore.compactHash('答案第一段第二段'),
      }];
      const merged = RoundtableRelayHistory.mergeIdentities(api, dom);
      const cursor = RoundtableCore.makeStartCursor(dom, 0, 'gemini:1');
      const located = RoundtableCore.findCursorIndex(merged, cursor);
      const plan = RoundtableCore.getRelayPlan(merged, cursor, 'gemini:1');
      return {
        located: located.index,
        kind: plan.kind,
        ids: plan.messages.map((message) => message.id),
        attached: merged[1].renderedCompactHash === dom[0].renderedCompactHash,
      };
    });
    assert.equal(result.located, 1);
    assert.equal(result.kind, 'incremental');
    assert.deepEqual(result.ids, ['a1', 'u2', 'a2']);
    assert.equal(result.attached, true);
  });
});

test('an empty new Gemini chat is a connected empty snapshot, not an error', { skip: skipBrowser }, async () => {
  const html = '<!doctype html><html><body><main>Start a new chat</main></body></html>';
  await withProviderPageAt('https://gemini.google.com/app?dest=create', html, 'gemini.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
    assert.equal(inspected.snapshot.messages.length, 0);
    assert.equal(inspected.snapshot.empty, true);
    assert.equal(inspected.snapshot.conversationKey, 'gemini:new:/app');
  });
});

test('an empty new ChatGPT chat is a connected empty snapshot, not an error', { skip: skipBrowser }, async () => {
  const html = '<!doctype html><html><body><main>What can I help with?</main></body></html>';
  await withProviderPageAt('https://chatgpt.com/', html, 'chatgpt.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
    assert.equal(inspected.snapshot.messages.length, 0);
    assert.equal(inspected.snapshot.empty, true);
    assert.equal(inspected.snapshot.conversationKey, 'chatgpt:new:/');
  });
});

test('an existing conversation with no mounted messages is still a read error', { skip: skipBrowser }, async () => {
  const html = '<!doctype html><html><body><main>Loading</main></body></html>';
  await withProviderPageAt('https://gemini.google.com/app/chat-123', html, 'gemini.js', async (page) => {
    const inspected = await contentCommand(page, 'RT_INSPECT', {});
    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'dom-empty');
  });
});
