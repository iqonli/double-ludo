import asyncio, json, os, subprocess, tempfile, time, urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
PORT=7877
BASE=f'http://127.0.0.1:{PORT}'

def get(path):
    with urllib.request.urlopen(BASE+path,timeout=5) as r: return json.loads(r.read().decode())
def post(path, body=None):
    req=urllib.request.Request(BASE+path,data=json.dumps(body or {}).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=5) as r: return json.loads(r.read().decode())

def build_inline_html():
    html=(ROOT/'public/game.html').read_text(encoding='utf-8')
    css=(ROOT/'public/styles.css').read_text(encoding='utf-8')
    html=html.replace('<link rel="stylesheet" href="styles.css">',f'<style>{css}</style>')
    for name,path in [('../shared/engine.js',ROOT/'shared/engine.js'),('../shared/action-protocol.js',ROOT/'shared/action-protocol.js'),('ai-model-normal.js',ROOT/'public/ai-model-normal.js'),('ai-model-advanced.js',ROOT/'public/ai-model-advanced.js'),('ai-controller.js',ROOT/'public/ai-controller.js'),('network-client.js',ROOT/'public/network-client.js'),('game.js',ROOT/'public/game.js')]:
        html=html.replace(f'<script src="{name}"></script>','<script>'+path.read_text(encoding='utf-8')+'</script>')
    return html

def forward_request(method,path,data,headers):
    req=urllib.request.Request(BASE+path,data=data,headers={'Content-Type':headers.get('content-type','application/json')},method=method)
    try:
        with urllib.request.urlopen(req,timeout=5) as r:return r.status,dict(r.headers),r.read()
    except urllib.error.HTTPError as e:return e.code,dict(e.headers),e.read()

async def install_proxy(page):
    async def handler(route,request):
        parsed=urlparse(request.url); data=request.post_data.encode('utf-8') if request.post_data is not None else None
        status,headers,body=await asyncio.to_thread(forward_request,request.method,parsed.path+(('?'+parsed.query) if parsed.query else ''),data,request.headers)
        await route.fulfill(status=status,headers={'Content-Type':headers.get('Content-Type','application/json')},body=body)
    await page.route('http://**/*',handler)

async def login(page, code, html):
    await install_proxy(page)
    await page.set_content(html, wait_until='load')
    await page.click('[data-runtime-mode="lan"]')
    await page.fill('#lanHost','127.0.0.1')
    await page.fill('#lanPort',str(PORT))
    await page.fill('#lanLoginCode',code)
    await page.click('#lanConnectButton')
    await page.wait_for_function("() => document.querySelector('#lanConnectionStatus').textContent.includes('已登录')",timeout=5000)

