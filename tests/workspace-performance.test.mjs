import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { importPlanned } from "./helpers/planned-module.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureDirectory = resolve(import.meta.dirname, "fixtures/legacy-workspace");
const firstInteractiveLimitMs = 2_000;
const annotationApiLimitMs = 1_000;
const workspacePayloadLimit = 128 * 1024;

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

function renderedText(blocks) {
  return blocks.map((block) => String(block.text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")).join("\n");
}

test("100k Chinese characters and 500 annotations stay paged and interactive", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inspiration-performance-"));
  const dataDirectory = join(root, "data");
  await cp(fixtureDirectory, dataDirectory, { recursive: true });

  const paragraph = "这是用于验证长篇视频转写阅读性能的中文内容，包含观点、证据、方法和行动步骤。".repeat(30);
  const paragraphs = Array.from({ length: 150 }, (_, index) => `${index + 1}。${paragraph}`);
  const longText = paragraphs.join("\n\n");
  assert.ok(longText.length >= 100_000, `fixture is only ${longText.length} characters`);
  const notesPath = join(dataDirectory, "notes.json");
  const notes = JSON.parse(await readFile(notesPath, "utf8"));
  notes[0].transcript = longText;
  notes[0].formattedTranscript = `# 十万字压力测试\n\n${longText}`;
  await writeFile(notesPath, `${JSON.stringify(notes, null, 2)}\n`, "utf8");

  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(projectRoot, "server.mjs")], {
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
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await Promise.race([new Promise((resolveExit) => server.once("exit", resolveExit)), delay(2_000)]);
    }
    await rm(root, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error(`performance server exited (${server.exitCode}): ${stderr}`);
    await delay(25);
  }

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner-a@example.test", password: "owner-a-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      cookie,
      ...options.headers,
    },
  });

  const workspaceStart = performance.now();
  const workspaceResponse = await request("/api/notes/note-legacy-1/workspace");
  const workspaceText = await workspaceResponse.text();
  const workspaceMs = performance.now() - workspaceStart;
  assert.equal(workspaceResponse.status, 200);
  assert.ok(workspaceMs < firstInteractiveLimitMs, `workspace metadata took ${workspaceMs.toFixed(1)}ms`);
  assert.ok(Buffer.byteLength(workspaceText) <= workspacePayloadLimit, `workspace payload is ${Buffer.byteLength(workspaceText)} bytes`);
  assert.ok(!workspaceText.includes(longText.slice(0, 1_000)), "workspace metadata inlined the long transcript");
  const workspace = JSON.parse(workspaceText).workspace;
  assert.ok(workspace.activeDocumentId);

  const documentStart = performance.now();
  const documentResponse = await request(`/api/notes/note-legacy-1/documents/${workspace.activeDocumentId}`);
  const documentPayload = await documentResponse.json();
  const rendered = renderedText(documentPayload.document.blocks);
  const documentRenderMs = performance.now() - documentStart;
  assert.equal(documentResponse.status, 200);
  assert.ok(rendered.length >= 100_000);
  assert.ok(documentRenderMs < firstInteractiveLimitMs, `document fetch + block render preparation took ${documentRenderMs.toFixed(1)}ms`);

  const { buildBlocks, buildAnchor, normalizeText, sha256Text } = await importPlanned("lib/transcript-workspace.mjs", [
    "buildBlocks", "buildAnchor", "normalizeText", "sha256Text",
  ]);
  const rawBlock = buildBlocks(longText)[0];
  const canonicalAnchor = buildAnchor({
    blockId: rawBlock.id,
    blockText: rawBlock.text,
    start: 0,
    end: Math.min(24, rawBlock.text.length),
    sourceDocumentSha256: sha256Text(normalizeText(longText)),
  });
  const annotationInput = (index) => JSON.stringify({
    kind: index % 5 === 0 ? "comment" : "highlight",
    color: ["key", "action", "evidence", "doubt"][index % 4],
    comment: index % 5 === 0 ? `性能批注 ${index}` : "",
    anchorScope: "canonical",
    sourceTranscriptVersionId: workspace.activeTranscriptId,
    canonicalAnchor,
  });

  const createStart = performance.now();
  const firstCreated = await request("/api/notes/note-legacy-1/annotations", {
    method: "POST",
    headers: { "Idempotency-Key": "performance-annotation-0" },
    body: annotationInput(0),
  });
  const singleCreateMs = performance.now() - createStart;
  assert.equal(firstCreated.status, 201);
  assert.ok(singleCreateMs < annotationApiLimitMs, `single annotation create took ${singleCreateMs.toFixed(1)}ms`);

  for (let start = 1; start < 500; start += 25) {
    const batch = Array.from({ length: Math.min(25, 500 - start) }, (_, offset) => start + offset);
    const results = await Promise.all(batch.map((index) => request("/api/notes/note-legacy-1/annotations", {
      method: "POST",
      headers: { "Idempotency-Key": `performance-annotation-${index}` },
      body: annotationInput(index),
    })));
    assert.ok(results.every((response) => response.status === 201));
  }

  const ids = new Set();
  let cursor = "";
  let pageCount = 0;
  let slowestListMs = 0;
  do {
    const listStart = performance.now();
    const response = await request(`/api/notes/note-legacy-1/annotations?status=&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const payload = await response.json();
    slowestListMs = Math.max(slowestListMs, performance.now() - listStart);
    assert.equal(response.status, 200);
    assert.ok(payload.items.length <= 100);
    payload.items.forEach((item) => ids.add(item.id));
    cursor = payload.nextCursor || "";
    pageCount += 1;
  } while (cursor && pageCount < 10);
  assert.equal(ids.size, 500);
  assert.ok(pageCount >= 5, `500 annotations were returned in only ${pageCount} pages`);
  assert.ok(slowestListMs < annotationApiLimitMs, `slowest annotation page took ${slowestListMs.toFixed(1)}ms`);

  const loadedWorkspace = await request("/api/notes/note-legacy-1/workspace");
  const loadedWorkspaceText = await loadedWorkspace.text();
  const loadedWorkspacePayload = JSON.parse(loadedWorkspaceText).workspace;
  assert.ok(Buffer.byteLength(loadedWorkspaceText) <= workspacePayloadLimit, `500 annotations inflated workspace to ${Buffer.byteLength(loadedWorkspaceText)} bytes`);
  assert.ok(loadedWorkspacePayload.annotations.length > 0 && loadedWorkspacePayload.annotations.length <= 100, "workspace must return a bounded initial annotation slice");
  assert.ok(!loadedWorkspaceText.includes(longText.slice(0, 1_000)));

  t.diagnostic(JSON.stringify({
    characters: longText.length,
    annotations: ids.size,
    workspaceBytes: Buffer.byteLength(loadedWorkspaceText),
    workspaceMs: Number(workspaceMs.toFixed(1)),
    documentRenderMs: Number(documentRenderMs.toFixed(1)),
    singleCreateMs: Number(singleCreateMs.toFixed(1)),
    slowestListMs: Number(slowestListMs.toFixed(1)),
    annotationPages: pageCount,
  }));
});
