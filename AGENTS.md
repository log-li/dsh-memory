# AGENTS.md — dsh-memory（`@log.li/dsh-memory`）

DSH 的长期记忆插件（**fork**）：markdown + git 记忆库 + 开机注入 + 分类/salience 衰减 + 迁移 CLI。

**设计真相见 spec**：`.plans/spec/dsh-memory-spec.md ` —— 改行为前先读它；改动偏离设计时**先改 spec**再继续写代码（全局「Spec 先行规则」）。

## 本 fork 的定位

- **上游**：[`LittleBlackTong/dsh-plugin-memory`](https://github.com/LittleBlackTong/dsh-plugin-memory) v0.6.0（MIT）——`git remote upstream` 已配好。
- **本 fork 只做「记忆」**（对齐 Claude Code 范式：常驻 = 规则 + 一行索引 + 热页一行；正文一律按需取；不做人格/persona），**数据面对上游保持 100% 兼容**（老记忆库直接可用；v0.8.0 起配置面主动收窄，见下）。
- 上游把记忆库本体做得很好（markdown + git + lint + 衰减），**这些不要重做**。

## 硬约束（违反即偏离 spec）

1. **数据面不动**：`<memoryDir>`（默认 `~/.dsh/memory`）的分类页与 `MEMORY.md` / `index.md` / `log.md` 格式保持上游兼容；老库里已有的 `SOUL.md` / `BOOTSTRAP.md` 是**普通页面**（可读可写可检索，但插件不再生成、不再注入、不再按它们判断"铸魂状态"）；**新派生文件必须可删可重建**（如 `index.boot.md`）。
2. **配置面：保留键语义不变、删除键被忽略**（v0.8.0 修订）：`enabled`/`memoryDir`/`autoInject`/`registerSkill`/`registerTools`/`indexBootMode`/`autoMemory` 语义稳定；已删除 `recall*`/`digestNudge*`/`deferUntilUserSpeaks`/`activeSessionOnly`（用户 2026-09-23 决定：这些 persona 侧特性与 CC 记忆范式不符）——残留键被忽略、不报错。新增键必须有安全默认值。
3. **命名四处一致**：`package.json` 的 `name` = profile `dependencies` 键 = `dsh.profile.bundles` 项 = `cordis.patch.yml` 的 `insert.name`。**`insert.name` 是 ESM 包解析名（= 依赖键 / 符号链接目录名），不一致即启动崩**（本机踩过）。
   **当前状态（2026-09-25）：本机 profile 已切到本 fork 并重启，四处命名一致**——切换时三处（依赖键 + `bundles` 项 + 符号链接/`pnpm-lock`）**一次改齐、不留新老并存窗口**（原因与后果见 spec §7）。**换注入层还必须同步改写「被注入的协议文件」**（如记忆库 `MEMORY.md` 里对已删除机制的承诺）——否则旧文本继续指挥模型；验证时要通读**模型实际读到的注入全文**，不能只 grep 插件源码（spec §7）。
4. **越界与查重**：`memory_read` / `memory_write` 的路径必须规范化后落在 `<memoryDir>` 内（否则拒绝）；写入前先查同主题页（提示"改旧页"而非新增）。
5. **profile 侧不要跑 `pnpm install`** 来改链接：会剪掉**只在 node_modules、不在 package.json/lock** 的 patch 注入型模块 → 启动 `module not found`。改链接＝手改三处（package.json / 符号链接 / pnpm-lock）。
6. **宿主兼容**：peer 范围自 `^0.1.2-alpha.1` 起；**升级到 `0.1.6+` 前必须先实测**（Session 日志 v4、presets 归插件组合包、settings 迁 profile 等破坏性变更）。**2026-09-25：本机宿主 0.1.7-rc.2 上已实测通过**（装载/注入/三工具/automemory；会话读取走宿主 session API，与磁盘日志格式无关）。

## 命令

```bash
npm test              # memory.mjs --self-test
npm run test:plugin   # node --test（8 个测试文件）
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
