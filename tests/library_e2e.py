from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:4199"


def login(page):
    page.goto(BASE, wait_until="networkidle")
    page.locator("#authEmail").fill("owner-a@example.test")
    page.locator("#authPassword").fill("owner-a-password")
    page.locator("#authSubmit").click()
    page.locator("#authScreen").wait_for(state="hidden")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    failed_responses = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("response", lambda response: failed_responses.append((response.status, response.request.method, response.url, response.text())) if response.status >= 400 else None)
    login(page)

    page.locator('[data-nav="historySection"]:not([data-pending])').click()
    page.locator("#newLibraryName").fill("产品观察")
    page.locator("#createLibrary").click()
    page.locator("#captureLibrarySelect option", has_text="产品观察").wait_for(state="attached")

    page.locator('[data-nav="capture"]').click()
    page.locator("#toggleLibraryComposer").click()
    page.locator("#captureLibrarySelect").select_option(label="产品观察")
    page.locator("#toggleNoteComposer").click()
    page.locator("#note").fill("验证保存时选择灵感库，并在后续移动归档。")
    page.locator("#save").click()
    page.get_by_text("已保存到我的灵感", exact=False).wait_for()

    page.locator('[data-nav="historySection"]:not([data-pending])').click()
    card = page.locator("#history .mini").filter(has_text="验证保存时选择灵感库").first
    card.wait_for()
    assert "产品观察" in card.inner_text()
    page.screenshot(path=ROOT / "tests/screenshots/library-desktop.png", full_page=True)

    card.click()
    page.locator("#noteLibrarySelect").select_option(label="待分类")
    page.locator("#moveNoteLibrary").click()
    page.wait_for_function("document.querySelector('#noteLibrarySelect').value.startsWith('library-default-')")
    assert page.locator("#noteLibrarySelect").input_value().startswith("library-default-")
    page.locator("#closeNote").click()

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    login(mobile)
    mobile.locator('[data-nav="historySection"]:not([data-pending])').click()
    mobile.locator("#libraryFilter").wait_for()
    mobile.screenshot(path=ROOT / "tests/screenshots/library-mobile.png", full_page=True)
    assert mobile.locator("#libraryFilter").is_visible()
    assert mobile.locator("#libraryList").is_visible()
    assert not failed_responses, failed_responses
    assert not errors, errors
    browser.close()
