# AGENTS.md — dsh-memory（`@log.li/dsh-memory`）

DSH 的长期记忆插件（**fork**）：markdown + git 记忆库 + 开机注入 + 分类/salience 衰减 + 迁移 CLI。

**设计真相见 spec**：`.plans/spec/dsh-memory-spec.md ` —— 改行为前先读它；改动偏离设计时**先改 spec**再继续写代码（全局「Spec 先行规则」）。

## 本 fork 的定位

- **上游**：[`LittleBlackTong/dsh-plugin-memory`](https://github.com/LittleBlackTong/dsh-plugin-memory) v0.6.0（MIT）——`git remote upstream` 已配好。
- **本 fork 只改「注入与检索层」**（对齐 Claude Code 范式：常驻 = 规则 + 一行索引；正文一律按需取），**数据面与配置面对上游保持 100% 兼容**（老记忆库直接可用）。
- 上游把记忆库本体做得很好（markdown + git + lint + 衰减），**这些不要重做**。

## 硬约束（违反即偏离 spec）

1. **数据面不动**：`<memoryDir>`（默认 `~/.dsh/memory`）的目录结构与 `SOUL.md` / `MEMORY.md` / `index.md` / `log.md` 格式保持上游兼容；**新派生文件必须可删可重建**（如 `index.boot.md`）。
2. **配置面不动**：`<dshHome>/memory.json` 既有键（`enabled`/`memoryDir`/`autoInject`/`deferUntilUserSpeaks`/`activeSessionOnly`/`registerSkill`/`recall*`）语义不变；新增键必须有安全默认值。
3. **命名四处一致**：`package.json` 的 `name` = profile `dependencies` 键 = `dsh.profile.bundles` 项 = `cordis.patch.yml` 的 `insert.name`。**`insert.name` 是 ESM 包解析名（= 依赖键 / 符号链接目录名），不一致即启动崩**（本机踩过）。
   **当前状态（2026-09-23）**：profile 侧仍指上游 npm 版（`dsh-plugin-memory`），所以此约束在**切换前**只对包内三处成立；**切换时必须一次改齐三处，不留新老并存窗口**（原因与后果见 spec §7）。
4. **越界与查重**：`memory_read` / `memory_write` 的路径必须规范化后落在 `<memoryDir>` 内（否则拒绝）；写入前先查同主题页（提示"改旧页"而非新增）。
5. **profile 侧不要跑 `pnpm install`** 来改链接：会剪掉**只在 node_modules、不在 package.json/lock** 的 patch 注入型模块 → 启动 `module not found`。改链接＝手改三处（package.json / 符号链接 / pnpm-lock）。
6. **宿主兼容**：peer 范围自 `^0.1.2-alpha.1` 起；**升级到 `0.1.6+` 前必须先实测**（Session 日志 v4、presets 归插件组合包、settings 迁 profile 等破坏性变更）。

## 命令

```bash
npm test              # memory.mjs --self-test
npm run test:plugin   # node --test（10 个测试文件，100 条）
npm run lint:memory   # dsh-memory lint：查重复/孤儿/该归档
```

## 与上游同步

```bash
git fetch upstream && git merge upstream/main
```
冲突集中在 `lib/*`（正是我们改动的地方）。**若上游改了 `cordis.patch.yml` 的 `insert.name`，必须改回 `@log.li/dsh-memory`**。

## 质量门禁（遵循全局规则）

**写代码 → 独立模型家族 review → 按 review 修正 → 验证 → commit → push**（review 必须在验证之前）。
- `src/lib` 代码改动**必审**；纯文档/格式小改可豁免。
- commit 前：**README 是否需同步**（行为/配置/命令变化必查）+ **隐私自查**（本仓库是通用代码：不得出现本机绝对路径、用户名、具体模型名、内网地址）。
- 发布前：CHANGELOG **双语**（上半英文 / 下半中文，同一文件），条目只写"变化了什么、对使用者意味着什么"——见 skill `changelog-writing`。
