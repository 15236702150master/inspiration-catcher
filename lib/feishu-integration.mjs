import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as cryptoRandomBytes,
  randomUUID,
} from "node:crypto";
import { marked } from "marked";
import { reanchorQuote } from "./transcript-workspace.mjs";

export const FEISHU_SCOPES = [
  "offline_access",
  "docx:document",
  "docx:document:readonly",
  "wiki:wiki",
  "wiki:wiki:readonly",
  "bitable:app",
  "bitable:app:readonly",
  "drive:drive",
];

const REQUIRED_ENVIRONMENT = ["INTEGRATION_ENCRYPTION_KEY"];
const REQUIRED_APP_FIELDS = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"];
const RETRY_DELAYS_MS = [60_000, 300_000, 1_200_000, 3_600_000];
const INDEX_FIELDS = [
  { field_name: "记录类型", type: 1 }, { field_name: "灵感ID", type: 1 }, { field_name: "标题", type: 1 }, { field_name: "灵感库", type: 1 }, { field_name: "封面", type: 17 },
  { field_name: "平台", type: 1 }, { field_name: "作者", type: 1 }, { field_name: "视频链接", type: 15 },
  { field_name: "标签", type: 4 }, { field_name: "状态", type: 1 }, { field_name: "转写状态", type: 1 },
  { field_name: "摘要", type: 1 }, { field_name: "Docx 链接", type: 15 }, { field_name: "创建时间", type: 5 },
  { field_name: "更新时间", type: 5 }, { field_name: "同步状态", type: 1 },
  { field_name: "线索ID", type: 1 }, { field_name: "开放分类", type: 1 }, { field_name: "领域", type: 1 },
  { field_name: "线索名称", type: 1 }, { field_name: "外链", type: 15 }, { field_name: "线索摘要", type: 1 },
  { field_name: "来源章节", type: 1 }, { field_name: "飞书笔记", type: 15 },
];
const LIBRARY_INDEX_FIELDS = [
  { field_name: "灵感ID", type: 1 },
  { field_name: "封面图", type: 17 },
  { field_name: "标题", type: 1 },
  { field_name: "我的标签", type: 4 },
  { field_name: "日期", type: 5 },
  { field_name: "作者名称", type: 1 },
  { field_name: "原链接", type: 15 },
  { field_name: "跳转笔记链接", type: 15 },
  { field_name: "灵感库", type: 1 },
  { field_name: "同步状态", type: 1 },
];

function integrationError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function iso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function camelRow(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bitableTableUrl(connection, libraryBinding = {}) {
  const base = String(connection?.bitable_url || "").trim();
  if (!base) return "";
  const tableId = String(libraryBinding?.library_bitable_table_id || "").trim();
  const viewId = String(libraryBinding?.library_bitable_view_id || "").trim();
  if (!tableId) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("table", tableId);
    if (viewId) url.searchParams.set("view", viewId);
    return url.toString();
  } catch {
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}table=${encodeURIComponent(tableId)}${viewId ? `&view=${encodeURIComponent(viewId)}` : ""}`;
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function compactText(value = "", length = 220) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function safeReturnTo(value) {
  const result = String(value || "/").trim();
  return result.startsWith("/") && !result.startsWith("//") ? result.slice(0, 1000) : "/";
}

function trimBase(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeNow(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return Number(value);
}

function rawTokenPayload(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return data || {};
}

function errorDetails(error) {
  return {
    status: Number(error?.status || 0) || undefined,
    code: String(error?.code || "FEISHU_SYNC_ERROR"),
    message: String(error?.message || "Feishu synchronization failed").slice(0, 1000),
    requestId: error?.details?.requestId || error?.requestId || undefined,
    upstream: error?.details?.upstream,
  };
}

export function createSecretBox(keyMaterial, randomBytesImpl = cryptoRandomBytes) {
  if (!String(keyMaterial || "")) throw integrationError(503, "FEISHU_ENCRYPTION_KEY_MISSING", "INTEGRATION_ENCRYPTION_KEY is not configured");
  const key = createHash("sha256").update(String(keyMaterial)).digest();
  return {
    encrypt(plaintext) {
      const iv = randomBytesImpl(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${base64url(iv)}.${base64url(tag)}.${base64url(encrypted)}`;
    },
    decrypt(payload) {
      const [version, ivValue, tagValue, cipherValue] = String(payload || "").split(".");
      if (version !== "v1" || !ivValue || !tagValue || cipherValue === undefined) {
        throw integrationError(500, "FEISHU_TOKEN_DECRYPT_FAILED", "Stored Feishu token is invalid");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(cipherValue, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw integrationError(500, "FEISHU_TOKEN_DECRYPT_FAILED", "Stored Feishu token cannot be decrypted");
      }
    },
  };
}

function normalizedAnnotation(row, targetReading = null) {
  const canonical = parseJson(row.canonical_anchor_json, {});
  const display = parseJson(row.display_anchor_json, {});
  let readingDisplay = display;
  if (targetReading?.id) {
    const alreadyOnReading = String(row.display_reading_document_id || "") === String(targetReading.id);
    if (!alreadyOnReading && canonical?.quote?.exact) {
      const migrated = reanchorQuote(canonical, targetReading.blocks || [], targetReading.sha256 || "");
      readingDisplay = migrated.anchor || null;
    } else if (alreadyOnReading) {
      readingDisplay = display;
    }
  }
  const kind = String(row.kind || "comment");
  const colorLabels = {
    key: "重点",
    action: "行动",
    doubt: "存疑",
    question: "存疑",
    evidence: "依据",
    insight: "洞察",
  };
  return {
    id: row.id,
    groupId: row.group_id || row.id,
    kind,
    color: String(row.color || ""),
    label: kind === "highlight" ? (colorLabels[row.color] || "重点") : ({
      underline: "线索",
      comment: "我的批注",
      ai_note: "AI 批注",
    }[kind] || "批注"),
    quote: String(readingDisplay?.quote?.exact || canonical?.quote?.exact || display?.quote?.exact || "").trim(),
    comment: String(row.comment || "").trim(),
    canonicalAnchor: canonical || null,
    displayAnchor: readingDisplay || display || null,
    displayReadingDocumentId: targetReading?.id && readingDisplay ? targetReading.id : (row.display_reading_document_id || null),
    createdAt: row.created_at,
  };
}

function normalizeAnnotations(rows, targetReading = null) {
  const seen = new Set();
  const order = { comment: 0, highlight: 1, underline: 2, ai_note: 3 };
  return rows.map(row => normalizedAnnotation(row, targetReading)).filter(item => {
    if (!item.quote && !item.comment) return false;
    const key = [item.groupId, item.kind, item.quote.replace(/\s+/g, " "), item.comment.replace(/\s+/g, " ")].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (order[left.kind] ?? 9) - (order[right.kind] ?? 9));
}

const CLUE_TYPES = [
  "工具/网站",
  "提示词/指令",
  "工作流/玩法",
  "方法/策略",
  "概念/模式",
  "案例/标杆",
  "数据/事实",
  "开源/文档",
  "模板/素材",
  "待研究问题",
  "行动机会",
  "人物/组织",
  "观点/判断",
  "待分类线索",
];

function inferClueType(line = "", url = "") {
  const text = `${line}\n${url}`.toLowerCase();
  if (/prompt|提示词|指令|咒语/.test(text)) return "提示词/指令";
  if (/github|开源|源码|repo|repository|蓝皮书|whitepaper|blueprint|文档|docs/.test(text)) return "开源/文档";
  if (/template|模板|素材|ui|组件|前端|design|案例库|case/.test(text)) return "模板/素材";
  if (/cli|computer use|agent|goal|画布|canvas|自动化|workflow|工作流|玩法|怎么用/.test(text)) return "工作流/玩法";
  if (/策略|方法|框架|步骤|流程|机制|原则/.test(text)) return "方法/策略";
  if (/概念|模式|范式|理论|模型/.test(text)) return "概念/模式";
  if (/数据|数字|比例|指标|事实|结论|报告/.test(text)) return "数据/事实";
  if (/问题|待研究|存疑|核验|为什么|如何/.test(text)) return "待研究问题";
  if (/机会|行动|下一步|可以做|尝试|实验/.test(text)) return "行动机会";
  if (/观点|判断|洞察|启发|信息差/.test(text)) return "观点/判断";
  if (/tool|工具|网站|平台|app|应用|https?:\/\//.test(text)) return "工具/网站";
  return "待分类线索";
}

function normalizeClueType(value = "", line = "", url = "") {
  const raw = compactText(value, 40).replace(/[，,;；。]+$/g, "");
  if (!raw || raw === "无") return inferClueType(line, url);
  const exact = CLUE_TYPES.find(type => type === raw);
  if (exact) return exact;
  const matched = CLUE_TYPES.find(type => raw.includes(type) || type.includes(raw));
  return matched || inferClueType(`${raw}\n${line}`, url);
}

function inferClueDomain(line = "", url = "") {
  const text = `${line}\n${url}`.toLowerCase();
  if (/feishu|飞书|bitable|多维表格|cli/.test(text)) return "飞书自动化";
  if (/codex|computer use|agent|goal|prompt|gpt|ai|llm|模型/.test(text)) return "AI 工具与工作流";
  if (/image|生图|绘图|midjourney|stable diffusion|flux/.test(text)) return "AI 生图";
  if (/frontend|前端|ui|css|react|组件|模板|design/.test(text)) return "前端与设计";
  if (/product|增长|运营|营销|商业/.test(text)) return "产品与增长";
  if (/writing|写作|文章|内容|公众号|视频/.test(text)) return "内容创作";
  return "未归类领域";
}

function cleanClueValue(value = "", length = 220) {
  return compactText(String(value || "")
    .replace(/^[-*+]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/\*\*([^*]+)\**/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim(), length);
}

function extractFirstUrl(value = "") {
  const markdown = String(value || "").match(/!?\[[^\]]{0,160}]\((https?:\/\/[^)\s]+)\)/i);
  const raw = markdown?.[1] || String(value || "").match(/https?:\/\/[^\s"'<>]+/i)?.[0] || "";
  const clean = raw.replace(/[，。；;、)\]）>]+$/g, "");
  try { return isResourceUrl(clean) ? new URL(clean).href : ""; } catch { return ""; }
}

function clueName(label = "", url = "", fallback = "") {
  const markdownLabel = String(label || fallback || "").match(/\[([^\]]{1,160})]\(https?:\/\/[^)\s]+\)/i)?.[1] || "";
  const clean = cleanClueValue(markdownLabel || label || fallback, 80)
    .replace(/^#+\s*/, "")
    .replace(/^(类型|分类|名称|线索名称)[：:]\s*/, "");
  if (clean && !/^https?:\/\//i.test(clean) && clean !== "无") return clean;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return compactText(url, 80) || "未命名线索"; }
}

function isResourceUrl(url = "") {
  try {
    const parsed = new URL(String(url || "").replace(/[，。；;、)\]）>]+$/g, ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const value = parsed.href.toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg|bmp|ico)(\?|#|$)/i.test(value)) return false;
    if (/mmbiz\.qpic\.cn|qlogo\.cn|wx_fmt=|\/covers\//i.test(value)) return false;
    return true;
  } catch { return false; }
}

function parseClueFieldLine(line = "", source = "内容拆解") {
  const original = String(line || "").trim();
  if (!original || /^#{1,6}\s/.test(original)) return null;
  const normalized = original.replace(/^[-*+]\s*/, "").replace(/^\d+[.)、]\s*/, "");
  const fields = {};
  for (const part of normalized.split(/\s*[｜|]\s*/).filter(Boolean)) {
    const match = part.match(/^\s*(?:\*\*)?([^*：:]{1,16})(?:\*\*)?\s*[：:]\s*(.+?)\s*$/);
    if (!match) continue;
    const key = cleanClueValue(match[1], 20);
    const value = cleanClueValue(match[2], 400);
    if (/^(类型|底层类型|类别)$/.test(key)) fields.type = value;
    else if (/^(开放分类|主题分类|子类|细分分类)$/.test(key)) fields.openCategory = value;
    else if (/^(领域|场景|赛道|方向)$/.test(key)) fields.domain = value;
    else if (/^(名称|线索名称|标题|项目|资源|工具|玩法|工作流|概念)$/.test(key)) fields.name = value;
    else if (/^(外链|链接|URL|网址|来源链接)$/.test(key)) fields.externalUrl = value;
    else if (/^(价值|摘要|线索摘要|为什么值得记|用途)$/.test(key)) fields.value = value;
    else if (/^(下一步|动作|建议|待办|验证动作)$/.test(key)) fields.nextStep = value;
    else if (/^(来源章节|出处|位置)$/.test(key)) fields.source = value;
    else if (/^(依据|原文依据|证据)$/.test(key)) fields.evidence = value;
  }
  const externalUrl = extractFirstUrl(fields.externalUrl || normalized);
  const hasStructuredFields = Object.keys(fields).length >= 2;
  if (!hasStructuredFields && !externalUrl) return null;
  const name = clueName(fields.name, externalUrl, normalized.replace(/\s*[｜|].*$/, ""));
  if (!name || name === "未命名线索") return null;
  const value = fields.value || fields.evidence || normalized;
  const type = normalizeClueType(fields.type || fields.openCategory, normalized, externalUrl);
  const domain = cleanClueValue(fields.domain, 40) || inferClueDomain(normalized, externalUrl);
  return {
    name,
    type,
    openCategory: cleanClueValue(fields.openCategory, 60) || type,
    domain,
    externalUrl,
    value: compactText(value, 260),
    nextStep: cleanClueValue(fields.nextStep, 160),
    source: cleanClueValue(fields.source, 80) || source,
    sourceText: compactText(fields.evidence || original, 260),
  };
}

function extractStructuredCluesFromMarkdown(markdown = "", source = "内容拆解") {
  const clues = [];
  let inClueSection = false;
  for (const rawLine of String(markdown || "").split(/\n+/)) {
    const line = rawLine.trim();
    if (/^#{1,6}\s*高价值线索索引\s*$/i.test(line)) { inClueSection = true; continue; }
    if (inClueSection && /^#{1,2}\s+/.test(line)) break;
    if (!inClueSection && !/^[-*+]\s*(?:\*\*)?(类型|开放分类|领域|名称|线索名称)[：:]/.test(line)) continue;
    const clue = parseClueFieldLine(line, source);
    if (clue) clues.push(clue);
  }
  return clues;
}

export function extractProjectionClues(projection) {
  const sources = [
    ["原文/阅读版", projection.sections?.reading],
    ["原始文本", projection.sections?.transcript],
    ["内容拆解", projection.sections?.breakdown],
    ["类似案例", projection.sections?.cases],
    ["我的思考", `${projection.sections?.thought || ""}\n${projection.sections?.personal || ""}`],
    ["阅读标注", projection.sections?.annotations],
  ];
  const clues = [];
  const seen = new Set();
  function add(clue, { fallbackUrlOnly = false } = {}) {
    const externalUrl = extractFirstUrl(clue.externalUrl || clue.url || "");
    const sourceText = clue.sourceText || clue.note || clue.value || "";
    const name = clueName(clue.name, externalUrl, sourceText);
    const type = normalizeClueType(clue.type || clue.openCategory, sourceText || name, externalUrl);
    const domain = cleanClueValue(clue.domain, 40) || inferClueDomain(`${name}\n${sourceText}`, externalUrl);
    const openCategory = cleanClueValue(clue.openCategory, 60) || type;
    const value = compactText(clue.value || clue.note || sourceText || name, 260);
    const key = externalUrl ? `url:${externalUrl}` : `text:${type}:${domain}:${name}`;
    if (!name || seen.has(key)) return;
    if (fallbackUrlOnly && [...seen].some(item => externalUrl && item === `url:${externalUrl}`)) return;
    seen.add(key);
    const idKey = `${projection.ownerId}:${projection.inspirationId}:${key}`;
    clues.push({
      clueId: sha256(idKey).slice(0, 24),
      inspirationId: projection.inspirationId,
      inspirationTitle: projection.title || "",
      libraryName: projection.library?.name || "待分类",
      name,
      type,
      openCategory,
      domain,
      externalUrl,
      url: externalUrl,
      value,
      note: value,
      nextStep: cleanClueValue(clue.nextStep, 160),
      source: cleanClueValue(clue.source, 80) || "内容拆解",
      sourceText: compactText(sourceText, 260),
    });
  }
  for (const [source, value] of sources) {
    if (source === "内容拆解" || source === "类似案例") {
      for (const clue of extractStructuredCluesFromMarkdown(value, source)) add(clue);
    }
  }
  for (const [source, value] of sources) {
    const text = String(value || "");
    for (const line of text.split(/\n+/).map(item => item.trim()).filter(Boolean)) {
      if (/^\s*[-*+]?\s*(?:\*\*)?类型(?:\*\*)?\s*[：:]/.test(line)) continue;
      for (const match of line.matchAll(/!?\[([^\]]{1,120})]\((https?:\/\/[^)\s]+)\)/gi)) {
        if (!match[0].startsWith("![")) add({ name: match[1], externalUrl: match[2], value: line, source, sourceText: line }, { fallbackUrlOnly: true });
      }
      const withoutMarkdown = line.replace(/!?\[[^\]]+]\(https?:\/\/[^)\s]+\)/gi, "");
      for (const match of withoutMarkdown.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        add({ name: "", externalUrl: match[0], value: line, source, sourceText: line }, { fallbackUrlOnly: true });
      }
    }
  }
  return clues.slice(0, 120);
}

