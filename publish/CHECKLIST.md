# 商店收录清单（dsh-ask-aside）

> 目标：awesome-dsh-plugin 清单收录 → dshmarket 插件市场展示。
> 规则来源：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `contributing.md`（2026-11 版，已核实）。

## 硬门槛（CI 自动检查）

| 条件 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch`，根目录有 `cordis.patch.yml` | ✅ |
| 仓库有真实可运行代码（不是占位/纯 README） | ✅（发布 1.0.0 到 npm） |
| 仓库创建满 **1 天** | ⏳ 2026-11-15 18:32 建仓（= 10:32 UTC）→ **2026-11-16 18:32（本地）之后**才能提 |
| 仓库带 `dsh-plugin` topic | ✅ |
| PR 只加一个文件 `data/plugins/AZ-666316__dsh-ask-aside.yml` | 待提 |
| 描述属实、无营销词、含 `: ` 要加引号 | ✅（已按此写） |
| 分类贴合（本插件 = `ui`） | ✅ |

## 提 PR 步骤

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`（GitHub 网页或 API）；
2. 在 fork 上新建分支，例：`add-ask-aside`；
3. 新增文件 `data/plugins/AZ-666316__dsh-ask-aside.yml`，内容 = 本仓库 `publish/awesome-entry.yml`；
4. 提交信息例：`Add AZ-666316/dsh-ask-aside`；
5. 向上游 `main` 发 PR，标题 `Add AZ-666316/dsh-ask-aside`，正文 = `publish/PR_BODY.md`；
6. 等 CI 绿（会检查 manifest / 仓库年龄 / YAML 格式 / README 能重新生成）；
7. 维护者 review 时会真的装插件看效果，可能会问实现细节。

**不要**手工改两个 README（由 `scripts/generate-readme.mjs` 从 `data/plugins/*.yml` 生成）。

## 收录之后

- 市场与站点自动刷新（通常 1 天内）。
- 之后每次发版：npm 发布 + GitHub Release（tag `vX.Y.Z`）；条目不需要改，除非能力/描述变了。
- 定期扫描会清理长期停更、归档、消失的仓库 —— 保持提交即可。

## 这次没做的

- 没做 96px 方形图标（`icon:` 可选，不写就回退到 GitHub 头像）。要做的话放 `assets/icon-180.png` 并把 `icon:` 加进 yml。
- 没跑本地 `node scripts/generate-readme.mjs` 预览（不需要，PR 只加数据文件）。