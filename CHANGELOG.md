# Changelog

All notable changes to this project are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions track `package.json`.

## [0.8.0] - 2026-09-23

### Removed

- **The persona half of the plugin is gone.** Soul-bootstrap (the first-person "define who I am" directive, the `SOUL.md` / `BOOTSTRAP.md` templates and the "soul first, tasks later" instruction), proactive recall (the idle-time "I remember when…" line) and the digest reminder are all removed, together with the ten settings keys and the activity tracker behind them. This plugin is memory, not a persona: a fresh session gets the rules, the hot index and nothing else — a brand-new store no longer opens a "what should my name be?" conversation.
- **The two polite injection gates are gone** (`deferUntilUserSpeaks`, `activeSessionOnly`): memory is a stable part of every session instead of appearing once you speak. The one filter that remains is structural — only root sessions are injected, so subagents neither read nor write long-term memory.
- Keys left over in `memory.json` (`recall*`, `digestNudge*`, `deferUntilUserSpeaks`, `activeSessionOnly`) are ignored rather than rejected, and disappear from the file on the next settings write.

### Changed

- **Automemory is now on by default** (`autoMemory: true`): the silent end-of-turn extraction replaces the removed digest reminder. It still runs through the same engine as `memory_write` (duplicate check, version check, catalog row, optional log entry), still only twice per session and a few turns apart, and can be switched off in the Settings panel.
- `bootFiles` no longer includes `SOUL.md` by default. Persona files, if a store has them, are ordinary pages: readable, searchable, never resident.
- A store scaffolded by `dsh-memory init` now creates `MEMORY.md` / `index.md` / `log.md` plus the category directories — no persona templates.

## [0.7.0] - 2026-09-23

### Added

- **`memory_search` / `memory_read` / `memory_write` tools.** Sessions no longer have to remember a CLI incantation: search the store by keyword, read one page's body, and write it back. `memory_write` enforces the store's two-step write (duplicate check + version check), keeps the catalog's one-line row in sync, and commits; a new `registerTools` setting turns all three off.
- **`indexBootMode: derive` (default).** The resident catalog is now the `salience: 1` hot subset computed from `index.md` on the fly (one row per page, summaries compressed to fit the budget), so it is never truncated and the derived `index.boot.md` file is no longer required. Set it to `off` to inject the catalog verbatim.
- **Optional automemory (`autoMemory`, off by default).** When enabled, the end of an idle turn asks the model two questions — "is anything here worth remembering?" and "write the pages" — and writes through the same engine as `memory_write` (duplicate check, version check, catalog row, log entry). It only ever runs for the session you are actually using, at most twice per session and a few turns apart, stands down when the agent already wrote the store during that turn, and contains every failure. The Settings panel can pause it for the current session.

### Changed

- **Boot injection is now incremental.** The injected block is built from named parts and the plugin tracks what the session already has: an unchanged store injects nothing at all, and one edited file re-sends only that part ("the parts not listed are unchanged") instead of the whole snapshot. A session resumed in a new process keeps that behaviour — the parts it already holds are recorded with the block — and after a compaction the full block is injected again.
- Boot injection is delivered as a plugin message at the start of a step (a full block is a *snapshot* that supersedes the previous one; a partial update is a *notice* that supersedes nothing), replacing the system-prompt runtime-context contribution. Deployments that disable runtime context are therefore no longer silencing memory injection.
- `auto-commit` now reports what it did (`clean` / `waiting` / `committed` / `failed`), and `memory_write` passes that through instead of assuming success.

## [0.6.0] - 2026-09-09

### Added

- **`deferUntilUserSpeaks`** (default on): nothing (boot block, recall, digest reminder) is injected before the session's first real user message.
- **`activeSessionOnly`** (default on): only the live root agent that most recently received a user message is injected — background sessions are left alone.

### Fixed

- The first recall fired immediately: the next-recall timestamp started at 0, so the first idle check triggered. It now arms a random interval first.

## [0.5.2] - 2026-08-31

### Changed

- **DSH 0.1.2-alpha.1 support**: peer ranges for `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-system-prompt` widened to `^0.1.2-alpha.1`.
- Dropped the obsolete `@deepseek-ai/dsh-client-runtime` entry from `dsh.client.inject`.

## [0.5.1] - 2026-08-24

### Changed

- `CHANGELOG.md` is shipped inside the npm package.

## [0.5.0] - 2026-08-23

### Added (recall nudge)

