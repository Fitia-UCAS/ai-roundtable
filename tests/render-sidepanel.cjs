const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const state = {
      session: { id: 's1', title: '插件产品讨论', updatedAt: Date.now() },
      sessions: [
        { id: 's1', title: '插件产品讨论', updatedAt: Date.now() },
        { id: 's0', title: '小说节奏复盘', updatedAt: Date.now() - 86400000 },
      ],
      sourceTabId: 1,
      activeTabId: 1,
      tabs: [
        { tabId: 1, provider: 'chatgpt', title: '圆桌插件产品设计', conversationKey: 'chatgpt:a', connected: true },
        { tabId: 2, provider: 'gemini', title: '交互方案审查', conversationKey: 'gemini:b', connected: true },
        { tabId: 3, provider: 'deepseek', title: '可靠性分析', conversationKey: 'deepseek:c', connected: true },
      ],
      entries: [
        {
          id: 'e1', status: 'completed', createdAt: Date.now() - 50000,
          source: { provider: 'gemini' }, target: { provider: 'chatgpt', tabId: 1 },
          sentText: 'Gemini 提议把目标消息立即设为书签。',
          answer: { text: '这个方向合理。它能阻止插件刚注入的内容在下一轮被原样传回。' },
        },
      ],
    };
    const event = { addListener() {} };
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage(_message, callback) { callback({ ok: true, state }); },
        onMessage: event,
      },
      windows: { async getCurrent() { return { id: 1 }; } },
      tabs: { onActivated: event, onUpdated: event, onRemoved: event, create() {} },
    };
  });

  await page.goto(pathToFileURL(path.join(__dirname, '..', 'sidepanel.html')).href);
  await page.waitForFunction(() => document.querySelector('#meeting-name')?.textContent.includes('插件产品'));
  await page.waitForFunction(() => document.querySelectorAll('.relay-entry').length === 1);
  const output = path.join(process.env.TEMP, 'ai-roundtable-sidepanel.png');
  await page.screenshot({ path: output, fullPage: true });
  console.log(output);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
