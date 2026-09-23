Status: active

# dsh-memory（fork）：把记忆注入层改成 CC 式

- **创建于**: 2026-09-23 · **最近更新**: 2026-09-23（§5 改造点 (a)(b)(c) 已实现并落测试；§10 覆盖清单同步）
- **上游**: [`LittleBlackTong/dsh-plugin-memory`](https://github.com/LittleBlackTong/dsh-plugin-memory) v0.6.0（MIT）
- **本仓库**: `log-li/dsh-memory`（`origin` = 本 fork，`upstream` = 上游）
- **本机宿主**: `@deepseek-ai/dsh 0.1.5-rc.1`（peer 范围见 §6）

> **本文档是活文档**：描述项目「现在是什么样」，随设计迭代滚动更新；历史靠 git log 与末尾「变更历史」回溯。

## 0. 一句话

上游把**记忆库本体**（markdown + git + 自描述 schema）做得很好，本 fork **只改注入与检索层**，让它对齐 Claude Code 的范式：**常驻的只有"规则 + 一行索引"，正文一律按需取**。数据面（`<memoryDir>/*`）与配置面（`memory.json`、settings 命名空间）**保持 100% 兼容——换装不迁移、不丢记忆**。

## 1. 为什么 fork（2026-09-23 调研判据）

1. **上游低维护但没死**：3★、最后提交 2026-09-09、0 open issues、未归档、MIT。
2. **换别的插件更冒险**：生态里只有 `omdsh-dev/dsh-mnemon` 明写以 `0.1.5-rc.1` 为基线（但要换整套体系 + 另装 CLI + 旧会话 repair）；最像 CC 的 `justhalfbit/dsh-plugin-memory v0.6.1` **与上游同名**（换装要顶掉依赖键）、默认注入预算 64,000 字符、13★ 单人维护、彼时仍在修注入 bug。
3. **缺的不是"另一个记忆插件"，而是注入层三处具体缺陷**（§4），都能在现插件内修掉。
4. **上游资产不该丢**：`lint`（查重复/孤儿/该归档）+ salience 衰减 + git 版本化 + 设置页热改，**都是 CC 本身没有的**。

## 2. 目标 / 非目标

**目标**
- 常驻上下文里，记忆部分**只有规则 + 一行索引**；索引**不再被截断**（当前只进 26%，见 §4.2）。
- 索引命中 → **按需读正文**，是一条**工具闭环**（不靠模型自觉碰 CLI）。
- 记忆变化时**不整块重放**；只重发变化的段落。
- 可选：会话收尾**自动抽取**记忆（默认关）。

**非目标**
- 不改记忆库格式（不引入向量库、不改成 SQLite）——纯 markdown + git 是本项目与 CC 的共同护城河。
- 不改 SOUL 铸魂流程、不改 `deferUntilUserSpeaks` / `activeSessionOnly` 两道闸门语义。
- 不追求"运行时检索替代索引"：索引仍是"我知道有哪些页"的地图。

## 3. 现状机制（上游 0.6.0，本机实测）

| 机制 | 实现 | 证据 |
|---|---|---|
| 记忆库 | `<memoryDir>`（默认 `~/.dsh/memory`）：`SOUL.md` 人格 / `MEMORY.md` 协议 / `index.md` 目录 / `log.md` 时间线 / `bootstrap` / 分类页 | `lib/scaffold.js` |
| **boot 注入** | 本 fork：`agent/pre-step` 贡献一条 plugin 消息，块渲染成命名段落、按段落增量重发（`lib/injector.js`）；`perFile = floor(bootMaxChars / bootFiles.length)` 逐段落截断 | `lib/boot.js`（`renderBootParts`/`renderBootBlock`）、`lib/injector.js`、`lib/index.js` |
| **检索工具** | 本 fork：`memory_search` / `memory_read` / `memory_write`（宿主 registry 手写定义 + 包内参数校验） | `lib/tools.js`、`lib/pages.js`、`lib/tool-schema.js` |
| 注入闸门 | `deferUntilUserSpeaks`（用户开口才注入）、`activeSessionOnly`（只注入当前激活会话） | `lib/activity-tracker.js` |
| 写入（上游） | **无专用工具**：模型按内嵌技能约定写文件 + 手工同步 `index.md`；`autocommit` 做 git 提交 | `skills/memory.md`、`lib/autocommit.js` |
| 写入（本 fork） | `memory_write` 两步写入：查重 + `ifVersion` + 自动 `index.md` 一行 + 派生重生成 + 触发提交 | `lib/tools.js`、`lib/pages.js` |
| 催记 / 追忆 | `digest-guard`（久未写→nudge）、`recall-nudge`（空闲→主动提往事） | `lib/digest-guard.js`、`lib/recall-nudge.js` |
| 检索 | CLI `dsh-memory search/lint/status/pack/unpack`（需 bash）+ 模型直接 `read` | `scripts/memory.mjs` |
| 设置 | 10 项热改（`enabled`/`memoryDir`/`autoInject`/两道闸门/`registerSkill`/`recall*`），存 `<dshHome>/memory.json` | `lib/config-store.js`、`lib/client.js` |
| 测试 | 10 个 `node --test` 文件（100 条）+ `memory.mjs --self-test` | `test/`、`package.json` scripts |

## 4. 与 Claude Code 的差距（实测，作为改造依据）

> CC 侧机制由本机 2.1.236 二进制取证确证：常驻 `# Memory` **规则段**；索引 `MEMORY.md` **按需 fetch**（构建 prompt 时异步、超时、失败降级兜底名）；单条记忆 = 独立文件、正文永不常驻；pinned ≤ 8；写入有专用工具（两步 + 查重 + `if_version`）+ automemory。

| # | 差距 | 实测数字 | 影响 |
|---|---|---|---|
| 1 | **常驻内容性质**：上游把「协议 + **数据索引**」都常驻 | 本机 `bootFiles` 曾为 `[MEMORY.md, index.md]`，boot 块 ≈7.6 KB | 数据被当常驻项 |
| 2 | **索引被截断**（最大差距） | `index.md` 8,603 字符；`perFile = 5600/2 = 2800`，此前 4600/2=2300 ⇒ **仅 26% 可见** | 「先看索引行再钻正文」链路**断裂** |
| 3 | 单条正文按需 | ✅ 已对齐（分类页不常驻） | — |
| 4 | **无专用写工具** | 靠技能约定 + 通用 write/edit + CLI | 无机器强制的查重、无并发保护、索引易漂移 |
| 5 | **无 automemory** | 只有提醒（digest-guard / recall-nudge） | 抽取仍靠模型自觉 |
| 6 | **无条目级去重** | 文件一变整块 ≈7.6 KB 重发（宿主仅投影级去重） | 反复占上下文 |
| 7 | 自查/管理 | 上游有 `lint/status/search` + 设置页 ⇒ **比 CC 强** | 保留，不重做 |
| 8 | 分类与置顶 | 有 `type` + `salience 1/2/3` + `last_access`；**无 pinned ≤8 强制置顶** | 可选补齐 |

## 5. 设计（改造点）

### 5.1 (a) 索引分层：常驻 boot 子集，全量按需 —— **已实现**

**过渡做法（外置，2026-09-23 已验证）**：`<memoryDir>/index.boot.md` 只含 `salience = 1` 的页面，一行一条、行宽截断（实测 17 条 / 2,575 字符）；`bootFiles: [MEMORY.md, index.boot.md]`、`bootMaxChars: 5600`（`5600/2 = 2800` ≥ 2575 ⇒ 零截断）；生成器脚本在 digest 时重跑。

**内置化（本次实现，取代外置脚本）**：`indexBootMode: off | derive`（默认 `derive`）。
- `renderBootParts()` 从 `index.md` **现算**热页子集（`lib/index-format.js#deriveIndexSubset`），不再需要一份要同步的派生文件：行解析 → 只留 `salience: 1` → 摘要按 `maxLineChars`（默认 110）压缩 → 超预算的行降级为「标题 + 路径」→ 仍超预算才丢弃（并如实计数，不静默）。
- 段落标题写明它是子集（`### index.md（boot 子集：salience=1 热页）` + 「完整目录见 index.md，需要冷页时按需 read」），模型因此知道全量表在哪。
- **回退规则**：目录里若一条 salience 标记都没有、且原文仍塞得进该段落预算 → 按原文注入（小库/老库不会被"暂无热页"蒙住）；`index.md` 缺失时回退到外置 `index.boot.md`（若存在）。
- 兼容：`bootFiles` 里写 `index.md` 或 `index.boot.md` 都走同一套现算逻辑；`indexBootMode: 'off'` 恢复逐字注入。

### 5.2 (b) 条目级 digest 去重 —— **已实现（机制与本文档初稿不同，见下）**

boot 块渲染为**命名段落**（`header` / `soul-directive` / 每个 boot 文件 / `log.md` 尾部），注入层按段落记账（`lib/injector.js`）：

| 情形 | 注入什么 |
|---|---|
| 某会话首次注入 | 整块，`form: 'snapshot'`（契约：同一 producer 的后续快照取代它） |
| 有段落变化 | **只发变化段落**，`form: 'notice'`（"刚发生的事"，不取代任何东西）+ 一行账目（summary） |
| 无变化 | **什么都不发**（连消息都不产生） |
| 基线已不在模型可见面上（压缩）／上次注入未落地（步骤被拒） | 重发整块 |

- **判定"模型手上有什么"**：读会话 **surface**（`session.surface.nodes` + `eventAt()`）里本插件自己的消息（`source.plugin === 'memory'`），与其文本逐字比对。基线 = 最近一条 `snapshot`；若最近一条注入的文本 ≠ 本插件上次发出的文本，说明那次没落地或已被压缩带走 → 重发整块（宁可多花一次，也不让模型拿着过期记忆）。
- **压缩后补注入**：`snapshot` 基线不在 surface 上即触发重发；冷页/非热页变化**完全不触发**注入（常驻块里根本没有它）。
- **进程重启（会话恢复）**：内存态为空时优先**从可见快照的消息段落重建**"模型手上有哪些段落"（整块注入的 `sections` 逐段落命名，`memory:<partId>`）——重建成功就直接算增量，连"store 变过"也只需重发变化段；快照没有段落名时退化为「整块文本逐字相同 → 采纳，否则重发整块」；只在可见链尾是增量通知时用源文件 mtime（容差 2ms）兜底。
- **机制偏离说明（为什么不再用 `ctx.systemPrompt.context()`）**：宿主把 runtime-context 快照按**整块**渲染，且拼接时直接声明 "This snapshot supersedes earlier runtime-context snapshots"——只发增量会与这句「取代此前全部」的框架冲突（模型可能认为未重发的人设/协议失效）。因此注入改走 `agent/pre-step` 贡献（`prepend` 不设，消息按 plugin 源追加）：全量用 `snapshot`（取代语义正确）、增量用 `notice`（追加语义正确），并且**只有自己发的消息**参与记账。附带好处：段落文本不再经过 `{{var}}` 严格插值，记忆正文里出现 `{{...}}` 也不会再把 assembly 打崩。
- 门控与原来一致：`enabled` / `autoInject` / `deferUntilUserSpeaks` / `activeSessionOnly` 每步实时读取（设置面板热改即时生效）。

### 5.3 (c) 检索与写入工具（收益最大）—— **已实现**

三个模型可见工具（`lib/tools.js`，可被 `registerTools: false` 整体关闭）：

| 工具 | 作用 | 要点（已实现） |
|---|---|---|
| `memory_search` | 关键词检索记忆页（标题 + 摘要 + 命中行上下文） | 有界返回（默认 8、上限 25）；**无命中明确回「无命中（已扫描 N 页）」**；全词命中优先，只有部分命中时标 `partial` 提示换词；默认不检索 `log.md`（`includeLog: true` 才纳入）、`raw/` 需 `includeRaw` |
| `memory_read` | 按路径读整页正文 | 路径规范化后必须落在 `<memoryDir>` 内（越界即拒）；返回 `version`（写回令牌）+ 标题/salience/字节数 |
| `memory_write` | **两步写入的机器强制** | 新建省略 `ifVersion`；改旧页必须带 `memory_read` 返回的 `ifVersion`，不匹配即拒（乐观并发）；同 slug/同 title 的页已存在 → 拒绝并提示「改旧页」（`allowDuplicate: true` 才另建）；写后**自动更新 `index.md` 一行**（原位替换则保持行位与分区）+ 重生成存在的派生 `index.boot.md` + 触发 auto-commit（`committer.check(true)`，状态如实回给模型）；可选 `logEntry` 追加 `log.md` 时间线；`raw/` 只读、非 `.md` 拒绝 |

工具定义以**普通对象**注册（`ctx.tools.register`），参数校验在包内完成（`lib/tool-schema.js`，与宿主支持的 JSON Schema 子集一致）——**刻意不 import `@deepseek-ai/dsh-tools`**：link 安装时包解析按 realpath 走本仓库 `node_modules`，引入宿主 tools 包会连带引入 `dsh-scope`/`dsh-llm` 等**第二份宿主实例**（scope 身份、工具装配都可能错乱），违反「插件不得声明共享宿主包」。宿主仍会校验 `output.schema`，因此三个工具的输出 schema 与实际返回值都由测试逐字段断言。

### 5.4 (d) 可选 automemory（默认关）—— **未实现（本轮不做，见下）**

设计仍然有效：`turn/end` 或空闲时用 `ctx.llm.stream()` 两阶段抽取（先判断"有没有值得记的"，再写），默认关闭；开启后设置页提供"本次会话暂停自动记忆"。

本轮**未实现**的理由（如实记录）：它需要 LLM 路由（provider/model 解析与降级）、会话转录裁剪、结构化输出解析、设置面板的会话级暂停控件，**并且是唯一会自动改写记忆库的路径**——风险面最大、收益最低（默认关）。因此按「先落 (a)(b)(c) 并端到端验证，再单独一轮做 (d)」推进；在 (d) 落地前，spec 不把默认关的能力描述成可用功能。

## 6. 约束（硬）

1. **数据面不动**：`<memoryDir>` 目录结构、`MEMORY.md`/`index.md` 格式、`log.md` 条目格式**保持上游兼容**（老库直接可用；新派生文件必须可删可重建）。
2. **配置面不动**：`<dshHome>/memory.json` 的既有键语义不变；新增键必须有安全默认值。
3. **命名一致**：包名 `@log.li/dsh-memory` 必须与 profile `dependencies` 键、`dsh.profile.bundles` 项、`cordis.patch.yml` 的 `insert.name` **四处一致**（本机踩过：`insert.name` 是 ESM 包解析名，不一致即启动崩）。
4. **peer 范围**：`@deepseek-ai/dsh-*` 保持 `^0.1.2-alpha.1` 起；**升级到 0.1.6+ 前必须先实测**（Session v4、settings 迁移等破坏性变更）。
5. **测试不退化**：`npm test`（`--self-test`）与 `npm run test:plugin`（7 个文件）全绿是提交前提；新增行为必须带测试。
6. **发布/署名**：MIT 保留上游 LICENSE 与 README 归因；对外发布前按仓库 AGENTS.md 的发布流程走。

## 7. 命名、安装与上游同步

- **改名**：`dsh-plugin-memory` → **`@log.li/dsh-memory`**（与 `@log.li/dsh-automode` 同 scope）。
- **本机安装**（切换时机由用户定）：
  ```bash
  # profile 的 package.json：dependencies 键 + bundles 项都改成新名，值为 link: 路径
  "@log.li/dsh-memory": "link:<本仓库绝对路径>"
  # 再重建 node_modules 链接；改动面与 dsh-automode 一致（package.json + 符号链接 + pnpm-lock）
  ```
  ⚠️ **不要跑 `pnpm install`**（会剪掉 patch 注入型模块，见本机记忆 `skills/dsh-plugin-development.md`）。
- ⚠️ **三处必须一次改齐，不留并存窗口**（2026-09-23 外部 review）：依赖键、`dsh.profile.bundles`、符号链接/lock 要在**同一步**完成——先加新再删旧会造成新老插件并存：boot 块注入两次、`memory` 技能重名、设置面板出现两个分区、命名空间冲突。改完**必须实测设置面板读写**（本 fork 的 devDependencies 会遮蔽宿主的 `schemastery`，版本与宿主不同，是切换后唯一新增的风险面）。
- **与上游同步**：`git fetch upstream && git merge upstream/main`；冲突集中在 `lib/*`（我们改动处）。**上游改了 `cordis.patch.yml` 的 name 时要改回我们的**。

## 8. 验收标准

**自动化**：`npm test` + `npm run test:plugin` 全绿（103 条）；新增测试覆盖：boot 子集派生与预算、段落级增量去重（含压缩后补注入、重启采纳、未落地重发）、`memory_search/read/write` 的查重/越界/乐观并发/索引与派生同步。

**实测（本机 0.1.5-rc.1）**：
1. boot 块**无任何截断提示**；`salience=1` 页面 100% 出现在常驻块里。
2. 记忆不变时**不重发**；改一页后**只重发变化段**（读回会话日志里的注入消息文本对照）。
3. `memory_search` 命中 → `memory_read` 取正文 → `memory_write` 改页并**自动更新 `index.md` 一行**，`git log` 有对应提交。
4. 换装前后 `~/.dsh/memory/` **内容零变化**（`git -C ~/.dsh/memory status` 干净），设置面板 10 项照旧可改。

## 9. 迁移与回滚

- **切换**：改 profile 三处（**必须一次改齐，见 §7**）+ 重启 dsh；旧 npm 版可先 `dsh-memory pack` 打包备份（`~/.dsh/memory` 本身也是 git 仓库，双重兜底）。
- **回滚**：把 profile 依赖键改回 `dsh-plugin-memory`（npm 版）+ 删掉 link 符号链接 + 重启；记忆库不动，因此**回滚无数据风险**。

## 10. E2E 覆盖清单（按项目「完整面」定义，不按改动路径）

> 依据全局规则「Commit 前必须端到端验证」第 5 条：**未跑的必跑项 ⇒ 不许 commit/push**（除非用户明确同意并记录在案）。
> **切换 profile 到本 fork 之前，① 层全部必跑项必须跑完并留证**——「完整」不靠临场判断，按本清单核。

### ① 每次必跑的活体链（真实实例 + 读回真实产物）

| # | 链 | 判据 |
|---|---|---|
| L1 | 隔离实例装载：`link:` 安装 + bundles 解析 + 服务器启动 | HTTP 401（非 000）；日志无 `plugin tree failed`、无 `client-modules ... failed to compose` |
| L2 | **真实会话内的注入**：新会话出现本插件的 boot 注入消息 | 从会话日志读回**注入文本全文并逐字通读**（含 `salience=1` 热页行、无截断提示），不只 grep 关键词。⚠️ 注入形态 2026-09-23 起由「systemPrompt 运行时上下文」改为「plugin `snapshot` 用户消息」，判据随之改为「会话日志里 `source.plugin === 'memory'` 的首条注入」 |
| L3 | `memory` 技能注册：技能目录可见、按需加载正文 | 会话内调用一次能取到 `skills/memory.md` 正文 |
| L4 | 设置面板：10 项可读、可写、热生效 | 面板读写各一次 + 观察注入/技能/脚手架随之变化（**本 fork 的 devDependencies 遮蔽宿主 `schemastery`，此处是唯一新增风险面**） |
| L5 | CLI：`status` / `lint` / `search` / `pack` / `unpack` | 在真实记忆库上各跑一次，pack 产物能 unpack 回来 |
| L6 | digest 提醒：收尾注入提醒 → 写回 → 提醒解除 | 一次真实会话内观察注入与解除 |
| L7 | 数据面不变：换装前后记忆库零变化 | 换装前后 `git -C <memoryDir> status` 均干净、页面内容逐字节一致 |
| L8 | **工具闭环**：`memory_search` → `memory_read` → `memory_write` | 真实会话内三连调用全部成功；写回后读回 `index.md` 那一行、`git log` 有对应提交、`memory_write` 报告 `action/indexRow/autocommit` 与实际一致 |
| L9 | **增量注入**：改一页后只重发变化段 | 同一会话内写回一页后，会话日志新增一条 `form: 'notice'` 注入，其文本只含该段落、并带「未列出的段落仍然有效」声明；未改动时无新增注入消息 |

### ② 可用结构断言替代的项（须写明理由；改动触及其逻辑时升格为必跑）

- **脚手架布局、boot 子集派生、`index.md` 一行更新、路径越界/查重拒绝**：纯函数或进程内可构造，输入输出完全可控、无宿主与浏览器参与 → 由 `npm test` / `node --test` 断言覆盖。**本次改动一旦触及这些函数，仍按必跑处理。**

### ③ 按本次改动触达面追加

- **改名（2026-09-23）**：包解析自 `link:` 路径、`insert.name` == 包名、client bundle 可组合、boot 块模型可见面为新名、全仓无旧名残留。
- **内置索引分层 / 检索工具（待实现后追加）**：boot 增量对照（记忆不变不重发、改一页只重发变化段）；`memory_search → read → write` 闭环（含 `index.md` 一行更新与 `git log` 提交）。

### 当前状态（必须与事实一致）

- **已跑**：L1（隔离实例装载 + 启动）、boot 文本按**真实代码路径 + 真实脚手架**读回并逐字通读（3,838 字符、无截断）、隔离记忆库 scaffold 完整、③ 改名项全部。
- **2026-09-23 注入层改造的验证结果**（隔离实例 `DSH_HOME=/tmp/dsh-e2e-memory`，两个 profile：web + headless；模型侧接一个**自建 stub 端点**（OpenAI-completions，按脚本产出工具调用），因此**模型不是真实 LLM**）：
  - ✅ **L1**：`link:` 安装 + bundles 解析 + 服务器启动（HTTP 401、日志无 `plugin tree failed`）；**红绿对照**：故意把 bundle 名写错 → `cannot resolve profile bundle "@log.li/dsh-memory-typo"`（红），改回即通过（绿）。
  - ✅ **L2**：真实会话的**模型可见请求**与**持久会话日志**（解压 `session.v3.jsonl.zstd`）都读到注入全文并逐字通读：`source.plugin='memory'`、`form='snapshot'`、670 字符、含 `### index.md（boot 子集：salience=1 热页）` 且**只有热页行**（冷页 `cold-archive.md` 不在常驻块里）、无任何截断/超预算提示。
  - ✅ **L3**：会话技能目录里出现插件注册的 `memory` 技能（隔离实例无同名文件技能）。
  - ⚠️ **L4（半边）**：`GET /api/memory/config` 返回含新键（`registerTools`/`indexBootMode`）的配置；POST 改 `indexBootMode`/`registerTools` 热生效并落盘，非法值 400 拒绝。**设置面板的浏览器渲染未验证**（无浏览器）——client bundle 是否 compose 只能靠「日志无 `client-modules … failed to compose`」间接判断。
  - ✅ **L5**：CLI `status` / `search` / `lint` / `pack` / `unpack` 在真实记忆库上各跑一次；`pack` → `unpack` 8 文件完整还原。
  - ❌ **L6**：未跑（digest 提醒需要 120 分钟空闲窗口，本轮未构造）。
  - ✅ **L7（格式侧）**：**上游插件自己的渲染器**能读本 fork 写出的库（index 行/log/页面），渲染 815 字节、含新增热页行 → 数据面仍是上游格式。
  - ✅ **L8**：真实宿主会话里 `memory_search` → `memory_read`（拿到 `version`）→ `memory_write` 全链路成功；写回报告与实际一致（`index.md：inserted`、`log.md：已追加`、`git：committed`），磁盘上索引行插进正确分区、log 追加、`git log` 出现 auto-commit 提交；另一轮里**故意带错 `ifVersion` 新建页 → CONFLICT 拒绝**（负路径也验了）。
  - ✅ **L9**：写回后**模型可见请求**里出现且只出现一条 `form='notice'` 增量（473 字符，含 index/log 两段、「未列出的段落仍然有效」），此后无变化的那一步**没有任何新增注入**；持久日志 `seq=32` 记录了同一增量。
  - ⚠️ **未覆盖**：会话在新进程里**恢复**（headless app 无 `--resume`）→ 仅由单测覆盖；真实 LLM 行为（stub 不是真模型）。
- 因此：**切换动作是 L4（浏览器侧）/L6 的门口**——不得先切换再补验证。

## 11. 变更历史

### v0.6.1-fork.0（进行中，2026-09-23）
- fork 自上游 v0.6.0；改名 `@log.li/dsh-memory`；建立本 spec。
- 同日本机已完成「(a) 索引分层的过渡版」验证（外置生成器 + `bootFiles` 切换，零截断），本 fork 的目标是把 (a) 内置，并实现 (b)(c)(d)。
- 改名收尾：仓库与本地目录均为 `dsh-memory`（GitHub `log-li/dsh-memory`）；清掉 `lib/*` 与 `skills/memory.md` 的模型可见旧名、README 克隆地址与徽章、`package.json` 仓库地址；JSDoc 安装示例由 `pnpm add` 改为 link 安装；测试断言改为**解析 `insert.name` 并与包名比对**（防改名时两处漂移）。
- 独立模型家族 review（外部审查，改代码后、验证前）：0【严重】/ 3【中等】已修——spec 内本机绝对路径、并存窗口纪律、包名与 `insert.name` 一致性断言；结论确认 `lib/client.js` 的 `id` 必须等于包名（宿主按包 specifier 组装 boot 图、浏览器按 id 找 factory，不一致即硬错、设置分区静默消失）。
- `Status` 由 `proposed` 改 `active`：spec 是活文档，状态写在文件内，不随目录搬迁。
- 新增 §10 **E2E 覆盖清单**（7 条活体链 + 可结构断言替代项 + 每次改动追加项），并如实记录未跑项——**切换 profile 前必须补跑 L2–L7**。

### review 处置记录（2026-09-23，独立模型家族审查 (a)(b)(c) 变更集）

逐条核验后的处置（采纳 / 调整 / 拒绝 + 理由）：

| # | review 说法 | 我的核验 | 处置 |
|---|---|---|---|
| 1 | 【严重】`readOwnInjections` 靠「文案巧合」区分自家注入与 digest/recall nudge（同 plugin 名 `memory`） | 识别判据本已是 `source.form === 'snapshot' + 段落名` / `form === 'notice' + summary 前缀`；nudge 消息**无 `form`**，从不进账本（review 终稿也改口为"契约脆弱性"）。但 notice 一路确实只靠 summary 前缀这一个文本信号 | **采纳（硬化）**：notice 再加一道独立信号——消息正文以 `DELTA_MARKER`（`【记忆增量更新`）开头；快照段落用 `memory:<partId>` 前缀且要求**段落文本拼接 === 消息正文**。补负向测试：同 plugin 名但无 `form` 的 nudge、复用同前缀的别的 notice、段名不是我们的 snapshot，一律不入账本。因此**不改** nudge 的 plugin 名（避免动上游模块与其测试） |
| 2 | 【中等】冷启动 reconcile 用 `maxSourceMtime` 判基线，log.md 一 append（digest 必然）就让重启后的会话重发整块 | 逻辑无误（保守、安全），但确实把「重启不重发」白白浪费 | **采纳（改判据）**：整块注入的 `sections` 改为**逐段落命名**（`memory:<partId>`），持久日志里因此保留了"模型手上有哪些段落"；重启后直接**从可见快照重建 part map** → 算增量（而非重发整块）。仅当可见快照没有段落名（旧版/别的 producer 写的）才回退到 mtime 判据或整块重发。补两条测试（有 part 名→增量；无 part 名→整块） |
| 3 | 【中等】`bootFiles` / `bootMaxChars` 在 `apply()` 闭包捕获，手改不热生效 | 二者是 **composition 键**：`memory.json` 的 `pickFields` 白名单**不含**它们（手改无效，不是"改了不生效"），README 配置表也写明"只在 composition 层生效、改完需重启" | **拒绝**（review 前提有误）：不影响任何已文档化行为。保留现状 |
| 4 | 【轻微】三个 `render` 回调无 try/catch | 宿主 `createSuccessResult` 已用 `projectionError` 包裹 render；我们的 render 只做字符串拼接 | **拒绝**：加兜底会把拼接 bug 静默化，宿主报错更可诊断 |
| 5 | 【轻微】`rel.startsWith('raw/')` 语义依赖归一化 | 事实正确（`raw/../x.md` → `x.md` 应放行） | **采纳（注释留档）**：写明按路径段判定、`raw-notes.md` 不会被误判 |
| 6 | 【轻微】`findSectionHeading` 用 `heading.includes(category)`，`user` 会命中 `## user-preferences` | 属实（低概率、行内容仍正确，但归属段可能错） | **采纳**：改成词边界匹配（`^cat(?![\p{L}\p{N}_-])`），补测试 |
| 7 | 【轻微】`deriveIndexSubset` 预算用 UTF-16 `.length`，与 `clampText` 的码点计数不一致 | 属实，但只影响预算的临界计数（BMP CJK 一致），不影响截断/丢弃行为 | **登记不修**：等真正出现 astral 字符引发的预算偏差再统一 |
| 8 | 【轻微】`resolveInside` 的 symlink 穿越无测试 | 我在 review 到达前已加固（realpath 校验 + `raw/` 双路径判定）并补了测试 | 已闭环 |

- 附带：review 未发现的自身加固——`resolveInside` 现在拒绝**经符号链接指向库外**的路径（含 `raw/` 软链），并在 store 根不存在时停止向上遍历（否则会误判 `OUT_OF_STORE`）；`session.surface` 不可用时降级为"只发整块、绝不猜基线"。
- 验证报告：以上修改后 `node --test` 103 条全绿、`--self-test` 通过；**隔离实例真实会话第二轮 E2E**（改判据之后）复现同一结果：持久日志 `seq=11 form=snapshot`（670 字符，段落名 `memory:header … memory:log.md`、段落拼接 === 正文）、写回后 `seq=32 form=notice`（473 字符）、模型可见请求里 FULL 一次 + NOTICE 一次且后续不再重发。

### v0.7.0-fork（2026-09-23）注入与检索层改造（(a)(b)(c) 落地）
- **(a) 内置索引分层**：新增 `index-format.js`（行解析 / 热页子集派生 / 一行 upsert）与 `indexBootMode: off | derive`（默认 `derive`）；boot 段落现算 `salience=1` 子集，**外置 `make-index-boot.mjs` 不再是必需**（老库的 `index.boot.md` 仍被兼容与刷新）。
- **(b) 条目级增量注入**：新增 `injector.js`——块拆成命名段落，首轮 `snapshot`、变化只发 `notice` 增量、无变化不发；压缩/未落地/重启三种失效面各自有判据（surface 比对 + 源文件 mtime 容差）。**注入机制由 `systemPrompt.context()` 改为 `agent/pre-step` 贡献**——原因见 §5.2（宿主对 runtime-context 拼接 "supersedes earlier snapshots" 的框架与增量语义冲突）。
- **(c) 三个记忆工具**：新增 `pages.js`（检索 / 读取 / 两步写入引擎）、`tools.js`（模型可见定义）、`tool-schema.js`（参数校验，刻意不引入宿主 `dsh-tools` 以避开第二份宿主实例）；`registerTools` 可整体关闭（面板热改）。
- 配置/UI：`SettingsSchema` + `memory.json` 新增 `indexBootMode` / `registerTools`；设置面板「记忆 Memory」区 10 → 12 项；`AutoCommitter.check()` 返回状态字（`clean|waiting|committed|skipped|failed`），`memory_write` 据此如实回报 git 结果。
- 测试：新增 `index-format` / `injector` / `tools` 三个测试文件，boot 测试补热页子集与预算用例；`node --test` 从 7 文件 55 条 → 10 文件 100 条全绿。
- 待办（如实记录）：**(d) 可选 automemory 未实现**（理由见 §5.4）；L3–L7 未跑（切换 profile 前必须补跑）。
