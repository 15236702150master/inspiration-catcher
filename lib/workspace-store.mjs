import { randomUUID } from "node:crypto";
import { buildBlocks, normalizeText, reanchorQuote, sha256Text, validateAnchor } from "./transcript-workspace.mjs";
import { editorPlainText, enumValue, httpError, limitedString, sanitizeMarkdown, validateEditorDocument } from "./validation.mjs";

function parse(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function now() { return new Date().toISOString(); }
function rowObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]));
}

export class WorkspaceStore {
  constructor(db, { onProjectionChange = null } = {}) {
    this.db = db;
    this.onProjectionChange = onProjectionChange;
  }

  notifyProjection(ownerId, inspirationId, options = {}) {
    if (!this.onProjectionChange) return;
    try {
      const pending = this.onProjectionChange(ownerId, inspirationId, options);
      pending?.catch?.(error => console.error("Projection enqueue failed", error));
    } catch (error) {
      console.error("Projection enqueue failed", error);
    }
  }

  inspiration(ownerId, inspirationId) {
    return this.db.prepare("SELECT * FROM inspirations WHERE id=? AND owner_id=?").get(inspirationId, ownerId);
  }

  requireInspiration(ownerId, inspirationId) {
    const item = this.inspiration(ownerId, inspirationId);
    if (!item) throw httpError(404, "NOT_FOUND", "灵感记录不存在");
    return item;
  }

  createTranscriptVersion(ownerId, inspirationId, { rawText, originJobId = null, language = "zh-CN", createdAt = now() }) {
    this.requireInspiration(ownerId, inspirationId);
    const normalized = normalizeText(limitedString(rawText, "rawText", 2_000_000, { required: true }));
    const digest = sha256Text(normalized);
    const existing = originJobId ? this.db.prepare("SELECT * FROM transcript_versions WHERE origin_job_id=? AND owner_id=?").get(originJobId, ownerId) : null;
    if (existing) return rowObject(existing);
    const result = this.db.transaction(() => {
      const versionNo = this.db.prepare("SELECT COALESCE(MAX(version_no),0)+1 AS value FROM transcript_versions WHERE inspiration_id=?").get(inspirationId).value;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO transcript_versions(id,inspiration_id,owner_id,origin_job_id,raw_text,normalized_text,sha256,language,version_no,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, inspirationId, ownerId, originJobId, String(rawText), normalized, digest, language, versionNo, createdAt);
      this.db.prepare("UPDATE inspirations SET active_transcript_id=?, transcription_status='completed', transcription_job_id=COALESCE(?,transcription_job_id), revision=revision+1, updated_at=? WHERE id=? AND owner_id=?").run(id, originJobId, now(), inspirationId, ownerId);
      return rowObject(this.db.prepare("SELECT * FROM transcript_versions WHERE id=?").get(id));
    })();
    this.notifyProjection(ownerId, inspirationId, { delayMs: 0, eventKind: "transcript" });
    return result;
  }

  createReadingDocument(ownerId, inspirationId, { transcriptVersionId, markdown, provider = "", model = "", promptVersion = "v1" }) {
    const inspiration = this.requireInspiration(ownerId, inspirationId);
    const transcriptId = transcriptVersionId || inspiration.active_transcript_id;
    const transcript = this.db.prepare("SELECT * FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").get(transcriptId, inspirationId, ownerId);
    if (!transcript) throw httpError(404, "TRANSCRIPT_NOT_FOUND", "转写版本不存在");
    const safeMarkdown = sanitizeMarkdown(limitedString(markdown, "markdown", 2_000_000, { required: true }));
    const blocks = buildBlocks(safeMarkdown);
    const plainText = blocks.map(block => block.text).filter(Boolean).join("\n\n");
    const result = this.db.transaction(() => {
      const versionNo = this.db.prepare("SELECT COALESCE(MAX(version_no),0)+1 AS value FROM reading_documents WHERE inspiration_id=?").get(inspirationId).value;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO reading_documents(id,inspiration_id,transcript_version_id,owner_id,markdown,plain_text,blocks_json,sha256,provider,model,prompt_version,version_no,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, inspirationId, transcriptId, ownerId, safeMarkdown, plainText, JSON.stringify(blocks), sha256Text(safeMarkdown), provider, model, promptVersion, versionNo, now());
      this.db.prepare("UPDATE inspirations SET active_reading_document_id=?, revision=revision+1, updated_at=? WHERE id=? AND owner_id=?").run(id, now(), inspirationId, ownerId);
      this.migrateDisplayAnchors(ownerId, inspirationId, id, blocks, sha256Text(safeMarkdown));
      return this.document(ownerId, inspirationId, id);
    })();
    this.notifyProjection(ownerId, inspirationId, { delayMs: 0, eventKind: "reading_document" });
    return result;
  }

