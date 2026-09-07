# 灵感捕手

用于快速保存刷视频时产生的灵感，并自动读取视频封面、提交 Whisper medium 转写、生成 AI 高密度拆解、搜索并研究类似案例。

## 本地运行

```powershell
npm run dev
```

访问 `http://127.0.0.1:4173`。

## 当前能力

- 抖音、B站、微信视频号链接识别与封面读取
- 灵感记录持久化、浏览和删除
- Gaia 服务器 Whisper medium 异步转写
- DeepSeek、OpenAI、Claude、Grok 模型切换
- 官方或第三方 OpenAI-compatible / Anthropic API
- Bing RSS 免费网络搜索
- 视频内容拆解与类似案例研究两套高密度提示词
- AI Markdown 原文持久化与安全阅读模式渲染

## 部署结构

- 个人云服务器：网页、API、记录、AI 正文、视频下载和任务队列
- Gaia：每分钟主动领取任务，用 Whisper medium 转写并回传文本
- 微信视频号：默认调用 `wx_channels_download` 作者提供的分享链接解析服务

## 主要接口

- `POST /api/video/inspect`
- `POST /api/video/transcribe`
- `GET /api/jobs/:id`
- `POST /api/insights/analyze`
- `GET /api/search?q=...`
- `GET/POST/DELETE /api/notes`
- `GET/DELETE /api/analyses`
- `GET/PUT /api/settings/providers`

页面只显示 API Key 遮罩。OpenAI、Claude、Grok 的模型下拉会根据模型刷新思考强度；不支持思考的模型不显示该选项，默认中等。更新供应商配置需要服务器环境变量 `ADMIN_TOKEN`；Gaia worker 使用独立的 `WORKER_TOKEN`。

## 飞书同步配置

第一版面向个人飞书组织，但连接、文档映射和同步队列均按网站用户隔离。本站数据是唯一事实源，飞书知识库文档与多维表格是异步单向镜像；普通保存不会等待飞书接口。

在飞书开放平台创建企业自建应用，并完成以下配置：

1. 将重定向 URL 设置为 `https://inspiration.zzhhh.site/api/integrations/feishu/oauth/callback`。
2. 开通用户身份、离线授权、知识库、云文档和多维表格所需权限；具体权限清单以设置页显示的 `requiredScopes` 为准。
3. 发布应用，并确保当前个人组织可使用该应用。
4. 在服务器配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`INTEGRATION_ENCRYPTION_KEY`、`PUBLIC_BASE_URL` 和 `FEISHU_REDIRECT_URI`，然后重启服务。

`INTEGRATION_ENCRYPTION_KEY` 用于加密飞书 access token 和 refresh token，必须是独立生成的高强度随机值，不应提交到仓库。未配置上述变量时，设置页会显示“服务器待配置”，其他灵感记录、转写、编辑与 AI 功能保持可用。
