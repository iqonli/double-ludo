import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


def build_inline_html():
    html = (ROOT / 'public/game.html').read_text(encoding='utf-8')
    css = (ROOT / 'public/styles.css').read_text(encoding='utf-8')
    html = html.replace('<link rel="stylesheet" href="styles.css">', f'<style>{css}</style>')
    scripts = [
        ('../shared/engine.js', ROOT / 'shared/engine.js'),
        ('../shared/action-protocol.js', ROOT / 'shared/action-protocol.js'),
        ('ai-model-normal.js', ROOT / 'public/ai-model-normal.js'),
        ('ai-model-advanced.js', ROOT / 'public/ai-model-advanced.js'),
        ('ai-controller.js', ROOT / 'public/ai-controller.js'),
        ('network-client.js', ROOT / 'public/network-client.js'),
        ('game.js', ROOT / 'public/game.js'),
    ]
    for name, file_path in scripts:
        html = html.replace(f'<script src="{name}"></script>', '<script>' + file_path.read_text(encoding='utf-8') + '</script>')
    return html


async def main():
    result = {'ok': False, 'checks': {}, 'errors': []}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 390, 'height': 780})
        page.on('pageerror', lambda e: result['errors'].append(str(e)))
        await page.set_content(build_inline_html(), wait_until='load')

        result['checks']['localIsDefault'] = await page.locator('[data-runtime-mode="local"]').evaluate('e => e.classList.contains("active")')
        result['checks']['setupScrollable'] = (await page.locator('.setup-card').evaluate('e => getComputedStyle(e).overflowY')) in ('auto', 'scroll')
        result['checks']['localAiVisible'] = await page.locator('#aiSetupSection').is_visible()

        await page.check('#setupAiAEnabled')
        result['checks']['advancedModelAvailable'] = await page.locator('#setupAiAModel option[value="advanced-v1"]').count() == 1
        await page.select_option('#setupAiAModel', 'advanced-v1')
        await page.click('[data-color="red"]')
        await page.click('[data-color="yellow"]')
        await page.click('#startGame')
        await page.wait_for_function("() => document.querySelector('#setupOverlay').classList.contains('hidden')")
        result['checks']['localStarted'] = True
        result['checks']['aiAControlButton'] = await page.locator('[data-ai-toggle-player="A"]').inner_text() == '夺回控制权'
        result['checks']['advancedModelSelected'] = '高级' in await page.locator('.player-card').first.inner_text()

        initial_log = int(await page.locator('#logCount').inner_text())
        await page.wait_for_timeout(5000)
        later_log = int(await page.locator('#logCount').inner_text())
        result['checks']['localAiActed'] = later_log > initial_log

        before = await page.evaluate('() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())')
        await page.click('#newGame')
        result['checks']['backToOriginalVisible'] = await page.locator('#backToGame').is_visible()
        await page.click('#backToGame')
        after = await page.evaluate('() => JSON.stringify(window.__doubleFlightDebug.getEngine().serialize())')
        result['checks']['returnOriginalExact'] = before == after

        await page.click('#newGame')
        await page.click('[data-mode="speed"]')
        result['checks']['speedAiHidden'] = not await page.locator('#aiSetupSection').is_visible()
        await page.click('#backToGame')
        result['checks']['classicRestored'] = await page.locator('[data-ai-toggle-player]').count() == 2

        result['checks']['ruleEngineAvailable'] = await page.evaluate('() => Boolean(window.DoubleFlight && window.DoubleFlight.DoubleFlightEngine)')
        result['ok'] = all(result['checks'].values()) and not result['errors']
        await browser.close()

    out = ROOT / 'tests/browser-local-smoke.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ok'] else 1)


asyncio.run(main())