async def main():
    tmp=tempfile.TemporaryDirectory(prefix='df-v037-')
    env={**os.environ,'PORT':str(PORT),'HOST':'127.0.0.1','DATA_DIR':tmp.name}
    proc=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    result={'ok':False,'checks':{},'errors':[]}
    try:
        for _ in range(60):
            try:
                info=get('/api/info')
                if info.get('ok'): break
            except Exception: await asyncio.sleep(.1)
        status=get('/api/admin/status'); room=status['rooms'][0]; codes=room['codes']; html=build_inline_html()
        async with async_playwright() as p:
            browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
            a=await browser.new_page(viewport={'width':1280,'height':850}); b=await browser.new_page(viewport={'width':900,'height':760})
            a.on('pageerror',lambda e:result['errors'].append('A:'+str(e))); b.on('pageerror',lambda e:result['errors'].append('B:'+str(e)))
            await asyncio.gather(login(a,codes['A'],html),login(b,codes['B'],html))
            await a.click('#setupAboutButton')
            result['checks']['setupAbout']=await a.locator('#aboutModal').is_visible() and 'github.com/iqonli/double-ludo' in await a.locator('.about-copy').inner_text()
            result['checks']['setupAboutLeftAligned']=await a.locator('#aboutTitle').evaluate("e=>getComputedStyle(e).textAlign==='left'") and await a.locator('.about-copy').evaluate("e=>getComputedStyle(e).textAlign==='left'")
            await a.click('#closeAboutButton')
            await a.click('[data-color="red"]'); await a.click('[data-color="yellow"]')
            await a.wait_for_selector('#protectionChoices input[data-protect-color="red"]')
            await a.click('#protectionChoices input[data-protect-color="red"]')
            await a.wait_for_timeout(900)
            result['checks']['protectionDraftSurvivesPollingA']=await a.locator('#protectionChoices input[data-protect-color="red"]').is_checked()
            result['checks']['protectionWarningA']=await a.locator('.protection-unsaved').is_visible()
            before_submit=time.perf_counter()
            await a.click('[data-submit-protection]')
            await a.wait_for_function("() => document.querySelector('.protection-unsaved').classList.contains('hidden')",timeout=5000)
            result['checks']['protectionSubmitPausedA']=(time.perf_counter()-before_submit)>=0.50
            await b.wait_for_selector('#protectionChoices input[data-protect-color]')
            bp=b.locator('#protectionChoices input[data-protect-color]').first
            await bp.click(); await b.wait_for_timeout(900)
            result['checks']['protectionDraftSurvivesPollingB']=await bp.is_checked()
            result['checks']['protectionWarningB']=await b.locator('.protection-unsaved').is_visible()
            await b.click('[data-submit-protection]')
            await b.wait_for_function("() => document.querySelector('.protection-unsaved').classList.contains('hidden')",timeout=5000)
            result['checks']['protectionSubmitB']=True
            await a.evaluate("""() => { for (const i of document.querySelectorAll('#launchValueChoices input')) { if(!i.checked){i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}));} } }""")
            await a.wait_for_function("() => document.querySelector('#startGame').textContent.includes('等待玩家B准备')",timeout=5000)
            result['checks']['aWaitsForB']=await a.locator('#startGame').is_disabled()
            await b.wait_for_function("() => document.querySelector('#startGame').textContent.trim()==='准备' && !document.querySelector('#startGame').disabled",timeout=5000)
            await b.click('#startGame')
            await a.wait_for_function("() => document.querySelector('#startGame').textContent.includes('开始局域网游戏') && !document.querySelector('#startGame').disabled",timeout=5000)
            result['checks']['bReadyEnablesA']=True
            await a.click('#startGame')
            await asyncio.gather(a.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')",timeout=5000),b.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')",timeout=5000))
            await a.click('#gameAboutButton')
            result['checks']['gameAbout']=await a.locator('#aboutModal').is_visible()
            await a.click('#closeAboutButton')

            admin=await browser.new_page(viewport={'width':1200,'height':800}); await install_proxy(admin)
            raw=urllib.request.urlopen(BASE+'/admin',timeout=5).read().decode('utf-8').replace('<head>',f'<head><base href="http://server.test:{PORT}/">',1)
            await admin.set_content(raw,wait_until='load'); await admin.wait_for_selector('.room-card')
            await admin.click('#aboutButton')
            result['checks']['serverAbout']=await admin.locator('#aboutModal').is_visible() and 'MIT许可证' in await admin.locator('.admin-modal-card').inner_text()
            result['checks']['serverAboutLeftAligned']=await admin.locator('.admin-modal-card h2').evaluate("e=>getComputedStyle(e).textAlign==='left'")
            await admin.click('#closeAboutButton')
            await admin.click('#createRoom'); await admin.wait_for_function("() => document.querySelectorAll('.room-card').length===2",timeout=3000)
            boxes=await admin.locator('.room-card').evaluate_all("els=>els.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width}})")
            result['checks']['roomCardsOnePerRow']=boxes[1]['y']>boxes[0]['y'] and abs(boxes[1]['x']-boxes[0]['x'])<3
            await browser.close()
        result['ok']=all(result['checks'].values()) and not result['errors']
    finally:
        proc.terminate()
        try: out,_=proc.communicate(timeout=5)
        except subprocess.TimeoutExpired: proc.kill(); out,_=proc.communicate()
        result['serverLog']=out
        tmp.cleanup()
    (ROOT/'tests/browser-v037-targeted.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['ok'] else 1)

asyncio.run(main())
