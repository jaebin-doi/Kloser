from playwright.sync_api import sync_playwright

errors = []
warnings = []
console_msgs = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 800})

    page.on('console', lambda msg: console_msgs.append(f'[{msg.type}] {msg.text}'))
    page.on('pageerror', lambda e: errors.append(f'PAGE_ERROR: {e}'))

    page.goto('http://localhost:8765/platform/daily.html', wait_until='networkidle', timeout=10000)

    # Wait a bit for JS to settle
    page.wait_for_timeout(1500)

    # Check sidebar exists
    sidebar = page.query_selector('#sidebar')
    sidebar_visible = sidebar.is_visible() if sidebar else False

    # Check key elements
    today_label = page.query_selector('#todayDate')
    todo_list = page.query_selector('#todoList')
    trends_list = page.query_selector('#trendsList')
    dl_btn = page.query_selector('button[onclick*="toggleDownloadMenu"]')

    print(f'sidebar exists: {sidebar is not None} visible: {sidebar_visible}')
    print(f'#todayDate exists: {today_label is not None}')
    if today_label:
        print(f'  text: {today_label.inner_text()[:60]}')
    print(f'#todoList exists: {todo_list is not None}')
    if todo_list:
        items = todo_list.query_selector_all('li')
        print(f'  todo items: {len(items)}')
    print(f'#trendsList exists: {trends_list is not None}')
    if trends_list:
        rows = trends_list.query_selector_all('.trend-row')
        print(f'  trend rows: {len(rows)}')
    print(f'download button exists: {dl_btn is not None}')

    print(f'\nErrors: {len(errors)}')
    for e in errors: print(f'  {e}')
    print(f'\nConsole messages: {len(console_msgs)}')
    for m in console_msgs[:15]: print(f'  {m}')

    # Take screenshot
    page.screenshot(path='_test_daily.png')
    print('\nScreenshot saved: _test_daily.png')

    browser.close()
