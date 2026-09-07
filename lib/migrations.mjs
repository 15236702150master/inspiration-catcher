import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildBlocks, normalizeText, sha256Text } from "./transcript-workspace.mjs";

export const SCHEMA_VERSION = 4;

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
}

function applySchemaV4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inspiration_libraries (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_owner_name_active
      ON inspiration_libraries(owner_id,name) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_owner_default
      ON inspiration_libraries(owner_id) WHERE is_default=1 AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_libraries_owner_sort
      ON inspiration_libraries(owner_id,deleted_at,sort_order,name);

    CREATE TABLE IF NOT EXISTS inspiration_library_assignments (
      inspiration_id TEXT PRIMARY KEY REFERENCES inspirations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      library_id TEXT NOT NULL REFERENCES inspiration_libraries(id) ON DELETE RESTRICT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_assignments_owner_library
      ON inspiration_library_assignments(owner_id,library_id,updated_at DESC);

    CREATE TABLE IF NOT EXISTS feishu_library_bindings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      connection_id TEXT REFERENCES feishu_connections(id) ON DELETE SET NULL,
      library_id TEXT NOT NULL REFERENCES inspiration_libraries(id) ON DELETE RESTRICT,
      space_id TEXT NOT NULL,
      root_parent_node_token TEXT,
      wiki_node_token TEXT,
      docx_document_id TEXT,
      document_url TEXT,
      library_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','deleting','deleted','failed')),
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id,connection_id,library_id)
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_library_bindings_owner
      ON feishu_library_bindings(owner_id,status,updated_at DESC);

    CREATE TABLE IF NOT EXISTS feishu_app_credentials (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL,
      app_secret_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  for (const [column, definition] of [
    ["library_id", "TEXT"],
    ["space_id", "TEXT"],
    ["parent_wiki_node_token", "TEXT"],
    ["last_moved_at", "TEXT"],
    ["library_bitable_record_id", "TEXT"],
  ]) {
    if (!hasColumn(db, "feishu_document_bindings", column)) db.exec(`ALTER TABLE feishu_document_bindings ADD COLUMN ${column} ${definition}`);
  }
  for (const [column, definition] of [
    ["library_bitable_table_id", "TEXT"],
    ["library_bitable_view_id", "TEXT"],
  ]) {
    if (!hasColumn(db, "feishu_library_bindings", column)) db.exec(`ALTER TABLE feishu_library_bindings ADD COLUMN ${column} ${definition}`);
  }
  const timestamp = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO inspiration_libraries
      (id,owner_id,name,is_default,sort_order,created_at,updated_at)
      SELECT 'library-default-' || owner_id,owner_id,'待分类',1,0,?,?
      FROM inspirations GROUP BY owner_id`).run(timestamp, timestamp);
    db.prepare(`INSERT OR IGNORE INTO inspiration_library_assignments
      (inspiration_id,owner_id,library_id,updated_at)
      SELECT id,owner_id,'library-default-' || owner_id,? FROM inspirations`).run(timestamp);
  })();
}

function applySchemaV3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_connections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL UNIQUE,
      tenant_key TEXT NOT NULL DEFAULT '',
      feishu_user_id TEXT NOT NULL DEFAULT '',
      feishu_user_name TEXT NOT NULL DEFAULT '',
      access_token_ciphertext TEXT NOT NULL,
      refresh_token_ciphertext TEXT NOT NULL,
      token_expires_at TEXT NOT NULL,
      refresh_token_expires_at TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      space_id TEXT,
      space_name TEXT NOT NULL DEFAULT '',
      parent_node_token TEXT,
      bitable_app_token TEXT,
      bitable_table_id TEXT,
      bitable_url TEXT,
      sync_policy TEXT NOT NULL DEFAULT 'new_only' CHECK(sync_policy IN ('new_only','all')),
      status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','paused','reauthorize','permission_error')),
      last_error_code TEXT,
      last_error_message TEXT,
      connected_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_connections_owner_status ON feishu_connections(owner_id,status);

    CREATE TABLE IF NOT EXISTS feishu_document_bindings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      connection_id TEXT REFERENCES feishu_connections(id) ON DELETE SET NULL,
      inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
      wiki_node_token TEXT,
      docx_document_id TEXT,
      bitable_record_id TEXT,
      document_url TEXT,
      section_blocks_json TEXT NOT NULL DEFAULT '{}',
      remote_version INTEGER,
      source_hash TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','syncing','synced','failed','reauthorize','permission_error')),
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_details_json TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id,inspiration_id),
      UNIQUE(connection_id,inspiration_id)
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_bindings_owner_status ON feishu_document_bindings(owner_id,sync_status,updated_at DESC);

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      integration TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES feishu_connections(id) ON DELETE CASCADE,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_kind TEXT NOT NULL DEFAULT 'refresh',
      dedupe_key TEXT NOT NULL,
      active_key TEXT UNIQUE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','succeeded','failed','canceled')),
      revision INTEGER NOT NULL DEFAULT 1,
      claimed_revision INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      available_at TEXT NOT NULL,
      first_queued_at TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_details_json TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_claim ON sync_outbox(integration,status,available_at,lease_expires_at,created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_owner_aggregate ON sync_outbox(owner_id,integration,aggregate_type,aggregate_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS integration_oauth_states (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      state_hash TEXT NOT NULL UNIQUE,
      code_verifier_ciphertext TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      return_to TEXT NOT NULL DEFAULT '/',
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_oauth_owner ON integration_oauth_states(owner_id,provider,expires_at DESC);
  `);
}

