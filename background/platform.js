'use strict';

// Browser API adapters, shared constants, and transient runtime handles.
const core = globalThis.RoundtableCore;
const STATE_KEY = 'roundtableRuntime';
const LEGACY_BOOKMARKS_KEY = 'roundtableBookmarks';
const PANEL_PORT_NAME = 'AI_ROUNDTABLE_PANEL';
const MAX_TIMELINE_ENTRIES = 200;
const MAX_SESSIONS = 30;
const MAX_RELAY_CHARACTERS = 80000;
const MAX_PERSISTED_STATE_CHARACTERS = 7_000_000;
const OPERATION_PREPARE_TIMEOUT_MS = 60 * 1000;
const WATCHDOG_ALARM = 'roundtable-operation-watchdog';
const PREFS_KEY = 'roundtablePreferences';
const SAVE_MODES = ['none', 'relay', 'full'];


const CONTENT_COMMANDS = Object.freeze({
  INSPECT: 'RT_INSPECT',
  LEGACY_INSPECT: 'AI_ROUNDTABLE_INSPECT',
  DISPATCH: 'RT_RELAY_DISPATCH',
  WATCH_DELIVERY: 'RT_RELAY_WATCH_DELIVERY',
  CANCEL: 'RT_RELAY_CANCEL',
});

const CONTENT_SCRIPT_FILES = Object.freeze({
  chatgpt: ['shared/core.js', 'vendor/marked/marked.min.js', 'content/markdown-identity.js', 'content/relay-history.js', 'content/dom-text.js', 'content/common.js', 'content/chatgpt-reader.js', 'content/chatgpt.js',
    'content/bookmark-model.js', 'content/bookmark-picker.js'],
  gemini: ['shared/core.js', 'vendor/marked/marked.min.js', 'content/markdown-identity.js', 'content/relay-history.js', 'content/dom-text.js', 'content/common.js', 'content/gemini.js',
    'content/bookmark-model.js', 'content/bookmark-picker.js'],
  deepseek: ['shared/core.js', 'content/dom-text.js', 'content/common.js', 'content/deepseek.js',
    'content/bookmark-model.js', 'content/bookmark-picker.js'],
});

const CONTENT_EVENT_TYPES = new Map([
  ['RT_RELAY_USER_ACK', 'USER_ACK'],
  ['RT_RELAY_COMPLETED', 'COMPLETED'],
  ['RT_RELAY_FAILED', 'FAILED'],
  ['RT_RELAY_PROGRESS', 'PROGRESS'],
]);

function now() {
  return Date.now();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomId(prefix) {
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function codedError(code, message, recoverable = true, stage = 'background') {
  return new core.AppError(code, message, stage, recoverable);
}

function errorData(error) {
  return {
    code: String(error?.code || 'UNKNOWN_ERROR'),
    stage: String(error?.stage || 'background'),
    message: String(error?.message || error || '发生未知错误。'),
    recoverable: error?.recoverable !== false,
  };
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tabs || []);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab || null);
    });
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab || null);
    });
  });
}

function windowsUpdate(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (window) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(window || null);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function executeScripts(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files }, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(results || []);
    });
  });
}

// The side panel cannot pick a stable destination, so downloads go through the
// browser API: one file per conversation name, overwritten in place instead of
// accumulating "(1)", "(2)" copies.
function downloadFile(payload = {}) {
  const filename = String(payload.filename || '').trim();
  const text = String(payload.text || '');
  const mime = String(payload.mime || 'text/plain;charset=utf-8');
  if (!text) return Promise.reject(codedError('EMPTY_EXPORT', '导出内容为空。'));
  if (!filename) return Promise.reject(codedError('EMPTY_FILENAME', '导出文件名无效。'));
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download({
        url: `data:${mime},${encodeURIComponent(text)}`,
        filename,
        conflictAction: 'overwrite',
        saveAs: false,
      }, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(codedError('DOWNLOAD_FAILED', error.message || '浏览器拒绝了下载。'));
        else resolve({ downloadId, filename });
      });
    } catch (error) {
      reject(codedError('DOWNLOAD_FAILED', error?.message || String(error)));
    }
  });
}

function shouldRepairContentBridge(error) {
  const value = String(error?.code || '') + ' ' + String(error?.message || error || '');
  return /CONTENT_SCRIPT_UNAVAILABLE|unsupported-page|暂不支持|receiving end|could not establish connection|message port|port closed|channel closed/i.test(value);
}

async function injectContentBridge(tabId, provider) {
  const files = CONTENT_SCRIPT_FILES[provider];
  if (!files) throw codedError('UNSUPPORTED_TAB', '当前页面不是支持的 AI 对话。');
  try {
    await executeScripts(tabId, files);
  } catch (error) {
    throw codedError(
      'CONTENT_SCRIPT_INJECTION_FAILED',
      `无法连接当前 AI 页面：${error?.message || error}`
    );
  }
}

// The extension is a relay, not a conversation archive. Only hashes, cursors,
// connection metadata and transmission receipts survive worker restarts.
function receiptOnly(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const value = { ...entry };
  delete value.sentText;
  delete value.answerText;
  delete value.text;
  delete value.prompt;
  delete value.response;
  delete value.answer;
  delete value.result;
  delete value.payload;
  delete value.messages;
  return value;
}

function operationWithoutContent(operation) {
  if (!operation || typeof operation !== 'object') return null;
  const value = clone(operation);
  if (value.payload) delete value.payload.text;
  if (value.source) { delete value.source.capturedMessages; delete value.source.instruction; delete value.source.fullSnapshot; }
  if (value.answer) delete value.answer;
  delete value.messages;
  if (value.target?.sendResult) delete value.target.sendResult.prompt;
  for (const ref of value.source?.messageRefs || []) delete ref.preview;
  if (value.source?.startBookmark) delete value.source.startBookmark.preview;
  if (value.source?.endBookmark) delete value.source.endBookmark.preview;
  if (value.target?.baselineLastMessage) delete value.target.baselineLastMessage.preview;
  if (value.target?.insertedMessage) delete value.target.insertedMessage.preview;
  return value;
}

function bookmarksWithoutPreviews(bookmarks) {
  const output = {};
  for (const [key, bookmark] of Object.entries(bookmarks || {})) {
    output[key] = { ...bookmark };
    delete output[key].preview;
  }
  return output;
}
