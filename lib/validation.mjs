const ALLOWED_NODES = new Set(["doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem", "blockquote", "hardBreak", "horizontalRule"]);
const ALLOWED_MARKS = new Set(["bold", "italic", "underline", "highlight", "link"]);

export function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

export function limitedString(value, name, max, { required = false } = {}) {
  const result = String(value ?? "");
  if (required && !result.trim()) throw httpError(422, `${name.toUpperCase()}_REQUIRED`, `${name}不能为空`);
  if (result.length > max) throw httpError(413, `${name.toUpperCase()}_TOO_LONG`, `${name}超过长度限制`, { max });
  return result;
}

export function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw httpError(422, `INVALID_${name.toUpperCase()}`, `${name}取值无效`, { allowed });
  return value;
}

export function validateEditorDocument(document) {
  let nodes = 0;
  let textLength = 0;
  function visit(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 30 || !ALLOWED_NODES.has(node.type)) throw httpError(422, "INVALID_DOCUMENT", "加工稿包含不支持的内容节点");
    nodes += 1;
    if (nodes > 20_000) throw httpError(413, "DOCUMENT_TOO_LARGE", "加工稿节点过多");
    if (node.type === "text") {
      if (typeof node.text !== "string") throw httpError(422, "INVALID_DOCUMENT", "文本节点格式无效");
      textLength += node.text.length;
      for (const mark of node.marks || []) {
        if (!ALLOWED_MARKS.has(mark?.type)) throw httpError(422, "INVALID_DOCUMENT", "加工稿包含不支持的格式");
        if (mark.type === "link") {
          const href = String(mark.attrs?.href || "");
          if (!/^https?:\/\//i.test(href)) throw httpError(422, "INVALID_LINK", "链接只支持 HTTP/HTTPS");
        }
      }
    }
    for (const child of node.content || []) visit(child, depth + 1);
  }
  visit(document);
  if (document.type !== "doc") throw httpError(422, "INVALID_DOCUMENT", "加工稿根节点必须是 doc");
  if (textLength > 500_000) throw httpError(413, "DOCUMENT_TOO_LARGE", "加工稿文字过长");
  return document;
}

export function editorPlainText(document) {
  const chunks = [];
  function visit(node) {
    if (node.type === "text") chunks.push(node.text || "");
    for (const child of node.content || []) visit(child);
    if (["paragraph", "heading", "blockquote", "listItem"].includes(node.type)) chunks.push("\n");
  }
  visit(document);
  return chunks.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function sanitizeMarkdown(value = "") {
  return String(value)
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/<\/?(?:script|style|iframe|object|embed|svg|math)\b[^>]*>/gi, "")
    .replace(/<[^>]+\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, "")
    .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, "](about:blank)");
}

export const validatePersonalDocument = validateEditorDocument;
