import { createHash, randomUUID } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";

export function normalizeText(value = "") {
  return String(value).normalize("NFC").replace(/\r\n?/g, "\n");
}

export function sha256Text(value = "") {
  return createHash("sha256").update(normalizeText(value)).digest("hex");
}

function nodeText(node) {
  if (!node) return "";
  if (node.type === "image") return node.alt || node.title || "";
  if (typeof node.value === "string") return node.value;
  return (node.children || []).map(nodeText).join("");
}

function nodeImages(node) {
  if (!node) return [];
  if (node.type === "image" && node.url) return [node];
  return (node.children || []).flatMap(nodeImages);
}

function stableBlockId(type, text, occurrence, extra = "") {
  const digest = createHash("sha1").update(`${type}\0${normalizeText(text)}\0${extra}`).digest("hex").slice(0, 14);
  return `block_${digest}_${occurrence}`;
}

export function buildBlocks(markdown = "") {
  const normalized = normalizeText(markdown);
  const tree = fromMarkdown(normalized);
  const counts = new Map();
  const blocks = [];
  for (const node of tree.children || []) {
    const images = nodeImages(node);
    if (images.length && (!nodeText(node).trim() || node.children?.every(child => child.type === "image" || child.type === "break"))) {
      for (const image of images) {
        const text = normalizeText(image.alt || image.title || "文章图片").trim();
        const key = `image\0${image.url}\0${text}`;
        const occurrence = (counts.get(key) || 0) + 1;
        counts.set(key, occurrence);
        blocks.push({
          id: stableBlockId("image", text, occurrence, image.url),
          type: "image",
          text,
          url: image.url,
          alt: text,
          title: image.title || "",
          order: blocks.length,
          source: image.position ? {
            start: { line: image.position.start.line, column: image.position.start.column, offset: image.position.start.offset },
            end: { line: image.position.end.line, column: image.position.end.column, offset: image.position.end.offset }
          } : null
        });
      }
      continue;
    }
    const text = normalizeText(nodeText(node)).trim();
    if (!text && node.type !== "thematicBreak") continue;
    const key = `${node.type}\0${text}`;
    const occurrence = (counts.get(key) || 0) + 1;
    counts.set(key, occurrence);
    blocks.push({
      id: stableBlockId(node.type, text, occurrence),
      type: node.type,
      text,
      order: blocks.length,
      source: node.position ? {
        start: { line: node.position.start.line, column: node.position.start.column, offset: node.position.start.offset },
        end: { line: node.position.end.line, column: node.position.end.column, offset: node.position.end.offset }
      } : null
    });
  }
  return blocks;
}

function excerpt(text, index, direction, length = 32) {
  return direction < 0 ? text.slice(Math.max(0, index - length), index) : text.slice(index, index + length);
}

export function buildAnchor({ blockId, blockText, start, end, sourceDocumentSha256 }) {
  const text = normalizeText(blockText);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
    throw Object.assign(new Error("选区位置无效"), { status: 422, code: "INVALID_ANCHOR_RANGE" });
  }
  const exact = text.slice(start, end);
  return {
    schema: 1,
    blockId: String(blockId || ""),
    position: { start, end, unit: "utf16" },
    quote: { exact, prefix: excerpt(text, start, -1), suffix: excerpt(text, end, 1) },
    normalizedQuote: normalizeText(exact).replace(/\s+/g, " ").trim(),
    sourceDocumentSha256: String(sourceDocumentSha256 || "")
  };
}

export function validateAnchor(anchor, { requireDocumentHash = true } = {}) {
  if (!anchor || anchor.schema !== 1 || typeof anchor.blockId !== "string" || !anchor.blockId) return false;
  const position = anchor.position;
  const quote = anchor.quote;
  if (!position || position.unit !== "utf16" || !Number.isInteger(position.start) || !Number.isInteger(position.end) || position.start < 0 || position.end <= position.start) return false;
  if (!quote || typeof quote.exact !== "string" || !quote.exact || typeof quote.prefix !== "string" || typeof quote.suffix !== "string") return false;
  if (requireDocumentHash && !/^[a-f0-9]{64}$/.test(String(anchor.sourceDocumentSha256 || ""))) return false;
  return true;
}

function occurrences(haystack, needle) {
  const found = [];
  let at = 0;
  while (needle && (at = haystack.indexOf(needle, at)) >= 0) { found.push(at); at += Math.max(1, needle.length); }
  return found;
}

export function reanchorQuote(anchor, blocks, sourceDocumentSha256) {
  if (!validateAnchor(anchor, { requireDocumentHash: false })) return { status: "orphaned", strategy: "invalid_anchor", confidence: 0, anchor: null };
  const exact = normalizeText(anchor.quote.exact);
  const candidates = [];
  for (const block of blocks || []) {
    const text = normalizeText(block.text);
    for (const start of occurrences(text, exact)) {
      const end = start + exact.length;
      let score = 0.65;
      if (block.id === anchor.blockId) score += 0.2;
      if (anchor.quote.prefix && text.slice(Math.max(0, start - anchor.quote.prefix.length), start) === anchor.quote.prefix) score += 0.075;
      if (anchor.quote.suffix && text.slice(end, end + anchor.quote.suffix.length) === anchor.quote.suffix) score += 0.075;
      candidates.push({ block, start, end, score: Math.min(1, score) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) return { status: "orphaned", strategy: candidates.length ? "ambiguous_quote" : "quote_not_found", confidence: candidates[0]?.score || 0, anchor: null };
  const match = candidates[0];
  if (candidates.length === 1) match.score = Math.max(match.score, 0.9);
  const migrated = buildAnchor({ blockId: match.block.id, blockText: match.block.text, start: match.start, end: match.end, sourceDocumentSha256 });
  return { status: match.score >= 0.85 ? "active" : "orphaned", strategy: match.block.id === anchor.blockId ? "block_quote_context" : "document_quote_context", confidence: match.score, anchor: match.score >= 0.85 ? migrated : null };
}

export function splitSelectionAnchors(selections, sourceDocumentSha256) {
  const groupId = randomUUID();
  return (selections || []).map(selection => ({ groupId, anchor: buildAnchor({ ...selection, sourceDocumentSha256 }) }));
}

export const createAnchor = buildAnchor;
export const resolveAnchor = reanchorQuote;
export const reanchorAnchor = reanchorQuote;
