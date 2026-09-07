import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../lib/db.mjs";
import { WorkspaceStore } from "../lib/workspace-store.mjs";
import { buildAnchor, buildBlocks, normalizeText, sha256Text } from "../lib/transcript-workspace.mjs";

function fixture() {
  const db = openDatabase({ databasePath: ":memory:", migrateLegacy: false });
  const store = new WorkspaceStore(db);
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO inspirations(id,owner_id,title,url,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("note-versioned", "owner-a", "版本验收", "https://example.test/video", "captured", timestamp, timestamp);
  return { db, store };
}

function anchorFor(text, exact) {
  const block = buildBlocks(text).find(item => item.text.includes(exact));
  const start = block.text.indexOf(exact);
  return buildAnchor({
    blockId: block.id,
    blockText: block.text,
    start,
    end: start + exact.length,
    sourceDocumentSha256: sha256Text(normalizeText(text)),
  });
}

test("retranscription and repeated formatting preserve immutable versions and historical anchors", () => {
  const { db, store } = fixture();
  try {
    const rawOne = "第一段。\n\n长期复用的关键判断。\n\n结尾。";
    const transcriptOne = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: rawOne, originJobId: "job-one" });
    const canonicalAnchor = anchorFor(rawOne, "长期复用的关键判断");
    const readingTexts = [
      "# 第一版\n\n长期复用的关键判断。\n\n结尾。",
      "# 第二版\n\n前言。\n\n长期复用的关键判断。\n\n结尾。",
      "# 第三版\n\n长期复用的关键判断。\n\n补充说明。",
    ];
    const firstDocument = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: transcriptOne.id, markdown: readingTexts[0], provider: "test", model: "one" });
    const firstDisplayAnchor = anchorFor(readingTexts[0], "长期复用的关键判断");
    const annotation = store.createAnnotation("owner-a", "note-versioned", {
      anchorScope: "canonical",
      sourceTranscriptVersionId: transcriptOne.id,
      canonicalAnchor,
      displayReadingDocumentId: firstDocument.id,
      displayAnchor: firstDisplayAnchor,
      kind: "highlight",
      color: "key",
    }, "versioned-annotation");
    const secondDocument = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: transcriptOne.id, markdown: readingTexts[1], provider: "test", model: "two" });
    const thirdDocument = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: transcriptOne.id, markdown: readingTexts[2], provider: "test", model: "three" });

    assert.equal(store.workspace("owner-a", "note-versioned").readingDocuments.length, 3);
    for (const document of [firstDocument, secondDocument, thirdDocument]) {
      const listed = store.listAnnotations("owner-a", "note-versioned", { documentId: document.id, status: "" }).items.find(item => item.id === annotation.id);
      assert.ok(listed.displayAnchor, `annotation was not restored for reading document ${document.versionNo}`);
      assert.equal(listed.displayAnchor.quote.exact, "长期复用的关键判断");
      assert.deepEqual(listed.canonicalAnchor, canonicalAnchor);
    }

    const originalBefore = db.prepare("SELECT raw_text,sha256 FROM transcript_versions WHERE id=?").get(transcriptOne.id);
    const transcriptTwo = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: `${rawOne}\n\n新增内容。`, originJobId: "job-two" });
    assert.notEqual(transcriptTwo.id, transcriptOne.id);
    assert.equal(store.transcriptVersions("owner-a", "note-versioned").length, 2);
    assert.deepEqual(db.prepare("SELECT raw_text,sha256 FROM transcript_versions WHERE id=?").get(transcriptOne.id), originalBefore);
  } finally { db.close(); }
});

test("raw reanchor and raw selection AI upgrade annotations to canonical anchors", () => {
  const { db, store } = fixture();
  try {
    const raw = "原文中的明确句子。";
    const transcript = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: raw, originJobId: "job-raw" });
    const reading = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: transcript.id, markdown: "# 改写\n\n一个无法映射的表达。" });
    const displayAnchor = anchorFor("# 改写\n\n一个无法映射的表达。", "一个无法映射的表达");
    const versionBound = store.createAnnotation("owner-a", "note-versioned", {
      anchorScope: "version_bound", displayReadingDocumentId: reading.id, displayAnchor,
      kind: "comment", comment: "待定位",
    }, "raw-reanchor");
    const canonicalAnchor = anchorFor(raw, "原文中的明确句子");
    const upgraded = store.reanchorAnnotation("owner-a", "note-versioned", versionBound.id, {
      baseRevision: versionBound.revision, documentId: transcript.id, anchor: canonicalAnchor, canonicalAnchor,
    });
    assert.equal(upgraded.anchorScope, "canonical");
    assert.equal(upgraded.sourceTranscriptVersionId, transcript.id);
    assert.equal(upgraded.displayReadingDocumentId, null);
    assert.deepEqual(upgraded.canonicalAnchor, canonicalAnchor);

    const ai = store.saveSelectionAi("owner-a", "note-versioned", {
      documentId: transcript.id, anchor: canonicalAnchor, groupId: "raw-ai", idempotencyKey: "raw-ai-once",
    }, { content: "原文 AI 批注" });
    assert.equal(ai.anchorScope, "canonical");
    assert.equal(ai.kind, "ai_note");
    assert.deepEqual(ai.canonicalAnchor, canonicalAnchor);
  } finally { db.close(); }
});

