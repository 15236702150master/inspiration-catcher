import Database from "better-sqlite3";
import { FeishuIntegration } from "../lib/feishu-integration.mjs";

const databasePath = process.env.DATABASE_PATH || new URL("../data/inspiration.sqlite3", import.meta.url).pathname;
const db = new Database(databasePath, { readonly: true });
const integration = new FeishuIntegration(db);
const keys = {
  2: "text",
  3: "heading1",
  4: "heading2",
  5: "heading3",
  6: "heading4",
  12: "bullet",
  13: "ordered",
  15: "quote",
  17: "todo",
  22: "divider",
  27: "image",
};

function blockSummary(block) {
  const type = Number(block.block_type ?? block.blockType);
  const key = keys[type] || `block_${type}`;
  const value = block[key] || {};
  const text = (value.elements || []).map(element => element.text_run?.content || "").join("");
  return {
    type,
    key,
    text: text.slice(0, 120),
    hasImage: type === 27 && Boolean(value.token || value.file_token || value.fileToken || (value.width && value.height)),
    ...(type === 27 ? {
      imageFields: Object.keys(value).sort(),
      tokenPresent: Boolean(value.token || value.file_token || value.fileToken),
      width: Number(value.width || 0),
      height: Number(value.height || 0),
    } : {}),
  };
}

try {
  const bindings = db.prepare(`SELECT owner_id,inspiration_id,docx_document_id,document_url,sync_status
    FROM feishu_document_bindings WHERE docx_document_id IS NOT NULL ORDER BY inspiration_id`).all();
  const output = [];
  for (const binding of bindings) {
    const blocks = await integration.listRootChildren(binding.owner_id, binding.docx_document_id);
    const summaries = blocks.map(blockSummary);
    const typeCounts = summaries.reduce((counts, item) => ({ ...counts, [item.key]: (counts[item.key] || 0) + 1 }), {});
    output.push({
      inspirationId: binding.inspiration_id,
      status: binding.sync_status,
      documentUrl: binding.document_url,
      blockCount: blocks.length,
      typeCounts,
      outline: summaries.filter(item => item.key === "heading1").map(item => item.text),
      subsectionCount: summaries.filter(item => item.key === "heading2").length,
      imageBlocks: summaries.filter(item => item.key === "image"),
      markdownLeaks: summaries.filter(item => /\*\*|^#{1,6}\s|^[-*]\s|\[[^\]]+\]\([^)]+\)/.test(item.text)).map(item => item.text),
      placeholderCount: summaries.filter(item => item.text.includes("暂无内容")).length,
    });
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  db.close();
}
