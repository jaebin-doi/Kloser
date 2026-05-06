from playwright.sync_api import sync_playwright

pages = ['dashboard.html', 'daily.html', 'live.html', 'calls.html', 'customers.html', 'newsletter.html', 'team.html', 'settings.html']

errors_by_page = {}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    summary = []
    for pname in pages:
        ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e, l=errs: l.append(str(e)))
        try:
            page.goto(f'http://localhost:8765/platform/{pname}', wait_until='networkidle', timeout=8000)
            page.wait_for_timeout(700)
            sb = page.query_selector('#sidebar')
            sb_visible = sb.is_visible() if sb else False
            sb_width = sb.bounding_box()['width'] if sb else 0
            active = page.query_selector('.nav-item.active')
            active_text = active.inner_text().split('\n')[0].strip() if active else 'none'
            summary.append((pname, sb_visible, int(sb_width), active_text, len(errs), errs[:2]))
        except Exception as e:
            summary.append((pname, False, 0, '-', 'GOTO_ERR', [str(e)[:80]]))
        ctx.close()

    print(f'{"page":18} {"sidebar":>9} {"width":>6} {"active":>14} errors')
    print('-' * 60)
    for s in summary:
        print(f'{s[0]:18} {str(s[1]):>9} {s[2]:>6} {s[3]:>14} {s[4]}')
        if s[5]:
            for e in s[5]:
                print(f'    err: {e[:90]}')

    browser.close()
