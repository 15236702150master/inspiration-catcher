import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../lib/db.mjs";
import {
  FEISHU_SCOPES,
  FeishuIntegration,
  buildFeishuProjection,
  createSecretBox,
  extractProjectionClues,
  markdownBlocks,
  projectionBlocks,
} from "../lib/feishu-integration.mjs";
import { buildAnchor, buildBlocks, sha256Text } from "../lib/transcript-workspace.mjs";

const fixtureDir = resolve(import.meta.dirname, "fixtures/legacy-workspace");
const fixedNow = Date.parse("2026-07-27T02:00:00.000Z");

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function databaseFixture(t, { legacy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inspiration-feishu-integration-"));
  const dataDirectory = join(root, "data");
  if (legacy) await cp(fixtureDir, dataDirectory, { recursive: true });
  const db = openDatabase({
    databasePath: join(root, "workspace.sqlite"),
    dataDirectory: legacy ? dataDirectory : undefined,
    migrateLegacy: legacy,
  });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return db;
}

function insertInspiration(db, id, ownerId) {
  const at = new Date(fixedNow).toISOString();
  db.prepare(`INSERT INTO inspirations
    (id,owner_id,title,url,quick_thought,status,transcription_status,created_at,updated_at)
    VALUES (?,?,?,?,?,'captured','completed',?,?)`).run(
    id,
    ownerId,
    `灵感 ${id}`,
    `https://example.test/${id}`,
    `感想 ${id}`,
    at,
    at,
  );
}

function integrationOptions(overrides = {}) {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(png.buffer).setUint32(16, 540);
  new DataView(png.buffer).setUint32(20, 720);
  return {
    appId: "cli-test-app",
    appSecret: "test-app-secret",
    encryptionKey: "test-encryption-key-with-enough-entropy",
    publicBaseUrl: "https://inspiration.example.test",
    accountsBaseUrl: "https://accounts.feishu.test",
    apiBaseUrl: "https://open.feishu.test/open-apis",
    assetFetchImpl: async () => new Response(png, { headers: { "content-type": "image/png" } }),
    now: () => fixedNow,
    ...overrides,
  };
}

function tokenPayload(code = "owner-a") {
  return {
    access_token: `access-token-${code}`,
    refresh_token: `refresh-token-${code}`,
    expires_in: 7200,
    refresh_token_expires_in: 2_592_000,
    scope: FEISHU_SCOPES.join(" "),
    tenant_key: `tenant-${code}`,
    open_id: `open-${code}`,
    name: `飞书用户 ${code}`,
  };
}

async function connect(integration, ownerId, code = ownerId) {
  const started = integration.startOAuth(ownerId, { returnTo: "/capture" });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  return integration.handleOAuthCallback(ownerId, { state, code });
}

test("AEAD token storage never contains recoverable plaintext", () => {
  const box = createSecretBox("integration-test-key", (size) => Buffer.alloc(size, 0x31));
  const plaintext = "refresh-token-plain-secret-value";
  const ciphertext = box.encrypt(plaintext);
  assert.match(ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!ciphertext.includes(plaintext));
  assert.ok(!Buffer.from(ciphertext).toString("base64").includes(Buffer.from(plaintext).toString("base64")));
  assert.equal(box.decrypt(ciphertext), plaintext);
  assert.throws(() => createSecretBox("wrong-key").decrypt(ciphertext), (error) => error.code === "FEISHU_TOKEN_DECRYPT_FAILED");
});

test("unconfigured integration returns an actionable status without secret values", async (t) => {
  const db = await databaseFixture(t);
  const integration = new FeishuIntegration(db, {
    appId: "",
    appSecret: "",
    encryptionKey: "",
    publicBaseUrl: "https://inspiration.example.test",
  });
  const status = integration.getStatus("owner-a");
  assert.equal(status.configured, false);
  assert.equal(status.status, "not_configured");
  assert.equal(status.callbackUrl, "https://inspiration.example.test/api/integrations/feishu/oauth/callback");
  assert.deepEqual(status.missingEnvironment.sort(), [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "INTEGRATION_ENCRYPTION_KEY",
  ].sort());
  assert.ok(status.requiredEnvironment.includes("FEISHU_APP_ID"));
  assert.ok(!JSON.stringify(status).includes("appSecret"));
});

test("OAuth start uses PKCE S256, exact redirect URI and offline access", async (t) => {
  const db = await databaseFixture(t);
  const integration = new FeishuIntegration(db, integrationOptions({ pkceEnabled: true }));
  const started = integration.startOAuth("owner-a", { returnTo: "/history?note=1" });
  const url = new URL(started.authorizationUrl);
  assert.equal(url.origin, "https://accounts.feishu.test");
  assert.equal(url.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(url.searchParams.get("client_id"), "cli-test-app");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://inspiration.example.test/api/integrations/feishu/oauth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("scope").split(" ").includes("offline_access"));

  const stateRow = db.prepare("SELECT * FROM integration_oauth_states WHERE owner_id='owner-a'").get();
  const verifier = createSecretBox(integrationOptions().encryptionKey)
    .decrypt(stateRow.code_verifier_ciphertext);
  const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(url.searchParams.get("code_challenge"), expectedChallenge);
  assert.ok(!stateRow.code_verifier_ciphertext.includes(verifier));
  assert.equal(stateRow.redirect_uri, url.searchParams.get("redirect_uri"));
  assert.equal(stateRow.return_to, "/history?note=1");
});

test("OAuth callback rejects cross-owner, expired and replayed states and encrypts tokens", async (t) => {
  const db = await databaseFixture(t);
  let now = fixedNow;
  const requests = [];
  const integration = new FeishuIntegration(db, integrationOptions({
    pkceEnabled: true,
    now: () => now,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse(tokenPayload(JSON.parse(options.body).code || "refresh"));
    },
  }));

  const crossStart = integration.startOAuth("owner-a");
  const crossState = new URL(crossStart.authorizationUrl).searchParams.get("state");
  await assert.rejects(
    integration.handleOAuthCallback("owner-b", { state: crossState, code: "owner-b" }),
    (error) => error.status === 403 && error.code === "OAUTH_STATE_OWNER_MISMATCH",
  );
  assert.equal(db.prepare("SELECT consumed_at FROM integration_oauth_states WHERE owner_id='owner-a'").get().consumed_at, null);

  db.prepare("UPDATE integration_oauth_states SET expires_at=? WHERE owner_id='owner-a'")
    .run(new Date(now - 1).toISOString());
  await assert.rejects(
    integration.handleOAuthCallback("owner-a", { state: crossState, code: "expired" }),
    (error) => error.status === 400 && error.code === "OAUTH_STATE_EXPIRED",
  );

  now += 1000;
  const validStart = integration.startOAuth("owner-a", { returnTo: "/capture" });
  const validState = new URL(validStart.authorizationUrl).searchParams.get("state");
  const connected = await integration.handleOAuthCallback("owner-a", { state: validState, code: "owner-a" });
  assert.equal(connected.connected, true);
  assert.equal(connected.returnTo, "/capture");
  await assert.rejects(
    integration.handleOAuthCallback("owner-a", { state: validState, code: "owner-a" }),
    (error) => error.status === 409 && error.code === "OAUTH_STATE_ALREADY_USED",
  );

  const row = db.prepare("SELECT * FROM feishu_connections WHERE owner_id='owner-a'").get();
  assert.ok(!row.access_token_ciphertext.includes("access-token-owner-a"));
  assert.ok(!row.refresh_token_ciphertext.includes("refresh-token-owner-a"));
  const box = createSecretBox(integrationOptions().encryptionKey);
  assert.equal(box.decrypt(row.access_token_ciphertext), "access-token-owner-a");
  assert.equal(box.decrypt(row.refresh_token_ciphertext), "refresh-token-owner-a");
  assert.equal(requests.at(-1).body.redirect_uri, validStart.callbackUrl);
  assert.ok(requests.at(-1).body.code_verifier, "PKCE verifier was not sent to the token endpoint");
});

test("confidential app OAuth omits PKCE parameters for Feishu compatibility", async (t) => {
  const db = await databaseFixture(t);
  const requests = [];
  const integration = new FeishuIntegration(db, integrationOptions({
    pkceEnabled: false,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse(tokenPayload("no-pkce"));
    },
  }));
  const started = integration.startOAuth("owner-a");
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.has("code_challenge"), false);
  assert.equal(authorization.searchParams.has("code_challenge_method"), false);
  const state = authorization.searchParams.get("state");
  await integration.handleOAuthCallback("owner-a", { state, code: "no-pkce" });
  assert.equal(Object.hasOwn(requests[0], "code_verifier"), false);
});

