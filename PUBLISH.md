# 发布清单（v1.0.0）

本地已经打包好，缺的只有「往哪儿推 + 用什么身份推」。

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| git 仓库 | `D:\大肥鱼工作区\dsh-plugins\dsh-ask-aside` | 分支 `master`，已打 tag `v1.0.0`，工作树干净 |
| npm 包 | `D:\大肥鱼工作区\dsh-plugins\dsh-ask-aside\dsh-ask-aside-1.0.0.tgz` | 30 KB，7 个文件，`npm i ./dsh-ask-aside-1.0.0.tgz` 可直接装 |
| 完整历史备份 | `D:\大肥鱼工作区\dsh-plugins\dsh-ask-aside-v1.0.0.bundle` | 54 KB，`git clone xxx.bundle` 能还原整条历史 |

## 还差三步

### 1. 建一个空仓库

GitHub → New repository → 名字 `dsh-ask-aside` → **不要**勾 README / .gitignore / LICENSE（本地都有了）。

记下地址，形如 `https://github.com/<你的账号>/dsh-ask-aside.git`。

### 2. 把地址填进 package.json

```bash
# 三个占位符要换成真实地址
# repository.url / bugs.url / homepage
# 目前是 <your-account> 占位
```

（告诉我账号名，我替你改完再提交。）

### 3. 推上去

```bash
cd D:/大肥鱼工作区/dsh-plugins/dsh-ask-aside
git remote add origin https://github.com/<你的账号>/dsh-ask-aside.git
git push -u origin master --tags
```

## 授权方式（三选一）

- **A. 我来推（推荐）**：你给一个只对这一个仓库有写权限的 fine-grained PAT（`Contents: Read and write`）。把它写进一个临时文件（比如 `D:\大肥鱼工作区\.gh-token`）告诉我路径，我用完立刻删掉，不写进 git 历史、不留在命令行里。
- **B. 你自己推**：照上面第 3 步，git 会弹浏览器/凭据框；Windows 凭据管理器记住后，以后 `git push` 不用再输。
- **C. 离线交接**：把 `dsh-ask-aside-v1.0.0.bundle` 拷到别的机器，`git clone dsh-ask-aside-v1.0.0.bundle` 之后再推。

## 可选：发 npm

DSH 插件市场按 npm 包名索引，想让别人 `plugin_manager install_bundle target=dsh-ask-aside` 直接装，就：

```bash
npm login          # 需要 npm 账号
npm whoami         # 确认登录
npm publish --access public
```

包名 `dsh-ask-aside` 目前没被占用（2026-11-15 查 registry 返回 404）。

## 已做的验证

- `node --check index.js` / `node --check lib/client.js` 通过；
- `node smoke-test.cjs`、`node render-test.cjs` 全绿；
- 本机 profile 已装着 1.0.0：`GET /dsh-ask-aside/api/status` → `version 1.0.0`，`/diag` 已 404（开发期自检路由清掉了）；
- 插件从本地 `link:` 安装可用：`plugin_manager set_bundle target=dsh-ask-aside enabled=true`。