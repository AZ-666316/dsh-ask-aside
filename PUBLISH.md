# 发布记录（v1.0.0，2026-11-15）

三个通道都通了。下面是可以照抄的状态与命令。

## 线上状态

| 通道 | 状态 | 地址 |
| --- | --- | --- |
| GitHub 仓库 | ✅ main = `5906801`，tag `v1.0.0` | https://github.com/AZ-666316/dsh-ask-aside |
| GitHub Release | ✅ v1.0.0 | https://github.com/AZ-666316/dsh-ask-aside/releases/tag/v1.0.0 |
| npm | ✅ latest = `1.0.0`（versions: `0.0.0-stage` 占位 + `1.0.0`） | https://www.npmjs.com/package/dsh-ask-aside |
| 插件市场（awesome-dsh-plugin） | ⏳ 草稿就绪，未提 PR | `publish/awesome-entry.yml` |

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

## 商店收录（还没做）

1. 等仓库创建满 1 天：仓库建于 `2026-11-15 10:32 UTC`（= 本地 18:32），所以 **2026-11-16 18:32（本地）之后**才能提；
2. fork `awesome-dsh-plugin/awesome-dsh-plugin`；
3. 新增 `data/plugins/AZ-666316__dsh-ask-aside.yml`，内容 = `publish/awesome-entry.yml`；
4. PR 标题 `Add AZ-666316/dsh-ask-aside`，正文用 `publish/PR_BODY.md`；
5. 等 CI 绿 + 维护者 review（会真的装插件看效果）。

规则细节见 `publish/CHECKLIST.md`。

## 已做的验证

- `node --check index.js` / `node --check lib/client.js` 通过；
- `node smoke-test.cjs`、`node render-test.cjs` 全绿（面板、浮层、旁支复用、附件上传契约、主输入框入口）；
- 本机 profile 已装着 1.0.0：`GET /dsh-ask-aside/api/status` → `version 1.0.0`，开发期的 `/diag` 已 404；
- npm：`npm view` → `1.0.0`；临时目录 `npm install dsh-ask-aside` 成功，tarball 7 个文件与本地一致。