test("outbox coalesces ten saves per owner and does not cross user boundaries", async (t) => {
  const db = await databaseFixture(t);
  insertInspiration(db, "note-a", "owner-a");
  insertInspiration(db, "note-b", "owner-b");
  const integration = new FeishuIntegration(db, integrationOptions({
    fetchImpl: async (_url, options) => jsonResponse(tokenPayload(JSON.parse(options.body).code)),
  }));
  await connect(integration, "owner-a");
  await connect(integration, "owner-b");

  const ids = new Set();
  for (let index = 0; index < 10; index += 1) {
    const result = integration.enqueueProjectionRefresh("owner-a", "note-a", { delayMs: 5000, eventKind: "save" });
    assert.equal(result.queued, true);
    ids.add(result.outboxId);
  }
  integration.enqueueProjectionRefresh("owner-b", "note-b", { delayMs: 5000, eventKind: "save" });
  assert.equal(ids.size, 1);
  const ownerA = db.prepare("SELECT * FROM sync_outbox WHERE owner_id='owner-a'").all();
  const ownerB = db.prepare("SELECT * FROM sync_outbox WHERE owner_id='owner-b'").all();
  assert.equal(ownerA.length, 1);
  assert.equal(ownerA[0].revision, 10);
  assert.equal(ownerB.length, 1);
  assert.notEqual(ownerA[0].active_key, ownerB[0].active_key);
  assert.throws(
    () => integration.enqueueProjectionRefresh("owner-b", "note-a"),
    (error) => error.status === 404 && error.code === "INSPIRATION_NOT_FOUND",
  );
  assert.ok(!JSON.stringify(integration.getStatus("owner-a")).includes("note-b"));
  assert.ok(!JSON.stringify(integration.getStatus("owner-a")).includes("access-token-owner-b"));
});

test("projection contains every managed chapter and excludes another owner's data", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const inspiration = db.prepare("SELECT * FROM inspirations WHERE id='note-legacy-1'").get();
  db.prepare(`INSERT INTO personal_documents
    (inspiration_id,owner_id,content_json,plain_text,revision,updated_at)
    VALUES (?,?,?, ?,1,?)`).run(
    inspiration.id,
    inspiration.owner_id,
    JSON.stringify({ type: "doc", content: [] }),
    "加工稿中的关键结论。",
    new Date(fixedNow).toISOString(),
  );
  db.prepare(`INSERT INTO annotations
    (id,inspiration_id,owner_id,group_id,anchor_scope,source_transcript_version_id,
     canonical_anchor_json,kind,color,comment,status,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active',1,?,?)`).run(
    "annotation-feishu",
    inspiration.id,
    inspiration.owner_id,
    "group-feishu",
    "canonical",
    inspiration.active_transcript_id,
    JSON.stringify({ quote: { exact: "emoji" } }),
    "highlight",
    "key",
    "这里值得复用。",
    new Date(fixedNow).toISOString(),
    new Date(fixedNow).toISOString(),
  );
  insertInspiration(db, "foreign-note", "user-owner-b");
  db.prepare(`INSERT INTO analyses
    (id,inspiration_id,owner_id,type,title,content,created_at)
    VALUES ('foreign-analysis','foreign-note','user-owner-b','video','','不应泄露的其他用户内容',?)`).run(new Date(fixedNow).toISOString());

  const projection = buildFeishuProjection(db, "user-owner-a", "note-legacy-1");
  assert.match(projection.sections.source, /bilibili/);
  assert.match(projection.sections.thought, /快速感想/);
  assert.match(projection.sections.personal, /加工稿中的关键结论/);
  assert.match(projection.sections.annotations, /这里值得复用/);
  assert.doesNotMatch(projection.sections.annotations, /key|\[高亮/);
  assert.match(projection.sections.reading, /核心观点/);
  assert.match(projection.sections.breakdown, /可迁移的方法/);
  assert.match(projection.sections.cases, /可供比较的案例/);
  assert.match(projection.sections.actions, /重复句与 emoji 测试/);
  assert.match(projection.sections.transcript, /第一段包含 emoji/);
  assert.deepEqual(projection.tags.map((tag) => tag.name).sort(), ["产品思维", "表达方法"].sort());
  assert.doesNotMatch(JSON.stringify(projection), /不应泄露的其他用户内容/);
  assert.match(projection.sourceHash, /^[a-f0-9]{64}$/);
});

