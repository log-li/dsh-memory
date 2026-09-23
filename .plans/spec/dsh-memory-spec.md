Status: active

# dsh-memory（fork）：把记忆注入层改成 CC 式

- **创建于**: 2026-09-23 · **最近更新**: 2026-09-23
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
| **boot 注入** | `ctx.systemPrompt.context()` 注入 boot 块；`perFile = floor(bootMaxChars / bootFiles.length)`，逐文件截断 | `lib/boot.js`（`renderBootBlock`）、`lib/index.js` |
| 注入闸门 | `deferUntilUserSpeaks`（用户开口才注入）、`activeSessionOnly`（只注入当前激活会话） | `lib/activity-tracker.js` |
| 写入 | **无专用工具**：模型按内嵌技能约定写文件 + 手工同步 `index.md`；`autocommit` 做 git 提交 | `skills/memory.md`、`lib/autocommit.js` |
| 催记 / 追忆 | `digest-guard`（久未写→nudge）、`recall-nudge`（空闲→主动提往事） | `lib/digest-guard.js`、`lib/recall-nudge.js` |
| 检索 | CLI `dsh-memory search/lint/status/pack/unpack`（需 bash）+ 模型直接 `read` | `scripts/memory.mjs` |
| 设置 | 10 项热改（`enabled`/`memoryDir`/`autoInject`/两道闸门/`registerSkill`/`recall*`），存 `<dshHome>/memory.json` | `lib/config-store.js`、`lib/client.js` |
| 测试 | 7 个 `node --test` 文件 + `memory.mjs --self-test` | `test/`、`package.json` scripts |

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

### 5.1 (a) 索引分层：常驻 boot 子集，全量按需

**已被本机验证的过渡做法**（外置，不改插件即可用）：
- 生成 `<memoryDir>/index.boot.md`：**只含 `salience = 1` 的页面**，一行一条、行宽截断（实测 17 条 / 2,575 字符）；
- `bootFiles: [MEMORY.md, index.boot.md]`、`bootMaxChars: 5600`（`5600/2 = 2800` ≥ 2575 ⇒ **零截断**）；
- 全量 `index.md` 仍按需 `read`；生成器脚本在 digest 时重跑（防漂移）。

**内置化（本 fork 目标）**：把该派生逻辑移进插件（配置项 `indexBootMode: off | derive`，默认 `derive`），在 `renderBootBlock` 里从 `index.md` 现算，避免"多一份需要同步的派生文件"。

### 5.2 (b) 条目级 digest 去重

- boot 块渲染后取 **SHA-1**，与「本插件在会话可见表面上最后一条注入」比对：**不变则不重发**（宿主已有投影级去重，这一层解决"部分变化"）。
- 变化时**只重发变化段**（按文件分段 diff：`MEMORY.md` / `index.boot.md` / log 尾部各自独立）。
- 需处理 **compaction 后补注入**（压缩会抹掉历史里的注入）。
- 参考实现：`justhalfbit/dsh-plugin-memory` README:95-98（与可见表面末条比对 + compaction 后补注）。

### 5.3 (c) 检索与写入工具（收益最大）

新增 3 个模型可见工具：

| 工具 | 作用 | 要点 |
|---|---|---|
| `memory_search` | 关键词/短语检索记忆页（标题 + 摘要 + 命中上下文） | 有界返回；无命中要说"无命中"而不是空 |
| `memory_read` | 按路径读整页正文 | 路径必须在 `<memoryDir>` 内（防越界读） |
| `memory_write` | **两步写入的机器强制**：写页面 + 自动在 `index.md` 追加/更新一行 + 重生成 boot 子集 | 先查重（同主题提示"改旧页"）；`if_version` 式乐观并发；写后跑 `autocommit` |

### 5.4 (d) 可选 automemory（默认关）

- `turn/end` 或空闲时用 `ctx.llm.stream()` 做两阶段抽取（先判断"有没有值得记的"，再写）。
- **默认关闭**；开启后在设置页显示"本次会话暂停自动记忆"。

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

**自动化**：`npm test` + `npm run test:plugin` 全绿；新增测试覆盖：boot 子集派生、digest 去重（含 compaction 后补注）、`memory_search/read/write` 的查重与越界拒绝。

**实测（本机 0.1.5-rc.1）**：
1. boot 块**无任何截断提示**；`salience=1` 页面 100% 出现在常驻块里。
2. 记忆不变时**不重发**；改一页后**只重发变化段**（对比 `decisions.jsonl` 式日志或会话消息增量）。
3. `memory_search` 命中 → `memory_read` 取正文 → `memory_write` 改页并**自动更新 `index.md` 一行**，`git log` 有对应提交。
4. 换装前后 `~/.dsh/memory/` **内容零变化**（`git -C ~/.dsh/memory status` 干净），设置面板 10 项照旧可改。

## 9. 迁移与回滚

