import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./lib/db.mjs";
import { createFeishuIntegration } from "./lib/feishu-integration.mjs";
import { WorkspaceStore } from "./lib/workspace-store.mjs";
import { fetchArticle } from "./lib/article-extractor.mjs";
import { MAX_DOCUMENT_BYTES, extractDocumentFile } from "./lib/document-extractor.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = normalize(process.env.DATA_DIRECTORY || join(root, "data"));
const notesFile = join(dataDirectory, "notes.json");
const jobsFile = join(dataDirectory, "jobs.json");
const settingsFile = join(dataDirectory, "settings.json");
const analysesFile = join(dataDirectory, "analyses.json");
const usersFile = join(dataDirectory, "users.json");
const tagsFile = join(dataDirectory, "tags.json");
const mediaDirectory = join(dataDirectory, "media");
const coverDirectory = join(root, "covers");
const jobRetentionDays = Number(process.env.JOB_RETENTION_DAYS || 7);
const jobRetentionCount = Number(process.env.JOB_RETENTION_COUNT || 20);
const port = Number(process.env.PORT || 4173);
const jsonLimit = 1_000_000;
const uploadLimit = MAX_DOCUMENT_BYTES + 1_000_000;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const jobs = new Map();
const sessions = new Map();

await mkdir(dataDirectory, { recursive: true });
await mkdir(mediaDirectory, { recursive: true });
await mkdir(coverDirectory, { recursive: true });
if (!existsSync(notesFile)) await writeFile(notesFile, "[]\n", "utf8");
if (!existsSync(jobsFile)) await writeFile(jobsFile, "[]\n", "utf8");
if (!existsSync(settingsFile)) await writeFile(settingsFile, "{}\n", "utf8");
if (!existsSync(analysesFile)) await writeFile(analysesFile, "[]\n", "utf8");
if (!existsSync(usersFile)) await writeFile(usersFile, "[]\n", "utf8");
if (!existsSync(tagsFile)) await writeFile(tagsFile, JSON.stringify({ groups: [{ id: "ungrouped", name: "未分组", tags: [] }] }, null, 2) + "\n", "utf8");
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of (await readFile(envFile, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}
async function pruneArchivedLocalFiles(summary = {}) {
  const thumbnail = String(summary.thumbnail || "");
  if (!thumbnail.startsWith("/covers/")) return;
  const coverRoot = normalize(`${coverDirectory}${sep}`);
  const coverPath = normalize(join(coverDirectory, decodeURIComponent(thumbnail.slice("/covers/".length))));
  if (!coverPath.startsWith(coverRoot)) return;
  await unlink(coverPath).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

const db = openDatabase({ databasePath: process.env.DATABASE_PATH || join(dataDirectory, "inspiration.sqlite3"), dataDirectory, migrateLegacy: true });
const feishuIntegration = createFeishuIntegration({ db, onPruneArchivedLocal: pruneArchivedLocalFiles });
const workspaceStore = new WorkspaceStore(db, {
  onProjectionChange: (ownerId, inspirationId, options) => feishuIntegration.enqueueProjectionRefresh(ownerId, inspirationId, options),
});
async function archivePreviouslySyncedLocalPayloads() {
  const rows = db.prepare(`SELECT i.id,i.owner_id FROM inspirations i
    JOIN feishu_document_bindings b ON b.inspiration_id=i.id AND b.owner_id=i.owner_id
    WHERE b.sync_status='synced' AND COALESCE(b.document_url,'')<>''
      AND i.status NOT IN ('feishu_archived','feishu_archiving')`).all();
  if (!rows.length) return { archived: 0 };
  const timestamp = new Date().toISOString();
  let archived = 0;
  for (const row of rows) {
    const changed = db.prepare(`UPDATE inspirations SET status='feishu_archived',updated_at=?,revision=revision+1
      WHERE id=? AND owner_id=? AND status NOT IN ('feishu_archived','feishu_archiving')`).run(timestamp, row.id, row.owner_id);
    if (!changed.changes) continue;
    archived += 1;
    const summary = feishuIntegration.pruneArchivedLocalPayload(row.owner_id, row.id, timestamp);
    if (summary) await pruneArchivedLocalFiles(summary).catch(error => console.warn("Feishu archived local file prune failed", error?.message || error));
  }
  if (archived) console.log(`Feishu previously synced local payloads archived: ${archived}`);
  return { archived };
}
await archivePreviouslySyncedLocalPayloads();
feishuIntegration.startWorker();
if (feishuIntegration.configured) {
  const libraryIndexBackfillTimer = setTimeout(() => {
    feishuIntegration.backfillLibraryIndexes?.()
      .then(result => { if (result?.upserted) console.log(`Feishu library Bitable indexes backfilled: ${result.upserted}`); })
      .catch(error => console.warn("Feishu library Bitable index backfill skipped", error?.code || error?.message || error));
  }, 3000);
  libraryIndexBackfillTimer.unref?.();
}
for (const row of db.prepare("SELECT * FROM transcription_jobs").all()) {
  const legacy = (() => { try { return JSON.parse(row.raw_json || "{}"); } catch { return {}; } })();
  jobs.set(row.id, { ...legacy, id: row.id, ownerId: row.owner_id, inspirationId: row.inspiration_id, url: row.url, status: row.status, progress: row.progress, stage: row.stage, mediaFile: row.media_file || undefined, transcript: row.transcript, error: row.error || undefined, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || undefined });
}
await pruneJobs();

function send(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(payload));
}

function fail(response, status, code, message, details) {
  send(response, status, { error: { code, message, ...(details && typeof details === "object" ? details : {}), ...(details ? { details } : {}) } });
}

function imageProxyReferer(target) {
  const host = target.hostname.toLowerCase();
  if (host.endsWith("qpic.cn") || host.includes("mmbiz")) return "https://mp.weixin.qq.com/";
  return target.origin;
}

async function proxyImage(response, rawUrl) {
  let target;
  try { target = new URL(String(rawUrl || "")); } catch { return fail(response, 422, "INVALID_IMAGE_URL", "图片地址无效"); }
  if (!["http:", "https:"].includes(target.protocol)) return fail(response, 422, "INVALID_IMAGE_URL", "图片地址只支持 HTTP/HTTPS");
  const upstream = await fetch(target, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "referer": imageProxyReferer(target),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!upstream.ok) return fail(response, 502, "IMAGE_PROXY_FETCH_FAILED", `图片读取失败：HTTP ${upstream.status}`);
  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  if (!/^image\//i.test(contentType)) return fail(response, 502, "IMAGE_PROXY_NOT_IMAGE", "远程地址没有返回图片");
  const buffer = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=600",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(buffer);
}

function requestOrigin(request) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",", 1)[0].trim();
  const protocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  const host = forwardedHost || request.headers.host || `127.0.0.1:${port}`;
  return `${protocol}://${host}`;
}

function enqueueFeishuProjection(ownerId, inspirationId, options = {}) {
  if (!ownerId || !inspirationId) return { queued: false, reason: "missing_resource" };
  try { return feishuIntegration.enqueueProjectionRefresh(ownerId, inspirationId, options); }
  catch (error) { console.error("Feishu enqueue failed", error); return { queued: false, reason: error.code || "enqueue_failed" }; }
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > jsonLimit) throw Object.assign(new Error("请求内容过大"), { status: 413, code: "BODY_TOO_LARGE" });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("请求内容不是有效 JSON"), { status: 400, code: "INVALID_JSON" }); }
}

async function binaryBody(request, limit = uploadLimit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    size += buffer.byteLength;
    if (size > limit) throw Object.assign(new Error("上传文件过大"), { status: 413, code: "UPLOAD_TOO_LARGE" });
  }
  return Buffer.concat(chunks, size);
}

function parseContentDisposition(value = "") {
  const result = {};
  for (const part of String(value || "").split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawValue.length) continue;
    result[rawKey.toLowerCase()] = rawValue.join("=").trim().replace(/^"|"$/g, "");
  }
  return result;
}

async function multipartBody(request) {
  const contentType = String(request.headers["content-type"] || "");
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw Object.assign(new Error("上传请求缺少边界"), { status: 400, code: "MULTIPART_BOUNDARY_MISSING" });
  const raw = await binaryBody(request);
  const marker = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(marker, cursor);
    if (start < 0) break;
    let partStart = start + marker.length;
    if (raw.slice(partStart, partStart + 2).toString() === "--") break;
    if (raw.slice(partStart, partStart + 2).toString() === "\r\n") partStart += 2;
    const next = raw.indexOf(marker, partStart);
    if (next < 0) break;
    let part = raw.slice(partStart, next);
    if (part.slice(-2).toString() === "\r\n") part = part.slice(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const headerText = part.slice(0, headerEnd).toString("utf8");
      const data = part.slice(headerEnd + 4);
      const headers = Object.fromEntries(headerText.split(/\r\n/).map(line => {
        const index = line.indexOf(":");
        return index > 0 ? [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] : null;
      }).filter(Boolean));
      const disposition = parseContentDisposition(headers["content-disposition"]);
      if (disposition.filename !== undefined) files.push({ field: disposition.name || "file", filename: disposition.filename, contentType: headers["content-type"] || "", buffer: data });
      else if (disposition.name) fields[disposition.name] = data.toString("utf8");
    }
    cursor = next;
  }
  return { fields, files };
}

