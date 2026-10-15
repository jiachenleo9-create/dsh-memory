/**
 * dsh-memory · 跨工作区审计（「班主任」视角）。
 *
 * ## 为什么单独成模块
 *
 * 前四层都是**单个工作区**内部的视角：
 *   L2 课代表知道本工作区做到哪了，L3 组长知道本任务在干什么，
 *   L4 个人日志知道本轮做了啥。
 *
 * 但用户是「班主任」：他关心的是**全局**——
 *   「最近各工作区干得怎么样？有没有按时归档？有没有写错文件？」
 *
 * 这个问题**任何一个工作区自己都答不了**，必须横向汇总所有工作区的端口。
 * 这正是本模块的职责。
 *
 * ## 设计约束：只读
 *
 * 审计是**纯只读**操作：它不修改任何记忆文件，也不触发任何写入。
 * 这样用户可以随时随地跑一次检查，不必担心"看一眼就把状态改了"。
 *
 * @module dsh-memory/audit
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { parseTaskCard } from './brief.js'
import { countEntries } from './store.js'

/** 一次审计中，单个工作区最多列出几条归档。 */
const MAX_ARCHIVES_PER_WORKSPACE = 5

/** 「很久没动」的阈值（天）。 */
const STALE_DAYS = 30

/** 读文本，失败返回 undefined。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 相对现在多少天前。 */
function daysAgo(time) {
  if (!Number.isFinite(time)) return undefined
  return Math.floor((Date.now() - time) / 86_400_000)
}


/**
 * 从文本里读出「更新」日期的时间戳。
 *
 * ⚠️ 必须同时兼容两种写法，否则日期读不出来、依赖它的检查会**静默失效**：
 *
 *   1. frontmatter 风格（WORKSPACE.md 用）：`更新: 2026-01-01`
 *   2. 正文列表项（ACTIVE.md 用）：`- 更新：2026-10-12`
 *
 * 真实事故：早期正则写成 `^更新\s*:\s*(...)`（要求行首就是"更新"、半角冒号），
 * 而 ACTIVE.md 实际是 `- 更新：2026-10-12`（带列表符号 + **全角冒号**），
 * 于是永远匹配不到 → `daysAgo` 返回 undefined → "任务陈旧、可能忘了归档"
 * 这个**用户最关心的检查**从来没触发过。
 *
 * @param text - 文件原文
 * @param field - 字段名，默认「更新」
 * @returns 时间戳，读不到时 undefined
 */
function stampOf(text, field = '更新') {
  if (typeof text !== 'string') return undefined
  // 允许行首有列表符号 / 引用符号 / 空白；冒号半角全角都认。
  const re = new RegExp(`^[\\s>*+-]*${field}\\s*[:：]\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})`, 'mu')
  const match = re.exec(text)
  if (match === null) return undefined
  const time = Date.parse(`${match[1]}T00:00:00`)
  return Number.isFinite(time) ? time : undefined
}

/**
 * 在一个工作区端口目录里做检查。
 *
 * @param portDir - `<工作区>/.dsh/memory` 绝对路径
 * @returns 检查结果
 */