- **Recall nudge**: when the conversation goes quiet, the agent surfaces — in its own voice — something it genuinely remembers about you or about the two of you (preferences, past events, open decisions, recent progress). Conversational only: it never writes the store and never invents a memory, drawing only on recent `log.md` entries.
- **Two triggers**: `turn-stopping` plus a 30-second poll, so a fully idle agent still speaks up.
- **Random interval** inside `[recallIntervalMinMinutes, recallIntervalMaxMinutes]`, so the cadence never feels metronomic.
- New settings, all hot-editable in the Settings panel: `recallEnabled` (default `true`), `recallIntervalMinMinutes` (30), `recallIntervalMaxMinutes` (240), `recallMaxPerSession` (3).

## [0.4.0] - 2026-08-19

### Added

- **Soul-bootstrap guidance**: while the store has no soul yet (`SOUL.md` missing or still a template, or `BOOTSTRAP.md` not complete), the boot block opens with a first-person directive that makes the agent start the soul-definition conversation on its own; the directive disappears at zero cost once the soul is complete. Legacy stores without `BOOTSTRAP.md` are judged by whether `SOUL.md` is filled.

## [0.3.0] - 2026-08-19

### Added (digest guard + auto-commit)

- **Digest guard**: per root agent, watches for the agent going idle while the store has not been written for a while (with cooldown and a per-session cap) and injects a synthetic reminder; writing the store clears it.
- **Auto-commit**: polls `git status` and commits after the store has been quiet for the configured period, flushing pre-existing dirty state at startup; a store without `.git` is skipped.

### Changed

- CLI `status` reports the last log write (digest freshness).

### Fixed

- Auto-commit never started on the first rebuild (wiring bug in the create condition), caught by a new regression test.

## [0.2.1] - 2026-08-18

### Changed

- **Settings panel no longer uses a settings namespace**: the web settings wire serves a hard-coded allowlist, so a plugin namespace is rejected. The plugin now keeps its own JSON config file plus a `GET/POST /api/memory/config` route, applied hot on write.
- **Installable from the market**: ships a `dsh.bundle` manifest plus a root `cordis.patch.yml`, so `dsh plugin add` / dsh-market can mount it.

## [0.2.0] - 2026-08-18

### Added

- **Settings-panel section** for `enabled` / `memoryDir` / `autoInject` / `registerSkill`, hot-applied.

## [0.1.1] - 2026-08-18

### Fixed

- Cordis metadata (name / inject / Config) is attached to the default export so the loader cannot lose it.

## [0.1.0] - 2026-08-18

### Added

- Karpathy *LLM Wiki*-style long-term memory: mandatory boot injection, an embedded `memory` skill, a portable CLI (`init` / `search` / `lint` / `status` / `pack` / `unpack`) and scaffolding templates.
- The store itself: `SOUL.md` / `MEMORY.md` / `BOOTSTRAP.md`, category pages (`identity/ user/ skills/ decisions/ projects/ concepts/`), `index.md` and `log.md` — plain markdown + git, migratable.

---

# 更新日志（Changelog）

所有记录跟随 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

## [0.8.0] - 2026-09-23

### Removed（persona 半边整体删除）

- **删掉铸魂/人格那一半**：第一人称「先定义我是谁」引导词、`SOUL.md` / `BOOTSTRAP.md` 模板、「铸魂优先于任务」的指令、主动追忆（空闲时第一人称提往事）、防懒 digest 提醒，连同它们背后的 10 个配置键与 activity-tracker 一起删除。本插件只做记忆、不做人格：新会话只拿到规则 + 热页索引，**空库也不再开口问「我该叫什么名字」**。
- **删掉两道礼貌注入闸门**（`deferUntilUserSpeaks`、`activeSessionOnly`）：记忆成为每个会话的稳定组成部分，而不是"你开口后才出现"。唯一保留的过滤是结构性的——**只给 root 会话注入**，子代理既不读也不写长期记忆。
- `memory.json` 里残留的旧键（`recall*`、`digestNudge*`、`deferUntilUserSpeaks`、`activeSessionOnly`）被忽略而不是报错，下次保存配置时自动消失。

### Changed

- **automemory 改为默认开**（`autoMemory: true`）：用静默的轮末抽取取代被删掉的催记提醒。仍然走与 `memory_write` 同一套引擎（查重 + 版本校验 + index 一行 + 可选 log 条目）、仍然每会话最多 2 次且间隔若干轮，随时可在设置面板关掉。
- `bootFiles` 默认不再包含 `SOUL.md`。老库里若有人格文件，它们就是普通页面：可读、可检索、永不常驻。
- `dsh-memory init` 现在只创建 `MEMORY.md` / `index.md` / `log.md` 与分类目录，不再生成人格模板。

