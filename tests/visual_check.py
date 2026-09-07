from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path("tests/screenshots")
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, width, height in [("desktop", 1440, 900), ("mobile", 390, 844)]:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.goto("http://127.0.0.1:4173", wait_until="networkidle")
        page.screenshot(path=str(out / f"{name}.png"), full_page=True)
        overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        title = page.locator(".title").inner_text()
        print(f"{name}: overflow={overflow} title={title!r} errors={errors}")
        assert not overflow
        assert page.locator("#inspect").is_visible()
        page.locator('[data-nav="historySection"]').first.click()
        page.wait_for_timeout(300)
        assert page.locator("#historySection").is_visible()
        page.locator('[data-nav="aiWorkbench"]').click()
        page.wait_for_timeout(300)
        assert page.locator("#aiWorkbench").is_visible()
        page.locator("#openConfigTop").click()
        page.wait_for_selector('[data-config="grok"]')
        assert page.locator('[data-config="grok"]').is_visible()
        page.locator("#closeConfig").click()
        if name == "mobile":
            assert page.locator(".side").evaluate("el => getComputedStyle(el).position") == "fixed"
        page.close()
    browser.close()
