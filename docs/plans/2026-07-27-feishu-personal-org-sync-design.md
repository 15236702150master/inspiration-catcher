# 飞书个人组织同步设计

## 1. 决策

第一版面向当前个人飞书组织上线，但数据库、API 和授权资源均按网站 `owner_id` 隔离。本站是唯一事实源，飞书是自动归档与协作阅读镜像。

采用“多维表格索引 + 每条灵感一篇知识库 Docx”：

- 每个网站用户绑定一个飞书连接。
- 每个连接选择一个知识空间父节点，并拥有一张“灵感索引”多维表格。
- 每条灵感映射一个 Wiki 节点、一个 Docx 文档和一条多维表格记录。
- 第一版只从本站同步到飞书，不接收飞书正文回写。
- 飞书文档预留“我的飞书补充”区域，本站永不覆盖该区域。

不采用“所有灵感追加到单一文档”，因为长转写会导致查找、更新、并发和冲突不可控。

## 2. 用户流程

1. 用户在“AI 设置”旁进入“飞书同步”。
2. 未配置服务器 App ID/Secret 时显示明确配置清单；配置完成后显示“连接飞书”。
3. OAuth 回调后选择知识空间和父目录，系统创建或复用“灵感索引”多维表格。
4. 可选择“只同步新记录”或“一次性同步已有记录”；默认只同步新记录。
5. 日常保存不等待飞书。服务端落库后写入同步 outbox，后台合并并同步最新完整状态。
6. 单条灵感显示 `待同步`、`同步中`、`已同步`、`同步失败`、`需重新授权`，并提供“在飞书打开”和“立即重试”。
7. 解绑默认只删除本站授权并停止同步，保留飞书副本；删除飞书副本是独立操作。

二期可增加飞书机器人：向机器人发送视频链接即可创建本站草稿，完成后回复进度和文档卡片。

## 3. 飞书文档投影

正文按固定托管章节输出：

1. 封面、平台、作者和原视频链接
2. 我的感想
3. 我的加工稿
4. 阅读标注与批注
5. AI 阅读版
6. 视频拆解
7. 类似案例
8. 原始转写
9. 我的飞书补充（非托管）

现有高亮、下划线和粗体映射为 Docx `text_run.style`；批注输出为引用或高亮块。长正文按不超过飞书块限制拆分，块创建每次最多 50 个。

多维表格字段：`灵感ID`、标题、封面、平台、作者、视频链接、标签、状态、转写状态、摘要、Docx 链接、创建时间、更新时间、同步状态。`灵感ID` 是唯一映射键，禁止按标题对账。

## 4. 鉴权与权限

采用飞书 OAuth v3：

- 授权：`GET https://accounts.feishu.cn/open-apis/authen/v1/authorize`
- 换取与刷新令牌：`POST https://accounts.feishu.cn/oauth/v3/token`
- 必须校验 `state`，申请 `offline_access`，支持 PKCE S256。
- Access/Refresh Token 加密存储；Refresh Token 每次使用后必须在同一事务中原子替换。
- 每个连接设置刷新互斥锁，避免并发消费一次性 Refresh Token。

一期权限至少包含 Docx 创建/读写、Wiki 节点创建/读取、多维表格建库建表建字段及记录读写、素材上传和 `offline_access`。除 API scope 外，授权身份还必须是目标知识空间成员并拥有父节点编辑权限。

自建应用先服务当前租户。未来跨租户开放时发布商店应用，不改变 `owner_id + tenant_key` 的连接模型。

## 5. 数据模型

新增 schema v3：

- `feishu_connections`：用户、租户、飞书用户标识、加密令牌、到期时间、授权范围、目标空间/父节点、索引表 token、策略与连接状态。
- `feishu_document_bindings`：`owner_id + inspiration_id` 唯一，保存 Wiki node、Docx、Bitable record、各托管章节 block ID、远端版本、内容哈希和同步状态。
- `sync_outbox`：通用服务端同步队列，保存聚合 ID、去重键、状态、尝试次数、租约、下次执行时间和错误详情。
- `integration_oauth_states`：短时 OAuth state、PKCE verifier、过期时间和一次性消费标记。

令牌密文使用服务器 `INTEGRATION_ENCRYPTION_KEY` 做 AEAD 加密。App ID/Secret 只从环境变量读取。

## 6. 同步架构

所有业务写入在数据库事务成功时调用 `enqueueProjectionRefresh(ownerId, inspirationId)`。相同灵感的连续事件合并为一个待处理任务：

- 草稿解析后延迟 5 秒创建索引。
- 转写、阅读版、拆解与案例完成后立即排队。
- 标注变化合并 5 秒。
- 加工稿变化合并 30 秒，最长 2 分钟强制刷新。

Worker 每次从 SQLite 读取最新完整聚合，生成 `FeishuInspirationProjection` 并计算 `source_hash`。哈希未变则直接成功。先保证索引记录存在，再创建/更新 Docx；某一步失败只重试该步骤。

飞书 Docx 单应用和单文档写入均约 3 次/秒，所有写操作按连接和文档串行。429、5xx、超时按 1、5、20、60 分钟指数退避并记录飞书请求 ID。401 先刷新令牌重试一次；403 标记权限失效；404 要求用户确认重新创建，禁止静默生成重复副本。

现有 `transcription_jobs` 和浏览器 IndexedDB outbox 不复用：前者有专用生命周期和清理策略，后者只覆盖加工稿。飞书同步使用独立的持久化服务端 outbox。

## 7. API

- `GET /api/integrations/feishu/status`
- `POST /api/integrations/feishu/oauth/start`
- `GET /api/integrations/feishu/oauth/callback`
- `GET /api/integrations/feishu/spaces`
- `POST /api/integrations/feishu/configure`
- `POST /api/integrations/feishu/sync-existing`
- `POST /api/integrations/feishu/sync/:inspirationId`
- `POST /api/integrations/feishu/retry/:inspirationId`
- `POST /api/integrations/feishu/pause`
- `DELETE /api/integrations/feishu/connection`

所有接口从网站会话取得当前用户，资源查询必须同时匹配 `owner_id`。错误继续使用现有 `{ error: { code, message, details } }` 格式。

## 8. 验收标准

1. 未配置 App ID/Secret 时，设置页给出回调地址和配置项，不泄露密钥。
2. OAuth state 过期、重复消费或归属不匹配时拒绝回调。
3. 两个网站用户的连接、令牌、文档和任务互不可见。
4. 同一灵感连续保存十次只产生一个待处理刷新任务。
5. 创建或重试不会重复生成 Docx 或多维表格记录。
6. 转写、阅读版、感想、加工稿、标注、拆解、案例和标签均进入投影。
7. 页面保存不等待飞书网络请求；失败可后台重试并展示错误码。
8. 解绑后飞书文档保留，本地令牌不可恢复；暂停后可继续同步。
9. 飞书未配置时现有记录、转写、AI、标签和标注流程全部保持可用。