test("content analysis extracts URL and non-URL clues for Feishu indexing", () => {
  const clues = extractProjectionClues({
    ownerId: "owner-a",
    inspirationId: "note-a",
    title: "公众号文章",
    library: { name: "AI 工作流" },
    sections: {
      reading: "文中还提到 [前端模板站](https://templates.example.test/ui)，适合后续收藏。",
      transcript: "",
      breakdown: `## 高价值线索索引
- **类型**：工具/网站｜**开放分类**：AI 生图提示词资源｜**领域**：AI 生图｜**名称**：gpt-image2.canghe.ai｜**外链**：https://gpt-image2.canghe.ai｜**价值**：可作为生图提示词搜索与复用入口｜**下一步**：测试 3 个提示词｜**来源章节**：关键线索
- **类型**：工作流/玩法｜**开放分类**：飞书自动化填表｜**领域**：飞书自动化｜**名称**：让 AI 使用飞书 CLI 自动填多维表格｜**外链**：无｜**价值**：把拆解结果自动写入资源库和线索库｜**下一步**：核验 CLI 字段映射｜**来源章节**：关键线索`,
      cases: "",
      thought: "",
      personal: "",
      annotations: "",
    },
  });
  assert.equal(clues.length, 3);
  assert.equal(clues.find(item => item.name === "gpt-image2.canghe.ai").externalUrl, "https://gpt-image2.canghe.ai/");
  const cliClue = clues.find(item => item.name.includes("飞书 CLI"));
  assert.equal(cliClue.externalUrl, "");
  assert.equal(cliClue.type, "工作流/玩法");
  assert.equal(cliClue.openCategory, "飞书自动化填表");
  assert.equal(clues.find(item => item.name === "前端模板站").source, "原文/阅读版");
  assert.ok(clues.every(item => /^[a-f0-9]{24}$/.test(item.clueId)));
});

test("Markdown uses native Feishu rich text and structural blocks", () => {
  const blocks = markdownBlocks(`正文 **粗体** *斜体* ~~删除~~ \`代码\` [原链接](https://example.test/path)\n\n![文章图](https://example.test/article.png)\n\n- 项目\n- [x] 已完成\n\n1. 第一步\n\n> 关键引用\n\n---`);
  assert.deepEqual(blocks.map(block => block.block_type), [2, 27, 12, 17, 13, 15, 22]);
  const paragraphRuns = blocks[0].text.elements.map(element => element.text_run);
  assert.equal(paragraphRuns.map(run => run.content).join(""), "正文 粗体 斜体 删除 代码 原链接");
  assert.equal(paragraphRuns.find(run => run.content === "粗体").text_element_style.bold, true);
  assert.equal(paragraphRuns.find(run => run.content === "斜体").text_element_style.italic, true);
  assert.equal(paragraphRuns.find(run => run.content === "删除").text_element_style.strikethrough, true);
  assert.equal(paragraphRuns.find(run => run.content === "代码").text_element_style.inline_code, true);
  assert.equal(paragraphRuns.find(run => run.content === "原链接").text_element_style.link.url, "https%3A%2F%2Fexample.test%2Fpath");
  assert.equal(blocks[1].__imageSource, "https://example.test/article.png");
  assert.equal(blocks[3].todo.style.done, true);
});

test("curated projection omits empty chapters and hides internal annotation keys", () => {
  const blocks = projectionBlocks({
    title: "精简飞书文档",
    url: "https://example.test/video",
    thumbnail: "",
    platform: "bilibili",
    author: "作者",
    createdAt: "2026-07-27T02:00:00.000Z",
    summary: "三行内看懂这条灵感的核心启发。",
    tags: [{ group: "工作", name: "沟通" }],
    actions: [],
    annotations: [{ kind: "highlight", label: "重点", quote: "值得保留的原句", comment: "**含义**\n\n- 可复用结论", groupId: "group-1" }],
    sections: { thought: "", personal: "", breakdown: "", cases: "", reading: "", transcript: "" },
  });
  const serialized = JSON.stringify(blocks);
  const headings = blocks.filter(block => block.heading1).map(block => block.heading1.elements[0].text_run.content);
  assert.deepEqual(headings, ["阅读标注"]);
  assert.doesNotMatch(serialized, /暂无内容|来源信息|我的感想|AI 阅读版|原始转写|key|doubt|action/);
  assert.match(serialized, /核心启发|打开原视频|值得保留的原句/);
  assert.doesNotMatch(serialized, /\*\*含义\*\*|- 可复用结论/);
  assert.match(serialized, /含义|可复用结论/);
});

