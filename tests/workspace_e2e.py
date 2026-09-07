"""Cross-browser acceptance tests for the transcript annotation workspace.

Run directly with ``python tests/workspace_e2e.py``. The suite owns a temporary
database and server; it never reads or writes the project's normal data folder.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "legacy-workspace"
SCREENSHOTS = ROOT / "tests" / "screenshots" / "workspace"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class WorkspaceE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_root = Path(tempfile.mkdtemp(prefix="inspiration-workspace-e2e-"))
        cls.data_dir = cls.temp_root / "data"
        shutil.copytree(FIXTURE, cls.data_dir)
        cls.port = free_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        env = {
            **os.environ,
            "PORT": str(cls.port),
            "DATA_DIRECTORY": str(cls.data_dir),
            "DATABASE_PATH": str(cls.temp_root / "workspace.sqlite"),
            "NODE_ENV": "test",
        }
        cls.server = subprocess.Popen(
            ["node", "server.mjs"],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        deadline = time.time() + 15
        while time.time() < deadline:
            if cls.server.poll() is not None:
                raise RuntimeError("workspace test server exited before becoming healthy")
            try:
                import urllib.request

                with urllib.request.urlopen(f"{cls.base_url}/api/health", timeout=0.2) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(0.05)
        else:
            raise RuntimeError("workspace test server did not become healthy within 15 seconds")
        SCREENSHOTS.mkdir(parents=True, exist_ok=True)
        cls.playwright = sync_playwright().start()

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "playwright"):
            cls.playwright.stop()
        if hasattr(cls, "server"):
            cls.server.terminate()
            try:
                cls.server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                cls.server.kill()
        if hasattr(cls, "temp_root"):
            shutil.rmtree(cls.temp_root, ignore_errors=True)

    def make_context(self, browser_name: str, viewport: dict[str, int]):
        try:
            browser = getattr(self.playwright, browser_name).launch(headless=True)
        except PlaywrightError as error:
            self.fail(f"{browser_name} is required by the approved test matrix: {error}")
        mobile = viewport["width"] <= 620
        context = browser.new_context(
            viewport=viewport,
            locale="zh-CN",
            is_mobile=False,
            has_touch=mobile,
        )
        if browser_name == "chromium":
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=self.base_url)
        context.set_default_timeout(5_000)
        context.set_default_navigation_timeout(15_000)
        return browser, context

    def login(self, page) -> None:
        page.goto(self.base_url, wait_until="domcontentloaded")
        expect(page.locator("#authScreen")).to_be_visible()
        page.locator("#authEmail").fill("owner-a@example.test")
        page.locator("#authPassword").fill("owner-a-password")
        page.locator("#authSubmit").click()
        expect(page.locator("#authScreen")).to_be_hidden()

    def open_fixture_workspace(self, page) -> None:
        page.locator('[data-nav="historySection"]').first.click()
        page.locator('[data-open-note="note-legacy-1"]').click()
        workspace = page.locator('[data-testid="transcript-workspace"][data-workspace-context="note"]')
        expect(workspace).to_be_visible()
        expect(workspace).to_have_attribute("data-note-id", "note-legacy-1")
        expect(workspace.locator('[data-testid="transcript-document"] [data-block-id]').first).to_be_visible()
        return workspace

    @staticmethod
    def clear_annotations(page) -> None:
        page.evaluate(
            """async () => {
              let cursor = '';
              do {
                const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
                const response = await fetch(`/api/notes/note-legacy-1/annotations?status=&limit=100${suffix}`);
                if (!response.ok) return;
                const payload = await response.json();
                for (const item of payload.items || []) {
                  await fetch(`/api/notes/note-legacy-1/annotations/${item.id}`, {
                    method: 'DELETE',
                    headers: {'content-type': 'application/json'},
                    body: JSON.stringify({baseRevision: item.revision})
                  });
                }
                cursor = payload.nextCursor || '';
              } while (cursor);
            }"""
        )

    @staticmethod
    def seed_annotations(page, count: int) -> list[str]:
        return page.evaluate(
            """async count => {
              const workspaceResponse = await fetch('/api/notes/note-legacy-1/workspace');
              const workspacePayload = await workspaceResponse.json();
              const workspace = workspacePayload.workspace || workspacePayload;
              const documentId = workspace.activeDocumentId || workspace.activeReadingDocumentId;
              const documentResponse = await fetch(`/api/notes/note-legacy-1/documents/${documentId}`);
              const documentPayload = await documentResponse.json();
              const document = documentPayload.document || documentPayload;
              const blocks = document.blocks.filter(block => block.text && block.text.length >= 6);
              const ids = [];
              const runId = crypto.randomUUID();
              for (let batchStart = 0; batchStart < count; batchStart += 20) {
                const batch = Array.from({length: Math.min(20, count - batchStart)}, (_, offset) => batchStart + offset);
                const responses = await Promise.all(batch.map(async index => {
                  const block = blocks[index % blocks.length];
                  const maxStart = Math.max(1, block.text.length - 5);
                  const start = index % maxStart;
                  const end = Math.min(block.text.length, start + 5);
                  const anchor = {
                    schema: 1,
                    blockId: block.id,
                    position: {start, end, unit: 'utf16'},
                    quote: {
                      exact: block.text.slice(start, end),
                      prefix: block.text.slice(Math.max(0, start - 32), start),
                      suffix: block.text.slice(end, end + 32)
                    },
                    normalizedQuote: block.text.slice(start, end).normalize('NFC'),
                    sourceDocumentSha256: document.sha256
                  };
                  const response = await fetch('/api/notes/note-legacy-1/annotations', {
                    method: 'POST',
                    headers: {'content-type': 'application/json', 'Idempotency-Key': `e2e-lazy-${runId}-${index}`},
                    body: JSON.stringify({
                      groupId: `e2e-lazy-group-${runId}-${index}`,
                      anchorScope: 'version_bound',
                      displayReadingDocumentId: document.id,
                      displayAnchor: anchor,
                      kind: index % 4 === 0 ? 'comment' : 'highlight',
                      color: ['key', 'action', 'evidence', 'doubt'][index % 4],
                      comment: index % 4 === 0 ? `远端批注 ${index + 1}` : ''
                    })
                  });
                  if (!response.ok) throw new Error(`annotation ${index} failed: ${response.status}`);
                  const payload = await response.json();
                  return (payload.annotation || payload.item || payload).id;
                }));
                ids.push(...responses);
              }
              return ids;
            }""",
            count,
        )

    @staticmethod
    def select_text(workspace, exact: str) -> None:
        result = workspace.locator('[data-testid="transcript-document"] [data-block-id]').evaluate_all(
            """(blocks, exact) => {
              const walkerFor = (block) => document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
              for (const block of blocks) {
                const walker = walkerFor(block);
                let node;
                while ((node = walker.nextNode())) {
                  const start = node.data.indexOf(exact);
                  if (start < 0) continue;
                  const range = document.createRange();
                  range.setStart(node, start);
                  range.setEnd(node, start + exact.length);
                  const selection = getSelection();
                  selection.removeAllRanges();
                  selection.addRange(range);
                  document.dispatchEvent(new Event('selectionchange', {bubbles: true}));
                  block.dispatchEvent(new PointerEvent('pointerup', {
                    bubbles: true,
                    pointerType: matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse'
                  }));
                  return selection.toString();
                }
              }
              return '';
            }""",
            exact,
        )
        if result != exact:
            rendered = workspace.get_by_test_id("transcript-document").inner_text()
            block_count = workspace.locator('[data-testid="transcript-document"] [data-block-id]').count()
            raise AssertionError(
                f"could not select fixture text {exact!r}; selected {result!r}; "
                f"blocks={block_count}; rendered={rendered[:500]!r}"
            )

    def test_desktop_annotation_editor_offline_and_conflict_matrix(self) -> None:
        for browser_name in ("chromium", "webkit"):
            with self.subTest(browser=browser_name):
                browser, context = self.make_context(browser_name, {"width": 1440, "height": 900})
                page = context.new_page()
                console_errors: list[str] = []
                http_errors: list[str] = []
                page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
                page.on("response", lambda response: http_errors.append(f"{response.status} {response.url}") if response.status >= 400 else None)
                self.login(page)
                self.clear_annotations(page)
                workspace = self.open_fixture_workspace(page)

                expect(workspace.get_by_test_id("workspace-mode-source")).to_have_attribute("aria-selected", "true")
                workspace.get_by_test_id("transcript-version-select").select_option(label="原始转写 v1")
                expect(workspace.locator('[data-role="document-meta"]')).to_contain_text("Whisper medium")
                expect(workspace.locator('[data-role="document-meta"]')).to_contain_text("任务 job-legacy-1")
                expect(workspace.locator('[data-role="document-meta"]')).to_contain_text("校验")
                workspace.get_by_test_id("transcript-version-select").select_option(label="AI 阅读版 v1")
                expect(workspace.locator('[data-role="document-meta"]')).to_contain_text("AI 阅读版")
                workspace.locator('[data-testid="transcript-document"] [data-block-id]').last.evaluate("node => { node.__renderIdentity = 'preserved'; }")
                self.select_text(workspace, "emoji 👩🏽‍💻")
                toolbar = workspace.get_by_test_id("selection-toolbar")
                expect(toolbar).to_be_visible()
                self.assertEqual(toolbar.get_attribute("role"), "toolbar")
                toolbar.locator('[data-action="highlight"]').click()
                toolbar.locator('[data-color="key"]').evaluate("button => button.click()")
                expect(workspace.locator(".tw-mark-key")).to_contain_text("emoji")
                self.assertEqual(workspace.locator('[data-testid="transcript-document"] [data-block-id]').last.evaluate("node => node.__renderIdentity"), "preserved")
                saved_annotation = page.evaluate("async () => (await (await fetch('/api/notes/note-legacy-1/annotations?status=&limit=100')).json()).items.find(item => item.kind === 'highlight')")
                self.assertEqual(saved_annotation["anchorScope"], "canonical")
                self.assertFalse(saved_annotation["canonicalAnchor"]["blockId"].startswith("legacy-"))

                self.select_text(workspace, "emoji 👩🏽‍💻")
                workspace.get_by_test_id("selection-toolbar").locator('[data-action="underline"]').click()
                expect(workspace.locator(".tw-underline")).to_be_visible()
                self.assertGreaterEqual(workspace.locator(".tw-mark-key").count(), 1)

                sidebar = workspace.locator(".tw-annotation-rail")
                expect(sidebar).to_be_visible()
                self.assertGreaterEqual(workspace.get_by_test_id("annotation-list").locator("[data-annotation-id]").count(), 2)
                first_item = workspace.get_by_test_id("annotation-list").locator("[data-annotation-id]").first
                first_item.click()
                target_id = first_item.get_attribute("data-annotation-id")
                expect(workspace.locator(f'[data-annotation-ids*="{target_id}"]')).to_be_in_viewport()

                workspace.get_by_test_id("workspace-mode-personal").click()
                editor = workspace.get_by_test_id("personal-editor").locator('[contenteditable="true"]')
                expect(editor).to_be_visible()
                editor.fill("我的加工稿：保留反馈回路，并写成下一步行动。")
                expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已保存", timeout=4000)
                self.assertEqual(http_errors, [], "unexpected HTTP errors before the intentional offline phase")
                self.assertEqual(console_errors, [], "unexpected console errors before the intentional offline phase")

                context.set_offline(True)
                editor.press("End")
                editor.type(" 离线补充。")
                expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("离线待同步", timeout=4000)
                self.assertEqual(workspace.get_attribute("data-offline"), "true")
                context.set_offline(False)
                expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已保存", timeout=6000)
                console_errors.clear()
                http_errors.clear()

                stale_page = context.new_page()
                stale_page.goto(self.base_url, wait_until="domcontentloaded")
                stale_workspace = self.open_fixture_workspace(stale_page)
                stale_workspace.get_by_test_id("workspace-mode-personal").click()
                stale_editor = stale_workspace.get_by_test_id("personal-editor").locator('[contenteditable="true"]')

                editor.press("End")
                editor.type(" 主标签页修改。")
                expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已保存", timeout=4000)
                stale_editor.press("End")
                stale_editor.type(" 过期标签页修改。")
                expect(stale_workspace.get_by_test_id("personal-conflict")).to_be_visible(timeout=4000)
                expect(stale_workspace.get_by_test_id("conflict-use-local")).to_be_visible()
                expect(stale_workspace.get_by_test_id("conflict-use-server")).to_be_visible()
                stale_page.close()
                persisted_text = editor.inner_text()

                workspace.locator('[data-action="personal-snapshot"]').click()
                page.wait_for_timeout(150)
                self.assertIn(workspace.get_by_test_id("personal-save-status").inner_text(), ("已保存新版本", "内容未变化，无需重复保存"))
                workspace.locator('[data-action="personal-snapshot"]').click()
                expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("内容未变化")
                workspace.locator('[data-action="personal-history"]').click()
                expect(workspace.locator(".tw-revisions article").first).to_be_visible()
                workspace.press("Escape")

                page.reload(wait_until="domcontentloaded")
                persisted = self.open_fixture_workspace(page)
                expect(persisted.locator(".tw-mark-key").first).to_be_visible()
                persisted.get_by_test_id("workspace-mode-personal").click()
                expect(persisted.get_by_test_id("personal-editor").locator('[contenteditable="true"]')).to_contain_text(persisted_text)

                page.locator("#closeNote").click()
                page.locator("#logout").click()
                expect(page.locator("#authScreen")).to_be_visible()
                page.locator("#authEmail").fill("owner-a@example.test")
                page.locator("#authPassword").fill("owner-a-password")
                page.locator("#authSubmit").click()
                expect(page.locator("#authScreen")).to_be_hidden()
                relogged = self.open_fixture_workspace(page)
                relogged.get_by_test_id("workspace-mode-personal").click()
                expect(relogged.get_by_test_id("personal-editor").locator('[contenteditable="true"]')).to_contain_text(persisted_text)

                other_context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
                other_page = other_context.new_page()
                self.login(other_page)
                other_workspace = self.open_fixture_workspace(other_page)
                expect(other_workspace.locator(".tw-mark-key").first).to_be_visible()
                other_workspace.get_by_test_id("workspace-mode-personal").click()
                expect(other_workspace.get_by_test_id("personal-editor").locator('[contenteditable="true"]')).to_contain_text(persisted_text)
                other_context.close()

                page.screenshot(path=SCREENSHOTS / f"{browser_name}-desktop.png", full_page=True)
                self.assertFalse(page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"))
                self.assertEqual(http_errors, [])
                self.assertEqual(console_errors, [])
                browser.close()

    def test_mobile_selection_toolbar_sheet_and_rotation(self) -> None:
        for browser_name in ("chromium", "webkit"):
            with self.subTest(browser=browser_name):
                browser, context = self.make_context(browser_name, {"width": 390, "height": 844})
                page = context.new_page()
                self.login(page)
                self.clear_annotations(page)
                workspace = self.open_fixture_workspace(page)

                # The fixture deliberately returns the newer cases record first. Both the
                # note detail and AI laboratory must still present video analysis first.
                note_analysis_meta = page.locator("#noteAnalyses .note-analysis-meta")
                expect(note_analysis_meta).to_have_count(2)
                expect(note_analysis_meta.nth(0)).to_contain_text("视频内容拆解")
                expect(note_analysis_meta.nth(1)).to_contain_text("类似案例研究")

                self.select_text(workspace, "emoji 👩🏽‍💻")
                toolbar = workspace.get_by_test_id("selection-toolbar-mobile")
                expect(toolbar).to_be_visible()
                toolbar.locator('[data-action="highlight"]').click()
                visible_colors = workspace.locator('[data-color]:visible')
                expect(visible_colors).to_have_count(4)
                self.assertEqual(
                    [visible_colors.nth(index).inner_text().strip() for index in range(4)],
                    ["重点", "行动", "案例/证据", "存疑"],
                )
                workspace.locator('[data-color="key"]:visible').click()
                expect(workspace.locator(".tw-mark-key")).to_contain_text("emoji")
                expect(workspace.get_by_test_id("annotation-list")).not_to_contain_text("保存中", timeout=3000)

                page.reload(wait_until="domcontentloaded")
                workspace = self.open_fixture_workspace(page)
                expect(workspace.locator(".tw-mark-key")).to_contain_text("emoji")

                self.select_text(workspace, "第一段包含")
                toolbar = workspace.get_by_test_id("selection-toolbar-mobile")
                expect(toolbar).to_be_visible()
                toolbar.locator('[data-action="underline"]').click()
                expect(workspace.locator(".tw-underline")).to_contain_text("第一段包含")

                self.select_text(workspace, "同一句会出现")
                expect(toolbar).to_be_visible()
                for button in toolbar.get_by_role("button").all():
                    box = button.bounding_box()
                    self.assertIsNotNone(box)
                    self.assertGreaterEqual(box["height"], 44)
                toolbar.locator('[data-action="highlight"]').click()
                color_sheet = workspace.locator(".tw-mobile-colors")
                expect(color_sheet).to_be_visible()
                for button in color_sheet.get_by_role("button").all():
                    box = button.bounding_box()
                    self.assertIsNotNone(box)
                    self.assertGreaterEqual(box["height"], 44)
                color_sheet.locator('[data-color="evidence"]').click()
                expect(workspace.locator(".tw-sheet")).to_be_hidden()
                expect(workspace.locator(".tw-mark-evidence").first).to_be_visible()
                self.select_text(workspace, "同一句会出现")
                expect(toolbar).to_be_visible()
                page.locator("#noteModal .note-reader").evaluate("element => { element.scrollTop += 180; element.dispatchEvent(new Event('scroll')); }")
                expect(toolbar).to_be_hidden()
                self.select_text(workspace, "同一句会出现")
                expect(toolbar).to_be_visible()
                toolbar.locator('[data-action="comment"]').click()
                sheet = workspace.locator('.tw-sheet [role="dialog"]')
                expect(sheet).to_be_visible()
                sheet.get_by_role("textbox").fill("这里是重复句，不能挂到错误位置。")
                sheet.locator('button[type="submit"]').click()
                expect(workspace.get_by_test_id("annotation-list")).to_contain_text("这里是重复句")

                self.select_text(workspace, "emoji 👩🏽‍💻")
                expect(toolbar).to_be_visible()
                toolbar.locator('[data-action="more"]').click()
                more_sheet = workspace.locator('.tw-sheet [role="dialog"]')
                expect(more_sheet).to_be_visible()
                for action_name in (
                    "复制",
                    "摘到加工稿",
                    "转为待实践",
                    "AI 解释",
                    "AI 反例",
                    "AI 补充案例",
                    "AI 行动步骤",
                ):
                    expect(more_sheet.get_by_role("button", name=action_name, exact=True)).to_be_visible()
                page.keyboard.press("Escape")

                connector_layer = workspace.locator('[data-role="annotation-connectors"]')
                expect(connector_layer).to_be_hidden()
                self.assertEqual(workspace.locator('[data-testid="annotation-connector"]:visible').count(), 0)

                page.evaluate("""() => {
                  window.__copiedNote = '';
                  Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: { writeText: text => { window.__copiedNote = text; return Promise.resolve(); } }
                  });
                }""")
                page.locator("#copyNote").click()
                copied_note = page.evaluate("window.__copiedNote")
                self.assertLess(copied_note.index("## 视频拆解"), copied_note.index("## 类似案例"))

                page.locator("#continueInAi").click()
                analysis_columns = page.locator("#analysisHistory .analysis-column")
                expect(analysis_columns).to_have_count(2)
                expect(analysis_columns.nth(0).locator(":scope > .analysis-column-head > h2")).to_have_text("视频内容拆解")
                expect(analysis_columns.nth(1).locator(":scope > .analysis-column-head > h2")).to_have_text("类似案例研究")

                for width, height, suffix in ((390, 844, "portrait"), (844, 390, "landscape"), (360, 800, "narrow")):
                    page.set_viewport_size({"width": width, "height": height})
                    page.wait_for_timeout(100)
                    self.assertFalse(page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"))
                    page.screenshot(path=SCREENSHOTS / f"{browser_name}-mobile-{suffix}.png", full_page=True)
                browser.close()

    def test_mobile_feishu_unconfigured_panel_is_readable(self) -> None:
        for browser_name in ("chromium", "webkit"):
            with self.subTest(browser=browser_name):
                browser, context = self.make_context(browser_name, {"width": 360, "height": 800})
                page = context.new_page()
                self.login(page)
                page.locator("#openFeishu").click()

                panel = page.locator("#feishuModal")
                expect(panel).to_be_visible()
                expect(panel.get_by_role("heading", name="服务器还差一步配置")).to_be_visible()
                expect(panel.locator(".feishu-state-badge")).to_have_text("服务器未配置")
                expect(panel.locator(".feishu-callback code")).to_contain_text("/api/integrations/feishu/oauth/callback")
                for variable in ("FEISHU_APP_ID", "FEISHU_APP_SECRET", "INTEGRATION_ENCRYPTION_KEY"):
                    expect(panel.locator(".feishu-env-list code", has_text=variable)).to_be_visible()

                self.assertFalse(page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"))
                self.assertFalse(panel.locator(".feishu-dialog").evaluate("element => element.scrollWidth > element.clientWidth"))
                page.screenshot(path=SCREENSHOTS / f"{browser_name}-mobile-feishu-unconfigured.png", full_page=True)
                panel.locator("#closeFeishu").click()
                expect(panel).to_be_hidden()
                browser.close()

    def test_feishu_polling_preserves_active_input_and_unsaved_draft(self) -> None:
        browser, context = self.make_context("chromium", {"width": 900, "height": 760})
        page = context.new_page()
        status = {
            "configured": True,
            "status": "connected",
            "connection": {"id": "connection-test", "status": "connected", "userName": "测试用户", "syncPolicy": "new_only"},
            "sync": {"pending": 0, "processing": 0, "failed": 0},
            "bindings": [],
        }
        page.route(
            "**/api/integrations/feishu/status",
            lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(status, ensure_ascii=False)),
        )
        page.route(
            "**/api/integrations/feishu/spaces*",
            lambda route: route.fulfill(status=200, content_type="application/json", body='{"items":[],"hasMore":false}'),
        )
        self.login(page)
        page.locator("#openFeishu").click()
        parent = page.locator("#feishuParentNode")
        expect(parent).to_be_visible()
        parent.fill("知识库里的灵感目录")
        expect(parent).to_be_focused()
        page.wait_for_timeout(5_300)
        expect(parent).to_be_focused()
        expect(parent).to_have_value("知识库里的灵感目录")

        page.locator("#feishuTitle").click()
        page.wait_for_timeout(5_300)
        expect(page.locator("#feishuParentNode")).to_have_value("知识库里的灵感目录")
        browser.close()

    def test_large_annotation_directory_is_lazy_and_remote_items_still_jump(self) -> None:
        for browser_name in ("chromium", "webkit"):
            with self.subTest(browser=browser_name):
                browser, context = self.make_context(browser_name, {"width": 1440, "height": 900})
                page = context.new_page()
                self.login(page)
                self.clear_annotations(page)
                annotation_ids = self.seed_annotations(page, 220)
                self.assertEqual(len(annotation_ids), 220)
                workspace = self.open_fixture_workspace(page)
                annotation_list = workspace.get_by_test_id("annotation-list")
                expect(annotation_list).to_have_attribute("data-total-count", "220")

                rendered = int(annotation_list.get_attribute("data-rendered-count"))
                cards = annotation_list.locator("[data-annotation-id]").count()
                self.assertLess(rendered, 100, "initial annotation window is too large")
                self.assertEqual(cards, rendered)
                self.assertLess(cards, 220 // 2, "lazy directory rendered too many cards")

                first_card = annotation_list.locator("[data-annotation-id]").first
                first_id = first_card.get_attribute("data-annotation-id")
                first_card.locator(".tw-annotation-main").click()
                first_connector = workspace.locator(
                    f'[data-testid="annotation-connector"][data-annotation-id="{first_id}"].is-active'
                )
                expect(first_connector).to_be_visible()
                expect(workspace.locator(f'[data-annotation-ids*="{first_id}"]').first).to_be_in_viewport()

                far_id = sorted(annotation_ids)[-1]
                far_card = annotation_list.locator(f'[data-annotation-id="{far_id}"]')
                sentinel = workspace.locator('[data-role="annotation-sentinel"]')
                for _ in range(10):
                    if far_card.count() and far_card.is_visible():
                        break
                    before_count = annotation_list.get_attribute("data-rendered-count")
                    workspace.locator('[data-role="annotation-sentinel"]').evaluate("button => button.click()")
                    expect(annotation_list).not_to_have_attribute("data-rendered-count", before_count)
                expect(far_card).to_be_visible()
                far_card.locator(".tw-annotation-main").click()
                far_connector = workspace.locator(
                    f'[data-testid="annotation-connector"][data-annotation-id="{far_id}"].is-active'
                )
                expect(far_connector).to_be_visible()
                far_marks = workspace.locator(f'[data-annotation-ids*="{far_id}"]')
                deadline = time.time() + 5
                any_mark_in_viewport = False
                while time.time() < deadline:
                    any_mark_in_viewport = far_marks.evaluate_all(
                        """nodes => nodes.some(node => {
                          const rect = node.getBoundingClientRect();
                          return rect.bottom > 0 && rect.right > 0
                            && rect.top < innerHeight && rect.left < innerWidth;
                        })"""
                    )
                    if any_mark_in_viewport:
                        break
                    page.wait_for_timeout(100)
                self.assertTrue(any_mark_in_viewport, "clicked remote annotation did not reveal any matching source mark")
                self.assertFalse(page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"))
                if browser_name == "chromium":
                    page.screenshot(path=SCREENSHOTS / "chromium-source-connectors.png", full_page=True)
                browser.close()

    def test_large_annotation_catalog_loads_incrementally(self) -> None:
        browser, context = self.make_context("chromium", {"width": 1440, "height": 900})
        page = context.new_page()
        self.login(page)
        self.clear_annotations(page)
        workspace = self.open_fixture_workspace(page)
        self.select_text(workspace, "emoji 👩🏽‍💻")
        workspace.get_by_test_id("selection-toolbar").locator('[data-action="highlight"]').click()
        workspace.get_by_test_id("selection-toolbar").locator('[data-color="key"]').click()
        expect(workspace.get_by_test_id("annotation-list").locator("[data-annotation-id]").first).to_be_visible()
        expect(workspace.get_by_test_id("annotation-list")).not_to_contain_text("保存中")
        created = page.evaluate(
            """async () => {
              const listed = await (await fetch('/api/notes/note-legacy-1/annotations?status=&limit=100')).json();
              const source = listed.items[0];
              const inputs = Array.from({length: 219}, (_, index) => ({
                kind: 'comment', color: '', comment: `分页批注 ${index + 1}`,
                anchorScope: 'canonical', sourceTranscriptVersionId: source.sourceTranscriptVersionId,
                canonicalAnchor: source.canonicalAnchor, groupId: `page-group-${index}`
              }));
              let completed = 0;
              for (let start = 0; start < inputs.length; start += 25) {
                const batch = inputs.slice(start, start + 25);
                const responses = await Promise.all(batch.map((body, offset) => fetch('/api/notes/note-legacy-1/annotations', {
                  method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': `page-${start + offset}`}, body: JSON.stringify(body)
                })));
                completed += responses.filter(response => response.ok).length;
              }
              return completed;
            }"""
        )
        self.assertEqual(created, 219)
        page.locator("#closeNote").click()
        workspace = self.open_fixture_workspace(page)
        expect(workspace.locator('[data-role="annotation-count"]')).to_have_text("220", timeout=10000)
        annotation_list = workspace.get_by_test_id("annotation-list")
        expect(annotation_list).to_have_attribute("data-total-count", "220")
        expect(annotation_list).to_have_attribute("data-rendered-count", "36")
        expect(annotation_list.locator("[data-annotation-id]")).to_have_count(36)
        sentinel = workspace.locator('[data-role="annotation-sentinel"]')
        expect(sentinel).to_be_visible()
        sentinel.evaluate("button => button.click()")
        expect(annotation_list).to_have_attribute("data-rendered-count", "64")
        expect(annotation_list.locator("[data-annotation-id]")).to_have_count(64)
        self.assertLess(annotation_list.locator("[data-annotation-id]").count(), 220)
        self.assertFalse(page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"))
        browser.close()

    def test_keyboard_shortcuts_and_ai_failure_details(self) -> None:
        browser, context = self.make_context("chromium", {"width": 1440, "height": 900})
        page = context.new_page()
        self.login(page)
        self.clear_annotations(page)
        workspace = self.open_fixture_workspace(page)

        self.select_text(workspace, "emoji 👩🏽‍💻")
        page.keyboard.press("Control+Shift+H")
        expect(workspace.locator(".tw-mark-key")).to_contain_text("emoji")
        expect(workspace.get_by_test_id("annotation-list")).not_to_contain_text("保存中")
        page.keyboard.press("Control+z")
        expect(workspace.locator(".tw-mark-key")).to_have_count(0)
        page.keyboard.press("Control+Shift+z")
        expect(workspace.locator(".tw-mark-key")).to_contain_text("emoji")

        page.route(
            "**/api/notes/note-legacy-1/selection-ai",
            lambda route: route.fulfill(
                status=503,
                content_type="application/json",
                body=json.dumps({"error": {"code": "PROVIDER_503", "message": "上游暂不可用", "details": "fixture-upstream"}}),
            ),
        )
        self.select_text(workspace, "同一句会出现")
        toolbar = workspace.get_by_test_id("selection-toolbar")
        toolbar.locator('[data-action="more"]').evaluate("button => button.click()")
        expect(toolbar.locator(".tw-more-menu")).to_be_visible()
        toolbar.locator('[data-ai="explain"]').click()
        error = workspace.locator(".tw-ai-error")
        expect(error).to_contain_text("HTTP 503")
        expect(error).to_contain_text("PROVIDER_503")
        expect(error).to_contain_text("fixture-upstream")
        expect(error.locator("[data-retry-ai]")).to_be_visible()
        browser.close()

    def test_five_minute_edit_session_creates_a_deduplicated_snapshot(self) -> None:
        browser, context = self.make_context("chromium", {"width": 1440, "height": 900})
        page = context.new_page()
        self.login(page)
        workspace = self.open_fixture_workspace(page)
        workspace.get_by_test_id("workspace-mode-personal").click()
        editor = workspace.get_by_test_id("personal-editor").locator('[contenteditable="true"]')
        editor.press("End")
        editor.type(" 计时快照起点。")
        expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已保存", timeout=4000)
        before_count = page.evaluate("async () => (await (await fetch('/api/notes/note-legacy-1/personal-document/revisions')).json()).items.length")
        page.evaluate("window.__realDateNow = Date.now; Date.now = () => window.__realDateNow() + 301000")
        editor.press("End")
        editor.type(" 五分钟后继续编辑。")
        expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已保存", timeout=4000)
        after_count = page.evaluate("async () => (await (await fetch('/api/notes/note-legacy-1/personal-document/revisions')).json()).items.length")
        page.evaluate("Date.now = window.__realDateNow; delete window.__realDateNow")
        self.assertEqual(after_count, min(20, before_count + 1))
        browser.close()

    def test_failed_reformat_preserves_versions_annotations_and_personal_draft(self) -> None:
        browser, context = self.make_context("chromium", {"width": 1440, "height": 900})
        page = context.new_page()
        self.login(page)
        page.locator('[data-nav="historySection"]').first.click()
        page.locator('[data-open-note="note-legacy-1"]').click()
        page.locator("#continueInAi").click()
        quick = page.locator('[data-testid="transcript-workspace"][data-workspace-context="quick"]')
        expect(quick).to_have_attribute("data-note-id", "note-legacy-1")
        expect(quick.get_by_test_id("transcript-document")).to_contain_text("第一段包含")
        before = page.evaluate(
            """async () => {
              const workspace = (await (await fetch('/api/notes/note-legacy-1/workspace')).json()).workspace;
              const personal = (await (await fetch('/api/notes/note-legacy-1/personal-document')).json()).document;
              return {
                transcriptIds: workspace.transcriptVersions.map(item => item.id),
                documentIds: workspace.readingDocuments.map(item => item.id),
                activeTranscriptId: workspace.activeTranscriptId,
                activeDocumentId: workspace.activeDocumentId,
                annotations: workspace.annotationCounts,
                personalRevision: personal.revision,
                personalText: personal.plainText
              };
            }"""
        )
        page.route(
            "**/api/transcripts/format",
            lambda route: route.fulfill(
                status=503,
                content_type="application/json",
                body=json.dumps({"error": {"code": "PROVIDER_503", "message": "排版服务暂不可用", "details": "format-fixture"}}),
            ),
        )
        page.locator("#retryFormat").evaluate("button => button.click()")
        expect(page.locator("#transcriptState")).to_contain_text("排版失败 · HTTP 503 · PROVIDER_503")
        self.assertFalse(page.locator("#retryFormat").evaluate("button => button.hidden"))
        expect(quick.get_by_test_id("transcript-document")).to_contain_text("第一段包含")
        after = page.evaluate(
            """async () => {
              const workspace = (await (await fetch('/api/notes/note-legacy-1/workspace')).json()).workspace;
              const personal = (await (await fetch('/api/notes/note-legacy-1/personal-document')).json()).document;
              return {
                transcriptIds: workspace.transcriptVersions.map(item => item.id),
                documentIds: workspace.readingDocuments.map(item => item.id),
                activeTranscriptId: workspace.activeTranscriptId,
                activeDocumentId: workspace.activeDocumentId,
                annotations: workspace.annotationCounts,
                personalRevision: personal.revision,
                personalText: personal.plainText
              };
            }"""
        )
        self.assertEqual(after, before)
        browser.close()

    def test_optimistic_annotation_feedback_stays_under_one_hundred_ms(self) -> None:
        browser, context = self.make_context("chromium", {"width": 1440, "height": 900})
        page = context.new_page()
        self.login(page)
        self.clear_annotations(page)
        workspace = self.open_fixture_workspace(page)
        page.evaluate(
            """() => {
              window.__nativeFetch = window.fetch;
              window.fetch = async (...args) => {
                const [url, options = {}] = args;
                if (String(url).includes('/annotations') && options.method === 'POST') {
                  await new Promise(resolve => setTimeout(resolve, 350));
                }
                return window.__nativeFetch(...args);
              };
            }"""
        )
        self.select_text(workspace, "emoji 👩🏽‍💻")
        toolbar = workspace.get_by_test_id("selection-toolbar")
        toolbar.locator('[data-action="highlight"]').click()
        page.evaluate("window.__annotationStartedAt = performance.now()")
        toolbar.locator('[data-color="key"]').click()
        expect(workspace.locator(".tw-mark-key")).to_be_visible()
        feedback_ms = page.evaluate("performance.now() - window.__annotationStartedAt")
        self.assertLess(feedback_ms, 100)
        expect(workspace.get_by_test_id("annotation-list")).not_to_contain_text("保存中", timeout=3000)
        page.evaluate("window.fetch = window.__nativeFetch; delete window.__nativeFetch")
        browser.close()

    def test_exports_are_distinct_and_xss_free(self) -> None:
        browser, context = self.make_context("chromium", {"width": 1440, "height": 900})
        page = context.new_page()
        self.login(page)
        workspace = self.open_fixture_workspace(page)
        page.evaluate(
            """() => {
              window.__workspaceCopied = [];
              Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {writeText: async text => { window.__workspaceCopied.push(String(text)); }}
              });
            }"""
        )
        downloads: dict[str, str] = {}
        for index, mode in enumerate(("raw", "annotated", "personal"), start=1):
            workspace.locator('[data-action="toggle-export"]').click()
            workspace.get_by_test_id(f"export-{mode}").click()
            expect(workspace.get_by_test_id("personal-save-status")).to_contain_text("已复制")
            page.wait_for_function("count => window.__workspaceCopied.length === count", arg=index)
            content = page.evaluate("window.__workspaceCopied.at(-1)")
            downloads[mode] = content
            self.assertNotIn("<script", content.lower())
            self.assertNotIn("javascript:", content.lower())
            self.assertNotIn("onerror=", content.lower())
        self.assertIn("第一段包含", downloads["raw"])
        self.assertIn("来源", downloads["annotated"])
        self.assertNotEqual(downloads["raw"], downloads["annotated"])
        browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
