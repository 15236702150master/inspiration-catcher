const ARTICLE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(value = "") {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function attr(tag, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = String(tag || "").match(pattern);
  return decodeEntities(match?.[2] || match?.[3] || match?.[4] || "");
}

function absoluteUrl(value, baseUrl) {
  const clean = decodeEntities(value || "").trim();
  if (!clean || clean.startsWith("data:")) return "";
  try { return new URL(clean, baseUrl).toString(); } catch { return clean; }
}

function firstMatch(source, patterns) {
  for (const pattern of patterns) {
    const match = String(source || "").match(pattern);
    const value = decodeEntities(match?.[1] || "").trim();
    if (value) return value;
  }
  return "";
}

function contentHtml(html) {
  const source = String(html || "");
  return firstMatch(source, [
    /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<script/i,
    /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ]) || source;
}

function normalizeMarkdown(value = "") {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .trim();
}

export function extractArticleHtml(html, { url = "" } = {}) {
  const source = String(html || "");
  const isWechat = /mp\.weixin\.qq\.com|id=["']js_content["']|var\s+msg_title|nickname/i.test(`${url}\n${source}`);
  const title = firstMatch(source, [
    /var\s+msg_title\s*=\s*['"]([^'"]+)['"]/i,
    /property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<h1[^>]+id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]).replace(/\s+/g, " ");
  const author = firstMatch(source, [
    /var\s+nickname\s*=\s*['"]([^'"]+)['"]/i,
    /id=["']js_name["'][^>]*>([\s\S]*?)<\/(?:a|span|strong|div)>/i,
    /property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /name=["']author["'][^>]+content=["']([^"']+)["']/i,
  ]).replace(/\s+/g, " ");
  const cover = absoluteUrl(firstMatch(source, [
    /var\s+msg_cdn_url\s*=\s*['"]([^'"]+)['"]/i,
    /property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  ]), url);
  let body = contentHtml(source)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  let imageIndex = 0;
  body = body.replace(/<img\b[^>]*>/gi, tag => {
    const imageUrl = absoluteUrl(attr(tag, "data-src") || attr(tag, "data-original") || attr(tag, "src"), url);
    if (!imageUrl) return "";
    imageIndex += 1;
    const alt = attr(tag, "alt") || `文章图片 ${imageIndex}`;
    return `\n\n![${alt.replace(/[[\]]/g, "")}](${imageUrl})\n\n`;
  });
  body = body
    .replace(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi, (_, level, text) => `\n\n${"#".repeat(Number(level.slice(1)))} ${decodeEntities(text.replace(/<[^>]+>/g, "")).trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|blockquote|li|ul|ol|table|tr)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00a0/g, " ");
  const markdown = normalizeMarkdown(decodeEntities(body));
  const plainText = normalizeMarkdown(markdown.replace(/!\[[^\]]*]\([^)]+\)/g, "[图片]").replace(/^#{1,6}\s+/gm, ""));
  return {
    platform: isWechat ? "wechat_article" : "article",
    title: title || "未命名文章",
    author,
    cover,
    url,
    markdown,
    plainText,
    imageCount: imageIndex,
  };
}

export async function fetchArticle(url, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const target = new URL(String(url || "").trim());
  const response = await fetchImpl(target, {
    headers: {
      "user-agent": ARTICLE_USER_AGENT,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "referer": target.origin,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`文章读取失败：HTTP ${response.status}`), { status: 502, code: "ARTICLE_FETCH_FAILED" });
  }
  const html = await response.text();
  const article = extractArticleHtml(html, { url: target.toString() });
  if (!article.plainText || article.plainText.length < 20) {
    throw Object.assign(new Error("没有从文章页面提取到足够正文"), { status: 422, code: "ARTICLE_CONTENT_EMPTY" });
  }
  return article;
}