- **切换**：改 profile 三处（**必须一次改齐，见 §7**）+ 重启 dsh；旧 npm 版可先 `dsh-memory pack` 打包备份（`~/.dsh/memory` 本身也是 git 仓库，双重兜底）。
- **回滚**：把 profile 依赖键改回 `dsh-plugin-memory`（npm 版）+ 删掉 link 符号链接 + 重启；记忆库不动，因此**回滚无数据风险**。

## 11. E2E 覆盖清单（按项目「完整面」定义，不按改动路径）

> 依据全局规则「Commit 前必须端到端验证」第 5 条：**未跑的必跑项 ⇒ 不许 commit/push**（除非用户明确同意并记录在案）。
> **切换 profile 到本 fork 之前，① 层全部必跑项必须跑完并留证**——「完整」不靠临场判断，按本清单核。

### ① 每次必跑的活体链（真实实例 + 读回真实产物）

| # | 链 | 判据 |
|---|---|---|
| L1 | 隔离实例装载：`link:` 安装 + bundles 解析 + 服务器启动 | HTTP 401（非 000）；日志无 `plugin tree failed`、无 `client-modules ... failed to compose` |
| L2 | **真实会话内的注入**：新会话 system prompt 出现 boot 块 | 从会话日志读回**注入文本全文并逐字通读**（含 `salience=1` 页正文、无截断提示），不只 grep 关键词 |
| L3 | `memory` 技能注册：技能目录可见、按需加载正文 | 会话内调用一次能取到 `skills/memory.md` 正文 |
| L4 | 设置面板：10 项可读、可写、热生效 | 面板读写各一次 + 观察注入/技能/脚手架随之变化（**本 fork 的 devDependencies 遮蔽宿主 `schemastery`，此处是唯一新增风险面**） |
| L5 | CLI：`status` / `lint` / `search` / `pack` / `unpack` | 在真实记忆库上各跑一次，pack 产物能 unpack 回来 |
| L6 | digest 提醒：收尾注入提醒 → 写回 → 提醒解除 | 一次真实会话内观察注入与解除 |
| L7 | 数据面不变：换装前后记忆库零变化 | 换装前后 `git -C <memoryDir> status` 均干净、页面内容逐字节一致 |

### ② 可用结构断言替代的项（须写明理由；改动触及其逻辑时升格为必跑）

- **脚手架布局、boot 子集派生、`index.md` 一行更新、路径越界/查重拒绝**：纯函数或进程内可构造，输入输出完全可控、无宿主与浏览器参与 → 由 `npm test` / `node --test` 断言覆盖。**本次改动一旦触及这些函数，仍按必跑处理。**

### ③ 按本次改动触达面追加

- **改名（2026-09-23）**：包解析自 `link:` 路径、`insert.name` == 包名、client bundle 可组合、boot 块模型可见面为新名、全仓无旧名残留。
- **内置索引分层 / 检索工具（待实现后追加）**：boot 增量对照（记忆不变不重发、改一页只重发变化段）；`memory_search → read → write` 闭环（含 `index.md` 一行更新与 `git log` 提交）。

### 当前状态（必须与事实一致）

- **已跑**：L1（隔离实例装载 + 启动）、boot 文本按**真实代码路径 + 真实脚手架**读回并逐字通读（3,838 字符、无截断）、隔离记忆库 scaffold 完整、③ 改名项全部。
- **未跑（切换前必须补跑）**：**L2**（上面那次是探针读回，**不是**真实会话 system prompt）、**L3**、**L4**、**L5**、**L6**、**L7**。
- 因此：**切换动作是 L2–L7 的门口**——不得先切换再补验证。

## 10. 变更历史

### v0.6.1-fork.0（进行中，2026-09-23）
- fork 自上游 v0.6.0；改名 `@log.li/dsh-memory`；建立本 spec。
- 同日本机已完成「(a) 索引分层的过渡版」验证（外置生成器 + `bootFiles` 切换，零截断），本 fork 的目标是把 (a) 内置，并实现 (b)(c)(d)。
- 改名收尾：仓库与本地目录均为 `dsh-memory`（GitHub `log-li/dsh-memory`）；清掉 `lib/*` 与 `skills/memory.md` 的模型可见旧名、README 克隆地址与徽章、`package.json` 仓库地址；JSDoc 安装示例由 `pnpm add` 改为 link 安装；测试断言改为**解析 `insert.name` 并与包名比对**（防改名时两处漂移）。
- 独立模型家族 review（外部审查，改代码后、验证前）：0【严重】/ 3【中等】已修——spec 内本机绝对路径、并存窗口纪律、包名与 `insert.name` 一致性断言；结论确认 `lib/client.js` 的 `id` 必须等于包名（宿主按包 specifier 组装 boot 图、浏览器按 id 找 factory，不一致即硬错、设置分区静默消失）。
- `Status` 由 `proposed` 改 `active`：spec 是活文档，状态写在文件内，不随目录搬迁。
- 新增 §11 **E2E 覆盖清单**（7 条活体链 + 可结构断言替代项 + 每次改动追加项），并如实记录未跑项——**切换 profile 前必须补跑 L2–L7**。
