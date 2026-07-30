import asyncio, json, os, subprocess, tempfile, time, urllib.request, urllib.error
from urllib.parse import urlparse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 7891
BASE = f'http://127.0.0.1:{PORT}'
BROWSER_HOST = 'v041.test'

def get_json(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return json.loads(r.read().decode())


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
        with urllib.request.urlopen(req,timeout=5) as r: return r.status,dict(r.headers),r.read()
    except urllib.error.HTTPError as e: return e.code,dict(e.headers),e.read()

async def install_proxy(page):
    async def handler(route,request):
        parsed=urlparse(request.url); data=request.post_data.encode('utf-8') if request.post_data is not None else None
        status,headers,body=await asyncio.to_thread(forward_request,request.method,parsed.path+(("?"+parsed.query) if parsed.query else ''),data,request.headers)
        await route.fulfill(status=status,headers={'Content-Type':headers.get('Content-Type','application/json')},body=body)
    await page.route(f'http://{BROWSER_HOST}:{PORT}/**',handler)

def make_autosave(data_dir):
    script = r'''
const fs=require('fs'); const path=require('path');
const {RoomManager}=require('./server/room-manager.js');
const m=new RoomManager(); const room=m.createRoom(); const codes=room.auth.publicCodes();
const a=room.login(codes.A); const b=room.login(codes.B); room.setLobbyReady(b.sessionToken,true);
room.startGame(a.sessionToken,{mode:'classic',playerAColors:['red','yellow'],protectedColors:[],launchValues:[5,6],tripleSixPenalty:true,firstPlayer:'A'});
const e=room.serverEngine.engine; e.pieces.red[0].location={zone:'main',mainIndex:7};
const saved=e.pieces.red.map(p=>({id:p.id,location:JSON.parse(JSON.stringify(p.location)),finished:!!p.finished}));
e.pendingDefeat={color:'red',pieces:saved}; e._sendColorHome('red');
fs.mkdirSync(process.env.OUT,{recursive:true}); fs.writeFileSync(path.join(process.env.OUT,'autosave.json'),JSON.stringify(m.exportAutosave(),null,2));
'''
    env=os.environ.copy(); env['OUT']=str(data_dir)
    subprocess.run(['node','-e',script],cwd=ROOT,env=env,check=True)

async def login(page, html, code):
    await install_proxy(page)
    await page.set_content(html, wait_until='load')
    await page.click('[data-runtime-mode="lan"]')
    await page.fill('#lanHost',BROWSER_HOST)
    await page.fill('#lanPort',str(PORT))
    await page.fill('#lanLoginCode',code)
    await page.click('#lanConnectButton')
    await page.wait_for_function("() => document.querySelector('#networkBadge').textContent.includes('LAN - 玩家')",timeout=5000)

async def main():
    tmp=tempfile.TemporaryDirectory(prefix='double-flight-v041-')
    make_autosave(Path(tmp.name))
    env=os.environ.copy(); env['PORT']=str(PORT); env['DATA_DIR']=tmp.name
    proc=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    result={'ok':False,'checks':{},'errors':[],'serverLog':''}
    try:
        deadline=time.time()+8
        while time.time()<deadline:
            try: get_json('/api/info'); break
            except Exception: await asyncio.sleep(.1)
        state=get_json('/api/admin/status'); room=state['rooms'][0]; codes=room['codes']
        async with async_playwright() as p:
            browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
            html=build_inline_html()
            a=await browser.new_page(viewport={'width':1400,'height':900}); b=await browser.new_page(viewport={'width':1400,'height':900})
            a.on('pageerror',lambda e:result['errors'].append('A:'+str(e))); b.on('pageerror',lambda e:result['errors'].append('B:'+str(e)))
            await login(a,html,codes['A']); await login(b,html,codes['B'])
            await a.wait_for_selector('#defeatModal:not(.hidden)')
            result['checks']['requesterPopup']=await a.locator('#defeatText').inner_text()=='666你的红色被击败了！！！'
            result['checks']['requesterButtons']=(await a.locator('#undoDefeat').inner_text()=='申请反悔' and await a.locator('#acceptDefeat').inner_text()=='我接受')
            result['checks']['opponentNoPopupInitially']=await b.locator('#defeatModal').evaluate("e=>e.classList.contains('hidden')")
            heights=await a.evaluate("() => [...document.querySelectorAll('.lan-chat-panel')].map(e=>Math.round(parseFloat(e.style.height)||0))")
            result['checks']['chatDefault500']=all(h==500 for h in heights)
            await a.click('#undoDefeat')
            await b.wait_for_function("() => !document.querySelector('#undoRequestModal').classList.contains('hidden')",timeout=5000)
            result['checks']['approvalTitle']=await b.locator('#undoRequestText').inner_text()=='玩家A申请反悔三6遣返！'
            result['checks']['approvalButtons']=(await b.locator('#rejectUndoRequest').inner_text()=='666我要是不同意呢' and await b.locator('#allowUndoRequest').inner_text()=='我同意了')
            await b.click('#rejectUndoRequest')
            await b.wait_for_function("() => document.querySelector('#undoRequestModal').classList.contains('hidden')",timeout=5000)
            result['checks']['requesterStillOpenAfterReject']=not await a.locator('#defeatModal').evaluate("e=>e.classList.contains('hidden')")
            await a.click('#undoDefeat'); await b.wait_for_function("() => !document.querySelector('#undoRequestModal').classList.contains('hidden')",timeout=5000)
            await b.click('#allowUndoRequest')
            await a.wait_for_function("() => document.querySelector('#defeatModal').classList.contains('hidden')",timeout=5000)
            result['checks']['allowedRestores']=await a.evaluate("() => window.__doubleFlightDebug.getEngine().pendingDefeat===null && window.__doubleFlightDebug.getEngine().pieces.red[0].location.zone==='main'")
            await browser.close()
        result['ok']=all(result['checks'].values()) and not result['errors']
    except Exception as e:
        result['errors'].append(repr(e))
    finally:
        proc.terminate()
        try: result['serverLog']=proc.communicate(timeout=5)[0]
        except Exception: proc.kill(); result['serverLog']=proc.communicate()[0]
        tmp.cleanup()
    out=ROOT/'tests/browser-v041-targeted.json'; out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['ok'] else 1)

if __name__=='__main__': asyncio.run(main())
