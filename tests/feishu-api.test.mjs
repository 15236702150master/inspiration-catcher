import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureDir = resolve(import.meta.dirname, "fixtures/legacy-workspace");
let root;
let databasePath;
let baseUrl;
let server;
let cookieA;
let cookieB;

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function request(path, { cookie, body, headers, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: options.redirect || "manual",
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { payload = text; }
  return { response, payload };
}

async function login(email, password) {
  const { response, payload } = await request("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  return response.headers.get("set-cookie").split(";", 1)[0];
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "inspiration-feishu-api-"));
  const dataDirectory = join(root, "data");
  await cp(fixtureDir, dataDirectory, { recursive: true });
  databasePath = join(root, "workspace.sqlite");
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIRECTORY: dataDirectory,
    DATABASE_PATH: databasePath,
    NODE_ENV: "test",
  };
  for (const name of [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "INTEGRATION_ENCRYPTION_KEY",
    "FEISHU_REDIRECT_URI",
    "PUBLIC_BASE_URL",
    "APP_BASE_URL",
  ]) delete env[name];
  server = spawn(process.execPath, [join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env,
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

test("Feishu integration status requires a website session", async () => {
  const { response, payload } = await request("/api/integrations/feishu/status");
  assert.equal(response.status, 401, JSON.stringify(payload));
  assert.equal(payload.error.code, "AUTH_REQUIRED");
});

test("unconfigured status exposes setup instructions and callback without secrets", async () => {
  for (const cookie of [cookieA, cookieB]) {
    const { response, payload } = await request("/api/integrations/feishu/status", { cookie });
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.configured, false);
    assert.equal(payload.status, "not_configured");
    assert.equal(payload.callbackUrl, `${baseUrl}/api/integrations/feishu/oauth/callback`);
    assert.deepEqual(payload.missingEnvironment.sort(), [
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "INTEGRATION_ENCRYPTION_KEY",
    ].sort());
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("app-secret"));
    assert.ok(!serialized.includes("access_token"));
    assert.ok(!serialized.includes("refresh_token"));
  }
});

test("status uses the public HTTPS origin supplied by the reverse proxy", async () => {
  const { response, payload } = await request("/api/integrations/feishu/status", {
    cookie: cookieA,
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "inspiration.zzhhh.site",
    },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.callbackUrl, "https://inspiration.zzhhh.site/api/integrations/feishu/oauth/callback");
});

test("OAuth start fails structurally when server credentials are absent", async () => {
  const { response, payload } = await request("/api/integrations/feishu/oauth/start", {
    cookie: cookieA,
    method: "POST",
    body: { returnTo: "/history" },
  });
  assert.equal(response.status, 503, JSON.stringify(payload));
  assert.equal(payload.error.code, "FEISHU_NOT_CONFIGURED");
  assert.ok(Array.isArray(payload.error.details?.missingEnvironment));
});

