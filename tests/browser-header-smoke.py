from pathlib import Path
import base64
import tempfile
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
browser_executable=next((str(path) for path in (
  Path('/usr/bin/chromium'),
  Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),
  Path(r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'),
) if path.is_file()),None)
html=(root/'sidepanel.html').read_text().replace('<link rel="stylesheet" href="sidepanel.css">','').replace('<script src="sidepanel.js"></script>','')
css=(root/'sidepanel.css').read_text()
js=(root/'sidepanel.js').read_text()
init='''(() => {
  window.__calls = { reload: [], bootstrap:0 };
  const events = () => {
    const listeners = new Set();
    return { addListener(fn) {listeners.add(fn)}, removeListener(fn){listeners.delete(fn)}, fire(...args){for(const fn of listeners) fn(...args)} };
  };
  const updated=events();
  const state = {
    session:{id:'s1',title:'系统测试对话'}, sessions:[{id:'s1',title:'系统测试对话'}],
    sourceTabId:1,activeTabId:1,
    supportedTabs:[{tabId:1,provider:'gemini',connected:true,online:true,conversationKey:'gemini:one'},
     {tabId:2,provider:'deepseek',connected:true,online:true,conversationKey:'deepseek:two'},
     {tabId:3,provider:'chatgpt',connected:true,online:true,conversationKey:'chatgpt:three'}],
    timeline:[{id:'a1',status:'COMPLETED',createdAt:1792449660000,source:{provider:'gemini'},target:{provider:'deepseek',tabId:2}},
     {id:'a2',status:'FAILED',createdAt:1792449690000,source:{provider:'deepseek'},target:{provider:'gemini',tabId:1},error:{message:'来源书签无法定位'}}],
    bookmarks:{'gemini:one':{messageId:'x'}},activeOperation:null
  };
  const transfers=[{operationId:'a1',provider:'deepseek',sourceProvider:'gemini',userText:'这是一个测试',sourceText:'Gemini 的回答内容',answerText:'DeepSeek 的回复'}];
  window.__fixtureState = state;
  window.chrome={
    runtime:{lastError:null,getURL:f=>f,onMessage:events(),sendMessage(req,cb){
      if(req.type==='RT_BOOTSTRAP') window.__calls.bootstrap++;
      if(req.type==='RT_ARCHIVE_READ'||req.type==='RT_ARCHIVE_REFRESH')cb({ok:true,archive:{sessionId:'s1',transfers,history:[]}});
      else cb({ok:true,state});
    }},
    windows:{async getCurrent(){return{id:99}}},
    tabs:{onActivated:events(),onRemoved:events(),onUpdated:updated,
      reload(id,opts,cb){ window.__calls.reload.push(id);cb();setTimeout(()=>updated.fire(id,{status:'complete'}),100); },
      create(){}
    },
    storage:{local:{get(_k,cb){cb({})},set(_v,cb){cb?.()}}}
  };
})()'''
with sync_playwright() as p:
  launch_options={'headless':True,'args':['--no-sandbox']}
  if browser_executable:
    launch_options['executable_path']=browser_executable
  browser=p.chromium.launch(**launch_options)
  for width in [280,350,415]:
    page=browser.new_page(viewport={'width':width,'height':760},device_scale_factor=1)
    page.add_init_script(init)
    page.goto('about:blank')
    page.set_content(html)
    page.add_style_tag(content=css)
    page.add_script_tag(content=js)
    assets={f'icons/{name}.png': 'data:image/png;base64,'+base64.b64encode((root/'icons'/f'{name}.png').read_bytes()).decode() for name in ['chatgpt','gemini','deepseek','icon48']}
    assets['icons/logo.svg']='data:image/svg+xml;base64,'+base64.b64encode((root/'icons/logo.svg').read_bytes()).decode()
    page.evaluate('assets => document.querySelectorAll("img[src]").forEach(img => {const source=img.getAttribute("src"); if(assets[source]) img.src=assets[source]})',assets)
    page.wait_for_function('document.querySelector(".entry-model-name")?.textContent === "Gemini"')
    cards=page.locator('.entry-model-name').all_inner_texts()
    assert cards==['Gemini','接力'],cards
    assert page.locator('.entry-route').first.inner_text().strip().endswith('DeepSeek')
    assert page.locator('#pick-bookmark').count()==0
    assert page.locator('#export-discussion').count()==1
    assert page.locator('#refresh-connection').count()==1
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'overflow {width}'
    page.locator('#more-button').click()
    menu=page.locator('#more-menu button:visible')
    assert menu.count()==1, menu.all_inner_texts()
    page.locator('#more-button').click()
    page.locator('[data-provider="deepseek"]').click()
    page.locator('#refresh-connection').click()
    page.wait_for_function('window.__calls.reload.length === 2')
    page.wait_for_function('!document.querySelector("#refresh-connection").disabled')
    assert page.evaluate('window.__calls.reload')==[1,2]
    assert '网页已重新连接' in page.locator('#notice-bar').inner_text()
    page.evaluate('''() => {
      window.__fixtureState.activeOperation = {id:'pending',state:'WAITING',target:{awaitingConfirmation:true}};
      chrome.runtime.onMessage.fire({type:'RT_STATE_CHANGED',state:window.__fixtureState});
    }''')
    page.wait_for_function('document.querySelector("#send-button").classList.contains("is-busy")')
    assert page.locator('#refresh-connection').is_enabled()
    count=page.evaluate('window.__calls.bootstrap')
    page.locator('#refresh-connection').click()
    page.wait_for_function('(count) => window.__calls.bootstrap > count',arg=count)
    page.wait_for_function('!document.querySelector("#refresh-connection").disabled')
    assert page.evaluate('window.__calls.reload')==[1,2], 'delivery recovery must not reload or resend'
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'overflow after refresh {width}'
    if width == 350:
      preview=Path(tempfile.gettempdir()) / 'ai-roundtable-v1.0.31-header-smoke.png'
      page.evaluate('assets => document.querySelectorAll("img[src]").forEach(img => {const source=img.getAttribute("src"); if(assets[source]) img.src=assets[source]})',assets)
      page.evaluate('() => Promise.all(Array.from(document.querySelectorAll("img[src]"), img => img.decode().catch(() => null)))')
      page.screenshot(path=str(preview))
    print('PASS',width,'px','model/system cards, menu, refresh flow, no overflow')
    page.close()
  browser.close()
