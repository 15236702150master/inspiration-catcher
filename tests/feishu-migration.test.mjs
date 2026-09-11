import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.mjs";
import { SCHEMA_VERSION } from "../lib/migrations.mjs";

const now = "2026-07-27T00:00:00.000Z";

function insertInspiration(db, id, ownerId) {
  db.prepare(`INSERT INTO inspirations
    (id,owner_id,title,url,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(id, ownerId, `title-${id}`, `https://example.test/${id}`, now, now);
}

function insertConnection(db, { id, ownerId }) {
  db.prepare(`INSERT INTO feishu_connections
    (id,owner_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,
     connected_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id,
    ownerId,
    `enc-access-${ownerId}`,
    `enc-refresh-${ownerId}`,
    "2026-07-27T01:00:00.000Z",
    now,
    now,
    now,
  );
}

test("schema v4 upgrades an existing workspace without losing notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inspiration-feishu-v3-"));
  const databasePath = join(root, "workspace.sqlite");
  const first = openDatabase({ databasePath, migrateLegacy: false });
  insertInspiration(first, "existing-note", "owner-a");
  first.exec(`
    DROP TABLE integration_oauth_states;
    DROP TABLE sync_outbox;
    DROP TABLE feishu_document_bindings;
    DROP TABLE feishu_connections;
    DELETE FROM schema_migrations WHERE version=3;
  `);
  first.close();

  const upgraded = openDatabase({ databasePath, migrateLegacy: false });
  t.after(async () => {
    upgraded.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(upgraded.prepare("SELECT title FROM inspirations WHERE id='existing-note'").get().title, "title-existing-note");
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=4").get().count, 1);
  const tables = new Set(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of [
    "feishu_connections",
    "feishu_document_bindings",
    "sync_outbox",
    "integration_oauth_states",
    "inspiration_libraries",
    "inspiration_library_assignments",
    "feishu_library_bindings",
  ]) assert.ok(tables.has(table), `${table} was not created by schema v4`);
  const assignment = upgraded.prepare(`SELECT a.library_id,l.name,l.is_default FROM inspiration_library_assignments a
    JOIN inspiration_libraries l ON l.id=a.library_id WHERE a.inspiration_id='existing-note'`).get();
  assert.deepEqual(assignment, { library_id: "library-default-owner-a", name: "待分类", is_default: 1 });
});

test("schema v3 keeps connections and remote mappings owner-scoped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inspiration-feishu-owner-"));
  const db = openDatabase({ databasePath: join(root, "workspace.sqlite"), migrateLegacy: false });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  insertInspiration(db, "note-a", "owner-a");
  insertInspiration(db, "note-b", "owner-b");
  insertConnection(db, { id: "connection-a", ownerId: "owner-a" });
  insertConnection(db, { id: "connection-b", ownerId: "owner-b" });

  const insertBinding = db.prepare(`INSERT INTO feishu_document_bindings
    (id,owner_id,connection_id,inspiration_id,wiki_node_token,docx_document_id,
     bitable_record_id,document_url,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertBinding.run("binding-a", "owner-a", "connection-a", "note-a", "wiki-a", "doc-a", "record-a", "https://feishu.test/doc-a", now, now);
  insertBinding.run("binding-b", "owner-b", "connection-b", "note-b", "wiki-b", "doc-b", "record-b", "https://feishu.test/doc-b", now, now);

  assert.deepEqual(
    db.prepare("SELECT docx_document_id FROM feishu_document_bindings WHERE owner_id=?").all("owner-a"),
    [{ docx_document_id: "doc-a" }],
  );
  assert.throws(
    () => insertBinding.run("binding-a-duplicate", "owner-a", "connection-a", "note-a", null, null, null, null, now, now),
    /UNIQUE constraint failed/,
  );

  const foreignKeys = db.prepare("PRAGMA foreign_key_list(feishu_document_bindings)").all();
  const connectionForeignKey = foreignKeys.find((item) => item.from === "connection_id");
  assert.equal(connectionForeignKey?.on_delete, "SET NULL", "disconnect must retain remote mapping metadata");

  db.prepare("DELETE FROM feishu_connections WHERE owner_id=?").run("owner-a");
  const retained = db.prepare(`SELECT owner_id,connection_id,wiki_node_token,docx_document_id,
    bitable_record_id,document_url FROM feishu_document_bindings WHERE id='binding-a'`).get();
  assert.deepEqual(retained, {
    owner_id: "owner-a",
    connection_id: null,
    wiki_node_token: "wiki-a",
    docx_document_id: "doc-a",
    bitable_record_id: "record-a",
    document_url: "https://feishu.test/doc-a",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM feishu_connections WHERE owner_id='owner-b'").get().count, 1);
});

test("schema stores OAuth state, ciphertext and outbox ownership explicitly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inspiration-feishu-columns-"));
  const db = openDatabase({ databasePath: join(root, "workspace.sqlite"), migrateLegacy: false });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const name of [
    "owner_id", "access_token_ciphertext", "refresh_token_ciphertext", "tenant_key",
    "space_id", "parent_node_token", "bitable_app_token", "bitable_table_id", "status",
  ]) assert.ok(columns("feishu_connections").has(name), `feishu_connections.${name} is required`);
  for (const name of ["owner_id", "app_id", "app_secret_ciphertext", "created_at", "updated_at"]) {
    assert.ok(columns("feishu_app_credentials").has(name), `feishu_app_credentials.${name} is required`);
  }
  for (const name of [
    "owner_id", "inspiration_id", "wiki_node_token", "docx_document_id", "bitable_record_id",
    "section_blocks_json", "source_hash", "sync_status", "last_error_code", "library_id",
    "space_id", "parent_wiki_node_token", "last_moved_at",
  ]) assert.ok(columns("feishu_document_bindings").has(name), `feishu_document_bindings.${name} is required`);
  for (const name of ["owner_id", "name", "is_default", "sort_order", "deleted_at"]) {
    assert.ok(columns("inspiration_libraries").has(name), `inspiration_libraries.${name} is required`);
  }
  for (const name of ["owner_id", "connection_id", "library_id", "space_id", "wiki_node_token", "docx_document_id", "status"]) {
    assert.ok(columns("feishu_library_bindings").has(name), `feishu_library_bindings.${name} is required`);
  }
  for (const name of [
    "owner_id", "aggregate_id", "dedupe_key", "active_key", "status", "attempts",
    "lease_expires_at", "available_at", "last_error_details_json",
  ]) assert.ok(columns("sync_outbox").has(name), `sync_outbox.${name} is required`);
  for (const name of [
    "owner_id", "state_hash", "code_verifier_ciphertext", "redirect_uri", "expires_at", "consumed_at",
  ]) assert.ok(columns("integration_oauth_states").has(name), `integration_oauth_states.${name} is required`);
});
