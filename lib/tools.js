/**
 * The three model-facing memory tools: `memory_search`, `memory_read`,
 * `memory_write`.
 *
 * Why they exist: the plugin's resident context is 「规则 + 一行热页索引」, so
 * *everything else about the store must be reachable from inside a session* —
 * without asking the model to remember a CLI incantation. The tools close that
 * loop: search the catalog and pages → read one page's body → write it back
 * with the catalog row kept in sync (and `git` committed).
 *
 * Definitions are plain objects registered on `ctx.tools`. The host validates
 * the *output* schema it is handed, and this package validates arguments itself
 * (`lib/tool-schema.js`) rather than importing the host's tool runtime, which
 * would drag a second copy of shared host packages into the plugin's module
 * graph (forbidden by the project's hard constraints).
 *
 * This module depends only on `node:*` builtins.
 *
 * @module @log.li/dsh-memory/tools
 */

import {
  MemoryOperationError,
  readMemoryPage,
  searchMemory,
  writeMemoryPage,
} from './pages.js'
import { withArgumentValidation } from './tool-schema.js'

export const MEMORY_SEARCH_TOOL = 'memory_search'
export const MEMORY_READ_TOOL = 'memory_read'
export const MEMORY_WRITE_TOOL = 'memory_write'

/** Tool names in registration order. */
export const MEMORY_TOOL_NAMES = [MEMORY_SEARCH_TOOL, MEMORY_READ_TOOL, MEMORY_WRITE_TOOL]

const SEARCH_DESCRIPTION = [
  '检索长期记忆库（markdown 页面）的关键词检索。返回命中页面的路径、标题、salience 与命中行上下文。',
  '**先 search 定位、再 read 正文**：常驻上下文只带 salience=1 的热页索引，冷页与所有正文都要按需取。',
  '无命中时会明确回复「无命中」——那不等于用户没提过，换同义词/中英/缩写再搜一次。',
  '默认不检索 log.md 时间线（要按时间线索找就用 includeLog: true）。',
].join('')

const READ_DESCRIPTION = [
  '读取记忆库中一页的完整正文（path 来自 memory_search 或 index.md，必须是记忆库内路径）。',
  '返回正文、version（写回时的乐观并发令牌）与标题/salience。改旧页前必须先 read 拿到 version。',
].join('')

const WRITE_DESCRIPTION = [
  '写入或更新一页记忆，并自动维护 index.md 的一行目录（以及派生热页子集）。**两步写入**：',
  '① 新建页面省略 ifVersion；② 改旧页必须先 memory_read 取 version，再带 ifVersion 写回——',
  '文件已被改动（版本不匹配）会拒绝，避免覆盖别人的更新。同主题页已存在时会拒绝并提示「改旧页」，',
  '确实要另建才传 allowDuplicate: true。raw/ 是只读源材料；index.md / index.boot.md / log.md 由插件维护、',
  '不允许整份改写（时间线用 logEntry 追加）。可选 logEntry 追加一条 log.md 时间线；写后自动触发记忆库的 git 提交。',
].join('')

/**
 * Create the three tool definitions.
 *
 * @param {{
 *   getMemoryDir: () => string,
 *   triggerCommit?: () => string,
 *   logger?: { info?: Function, warn?: Function },
 * }} options
 * @returns {object[]} registry-ready definitions
 */
