/**
 * dsh-memory · 模型可调用的记忆工具。
 *
 * 三个工具刻意保持**小面**（每个都很窄），因为工具定义本身要占系统提示词预算：
 *   - `memory_read`   按需读取，返回带来源标注的片段
 *   - `memory_search` 关键词检索，避免为记忆引入向量库
 *   - `memory_write`  唯一写入口，内置隐私自检 + 分类路由
 *
 * @module dsh-memory/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe as describePrivacy, inspect } from './privacy.js'
import { clipBytes, today } from './store.js'
import { buildAudit, renderReport } from './audit.js'
import { findGlobalWrites, ARCHIVED_MARKER } from './harvest.js'

/** 全局库的分类 → 文件名映射，供 `memory_write` 路由。 */
export const GLOBAL_CATEGORIES = {
  identity: { file: '01-身份与基本档案.md', label: '身份与基本档案' },
  communication: { file: '02-沟通与协作偏好.md', label: '沟通与协作偏好' },
  tech: { file: '03-技术栈与工具.md', label: '技术栈与工具' },
  work: { file: '04-工作与项目.md', label: '工作与项目' },
  learning: { file: '05-学习与知识.md', label: '学习与知识' },
  life: { file: '06-生活与健康.md', label: '生活与健康' },
  business: { file: '07-副业与商业记录.md', label: '副业与商业记录' },
  interest: { file: '08-兴趣与娱乐.md', label: '兴趣与娱乐' },
  goals: { file: '09-目标与计划.md', label: '目标与计划' },
  decisions: { file: '10-重要决定与对话结论.md', label: '重要决定与对话结论' },
  taboos: { file: '11-雷区与注意事项.md', label: '雷区与注意事项' },
  content: { file: '14-内容与商业探索.md', label: '内容与商业探索' },
  photo: { file: '13-摄影能力与作品.md', label: '摄影能力与作品' },
}

/** 把参数数组里的分类键渲染成一行帮助文本。 */
const CATEGORY_HELP = Object.entries(GLOBAL_CATEGORIES)
  .map(([key, value]) => `${key}=${value.label}`)
  .join('、')

/**
 * 生成统一格式的长期记忆条目。
 * @param input - `{ title, body, source, confidence, tags }`
 * @returns Markdown 条目
 */
export function formatEntry(input) {
  const lines = [
    `### ${input.title}`,
    `- **记忆**：${input.body}`,
    `- **来源**：${input.source}`,
    `- **记录时间**：${today()}`,
    `- **可信度**：${input.confidence}`,
  ]
  if (Array.isArray(input.tags) && input.tags.length > 0) {
    lines.push(`- **标签**：${input.tags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' ')}`)
  }
  return lines.join('\n')
}

/**
 * 注册全部记忆工具。
 * @param ctx - profile scope
 * @param store - MemoryStore
 * @param settings - 插件设置
 * @param keeper - AnchorKeeper（用于 task 写入）
 */
