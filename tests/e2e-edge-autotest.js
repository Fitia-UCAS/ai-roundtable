#!/usr/bin/env node
'use strict';

/*
 * AI ROUND TABLE v1.0.31 real-Edge E2E autotest.
 *
 * It launches a SEPARATE Edge instance with a dedicated user-data-dir.
 * It never touches the user's normal Edge profile or open tabs.
 *
 * Usage:
 *   node e2e-edge-autotest.js --yes
 *   node e2e-edge-autotest.js --profile "C:\...\edge-rt-live" --yes
 *
 * First run: the script opens Gemini/DeepSeek in the dedicated profile and
 * waits for you to sign in. Later runs reuse that profile.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const core = require('../shared/core.js');
const net = require('node:net');
const readline = require('node:readline');

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  try { ({ chromium } = require('playwright-core')); }
  catch {
    console.error('Playwright is not available. Set NODE_PATH to a node_modules containing playwright, or install playwright.');
    process.exit(2);
  }
}

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const yes = args.includes('--yes');
const keepOpen = args.includes('--keep-open');
const skipRefresh = args.includes('--skip-refresh');
const skipLong = args.includes('--skip-long');
const deleteSession = args.includes('--delete-session');
const failAfterSetup = args.includes('--fail-after-setup');
const cycles = Math.max(1, Number(argValue('--cycles', '3')) || 3);
let port = Number(argValue('--port', '0')) || 0;
const EDGE = argValue('--edge',
  fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
const EXTENSION = path.resolve(argValue('--extension', path.join(__dirname, '..')));
const PROFILE = path.resolve(argValue('--profile',
  path.join(os.tmpdir(), 'ai-roundtable-e2e-profile')));
const REPORT_JSON = path.resolve(argValue('--report',
  path.join(os.tmpdir(), 'ai-roundtable-e2e-report.json')));
const REPORT_MD = REPORT_JSON.replace(/\.json$/i, '.md');

const steps = [];
let testSessionId = '';
let sidepanelForCleanup = null;
let pagesForCleanup = null;
const testRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const testConversations = [];
let webCleanupAttempted = false;
const historyRequests = [];
const relayApiRequests = [];
let apiMonitorActive = false;
const startedAt = new Date().toISOString();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
}
function log(...values) { console.log(...values); }

async function waitForUrl(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForInput(prompt) {
  if (yes) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function evaluateCall(page, type, payload = {}, timeout = 45000) {
  return page.evaluate(async ({ commandType, commandPayload, commandTimeout }) => {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: { code: 'CLIENT_TIMEOUT', message: 'extension command timeout' } });
      }, commandTimeout);
      chrome.runtime.sendMessage({ type: commandType, ...commandPayload }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: { code: 'RUNTIME_ERROR', message: chrome.runtime.lastError.message } });
        } else {
          resolve(response || { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'empty response' } });
        }
      });
    });
  }, { commandType: type, commandPayload: payload, commandTimeout: timeout });
}

async function bootstrap(sidepanel) {
  return sidepanel.evaluate(async () => {
    const wins = await chrome.windows.getAll({ populate: true });
    const win = wins.find((item) => (item.tabs || []).some((tab) =>
      /gemini\.google\.com|chat\.deepseek\.com/.test(tab.url || '')))
      || wins.find((item) => item.type === 'normal');
    if (!win) return { ok: false, error: { code: 'NO_WINDOW', message: 'no Edge window' } };
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RT_BOOTSTRAP', windowId: win.id, force: true }, resolve);
    });
    return result || { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'empty bootstrap response' } };
  });
}

async function exportState(sidepanel) {
  return evaluateCall(sidepanel, 'RT_EXPORT_STATE', {}, 15000);
}

function getTabs(boot) {
  const state = boot?.state || boot || {};
  return state.supportedTabs || state.tabs || [];
}

async function ensureConnectedTabs(sidepanel, pages, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const boot = await bootstrap(sidepanel);
    last = boot;
    const tabs = getTabs(boot);
    const gem = tabs.find((tab) => tab.provider === 'gemini' && tab.connected);
    const ds = tabs.find((tab) => tab.provider === 'deepseek' && tab.connected);
    if (gem && ds) return { boot, gem, ds, tabs };
    // A reload gives the extension a fresh chance to inject the content bridge.
    if (pages.gemini && !gem) {
      await pages.gemini.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    if (pages.deepseek && !ds) {
      await pages.deepseek.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await sleep(1500);
  }
  throw new Error(`AI tabs not connected: ${JSON.stringify(getTabs(last))}`);
}

function isLoggedInGemini(text) {
  return !/(^|\n)\s*(登录|Sign in)\s*(\n|$)/i.test(text)
    && !/登录即可保存活动记录/i.test(text);
}
function isLoggedInDeepSeek(text) {
  return !/(^|\n)\s*(登录|Sign in)\s*(\n|$)/i.test(text);
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '');
}

async function preparePages(context) {
  let gemini = context.pages().find((page) => page.url().includes('gemini.google.com'));
  let deepseek = context.pages().find((page) => page.url().includes('chat.deepseek.com'));
  if (!gemini) gemini = await context.newPage();
  if (!deepseek) deepseek = await context.newPage();
  await gemini.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await deepseek.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(5000);
  return { gemini, deepseek };
}

async function ensureLogin(pages) {
  const gemText = await pageText(pages.gemini);
  const dsText = await pageText(pages.deepseek);
  if (!isLoggedInGemini(gemText) || !isLoggedInDeepSeek(dsText)) {
    log('\n请在新打开的 Edge 窗口中登录 Gemini 和 DeepSeek。');
    log('登录完成后回到这里按 Enter 继续。');
    await waitForInput('按 Enter 继续...');
    await pages.gemini.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await pages.deepseek.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(5000);
    const gem2 = await pageText(pages.gemini);
    const ds2 = await pageText(pages.deepseek);
    if (!isLoggedInGemini(gem2) || !isLoggedInDeepSeek(ds2)) {
      throw new Error('Gemini 或 DeepSeek 仍未登录；请在该 Edge profile 中登录后重试。');
    }
  }
}

async function ensureNewGeminiChat(gemini) {
  await gemini.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  await dismissGeminiOverlays(gemini);
  const users = await gemini.evaluate(() =>
    document.querySelectorAll('user-query,[data-testid="user-query"]').length);
  if (users > 0) {
    const candidates = [
      gemini.getByRole('button', { name: /New chat|发起新对话|新对话/i }).first(),
      gemini.locator('button[aria-label*="New chat" i], button[aria-label*="发起新对话"]').first(),
    ];
    for (const candidate of candidates) {
      try {
        if (await candidate.count()) {
          await candidate.click({ timeout: 3000 });
          await sleep(1500);
          break;
        }
      } catch {}
    }
  }
}

async function ensureNewDeepSeekChat(deepseek) {
  await deepseek.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);
}

async function dismissGeminiOverlays(gemini) {
  await gemini.keyboard.press('Escape').catch(() => {});
  const labels = [/Let's go/i, /Got it/i, /Continue/i, /Close/i, /Dismiss/i, /开始使用/i, /知道了/i, /继续/i];
  for (const label of labels) {
    const button = gemini.getByRole('button', { name: label }).first();
    try {
      if (await button.count() && await button.isVisible()) {
        await button.click({ force: true, timeout: 2000 });
        await sleep(400);
      }
    } catch {}
  }
  await gemini.keyboard.press('Escape').catch(() => {});
  await sleep(300);
}

async function sendGeminiPrompt(gemini, text) {
  await dismissGeminiOverlays(gemini);
  const box = gemini.locator('div[role="textbox"][contenteditable="true"]').first();
  await box.waitFor({ state: 'visible', timeout: 15000 });
  try { await box.click({ timeout: 5000 }); }
  catch { await box.click({ force: true, timeout: 5000 }); }
  await gemini.keyboard.type(text);
  await sleep(250);
  await gemini.keyboard.press('Enter');
  await sleep(500);
}

async function counts(page, provider) {
  return page.evaluate(({ provider }) => {
    if (provider === 'deepseek') {
      return {
        users: document.querySelectorAll('.ds-collapsible-text').length,
        answers: document.querySelectorAll('.ds-assistant-message-main-content').length,
        stop: [...document.querySelectorAll('[role="button"][aria-label*="停止"],[role="button"][aria-label*="Stop" i],button[aria-label*="停止"],button[aria-label*="Stop" i]')]
          .some((el) => el.getClientRects().length > 0),
      };
    }
    return {
      users: document.querySelectorAll('user-query,[data-testid="user-query"]').length,
      answers: document.querySelectorAll('model-response,[data-testid="model-response"]').length,
      stop: [...document.querySelectorAll('button')].some((el) =>
        /stop/i.test(el.getAttribute('aria-label') || '') && el.getClientRects().length > 0),
    };
  }, { provider });
}

async function waitForAnswer(page, provider, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastLength = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const value = await counts(page, provider);
    const length = await page.evaluate(() => (document.body?.innerText || '').length);
    if (value.users > 0 && value.answers >= value.users && !value.stop) {
      if (length === lastLength) {
        if (Date.now() - stableSince >= 1800) return value;
      } else {
        lastLength = length;
        stableSince = Date.now();
      }
    } else {
      lastLength = -1;
      stableSince = 0;
    }
    await sleep(400);
  }
  throw new Error(`${provider} answer did not become stable in ${timeoutMs} ms`);
}

async function targetUserSnapshot(page, provider) {
  return page.evaluate(({ provider }) => {
    if (provider === 'deepseek') {
      const bodies = [...document.querySelectorAll('.ds-collapsible-text')];
      const entries = bodies.map((body) => {
        const row = body.closest('[data-virtual-list-item-key]');
        const key = row?.getAttribute('data-virtual-list-item-key') || '';
        const text = (body.innerText || body.textContent || '').trim();
        return { key, id: key ? `deepseek-item:${key}:q` : '', text };
      });
      const last = bodies[bodies.length - 1];
      const message = last?.closest('.ds-message') || null;
      const text = (last?.innerText || last?.textContent || '').trim();
      return {
        count: bodies.length,
        ids: entries.map((entry) => entry.id).filter(Boolean),
        entries,
        text,
        textLength: text.length,
        bodyClass: String(last?.className || ''),
        messageClass: String(message?.className || ''),
        ariaFalseInsideBody: last ? last.querySelectorAll('[aria-expanded="false"]').length : 0,
        ariaFalseInMessage: message ? message.querySelectorAll('[aria-expanded="false"]').length : 0,
        nestedQuoteInsideBody: last ? last.querySelectorAll(
          '[class*="quote" i], [class*="reference" i], blockquote, [data-quote]').length : 0,
        buttonsInsideBody: last ? last.querySelectorAll('button, [role="button"]').length : 0,
        htmlPreview: String(last?.outerHTML || '').slice(0, 1600),
      };
    }
    const nodes = [...document.querySelectorAll('user-query,[data-testid="user-query"]')];
    const textVariants = (node) => {
      const bases = [
        node.innerText || node.textContent || '',
        node.querySelector('.query-content')?.innerText || '',
        node.querySelector('.query-text')?.innerText || '',
      ].map((value) => String(value || '').trim()).filter(Boolean);
      const values = [...bases];
      // Gemini sometimes renders a "You said ..." summary before the actual
      // query. A suffix at a paragraph boundary is still the submitted body.
      for (const base of bases) {
        const parts = base.split(/\n{2,}/);
        for (let index = 1; index < Math.min(parts.length, 10); index += 1) {
          values.push(parts.slice(index).join('\n\n').trim());
        }
      }
      return [...new Set(values.filter(Boolean))];
    };
    const entries = nodes.map((node, index) => {
      const nativeId = String(node.getAttribute('data-message-id') || '').trim();
      return {
        key: String(index),
        ordinal: index,
        nativeId,
        // Test-only row identity. It is NOT the production bookmark id.
        id: nativeId || `e2e-row-${index}`,
        text: (node.innerText || node.textContent || '').trim(),
        textCandidates: textVariants(node),
      };
    });
    const last = nodes[nodes.length - 1];
    const text = (last?.innerText || last?.textContent || '').trim();
    return {
      count: nodes.length,
      ids: entries.map((entry) => entry.id),
      entries,
      text,
      textLength: text.length,
      htmlPreview: String(last?.outerHTML || '').slice(0, 1600),
    };
  }, { provider });
}

function webConversationId(page, provider) {
  const url = page?.url?.() || '';
  if (provider === 'deepseek') {
    const match = /\/a\/chat\/s\/([^/?#]+)/i.exec(url);
    return match ? match[1] : '';
  }
  const match = /\/app\/([^/?#]+)/i.exec(url);
  return match ? match[1] : '';
}

async function deleteDeepSeekTestConversation(page, id) {
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  const link = page.locator(`a[href="/a/chat/s/${id}"]`).first();
  if (!(await link.count())) return { deleted: false, reason: 'not-found-in-history' };
  const title = (await link.innerText()).trim();
  await link.hover();
  await link.locator('[role="button"]').first().click();
  await sleep(250);
  await page.locator('.ds-dropdown-menu-option--error').filter({ hasText: '删除' }).first().click();
  await sleep(250);
  await page.getByRole('button', { name: '删除该对话', exact: true }).click();
  await sleep(1000);
  return { deleted: true, title };
}

async function deleteGeminiTestConversation(page, id) {
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  if (!(await page.locator('a[href^="/app/"]').count())) {
    const open = page.getByRole('button', { name: /Open sidebar|打开侧边栏/i }).first();
    if (await open.count()) { await open.click().catch(() => {}); await sleep(1500); }
  }
  const link = page.locator(`a[href="/app/${id}"]`).first();
  if (!(await link.count())) return { deleted: false, reason: 'not-found-in-history' };
  const title = (await link.innerText()).trim();
  await link.hover();
  await sleep(400);
  const more = page.locator('button[aria-label*="More options"]').first();
  if (!(await more.count())) return { deleted: false, reason: 'menu-not-found' };
  await more.click({ force: true });
  await sleep(500);
  const del = page.getByRole('menuitem', { name: /Delete|删除/i }).last();
  if (await del.count()) await del.click();
  else await page.getByText(/^Delete$|^删除$/).last().click();
  await sleep(500);
  const confirm = page.getByRole('button', { name: /^Delete$|^删除$|Delete chat/i }).last();
  if (!(await confirm.count())) return { deleted: false, reason: 'confirm-not-found' };
  await confirm.click();
  await sleep(1200);
  return { deleted: true, title };
}

function registerTestConversations(pages, providerKeys = {}) {
  if (!pages?.creationProof) return;
  for (const provider of ['deepseek', 'gemini']) {
    const proof = pages.creationProof[provider];
    if (!proof?.wasRoot || proof.afterId) continue;
    const key = String(providerKeys[provider] || '');
    const match = new RegExp(`^${provider}:([^:]+)$`).exec(key);
    const id = match ? match[1] : '';
    if (!id) continue;
    if (testConversations.some((entry) => entry.provider === provider && entry.id === id)) continue;
    testConversations.push({
      runId: testRunId,
      provider,
      id,
      source: proof.source || 'new-chat',
      registeredFromKey: key,
      creationProof: {
        beforeUrl: proof.beforeUrl,
        beforeId: proof.beforeId,
        afterUrl: proof.afterUrl,
        afterId: proof.afterId,
      },
      registeredAt: new Date().toISOString(),
    });
  }
}

async function cleanupWebTestConversations(pages) {
  const eligible = testConversations.filter((entry) => entry.runId === testRunId);
  if (!eligible.length) return { skipped: true, reason: 'no-registered-test-conversations' };
  const result = { runId: testRunId, conversations: [] };
  for (const entry of eligible) {
    const page = entry.provider === 'gemini' ? pages?.gemini : pages?.deepseek;
    if (!page) {
      result.conversations.push({ ...entry, deleted: false, reason: 'page-unavailable' });
      continue;
    }
    try {
      const deletion = entry.provider === 'gemini'
        ? await deleteGeminiTestConversation(page, entry.id)
        : await deleteDeepSeekTestConversation(page, entry.id);
      result.conversations.push({ ...entry, ...deletion });
    } catch (error) {
      result.conversations.push({ ...entry, deleted: false,
        reason: `cleanup-error: ${String(error?.message || error)}` });
    }
  }
  result.deleted = result.conversations.filter((entry) => entry.deleted).length;
  result.remaining = result.conversations.filter((entry) => !entry.deleted);
  return result;
}


async function scrollDeepSeekToBottom(page) {
  await page.bringToFront().catch(() => {});
  await page.mouse.wheel(0, 12000).catch(() => {});
  await page.keyboard.press('End').catch(() => {});
  await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll('*')]
      .filter((el) => el.scrollHeight > el.clientHeight + 20);
    for (const el of scrollers) el.scrollTop = el.scrollHeight;
    const rows = [...document.querySelectorAll('[data-virtual-list-item-key]')];
    rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
  await sleep(1000);
  await page.mouse.wheel(0, 12000).catch(() => {});
  await sleep(500);
}

async function relay(sidepanel, pages, sourceProvider, targetProvider, instruction = '') {
  const connected = await ensureConnectedTabs(sidepanel, pages);
  const source = sourceProvider === 'gemini' ? connected.gem : connected.ds;
  const target = targetProvider === 'gemini' ? connected.gem : connected.ds;
  if (!source?.conversationKey || !target?.conversationKey) {
    throw new Error(`missing conversation key: source=${source?.conversationKey} target=${target?.conversationKey}`);
  }
  const targetUsersBefore = await targetUserSnapshot(
    targetProvider === 'gemini' ? pages.gemini : pages.deepseek, targetProvider);
  apiMonitorActive = true;
  historyRequests.length = 0;
  const response = await evaluateCall(sidepanel, 'RT_RELAY_START', {
    sourceTabId: source.tabId,
    targetTabId: target.tabId,
    expectedSourceConversationKey: source.conversationKey,
    expectedTargetConversationKey: target.conversationKey,
    instruction,
  }, 45000);
  apiMonitorActive = false;
  relayApiRequests.push(...historyRequests);
  let state = response?.state;
  let operation = state?.lastOperation || state?.activeOperation;
  const terminal = /COMPLETED|FAILED|NO_CONTENT|CANCELLED|UNCERTAIN|SUSPENDED/;
  const deadline = Date.now() + 45000;
  while (operation && !terminal.test(String(operation.state || '')) && Date.now() < deadline) {
    await sleep(500);
    const check = await evaluateCall(sidepanel, 'RT_OPERATION_CHECK', {}, 10000);
    if (check?.state) state = check.state;
    operation = state?.lastOperation || state?.activeOperation;
  }
  await sleep(350);
  let targetUsersAfter = await targetUserSnapshot(
    targetProvider === 'gemini' ? pages.gemini : pages.deepseek, targetProvider);
  const exported = await exportState(sidepanel);
  const bookmarks = exported?.state?.bookmarks || {};
  const targetKey = operation?.target?.conversation?.conversationKey
    || target.conversationKey;
  const bookmark = bookmarks[targetKey] || null;
  let addedEntries = (targetUsersAfter.entries || []).filter((entry) => (
    !(targetUsersBefore.ids || []).includes(entry.id)
  ));
  if (targetProvider === 'deepseek' && addedEntries.length === 0) {
    // The last virtual-list row can be outside the mounted window. Scroll the
    // target (test page only) to the bottom and re-read; this does not change
    // the message data or the production relay behavior.
    await scrollDeepSeekToBottom(pages.deepseek);
    if (bookmark?.messageId) {
      await pages.deepseek.evaluate(({ messageId }) => {
        const match = /^deepseek-item:(.+):q$/.exec(String(messageId || ''));
        if (!match) return;
        const row = document.querySelector(`[data-virtual-list-item-key="${CSS.escape(match[1])}"]`);
        row?.scrollIntoView({ block: 'end' });
      }, { messageId: bookmark.messageId }).catch(() => {});
      await sleep(350);
    }
    targetUsersAfter = await targetUserSnapshot(pages.deepseek, targetProvider);
    addedEntries = (targetUsersAfter.entries || []).filter((entry) => (
      !(targetUsersBefore.ids || []).includes(entry.id)
    ));
    if (addedEntries.length === 0) {
      // A virtualized DeepSeek list can keep the new row unmounted even after
      // scrolling. Reloading the test target is read-only and does not submit
      // anything; it makes the persisted conversation observable.
      await pages.deepseek.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(5000);
      targetUsersAfter = await targetUserSnapshot(pages.deepseek, targetProvider);
      addedEntries = (targetUsersAfter.entries || []).filter((entry) => (
        !(targetUsersBefore.ids || []).includes(entry.id)
      ));
    }
  }
  if (targetProvider === 'gemini') {
    if (targetUsersAfter.count !== targetUsersBefore.count + 1) {
      throw new Error(`target added ${targetUsersAfter.count - targetUsersBefore.count} user messages, expected exactly 1: `
        + JSON.stringify({ before: targetUsersBefore.count, after: targetUsersAfter.count }));
    }
  } else if (addedEntries.length !== 1) {
    throw new Error(`target added ${addedEntries.length} user-row ids, expected exactly 1`);
  }
  const addedEntry = addedEntries[0] || targetUsersAfter.entries?.[targetUsersAfter.entries.length - 1];
  if (!String(addedEntry?.text || '').trim()) {
    throw new Error('target user message has no observable text');
  }
  if (targetProvider === 'deepseek' && bookmark?.messageId && addedEntry?.id
    && bookmark.messageId !== addedEntry.id) {
    throw new Error(`target bookmark ${bookmark.messageId} does not match newly added row ${addedEntry.id}`);
  }
  const actualText = String(addedEntry?.text || '');
  const expectedFullHashes = [...new Set([
    String(bookmark?.sentMessageHash || ''),
    String(bookmark?.messageHash || ''),
  ].filter(Boolean))];
  const expectedSemanticHashes = [...new Set([
    String(bookmark?.sentSemanticHash || ''),
    String(bookmark?.messageSemanticHash || ''),
  ].filter(Boolean))];
  const expectedCompactHash = String(bookmark?.sentCompactHash || '');
  const expectedFullHash = expectedFullHashes[0] || '';
  const expectedSemanticHash = expectedSemanticHashes[0] || '';
  const textCandidates = [...new Set([actualText, ...(addedEntry?.textCandidates || [])]
    .map((value) => String(value || '').trim()).filter(Boolean))];
  let matchedText = '';
  let verificationMethod = '';
  for (const candidate of textCandidates) {
    if (expectedFullHashes.includes(core.messageHash({ role: 'user', text: candidate }))) {
      matchedText = candidate;
      verificationMethod = 'full-hash';
      break;
    }
    if (expectedSemanticHashes.includes(core.semanticHash(candidate))) {
      matchedText = candidate;
      verificationMethod = 'semantic-hash';
      break;
    }
    if (expectedCompactHash && core.hashText(
      core.normalizeText(candidate).replace(/\s+/gu, '')
    ) === expectedCompactHash) {
      matchedText = candidate;
      verificationMethod = 'compact-normalized';
      break;
    }
  }
  const actualFullHash = core.messageHash({ role: 'user', text: actualText });
  const actualSemanticHash = core.semanticHash(actualText);
  const actualCompactHash = core.hashText(
    core.normalizeText(actualText).replace(/\s+/gu, '')
  );
  const fullTextMatch = expectedFullHashes.includes(actualFullHash);
  const semanticTextMatch = expectedSemanticHashes.includes(actualSemanticHash);
  const compactTextMatch = Boolean(expectedCompactHash && actualCompactHash === expectedCompactHash);
  const fullTextVerified = verificationMethod === 'full-hash' || verificationMethod === 'semantic-hash';
  const targetTextVerified = Boolean(matchedText);
  if (!targetTextVerified) {
    throw new Error(`target ${targetProvider} user text does not match the saved sent fingerprint`);
  }
  const result = {
    sourceProvider,
    targetProvider,
    sourceKey: source.conversationKey,
    targetKey,
    ok: response?.ok !== false && operation?.state === 'COMPLETED',
    operationId: operation?.id || response?.operationId || '',
    operationState: operation?.state || response?.operationState || '',
    error: response?.error || operation?.error || null,
    timings: operation?.timings || null,
    bookmark,
    targetUsersBefore: targetUsersBefore.count,
    targetUsersAfter: targetUsersAfter.count,
    targetUserTextLength: String(addedEntry?.text || '').length,
    targetUserTextPreview: String(addedEntry?.text || '').slice(0, 240),
    targetTextVerification: {
      provider: targetProvider,
      fullTextMatch,
      semanticTextMatch,
      compactTextMatch,
      fullTextVerified,
      previewOnly: targetTextVerified && !fullTextVerified,
      verified: targetTextVerified,
      verificationMethod,
      matchedTextLength: matchedText.length,
      expectedFullHash,
      expectedSemanticHash,
      expectedFullHashes,
      expectedSemanticHashes,
      expectedCompactHash,
      bookmarkMessageId: bookmark?.messageId || '',
      actualFullHash,
      actualSemanticHash,
      actualCompactHash,
    },
    targetUserNativeIdsBefore: targetUsersBefore.entries?.map((e) => e.nativeId || '') || [],
    targetUserNativeIdsAfter: targetUsersAfter.entries?.map((e) => e.nativeId || '') || [],
    targetUserRowIdsBefore: targetUsersBefore.ids || [],
    targetUserRowIdsAfter: targetUsersAfter.ids || [],
    targetUserRowIdsAdded: addedEntries.map((entry) => entry.id),
    targetUserOrdinalsAdded: addedEntries.map((entry) => entry.ordinal),
    targetBookmarkId: bookmark?.messageId || '',
    targetUserDom: targetProvider === 'deepseek' ? {
      bodyClass: targetUsersAfter.bodyClass,
      messageClass: targetUsersAfter.messageClass,
      ariaFalseInsideBody: targetUsersAfter.ariaFalseInsideBody,
      ariaFalseInMessage: targetUsersAfter.ariaFalseInMessage,
      nestedQuoteInsideBody: targetUsersAfter.nestedQuoteInsideBody,
      buttonsInsideBody: targetUsersAfter.buttonsInsideBody,
      htmlPreview: targetUsersAfter.htmlPreview,
    } : { htmlPreview: targetUsersAfter.htmlPreview },
  };
  if (!result.ok) throw new Error(`relay ${sourceProvider}->${targetProvider} failed: ${JSON.stringify(result.error || result.operationState)}`);
  if (targetProvider === 'deepseek') {
    if (!String(bookmark?.messageId || '').startsWith('deepseek-item:')) {
      throw new Error(`DeepSeek target bookmark is not a virtual-list identity: ${JSON.stringify(bookmark)}`);
    }
    if (!Number.isInteger(bookmark.turnOrdinal)) {
      throw new Error(`DeepSeek target bookmark has no turnOrdinal: ${JSON.stringify(bookmark)}`);
    }
  }
  registerTestConversations(pages, {
    gemini: sourceProvider === 'gemini' ? source.conversationKey : target.conversationKey,
    deepseek: sourceProvider === 'deepseek' ? source.conversationKey : target.conversationKey,
  });
  return result;
}

async function step(name, fn) {
  const started = Date.now();
  log(`\n[TEST] ${name}`);
  try {
    const value = await fn();
    const record = { name, ok: true, durationMs: Date.now() - started, value };
    steps.push(record);
    log(`[PASS] ${name} (${record.durationMs} ms)`);
    return value;
  } catch (error) {
    const record = { name, ok: false, durationMs: Date.now() - started,
      error: { message: String(error?.message || error), code: error?.code || '' } };
    steps.push(record);
    log(`[FAIL] ${name}: ${record.error.message}`);
    throw error;
  }
}

function writeReport(ok, error = null) {
  const report = { startedAt, finishedAt: new Date().toISOString(), ok, error,
    profile: PROFILE, extension: EXTENSION, cycles, testSessionId, testRunId,
    testConversations, steps };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  const lines = [
    '# AI ROUND TABLE v1.0.31 · Real Edge E2E report',
    '',
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Result: ${ok ? 'PASS' : 'FAIL'}`,
    `- Profile: ${PROFILE}`,
    `- Extension: ${EXTENSION}`,
    '',
    '| Step | Result | Duration | State/Error |',
    '|---|---:|---:|---|',
    ...steps.map((item) => `| ${item.name} | ${item.ok ? 'PASS' : 'FAIL'} | ${item.durationMs} ms | ${item.error?.message || item.value?.operationState || ''} |`),
    '',
  ];
  if (error) lines.push(`Error: ${error}`);
  fs.writeFileSync(REPORT_MD, lines.join('\n'));
  log(`\nReport: ${REPORT_JSON}`);
  log(`Report: ${REPORT_MD}`);
}

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error(`Edge not found: ${EDGE}`);
  if (!fs.existsSync(path.join(EXTENSION, 'manifest.json'))) throw new Error(`Extension not found: ${EXTENSION}`);

  log('AI ROUND TABLE v1.0.31 real-Edge E2E');
  log(`Edge: ${EDGE}`);
  log(`Extension: ${EXTENSION}`);
  log(`Profile: ${PROFILE}`);
  log(`Port: ${port}`);
  log('\nThis test sends real messages to Gemini and DeepSeek in the dedicated profile.');
  log('It never uses your normal Edge profile or your open tabs.');
  await waitForInput('输入 YES 后按 Enter 开始（或加 --yes）: ');

  if (!port) port = await getFreePort();
  log(`CDP port: ${port}`);
  let child = null;
  let browser = null;
  try {
    child = spawn(EDGE, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false });
    await waitForUrl(`http://127.0.0.1:${port}/json/version`, 25000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];

    // Find the unpacked extension service worker. The id is not hard-coded.
    let extensionId = '';
    const deadline = Date.now() + 15000;
    while (!extensionId && Date.now() < deadline) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const worker = list.find((item) => item.type === 'service_worker'
        && /^chrome-extension:\/\/[a-z]+\/background\.js$/i.test(item.url || ''));
      if (worker) extensionId = new URL(worker.url).host;
      if (!extensionId) await sleep(500);
    }
    if (!extensionId) throw new Error('AI ROUND TABLE service worker not found; check --load-extension');
    log(`Extension id: ${extensionId}`);

    const sidepanel = await context.newPage();
    sidepanelForCleanup = sidepanel;
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    log(`Extension version: ${await sidepanel.evaluate(() => chrome.runtime.getManifest().version).catch(() => 'unknown')}`);
    await sleep(1000);

    const sessionResponse = await evaluateCall(sidepanel, 'RT_SESSION_NEW', {
      title: `E2E 自动测试 ${new Date().toLocaleString('zh-CN')}`,
    }, 15000);
    testSessionId = sessionResponse?.session?.id || sessionResponse?.state?.session?.id || '';
    log(`Test session: ${testSessionId || '(default)'}`);

    const pages = await preparePages(context);
    pagesForCleanup = pages;
    const creationBefore = {
      gemini: { url: pages.gemini.url(), id: webConversationId(pages.gemini, 'gemini') },
      deepseek: { url: pages.deepseek.url(), id: webConversationId(pages.deepseek, 'deepseek') },
    };
    await step('login check', async () => { await ensureLogin(pages); return true; });
    await step('new Gemini chat', async () => { await ensureNewGeminiChat(pages.gemini); return true; });
    await step('new DeepSeek chat', async () => { await ensureNewDeepSeekChat(pages.deepseek); return true; });
    pages.creationProof = {
      gemini: {
        runId: testRunId,
        provider: 'gemini',
        source: 'new-chat',
        beforeUrl: creationBefore.gemini.url,
        beforeId: creationBefore.gemini.id,
        afterUrl: pages.gemini.url(),
        afterId: webConversationId(pages.gemini, 'gemini'),
        wasRoot: !webConversationId(pages.gemini, 'gemini'),
      },
      deepseek: {
        runId: testRunId,
        provider: 'deepseek',
        source: 'new-chat',
        beforeUrl: creationBefore.deepseek.url,
        beforeId: creationBefore.deepseek.id,
        afterUrl: pages.deepseek.url(),
        afterId: webConversationId(pages.deepseek, 'deepseek'),
        wasRoot: !webConversationId(pages.deepseek, 'deepseek'),
      },
    };
    if (failAfterSetup) {
      throw new Error('deliberate E2E failure after new-chat setup; cleanup must skip without registered IDs');
    }

    pages.deepseek.on('request', (request) => {
      if (apiMonitorActive && request.url().includes('/api/v0/chat/history_messages')) {
        historyRequests.push(request.url().slice(0, 160));
      }
    });
    historyRequests.length = 0;
    const seed = '只回复：E2E 接力测试，收到请回答 OK。';
    await step('seed Gemini answer', async () => {
      await sendGeminiPrompt(pages.gemini, seed);
      await waitForAnswer(pages.gemini, 'gemini');
      return true;
    });

    await step('connected tabs', async () => {
      const connected = await ensureConnectedTabs(sidepanel, pages);
      return { gemini: connected.gem.conversationKey, deepseek: connected.ds.conversationKey };
    });

    for (let index = 1; index <= cycles; index += 1) {
      await step(`cycle ${index} Gemini -> DeepSeek`, async () => {
        const result = await relay(sidepanel, pages, 'gemini', 'deepseek');
        await waitForAnswer(pages.deepseek, 'deepseek');
        return result;
      });
      await step(`cycle ${index} DeepSeek -> Gemini`, async () => {
        const result = await relay(sidepanel, pages, 'deepseek', 'gemini');
        await waitForAnswer(pages.gemini, 'gemini');
        return result;
      });
    }

    if (!skipRefresh) {
      await step('refresh test: create a DeepSeek user bookmark', async () => {
        const result = await relay(sidepanel, pages, 'gemini', 'deepseek');
        await waitForAnswer(pages.deepseek, 'deepseek');
        return result;
      });
      await step('refresh DeepSeek page', async () => {
        await pages.deepseek.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(6000);
        return true;
      });
      await step('refresh test: DeepSeek -> Gemini after re-render', async () => {
        const result = await relay(sidepanel, pages, 'deepseek', 'gemini');
        await waitForAnswer(pages.gemini, 'gemini');
        return result;
      });
    }

    if (!skipLong) {
      const longInstruction = '这是一段用于验证长消息折叠与书签恢复的补充要求。请保持原意，并在回答中确认收到。'.repeat(18);
      await step('long message Gemini -> DeepSeek', async () => {
        const result = await relay(sidepanel, pages, 'gemini', 'deepseek', longInstruction);
        await waitForAnswer(pages.deepseek, 'deepseek');
        return { ...result, instructionLength: longInstruction.length };
      });
      await step('long message DeepSeek -> Gemini', async () => {
        const result = await relay(sidepanel, pages, 'deepseek', 'gemini');
        await waitForAnswer(pages.gemini, 'gemini');
        return result;
      });
    }

    if (deleteSession && testSessionId) {
      await step('delete isolated test session', async () => {
        const result = await evaluateCall(sidepanel, 'RT_SESSION_DELETE', { sessionId: testSessionId }, 15000);
        if (result?.ok === false) throw new Error(JSON.stringify(result.error));
        return { deletedSessionId: testSessionId };
      });
    }

    await step('no DeepSeek history API during relay', async () => {
      if (relayApiRequests.length) {
        throw new Error(`DeepSeek history API was requested during relay: ${JSON.stringify(relayApiRequests)}`);
      }
      return { count: 0 };
    });

    webCleanupAttempted = true;
    await step('cleanup web test conversations', async () => cleanupWebTestConversations(pages));

    writeReport(true);
  } catch (error) {
    if (deleteSession && testSessionId && sidepanelForCleanup) {
      try {
        const deleted = await evaluateCall(sidepanelForCleanup, 'RT_SESSION_DELETE',
          { sessionId: testSessionId }, 15000);
        steps.push({ name: 'delete isolated test session (failure path)',
          ok: deleted?.ok !== false, value: { deletedSessionId: testSessionId } });
      } catch (cleanupError) {
        steps.push({ name: 'delete isolated test session (failure path)', ok: false,
          error: { message: String(cleanupError?.message || cleanupError) } });
      }
    }
    if (pagesForCleanup && !webCleanupAttempted) {
      webCleanupAttempted = true;
      try {
        await step('cleanup web test conversations (failure path)', async () => (
          cleanupWebTestConversations(pagesForCleanup)
        ));
      } catch (cleanupError) {
        log(`cleanup failure: ${cleanupError?.message || cleanupError}`);
      }
    }
    writeReport(false, String(error?.stack || error));
    process.exitCode = 1;
  } finally {
    if (!keepOpen) {
      try { if (browser) await browser.close(); } catch {}
      await sleep(1200);
      if (child && child.exitCode === null) killTree(child);
    }
  }
}

main().catch((error) => {
  writeReport(false, String(error?.stack || error));
  process.exit(1);
});
