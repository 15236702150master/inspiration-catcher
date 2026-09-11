import test from "node:test";
import assert from "node:assert/strict";
import { extractArticleHtml } from "../lib/article-extractor.mjs";

test("WeChat article extractor keeps title, author, paragraphs and image links", () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="备用标题">
    <script>
      var msg_title = '公众号文章标题';
      var nickname = '测试公众号';
      var msg_cdn_url = 'https://mmbiz.qpic.cn/cover.jpg';
    </script>
  </head><body>
    <h1 id="activity-name">公众号文章标题</h1>
    <span id="js_name">测试公众号</span>
    <div id="js_content">
      <p>第一段正文，包含重要观点。</p>
      <section><strong>第二段正文</strong>，继续展开说明。</section>
      <img data-src="https://mmbiz.qpic.cn/mmbiz_png/image-one.png?wx_fmt=png" alt="示意图">
      <p>图片之后的总结。</p>
    </div>
    <script>console.log("after content")</script>
  </body></html>`;
  const article = extractArticleHtml(html, { url: "https://mp.weixin.qq.com/s/test" });
  assert.equal(article.platform, "wechat_article");
  assert.equal(article.title, "公众号文章标题");
  assert.equal(article.author, "测试公众号");
  assert.equal(article.cover, "https://mmbiz.qpic.cn/cover.jpg");
  assert.match(article.markdown, /第一段正文/);
  assert.match(article.markdown, /第二段正文/);
  assert.match(article.markdown, /!\[示意图\]\(https:\/\/mmbiz\.qpic\.cn\/mmbiz_png\/image-one\.png\?wx_fmt=png\)/);
  assert.match(article.plainText, /图片之后的总结/);
  assert.equal(article.imageCount, 1);
});

test("generic article extractor falls back to article body", () => {
  const html = `<html><head><title>普通网页文章</title><meta name="author" content="作者A"></head>
  <body><article><h2>小标题</h2><p>这里是普通网页文章正文，长度足够用于提取。</p></article></body></html>`;
  const article = extractArticleHtml(html, { url: "https://example.test/post/1" });
  assert.equal(article.platform, "article");
  assert.equal(article.title, "普通网页文章");
  assert.equal(article.author, "作者A");
  assert.match(article.markdown, /## 小标题/);
  assert.match(article.plainText, /普通网页文章正文/);
});