test("Feishu reading projection embeds annotations inline beside the reading text", async (t) => {
  const db = await databaseFixture(t);
  insertInspiration(db, "note-inline-reading", "owner-a");
  const timestamp = new Date(fixedNow).toISOString();
  const rawText = "第一段有飞书 CLI 自动填表，也提到 Goal 模式。";
  const rawBlocks = buildBlocks(rawText);
  const rawSha = sha256Text(rawText);
  db.prepare(`INSERT INTO transcript_versions
    (id,inspiration_id,owner_id,raw_text,normalized_text,sha256,language,version_no,created_at)
    VALUES ('raw-inline','note-inline-reading','owner-a',?,?,?,?,1,?)`).run(rawText, rawText, rawSha, "zh-CN", timestamp);
  const readingMarkdown = `# 阅读版\n\n${rawText}\n\n![配图](https://example.test/article-image.png)`;
  const readingBlocks = buildBlocks(readingMarkdown);
  const readingSha = sha256Text(readingMarkdown);
  db.prepare(`INSERT INTO reading_documents
    (id,inspiration_id,transcript_version_id,owner_id,markdown,plain_text,blocks_json,sha256,provider,model,prompt_version,version_no,created_at)
    VALUES ('reading-inline','note-inline-reading','raw-inline','owner-a',?,?,?,?, 'test','model','v1',1,?)`)
    .run(readingMarkdown, readingBlocks.map(block => block.text).join("\n\n"), JSON.stringify(readingBlocks), readingSha, timestamp);
  db.prepare("UPDATE inspirations SET active_transcript_id='raw-inline',active_reading_document_id='reading-inline' WHERE id='note-inline-reading' AND owner_id='owner-a'").run();
  const cliStart = rawText.indexOf("飞书 CLI 自动填表");
  const goalStart = rawText.indexOf("Goal 模式");
  const canonicalCli = buildAnchor({ blockId: rawBlocks[0].id, blockText: rawBlocks[0].text, start: cliStart, end: cliStart + "飞书 CLI 自动填表".length, sourceDocumentSha256: rawSha });
  const canonicalGoal = buildAnchor({ blockId: rawBlocks[0].id, blockText: rawBlocks[0].text, start: goalStart, end: goalStart + "Goal 模式".length, sourceDocumentSha256: rawSha });
  for (const [id, groupId, anchor, kind, color, comment] of [
    ["ann-cli", "group-cli", canonicalCli, "highlight", "key", "这是一个信息差，后续要尝试。"],
    ["ann-goal", "group-goal", canonicalGoal, "underline", "", ""],
  ]) {
    db.prepare(`INSERT INTO annotations
      (id,inspiration_id,owner_id,group_id,anchor_scope,source_transcript_version_id,canonical_anchor_json,kind,color,comment,status,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',1,?,?)`).run(id, "note-inline-reading", "owner-a", groupId, "canonical", "raw-inline", JSON.stringify(anchor), kind, color, comment, timestamp, timestamp);
  }

  const projection = buildFeishuProjection(db, "owner-a", "note-inline-reading");
  const blocks = projectionBlocks(projection);
  const headings = blocks.filter(block => block.heading1).map(block => block.heading1.elements[0].text_run.content);
  assert.ok(headings.includes("AI 阅读版"));
  assert.ok(headings.indexOf("AI 阅读版") < headings.indexOf("我的思考"));
  assert.equal(headings.includes("阅读标注"), false);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /article-image\.png/);
  assert.match(serialized, /这是一个信息差/);
  const runs = blocks.flatMap(block => block.text?.elements || block.heading2?.elements || []);
  const cliRun = runs.find(element => element.text_run?.content === "飞书 CLI 自动填表")?.text_run;
  const goalRun = runs.find(element => element.text_run?.content === "Goal 模式")?.text_run;
  assert.equal(cliRun?.text_element_style?.background_color, 2);
  assert.equal(goalRun?.text_element_style?.underline, true);
});

test("Feishu sync writes high-value clues as typed Bitable rows linked back to the note", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const remote = createRemoteMock();
  const integration = new FeishuIntegration(db, integrationOptions({ fetchImpl: remote.fetchImpl }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1", spaceName: "个人知识库" });

  db.prepare(`INSERT INTO analyses
    (id,inspiration_id,owner_id,type,title,content,provider,model,source_url,created_at)
    VALUES ('analysis-clues','note-legacy-1','user-owner-a','video','内容拆解',?,'openai','fixture-model','https://example.test/article',?)`).run(
    `## 高价值线索索引
- **类型**：工具/网站｜**开放分类**：AI 生图提示词资源｜**领域**：AI 生图｜**名称**：gpt-image2.canghe.ai｜**外链**：https://gpt-image2.canghe.ai｜**价值**：可作为生图提示词搜索与复用入口｜**下一步**：测试 3 个提示词｜**来源章节**：关键线索
- **类型**：工作流/玩法｜**开放分类**：飞书自动化填表｜**领域**：飞书自动化｜**名称**：让 AI 使用飞书 CLI 自动填多维表格｜**外链**：无｜**价值**：把拆解结果自动写入资源库和线索库｜**下一步**：核验 CLI 字段映射｜**来源章节**：关键线索`,
    new Date(fixedNow).toISOString(),
  );

  integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1");
  const result = await integration.processNextOutbox();
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.clues, 2);

  const rows = [...remote.records.values()];
  const inspirationRows = rows.filter(record => record.fields["记录类型"] === "灵感");
  const clueRows = rows.filter(record => record.fields["记录类型"] === "线索");
  assert.equal(inspirationRows.length, 1);
  assert.equal(clueRows.length, 2);
  const urlClue = clueRows.find(record => record.fields["线索名称"] === "gpt-image2.canghe.ai");
  assert.equal(urlClue.fields["开放分类"], "AI 生图提示词资源");
  assert.equal(urlClue.fields["领域"], "AI 生图");
  assert.deepEqual(urlClue.fields["外链"], { text: "https://gpt-image2.canghe.ai/", link: "https://gpt-image2.canghe.ai/" });
  assert.deepEqual(urlClue.fields["飞书笔记"], { text: "https://feishu.test/wiki-1", link: "https://feishu.test/wiki-1" });
  const nonUrlClue = clueRows.find(record => record.fields["线索名称"].includes("飞书 CLI"));
  assert.equal(nonUrlClue.fields["外链"], null);
  assert.match(nonUrlClue.fields["线索摘要"], /字段映射/);

  const documentWrites = remote.calls.filter((call) => call.method === "POST" && call.url.includes("/docx/v1/documents/doc-1/blocks/doc-1/children"));
  const libraryHubWrites = remote.calls.filter((call) => call.method === "POST" && call.url.includes("/docx/v1/documents/library-doc-1/blocks/library-doc-1/children"));
  assert.match(JSON.stringify(documentWrites[0].body.children), /自动整理线索/);
  assert.match(JSON.stringify(libraryHubWrites.at(-1).body.children), /打开本库多维表格|本库已接入多维表格/);
  assert.match(JSON.stringify(libraryHubWrites.at(-1).body.children), /table-library-1/);
  assert.match(JSON.stringify(libraryHubWrites.at(-1).body.children), /view-library-1/);
});

