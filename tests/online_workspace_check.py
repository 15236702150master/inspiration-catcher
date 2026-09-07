from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def credentials():
    values = {}
    for line in (ROOT / ".private" / "credentials.txt").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def select_text(workspace, exact):
    selected = workspace.locator('[data-testid="transcript-document"] [data-block-id]').evaluate_all(
        """(blocks, exact) => {
          for (const block of blocks) {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const start = node.data.indexOf(exact);
              if (start < 0) continue;
              const range = document.createRange();
              range.setStart(node, start); range.setEnd(node, start + exact.length);
              const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
              document.dispatchEvent(new Event('selectionchange', {bubbles: true}));
              block.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerType: 'mouse'}));
              return selection.toString();
            }
          }
          return '';
        }""",
        exact,
    )
    assert selected == exact


def main():
    auth = credentials()
    note_id = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = context.new_page()
        page.set_default_navigation_timeout(60_000)
        console_errors = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        try:
            try:
                page.goto(auth["URL"], wait_until="domcontentloaded")
            except Exception:
                page.goto(auth["URL"], wait_until="domcontentloaded")
            page.locator("#authEmail").fill(auth["Email"])
            page.locator("#authPassword").fill(auth["Password"])
            page.locator("#authSubmit").click()
            expect(page.locator("#authScreen")).to_be_hidden()
            nonce = uuid4().hex[:10]
            created = page.evaluate(
                r"""async ({nonce}) => {
                  const response = await fetch('/api/notes', {
                    method: 'POST', headers: {'content-type': 'application/json'},
                    body: JSON.stringify({
                      url: `https://example.test/workspace-${nonce}`,
                      title: `线上标注验收 ${nonce}`,
                      thumbnail: '/covers/54398e5746068d4fee7a9a88.jpg',
                      note: '临时验收记录，完成后自动删除。',
                      transcript: '第一段用于线上标注。\n\n这句话需要长期保留并加工。\n\n最后一段用于确认段落刷新。',
                      formattedTranscript: '# 线上阅读版\n\n第一段用于线上标注。\n\n这句话需要长期保留并加工。\n\n最后一段用于确认段落刷新。',
                      status: 'captured', tags: []
                    })
                  });
                  if (!response.ok) throw new Error(await response.text());
                  return (await response.json()).item;
                }""",
                {"nonce": nonce},
            )
            note_id = created["id"]
            page.reload(wait_until="domcontentloaded")
            page.locator('[data-nav="historySection"]').first.click()
            page.locator(f'[data-open-note="{note_id}"]').click()
            workspace = page.locator('[data-testid="transcript-workspace"][data-workspace-context="note"]')
            expect(workspace).to_have_attribute("data-note-id", note_id)
            expect(workspace.get_by_test_id("transcript-version-select")).to_have_value(created["activeReadingDocumentId"])
            expect(workspace.get_by_test_id("transcript-document")).to_contain_text("这句话需要长期保留并加工")

            select_text(workspace, "这句话需要长期保留并加工")
            toolbar = workspace.get_by_test_id("selection-toolbar")
            toolbar.locator('[data-action="highlight"]').click()
            toolbar.locator('[data-color="action"]').evaluate("button => button.click()")
            expect(workspace.locator(".tw-mark-action")).to_be_visible()
            expect(workspace.get_by_test_id("annotation-list")).not_to_contain_text("保存中")

            workspace.get_by_test_id("transcript-version-select").select_option(label="原始转写 v1")
            expect(workspace.locator('[data-role="document-meta"]')).to_contain_text("Whisper medium")
            expect(workspace.locator('[data-role="document-meta"]')).to_contain_text("校验")
            expect(workspace.locator(".tw-mark-action")).to_be_visible()

            workspace.get_by_test_id("workspace-mode-personal").click()
            editor = workspace.get_by_test_id("personal-editor").locator('[contenteditable="true"]')
            editor.fill("这是线上加工稿验收内容。")
            expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已保存", timeout=5000)
            workspace.locator('[data-action="personal-snapshot"]').click()
            expect(workspace.get_by_test_id("personal-save-status")).to_have_attribute("data-state", "saved")

            page.set_viewport_size({"width": 390, "height": 844})
            assert not page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
            assert page.locator("#noteModal .note-reader").bounding_box()["width"] <= 390
            page.screenshot(path=ROOT / "tests" / "screenshots" / "online-workspace-v2-mobile.png", full_page=True)

            mobile_context = browser.new_context(
                storage_state=context.storage_state(),
                viewport={"width": 390, "height": 844},
                locale="zh-CN",
                is_mobile=False,
                has_touch=True,
            )
            mobile_page = mobile_context.new_page()
            mobile_page.goto(auth["URL"], wait_until="domcontentloaded")
            mobile_page.locator('[data-nav="historySection"]').first.click()
            mobile_page.locator(f'[data-open-note="{note_id}"]').click()
            mobile_workspace = mobile_page.locator('[data-testid="transcript-workspace"][data-workspace-context="note"]')
            expect(mobile_workspace).to_have_attribute("data-note-id", note_id)
            expect(mobile_workspace.get_by_test_id("transcript-document")).to_contain_text("最后一段用于确认段落刷新")
            select_text(mobile_workspace, "最后一段用于确认段落刷新")
            mobile_toolbar = mobile_workspace.get_by_test_id("selection-toolbar-mobile")
            expect(mobile_toolbar).to_be_visible()
            mobile_toolbar.locator('[data-action="highlight"]').click()
            mobile_colors = mobile_workspace.locator('.tw-mobile-colors [data-color]')
            expect(mobile_colors).to_have_count(4)
            mobile_workspace.locator('.tw-mobile-colors [data-color="doubt"]').click()
            expect(mobile_workspace.locator(".tw-mark-doubt")).to_contain_text("最后一段")
            expect(mobile_workspace.get_by_test_id("annotation-list")).not_to_contain_text("保存中", timeout=5000)
            mobile_context.close()

            page.set_viewport_size({"width": 1440, "height": 900})
            page.reload(wait_until="domcontentloaded")
            page.locator('[data-nav="historySection"]').first.click()
            page.locator(f'[data-open-note="{note_id}"]').click()
            workspace = page.locator('[data-testid="transcript-workspace"][data-workspace-context="note"]')
            expect(workspace.locator(".tw-mark-action")).to_be_visible()
            expect(workspace.locator(".tw-mark-doubt")).to_be_visible()
            workspace.get_by_test_id("workspace-mode-personal").click()
            expect(workspace.get_by_test_id("personal-editor").locator('[contenteditable="true"]')).to_contain_text("线上加工稿验收内容", timeout=15000)
            assert console_errors == []
            print(f"online-workspace-v2: note={note_id} annotation=True mobile_highlight=True personal=True mobile=True console_errors=0")
        finally:
            if note_id:
                try:
                    page.evaluate("id => fetch('/api/notes/' + id, {method: 'DELETE'})", note_id)
                except Exception:
                    pass
            browser.close()


if __name__ == "__main__":
    main()
