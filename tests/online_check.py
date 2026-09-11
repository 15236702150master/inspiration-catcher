from pathlib import Path
from playwright.sync_api import sync_playwright

values = {}
for line in Path(".private/credentials.txt").read_text(encoding="utf-8").splitlines():
    if "=" in line:
        key, value = line.split("=", 1)
        values[key] = value

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.goto(values["URL"], wait_until="networkidle")
    page.locator("#authEmail").fill(values["Email"])
    page.locator("#authPassword").fill(values["Password"])
    page.locator("#authSubmit").click()
    page.wait_for_selector("#authScreen", state="hidden")
    created = page.evaluate("""async () => {
      const response = await fetch('/api/notes', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
        url: 'https://weixin.qq.com/sph/AbGEdGh4Y0', title: '阅读页封面测试', thumbnail: '/covers/f9f5aa55ece1537f01c32b27.jpg',
        note: '用于验证笔记详情。', transcript: '简体中文转写。', status: 'pending', tags: []
      })});
      return (await response.json()).item;
    }""")
    page.reload(wait_until="networkidle")
    assert page.locator("#toggleTagComposer").is_visible()
    page.locator("#toggleTagComposer").click()
    assert page.locator("#tagComposer").evaluate("el => el.classList.contains('is-open')")
    assert page.locator("#recommendTags").is_visible()
    assert page.locator("#transcriptPanel").is_visible()
    assert page.locator("#transcriptPanel").evaluate("el => getComputedStyle(el).backgroundColor") == "rgb(255, 255, 255)"
    capture_box = page.locator("#capture").bounding_box()
    transcript_box = page.locator("#transcriptPanel").bounding_box()
    assert transcript_box["y"] >= capture_box["y"] + capture_box["height"] - 2
    assert not page.locator("#historySection").is_visible()
    assert not page.locator("#tagManager").is_visible()
    assert not page.locator("#aiWorkbench").is_visible()
    page.locator("#openConfigTop").click()
    page.wait_for_selector('[data-config="grok"]')
    assert page.locator('[data-config="openai"] [data-profile-select]').is_visible()
    assert page.locator('[data-config="openai"] [data-field="model"] option[value="gpt-5.6-sol"]').count() == 1
    assert page.locator('[data-config="claude"] [data-field="model"] option[value="claude-sonnet-4-6"]').count() == 1
    page.locator("#closeConfig").click()
    page.locator('[data-nav="historySection"]').first.click()
    page.locator(f'[data-open-note="{created["id"]}"]').click()
    page.wait_for_selector("#noteModal:not([hidden])")
    assert page.locator("#noteModal .note-reader").evaluate("el => getComputedStyle(el).overflowY") == "auto"
    assert page.locator("#noteAnalyses").is_visible()
    assert "f9f5aa55ece1537f01c32b27.jpg" in page.locator("#noteCover").evaluate("el => el.style.backgroundImage")
    page.locator("#continueInAi").click()
    assert page.locator("#analysisHistory").is_visible()
    assert page.locator(".analysis-column").count() == 2
    assert page.locator(".analysis-divider").is_visible()
    page.locator('[data-nav][data-pending]').click()
    assert page.locator(f'[data-open-note="{created["id"]}"]').is_visible()
    page.locator('[data-nav="tagManager"]').click()
    page.wait_for_selector('#tagManager')
    assert page.locator('#tagManagerSearch').is_visible()
    page.locator('[data-nav="aiWorkbench"]').click()
    page.screenshot(path="tests/screenshots/online-desktop.png", full_page=True)
    mobile = context.new_page()
    mobile.set_viewport_size({"width": 390, "height": 844})
    mobile.goto(values["URL"], wait_until="networkidle")
    assert mobile.locator("#authScreen").is_hidden()
    assert not mobile.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    mobile.locator('[data-nav="aiWorkbench"]').click()
    assert mobile.locator("#aiWorkbench").bounding_box()["width"] > 340
    assert not mobile.locator(".analysis-divider").is_visible()
    mobile.screenshot(path="tests/screenshots/online-mobile.png", full_page=True)
    mobile.close()
    page.evaluate("id => fetch('/api/notes/' + id, {method: 'DELETE'})", created["id"])
    print(f"online: grok=True nav=True tags=True note_cover=True errors={errors}")
    assert not errors
    browser.close()