function createRemoteMock({ failures = [] } = {}) {
  const calls = [];
  let childId = 0;
  let supplementBlockId = null;
  let libraryCount = 0;
  let noteCount = 0;
  let recordCount = 0;
  let libraryTableCount = 0;
  const records = new Map();
  const docChildren = new Map();
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(png.buffer).setUint32(16, 540);
  new DataView(png.buffer).setUint32(20, 720);
  const tableIdFrom = (value) => value.match(/\/tables\/([^/?]+)(?:\/|$)/)?.[1] || "";
  const fieldText = (value) => {
    if (value == null) return "";
    if (["string", "number", "boolean"].includes(typeof value)) return String(value);
    if (Array.isArray(value)) return value.map(fieldText).join("");
    if (typeof value === "object") return String(value.text || value.name || value.value || value.link || "");
    return String(value || "");
  };
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";
    const formData = typeof FormData !== "undefined" && options.body instanceof FormData;
    const body = options.body ? (formData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body)) : null;
    calls.push({ url: value, method, body });
    if (value.endsWith("/oauth/v3/token")) return jsonResponse(tokenPayload(body.code || "refresh"));
    if (failures.length) {
      const failure = failures.shift();
      return jsonResponse({ code: failure.status, msg: failure.message }, failure.status, { "x-tt-logid": failure.requestId });
    }
    if (value.endsWith("/bitable/v1/apps")) {
      return jsonResponse({ code: 0, data: { app: { app_token: "base-1", default_table_id: "table-1", url: "https://feishu.test/base-1" } } });
    }
    if (/\/drive\/v1\/medias\/[^/]+\/download(?:\?|$)/.test(value) && method === "GET") {
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    if (value.endsWith("/drive/v1/medias/upload_all") && method === "POST") {
      return jsonResponse({ code: 0, data: { file_token: "cover-file-token" } });
    }
    if (/\/docx\/v1\/documents\/doc-1\/blocks\/block-\d+/.test(value) && method === "PATCH") {
      const documentItems = docChildren.get("doc-1") || [];
      const blockId = value.match(/\/blocks\/(block-\d+)/)?.[1];
      const item = documentItems.find(child => child.block_id === blockId);
      if (item && body?.replace_image) item.image = { token: body.replace_image.token, width: body.replace_image.width, height: body.replace_image.height };
      return jsonResponse({ code: 0, data: {} });
    }
    if (/\/docx\/v1\/documents\/library-doc-\d+$/.test(value) && method === "PATCH") return jsonResponse({ code: 0, data: {} });
    if (value.endsWith("/bitable/v1/apps/base-1/tables") && method === "POST") {
      const name = body?.table?.name || "";
      if (name === "灵感索引") return jsonResponse({ code: 0, data: { table_id: "table-index", table: { table_id: "table-index" } } });
      libraryTableCount += 1;
      const tableId = `table-library-${libraryTableCount}`;
      return jsonResponse({ code: 0, data: { table_id: tableId, table: { table_id: tableId, default_view_id: `view-library-${libraryTableCount}` } } });
    }
    if (/\/bitable\/v1\/apps\/base-1\/tables\/[^/]+$/.test(value) && method === "PATCH") return jsonResponse({ code: 0, data: {} });
    if (/\/bitable\/v1\/apps\/base-1\/tables\/[^/]+$/.test(value) && method === "DELETE") return jsonResponse({ code: 0, data: {} });
    if (value.includes("/tables/") && value.includes("/fields") && method === "GET") {
      return jsonResponse({
        code: 0,
        data: {
          items: [
            { field_id: "fld-id", field_name: "灵感ID", type: 1 },
            { field_id: "fld-cover", field_name: "封面图", type: 15 },
            { field_id: "fld-title", field_name: "标题", type: 1 },
            { field_id: "fld-tags", field_name: "我的标签", type: 1 },
            { field_id: "fld-date", field_name: "日期", type: 5 },
            { field_id: "fld-author", field_name: "作者名称", type: 1 },
            { field_id: "fld-source", field_name: "原链接", type: 15 },
            { field_id: "fld-note", field_name: "跳转笔记链接", type: 15 },
            { field_id: "fld-library", field_name: "灵感库", type: 1 },
            { field_id: "fld-status", field_name: "同步状态", type: 1 },
          ],
        },
      });
    }
    if (value.includes("/tables/") && value.includes("/fields/") && method === "PUT") return jsonResponse({ code: 0, data: {} });
    if (value.includes("/tables/") && value.endsWith("/fields") && method === "POST") return jsonResponse({ code: 0, data: {} });
    if (value.includes("/records/search")) {
      const tableId = tableIdFrom(value);
      const inspirationId = body?.filter?.conditions?.find(condition => condition.field_name === "灵感ID")?.value?.[0] || "";
      const items = [...records.values()].filter(record => record.table_id === tableId && (!inspirationId || fieldText(record.fields?.["灵感ID"]) === inspirationId));
      return jsonResponse({ code: 0, data: { items } });
    }
    if (value.endsWith("/records") && method === "POST") {
      const tableId = tableIdFrom(value);
      const record = { record_id: `record-${++recordCount}`, table_id: tableId, fields: body.fields || {} };
      records.set(record.record_id, record);
      return jsonResponse({ code: 0, data: { record } });
    }
    if (/\/records\/record-\d+$/.test(value) && method === "PUT") {
      const recordId = value.match(/\/records\/(record-\d+)$/)?.[1];
      const tableId = tableIdFrom(value);
      records.set(recordId, { record_id: recordId, table_id: tableId, fields: body.fields || {} });
      return jsonResponse({ code: 0, data: {} });
    }
    if (/\/records\/record-\d+$/.test(value) && method === "DELETE") {
      const recordId = value.match(/\/records\/(record-\d+)$/)?.[1];
      records.delete(recordId);
      return jsonResponse({ code: 0, data: {} });
    }
    if (value.endsWith("/wiki/v2/spaces/space-1/nodes") && method === "POST") {
      if (!body.parent_node_token) {
        libraryCount += 1;
        return jsonResponse({ code: 0, data: { node: {
          node_token: `library-wiki-${libraryCount}`,
          obj_token: `library-doc-${libraryCount}`,
          url: `https://feishu.test/library-${libraryCount}`,
        } } });
      }
      noteCount += 1;
      return jsonResponse({ code: 0, data: { node: {
        node_token: noteCount === 1 ? "wiki-1" : `wiki-${noteCount}`,
        obj_token: noteCount === 1 ? "doc-1" : `doc-${noteCount}`,
        url: `https://feishu.test/wiki-${noteCount}`,
      } } });
    }
    if (/\/wiki\/v2\/spaces\/space-1\/nodes\/wiki-\d+\/move$/.test(value) && method === "POST") return jsonResponse({ code: 0, data: {} });
    if (/\/wiki\/v2\/spaces\/space-1\/nodes\/library-wiki-\d+$/.test(value) && method === "DELETE") return jsonResponse({ code: 0, data: {} });
    const docChildrenMatch = value.match(/\/docx\/v1\/documents\/([^/]+)\/blocks\/\1\/children(?:\?|$)/);
    if (docChildrenMatch && method === "POST") {
      const documentId = docChildrenMatch[1];
      const children = body.children.map((block) => {
        const blockId = `block-${++childId}`;
        const content = block.heading1?.elements?.[0]?.text_run?.content;
        if (documentId === "doc-1" && content === "我的飞书补充") supplementBlockId = blockId;
        return { block_id: blockId, ...block };
      });
      docChildren.set(documentId, [...(docChildren.get(documentId) || []), ...children]);
      return jsonResponse({
        code: 0,
        data: { children },
      });
    }
    if (docChildrenMatch && method === "GET") {
      const documentId = docChildrenMatch[1];
      const items = docChildren.get(documentId) || (documentId === "doc-1" && supplementBlockId ? [{ block_id: supplementBlockId }] : []);
      return jsonResponse({ code: 0, data: { items, has_more: false } });
    }
    if (value.includes("batch_delete")) return jsonResponse({ code: 0, data: {} });
    throw new Error(`Unexpected mock Feishu request: ${method} ${value}`);
  };
  return { calls, fetchImpl, records, docChildren };
}

