# 发布记录（v1.0.0 已上线，v1.1.0 待发，2026-11-16）

三个通道都通了。下面是可以照抄的状态与命令。

> **当前本地 = 1.1.0（未发布）**：新增「任务进度带」。本地 `main` = `afdae6b`，已 commit 未 push；
> npm 上还是 `1.0.0`。等用户说「上传」再走下面「复现命令」发 1.1.0（记得 tag `v1.1.0` + Release + 商店条目描述不用改）。

## 线上状态

| 通道 | 状态 | 地址 |
| --- | --- | --- |
| GitHub 仓库 | ✅ 远端 main = `9235a91`（tag `v1.0.0`）；本地已到 `afdae6b`（1.1.0，未 push） | https://github.com/AZ-666316/dsh-ask-aside |
| GitHub Release | ✅ v1.0.0 | https://github.com/AZ-666316/dsh-ask-aside/releases/tag/v1.0.0 |
| npm | ✅ latest = `1.0.0`（versions: `0.0.0-stage` 占位 + `1.0.0`） | https://www.npmjs.com/package/dsh-ask-aside |
| 插件市场（awesome-dsh-plugin） | ✅ 已提 PR [#15889](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15889)（2026-11-16），**两道 CI 全绿**，`mergeable: clean`，等维护者 review | `publish/awesome-entry.yml` |

`0.0.0-stage` 是 npm 对**新包**第一次发布时先落的一个占位版本（`npm publish` 返回 202 + 「being processed」），真实版本通常一两分钟内跟上，**不需要手动 approve**。看到它别慌。

## 产物

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| git 仓库 | `D:\大肥鱼工作区\dsh-plugins\dsh-ask-aside` | 分支 `main`，工作树干净 |
| npm 包 | `dsh-ask-aside-1.0.0.tgz` | 30.8 KB、7 个文件；`npm i dsh-ask-aside` 实测可装 |
| 完整历史备份 | `..\dsh-ask-aside-v1.0.0.bundle` | 54.5 KB，`git clone xxx.bundle` 能还原整条历史 |

## 复现命令（下次发版）

```powershell
# 1) 改功能 → 升 package.json 版本 → 测试
node --check index.js; node --check lib/client.js
node smoke-test.cjs; node render-test.cjs

# 2) 提交 + 打 tag + 推（github.com 直连不稳，走本机 Clash 代理）
git add -A; git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git -c http.proxy=http://127.0.0.1:7892 -c https.proxy=http://127.0.0.1:7892 push origin main --tags

# 3) npm（token 在本地 .npmrc，已 gitignore；npm.cmd 才能用）
$env:npm_config_cache = '<某个可写目录>\.npm-cache-tmp'
D:\node\npm.cmd publish --access public
D:\node\npm.cmd view dsh-ask-aside version

# 4) GitHub Release
node ../publish-ask-aside.mjs release vX.Y.Z   # 需要 $env:GH_TOKEN

# 5) 商店条目：改 publish/awesome-entry.yml 里的描述（如行为有变），仓库满 1 天后提 PR
```

## 身份与凭据（本机）

- GitHub 账号：`AZ-666316`（`git credential fill` 里存的是 `gho_` 开头 OAuth token，可直接当 `Authorization: Bearer` 调 api.github.com）
- npm 账号：`xjz666`（token 在 `.npmrc`，**不要提交**）
- 全局 `http.proxy` 指向 `127.0.0.1:7892`；Clash 没开时 `git push` 会报 `Could not connect to server` 或 `RPC failed; curl 55`

## 商店收录（CI 全绿，等 review）

PR：[#15889](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15889)（2026-11-16 提交，head SHA `794adc91`，head = fork `AZ-666316:main`，**1 个 commit / +1 文件 / +6 行**，`mergeable: true`、`mergeable_state: clean`）。

**CI 结果（2026-11-16 19:06 本地完成，总时长 24 分 41 秒）**

| 检查 | 结论 |
| --- | --- |
| `Submission gate` | ✅ success（`dsh.bundle` 声明 + 仓库年龄 24.04h 均过） |
| `PR check` run [43851117244](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/43851117244) | ✅ success，15/15 步全绿：stale-fork guard → `.yml` 扩展名/路径 → README 生成行非空 → README 与 `data/plugins` 一致 → awesome-lint → 4 组回归测试（added-date / capability-disclosure / discussion-adoption / entry-path）→ 整站构建（locale parity、date derivation、templates） |

剩下的只有维护者 review（会真的装插件看效果），没有我能加速的动作。

1. 仓库创建满 1 天：仓库建于 `2026-11-15 10:32 UTC`（= 本地 18:32），门槛是 **2026-11-16 18:32（本地）之后** —— 已满足；
2. fork `awesome-dsh-plugin/awesome-dsh-plugin`（`AZ-666316/awesome-dsh-plugin`，**已关掉该 fork 的 Actions**，否则上游 `sync-readme.yml` 会在 fork 上自动生成 README 提交，把 PR 变成 README 冲突）；
3. 新增 `data/plugins/AZ-666316__dsh-ask-aside.yml`，内容 = `publish/awesome-entry.yml`；
4. PR 标题 `Add AZ-666316/dsh-ask-aside`，正文用 `publish/PR_BODY.md`；
5. 等维护者 review（会真的装插件看效果）。

**坑（下次注意）**：fork 出来的仓库默认 Actions 是开着的，上游 `sync-readme.yml` 是 `on: push` —— 一推 yml 它就在 fork 上再生成 README 提交，PR 立刻从「+1 文件」变成「改 README」并在上游 main 前进后冲突（`mergeable_state: dirty`）。处理：`PUT /repos/<owner>/<repo>/actions/permissions {"enabled":false}`，然后 `PATCH /repos/<owner>/<repo>/git/refs/heads/main {sha:<yml-only commit>, force:true}` 把 README 提交踢掉，PR 会恢复成 +1 文件 / clean。

规则细节见 `publish/CHECKLIST.md`。

## 已做的验证

- `node --check index.js` / `node --check lib/client.js` 通过；
- `node smoke-test.cjs`、`node render-test.cjs` 全绿（面板、浮层、旁支复用、附件上传契约、主输入框入口）；
- 本机 profile 已装着 1.0.0：`GET /dsh-ask-aside/api/status` → `version 1.0.0`，开发期的 `/diag` 已 404；
- npm：`npm view` → `1.0.0`；临时目录 `npm install dsh-ask-aside` 成功，tarball 7 个文件与本地一致。