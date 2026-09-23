> **本仓库是 fork**：`@log.li/dsh-memory`，fork 自 [`LittleBlackTong/dsh-plugin-memory`](https://github.com/LittleBlackTong/dsh-plugin-memory)（MIT，2026-09-23）。
> 本 fork **只改注入与检索层**——对齐 Claude Code 范式（常驻 = 规则 + 一行索引，正文一律按需取），
> **数据面与配置面对上游保持兼容**（老记忆库直接可用，换装不迁移）。设计真相与路线见 [`.plans/spec/dsh-memory-spec.md`](.plans/spec/dsh-memory-spec.md)。
> 本机安装：profile 的 `dependencies` 与 `dsh.profile.bundles` 用 `@log.li/dsh-memory`，值写 `link:<本仓库路径>`。

# dsh-memory（`@log.li/dsh-memory`）

<p align="center">
  <a href="https://github.com/LittleBlackTong/dsh-plugin-memory"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-LittleBlackTong%2Fdsh--plugin--memory-blue?logo=github"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-memory"><img alt="npm" src="https://img.shields.io/npm/v/dsh-plugin-memory?label=upstream%20npm&logo=npm"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-green">
</p>

> DeepSeek Harness 长期记忆插件：跨会话、可迁移、带「灵魂」的 markdown 记忆库。

**English TL;DR** — A Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that gives agents a persistent, cross-session, migratable long-term memory: a markdown + git store (inspired by Karpathy's *LLM Wiki* pattern) with a `SOUL.md` persona file, **auto-injected at every session start**, plus `memory_search` / `memory_read` / `memory_write` tools that fetch and update pages on demand. The resident block is deliberately small — rules plus a one-line-per-row index of the hot pages — and it is re-sent **part by part**: an unchanged store costs nothing, one edited file re-sends only that part.

## 特性

- **开机强制注入**：插件在会话每一步前置一条 plugin 消息，把记忆 boot 块（`SOUL.md` 人格 + `MEMORY.md` 协议 + **热页索引** + 最近动态）送进上下文——这是"新会话必先加载记忆"的**硬保障**，不需要模型碰运气调技能。默认还带**两道礼貌闸门**：`deferUntilUserSpeaks`（用户开口后才注入）与 `activeSessionOnly`（只注入当前激活会话），见「配置」。
- **`indexBootMode: derive`（默认）· 常驻索引只放热页**：`index.md` 里 `salience: 1` 的页才进常驻块（一行一条、摘要按预算压缩），**永不被截断**；冷页正文与完整目录一律按需取——「先看索引行、再钻正文」这条链因此不再断裂。旧记忆库（整份 index 或外置 `index.boot.md`）都直接可用。
- **条目级增量注入**：boot 块按命名段落（header / 铸魂引导 / 各 boot 文件 / log 尾部）渲染，插件记住"模型手上是哪些段落"——记忆没变则**什么都不发**；变了一段就只重发那一段（`form: 'notice'`，明确「未列出的段落仍然有效」）；压缩/重启后基线丢失则重发整块。整块更新只在首次注入或基线失效时发生。
- **三个记忆工具（工具闭环）**：`memory_search` 关键词定位 → `memory_read` 取正文（返回 `version` 令牌）→ `memory_write` 两步写回（查重 + `ifVersion` 乐观并发 + 自动维护 `index.md` 一行 + 重生成派生热页子集 + 触发 git 提交）。记忆写入不再靠模型手改索引文件；设置面板可整体关掉（`registerTools`）。
- **SOUL.md 铸魂**：安装后首要任务是和用户对话定义灵魂（名字、性格、价值观、语气、边界）、确认身份与关系（`BOOTSTRAP.md` 清单驱动，complete 前优先于常规任务）。
- **铸魂自动引导**：记忆库还没有灵魂（`BOOTSTRAP.md` 非 complete，或 `SOUL.md` 仍是占位模板）时，boot 块会自动前置一段第一人称引导词——「我的首要任务是确认我是谁，还有你是谁：我叫什么名字、怎么称呼你、你我是什么关系、我该是什么样的性格」——像 OpenClaw 初始化那样，**由 agent 在对话里主动发起铸魂**，逐项问、逐项写回，而不是等用户来喂。铸魂完成后引导词自动消失，零开销。
- **复利记忆**：遵循 Karpathy 的 *LLM Wiki* 约定——记忆是"一次编译、持续保鲜"的持久产物，不是每次查询重新 RAG。remember / recall / consolidate / forget 四操作 + salience 三级衰减。
- **可迁移**：记忆本体是纯 markdown + git + 自描述 schema，任何能读 markdown 的 agent 都能接手。`dsh-memory pack/unpack` 打包迁移。
- **内嵌技能**：通过 `ctx.skills.register()` 注册 `memory` 技能（操作协议随插件分发）；项目级 `.dsh/skills/memory` 文件技能仍可覆盖它。
- **可选：会话收尾自动抽取记忆（automemory，默认关）**：开启后，每轮结束（空闲）时用模型两阶段判断「本会话有没有值得长期保存的内容」——值得才写，且走与 `memory_write` **同一套引擎**（查重 + 版本校验 + 自动更新 index 一行 + log 条目）。护栏：只对当前激活会话、每会话限次、需间隔若干轮、agent 本轮自己已写库就让位、一切失败只记日志不打断会话；设置面板另有「本次会话暂停自动记忆」。**默认关闭**——这是唯一会自动改写记忆库的路径。
- **防懒 digest 唤醒**：每轮结束后，若 agent 空闲且记忆库超过 `digestNudgeAfterMinutes` 未写入，插件注入一条 digest 提醒（合成消息，走 `agent.followup`），把"会话收尾沉淀"从靠自觉变成有机制兜底；带冷却与每会话限次，不骚扰。**独立于 dsh-plugin-heartbeat**，两插件各自可装、互不依赖。
- **主动追忆（拟人化）**：对话空下来时，插件会以第一人称主动提起一件**真实记得**的、关于用户或你们之间的事（偏好、往事、未了的决定、最近的进展），把记忆从"只写回"变成"也用起来"——像老友自然想起那样，而非报状态。间隔在最短/最长之间**随机取值**（不固定节奏），配合每会话限次，不骚扰、不编造、不硬聊；纯对话行为，不写记忆库。**同样独立于 heartbeat**。
- **git 自动提交**：记忆库变更静默 `autoCommitQuietSeconds` 后自动 `git add -A && git commit`（无 `.git` 则跳过）——历史可回滚不再依赖 agent 记得 commit。
- **设置面板**：在 DSH 设置页提供「记忆 Memory」区块——总开关、记忆目录、开机注入、常驻索引分层、技能注册、工具注册、主动追忆（开关 + 随机间隔范围 + 每会话次数）均可热改，立即生效，无需重启。
- **零构建**：纯 ESM JavaScript，无编译步骤，`pnpm add` 即用。

## 架构

插件只拥有**工作流**，不拥有**数据格式**：

```
@log.li/dsh-memory（本插件）
├── lib/index.js        # Cordis 入口：boot 注入 + 技能/工具注册 + settings 热改
├── lib/boot.js         # boot 块渲染（命名段落：header/SOUL/MEMORY/热页索引/log 尾部）
├── lib/injector.js     # 条目级增量注入（全量快照 → 增量通知 → 压缩/重启补注入）
├── lib/index-format.js # index.md 解析：行解析 / 热页子集派生 / 一行 upsert
├── lib/pages.js        # 记忆页读写引擎：检索 / 读取 / 两步写入 / 派生与日志
├── lib/tools.js        # 三个模型可见工具（memory_search / read / write）
├── lib/automemory.js   # 可选 automemory：轮末两阶段抽取，走同一套写入引擎（默认关）
├── lib/tool-schema.js  # 工具参数 JSON Schema 子集 + 校验（不引入宿主 tools 包）
├── lib/activity-tracker.js # 两道礼貌闸门：用户是否开口 + 当前激活会话
├── lib/digest-guard.js # 防懒 digest 唤醒（空闲 + 记忆库久未写 → followup 提醒）
├── lib/recall-nudge.js # 主动追忆（空闲 → 第一人称提起一件真实往事，纯对话不写库）
├── lib/scaffold.js     # 记忆库脚手架（模板只建不覆盖）
├── lib/client.js       # 客户端半：设置面板「记忆 Memory」区块
├── skills/memory.md    # 内嵌技能的操作协议正文
└── scripts/memory.mjs  # CLI：init/search/lint/status/pack/unpack

记忆库（用户数据，默认 ~/.memory）
├── SOUL.md       # 人格与灵魂（用户主导）
├── BOOTSTRAP.md  # 铸魂清单（complete 前优先）
├── MEMORY.md     # schema 与维护协议（自描述）
├── index.md      # 页面目录    log.md # 时间线（append-only）
├── identity/ user/ skills/ decisions/ projects/{active,archive}/ concepts/
└── raw/          # 不可变源材料
```

## 安装

```sh
# 本 fork 用 link 接入本地 checkout（不要把 npm 上的同名上游包装进来）：
#   1) profile 的 package.json：dependencies 加 "@log.li/dsh-memory": "link:<本仓库路径>"，bundles 加 "@log.li/dsh-memory"
#   2) 重建 node_modules 符号链接（勿跑 pnpm install，见 AGENTS.md）
dsh plugin --profile <profile> add @log.li/dsh-memory
```

（包内置 `dsh.bundle` manifest，`dsh plugin add` 会把它自动挂进 profile 的 bundles 层；dsh-market 里的一键安装同此通道。）

重启 profile（DSH Desktop 重启应用）后生效。

> ⚠️ **不要**再往 profile 的 `cordis.patch.yml` 里手写 `- insert: {id: dsh-memory, ...}`：
> 那会与 bundle manifest 的自动挂载产生两条同名 entry，整个 profile 会以
> `duplicate loader entry id "dsh-memory"` 启动失败（2026-08-18 实机事故）。
> 运行期配置（enabled / memoryDir / autoInject / registerSkill / recallEnabled）改走
> `<dshHome>/memory.json`（设置面板热改）；composition 配置见下表。
> 如需覆盖某个 composition 键，用**不带 insert 的 id 覆盖条目**（见配置一节）。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关：关闭后不注入 boot 块、不注册 `memory` 技能与记忆工具 |
| `memoryDir` | `~/.memory` | 记忆库绝对路径（`~` 自动展开） |
| `bootFiles` | `[SOUL.md, MEMORY.md, index.md]` | 开机注入的段落（`index.md` / `index.boot.md` 走热页子集，见 `indexBootMode`） |
| `bootMaxChars` | `6000` | boot 块总字符预算（按段落数平分到每个段落） |
| `indexBootMode` | `derive` | `derive`：`index.md` 只注入 `salience: 1` 热页子集（永不截断）；`off`：按原文注入整份索引 |
| `registerTools` | `true` | 注册 `memory_search` / `memory_read` / `memory_write`（宿主没有 tools 服务时自动跳过） |
| `autoMemory` | `false` | 会话收尾自动抽取记忆总开关（面板可热改） |
| `autoMemoryMaxPerSession` | `2` | 每个会话最多自动抽取几次 |
| `autoMemoryMinTurnsBetweenRuns` | `3` | 两次自动抽取之间至少间隔几轮 |
| `autoMemoryMinTranscriptChars` | `200` | 会话文本（用户+助手）短于此值就不抽取（避免碎片写入） |
| `autoMemoryMaxPages` | `3` | 单次最多写几页 |
| `autoMemoryProvider` / `autoMemoryModel` | 未设 | 指定抽取用的模型路由；不设则用会话自身的路由 |
| `autoMemoryMaxTokens` / `autoMemoryTimeoutMs` | `2000` / `60000` | 单次调用的输出上限与超时 |
| `autoInject` | `true` | 会话开始时注入 boot 块 |
| `deferUntilUserSpeaks` | `true` | 用户发出第一条真实消息后才注入（boot 块 / 追忆 / digest 提醒都遵守）；面板可热改 |
| `activeSessionOnly` | `true` | 只对「当前激活会话」（最近收到用户消息的会话）注入，后台会话不打扰；面板可热改 |
| `registerSkill` | `true` | 注册内嵌 `memory` 技能 |
| `scaffold` | `true` | 记忆库缺失时自动创建模板（只建不覆盖） |
| `configFile` | `<dshHome>/memory.json` | 用户可改配置的 JSON 文件路径（设置面板读写它） |
| `digestNudgeEnabled` | `true` | 防懒 digest 提醒总开关（composition） |
| `digestNudgeAfterMinutes` | `120` | 记忆库超过多久未写入就提醒 |
| `digestNudgeCooldownMinutes` | `180` | 两次提醒的最小间隔 |
| `digestNudgeMaxPerSession` | `2` | 每个会话最多提醒次数 |
| `recallEnabled` | `true` | 主动追忆总开关（面板可热改） |
| `recallIntervalMinMinutes` | `30` | 随机间隔下限（分钟，面板可热改） |
| `recallIntervalMaxMinutes` | `240` | 随机间隔上限（分钟，面板可热改） |
| `recallMaxPerSession` | `3` | 每个会话最多追忆次数（面板可热改） |
| `autoCommit` | `true` | 记忆库 git 自动提交开关（composition） |
| `autoCommitQuietSeconds` | `60` | 变更静默多久后提交（防抖） |
| `autoCommitIntervalSeconds` | `60` | 变更轮询间隔 |

### 设置面板（热改）

`enabled` / `memoryDir` / `autoInject` / `indexBootMode` / `registerSkill` / `registerTools` / `autoMemory` / `deferUntilUserSpeaks` / `activeSessionOnly` / `recallEnabled` / `recallIntervalMinMinutes` / `recallIntervalMaxMinutes` / `recallMaxPerSession` 十三项在 DSH 设置页的「记忆 Memory」区块中可改（另有「本次会话暂停自动记忆」，由插件自己的 `/api/memory/automemory` 路由按**当前激活会话**读写），**即时生效**：boot 注入、常驻索引分层、两道礼貌闸门、技能与工具注册、主动追忆（含随机间隔与次数）随修改立即生效；记忆目录切换时自动为新目录初始化脚手架（`scaffold: true` 时）。其余键（`bootFiles` / `bootMaxChars` / `scaffold` / `configFile` / `digestNudge*` / `autoCommit*` / `autoMemoryMaxPerSession` / `autoMemoryMinTurnsBetweenRuns` / `autoMemoryMinTranscriptChars` / `autoMemoryMaxPages` / `autoMemoryProvider` / `autoMemoryModel` / `autoMemoryMaxTokens` / `autoMemoryTimeoutMs`）只在 composition 配置层生效，改完需重启。

> **「当前激活会话」怎么判？** DSH 宿主侧没有「浏览器当前聚焦的会话」信号（激活会话是前端概念）。插件用**最近一次收到真实用户消息的 live root agent**作为激活会话的代理：你在哪个会话里说话，哪个会话就激活；切到别处但不发消息时，宿主感知不到「切换」这个动作（这是代理的已知边界）。若日后需要精确到「展开/聚焦」级别，需补一小段客户端 focus 上报。

覆盖 composition 键（例如把 boot 块预算调大），在 profile 的 `cordis.patch.yml` 里写**不带 `insert` 的 id 覆盖条目**：

```yaml
- id: dsh-memory
  config:
    bootMaxChars: 12000
```

> 实现说明：DSH 的 settings wire 只服务硬编码的命名空间白名单，插件命名空间写不进去，因此本插件走自建通道——配置存 `<dshHome>/memory.json`（schema 校验 + 原子落盘），由插件自注册的 `GET/POST /api/memory/config` 路由服务，客户端区块 fetch 直连。

## 首次使用：铸魂

插件安装后，第一次会话里 agent 的首要任务**不是干活**，而是与你对话定义它的灵魂：名字、性格、价值观、语气、边界，以及你的身份与你们的关系。逐项确认并写回 `SOUL.md` / `user/profile.md`，直到 `BOOTSTRAP.md` 的 `status` 变为 `complete`。你可以随时跳过或暂缓。

## 注入与检索（改造后的注入层）

```
常驻（每次会话）        按需（模型自己取）
─────────────────       ────────────────────────────────────────
header 规则段            memory_search  → 关键词定位（标题/路径/正文）
SOUL.md                  memory_read    → 取一页正文（含 version 令牌）
MEMORY.md 协议           memory_write   → 两步写回 + index 一行 + git 提交
index.md 的 salience=1 热页（一行一条）
log.md 末尾 5 条
```

- **首轮**：一条 `form: 'snapshot'` 消息（契约：同一 producer 的后续快照取代它）承载整块。
- **之后**：只发**变化段落**，`form: 'notice'`（"刚发生了什么"、不取代任何东西），并声明「未列出的段落仍然有效」；没变化就一条都不发。
- **压缩 / 新进程**：注入消息逐段落记录了"这一份里有什么"，所以**新进程恢复会话时也只补变化段**；只有基线真的不在可见面上了（压缩）才重发整块——宁可多花一次，也不让模型拿着过期记忆。

## 四个操作

- **remember（记）**：把值得持久化的内容蒸馏成页面——用 `memory_write`（它负责 `index.md` 那一行、派生热页子集与 git 提交），不要手改索引。
- **recall（忆）**：会话开始读 boot 块；查询时 `memory_search` 定位 → `memory_read` 取正文；需要完整目录时读 `index.md`；shell 里可用 `dsh-memory search`。
- **consolidate（整理）**：`dsh-memory lint` 查矛盾、孤儿页、该归档的冷页。
- **forget（忘）**：显式遗忘立即执行；自动衰减按 salience + last_access（冷页优先归档）。

## CLI

```sh
dsh-memory init [dir]                 # 创建记忆库脚手架
dsh-memory search <query>             # 全文检索
dsh-memory lint                       # 完整性体检
dsh-memory status                     # 健康概览
dsh-memory pack [out.tar.gz]          # 打包导出（含 manifest）
dsh-memory unpack <archive> [--force] # 从归档恢复
```

存储定位顺序：`$MEMORY_DIR` → `./.memory`（存在时）→ `~/.memory`。

## 迁移

记忆库是纯 markdown + git：拷贝即迁移。跨机器 / 跨 agent / 能力降级档位见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## 常见问题

**Q：和手写的 `.dsh/skills/memory` 文件技能（skill 版）什么关系？**
skill 版是"软保障"（技能目录只注入简介，正文靠模型主动加载）；本插件是"硬保障"（boot 块随系统提示词运行时上下文自动注入）。两者可共存：文件技能（rank 100）会覆盖插件内嵌技能（rank 250）的协议。如果你之前为了软保障改过系统提示词 persona（如 profile 补丁里的开机指令），装上本插件后建议**移除那段 persona**，避免双份注入。

**Q：boot 块会不会每次请求都重复注入、烧 token？**
不会。块被拆成命名段落分别记账：记忆不变时**一条消息都不发**；变了一段就只重发那一段（几百字符），而不是整块（数 KB）。只在首次注入、压缩导致基线丢失、或进程重启后源文件又变了的时候才重发整块。

**Q：为什么常驻索引只放热页？冷页会不会「丢」？**
不会丢：`index.md` 始终是完整目录，`memory_search` 检索所有页面正文，`memory_read` 随时能取。常驻块是"我知道有哪些页"的地图，因此只放最常需要的 `salience: 1` 热页——原来整份索引塞进固定预算里会被截断（实测只进 26%），反而让"先看索引再钻页"这条链断掉。

**Q：记忆库放在哪里最合适？**
默认 `~/.memory`（全局、跨项目）。需要按项目隔离时，把 `memoryDir` 配到项目内，或让 agent 在项目里维护 `.memory/`。

**Q：可以加密吗？**
记忆含敏感内容时，可把 `memoryDir` 放进加密卷 / 私有仓库。格式不变，插件无感知。

## 开发

```sh
git clone https://github.com/log-li/dsh-memory.git
cd <本仓库>
node scripts/memory.mjs --self-test   # 冒烟测试（无需安装依赖）
```

零构建：`lib/` 直接是运行时代码，`lib/types/index.d.ts` 供 TS 消费方使用。`boot.js` / `scaffold.js` 只依赖 `node:*` 内置模块，可独立复用。

## 路线图

- [x] 注入层改造（本 fork）：热页 boot 子集 + 条目级增量注入 + `memory_search/read/write` 工具
- [x] 可选 automemory（会话收尾自动抽取，默认关，spec §5.4）
- [ ] TypeScript 重写（带完整类型与构建步骤）
- [ ] embedding/BM25 检索（规模超过几百页后替代 index 先行）
- [ ] MCP server（让非 DSH 的 agent 也能用同一套记忆库）
- [ ] GitHub Actions CI（跑 `--self-test` 与 lint）
- [ ] 记忆加密存储选项

欢迎在 [Issues](https://github.com/log-li/dsh-memory/issues) 里提需求、报 bug、交 PR。

## License

[MIT](LICENSE)
