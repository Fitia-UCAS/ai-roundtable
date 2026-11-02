'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  if (process.env.PLAYWRIGHT_MODULE_PATH) {
    try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH)); } catch {}
  }
}

test('side panel renders model, bold prompt, reply, and a divider-free action menu',
  { skip: chromium ? false : 'Playwright unavailable' }, async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BROWSER_PATH || (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        : '/usr/bin/chromium'),
      args: process.platform === 'win32' ? [] : ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 350, height: 760 } });
      await page.addInitScript(() => {
        const state = {
          session: { id: 's1', title: '测试对话成功', saveMode: 'relay' },
          sessions: [{ id: 's1', title: '测试对话成功' }],
          sourceTabId: 11, activeTabId: 11,
          supportedTabs: [{ tabId: 11, provider: 'chatgpt', conversationKey:'chatgpt:chat-1', connected: true, online: true },
            { tabId: 22, provider: 'gemini', connected: true, online: true }],
          timeline: [
            { operationId: 'o1', source: { provider: 'chatgpt' }, target: { provider: 'gemini', tabId: 22 }, status: 'sent', createdAt: 1792449660000 },
            { operationId: 'o2', source: { provider: 'gemini' }, target: { provider: 'chatgpt', tabId: 11 }, status: 'sent', createdAt: 1792449690000 },
          ],
          bookmarks: { 'chatgpt:chat-1': { messageId: 'saved' } },
          activeOperation: null,
        };
        const transfers = [
          {operationId:'o1',sourceProvider:'chatgpt',provider:'gemini',userText:'帮我总结这段讨论',
            sourceText:'我们分析了角色设定',answerText:'建议减少重复描写。',createdAt:1792449660000},
          {operationId:'o2',sourceProvider:'gemini',provider:'chatgpt',userText:'请进一步修改对白',
            sourceText:'ChatGPT 提到了节奏问题',answerText:'可以减少心理独白。',createdAt:1792449690000},
        ];
        const event = { addListener() {} };
        globalThis.chrome = {
          runtime: { lastError: null, getURL: (file) => file, sendMessage(request, callback) {
            if (request.type === 'RT_ARCHIVE_READ' || request.type === 'RT_ARCHIVE_REFRESH') {
              callback({ ok: true, state, session: state.session,
                archive: { sessionId: 's1', transfers, history: [] } });
            } else if (request.type === 'RT_SETTINGS_GET') {
              callback({ ok: true, state, preferences: { defaultSaveMode: 'relay' } });
            } else callback({ ok: true, state });
          }, onMessage: event },
          windows: { async getCurrent() { return { id: 1 }; } },
          tabs: { onActivated: event, onUpdated: event, onRemoved: event, create() {} },
          storage: { local: { get(_key, callback) { callback({}); }, set(_values, callback) { callback?.(); } } },
        };
      });
      await page.goto('about:blank');
      const root = path.join(__dirname, '..');
      const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8')
        .replace(/<link[^>]+sidepanel\.css[^>]*>/, '')
        .replace(/<script src="sidepanel\.js"><\/script>/, '');
      await page.setContent(html);
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8') });
      const images = Object.fromEntries(['chatgpt', 'gemini', 'deepseek'].map((provider) => [
        `icons/${provider}.png`,
        `data:image/png;base64,${fs.readFileSync(path.join(root, 'icons', provider + '.png')).toString('base64')}`,
      ]));
      images['icons/logo.svg'] = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'icons/logo.svg')).toString('base64')}`;
      await page.evaluate((assets) => {
        document.querySelectorAll('img[src]').forEach((img) => {
          const source = img.getAttribute('src');
          if (assets[source]) img.src = assets[source];
        });
      }, images);
      await page.locator('.entry-prompt').first().waitFor({ state: 'visible' });
      assert.equal(await page.locator('#timeline .relay-entry').count(), 2);
      assert.equal((await page.locator('.entry-model-name').first().innerText()).trim(), 'ChatGPT');
      assert.equal((await page.locator('.entry-prompt').first().innerText()).trim(), '帮我总结这段讨论');
      assert.equal((await page.locator('.entry-answer').first().innerText()).trim(), '我们分析了角色设定');
      assert.equal(await page.locator('.entry-summary img').count(), 2);
      assert.equal(await page.locator('#model-picker .model-button').count(), 3);
      // The direction switch shares the model button's circle, diameter and hover treatment.
      const circles = await page.locator('#model-picker .model-button, #swap-direction').evaluateAll((buttons) =>
        buttons.map((button) => {
          const css = getComputedStyle(button);
          const box = button.getBoundingClientRect();
          return { width: box.width, height: box.height, radius: css.borderRadius,
            border: css.borderTopWidth };
        }));
      assert.equal(circles.length, 4);
      for (const circle of circles.slice(1)) assert.deepEqual(circle, circles[0]);
      assert.equal(await page.locator('#instruction').getAttribute('placeholder'), '');
      const weight = await page.locator('.entry-prompt').first().evaluate((el) => getComputedStyle(el).fontWeight);
      assert.ok(Number(weight) >= 600);
      await page.locator('#more-button').click();
      assert.equal(await page.locator('#more-menu button:visible').count(), 1);
      assert.equal(await page.locator('#more-menu [data-action="pick-bookmark"]').count(), 0);
      assert.equal(await page.locator('#more-menu [data-action="refresh"]').count(), 0);
      assert.equal(await page.locator('#more-menu [data-action="export"]').count(), 0);
      assert.equal(await page.locator('#pick-bookmark').count(), 0);
      assert.equal(await page.locator('#export-discussion').count(), 1);
      assert.equal(await page.locator('#refresh-connection').count(), 1);
      assert.equal(await page.locator('#more-menu hr').count(), 0);
      const hovered = page.locator('#more-menu [data-action="settings"]');
      await hovered.hover();
      assert.notEqual(await hovered.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
      if (process.env.ROUNDTABLE_UI_SCREENSHOT) {
        await page.screenshot({ path: process.env.ROUNDTABLE_UI_SCREENSHOT, fullPage: true });
      }
    } finally { await browser.close(); }
  });

test('side panel notices stay outside the relay list and do not auto-hide',
  { skip: chromium ? false : 'Playwright unavailable' }, async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BROWSER_PATH || (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        : '/usr/bin/chromium'),
      args: process.platform === 'win32' ? [] : ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 350, height: 760 } });
      await page.addInitScript(() => {
        const state = {
          session: { id: 's1', title: '空讨论', saveMode: 'relay' },
          sessions: [{ id: 's1', title: '空讨论' }],
          sourceTabId: null, activeTabId: null,
          supportedTabs: [], tabs: [],
          timeline: [], bookmarks: {}, activeOperation: null,
        };
        const event = { addListener() {} };
        globalThis.chrome = {
          runtime: {
            lastError: null,
            sendMessage(request, callback) { callback({ ok: true, state }); },
            onMessage: event,
          },
          windows: { async getCurrent() { return { id: 1 }; } },
          tabs: { onActivated: event, onUpdated: event, onRemoved: event, create() {}, reload() {} },
          storage: {
            local: { get(_key, callback) { callback({}); }, set(_values, callback) { callback?.(); } },
          },
        };
      });
      await page.goto('about:blank');
      const root = path.join(__dirname, '..');
      const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8')
        .replace(/<link[^>]+sidepanel\.css[^>]*>/, '')
        .replace(/<script src="sidepanel\.js"><\/script>/, '');
      await page.setContent(html);
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8') });
      await page.locator('#refresh-connection').click();
      await page.locator('#notice-bar').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#timeline #notice-bar').count(), 0);
      assert.equal(await page.locator('#timeline #operation-bar').count(), 0);
      assert.equal(await page.locator('#status-area #notice-bar').count(), 1);
      assert.match(await page.locator('#notice-text').innerText(), /没有找到可刷新的 AI 网页/);
      await page.waitForTimeout(4200);
      assert.equal(await page.locator('#notice-bar').isVisible(), true);
      await page.locator('#notice-close').click();
      assert.equal(await page.locator('#notice-bar').isVisible(), false);
      if (process.env.ROUNDTABLE_UI_SCREENSHOT) {
        await page.locator('#refresh-connection').click();
        await page.locator('#notice-bar').waitFor({ state: 'visible' });
        await page.screenshot({ path: process.env.ROUNDTABLE_UI_SCREENSHOT, fullPage: true });
      }
    } finally { await browser.close(); }
  });

test('a panel wait timeout consults the completed relay instead of showing retry',
  { skip: chromium ? false : 'Playwright unavailable' }, async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BROWSER_PATH || (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        : '/usr/bin/chromium'),
      args: process.platform === 'win32' ? [] : ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 350, height: 760 } });
      await page.addInitScript(() => {
        const nativeTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback,
          delay === 120000 ? 80 : delay, ...args);
        const state = {
          session: { id: 's1', title: '接力测试', saveMode: 'relay' },
          sessions: [{ id: 's1', title: '接力测试' }],
          sourceTabId: 11, activeTabId: 11,
          tabs: [
            { tabId: 11, provider: 'chatgpt', conversationKey: 'chatgpt:a', connected: true },
            { tabId: 22, provider: 'gemini', conversationKey: 'gemini:b', connected: true },
          ],
          timeline: [], bookmarks: {}, activeOperation: null, lastOperation: null,
        };
        const event = { addListener() {} };
        globalThis.__relayStarts = 0;
        globalThis.__statusChecks = 0;
        globalThis.chrome = {
          runtime: {
            lastError: null,
            sendMessage(request, callback) {
              if (request.type === 'RT_RELAY_START') {
                globalThis.__relayStarts += 1;
                nativeTimeout(() => {
                  state.lastOperation = { id: 'op-1', state: 'COMPLETED',
                    createdAt: Date.now(), sourceTabId: 11, targetTabId: 22 };
                }, 30);
                return; // Worker response arrives after the panel's wait timer.
              }
              if (request.type === 'RT_RELAY_STATUS') globalThis.__statusChecks += 1;
              callback({ ok: true, state, archive: { sessionId: 's1', transfers: [], history: [] } });
            },
            onMessage: event,
          },
          windows: { async getCurrent() { return { id: 1 }; } },
          tabs: { onActivated: event, onUpdated: event, onRemoved: event, create() {} },
          storage: { local: { get(_key, callback) { callback({}); },
            set(_values, callback) { callback?.(); } } },
        };
      });
      await page.goto('about:blank');
      const root = path.join(__dirname, '..');
      const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8')
        .replace(/<link[^>]+sidepanel\.css[^>]*>/, '')
        .replace(/<script src="sidepanel\.js"><\/script>/, '');
      await page.setContent(html);
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8') });
      await page.locator('#instruction').fill('补充');
      await page.locator('#send-button').click();
      await page.waitForTimeout(180);
      assert.equal(await page.locator('#notice-bar').isVisible(), false);
      assert.equal(await page.locator('#instruction').inputValue(), '');
      assert.deepEqual(await page.evaluate(() => [globalThis.__relayStarts, globalThis.__statusChecks]), [1, 1]);
    } finally { await browser.close(); }
  });

test('waiting Gemini relay offers a manual delivery check without sending again',
  { skip: chromium ? false : 'Playwright unavailable' }, async () => {
    const browser = await chromium.launch({ headless: true,
      executablePath: process.env.BROWSER_PATH || (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/chromium'),
      args: process.platform === 'win32' ? [] : ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 350, height: 760 } });
      await page.addInitScript(() => {
        const state = {
          session: { id: 's1', title: '接力测试', saveMode: 'relay' },
          sessions: [{ id: 's1', title: '接力测试' }],
          sourceTabId: 11, activeTabId: 22,
          tabs: [{ tabId: 11, provider: 'chatgpt', conversationKey: 'chatgpt:a', connected: true },
            { tabId: 22, provider: 'gemini', conversationKey: 'gemini:b', connected: true }],
          timeline: [], bookmarks: {}, lastOperation: null,
          activeOperation: { id: 'op-1', state: 'WAITING', target: {
            tabId: 22, conversation: { provider: 'gemini' }, generating: false } },
        };
        const event = { addListener() {} };
        globalThis.__verifyCalls = 0;
        globalThis.__sendCalls = 0;
        globalThis.chrome = { runtime: { lastError: null,
          sendMessage(request, callback) {
            if (request.type === 'RT_RELAY_VERIFY_DELIVERY') {
              globalThis.__verifyCalls += 1;
              state.activeOperation = null;
              state.lastOperation = { id: 'op-1', state: 'COMPLETED' };
            }
            if (request.type === 'RT_RELAY_START') globalThis.__sendCalls += 1;
            callback({ ok: true, state, archive: { sessionId: 's1', transfers: [], history: [] } });
          }, onMessage: event },
          windows: { async getCurrent() { return { id: 1 }; } },
          tabs: { onActivated: event, onUpdated: event, onRemoved: event, create() {} },
          storage: { local: { get(_key, callback) { callback({}); }, set(_values, callback) { callback?.(); } } },
        };
      });
      await page.goto('about:blank');
      const root = path.join(__dirname, '..');
      const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8')
        .replace(/<link[^>]+sidepanel\.css[^>]*>/, '')
        .replace(/<script src="sidepanel\.js"><\/script>/, '');
      await page.setContent(html);
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8') });
      await page.locator('#operation-verify').click();
      assert.deepEqual(await page.evaluate(() => [globalThis.__verifyCalls, globalThis.__sendCalls]), [1, 0]);
      assert.equal(await page.locator('#operation-bar').isVisible(), false);
      assert.match(await page.locator('#notice-text').innerText(), /已核对目标消息/u);
    } finally { await browser.close(); }
  });
