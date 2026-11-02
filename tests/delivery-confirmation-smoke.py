"""Isolated real-Chromium tests for delayed user bubble acknowledgement.
No external provider account/network is used."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
BASE_STYLE='<style>textarea,.ql-editor { display:block; min-height:48px;width:500px; }button{width:110px;height:40px}</style>'
INIT='''globalThis.__listeners=[];globalThis.chrome={runtime:{lastError:null,onMessage:{addListener(fn){globalThis.__listeners.push(fn)}},sendMessage(x,cb){cb?.({ok:true})}}};'''
def boot(page,provider,html,fast_no_ack=False):
    page.goto('about:blank');page.evaluate(INIT);page.set_content('<html><head>'+BASE_STYLE+'</head><body>'+html+'</body></html>')
    for dependency in ('shared/core.js', 'vendor/marked/marked.min.js', 'content/markdown-identity.js', 'content/relay-history.js', 'content/dom-text.js', 'content/common.js', 'content/chatgpt-reader.js'):
        page.add_script_tag(path=str(ROOT/dependency))
    src=(ROOT/'content'/f'{provider}.js').read_text()
    src=src.replace('  function matches(currentLocation) {','  function matches(currentLocation) {')
    import re
    src,count=re.subn(r'  function matches\(currentLocation\) \{[\s\S]*?\n  \}', '  function matches() { return true; }',src,count=1)
    assert count==1
    if fast_no_ack and provider=='deepseek':
        src=src.replace('prompt, baselineIds, baselineCount, composer, signal, 12 * 1000,',
                        'prompt, baselineIds, baselineCount, composer, signal, 1600,')
    page.add_script_tag(content=src)
def send(page,txt,provider):
    return page.evaluate('''({txt,provider}) => new Promise(resolve=>{
      globalThis.__listeners[0]({type:'RT_SEND', payload:{operationId:provider+'-delayed-confirm',text:txt}}, {}, resolve);
    })''',{'txt':txt,'provider':provider})

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    pg=browser.new_page()
    prompt=('接续 DeepSeek 的讨论：\n\n用户：\n这是一个新的圆桌讨论，和上一条对话完全不同。\n\n'
            'DeepSeek：\n我建议增加两位角色在晚宴上的误会，并分别说明角色动机和伏笔。\n\n')*2
    # Artificial delayed Gemini message: editor clears first, bubble appears after 2.5 s,
    # and only an abbreviated preview is mounted. The preview must still be novel.
    boot(pg,'gemini', '''
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" type="button" aria-label="Send message" disabled>Send</button>
    <main id="turns"></main>
    <script>
      globalThis.clicks=0;
      let composer=document.querySelector('.ql-editor'), button=document.querySelector('#send');
      composer.addEventListener('input',()=>{button.disabled=!composer.textContent.trim()});
      button.addEventListener('click',()=>{
        clicks++;
        const body=composer.textContent.trim();
        composer.replaceChildren();
        setTimeout(()=>{
          const user=document.createElement('user-query');
          user.setAttribute('data-message-id','gemini-delayed-new-id');
          user.textContent=body.slice(0,110)+'…';
          document.querySelector('#turns').append(user);
        },2600)
      });
    </script>''')
    r=send(pg,prompt,'gemini')
    assert r['ok'] is True and r['result']['confirmed'] is True, r
    assert r['result']['userMessageId']=='gemini-delayed-new-id',r
    assert r['result']['matchType']=='collapsed-preview',r
    assert pg.evaluate('clicks')==1
    print('PASS Gemini: delayed 2.6 s abbreviated user bubble, no double send')

    boot(pg,'deepseek','''
    <form><textarea placeholder="Message DeepSeek"></textarea><button type="submit" id="send">Send</button></form>
    <main id="turns"></main>
    <script>
      globalThis.clicks=0;
      const form=document.querySelector('form'), composer=document.querySelector('textarea');
      form.addEventListener('submit',e=>{
        e.preventDefault();clicks++;
        let body=composer.value.trim();composer.value='';
        setTimeout(()=>{
          let user=document.createElement('div');
          user.className='ds-message-row';
          user.setAttribute('data-message-id','deepseek-delayed-new-id');
          user.setAttribute('data-role','user');
          user.textContent=body;
          document.querySelector('#turns').append(user);
        },2600)
      });
    </script>''')
    r=send(pg,'DeepSeek new message after two seconds','deepseek')
    assert r['ok'] is True and r['result']['confirmed'] is True,r
    assert r['result']['userMessageId']=='deepseek-native:deepseek-delayed-new-id:q',r
    assert pg.evaluate('clicks')==1
    print('PASS DeepSeek: delayed 2.6 s user bubble, no double send')
    # DeepSeek also abbreviates long sent bubbles. A new, uniquely positioned
    # collapsed prefix is an ACK; the full answer is NOT needed.
    deepseek_prompt = ('接续 Gemini 的讨论：\n\n用户：\n测试网页接力确认。\n\nGemini：\n'
                      '这是为了验证长消息折叠气泡仍可快速识别送达的一段比较长的回答。' * 5)
    boot(pg,'deepseek','''
    <form><textarea placeholder="Message DeepSeek"></textarea><button type="submit">Send</button></form>
    <main id="turns"><div class="ds-message-row" data-message-id="baseline-1" data-role="user">旧消息</div></main>
    <script>
      globalThis.clicks=0;
      const f=document.querySelector('form'),t=document.querySelector('textarea');
      f.addEventListener('submit',e=>{
        e.preventDefault();clicks++;const txt=t.value;t.value='';
        setTimeout(()=>{
          const el=document.createElement('div');el.className='ds-message-row';
          el.setAttribute('data-message-id','deepseek-long-new-native-id');
          el.setAttribute('data-role','user');el.textContent=txt.slice(0,140)+'…';
          document.querySelector('#turns').append(el);
        },150);
      });
    </script>''')
    from time import monotonic
    start=monotonic()
    r=send(pg,deepseek_prompt,'deepseek')
    elapsed=monotonic()-start
    assert r['ok'] and r['result']['confirmed'] and r['result']['matchType']=='collapsed-preview',r
    assert r['result']['userMessageId']=='deepseek-native:deepseek-long-new-native-id:q',r
    assert pg.evaluate('clicks')==1
    assert elapsed<4.5, f'DeepSeek folded ACK too slow: {elapsed:.2f}s'
    print(f'PASS DeepSeek: collapsed long message ACK in {elapsed:.2f}s without waiting for AI reply')

    # Re-rendering an old bubble with the same prefix is NOT a new user turn.
    boot(pg,'deepseek','''
    <form><textarea placeholder="Message DeepSeek"></textarea><button type="submit">Send</button></form>
    <main><div class="ds-message-row" data-role="user" id="stale">已经存在的旧消息预览</div></main>
    <script>
      globalThis.clicks=0;
      document.querySelector('form').addEventListener('submit',e=>{
        e.preventDefault();clicks++;document.querySelector('textarea').value='';
        document.querySelector('#stale').textContent=window.__pendingText.slice(0,140)+'…';
      });
    </script>''',fast_no_ack=True)
    pg.evaluate('(txt)=>window.__pendingText=txt', deepseek_prompt)
    r=send(pg,deepseek_prompt,'deepseek')
    assert r['ok'] and r['result']['confirmed'] is False and not r['result']['sent'],r
    assert pg.evaluate('clicks')==1
    print('PASS DeepSeek: stale re-rendered bubble rejected, no automatic resend')

    # Repeated identical prompts MUST remain separate user turns; the old
    # content-hash-only IDs silently merged them and made the last turn stale.
    boot(pg,'gemini','''<main><user-query>重复测试</user-query>
        <model-response><div class="markdown">第一次回答</div></model-response>
        <user-query>重复测试</user-query></main>''')
    r=pg.evaluate("() => new Promise(resolve => __listeners[0]({type:'RT_INSPECT'}, {}, resolve))")
    assert r['ok'] and [m['role'] for m in r['snapshot']['messages']]==['user','assistant','user'],r
    ids=[m['id'] for m in r['snapshot']['messages'] if m['role']=='user']
    assert len(set(ids))==2,r
    print('PASS Gemini: repeated identical prompts remain distinct turns')

    boot(pg,'deepseek','''<main><div class="ds-message-row" data-role="user">重复测试</div>
        <div class="ds-message-row" data-role="assistant"><div class="ds-markdown">第一次回答</div></div>
        <div class="ds-message-row" data-role="user">重复测试</div></main>''')
    r=pg.evaluate("() => new Promise(resolve => __listeners[0]({type:'RT_INSPECT'}, {}, resolve))")
    assert r['ok'] and [m['role'] for m in r['snapshot']['messages']]==['user','assistant','user'],r
    ids=[m['id'] for m in r['snapshot']['messages'] if m['role']=='user']
    assert len(set(ids))==2,r
    print('PASS DeepSeek: repeated identical prompts remain distinct turns')
    boot(pg,'gemini','''<rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
        <button id="send" type="button" aria-label="Send message" disabled>Send</button>
        <script>
          globalThis.clicks=0;
          const c=document.querySelector('.ql-editor'),b=document.querySelector('button');
          c.addEventListener('input',()=>{b.disabled=!c.textContent.trim()});
          b.addEventListener('click',()=>{clicks++;c.replaceChildren();});
        </script>''')
    r=send(pg,'Nothing should be confirmed unless a user turn really appears','gemini')
    assert r['ok'] and r['result']['confirmed'] is False and not r['result']['sent'],r
    assert pg.evaluate('clicks')==1
    print('PASS Gemini: empty composer without a user bubble stays unconfirmed; no second click')
    browser.close()
