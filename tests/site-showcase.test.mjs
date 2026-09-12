import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

test("static showcase wires each rail item to one visible view", async () => {
  const html = await source("site/index.html");
  const panels = [...html.matchAll(/data-view-panel="([^"]+)"/g)].map(match => match[1]);
  const controls = [...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(panels, ["capture", "library", "lab"]);
  assert.deepEqual(controls, panels);
  for (const id of ["capture-view", "library-view", "lab-view", "library-card", "lab-empty", "reset-demo"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-controls="breakdown-panel"/);
  assert.match(html, /aria-controls="cases-panel"/);
});

test("static showcase supports validation, saving, reset, and keyboard result tabs", async () => {
  const script = await source("site/app.js");
  assert.match(script, /new URL\(value\)/);
  assert.match(script, /请输入有效的 http\(s\) 链接/);
  assert.match(script, /savedExample =/);
  assert.match(script, /function resetDemo\(\)/);
  assert.match(script, /ArrowRight/);
  assert.match(script, /parsed = false;/);
});

test("showcase README and page images are present", async () => {
  const readme = await source("README.md");
  for (const image of [
    "overview-desktop.png",
    "workflow-desktop.png",
    "library-desktop.png",
    "connectors-desktop.png",
    "overview-mobile.png",
  ]) {
    await access(resolve(root, "docs/images", image));
    assert.match(readme, new RegExp(`docs/images/${image}`));
    await access(resolve(root, "site/images", image));
  }
});

test("WeChat video resolver is configurable for public deployments", async () => {
  const server = await source("server.mjs");
  const envExample = await source(".env.example");
  assert.match(server, /process\.env\.WECHAT_RESOLVER_URL/);
  assert.match(server, /-EncodedCommand/);
  assert.match(server, /encodedResolver/);
  assert.match(envExample, /^WECHAT_RESOLVER_URL=/m);
});