test("mock Feishu sync creates one wiki document, one global index row and one library index row across retry", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const remote = createRemoteMock();
  const integration = new FeishuIntegration(db, integrationOptions({ fetchImpl: remote.fetchImpl }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1", spaceName: "个人知识库" });

  integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1");
  const first = await integration.processNextOutbox();
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  integration.validatedIndexTables.clear();
  integration.validatedLibraryTables.clear();
  integration.retry("user-owner-a", "note-legacy-1");
  const second = await integration.processNextOutbox();
  assert.equal(second.status, "succeeded", JSON.stringify(second));

  const wikiCreates = remote.calls.filter((call) => call.method === "POST" && call.url.includes("/wiki/v2/spaces/space-1/nodes"));
  const recordCreates = remote.calls.filter((call) => call.method === "POST" && /\/records$/.test(call.url));
  const tableCreates = remote.calls.filter((call) => call.method === "POST" && /\/tables$/.test(call.url));
  const fieldTypeUpdates = remote.calls.filter((call) => call.method === "PUT" && /\/fields\//.test(call.url));
  const coverUploads = remote.calls.filter((call) => call.method === "POST" && call.url.endsWith("/drive/v1/medias/upload_all"));
  const docxCoverUploads = coverUploads.filter((call) => call.body.parent_type === "docx_image");
  const bitableCoverUploads = coverUploads.filter((call) => call.body.parent_type === "bitable_file");
  const coverPatches = remote.calls.filter((call) => call.method === "PATCH" && /\/docx\/v1\/documents\/doc-1\/blocks\/block-\d+/.test(call.url));
  const documentWrites = remote.calls.filter((call) => call.method === "POST" && call.url.includes("/docx/v1/documents/doc-1/blocks/doc-1/children"));
  assert.equal(wikiCreates.length, 2, "sync should create one library node and one note document only");
  assert.equal(wikiCreates[0].body.title, "待分类");
  assert.equal(wikiCreates[1].body.parent_node_token, "library-wiki-1");
  assert.equal(recordCreates.length, 2, "manual retry duplicated the Bitable rows");
  assert.equal(tableCreates.length, 2, "manual retry duplicated the library Bitable table");
  assert.ok(fieldTypeUpdates.some(call => call.url.endsWith("/fields/fld-cover") && call.body.type === 17), "old cover link field was not upgraded to attachment");
  assert.ok(fieldTypeUpdates.some(call => call.url.endsWith("/fields/fld-tags") && call.body.type === 4), "old tag text field was not upgraded to multi-select");
  assert.equal(docxCoverUploads.length, 2, "each forced document rewrite must attach the cover to its newly created image block");
  assert.equal(bitableCoverUploads.length, 2, "global and library Bitable cover fields should use Base-owned attachment tokens");
  assert.equal(coverPatches.length, 2, "each uploaded cover must replace its empty image block");
  assert.ok(documentWrites[0].body.children.some(block => block.block_type === 27 && block.image), "the cover image placeholder block was not written");
  assert.match(String(docxCoverUploads[0].body.parent_node), /^block-\d+$/, "the cover was not attached to the created image block");
  assert.deepEqual(JSON.parse(docxCoverUploads[0].body.extra), { drive_route_token: "doc-1" });
  assert.equal(bitableCoverUploads[0].body.parent_node, "base-1");
  assert.deepEqual(coverPatches[0].body.replace_image, { token: "cover-file-token", width: 540, height: 720 });
  const binding = db.prepare("SELECT * FROM feishu_document_bindings WHERE owner_id='user-owner-a' AND inspiration_id='note-legacy-1'").get();
  assert.equal(binding.wiki_node_token, "wiki-1");
  assert.equal(binding.docx_document_id, "doc-1");
  assert.equal(binding.bitable_record_id, "record-1");
  assert.equal(binding.library_bitable_record_id, "record-2");
  assert.equal(binding.sync_status, "synced");
  assert.equal(binding.parent_wiki_node_token, "library-wiki-1");
  assert.equal(binding.library_id, "library-default-user-owner-a");
  const libraryIndexRecord = remote.records.get(binding.library_bitable_record_id);
  assert.deepEqual(libraryIndexRecord.fields["封面图"], [{ file_token: "cover-file-token", name: "封面", type: "image/jpeg" }]);
  const expectedTagLabels = integration.buildProjection("user-owner-a", "note-legacy-1").tags.map(tag => `${tag.group ? `${tag.group} / ` : ""}#${tag.name}`).sort();
  assert.deepEqual(libraryIndexRecord.fields["我的标签"].sort(), expectedTagLabels);
  const libraryBinding = db.prepare("SELECT * FROM feishu_library_bindings WHERE owner_id='user-owner-a'").get();
  assert.equal(libraryBinding.library_bitable_table_id, "table-library-1");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM feishu_library_bindings WHERE owner_id='user-owner-a'").get().count, 1);
  db.prepare("UPDATE sync_outbox SET status='failed' WHERE owner_id='user-owner-a'").run();
  const currentStatus = integration.getStatus("user-owner-a");
  assert.equal(currentStatus.sync.failed, 0, "historical failed outbox rows leaked into current status");
  assert.equal(currentStatus.sync.succeeded, 1);

  const disconnected = integration.disconnect("user-owner-a");
  assert.equal(disconnected.remoteDocumentsPreserved, true);
  const retained = db.prepare("SELECT * FROM feishu_document_bindings WHERE id=?").get(binding.id);
  assert.equal(retained.connection_id, null);
  assert.equal(retained.wiki_node_token, "wiki-1");
  assert.equal(retained.docx_document_id, "doc-1");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM feishu_connections WHERE owner_id='user-owner-a'").get().count, 0);
});

test("Feishu archive outbox hides the local note only after successful sync", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const remote = createRemoteMock();
  const pruned = [];
  const integration = new FeishuIntegration(db, integrationOptions({
    fetchImpl: remote.fetchImpl,
    onPruneArchivedLocal: (summary) => pruned.push(summary),
  }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1", spaceName: "个人知识库" });

  db.prepare(`INSERT INTO personal_documents
    (inspiration_id,owner_id,content_json,plain_text,revision,updated_at)
    VALUES ('note-legacy-1','user-owner-a','{"type":"doc","content":[]}','本地加工稿',1,?)`).run(new Date(fixedNow).toISOString());
  db.prepare("UPDATE inspirations SET status='feishu_archiving' WHERE id=? AND owner_id=?")
    .run("note-legacy-1", "user-owner-a");
  integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1", {
    eventKind: "feishu_archive",
    force: true,
    payload: { archiveAfterSync: true, previousStatus: "captured" },
  });
  const result = await integration.processNextOutbox();
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const inspiration = db.prepare("SELECT status,thumbnail,quick_thought,active_transcript_id,active_reading_document_id,transcription_job_id,transcription_status FROM inspirations WHERE id=? AND owner_id=?").get("note-legacy-1", "user-owner-a");
  assert.equal(inspiration.status, "feishu_archived");
  assert.equal(inspiration.thumbnail, "");
  assert.equal(inspiration.quick_thought, "");
  assert.equal(inspiration.active_transcript_id, null);
  assert.equal(inspiration.active_reading_document_id, null);
  assert.equal(inspiration.transcription_job_id, null);
  assert.equal(inspiration.transcription_status, "");
  for (const table of ["transcript_versions", "reading_documents", "personal_documents", "personal_document_mutations", "personal_document_revisions", "annotations", "analyses", "transcription_jobs", "action_items", "inspiration_tags"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE inspiration_id=?`).get("note-legacy-1").count, 0, `${table} should be pruned after Feishu archive`);
  }
  const binding = db.prepare("SELECT sync_status,document_url,source_hash FROM feishu_document_bindings WHERE owner_id=? AND inspiration_id=?").get("user-owner-a", "note-legacy-1");
  assert.equal(binding.sync_status, "synced");
  assert.ok(binding.document_url);
  assert.ok(binding.source_hash);
  assert.equal(pruned.length, 1);
  assert.match(pruned[0].thumbnail, /^\/covers\//);
});

test("library index backfill recovers cover and tags from archived Feishu document", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const remote = createRemoteMock();
  const integration = new FeishuIntegration(db, integrationOptions({ fetchImpl: remote.fetchImpl }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1", spaceName: "个人知识库" });

  const beforePrune = integration.buildProjection("user-owner-a", "note-legacy-1");
  const expectedTagLabels = beforePrune.tags.map(tag => `${tag.group ? `${tag.group} / ` : ""}#${tag.name}`).sort();
  integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1");
  const synced = await integration.processNextOutbox();
  assert.equal(synced.status, "succeeded", JSON.stringify(synced));

  db.prepare("UPDATE inspirations SET status='feishu_archived' WHERE owner_id='user-owner-a' AND id='note-legacy-1'").run();
  integration.pruneArchivedLocalPayload("user-owner-a", "note-legacy-1");
  const pruned = integration.buildProjection("user-owner-a", "note-legacy-1");
  assert.equal(pruned.thumbnail, "");
  assert.equal(pruned.tags.length, 0);

  const binding = db.prepare("SELECT * FROM feishu_document_bindings WHERE owner_id='user-owner-a' AND inspiration_id='note-legacy-1'").get();
  remote.records.get(binding.library_bitable_record_id).fields["封面图"] = [];
  remote.records.get(binding.library_bitable_record_id).fields["我的标签"] = [];

  const result = await integration.backfillLibraryIndexes({ ownerId: "user-owner-a", limit: 10 });
  assert.equal(result.upserted, 1);
  const libraryIndexRecord = remote.records.get(binding.library_bitable_record_id);
  assert.deepEqual(libraryIndexRecord.fields["封面图"], [{ file_token: "cover-file-token", name: "封面", type: "image/jpeg" }]);
  assert.deepEqual(libraryIndexRecord.fields["我的标签"].sort(), expectedTagLabels);
});

test("Feishu archive outbox restores the previous local status after terminal failure", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const remote = createRemoteMock({ failures: [{ status: 400, message: "invalid request", requestId: "req-400" }] });
  const pruned = [];
  const integration = new FeishuIntegration(db, integrationOptions({ fetchImpl: remote.fetchImpl, onPruneArchivedLocal: summary => pruned.push(summary) }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1", spaceName: "个人知识库" });

  const beforeTranscriptCount = db.prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE inspiration_id=? AND owner_id=?").get("note-legacy-1", "user-owner-a").count;
  const beforeReadingCount = db.prepare("SELECT COUNT(*) AS count FROM reading_documents WHERE inspiration_id=? AND owner_id=?").get("note-legacy-1", "user-owner-a").count;
  db.prepare("UPDATE inspirations SET status='feishu_archiving' WHERE id=? AND owner_id=?")
    .run("note-legacy-1", "user-owner-a");
  integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1", {
    eventKind: "feishu_archive",
    force: true,
    payload: { archiveAfterSync: true, previousStatus: "pending" },
  });
  const result = await integration.processNextOutbox();
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(db.prepare("SELECT status FROM inspirations WHERE id=? AND owner_id=?").get("note-legacy-1", "user-owner-a").status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE inspiration_id=? AND owner_id=?").get("note-legacy-1", "user-owner-a").count, beforeTranscriptCount);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reading_documents WHERE inspiration_id=? AND owner_id=?").get("note-legacy-1", "user-owner-a").count, beforeReadingCount);
  assert.equal(pruned.length, 0);
});

test("library move and rename preserve the note document and clean an empty deleted directory", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  const remote = createRemoteMock();
  const integration = new FeishuIntegration(db, integrationOptions({ fetchImpl: remote.fetchImpl }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1" });

  integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1");
  assert.equal((await integration.processNextOutbox()).status, "succeeded");
  const original = db.prepare("SELECT * FROM feishu_document_bindings WHERE inspiration_id='note-legacy-1'").get();
  const timestamp = new Date(fixedNow).toISOString();
  db.prepare(`INSERT INTO inspiration_libraries(id,owner_id,name,is_default,sort_order,created_at,updated_at)
    VALUES ('library-work','user-owner-a','工作协作',0,1,?,?)`).run(timestamp, timestamp);
  db.prepare(`UPDATE inspiration_library_assignments SET library_id='library-work',updated_at=?
    WHERE inspiration_id='note-legacy-1' AND owner_id='user-owner-a'`).run(timestamp);

  integration.retry("user-owner-a", "note-legacy-1");
  assert.equal((await integration.processNextOutbox()).status, "succeeded");
  let binding = db.prepare("SELECT * FROM feishu_document_bindings WHERE inspiration_id='note-legacy-1'").get();
  assert.equal(binding.wiki_node_token, original.wiki_node_token);
  assert.equal(binding.docx_document_id, original.docx_document_id);
  assert.equal(binding.document_url, original.document_url);
  assert.equal(binding.library_id, "library-work");
  assert.equal(binding.parent_wiki_node_token, "library-wiki-2");
  let moves = remote.calls.filter(call => call.method === "POST" && call.url.endsWith("/wiki-1/move"));
  assert.deepEqual(moves.at(-1).body, { target_parent_token: "library-wiki-2" });

  db.prepare("UPDATE inspiration_libraries SET name='团队沟通',updated_at=? WHERE id='library-work'").run(timestamp);
  integration.retry("user-owner-a", "note-legacy-1");
  assert.equal((await integration.processNextOutbox()).status, "succeeded");
  const renames = remote.calls.filter(call => call.method === "PATCH" && call.url.endsWith("/docx/v1/documents/library-doc-2"));
  assert.equal(renames.at(-1).body.title, "团队沟通");

  db.transaction(() => {
    db.prepare(`UPDATE inspiration_library_assignments SET library_id='library-default-user-owner-a',updated_at=?
      WHERE inspiration_id='note-legacy-1'`).run(timestamp);
    db.prepare("UPDATE inspiration_libraries SET deleted_at=?,updated_at=? WHERE id='library-work'").run(timestamp, timestamp);
  })();
  integration.retry("user-owner-a", "note-legacy-1");
  assert.equal((await integration.processNextOutbox()).status, "succeeded");
  binding = db.prepare("SELECT * FROM feishu_document_bindings WHERE inspiration_id='note-legacy-1'").get();
  assert.equal(binding.library_id, "library-default-user-owner-a");
  assert.equal(binding.parent_wiki_node_token, "library-wiki-1");
  moves = remote.calls.filter(call => call.method === "POST" && call.url.endsWith("/wiki-1/move"));
  assert.equal(moves.length, 2);
  const deletes = remote.calls.filter(call => call.method === "DELETE" && call.url.endsWith("/library-wiki-2"));
  assert.equal(deletes.length, 1);
  assert.equal(db.prepare("SELECT status FROM feishu_library_bindings WHERE library_id='library-work'").get().status, "deleted");
});

test("Feishu object errors keep the numeric upstream code and detailed message", async (t) => {
  const db = await databaseFixture(t);
  const integration = new FeishuIntegration(db, integrationOptions());
  await assert.rejects(
    integration.readFeishuResponse(jsonResponse({
      code: 1254018,
      msg: "InvalidFilter",
      error: { message: "not found field_name '灵感ID'" },
    })),
    error => error.code === "FEISHU_API_ERROR_1254018" && /灵感ID/.test(error.message),
  );
});

test("429 and 5xx failures retain one outbox row and use 1/5 minute backoff", async (t) => {
  const db = await databaseFixture(t, { legacy: true });
  let now = fixedNow;
  const remote = createRemoteMock({ failures: [
    { status: 429, message: "rate limited", requestId: "req-429" },
    { status: 503, message: "temporarily unavailable", requestId: "req-503" },
  ] });
  const integration = new FeishuIntegration(db, integrationOptions({ now: () => now, fetchImpl: remote.fetchImpl }));
  await connect(integration, "user-owner-a", "owner-a");
  integration.configure("user-owner-a", { spaceId: "space-1" });
  const queued = integration.enqueueProjectionRefresh("user-owner-a", "note-legacy-1");

  const rateLimited = await integration.processNextOutbox();
  assert.equal(rateLimited.status, "failed");
  let outbox = db.prepare("SELECT * FROM sync_outbox WHERE id=?").get(queued.outboxId);
  assert.equal(outbox.status, "pending");
  assert.equal(new Date(outbox.available_at).getTime(), now + 60_000);
  assert.match(outbox.last_error_code, /429/);
  assert.match(outbox.last_error_details_json, /req-429/);

  now += 60_000;
  const unavailable = await integration.processNextOutbox();
  assert.equal(unavailable.status, "failed");
  outbox = db.prepare("SELECT * FROM sync_outbox WHERE id=?").get(queued.outboxId);
  assert.equal(outbox.status, "pending");
  assert.equal(new Date(outbox.available_at).getTime(), now + 300_000);
  assert.match(outbox.last_error_code, /503/);
  assert.match(outbox.last_error_details_json, /req-503/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE owner_id='user-owner-a'").get().count, 1);

  now += 300_000;
  const recovered = await integration.processNextOutbox();
  assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
  outbox = db.prepare("SELECT * FROM sync_outbox WHERE id=?").get(queued.outboxId);
  assert.equal(outbox.status, "succeeded");
  assert.equal(outbox.attempts, 3);
});
