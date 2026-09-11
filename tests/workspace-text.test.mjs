import test from "node:test";
import assert from "node:assert/strict";
import { importPlanned } from "./helpers/planned-module.mjs";

const apiPromise = importPlanned("lib/transcript-workspace.mjs", [
  "normalizeText",
  "sha256Text",
  "buildBlocks",
  "buildAnchor",
  "validateAnchor",
  "reanchorQuote",
]);

test("normalization uses NFC and LF without changing meaningful Chinese whitespace", async () => {
  const { normalizeText } = await apiPromise;
  const decomposed = "Cafe\u0301\r\n中文　保留\r末尾";
  assert.equal(normalizeText(decomposed), "Café\n中文　保留\n末尾");
});

test("normalization preserves emoji grapheme data and UTF-16 offsets", async () => {
  const { normalizeText } = await apiPromise;
  const value = "行动 👩🏽‍💻 再验证";
  const normalized = normalizeText(value);
  assert.equal(normalized, value);
  assert.equal(normalized.indexOf("再验证"), 11, "anchor positions must use browser-compatible UTF-16 units");
});

test("block IDs are deterministic and duplicate blocks receive distinct occurrence IDs", async () => {
  const { buildBlocks } = await apiPromise;
  const input = "重复的一句话。\n\n重复的一句话。\n\n最后一段。";
  const first = buildBlocks(input);
  const second = buildBlocks(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((block) => block.id)).size, 3);
  assert.equal(first[0].text, first[1].text);
  assert.notEqual(first[0].id, first[1].id);
});

test("markdown article images become stable image blocks", async () => {
  const { buildBlocks } = await apiPromise;
  const blocks = buildBlocks("第一段。\n\n![示意图](https://mmbiz.qpic.cn/demo.png?wx_fmt=png)\n\n最后一段。");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[1].url, "https://mmbiz.qpic.cn/demo.png?wx_fmt=png");
  assert.equal(blocks[1].alt, "示意图");
  assert.match(blocks[1].id, /^block_[a-f0-9]{14}_1$/);
});

test("same content produces the same document checksum", async () => {
  const { normalizeText, sha256Text } = await apiPromise;
  const crlf = "第一行\r\n第二行";
  const lf = "第一行\n第二行";
  assert.equal(sha256Text(normalizeText(crlf)), sha256Text(normalizeText(lf)));
  assert.match(sha256Text("内容"), /^[a-f0-9]{64}$/);
});

test("a Chinese and emoji selection round-trips through a composite anchor", async () => {
  const { buildBlocks, buildAnchor, validateAnchor, sha256Text, normalizeText } = await apiPromise;
  const input = "前文。\n\n这句包含 emoji 👩🏽‍💻 和中文重点。\n\n后文。";
  const blocks = buildBlocks(input);
  const block = blocks[1];
  const start = block.text.indexOf("emoji");
  const end = block.text.indexOf("。", start);
  const anchor = buildAnchor({
    blockId: block.id,
    blockText: block.text,
    start,
    end,
    sourceDocumentSha256: sha256Text(normalizeText(input)),
  });
  assert.equal(anchor.position.unit, "utf16");
  assert.equal(anchor.quote.exact, block.text.slice(start, end));
  assert.ok(anchor.quote.prefix.length <= 32);
  assert.ok(anchor.quote.suffix.length <= 32);
  assert.equal(validateAnchor(anchor), true);
});

test("cross-block selection is represented by one group with independently valid anchors", async () => {
  const { buildBlocks, buildAnchor, validateAnchor, sha256Text, normalizeText } = await apiPromise;
  const input = "第一段的结尾重点。\n\n第二段开头也是重点。";
  const blocks = buildBlocks(input);
  const checksum = sha256Text(normalizeText(input));
  const groupId = "selection-cross-block";
  const anchors = [
    { ...buildAnchor({ blockId: blocks[0].id, blockText: blocks[0].text, start: blocks[0].text.indexOf("结尾"), end: blocks[0].text.length, sourceDocumentSha256: checksum }), groupId },
    { ...buildAnchor({ blockId: blocks[1].id, blockText: blocks[1].text, start: 0, end: blocks[1].text.indexOf("也是") + 2, sourceDocumentSha256: checksum }), groupId },
  ];
  assert.equal(anchors.length, 2);
  assert.ok(anchors.every((anchor) => anchor.groupId === groupId));
  assert.ok(anchors.every((anchor) => validateAnchor(anchor)));
});