export function inspectPort(portDir) {
  const result = {
    portDir,
    hasWorkspace: false,
    hasActive: false,
    task: undefined,
    archives: [],
    archiveCount: 0,
    sessionLogs: 0,
    lastActivity: undefined,
    problems: [],
  }

  const portPath = join(portDir, 'WORKSPACE.md')
  const activePath = join(portDir, 'ACTIVE.md')
  const archiveDir = join(portDir, 'archive')
  const sessionsDir = join(portDir, 'sessions')

  // ---- L2 工作区端口 ----
  const port = readText(portPath)
  result.hasWorkspace = port !== undefined
  if (port !== undefined) {
    result.lastActivity = stampOf(port, '更新')
    // 占位符没被填过 = 课代表还没上任
    if (/^-\s*（待补充）/mu.test(port)) {
      result.problems.push({ level: 'info', kind: 'empty-port', detail: '工作区端口仍是模板，未填写实际内容' })
    }
  } else {
    result.problems.push({ level: 'warn', kind: 'missing-port', detail: 'WORKSPACE.md 不存在' })
  }

  // ---- L3 任务档案 ----
  const active = readText(activePath)
  result.hasActive = active !== undefined
  if (active !== undefined) {
    const card = parseTaskCard(active)
    result.task = card

    if (card.status === '进行中') {
      result.problems.push({ level: 'info', kind: 'task-open', detail: `有进行中的任务：${card.goal[0] ?? '(无目标)'}` })

      /*
       * 关键检查：进行中的任务有没有"卡住"。
       * 用户明确说过他关心"有没有按时归档"。判断依据是 ACTIVE.md 的
       * 更新时间与当前时间的差——任务开着但很久没动，多半是忘了归档。
       */
      const stamp = stampOf(active, '更新') ?? undefined
      const days = daysAgo(stamp)
      if (days !== undefined && days >= STALE_DAYS) {
        result.problems.push({
          level: 'warn',
          kind: 'stale-task',
          detail: `任务「${card.goal[0] ?? '?'}」已 ${days} 天没有更新，可能忘了归档`,
        })
      }
    }

    // 目标为空却是进行中 = 数据不一致
    if (card.status === '进行中' && card.goal.length === 0) {
      result.problems.push({ level: 'error', kind: 'task-without-goal', detail: '状态是进行中，但任务目标为空' })
    }
    // 目标是占位符却没改成空闲
    if (card.status === '进行中' && card.goal.some((g) => g.includes('当前没有进行中的任务'))) {
      result.problems.push({ level: 'error', kind: 'state-mismatch', detail: '状态与目标不一致：目标是空闲占位，状态却是进行中' })
    }
  } else {
    result.problems.push({ level: 'warn', kind: 'missing-active', detail: 'ACTIVE.md 不存在' })
  }

  // ---- 归档 ----
  if (existsSync(archiveDir)) {
    try {
      const files = readdirSync(archiveDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
          const full = join(archiveDir, name)
          let mtime = 0
          try { mtime = statSync(full).mtimeMs } catch { /* 忽略 */ }
          return { name, path: full, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)

      result.archiveCount = files.length
      result.archives = files.slice(0, MAX_ARCHIVES_PER_WORKSPACE).map((file) => {
        const text = readText(file.path)
        // 归档文件里第一行 `> 归档说明：` 是归档理由
        const summary = /^>\s*归档说明[:：]\s*(.*)$/mu.exec(text ?? '')?.[1]?.trim()
        // 目标取自归档正文里的任务目标小节
        const goal = /^##\s*任务目标[^\n]*\n+([^\n#]+)/mu.exec(text ?? '')?.[1]?.replace(/^-\s*/u, '').trim()
        return { name: file.name, days: daysAgo(file.mtime), summary, goal }
      })

      // 归档文件命名检查（应为 `YYYY-MM-DD-*.md`）
      for (const file of files) {
        if (!/^\d{4}-\d{2}-\d{2}-/.test(file.name)) {
          result.problems.push({ level: 'warn', kind: 'bad-archive-name', detail: `归档文件名不符合 \`YYYY-MM-DD-标题.md\`：${file.name}` })
        }
      }
    } catch {
      result.problems.push({ level: 'warn', kind: 'archive-unreadable', detail: 'archive/ 目录无法读取' })
    }
  }

  // ---- L4 会话轨迹 ----
  if (existsSync(sessionsDir)) {
    try {
      result.sessionLogs = readdirSync(sessionsDir).filter((name) => name.endsWith('.md')).length
    } catch { /* 忽略 */ }
  }

  return result
}

/**
 * 审计全局库本身：有没有写坏、索引与文件是否对得上。
 *
 * ## 精度原则（不要制造噪音）
 *
 * 审计的价值在于**每条告警都值得行动**。用户说了他只会"偶尔检查一下"，
 * 所以不能拿结构性事实去刷屏：
 *
 *   - `00-隐私红线.md` 是规则清单、`12-记忆维护日志.md` 是日志流水，
 *     两者**本来就不是条目容器**，不该报"缺 `## 条目`"。
 *   - 条目数为 0 的分类文件（`06/08`）是正常的"尚未录入"，
 *     frontmatter 写 0、实际 0，一致即通过。
 *   - 只有**声明与实际不一致**才是真问题（那意味着有写入绕过了工具层）。
 *
 * @param memoryRoot - L1 全局库根目录
 * @returns 检查结果
 */
export function inspectGlobal(memoryRoot) {
  const result = { memoryRoot, entries: [], problems: [], indexUpdated: undefined, declaredTotal: undefined, actualTotal: undefined }

  /** 这两类文件不是条目容器，跳过"缺小节"检查。 */
  const NOT_ENTRY_CONTAINERS = new Set(['00-隐私红线.md', '12-记忆维护日志.md'])

  const indexPath = join(memoryRoot, 'MEMORY.md')
  const index = readText(indexPath)
  if (index === undefined) {
    result.problems.push({ level: 'error', kind: 'missing-index', detail: 'MEMORY.md 不存在（L1 入口缺失）' })
    return result
  }

  result.indexUpdated = /最后更新[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/u.exec(index)?.[1]
  const declared = /条目总数[:：]\s*([0-9]+)/u.exec(index)?.[1]
  result.declaredTotal = declared === undefined ? undefined : Number(declared)

  // 逐个数分类文件里的 `### ` 条目
  let actual = 0
  let names
  try {
    names = readdirSync(memoryRoot).filter((name) => /^\d{2}-.*\.md$/u.test(name)).sort()
  } catch {
    result.problems.push({ level: 'error', kind: 'unreadable-root', detail: `无法读取记忆库根目录：${memoryRoot}` })
    return result
  }

  for (const name of names) {
    const text = readText(join(memoryRoot, name))
    if (text === undefined) {
      result.problems.push({ level: 'warn', kind: 'unreadable-category', detail: `${name} 无法读取` })
      continue
    }
    const counted = countEntries(text)
    // 只有条目容器的条目计入总数：00 是规则清单、12 是日志流水，
    // 它们的 `###` 不是记忆条目。这必须与 store.syncIndex() 的口径完全一致，
    // 否则审计会报一个自己造成的假不一致。
    const isContainer = !NOT_ENTRY_CONTAINERS.has(name)
    if (isContainer) actual += counted
    const declaredInFile = /条目数[:：]\s*([0-9]+)/u.exec(text)?.[1]
    const entry = {
      name,
      isContainer,
      counted,
      declared: declaredInFile === undefined ? undefined : Number(declaredInFile),
      updated: /更新[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/u.exec(text)?.[1],
      bytes: Buffer.byteLength(text, 'utf8'),
    }
    result.entries.push(entry)

    /*
     * 只有条目容器才做结构检查。
     * 00-隐私红线.md 是规则清单、12-记忆维护日志.md 是日志流水，
     * 它们本来就没有 `## 条目`，报这个属于噪音。
     */

    if (isContainer) {
      // frontmatter 声明的条目数应与实际一致（用户担心"写错文件"）
      if (entry.declared !== undefined && entry.declared !== counted) {
        result.problems.push({
          level: 'warn',
          kind: 'count-mismatch',
          detail: `${name} frontmatter 声明 ${entry.declared} 条，实际 ${counted} 条——可能有写入绕过了 memory_write`,
        })
      }
      // 结构性检查：必须有 `## 条目` 容器，否则追加会落到文件末尾
      if (!/^##\s*条目/mu.test(text)) {
        result.problems.push({ level: 'warn', kind: 'no-entries-section', detail: `${name} 缺少 \`## 条目\` 小节，新条目会追加到文末` })
      }
      // 占位符残留说明脱敏把内容吃掉了
      if (text.includes('【已脱敏')) {
        const count = (text.match(/【已脱敏/g) ?? []).length
        result.problems.push({ level: 'info', kind: 'masked-content', detail: `${name} 含 ${count} 处脱敏占位符，建议人工核对是否为误报` })
      }
    }
  }

  result.actualTotal = actual
  if (result.declaredTotal !== undefined && result.declaredTotal !== actual) {
    result.problems.push({
      level: 'warn',
      kind: 'total-mismatch',
      detail: `MEMORY.md 声明共 ${result.declaredTotal} 条，实际统计 ${actual} 条`,
    })
  }

  // 维护日志存在性
  if (readText(join(memoryRoot, '12-记忆维护日志.md')) === undefined) {
    result.problems.push({ level: 'warn', kind: 'missing-log', detail: '12-记忆维护日志.md 不存在' })
  }

  return result
}

/**
 * 找出所有带记忆端口的工作区。
 *
 * 端口目录形如 `<工作区>/.dsh/memory`，散落在磁盘各处，
 * 没有中央注册表，所以只能从两个已知来源枚举：
 *   1. `sessions/` 下的工作区目录名（DSH 用 `--<路径编码>--` 的形式记录）；
 *   2. 用户显式提供的路径。
 *
 * @param sessionRoot - DSH 的 sessions 根目录
 * @returns `{ cwd, portDir }` 数组
 */
export function discoverWorkspaces(sessionRoot) {
  const found = new Map()

  /**
   * 从会话日志头部读**权威的 cwd**。
   *
   * ## 为什么不靠目录名反解
   *
   * DSH 的 sessions 目录名是 `--<盘符>-<路径，分隔符→`-`>--`，
   * 非 ASCII 转 `~XXXX`。这个编码**本质上是有损的**：
   * 路径里原本就有的 `-`（如 `dec-h41ZXk`）和作为分隔符的 `-` 无法区分，
   * 所以任何反解都只能"猜"，遇到含连字符的目录名就会解出不存在的路径。
   *
   * 而每个会话日志的**第一行头部**里有原样的 `cwd` 字段：
   *   `{"type":"session","version":4,"id":"...","cwd":"D:\\projects\\demo"}`
   * 这是权威来源，不需要猜。
   *
   * 日志是 zstd 压缩的，头部在**第一帧**——`zstdDecompressSync` 正好只解第一帧，
   * 所以读头部既便宜又不需要处理多帧。
   *
   * @param sessionDir - 某个会话目录
   * @returns 该会话记录的 cwd，读不到时 undefined
   */
  const readCwdFromSession = (sessionDir) => {
    let names
    try {
      names = readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))
    } catch {
      return undefined
    }
    for (const name of names) {
      const full = join(sessionDir, name)
      let text
      try {
        const raw = readFileSync(full)
        text = name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
      } catch {
        continue
      }
      // 头部是第一行；只解析这一行，不碰后面的大块内容。
      const firstLine = text.split('\n', 1)[0]
      if (firstLine === undefined || firstLine.trim() === '') continue
      try {
        const header = JSON.parse(firstLine)
        const cwd = header?.cwd
        if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
      } catch {
        continue
      }
    }
    return undefined
  }

  /**
   * 兜底：从目录名反解路径。
   *
   * 只在会话日志缺失/损坏时使用。⚠️ 有损：路径里含 `-` 时会解错，
   * 所以调用方必须用 `existsSync` 验证结果，解错即丢弃。
   *
   * @param name - sessions 下的目录名
   * @returns 猜测的路径
   */
  const decodeFallback = (name) => {
    const inner = name.replace(/^--/u, '').replace(/--$/u, '')
    if (inner === '') return undefined
    // 只吃前导 `~`：四位十六进制码元（无尾随波浪号）。
    const decoded = inner.replace(/~([0-9A-Fa-f]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    const withColon = decoded.replace(/^([A-Za-z])-/u, '$1:')
    return withColon.replace(/-/gu, '\\')
  }

  try {
    for (const entry of readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sessionDir = join(sessionRoot, entry.name)

      // 先查该目录下每个会话子目录的头部（权威）。
      const candidates = [sessionDir]
      try {
        for (const child of readdirSync(sessionDir, { withFileTypes: true })) {
          if (child.isDirectory()) candidates.push(join(sessionDir, child.name))
        }
      } catch { /* 读不到子目录就用自己 */ }

      let cwd
      for (const dir of candidates) {
        cwd = readCwdFromSession(dir)
        if (cwd !== undefined) break
      }

      // 兜底：目录名反解（必须验证存在性，否则会收进一堆假路径）。
      if (cwd === undefined) {
        const guessed = decodeFallback(entry.name)
        if (guessed !== undefined && existsSync(guessed)) cwd = guessed
      }
      if (cwd === undefined) continue

      const portDir = join(cwd, '.dsh', 'memory')
      if (existsSync(join(portDir, 'ACTIVE.md')) || existsSync(join(portDir, 'WORKSPACE.md'))) {
        found.set(portDir.toLowerCase(), { cwd, portDir })
      }
    }
  } catch {
    /* sessions 目录不可读时返回空列表 */
  }

  return [...found.values()]
}

/**
 * 组装一次完整审计：全局库 + 所有发现的工作区 + 额外指定的工作区。
 *
 * @param store - MemoryStore（只用它的 `portDirFor`）
 * @param settings - 插件设置（需要 `memoryRoot` 与 `sessionRoot`）
 * @param extraCwd - 额外纳入的工作区路径（可为空）
 * @returns `{ generatedAt, global, workspaces }`
 */
export function buildAudit(store, settings, extraCwd) {
  const workspaces = discoverWorkspaces(settings.sessionRoot).map((entry) => ({
    cwd: entry.cwd,
    ...inspectPort(entry.portDir),
  }))

  // 把额外指定的工作区并进来（按 portDir 去重）
  if (typeof extraCwd === 'string' && extraCwd.trim() !== '') {
    const portDir = store.portDirFor(extraCwd)
    if (!workspaces.some((ws) => ws.portDir.toLowerCase() === portDir.toLowerCase())) {
      workspaces.push({ cwd: extraCwd, ...inspectPort(portDir) })
    }
  }

  // 问题多的排前面，方便一眼看到需要处理的工作区
  const weight = (ws) => ws.problems.reduce(
    (sum, p) => sum + (p.level === 'error' ? 3 : p.level === 'warn' ? 1 : 0), 0)
  workspaces.sort((a, b) => weight(b) - weight(a))

  return {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    global: inspectGlobal(settings.memoryRoot),
    workspaces,
  }
}

/**
 * 生成一份班主任可读的审计报告（Markdown）。
 *
 * @param parts - `{ global, workspaces, generatedAt }`
 * @returns Markdown 文本
 */
export function renderReport(parts) {
  const lines = []
  const totalProblems = parts.global.problems.length
    + parts.workspaces.reduce((sum, w) => sum + w.problems.length, 0)

  lines.push('# 记忆系统审计报告', '')
  lines.push(`> 生成时间：${parts.generatedAt}`)
  lines.push(`> 全局库：\`${parts.global.memoryRoot}\``)
  lines.push(`> 工作区端口：${parts.workspaces.length} 个　｜　发现问题：${totalProblems} 项`)
  lines.push('')

  // ---------------- 总览 ----------------
  lines.push('## 一、总览', '')
  lines.push('| 工作区 | 任务状态 | 当前任务 | 归档数 | 轨迹数 | 最近活动 | 问题 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const ws of parts.workspaces) {
    const name = ws.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? ws.cwd
    const status = ws.task?.status ?? '无档案'
    const goal = (ws.task?.goal?.[0] ?? '—').slice(0, 40)
    const activity = ws.lastActivity === undefined ? '—' : `${daysAgo(ws.lastActivity)} 天前`
    const problems = ws.problems.filter((p) => p.level !== 'info').length
    lines.push(`| ${name} | ${status} | ${goal} | ${ws.archiveCount} | ${ws.sessionLogs} | ${activity} | ${problems === 0 ? '✅' : `⚠️ ${problems}`} |`)
  }
  lines.push('')

  // ---------------- 全局库 ----------------
  lines.push('## 二、全局记忆库（班长）', '')
  const g = parts.global
  lines.push(`- 索引更新：${g.indexUpdated ?? '未知'}`)
  lines.push(`- 声明条目：${g.declaredTotal ?? '?'}　｜　实际统计：${g.actualTotal ?? '?'}　｜　${g.declaredTotal === g.actualTotal ? '✅ 一致' : '⚠️ 不一致'}`)
  lines.push('')
  lines.push('| 分类文件 | 条目（声明/实际） | 更新 | 大小 |')
  lines.push('|---|---|---|---|')
  for (const entry of g.entries) {
    const flag = entry.declared !== undefined && entry.declared !== entry.counted ? ' ⚠️' : ''
    lines.push(`| ${entry.name} | ${entry.declared ?? '?'} / ${entry.counted}${flag} | ${entry.updated ?? '—'} | ${(entry.bytes / 1024).toFixed(1)} KB |`)
  }
  lines.push('')

  // ---------------- 发现问题 ----------------
  lines.push('## 三、发现的问题', '')
  const emit = (title, problems) => {
    if (problems.length === 0) return
    lines.push(`### ${title}`, '')
    for (const p of problems) {
      const icon = { error: '🔴', warn: '🟡', info: '🔵' }[p.level] ?? '·'
      lines.push(`- ${icon} **${p.kind}** — ${p.detail}`)
    }
    lines.push('')
  }
  emit('全局库', g.problems)
  for (const ws of parts.workspaces) {
    emit(ws.cwd, ws.problems)
  }
  if (totalProblems === 0) lines.push('✅ 没有发现问题。', '')

  // ---------------- 归档明细 ----------------
  lines.push('## 四、最近归档', '')
  let anyArchive = false
  for (const ws of parts.workspaces) {
    if (ws.archives.length === 0) continue
    anyArchive = true
    lines.push(`### ${ws.cwd}`, '')
    for (const a of ws.archives) {
      const when = a.days === undefined ? '' : `（${a.days} 天前）`
      lines.push(`- \`${a.name}\`${when}`)
      if (a.goal) lines.push(`  - 目标：${a.goal.slice(0, 80)}`)
      if (a.summary) lines.push(`  - 说明：${a.summary.slice(0, 80)}`)
    }
    lines.push('')
  }
  if (!anyArchive) lines.push('（没有任何归档记录）', '')

  return lines.join('\n')
}