export function extractProjectionResources(projection) {
  return extractProjectionClues(projection);
}

function annotationText(item) {
  const parts = [`${item.label}：${item.quote}`.trim()];
  if (item.comment) parts.push(item.comment);
  return parts.join("\n");
}

export function buildFeishuProjection(db, ownerId, inspirationId) {
  const inspiration = db.prepare("SELECT * FROM inspirations WHERE id=? AND owner_id=?").get(inspirationId, ownerId);
  if (!inspiration) throw integrationError(404, "INSPIRATION_NOT_FOUND", "Inspiration does not exist");
  const transcript = inspiration.active_transcript_id
    ? db.prepare("SELECT * FROM transcript_versions WHERE id=? AND inspiration_id=? AND owner_id=?").get(inspiration.active_transcript_id, inspirationId, ownerId)
    : null;
  const reading = inspiration.active_reading_document_id
    ? db.prepare("SELECT * FROM reading_documents WHERE id=? AND inspiration_id=? AND owner_id=?").get(inspiration.active_reading_document_id, inspirationId, ownerId)
    : null;
  const personal = db.prepare("SELECT plain_text,content_json,revision,updated_at FROM personal_documents WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId);
  const annotations = db.prepare("SELECT * FROM annotations WHERE inspiration_id=? AND owner_id=? AND deleted_at IS NULL AND status<>'deleted' ORDER BY created_at,id").all(inspirationId, ownerId);
  const analyses = db.prepare("SELECT * FROM analyses WHERE inspiration_id=? AND owner_id=? ORDER BY created_at,id").all(inspirationId, ownerId);
  const tags = db.prepare(`SELECT t.name,g.name AS group_name FROM inspiration_tags it
    JOIN tags t ON t.id=it.tag_id AND t.owner_id=?
    JOIN tag_groups g ON g.id=t.group_id AND g.owner_id=?
    JOIN inspirations i ON i.id=it.inspiration_id AND i.owner_id=?
    WHERE it.inspiration_id=? ORDER BY g.sort_order,t.name`).all(ownerId, ownerId, ownerId, inspirationId);
  const actions = db.prepare("SELECT title,note,status,due_at FROM action_items WHERE inspiration_id=? AND owner_id=? ORDER BY created_at,id").all(inspirationId, ownerId);
  const library = db.prepare(`SELECT l.id,l.name FROM inspiration_library_assignments a
    JOIN inspiration_libraries l ON l.id=a.library_id AND l.owner_id=a.owner_id
    WHERE a.inspiration_id=? AND a.owner_id=? AND l.deleted_at IS NULL`).get(inspirationId, ownerId)
    || { id: `library-default-${ownerId}`, name: "待分类" };
  const videoAnalysis = analyses.filter(item => item.type !== "cases").map(item => item.content).filter(Boolean).join("\n\n---\n\n");
  const caseAnalysis = analyses.filter(item => item.type === "cases").map(item => item.content).filter(Boolean).join("\n\n---\n\n");
  const metadata = [
    `平台：${inspiration.platform || "未识别"}`,
    `作者：${inspiration.author || "未知"}`,
    `原视频：${inspiration.url || "无"}`,
    inspiration.thumbnail ? `封面：${inspiration.thumbnail}` : "",
    tags.length ? `标签：${tags.map(item => `#${item.name}`).join(" ")}` : "标签：无",
  ].filter(Boolean).join("\n");
  const readingBlocks = parseJson(reading?.blocks_json, []);
  const targetReading = reading ? { id: reading.id, blocks: readingBlocks, sha256: reading.sha256 } : null;
  const normalizedAnnotationsValue = normalizeAnnotations(annotations, targetReading);
  const actionText = actions.length
    ? actions.map(item => `- [${item.status === "completed" ? "x" : " "}] ${item.title}${item.note ? `：${item.note}` : ""}${item.due_at ? `（${item.due_at}）` : ""}`).join("\n")
    : "";
  const projection = {
    inspirationId,
    ownerId,
    title: inspiration.title || "未命名灵感",
    url: inspiration.url || "",
    thumbnail: inspiration.thumbnail || "",
    platform: inspiration.platform || "",
    author: inspiration.author || "",
    status: inspiration.status || "draft",
    transcriptionStatus: inspiration.transcription_status || "",
    tags: tags.map(item => ({ name: item.name, group: item.group_name })),
    library: { id: library.id, name: library.name },
    createdAt: inspiration.created_at,
    updatedAt: inspiration.updated_at,
    summary: String(inspiration.quick_thought || reading?.plain_text || transcript?.normalized_text || "").replace(/\s+/g, " ").trim().slice(0, 300),
    annotations: normalizedAnnotationsValue,
    reading: reading ? {
      documentId: reading.id,
      transcriptVersionId: reading.transcript_version_id,
      versionNo: reading.version_no || 0,
      blocks: readingBlocks,
    } : null,
    actions: actions.map(item => ({
      title: String(item.title || "").trim(),
      note: String(item.note || "").trim(),
      completed: item.status === "completed",
      dueAt: item.due_at || "",
    })).filter(item => item.title),
    sections: {
      source: metadata,
      thought: inspiration.quick_thought || "",
      personal: personal?.plain_text || "",
      annotations: normalizedAnnotationsValue.map(annotationText).join("\n\n"),
      reading: reading?.markdown || "",
      breakdown: videoAnalysis,
      cases: caseAnalysis,
      actions: actionText,
      transcript: transcript?.raw_text || "",
    },
    revisions: {
      inspiration: inspiration.revision,
      transcript: transcript?.version_no || 0,
      reading: reading?.version_no || 0,
      personal: personal?.revision || 0,
      annotations: annotations.map(item => [item.id, item.revision, item.updated_at]),
      analyses: analyses.map(item => [item.id, item.created_at]),
    },
  };
  projection.clues = extractProjectionClues(projection);
  projection.sourceHash = sha256(stableJson(projection));
  return projection;
}

function textRun(content, style = {}) {
  return { text_run: { content: String(content || ""), text_element_style: style } };
}

const BLOCK_TYPES = {
  text: 2,
  heading1: 3,
  heading2: 4,
  heading3: 5,
  heading4: 6,
  bullet: 12,
  ordered: 13,
  quote: 15,
  todo: 17,
  divider: 22,
  image: 27,
};
const BLOCK_CHAR_LIMIT = 1600;

function validLink(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? encodeURIComponent(url.href) : "";
  } catch { return ""; }
}

function docBlock(type, content, options = {}) {
  if (type === "divider") return { block_type: BLOCK_TYPES.divider, divider: {} };
  if (type === "image") return { block_type: BLOCK_TYPES.image, image: {}, ...(options.source ? { __imageSource: options.source, __imageAlt: options.alt || "" } : {}) };
  const elements = Array.isArray(content) ? content : [textRun(content)];
  return {
    block_type: BLOCK_TYPES[type] || BLOCK_TYPES.text,
    [type]: {
      elements,
      style: type === "todo" ? {
        done: Boolean(options.done),
        folded: false,
        align: 1,
        wrap: true,
        indentation_level: "NoIndent",
      } : {},
    },
  };
}

function feishuBlockPayload(block) {
  if (!block || typeof block !== "object") return block;
  return Object.fromEntries(Object.entries(block).filter(([key]) => !key.startsWith("__")));
}