test("personal snapshots deduplicate unchanged content and retain only the latest twenty", () => {
  const { db, store } = fixture();
  try {
    let revision = 0;
    const save = (index, createRevision = true) => {
      const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `版本 ${index}` }] }] };
      const result = store.putPersonalDocument("owner-a", "note-versioned", { content, baseRevision: revision, clientMutationId: `save-${index}`, createRevision, reason: "test" });
      revision = result.revision;
      return result;
    };
    save(1);
    assert.equal(store.snapshotPersonalDocument("owner-a", "note-versioned", "manual").created, false);
    for (let index = 2; index <= 25; index += 1) save(index);
    const history = store.personalRevisions("owner-a", "note-versioned");
    assert.equal(history.length, 20);
    assert.equal(history[0].plainText, "版本 25");
    assert.equal(history.at(-1).plainText, "版本 6");
    const restored = store.restorePersonalRevision("owner-a", "note-versioned", history.at(-1).revision);
    assert.equal(restored.plainText, "版本 6");
    assert.equal(restored.revision, 26);
  } finally { db.close(); }
});

test("transcript, reading document, personal draft and annotation writes coexist", async () => {
  const { db, store } = fixture();
  try {
    const first = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: "并发前原文。", originJobId: "job-before" });
    const canonicalAnchor = anchorFor("并发前原文。", "并发前原文");
    const operations = await Promise.all([
      Promise.resolve().then(() => store.createTranscriptVersion("owner-a", "note-versioned", { rawText: "并发后原文。", originJobId: "job-after" })),
      Promise.resolve().then(() => store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: first.id, markdown: "# 并发阅读版\n\n并发前原文。" })),
      Promise.resolve().then(() => store.putPersonalDocument("owner-a", "note-versioned", { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "并发加工稿" }] }] }, baseRevision: 0, clientMutationId: "parallel-personal" })),
      Promise.resolve().then(() => store.createAnnotation("owner-a", "note-versioned", { anchorScope: "canonical", sourceTranscriptVersionId: first.id, canonicalAnchor, kind: "highlight", color: "action" }, "parallel-annotation")),
    ]);
    assert.equal(operations.length, 4);
    assert.equal(store.transcriptVersions("owner-a", "note-versioned").length, 2);
    assert.equal(store.workspace("owner-a", "note-versioned").readingDocuments.length, 1);
    assert.equal(store.personalDocument("owner-a", "note-versioned").plainText, "并发加工稿");
    assert.equal(store.listAnnotations("owner-a", "note-versioned", { status: "" }).items.length, 1);
  } finally { db.close(); }
});


test("deleting a reading version removes its annotations and keeps the remaining version", () => {
  const { db, store } = fixture();
  try {
    const transcript = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: "alpha useful point\n\nbeta", originJobId: "job-delete-reading" });
    const first = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: transcript.id, markdown: "alpha useful point", provider: "test", model: "one" });
    const second = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: transcript.id, markdown: "beta", provider: "test", model: "two" });
    const displayAnchor = anchorFor("alpha useful point", "useful");
    store.createAnnotation("owner-a", "note-versioned", {
      anchorScope: "version_bound",
      displayReadingDocumentId: first.id,
      displayAnchor,
      kind: "highlight",
      color: "key",
      comment: "keep only with this version",
    });
    const removed = store.deleteReadingDocument("owner-a", "note-versioned", first.id);
    assert.equal(removed.deleted, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reading_documents WHERE id=?").get(first.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE display_reading_document_id=?").get(first.id).count, 0);
    assert.equal(db.prepare("SELECT active_reading_document_id FROM inspirations WHERE id='note-versioned'").get().active_reading_document_id, second.id);
  } finally { db.close(); }
});

test("deleting a raw transcript version also removes derived reading versions and annotations", () => {
  const { db, store } = fixture();
  try {
    const firstRaw = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: "first raw point", originJobId: "job-delete-raw-one" });
    const firstReading = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: firstRaw.id, markdown: "first raw point", provider: "test", model: "one" });
    const displayAnchor = anchorFor("first raw point", "raw");
    store.createAnnotation("owner-a", "note-versioned", {
      anchorScope: "version_bound",
      displayReadingDocumentId: firstReading.id,
      displayAnchor,
      kind: "highlight",
      color: "key",
      comment: "derived annotation",
    });
    const secondRaw = store.createTranscriptVersion("owner-a", "note-versioned", { rawText: "second raw point", originJobId: "job-delete-raw-two" });
    const secondReading = store.createReadingDocument("owner-a", "note-versioned", { transcriptVersionId: secondRaw.id, markdown: "second raw point", provider: "test", model: "two" });
    const removed = store.deleteTranscriptVersion("owner-a", "note-versioned", firstRaw.id);
    assert.equal(removed.deleted, true);
    assert.deepEqual(removed.deletedReadingDocumentIds, [firstReading.id]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE id=?").get(firstRaw.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reading_documents WHERE id=?").get(firstReading.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE display_reading_document_id=?").get(firstReading.id).count, 0);
    const active = db.prepare("SELECT active_transcript_id,active_reading_document_id FROM inspirations WHERE id='note-versioned'").get();
    assert.equal(active.active_transcript_id, secondRaw.id);
    assert.equal(active.active_reading_document_id, secondReading.id);
  } finally { db.close(); }
});
