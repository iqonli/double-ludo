import asyncio
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 7890
NODE_BASE = f"http://127.0.0.1:{PORT}"
BROWSER_HOST = "speed.test"


def post(path, body=None):
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(NODE_BASE + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.status, dict(response.headers), response.read()


def build_inline_html():
    html = (ROOT / "public/game.html").read_text(encoding="utf-8")
    css = (ROOT / "public/styles.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="styles.css">', f'<style>{css}</style>')
    scripts = [
        ("../shared/engine.js", ROOT / "shared/engine.js"),
        ("../shared/action-protocol.js", ROOT / "shared/action-protocol.js"),
        ("ai-model-normal.js", ROOT / "public/ai-model-normal.js"),
        ("ai-model-advanced.js", ROOT / "public/ai-model-advanced.js"),
        ("ai-controller.js", ROOT / "public/ai-controller.js"),
        ("network-client.js", ROOT / "public/network-client.js"),
        ("game.js", ROOT / "public/game.js"),
    ]
    for name, file_path in scripts:
        html = html.replace(f'<script src="{name}"></script>', '<script>' + file_path.read_text(encoding="utf-8") + '</script>')
    return html


def forward_request(method, path, data, headers):
    request = urllib.request.Request(
        NODE_BASE + path,
        data=data,
        headers={"Content-Type": headers.get("content-type", "application/json")},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


async def install_proxy(page):
    async def handler(route, request):
        parsed = urlparse(request.url)
        data = request.post_data.encode("utf-8") if request.post_data is not None else None
        status, headers, body = await asyncio.to_thread(
            forward_request,
            request.method,
            parsed.path + (("?" + parsed.query) if parsed.query else ""),
            data,
            request.headers,
        )
        await route.fulfill(status=status, headers={"Content-Type": headers.get("Content-Type", "application/json")}, body=body)
    await page.route(f"http://{BROWSER_HOST}:{PORT}/**", handler)
    await page.route(f"http://127.0.0.1:{PORT}/**", handler)


async def login(page, html, code):
    await install_proxy(page)
    await page.set_content(html, wait_until="load")
    await page.click('[data-runtime-mode="lan"]')
    await page.fill('#lanHost', BROWSER_HOST)
    await page.fill('#lanPort', str(PORT))
    await page.fill('#lanLoginCode', code)
    await page.click('#lanConnectButton')
    await page.wait_for_function("() => document.querySelector('#networkBadge').textContent.includes('LAN - 玩家')", timeout=5000)


async def main():
    env = os.environ.copy()
    env['PORT'] = str(PORT)
    temp_data = tempfile.TemporaryDirectory(prefix='double-flight-v040-')
    env['DATA_DIR'] = temp_data.name
    server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    result = {'ok': False, 'checks': {}, 'errors': [], 'serverLog': ''}
    try:
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                urllib.request.urlopen(NODE_BASE + '/api/info', timeout=1)
                break
            except Exception:
                await asyncio.sleep(.1)
        _, _, opened_body = post('/api/admin/open')
        codes = json.loads(opened_body.decode('utf-8'))['codes']
        html = build_inline_html()

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])

            # Finished-count label position and counter-rotation.
            local = await browser.new_page(viewport={'width': 1280, 'height': 850})
            local.on('pageerror', lambda e: result['errors'].append('local: ' + str(e)))
            await local.set_content(html, wait_until='load')
            await local.evaluate("""() => {
              const engine = window.__doubleFlightDebug.startClassic(['red','yellow']);
              for (const piece of engine.pieces.red) {
                piece.location = { zone: 'finished', finishColor: 'red' };
                piece.finished = true;
              }
              window.__doubleFlightDebug.render();
            }""")
            await local.wait_for_selector('.finish-count-label')
            await local.wait_for_timeout(380)
            centered = await local.evaluate("""() => {
              const label = document.querySelector('.finish-count-label').getBoundingClientRect();
              const pieces = [...document.querySelectorAll('.piece.red')].map(node => node.getBoundingClientRect());
              const cx = pieces.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / pieces.length;
              const cy = pieces.reduce((sum, rect) => sum + rect.top + rect.height / 2, 0) / pieces.length;
              return { dx: Math.abs(label.left + label.width / 2 - cx), dy: Math.abs(label.top + label.height / 2 - cy) };
            }""")
            result['checks']['finishCountCentered'] = centered['dx'] < 3 and centered['dy'] < 3
            await local.click('#rotateBoardRight')
            await local.wait_for_timeout(260)
            net_angle = await local.evaluate("""() => {
              const parent = new DOMMatrix(getComputedStyle(document.querySelector('#pieceLayer')).transform);
              const child = new DOMMatrix(getComputedStyle(document.querySelector('.finish-count-label')).transform);
              const total = parent.multiply(child);
              return Math.atan2(total.b, total.a) * 180 / Math.PI;
            }""")
            result['checks']['finishCountUpright'] = abs(net_angle) < 1

            page_a = await browser.new_page(viewport={'width': 1200, 'height': 850})
            page_b = await browser.new_page(viewport={'width': 900, 'height': 800})
            page_a.on('pageerror', lambda e: result['errors'].append('A: ' + str(e)))
            page_b.on('pageerror', lambda e: result['errors'].append('B: ' + str(e)))
            await login(page_a, html, codes['A'])
            await login(page_b, html, codes['B'])

            await page_a.click('[data-color="red"]')
            await page_a.click('[data-color="yellow"]')
            await page_a.click('[data-mode="speed"]')
            await page_b.wait_for_function("() => !document.querySelector('#speedOrderSection').classList.contains('hidden')", timeout=5000)

            result['checks']['bothSeeRollButtons'] = await page_a.locator('#rollOrderA').is_visible() and await page_a.locator('#rollOrderB').is_visible() and await page_b.locator('#rollOrderA').is_visible() and await page_b.locator('#rollOrderB').is_visible()
            result['checks']['ownRollButtonsGreen'] = await page_a.locator('#rollOrderA').evaluate("e => e.classList.contains('own-roll')") and await page_b.locator('#rollOrderB').evaluate("e => e.classList.contains('own-roll')")
            result['checks']['onlyOwnRollEnabled'] = (not await page_a.locator('#rollOrderA').is_disabled()) and await page_a.locator('#rollOrderB').is_disabled() and await page_b.locator('#rollOrderA').is_disabled() and (not await page_b.locator('#rollOrderB').is_disabled())
            result['checks']['bCannotReadyBeforeRoll'] = await page_b.locator('#startGame').is_disabled()

            await page_a.click('#rollOrderA')
            await page_a.wait_for_function("() => document.querySelector('#orderResultA').textContent !== '未投'", timeout=3000)
            await page_b.wait_for_function("() => document.querySelector('#orderResultA').textContent !== '未投'", timeout=3000)
            result['checks']['aRollOneShot'] = await page_a.locator('#rollOrderA').is_disabled()

            await page_b.click('#rollOrderB')
            await page_b.wait_for_function("() => document.querySelector('#orderSummary').textContent.includes('先手')", timeout=3000)
            await page_a.wait_for_function("() => document.querySelector('#orderSummary').textContent.includes('先手')", timeout=3000)
            result['checks']['bRollOneShot'] = await page_b.locator('#rollOrderB').is_disabled()

            # Only classic -> speed resets the one-shot opportunities.
            await page_a.click('[data-mode="classic"]')
            await page_b.wait_for_function("() => document.querySelector('#speedOrderSection').classList.contains('hidden')", timeout=3000)
            await page_a.click('[data-mode="speed"]')
            await page_b.wait_for_function("() => !document.querySelector('#speedOrderSection').classList.contains('hidden') && document.querySelector('#orderResultA').textContent === '未投' && document.querySelector('#orderResultB').textContent === '未投'", timeout=5000)
            result['checks']['modeRoundTripResetsRolls'] = (not await page_a.locator('#rollOrderA').is_disabled()) and (not await page_b.locator('#rollOrderB').is_disabled())

            # B may prepare only after its own roll; A still needs both rolls before start.
            await page_b.click('#rollOrderB')
            await page_b.wait_for_function("() => document.querySelector('#orderResultB').textContent !== '未投'", timeout=3000)
            await page_b.wait_for_function("() => !document.querySelector('#startGame').disabled", timeout=3000)
            result['checks']['bCanReadyAfterOwnRoll'] = not await page_b.locator('#startGame').is_disabled()
            await page_a.click('#rollOrderA')
            await page_a.wait_for_function("() => document.querySelector('#orderSummary').textContent.includes('先手')", timeout=3000)
            await page_b.click('#startGame')
            await page_a.wait_for_function("() => document.querySelector('#startGame').textContent === '开始局域网游戏' && !document.querySelector('#startGame').disabled", timeout=3000)
            await page_a.click('#startGame')
            await page_a.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')", timeout=5000)
            await page_b.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')", timeout=5000)
            result['checks']['speedGameStartsForBoth'] = await page_a.locator('#gameTitle').inner_text() == '极速双飞' and await page_b.locator('#gameTitle').inner_text() == '极速双飞'

            await browser.close()

        result['ok'] = all(result['checks'].values()) and not result['errors']
    finally:
        server.terminate()
        try:
            stdout, _ = server.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            stdout, _ = server.communicate(timeout=2)
        result['serverLog'] = stdout
        temp_data.cleanup()

    out = ROOT / 'tests/browser-v040-targeted.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ok'] else 1)


asyncio.run(main())
