import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractDocumentFile } from "../lib/document-extractor.mjs";

async function sampleDocxBuffer(text = "Word 文档正文，可用于阅读标注。") {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
        <w:p><w:r><w:t>第二段内容。</w:t></w:r></w:p>
      </w:body>
    </w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function samplePdfBuffer(text = "PDF document text for annotation") {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  objects.push(`5 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("DOCX upload extractor returns markdown and plain text", async () => {
  const document = await extractDocumentFile({
    filename: "读书笔记.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await sampleDocxBuffer(),
  });
  assert.equal(document.kind, "docx");
  assert.equal(document.platform, "uploaded_docx");
  assert.equal(document.title, "读书笔记");
  assert.match(document.markdown, /Word 文档正文/);
  assert.match(document.plainText, /第二段内容/);
});

test("PDF upload extractor returns text", async () => {
  const document = await extractDocumentFile({
    filename: "paper.pdf",
    contentType: "application/pdf",
    buffer: samplePdfBuffer(),
  });
  assert.equal(document.kind, "pdf");
  assert.equal(document.platform, "uploaded_pdf");
  assert.equal(document.title, "paper");
  assert.match(document.plainText, /PDF document text for annotation/);
});
