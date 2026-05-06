from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # Mobile screenshot of customers.html (the page user had open)
    ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    page = ctx.new_page()
    page.goto('http://localhost:8765/platform/customers.html', wait_until='networkidle')
    page.wait_for_timeout(500)
    page.screenshot(path='_mobile_customers_closed.png')
    page.click('.mobile-menu-btn')
    page.wait_for_timeout(400)
    page.screenshot(path='_mobile_customers_open.png')
    ctx.close()

    # Desktop screenshot of customers
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    page = ctx.new_page()
    page.goto('http://localhost:8765/platform/customers.html', wait_until='networkidle')
    page.wait_for_timeout(500)
    page.screenshot(path='_desktop_customers.png')
    ctx.close()

    browser.close()
    print('Screenshots saved')
