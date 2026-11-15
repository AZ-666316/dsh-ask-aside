Add AZ-666316/dsh-ask-aside

## 插件做什么

读长回答时碰到不懂的术语，不用在正文下面接着追问（那会把主线顶走、把上下文搅浑）：

- 选中回答里的文字 → 选区下方出现「提问」（样式与宿主自带的「引用文本」一致，靠让位逻辑互不遮挡）；
- 点它 → 右侧栏「问答」页签开一条独立会话，流式回答；
- 默认 `ctx.remote.session.fork()` 继承主对话到此刻的完整历史（前缀缓存命中），也可在面板顶部切「只看引文」只带选中文字；
- 同一个主对话只维护一条旁支会话（映射落盘到 `<DSH_HOME>/dsh-ask-aside-map.json`），左侧会话列表里用一段注入的 CSS 把它藏起来，需要时「在会话中打开」随时找回；
- 输入框支持图片/文件附件（粘贴、拖拽、`＋` 选文件，走宿主同一条 `fileUpload` 链路，最多 8 个）；
- 不划词也能问：右侧栏页签条「+」→「问答」，或主输入框左侧的小入口。

安装：`npm i dsh-ask-aside` 或 `dsh plugin install dsh-ask-aside`，然后在 profile 的 `dsh.profile.bundles` 里启用。

## 提交检查（对应 contributing.md 的要求）

- [x] `package.json` 声明 `dsh.bundle.patch`（`./cordis.patch.yml`），根目录有该 patch 文件
- [x] 仓库有可运行的真实代码（宿主路由 + 手写客户端模块，2026-11-15 发布 1.0.0 到 npm）
- [x] 仓库已加 `dsh-plugin` topic
- [x] 仓库创建已满 1 天（2026-11-15 建仓，提交本 PR 时已过 24h）
- [x] 只新增一个文件：`data/plugins/AZ-666316__dsh-ask-aside.yml`
- [x] 分类选 `ui`（划词浮层 + 侧栏面板，都是界面交互）
- [x] 描述与代码一致：fork 继承、只看引文、流式、附件、一条旁支都是 1.0.0 的实际行为

## 线上状态

- GitHub：https://github.com/AZ-666316/dsh-ask-aside （tag `v1.0.0`）
- Release：https://github.com/AZ-666316/dsh-ask-aside/releases/tag/v1.0.0
- npm：https://www.npmjs.com/package/dsh-ask-aside （latest `1.0.0`）

## 已知限制（README 里有全文）

- 只支持 DSH 界面内的消息，不支持浏览器外部页面划词；
- 左栏隐藏依赖宿主的 `data-row-key="session:<id>"` 属性，宿主改版可能失效（失效只是「又看得见」，不影响功能）；
- 旁支会话是真会话（名字带「❓」前缀），会出现在最近会话/搜索里。