  document(ownerId, inspirationId, documentId) {
    this.requireInspiration(ownerId, inspirationId);
    const row = this.db.prepare("SELECT * FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(documentId, inspirationId, ownerId);
    if (!row) throw httpError(404, "NOT_FOUND", "阅读版本不存在");
    return { ...rowObject(row), blocks: parse(row.blocks_json, []) };
  }

  transcriptVersions(ownerId, inspirationId) {
    this.requireInspiration(ownerId, inspirationId);
    return this.db.prepare("SELECT id,inspiration_id,origin_job_id,raw_text,normalized_text,sha256,language,version_no,created_at,length(raw_text) AS character_count FROM transcript_versions WHERE inspiration_id=? AND owner_id=? ORDER BY version_no DESC").all(inspirationId, ownerId).map(row => ({ ...rowObject(row), blocks: buildBlocks(row.raw_text) }));
  }

  workspace(ownerId, inspirationId) {
    const item = this.requireInspiration(ownerId, inspirationId);
    const documents = this.db.prepare("SELECT id,transcript_version_id,sha256,provider,model,prompt_version,version_no,created_at,length(plain_text) AS character_count FROM reading_documents WHERE inspiration_id=? AND owner_id=? ORDER BY version_no DESC").all(inspirationId, ownerId).map(rowObject);
    const annotations = this.listAnnotations(ownerId, inspirationId, { limit: 100 }).items.map(item => ({
      id: item.id,
      groupId: item.groupId,
      anchorScope: item.anchorScope,
      sourceTranscriptVersionId: item.sourceTranscriptVersionId,
      displayReadingDocumentId: item.displayReadingDocumentId,
      kind: item.kind,
      color: item.color,
      comment: String(item.comment || "").slice(0, 160),
      excerpt: String(item.canonicalAnchor?.quote?.exact || item.displayAnchor?.quote?.exact || "").slice(0, 120),
      status: item.status,
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
    const counts = Object.fromEntries(this.db.prepare("SELECT kind,COUNT(*) AS count FROM annotations WHERE inspiration_id=? AND owner_id=? AND deleted_at IS NULL GROUP BY kind").all(inspirationId, ownerId).map(row => [row.kind, row.count]));
    const personal = this.db.prepare("SELECT revision,updated_at,length(plain_text) AS character_count FROM personal_documents WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId);
    const actions = this.db.prepare("SELECT id,title,status,due_at,revision,updated_at FROM action_items WHERE inspiration_id=? AND owner_id=? ORDER BY updated_at DESC LIMIT 20").all(inspirationId, ownerId).map(rowObject);
    const transcriptVersions = this.transcriptVersions(ownerId, inspirationId).map(({ rawText, normalizedText, blocks, ...metadata }) => metadata);
    return { inspiration: rowObject(item), transcriptVersions, readingDocuments: documents, activeTranscriptId: item.active_transcript_id, activeDocumentId: item.active_reading_document_id, annotations, annotationCounts: counts, personalDocument: rowObject(personal), actionItems: actions };
  }

  annotationRow(ownerId, inspirationId, annotationId) {
    return this.db.prepare("SELECT * FROM annotations WHERE id=? AND inspiration_id=? AND owner_id=? AND deleted_at IS NULL").get(annotationId, inspirationId, ownerId);
  }

  mapAnnotation(row, documentId = null, targetDocument = null) {
    const mapped = { ...rowObject(row), canonicalAnchor: parse(row.canonical_anchor_json), displayAnchor: parse(row.display_anchor_json) };
    if (row.anchor_scope !== "canonical" || !documentId || !targetDocument) return mapped;
    if (String(row.display_reading_document_id || "") === String(documentId)) return mapped;
    const migration = this.db.prepare(`SELECT strategy,confidence,new_anchor_json FROM annotation_anchor_migrations
      WHERE annotation_id=? AND new_document_id=? ORDER BY created_at DESC LIMIT 1`).get(row.id, documentId);
    if (migration) {
      mapped.displayReadingDocumentId = documentId;
      mapped.displayAnchor = parse(migration.new_anchor_json);
      mapped.status = mapped.displayAnchor ? "active" : "orphaned";
      mapped.anchorMigration = { strategy: migration.strategy, confidence: migration.confidence };
      return mapped;
    }
    const result = reanchorQuote(mapped.canonicalAnchor, targetDocument.blocks, targetDocument.sha256);
    mapped.displayReadingDocumentId = documentId;
    mapped.displayAnchor = result.anchor;
    mapped.status = result.status;
    mapped.anchorMigration = { strategy: result.strategy, confidence: result.confidence, transient: true };
    return mapped;
  }


  deleteReadingDocument(ownerId, inspirationId, documentId) {
    const inspiration = this.requireInspiration(ownerId, inspirationId);
    const row = this.db.prepare("SELECT * FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(documentId, inspirationId, ownerId);
    if (!row) throw httpError(404, "NOT_FOUND", "Reading version not found");
    const transcriptCount = this.db.prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count;
    const readingCount = this.db.prepare("SELECT COUNT(*) AS count FROM reading_documents WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count;
    if (transcriptCount + readingCount <= 1) throw httpError(422, "VERSION_LAST", "Keep at least one source or reading version");
    const timestamp = now();
    const fallback = this.db.prepare("SELECT id FROM reading_documents WHERE inspiration_id=? AND owner_id=? AND id<>? ORDER BY version_no DESC LIMIT 1").get(inspirationId, ownerId, documentId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM annotations WHERE owner_id=? AND inspiration_id=? AND display_reading_document_id=?").run(ownerId, inspirationId, documentId);
      this.db.prepare("DELETE FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").run(documentId, inspirationId, ownerId);
      if (String(inspiration.active_reading_document_id || "") === String(documentId)) {
        this.db.prepare("UPDATE inspirations SET active_reading_document_id=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?").run(fallback?.id || null, timestamp, inspirationId, ownerId);
      }
    })();
    this.notifyProjection(ownerId, inspirationId, { delayMs: 0, eventKind: "reading_document_deleted" });
    return { deleted: true, activeDocumentId: fallback?.id || null };
  }

  deleteTranscriptVersion(ownerId, inspirationId, transcriptVersionId) {
    const inspiration = this.requireInspiration(ownerId, inspirationId);
    const row = this.db.prepare("SELECT * FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").get(transcriptVersionId, inspirationId, ownerId);
    if (!row) throw httpError(404, "NOT_FOUND", "Source transcript version not found");
    const derivedDocs = this.db.prepare("SELECT id FROM reading_documents WHERE transcript_version_id=? AND inspiration_id=? AND owner_id=?").all(transcriptVersionId, inspirationId, ownerId).map(item => item.id);
    const remainingTranscript = this.db.prepare("SELECT id FROM transcript_versions WHERE inspiration_id=? AND owner_id=? AND id<>? ORDER BY version_no DESC LIMIT 1").get(inspirationId, ownerId, transcriptVersionId);
    const remainingReading = this.db.prepare(`SELECT id FROM reading_documents WHERE inspiration_id=? AND owner_id=? ${derivedDocs.length ? `AND id NOT IN (${derivedDocs.map(() => "?").join(",")})` : ""} ORDER BY version_no DESC LIMIT 1`).get(inspirationId, ownerId, ...derivedDocs);
    if (!remainingTranscript && !remainingReading) throw httpError(422, "VERSION_LAST", "Keep at least one source or reading version");
    const timestamp = now();
    this.db.transaction(() => {
      if (derivedDocs.length) {
        this.db.prepare(`DELETE FROM annotations WHERE owner_id=? AND inspiration_id=? AND (source_transcript_version_id=? OR display_reading_document_id IN (${derivedDocs.map(() => "?").join(",")}))`).run(ownerId, inspirationId, transcriptVersionId, ...derivedDocs);
        this.db.prepare(`DELETE FROM reading_documents WHERE inspiration_id=? AND owner_id=? AND id IN (${derivedDocs.map(() => "?").join(",")})`).run(inspirationId, ownerId, ...derivedDocs);
      } else {
        this.db.prepare("DELETE FROM annotations WHERE owner_id=? AND inspiration_id=? AND source_transcript_version_id=?").run(ownerId, inspirationId, transcriptVersionId);
      }
      this.db.prepare("DELETE FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").run(transcriptVersionId, inspirationId, ownerId);
      const nextTranscriptId = String(inspiration.active_transcript_id || "") === String(transcriptVersionId) ? remainingTranscript?.id || null : inspiration.active_transcript_id;
      const activeReadingWasDerived = derivedDocs.some(id => String(id) === String(inspiration.active_reading_document_id || ""));
      const nextReadingId = activeReadingWasDerived ? remainingReading?.id || null : inspiration.active_reading_document_id;
      this.db.prepare("UPDATE inspirations SET active_transcript_id=?,active_reading_document_id=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?").run(nextTranscriptId, nextReadingId, timestamp, inspirationId, ownerId);
    })();
    this.notifyProjection(ownerId, inspirationId, { delayMs: 0, eventKind: "transcript_version_deleted" });
    return { deleted: true, activeTranscriptId: remainingTranscript?.id || null, activeDocumentId: remainingReading?.id || null, deletedReadingDocumentIds: derivedDocs };
  }

  createAnnotation(ownerId, inspirationId, input, idempotencyKey) {
    this.requireInspiration(ownerId, inspirationId);
    const scopeKey = `annotation:${inspirationId}:create`;
    if (idempotencyKey) {
      const prior = this.db.prepare("SELECT response_json FROM mutation_idempotency WHERE owner_id=? AND scope=? AND idempotency_key=?").get(ownerId, scopeKey, idempotencyKey);
      if (prior) return parse(prior.response_json);
    }
    const anchorScope = enumValue(input.anchorScope, ["canonical", "version_bound"], "anchorScope");
    const kind = enumValue(input.kind, ["highlight", "underline", "comment", "ai_note"], "kind");
    const canonicalAnchor = input.canonicalAnchor || null;
    const displayAnchor = input.displayAnchor || null;
    if (anchorScope === "canonical" && !input.sourceTranscriptVersionId) input.sourceTranscriptVersionId = this.inspiration(ownerId, inspirationId)?.active_transcript_id || null;
    if (anchorScope === "canonical" && (!input.sourceTranscriptVersionId || !validateAnchor(canonicalAnchor))) throw httpError(422, "INVALID_CANONICAL_ANCHOR", "规范标注缺少有效原文锚点");
    if (anchorScope === "version_bound" && (!input.displayReadingDocumentId || !validateAnchor(displayAnchor))) throw httpError(422, "INVALID_DISPLAY_ANCHOR", "版本标注缺少有效阅读锚点");
    if (input.sourceTranscriptVersionId && !this.db.prepare("SELECT 1 FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").get(input.sourceTranscriptVersionId, inspirationId, ownerId)) throw httpError(404, "NOT_FOUND", "转写版本不存在");
    if (input.displayReadingDocumentId && !this.db.prepare("SELECT 1 FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(input.displayReadingDocumentId, inspirationId, ownerId)) throw httpError(404, "NOT_FOUND", "阅读版本不存在");
    const result = this.db.transaction(() => {
      const id = randomUUID(); const timestamp = now();
      this.db.prepare(`INSERT INTO annotations(id,inspiration_id,owner_id,group_id,anchor_scope,source_transcript_version_id,canonical_anchor_json,display_reading_document_id,display_anchor_json,kind,color,comment,status,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, inspirationId, ownerId, String(input.groupId || randomUUID()), anchorScope, input.sourceTranscriptVersionId || null, canonicalAnchor ? JSON.stringify(canonicalAnchor) : null, input.displayReadingDocumentId || null, displayAnchor ? JSON.stringify(displayAnchor) : null, kind, String(input.color || "").slice(0, 30), limitedString(input.comment, "comment", 20_000), "active", timestamp, timestamp);
      const response = this.mapAnnotation(this.annotationRow(ownerId, inspirationId, id));
      if (idempotencyKey) this.db.prepare("INSERT INTO mutation_idempotency(owner_id,scope,idempotency_key,status,response_json,created_at) VALUES (?,?,?,?,?,?)").run(ownerId, scopeKey, idempotencyKey, 201, JSON.stringify(response), timestamp);
      return response;
    })();
    this.notifyProjection(ownerId, inspirationId, { delayMs: 5000, eventKind: "annotation" });
    return result;
  }

  listAnnotations(ownerId, inspirationId, { documentId, kind, status = "active", cursor, sinceRevision, limit = 100 } = {}) {
    this.requireInspiration(ownerId, inspirationId);
    const clauses = ["inspiration_id=?", "owner_id=?", "deleted_at IS NULL"];
    const params = [inspirationId, ownerId];
    if (documentId) { clauses.push("(anchor_scope='canonical' OR display_reading_document_id=?)"); params.push(documentId); }
    if (kind) { clauses.push("kind=?"); params.push(kind); }
    if (status) { clauses.push("status=?"); params.push(status); }
    if (cursor) { clauses.push("id>?"); params.push(cursor); }
    if (Number.isInteger(Number(sinceRevision)) && Number(sinceRevision) > 0) { clauses.push("revision>?"); params.push(Number(sinceRevision)); }
    const capped = Math.max(1, Math.min(100, Number(limit) || 100));
    const rows = this.db.prepare(`SELECT * FROM annotations WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`).all(...params, capped + 1);
    const targetRow = documentId ? this.db.prepare("SELECT blocks_json,sha256 FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(documentId, inspirationId, ownerId) : null;
    const targetDocument = targetRow ? { blocks: parse(targetRow.blocks_json, []), sha256: targetRow.sha256 } : null;
    return { items: rows.slice(0, capped).map(row => this.mapAnnotation(row, documentId, targetDocument)), nextCursor: rows.length > capped ? rows[capped - 1].id : null };
  }

  patchAnnotation(ownerId, inspirationId, annotationId, input) {
    const row = this.annotationRow(ownerId, inspirationId, annotationId);
    if (!row) throw httpError(404, "NOT_FOUND", "标注不存在");
    if (Number(input.baseRevision) !== row.revision) throw httpError(409, "REVISION_CONFLICT", "标注已被其他页面修改", { serverRevision: row.revision, resource: this.mapAnnotation(row) });
    const updates = [];
    const values = [];
    if (Object.hasOwn(input, "color")) { updates.push("color=?"); values.push(String(input.color || "").slice(0, 30)); }
    if (Object.hasOwn(input, "comment")) { updates.push("comment=?"); values.push(limitedString(input.comment, "comment", 20_000)); }
    if (Object.hasOwn(input, "kind")) { updates.push("kind=?"); values.push(enumValue(input.kind, ["highlight", "underline", "comment", "ai_note"], "kind")); }
    if (!updates.length) throw httpError(422, "EMPTY_PATCH", "没有可更新字段");
    updates.push("revision=revision+1", "updated_at=?"); values.push(now(), annotationId, ownerId, row.revision);
    this.db.prepare(`UPDATE annotations SET ${updates.join(",")} WHERE id=? AND owner_id=? AND revision=?`).run(...values);
    const result = this.mapAnnotation(this.annotationRow(ownerId, inspirationId, annotationId));
    this.notifyProjection(ownerId, inspirationId, { delayMs: 5000, eventKind: "annotation" });
    return result;
  }

  deleteAnnotation(ownerId, inspirationId, annotationId, baseRevision) {
    const row = this.annotationRow(ownerId, inspirationId, annotationId);
    if (!row) throw httpError(404, "NOT_FOUND", "标注不存在");
    if (Number(baseRevision) !== row.revision) throw httpError(409, "REVISION_CONFLICT", "标注已被其他页面修改", { serverRevision: row.revision, resource: this.mapAnnotation(row) });
    this.db.prepare("UPDATE annotations SET status='deleted',deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=?").run(now(), now(), annotationId, ownerId, row.revision);
    this.notifyProjection(ownerId, inspirationId, { delayMs: 5000, eventKind: "annotation" });
    return { deleted: true, revision: row.revision + 1 };
  }

  reanchorAnnotation(ownerId, inspirationId, annotationId, input) {
    const row = this.annotationRow(ownerId, inspirationId, annotationId);
    if (!row) throw httpError(404, "NOT_FOUND", "标注不存在");
    if (Number(input.baseRevision) !== row.revision) throw httpError(409, "REVISION_CONFLICT", "标注已被其他页面修改", { serverRevision: row.revision, resource: this.mapAnnotation(row) });
    const anchor = input.anchor;
    if (!validateAnchor(anchor)) throw httpError(422, "INVALID_ANCHOR", "新锚点无效");
    const reading = this.db.prepare("SELECT * FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(input.documentId, inspirationId, ownerId);
    const transcript = reading ? null : this.db.prepare("SELECT * FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").get(input.documentId, inspirationId, ownerId);
    if (!reading && !transcript) throw httpError(404, "NOT_FOUND", "重新定位的文档不存在");
    const timestamp = now();
    this.db.transaction(() => {
      const transcriptId = reading ? reading.transcript_version_id : transcript.id;
      const displayDocumentId = reading ? reading.id : null;
      const displayAnchor = reading ? anchor : null;
      const canonicalAnchor = input.canonicalAnchor || anchor;
      this.db.prepare(`UPDATE annotations SET anchor_scope='canonical',source_transcript_version_id=?,canonical_anchor_json=?,display_reading_document_id=?,display_anchor_json=?,status='active',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?`).run(transcriptId, JSON.stringify(canonicalAnchor), displayDocumentId, displayAnchor ? JSON.stringify(displayAnchor) : null, timestamp, annotationId, ownerId, row.revision);
      this.db.prepare("INSERT INTO annotation_anchor_migrations(id,annotation_id,old_document_id,new_document_id,new_transcript_version_id,strategy,confidence,old_anchor_json,new_anchor_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), annotationId, row.display_reading_document_id, displayDocumentId, transcript ? transcript.id : null, "manual", 1, row.display_anchor_json, JSON.stringify(canonicalAnchor), timestamp);
    })();
    const result = this.mapAnnotation(this.annotationRow(ownerId, inspirationId, annotationId));
    this.notifyProjection(ownerId, inspirationId, { delayMs: 5000, eventKind: "annotation" });
    return result;
  }

  migrateDisplayAnchors(ownerId, inspirationId, newDocumentId, blocks, documentSha) {
    const rows = this.db.prepare("SELECT * FROM annotations WHERE inspiration_id=? AND owner_id=? AND anchor_scope='canonical' AND deleted_at IS NULL").all(inspirationId, ownerId);
    const insertHistory = this.db.prepare("INSERT INTO annotation_anchor_migrations(id,annotation_id,old_document_id,new_document_id,strategy,confidence,old_anchor_json,new_anchor_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const row of rows) {
      const source = parse(row.display_anchor_json) || parse(row.canonical_anchor_json);
      const result = reanchorQuote(source, blocks, documentSha);
      this.db.prepare("UPDATE annotations SET display_reading_document_id=?,display_anchor_json=?,status=?,updated_at=? WHERE id=?").run(newDocumentId, result.anchor ? JSON.stringify(result.anchor) : null, result.status, now(), row.id);
      insertHistory.run(randomUUID(), row.id, row.display_reading_document_id, newDocumentId, result.strategy, result.confidence, row.display_anchor_json, result.anchor ? JSON.stringify(result.anchor) : null, now());
    }
  }

  personalDocument(ownerId, inspirationId) {
    this.requireInspiration(ownerId, inspirationId);
    const row = this.db.prepare("SELECT * FROM personal_documents WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId);
    if (row) { const content = parse(row.content_json, { type: "doc", content: [] }); return { ...rowObject(row), content, contentJson: content }; }
    const content = { type: "doc", content: [] };
    return { inspirationId, content, contentJson: content, plainText: "", revision: 0, updatedAt: null };
  }

  putPersonalDocument(ownerId, inspirationId, input) {
    this.requireInspiration(ownerId, inspirationId);
    const clientMutationId = limitedString(input.clientMutationId, "clientMutationId", 100, { required: true });
    const prior = this.db.prepare("SELECT response_json FROM personal_document_mutations WHERE owner_id=? AND inspiration_id=? AND client_mutation_id=?").get(ownerId, inspirationId, clientMutationId);
    if (prior) return parse(prior.response_json);
    const content = input.content ?? input.contentJson;
    validateEditorDocument(content);
    const current = this.personalDocument(ownerId, inspirationId);
    if (Number(input.baseRevision) !== current.revision) throw httpError(409, "REVISION_CONFLICT", "加工稿已被其他页面修改", { serverRevision: current.revision, resource: current });
    const plainText = editorPlainText(content);
    const nextRevision = current.revision + 1;
    const result = { inspirationId, content, contentJson: content, plainText, revision: nextRevision, updatedAt: now() };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO personal_documents(inspiration_id,owner_id,content_json,plain_text,revision,last_mutation_id,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(inspiration_id) DO UPDATE SET content_json=excluded.content_json,plain_text=excluded.plain_text,revision=excluded.revision,last_mutation_id=excluded.last_mutation_id,updated_at=excluded.updated_at`).run(inspirationId, ownerId, JSON.stringify(content), plainText, nextRevision, clientMutationId, result.updatedAt);
      this.db.prepare("INSERT INTO personal_document_mutations(owner_id,inspiration_id,client_mutation_id,revision,response_json,created_at) VALUES (?,?,?,?,?,?)").run(ownerId, inspirationId, clientMutationId, nextRevision, JSON.stringify(result), result.updatedAt);
      if (input.createRevision || !current.updatedAt) this.createPersonalRevision(ownerId, inspirationId, result, String(input.reason || "autosave"));
      this.db.prepare("DELETE FROM personal_document_mutations WHERE rowid IN (SELECT rowid FROM personal_document_mutations WHERE owner_id=? AND inspiration_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 200)").run(ownerId, inspirationId);
    })();
    this.notifyProjection(ownerId, inspirationId, { delayMs: 30_000, maxDelayMs: 120_000, eventKind: "personal_document" });
    return result;
  }

  createPersonalRevision(ownerId, inspirationId, document, reason) {
    const serialized = JSON.stringify(document.content);
    const latest = this.db.prepare("SELECT content_json FROM personal_document_revisions WHERE inspiration_id=? AND owner_id=? ORDER BY revision DESC LIMIT 1").get(inspirationId, ownerId);
    if (latest?.content_json === serialized) return false;
    this.db.prepare("INSERT OR IGNORE INTO personal_document_revisions(id,inspiration_id,owner_id,content_json,plain_text,revision,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), inspirationId, ownerId, serialized, document.plainText, document.revision, reason.slice(0, 50), now());
    this.db.prepare("DELETE FROM personal_document_revisions WHERE id IN (SELECT id FROM personal_document_revisions WHERE inspiration_id=? AND owner_id=? ORDER BY revision DESC LIMIT -1 OFFSET 20)").run(inspirationId, ownerId);
    return true;
  }

  snapshotPersonalDocument(ownerId, inspirationId, reason = "manual") {
    const document = this.personalDocument(ownerId, inspirationId);
    if (!document.updatedAt) throw httpError(422, "PERSONAL_DOCUMENT_EMPTY", "加工稿还没有可保存的内容");
    const created = this.createPersonalRevision(ownerId, inspirationId, document, String(reason || "manual"));
    return { created, revision: document.revision };
  }

  personalRevisions(ownerId, inspirationId) {
    this.requireInspiration(ownerId, inspirationId);
    return this.db.prepare("SELECT id,inspiration_id,plain_text,revision,reason,created_at FROM personal_document_revisions WHERE inspiration_id=? AND owner_id=? ORDER BY revision DESC LIMIT 20").all(inspirationId, ownerId).map(rowObject);
  }

  restorePersonalRevision(ownerId, inspirationId, revision) {
    const source = this.db.prepare("SELECT * FROM personal_document_revisions WHERE inspiration_id=? AND owner_id=? AND revision=?").get(inspirationId, ownerId, revision);
    if (!source) throw httpError(404, "NOT_FOUND", "加工稿历史版本不存在");
    const current = this.personalDocument(ownerId, inspirationId);
    return this.putPersonalDocument(ownerId, inspirationId, { content: parse(source.content_json), baseRevision: current.revision, clientMutationId: randomUUID(), createRevision: true, reason: `restore:${revision}` });
  }

  createActionItem(ownerId, inspirationId, input) {
    this.requireInspiration(ownerId, inspirationId);
    if (input.sourceAnnotationId && !this.annotationRow(ownerId, inspirationId, input.sourceAnnotationId)) throw httpError(404, "NOT_FOUND", "来源标注不存在");
    const id = randomUUID(); const timestamp = now();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO action_items(id,inspiration_id,owner_id,source_annotation_id,title,note,status,due_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,1,?,?)").run(id, inspirationId, ownerId, input.sourceAnnotationId || null, limitedString(input.title, "title", 300, { required: true }), limitedString(input.note, "note", 10_000), input.dueAt || null, timestamp, timestamp);
      this.syncInspirationPending(ownerId, inspirationId);
    })();
    const result = rowObject(this.db.prepare("SELECT * FROM action_items WHERE id=?").get(id));
    this.notifyProjection(ownerId, inspirationId, { delayMs: 5000, eventKind: "action_item" });
    return result;
  }

  actionItem(ownerId, actionItemId) {
    const row = this.db.prepare(`SELECT a.*,i.title AS inspiration_title,i.url AS inspiration_url,i.thumbnail AS inspiration_thumbnail
      FROM action_items a JOIN inspirations i ON i.id=a.inspiration_id
      WHERE a.id=? AND a.owner_id=? AND i.owner_id=?`).get(actionItemId, ownerId, ownerId);
    return row ? rowObject(row) : null;
  }

  listActionItems(ownerId, { status = "pending", inspirationId = null } = {}) {
    const clauses = ["a.owner_id=?", "i.owner_id=?"];
    const params = [ownerId, ownerId];
    if (status && status !== "all") { enumValue(status, ["pending", "completed", "canceled"], "status"); clauses.push("a.status=?"); params.push(status); }
    if (inspirationId) { clauses.push("a.inspiration_id=?"); params.push(inspirationId); }
    return this.db.prepare(`SELECT a.*,i.title AS inspiration_title,i.url AS inspiration_url,i.thumbnail AS inspiration_thumbnail,i.quick_thought AS inspiration_note
      FROM action_items a JOIN inspirations i ON i.id=a.inspiration_id WHERE ${clauses.join(" AND ")} ORDER BY a.updated_at DESC,a.id`).all(...params).map(rowObject);
  }

  patchActionItem(ownerId, actionItemId, input) {
    const row = this.actionItem(ownerId, actionItemId);
    if (!row) throw httpError(404, "NOT_FOUND", "待实践事项不存在");
    if (Number(input.baseRevision) !== row.revision) throw httpError(409, "REVISION_CONFLICT", "待实践事项已被其他页面修改", { serverRevision: row.revision, resource: row });
    const updates = [];
    const values = [];
    if (Object.hasOwn(input, "title")) { updates.push("title=?"); values.push(limitedString(input.title, "title", 300, { required: true })); }
    if (Object.hasOwn(input, "note")) { updates.push("note=?"); values.push(limitedString(input.note, "note", 10_000)); }
    if (Object.hasOwn(input, "status")) { updates.push("status=?"); values.push(enumValue(input.status, ["pending", "completed", "canceled"], "status")); }
    if (Object.hasOwn(input, "dueAt")) { updates.push("due_at=?"); values.push(input.dueAt || null); }
    if (!updates.length) throw httpError(422, "EMPTY_PATCH", "没有可更新字段");
    const timestamp = now();
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE action_items SET ${updates.join(",")},revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?`).run(...values, timestamp, actionItemId, ownerId, row.revision);
      if (!result.changes) throw httpError(409, "REVISION_CONFLICT", "待实践事项已被其他页面修改", { serverRevision: this.actionItem(ownerId, actionItemId)?.revision });
      this.syncInspirationPending(ownerId, row.inspirationId);
    })();
    const result = this.actionItem(ownerId, actionItemId);
    this.notifyProjection(ownerId, row.inspirationId, { delayMs: 5000, eventKind: "action_item" });
    return result;
  }

  deleteActionItem(ownerId, actionItemId, baseRevision) {
    const row = this.actionItem(ownerId, actionItemId);
    if (!row) throw httpError(404, "NOT_FOUND", "待实践事项不存在");
    if (Number(baseRevision) !== row.revision) throw httpError(409, "REVISION_CONFLICT", "待实践事项已被其他页面修改", { serverRevision: row.revision, resource: row });
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM action_items WHERE id=? AND owner_id=? AND revision=?").run(actionItemId, ownerId, row.revision);
      this.syncInspirationPending(ownerId, row.inspirationId);
    })();
    this.notifyProjection(ownerId, row.inspirationId, { delayMs: 5000, eventKind: "action_item" });
    return { deleted: true };
  }

  syncInspirationPending(ownerId, inspirationId) {
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM action_items WHERE owner_id=? AND inspiration_id=? AND status='pending'").get(ownerId, inspirationId).count;
    if (pending) this.db.prepare("UPDATE inspirations SET status='pending',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND status<>'pending'").run(now(), inspirationId, ownerId);
    else this.db.prepare("UPDATE inspirations SET status='captured',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND status='pending'").run(now(), inspirationId, ownerId);
  }

  saveSelectionAi(ownerId, inspirationId, input, result) {
    if (!validateAnchor(input.anchor)) throw httpError(422, "INVALID_ANCHOR", "选区锚点无效");
    const reading = this.db.prepare("SELECT id FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(input.documentId, inspirationId, ownerId);
    if (reading) return this.createAnnotation(ownerId, inspirationId, { anchorScope: "version_bound", displayReadingDocumentId: reading.id, displayAnchor: input.anchor, kind: "ai_note", color: "", comment: result.content, groupId: input.groupId || randomUUID() }, input.idempotencyKey);
    const transcript = this.db.prepare("SELECT id FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").get(input.documentId, inspirationId, ownerId);
    if (!transcript) throw httpError(404, "NOT_FOUND", "选区所在文档不存在");
    return this.createAnnotation(ownerId, inspirationId, { anchorScope: "canonical", sourceTranscriptVersionId: transcript.id, canonicalAnchor: input.anchor, kind: "ai_note", color: "", comment: result.content, groupId: input.groupId || randomUUID() }, input.idempotencyKey);
  }

  export(ownerId, inspirationId, mode) {
    const inspiration = this.requireInspiration(ownerId, inspirationId);
    enumValue(mode, ["raw", "annotated", "personal"], "mode");
    const source = `来源：${inspiration.title}\n${inspiration.url}\n导出时间：${now()}`;
    if (mode === "personal") { const personal = this.personalDocument(ownerId, inspirationId); return { mode, filename: `${inspiration.title || "加工稿"}.md`, content: `# ${inspiration.title}\n\n${personal.plainText}\n\n---\n${source}` }; }
    const transcript = this.db.prepare("SELECT * FROM transcript_versions WHERE id=? AND owner_id=?").get(inspiration.active_transcript_id, ownerId);
    if (!transcript) throw httpError(404, "TRANSCRIPT_NOT_FOUND", "原始转写不存在");
    if (mode === "raw") return { mode, filename: `${inspiration.title || "转写"}.txt`, content: `${transcript.raw_text}\n\n---\n${source}` };
    const annotations = this.db.prepare("SELECT * FROM annotations WHERE inspiration_id=? AND owner_id=? AND deleted_at IS NULL ORDER BY id").all(inspirationId, ownerId).map(row => this.mapAnnotation(row));
    const footnotes = annotations.map((item, index) => `${index + 1}. [${item.kind}${item.color ? `/${item.color}` : ""}${item.anchorScope === "version_bound" ? "/版本限定" : ""}] ${item.canonicalAnchor?.quote?.exact || item.displayAnchor?.quote?.exact || ""}${item.comment ? `：${item.comment}` : ""}`).join("\n");
    return { mode, filename: `${inspiration.title || "带标注转写"}.md`, content: `# ${inspiration.title}\n\n${transcript.raw_text}\n\n## 标注\n\n${footnotes || "无标注"}\n\n---\n${source}` };
  }

  deleteInspiration(ownerId, inspirationId) {
    this.requireInspiration(ownerId, inspirationId);
    const result = this.db.prepare("DELETE FROM inspirations WHERE id=? AND owner_id=?").run(inspirationId, ownerId);
    return { deleted: result.changes === 1 };
  }
}