test("notes, workspaces, tags and ordinary saves remain usable without Feishu", async () => {
  const notes = await request("/api/notes", { cookie: cookieA });
  assert.equal(notes.response.status, 200, JSON.stringify(notes.payload));
  assert.ok(notes.payload.items.some((item) => item.id === "note-legacy-1"));

  const workspace = await request("/api/notes/note-legacy-1/workspace", { cookie: cookieA });
  assert.equal(workspace.response.status, 200, JSON.stringify(workspace.payload));
  const tags = await request("/api/tags", { cookie: cookieA });
  assert.equal(tags.response.status, 200, JSON.stringify(tags.payload));

  const created = await request("/api/notes", {
    cookie: cookieA,
    method: "POST",
    body: {
      url: "https://example.test/no-feishu-save",
      title: "未配置飞书也能保存",
      note: "这是普通保存流程。",
      tags: [],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.item.title, "未配置飞书也能保存");

  const database = new Database(databasePath, { readonly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feishu_connections").get().count, 0);
  } finally {
    database.close();
  }
});

test("inspiration libraries are owner scoped and deleting one moves its notes to the default library", async () => {
  const initialA = await request("/api/libraries", { cookie: cookieA });
  const initialB = await request("/api/libraries", { cookie: cookieB });
  assert.equal(initialA.response.status, 200, JSON.stringify(initialA.payload));
  assert.equal(initialB.response.status, 200, JSON.stringify(initialB.payload));
  const defaultA = initialA.payload.items.find(item => item.isDefault);
  const defaultB = initialB.payload.items.find(item => item.isDefault);
  assert.equal(defaultA.name, "待分类");
  assert.notEqual(defaultA.id, defaultB.id);

  const createdLibrary = await request("/api/libraries", {
    cookie: cookieA,
    method: "POST",
    body: { name: "工作方法" },
  });
  assert.equal(createdLibrary.response.status, 201, JSON.stringify(createdLibrary.payload));
  const libraryId = createdLibrary.payload.library.id;

  const renamed = await request(`/api/libraries/${libraryId}`, {
    cookie: cookieA,
    method: "PATCH",
    body: { name: "团队协作" },
  });
  assert.equal(renamed.response.status, 200, JSON.stringify(renamed.payload));
  assert.equal(renamed.payload.library.name, "团队协作");

  const foreignRename = await request(`/api/libraries/${libraryId}`, {
    cookie: cookieB,
    method: "PATCH",
    body: { name: "越权修改" },
  });
  assert.equal(foreignRename.response.status, 404, JSON.stringify(foreignRename.payload));

  const note = await request("/api/notes", {
    cookie: cookieA,
    method: "POST",
    body: {
      url: "https://example.test/library-note",
      title: "归档测试",
      note: "保存时直接选择灵感库。",
      libraryId,
      tags: [],
    },
  });
  assert.equal(note.response.status, 201, JSON.stringify(note.payload));
  assert.equal(note.payload.item.libraryId, libraryId);

  const foreignMove = await request(`/api/notes/${note.payload.item.id}/move-library`, {
    cookie: cookieB,
    method: "POST",
    body: { libraryId },
  });
  assert.equal(foreignMove.response.status, 404, JSON.stringify(foreignMove.payload));

  const deleted = await request(`/api/libraries/${libraryId}`, { cookie: cookieA, method: "DELETE" });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.movedNotes, 1);
  assert.equal(deleted.payload.fallbackLibraryId, defaultA.id);

  const notesAfter = await request("/api/notes", { cookie: cookieA });
  const movedNote = notesAfter.payload.items.find(item => item.id === note.payload.item.id);
  assert.equal(movedNote.libraryId, defaultA.id);
  assert.equal(movedNote.libraryName, "待分类");

  const deleteDefault = await request(`/api/libraries/${defaultA.id}`, { cookie: cookieA, method: "DELETE" });
  assert.equal(deleteDefault.response.status, 422, JSON.stringify(deleteDefault.payload));
  assert.equal(deleteDefault.payload.error.code, "LIBRARY_DEFAULT");
});

test("note, analysis and tag mutations enqueue owner-scoped projection refreshes", async () => {
  const database = new Database(databasePath);
  const timestamp = new Date().toISOString();
  try {
    database.prepare(`INSERT INTO feishu_connections
      (id,owner_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,
       status,connected_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'connected',?,?,?)`).run(
      "connection-owner-a",
      "user-owner-a",
      "test-ciphertext-access",
      "test-ciphertext-refresh",
      new Date(Date.now() + 3_600_000).toISOString(),
      timestamp,
      timestamp,
      timestamp,
    );
  } finally {
    database.close();
  }

  const created = await request("/api/notes", {
    cookie: cookieA,
    method: "POST",
    body: {
      url: "https://example.test/queued-note",
      title: "只保存感想也要进入飞书队列",
      note: "这条记录没有转写和阅读版。",
      tags: [],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));

  let writer = new Database(databasePath);
  try {
    const queued = writer.prepare("SELECT * FROM sync_outbox WHERE owner_id=? AND aggregate_id=? AND active_key IS NOT NULL")
      .get("user-owner-a", created.payload.item.id);
    assert.equal(queued?.status, "pending");
    assert.equal(queued?.event_kind, "inspiration_created");
    assert.equal(writer.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE owner_id='user-owner-b'").get().count, 0);
  } finally {
    writer.close();
  }

  writer = new Database(databasePath, { readonly: true });
  const analysis = writer.prepare("SELECT id,inspiration_id FROM analyses WHERE owner_id=? LIMIT 1").get("user-owner-a");
  const assignedTag = writer.prepare(`SELECT t.id FROM tags t
    JOIN inspiration_tags it ON it.tag_id=t.id
    WHERE t.owner_id=? AND it.inspiration_id=? LIMIT 1`).get("user-owner-a", analysis.inspiration_id);
  writer.close();
  assert.ok(analysis?.id && assignedTag?.id, "legacy fixture must include an analysis and an assigned tag");

  const deletedAnalysis = await request(`/api/analyses/${analysis.id}`, { cookie: cookieA, method: "DELETE" });
  assert.equal(deletedAnalysis.response.status, 200, JSON.stringify(deletedAnalysis.payload));
  writer = new Database(databasePath, { readonly: true });
  const afterAnalysis = writer.prepare("SELECT revision FROM sync_outbox WHERE owner_id=? AND aggregate_id=? AND active_key IS NOT NULL")
    .get("user-owner-a", analysis.inspiration_id);
  writer.close();
  assert.ok(afterAnalysis?.revision >= 1);

  const group = await request("/api/tags/groups", {
    cookie: cookieA,
    method: "POST",
    body: { name: "飞书测试分组" },
  });
  assert.equal(group.response.status, 201, JSON.stringify(group.payload));
  const moved = await request(`/api/tags/${assignedTag.id}/move`, {
    cookie: cookieA,
    method: "POST",
    body: { groupId: group.payload.group.id },
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.payload));

  writer = new Database(databasePath, { readonly: true });
  try {
    const afterTagMove = writer.prepare("SELECT revision,status FROM sync_outbox WHERE owner_id=? AND aggregate_id=? AND active_key IS NOT NULL")
      .get("user-owner-a", analysis.inspiration_id);
    assert.equal(afterTagMove?.status, "pending");
    assert.ok(afterTagMove.revision > afterAnalysis.revision);
    assert.equal(writer.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE owner_id=? AND aggregate_id=? AND active_key IS NOT NULL")
      .get("user-owner-a", analysis.inspiration_id).count, 1);
  } finally {
    writer.close();
  }
});

test("Feishu archive removes notes from My Inspirations while saving and keeps them recoverable for status checks", async () => {
  const timestamp = new Date().toISOString();
  let writer = new Database(databasePath);
  try {
    writer.prepare("DELETE FROM feishu_connections WHERE owner_id=?").run("user-owner-a");
    writer.prepare(`INSERT INTO feishu_connections
      (id,owner_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,
       status,connected_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'connected',?,?,?)`).run(
      "archive-connection-owner-a",
      "user-owner-a",
      "test-ciphertext-access",
      "test-ciphertext-refresh",
      new Date(Date.now() + 3_600_000).toISOString(),
      timestamp,
      timestamp,
      timestamp,
    );
  } finally {
    writer.close();
  }

  const created = await request("/api/notes", {
    cookie: cookieA,
    method: "POST",
    body: {
      url: "https://example.test/archive-single",
      title: "单条归档到飞书",
      note: "先在网站标注，确认后归档。",
      tags: [],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const noteId = created.payload.item.id;

  const archived = await request(`/api/integrations/feishu/sync/${noteId}`, {
    cookie: cookieA,
    method: "POST",
    body: {},
  });
  assert.equal(archived.response.status, 202, JSON.stringify(archived.payload));
  assert.equal(archived.payload.archiveStatus, "feishu_archiving");

  writer = new Database(databasePath);
  try {
    const note = writer.prepare("SELECT status FROM inspirations WHERE id=? AND owner_id=?").get(noteId, "user-owner-a");
    assert.equal(note.status, "feishu_archiving");
    const outbox = writer.prepare("SELECT event_kind,payload_json FROM sync_outbox WHERE aggregate_id=? AND owner_id=? AND active_key IS NOT NULL")
      .get(noteId, "user-owner-a");
    assert.equal(outbox.event_kind, "feishu_archive");
    assert.equal(JSON.parse(outbox.payload_json).archiveAfterSync, true);
  } finally {
    writer.close();
  }

  const duringArchive = await request("/api/notes", { cookie: cookieA });
  assert.equal(duringArchive.response.status, 200, JSON.stringify(duringArchive.payload));
  assert.equal(duringArchive.payload.items.some(item => item.id === noteId), false);

  const includedDuringArchive = await request("/api/notes?includeArchived=1", { cookie: cookieA });
  assert.equal(includedDuringArchive.response.status, 200, JSON.stringify(includedDuringArchive.payload));
  assert.ok(includedDuringArchive.payload.items.some(item => item.id === noteId && item.status === "feishu_archiving"));

  writer = new Database(databasePath);
  try {
    writer.prepare("UPDATE inspirations SET status='feishu_archived' WHERE id=? AND owner_id=?").run(noteId, "user-owner-a");
  } finally {
    writer.close();
  }

  const hidden = await request("/api/notes", { cookie: cookieA });
  assert.equal(hidden.response.status, 200, JSON.stringify(hidden.payload));
  assert.equal(hidden.payload.items.some(item => item.id === noteId), false);
  const included = await request("/api/notes?includeArchived=1", { cookie: cookieA });
  assert.equal(included.response.status, 200, JSON.stringify(included.payload));
  assert.ok(included.payload.items.some(item => item.id === noteId && item.status === "feishu_archived"));
});

test("Feishu library archive only queues notes in the selected owner library", async () => {
  const timestamp = new Date().toISOString();
  let writer = new Database(databasePath);
  try {
    writer.prepare("DELETE FROM feishu_connections WHERE owner_id=?").run("user-owner-a");
    writer.prepare(`INSERT INTO feishu_connections
      (id,owner_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,
       status,connected_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'connected',?,?,?)`).run(
      "archive-library-connection-owner-a",
      "user-owner-a",
      "test-ciphertext-access",
      "test-ciphertext-refresh",
      new Date(Date.now() + 3_600_000).toISOString(),
      timestamp,
      timestamp,
      timestamp,
    );
  } finally {
    writer.close();
  }

  const library = await request("/api/libraries", {
    cookie: cookieA,
    method: "POST",
    body: { name: "待归档库" },
  });
  assert.equal(library.response.status, 201, JSON.stringify(library.payload));
  const libraryId = library.payload.library.id;
  const first = await request("/api/notes", {
    cookie: cookieA,
    method: "POST",
    body: { url: "https://example.test/archive-library-1", title: "整库归档 1", note: "A", libraryId, tags: [] },
  });
  const second = await request("/api/notes", {
    cookie: cookieA,
    method: "POST",
    body: { url: "https://example.test/archive-library-2", title: "整库归档 2", note: "B", libraryId, tags: [] },
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.payload));
  assert.equal(second.response.status, 201, JSON.stringify(second.payload));

  const foreignArchive = await request(`/api/integrations/feishu/archive-library/${libraryId}`, {
    cookie: cookieB,
    method: "POST",
    body: {},
  });
  assert.equal(foreignArchive.response.status, 404, JSON.stringify(foreignArchive.payload));

  const queued = await request(`/api/integrations/feishu/archive-library/${libraryId}`, {
    cookie: cookieA,
    method: "POST",
    body: {},
  });
  assert.equal(queued.response.status, 202, JSON.stringify(queued.payload));
  assert.equal(queued.payload.total, 2);
  assert.equal(queued.payload.queued, 2);

  writer = new Database(databasePath, { readonly: true });
  try {
    const ids = [first.payload.item.id, second.payload.item.id];
    const rows = writer.prepare(`SELECT aggregate_id,event_kind FROM sync_outbox
      WHERE owner_id=? AND aggregate_id IN (?,?) AND active_key IS NOT NULL
      ORDER BY aggregate_id`).all("user-owner-a", ...ids);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.event_kind === "feishu_archive"));
    assert.equal(writer.prepare(`SELECT COUNT(*) AS count FROM sync_outbox
      WHERE owner_id=? AND aggregate_id IN (?,?)`).get("user-owner-b", ...ids).count, 0);
    assert.equal(writer.prepare(`SELECT COUNT(*) AS count FROM inspirations
      WHERE owner_id=? AND id IN (?,?) AND status='feishu_archiving'`).get("user-owner-a", ...ids).count, 2);
  } finally {
    writer.close();
  }
});