async function readJson(path) { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
function defaultLibraryId(ownerId) { return `library-default-${ownerId}`; }
function ensureDefaultLibrary(ownerId) {
  const timestamp = new Date().toISOString();
  const id = defaultLibraryId(ownerId);
  db.prepare(`INSERT OR IGNORE INTO inspiration_libraries
    (id,owner_id,name,is_default,sort_order,created_at,updated_at)
    VALUES (?,?,?,1,0,?,?)`).run(id, ownerId, "待分类", timestamp, timestamp);
  return db.prepare("SELECT * FROM inspiration_libraries WHERE id=? AND owner_id=? AND deleted_at IS NULL").get(id, ownerId);
}
function activeLibrary(ownerId, libraryId) {
  return db.prepare("SELECT * FROM inspiration_libraries WHERE id=? AND owner_id=? AND deleted_at IS NULL").get(libraryId, ownerId);
}
function assignLibrary(ownerId, inspirationId, libraryId, timestamp = new Date().toISOString()) {
  const library = activeLibrary(ownerId, libraryId) || ensureDefaultLibrary(ownerId);
  db.prepare(`INSERT INTO inspiration_library_assignments(inspiration_id,owner_id,library_id,updated_at)
    VALUES (?,?,?,?) ON CONFLICT(inspiration_id) DO UPDATE SET owner_id=excluded.owner_id,
    library_id=excluded.library_id,updated_at=excluded.updated_at`).run(inspirationId, ownerId, library.id, timestamp);
  return library;
}
function librariesFor(ownerId) {
  ensureDefaultLibrary(ownerId);
  return db.prepare(`SELECT l.*,COUNT(i.id) AS note_count FROM inspiration_libraries l
    LEFT JOIN inspiration_library_assignments a ON a.library_id=l.id AND a.owner_id=l.owner_id
    LEFT JOIN inspirations i ON i.id=a.inspiration_id AND i.owner_id=a.owner_id AND i.status NOT IN ('feishu_archived','feishu_archiving')
    WHERE l.owner_id=? AND l.deleted_at IS NULL GROUP BY l.id
    ORDER BY l.is_default DESC,l.sort_order,l.created_at,l.name`).all(ownerId).map(row => ({
      id: row.id,
      name: row.name,
      isDefault: Boolean(row.is_default),
      noteCount: Number(row.note_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}
function markFeishuArchiving(ownerId, inspirationId, timestamp = new Date().toISOString()) {
  db.prepare(`UPDATE inspirations SET status='feishu_archiving',updated_at=?,revision=revision+1
    WHERE id=? AND owner_id=? AND status<>'feishu_archived'`).run(timestamp, inspirationId, ownerId);
}
function enqueueFeishuArchive(ownerId, inspirationId) {
  workspaceStore.requireInspiration(ownerId, inspirationId);
  const current = db.prepare("SELECT status FROM inspirations WHERE id=? AND owner_id=?").get(inspirationId, ownerId);
  if (current?.status === "feishu_archived") return { queued: false, reason: "already_archived", inspirationId, archiveStatus: "feishu_archived" };
  const result = feishuIntegration.enqueueProjectionRefresh(ownerId, inspirationId, {
    delayMs: 0,
    eventKind: "feishu_archive",
    force: true,
    payload: {
      archiveAfterSync: true,
      previousStatus: current?.status && current.status !== "feishu_archiving" ? current.status : null,
    },
  });
  if (result.queued) markFeishuArchiving(ownerId, inspirationId);
  return { ...result, archiveStatus: result.queued ? "feishu_archiving" : "unchanged" };
}
function enqueueFeishuLibraryArchive(ownerId, libraryId) {
  const library = activeLibrary(ownerId, libraryId);
  if (!library) throw Object.assign(new Error("灵感库不存在"), { status: 404, code: "LIBRARY_NOT_FOUND" });
  const rows = db.prepare(`SELECT i.id FROM inspirations i
    JOIN inspiration_library_assignments a ON a.inspiration_id=i.id AND a.owner_id=i.owner_id
    WHERE i.owner_id=? AND a.library_id=? AND i.status NOT IN ('feishu_archived','feishu_archiving')
    ORDER BY i.updated_at DESC,i.id`).all(ownerId, libraryId);
  let queued = 0;
  for (const row of rows) {
    const result = enqueueFeishuArchive(ownerId, row.id);
    if (result.queued) queued += 1;
  }
  return { libraryId, queued, total: rows.length, archiveStatus: queued ? "feishu_archiving" : "unchanged" };
}
async function notes() {
  return db.prepare("SELECT * FROM inspirations ORDER BY updated_at DESC").all().map(row => {
    const transcript = row.active_transcript_id ? db.prepare("SELECT raw_text FROM transcript_versions WHERE id=?").get(row.active_transcript_id)?.raw_text || "" : "";
    const formattedTranscript = row.active_reading_document_id ? db.prepare("SELECT markdown FROM reading_documents WHERE id=?").get(row.active_reading_document_id)?.markdown || "" : "";
    const tags = db.prepare("SELECT t.name FROM tags t JOIN inspiration_tags it ON it.tag_id=t.id WHERE it.inspiration_id=? ORDER BY t.name").all(row.id).map(item => item.name);
    const analysisIds = db.prepare("SELECT id FROM analyses WHERE inspiration_id=? ORDER BY created_at DESC").all(row.id).map(item => item.id);
    const assignment = db.prepare(`SELECT a.library_id,l.name AS library_name FROM inspiration_library_assignments a
      JOIN inspiration_libraries l ON l.id=a.library_id AND l.owner_id=a.owner_id
      WHERE a.inspiration_id=? AND a.owner_id=? AND l.deleted_at IS NULL`).get(row.id, row.owner_id);
    const library = assignment || assignLibrary(row.owner_id, row.id, defaultLibraryId(row.owner_id), row.updated_at);
    return { id: row.id, ownerId: row.owner_id, title: row.title, url: row.url, thumbnail: row.thumbnail, platform: row.platform, author: row.author, duration: row.duration, note: row.quick_thought, status: row.status, transcriptionStatus: row.transcription_status, transcriptionJobId: row.transcription_job_id, activeTranscriptId: row.active_transcript_id, activeReadingDocumentId: row.active_reading_document_id, revision: row.revision, tags, analysisIds, libraryId: library.library_id || library.id, libraryName: library.library_name || library.name, transcript, formattedTranscript, createdAt: row.created_at, updatedAt: row.updated_at };
  });
}
async function saveNotes(value) {
  const upsert = db.prepare(`INSERT INTO inspirations(id,owner_id,title,url,thumbnail,platform,author,duration,quick_thought,status,transcription_status,transcription_job_id,revision,created_at,updated_at)
    VALUES (@id,@ownerId,@title,@url,@thumbnail,@platform,@author,@duration,@note,@status,@transcriptionStatus,@transcriptionJobId,1,@createdAt,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,thumbnail=excluded.thumbnail,platform=excluded.platform,author=excluded.author,duration=excluded.duration,quick_thought=excluded.quick_thought,status=excluded.status,transcription_status=excluded.transcription_status,transcription_job_id=excluded.transcription_job_id,revision=inspirations.revision+1,updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const item of value) {
      const timestamp = item.updatedAt || new Date().toISOString();
      upsert.run({ id: item.id, ownerId: item.ownerId, title: String(item.title || ""), url: String(item.url || ""), thumbnail: String(item.thumbnail || ""), platform: String(item.platform || ""), author: String(item.author || ""), duration: Number(item.duration || 0), note: String(item.note || ""), status: String(item.status || "draft"), transcriptionStatus: String(item.transcriptionStatus || ""), transcriptionJobId: item.transcriptionJobId || null, createdAt: item.createdAt || timestamp, updatedAt: timestamp });
      assignLibrary(item.ownerId, item.id, item.libraryId, timestamp);
      if (Array.isArray(item.tags)) {
        db.prepare("DELETE FROM inspiration_tags WHERE inspiration_id=?").run(item.id);
        for (const name of item.tags.map(tag => typeof tag === "string" ? tag : tag.name).filter(Boolean)) {
          let tag = db.prepare("SELECT id FROM tags WHERE owner_id=? AND name=?").get(item.ownerId, name);
          if (!tag) {
            let group = db.prepare("SELECT id FROM tag_groups WHERE owner_id=? AND name='未分组'").get(item.ownerId);
            if (!group) { const id = `ungrouped-${item.ownerId}`; db.prepare("INSERT OR IGNORE INTO tag_groups(id,owner_id,parent_id,name,sort_order,created_at,updated_at) VALUES (?,?,NULL,'未分组',0,?,?)").run(id, item.ownerId, timestamp, timestamp); group = { id }; }
            const id = `tag-${randomUUID()}`;
            db.prepare("INSERT OR IGNORE INTO tags(id,owner_id,group_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, item.ownerId, group.id, name, timestamp, timestamp);
            tag = db.prepare("SELECT id FROM tags WHERE owner_id=? AND name=?").get(item.ownerId, name);
          }
          if (tag) db.prepare("INSERT OR IGNORE INTO inspiration_tags(inspiration_id,tag_id) VALUES (?,?)").run(item.id, tag.id);
        }
      }
    }
  })();
}
async function saveJobs() {
  const upsert = db.prepare(`INSERT INTO transcription_jobs(id,inspiration_id,owner_id,url,status,progress,stage,media_file,transcript,error,raw_json,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET inspiration_id=excluded.inspiration_id,status=excluded.status,progress=excluded.progress,stage=excluded.stage,media_file=excluded.media_file,transcript=excluded.transcript,error=excluded.error,raw_json=excluded.raw_json,updated_at=excluded.updated_at,completed_at=excluded.completed_at`);
  db.transaction(() => {
    for (const job of jobs.values()) upsert.run(job.id, job.inspirationId || null, job.ownerId, String(job.url || ""), job.status, Number(job.progress || 0), String(job.stage || ""), job.mediaFile || null, String(job.transcript || ""), job.error || null, JSON.stringify(job), job.createdAt || new Date().toISOString(), job.updatedAt || new Date().toISOString(), job.completedAt || null);
    const ids = [...jobs.keys()];
    if (ids.length) db.prepare(`DELETE FROM transcription_jobs WHERE id NOT IN (${ids.map(() => "?").join(",")})`).run(...ids); else db.prepare("DELETE FROM transcription_jobs").run();
  })();
}
async function pruneJobs() {
  const cutoff = Date.now() - jobRetentionDays * 24 * 60 * 60 * 1000;
  const terminal = [...jobs.values()].filter(job => ["completed", "failed", "canceled"].includes(job.status));
  const ownerIds = new Set(terminal.map(job => job.ownerId));
  for (const ownerId of ownerIds) {
    const ownerJobs = terminal.filter(job => job.ownerId === ownerId).sort((a, b) => String(b.completedAt || b.createdAt).localeCompare(String(a.completedAt || a.createdAt)));
    const keep = new Set(ownerJobs.slice(0, jobRetentionCount).map(job => job.id));
    for (const job of ownerJobs) {
      if (keep.has(job.id) && new Date(job.completedAt || job.createdAt).getTime() >= cutoff) continue;
      jobs.delete(job.id);
    }
  }
  await saveJobs();
}
async function settings() { return readJson(settingsFile); }
async function saveSettings(value) { await writeFile(settingsFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
async function analyses() { return db.prepare("SELECT * FROM analyses ORDER BY created_at DESC").all().map(row => ({ ...JSON.parse(row.raw_json || "{}"), id: row.id, ownerId: row.owner_id, inspirationId: row.inspiration_id, type: row.type, title: row.title, markdown: row.content, provider: row.provider, model: row.model, sourceUrl: row.source_url, createdAt: row.created_at })); }
async function saveAnalyses(value) {
  const statement = db.prepare(`INSERT INTO analyses(id,inspiration_id,owner_id,type,title,content,provider,model,source_url,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET type=excluded.type,title=excluded.title,content=excluded.content,provider=excluded.provider,model=excluded.model,source_url=excluded.source_url,raw_json=excluded.raw_json`);
  db.transaction(() => { for (const item of value) if (item.inspirationId && item.ownerId) statement.run(item.id, item.inspirationId, item.ownerId, item.type || "video", item.title || "", item.markdown || item.content || "", item.provider || "", item.model || "", item.sourceUrl || "", JSON.stringify(item), item.createdAt || new Date().toISOString()); })();
}
async function users() { return readJson(usersFile); }
async function saveUsers(value) { await writeFile(usersFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
function normalizedUrl(value) { return String(value || "").trim().replace(/#.*$/, "").replace(/\/$/, ""); }
function belongsTo(item, ownerId) { return Boolean(ownerId && item.ownerId === ownerId); }
function findInspiration(items, ownerId, input = {}) {
  if (input.inspirationId) return items.find(item => item.id === input.inspirationId && belongsTo(item, ownerId));
  const sourceUrl = normalizedUrl(input.url || input.sourceUrl);
  return sourceUrl ? items.find(item => belongsTo(item, ownerId) && normalizedUrl(item.url) === sourceUrl) : null;
}
async function updateInspiration(inspirationId, ownerId, patch) {
  if (!inspirationId) return null;
  const items = await notes();
  const item = items.find(note => note.id === inspirationId && belongsTo(note, ownerId));
  if (!item) return null;
  const transcript = Object.hasOwn(patch, "transcript") ? String(patch.transcript || "") : null;
  const formattedTranscript = Object.hasOwn(patch, "formattedTranscript") ? String(patch.formattedTranscript || "") : null;
  const metadata = { ...patch };
  delete metadata.transcript;
  delete metadata.formattedTranscript;
  delete metadata.transcriptionError;
  Object.assign(item, metadata, { updatedAt: new Date().toISOString() });
  await saveNotes(items);
  if (transcript && transcript !== item.transcript) workspaceStore.createTranscriptVersion(ownerId, inspirationId, { rawText: transcript, originJobId: patch.transcriptionJobId || null });
  if (formattedTranscript) {
    const refreshed = workspaceStore.requireInspiration(ownerId, inspirationId);
    const current = refreshed.active_reading_document_id ? db.prepare("SELECT markdown FROM reading_documents WHERE id=?").get(refreshed.active_reading_document_id) : null;
    if (!current || current.markdown !== formattedTranscript) workspaceStore.createReadingDocument(ownerId, inspirationId, { markdown: formattedTranscript, provider: "legacy", promptVersion: "compat-v1" });
  }
  enqueueFeishuProjection(ownerId, inspirationId, { delayMs: transcript || formattedTranscript ? 0 : 5000, eventKind: transcript ? "transcript" : formattedTranscript ? "reading_document" : "inspiration" });
  return (await notes()).find(note => note.id === inspirationId && belongsTo(note, ownerId)) || item;
}
async function persistDraft(ownerId, input, video) {
  const items = await notes();
  let item = findInspiration(items, ownerId, input);
  const now = new Date().toISOString();
  if (!item) {
    item = { id: randomUUID(), ownerId, url: String(video.webpageUrl || input.url || ""), platform: video.platform || platform(input.url), title: String(video.title || "正在解析的视频").slice(0, 200), thumbnail: String(video.thumbnail || ""), author: String(video.author || ""), duration: Number(video.duration || 0), note: "", status: "draft", tags: [], transcript: "", formattedTranscript: "", analysisIds: [], createdAt: now, updatedAt: now };
    items.unshift(item);
  } else {
    Object.assign(item, { ownerId, url: String(video.webpageUrl || item.url || input.url || ""), platform: video.platform || item.platform, title: String(video.title || item.title || "正在解析的视频").slice(0, 200), thumbnail: String(video.thumbnail || item.thumbnail || ""), author: String(video.author || item.author || ""), duration: Number(video.duration || item.duration || 0), updatedAt: now });
  }
  await saveNotes(items);
  enqueueFeishuProjection(ownerId, item.id, { delayMs: 5000, eventKind: "draft" });
  return item;
}
function passwordHash(password, salt = randomBytes(16).toString("hex")) { return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`; }
function passwordMatches(password, stored) { try { const [salt, digest] = String(stored).split(":"); const actual = scryptSync(password, salt, 64); return timingSafeEqual(actual, Buffer.from(digest, "hex")); } catch { return false; } }
function cookieValue(request, name) { const match = String(request.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return match ? decodeURIComponent(match[1]) : ""; }
function currentUser(request) { const token = cookieValue(request, "inspiration_session"); const session = sessions.get(token); return session && session.expiresAt > Date.now() ? session.user : null; }
function sessionCookie(token, maxAge = 60 * 60 * 24 * 30) { return `inspiration_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }
async function tagData(ownerId) {
  const groups = db.prepare("SELECT * FROM tag_groups WHERE owner_id=? ORDER BY sort_order,name").all(ownerId).map(group => ({ id: group.id, name: group.name, parentId: group.parent_id, tags: db.prepare("SELECT id,name FROM tags WHERE group_id=? AND owner_id=? ORDER BY name").all(group.id, ownerId) }));
  if (!groups.length) {
    const id = `ungrouped-${ownerId}`;
    db.prepare("INSERT OR IGNORE INTO tag_groups(id,owner_id,parent_id,name,sort_order,created_at,updated_at) VALUES (?,?,NULL,?,0,?,?)").run(id, ownerId, "未分组", new Date().toISOString(), new Date().toISOString());
    return tagData(ownerId);
  }
  return { groups };
}
function inspirationIdsUsingTag(ownerId, tagId) {
  return db.prepare(`SELECT DISTINCT it.inspiration_id FROM inspiration_tags it
    JOIN inspirations i ON i.id=it.inspiration_id AND i.owner_id=? WHERE it.tag_id=?`).all(ownerId, tagId).map(item => item.inspiration_id);
}
function inspirationIdsUsingTagGroup(ownerId, groupId) {
  return db.prepare(`SELECT DISTINCT it.inspiration_id FROM inspiration_tags it
    JOIN tags t ON t.id=it.tag_id AND t.owner_id=?
    JOIN inspirations i ON i.id=it.inspiration_id AND i.owner_id=? WHERE t.group_id=?`).all(ownerId, ownerId, groupId).map(item => item.inspiration_id);
}
function enqueueTagProjectionChanges(ownerId, inspirationIds, eventKind) {
  for (const inspirationId of new Set(inspirationIds)) {
    enqueueFeishuProjection(ownerId, inspirationId, { delayMs: 5000, eventKind });
  }
}
async function saveTagData(value, ownerId) {
  db.transaction(() => {
    const keepGroups = [];
    const keepTags = [];
    for (const [order, group] of (value.groups || []).entries()) {
      keepGroups.push(group.id);
      db.prepare("INSERT INTO tag_groups(id,owner_id,parent_id,name,sort_order,created_at,updated_at) VALUES (?,?,NULL,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,updated_at=excluded.updated_at").run(group.id, ownerId, group.name, order, new Date().toISOString(), new Date().toISOString());
      for (const raw of group.tags || []) {
        const tag = typeof raw === "string" ? { id: `tag-${createHash("sha1").update(`${ownerId}:${raw}`).digest("hex").slice(0, 12)}`, name: raw } : raw;
        keepTags.push(tag.id);
        db.prepare("INSERT INTO tags(id,owner_id,group_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,name=excluded.name,updated_at=excluded.updated_at").run(tag.id, ownerId, group.id, tag.name, new Date().toISOString(), new Date().toISOString());
      }
    }
    if (keepTags.length) db.prepare(`DELETE FROM tags WHERE owner_id=? AND id NOT IN (${keepTags.map(() => "?").join(",")})`).run(ownerId, ...keepTags); else db.prepare("DELETE FROM tags WHERE owner_id=?").run(ownerId);
    if (keepGroups.length) db.prepare(`DELETE FROM tag_groups WHERE owner_id=? AND id NOT IN (${keepGroups.map(() => "?").join(",")})`).run(ownerId, ...keepGroups);
  })();
}
async function allTags(ownerId) { return (await tagData(ownerId)).groups.flatMap(group => (group.tags || []).map(tag => typeof tag === "string" ? tag : tag.name)).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN")); }

function platform(url) {
  if (/bilibili\.com|b23\.tv/i.test(url)) return "bilibili";
  if (/douyin\.com|v\.douyin\.com/i.test(url)) return "douyin";
  if (/weixin\.qq\.com\/sph\//i.test(url)) return "wechat_channels";
  return "unknown";
}

function command(program, args, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `命令退出码 ${code}`));
    });
  });
}

function runTranscription(job, url) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const script = fileURLToPath(new URL("scripts/transcribe-url.sh", import.meta.url)).replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll("\\", "/");
  command("wsl", ["-e", "bash", script, url, job.id], 12 * 60 * 60 * 1000)
    .then(async transcript => { job.status = "completed"; job.progress = 100; job.stage = "转写完成"; job.transcript = transcript.trim(); job.completedAt = new Date().toISOString(); await saveJobs(); await updateInspiration(job.inspirationId, job.ownerId, { transcript: job.transcript, transcriptionStatus: "completed", transcriptionJobId: job.id }); })
    .catch(async error => { job.status = "failed"; job.error = error.message; job.completedAt = new Date().toISOString(); await saveJobs(); await updateInspiration(job.inspirationId, job.ownerId, { transcriptionStatus: "failed", transcriptionError: job.error, transcriptionJobId: job.id }); });
}

async function prepareMedia(job, url) {
  try {
    job.status = "downloading"; job.progress = 5; job.stage = "正在下载视频"; await saveJobs();
    const template = join(mediaDirectory, `${job.id}.%(ext)s`);
    const proxyArgs = process.env.MEDIA_PROXY_URL ? ["--proxy", process.env.MEDIA_PROXY_URL] : [];
    try {
      await command(process.env.YTDLP_PATH || "yt-dlp", ["--no-playlist", ...proxyArgs, "-f", "bestaudio/best", "-o", template, url], 30 * 60 * 1000);
    } catch (downloadError) {
      if (!/\.(mp3|m4a|wav|flac|ogg|mp4|webm)(?:\?|$)/i.test(url)) throw downloadError;
      const extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "media";
      const curlProxy = process.env.MEDIA_PROXY_URL ? ["--proxy", process.env.MEDIA_PROXY_URL] : [];
      await command("curl", ["-L", "--fail", "--max-time", "1800", ...curlProxy, "-o", join(mediaDirectory, `${job.id}.${extension}`), url], 30 * 60 * 1000);
    }
    const filename = (await readdir(mediaDirectory)).find(name => name.startsWith(`${job.id}.`));
    if (!filename) throw new Error("下载完成但未找到媒体文件");
    job.mediaFile = filename; job.status = "queued"; job.progress = 25; job.stage = "等待 Whisper 服务器"; job.updatedAt = new Date().toISOString(); await saveJobs();
  } catch (error) {
    job.status = "failed"; job.error = `视频下载失败：${error.message}`; job.stage = "下载失败"; job.completedAt = new Date().toISOString(); await saveJobs();
    await updateInspiration(job.inspirationId, job.ownerId, { transcriptionStatus: "failed", transcriptionError: job.error, transcriptionJobId: job.id });
  }
}

function workerAuthorized(request) { const token = request.headers.authorization?.replace(/^Bearer\s+/i, ""); return Boolean(process.env.WORKER_TOKEN && token === process.env.WORKER_TOKEN); }

async function inspectVideo(url) {
  const source = platform(url);
  if (source === "unknown") throw Object.assign(new Error("目前支持抖音、B站和微信视频号链接"), { status: 422, code: "UNSUPPORTED_PLATFORM" });
  if (source === "wechat_channels") {
    let payload;
    let responseOk = true;
    try {
      const response = await fetch("https://sph.litao.workers.dev/api/fetch_video_profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(15_000) });
      responseOk = response.ok;
      payload = await response.json();
    } catch {
      if (process.platform === "win32") {
        const encoded = Buffer.from(JSON.stringify({ url }), "utf16le").toString("base64");
        const script = `$body=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); Invoke-RestMethod 'https://sph.litao.workers.dev/api/fetch_video_profile' -Method Post -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 20 -Compress`;
        payload = JSON.parse(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 35_000));
      } else {
        const proxyArgs = process.env.WECHAT_PROXY_URL ? ["--proxy", process.env.WECHAT_PROXY_URL] : [];
        payload = JSON.parse(await command("curl", ["-sS", "--max-time", "30", ...proxyArgs, "-X", "POST", "-H", "Content-Type: application/json", "--data", JSON.stringify({ url }), "https://sph.litao.workers.dev/api/fetch_video_profile"], 35_000));
      }
    }
    const feed = payload.data?.feedInfo;
    if (!responseOk || !feed) throw Object.assign(new Error(payload.error || "视频号分享链接解析失败"), { status: 502, code: "WECHAT_RESOLVE_FAILED" });
    return { platform: source, status: "ready", title: feed.description || "微信视频号", author: payload.data?.authorInfo?.nickname || "", duration: Number(feed.mediaDuration || 0), thumbnail: feed.coverUrl || "", mediaUrl: feed.h264VideoInfo?.videoUrl || feed.h265VideoInfo?.videoUrl || feed.videoUrl || "", webpageUrl: url };
  }
  let metadata;
  try {
    const program = process.platform === "win32" ? "wsl" : process.env.YTDLP_PATH || "yt-dlp";
    const wslYtdlp = process.env.YTDLP_WSL_PATH || "yt-dlp";
    const args = process.platform === "win32" ? ["-e", wslYtdlp, "--no-playlist", "--skip-download", "--dump-single-json", url] : ["--no-playlist", "--skip-download", "--dump-single-json", url];
    const output = await command(program, args);
    metadata = JSON.parse(output);
  } catch (error) {
    if (source !== "bilibili") throw error;
    const id = url.match(/BV[\w]+/i)?.[0];
    if (!id) throw error;
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`, { headers: { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" } });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw error;
    metadata = { title: payload.data.title, uploader: payload.data.owner?.name, duration: payload.data.duration, thumbnail: payload.data.pic, webpage_url: url };
  }
  return { platform: source, status: "ready", title: metadata.title || "未命名视频", author: metadata.uploader || metadata.channel || "", duration: metadata.duration || 0, thumbnail: metadata.thumbnail || "", webpageUrl: metadata.webpage_url || url };
}

async function cacheCover(video) {
  if (!video.thumbnail) return video;
  const name = `${createHash("sha256").update(video.thumbnail).digest("hex").slice(0, 24)}.jpg`;
  const path = join(coverDirectory, name);
  if (!existsSync(path)) {
    try {
      const response = await fetch(video.thumbnail, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0" } });
      if (!response.ok) throw new Error(`cover HTTP ${response.status}`);
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
    } catch {
      const proxyArgs = process.env.WECHAT_PROXY_URL ? ["--proxy", process.env.WECHAT_PROXY_URL] : [];
      await command(process.platform === "win32" ? "curl.exe" : "curl", ["-L", "--fail", "--max-time", "30", ...proxyArgs, "-o", path, video.thumbnail], 35_000);
    }
  }
  return { ...video, thumbnail: `/covers/${name}` };
}

const providerDefaults = {
  deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1/chat/completions", model: process.env.DEEPSEEK_MODEL || "deepseek-chat", protocol: "openai" },
  openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions", model: process.env.OPENAI_MODEL || "gpt-4.1-mini", protocol: "openai" },
  claude: { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages", model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514", protocol: "anthropic" },
  grok: { apiKeyEnv: "XAI_API_KEY", baseUrl: process.env.XAI_BASE_URL || "https://api.x.ai/v1/chat/completions", model: process.env.XAI_MODEL || "grok-3-mini", protocol: "openai" }
};

const modelCatalog = {
  deepseek: [{ id: "deepseek-chat", effort: [] }, { id: "deepseek-reasoner", effort: ["medium"] }],
  openai: [{ id: "gpt-5.6", effort: [] }, { id: "gpt-5.6-sol", effort: ["low", "medium", "high", "xhigh", "max", "ultra"] }, { id: "gpt-5.6-terra", effort: ["low", "medium", "high", "xhigh", "max", "ultra"] }, { id: "gpt-5.6-luna", effort: ["low", "medium", "high", "xhigh", "max", "ultra"] }, { id: "gpt-5.5", effort: ["none", "low", "medium", "high", "xhigh"] }, { id: "gpt-5.5-pro", effort: ["medium", "high", "xhigh"] }, { id: "gpt-5.4", effort: ["none", "low", "medium", "high", "xhigh"] }, { id: "gpt-5.4-mini", effort: ["none", "low", "medium", "high"] }, { id: "gpt-5.4-nano", effort: ["none", "low", "medium"] }, { id: "gpt-5", effort: ["minimal", "low", "medium", "high", "xhigh"] }, { id: "gpt-5-mini", effort: ["minimal", "low", "medium", "high"] }, { id: "gpt-5-nano", effort: ["minimal", "low", "medium"] }, { id: "gpt-5.3-codex", effort: ["low", "medium", "high", "xhigh"] }, { id: "o4-mini", effort: ["low", "medium", "high"] }, { id: "o3", effort: ["low", "medium", "high"] }, { id: "gpt-4.1", effort: [] }, { id: "gpt-4.1-mini", effort: [] }, { id: "gpt-4.1-nano", effort: [] }, { id: "gpt-4o", effort: [] }, { id: "gpt-4o-mini", effort: [] }],
  claude: [{ id: "claude-opus-4-6", effort: ["low", "medium", "high", "max"] }, { id: "claude-sonnet-4-6", effort: ["low", "medium", "high"] }, { id: "claude-opus-4-5-20251101", effort: ["low", "medium", "high"] }, { id: "claude-sonnet-4-5-20250929", effort: ["low", "medium", "high"] }, { id: "claude-haiku-4-5-20251001", effort: [] }, { id: "claude-opus-4-1-20250805", effort: ["low", "medium", "high"] }, { id: "claude-opus-4-20250514", effort: ["low", "medium", "high"] }, { id: "claude-sonnet-4-20250514", effort: ["low", "medium", "high"] }, { id: "claude-3-7-sonnet-20250219", effort: ["low", "medium", "high"] }, { id: "claude-3-5-haiku-20241022", effort: [] }],
  grok: [{ id: "grok-4.5", effort: ["low", "medium", "high"] }, { id: "grok-4", effort: ["low", "medium", "high"] }, { id: "grok-3", effort: [] }, { id: "grok-3-mini", effort: ["low", "medium", "high"] }, { id: "grok-2-latest", effort: [] }]
};

async function providerState(name) {
  const fallback = providerDefaults[name];
  if (!fallback) throw Object.assign(new Error("未知 AI 平台"), { status: 422, code: "INVALID_PROVIDER" });
  const saved = (await settings()).providers?.[name] || {};
  const legacy = { id: "default", name: saved.profileName || "默认配置", baseUrl: saved.baseUrl || fallback.baseUrl, model: saved.model || fallback.model, protocol: saved.protocol || fallback.protocol, reasoningEffort: saved.reasoningEffort || "medium", apiKey: saved.apiKey || process.env[fallback.apiKeyEnv] || "" };
  const profiles = Array.isArray(saved.profiles) && saved.profiles.length ? saved.profiles : [legacy];
  const activeProfileId = profiles.some(profile => profile.id === saved.activeProfileId) ? saved.activeProfileId : profiles[0].id;
  return { profiles, activeProfileId };
}

async function providerConfig(name) {
  const fallback = providerDefaults[name];
  const state = await providerState(name);
  const active = state.profiles.find(profile => profile.id === state.activeProfileId) || state.profiles[0];
  return { ...fallback, ...active, reasoningEffort: active.reasoningEffort || "medium" };
}
function completionUrl(provider) {
  const base = String(provider.baseUrl || "").replace(/\/$/, "");
  if (provider.protocol === "anthropic") return base;
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

const CONTENT_PROMPT = `你是“高价值内容拆解器”。目标：把文章、Word/PDF、视频转写和用户灵感压成一篇可行动、可归档、可被飞书多维表格自动整理的高密度中文笔记。
规则：
1. 只保留新增信息、关键机制、资源、提示词、工作流、方法、概念、案例、模板、数据、人物组织、观点判断、待研究问题和行动机会；删除开场白、总结套话、重复、常识和无依据赞美。
2. 区分“原文明确表达”“合理推断”“用户自己的启发”，不虚构事实；不确定的信息写“待核验”。
3. 不只总结主旨，要主动抓“信息差”：用户可能不知道但可复用、可搜索、可购买/收藏/测试、可改造成流程或资产的细节。
4. 每个结论尽量包含：动作、适用场景、为什么、判断标准；用具体动词、工具名、字段名、网址、步骤和数字，避免空泛词。
5. 默认 700-1200 个中文字符；信息不足时更短，信息丰富也不超过 1600 字。
6. 输出 Markdown 正文，不输出 JSON，不解释你的过程。
可自动整理的底层类型参考：工具/网站、提示词/指令、工作流/玩法、方法/策略、概念/模式、案例/标杆、数据/事实、开源/文档、模板/素材、待研究问题、行动机会、人物/组织、观点/判断。可按内容领域生成更贴切的“开放分类”和“领域”，不要局限于参考类型。
固定结构：
# 一句话结论
一句话说明最值得复用的做法。
## 方法骨架
3-6 条，每条格式“**动作**：做法 → 原理/作用”。
## 关键线索
列 4-10 个最值得单独保存的细节：工具、网址、提示词、流程、玩法、概念、模板、开源项目、案例、数据、观点、待研究问题或行动机会。每条说明“价值/用途/适用场景”。
## 隐含机制
仅列 2-4 个原文未必明说但决定成败的机制，并标注“推断”。
## 可直接照做
按先后顺序给 3-5 步，每步必须可执行、可检查。
## 边界与反例
列出不适用场景、失败信号或需验证的假设，最多 3 条。
## 30 分钟内的下一步
给用户一个最小行动，包含交付物和完成标准。
## 高价值线索索引
必须用下面的单行格式输出 3-12 条，方便程序解析并同步到飞书多维表格；没有外链就写“无”，不要省略字段：
- **类型**：工具/网站｜**开放分类**：AI 生图提示词资源｜**领域**：AI 生图｜**名称**：gpt-image2.canghe.ai｜**外链**：https://gpt-image2.canghe.ai｜**价值**：可收藏为生图提示词搜索与复用入口｜**下一步**：测试 3 个高频提示词并记录效果｜**来源章节**：关键线索
- **类型**：工作流/玩法｜**开放分类**：飞书自动化填表｜**领域**：飞书自动化｜**名称**：让 AI 使用飞书 CLI 自动填多维表格｜**外链**：无｜**价值**：可把拆解出的线索自动写入不同表格，减少手工录入｜**下一步**：核验 CLI 权限、字段映射和写入示例｜**来源章节**：关键线索`;

const CASE_PROMPT = `你是“类似案例研究压缩器”。基于用户主题、视频内容和给定网络搜索结果，找出真正同构的案例、方法或事物，形成高密度中文研究正文。
规则：
1. 不是罗列链接；先判断案例与原做法共享的机制，再比较差异。
2. 只使用给定搜索证据；不确定的信息明确写“待核验”，不得编造案例、数字或来源。
3. 优先保留可迁移做法、成败条件、可验证指标；删除背景故事、宣传语、重复观点和空泛建议。
4. 默认 600-1000 个中文字符，最多 1200 字；每段最多 4 行。
5. 链接使用 Markdown 格式，标题必须可点击；输出 Markdown 正文，不输出 JSON。
固定结构：
# 最相似的机制
用 2-3 句话说明这些案例为何同构。
## 值得看的案例
选 3-5 个最相关案例。每个包含：**案例名**、相似机制、可借鉴动作、关键差异、[来源](URL)。
## 横向规律
提炼 3-5 条跨案例共同规律，并说明证据来自哪些案例。
## 可复用方案
把规律重组为适合用户的 3-5 步方案，每步给检查标准。
## 最小验证
设计一个低成本验证动作，说明观察指标和停止条件。`;

async function analyze(input, ownerId) {
  const provider = await providerConfig(input.provider);
  if (!provider.apiKey) throw Object.assign(new Error(`${input.provider} 尚未配置 API Key`), { status: 503, code: "PROVIDER_NOT_CONFIGURED" });
  const noteItems = await notes();
  const inspiration = findInspiration(noteItems, ownerId, input);
  if (input.inspirationId && !inspiration) throw Object.assign(new Error("灵感记录不存在"), { status: 404, code: "INSPIRATION_NOT_FOUND" });
  const context = {
    ...input,
    title: input.title || inspiration?.title,
    url: input.url || inspiration?.url,
    transcript: input.transcript || inspiration?.transcript,
    note: input.note || inspiration?.note
  };
  let evidence = "";
  if (input.type === "cases") {
    const results = await searchWeb(context.query || context.title || context.note);
    evidence = results.map((item, index) => `${index + 1}. ${item.title}\nURL: ${item.url}\n摘要: ${item.snippet}`).join("\n\n");
  }
  const systemPrompt = input.type === "cases" ? CASE_PROMPT : CONTENT_PROMPT;
  const prompt = `内容标题：${context.title || "（未提供）"}\n来源链接：${context.url || "（未提供）"}\n正文或转写：${context.transcript || "（未生成）"}\n用户感想：${context.note || "（未提供）"}\n研究主题：${context.query || "（未提供）"}${evidence ? `\n\n网络搜索证据：\n${evidence}` : ""}`;
  const isClaude = provider.protocol === "anthropic";
  const supportsEffort = (modelCatalog[input.provider] || []).find(item => item.id === provider.model)?.effort || [];
  const effort = supportsEffort.includes(provider.reasoningEffort) ? provider.reasoningEffort : (supportsEffort.includes("medium") ? "medium" : undefined);
  const response = await fetch(completionUrl(provider), { method: "POST", headers: isClaude ? { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify(isClaude ? { model: provider.model, max_tokens: 12000, ...(effort ? { thinking: { type: "enabled", budget_tokens: { low: 2048, medium: 4096, high: 8192, max: 12000 }[effort] } } : {}), system: systemPrompt, messages: [{ role: "user", content: prompt }] } : { model: provider.model, max_tokens: 1800, ...(effort && effort !== "none" ? { reasoning_effort: effort } : {}), messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }] }) });
  const result = await providerJson(response);
  const markdown = (isClaude ? result.content?.[0]?.text : result.choices?.[0]?.message?.content)?.trim();
  if (!markdown) throw Object.assign(new Error("AI 返回了空内容"), { status: 502, code: "EMPTY_PROVIDER_RESPONSE" });
  const item = { id: randomUUID(), ownerId, inspirationId: inspiration?.id || "", type: input.type === "cases" ? "cases" : "video", provider: input.provider, model: provider.model, title: String(context.title || context.query || (input.type === "cases" ? "类似案例研究" : "内容拆解")), sourceUrl: String(context.url || ""), markdown, promptVersion: input.type === "cases" ? "dense-v1" : "content-clue-v2", createdAt: new Date().toISOString() };
  const items = await analyses(); items.unshift(item); await saveAnalyses(items);
  if (inspiration) {
    inspiration.analysisIds = [...new Set([...(Array.isArray(inspiration.analysisIds) ? inspiration.analysisIds : []), item.id])];
    inspiration.updatedAt = new Date().toISOString();
    await saveNotes(noteItems);
    enqueueFeishuProjection(ownerId, inspiration.id, { delayMs: 0, eventKind: input.type === "cases" ? "cases" : "analysis" });
  }
  return item;
}

async function recommendTags(input, ownerId) {
  const provider = await providerConfig(input.provider);
  if (!provider.apiKey) throw Object.assign(new Error(`${input.provider} 尚未配置 API Key`), { status: 503, code: "PROVIDER_NOT_CONFIGURED" });
  const catalog = await tagData(ownerId);
  const existing = catalog.groups.flatMap(group => (group.tags || []).map(tag => ({ name: typeof tag === "string" ? tag : tag.name, group: group.name })));
  const groups = catalog.groups.map(group => ({ name: group.name, tags: (group.tags || []).map(tag => typeof tag === "string" ? tag : tag.name) }));
  const prompt = `你是一个严谨的个人知识库标签规划师。请完整阅读视频转写、视频标题和用户感想，为这条灵感推荐 3-10 个适合长期复用的标签。标签的目标是让用户以后能用同一标签找到一批相关笔记，而不是把本条视频的每个金句都变成标签。\n\n请先把候选标签分成四类思考：主题领域（如职场成长、个人认知）、使用场景（如职场沟通、团队协作）、可迁移方法（如边界管理、信息管理）、核心机制（如社会比较、激励机制）。优先选择主题领域和使用场景，其次选择可迁移方法，最后才选择核心机制。一个只在本条视频中出现、无法覆盖其他笔记的独特句子，不应成为标签。\n\n必须遵守以下决策顺序：\n1. 先理解完整内容的主旨、领域、场景、方法和机制。\n2. 优先复用已有分组中的已有标签：只要已有标签语义相近且足够准确，就直接使用，不要创造同义新标签。\n3. 如果已有标签不够贴切，可以推荐新标签；新标签必须放入最合适的已有分组。\n4. 如果没有任何已有分组适合，才提出新的一级分组，并在 groupIsNew 中标记 true。\n5. “成长、经验、方法、观点、分享”等词不是绝对禁止；只有它们确实代表整条内容的长期检索主题时才使用。\n6. 标签应稳定、可复用、容易检索，通常 2-10 个汉字；避免同义重复、上下位重复、过度细节化和只描述载体的“视频/内容/记录”。\n7. 不要把一句完整观点、一个夸张标题或一次性事件直接当标签。\n8. 标签数量不足时宁缺毋滥，不要为了凑数强行推荐。\n\n只输出 JSON 数组，不要 Markdown，不要解释。每项必须包含：\n{"name":"标签名","group":"一级分组名","existing":true或false,"groupIsNew":true或false,"type":"主题领域/使用场景/可迁移方法/核心机制","reason":"不超过20字的长期复用理由"}\n\n已有分组和对应标签：\n${JSON.stringify(groups, null, 2)}\n\n视频标题：${input.title || "（无）"}\n视频完整转写：${input.transcript || "（无转写）"}\n用户感想：${input.note || "（无感想）"}`;
  const isClaude = provider.protocol === "anthropic";
  const response = await fetch(completionUrl(provider), { method: "POST", headers: isClaude ? { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify(isClaude ? { model: provider.model, max_tokens: 600, messages: [{ role: "user", content: prompt }] } : { model: provider.model, max_tokens: 600, messages: [{ role: "system", content: "你是标签整理助手。" }, { role: "user", content: prompt }] }) });
  const result = await providerJson(response);
  const text = isClaude ? result.content?.[0]?.text : result.choices?.[0]?.message?.content;
  let tags;
  try { tags = JSON.parse(String(text || "").replace(/^```json\s*|```$/g, "").trim()); } catch { tags = []; }
  const recommended = tags.map(tag => typeof tag === "string" ? { name: tag, group: "未分组", existing: false, groupIsNew: false, reason: "AI 推荐" } : { name: tag.name, group: tag.group || "未分组", existing: Boolean(tag.existing), groupIsNew: Boolean(tag.groupIsNew), reason: tag.reason || "内容贴合" }).map(tag => ({ ...tag, name: String(tag.name || "").replace(/^#/, "").trim(), group: String(tag.group || "未分组").trim() })).filter(tag => tag.name && tag.name.length <= 10).slice(0, 10);
  const existingSet = new Set(existing.map(tag => tag.name));
  return { existing: recommended.filter(tag => existingSet.has(tag.name)), tags: recommended.filter(tag => !existingSet.has(tag.name)), groups: catalog.groups.map(group => ({ id: group.id, name: group.name })) };
}

async function providerJson(response) {
  const raw = await response.text();
  if (!response.ok) { let upstream; try { upstream = JSON.parse(raw); } catch {} const type = upstream?.error?.type; throw Object.assign(new Error(upstream?.error?.message || `AI 服务返回 ${response.status}`), { status: response.status, code: type === "billing_error" ? "PROVIDER_BILLING_ERROR" : `PROVIDER_${response.status}`, details: raw.slice(0, 500) }); }
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error(raw.trim().startsWith("<") ? "AI 接口返回了 HTML 页面，请检查第三方 URL 是否为 API 地址（不是控制台网页地址），以及协议是否选择正确。" : "AI 接口返回的不是有效 JSON，请检查第三方 URL、协议和模型配置。"), { status: 502, code: "PROVIDER_INVALID_RESPONSE" }); }
}

async function providerRequest(url, options) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(50_000) }); }
    catch (error) { throw Object.assign(new Error("AI 服务连续 50 秒无响应，请切换模型或服务配置后重试"), { status: 504, code: "PROVIDER_TIMEOUT", details: error.message }); }
    if (![429, 502, 503, 504].includes(response.status) || attempt === 1) return response;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function formatTranscript(input) {
  const provider = await providerConfig(input.provider);
  if (!provider.apiKey) throw Object.assign(new Error(`${input.provider} 尚未配置 API Key`), { status: 503, code: "PROVIDER_NOT_CONFIGURED" });
  const raw = String(input.transcript || "").trim();
  if (!raw) throw Object.assign(new Error("没有可排版的转写内容"), { status: 422, code: "TRANSCRIPT_REQUIRED" });
  const prompt = `你是中文口述稿排版编辑。把下面的自动转写整理成适合屏幕阅读的 Markdown 正文。\n要求：\n1. 忠实保留原意、事实、论证顺序和重要细节，不新增观点，不写总结报告。\n2. 修正明显的断句、标点和同音错字；删除无信息量的口头重复，但不要过度压缩。\n3. 根据内容生成简短标题；使用 2-5 个二级标题组织主题。\n4. 每段 60-140 个中文字符；关键结论用粗体；连续步骤用列表；引用式金句用引用块。\n5. 不使用段落编号，不输出“排版说明”，只输出 Markdown 正文。\n\n原始转写：\n${raw}`;
  const isClaude = provider.protocol === "anthropic";
  const endpoint = completionUrl(provider);
  const response = await providerRequest(endpoint, { method: "POST", headers: isClaude ? { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify(isClaude ? { model: provider.model, max_tokens: 3600, messages: [{ role: "user", content: prompt }] } : { model: provider.model, max_tokens: 3600, messages: [{ role: "system", content: "你是严谨的中文口述稿排版编辑。" }, { role: "user", content: prompt }] }) });
  const result = await providerJson(response);
  const markdown = (isClaude ? result.content?.[0]?.text : result.choices?.[0]?.message?.content)?.trim();
  if (!markdown) throw Object.assign(new Error("AI 返回了空排版结果"), { status: 502, code: "EMPTY_PROVIDER_RESPONSE" });
  return { markdown, provider: input.provider, model: provider.model };
}

async function runSelectionAi(input, inspiration) {
  const providerName = input.provider || "openai";
  const provider = await providerConfig(providerName);
  if (!provider.apiKey) throw Object.assign(new Error(`${providerName} 尚未配置 API Key`), { status: 503, code: "PROVIDER_NOT_CONFIGURED" });
  const operation = ["explain", "counterexample", "cases", "steps"].includes(input.operation) ? input.operation : "explain";
  const labels = { explain: "解释这段话的含义、隐含前提和适用边界", counterexample: "给出最有力的反例，并说明原观点何时失效", cases: "补充两个同构案例，指出可迁移的共同机制", steps: "把这段话转成明确、可执行、可检查的行动步骤" };
  const selectedText = String(input.selectedText || input.anchor?.quote?.exact || "").trim();
  if (!selectedText) throw Object.assign(new Error("没有可处理的选中文字"), { status: 422, code: "SELECTION_REQUIRED" });
  const prompt = `你是高密度阅读批注助手。${labels[operation]}。只保留有用信息，控制在 250 个中文字符以内，使用简体中文 Markdown，不复述任务。\n\n视频标题：${inspiration.title}\n用户感想：${inspiration.quick_thought || "（无）"}\n选中文字：${selectedText}\n前后文：${String(input.context || "").slice(0, 3000)}`;
  const isClaude = provider.protocol === "anthropic";
  const response = await providerRequest(completionUrl(provider), { method: "POST", headers: isClaude ? { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify(isClaude ? { model: provider.model, max_tokens: 800, messages: [{ role: "user", content: prompt }] } : { model: provider.model, max_tokens: 800, messages: [{ role: "system", content: "你是严谨、精炼的中文阅读批注助手。" }, { role: "user", content: prompt }] }) });
  const result = await providerJson(response);
  const content = (isClaude ? result.content?.[0]?.text : result.choices?.[0]?.message?.content)?.trim();
  if (!content) throw Object.assign(new Error("AI 返回了空批注"), { status: 502, code: "EMPTY_PROVIDER_RESPONSE" });
  return { content, provider: providerName, model: provider.model, operation };
}

function decodeXml(value = "") { return value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"'); }
async function searchWeb(query) {
  const response = await fetch(`https://cn.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, { headers: { "user-agent": "Mozilla/5.0 InspirationCatcher/0.2" } });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/g)].slice(0, 8).map(match => ({ title: decodeXml(match[1]), url: decodeXml(match[2]), snippet: decodeXml(match[3]).replace(/<[^>]+>/g, "") }));
}

async function route(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/auth/me") { const user = currentUser(request); return send(response, 200, { authenticated: Boolean(user), user: user ? { id: user.id, email: user.email } : null }); }
  if (request.method === "POST" && url.pathname === "/api/auth/register") { const input = await body(request); const email = String(input.email || "").trim().toLowerCase(); const password = String(input.password || ""); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(response, 422, "INVALID_EMAIL", "请输入有效邮箱"); if (password.length < 8) return fail(response, 422, "WEAK_PASSWORD", "密码至少 8 位"); const list = await users(); if (list.some(user => user.email === email)) return fail(response, 409, "EMAIL_EXISTS", "该邮箱已注册"); const user = { id: randomUUID(), email, passwordHash: passwordHash(password), createdAt: new Date().toISOString() }; list.push(user); await saveUsers(list); const token = randomUUID(); sessions.set(token, { user: { id: user.id, email: user.email }, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }); return send(response, 201, { authenticated: true, user: { id: user.id, email: user.email } }, { "Set-Cookie": sessionCookie(token) }); }
  if (request.method === "POST" && url.pathname === "/api/auth/login") { const input = await body(request); const email = String(input.email || "").trim().toLowerCase(); const password = String(input.password || ""); const user = (await users()).find(item => item.email === email); if (!user || !passwordMatches(password, user.passwordHash)) return fail(response, 401, "INVALID_CREDENTIALS", "邮箱或密码错误"); const token = randomUUID(); sessions.set(token, { user: { id: user.id, email: user.email }, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }); return send(response, 200, { authenticated: true, user: { id: user.id, email: user.email } }, { "Set-Cookie": sessionCookie(token) }); }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") { const token = cookieValue(request, "inspiration_session"); sessions.delete(token); return send(response, 200, { authenticated: false }, { "Set-Cookie": sessionCookie("", 0) }); }
  if (url.pathname.startsWith("/api/worker/") || url.pathname === "/api/health") { /* worker token and health are handled below */ }
  else if (request.method === "GET"
    && url.pathname === "/api/integrations/feishu/oauth/callback"
    && !currentUser(request)
    && String(request.headers.accept || "").includes("text/html")) {
    const target = new URL("/", requestOrigin(request));
    target.searchParams.set("feishu", "error");
    target.searchParams.set("code", "AUTH_REQUIRED");
    target.searchParams.set("message", "网站登录已过期，请登录后重新连接飞书");
    response.writeHead(302, { Location: `${target.pathname}${target.search}`, "Cache-Control": "no-store" });
    response.end();
    return;
  }
  else if (url.pathname.startsWith("/api/") && !currentUser(request)) return fail(response, 401, "AUTH_REQUIRED", "请先登录");
  const user = currentUser(request);
  if (request.method === "GET" && url.pathname === "/api/image-proxy") {
    await proxyImage(response, url.searchParams.get("url"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/integrations/feishu/status") {
    return send(response, 200, feishuIntegration.getStatus(user.id, { origin: requestOrigin(request) }));
  }
    if (request.method === "POST" && url.pathname === "/api/integrations/feishu/oauth/start") {
      const input = await body(request);
      return send(response, 200, feishuIntegration.startOAuth(user.id, { ...input, origin: requestOrigin(request) }));
    }
    if (request.method === "POST" && url.pathname === "/api/integrations/feishu/app-credentials") {
      const input = await body(request);
      return send(response, 200, feishuIntegration.configureAppCredentials(user.id, input));
    }
  if (request.method === "GET" && url.pathname === "/api/integrations/feishu/oauth/callback") {
    const browserNavigation = String(request.headers.accept || "").includes("text/html");
    try {
      const result = await feishuIntegration.handleOAuthCallback(user.id, {
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
        errorDescription: url.searchParams.get("error_description"),
      });
      if (!browserNavigation) return send(response, 200, result);
      const target = new URL(result.returnTo || "/", requestOrigin(request));
      target.searchParams.set("feishu", "connected");
      response.writeHead(302, { Location: `${target.pathname}${target.search}${target.hash}`, "Cache-Control": "no-store" });
      response.end();
      return;
    } catch (error) {
      if (!browserNavigation) throw error;
      const target = new URL("/", requestOrigin(request));
      target.searchParams.set("feishu", "error");
      target.searchParams.set("code", String(error.code || "FEISHU_OAUTH_ERROR").slice(0, 120));
      target.searchParams.set("message", String(error.message || "飞书授权没有完成").slice(0, 300));
      response.writeHead(302, { Location: `${target.pathname}${target.search}`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
  }
  if (request.method === "GET" && url.pathname === "/api/integrations/feishu/spaces") {
    return send(response, 200, await feishuIntegration.listSpaces(user.id, { pageToken: url.searchParams.get("pageToken") || "" }));
  }
  if (request.method === "POST" && url.pathname === "/api/integrations/feishu/configure") {
    const input = await body(request);
    const connection = feishuIntegration.configure(user.id, input);
    return send(response, 200, { connection, status: connection.status });
  }
  if (request.method === "POST" && url.pathname === "/api/integrations/feishu/sync-existing") {
    return send(response, 202, feishuIntegration.enqueueExisting(user.id));
  }
  const feishuArchiveMatch = url.pathname.match(/^\/api\/integrations\/feishu\/archive\/([^/]+)$/);
  if (request.method === "POST" && feishuArchiveMatch) {
    return send(response, 202, enqueueFeishuArchive(user.id, decodeURIComponent(feishuArchiveMatch[1])));
  }
  const feishuArchiveLibraryMatch = url.pathname.match(/^\/api\/integrations\/feishu\/archive-library\/([^/]+)$/);
  if (request.method === "POST" && feishuArchiveLibraryMatch) {
    return send(response, 202, enqueueFeishuLibraryArchive(user.id, decodeURIComponent(feishuArchiveLibraryMatch[1])));
  }
  const feishuRetryMatch = url.pathname.match(/^\/api\/integrations\/feishu\/retry\/([^/]+)$/);
  if (request.method === "POST" && feishuRetryMatch) {
    return send(response, 202, feishuIntegration.retry(user.id, decodeURIComponent(feishuRetryMatch[1])));
  }
  const feishuSyncMatch = url.pathname.match(/^\/api\/integrations\/feishu\/sync\/([^/]+)$/);
  if (request.method === "POST" && feishuSyncMatch) {
    const inspirationId = decodeURIComponent(feishuSyncMatch[1]);
    return send(response, 202, enqueueFeishuArchive(user.id, inspirationId));
  }
  if (request.method === "POST" && url.pathname === "/api/integrations/feishu/pause") {
    const input = await body(request);
    const connection = feishuIntegration.pause(user.id, input.paused !== false);
    return send(response, 200, { connection, status: connection.status });
  }
  if (request.method === "DELETE" && url.pathname === "/api/integrations/feishu/connection") {
    return send(response, 200, feishuIntegration.disconnect(user.id));
  }
  if (request.method === "GET" && url.pathname === "/api/health") { const configured = await Promise.all(Object.keys(providerDefaults).map(async name => [name, Boolean((await providerConfig(name)).apiKey)])); return send(response, 200, { status: "ok", capabilities: { video: process.platform === "win32" ? "yt-dlp via WSL" : "yt-dlp", search: "Bing RSS", transcription: process.platform === "win32" ? "Gaia Whisper medium via WSL" : process.env.WORKER_TOKEN ? "Gaia worker queue" : "not_configured", providers: Object.fromEntries(configured) } }); }
  if (request.method === "GET" && url.pathname === "/api/settings/providers") { const entries = await Promise.all(Object.keys(providerDefaults).map(async name => { const state = await providerState(name); const profiles = state.profiles.map(profile => ({ ...profile, apiKey: undefined, configured: Boolean(profile.apiKey), apiKeyMasked: profile.apiKey ? `${profile.apiKey.slice(0, 3)}••••${profile.apiKey.slice(-3)}` : "", models: modelCatalog[name] })); const active = profiles.find(profile => profile.id === state.activeProfileId) || profiles[0]; return [name, { ...active, profiles, activeProfileId: state.activeProfileId, models: modelCatalog[name] }]; })); return send(response, 200, { providers: Object.fromEntries(entries) }); }
  if (request.method === "GET" && url.pathname.match(/^\/api\/settings\/providers\/[^/]+\/models$/)) { const name = url.pathname.split("/")[4]; const config = await providerConfig(name); const base = config.baseUrl.replace(/\/$/, ""); const modelsUrl = /\/(chat\/completions|messages)$/.test(base) ? base.replace(/\/(chat\/completions|messages)$/, "/models") : /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`; const headers = config.protocol === "anthropic" ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${config.apiKey}` }; const upstream = await fetch(modelsUrl, { headers }); const result = await providerJson(upstream); const ids = (result.data || result.models || []).map(item => typeof item === "string" ? item : item.id).filter(Boolean); return send(response, 200, { models: ids.map(id => ({ id, effort: (modelCatalog[name] || []).find(item => item.id === id)?.effort || [] })) }); }
  if (request.method === "POST" && url.pathname.match(/^\/api\/settings\/providers\/[^/]+\/profiles$/)) { const adminAuthorized = process.env.ADMIN_TOKEN && request.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`; const gatewayAuthorized = request.headers["x-inspiration-gateway"] === "authenticated"; if (!adminAuthorized && !gatewayAuthorized) return fail(response, 401, "UNAUTHORIZED", "管理身份验证失败"); const name = url.pathname.split("/")[4]; if (!providerDefaults[name]) return fail(response, 404, "NOT_FOUND", "平台不存在"); const input = await body(request); const current = await settings(); const state = await providerState(name); const profile = { id: `profile-${randomUUID()}`, name: String(input.name || "新配置").slice(0, 40), baseUrl: String(input.baseUrl || providerDefaults[name].baseUrl), model: String(input.model || providerDefaults[name].model), protocol: input.protocol === "anthropic" ? "anthropic" : "openai", reasoningEffort: String(input.reasoningEffort || "medium"), apiKey: String(input.apiKey || "") }; state.profiles.push(profile); state.activeProfileId = profile.id; current.providers ||= {}; current.providers[name] = { profiles: state.profiles, activeProfileId: state.activeProfileId }; await saveSettings(current); return send(response, 201, { saved: true, profile: { ...profile, apiKey: undefined } }); }
  if (request.method === "DELETE" && url.pathname.match(/^\/api\/settings\/providers\/[^/]+\/profiles\/[^/]+$/)) { const adminAuthorized = process.env.ADMIN_TOKEN && request.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`; const gatewayAuthorized = request.headers["x-inspiration-gateway"] === "authenticated"; if (!adminAuthorized && !gatewayAuthorized) return fail(response, 401, "UNAUTHORIZED", "管理身份验证失败"); const parts = url.pathname.split("/"); const name = parts[4], id = parts[6]; const state = await providerState(name); if (state.profiles.length <= 1) return fail(response, 422, "PROFILE_LAST", "至少保留一套配置"); state.profiles = state.profiles.filter(profile => profile.id !== id); if (state.profiles.length === 0) return fail(response, 404, "NOT_FOUND", "配置不存在"); if (state.activeProfileId === id) state.activeProfileId = state.profiles[0].id; const current = await settings(); current.providers ||= {}; current.providers[name] = { profiles: state.profiles, activeProfileId: state.activeProfileId }; await saveSettings(current); return send(response, 200, { deleted: true, activeProfileId: state.activeProfileId }); }
  if (request.method === "PUT" && url.pathname.match(/^\/api\/settings\/providers\/[^/]+\/active$/)) { const adminAuthorized = process.env.ADMIN_TOKEN && request.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`; const gatewayAuthorized = request.headers["x-inspiration-gateway"] === "authenticated"; if (!adminAuthorized && !gatewayAuthorized) return fail(response, 401, "UNAUTHORIZED", "管理身份验证失败"); const name = url.pathname.split("/")[4]; const input = await body(request); const state = await providerState(name); if (!state.profiles.some(profile => profile.id === input.profileId)) return fail(response, 404, "PROFILE_NOT_FOUND", "配置不存在"); state.activeProfileId = input.profileId; const current = await settings(); current.providers ||= {}; current.providers[name] = { profiles: state.profiles, activeProfileId: state.activeProfileId }; await saveSettings(current); return send(response, 200, { saved: true }); }
  if (request.method === "PUT" && url.pathname.match(/^\/api\/settings\/providers\/[^/]+$/)) { const adminAuthorized = process.env.ADMIN_TOKEN && request.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`; const gatewayAuthorized = request.headers["x-inspiration-gateway"] === "authenticated"; if (!adminAuthorized && !gatewayAuthorized) return fail(response, 401, "UNAUTHORIZED", "管理身份验证失败"); const name = url.pathname.split("/").pop(); if (!providerDefaults[name]) return fail(response, 404, "NOT_FOUND", "平台不存在"); const input = await body(request); const current = await settings(); const state = await providerState(name); const index = state.profiles.findIndex(profile => profile.id === (input.profileId || state.activeProfileId)); if (index < 0) return fail(response, 404, "PROFILE_NOT_FOUND", "配置不存在"); const previous = state.profiles[index]; const baseUrl = String(input.baseUrl || previous.baseUrl || providerDefaults[name].baseUrl); try { const parsed = new URL(baseUrl); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { return fail(response, 422, "INVALID_BASE_URL", "API URL 必须是有效的 HTTP/HTTPS 地址"); } state.profiles[index] = { ...previous, name: String(input.profileName || previous.name || "默认配置"), baseUrl, model: String(input.model || previous.model || providerDefaults[name].model), protocol: input.protocol === "anthropic" ? "anthropic" : "openai", reasoningEffort: String(input.reasoningEffort || previous.reasoningEffort || "medium"), apiKey: String(input.apiKey || previous.apiKey || "") }; state.activeProfileId = state.profiles[index].id; current.providers ||= {}; current.providers[name] = { profiles: state.profiles, activeProfileId: state.activeProfileId }; await saveSettings(current); return send(response, 200, { saved: true }); }
  const workspaceMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/workspace$/);
  if (request.method === "GET" && workspaceMatch) return send(response, 200, { workspace: workspaceStore.workspace(user.id, workspaceMatch[1]) });
  const transcriptVersionsMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/transcript-versions$/);
  if (request.method === "GET" && transcriptVersionsMatch) return send(response, 200, { items: workspaceStore.transcriptVersions(user.id, transcriptVersionsMatch[1]) });
  const transcriptVersionMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/transcript-versions\/([^/]+)$/);
  if (request.method === "DELETE" && transcriptVersionMatch) return send(response, 200, workspaceStore.deleteTranscriptVersion(user.id, transcriptVersionMatch[1], transcriptVersionMatch[2]));
  const documentMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/documents\/([^/]+)$/);
  if (request.method === "GET" && documentMatch) return send(response, 200, { document: workspaceStore.document(user.id, documentMatch[1], documentMatch[2]) });
  if (request.method === "DELETE" && documentMatch) return send(response, 200, workspaceStore.deleteReadingDocument(user.id, documentMatch[1], documentMatch[2]));
  const readingFormatMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/reading-documents\/format$/);
  if (request.method === "POST" && readingFormatMatch) { const input = await body(request); const inspiration = workspaceStore.requireInspiration(user.id, readingFormatMatch[1]); const transcript = db.prepare("SELECT raw_text FROM transcript_versions WHERE id=? AND owner_id=?").get(input.transcriptVersionId || inspiration.active_transcript_id, user.id); if (!transcript) return fail(response, 404, "TRANSCRIPT_NOT_FOUND", "转写版本不存在"); const result = await formatTranscript({ ...input, transcript: transcript.raw_text }); const document = workspaceStore.createReadingDocument(user.id, inspiration.id, { transcriptVersionId: input.transcriptVersionId, markdown: result.markdown, provider: result.provider, model: result.model, promptVersion: "format-v2" }); return send(response, 201, { document }); }
  const annotationsCollectionMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/annotations$/);
  if (request.method === "GET" && annotationsCollectionMatch) return send(response, 200, workspaceStore.listAnnotations(user.id, annotationsCollectionMatch[1], { documentId: url.searchParams.get("documentId"), kind: url.searchParams.get("kind"), status: url.searchParams.has("status") ? url.searchParams.get("status") : "active", cursor: url.searchParams.get("cursor"), sinceRevision: url.searchParams.get("sinceRevision"), limit: url.searchParams.get("limit") }));
  if (request.method === "POST" && annotationsCollectionMatch) { const input = await body(request); const annotation = workspaceStore.createAnnotation(user.id, annotationsCollectionMatch[1], input, request.headers["idempotency-key"]); return send(response, 201, { annotation }); }
  const annotationMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/annotations\/([^/]+)$/);
  if (request.method === "PATCH" && annotationMatch) { const input = await body(request); return send(response, 200, { annotation: workspaceStore.patchAnnotation(user.id, annotationMatch[1], annotationMatch[2], input) }); }
  if (request.method === "DELETE" && annotationMatch) { const input = await body(request); return send(response, 200, workspaceStore.deleteAnnotation(user.id, annotationMatch[1], annotationMatch[2], input.baseRevision ?? url.searchParams.get("baseRevision"))); }
  const reanchorMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/annotations\/([^/]+)\/reanchor$/);
  if (request.method === "POST" && reanchorMatch) { const input = await body(request); return send(response, 200, { annotation: workspaceStore.reanchorAnnotation(user.id, reanchorMatch[1], reanchorMatch[2], input) }); }
  const personalMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/personal-document$/);
  if (request.method === "GET" && personalMatch) return send(response, 200, { document: workspaceStore.personalDocument(user.id, personalMatch[1]) });
  if (request.method === "PUT" && personalMatch) { const input = await body(request); return send(response, 200, { document: workspaceStore.putPersonalDocument(user.id, personalMatch[1], input) }); }
  const revisionsMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/personal-document\/revisions$/);
  if (request.method === "GET" && revisionsMatch) return send(response, 200, { items: workspaceStore.personalRevisions(user.id, revisionsMatch[1]) });
  if (request.method === "POST" && revisionsMatch) { const input = await body(request); return send(response, 201, { snapshot: workspaceStore.snapshotPersonalDocument(user.id, revisionsMatch[1], input.reason) }); }
  const restoreMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/personal-document\/revisions\/(\d+)\/restore$/);
  if (request.method === "POST" && restoreMatch) return send(response, 201, { document: workspaceStore.restorePersonalRevision(user.id, restoreMatch[1], Number(restoreMatch[2])) });
  const actionMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/action-items$/);
  if (request.method === "POST" && actionMatch) { const input = await body(request); return send(response, 201, { item: workspaceStore.createActionItem(user.id, actionMatch[1], input) }); }
  if (request.method === "GET" && url.pathname === "/api/action-items") return send(response, 200, { items: workspaceStore.listActionItems(user.id, { status: url.searchParams.get("status") || "pending", inspirationId: url.searchParams.get("inspirationId") || null }) });
  const actionItemMatch = url.pathname.match(/^\/api\/action-items\/([^/]+)$/);
  if (request.method === "PATCH" && actionItemMatch) { const input = await body(request); return send(response, 200, { item: workspaceStore.patchActionItem(user.id, actionItemMatch[1], input) }); }
  if (request.method === "DELETE" && actionItemMatch) { const input = await body(request); return send(response, 200, workspaceStore.deleteActionItem(user.id, actionItemMatch[1], input.baseRevision ?? url.searchParams.get("baseRevision"))); }
  const selectionMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/selection-ai$/);
  if (request.method === "POST" && selectionMatch) { const input = await body(request); input.idempotencyKey = request.headers["idempotency-key"]; const inspiration = workspaceStore.requireInspiration(user.id, selectionMatch[1]); const ai = await runSelectionAi(input, inspiration); const annotation = workspaceStore.saveSelectionAi(user.id, selectionMatch[1], input, ai); return send(response, 201, { result: { ...ai, annotation } }); }
  const exportMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/export$/);
  if (request.method === "GET" && exportMatch) return send(response, 200, { export: workspaceStore.export(user.id, exportMatch[1], url.searchParams.get("mode") || "raw") });
  if (request.method === "GET" && url.pathname === "/api/analyses") { const inspirationId = url.searchParams.get("inspirationId"); const items = (await analyses()).filter(item => belongsTo(item, user.id) && (!inspirationId || item.inspirationId === inspirationId)); return send(response, 200, { items }); }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/analyses/")) {
    const id = url.pathname.split("/").pop();
    const analysis = db.prepare("SELECT inspiration_id FROM analyses WHERE id=? AND owner_id=?").get(id, user.id);
    if (!analysis) return fail(response, 404, "NOT_FOUND", "正文记录不存在");
    db.prepare("DELETE FROM analyses WHERE id=? AND owner_id=?").run(id, user.id);
    enqueueFeishuProjection(user.id, analysis.inspiration_id, { delayMs: 0, eventKind: "analysis_deleted" });
    return send(response, 200, { deleted: true });
  }
  if (request.method === "GET" && url.pathname === "/api/notes") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const noteItems = (await notes()).filter(item => belongsTo(item, user.id) && (includeArchived || !["feishu_archived", "feishu_archiving"].includes(item.status)));
    const analysisItems = (await analyses()).filter(item => belongsTo(item, user.id));
    return send(response, 200, { items: noteItems.map(item => ({ ...item, analyses: analysisItems.filter(analysis => analysis.inspirationId === item.id || (!analysis.inspirationId && normalizedUrl(analysis.sourceUrl) === normalizedUrl(item.url))) })) });
  }
  if (request.method === "GET" && url.pathname === "/api/libraries") return send(response, 200, { items: librariesFor(user.id) });
  if (request.method === "POST" && url.pathname === "/api/libraries") {
    const input = await body(request);
    const name = String(input.name || "").trim().slice(0, 40);
    if (!name) return fail(response, 422, "LIBRARY_NAME_REQUIRED", "灵感库名称不能为空");
    if (librariesFor(user.id).some(item => item.name === name)) return fail(response, 409, "LIBRARY_EXISTS", "同名灵感库已存在");
    const timestamp = new Date().toISOString();
    const id = `library-${randomUUID()}`;
    const sortOrder = Number(db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS value FROM inspiration_libraries WHERE owner_id=? AND deleted_at IS NULL").get(user.id).value);
    db.prepare(`INSERT INTO inspiration_libraries(id,owner_id,name,is_default,sort_order,created_at,updated_at)
      VALUES (?,?,?,0,?,?,?)`).run(id, user.id, name, sortOrder, timestamp, timestamp);
    feishuIntegration.syncLibraryDirectory?.(user.id, id).catch(error => console.error("Feishu library creation sync failed", error));
    return send(response, 201, { library: librariesFor(user.id).find(item => item.id === id) });
  }
  const libraryMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)$/);
  if (request.method === "PATCH" && libraryMatch) {
    const id = decodeURIComponent(libraryMatch[1]);
    const library = activeLibrary(user.id, id);
    if (!library) return fail(response, 404, "LIBRARY_NOT_FOUND", "灵感库不存在");
    const input = await body(request);
    const name = String(input.name || "").trim().slice(0, 40);
    if (!name) return fail(response, 422, "LIBRARY_NAME_REQUIRED", "灵感库名称不能为空");
    if (librariesFor(user.id).some(item => item.id !== id && item.name === name)) return fail(response, 409, "LIBRARY_EXISTS", "同名灵感库已存在");
    db.prepare("UPDATE inspiration_libraries SET name=?,updated_at=? WHERE id=? AND owner_id=?").run(name, new Date().toISOString(), id, user.id);
    const affected = db.prepare("SELECT inspiration_id FROM inspiration_library_assignments WHERE owner_id=? AND library_id=?").all(user.id, id);
    for (const item of affected) enqueueFeishuProjection(user.id, item.inspiration_id, { delayMs: 0, eventKind: "library_renamed", force: true });
    feishuIntegration.syncLibraryDirectory?.(user.id, id).catch(error => console.error("Feishu library rename sync failed", error));
    return send(response, 200, { library: librariesFor(user.id).find(item => item.id === id) });
  }
  if (request.method === "DELETE" && libraryMatch) {
    const id = decodeURIComponent(libraryMatch[1]);
    const library = activeLibrary(user.id, id);
    if (!library) return fail(response, 404, "LIBRARY_NOT_FOUND", "灵感库不存在");
    if (library.is_default) return fail(response, 422, "LIBRARY_DEFAULT", "待分类灵感库不能删除");
    const fallback = ensureDefaultLibrary(user.id);
    const timestamp = new Date().toISOString();
    const affected = db.prepare("SELECT inspiration_id FROM inspiration_library_assignments WHERE owner_id=? AND library_id=?").all(user.id, id);
    db.transaction(() => {
      db.prepare("UPDATE inspiration_library_assignments SET library_id=?,updated_at=? WHERE owner_id=? AND library_id=?").run(fallback.id, timestamp, user.id, id);
      db.prepare("UPDATE inspiration_libraries SET deleted_at=?,updated_at=? WHERE id=? AND owner_id=?").run(timestamp, timestamp, id, user.id);
    })();
    for (const item of affected) enqueueFeishuProjection(user.id, item.inspiration_id, { delayMs: 0, eventKind: "library_deleted", force: true });
    feishuIntegration.cleanupLibraryDirectories?.(user.id).catch(error => console.error("Feishu library cleanup failed", error));
    return send(response, 200, { deleted: true, movedNotes: affected.length, fallbackLibraryId: fallback.id });
  }
  const moveLibraryMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/move-library$/);
  if (request.method === "POST" && moveLibraryMatch) {
    const inspirationId = decodeURIComponent(moveLibraryMatch[1]);
    if (!db.prepare("SELECT id FROM inspirations WHERE id=? AND owner_id=?").get(inspirationId, user.id)) return fail(response, 404, "INSPIRATION_NOT_FOUND", "灵感记录不存在");
    const input = await body(request);
    const library = activeLibrary(user.id, String(input.libraryId || ""));
    if (!library) return fail(response, 404, "LIBRARY_NOT_FOUND", "目标灵感库不存在");
    assignLibrary(user.id, inspirationId, library.id);
    db.prepare("UPDATE inspirations SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=?").run(new Date().toISOString(), inspirationId, user.id);
    enqueueFeishuProjection(user.id, inspirationId, { delayMs: 0, eventKind: "library_moved", force: true });
    return send(response, 200, { moved: true, library: librariesFor(user.id).find(item => item.id === library.id) });
  }
  if (request.method === "GET" && url.pathname === "/api/tags") { const data = await tagData(user.id); return send(response, 200, { groups: data.groups, tags: data.groups.flatMap(group => (group.tags || []).map(tag => typeof tag === "string" ? tag : tag.name)) }); }
  if (request.method === "POST" && url.pathname === "/api/tags/groups") { const input = await body(request); const name = String(input.name || "").trim().slice(0, 40); if (!name) return fail(response, 422, "TAG_GROUP_REQUIRED", "分组名称不能为空"); const data = await tagData(user.id); if (data.groups.some(group => group.name === name)) return fail(response, 409, "TAG_GROUP_EXISTS", "分组已存在"); const group = { id: `group-${randomUUID()}`, name, tags: [] }; data.groups.push(group); await saveTagData(data, user.id); return send(response, 201, { group }); }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/tags/groups/")) { const id = url.pathname.split("/").pop(); const data = await tagData(user.id); const index = data.groups.findIndex(group => group.id === id); if (index < 0) return fail(response, 404, "NOT_FOUND", "分组不存在"); const group = data.groups[index]; if (group.name === "未分组") return fail(response, 422, "TAG_GROUP_PROTECTED", "未分组不能删除"); const affected = inspirationIdsUsingTagGroup(user.id, id); const fallback = data.groups.find(item => item.name === "未分组") || data.groups[0]; fallback.tags.push(...(group.tags || [])); data.groups.splice(index, 1); await saveTagData(data, user.id); enqueueTagProjectionChanges(user.id, affected, "tag_group_deleted"); return send(response, 200, { deleted: true, movedTo: fallback.id }); }
  if (request.method === "POST" && url.pathname === "/api/tags") { const input = await body(request); const name = String(input.name || "").replace(/^#/, "").trim().slice(0, 50); if (!name) return fail(response, 422, "TAG_NAME_REQUIRED", "标签名称不能为空"); const data = await tagData(user.id); const group = data.groups.find(item => item.id === input.groupId) || data.groups.find(item => item.name === input.group) || data.groups.find(item => item.name === "未分组"); if (!group) return fail(response, 422, "TAG_GROUP_REQUIRED", "请选择标签分组"); if (data.groups.some(item => (item.tags || []).some(tag => (typeof tag === "string" ? tag : tag.name) === name))) return fail(response, 409, "TAG_EXISTS", "标签已存在"); const tag = { id: `tag-${randomUUID()}`, name }; group.tags.push(tag); await saveTagData(data, user.id); return send(response, 201, { group, tag }); }
  if (request.method === "POST" && /^\/api\/tags\/[^/]+\/move$/.test(url.pathname)) { const id = url.pathname.split("/")[3]; const input = await body(request); const data = await tagData(user.id); const target = data.groups.find(group => group.id === input.groupId); if (!target) return fail(response, 422, "TAG_GROUP_REQUIRED", "请选择目标分组"); let moved = null; let source = null; for (const group of data.groups) { const index = (group.tags || []).findIndex(tag => (typeof tag === "string" ? `tag-${createHash("sha1").update(tag).digest("hex").slice(0, 12)}` : tag.id) === id); if (index >= 0) { source = group; moved = group.tags.splice(index, 1)[0]; break; } } if (!moved) return fail(response, 404, "NOT_FOUND", "标签不存在"); const name = typeof moved === "string" ? moved : moved.name; if (target.tags.some(tag => (typeof tag === "string" ? tag : tag.name) === name)) return fail(response, 409, "TAG_EXISTS", "目标分组已有同名标签"); const affected = inspirationIdsUsingTag(user.id, id); if (typeof moved === "string") moved = { id, name }; target.tags.push(moved); await saveTagData(data, user.id); enqueueTagProjectionChanges(user.id, affected, "tag_moved"); return send(response, 200, { moved: true, tag: moved, from: source?.id, group: target }); }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/tags/")) {
    const id = url.pathname.split("/").pop();
    const data = await tagData(user.id);
    for (const group of data.groups) {
      const index = (group.tags || []).findIndex(tag => (typeof tag === "string" ? "" : tag.id) === id);
      if (index < 0) continue;
      const affected = inspirationIdsUsingTag(user.id, id);
      const [tag] = group.tags.splice(index, 1);
      await saveTagData(data, user.id);
      enqueueTagProjectionChanges(user.id, affected, "tag_deleted");
      return send(response, 200, { deleted: true, tag });
    }
    return fail(response, 404, "NOT_FOUND", "标签不存在");
  }
  if (request.method === "POST" && url.pathname === "/api/tags/recommend") { const input = await body(request); return send(response, 200, await recommendTags(input, user.id)); }
  if (request.method === "POST" && url.pathname === "/api/transcripts/format") { const input = await body(request); const result = await formatTranscript(input); if (input.inspirationId) { const item = await updateInspiration(input.inspirationId, user.id, { formattedTranscript: result.markdown }); if (!item) return fail(response, 404, "INSPIRATION_NOT_FOUND", "灵感记录不存在"); result.documentId = item.activeReadingDocumentId; } return send(response, 200, result); }
  if (request.method === "POST" && url.pathname === "/api/notes") {
    const input = await body(request);
    if (!input.note?.trim()) return fail(response, 422, "NOTE_REQUIRED", "请先写下你的感想或启发");
    const items = await notes(); let item = findInspiration(items, user.id, input); const created = !item; const now = new Date().toISOString();
    if (!item) { item = { id: randomUUID(), ownerId: user.id, createdAt: now, analysisIds: [] }; items.unshift(item); }
    const sourceUrl = String(input.url || item.url || "");
    Object.assign(item, { ownerId: user.id, url: sourceUrl, platform: String(input.platform || item.platform || platform(sourceUrl)), title: String(input.title || item.title || "新灵感记录").slice(0, 200), thumbnail: String(input.thumbnail || item.thumbnail || ""), note: input.note.trim().slice(0, 10_000), status: input.status === "pending" ? "pending" : "captured", tags: Array.isArray(input.tags) ? input.tags.slice(0, 10) : (item.tags || []), libraryId: String(input.libraryId || item.libraryId || defaultLibraryId(user.id)), transcript: String(input.transcript || item.transcript || ""), formattedTranscript: String(input.formattedTranscript || item.formattedTranscript || ""), updatedAt: now });
    await saveNotes(items);
    if (input.transcript) await updateInspiration(item.id, user.id, { transcript: input.transcript, transcriptionJobId: item.transcriptionJobId });
    if (input.formattedTranscript) await updateInspiration(item.id, user.id, { formattedTranscript: input.formattedTranscript });
    item = (await notes()).find(note => note.id === item.id) || item;
    enqueueFeishuProjection(user.id, item.id, { delayMs: 5000, eventKind: created ? "inspiration_created" : "inspiration_saved" });
    return send(response, created ? 201 : 200, { item });
  }
  if (request.method === "PATCH" && /^\/api\/notes\/[^/]+$/.test(url.pathname)) { const id = url.pathname.split("/").pop(); const input = await body(request); const allowed = ["note", "status", "tags", "title", "thumbnail"]; const patch = Object.fromEntries(allowed.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])); const item = await updateInspiration(id, user.id, patch); return item ? send(response, 200, { item }) : fail(response, 404, "NOT_FOUND", "记录不存在"); }
  if (request.method === "DELETE" && /^\/api\/notes\/[^/]+$/.test(url.pathname)) { const id = url.pathname.split("/").pop(); return send(response, 200, workspaceStore.deleteInspiration(user.id, id)); }
  if (request.method === "POST" && url.pathname === "/api/video/inspect") { const input = await body(request); try { new URL(input.url); } catch { return fail(response, 422, "INVALID_URL", "请粘贴有效的视频链接"); } const video = await cacheCover(await inspectVideo(input.url)); const inspiration = await persistDraft(user.id, input, video); return send(response, 200, { video, inspiration, inspirationId: inspiration.id }); }
  if (request.method === "POST" && url.pathname === "/api/articles/inspect") {
    const input = await body(request);
    try { new URL(input.url); } catch { return fail(response, 422, "INVALID_URL", "请粘贴有效的文章链接"); }
    const article = await fetchArticle(input.url);
    const videoLike = await cacheCover({
      platform: article.platform,
      status: "ready",
      title: article.title,
      author: article.author,
      duration: 0,
      thumbnail: article.cover,
      webpageUrl: article.url,
      message: article.imageCount ? `已提取正文和 ${article.imageCount} 张图片链接` : "已提取正文",
    });
    const inspiration = await persistDraft(user.id, input, videoLike);
    const updated = await updateInspiration(inspiration.id, user.id, {
      transcript: article.markdown || article.plainText,
      formattedTranscript: article.markdown,
      transcriptionStatus: "completed",
    });
    return send(response, 200, { article: { ...article, cover: videoLike.thumbnail }, inspiration: updated, inspirationId: inspiration.id });
  }
  if (request.method === "POST" && url.pathname === "/api/documents/inspect") {
    const input = await multipartBody(request);
    const file = input.files.find(item => item.field === "file") || input.files[0];
    if (!file) return fail(response, 422, "DOCUMENT_FILE_REQUIRED", "请选择 Word 或 PDF 文件");
    const document = await extractDocumentFile(file);
    const sourceUrl = `upload://${randomUUID()}/${encodeURIComponent(document.filename || document.title)}`;
    const videoLike = {
      platform: document.platform,
      status: "ready",
      title: document.title,
      author: "",
      duration: 0,
      thumbnail: "",
      webpageUrl: sourceUrl,
      message: document.pageCount ? `已提取 ${document.pageCount} 页正文` : "已提取正文",
    };
    const inspiration = await persistDraft(user.id, { url: sourceUrl }, videoLike);
    const updated = await updateInspiration(inspiration.id, user.id, {
      transcript: document.markdown || document.plainText,
      formattedTranscript: document.markdown,
      transcriptionStatus: "completed",
    });
    return send(response, 200, { document, inspiration: updated, inspirationId: inspiration.id });
  }
  if (request.method === "POST" && url.pathname === "/api/insights/analyze") { const input = await body(request); return send(response, 201, { analysis: await analyze(input, user.id) }); }
  if (request.method === "GET" && url.pathname === "/api/search") { const query = url.searchParams.get("q")?.trim(); if (!query) return fail(response, 422, "QUERY_REQUIRED", "请输入搜索关键词"); return send(response, 200, { items: await searchWeb(query) }); }
  if (request.method === "POST" && url.pathname === "/api/video/transcribe") { const input = await body(request); if (!input.url) return fail(response, 422, "URL_REQUIRED", "缺少视频链接"); const noteItems = await notes(); let inspiration = findInspiration(noteItems, user.id, input); if (input.inspirationId && !inspiration) return fail(response, 404, "INSPIRATION_NOT_FOUND", "灵感记录不存在"); if (!inspiration) inspiration = await persistDraft(user.id, input, { webpageUrl: input.url, platform: platform(input.url), title: input.title || "正在解析的视频", thumbnail: input.thumbnail || "" }); const id = randomUUID(); const job = { id, ownerId: user.id, inspirationId: inspiration.id, url: String(input.url), status: process.platform === "win32" ? "running" : "preparing", progress: 2, stage: "正在解析视频", createdAt: new Date().toISOString() }; jobs.set(id, job); await saveJobs(); await updateInspiration(inspiration.id, user.id, { transcriptionStatus: "running", transcriptionJobId: id }); let downloadUrl = input.url; if (platform(input.url) === "wechat_channels") { const resolved = await inspectVideo(input.url); if (!resolved.mediaUrl) return fail(response, 502, "WECHAT_MEDIA_MISSING", "视频号解析结果没有媒体地址"); downloadUrl = resolved.mediaUrl; } if (process.platform === "win32") runTranscription(job, downloadUrl); else prepareMedia(job, downloadUrl); return send(response, 202, { job }); }
  if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) { const job = jobs.get(url.pathname.split("/").pop()); return job && belongsTo(job, user.id) ? send(response, 200, { job }) : fail(response, 404, "NOT_FOUND", "任务不存在"); }
  if (request.method === "GET" && url.pathname === "/api/jobs") return send(response, 200, { jobs: [...jobs.values()].filter(job => belongsTo(job, user.id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20) });
  if (request.method === "DELETE" && url.pathname.startsWith("/api/jobs/")) { const job = jobs.get(url.pathname.split("/").pop()); if (!job || !belongsTo(job, user.id)) return fail(response, 404, "NOT_FOUND", "任务不存在"); if (["completed", "failed"].includes(job.status)) return send(response, 200, { job }); job.status = "canceled"; job.completedAt = new Date().toISOString(); await saveJobs(); await updateInspiration(job.inspirationId, user.id, { transcriptionStatus: "canceled", transcriptionJobId: job.id }); if (job.mediaFile) unlink(join(mediaDirectory, job.mediaFile)).catch(() => {}); return send(response, 200, { job }); }
  if (url.pathname.startsWith("/api/worker/") && !workerAuthorized(request)) return fail(response, 401, "UNAUTHORIZED", "Worker 令牌无效");
  if (request.method === "POST" && url.pathname === "/api/worker/claim") { const job = [...jobs.values()].find(item => item.status === "queued" && item.mediaFile); if (!job) return send(response, 200, { job: null }); job.status = "transcribing"; job.progress = 30; job.stage = "正在加载 Whisper medium"; job.workerClaimedAt = new Date().toISOString(); await saveJobs(); return send(response, 200, { job: { id: job.id, mediaUrl: `/api/worker/media/${job.id}` } }); }
  if (request.method === "GET" && url.pathname.startsWith("/api/worker/media/")) { const job = jobs.get(url.pathname.split("/").pop()); if (!job?.mediaFile) return fail(response, 404, "NOT_FOUND", "媒体文件不存在"); const filePath = join(mediaDirectory, job.mediaFile); response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${job.mediaFile}"` }); createReadStream(filePath).pipe(response); return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/worker/progress/")) { const job = jobs.get(url.pathname.split("/").pop()); if (!job) return fail(response, 404, "NOT_FOUND", "任务不存在"); const input = await body(request); job.progress = Math.max(job.progress || 0, Math.min(98, Number(input.progress) || 0)); job.stage = String(input.stage || "正在识别音频"); job.updatedAt = new Date().toISOString(); await saveJobs(); return send(response, 200, { accepted: true }); }
  if (request.method === "POST" && url.pathname.startsWith("/api/worker/complete/")) { const job = jobs.get(url.pathname.split("/").pop()); if (!job) return fail(response, 404, "NOT_FOUND", "任务不存在"); const input = await body(request); const mediaFile = job.mediaFile; job.status = input.error ? "failed" : "completed"; job.progress = input.error ? job.progress : 100; job.stage = input.error ? "转写失败" : "转写完成"; job.transcript = String(input.transcript || ""); job.error = input.error ? String(input.error) : undefined; job.completedAt = new Date().toISOString(); delete job.mediaFile; await saveJobs(); await updateInspiration(job.inspirationId, job.ownerId, input.error ? { transcriptionStatus: "failed", transcriptionError: job.error, transcriptionJobId: job.id } : { transcript: job.transcript, transcriptionStatus: "completed", transcriptionJobId: job.id }); if (mediaFile) unlink(join(mediaDirectory, mediaFile)).catch(() => {}); await pruneJobs(); return send(response, 200, { accepted: true }); }
  return false;
}

const bindHost = process.env.HOST || "127.0.0.1";

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) { const handled = await route(request, response, url); if (handled === false) fail(response, 404, "NOT_FOUND", "接口不存在"); return; }
    if (url.pathname.startsWith("/covers/")) {
      const coverRoot = normalize(`${coverDirectory}${sep}`);
      const coverPath = normalize(join(coverDirectory, decodeURIComponent(url.pathname.slice("/covers/".length))));
      if (!coverPath.startsWith(coverRoot) || !existsSync(coverPath)) { response.writeHead(404); response.end("Not found"); return; }
      response.writeHead(200, { "Content-Type": types[extname(coverPath).toLowerCase()] || "application/octet-stream", "Cache-Control": "public, max-age=86400, immutable", "X-Content-Type-Options": "nosniff" });
      createReadStream(coverPath).pipe(response);
      return;
    }
    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const staticRoot = existsSync(join(root, "dist", "index.html")) ? join(root, "dist") : root;
    const filePath = normalize(join(staticRoot, relativePath));
    if (!filePath.startsWith(normalize(staticRoot)) || !existsSync(filePath)) { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream", "Cache-Control": [".html", ".js", ".css"].includes(extname(filePath)) ? "no-cache, no-store, must-revalidate" : "public, max-age=3600" }); createReadStream(filePath).pipe(response);
  } catch (error) { console.error(error); fail(response, error.status || 500, error.code || "INTERNAL_ERROR", error.message || "服务器内部错误", error.details); }
}).listen(port, bindHost, () => console.log(`Inspiration Catcher: http://${bindHost}:${port}`));
