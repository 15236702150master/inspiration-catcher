import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { openDatabase } from "../lib/db.mjs";
import { WorkspaceStore } from "../lib/workspace-store.mjs";

function seeded() {
  const db = openDatabase({ databasePath: ":memory:", migrateLegacy: false });
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO inspirations(id,owner_id,title,url,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("note-a", "owner-a", "测试灵感", "https://example.test/a", "captured", timestamp, timestamp);
  db.prepare("INSERT INTO inspirations(id,owner_id,title,url,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("note-b", "owner-b", "其他账号", "https://example.test/b", "captured", timestamp, timestamp);
  return { db, store: new WorkspaceStore(db) };
}

test("action items list, update and delete are owner scoped and revision checked", () => {
  const { db, store } = seeded();
  try {
    const created = store.createActionItem("owner-a", "note-a", { title: "执行一次", note: "保留来源" });
    assert.equal(store.listActionItems("owner-a", { status: "pending" }).length, 1);
    assert.equal(store.listActionItems("owner-b", { status: "all" }).length, 0);
    assert.equal(db.prepare("SELECT status FROM inspirations WHERE id='note-a'").get().status, "pending");
    assert.throws(() => store.patchActionItem("owner-b", created.id, { baseRevision: 1, status: "completed" }), error => error.status === 404);
    const completed = store.patchActionItem("owner-a", created.id, { baseRevision: created.revision, status: "completed" });
    assert.equal(completed.revision, 2);
    assert.equal(completed.status, "completed");
    assert.equal(db.prepare("SELECT status FROM inspirations WHERE id='note-a'").get().status, "captured");
    assert.throws(() => store.patchActionItem("owner-a", created.id, { baseRevision: 1, note: "过期覆盖" }), error => error.status === 409 && error.code === "REVISION_CONFLICT");
    assert.throws(() => store.deleteActionItem("owner-a", created.id, 1), error => error.status === 409);
    assert.deepEqual(store.deleteActionItem("owner-a", created.id, 2), { deleted: true });
    assert.equal(store.listActionItems("owner-a", { status: "all" }).length, 0);
  } finally { db.close(); }
});

test("legacy pending notes migrate to consumable pending action items", () => {
  const db = openDatabase({ databasePath: ":memory:", dataDirectory: resolve("tests/fixtures/legacy-workspace"), migrateLegacy: true });
  try {
    const store = new WorkspaceStore(db);
    const items = store.listActionItems("user-owner-a", { status: "pending", inspirationId: "note-legacy-1" });
    assert.equal(items.length, 1);
    assert.equal(items[0].inspirationId, "note-legacy-1");
    assert.equal(db.prepare("SELECT status FROM inspirations WHERE id='note-legacy-1'").get().status, "pending");
  } finally { db.close(); }
});
