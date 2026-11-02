(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const send = (type, fields = {}) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...fields }, (value) => {
      resolve(chrome.runtime.lastError ? {ok:false,error:chrome.runtime.lastError.message} : (value || {ok:false}));
    });
  });
  const tabs = {messages:'消息管理',export:'导出配置'};
  let preferences = {};
  let sessionId = '';
  let updating = false;
  function feedback(text, error = false) {
    const element = $('feedback');
    element.hidden = !error;
    element.textContent = error ? text : '';
  }
  function showTab(page) {
    if (!tabs[page]) page = 'messages';
    document.querySelectorAll('[data-page]').forEach((el) => { el.hidden = el.dataset.page !== page; });
    document.querySelectorAll('[data-tab]').forEach((el) => { el.classList.toggle('active', el.dataset.tab === page); });
    $('page-title').textContent = tabs[page];
    if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  }
  async function load() {
    const [prefs, archive] = await Promise.all([send('RT_SETTINGS_GET'), send('RT_ARCHIVE_READ')]);
    if (!prefs?.ok || !archive?.ok) { feedback('无法加载扩展配置，请刷新页面。', true); return; }
    preferences = prefs.preferences || {};
    sessionId = archive.session?.id || '';
    $('default-mode').value = preferences.defaultSaveMode || 'relay';
    $('session-mode').value = archive.session?.saveMode || 'relay';
    $('current-session').textContent = archive.session?.title || '当前讨论';
    $('export-format').value = preferences.exportFormat === 'json' ? 'json' : 'markdown';
    $('include-time').checked = preferences.includeTime !== false;
    $('include-links').checked = preferences.includeLinks !== false;
  }
  async function savePreferences() {
    if (updating) return;
    updating = true;
    const data = {defaultSaveMode:$('default-mode').value,exportFormat:$('export-format').value,
      includeTime:$('include-time').checked,includeLinks:$('include-links').checked};
    const response = await send('RT_SETTINGS_SET', data);
    updating = false;
    feedback(response?.ok ? '' : (response.error?.message || '保存失败'), !response?.ok);
  }
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }
  for (const id of ['default-mode','export-format','include-time','include-links']) $(id).addEventListener('change', savePreferences);
  $('session-mode').addEventListener('change', async () => {
    const response = await send('RT_SESSION_MODE_SET', {mode:$('session-mode').value});
    feedback(response?.ok ? '' : (response.error?.message || '更新失败'), !response?.ok);
    if (!response?.ok) await load();
  });
  $('clear-cache').addEventListener('click', () => $('confirm-dialog').showModal());
  $('confirm-dialog').addEventListener('close', async () => {
    if ($('confirm-dialog').returnValue !== 'clear') return;
    const current = await send('RT_ARCHIVE_READ');
    if (current.session?.id !== sessionId) { feedback('当前讨论已变更，请重新打开设置页确认。', true); return; }
    const response = await send('RT_ARCHIVE_CLEAR');
    feedback(response?.ok ? '' : (response.error?.message || '清除失败'), !response?.ok);
  });
  showTab(location.hash.slice(1));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  void load();
})();