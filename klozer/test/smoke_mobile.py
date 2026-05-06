import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from playwright.sync_api import sync_playwright

pages = ['dashboard.html', 'daily.html', 'live.html', 'calls.html', 'customers.html', 'newsletter.html', 'team.html', 'settings.html']

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    print('═══ MOBILE 390x844 ═══')
    for pname in pages:
        ctx = browser.new_context(viewport={'width': 390, 'height': 844})
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e, l=errs: l.append(str(e)))
        try:
            page.goto(f'http://localhost:8765/platform/{pname}', wait_until='networkidle', timeout=8000)
            page.wait_for_timeout(500)
            sb = page.query_selector('#sidebar')
            sb_visible = sb.is_visible() if sb else False
            mobile_btn = page.query_selector('.mobile-menu-btn')
            mobile_btn_visible = mobile_btn.is_visible() if mobile_btn else False
            # Click mobile menu and check sidebar opens
            if mobile_btn_visible:
                mobile_btn.click()
                page.wait_for_timeout(300)
                sb_after = sb.is_visible() if sb else False
                # Get sidebar transform
                box = sb.bounding_box() if sb else None
            else:
                sb_after = sb_visible
                box = None
            print(f'{pname:18} sb_default={sb_visible} mobile_btn={mobile_btn_visible} sb_after_click={sb_after} errs={len(errs)}')
            if errs:
                for e in errs[:2]:
                    print(f'    {e[:100]}')
        except Exception as e:
            print(f'{pname:18} GOTO_ERR: {e}')
        ctx.close()

    browser.close()
