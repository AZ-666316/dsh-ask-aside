# dsh-ask-aside

**划词提问，答案长在侧栏里，不打断主对话。**

读长回答时碰到不懂的术语、跳步的推导，不用在正文下面接着追问（那会把主线顶走、把上下文搅浑）：选中那几个字 → 点「提问」→ 右侧栏开一个独立会话，流式回答，边看边追。

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的插件。

---

## 为什么

在主对话里问「这个术语什么意思」，代价是双向的：

- 主对话被术语解释、追问、来回澄清占满，真正的主线（论文、实验、代码）被挤到上面去了；
- 你并不总是想为一句「PARP 是什么」新开一整个会话，回来还得自己找。

dsh-ask-aside 的做法是：**每次划词提问 = 一条独立的旁支会话**，它默认承接主对话的全部上下文（答得准），但在界面上与主线完全分离（不污染）；问完就关，值得留再升格成正式对话。

## 能力

| 能力 | 说明 |
| --- | --- |
| 划词浮层 | 选中「主对话里的文字」→ 选区下方浮出「提问」按钮，样式与宿主自带的「引用文本」一致，靠让位逻辑避开它，不会遮挡 |
| 侧栏直接问 | 不划词也行：右侧栏页签条「+」→「问答」，或点主输入框 `+` 旁边的那个小图标，直接接着当前主对话的上下文追问 |
| 承接上下文 | 默认 `fork` 主会话：新会话继承主会话到此刻为止的完整历史，**前缀缓存命中**，回答知道你在说什么 |
| 只看引文 | 面板顶部可切「只看引文」，只带选中文字、不带历史，省 token / 免得把旧话题带进来 |
| 一个主对话一条旁支 | 同一个主对话只维护一条旁支会话（映射落盘），再问接着聊，不会每问一次在左栏堆一条新会话 |
| 悄悄存在 | 旁支会话用 CSS 从左侧列表隐藏，主对话列表保持干净；需要时「在会话中打开」随时能找回 |
| 流式回答 | 逐字上屏，可中途停止（关闭面板即中止订阅） |
| 附件 | 输入框左侧只有一个 `＋`：点它选图片/文件，也可以直接把文件粘贴或拖进面板（不显示任何原生选择器或提示文字）；走宿主同一条上传链路，最多 8 个，只发附件不写字也行 |
| 多轮追问 | 在同一个旁支会话里连续问，互相关联 |
| 升格 | 「在会话中打开」跳到该旁支会话，之后就是普通会话，可续聊、改标题、归档 |
| 失败可见 | 上游报错 / 被中断会显示原因，不会静默空白 |
| 不抢焦点 | 面板不夺输入焦点；主对话的草稿不会被覆盖 |
| 与视频皮肤共存 | 装了 `dsh-video-skin` 时，它贴屏幕右下角的透明度圆钮会在「问答」面板打开期间自动让到侧栏左边（面板关掉回原位），原生 `title` 提示框换成主题化气泡；不改对方文件 |

## 安装

插件以普通 DSH bundle 形式安装（profile 内 `link:` 或 npm 包皆可）：

```jsonc
// <DSH_HOME>/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-ask-aside": "link:D:/path/to/dsh-ask-aside"
  },
  "dsh": { "profile": { "bundles": ["dsh-ask-aside"] } }
}
```

然后在 DSH 里启用并应用：

```text
plugin_manager set_bundle  target=dsh-ask-aside  enabled=true
```

刷新页面后：

1. 在任意回答里选中一段文字 → 选区下方出现「提问」（与「引用文本」互不遮挡）；也可以不划词，直接用右侧栏页签条的「+」打开「问答」；
2. 点它 → 右侧栏打开「问答」页签，问题自动带引文发出；
3. 想换话题就点「新对话」；想留下就点「在会话中打开」；
4. 想带材料问，点输入框下的 `＋` 选图片/文件，或者直接把文件粘贴/拖进面板（最多 8 个；只发附件不写字也可以）。

依赖：`dsh >= 0.2.0`、`node >= 20`。宿主侧只用 `webServer`，提供两个路由：

```text
GET  /dsh-ask-aside/api/status          插件状态
GET  /dsh-ask-aside/api/map             读「主对话 → 旁支」映射
POST /dsh-ask-aside/api/map             写一条映射 { parent, side, strategy }
```

