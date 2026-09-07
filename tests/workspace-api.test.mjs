import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { importPlanned } from "./helpers/planned-module.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureDir = resolve(import.meta.dirname, "fixtures/legacy-workspace");
let root;
let baseUrl;
let server;
let cookieA;
let cookieB;
let canonicalAnchor;
let annotation;
let workspaceMeta;

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function request(path, { cookie, headers, body, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { payload = text; }
  return { response, payload };
}

async function login(email, password) {
  const { response, payload } = await request("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(response.status, 200, JSON.stringify(payload));
  return response.headers.get("set-cookie").split(";", 1)[0];
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "inspiration-api-"));
  const dataDirectory = join(root, "data");
  await cp(fixtureDir, dataDirectory, { recursive: true });
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIRECTORY: dataDirectory,
      DATABASE_PATH: join(root, "workspace.sqlite"),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error(`test server exited (${server.exitCode}): ${stderr}`);
    await delay(50);
  }
  cookieA = await login("owner-a@example.test", "owner-a-password");
  cookieB = await login("owner-b@example.test", "owner-b-password");

  const { buildBlocks, buildAnchor, sha256Text, normalizeText } = await importPlanned("lib/transcript-workspace.mjs", [
    "buildBlocks", "buildAnchor", "sha256Text", "normalizeText",
  ]);
  const raw = "第一段包含 emoji 👩🏽‍💻。\r\n\r\n同一句会出现。\r\n同一句会出现。";
  const blocks = buildBlocks(raw);
  const block = blocks[0];
  const start = block.text.indexOf("emoji");
  canonicalAnchor = buildAnchor({
    blockId: block.id,
    blockText: block.text,
    start,
    end: start + "emoji 👩🏽‍💻".length,
    sourceDocumentSha256: sha256Text(normalizeText(raw)),
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      delay(2000),
    ]);
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test("workspace metadata stays small and loads document bodies separately", async () => {
  const { response, payload } = await request("/api/notes/note-legacy-1/workspace", { cookie: cookieA });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 28 * 1024);
  assert.ok(!JSON.stringify(payload).includes("第一段包含 emoji"), "workspace first payload must not inline full document text");
  assert.ok(payload.activeTranscriptId || payload.workspace?.activeTranscriptId);
  workspaceMeta = payload.workspace || payload;
});

test("expired terminal transcription jobs are pruned while active work survives", async () => {
  const { response, payload } = await request("/api/jobs", { cookie: cookieA });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(payload.jobs.some(job => job.id === "job-active-1"));
  assert.ok(!payload.jobs.some(job => job.id === "job-legacy-1"));
});

test("another user receives the same 404 for GET and mutation attempts", async () => {
  const getResult = await request("/api/notes/note-legacy-1/workspace", { cookie: cookieB });
  assert.equal(getResult.response.status, 404);
  const postResult = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieB,
    method: "POST",
    headers: { "Idempotency-Key": "owner-b-probe" },
    body: { kind: "highlight", color: "focus", anchorScope: "canonical", canonicalAnchor },
  });
  assert.equal(postResult.response.status, 404);

  const owned = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieA,
    method: "POST",
    headers: { "Idempotency-Key": "owner-a-isolation-fixture" },
    body: { kind: "highlight", color: "key", anchorScope: "canonical", canonicalAnchor },
  });
  assert.equal(owned.response.status, 201, JSON.stringify(owned.payload));
  const annotationId = owned.payload.annotation.id;
  const foreignPatch = await request(`/api/notes/note-legacy-1/annotations/${annotationId}`, {
    cookie: cookieB, method: "PATCH", body: { baseRevision: 1, comment: "越权修改" },
  });
  const foreignDelete = await request(`/api/notes/note-legacy-1/annotations/${annotationId}`, {
    cookie: cookieB, method: "DELETE", body: { baseRevision: 1 },
  });
  assert.equal(foreignPatch.response.status, 404);
  assert.equal(foreignDelete.response.status, 404);
});

test("canonical and version_bound annotation fields are mutually validated", async () => {
  const missingCanonical = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieA,
    method: "POST",
    headers: { "Idempotency-Key": "invalid-canonical" },
    body: { kind: "highlight", color: "focus", anchorScope: "canonical" },
  });
  assert.equal(missingCanonical.response.status, 422);
  const missingDisplay = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieA,
    method: "POST",
    headers: { "Idempotency-Key": "invalid-version-bound" },
    body: { kind: "comment", anchorScope: "version_bound", comment: "仅此版本" },
  });
  assert.equal(missingDisplay.response.status, 422);
});

