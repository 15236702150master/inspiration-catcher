# 转写标注工作区验收记录

验收版本：schema v2  
线上地址：https://inspiration.zzhhh.site  
部署时间：2026-07-26 13:19:51 CST

## 自动化与线上证据

- 完整入口：`powershell -ExecutionPolicy Bypass -File tests/run-workspace-tests.ps1`
- Node：30/30
- Chromium/WebKit：8/8
- 线上临时记录闭环：`python tests/online_workspace_check.py`
- 线上数据库：`node scripts/audit-workspace-db.mjs --db data/inspiration.sqlite3`
- 依赖审计：0 vulnerabilities
- 压力数据：171,790 字、500 条标注、首包约 47KB、正文准备约 22ms、标注反馈 <100ms

## 19 项验收

| # | 状态 | 直接证据 |
|---|---|---|
| 1 | verified | 不可变 trigger、版本/锚点 completion 测试 |
| 2 | verified | 重转写产生新 ID，旧 raw/sha 保持不变 |
| 3 | verified | 三阅读版本并存；503 重排前后版本、指针、标注和加工稿一致 |
| 4 | verified | 中文、emoji、重复句、跨块锚点与 Chromium/WebKit 选区 |
| 5 | verified | 唯一/歧义/缺失重定位与历史文档锚点恢复 |
| 6 | verified | 多阅读版本 canonical anchor 恒定 |
| 7 | verified | version_bound 隔离、原文手动重定位后升级 canonical |
| 8 | verified | 高亮、下划线、两批注共存并独立删除 |
| 9 | verified | 刷新、退出再登录、新浏览器上下文恢复 |
| 10 | verified | 800ms 保存、离线重连、五分钟快照、去重与 20 版上限 |
| 11 | verified | 双标签页 409，服务器版与本地版均保留 |
| 12 | verified | 转写、阅读版、加工稿、标注写入后四项共存 |
| 13 | verified | 其他账号 GET/POST/PATCH/DELETE 均为 404 |
| 14 | verified | script 节点、事件属性、javascript URL 拒绝；导出无注入 |
| 15 | partial | 自动化桌面/手机/横屏通过；真实 Android/iOS 系统手柄与软键盘待验证 |
| 16 | verified | 100k/500 压测、首包上限、正文按需、前端增量分页 |
| 17 | verified | 原文、带标注版、加工稿三种导出独立且含来源 |
| 18 | verified | 事务级联；版本无独立删除入口且受 RESTRICT 保护 |
| 19 | verified | JSON 幂等迁移、schema v1->v2、线上 checksum/数量/外键/指针审计 |

## 部署证据

- 上一版程序：`/home/op/backups/inspiration-catcher/pre-schema-v2-app-20260726051704.tar.gz`
- SQLite 切换前一致性备份：`/home/op/backups/inspiration-catcher/cutover-schema-v2-db-20260726051704.sqlite3`
- JSON/封面/环境归档：`/home/op/backups/inspiration-catcher/pre-schema-v2-legacy-20260726051704.tar.gz`
- 24 小时审计定时器：`inspiration-schema-v2-observation-20260726051704.timer`
- 预期报告：`/home/op/backups/inspiration-catcher/post-schema-v2-observation-20260726051704.txt`

## 尚未关闭的门禁

1. 在真实 Android Chrome 与 iOS Safari 填写 `tests/manual-device-checklist.md`，保留截图或录屏。
2. 读取 24 小时观察报告；确认无新增 orphan、未处理 409、SQLite/写入错误。
3. 两项通过后关闭启动时旧 JSON 兼容读取，并做最后一次数据库与线上回归。

## 2026-07-26 14:01 CST 交互收口

- 桌面批注轨道增加独立 SVG 连接层；当前批注使用高对比连接，其他连接退到背景层，不改写正文 DOM。
- 标注目录首批渲染 36 条、每批增加 28 条；远端跳转只渲染目标附近窗口，手机端使用显式加载按钮。
- `<900px` 不显示连接线；390px、360px 与横屏均无横向溢出。
- 完整入口：Node/API 30/30，Chromium/WebKit 9/9；独立 `npm test` 32/32。
- 220 条目录场景：首屏 DOM 36 条、总数 220 条、远端项可加载并跳回正文。
- 视觉证据：`tests/screenshots/workspace/chromium-source-connectors.png`。
- 线上资源：`assets/index--6tNTaxY.js`、`assets/index-CBwre5Z9.css`。
- 线上临时记录闭环：`annotation=True personal=True mobile=True console_errors=0`，测试记录已自动删除。
- 线上数据库：integrity `ok`、外键异常 0、active pointer 异常 0、owner 异常 0，灵感数量恢复为 2。
