import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../lib/db.mjs";
import { WorkspaceStore } from "../lib/workspace-store.mjs";
import { importPlanned, unwrapDatabase } from "./helpers/planned-module.mjs";

const fixtureDir = resolve(import.meta.dirname, "fixtures/legacy-workspace");

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function one(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

test("legacy JSON migration is lossless, relational, and idempotent", async (t) => {
  const [{ openDatabase }, { migrateLegacyJson }] = await Promise.all([
    importPlanned("lib/db.mjs", ["openDatabase"]),
    importPlanned("lib/migrations.mjs", ["migrateLegacyJson"]),
  ]);
  const root = await mkdtemp(join(tmpdir(), "inspiration-migration-"));
  const dataDirectory = join(root, "data");
  await cp(fixtureDir, dataDirectory, { recursive: true });

  const opened = await openDatabase({
    databasePath: join(root, "workspace.sqlite"),
    dataDirectory,
    migrateLegacy: false,
  });
  const db = unwrapDatabase(opened);
  t.after(async () => {
    if (opened?.close) opened.close(); else db.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await migrateLegacyJson(db, { dataDirectory });
  const countsAfterFirst = Object.fromEntries([
    "inspirations",
    "transcript_versions",
    "reading_documents",
    "analyses",
    "transcription_jobs",
    "tag_groups",
    "tags",
    "inspiration_tags",
    "action_items",
  ].map((table) => [table, one(db, `SELECT COUNT(*) AS count FROM ${table}`).count]));
  const second = await migrateLegacyJson(db, { dataDirectory });
  const countsAfterSecond = Object.fromEntries(
    Object.keys(countsAfterFirst).map((table) => [table, one(db, `SELECT COUNT(*) AS count FROM ${table}`).count]),
  );

  assert.deepEqual(countsAfterSecond, countsAfterFirst, "running migration twice must not duplicate rows");
  assert.ok(first && second, "migration must return an auditable report");

  const store = new WorkspaceStore(db);
  const latestTranscript = store.createTranscriptVersion("user-owner-a", "note-legacy-1", { rawText: "重新转写后的新版本。", originJobId: "job-after-migration" });
  const latestDocument = store.createReadingDocument("user-owner-a", "note-legacy-1", { transcriptVersionId: latestTranscript.id, markdown: "# 新阅读版本\n\n重新转写后的新版本。" });
  await migrateLegacyJson(db, { dataDirectory });
  const activeAfterRestart = one(db, "SELECT active_transcript_id,active_reading_document_id FROM inspirations WHERE id=?", ["note-legacy-1"]);
  assert.equal(activeAfterRestart.active_transcript_id, latestTranscript.id, "compatibility import reset the active transcript pointer");
  assert.equal(activeAfterRestart.active_reading_document_id, latestDocument.id, "compatibility import reset the active reading pointer");

  const inspiration = one(db, "SELECT * FROM inspirations WHERE id = ?", ["note-legacy-1"]);
  assert.equal(inspiration.owner_id, "user-owner-a");
  assert.equal(inspiration.thumbnail, "/covers/c17f3cca84ece15e669e872e.jpg");
  assert.equal(inspiration.platform, "bilibili");
  assert.equal(inspiration.author, "测试作者");
  assert.equal(inspiration.duration, 125);
  assert.equal(inspiration.quick_thought, "这是原有的快速感想，不应进入加工稿。");
  assert.equal(inspiration.transcription_status, "completed");

  const transcript = one(db, "SELECT * FROM transcript_versions WHERE inspiration_id = ? AND version_no=1", ["note-legacy-1"]);
  const legacy = JSON.parse(await readFile(join(dataDirectory, "notes.json"), "utf8"))[0];
  assert.equal(transcript.raw_text, legacy.transcript, "raw transcript bytes must remain auditable");
  assert.match(transcript.sha256, /^[a-f0-9]{64}$/);
  assert.equal(inspiration.active_transcript_id, latestTranscript.id);

  const reading = one(db, "SELECT * FROM reading_documents WHERE inspiration_id = ? AND version_no=1", ["note-legacy-1"]);
  assert.equal(reading.markdown, legacy.formattedTranscript);
  assert.equal(inspiration.active_reading_document_id, latestDocument.id);
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM personal_documents").count, 0);

  assert.equal(one(db, "SELECT inspiration_id FROM analyses WHERE id = ?", ["analysis-legacy-1"]).inspiration_id, "note-legacy-1");
  assert.equal(one(db, "SELECT status FROM transcription_jobs WHERE id = ?", ["job-active-1"]).status, "transcribing");
  assert.equal(rows(db, "SELECT name FROM tags ORDER BY name").length, 2);
  assert.equal(rows(db, "SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?", ["note-legacy-1"]).length, 2);
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM action_items WHERE inspiration_id = ?", ["note-legacy-1"]).count, 1);
});

test("foreign-key cascade removes the whole inspiration workspace atomically", async (t) => {
  const [{ openDatabase }, { migrateLegacyJson }] = await Promise.all([
    importPlanned("lib/db.mjs", ["openDatabase"]),
    importPlanned("lib/migrations.mjs", ["migrateLegacyJson"]),
  ]);
  const root = await mkdtemp(join(tmpdir(), "inspiration-cascade-"));
  const dataDirectory = join(root, "data");
  await cp(fixtureDir, dataDirectory, { recursive: true });
  const opened = await openDatabase({ databasePath: join(root, "workspace.sqlite"), dataDirectory, migrateLegacy: false });
  const db = unwrapDatabase(opened);
  t.after(async () => {
    if (opened?.close) opened.close(); else db.close();
    await rm(root, { recursive: true, force: true });
  });
  await migrateLegacyJson(db, { dataDirectory });

  db.prepare("DELETE FROM inspirations WHERE id = ?").run("note-legacy-1");
  for (const table of ["transcript_versions", "reading_documents", "analyses", "transcription_jobs", "inspiration_tags", "action_items"]) {
    assert.equal(one(db, `SELECT COUNT(*) AS count FROM ${table} WHERE inspiration_id = ?`, ["note-legacy-1"]).count, 0, `${table} was not cascaded`);
  }
});

test("schema v1 anchor history upgrades to v2 without losing migration rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inspiration-schema-v2-"));
  const dataDirectory = join(root, "data");
  const databasePath = join(root, "workspace.sqlite");
  await cp(fixtureDir, dataDirectory, { recursive: true });
  const opened = openDatabase({ databasePath, dataDirectory, migrateLegacy: true });
  opened.exec(`
    INSERT INTO annotations(id,inspiration_id,owner_id,group_id,anchor_scope,source_transcript_version_id,canonical_anchor_json,kind,color,comment,status,revision,created_at,updated_at)
    SELECT 'annotation-placeholder',inspiration_id,owner_id,'migration-group','canonical',id,'{}','highlight','key','','active',1,datetime('now'),datetime('now') FROM transcript_versions LIMIT 1;
    PRAGMA foreign_keys=OFF;
    DROP TABLE annotation_anchor_migrations;
    CREATE TABLE annotation_anchor_migrations (
      id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
      old_document_id TEXT, new_document_id TEXT NOT NULL REFERENCES reading_documents(id) ON DELETE CASCADE,
      strategy TEXT NOT NULL, confidence REAL NOT NULL, old_anchor_json TEXT, new_anchor_json TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO annotation_anchor_migrations(id,annotation_id,old_document_id,new_document_id,strategy,confidence,old_anchor_json,new_anchor_json,created_at)
    SELECT 'migration-v1','annotation-placeholder',NULL,id,'exact',1,NULL,'{}',datetime('now') FROM reading_documents LIMIT 1;
    DELETE FROM schema_migrations WHERE version=2;
  `);
  opened.close();

  const upgraded = openDatabase({ databasePath, dataDirectory, migrateLegacy: false });
  t.after(async () => { upgraded.close(); await rm(root, { recursive: true, force: true }); });
  const columns = upgraded.prepare("PRAGMA table_info(annotation_anchor_migrations)").all();
  assert.equal(columns.find(column => column.name === "new_document_id").notnull, 0);
  assert.ok(columns.some(column => column.name === "new_transcript_version_id"));
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM annotation_anchor_migrations WHERE id='migration-v1'").get().count, 1);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=2").get().count, 1);
});