function applySchemaV2(db) {
  const columns = db.prepare("PRAGMA table_info(annotation_anchor_migrations)").all();
  const newDocument = columns.find(column => column.name === "new_document_id");
  const hasTranscriptTarget = columns.some(column => column.name === "new_transcript_version_id");
  if ((!newDocument || newDocument.notnull === 0) && hasTranscriptTarget) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE annotation_anchor_migrations_v2 (
        id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
        old_document_id TEXT, new_document_id TEXT REFERENCES reading_documents(id) ON DELETE CASCADE,
        new_transcript_version_id TEXT REFERENCES transcript_versions(id) ON DELETE CASCADE,
        strategy TEXT NOT NULL, confidence REAL NOT NULL, old_anchor_json TEXT, new_anchor_json TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO annotation_anchor_migrations_v2
        (id,annotation_id,old_document_id,new_document_id,strategy,confidence,old_anchor_json,new_anchor_json,created_at)
        SELECT id,annotation_id,old_document_id,new_document_id,strategy,confidence,old_anchor_json,new_anchor_json,created_at
        FROM annotation_anchor_migrations;
      DROP TABLE annotation_anchor_migrations;
      ALTER TABLE annotation_anchor_migrations_v2 RENAME TO annotation_anchor_migrations;
      CREATE INDEX IF NOT EXISTS idx_anchor_migrations_target ON annotation_anchor_migrations(annotation_id,new_document_id,new_transcript_version_id,created_at DESC);
    `);
  })();
}

export function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_imports (
      source_name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL, report_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inspirations (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      thumbnail TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,
      quick_thought TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', transcription_status TEXT NOT NULL DEFAULT '',
      transcription_job_id TEXT, active_transcript_id TEXT, active_reading_document_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspirations_owner_updated ON inspirations(owner_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inspirations_owner_url ON inspirations(owner_id, url) WHERE url <> '';
    CREATE TABLE IF NOT EXISTS tag_groups (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_tag_groups_owner ON tag_groups(owner_id, sort_order);
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES tag_groups(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_owner_group ON tags(owner_id, group_id, name);
    CREATE TABLE IF NOT EXISTS inspiration_tags (
      inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(inspiration_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS transcript_versions (
      id TEXT PRIMARY KEY, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      origin_job_id TEXT UNIQUE, raw_text TEXT NOT NULL, normalized_text TEXT NOT NULL, sha256 TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'zh-CN', version_no INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(inspiration_id, version_no)
    );
    CREATE INDEX IF NOT EXISTS idx_transcripts_owner_inspiration ON transcript_versions(owner_id, inspiration_id, version_no DESC);
    CREATE TABLE IF NOT EXISTS reading_documents (
      id TEXT PRIMARY KEY, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
      transcript_version_id TEXT NOT NULL REFERENCES transcript_versions(id) ON DELETE RESTRICT, owner_id TEXT NOT NULL,
      markdown TEXT NOT NULL, plain_text TEXT NOT NULL, blocks_json TEXT NOT NULL, sha256 TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', prompt_version TEXT NOT NULL DEFAULT '',
      version_no INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(inspiration_id, version_no)
    );
    CREATE INDEX IF NOT EXISTS idx_documents_owner_inspiration ON reading_documents(owner_id, inspiration_id, version_no DESC);
    CREATE TRIGGER IF NOT EXISTS transcript_versions_immutable BEFORE UPDATE ON transcript_versions BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_TRANSCRIPT'); END;
    CREATE TRIGGER IF NOT EXISTS reading_documents_immutable BEFORE UPDATE ON reading_documents BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_READING_DOCUMENT'); END;
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      group_id TEXT NOT NULL, anchor_scope TEXT NOT NULL CHECK(anchor_scope IN ('canonical','version_bound')),
      source_transcript_version_id TEXT REFERENCES transcript_versions(id) ON DELETE RESTRICT,
      canonical_anchor_json TEXT, display_reading_document_id TEXT REFERENCES reading_documents(id) ON DELETE RESTRICT,
      display_anchor_json TEXT, kind TEXT NOT NULL CHECK(kind IN ('highlight','underline','comment','ai_note')),
      color TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','orphaned','deleted')),
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      CHECK((anchor_scope='canonical' AND canonical_anchor_json IS NOT NULL AND source_transcript_version_id IS NOT NULL) OR
            (anchor_scope='version_bound' AND display_reading_document_id IS NOT NULL AND display_anchor_json IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_listing ON annotations(owner_id, inspiration_id, status, updated_at, id);
    CREATE TABLE IF NOT EXISTS annotation_anchor_migrations (
      id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
      old_document_id TEXT, new_document_id TEXT REFERENCES reading_documents(id) ON DELETE CASCADE,
      new_transcript_version_id TEXT REFERENCES transcript_versions(id) ON DELETE CASCADE,
      strategy TEXT NOT NULL, confidence REAL NOT NULL, old_anchor_json TEXT, new_anchor_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_documents (
      inspiration_id TEXT PRIMARY KEY REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      content_json TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
      last_mutation_id TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_document_mutations (
      owner_id TEXT NOT NULL, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
      client_mutation_id TEXT NOT NULL, revision INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, inspiration_id, client_mutation_id)
    );
    CREATE TABLE IF NOT EXISTS personal_document_revisions (
      id TEXT PRIMARY KEY, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      content_json TEXT NOT NULL, plain_text TEXT NOT NULL, revision INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(inspiration_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_personal_revisions ON personal_document_revisions(owner_id, inspiration_id, revision DESC);
    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      source_annotation_id TEXT REFERENCES annotations(id) ON DELETE SET NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','canceled')), due_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_items_owner ON action_items(owner_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_owner_inspiration ON analyses(owner_id, inspiration_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS transcription_jobs (
      id TEXT PRIMARY KEY, inspiration_id TEXT REFERENCES inspirations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT '',
      media_file TEXT, transcript TEXT NOT NULL DEFAULT '', error TEXT, raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_claim ON transcription_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS mutation_idempotency (
      owner_id TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, status INTEGER NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_id, scope, idempotency_key)
    );
  `);
  applySchemaV2(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
  applySchemaV3(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
  applySchemaV4(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function sourceChecksum(path) {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function normalizedUrl(value) { return String(value || "").trim().replace(/#.*$/, "").replace(/\/$/, ""); }
function nowOf(value) { const parsed = new Date(value || ""); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString(); }
function stableId(prefix, ...values) { return `${prefix}-${createHash("sha1").update(values.join("\0")).digest("hex").slice(0, 20)}`; }

export function migrateLegacyData(db, { dataDirectory, dryRun = false } = {}) {
  if (!dataDirectory) throw new Error("dataDirectory is required");
  const files = { users: "users.json", notes: "notes.json", analyses: "analyses.json", jobs: "jobs.json", tags: "tags.json" };
  const checksums = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sourceChecksum(join(dataDirectory, file))]));
  const users = readJson(join(dataDirectory, files.users), []);
  const notes = readJson(join(dataDirectory, files.notes), []);
  const analysisItems = readJson(join(dataDirectory, files.analyses), []);
  const jobs = readJson(join(dataDirectory, files.jobs), []);
  const tagData = readJson(join(dataDirectory, files.tags), { groups: [] });
  const defaultOwnerId = users[0]?.id || notes.find(item => item.ownerId)?.ownerId || analysisItems.find(item => item.ownerId)?.ownerId || "legacy-owner";
  const report = { dryRun, checksums, counts: { inspirations: notes.length, analyses: analysisItems.length, jobs: jobs.length, transcriptVersions: 0, readingDocuments: 0, actionItems: 0, tagGroups: 0, tags: 0, inspirationTags: 0 }, orphans: [] };
  if (dryRun) {
    report.counts.transcriptVersions = notes.filter(item => item.transcript).length;
    report.counts.readingDocuments = notes.filter(item => item.formattedTranscript && item.transcript).length;
    report.counts.actionItems = notes.filter(item => item.status === "pending").length;
    report.counts.tagGroups = (tagData.groups || []).length;
    report.counts.tags = (tagData.groups || []).reduce((total, group) => total + (group.tags || []).length, 0);
    return report;
  }

  const transaction = db.transaction(() => {
    const insertInspiration = db.prepare(`INSERT INTO inspirations
      (id, owner_id, title, url, thumbnail, platform, author, duration, quick_thought, status, transcription_status, transcription_job_id, revision, created_at, updated_at)
      VALUES (@id,@ownerId,@title,@url,@thumbnail,@platform,@author,@duration,@quickThought,@status,@transcriptionStatus,@jobId,1,@createdAt,@updatedAt)
      ON CONFLICT(id) DO NOTHING`);
    const updatePointers = db.prepare("UPDATE inspirations SET active_transcript_id=COALESCE(active_transcript_id,?), active_reading_document_id=COALESCE(active_reading_document_id,?) WHERE id=?");
    const insertTranscript = db.prepare(`INSERT OR IGNORE INTO transcript_versions
      (id,inspiration_id,owner_id,origin_job_id,raw_text,normalized_text,sha256,language,version_no,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insertDocument = db.prepare(`INSERT OR IGNORE INTO reading_documents
      (id,inspiration_id,transcript_version_id,owner_id,markdown,plain_text,blocks_json,sha256,provider,model,prompt_version,version_no,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ownerByNote = new Map();
    const noteByUrl = new Map();
    for (const note of notes) {
      const ownerId = note.ownerId || defaultOwnerId;
      ownerByNote.set(note.id, ownerId);
      if (note.url) noteByUrl.set(`${ownerId}\0${normalizedUrl(note.url)}`, note.id);
      insertInspiration.run({ id: note.id, ownerId, title: String(note.title || ""), url: String(note.url || ""), thumbnail: String(note.thumbnail || ""), platform: String(note.platform || ""), author: String(note.author || ""), duration: Number(note.duration || 0), quickThought: String(note.note || note.quickThought || ""), status: String(note.status || "captured"), transcriptionStatus: String(note.transcriptionStatus || ""), jobId: note.transcriptionJobId || null, createdAt: nowOf(note.createdAt), updatedAt: nowOf(note.updatedAt || note.createdAt) });
      let transcriptId = null;
      let documentId = null;
      if (note.transcript) {
        transcriptId = stableId("transcript", note.id, sha256Text(note.transcript));
        insertTranscript.run(transcriptId, note.id, ownerId, note.transcriptionJobId || null, String(note.transcript), normalizeText(note.transcript), sha256Text(note.transcript), "zh-CN", 1, nowOf(note.updatedAt || note.createdAt));
        report.counts.transcriptVersions += 1;
      }
      if (note.formattedTranscript && transcriptId) {
        documentId = stableId("document", note.id, sha256Text(note.formattedTranscript));
        const markdown = normalizeText(note.formattedTranscript);
        const blocks = buildBlocks(markdown);
        insertDocument.run(documentId, note.id, transcriptId, ownerId, markdown, blocks.map(block => block.text).join("\n\n"), JSON.stringify(blocks), sha256Text(markdown), "legacy", "", "legacy-v1", 1, nowOf(note.updatedAt || note.createdAt));
        report.counts.readingDocuments += 1;
      }
      updatePointers.run(transcriptId, documentId, note.id);
    }

    const owners = new Set([...ownerByNote.values(), defaultOwnerId]);
    const groupRows = [];
    const legacyGroups = Array.isArray(tagData.groups) && tagData.groups.length ? tagData.groups : [{ id: "ungrouped", name: "未分组", tags: [] }];
    for (const ownerId of owners) {
      let order = 0;
      for (const group of legacyGroups) {
        const id = ownerId === defaultOwnerId ? String(group.id || stableId("group", ownerId, group.name)) : stableId("group", ownerId, group.id || group.name);
        db.prepare("INSERT OR IGNORE INTO tag_groups(id,owner_id,parent_id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, ownerId, null, String(group.name || "未分组"), order++, new Date().toISOString(), new Date().toISOString());
        groupRows.push({ ownerId, id, sourceId: group.id, name: group.name, tags: group.tags || [] });
        report.counts.tagGroups += 1;
        for (const legacyTag of group.tags || []) {
          const name = typeof legacyTag === "string" ? legacyTag : legacyTag.name;
          const tagId = typeof legacyTag === "object" && legacyTag.id && ownerId === defaultOwnerId ? legacyTag.id : stableId("tag", ownerId, name);
          db.prepare("INSERT OR IGNORE INTO tags(id,owner_id,group_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(tagId, ownerId, id, name, new Date().toISOString(), new Date().toISOString());
          report.counts.tags += 1;
        }
      }
    }
    for (const note of notes) {
      const ownerId = note.ownerId || defaultOwnerId;
      for (const legacyTag of note.tags || []) {
        const name = typeof legacyTag === "string" ? legacyTag : legacyTag.name;
        let tag = db.prepare("SELECT id FROM tags WHERE owner_id=? AND name=?").get(ownerId, name);
        if (!tag) {
          let group = db.prepare("SELECT id FROM tag_groups WHERE owner_id=? AND name='未分组'").get(ownerId) || db.prepare("SELECT id FROM tag_groups WHERE owner_id=? ORDER BY sort_order LIMIT 1").get(ownerId);
          if (!group) { const id = stableId("group", ownerId, "ungrouped"); db.prepare("INSERT INTO tag_groups VALUES (?,?,?,?,?,?,?)").run(id, ownerId, null, "未分组", 0, new Date().toISOString(), new Date().toISOString()); group = { id }; }
          const id = stableId("tag", ownerId, name); db.prepare("INSERT OR IGNORE INTO tags(id,owner_id,group_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, ownerId, group.id, name, new Date().toISOString(), new Date().toISOString()); tag = { id };
        }
        db.prepare("INSERT OR IGNORE INTO inspiration_tags(inspiration_id,tag_id) VALUES (?,?)").run(note.id, tag.id);
        report.counts.inspirationTags += 1;
      }
      if (note.status === "pending") {
        const id = stableId("action", note.id, "legacy-pending");
        db.prepare("INSERT OR IGNORE INTO action_items(id,inspiration_id,owner_id,title,note,status,due_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,'pending',NULL,1,?,?)").run(id, note.id, ownerId, note.title || "待实践", note.note || "由旧待实践状态迁移", nowOf(note.createdAt), nowOf(note.updatedAt));
        report.counts.actionItems += 1;
      }
    }

    for (const item of analysisItems) {
      const ownerId = item.ownerId || defaultOwnerId;
      const inspirationId = item.inspirationId || noteByUrl.get(`${ownerId}\0${normalizedUrl(item.sourceUrl)}`);
      if (!inspirationId || !ownerByNote.has(inspirationId)) { report.orphans.push({ type: "analysis", id: item.id }); continue; }
      db.prepare(`INSERT OR IGNORE INTO analyses(id,inspiration_id,owner_id,type,title,content,provider,model,source_url,raw_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(item.id || randomUUID(), inspirationId, ownerId, String(item.type || "analysis"), String(item.title || ""), String(item.content || item.markdown || ""), String(item.provider || ""), String(item.model || ""), String(item.sourceUrl || ""), JSON.stringify(item), nowOf(item.createdAt));
    }
    for (const job of jobs) {
      const ownerId = job.ownerId || defaultOwnerId;
      const inspirationId = job.inspirationId || noteByUrl.get(`${ownerId}\0${normalizedUrl(job.url)}`) || null;
      db.prepare(`INSERT OR IGNORE INTO transcription_jobs(id,inspiration_id,owner_id,url,status,progress,stage,media_file,transcript,error,raw_json,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, inspirationId, ownerId, String(job.url || ""), String(job.status || "queued"), Number(job.progress || 0), String(job.stage || ""), job.mediaFile || null, String(job.transcript || ""), job.error || null, JSON.stringify(job), nowOf(job.createdAt), nowOf(job.updatedAt || job.createdAt), job.completedAt ? nowOf(job.completedAt) : null);
    }
    const libraryTimestamp = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO inspiration_libraries
      (id,owner_id,name,is_default,sort_order,created_at,updated_at)
      SELECT 'library-default-' || owner_id,owner_id,'待分类',1,0,?,?
      FROM inspirations GROUP BY owner_id`).run(libraryTimestamp, libraryTimestamp);
    db.prepare(`INSERT OR IGNORE INTO inspiration_library_assignments
      (inspiration_id,owner_id,library_id,updated_at)
      SELECT id,owner_id,'library-default-' || owner_id,? FROM inspirations`).run(libraryTimestamp);
    for (const [name, checksum] of Object.entries(checksums)) if (checksum) db.prepare("INSERT INTO legacy_imports(source_name,sha256,imported_at,report_json) VALUES (?,?,?,?) ON CONFLICT(source_name) DO UPDATE SET sha256=excluded.sha256, imported_at=excluded.imported_at, report_json=excluded.report_json").run(name, checksum, new Date().toISOString(), JSON.stringify(report));
  });
  transaction();
  return report;
}

export const migrateLegacyJson = migrateLegacyData;