映射存放在 `<DSH_HOME>/dsh-ask-aside-map.json`（原子写），所以重启桌面端之后仍然认回同一条旁支；删掉这个文件等于全部重来。

## 它是怎么实现的

整个插件是「一个客户端模块 + 一个空壳宿主模块」，用的是 DSH 公开的客户端服务：

- **浮层**：监听 `selectionchange`/`mouseup`，要求选区落在 `[data-chat-anchor-key]` 内且起止同一锚点（避免跨消息引用产生歧义）；流式生成中的消息（带 `[data-streaming]`）拒绝提问，因为那段文字还在变。
- **开旁支**：`ctx.remote.session.fork({ sessionId })` 继承历史；父会话正在生成时 fork 不可用，自动降级为 `create()` + 只带引文，并在面板上标注「本次未承接上下文」。
- **提问**：`ctx.remote.session.prompt({ requestId, sessionId, mode: 'queue', content: [...] })`，首问把引文拼成 `> 引用` + 问题。
- **看回话**：`ctx.remote.session.follow({ address, maxMessages: 60, assistantStream: true }, signal)` 是一条 async iterable，`assistant-stream` 帧负责逐字、`event` 帧负责落库消息，两条线按 seq 合并 —— 少任何一条，流式或历史都会漏。
- **进侧栏**：`tabs.register({ id, kind, title, guide })` 声明页签类型，`slots.inject('sidebar.right.pane.tab', …)` 挂面板。所有侧栏服务用 `ctx.get()` 探测而不是 `inject` —— cordis 没有可选依赖，注入一个宿主没有的服务会把 fiber 挂住、整个 web 白屏。
- **一条旁支**：`<DSH_HOME>/dsh-ask-aside-map.json` 记录 `主对话 id → 旁支 id`；面板打开时先查表，有就接着用，没有才 `fork`。换「新对话」时把旧的 id 归档进 `retired` 数组，用一段注入的 CSS（`[data-row-key="session:<id>"]{display:none}`）把它们从左栏藏掉 —— 只改显示，不动数据，所以「在会话中打开」仍能找到完整记录。

不做的事：不写宿主状态、不读你的会话文件、不联网（除了走 DSH 自己的会话通道）。

## 已知限制

- 只支持 DSH 桌面/Web 界面内的消息，不支持浏览器外部页面里的划词；
- 左栏隐藏依赖宿主的 `data-row-key="session:<id>"` 属性，宿主改版可能失效（失效只是「又看得见」，不影响功能）；
- 旁支会话是真的会话（名字带「❓」前缀），会出现在「最近会话」/搜索里；
- 浮层默认贴在选区正下方，下方放不下就翻到上方；与宿主「引用文本」重叠时再让开（依赖按钮文字匹配，宿主改文案后只是退回普通定位）；
- 从页签「+」进入时面板没有引文，提问会直接 fork 当前主对话，回答里不带「你选的那句」；
- 附件上传依赖宿主的 `fileUpload` 客户端服务（本机 0.2.2-rc.3 有），宿主没有时会在面板里明确报错；
- 一次最多 8 个附件；图片类型限 `png/jpeg/webp/gif`，其他类型按普通文件上传；
- 暂不做：嵌套追问树、历史列表、追问记录面板。

## 开发

```bash
node --check lib/client.js          # 语法
node smoke-test.cjs                 # 无浏览器冒烟：tab 注册 / 日志折叠 / 首问拼装 / store / markdown
node render-test.cjs                # 真 React + jsdom 渲染：面板、浮层、旁支复用、附件入口与上传契约
```

`lib/client.js` 是手写的浏览器模块（没有构建步骤），通过 `window.__ModuleLoader__.load({ id, factory })` 注册，`factory` 里只能 `require` 平台种子模块：`react`、`react-dom/client`。

## 打包 / 发布

```bash
npm pack            # 产出 dsh-ask-aside-1.0.0.tgz（只含 files 里列的文件）
npm publish         # 需要 npm 登录；DSH 插件市场按 npm 包名索引
git tag v1.0.0 && git push origin main --tags
```

仓库地址在 `package.json` 的 `repository` / `homepage` / `bugs` 里，发布前替换成真实账号。

## License

MIT