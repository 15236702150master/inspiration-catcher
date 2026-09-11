# 转写标注工作区测试矩阵

这些测试对应实施计划的硬验收条件。测试使用临时目录、临时 SQLite 和固定账号，不接触项目的 `data/`，也不调用线上 AI 或视频服务。

## 运行

```powershell
# 纯函数、迁移和 API 集成
node --test --test-concurrency=1 tests/workspace-*.test.mjs

# Chromium + WebKit 桌面/手机交互及截图
python tests/workspace_e2e.py

# 全部执行
powershell -ExecutionPolicy Bypass -File tests/run-workspace-tests.ps1
```

完整入口会先重新构建 `dist/`，确保浏览器验证的是当前源码生成的生产产物，而不是旧缓存构建。

如果计划中的模块或选择器尚未实现，测试会明确报告缺少的文件、导出、API 或 `data-testid`，不会把缺失能力记为跳过或通过。

## 覆盖关系

| 范围 | 自动化证据 | 对应验收 |
|---|---|---|
| NFC、CRLF、中文空格、emoji UTF-16 | `workspace-text.test.mjs` | 1、4 |
| 稳定块 ID、重复中文、跨块 group | `workspace-text.test.mjs` | 4、8 |
| 唯一匹配、歧义、丢失重定位 | `workspace-reanchor.test.mjs` | 5、6、7 |
| JSON -> SQLite 无损与幂等迁移 | `workspace-migration.test.mjs` | 12、18、19 |
| schema v1 -> v2 锚点历史无损升级 | `workspace-migration.test.mjs` | 5、7、19 |
| 外键级联 | migration + API delete | 18 |
| 用户所有权 GET/POST/PATCH/DELETE 统一 404 | `workspace-api.test.mjs` | 13 |
| 锚点互斥字段 422 | `workspace-api.test.mjs` | 7、13 |
| Idempotency-Key 与 `clientMutationId` | `workspace-api.test.mjs` | 10、12 |
| 乐观 revision 与 409 正文 | API + 双页面 E2E | 11 |
| Tiptap JSON / URL XSS | API + 三类导出 E2E | 14、17 |
| 桌面选区、叠加标注、目录跳转 | Chromium + WebKit E2E | 4、8、15 |
| 800ms 保存、离线 outbox、重连 | Chromium + WebKit E2E | 9、10 |
| 刷新、退出登录、新浏览器恢复 | Chromium + WebKit E2E | 9 |
| 五分钟快照、手动快照、去重与最近 20 版 | completion + E2E | 9、10 |
| 重转写、三阅读版本、旧版锚点恢复 | `workspace-completion.test.mjs` | 1、2、3、5、6、7 |
| worker/阅读版/加工稿/标注写入共存 | `workspace-completion.test.mjs` | 12 |
| 原文重新定位与原文局部 AI | `workspace-completion.test.mjs` | 5、7 |
| 220 条标注前端分页增量装载 | Chromium E2E | 16 |
| 段落级刷新、慢网乐观反馈 <100ms | Chromium E2E | 阶段 3、阶段 7 |
| 快捷键、滚动收起、AI 失败详情与重试 | Chromium/WebKit E2E | 阶段 2、阶段 6、15 |
| 手机底栏、44px 触控、批注 sheet | 390x844 E2E | 15 |
| 390/360px 与横屏无横向溢出 | 视觉/布局断言与截图 | 15 |
| 三种导出相互独立且无危险标记 | E2E download | 14、17 |
| 首包不内联全文且不超过 28KB | API 集成 | 16 |
| 100k 中文、500 标注、首包/正文/分页计时 | `workspace-performance.test.mjs` | 16、阶段 7 性能门禁 |

## 真实设备门禁

浏览器自动化无法可靠操纵 iOS/Android 的系统选区手柄、软键盘和浏览器工具栏。上线前必须在最近两个主版本的 Android Chrome 与 iOS Safari 各填写一次 [`manual-device-checklist.md`](manual-device-checklist.md)，并保存对应截图或录屏。没有真实设备证据时，验收条件 15 不能标记完成。