export function createMemoryTools(options) {
  const getMemoryDir = options.getMemoryDir
  const logger = options.logger
  const triggerCommit = options.triggerCommit

  /** Resolve the store, failing loudly when the plugin has no usable dir. */
  const storeDir = () => {
    const dir = getMemoryDir?.()
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('memory plugin has no memoryDir configured')
    return dir
  }

  /** Re-throw a memory failure with its stable code made visible to the model. */
  const run = (fn) => {
    try {
      return fn()
    } catch (error) {
      if (error instanceof MemoryOperationError) {
        throw new Error(`${error.code}: ${error.message}`)
      }
      throw error
    }
  }

  const search = withArgumentValidation({
    name: MEMORY_SEARCH_TOOL,
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，空格分隔多个词（同义词/中英可一起给）。' },
        limit: { type: 'integer', description: '最多返回多少页，默认 8，上限 25。' },
        includeRaw: { type: 'boolean', description: '是否把只读的 raw/ 源材料也纳入检索，默认 false。' },
        includeLog: { type: 'boolean', description: '是否把 log.md 时间线也纳入检索，默认 false（boot 块已带末尾动态）。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'scanned', 'partial', 'results'],
        properties: {
          query: { type: 'string' },
          scanned: { type: 'integer' },
          partial: { type: 'boolean' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'title', 'salience', 'score', 'summary', 'matches'],
              properties: {
                path: { type: 'string' },
                title: { type: 'string' },
                salience: { type: 'integer' },
                score: { type: 'number' },
                summary: { type: 'string' },
                matches: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['line', 'text'],
                    properties: {
                      line: { type: 'integer' },
                      text: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    execute(args) {
      return Promise.resolve(run(() => {
        const found = searchMemory(storeDir(), {
          query: args.query,
          limit: args.limit,
          includeRaw: args.includeRaw === true,
          includeLog: args.includeLog === true,
        })
        logger?.info?.(`memory: search "${found.query}" → ${found.results.length} hit(s) of ${found.scanned} page(s)`)
        return {
          query: found.query,
          scanned: found.scanned,
          partial: found.partial,
          results: found.results.map((entry) => ({
            path: entry.path,
            title: entry.title,
            salience: entry.salience,
            score: entry.score,
            summary: entry.summary ?? '',
            matches: entry.matches.map((match) => ({ line: match.line, text: match.text })),
          })),
        }
      }))
    },
  })

  const read = withArgumentValidation({
    name: MEMORY_READ_TOOL,
    description: READ_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '记忆库内相对路径，例如 decisions/dsh-plugin-slot-safety.md。' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'text', 'version', 'title', 'salience', 'bytes'],
        properties: {
          path: { type: 'string' },
          text: { type: 'string' },
          version: { type: 'string' },
          title: { type: 'string' },
          salience: { type: 'integer' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `# ${value.path}（version ${value.version}，salience ${value.salience}，${value.bytes} 字节）\n\n${value.text}`,
      }],
    },
    execute(args) {
      return Promise.resolve(run(() => {
        const page = readMemoryPage(storeDir(), args.path)
        return {
          path: page.path,
          text: page.text,
          version: page.version,
          title: page.title,
          salience: page.salience,
          bytes: page.bytes,
        }
      }))
    },
  })

  const write = withArgumentValidation({
    name: MEMORY_WRITE_TOOL,
    description: WRITE_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '记忆库内相对路径（.md 结尾），如 decisions/新决策.md。' },
        content: { type: 'string', description: '页面完整正文（含 frontmatter 时一并给出）。' },
        ifVersion: { type: 'string', description: '改旧页必填：memory_read 返回的 version（乐观并发令牌）。' },
        allowDuplicate: { type: 'boolean', description: '同主题页已存在时是否仍要另建（默认 false → 拒绝并提示改旧页）。' },
        summary: { type: 'string', description: '写入 index.md 那一行的摘要；省略则从正文首段提取。' },
        salience: { type: 'integer', description: '1=热（进常驻 boot 子集）/2=温/3=冷；省略则按 frontmatter，默认 2。', enum: [1, 2, 3] },
        logEntry: { type: 'string', description: '顺便追加一条 log.md 时间线，如 “decision | 决定不换插件”。' },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'version', 'previousVersion', 'indexRow', 'bootSubset', 'logged', 'salience', 'title', 'bytes', 'autocommit'],
        properties: {
          path: { type: 'string' },
          action: { type: 'string', enum: ['created', 'updated'] },
          version: { type: 'string' },
          previousVersion: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          indexRow: { type: 'string' },
          bootSubset: { type: 'string' },
          logged: { type: 'boolean' },
          salience: { type: 'integer' },
          title: { type: 'string' },
          bytes: { type: 'integer' },
          autocommit: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderWriteResult(value),
      }],
    },
    execute(args) {
      return Promise.resolve(run(() => {
        const report = writeMemoryPage(storeDir(), {
          path: args.path,
          content: args.content,
          ifVersion: args.ifVersion,
          allowDuplicate: args.allowDuplicate === true,
          summary: args.summary,
          salience: args.salience,
          logEntry: args.logEntry,
        })
        let autocommit = 'disabled'
        if (typeof triggerCommit === 'function') {
          try {
            autocommit = triggerCommit()
          } catch (error) {
            autocommit = 'failed'
            logger?.warn?.(`memory: auto-commit after write failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        logger?.info?.(`memory: ${report.action} ${report.path} (v${report.version}, index ${report.indexRow})`)
        return { ...report, autocommit }
      }))
    },
  })

  return [search, read, write]
}

/** Model-facing text for a search result (bounded, but never silently empty). */
export function renderSearchResult(value) {
  if (value.results.length === 0) {
    return `无命中（已扫描 ${value.scanned} 页，query: "${value.query}"）。换个关键词/同义词再搜，或先 read index.md 看目录。`
  }
  const header = value.partial
    ? `没有页面同时命中全部关键词，以下是部分命中的 ${value.results.length} 页（共扫描 ${value.scanned} 页）：`
    : `命中 ${value.results.length} 页（共扫描 ${value.scanned} 页）：`
  const blocks = value.results.map((entry) => {
    const lines = [
      `- ${entry.path} — ${entry.title}（salience ${entry.salience}，score ${entry.score}）`,
      entry.summary.length > 0 ? `  摘要：${entry.summary}` : undefined,
      ...entry.matches.map((match) => `  L${match.line}: ${match.text}`),
    ].filter((line) => line !== undefined)
    return lines.join('\n')
  })
  return `${header}\n\n${blocks.join('\n')}`
}

/** Model-facing text for a write report. */
export function renderWriteResult(value) {
  const lines = [
    `已${value.action === 'created' ? '新建' : '更新'} ${value.path}（version ${value.version}${value.previousVersion === null ? '' : `，原 ${value.previousVersion}`}）。`,
    `index.md：${value.indexRow}；派生热页子集：${value.bootSubset}；log.md：${value.logged ? '已追加' : '未追加'}；git：${value.autocommit}。`,
  ]
  return lines.join('')
}

/**
 * Register every memory tool on `ctx.tools`.
 * @param {{ tools: { register: (definition: object) => () => void } }} ctx
 * @param {Parameters<typeof createMemoryTools>[0]} options
 * @returns {() => void} disposer unregistering all three tools
 */
export function registerMemoryTools(ctx, options) {
  const disposers = createMemoryTools(options).map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // already disposed with its scope
      }
    }
  }
}