## [0.7.0] - 2026-09-23

### Added（注入与检索层改造）

- **新增 `memory_search` / `memory_read` / `memory_write` 三个模型可见工具**：关键词检索记忆页 → 读一页正文（返回写回用的 `version` 令牌）→ 两步写回。`memory_write` 机器强制查重与版本校验，并自动更新 `index.md` 那一行、重生成派生热页子集、触发 git 提交；`registerTools` 可整体关闭。
- **新增 `indexBootMode`（默认 `derive`）**：常驻索引改为从 `index.md` 现算的 `salience: 1` 热页子集（一行一条、摘要按预算压缩），**永不被截断**，也不再需要外置派生文件 `index.boot.md`；设为 `off` 则按原文注入整份索引。
- **新增可选 automemory（`autoMemory`，默认关）**：开启后，每轮空闲结束时会用模型两阶段判断本会话是否值得写入长期记忆，值得才写——且走与 `memory_write` **同一套引擎**（查重 + 版本校验 + 自动维护 index 一行 + log 条目）。它只对当前激活会话生效、每会话限次且需间隔若干轮、agent 本轮已自己写库就让位、失败只记日志不打断会话；设置面板可「本次会话暂停自动记忆」。

### Changed

- **boot 注入改为条目级增量**：注入块由命名段落组成，插件按段落记账——记忆没变时**什么都不注入**，变了一段就**只重发那一段**（并声明「未列出的段落仍然有效」），不再整块重发。会话在新进程里恢复时同样只补变化段（注入消息记录了段落清单）；压缩导致基线消失时才重发整块。
- 注入形态改为**步骤开始时的 plugin 消息**（整块是取代前一份的 *snapshot*，增量是不取代任何东西的 *notice*），不再走系统提示词的运行时上下文；因此关掉运行时上下文的部署不再连记忆注入一起静默关掉。
- `auto-commit` 如实回报结果（`clean` / `waiting` / `committed` / `failed`），`memory_write` 把它原样告知模型，不再假定提交成功。

## [0.6.0] - 2026-09-09

### Added（两道礼貌闸门：提问后才注入 + 只注入激活会话）

- **`deferUntilUserSpeaks`**（默认开）：会话收到第一条真实用户消息（`source.kind === 'user'`）前，boot 块、主动追忆、digest 提醒一律不注入——杜绝「开了会话啥也没问就自动蹦提示词」。
- **`activeSessionOnly`**（默认开）：只对「最近收到用户消息的 live root agent」注入，后台 / 未展开会话不再被追忆或 digest 提醒打扰。
- 新增 `lib/activity-tracker.js`：per-agent 状态表（`hasUserSpoken` + 最近用户消息次序），三个注入点共用同一 `shouldInject` 谓词，口径一致。

### Fixed

- 主动追忆首拍立即开火：`nextRecallAt` 初始值为 0 → 第一次 idle 检查就触发。改为「首个满足条件的空闲时刻先 arm 间隔，再等一个随机间隔后才开口」。

## [0.5.2] - 2026-08-31

### Changed

- **适配 DSH 0.1.2-alpha.1**：`@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-system-prompt` 的 peerDependencies 从 `^0.1.0-rc.6` 放宽到 `^0.1.2-alpha.1`（`^0.1.0-rc.6` 无法匹配 prerelease 的新版宿主）。
- 移除 `dsh.client.inject` 里已废弃的 `@deepseek-ai/dsh-client-runtime`（新版宿主已合并进 `dsh-client-modules`，且本插件客户端半只依赖 `react` 平台种子模块）。

## [0.5.1] - 2026-08-24

### Changed

- 包内新增 `CHANGELOG.md` 并纳入 npm 发布文件（`files` 加 `CHANGELOG.md`），随发布携带版本说明。

## [0.5.0] - 2026-08-23

### Added（拟人化：主动追忆 recall-nudge）

