import os
from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ["LIBRARY_CHECK_BASE"].rstrip("/")
EMAIL = os.environ["LIBRARY_CHECK_EMAIL"]
PASSWORD = os.environ["LIBRARY_CHECK_PASSWORD"]


def login(page):
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("#authEmail").wait_for()
    page.locator("#authEmail").fill(EMAIL)
    page.locator("#authPassword").fill(PASSWORD)
    page.locator("#authSubmit").click()
    page.locator("#authScreen").wait_for(state="hidden")
    page.locator('[data-nav="historySection"]:not([data-pending])').click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    desktop = browser.new_page(viewport={"width": 1440, "height": 1000})
    login(desktop)
    desktop.locator("#libraryList").wait_for()
    desktop.wait_for_function("document.querySelectorAll('#history .mini').length === 3")
    assert "待分类" in desktop.locator("#libraryList").inner_text()
    assert desktop.locator("#history .mini").count() == 3
    desktop.screenshot(path=ROOT / "tests/screenshots/library-online-desktop.png", full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    login(mobile)
    mobile.locator("#libraryFilter").wait_for()
    mobile.wait_for_function("document.querySelectorAll('#history .mini').length === 3")
    assert mobile.locator("#libraryFilter").is_visible()
    assert mobile.locator("#history .mini").count() == 3
    mobile.screenshot(path=ROOT / "tests/screenshots/library-online-mobile.png", full_page=True)
    browser.close()
