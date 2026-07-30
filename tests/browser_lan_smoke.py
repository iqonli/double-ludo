import asyncio
import json
import os
import subprocess
import time
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 7866
NODE_BASE = f"http://127.0.0.1:{PORT}"
BROWSER_HOST = "server.test"



def get(path):
    with urllib.request.urlopen(NODE_BASE + path, timeout=5) as response:
        return response.status, dict(response.headers), response.read()

def post(path, body=None):
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        NODE_BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
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
        await route.fulfill(
            status=status,
            headers={"Content-Type": headers.get("Content-Type", "application/json")},
            body=body,
        )
    await page.route(f"http://{BROWSER_HOST}:{PORT}/**", handler)
    await page.route(f"http://127.0.0.1:{PORT}/**", handler)


async def login(page, html, code):
    await install_proxy(page)
    await page.set_content(html, wait_until="load")
    await page.click('[data-runtime-mode="lan"]')
    await page.fill("#lanHost", BROWSER_HOST)
    await page.fill("#lanPort", str(PORT))
    await page.fill("#lanLoginCode", code)
    await page.click("#lanConnectButton")
    await page.wait_for_function("() => document.querySelector('#networkBadge').textContent.includes('LAN - 玩家')")


async def main():
    env = os.environ.copy()
    env["PORT"] = str(PORT)
    temp_data = tempfile.TemporaryDirectory(prefix="double-flight-lan-test-")
    env["DATA_DIR"] = temp_data.name
    server = subprocess.Popen(
        ["node", "server.js"], cwd=ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    result = {"ok": False, "checks": {}, "errors": [], "serverLog": ""}
    try:
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                urllib.request.urlopen(NODE_BASE + "/api/info", timeout=1)
                break
            except Exception:
                await asyncio.sleep(0.1)
        _, _, opened_body = post("/api/admin/open")
        opened = json.loads(opened_body.decode("utf-8"))
        codes = opened["codes"]
        result["checks"]["fiveDigitCodes"] = (
            len(codes["A"]) == 5 and codes["A"].isdigit()
            and len(codes["B"]) == 5 and codes["B"].isdigit()
            and codes["A"] != codes["B"]
        )
        html = build_inline_html()
        _, _, admin_body = get("/admin")
        admin_html = admin_body.decode("utf-8").replace("<head>", f'<head><base href="http://{BROWSER_HOST}:{PORT}/">', 1)

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, executable_path="/usr/bin/chromium", args=["--no-sandbox"])
            admin_page = await browser.new_page(viewport={"width": 900, "height": 700})
            await install_proxy(admin_page)
            await admin_page.set_content(admin_html, wait_until="load")
            await admin_page.wait_for_function("() => document.querySelectorAll('.room-card').length >= 1", timeout=5000)
            result["checks"]["adminStatusLoads"] = "房间 1" in await admin_page.locator("#roomsGrid").inner_text()
            await admin_page.wait_for_function("() => document.querySelector('#consoleLog').textContent.includes('双飞 v0.41 多房间局域网服务器已启动')", timeout=5000)
            result["checks"]["adminConsoleMirrors"] = str(PORT) in await admin_page.locator("#consoleLog").inner_text()
            await admin_page.fill("#chatInput", "服务端消息\n第二行")
            await admin_page.click("#sendChat")
            await admin_page.wait_for_function("() => document.querySelector('#chatLog').textContent.includes('服务端消息')", timeout=3000)
            result["checks"]["adminCanChat"] = "服务端:" in await admin_page.locator("#chatLog").inner_text()
            result["checks"]["adminOwnMessageDoesNotShake"] = not await admin_page.locator("#chatCard").evaluate("e => e.classList.contains('chat-bg-shake')")
            admin_chat_before = await admin_page.locator('#chatCard').bounding_box()
            admin_handle = await admin_page.locator('#chatResizeHandle').bounding_box()
            if admin_chat_before and admin_handle:
                await admin_page.mouse.move(admin_handle['x'] + admin_handle['width'] / 2, admin_handle['y'] + admin_handle['height'] / 2)
                await admin_page.mouse.down()
                await admin_page.mouse.move(admin_handle['x'] + admin_handle['width'] / 2, admin_handle['y'] + admin_handle['height'] / 2 + 55, steps=5)
                await admin_page.mouse.up()
            admin_chat_after = await admin_page.locator('#chatCard').bounding_box()
            result["checks"]["adminChatHeightResizable"] = bool(admin_chat_before and admin_chat_after and admin_chat_after['height'] >= admin_chat_before['height'] + 35)
            bundle_button = admin_page.locator(".room-card").first.locator("button", has_text="复制端口+登录码").first
            await bundle_button.click()
            await admin_page.wait_for_function("() => document.querySelector('#copyNotice').textContent.includes('-')", timeout=2000)
            result["checks"]["copyPortAndCode"] = f"{PORT}-{codes['A']}" in await admin_page.locator("#copyNotice").inner_text()
            await admin_page.click("#createRoom")
            await admin_page.wait_for_function("() => document.querySelectorAll('.room-card').length === 2", timeout=3000)
            result["checks"]["adminCreatesMultipleRooms"] = "房间 2" in await admin_page.locator("#roomsGrid").inner_text()
            await admin_page.select_option("#chatRoomSelect", "1")

            page_a = await browser.new_page(viewport={"width": 1280, "height": 850})
            page_b = await browser.new_page(viewport={"width": 390, "height": 780})
            page_a.on("pageerror", lambda e: result["errors"].append("A: " + str(e)))
            page_b.on("pageerror", lambda e: result["errors"].append("B: " + str(e)))

            await install_proxy(page_a)
            await page_a.set_content(html, wait_until="load")
            parsed = await page_a.evaluate("text => window.__doubleFlightDebug.parseSmartLanInput(text)", f"地址 127.0.0.1 连接 {PORT}-{codes['A']}")
            result["checks"]["smartInputParsing"] = parsed == {"ip": "127.0.0.1", "port": str(PORT), "code": codes["A"]}
            await page_a.click('[data-runtime-mode="lan"]')
            await page_a.fill("#lanPort", str(PORT))
            await page_a.click("#lanAutoSearchButton")
            await page_a.wait_for_function("() => document.querySelector('#lanHost').value === '127.0.0.1'", timeout=5000)
            result["checks"]["autoSearchFindsServer"] = True

            await asyncio.gather(login(page_a, html, codes["A"]), login(page_b, html, codes["B"]))
            result["checks"]["aSeesSetup"] = await page_a.locator("#modeSection").is_visible()
            result["checks"]["bWaits"] = await page_b.locator("#lanWaitingSection").is_visible()
            result["checks"]["mobileConnectLayout"] = await page_b.locator("#lanConnectPanel").is_visible()
            result["checks"]["chatBelowPlayers"] = await page_b.locator("#lanChatPanel").is_visible()
            result["checks"]["allGameChatCardsResizable"] = await page_a.locator('.lan-chat-resize-handle').count() == 4
            setup_box = await page_a.locator(".setup-card").bounding_box()
            result["checks"]["setupMainCardCentered"] = setup_box is not None and abs((setup_box["x"] + setup_box["width"] / 2) - 640) <= 3
            chat_before = await page_a.locator('#setupLanChatPanel').bounding_box()
            handle_box = await page_a.locator('#setupLanChatPanel .lan-chat-resize-handle').bounding_box()
            if chat_before and handle_box:
                await page_a.mouse.move(handle_box['x'] + handle_box['width'] / 2, handle_box['y'] + handle_box['height'] / 2)
                await page_a.mouse.down()
                await page_a.mouse.move(handle_box['x'] + handle_box['width'] / 2, handle_box['y'] + handle_box['height'] / 2 + 70, steps=6)
                await page_a.mouse.up()
            chat_after = await page_a.locator('#setupLanChatPanel').bounding_box()
            result["checks"]["chatHeightResizable"] = bool(chat_before and chat_after and chat_after['height'] >= chat_before['height'] + 45)
            result["checks"]["chatDefaultsToEnter"] = (
                await page_a.locator("#lanChatHint").inner_text() == "当前：Enter发送"
                and await page_a.evaluate("() => window.__doubleFlightDebug.getLanChatSendKeyMode()") == "enter"
            )
            await page_a.locator("#lanChatHint").evaluate("e => e.click()")
            result["checks"]["chatModeToggles"] = (
                await page_a.locator("#lanChatHint").inner_text() == "当前：Shift+Enter发送"
                and await page_a.evaluate("() => window.__doubleFlightDebug.getLanChatSendKeyMode()") == "shift-enter"
            )
            await page_a.locator("#lanChatHint").evaluate("e => e.click()")

            # The four timing controls only affect visual animation. Raising them
            # must not change or pause the independent 500 ms network loop.
            await page_a.evaluate("""() => {
              for (const id of ['loopWaitMs','stepDurationMs','specialDurationMs','stageWaitMs']) {
                const input = document.getElementById(id);
                input.value = '5000';
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }""")
            result["checks"]["animationDoesNotChangePolling"] = (
                await page_a.evaluate("() => window.__doubleFlightDebug.getNetworkInterval()") == 500
                and all(value == 5000 for value in (await page_a.evaluate("() => Object.values(window.__doubleFlightDebug.getTiming())")))
            )
            _, _, before_chat_body = get("/api/admin/status")
            before_chat = json.loads(before_chat_body.decode("utf-8"))
            await page_a.fill("#lanChatInput", "快点准备！！\ncontent2")
            await page_a.press("#lanChatInput", "Enter")
            await page_b.wait_for_function("() => document.querySelector('#lanChatLog').textContent.includes('快点准备！！')", timeout=3000)
            await page_b.wait_for_function("() => document.querySelector('#lanChatPanel').classList.contains('chat-shake')", timeout=2000)
            await page_b.wait_for_function("() => document.querySelectorAll('#lanSpiritLayer .chat-spirit').length > 0", timeout=2500)
            result["checks"]["incomingChatSpirit"] = await page_b.locator('#lanSpiritLayer .chat-spirit').count() > 0
            result["checks"]["incomingOnlyChatShake"] = (
                not await page_a.locator("#lanChatPanel").evaluate("e => e.classList.contains('chat-shake')")
                and await page_b.locator("#lanChatPanel").evaluate("e => e.classList.contains('chat-shake')")
                and not await page_b.locator("#lanChatInput").evaluate("e => getComputedStyle(e).transform !== 'none'")
            )
            await admin_page.wait_for_function("() => document.querySelector('#chatCard').classList.contains('chat-bg-shake')", timeout=2500)
            result["checks"]["adminIncomingChatShakesBackground"] = await admin_page.locator("#chatCard").evaluate("e => e.classList.contains('chat-bg-shake')")
            chat_text = await page_b.locator("#lanChatLog").inner_text()
            _, _, after_chat_body = get("/api/admin/status")
            after_chat = json.loads(after_chat_body.decode("utf-8"))
            result["checks"]["multilineChat"] = (
                "玩家A:" in chat_text and "快点准备！！\ncontent2" in chat_text
                and before_chat["version"] == after_chat["version"]
                and after_chat["chatVersion"] > before_chat["chatVersion"]
                and "服务端消息" in chat_text
            )
            await page_a.evaluate("""() => {
              for (const id of ['loopWaitMs','stepDurationMs','specialDurationMs','stageWaitMs']) {
                const input = document.getElementById(id);
                input.value = '120';
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }""")

            await page_a.click('[data-color="red"]')
            await page_a.click('[data-color="yellow"]')
            # Make the animation smoke deterministic: every die value can launch,
            # so the test always reaches a real piece movement instead of depending
            # on the random opening roll.
            await page_a.evaluate("""() => {
              for (const input of document.querySelectorAll('#launchValueChoices input')) {
                if (!input.checked) {
                  input.checked = true;
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            }""")
            await page_a.wait_for_function("() => document.querySelector('#startGame').textContent.includes('等待玩家B准备')", timeout=5000)
            await page_b.wait_for_function("() => document.querySelector('#startGame').textContent.trim()==='准备' && !document.querySelector('#startGame').disabled", timeout=5000)
            await page_b.click("#startGame")
            await page_a.wait_for_function("() => document.querySelector('#startGame').textContent.includes('开始局域网游戏') && !document.querySelector('#startGame').disabled", timeout=5000)
            await page_a.click("#startGame")
            await asyncio.gather(
                page_a.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')"),
                page_b.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')"),
            )
            result["checks"]["bothEnteredGame"] = True
            await page_a.wait_for_function("() => document.querySelectorAll('#lanSpiritLayer .turn-spirit').length > 0", timeout=2500)
            result["checks"]["ownTurnSpirit"] = await page_a.locator('#lanSpiritLayer .turn-spirit').count() > 0
            left_before = await page_a.locator('#leftPanel').bounding_box()
            left_handle = await page_a.locator('#leftColumnResizer').bounding_box()
            if left_before and left_handle:
                await page_a.mouse.move(left_handle['x'] + left_handle['width'] / 2, left_handle['y'] + 120)
                await page_a.mouse.down()
                await page_a.mouse.move(left_handle['x'] + left_handle['width'] / 2 + 45, left_handle['y'] + 120, steps=6)
                await page_a.mouse.up()
            left_after = await page_a.locator('#leftPanel').bounding_box()
            right_before = await page_a.locator('#turnInteractionPanel').bounding_box()
            right_handle = await page_a.locator('#rightColumnResizer').bounding_box()
            if right_before and right_handle:
                await page_a.mouse.move(right_handle['x'] + right_handle['width'] / 2, right_handle['y'] + 120)
                await page_a.mouse.down()
                await page_a.mouse.move(right_handle['x'] + right_handle['width'] / 2 - 35, right_handle['y'] + 120, steps=6)
                await page_a.mouse.up()
            right_after = await page_a.locator('#turnInteractionPanel').bounding_box()
            result["checks"]["sideColumnsResizable"] = bool(left_before and left_after and right_before and right_after and left_after['width'] >= left_before['width'] + 30 and right_after['width'] >= right_before['width'] + 20)
            result["checks"]["aCanRoll"] = not await page_a.locator("#rollButton").is_disabled()
            result["checks"]["bCannotRoll"] = await page_b.locator("#rollButton").is_disabled()
            result["checks"]["ownTurnHighlight"] = (
                await page_a.locator("#turnInteractionPanel").evaluate("e => e.classList.contains('your-turn')")
                and not await page_b.locator("#turnInteractionPanel").evaluate("e => e.classList.contains('your-turn')")
            )

            await page_a.click("#rollButton")
            await asyncio.gather(
                page_a.wait_for_function("() => !window.__doubleFlightDebug.isLanAnimationActive() && document.querySelector('#die0 strong').textContent !== '–'", timeout=5000),
                page_b.wait_for_function("() => !window.__doubleFlightDebug.isLanAnimationActive() && document.querySelector('#die0 strong').textContent !== '–'", timeout=5000),
            )
            state_a = await page_a.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
            state_b = await page_b.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
            result["checks"]["statesMatchAfterAction"] = state_a == state_b
            result["checks"]["serverDiceVisible"] = (await page_a.locator("#die0 strong").inner_text()) != "–" and (await page_b.locator("#die0 strong").inner_text()) != "–"
            result["checks"]["lanTransitionAnimated"] = (
                await page_a.evaluate("() => window.__doubleFlightDebug.getLanVisualVersion()") > 0
                and await page_b.evaluate("() => window.__doubleFlightDebug.getLanVisualVersion()") > 0
            )

            # Continue through die selection until the current player can move
            # a piece. Opening automatic rolls may hand control to either A or B.
            actor_page = page_a
            observer_page = page_b
            for _ in range(4):
                current_role = await page_a.evaluate("() => window.__doubleFlightDebug.getEngine().currentPlayerId")
                actor_page = page_a if current_role == "A" else page_b
                observer_page = page_b if current_role == "A" else page_a
                phase = await actor_page.evaluate("() => window.__doubleFlightDebug.getEngine().phase")
                if phase == "selectPiece":
                    break
                if phase == "selectDie":
                    enabled = actor_page.locator(".die-button:not(:disabled)")
                    if await enabled.count():
                        _, _, before_select_body = get("/api/admin/status")
                        before_select_version = json.loads(before_select_body.decode("utf-8"))["version"]
                        await enabled.first.evaluate("e => e.click()")
                        deadline_select = time.time() + 5
                        new_select_version = before_select_version
                        while time.time() < deadline_select:
                            _, _, selected_body = get("/api/admin/status")
                            new_select_version = json.loads(selected_body.decode("utf-8"))["version"]
                            if new_select_version > before_select_version:
                                break
                            await asyncio.sleep(0.05)
                        await asyncio.gather(
                            actor_page.wait_for_function("version => window.__doubleFlightDebug.getLanVisualVersion() >= version && !window.__doubleFlightDebug.isLanAnimationActive()", arg=new_select_version, timeout=5000),
                            observer_page.wait_for_function("version => window.__doubleFlightDebug.getLanVisualVersion() >= version && !window.__doubleFlightDebug.isLanAnimationActive()", arg=new_select_version, timeout=5000),
                        )
                        continue
                break
            result["checks"]["pieceMoveAvailable"] = await actor_page.locator(".piece.selectable").count() > 0
            if result["checks"]["pieceMoveAvailable"]:
                pre_move_state = await actor_page.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
                await observer_page.evaluate("""() => {
                  for (const id of ['stepDurationMs','specialDurationMs','stageWaitMs']) {
                    const input = document.getElementById(id);
                    input.value = '450';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                }""")
                animation_started = observer_page.wait_for_function("() => window.__doubleFlightDebug.isLanAnimationActive()", timeout=5000)
                await actor_page.locator(".piece.selectable").first.evaluate("e => e.click()")
                await animation_started
                result["checks"]["opponentMoveAnimationStarted"] = True
                await asyncio.gather(
                    page_a.wait_for_function("() => !window.__doubleFlightDebug.isLanAnimationActive()", timeout=7000),
                    page_b.wait_for_function("() => !window.__doubleFlightDebug.isLanAnimationActive()", timeout=7000),
                )
                moved_state_a = await page_a.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
                moved_state_b = await page_b.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
                result["checks"]["statesMatchAfterPieceAnimation"] = moved_state_a == moved_state_b

                await actor_page.wait_for_function("() => !document.querySelector('#undoActionButton').disabled", timeout=5000)
                await actor_page.click("#undoActionButton")
                await observer_page.wait_for_function("() => !document.querySelector('#undoRequestModal').classList.contains('hidden')", timeout=5000)
                result["checks"]["undoApprovalModal"] = "允许玩家" in await observer_page.locator("#undoRequestText").inner_text()
                result["checks"]["undoModalHasChat"] = await observer_page.locator("#undoLanChatPanel").is_visible()
                await observer_page.click("#rejectUndoRequest")
                await observer_page.wait_for_function("() => document.querySelector('#undoRequestModal').classList.contains('hidden')", timeout=5000)
                await actor_page.wait_for_function("() => !document.querySelector('#undoActionButton').disabled", timeout=5000)
                await actor_page.click("#undoActionButton")
                await observer_page.wait_for_function("() => !document.querySelector('#undoRequestModal').classList.contains('hidden')", timeout=5000)
                _, _, before_allow_body = get("/api/admin/status")
                before_allow_version = json.loads(before_allow_body.decode("utf-8"))["version"]
                await observer_page.click("#allowUndoRequest")
                deadline_undo = time.time() + 5
                undo_server_version = -1
                while time.time() < deadline_undo:
                    _, _, undo_status_body = get("/api/admin/status")
                    undo_server_version = json.loads(undo_status_body.decode("utf-8"))["version"]
                    if undo_server_version > before_allow_version:
                        break
                    await asyncio.sleep(0.05)
                await asyncio.gather(
                    page_a.wait_for_function("version => window.__doubleFlightDebug.getLanVisualVersion() >= version && !window.__doubleFlightDebug.isLanAnimationActive()", arg=undo_server_version, timeout=7000),
                    page_b.wait_for_function("version => window.__doubleFlightDebug.getLanVisualVersion() >= version && !window.__doubleFlightDebug.isLanAnimationActive()", arg=undo_server_version, timeout=7000),
                )
                undo_state_a = await page_a.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
                undo_state_b = await page_b.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
                result["checks"]["undoRestoresBothClients"] = undo_state_a == pre_move_state and undo_state_b == pre_move_state
            else:
                result["checks"]["opponentMoveAnimationStarted"] = False
                result["checks"]["statesMatchAfterPieceAnimation"] = False
                result["checks"]["undoApprovalModal"] = False
                result["checks"]["undoModalHasChat"] = False
                result["checks"]["undoRestoresBothClients"] = False

            current_after_move = await page_a.evaluate("() => window.__doubleFlightDebug.getEngine().currentPlayerId")
            wrong_page = page_b if current_after_move == "A" else page_a
            before_wrong = await wrong_page.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
            await wrong_page.locator("#rollButton").evaluate("e => e.click()")
            await wrong_page.wait_for_timeout(250)
            after_wrong = await wrong_page.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
            result["checks"]["wrongPlayerBlocked"] = before_wrong == after_wrong

            # Export a normal JSON save, edit it, restore it, and ensure both clients
            # adopt the restored authoritative state. This is intentionally not a
            # replay test: the restored snapshot directly becomes the current game.
            _, _, export_body = get("/api/admin/export-game")
            exported = json.loads(export_body.decode("utf-8"))
            exported["game"]["snapshot"]["turnNumber"] = 77
            exported["game"]["snapshot"]["messages"].append("浏览器恢复测试")
            post("/api/admin/import-game", {"gameFile": exported})
            await asyncio.gather(
                page_a.wait_for_function("() => window.__doubleFlightDebug.getEngine().turnNumber === 77", timeout=5000),
                page_b.wait_for_function("() => window.__doubleFlightDebug.getEngine().turnNumber === 77", timeout=5000),
            )
            restored_a = await page_a.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
            restored_b = await page_b.evaluate("() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())")
            result["checks"]["editedSaveRestored"] = restored_a == restored_b and "浏览器恢复测试" in restored_a

            _, _, before_bad_body = get("/api/admin/status")
            before_bad = json.loads(before_bad_body.decode("utf-8"))
            bad_status = None
            try:
                post("/api/admin/import-game", {"gameFile": {"game": {"snapshot": {"bad": True}}}})
            except urllib.error.HTTPError as error:
                bad_status = error.code
            _, _, after_bad_body = get("/api/admin/status")
            after_bad = json.loads(after_bad_body.decode("utf-8"))
            result["checks"]["badSaveDoesNotReplaceGame"] = bad_status == 422 and before_bad["stateHash"] == after_bad["stateHash"]

            _, _, refresh_body = post("/api/admin/refresh-codes")
            refreshed = json.loads(refresh_body.decode("utf-8"))
            result["checks"]["codesRefresh"] = refreshed["codes"]["A"] != codes["A"] and refreshed["codes"]["B"] != codes["B"]
            await asyncio.gather(
                page_a.wait_for_function("() => !document.querySelector('#setupOverlay').classList.contains('hidden')", timeout=5000),
                page_b.wait_for_function("() => !document.querySelector('#setupOverlay').classList.contains('hidden')", timeout=5000),
            )
            result["checks"]["refreshForcesRelogin"] = (
                "会话" in await page_a.locator("#lanConnectionStatus").inner_text()
                and "会话" in await page_b.locator("#lanConnectionStatus").inner_text()
            )

            result["ok"] = all(result["checks"].values()) and not result["errors"]
            await browser.close()
    finally:
        server.terminate()
        try:
            stdout, _ = server.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill(); stdout, _ = server.communicate()
        result["serverLog"] = stdout
        temp_data.cleanup()

    out = ROOT / "tests/browser-lan-smoke.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["ok"] else 1)


asyncio.run(main())
