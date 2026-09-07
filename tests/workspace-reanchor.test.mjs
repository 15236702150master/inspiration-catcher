import test from "node:test";
import assert from "node:assert/strict";
import { importPlanned } from "./helpers/planned-module.mjs";

const apiPromise = importPlanned("lib/transcript-workspace.mjs", [
  "buildBlocks",
  "buildAnchor",
  "sha256Text",
  "normalizeText",
  "reanchorQuote",
]);

async function anchorFor(text, blockIndex, exact) {
  const api = await apiPromise;
  const blocks = api.buildBlocks(text);
  const block = blocks[blockIndex];
  const start = block.text.indexOf(exact);
  return {
    blocks,
    anchor: api.buildAnchor({
      blockId: block.id,
      blockText: block.text,
      start,
      end: start + exact.length,
      sourceDocumentSha256: api.sha256Text(api.normalizeText(text)),
    }),
  };
}

test("reanchor keeps a unique quote canonical after surrounding layout changes", async () => {
  const { reanchorQuote, buildBlocks } = await apiPromise;
  const source = "开场。\n\n真正重要的是建立反馈回路。\n\n结尾。";
  const { anchor } = await anchorFor(source, 1, "建立反馈回路");
  const target = buildBlocks("# 新标题\n\n开场被改写。\n\n真正重要的是：建立反馈回路。\n\n结尾补充。 ");
  const result = reanchorQuote(anchor, target, "a".repeat(64));
  assert.equal(result.status, "active");
  assert.ok(result.confidence >= 0.9);
  assert.equal(result.anchor.quote.exact, "建立反馈回路");
});

test("duplicate Chinese quotes never silently attach to the wrong occurrence", async () => {
  const { reanchorQuote, buildBlocks } = await apiPromise;
  const source = "甲段前文：同一句会出现。甲段后文。\n\n乙段前文：同一句会出现。乙段后文。";
  const { anchor } = await anchorFor(source, 1, "同一句会出现");
  const ambiguous = buildBlocks("第一处：同一句会出现。\n\n第二处：同一句会出现。");
  const result = reanchorQuote(anchor, ambiguous, "b".repeat(64));
  assert.equal(result.status, "orphaned");
  assert.equal(result.strategy, "ambiguous_quote");
});

test("missing quote becomes orphaned and retains the original anchor", async () => {
  const { reanchorQuote, buildBlocks } = await apiPromise;
  const source = "需要保留的原句。";
  const { anchor } = await anchorFor(source, 0, "保留的原句");
  const frozen = structuredClone(anchor);
  const result = reanchorQuote(anchor, buildBlocks("AI 完全改写了这一部分。"), "c".repeat(64));
  assert.equal(result.status, "orphaned");
  assert.equal(result.anchor, null);
  assert.deepEqual(anchor, frozen, "reanchoring must not mutate the persisted original anchor");
});
