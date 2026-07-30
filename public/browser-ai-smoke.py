import asyncio, json, subprocess, time
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    server=subprocess.Popen(['python','-m','http.server','8765','--bind','127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    result={'ok':False,'checks':{},'errors':[]}
    try:
      await asyncio.sleep(.5)
      async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1280,'height':800})
        page.on('pageerror',lambda e: result['errors'].append(str(e)))
        
        html=Path('game.html').read_text(encoding='utf-8')
        html=html.replace('<link rel="stylesheet" href="styles.css">', '<style>'+Path('styles.css').read_text(encoding='utf-8')+'</style>')
        scripts = [
            ('../shared/engine.js', Path('../shared/engine.js')),
            ('../shared/action-protocol.js', Path('../shared/action-protocol.js')),
            ('ai-model-normal.js', Path('ai-model-normal.js')),
            ('ai-model-advanced.js', Path('ai-model-advanced.js')),
            ('ai-controller.js', Path('ai-controller.js')),
            ('network-client.js', Path('network-client.js')),
            ('game.js', Path('game.js')),
        ]
        for src, file_path in scripts:
            html=html.replace(f'<script src="{src}"></script>', '<script>'+file_path.read_text(encoding='utf-8')+'</script>')
        await page.set_content(html, wait_until='load')
        result['checks']['onlyGameHtml']=not Path('index.html').exists()
        result['checks']['setupAiVisible']=await page.locator('#aiSetupSection').is_visible()
        await page.check('#setupAiAEnabled')
        await page.click('[data-color="red"]')
        await page.click('[data-color="yellow"]')
        await page.click('#startGame')
        await page.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')")
        result['checks']['aiAControlButton']=await page.locator('[data-ai-toggle-player="A"]').inner_text() == '夺回控制权'
        initial_log=int(await page.locator('#logCount').inner_text())
        await page.wait_for_timeout(5000)
        later_log=int(await page.locator('#logCount').inner_text())
        result['checks']['aiActed']=later_log>initial_log
        result['checks']['operatorMentionsAi']='人机（正常）' in await page.locator('#currentOperator').inner_text() or later_log>initial_log

        # Reclaim A, then switch B to AI through modal.
        await page.click('[data-ai-toggle-player="A"]')
        result['checks']['reclaimA']=await page.locator('[data-ai-toggle-player="A"]').inner_text() == '切换为人机'
        await page.click('[data-ai-toggle-player="B"]')
        result['checks']['runtimeModal']=await page.locator('#aiControlModal').is_visible()
        await page.click('#confirmAiControl')
        result['checks']['switchB']=await page.locator('[data-ai-toggle-player="B"]').inner_text() == '夺回控制权'

        old_turn=await page.locator('#turnLabel').inner_text()
        await page.click('#newGame')
        result['checks']['setupScrollable']=(await page.locator('.setup-card').evaluate("e=>getComputedStyle(e).overflowY")) in ('auto','scroll')
        result['checks']['backVisible']=await page.locator('#backToGame').is_visible()
        await page.click('#backToGame')
        result['checks']['returnOriginal']=await page.locator('#turnLabel').inner_text()==old_turn

        # Setup again and verify speed mode hides AI controls and runtime buttons.
        await page.click('#newGame')
        await page.click('[data-mode="speed"]')
        result['checks']['speedAiHidden']=not await page.locator('#aiSetupSection').is_visible()
        # Return original classic game then verify buttons still exist there.
        await page.click('#backToGame')
        result['checks']['classicAiButtonsRestored']=await page.locator('[data-ai-toggle-player]').count()==2
        result['ok']=all(result['checks'].values()) and not result['errors']
        await browser.close()
    finally:
      server.terminate(); server.wait(timeout=5)
    Path('browser-ai-smoke.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['ok'] else 1)

asyncio.run(main())
