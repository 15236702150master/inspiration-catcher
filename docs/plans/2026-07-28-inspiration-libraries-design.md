# 灵感库与飞书目录设计

## 目标

灵感库是每条灵感唯一的归档位置，标签继续承担多选和交叉筛选。用户可以创建、重命名、删除灵感库，并在保存或后续整理时移动笔记。

## 规则

- 每位用户自动拥有不可删除的“待分类”灵感库。
- 每条灵感始终属于一个灵感库；新建时未选择则进入“待分类”。
- 删除自定义灵感库时，其中笔记原子地移入“待分类”，笔记本身不删除。
- 标签变化不改变灵感库归属。
- 飞书知识库中，每个灵感库对应一个可作为父节点的 Docx Wiki 节点。
- 灵感库重命名时同步更新飞书目录标题；笔记移动时移动原 Wiki 节点，不重建文档，保留 URL、评论和“我的飞书补充”。
- 删除灵感库后，只有当全部子文档成功迁出，才删除远端空目录。

## 接口

- `GET /api/libraries`
- `POST /api/libraries`
- `PATCH /api/libraries/:id`
- `DELETE /api/libraries/:id`
- `POST /api/notes/:id/move-library`
- `GET /api/notes` 和 `POST /api/notes` 返回或接受 `libraryId`

## 数据模型

- `inspiration_libraries`：多用户灵感库，支持软删除和默认库。
- `inspiration_library_assignments`：灵感到灵感库的一对一归属。
- `feishu_library_bindings`：本地灵感库到飞书 Wiki 父节点的映射。
- `feishu_document_bindings` 保存当前远端父节点和所属灵感库，用于幂等移动与漂移修复。

## 失败处理

所有本地保存先完成，飞书目录创建、重命名、移动和清理由异步 worker 完成。移动失败时保留原远端文档和绑定，按现有退避机制重试，不复制文档。
