import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

function normalizeText(value = "") {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fallbackTitle(filename = "") {
  return String(filename || "上传文章")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .slice(0, 200) || "上传文章";
}

function markdownFromPlainText(value = "") {
  const text = normalizeText(value);
  return text.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean).join("\n\n");
}

function extnameLower(filename = "") {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

export async function extractDocumentFile({ buffer, filename = "", contentType = "" } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!bytes.length) throw Object.assign(new Error("上传文件为空"), { status: 422, code: "DOCUMENT_EMPTY" });
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw Object.assign(new Error("文件超过 25MB，请先压缩或拆分"), { status: 413, code: "DOCUMENT_TOO_LARGE" });
  const extension = extnameLower(filename);
  const type = String(contentType || "").toLowerCase();
  if (extension === ".docx" || type.includes("wordprocessingml.document")) {
    const result = await mammoth.convertToMarkdown({ buffer: bytes });
    const markdown = normalizeText(result.value || "");
    if (!markdown) throw Object.assign(new Error("没有从 Word 文档中提取到正文"), { status: 422, code: "DOCUMENT_CONTENT_EMPTY" });
    const plainText = normalizeText(markdown.replace(/!\[[^\]]*]\([^)]+\)/g, "[图片]").replace(/[#*_`>~-]/g, ""));
    return {
      kind: "docx",
      platform: "uploaded_docx",
      title: fallbackTitle(filename),
      filename,
      markdown,
      plainText,
      pageCount: 0,
      warnings: (result.messages || []).map(item => item.message || String(item)).filter(Boolean),
    };
  }
  if (extension === ".pdf" || type.includes("pdf")) {
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      const plainText = normalizeText(result.text || "");
      if (!plainText) throw Object.assign(new Error("没有从 PDF 中提取到可复制正文，可能是扫描版"), { status: 422, code: "PDF_TEXT_EMPTY" });
      return {
        kind: "pdf",
        platform: "uploaded_pdf",
        title: fallbackTitle(filename),
        filename,
        markdown: markdownFromPlainText(plainText),
        plainText,
        pageCount: Number(result.total || result.pages?.length || 0),
        warnings: [],
      };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  throw Object.assign(new Error("暂时只支持 .docx 和 .pdf 文件"), { status: 415, code: "DOCUMENT_TYPE_UNSUPPORTED" });
}

export { MAX_DOCUMENT_BYTES };