export function registerMemoryTools(ctx, store, settings, keeper) {
  // ---------------------------------------------------------------- memory_read
  ctx.tools.register(defineTool({
    name: 'memory_read',
    description:
      '按需读取记忆。记忆系统分四层：global=L1 全局个人记忆库入口（关于用户的一切）、'
      + 'port=L2 本工作区记忆端口（这个工作区做什么/规范/踩坑）、task=L3 当前任务档案（目标与进度）、'
      + `category=读取某个全局分类文件（${CATEGORY_HELP}）。`
      + '会话开始时这四层的摘要已自动注入，只在需要更多细节时读，不要一次读完整个库。',
    parameters: {
      target: {
        type: 'string',
        required: true,
        enum: ['global', 'port', 'task', 'category', 'list'],
        description: 'global / port / task / category（配合 category 参数）/ list（列出全部可用文件与大小）。',
      },
      category: {
        type: 'string',
        description: `target=category 时必填，取值为：${Object.keys(GLOBAL_CATEGORIES).join(' / ')}，或直接给 \`NN-*.md\` 文件名。`,
      },
      query: {
        type: 'string',
        description: '给定关键词时只返回包含这些词的行（空格分隔），用于在大文件里定位，避免整篇读取。',
      },
      maxBytes: { type: 'integer', description: '返回内容上限（字节），默认 6000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `【记忆读取 · ${value.target}】${value.path}`,
          value.truncated ? `（已截断，原始 ${value.bytes} 字节；可用 query 参数精确定位）` : `${value.bytes} 字节`,
          value.note ?? '',
          '',
          value.text,
        ].filter((line) => line !== '').join('\n'),
      }],
      presentationMeta: (_args, value) => ({ path: value.path, bytes: value.bytes }),
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'read',
      title: `读取记忆 · ${args.target}${args.category === undefined ? '' : `/${args.category}`}`,
    }),
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const budget = Number.isFinite(args.maxBytes) && args.maxBytes > 0 ? args.maxBytes : settings.portInlineBytes * 2

      if (args.target === 'list') {
        const categories = store.listCategories()
        const rows = [
          `L1 全局库根：${store.memoryRoot}`,
          `  - 入口 \`MEMORY.md\``,
          ...categories.map((item) => `  - \`${item.name}\` (${item.bytes} B, 更新 ${item.updated || '未知'})`),
          'L2 工作区端口：',
          `  - \`${store.portPath(cwd)}\``,
          'L3 任务档案：',
          `  - \`${store.activeTaskPath(cwd)}\``,
          `  - 归档目录 \`${store.portDirFor(cwd)}\\archive\``,
        ]
        const text = rows.join('\n')
        return { target: 'list', path: store.memoryRoot, bytes: Buffer.byteLength(text, 'utf8'), truncated: false, text }
      }

      let resolved
      if (args.target === 'category') {
        const key = String(args.category ?? '').trim()
        const mapped = GLOBAL_CATEGORIES[key]?.file ?? key
        resolved = store.read(mapped, cwd)
        if (resolved === undefined) {
          throw new Error(
            `未知分类「${key}」。可用键：${Object.keys(GLOBAL_CATEGORIES).join('、')}；也可直接传 \`NN-*.md\` 文件名。`,
          )
        }
      } else {
        resolved = store.read(args.target, cwd)
        if (resolved === undefined) {
          throw new Error(`记忆文件不存在：${args.target}（工作区端口由插件自动创建，先执行任意任务即可）`)
        }
      }

      let text = resolved.text
      let note = ''
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        const terms = args.query.toLowerCase().split(/\s+/u).filter(Boolean)
        const kept = text.split(/\r?\n/u).filter((line) => {
          const lower = line.toLowerCase()
          return terms.some((term) => lower.includes(term))
        })
        note = `已按关键词「${args.query}」过滤：${kept.length} 行命中。`
        text = kept.join('\n')
      }

      const rawBytes = Buffer.byteLength(text, 'utf8')
      const clipped = clipBytes(text, budget)
      const value = {
        target: `${args.target}${args.category === undefined ? '' : `:${args.category}`}`,
        path: resolved.path,
        bytes: rawBytes,
        truncated: clipped !== text,
        text: clipped === '' ? '（空）' : clipped,
      }
      // ⚠️ 只在真有内容时带上可选字段：DSH 会用 isJsonValue 校验工具返回值，
      // 而 `undefined` 不是合法 JSON 值，带上会报
      // "value is not lossless JSON"。
      if (note !== '') value.note = note
      return value
    },
  }))

  // -------------------------------------------------------------- memory_search
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      '在记忆库里做关键词检索（全局分类文件 + 工作区端口 + 任务档案一起搜）。'
      + '当你不确定某条信息记在哪个文件时用它，比逐个 memory_read 更省上下文。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词，空格分隔；多个词全部命中的行优先返回。' },
      limit: { type: 'integer', description: '最多返回多少条命中，默认 15，上限 50。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) {
          return [{ type: 'text', text: `记忆检索「${value.query}」：没有命中。可能尚未记录，或换个关键词。` }]
        }
        const lines = [`记忆检索「${value.query}」：${value.count} 条命中`, '']
        for (const hit of value.hits) lines.push(`- [${hit.file}:${hit.line}] ${hit.text}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'search', title: `检索记忆 · ${String(args.query ?? '').slice(0, 60)}` }),
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const limit = Math.min(50, Math.max(1, Number.isFinite(args.limit) ? args.limit : 15))
      const hits = store.search(args.query, cwd, limit)
      return {
        query: args.query,
        count: hits.length,
        hits: hits.map((hit) => ({ file: hit.file, line: hit.line, text: hit.text })),
      }
    },
  }))

  // --------------------------------------------------------------- memory_write
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      '写入记忆（唯一写入口，内置隐私红线自检，命中硬红线会被拒绝并返回脱敏版本）。'
      + 'target=global 沉淀到 L1 全局长期记忆库（需要 category 指明分类）；'
      + 'target=port 写入 L2 本工作区端口（这个工作区做什么、规范、稳定事实）；'
      + 'target=task 更新 L3 任务档案（action=set_goal 设目标 / progress 记进度 / decision 记决定 / archive_task 归档）；'
      + 'target=pitfall 往 L2 记一条踩坑教训。'
      + '一轮结束时请顺手把「值得下次复用」的结论写进来，不要等用户提醒。',
    parameters: {
      target: {
        type: 'string',
        required: true,
        enum: ['global', 'port', 'task', 'pitfall', 'section'],
        description: 'global（长期记忆）/ port（工作区规范事实）/ task（任务目标与进度）/ pitfall（踩坑）/ section（写进 port 的指定小节）。',
      },
      content: { type: 'string', required: true, description: '要记住的内容。一句话说清；写 global 时会被拆成条目正文。' },
      title: { type: 'string', description: '条目标题（target=global 必填）。' },
      category: {
        type: 'string',
        description: `target=global 时必填，取值：${Object.keys(GLOBAL_CATEGORIES).join(' / ')}。`,
      },
      action: {
        type: 'string',
        enum: ['set_goal', 'progress', 'decision', 'archive_task', 'set_acceptance'],
        description: 'target=task 时的动作；默认 progress。',
      },
      section: {
        type: 'string',
        description: 'target=section 时必填，写进 port 的哪个小节，例如「行为规范与约定」。',
      },
      skipGlobalCheck: {
        type: 'boolean',
        description:
          '仅用于 action=archive_task：跳过"本任务是否写过 L1"的归档闸门。'
          + '只有在**确实判断过本次任务没有可长期复用的结论**时才用；'
          + '有结论时应该先写 target:"global" 再归档。',
      },
      source: { type: 'string', description: '信息来源：用户口述 / 用户确认 / 对话推断。默认「用户确认」。' },
      confidence: { type: 'string', enum: ['高', '中', '低'], description: '可信度；推断类内容请用「中」或「低」并说明依据。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 ["行为规则","硬件"]。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          path: { type: 'string', required: true },
          privacy: { type: 'string', required: true },
          rejected: { type: 'boolean', required: true },
          sanitizedUsed: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.rejected
            ? '❌ 写入被隐私红线拦截。'
            : value.ok ? '✅ 已写入记忆。' : '⚠️ 写入未完成。',
          `目标：${value.target}　→　${value.path}`,
          value.sanitizedUsed ? '（落盘内容已脱敏）' : '',
          value.privacy,
          value.note ?? '',
        ].filter((line) => line !== '').join('\n'),
      }],
      presentationMeta: (_args, value) => ({ path: value.path, ok: value.ok }),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'edit',
      title: `写入记忆 · ${args.target}${args.title === undefined ? '' : ` · ${args.title}`}`,
    }),
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const content = String(args.content ?? '').trim()
      if (content === '') throw new Error('content 不能为空。')

      // ---- 隐私自检（写 global 时最严格；工作区端口不做软红线拦截，避免误伤技术内容）
      const allowSoft = args.target !== 'global'
      const report = settings.privacyGuard === false
        ? { ok: true, blocked: false, hits: [], warnings: [], sanitized: content }
        : inspect(content, { allowSoft })
      const privacyText = settings.privacyGuard === false ? '隐私自检已关闭。' : describePrivacy(report)
      const body = report.blocked ? report.sanitized : content

      // 脱敏后若只剩占位符（整条内容都是敏感信息），就没有记录价值了——
      // 此时明确拒绝，而不是往库里塞一句空话。
      const meaningful = body.replace(/【已脱敏[^】]*】/gu, '').replace(/[\s\p{P}]/gu, '')
      if (report.blocked && meaningful.length < 4) {
        return {
          ok: false,
          target: String(args.target),
          path: '',
          privacy: privacyText,
          rejected: true,
          sanitizedUsed: true,
          note: '整条内容都是敏感信息，脱敏后已无可记录内容，已拒绝写入。请改用泛化表述后重试。',
        }
      }

      if (args.target === 'global') {
        const key = String(args.category ?? '').trim()
        const mapped = GLOBAL_CATEGORIES[key]?.file ?? key
        if (!/^\d{2}-[^\\/]+\.md$/u.test(mapped)) {
          throw new Error(`target=global 需要合法的 category。可用：${Object.keys(GLOBAL_CATEGORIES).join('、')}（或直接传 \`NN-*.md\`）。`)
        }
        const title = String(args.title ?? '').trim()
        if (title === '') throw new Error('target=global 需要 title（条目标题）。')
        const entry = formatEntry({
          title,
          body,
          source: args.source ?? '用户确认',
          confidence: args.confidence ?? '高',
          tags: args.tags ?? [],
        })
        const result = store.appendGlobalEntry(mapped, entry)
        if (result.ok) {
          store.appendMaintenanceLog(
            `写入 | \`${mapped}\` | ${title} | dsh-memory 插件 | 自动沉淀：${String(content).slice(0, 40)}`,
          )
        }
        return {
          ok: result.ok,
          target: 'global',
          path: result.path,
          privacy: privacyText,
          rejected: false,
          sanitizedUsed: report.blocked,
          note: result.ok
            ? '已追加到分类文件并递增条目数。记得 MEMORY.md 索引由插件在归档时统一刷新。'
            : `写入失败：${result.error ?? '未知原因'}`,
        }
      }

      if (args.target === 'port' || args.target === 'pitfall' || args.target === 'section') {
        store.ensurePort(cwd, { projectName: cwd.split(/[\\/]/u).filter(Boolean).at(-1) })
        let port = store.readPort(cwd)
        if (port === undefined) throw new Error(`工作区端口不存在且创建失败：${store.portPath(cwd)}`)
        const section = args.target === 'pitfall'
          ? '踩坑与教训'
          : args.target === 'section'
            ? String(args.section ?? '').trim()
            : '关键事实'
        if (section === '') throw new Error('target=section 需要 section 参数。')
        // 端口文件里所有小节都是三级标题（速览与详述下的 `###`）。
        port = store.appendBullet(port, section, body.replace(/\n+/gu, ' '), 3)
        port = store.setFrontmatter(port, '更新', today())
        const ok = store.writePort(cwd, port)
        return {
          ok,
          target: args.target,
          path: store.portPath(cwd),
          privacy: privacyText,
          rejected: false,
          sanitizedUsed: report.blocked,
          note: ok ? `已追加到「${section}」。` : '写入失败（权限或磁盘）。',
        }
      }

      // target === 'task'
      store.ensurePort(cwd, { projectName: cwd.split(/[\\/]/u).filter(Boolean).at(-1) })
      const action = args.action ?? 'progress'

      if (action === 'archive_task') {
        /*
         * ============ 归档闸门 ============
         *
         * 用户的设计里，L1 是「各工作区共同的大脑」，经验必须往那里沉淀。
         * 但实测发现：沉淀完全靠模型自觉——任务做完、归档一按，那些经验
         * 就只留在本工作区的 archive/ 里，**换个工作区根本看不到**
         * （只有 L1 跨工作区共享）。
         *
         * 闸门把这件事从"靠自觉"变成"流程必经点"：
         *   本任务从未写过 L1 → 拒绝归档，先让模型判断一次。
         *
         * 同时必须给出**体面的跳过路径**（`skipGlobalCheck: true`），
         * 否则遇到"这个任务确实没有可长期复用的结论"时，模型会被卡在
         * 归档这一步出不来，反而变成骚扰。
         */
        if (settings.archiveGate !== false && args.skipGlobalCheck !== true) {
          const events = exec?.agent?.session?.snapshotEvents?.() ?? []
          const globalWrites = findGlobalWrites(events)
          if (!globalWrites.wrote) {
            return {
              ok: false,
              target: 'task',
              path: store.activeTaskPath(cwd),
              privacy: privacyText,
              rejected: true,
              sanitizedUsed: report.blocked,
              note: [
                '⏸ 归档被闸门拦下：本任务还没有往 L1 全局库写过任何东西。',
                '',
                '请先判断一次——本次任务有没有**下次仍会用到的**结论（新知识、踩坑、决定、可复用方法）？',
                '',
                '· 有 → 先调用 `memory_write`（`target:"global"` + 合适的 `category`）写进去，再重新归档。',
                '· 确实没有 → 带上 `skipGlobalCheck: true` 重新调用 `archive_task`。',
                '',
                '为什么要有这道闸门：L1 是**跨工作区共享**的唯一一层。',
                '不写进去，这次的经验就只留在本工作区，别的项目永远看不到。',
              ].join('\n'),
            }
          }
        }

        const target = store.archiveActiveTask(cwd, body)
        return {
          ok: target !== undefined,
          target: 'task',
          path: target ?? store.activeTaskPath(cwd),
          privacy: privacyText,
          rejected: false,
          sanitizedUsed: report.blocked,
          // ARCHIVED_MARKER 是机器可读的成功标记，供 harvest.findTaskBoundary 判定
          // "这次归档是否真的发生"。HTML 注释，渲染给模型看时不可见。
          note: target === undefined
            ? '归档失败。'
            : `任务已归档到 archive/，ACTIVE.md 已回到空闲状态。\n${ARCHIVED_MARKER}`,
        }
      }

      let text = store.readActiveTask(cwd)
      if (text === undefined) throw new Error(`任务档案不存在：${store.activeTaskPath(cwd)}`)

      if (action === 'set_goal') {
        const goalRange = store.sectionRange(text, '任务目标（原始表述，不要在推进中被改写）')
        if (goalRange !== undefined) {
          text = text.slice(0, goalRange.start)
            + `## 任务目标（原始表述，不要在推进中被改写）\n- ${body.replace(/\n+/gu, ' ')}\n\n`
            + text.slice(goalRange.end)
        }
        const statusRange = store.sectionRange(text, '状态')
        if (statusRange !== undefined) {
          text = text.slice(0, statusRange.start)
            + `## 状态\n- 状态：进行中\n- 更新：${today()}\n\n`
            + text.slice(statusRange.end)
        }
      } else if (action === 'set_acceptance') {
        const range = store.sectionRange(text, '验收标准')
        if (range !== undefined) {
          text = text.slice(0, range.start)
            + `## 验收标准\n- ${body.replace(/\n+/gu, ' ')}\n\n`
            + text.slice(range.end)
        }
      } else if (action === 'decision') {
        text = store.appendBullet(text, '关键约束与决定', body.replace(/\n+/gu, ' '))
      } else {
        text = store.appendBullet(text, '进度时间线', `${new Date().toLocaleString('zh-CN', { hour12: false })}　${body.replace(/\n+/gu, ' ')}`)
      }
      const ok = store.writeActiveTask(cwd, text)
      return {
        ok,
        target: 'task',
        path: store.activeTaskPath(cwd),
        privacy: privacyText,
        rejected: false,
        sanitizedUsed: report.blocked,
        note: ok ? `已更新任务档案（action=${action}）。` : '写入失败（权限或磁盘）。',
      }
    },
  }))

  // --------------------------------------------------------------- memory_audit
  /*
   * 「班主任」视角：横向汇总所有工作区。
   *
   * 为什么必须有这个工具：用户说的四层都是**单个工作区内部**的视角，
   * 而用户自己要的是"偶尔检查最近工作情况、有没有按时归档、有没有写错文件"——
   * 这个问题任何单个工作区都答不了。memory_audit 把散落各处的端口
   * 汇总成一份可读报告。
   *
   * 纯只读，不修改任何记忆文件。
   */
  ctx.tools.register(defineTool({
    name: 'memory_audit',
    description:
      '跨工作区审计记忆系统（「班主任」视角）。横向汇总所有工作区的记忆端口：'
      + '各工作区在做什么任务、归档了多少、有没有按时归档、有没有写错文件、'
      + '全局库索引与实际条目数是否对得上。'
      + '当用户问「最近工作怎么样」「有没有按时归档」「检查一下记忆」时用它。'
      + '纯只读，不会修改任何记忆文件。',
    parameters: {
      format: {
        type: 'string',
        enum: ['markdown', 'summary'],
        description: 'markdown = 完整报告（默认）；summary = 只给结论与问题清单。',
      },
      cwd: { type: 'string', description: '额外纳入一个工作区路径（通常不需要，审计会自动发现）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceCount: { type: 'integer', required: true },
          problemCount: { type: 'integer', required: true },
          errorCount: { type: 'integer', required: true },
          globalConsistent: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
      presentationMeta: (_args, value) => ({
        workspaces: value.workspaceCount,
        problems: value.problemCount,
      }),
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', kind: 'search', title: '审计记忆系统（跨工作区）' }),
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const report = buildAudit(store, settings, args.cwd ?? cwd)

      const problems = [
        ...report.global.problems,
        ...report.workspaces.flatMap((ws) => ws.problems),
      ]
      const errors = problems.filter((p) => p.level === 'error')

      if (args.format === 'summary') {
        const lines = [
          `审计完成：${report.workspaces.length} 个工作区，${problems.length} 项发现（其中 ${errors.length} 项错误）`,
          '',
        ]
        if (problems.length === 0) lines.push('✅ 没有发现问题。')
        else {
          for (const p of problems) {
            const icon = { error: '🔴', warn: '🟡', info: '🔵' }[p.level] ?? '·'
            lines.push(`${icon} ${p.detail}`)
          }
        }
        return {
          workspaceCount: report.workspaces.length,
          problemCount: problems.length,
          errorCount: errors.length,
          globalConsistent: report.global.declaredTotal === report.global.actualTotal,
          report: lines.join('\n'),
        }
      }

      return {
        workspaceCount: report.workspaces.length,
        problemCount: problems.length,
        errorCount: errors.length,
        globalConsistent: report.global.declaredTotal === report.global.actualTotal,
        report: renderReport(report),
      }
    },
  }))
}
