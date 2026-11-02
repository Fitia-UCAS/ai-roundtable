"""Optional browser smoke checks. Run: python tests/project-dom-smoke.py"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = '''<!doctype html><html lang="zh"><body>
<main>
<div>正在加载更早的消息…</div>
<div class="group"><h4>你说：</h4><div>你觉得如何？</div></div>
<div class="group"><h4>ChatGPT 说：</h4><div data-markdown-copy-text="第一轮回答">第一轮回答</div></div>
<div class="group"><h4>You said:</h4><div>你觉得如何？</div></div>
<div class="group"><h4>ChatGPT said:</h4><div data-markdown-copy-text="第二轮回答">第二轮回答</div></div>
</main>
<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
<button type="button" data-testid="fruitjuice-send-button">Send</button></form>
</body></html>'''

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                         args=['--no-sandbox'])
    page = browser.new_page()
    page.add_init_script('''
    window.__listeners = [];
    window.chrome = { runtime: { lastError:null,
        onMessage:{addListener(fn){window.__listeners.push(fn)}},
        sendMessage(message,cb){if(cb)cb({ok:true})} } };
    ''')
    page.set_content(HTML)
    for filename in ('shared/core.js', 'vendor/marked/marked.min.js', 'content/markdown-identity.js', 'content/relay-history.js', 'content/dom-text.js', 'content/chatgpt-reader.js'):
        page.add_script_tag(path=str(ROOT / filename))
    result = page.evaluate('RoundtableChatGptReader.read(document)')
    assert [m['role'] for m in result['messages']] == ['user','assistant','user','assistant'], result
    assert result['messages'][0]['text'] == result['messages'][2]['text']
    assert result['messages'][1]['text'] == '第一轮回答'
    assert result['strategy'] == 'chatgpt-project-h4'
    assert result['truncated'] is True
    assert page.evaluate('document.scrollingElement.scrollTop') == 0
    print('PASS: bilingual h4 labels, repeated turns, assistant copy-text, truncated, DOM-only')

    # The h4 is in a nested title bar: the user and assistant bodies are siblings,
    # so selecting the first ancestor with any text would capture the wrong content.
    page.set_content('''<main>
      <section class="turn"><header><div class="title"><h4>你说：</h4></div><span>8:32</span></header>
        <div class="message"><div>真正的用户提问</div></div></section>
      <section class="turn"><header><div class="title"><h4>ChatGPT 说：</h4></div></header>
        <section class="response"><div data-markdown-copy-text="true"><p>第一段回答</p><p>第二段回答</p></div></section>
      </section>
      <section class="turn"><header><h4>你说：</h4></header><div>真正的用户提问</div></section>
    </main>''')
    nested = page.evaluate('RoundtableChatGptReader.read(document)')
    assert [m['role'] for m in nested['messages']] == ['user','assistant','user'], nested
    assert nested['messages'][0]['text'] == '8:32\n真正的用户提问', nested
    assert '第一段回答' in nested['messages'][1]['text'], nested
    assert nested['messages'][1]['text'] != 'true', nested
    assert nested['messages'][0]['id'] != nested['messages'][2]['id'], nested
    print('PASS: nested title bars, attribute markers, preserved duplicate turns')


    # Check the wait strategy when the sent prompt cannot be matched literally.
    page.set_content('''<main>
      <div class="group"><h4>你说：</h4><div>历史问题</div></div>
      <div class="group"><h4>ChatGPT 说：</h4><div data-markdown-copy-text="历史回答"></div></div>
      <div class="group"><h4>你说：</h4><div>网页自动格式化了新问题</div></div>
      <div class="group"><h4>ChatGPT 说：</h4><div data-markdown-copy-text="这是新增的完整回答"></div></div>
      </main>''')
    page.evaluate('''() => {
      window.__listeners = [];
      window.chrome = {runtime:{lastError:null,
        onMessage:{addListener(fn){window.__listeners.push(fn)}},
        sendMessage(message, cb){cb?.({ok:true})}}};
    }''')
    page.add_script_tag(path=str(ROOT / 'content/common.js'))
    page.add_script_tag(path=str(ROOT / 'content/chatgpt-reader.js'))
    adapter = (ROOT / 'content/chatgpt.js').read_text().replace(
      r'''  function matches(currentLocation) {
    return /(^|\.)chatgpt\.com$/i.test(currentLocation.hostname)
      || /(^|\.)chat\.openai\.com$/i.test(currentLocation.hostname);
  }''',
      '''  function matches() { return true; }'''
    )
    assert 'function matches() { return true; }' in adapter
    page.add_script_tag(content=adapter)
    baseline = page.evaluate('''() => ({
      ids: RoundtableChatGptReader.read(document).messages.slice(0,2).map(x => x.id),
      last: RoundtableChatGptReader.read(document).messages[1],
    })''')
    wait = page.evaluate('''payload => new Promise(resolve => {
      window.__listeners[0]({type:'RT_RELAY_RESUME', payload}, {}, resolve);
    })''', {
      'operationId': 'test-wait',
      'prompt': '这个发送原文无法直接匹配',
      'baselineMessageIds': baseline['ids'],
      'baselineLastMessage': baseline['last'],
      'maxWaitMs': 5000,
      'pollMs': 250,
      'stableMilliseconds': 650,
    })
    assert wait['ok'], wait
    assert '新增的完整回答' in wait['result']['message']['text'], wait
    print('PASS: baseline-last assistant fallback completes without exact prompt match')
    browser.close()