function splitLongText(value, max = 1800) {
  const text = String(value || "").trim();
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let at = Math.max(1, remaining.lastIndexOf("\n", max));
    if (at < max * 0.5) at = Math.max(1, remaining.lastIndexOf("。", max) + 1);
    if (at < max * 0.5) at = max;
    chunks.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function imageDimensions(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data.length >= 10 && String.fromCharCode(...data.slice(0, 3)) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = view.getUint16(offset + 2);
      if (startOfFrame.has(marker)) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return { width: 0, height: 0 };
}

function inlineElements(tokens, inherited = {}) {
  const elements = [];
  for (const token of tokens || []) {
    if (token.type === "checkbox") continue;
    if (token.type === "br") { elements.push(textRun("\n", inherited)); continue; }
    if (token.type === "strong") { elements.push(...inlineElements(token.tokens, { ...inherited, bold: true })); continue; }
    if (token.type === "em") { elements.push(...inlineElements(token.tokens, { ...inherited, italic: true })); continue; }
    if (token.type === "del") { elements.push(...inlineElements(token.tokens, { ...inherited, strikethrough: true })); continue; }
    if (token.type === "codespan") { elements.push(textRun(token.text, { ...inherited, inline_code: true })); continue; }
    if (token.type === "link") {
      const link = validLink(token.href);
      elements.push(...inlineElements(token.tokens, link ? { ...inherited, link: { url: link } } : inherited));
      continue;
    }
    if (token.type === "image") {
      const link = validLink(token.href);
      const label = token.text || token.title || "查看图片";
      elements.push(textRun(label, link ? { ...inherited, link: { url: link } } : inherited));
      continue;
    }
    if (token.tokens?.length) { elements.push(...inlineElements(token.tokens, inherited)); continue; }
    const content = token.text ?? token.raw ?? "";
    if (content) elements.push(textRun(String(content).replace(/<[^>]+>/g, ""), inherited));
  }
  return elements.filter(element => element.text_run.content);
}

function imageMarkdownToken(token) {
  const source = String(token?.href || token?.url || "").trim();
  if (!source) return null;
  try {
    const parsed = new URL(source);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch { return null; }
  return docBlock("image", "", { source, alt: token.text || token.title || "文章图片" });
}

function splitElements(elements, max = BLOCK_CHAR_LIMIT) {
  const groups = [];
  let current = [];
  let size = 0;
  function flush() {
    if (current.length) groups.push(current);
    current = [];
    size = 0;
  }
  for (const element of elements) {
    const style = element.text_run.text_element_style || {};
    let remaining = Array.from(element.text_run.content || "");
    while (remaining.length) {
      if (size >= max) flush();
      const take = Math.min(max - size, remaining.length);
      current.push(textRun(remaining.slice(0, take).join(""), style));
      size += take;
      remaining = remaining.slice(take);
    }
  }
  flush();
  return groups;
}

function richBlocks(type, elements, options = {}) {
  return splitElements(elements).map(group => docBlock(type, group, options));
}

function listBlocks(token, depth = 0) {
  const blocks = [];
  for (const item of token.items || []) {
    const inlineTokens = [];
    const nestedLists = [];
    for (const child of item.tokens || []) {
      if (child.type === "list") nestedLists.push(child);
      else if (child.type !== "checkbox") inlineTokens.push(child);
    }
    const elements = inlineElements(inlineTokens);
    if (depth && elements.length) elements.unshift(textRun("　".repeat(Math.min(depth, 4))));
    const type = item.task ? "todo" : token.ordered ? "ordered" : "bullet";
    blocks.push(...richBlocks(type, elements.length ? elements : [textRun(item.text || "")], { done: item.checked }));
    for (const nested of nestedLists) blocks.push(...listBlocks(nested, depth + 1));
  }
  return blocks;
}

function markdownTokenBlocks(tokens) {
  const blocks = [];
  for (const token of tokens || []) {
    if (["space", "def"].includes(token.type)) continue;
    if (token.type === "heading") {
      blocks.push(...richBlocks("text", inlineElements(token.tokens, { bold: true })));
      continue;
    }
    if (token.type === "paragraph" || token.type === "text") {
      const imageTokens = (token.tokens || []).filter(item => item.type === "image");
      if (imageTokens.length) {
        const textElements = inlineElements((token.tokens || []).filter(item => item.type !== "image"));
        if (textElements.length) blocks.push(...richBlocks("text", textElements));
        for (const imageToken of imageTokens) {
          const block = imageMarkdownToken(imageToken);
          if (block) blocks.push(block);
        }
        continue;
      }
      blocks.push(...richBlocks("text", inlineElements(token.tokens?.length ? token.tokens : [token])));
      continue;
    }
    if (token.type === "image") {
      const block = imageMarkdownToken(token);
      if (block) blocks.push(block);
      continue;
    }
    if (token.type === "list") { blocks.push(...listBlocks(token)); continue; }
    if (token.type === "blockquote") {
      for (const child of token.tokens || []) {
        const elements = inlineElements(child.tokens?.length ? child.tokens : [child]);
        if (elements.length) blocks.push(...richBlocks("quote", elements));
      }
      continue;
    }
    if (token.type === "hr") { blocks.push(docBlock("divider")); continue; }
    if (token.type === "code") {
      blocks.push(...richBlocks("text", [textRun(token.text || "", { inline_code: true })]));
      continue;
    }
    if (token.type === "table") {
      const rows = [token.header, ...(token.rows || [])];
      for (const row of rows) {
        const elements = [];
        row.forEach((cell, index) => {
          if (index) elements.push(textRun(" ｜ "));
          elements.push(...inlineElements(cell.tokens || []));
        });
        blocks.push(...richBlocks("text", elements));
      }
      continue;
    }
    const elements = inlineElements(token.tokens?.length ? token.tokens : [token]);
    if (elements.length) blocks.push(...richBlocks("text", elements));
  }
  return blocks;
}

export function markdownBlocks(value) {
  const markdown = String(value || "").trim();
  return markdown ? markdownTokenBlocks(marked.lexer(markdown, { gfm: true, breaks: false })) : [];
}

function sectionBlocks(title, value) {
  const content = markdownBlocks(value);
  return content.length ? [docBlock("heading1", title), ...content] : [];
}

function readableTranscriptBlocks(value) {
  const source = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!source) return [];
  const paragraphs = [];
  for (const original of source.split(/\n{2,}/).map(item => item.trim()).filter(Boolean)) {
    if (Array.from(original).length <= 520) { paragraphs.push(original); continue; }
    let buffer = "";
    for (const sentence of original.split(/(?<=[。！？!?])/u).filter(Boolean)) {
      if (buffer && Array.from(buffer + sentence).length > 520) {
        paragraphs.push(buffer.trim());
        buffer = "";
      }
      buffer += sentence;
    }
    if (buffer.trim()) paragraphs.push(buffer.trim());
  }
  return paragraphs.flatMap(paragraph => splitLongText(paragraph, BLOCK_CHAR_LIMIT).map(chunk => docBlock("text", chunk)));
}

function annotationBlocks(items) {
  if (!items?.length) return [];
  const blocks = [docBlock("heading1", "阅读标注")];
  let previousKind = "";
  for (const item of items) {
    if (item.kind !== previousKind) {
      blocks.push(docBlock("text", [textRun(item.label, { bold: true })]));
      previousKind = item.kind;
    }
    const quoteStyle = item.kind === "highlight" ? { background_color: 2 } : item.kind === "underline" ? { underline: true } : {};
    if (item.quote) blocks.push(...richBlocks("quote", [textRun(item.quote, quoteStyle)]));
    if (item.comment) blocks.push(...markdownBlocks(item.comment));
  }
  return blocks;
}

function annotationAnchorPosition(item) {
  const anchor = item?.displayAnchor || item?.canonicalAnchor || null;
  const position = anchor?.position || anchor;
  const blockId = anchor?.blockId || position?.blockId || "";
  const start = Number(position?.start);
  const end = Number(position?.end);
  if (!blockId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { blockId: String(blockId), start, end };
}

function annotationInlineStyle(item) {
  if (item.kind === "highlight") {
    const backgroundByColor = { key: 2, action: 3, doubt: 4, question: 4, evidence: 5, insight: 6 };
    return { background_color: backgroundByColor[item.color] || 2 };
  }
  if (item.kind === "underline") return { underline: true };
  if (item.kind === "comment" || item.kind === "ai_note") return { background_color: 2, underline: item.kind === "ai_note" };
  return {};
}

function mergeTextStyles(items = []) {
  return items.reduce((style, item) => ({ ...style, ...annotationInlineStyle(item) }), {});
}

function annotatedTextElements(text = "", intervals = []) {
  const source = String(text || "");
  if (!source) return [];
  const boundaries = new Set([0, source.length]);
  for (const item of intervals) {
    boundaries.add(Math.max(0, Math.min(source.length, item.start)));
    boundaries.add(Math.max(0, Math.min(source.length, item.end)));
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const elements = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const covering = intervals.filter(item => item.start < end && item.end > start).map(item => item.annotation);
    elements.push(textRun(source.slice(start, end), mergeTextStyles(covering)));
  }
  return elements;
}

function commentBlocksForAnnotations(items = []) {
  const seen = new Set();
  const blocks = [];
  for (const item of items) {
    const comment = String(item.comment || "").trim();
    if (!comment) continue;
    const key = `${item.groupId || item.id}|${item.kind}|${comment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(docBlock("quote", [textRun(`${item.label}｜`, { bold: true }), textRun(comment)]));
  }
  return blocks;
}

function annotatedReadingBlocks(projection) {
  const reading = projection.reading || {};
  const blocks = Array.isArray(reading.blocks) ? reading.blocks : [];
  if (!blocks.length) return sectionBlocks("AI 阅读版", projection.sections.reading);
  const result = [docBlock("heading1", "AI 阅读版")];
  const annotations = Array.isArray(projection.annotations) ? projection.annotations : [];
  for (const block of blocks) {
    if (block.type === "image" && block.url) {
      result.push(docBlock("image", "", { source: block.url, alt: block.alt || block.text || "文章图片" }));
      continue;
    }
    if (block.type === "thematicBreak") {
      result.push(docBlock("divider"));
      continue;
    }
    const text = String(block.text || "").trim();
    if (!text) continue;
    const intervals = annotations.map(annotation => {
      const position = annotationAnchorPosition(annotation);
      if (!position || position.blockId !== String(block.id)) return null;
      return {
        annotation,
        start: Math.max(0, Math.min(text.length, position.start)),
        end: Math.max(0, Math.min(text.length, position.end)),
      };
    }).filter(item => item && item.end > item.start);
    const type = block.type === "heading" ? "heading2" : "text";
    if (intervals.length) {
      result.push(...richBlocks(type, annotatedTextElements(text, intervals)));
      result.push(...commentBlocksForAnnotations(intervals.map(item => item.annotation)));
    } else {
      result.push(...richBlocks(type, [textRun(text)]));
    }
  }
  return result;
}

function overviewBlocks(projection, includeCover = false) {
  const blocks = [];
  if (includeCover) blocks.push(docBlock("image"));
  const metadata = [projection.platform, projection.author, projection.createdAt ? new Date(projection.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""].filter(Boolean).join(" · ");
  if (metadata) blocks.push(docBlock("text", metadata));
  const sourceLink = validLink(projection.url);
  if (sourceLink) blocks.push(docBlock("text", [textRun("打开原视频", { bold: true, link: { url: sourceLink } })]));
  if (projection.tags?.length) {
    const shown = projection.tags.slice(0, 6).map(item => `${item.group ? `${item.group} / ` : ""}#${item.name}`).join("　");
    blocks.push(docBlock("text", `${shown}${projection.tags.length > 6 ? `　另有 ${projection.tags.length - 6} 个标签` : ""}`));
  }
  if (projection.summary) blocks.push(docBlock("quote", [textRun("核心启发　", { bold: true }), textRun(projection.summary)]));
  const nextAction = projection.actions?.find(item => !item.completed);
  if (nextAction) blocks.push(docBlock("todo", [textRun(nextAction.title), ...(nextAction.note ? [textRun(`：${nextAction.note}`)] : [])], { done: false }));
  if (blocks.length) blocks.push(docBlock("divider"));
  return blocks;
}


function clueBlocks(clues = []) {
  const items = Array.isArray(clues) ? clues.filter(item => item?.name).slice(0, 40) : [];
  if (!items.length) return [];
  const blocks = [docBlock("heading1", "自动整理线索")];
  for (const clue of items) {
    const prefix = `【${clue.type || "线索"}｜${clue.domain || "未归类"}】`;
    const parts = [textRun(prefix), textRun(clue.name, { bold: true })];
    if (clue.externalUrl) parts.push(textRun(" · 外链", { link: { url: validLink(clue.externalUrl) } }));
    const value = clue.value || clue.note || clue.sourceText || "";
    if (value) parts.push(textRun(`：${value}`));
    if (clue.nextStep) parts.push(textRun(`；下一步：${clue.nextStep}`));
    blocks.push(docBlock("bullet", parts));
  }
  return blocks;
}

export function projectionBlocks(projection, { includeCover = false } = {}) {
  const thinking = [];
  if (String(projection.sections.thought || "").trim() || String(projection.sections.personal || "").trim()) {
    thinking.push(docBlock("heading1", "我的思考"));
    if (String(projection.sections.thought || "").trim()) thinking.push(docBlock("heading2", "我的感想"), ...markdownBlocks(projection.sections.thought));
    if (String(projection.sections.personal || "").trim()) thinking.push(docBlock("heading2", "我的加工稿"), ...markdownBlocks(projection.sections.personal));
  }
  const actions = projection.actions?.length
    ? [docBlock("heading1", "待实践"), ...projection.actions.map(item => docBlock("todo", [
      textRun(item.title),
      ...(item.note ? [textRun(`：${item.note}`)] : []),
      ...(item.dueAt ? [textRun(`（${item.dueAt}）`)] : []),
    ], { done: item.completed }))]
    : [];
  const reading = [
    ...(projection.reading?.blocks?.length ? [] : annotationBlocks(projection.annotations || [])),
    ...annotatedReadingBlocks(projection),
  ];
  const transcript = readableTranscriptBlocks(projection.sections.transcript);
  return [
    ...overviewBlocks(projection, includeCover),
    ...reading,
    ...thinking,
    ...actions,
    ...clueBlocks(projection.clues),
    ...sectionBlocks("内容拆解", projection.sections.breakdown),
    ...sectionBlocks("类似案例", projection.sections.cases),
    ...(transcript.length ? [docBlock("heading1", "原始转写"), ...transcript] : []),
  ];
}

function connectionView(row) {
  if (!row) return null;
  const value = camelRow(row);
  return {
    id: value.id,
    status: value.status,
    tenantKey: value.tenantKey,
    feishuUserId: value.feishuUserId,
    userName: value.feishuUserName,
    spaceId: value.spaceId,
    spaceName: value.spaceName,
    parentNodeToken: value.parentNodeToken,
    bitableAppToken: value.bitableAppToken,
    bitableTableId: value.bitableTableId,
    bitableUrl: value.bitableUrl,
    syncPolicy: value.syncPolicy,
    lastErrorCode: value.lastErrorCode,
    lastErrorMessage: value.lastErrorMessage,
    connectedAt: value.connectedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export class FeishuIntegration {
  constructor(dbOrOptions, maybeOptions = {}) {
    const options = dbOrOptions?.db ? dbOrOptions : { ...maybeOptions, db: dbOrOptions };
    if (!options.db) throw new TypeError("db is required");
    this.db = options.db;
    this.appId = options.appId ?? process.env.FEISHU_APP_ID ?? "";
    this.appSecret = options.appSecret ?? process.env.FEISHU_APP_SECRET ?? "";
    this.encryptionKey = options.encryptionKey ?? process.env.INTEGRATION_ENCRYPTION_KEY ?? "";
    this.publicBaseUrl = trimBase(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? "");
    this.redirectUri = options.redirectUri ?? process.env.FEISHU_REDIRECT_URI ?? "";
    this.pkceEnabled = options.pkceEnabled ?? process.env.FEISHU_PKCE_ENABLED === "true";
    this.allowServerAppFallback = options.allowServerAppFallback ?? process.env.FEISHU_SERVER_APP_FALLBACK === "true";
    this.apiBaseUrl = trimBase(options.apiBaseUrl ?? process.env.FEISHU_API_BASE ?? "https://open.feishu.cn/open-apis");
    this.accountsBaseUrl = trimBase(options.accountsBaseUrl ?? process.env.FEISHU_ACCOUNTS_BASE ?? "https://accounts.feishu.cn");
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.assetFetchImpl = options.assetFetchImpl || globalThis.fetch;
    this.onPruneArchivedLocal = options.onPruneArchivedLocal || null;
    this.now = options.now || (() => Date.now());
    this.randomBytes = options.randomBytes || cryptoRandomBytes;
    this.workerId = options.workerId || `feishu-${randomUUID()}`;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 20_000);
    this.refreshLocks = new Map();
    this.connectionLocks = new Map();
    this.validatedIndexTables = new Set();
    this.validatedLibraryTables = new Set();
    this.timer = null;
    this.processing = false;
  }

  get missingEnvironment() {
    return [
      !this.encryptionKey && "INTEGRATION_ENCRYPTION_KEY",
    ].filter(Boolean);
  }

  get configured() { return this.missingEnvironment.length === 0; }

  nowMs() { return normalizeNow(this.now); }

  callbackUrl(origin = "") {
    if (this.redirectUri) return this.redirectUri;
    const base = this.publicBaseUrl || trimBase(origin) || "http://127.0.0.1:4173";
    return `${base}/api/integrations/feishu/oauth/callback`;
  }

  assertConfigured() {
    if (!this.configured) throw integrationError(503, "FEISHU_NOT_CONFIGURED", "Feishu integration is not configured", { missingEnvironment: this.missingEnvironment });
  }

  secretBox() { this.assertConfigured(); return createSecretBox(this.encryptionKey, this.randomBytes); }

  connectionRow(ownerId) {
    return this.db.prepare("SELECT * FROM feishu_connections WHERE owner_id=?").get(ownerId);
  }

  appCredentialRow(ownerId) {
    return this.db.prepare("SELECT * FROM feishu_app_credentials WHERE owner_id=?").get(ownerId);
  }

  appCredentials(ownerId) {
    this.assertConfigured();
    const row = this.appCredentialRow(ownerId);
    if (row?.app_id && row?.app_secret_ciphertext) {
      return {
        appId: row.app_id,
        appSecret: this.secretBox().decrypt(row.app_secret_ciphertext),
        source: "user",
        configured: true,
      };
    }
    if (this.appId && this.appSecret && (this.allowServerAppFallback || this.connectionRow(ownerId))) {
      return { appId: this.appId, appSecret: this.appSecret, source: "server_legacy", configured: true };
    }
    return { appId: "", appSecret: "", source: "", configured: false };
  }

  requireAppCredentials(ownerId) {
    const credentials = this.appCredentials(ownerId);
    if (!credentials.configured) {
      throw integrationError(409, "FEISHU_APP_CREDENTIALS_REQUIRED", "请先填写飞书应用 App ID 和 App Secret", { requiredAppFields: REQUIRED_APP_FIELDS });
    }
    return credentials;
  }

  configureAppCredentials(ownerId, input = {}) {
    this.assertConfigured();
    const appId = String(input.appId || input.feishuAppId || "").trim();
    const appSecret = String(input.appSecret || input.feishuAppSecret || "").trim();
    if (!appId) throw integrationError(422, "FEISHU_APP_ID_REQUIRED", "请填写飞书应用 App ID");
    if (!appSecret) throw integrationError(422, "FEISHU_APP_SECRET_REQUIRED", "请填写飞书应用 App Secret");
    const timestamp = iso(this.nowMs());
    const existing = this.appCredentialRow(ownerId);
    const changed = existing ? existing.app_id !== appId : Boolean(this.connectionRow(ownerId));
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO feishu_app_credentials
        (id,owner_id,app_id,app_secret_ciphertext,created_at,updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(owner_id) DO UPDATE SET app_id=excluded.app_id,
          app_secret_ciphertext=excluded.app_secret_ciphertext,updated_at=excluded.updated_at`).run(
        existing?.id || randomUUID(), ownerId, appId, this.secretBox().encrypt(appSecret),
        existing?.created_at || timestamp, timestamp,
      );
      this.db.prepare("DELETE FROM integration_oauth_states WHERE owner_id=? AND provider='feishu'").run(ownerId);
      if (changed) {
        this.db.prepare(`UPDATE feishu_document_bindings SET sync_status='failed',last_error_code='FEISHU_APP_CHANGED',
          last_error_message='Feishu app credentials changed; reconnect Feishu',updated_at=? WHERE owner_id=?`).run(timestamp, ownerId);
        this.db.prepare("DELETE FROM feishu_connections WHERE owner_id=?").run(ownerId);
      }
    })();
    return { saved: true, appId, source: "user", reconnectRequired: Boolean(changed) };
  }

  requireConnection(ownerId, { allowPaused = false } = {}) {
    const row = this.connectionRow(ownerId);
    if (!row) throw integrationError(409, "FEISHU_NOT_CONNECTED", "Feishu account is not connected");
    if (!allowPaused && row.status === "paused") throw integrationError(409, "FEISHU_SYNC_PAUSED", "Feishu synchronization is paused");
    if (!allowPaused && row.status === "reauthorize") throw integrationError(401, "FEISHU_REAUTHORIZE_REQUIRED", "Feishu authorization must be renewed");
    if (!allowPaused && row.status === "permission_error") throw integrationError(403, "FEISHU_PERMISSION_REQUIRED", "Feishu permissions must be repaired");
    return row;
  }

  getStatus(ownerId, { origin = "" } = {}) {
    const connection = this.connectionRow(ownerId);
    const app = this.configured ? this.appCredentials(ownerId) : { configured: false, appId: "", source: "" };
    const counts = this.db.prepare(`SELECT status,COUNT(*) AS count FROM sync_outbox
      WHERE owner_id=? AND integration='feishu' GROUP BY status`).all(ownerId);
    const syncCounts = Object.fromEntries(counts.map(item => [item.status, item.count]));
    const latest = this.db.prepare("SELECT last_synced_at FROM feishu_document_bindings WHERE owner_id=? AND last_synced_at IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1").get(ownerId);
    const bindings = this.db.prepare(`SELECT inspiration_id,sync_status,document_url,last_error_code,last_error_message,last_synced_at,updated_at
      FROM feishu_document_bindings WHERE owner_id=? ORDER BY updated_at DESC`).all(ownerId).map(camelRow);
    const bindingCounts = bindings.reduce((result, item) => {
      result[item.syncStatus] = (result[item.syncStatus] || 0) + 1;
      return result;
    }, {});
    const status = !this.configured ? "not_configured" : !app.configured ? "app_missing" : !connection ? "not_connected" : connection.status;
    return {
      provider: "feishu",
      configured: this.configured,
      appConfigured: Boolean(app.configured),
      appCredentialSource: app.source || "",
      appId: app.appId ? `${app.appId.slice(0, 8)}${app.appId.length > 8 ? "…" : ""}` : "",
      status,
      callbackUrl: this.callbackUrl(origin),
      requiredEnvironment: REQUIRED_ENVIRONMENT,
      requiredEnv: REQUIRED_ENVIRONMENT,
      requiredAppFields: REQUIRED_APP_FIELDS,
      requiredScopes: FEISHU_SCOPES,
      missingEnvironment: this.missingEnvironment,
      connection: connectionView(connection),
      sync: {
        pending: syncCounts.pending || 0,
        processing: syncCounts.processing || 0,
        failed: bindingCounts.failed || 0,
        succeeded: bindingCounts.synced || 0,
        lastSyncedAt: latest?.last_synced_at || null,
      },
      bindings,
    };
  }

  startOAuth(ownerId, { returnTo = "/", origin = "", redirectUri = "" } = {}) {
    const app = this.requireAppCredentials(ownerId);
    const state = base64url(this.randomBytes(32));
    const verifier = this.pkceEnabled ? base64url(this.randomBytes(48)) : "";
    const challenge = verifier ? base64url(createHash("sha256").update(verifier).digest()) : "";
    const callback = redirectUri || this.callbackUrl(origin);
    const timestamp = this.nowMs();
    const expiresAt = iso(timestamp + 10 * 60_000);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM integration_oauth_states WHERE expires_at<? OR (consumed_at IS NOT NULL AND consumed_at<?)").run(iso(timestamp - 24 * 60 * 60_000), iso(timestamp - 24 * 60 * 60_000));
      this.db.prepare(`INSERT INTO integration_oauth_states
        (id,owner_id,provider,state_hash,code_verifier_ciphertext,redirect_uri,return_to,expires_at,consumed_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,NULL,?)`).run(randomUUID(), ownerId, "feishu", sha256(state), this.secretBox().encrypt(verifier), callback, safeReturnTo(returnTo), expiresAt, iso(timestamp));
    })();
    const authorization = new URL(`${this.accountsBaseUrl}/open-apis/authen/v1/authorize`);
    authorization.searchParams.set("client_id", app.appId);
    authorization.searchParams.set("redirect_uri", callback);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("state", state);
    if (challenge) {
      authorization.searchParams.set("code_challenge", challenge);
      authorization.searchParams.set("code_challenge_method", "S256");
    }
    authorization.searchParams.set("scope", FEISHU_SCOPES.join(" "));
    return { authorizationUrl: authorization.toString(), stateExpiresAt: expiresAt, callbackUrl: callback };
  }

  consumeOAuthState(ownerId, state) {
    const stateHash = sha256(String(state || ""));
    const anyOwner = this.db.prepare("SELECT * FROM integration_oauth_states WHERE provider='feishu' AND state_hash=?").get(stateHash);
    if (!anyOwner) throw integrationError(400, "OAUTH_STATE_INVALID", "OAuth state is invalid");
    if (anyOwner.owner_id !== ownerId) throw integrationError(403, "OAUTH_STATE_OWNER_MISMATCH", "OAuth state belongs to another user");
    if (anyOwner.consumed_at) throw integrationError(409, "OAUTH_STATE_ALREADY_USED", "OAuth state has already been used");
    if (new Date(anyOwner.expires_at).getTime() <= this.nowMs()) throw integrationError(400, "OAUTH_STATE_EXPIRED", "OAuth state has expired");
    const consumedAt = iso(this.nowMs());
    const changed = this.db.prepare("UPDATE integration_oauth_states SET consumed_at=? WHERE id=? AND owner_id=? AND consumed_at IS NULL").run(consumedAt, anyOwner.id, ownerId);
    if (!changed.changes) throw integrationError(409, "OAUTH_STATE_ALREADY_USED", "OAuth state has already been used");
    return { ...anyOwner, consumed_at: consumedAt, verifier: this.secretBox().decrypt(anyOwner.code_verifier_ciphertext) };
  }

  async tokenRequest(body, credentials = null) {
    let response;
    const app = credentials || { appId: this.appId, appSecret: this.appSecret };
    try {
      response = await this.fetchImpl(`${this.accountsBaseUrl}/oauth/v3/token`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          client_id: app.appId,
          client_secret: app.appSecret,
          ...body,
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw integrationError(504, "FEISHU_TOKEN_TIMEOUT", "Feishu token service timed out", { upstream: error.message });
    }
    return this.readFeishuResponse(response, "FEISHU_TOKEN_ERROR");
  }

  async handleOAuthCallback(ownerId, { state, code, error, errorDescription } = {}) {
    const app = this.requireAppCredentials(ownerId);
    if (error) throw integrationError(400, "FEISHU_OAUTH_DENIED", errorDescription || String(error));
    if (!code) throw integrationError(422, "FEISHU_OAUTH_CODE_REQUIRED", "OAuth callback did not include a code");
    const oauthState = this.consumeOAuthState(ownerId, state);
    const tokenBody = {
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: oauthState.redirect_uri,
    };
    if (oauthState.verifier) tokenBody.code_verifier = oauthState.verifier;
    const payload = rawTokenPayload(await this.tokenRequest(tokenBody, app));
    if (!payload.access_token || !payload.refresh_token) throw integrationError(502, "FEISHU_TOKEN_INVALID", "Feishu token response is incomplete");
    const timestamp = this.nowMs();
    const box = this.secretBox();
    const current = this.connectionRow(ownerId);
    const id = current?.id || randomUUID();
    const scope = Array.isArray(payload.scope) ? payload.scope : String(payload.scope || "").split(/[ ,]+/).filter(Boolean);
    this.db.prepare(`INSERT INTO feishu_connections
      (id,owner_id,tenant_key,feishu_user_id,feishu_user_name,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,refresh_token_expires_at,scopes_json,space_id,space_name,parent_node_token,bitable_app_token,bitable_table_id,bitable_url,sync_policy,status,last_error_code,last_error_message,connected_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'connected',NULL,NULL,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET tenant_key=excluded.tenant_key,feishu_user_id=excluded.feishu_user_id,
        feishu_user_name=excluded.feishu_user_name,access_token_ciphertext=excluded.access_token_ciphertext,
        refresh_token_ciphertext=excluded.refresh_token_ciphertext,token_expires_at=excluded.token_expires_at,
        refresh_token_expires_at=excluded.refresh_token_expires_at,scopes_json=excluded.scopes_json,status='connected',
        last_error_code=NULL,last_error_message=NULL,connected_at=excluded.connected_at,updated_at=excluded.updated_at`).run(
      id, ownerId, String(payload.tenant_key || payload.tenantKey || ""), String(payload.open_id || payload.user_id || ""),
      String(payload.name || payload.user_name || ""), box.encrypt(payload.access_token), box.encrypt(payload.refresh_token),
      iso(timestamp + Number(payload.expires_in || 7200) * 1000),
      payload.refresh_token_expires_in ? iso(timestamp + Number(payload.refresh_token_expires_in) * 1000) : null,
      JSON.stringify(scope), current?.space_id || null, current?.space_name || "", current?.parent_node_token || null,
      current?.bitable_app_token || null, current?.bitable_table_id || null, current?.bitable_url || null,
      current?.sync_policy || "new_only", iso(timestamp), current?.created_at || iso(timestamp), iso(timestamp),
    );
    return { connected: true, connection: connectionView(this.connectionRow(ownerId)), returnTo: oauthState.return_to };
  }

  async readFeishuResponse(response, fallbackCode = "FEISHU_API_ERROR") {
    const requestId = response?.headers?.get?.("x-tt-logid") || response?.headers?.get?.("x-request-id") || null;
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw integrationError(502, "FEISHU_INVALID_RESPONSE", "Feishu returned a non-JSON response", { requestId, upstream: raw.slice(0, 500) }); }
    if (!response.ok || payload?.error || (Number.isFinite(Number(payload?.code)) && Number(payload.code) !== 0)) {
      const rawCode = payload?.code ?? payload?.error?.code ?? payload?.error ?? response.status;
      const upstreamCode = typeof rawCode === "object" ? "UPSTREAM_ERROR" : String(rawCode);
      const message = payload?.error_description || payload?.error?.message || payload?.msg || payload?.message || `Feishu returned ${response.status}`;
      const status = response.ok ? 400 : (response.status || 502);
      throw integrationError(status, `${fallbackCode}_${upstreamCode}`, message, { requestId, upstream: payload });
    }
    return payload;
  }

  async refreshConnection(ownerId, { force = false } = {}) {
    const existing = this.refreshLocks.get(ownerId);
    if (existing) return existing;
    const task = (async () => {
      const row = this.requireConnection(ownerId, { allowPaused: true });
      if (!force && new Date(row.token_expires_at).getTime() > this.nowMs() + 60_000) return row;
      if (row.refresh_token_expires_at && new Date(row.refresh_token_expires_at).getTime() <= this.nowMs()) {
        this.markConnectionError(row, "reauthorize", "FEISHU_REFRESH_TOKEN_EXPIRED", "Refresh token has expired");
        throw integrationError(401, "FEISHU_REAUTHORIZE_REQUIRED", "Feishu authorization must be renewed");
      }
      const refreshToken = this.secretBox().decrypt(row.refresh_token_ciphertext);
      const app = this.requireAppCredentials(ownerId);
      let payload;
      try {
        payload = rawTokenPayload(await this.tokenRequest({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }, app));
      } catch (error) {
        if ([400, 401, 403].includes(Number(error.status))) this.markConnectionError(row, "reauthorize", error.code, error.message);
        throw error;
      }
      if (!payload.access_token || !payload.refresh_token) throw integrationError(502, "FEISHU_TOKEN_INVALID", "Feishu refresh response is incomplete");
      const timestamp = this.nowMs();
      const box = this.secretBox();
      this.db.transaction(() => {
        const latest = this.db.prepare("SELECT refresh_token_ciphertext FROM feishu_connections WHERE id=? AND owner_id=?").get(row.id, ownerId);
        if (!latest) throw integrationError(409, "FEISHU_NOT_CONNECTED", "Feishu account is not connected");
        this.db.prepare(`UPDATE feishu_connections SET access_token_ciphertext=?,refresh_token_ciphertext=?,token_expires_at=?,
          refresh_token_expires_at=?,scopes_json=?,status=CASE WHEN status='reauthorize' THEN 'connected' ELSE status END,
          last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=? AND owner_id=?`).run(
          box.encrypt(payload.access_token), box.encrypt(payload.refresh_token), iso(timestamp + Number(payload.expires_in || 7200) * 1000),
          payload.refresh_token_expires_in ? iso(timestamp + Number(payload.refresh_token_expires_in) * 1000) : row.refresh_token_expires_at,
          JSON.stringify(Array.isArray(payload.scope) ? payload.scope : String(payload.scope || "").split(/[ ,]+/).filter(Boolean)),
          iso(timestamp), row.id, ownerId,
        );
      })();
      return this.connectionRow(ownerId);
    })().finally(() => this.refreshLocks.delete(ownerId));
    this.refreshLocks.set(ownerId, task);
    return task;
  }

  markConnectionError(connection, status, code, message) {
    this.db.prepare("UPDATE feishu_connections SET status=?,last_error_code=?,last_error_message=?,updated_at=? WHERE id=? AND owner_id=?")
      .run(status, String(code || "FEISHU_ERROR"), String(message || "").slice(0, 1000), iso(this.nowMs()), connection.id, connection.owner_id);
  }

  async apiRequest(ownerId, path, options = {}, retry401 = true) {
    let connection = await this.refreshConnection(ownerId);
    const accessToken = this.secretBox().decrypt(connection.access_token_ciphertext);
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/${String(path).replace(/^\/+/, "")}`, {
        ...options,
        headers: {
          ...((typeof FormData !== "undefined" && options.body instanceof FormData) ? {} : { "content-type": "application/json; charset=utf-8" }),
          authorization: `Bearer ${accessToken}`,
          ...(options.headers || {}),
        },
        signal: options.signal || AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw integrationError(504, "FEISHU_API_TIMEOUT", "Feishu API request timed out", { upstream: error.message });
    }
    if (response.status === 401 && retry401) {
      await this.refreshConnection(ownerId, { force: true });
      return this.apiRequest(ownerId, path, options, false);
    }
    return this.readFeishuResponse(response);
  }

  async listSpaces(ownerId, { pageToken = "" } = {}) {
    const query = new URLSearchParams({ page_size: "50" });
    if (pageToken) query.set("page_token", pageToken);
    const payload = await this.apiRequest(ownerId, `wiki/v2/spaces?${query}`);
    const data = payload.data || payload;
    const items = data.items || data.spaces || [];
    return {
      items: items.map(item => ({
        spaceId: String(item.space_id || item.spaceId || item.id || ""),
        name: String(item.name || "未命名知识空间"),
        description: String(item.description || ""),
        visibility: item.visibility || item.space_type || "",
      })).filter(item => item.spaceId),
      pageToken: data.page_token || data.pageToken || "",
      hasMore: Boolean(data.has_more || data.hasMore),
    };
  }

  configure(ownerId, input = {}) {
    const connection = this.requireConnection(ownerId, { allowPaused: true });
    const spaceId = String(input.spaceId || "").trim().slice(0, 200);
    if (!spaceId) throw integrationError(422, "FEISHU_SPACE_REQUIRED", "Please select a Feishu knowledge space");
    const syncPolicy = input.syncPolicy === "all" ? "all" : "new_only";
    const timestamp = iso(this.nowMs());
    this.db.prepare(`UPDATE feishu_connections SET space_id=?,space_name=?,parent_node_token=?,bitable_app_token=COALESCE(?,bitable_app_token),
      bitable_table_id=COALESCE(?,bitable_table_id),bitable_url=COALESCE(?,bitable_url),sync_policy=?,status='connected',
      last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=? AND owner_id=?`).run(
      spaceId, String(input.spaceName || "").slice(0, 200), String(input.parentNodeToken || "").trim() || null,
      String(input.bitableAppToken || "").trim() || null, String(input.bitableTableId || "").trim() || null,
      String(input.bitableUrl || "").trim() || null, syncPolicy, timestamp, connection.id, ownerId,
    );
    return connectionView(this.connectionRow(ownerId));
  }

  enqueueProjectionRefresh(ownerId, inspirationId, { delayMs = 0, maxDelayMs = 120_000, eventKind = "refresh", force = false, payload = {} } = {}) {
    const inspiration = this.db.prepare("SELECT id FROM inspirations WHERE id=? AND owner_id=?").get(inspirationId, ownerId);
    if (!inspiration) throw integrationError(404, "INSPIRATION_NOT_FOUND", "Inspiration does not exist");
    const connection = this.connectionRow(ownerId);
    if (!connection) return { queued: false, reason: "not_connected", inspirationId };
    if (!force && connection.status !== "connected") return { queued: false, reason: connection.status, inspirationId };
    const timestamp = this.nowMs();
    const activeKey = `feishu:${ownerId}:inspiration:${inspirationId}`;
    const dedupeKey = `inspiration:${inspirationId}`;
    const payloadJson = JSON.stringify(payload && typeof payload === "object" ? payload : {});
    const existing = this.db.prepare("SELECT * FROM sync_outbox WHERE active_key=?").get(activeKey);
    if (existing) {
      const first = new Date(existing.first_queued_at).getTime();
      const desired = Math.min(timestamp + Math.max(0, Number(delayMs) || 0), first + Math.max(0, Number(maxDelayMs) || 0));
      const available = Number(delayMs) === 0 ? timestamp : desired;
      this.db.prepare(`UPDATE sync_outbox SET connection_id=?,event_kind=?,payload_json=?,revision=revision+1,
        available_at=?,requested_at=?,updated_at=?,last_error_code=NULL,last_error_message=NULL,last_error_details_json=NULL
        WHERE id=? AND owner_id=?`).run(connection.id, eventKind, payloadJson, iso(available), iso(timestamp), iso(timestamp), existing.id, ownerId);
      return { queued: true, coalesced: true, outboxId: existing.id, inspirationId, syncStatus: "pending" };
    }
    const id = randomUUID();
    const availableAt = iso(timestamp + Math.max(0, Number(delayMs) || 0));
    this.db.prepare(`INSERT INTO sync_outbox
      (id,owner_id,integration,connection_id,aggregate_type,aggregate_id,event_kind,dedupe_key,active_key,payload_json,status,revision,claimed_revision,attempts,lease_owner,lease_expires_at,available_at,first_queued_at,requested_at,last_error_code,last_error_message,last_error_details_json,completed_at,created_at,updated_at)
      VALUES (?,?, 'feishu', ?, 'inspiration', ?, ?, ?, ?, ?,'pending',1,NULL,0,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL,?,?)`).run(
      id, ownerId, connection.id, inspirationId, eventKind, dedupeKey, activeKey, payloadJson, availableAt, iso(timestamp), iso(timestamp), iso(timestamp), iso(timestamp),
    );
    this.ensureBinding(ownerId, connection.id, inspirationId, { syncStatus: "pending" });
    return { queued: true, coalesced: false, outboxId: id, inspirationId, syncStatus: "pending" };
  }

  enqueueExisting(ownerId) {
    const connection = this.requireConnection(ownerId);
    if (!connection.space_id) throw integrationError(409, "FEISHU_DESTINATION_REQUIRED", "Select a Feishu knowledge space before synchronizing");
    const rows = this.db.prepare("SELECT id FROM inspirations WHERE owner_id=? AND status<>'feishu_archived' ORDER BY created_at,id").all(ownerId);
    let queued = 0;
    for (const row of rows) if (this.enqueueProjectionRefresh(ownerId, row.id, { delayMs: 0, eventKind: "sync_existing", force: true }).queued) queued += 1;
    return { queued, total: rows.length };
  }

  retry(ownerId, inspirationId) {
    this.requireConnection(ownerId);
    const binding = this.db.prepare("SELECT id FROM feishu_document_bindings WHERE owner_id=? AND inspiration_id=?").get(ownerId, inspirationId);
    if (binding) this.db.prepare("UPDATE feishu_document_bindings SET sync_status='pending',last_error_code=NULL,last_error_message=NULL,last_error_details_json=NULL,updated_at=? WHERE id=? AND owner_id=?").run(iso(this.nowMs()), binding.id, ownerId);
    return this.enqueueProjectionRefresh(ownerId, inspirationId, { delayMs: 0, eventKind: "manual_retry", force: true });
  }

  pause(ownerId, paused = true) {
    const connection = this.requireConnection(ownerId, { allowPaused: true });
    const status = paused ? "paused" : "connected";
    this.db.prepare("UPDATE feishu_connections SET status=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=? AND owner_id=?")
      .run(status, iso(this.nowMs()), connection.id, ownerId);
    return connectionView(this.connectionRow(ownerId));
  }

  disconnect(ownerId) {
    const connection = this.connectionRow(ownerId);
    if (!connection) return { disconnected: true, remoteDocumentsPreserved: true };
    this.db.transaction(() => {
      this.db.prepare(`UPDATE feishu_document_bindings SET sync_status='failed',last_error_code='FEISHU_DISCONNECTED',
        last_error_message='Feishu connection was removed',updated_at=? WHERE owner_id=?`).run(iso(this.nowMs()), ownerId);
      this.db.prepare("DELETE FROM integration_oauth_states WHERE owner_id=? AND provider='feishu'").run(ownerId);
      this.db.prepare("DELETE FROM feishu_connections WHERE id=? AND owner_id=?").run(connection.id, ownerId);
    })();
    return { disconnected: true, remoteDocumentsPreserved: true };
  }

  buildProjection(ownerId, inspirationId) { return buildFeishuProjection(this.db, ownerId, inspirationId); }

  ensureInspirationLibrary(ownerId, inspirationId) {
    const timestamp = iso(this.nowMs());
    const defaultId = `library-default-${ownerId}`;
    this.db.prepare(`INSERT OR IGNORE INTO inspiration_libraries
      (id,owner_id,name,is_default,sort_order,created_at,updated_at) VALUES (?,?,?,1,0,?,?)`)
      .run(defaultId, ownerId, "待分类", timestamp, timestamp);
    this.db.prepare(`INSERT OR IGNORE INTO inspiration_library_assignments
      (inspiration_id,owner_id,library_id,updated_at) VALUES (?,?,?,?)`)
      .run(inspirationId, ownerId, defaultId, timestamp);
  }

  ensureBinding(ownerId, connectionId, inspirationId, { syncStatus = "pending" } = {}) {
    const timestamp = iso(this.nowMs());
    this.db.prepare(`INSERT INTO feishu_document_bindings
      (id,owner_id,connection_id,inspiration_id,section_blocks_json,sync_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,inspiration_id) DO UPDATE SET connection_id=excluded.connection_id,
        sync_status=CASE WHEN feishu_document_bindings.sync_status='syncing' THEN feishu_document_bindings.sync_status ELSE excluded.sync_status END,
        updated_at=excluded.updated_at`).run(randomUUID(), ownerId, connectionId, inspirationId, "{}", syncStatus, timestamp, timestamp);
    return this.db.prepare("SELECT * FROM feishu_document_bindings WHERE owner_id=? AND inspiration_id=?").get(ownerId, inspirationId);
  }

  claimNextOutbox() {
    const timestamp = this.nowMs();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE sync_outbox SET status='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE integration='feishu' AND status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`).run(iso(timestamp), iso(timestamp));
      const row = this.db.prepare(`SELECT o.* FROM sync_outbox o JOIN feishu_connections c ON c.id=o.connection_id AND c.owner_id=o.owner_id
        WHERE o.integration='feishu' AND o.status='pending' AND o.available_at<=? AND c.status='connected'
        ORDER BY o.available_at,o.created_at LIMIT 1`).get(iso(timestamp));
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE sync_outbox SET status='processing',claimed_revision=revision,attempts=attempts+1,
        lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND owner_id=? AND status='pending'`).run(
        this.workerId, iso(timestamp + 120_000), iso(timestamp), row.id, row.owner_id,
      );
      return changed.changes ? this.db.prepare("SELECT * FROM sync_outbox WHERE id=?").get(row.id) : null;
    })();
  }

  async withConnectionLock(connectionId, callback) {
    const previous = this.connectionLocks.get(connectionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.connectionLocks.set(connectionId, current);
    try { return await current; }
    finally { if (this.connectionLocks.get(connectionId) === current) this.connectionLocks.delete(connectionId); }
  }

  async processNextOutbox() {
    const task = this.claimNextOutbox();
    if (!task) return null;
    return this.withConnectionLock(task.connection_id, async () => {
      const renewLease = () => this.db.prepare(`UPDATE sync_outbox SET lease_expires_at=?,updated_at=?
        WHERE id=? AND owner_id=? AND status='processing' AND lease_owner=?`).run(
        iso(this.nowMs() + 120_000), iso(this.nowMs()), task.id, task.owner_id, task.lease_owner,
      );
      const leaseTimer = setInterval(renewLease, 30_000);
      leaseTimer.unref?.();
      const binding = this.ensureBinding(task.owner_id, task.connection_id, task.aggregate_id, { syncStatus: "syncing" });
      this.db.prepare("UPDATE feishu_document_bindings SET sync_status='syncing',updated_at=? WHERE id=? AND owner_id=?").run(iso(this.nowMs()), binding.id, task.owner_id);
      try {
        const result = await this.syncProjection(task.owner_id, task.aggregate_id);
        this.completeOutbox(task, result);
        return { taskId: task.id, status: "succeeded", ...result };
      } catch (error) {
        this.failOutbox(task, error);
        return { taskId: task.id, status: "failed", error: errorDetails(error) };
      } finally {
        clearInterval(leaseTimer);
      }
    });
  }

  completeOutbox(task, result) {
    const timestamp = iso(this.nowMs());
    const payload = parseJson(task.payload_json, {});
    let pruneSummary = null;
    this.db.transaction(() => {
      const latest = this.db.prepare("SELECT revision,available_at,lease_owner FROM sync_outbox WHERE id=? AND owner_id=?").get(task.id, task.owner_id);
      if (!latest || latest.lease_owner !== task.lease_owner) return;
      if (latest.revision > task.claimed_revision) {
        this.db.prepare(`UPDATE sync_outbox SET status='pending',claimed_revision=NULL,lease_owner=NULL,lease_expires_at=NULL,
          available_at=CASE WHEN available_at<? THEN ? ELSE available_at END,last_error_code=NULL,last_error_message=NULL,
          last_error_details_json=NULL,updated_at=? WHERE id=? AND owner_id=?`).run(timestamp, timestamp, timestamp, task.id, task.owner_id);
        this.db.prepare("UPDATE feishu_document_bindings SET sync_status='pending',updated_at=? WHERE owner_id=? AND inspiration_id=?").run(timestamp, task.owner_id, task.aggregate_id);
      } else {
        this.db.prepare(`UPDATE sync_outbox SET status='succeeded',active_key=NULL,claimed_revision=NULL,lease_owner=NULL,
          lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL,last_error_details_json=NULL,completed_at=?,updated_at=?
          WHERE id=? AND owner_id=?`).run(timestamp, timestamp, task.id, task.owner_id);
        this.db.prepare(`UPDATE feishu_document_bindings SET sync_status='synced',source_hash=?,last_error_code=NULL,
          last_error_message=NULL,last_error_details_json=NULL,last_synced_at=?,updated_at=? WHERE owner_id=? AND inspiration_id=?`).run(
          result.sourceHash, timestamp, timestamp, task.owner_id, task.aggregate_id,
        );
        if (task.event_kind === "feishu_archive" || payload.archiveAfterSync) {
          this.db.prepare(`UPDATE inspirations SET status='feishu_archived',updated_at=?,revision=revision+1
            WHERE id=? AND owner_id=? AND status='feishu_archiving'`).run(timestamp, task.aggregate_id, task.owner_id);
          pruneSummary = this.pruneArchivedLocalPayload(task.owner_id, task.aggregate_id, timestamp);
        }
      }
    })();
    if (pruneSummary && this.onPruneArchivedLocal) {
      try {
        const hookResult = this.onPruneArchivedLocal(pruneSummary);
        if (hookResult?.catch) hookResult.catch(error => console.warn("Feishu archive local file prune failed", error?.message || error));
      } catch (error) {
        console.warn("Feishu archive local file prune failed", error?.message || error);
      }
    }
  }

  pruneArchivedLocalPayload(ownerId, inspirationId, timestamp = iso(this.nowMs())) {
    const row = this.db.prepare("SELECT id,owner_id,thumbnail,status FROM inspirations WHERE id=? AND owner_id=?").get(inspirationId, ownerId);
    if (!row || row.status !== "feishu_archived") return null;
    const counts = {
      actionItems: this.db.prepare("SELECT COUNT(*) AS count FROM action_items WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      annotations: this.db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      analyses: this.db.prepare("SELECT COUNT(*) AS count FROM analyses WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      personalDocuments: this.db.prepare("SELECT COUNT(*) AS count FROM personal_documents WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      readingDocuments: this.db.prepare("SELECT COUNT(*) AS count FROM reading_documents WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      transcriptVersions: this.db.prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      transcriptionJobs: this.db.prepare("SELECT COUNT(*) AS count FROM transcription_jobs WHERE inspiration_id=? AND owner_id=?").get(inspirationId, ownerId).count,
      tagLinks: this.db.prepare("SELECT COUNT(*) AS count FROM inspiration_tags WHERE inspiration_id=?").get(inspirationId).count,
    };
    this.db.prepare("DELETE FROM action_items WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM personal_document_mutations WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM personal_document_revisions WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM personal_documents WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM annotations WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM analyses WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM inspiration_tags WHERE inspiration_id=?").run(inspirationId);
    this.db.prepare("UPDATE inspirations SET active_reading_document_id=NULL,active_transcript_id=NULL,transcription_job_id=NULL,transcription_status='',quick_thought='',thumbnail='',revision=revision+1,updated_at=? WHERE id=? AND owner_id=?").run(timestamp, inspirationId, ownerId);
    this.db.prepare("DELETE FROM reading_documents WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM transcript_versions WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    this.db.prepare("DELETE FROM transcription_jobs WHERE inspiration_id=? AND owner_id=?").run(inspirationId, ownerId);
    return { ownerId, inspirationId, thumbnail: row.thumbnail || "", counts };
  }

  failOutbox(task, error) {
    const details = errorDetails(error);
    const payload = parseJson(task.payload_json, {});
    const timestamp = this.nowMs();
    const retryable = error?.status === 429 || Number(error?.status) >= 500 || error?.code === "FEISHU_API_TIMEOUT";
    const retry = retryable && task.attempts < 8;
    const connectionStatus = Number(error?.status) === 401 ? "reauthorize" : Number(error?.status) === 403 ? "permission_error" : null;
    this.db.transaction(() => {
      const latest = this.db.prepare("SELECT lease_owner FROM sync_outbox WHERE id=? AND owner_id=?").get(task.id, task.owner_id);
      if (!latest || latest.lease_owner !== task.lease_owner) return;
      if (connectionStatus) {
        this.db.prepare("UPDATE feishu_connections SET status=?,last_error_code=?,last_error_message=?,updated_at=? WHERE id=? AND owner_id=?")
          .run(connectionStatus, details.code, details.message, iso(timestamp), task.connection_id, task.owner_id);
      }
      if (retry) {
        const delay = RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, task.attempts - 1))];
        this.db.prepare(`UPDATE sync_outbox SET status='pending',claimed_revision=NULL,lease_owner=NULL,lease_expires_at=NULL,
          available_at=?,last_error_code=?,last_error_message=?,last_error_details_json=?,updated_at=? WHERE id=? AND owner_id=?`).run(
          iso(timestamp + delay), details.code, details.message, JSON.stringify(details), iso(timestamp), task.id, task.owner_id,
        );
      } else {
        this.db.prepare(`UPDATE sync_outbox SET status='failed',active_key=NULL,claimed_revision=NULL,lease_owner=NULL,
          lease_expires_at=NULL,last_error_code=?,last_error_message=?,last_error_details_json=?,completed_at=?,updated_at=?
          WHERE id=? AND owner_id=?`).run(details.code, details.message, JSON.stringify(details), iso(timestamp), iso(timestamp), task.id, task.owner_id);
        if ((task.event_kind === "feishu_archive" || payload.archiveAfterSync) && payload.previousStatus) {
          this.db.prepare(`UPDATE inspirations SET status=?,updated_at=?,revision=revision+1
            WHERE id=? AND owner_id=? AND status='feishu_archiving'`).run(
            payload.previousStatus, iso(timestamp), task.aggregate_id, task.owner_id,
          );
        }
      }
      const bindingStatus = connectionStatus || "failed";
      this.db.prepare(`UPDATE feishu_document_bindings SET sync_status=?,last_error_code=?,last_error_message=?,
        last_error_details_json=?,updated_at=? WHERE owner_id=? AND inspiration_id=?`).run(
        bindingStatus, details.code, details.message, JSON.stringify(details), iso(timestamp), task.owner_id, task.aggregate_id,
      );
    })();
  }

  async ensureIndex(ownerId, connection) {
    let appToken = connection.bitable_app_token;
    let tableId = connection.bitable_table_id;
    let bitableUrl = connection.bitable_url;
    let createdApp = false;
    if (!appToken) {
      const appPayload = await this.apiRequest(ownerId, "bitable/v1/apps", { method: "POST", body: JSON.stringify({ name: "灵感索引" }) });
      const app = appPayload.data?.app || appPayload.data || appPayload.app || appPayload;
      appToken = app.app_token || app.appToken;
      tableId = app.default_table_id || app.defaultTableId || app.table_id || app.tableId;
      bitableUrl = app.url || appPayload.data?.url || null;
      createdApp = true;
    }
    if (!appToken) throw integrationError(502, "FEISHU_BITABLE_CREATE_INVALID", "Feishu did not return a Bitable app token");
    const cacheKey = tableId ? `${appToken}:${tableId}:${INDEX_FIELDS.map(field => `${field.field_name}:${field.type}`).join("|")}` : "";
    let needsStructuredTable = createdApp || !tableId;
    if (!needsStructuredTable && !this.validatedIndexTables.has(cacheKey)) {
      const fieldsPayload = await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
      const fields = fieldsPayload.data?.items || fieldsPayload.items || [];
      const names = new Set(fields.map(field => field.field_name || field.fieldName));
      const requiredNames = new Set(INDEX_FIELDS.map(field => field.field_name));
      needsStructuredTable = !names.has("灵感ID") || !names.has("标题");
      if (!needsStructuredTable) await this.ensureTableFields(ownerId, appToken, tableId, INDEX_FIELDS, this.validatedIndexTables);
      if (!needsStructuredTable && [...requiredNames].every(name => names.has(name))) this.validatedIndexTables.add(cacheKey);
    }
    if (needsStructuredTable) {
      const previousTableId = tableId;
      const tablePayload = await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables`, {
        method: "POST",
        body: JSON.stringify({ table: { name: "灵感索引", default_view_name: "全部灵感", fields: INDEX_FIELDS } }),
      });
      tableId = tablePayload.data?.table_id || tablePayload.data?.table?.table_id || tablePayload.table_id;
      if (tableId) this.validatedIndexTables.add(`${appToken}:${tableId}:${INDEX_FIELDS.map(field => `${field.field_name}:${field.type}`).join("|")}`);
      if (previousTableId && tableId && previousTableId !== tableId) {
        this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${previousTableId}`, { method: "DELETE" }).catch(() => {});
      }
    }
    if (!tableId) throw integrationError(502, "FEISHU_BITABLE_TABLE_INVALID", "Feishu did not return a Bitable table ID");
    const timestamp = iso(this.nowMs());
    this.db.prepare("UPDATE feishu_connections SET bitable_app_token=?,bitable_table_id=?,bitable_url=?,updated_at=? WHERE id=? AND owner_id=?")
      .run(appToken, tableId, bitableUrl, timestamp, connection.id, ownerId);
    return this.connectionRow(ownerId);
  }

  indexFields(projection, documentUrl = "", coverFileToken = "") {
    const urlField = value => value ? { text: value, link: value } : null;
    const coverField = coverFileToken ? [{ file_token: coverFileToken, name: "封面", type: "image/jpeg" }] : [];
    const tagLabels = (projection.tags || []).map(item => `${item.group ? `${item.group} / ` : ""}#${item.name}`).filter(Boolean);
    return {
      "记录类型": "灵感",
      "灵感ID": projection.inspirationId,
      "标题": projection.title,
      "灵感库": projection.library?.name || "待分类",
      "封面": coverField,
      "平台": projection.platform,
      "作者": projection.author,
      "视频链接": urlField(projection.url),
      "标签": tagLabels,
      "状态": projection.status,
      "转写状态": projection.transcriptionStatus,
      "摘要": projection.summary,
      "Docx 链接": urlField(documentUrl),
      "创建时间": new Date(projection.createdAt).getTime(),
      "更新时间": new Date(projection.updatedAt).getTime(),
      "同步状态": "已同步",
    };
  }

  libraryIndexFields(projection, documentUrl = "", coverFileToken = "") {
    const urlField = (value, label = value) => value ? { text: label || value, link: value } : null;
    const coverField = coverFileToken ? [{ file_token: coverFileToken, name: "封面", type: "image/jpeg" }] : [];
    const tagLabels = (projection.tags || []).map(item => `${item.group ? `${item.group} / ` : ""}#${item.name}`).filter(Boolean);
    return {
      "灵感ID": projection.inspirationId,
      "封面图": coverField,
      "标题": projection.title,
      "我的标签": tagLabels,
      "日期": new Date(projection.createdAt).getTime(),
      "作者名称": projection.author,
      "原链接": urlField(projection.url, "原文"),
      "跳转笔记链接": urlField(documentUrl, "打开笔记"),
      "灵感库": projection.library?.name || "待分类",
      "同步状态": "已同步",
    };
  }

  recordId(record) {
    return record?.record_id || record?.recordId || "";
  }

  fieldPlainText(value) {
    if (value == null) return "";
    if (["string", "number", "boolean"].includes(typeof value)) return String(value);
    if (Array.isArray(value)) return value.map(item => this.fieldPlainText(item)).join("");
    if (typeof value === "object") return String(value.text || value.name || value.value || value.link || "");
    return String(value || "");
  }

  attachmentFileToken(value) {
    if (!value) return "";
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!item || typeof item !== "object") continue;
      const token = item.file_token || item.fileToken || item.token || "";
      if (token) return token;
    }
    return "";
  }

  blockElements(block) {
    if (!block || typeof block !== "object") return [];
    const containers = ["text", "heading1", "heading2", "heading3", "heading4", "bullet", "ordered", "quote", "todo"];
    for (const key of containers) {
      const elements = block[key]?.elements;
      if (Array.isArray(elements)) return elements;
    }
    return [];
  }

  blockPlainText(block) {
    return this.blockElements(block).map(element => {
      const run = element?.text_run || element?.mention_doc || element?.equation || element;
      return String(run?.content || run?.text || run?.name || "");
    }).join("");
  }

  tagsFromDocumentText(text) {
    const labels = [];
    const seen = new Set();
    const source = String(text || "");
    if (!source.includes("#") || !source.includes("/")) return labels;
    for (const match of source.matchAll(/(?:^|[　\s])([^#\n　]+?)\s*\/\s*#([^\s#　]+)/g)) {
      const group = String(match[1] || "").replace(/^[,，;；、|｜\-—:：]+/, "").trim();
      const name = String(match[2] || "").replace(/[),，。;；、|｜]+$/, "").trim();
      if (!name) continue;
      const key = `${group}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ group, name });
    }
    return labels;
  }

  async documentArchiveMetadata(ownerId, documentId) {
    if (!documentId) return { tags: [], cover: null };
    const children = await this.listRootChildren(ownerId, documentId);
    let cover = null;
    const tags = [];
    const seenTags = new Set();
    for (const item of children) {
      if (!cover) {
        const image = item?.image || item?.img || item?.picture || null;
        const token = image?.token || image?.file_token || image?.fileToken || item?.token || item?.file_token || item?.fileToken || "";
        if (token) {
          cover = {
            token,
            width: Number(image?.width || item?.width || 0),
            height: Number(image?.height || item?.height || 0),
          };
        }
      }
      for (const tag of this.tagsFromDocumentText(this.blockPlainText(item))) {
        const key = `${tag.group}\u0000${tag.name}`;
        if (seenTags.has(key)) continue;
        seenTags.add(key);
        tags.push(tag);
      }
    }
    return { tags, cover };
  }

  async enrichProjectionFromDocument(ownerId, binding, projection) {
    const needsTags = !(projection.tags || []).length;
    const needsCover = !projection.thumbnail && !projection.documentCoverToken;
    if (!binding?.docx_document_id || (!needsTags && !needsCover)) return projection;
    try {
      const metadata = await this.documentArchiveMetadata(ownerId, binding.docx_document_id);
      return {
        ...projection,
        tags: needsTags && metadata.tags.length ? metadata.tags : projection.tags,
        documentCoverToken: needsCover ? (metadata.cover?.token || "") : projection.documentCoverToken,
        documentId: binding.docx_document_id,
        documentCoverWidth: metadata.cover?.width || 0,
        documentCoverHeight: metadata.cover?.height || 0,
      };
    } catch (error) {
      console.warn("Feishu archived metadata recovery skipped", error?.code || error?.message || error);
      return projection;
    }
  }

  async bitableCoverToken(ownerId, connection, projection, existingAttachment = null) {
    const existingToken = this.attachmentFileToken(existingAttachment);
    if (existingToken) return existingToken;
    if (!connection?.bitable_app_token) return "";
    try {
      let prepared = null;
      if (projection.thumbnail) {
        prepared = await this.prepareCoverImage(projection.thumbnail);
      } else if (projection.documentCoverToken) {
        prepared = await this.downloadMedia(ownerId, projection.documentCoverToken, {
          documentId: projection.documentId || projection.docxDocumentId || "",
        });
      }
      if (!prepared) return "";
      return await this.uploadMedia(ownerId, prepared, { parentType: "bitable_file", parentNode: connection.bitable_app_token });
    } catch (error) {
      console.warn("Feishu Bitable cover upload skipped", error?.code || error?.message || error);
      return "";
    }
  }

  async findIndexRows(ownerId, connection, inspirationId) {
    const payload = await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${connection.bitable_table_id}/records/search?page_size=200`, {
      method: "POST",
      body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "灵感ID", operator: "is", value: [inspirationId] }] } }),
    });
    return payload.data?.items || payload.data?.records || payload.items || [];
  }

  clueFields(projection, clue, documentUrl = "") {
    const urlField = value => value ? { text: value, link: value } : null;
    const summary = compactText([clue.value || clue.note || "", clue.nextStep ? `下一步：${clue.nextStep}` : ""].filter(Boolean).join("；"), 260);
    return {
      "记录类型": "线索",
      "灵感ID": projection.inspirationId,
      "标题": projection.title,
      "灵感库": projection.library?.name || "待分类",
      "状态": projection.status,
      "同步状态": "已同步",
      "线索ID": clue.clueId,
      "开放分类": clue.openCategory || clue.type || "待分类",
      "领域": clue.domain || "未归类领域",
      "线索名称": clue.name,
      "外链": urlField(clue.externalUrl || clue.url || ""),
      "线索摘要": summary,
      "来源章节": clue.source || "内容拆解",
      "飞书笔记": urlField(documentUrl),
      "创建时间": new Date(projection.createdAt).getTime(),
      "更新时间": new Date(projection.updatedAt).getTime(),
    };
  }

  async ensureIndexRecord(ownerId, connection, binding, projection, documentUrl = "", coverFileToken = "") {
    const rows = await this.findIndexRows(ownerId, connection, projection.inspirationId);
    const existing = rows.find(row => {
      const type = this.fieldPlainText(row.fields?.["记录类型"]);
      return !type || type === "灵感";
    });
    const recordId = binding.bitable_record_id || this.recordId(existing);
    const resolvedCoverToken = coverFileToken || await this.bitableCoverToken(ownerId, connection, projection, existing?.fields?.["封面"]);
    const fields = this.indexFields(projection, documentUrl, resolvedCoverToken);
    if (recordId) {
      await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${connection.bitable_table_id}/records/${recordId}`, {
        method: "PUT", body: JSON.stringify({ fields }),
      });
      return recordId;
    }
    const created = await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${connection.bitable_table_id}/records`, {
      method: "POST", body: JSON.stringify({ fields }),
    });
    const record = created.data?.record || created.data || created.record || created;
    const createdRecordId = this.recordId(record);
    if (!createdRecordId) throw integrationError(502, "FEISHU_BITABLE_RECORD_INVALID", "Feishu did not return a Bitable record ID");
    return createdRecordId;
  }

  async ensureTableFields(ownerId, appToken, tableId, fields, cacheSet = this.validatedIndexTables) {
    const cacheKey = `${appToken}:${tableId}:${fields.map(field => `${field.field_name}:${field.type}`).join("|")}`;
    if (cacheSet.has(cacheKey)) return;
    const payload = await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
    const existing = payload.data?.items || payload.items || [];
    const existingByName = new Map(existing.map(field => [field.field_name || field.fieldName, field]));
    for (const field of fields) {
      const current = existingByName.get(field.field_name);
      if (!current) {
        await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
          method: "POST", body: JSON.stringify(field),
        });
        continue;
      }
      const currentType = Number(current.type ?? current.field_type ?? current.fieldType);
      if (Number(field.type) !== currentType) {
        const fieldId = current.field_id || current.fieldId || current.id;
        if (fieldId) {
          try {
            await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`, {
              method: "PUT", body: JSON.stringify(field),
            });
          } catch (error) {
            console.warn("Feishu Bitable field type update fell back to recreate", field.field_name, error?.code || error?.message || error);
            await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`, { method: "DELETE" });
            await this.apiRequest(ownerId, `bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
              method: "POST", body: JSON.stringify(field),
            });
          }
        }
      }
    }
    cacheSet.add(cacheKey);
  }

  async ensureLibraryIndex(ownerId, connection, library, binding) {
    if (!connection.bitable_app_token) throw integrationError(409, "FEISHU_BITABLE_MISSING", "Feishu Bitable app is not ready");
    let tableId = binding?.library_bitable_table_id || "";
    let viewId = binding?.library_bitable_view_id || "";
    const timestamp = iso(this.nowMs());
    if (!tableId) {
      const payload = await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables`, {
        method: "POST",
        body: JSON.stringify({ table: { name: String(library.name || "待分类").slice(0, 100), default_view_name: "全部笔记", fields: LIBRARY_INDEX_FIELDS } }),
      });
      const table = payload.data?.table || payload.data || payload.table || payload;
      tableId = table.table_id || table.tableId || payload.data?.table_id || payload.table_id || "";
      viewId = table.default_view_id || table.defaultViewId || payload.data?.default_view_id || viewId || "";
      if (!tableId) throw integrationError(502, "FEISHU_LIBRARY_TABLE_INVALID", "Feishu did not return the library Bitable table ID");
      this.validatedLibraryTables.add(`${connection.bitable_app_token}:${tableId}:${LIBRARY_INDEX_FIELDS.map(field => `${field.field_name}:${field.type}`).join("|")}`);
      this.db.prepare(`UPDATE feishu_library_bindings SET library_bitable_table_id=?,library_bitable_view_id=?,updated_at=?
        WHERE id=? AND owner_id=?`).run(tableId, viewId || null, timestamp, binding.id, ownerId);
    } else {
      await this.ensureTableFields(ownerId, connection.bitable_app_token, tableId, LIBRARY_INDEX_FIELDS, this.validatedLibraryTables);
      if (binding?.library_name_snapshot !== library.name) {
        await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${tableId}`, {
          method: "PATCH", body: JSON.stringify({ table: { name: String(library.name || "待分类").slice(0, 100) } }),
        }).catch(error => {
          console.warn("Feishu library Bitable rename skipped", error?.code || error?.message || error);
        });
      }
    }
    return this.db.prepare("SELECT * FROM feishu_library_bindings WHERE id=? AND owner_id=?").get(binding.id, ownerId);
  }

  async findLibraryIndexRows(ownerId, connection, tableId, inspirationId) {
    const payload = await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${tableId}/records/search?page_size=50`, {
      method: "POST",
      body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "灵感ID", operator: "is", value: [inspirationId] }] } }),
    });
    return payload.data?.items || payload.data?.records || payload.items || [];
  }

  async removeLibraryIndexRecord(ownerId, connection, binding) {
    if (!binding?.library_bitable_record_id || !binding.library_id) return false;
    const previous = this.db.prepare(`SELECT library_bitable_table_id FROM feishu_library_bindings
      WHERE owner_id=? AND connection_id=? AND library_id=?`).get(ownerId, connection.id, binding.library_id);
    if (previous?.library_bitable_table_id) {
      await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${previous.library_bitable_table_id}/records/${binding.library_bitable_record_id}`, { method: "DELETE" }).catch(error => {
        console.warn("Feishu old library index row delete skipped", error?.code || error?.message || error);
      });
    }
    this.db.prepare("UPDATE feishu_document_bindings SET library_bitable_record_id=NULL,updated_at=? WHERE id=? AND owner_id=?")
      .run(iso(this.nowMs()), binding.id, ownerId);
    return true;
  }

  async ensureLibraryIndexRecord(ownerId, connection, binding, projection, libraryBinding, documentUrl = "", coverFileToken = "") {
    const tableId = libraryBinding?.library_bitable_table_id;
    if (!tableId) return "";
    const rows = await this.findLibraryIndexRows(ownerId, connection, tableId, projection.inspirationId);
    const existing = rows.find(row => this.fieldPlainText(row.fields?.["灵感ID"]) === projection.inspirationId && this.recordId(row));
    const recordId = binding.library_bitable_record_id || this.recordId(existing);
    const resolvedCoverToken = coverFileToken || await this.bitableCoverToken(ownerId, connection, projection, existing?.fields?.["封面图"]);
    const fields = this.libraryIndexFields(projection, documentUrl, resolvedCoverToken);
    if (recordId) {
      await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${tableId}/records/${recordId}`, {
        method: "PUT", body: JSON.stringify({ fields }),
      });
      return recordId;
    }
    const created = await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${tableId}/records`, {
      method: "POST", body: JSON.stringify({ fields }),
    });
    const record = created.data?.record || created.data || created.record || created;
    const createdRecordId = this.recordId(record);
    if (!createdRecordId) throw integrationError(502, "FEISHU_LIBRARY_RECORD_INVALID", "Feishu did not return the library index record ID");
    return createdRecordId;
  }

  async refreshLibraryHub(ownerId, connection, library, libraryBinding) {
    if (!libraryBinding?.docx_document_id) return { refreshed: false };
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM inspiration_library_assignments a
      JOIN inspirations i ON i.id=a.inspiration_id AND i.owner_id=a.owner_id
      WHERE a.owner_id=? AND a.library_id=?`).get(ownerId, library.id).count;
    const tableUrl = bitableTableUrl(connection, libraryBinding);
    const blocks = [
      docBlock("heading1", library.name),
      docBlock("quote", [textRun(`本库已接入多维表格，共 ${total} 条灵感笔记。`)]),
      ...(tableUrl ? [docBlock("text", [textRun("打开本库多维表格", { bold: true, link: { url: validLink(tableUrl) } })])] : []),
      docBlock("text", `下面的灵感笔记会持续同步到这个目录和表格中。`),
    ];
    const children = await this.listRootChildren(ownerId, libraryBinding.docx_document_id);
    if (children.length) {
      await this.apiRequest(ownerId, `docx/v1/documents/${libraryBinding.docx_document_id}/blocks/${libraryBinding.docx_document_id}/children/batch_delete`, {
        method: "DELETE",
        body: JSON.stringify({ start_index: 0, end_index: children.length }),
      });
    }
    await this.createChildren(ownerId, libraryBinding.docx_document_id, blocks, 0);
    return { refreshed: true, total };
  }

  async ensureClueRecords(ownerId, connection, projection, documentUrl = "") {
    const clues = Array.isArray(projection.clues) ? projection.clues.slice(0, 120) : [];
    const rows = await this.findIndexRows(ownerId, connection, projection.inspirationId);
    const clueRows = rows.filter(row => this.fieldPlainText(row.fields?.["记录类型"]) === "线索");
    const existingByClueId = new Map();
    for (const row of clueRows) {
      const clueId = this.fieldPlainText(row.fields?.["线索ID"]);
      if (clueId && this.recordId(row)) existingByClueId.set(clueId, row);
    }
    const expectedIds = new Set();
    for (const clue of clues) {
      expectedIds.add(clue.clueId);
      const fields = this.clueFields(projection, clue, documentUrl);
      const existing = existingByClueId.get(clue.clueId);
      if (existing) {
        await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${connection.bitable_table_id}/records/${this.recordId(existing)}`, {
          method: "PUT", body: JSON.stringify({ fields }),
        });
      } else {
        await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${connection.bitable_table_id}/records`, {
          method: "POST", body: JSON.stringify({ fields }),
        });
      }
    }
    for (const row of clueRows) {
      const clueId = this.fieldPlainText(row.fields?.["线索ID"]);
      const id = this.recordId(row);
      if (id && clueId && !expectedIds.has(clueId)) {
        await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${connection.bitable_table_id}/records/${id}`, { method: "DELETE" });
      }
    }
    return { upserted: clues.length, deleted: clueRows.filter(row => !expectedIds.has(this.fieldPlainText(row.fields?.["线索ID"]))).length };
  }


  async createWikiNode(ownerId, connection, title, parentNodeToken = null) {
    if (!connection.space_id) throw integrationError(409, "FEISHU_DESTINATION_REQUIRED", "Select a Feishu knowledge space before synchronizing");
    const payload = await this.apiRequest(ownerId, `wiki/v2/spaces/${connection.space_id}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        obj_type: "docx",
        node_type: "origin",
        title: String(title || "未命名").slice(0, 200),
        ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
      }),
    });
    const node = payload.data?.node || payload.data || payload.node || payload;
    const wikiNodeToken = node.node_token || node.nodeToken;
    const documentId = node.obj_token || node.objToken;
    if (!wikiNodeToken || !documentId) throw integrationError(502, "FEISHU_DOCUMENT_CREATE_INVALID", "Feishu did not return document identifiers");
    return {
      wikiNodeToken,
      documentId,
      documentUrl: node.url || `https://feishu.cn/wiki/${wikiNodeToken}`,
    };
  }

  async ensureLibraryNode(ownerId, connection, library) {
    let binding = this.db.prepare(`SELECT * FROM feishu_library_bindings
      WHERE owner_id=? AND connection_id=? AND library_id=?`).get(ownerId, connection.id, library.id);
    const rootParent = connection.parent_node_token || null;
    if (!binding || binding.status === "deleted" || binding.space_id !== connection.space_id || (binding.root_parent_node_token || null) !== rootParent) {
      const node = await this.createWikiNode(ownerId, connection, library.name, rootParent);
      const timestamp = iso(this.nowMs());
      this.db.prepare(`INSERT INTO feishu_library_bindings
        (id,owner_id,connection_id,library_id,space_id,root_parent_node_token,wiki_node_token,docx_document_id,
         document_url,library_name_snapshot,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'active',?,?)
        ON CONFLICT(owner_id,connection_id,library_id) DO UPDATE SET space_id=excluded.space_id,
          root_parent_node_token=excluded.root_parent_node_token,wiki_node_token=excluded.wiki_node_token,
          docx_document_id=excluded.docx_document_id,document_url=excluded.document_url,
          library_name_snapshot=excluded.library_name_snapshot,status='active',last_error_code=NULL,
          last_error_message=NULL,updated_at=excluded.updated_at`).run(
        randomUUID(), ownerId, connection.id, library.id, connection.space_id, rootParent,
        node.wikiNodeToken, node.documentId, node.documentUrl, library.name, timestamp, timestamp,
      );
      binding = this.db.prepare(`SELECT * FROM feishu_library_bindings
        WHERE owner_id=? AND connection_id=? AND library_id=?`).get(ownerId, connection.id, library.id);
    } else if (binding.library_name_snapshot !== library.name) {
      await this.apiRequest(ownerId, `docx/v1/documents/${binding.docx_document_id}`, {
        method: "PATCH", body: JSON.stringify({ title: library.name.slice(0, 200) }),
      });
      if (connection.bitable_app_token && binding.library_bitable_table_id) {
        await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${binding.library_bitable_table_id}`, {
          method: "PATCH", body: JSON.stringify({ table: { name: library.name.slice(0, 100) } }),
        }).catch(error => {
          console.warn("Feishu library Bitable rename skipped", error?.code || error?.message || error);
        });
      }
      this.db.prepare(`UPDATE feishu_library_bindings SET library_name_snapshot=?,status='active',
        last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=? AND owner_id=?`).run(
        library.name, iso(this.nowMs()), binding.id, ownerId,
      );
      binding = { ...binding, library_name_snapshot: library.name };
    }
    return binding;
  }

  async syncLibraryDirectory(ownerId, libraryId) {
    let connection = this.connectionRow(ownerId);
    if (!connection || connection.status !== "connected" || !connection.space_id) return { synced: false, reason: "not_connected" };
    const library = this.db.prepare("SELECT id,name FROM inspiration_libraries WHERE id=? AND owner_id=? AND deleted_at IS NULL")
      .get(libraryId, ownerId);
    if (!library) throw integrationError(404, "LIBRARY_NOT_FOUND", "Inspiration library does not exist");
    return this.withConnectionLock(connection.id, async () => {
      connection = await this.ensureIndex(ownerId, connection);
      let binding = await this.ensureLibraryNode(ownerId, connection, library);
      binding = await this.ensureLibraryIndex(ownerId, connection, library, binding);
      await this.refreshLibraryHub(ownerId, connection, library, binding);
      return { synced: true, wikiNodeToken: binding.wiki_node_token, documentUrl: binding.document_url, tableId: binding.library_bitable_table_id, bitableUrl: bitableTableUrl(connection, binding) };
    });
  }

  async ensureDocumentPlacement(ownerId, connection, binding, libraryBinding, projection) {
    if (!binding.docx_document_id || !binding.wiki_node_token) {
      const document = await this.createWikiNode(ownerId, connection, projection.title, libraryBinding.wiki_node_token);
      this.db.prepare(`UPDATE feishu_document_bindings SET wiki_node_token=?,docx_document_id=?,document_url=?,
        library_id=?,space_id=?,parent_wiki_node_token=?,last_moved_at=?,updated_at=? WHERE id=? AND owner_id=?`).run(
        document.wikiNodeToken, document.documentId, document.documentUrl, projection.library.id,
        connection.space_id, libraryBinding.wiki_node_token, iso(this.nowMs()), iso(this.nowMs()), binding.id, ownerId,
      );
    } else if (binding.parent_wiki_node_token !== libraryBinding.wiki_node_token || binding.space_id !== connection.space_id) {
      await this.apiRequest(ownerId, `wiki/v2/spaces/${connection.space_id}/nodes/${binding.wiki_node_token}/move`, {
        method: "POST",
        body: JSON.stringify({ target_parent_token: libraryBinding.wiki_node_token }),
      });
      this.db.prepare(`UPDATE feishu_document_bindings SET library_id=?,space_id=?,parent_wiki_node_token=?,
        last_moved_at=?,updated_at=? WHERE id=? AND owner_id=?`).run(
        projection.library.id, connection.space_id, libraryBinding.wiki_node_token,
        iso(this.nowMs()), iso(this.nowMs()), binding.id, ownerId,
      );
    } else if (binding.library_id !== projection.library.id) {
      this.db.prepare("UPDATE feishu_document_bindings SET library_id=?,updated_at=? WHERE id=? AND owner_id=?")
        .run(projection.library.id, iso(this.nowMs()), binding.id, ownerId);
    }
    return this.db.prepare("SELECT * FROM feishu_document_bindings WHERE id=? AND owner_id=?").get(binding.id, ownerId);
  }

  async listRootChildren(ownerId, documentId) {
    const result = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "500" });
      if (pageToken) query.set("page_token", pageToken);
      const payload = await this.apiRequest(ownerId, `docx/v1/documents/${documentId}/blocks/${documentId}/children?${query}`);
      const data = payload.data || payload;
      result.push(...(data.items || data.children || []));
      pageToken = data.has_more || data.hasMore ? (data.page_token || data.pageToken || "") : "";
    } while (pageToken);
    return result;
  }

  async createChildren(ownerId, documentId, blocks, index = 0) {
    const created = [];
    let position = index;
    for (let offset = 0; offset < blocks.length; offset += 50) {
      const children = blocks.slice(offset, offset + 50);
      const payload = await this.apiRequest(ownerId, `docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
        method: "POST", body: JSON.stringify({ index: position, children: children.map(feishuBlockPayload) }),
      });
      const values = payload.data?.children || payload.data?.items || payload.children || [];
      created.push(...values);
      position += children.length;
    }
    return created;
  }

  async prepareCoverImage(source) {
    const imageUrl = new URL(String(source || ""), this.publicBaseUrl || undefined);
    if (!["http:", "https:"].includes(imageUrl.protocol)) return null;
    const response = await this.assetFetchImpl(imageUrl, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) throw integrationError(502, "FEISHU_COVER_FETCH_FAILED", `Cover image returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw integrationError(422, "FEISHU_COVER_SIZE_INVALID", "Cover image is empty or exceeds 20 MB");
    const contentType = String(response.headers.get("content-type") || "image/jpeg").split(";", 1)[0];
    if (!contentType.startsWith("image/")) throw integrationError(422, "FEISHU_COVER_TYPE_INVALID", "Cover URL did not return an image");
    const extension = ({ "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[contentType] || "jpg";
    const fileName = `inspiration-cover-${sha256(source).slice(0, 12)}.${extension}`;
    const dimensions = imageDimensions(bytes);
    if (!dimensions.width || !dimensions.height) throw integrationError(422, "FEISHU_COVER_DIMENSIONS_INVALID", "Cover image dimensions could not be read");
    return { bytes, contentType, fileName, ...dimensions };
  }

  async uploadCoverImage(ownerId, documentId, imageBlockId, prepared) {
    const token = await this.uploadMedia(ownerId, prepared, {
      parentType: "docx_image",
      parentNode: imageBlockId,
      extra: { drive_route_token: documentId },
    });
    await this.apiRequest(ownerId, `docx/v1/documents/${documentId}/blocks/${imageBlockId}?document_revision_id=-1`, {
      method: "PATCH",
      body: JSON.stringify({ replace_image: { token, width: prepared.width, height: prepared.height } }),
    });
    return token;
  }

  async uploadMedia(ownerId, prepared, { parentType, parentNode, extra = null } = {}) {
    const body = new FormData();
    body.set("file_name", prepared.fileName);
    if (parentType) body.set("parent_type", parentType);
    if (parentNode) body.set("parent_node", parentNode);
    body.set("size", String(prepared.bytes.byteLength));
    if (extra) body.set("extra", JSON.stringify(extra));
    body.set("file", new Blob([prepared.bytes], { type: prepared.contentType }), prepared.fileName);
    const payload = await this.apiRequest(ownerId, "drive/v1/medias/upload_all", { method: "POST", body });
    const token = payload.data?.file_token || payload.data?.fileToken || payload.file_token || payload.fileToken || "";
    if (!token) throw integrationError(502, "FEISHU_COVER_UPLOAD_INVALID", "Feishu did not return the uploaded cover token");
    return token;
  }

  async downloadMedia(ownerId, fileToken, { documentId = "", retry401 = true } = {}) {
    const token = String(fileToken || "").trim();
    if (!token) return null;
    let connection = await this.refreshConnection(ownerId);
    let accessToken = this.secretBox().decrypt(connection.access_token_ciphertext);
    const query = new URLSearchParams();
    if (documentId) query.set("extra", JSON.stringify({ drive_route_token: documentId }));
    const suffix = query.toString() ? `?${query}` : "";
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/drive/v1/medias/${encodeURIComponent(token)}/download${suffix}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw integrationError(504, "FEISHU_MEDIA_DOWNLOAD_TIMEOUT", "Feishu media download timed out", { upstream: error.message });
    }
    if (response.status === 401 && retry401) {
      connection = await this.refreshConnection(ownerId, { force: true });
      accessToken = this.secretBox().decrypt(connection.access_token_ciphertext);
      return this.downloadMedia(ownerId, fileToken, { documentId, retry401: false, accessToken });
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw integrationError(response.status || 502, `FEISHU_MEDIA_DOWNLOAD_FAILED_${response.status || "ERROR"}`, "Feishu media download failed", { upstream: raw.slice(0, 500) });
    }
    const contentType = String(response.headers.get("content-type") || "image/jpeg").split(";", 1)[0];
    if (!contentType.startsWith("image/")) {
      const raw = await response.text().catch(() => "");
      throw integrationError(422, "FEISHU_MEDIA_TYPE_INVALID", "Downloaded Feishu media is not an image", { upstream: raw.slice(0, 500) });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw integrationError(422, "FEISHU_MEDIA_SIZE_INVALID", "Downloaded Feishu image is empty or exceeds 20 MB");
    const dimensions = imageDimensions(bytes);
    if (!dimensions.width || !dimensions.height) throw integrationError(422, "FEISHU_MEDIA_DIMENSIONS_INVALID", "Downloaded Feishu image dimensions could not be read");
    const extension = ({ "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[contentType] || "jpg";
    return { bytes, contentType, fileName: `feishu-doc-cover-${sha256(token).slice(0, 12)}.${extension}`, ...dimensions };
  }

  async findDocumentCoverToken(ownerId, documentId) {
    if (!documentId) return "";
    const children = await this.listRootChildren(ownerId, documentId);
    for (const item of children) {
      const image = item?.image || item?.img || item?.picture || null;
      const token = image?.token || image?.file_token || image?.fileToken || item?.token || item?.file_token || item?.fileToken || "";
      if (token) return token;
    }
    return "";
  }

  async writeDocument(ownerId, documentId, projection, sectionState = {}) {
    let preparedCover = null;
    if (projection.thumbnail) {
      try {
        preparedCover = await this.prepareCoverImage(projection.thumbnail);
      } catch (error) {
        console.warn("Feishu cover fetch skipped", error?.code || error?.message || error);
      }
    }
    const managed = projectionBlocks(projection, { includeCover: Boolean(preparedCover) });
    async function attachCover(integration, created, blocks) {
      if (!preparedCover) return;
      const imageIndex = blocks.findIndex(block => block.block_type === BLOCK_TYPES.image);
      const imageBlock = imageIndex >= 0 ? created[imageIndex] : null;
      const imageBlockId = imageBlock?.block_id || imageBlock?.blockId;
      if (!imageBlockId) throw integrationError(502, "FEISHU_IMAGE_BLOCK_INVALID", "Feishu did not return the image block ID");
      return integration.uploadCoverImage(ownerId, documentId, imageBlockId, preparedCover);
    }
    async function attachMarkdownImages(integration, created, blocks) {
      for (const [index, block] of blocks.entries()) {
        if (!block.__imageSource) continue;
        const imageBlock = created[index];
        const imageBlockId = imageBlock?.block_id || imageBlock?.blockId;
        if (!imageBlockId) continue;
        try {
          const prepared = await integration.prepareCoverImage(block.__imageSource);
          await integration.uploadCoverImage(ownerId, documentId, imageBlockId, prepared);
        } catch (error) {
          console.warn("Feishu article image upload skipped", block.__imageSource, error?.code || error?.message || error);
        }
      }
    }
    const supplement = docBlock("heading1", "我的飞书补充");
    if (!sectionState.supplementHeadingBlockId) {
      const allBlocks = [...managed, supplement];
      const created = await this.createChildren(ownerId, documentId, allBlocks, 0);
      const coverFileToken = await attachCover(this, created, allBlocks);
      await attachMarkdownImages(this, created, allBlocks);
      const marker = created[managed.length];
      const markerId = marker?.block_id || marker?.blockId;
      if (!markerId) throw integrationError(502, "FEISHU_SUPPLEMENT_MARKER_INVALID", "Feishu did not return the supplement marker block ID");
      return { supplementHeadingBlockId: markerId, coverFileToken };
    }
    const children = await this.listRootChildren(ownerId, documentId);
    const markerIndex = children.findIndex(item => (item.block_id || item.blockId) === sectionState.supplementHeadingBlockId);
    if (markerIndex < 0) {
      throw integrationError(409, "FEISHU_SUPPLEMENT_MARKER_MISSING", "The protected Feishu supplement section was moved or deleted; confirm recreation before retrying");
    }
    if (markerIndex > 0) {
      await this.apiRequest(ownerId, `docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_delete`, {
        method: "DELETE", body: JSON.stringify({ start_index: 0, end_index: markerIndex }),
      });
    }
    const created = await this.createChildren(ownerId, documentId, managed, 0);
    const coverFileToken = await attachCover(this, created, managed);
    await attachMarkdownImages(this, created, managed);
    return { supplementHeadingBlockId: sectionState.supplementHeadingBlockId, coverFileToken };
  }

  async syncProjection(ownerId, inspirationId) {
    let connection = this.requireConnection(ownerId);
    this.ensureInspirationLibrary(ownerId, inspirationId);
    const projection = this.buildProjection(ownerId, inspirationId);
    let binding = this.ensureBinding(ownerId, connection.id, inspirationId, { syncStatus: "syncing" });
    connection = await this.ensureIndex(ownerId, connection);
    const library = this.db.prepare("SELECT id,name FROM inspiration_libraries WHERE id=? AND owner_id=? AND deleted_at IS NULL")
      .get(projection.library.id, ownerId);
    if (!library) throw integrationError(409, "INSPIRATION_LIBRARY_MISSING", "The inspiration library no longer exists");
    if (binding.library_id && binding.library_id !== projection.library.id) await this.removeLibraryIndexRecord(ownerId, connection, binding);
    let libraryBinding = await this.ensureLibraryNode(ownerId, connection, library);
    libraryBinding = await this.ensureLibraryIndex(ownerId, connection, library, libraryBinding);
    await this.refreshLibraryHub(ownerId, connection, library, libraryBinding);
    binding = await this.ensureDocumentPlacement(ownerId, connection, binding, libraryBinding, projection);
    const indexProjection = await this.enrichProjectionFromDocument(ownerId, binding, projection);
    if (binding.source_hash === projection.sourceHash && binding.sync_status === "synced") {
      const recordId = await this.ensureIndexRecord(ownerId, connection, binding, indexProjection, binding.document_url || "", "");
      if (recordId !== binding.bitable_record_id) {
        this.db.prepare("UPDATE feishu_document_bindings SET bitable_record_id=?,updated_at=? WHERE id=? AND owner_id=?")
          .run(recordId, iso(this.nowMs()), binding.id, ownerId);
      }
      const libraryRecordId = await this.ensureLibraryIndexRecord(ownerId, connection, binding, indexProjection, libraryBinding, binding.document_url || "", "");
      if (libraryRecordId && libraryRecordId !== binding.library_bitable_record_id) {
        this.db.prepare("UPDATE feishu_document_bindings SET library_bitable_record_id=?,updated_at=? WHERE id=? AND owner_id=?")
          .run(libraryRecordId, iso(this.nowMs()), binding.id, ownerId);
        binding = this.db.prepare("SELECT * FROM feishu_document_bindings WHERE id=? AND owner_id=?").get(binding.id, ownerId);
      }
      await this.ensureClueRecords(ownerId, connection, indexProjection, binding.document_url || "");
      await this.cleanupLibraryDirectories(ownerId);
      return { skipped: true, sourceHash: projection.sourceHash, documentUrl: binding.document_url, clues: projection.clues?.length || 0, libraryTableId: libraryBinding.library_bitable_table_id };
    }
    const recordId = await this.ensureIndexRecord(ownerId, connection, binding, indexProjection, binding.document_url || "");
    this.db.prepare("UPDATE feishu_document_bindings SET bitable_record_id=?,updated_at=? WHERE id=? AND owner_id=?")
      .run(recordId, iso(this.nowMs()), binding.id, ownerId);
    binding = this.db.prepare("SELECT * FROM feishu_document_bindings WHERE id=? AND owner_id=?").get(binding.id, ownerId);
    const sectionState = await this.writeDocument(ownerId, binding.docx_document_id, projection, parseJson(binding.section_blocks_json, {}));
    this.db.prepare(`UPDATE feishu_document_bindings SET section_blocks_json=?,source_hash=?,sync_status='synced',
      last_error_code=NULL,last_error_message=NULL,last_error_details_json=NULL,last_synced_at=?,updated_at=? WHERE id=? AND owner_id=?`).run(
      JSON.stringify(sectionState), projection.sourceHash, iso(this.nowMs()), iso(this.nowMs()), binding.id, ownerId,
    );
    binding = this.db.prepare("SELECT * FROM feishu_document_bindings WHERE id=? AND owner_id=?").get(binding.id, ownerId);
    await this.ensureIndexRecord(ownerId, connection, binding, projection, binding.document_url || "", "");
    const libraryRecordId = await this.ensureLibraryIndexRecord(ownerId, connection, binding, projection, libraryBinding, binding.document_url || "", "");
    if (libraryRecordId && libraryRecordId !== binding.library_bitable_record_id) {
      this.db.prepare("UPDATE feishu_document_bindings SET library_bitable_record_id=?,updated_at=? WHERE id=? AND owner_id=?")
        .run(libraryRecordId, iso(this.nowMs()), binding.id, ownerId);
    }
    await this.ensureClueRecords(ownerId, connection, projection, binding.document_url || "");
    await this.cleanupLibraryDirectories(ownerId);
    return { skipped: false, sourceHash: projection.sourceHash, documentUrl: binding.document_url, clues: projection.clues?.length || 0, libraryTableId: libraryBinding.library_bitable_table_id };
  }

  async backfillLibraryIndexes({ ownerId = null, limit = 200 } = {}) {
    const connectionRows = this.db.prepare(`SELECT * FROM feishu_connections
      WHERE status='connected' AND space_id IS NOT NULL ${ownerId ? "AND owner_id=?" : ""}
      ORDER BY updated_at DESC`).all(...(ownerId ? [ownerId] : []));
    let upserted = 0;
    for (let connection of connectionRows) {
      await this.withConnectionLock(connection.id, async () => {
        connection = await this.ensureIndex(connection.owner_id, connection);
        const rows = this.db.prepare(`SELECT b.*,a.library_id,l.name AS library_name FROM feishu_document_bindings b
          JOIN inspiration_library_assignments a ON a.inspiration_id=b.inspiration_id AND a.owner_id=b.owner_id
          JOIN inspiration_libraries l ON l.id=a.library_id AND l.owner_id=a.owner_id AND l.deleted_at IS NULL
          WHERE b.owner_id=? AND b.sync_status='synced' AND COALESCE(b.document_url,'')<>''
          ORDER BY COALESCE(b.last_synced_at,b.updated_at) DESC LIMIT ?`).all(connection.owner_id, Math.max(1, Math.min(1000, Number(limit) || 200)));
        for (let binding of rows) {
          const projection = this.buildProjection(connection.owner_id, binding.inspiration_id);
          const indexProjection = await this.enrichProjectionFromDocument(connection.owner_id, binding, projection);
          const library = { id: binding.library_id || projection.library.id, name: binding.library_name || projection.library.name };
          let libraryBinding = await this.ensureLibraryNode(connection.owner_id, connection, library);
          libraryBinding = await this.ensureLibraryIndex(connection.owner_id, connection, library, libraryBinding);
          await this.refreshLibraryHub(connection.owner_id, connection, library, libraryBinding);
          const recordId = await this.ensureLibraryIndexRecord(connection.owner_id, connection, binding, indexProjection, libraryBinding, binding.document_url || "");
          if (recordId) {
            this.db.prepare("UPDATE feishu_document_bindings SET library_bitable_record_id=?,updated_at=? WHERE id=? AND owner_id=?")
              .run(recordId, iso(this.nowMs()), binding.id, connection.owner_id);
            upserted += 1;
          }
        }
      });
    }
    return { upserted };
  }

  async cleanupLibraryDirectories(ownerId) {
    const connection = this.connectionRow(ownerId);
    if (!connection?.space_id || connection.status !== "connected") return { cleaned: 0 };
    const rows = this.db.prepare(`SELECT fb.* FROM feishu_library_bindings fb
      JOIN inspiration_libraries l ON l.id=fb.library_id AND l.owner_id=fb.owner_id
      WHERE fb.owner_id=? AND fb.connection_id=? AND l.deleted_at IS NOT NULL
        AND fb.status NOT IN ('deleted','deleting')`).all(ownerId, connection.id);
    let cleaned = 0;
    for (const row of rows) {
      const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM feishu_document_bindings
        WHERE owner_id=? AND library_id=? AND parent_wiki_node_token=?`).get(ownerId, row.library_id, row.wiki_node_token).count;
      if (remaining) continue;
      this.db.prepare("UPDATE feishu_library_bindings SET status='deleting',updated_at=? WHERE id=? AND owner_id=?")
        .run(iso(this.nowMs()), row.id, ownerId);
      try {
        await this.apiRequest(ownerId, `wiki/v2/spaces/${row.space_id}/nodes/${row.wiki_node_token}`, { method: "DELETE" });
        if (connection.bitable_app_token && row.library_bitable_table_id) {
          await this.apiRequest(ownerId, `bitable/v1/apps/${connection.bitable_app_token}/tables/${row.library_bitable_table_id}`, { method: "DELETE" }).catch(error => {
            console.warn("Feishu deleted library Bitable cleanup skipped", error?.code || error?.message || error);
          });
        }
        this.db.prepare(`UPDATE feishu_library_bindings SET status='deleted',last_error_code=NULL,
          last_error_message=NULL,updated_at=? WHERE id=? AND owner_id=?`).run(iso(this.nowMs()), row.id, ownerId);
        cleaned += 1;
      } catch (error) {
        this.db.prepare(`UPDATE feishu_library_bindings SET status='failed',last_error_code=?,
          last_error_message=?,updated_at=? WHERE id=? AND owner_id=?`).run(
          String(error.code || "FEISHU_LIBRARY_DELETE_FAILED"), String(error.message || "").slice(0, 1000),
          iso(this.nowMs()), row.id, ownerId,
        );
        throw error;
      }
    }
    return { cleaned };
  }

  startWorker({ intervalMs = 2000 } = {}) {
    if (this.timer || !this.configured) return () => this.stopWorker();
    this.timer = setInterval(async () => {
      if (this.processing) return;
      this.processing = true;
      try { await this.processNextOutbox(); }
      catch (error) { console.error("Feishu worker failed", error); }
      finally { this.processing = false; }
    }, Math.max(250, Number(intervalMs) || 2000));
    this.timer.unref?.();
    return () => this.stopWorker();
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createFeishuIntegration(input, options = {}) {
  return input?.db ? new FeishuIntegration(input) : new FeishuIntegration(input, options);
}
