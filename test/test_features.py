import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    for pname in ['dashboard.html', 'live.html', 'daily.html']:
        ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e, l=errs: l.append(str(e)))
        page.goto(f'http://localhost:8765/platform/{pname}', wait_until='networkidle', timeout=8000)
        page.wait_for_timeout(800)

        notif = page.query_selector('#notifBtn')
        if notif:
            panel = page.query_selector('#notifBtnPanel')
            print(f'{pname:18} notif_btn=True panel_exists={panel is not None} errs={len(errs)}')
            # Click to open
            notif.click()
            page.wait_for_timeout(300)
            opened = panel and panel.is_visible() if panel else False
            print(f'  panel after click: visible={opened}')
            if opened:
                items = panel.query_selector_all('.notif-item')
                print(f'  items: {len(items)}')
            page.screenshot(path=f'_notif_{pname.replace(".html","")}.png')
        else:
            print(f'{pname:18} no notif button (expected: only on dashboard/live)')
        for e in errs: print(f'    err: {e[:120]}')
        ctx.close()

    # daily.html — check Word export button exists
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e, l=errs: l.append(str(e)))
    page.goto('http://localhost:8765/platform/daily.html', wait_until='networkidle', timeout=8000)
    page.wait_for_timeout(800)
    word_btn = page.query_selector('button[onclick*="dlWord"]')
    print(f'\ndaily.html word_btn exists: {word_btn is not None}, errs={len(errs)}')
    for e in errs: print(f'  err: {e[:120]}')
    ctx.close()

    browser.close()