- **主动追忆**：对话空下来时，agent 以第一人称主动提起一件**真实记得**的、关于你或你们之间的事——偏好、往事、未了的决定、最近的进展，像老友自然想起那样。纯对话、不写库、**绝不编造**，只从 `log.md` 最近条目取真实引子。
- **双触发**：`turn-stopping`（聊完一句立即检查）+ **30s 轮询定时器**（纯空闲也能到点开口）。
- **随机间隔**：每次追忆后在 `[最短, 最长]` 分钟内随机取下一个时间点，节奏不机械。
- **新增配置（全部进设置面板，热改即生效）**：

  | 配置项 | 默认 | 含义 |
  |---|---|---|
  | `recallEnabled` | `true` | 主动追忆总开关 |
  | `recallIntervalMinMinutes` | `30` | 随机间隔下限（分钟） |
  | `recallIntervalMaxMinutes` | `240` | 随机间隔上限（分钟） |
  | `recallMaxPerSession` | `3` | 每会话最多追忆次数 |

### Fixed

- 首版主动追忆只挂 `turn-stopping`，agent 纯空闲（用户静默等待）时永远不触发 → 补 **30s 轮询定时器**解决。

## [0.4.0] - 2026-08-19

### Added

- **铸魂自动引导（soul-bootstrap）**：记忆库为空（`SOUL.md` 缺失、仍含占位符，或 `BOOTSTRAP.md` 状态非 complete）时，boot 块在头部前置**第一人称引导词**（六步清单），由 agent **主动发起**灵魂定义对话，而不是等用户喂消息；complete 后引导词自动消失、零开销；无 BOOTSTRAP 的旧库以 SOUL 是否已填为准。

## [0.3.0] - 2026-08-19

### Added（防懒双保险）

- **digest guard**：per-root-agent 监听 `agent/turn-stopping`，判断「agent 空闲 + `log.md`/`index.md` 超时未写 + 冷却 + 每会话限次」后，用 `agent.followup()` 注入 plugin 源提醒。写回记忆（mtime 刷新）即解除。
- **auto-commit**：轮询 `git status`，dirty 从首次发现起静默 `quiet` 秒后 `git add -A` + commit；启动时先 flush 存量脏数据；无 `.git` 跳过。

### Changed

- CLI `status` 新增报告最近一次 log write（digest 新鲜度）。
- 措辞强化四处：boot header、内嵌技能、scaffold `MEMORY` 模板、`.dsh/skills/memory/SKILL.md`，把 digest 定为**硬义务**。

### Fixed

- auto-commit 接线 bug：`rebuild()` 里 committer 创建条件写错（`memoryDir !== currentMemoryDir`，首次重建恒 false）→ 改为 `committer === undefined || memoryDir !== currentMemoryDir`；新增接线回归测试。

## [0.2.1] - 2026-08-18

### Changed

- **设置面板弃 settings namespace**：web settings wire 有硬编码白名单（`WEB_SETTINGS_NAMESPACES`），插件 namespace 一律 `settings-not-exposed` 拒绝读写 → 改为**自建配置通道**（JSON 配置文件 + `GET/POST /api/memory/config` 路由），写入即热应用。
- **可安装/可上架**：声明 `dsh.bundle` manifest + 仓库根 `cordis.patch.yml`（含 `dsh.bundle.patch`），可通过 `dsh plugin add` / dsh-market 安装；npm tarball 含 `cordis.patch.yml`（市场安装的硬前提）。
- README 安装方式改为以 `dsh plugin add` 为主，删掉「手动 insert」路径（防 manifest 与手写双轨）。

## [0.2.0] - 2026-08-18

### Added

- **设置面板「记忆 Memory」区块**：`enabled` / `memoryDir` / `autoInject` / `registerSkill` 开关与配置，热改即生效（boot 注入、技能注册随修改立即生效）。

## [0.1.1] - 2026-08-18

### Fixed

- 保留 Cordis 元数据挂在默认导出上（`Object.defineProperties(apply, { name, inject, Config })`），避免 loader 元数据丢失。

## [0.1.0] - 2026-08-18

### Added（插件本体）

- Karpathy *LLM Wiki* 式长期记忆：**boot 强制注入**（`systemPrompt.context`）+ **内嵌 memory 技能**（`skills.register`）+ **便携 CLI**（`init` / `search` / `lint` / `status` / `pack` / `unpack`）+ 脚手架模板。
- 记忆库结构：`SOUL.md` / `MEMORY.md` / `BOOTSTRAP.md` + 分类页目录（`identity/ user/ skills/ decisions/ projects/ concepts/`）+ `index.md` + `log.md`，纯 markdown + git，可迁移。
- 仓库链接（repository / bugs / homepage）指向真实 GitHub，README 徽章/安装/路线图完善。
