# dsh-session-delete

DeepSeek Harness（DSH）插件：在侧栏会话列表里**永久删除**会话。

[English](README.en.md) | 中文

DSH 自带的「归档会话」只是把会话从列表里隐藏，日志仍然留在磁盘上。这个插件补上真正的删除：右键菜单（或行尾的 `...` 菜单）里出现 **删除会话…**，悬停会话行还会出现一个垃圾桶按钮，确认后删除已保存的聊天日志、投影缓存和工作区条目。

- 版本：`1.0.0`
- 兼容：DSH `0.2.2-rc.5`（桌面版验证）
- 许可：MIT
- 关键词：`dsh-plugin` · `deepseek-harness` · `dsh` · `deepseek`

## 功能

| 入口 | 位置 |
|---|---|
| 菜单项 **删除会话…** | 会话行右键菜单 / 行尾 `...` 菜单，排在系统「归档会话」之前 |
| 垃圾桶按钮 | 会话行悬停时，出现在归档、置顶按钮之后 |
| 确认对话框 | 默认焦点在「取消」，Esc / 点遮罩可取消，删除中禁用按钮 |
| 成功提示 | 底部一条「会话已删除」，约 2.4 秒后自动消失 |
| 智能体工具 `session_delete` | 与界面同一个宿主方法，参数为一组会话 id |

## 安装

```bash
git clone https://github.com/ruichina/dsh-session-delete.git
```

方式一（图形界面）：**插件** → **添加插件** → 选择克隆下来的目录（本地链接安装）。

方式二（`plugin_manager` 工具 / 脚本）：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

安装后条目 id 形如 `include:session-delete`，在 **设置 → 插件** 里可以随时停用；停用即恢复原生侧栏，并移除 `session_delete` 工具。

## 删除的内容

确认后，插件在**宿主进程**中：

1. 删除该会话的存储目录（`<DSH_HOME>/sessions/<分组>/<会话目录>/`，包含该会话的**所有格式代**日志文件——只删当前一代会让会话以旧格式"复活"）；
2. 删除投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`；
3. 把该会话从工作区列表、归档集合、置顶集合中移除，侧栏那一行随之消失。

## 限制与安全闸门

- **正在使用中的会话**（宿主里还有活动 Agent 持有写入句柄）会被拒绝，提示先切换会话；
- **仍有任务在跑的会话**（子代理 / 后台任务 / 定时任务）会被拒绝，提示先归档（归档会停止这些任务）再删除——这个检查复用系统归档路径的 `workspace/session-activity` 瀑布；
- 对话框一次只处理一个会话，不支持批量多选；`session_delete` 工具单次请求最多 50 个 id；
- 会话的附件、终端不在此插件清理范围内；
- 未归入任何工作区的会话被删除后，侧栏那一行可能要在切换会话或刷新页面后才消失。

## 实现说明

- **Host 半**（[`index.js`](index.js)）：删除逻辑只实现一次，两个调用方共用。浏览器通过 `/api` 上的一条**独占精确 Fetch 路由**（`ctx.connection.fetch.register`，`POST /api/session-delete/delete`）调用；`/api` 的 RPC 拦截器是单值占用（API Gateway 持有），插件不能使用它。工具 `session_delete` 走同一个函数。
- **Client 半**（[`client.js`](client.js)）：向 `sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action` 与 `shell.overlay` 三个槽位注册，样式只用 `--dsw-alias-*` 主题 token，对话框 portal 到 `document.body` 以避免被窄窗口抽屉覆盖。
- 显示元数据与图标来自 [`locale/`](locale) 与 [`icon.svg`](icon.svg)，无需启用插件即可在插件详情页读到。

## 已知未验证项

- 浏览器里的实际点击流程由作者手动确认（插件作者备注），本仓库不含自动化 UI 测试；
- 工作区条目移除分支（`detachSession`）在合成会话上无法覆盖，只经过代码审查。

## 开发与调试

- 修改 `client.js` 后需要刷新页面（DSH 客户端 bundle 按文件元数据取版本）；
- 修改 `index.js` 后重启该插件行（停用再启用）即可加载新的宿主模块；
- 语法自检：`node --check index.js client.js`。

## 致谢与许可

DSH 的插件规范、槽位契约与主题 token 来自 `deepseek-ai/deepseek-harness`。本项目以 [MIT](LICENSE) 许可发布。
