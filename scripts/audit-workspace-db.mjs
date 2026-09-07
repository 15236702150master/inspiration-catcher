import { resolve } from "node:path";
import { openDatabase } from "../lib/db.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const databasePath = resolve(option("--db") || process.env.DATABASE_PATH || "data/inspiration.sqlite3");
const db = openDatabase({ databasePath, migrateLegacy: false });
try {
  const tables = [
    "inspirations", "transcript_versions", "reading_documents", "annotations",
    "annotation_anchor_migrations", "personal_documents", "personal_document_revisions",
    "action_items", "analyses", "transcription_jobs", "tag_groups", "tags", "inspiration_tags",
  ];
  const counts = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  const integrity = db.pragma("integrity_check", { simple: true });
  const foreignKeyViolations = db.pragma("foreign_key_check");
  const activePointerViolations = db.prepare(`SELECT COUNT(*) AS count FROM inspirations i
    WHERE (i.active_transcript_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM transcript_versions t WHERE t.id=i.active_transcript_id AND t.inspiration_id=i.id))
       OR (i.active_reading_document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reading_documents d WHERE d.id=i.active_reading_document_id AND d.inspiration_id=i.id))`).get().count;
  const annotationOwnerViolations = db.prepare(`SELECT COUNT(*) AS count FROM annotations a
    JOIN inspirations i ON i.id=a.inspiration_id WHERE a.owner_id<>i.owner_id`).get().count;
  const schemaVersions = db.prepare("SELECT version,applied_at FROM schema_migrations ORDER BY version").all();
  const report = { databasePath, integrity, foreignKeyViolations, activePointerViolations, annotationOwnerViolations, schemaVersions, counts };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (integrity !== "ok" || foreignKeyViolations.length || activePointerViolations || annotationOwnerViolations) process.exitCode = 1;
} finally {
  db.close();
}