test("Idempotency-Key creates exactly one annotation", async () => {
  const input = { kind: "highlight", color: "focus", anchorScope: "canonical", canonicalAnchor };
  const first = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieA,
    method: "POST",
    headers: { "Idempotency-Key": "annotation-once-1" },
    body: input,
  });
  const second = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieA,
    method: "POST",
    headers: { "Idempotency-Key": "annotation-once-1" },
    body: input,
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.payload));
  assert.ok([200, 201].includes(second.response.status));
  annotation = first.payload.annotation;
  assert.equal(second.payload.annotation.id, annotation.id);
  const listed = await request("/api/notes/note-legacy-1/annotations", { cookie: cookieA });
  assert.equal(listed.payload.items.filter((item) => item.id === annotation.id).length, 1);
});

test("stale annotation revision returns structured 409 without overwriting", async () => {
  assert.ok(annotation, "annotation idempotency setup must succeed before revision checks");
  const updated = await request(`/api/notes/note-legacy-1/annotations/${annotation.id}`, {
    cookie: cookieA,
    method: "PATCH",
    body: { baseRevision: annotation.revision, comment: "第一次更新" },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  const conflict = await request(`/api/notes/note-legacy-1/annotations/${annotation.id}`, {
    cookie: cookieA,
    method: "PATCH",
    body: { baseRevision: annotation.revision, comment: "过期标签页不应覆盖" },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.error.code, "REVISION_CONFLICT");
  assert.ok(Number.isInteger(conflict.payload.error.serverRevision ?? conflict.payload.serverRevision));
  assert.ok(JSON.stringify(conflict.payload).includes("第一次更新"));
  annotation = updated.payload.annotation;
});

test("overlapping highlight, underline and comments coexist and delete independently", async () => {
  const created = [];
  for (const [index, input] of [
    { kind: "underline", anchorScope: "canonical", canonicalAnchor },
    { kind: "comment", anchorScope: "canonical", canonicalAnchor, comment: "第一条批注" },
    { kind: "comment", anchorScope: "canonical", canonicalAnchor, comment: "第二条批注" },
  ].entries()) {
    const result = await request("/api/notes/note-legacy-1/annotations", {
      cookie: cookieA,
      method: "POST",
      headers: { "Idempotency-Key": `overlap-${index}` },
      body: input,
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    created.push(result.payload.annotation);
  }
  const removed = await request(`/api/notes/note-legacy-1/annotations/${annotation.id}`, {
    cookie: cookieA,
    method: "DELETE",
    body: { baseRevision: annotation.revision },
  });
  assert.equal(removed.response.status, 200);
  const listed = await request("/api/notes/note-legacy-1/annotations", { cookie: cookieA });
  const activeIds = new Set(listed.payload.items.map((item) => item.id));
  assert.ok(!activeIds.has(annotation.id));
  assert.ok(created.every((item) => activeIds.has(item.id)));
});

test("version_bound annotation stays version-local until explicit canonical reanchor", async () => {
  assert.ok(workspaceMeta, "workspace metadata setup is required");
  const readingId = workspaceMeta.activeReadingDocumentId || workspaceMeta.activeDocumentId;
  const transcriptId = workspaceMeta.activeTranscriptId;
  assert.ok(readingId && transcriptId);
  const { buildBlocks, buildAnchor, sha256Text, normalizeText } = await importPlanned("lib/transcript-workspace.mjs", [
    "buildBlocks", "buildAnchor", "sha256Text", "normalizeText",
  ]);
  const markdown = "# 核心观点\n\n第一段包含 **emoji 👩🏽‍💻**。\n\n同一句会出现。";
  const block = buildBlocks(markdown)[1];
  const start = block.text.indexOf("emoji");
  const displayAnchor = buildAnchor({
    blockId: block.id,
    blockText: block.text,
    start,
    end: start + "emoji 👩🏽‍💻".length,
    sourceDocumentSha256: sha256Text(normalizeText(markdown)),
  });
  const created = await request("/api/notes/note-legacy-1/annotations", {
    cookie: cookieA,
    method: "POST",
    headers: { "Idempotency-Key": "version-bound-1" },
    body: {
      kind: "comment",
      anchorScope: "version_bound",
      displayReadingDocumentId: readingId,
      displayAnchor,
      comment: "AI 版本限定批注",
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.annotation.anchorScope, "version_bound");
  const upgraded = await request(`/api/notes/note-legacy-1/annotations/${created.payload.annotation.id}/reanchor`, {
    cookie: cookieA,
    method: "POST",
    body: {
      baseRevision: created.payload.annotation.revision,
      documentId: readingId,
      anchor: displayAnchor,
      canonicalAnchor,
    },
  });
  assert.equal(upgraded.response.status, 200, JSON.stringify(upgraded.payload));
  assert.equal(upgraded.payload.annotation.anchorScope, "canonical");
  assert.deepEqual(upgraded.payload.annotation.canonicalAnchor, canonicalAnchor);
});

test("personal document retries are idempotent and stale tabs conflict", async () => {
  const initial = await request("/api/notes/note-legacy-1/personal-document", { cookie: cookieA });
  assert.equal(initial.response.status, 200);
  const baseRevision = initial.payload.document?.revision ?? 0;
  const body = {
    baseRevision,
    clientMutationId: "personal-save-once-1",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "我的加工稿" }] }] },
    plainText: "我的加工稿",
  };
  const first = await request("/api/notes/note-legacy-1/personal-document", { cookie: cookieA, method: "PUT", body });
  const retry = await request("/api/notes/note-legacy-1/personal-document", { cookie: cookieA, method: "PUT", body });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(retry.response.status, 200);
  assert.equal(retry.payload.document.revision, first.payload.document.revision);

  const stale = await request("/api/notes/note-legacy-1/personal-document", {
    cookie: cookieA,
    method: "PUT",
    body: { ...body, clientMutationId: "stale-tab-2", plainText: "来自过期标签页" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error.code, "REVISION_CONFLICT");
});

test("personal document rejects script nodes, event attributes, and javascript links", async () => {
  for (const contentJson of [
    { type: "doc", content: [{ type: "script", content: [{ type: "text", text: "alert(1)" }] }] },
    { type: "doc", content: [{ type: "image", attrs: { src: "x", onerror: "alert(1)" } }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] },
  ]) {
    const result = await request("/api/notes/note-legacy-1/personal-document", {
      cookie: cookieA,
      method: "PUT",
      body: { baseRevision: 1, clientMutationId: `xss-${Math.random()}`, contentJson, plainText: "bad" },
    });
    assert.equal(result.response.status, 422, JSON.stringify(result.payload));
  }
});

test("action item routes list, update and delete while preserving legacy pending items", async () => {
  const legacy = await request("/api/action-items?status=pending&inspirationId=note-legacy-1", { cookie: cookieA });
  assert.equal(legacy.response.status, 200, JSON.stringify(legacy.payload));
  assert.ok(legacy.payload.items.length >= 1, "legacy pending note must be consumable as an action item");
  const created = await request("/api/notes/note-legacy-1/action-items", { cookie: cookieA, method: "POST", body: { title: "接口待实践", note: "保留来源" } });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const item = created.payload.item;
  const foreign = await request(`/api/action-items/${item.id}`, { cookie: cookieB, method: "PATCH", body: { baseRevision: item.revision, status: "completed" } });
  assert.equal(foreign.response.status, 404);
  const updated = await request(`/api/action-items/${item.id}`, { cookie: cookieA, method: "PATCH", body: { baseRevision: item.revision, status: "completed" } });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.item.status, "completed");
  const conflict = await request(`/api/action-items/${item.id}`, { cookie: cookieA, method: "PATCH", body: { baseRevision: item.revision, note: "过期覆盖" } });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.error.code, "REVISION_CONFLICT");
  const removed = await request(`/api/action-items/${item.id}`, { cookie: cookieA, method: "DELETE", body: { baseRevision: updated.payload.item.revision } });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.payload));
});

test("cover assets remain available with dist builds and reject traversal", async () => {
  const cover = await fetch(`${baseUrl}/covers/c17f3cca84ece15e669e872e.jpg`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get("content-type"), "image/jpeg");
  assert.ok((await cover.arrayBuffer()).byteLength > 0);
  const traversal = await fetch(`${baseUrl}/covers/%2e%2e/server.mjs`);
  assert.equal(traversal.status, 404);
});

test("deleting an inspiration removes access to all workspace resources", async () => {
  const deleted = await request("/api/notes/note-legacy-1", { cookie: cookieA, method: "DELETE" });
  assert.equal(deleted.response.status, 200);
  for (const path of [
    "/api/notes/note-legacy-1/workspace",
    "/api/notes/note-legacy-1/annotations",
    "/api/notes/note-legacy-1/personal-document",
  ]) {
    const result = await request(path, { cookie: cookieA });
    assert.equal(result.response.status, 404, `${path} remained accessible after cascade delete`);
  }
});
