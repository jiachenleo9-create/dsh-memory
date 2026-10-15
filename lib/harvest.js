/**
 * dsh-memory · 会话轨迹采集与任务锚点自动维护。
 *
 * 核心设计（为什么这样能省 token）：
 *
 *   1. **零 token 的机械采集**：轮次、工具调用、文件读写、最终答复，
 *      全部从会话事件里直接读，不需要额外调用模型。
 *   2. **原始目标逐字保留**：一个会话的**第一条**实质用户消息就是原始目标，
 *      原样写进 ACTIVE.md，之后只增不改——这是「不忘记最初重点」的物理保证。
 *   3. **语义沉淀交给模型自己**：插件负责把「该沉淀了」这件事通过系统提示词
 *      常态化，模型在本轮内顺手调用 `memory_write`，不额外多花一轮。
 *
 * @module dsh-memory/harvest
 */
import { nowStamp, today } from './store.js'
import { parseTaskCard } from './brief.js'
import { isInjectedSource } from './source.js'

/** 会被记入文件账本的工具。 */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor'])

/** 看起来像"实质任务"而不是寒暄/闲聊的最小有效字符数（按中文字密度定）。 */
const TASK_MIN_CHARS = 14

/**
 * 归档**成功**时写入工具结果的机器可读标记。
 *
 * 发布方：`tools.js` 的 `archive_task` 成功分支。
 * 消费方：`findTaskBoundary()` —— 只有看到这个标记才认为归档真的发生了。
 *
 * 为什么不判断自然语言文案：文案可能被改；而且被闸门拒绝时
 * 也会返回一段含"归档"字样的说明，用文案判断会误判成成功，
 * 导致边界跨过失败尝试、闸门陷入死循环。
 *
 * 标记用 HTML 注释形式，渲染给模型看时不可见（不干扰阅读）。
 */
export const ARCHIVED_MARKER = '<!-- dsh-memory:archived -->'

/**
 * 把一条 user/message 的 content 拍平成纯文本。
 * @param content - ContentBlock 数组
 * @returns 文本
 */
function flatten(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
    .trim()
}

/**
 * 判断一条用户消息是否来自插件注入（而非真人输入）。
 * 具体规则见 `./source.js`——必须与写路径使用同一套判定，
 * 否则会把插件的记忆简报误当成用户的任务描述。
 *
 * @param source - UserMessage.source
 * @returns 是否为注入内容
 */
function isInjected(source) {
  return isInjectedSource(source)
}

/**
 * 判断一段文本是否值得作为任务目标锚定。
 * 过滤掉确认、寒暄、单字回复这类噪音。
 *
 * 注意：中文信息密度远高于英文，所以门槛按「有效字符数」而非纯长度来定——
 * 14 个中文字已经能说清一件事，而 14 个英文字符通常不能。
 *
 * @param text - 用户原文
 * @returns 是否适合作为目标
 */
export function looksLikeTask(text) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  // 有效字符：去掉标点与空白后的实际内容长度。
  const meaningful = flat.replace(/[\s\p{P}\p{S}]/gu, '')
  if (meaningful.length < TASK_MIN_CHARS) return false
  // 纯确认/感谢类短句直接排除。
  if (/^(?:嗯+|好+|ok|OK|okay|可以|行|收到|谢谢|多谢|没事|继续|是的|对|哈哈+)[。！!~～\s]*$/u.test(flat)) return false
  // 以疑问词结尾且很短的多半是提问，不是任务目标。
  if (meaningful.length < TASK_MIN_CHARS + 6 && /[?？]$/u.test(flat)) return false
  return true
}

/**
 * 从一组会话事件里抽取本轮的轨迹快照。
 * @param events - `session.snapshotEvents()` 或事件数组
 * @param turn - 目标轮次
 * @returns 轨迹快照
 */
export function collectTurn(events, turn) {
  const toolCalls = []
  const filesRead = new Set()
  const filesWritten = new Set()
  const assistantTexts = []

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data ?? {}
    if (data.turn !== turn) continue

    if (event.type === 'tool/call') {
      const name = String(data.name ?? '')
      toolCalls.push(name)
      if (FILE_TOOLS.has(name)) {
        let path
        try {
          const args = JSON.parse(String(data.arguments ?? '{}'))
          if (args !== null && typeof args === 'object' && typeof args.file_path === 'string') path = args.file_path
        } catch {
          /* 参数不是合法 JSON 就跳过 */
        }
        if (typeof path === 'string' && path !== '') {
          if (name === 'read') filesRead.add(path)
          else filesWritten.add(path)
        }
      }
    } else if (event.type === 'assistant/message') {
      const text = flatten(data.message?.content)
      if (text !== '') assistantTexts.push(text)
    }
  }

  return {
    turn,
    toolCalls,
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    assistantText: assistantTexts.join('\n\n').trim(),
  }
}

/**
 * 从会话里找出**最早的**实质用户消息——即原始任务目标。
 * 必须逐字保留，后续任何处理都不能改写它。
 *
 * `sinceIndex` 是**任务轮换的关键**：一个会话里可以连续做多个任务，
 * 归档上一个任务之后，新的任务目标必须从**归档点之后**开始找。
 * 否则会把上一个任务的目标当成新任务的目标重新写进去，制造幻觉
 * （"我记得我在做 A"，其实在做 B）。
 *
 * @param events - 会话事件
 * @param options - `{ sinceIndex }`：只在该下标（含）之后查找
 * @returns `{ text, turn, index }` 或 undefined
 */
export function findOriginalGoal(events, options = {}) {
  const from = Number.isInteger(options.sinceIndex) && options.sinceIndex > 0 ? options.sinceIndex : 0
  for (let index = from; index < events.length; index++) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const data = event.data ?? {}
    if (isInjected(data.source)) continue
    const text = flatten(data.content)
    if (!looksLikeTask(text)) continue
    return { text: text.replace(/\s+/gu, ' ').trim(), turn: data.turn ?? 0, index }
  }
  return undefined
}

/**
 * 找出**上一次成功归档**之后的位置，作为新任务的搜索起点。
 *
 * 为什么用「扫日志」而不是在内存里计数：
 *   - 连续做任务时，任务一的后续补充消息（第 2、3 轮的解释）也在会话日志里，
 *     如果只记"任务一开始的下标 +1"，任务二会把那些补充消息当成自己的目标；
 *   - 归档动作本身是日志里的一条 `tool/call`（memory_write / archive_task），
 *     直接以它为界最准确，而且**无状态**——进程重启、会话恢复都不会错位。
 *
 * ## 为什么必须确认「成功」
 *
 * 早期实现只看 `tool/call` 是否带 `archive_task` 参数。但归档可能
 * **被闸门拒绝**（本任务还没写过 L1）——那次调用不是真的归档，
 * ACTIVE.md 仍在进行中。如果把它当成边界，就会：
 *   1. 前面写过的 L1 被划到"上一个任务"里 → `findGlobalWrites` 看不到；
 *   2. 于是闸门**再次拒绝** → 无论怎么写都归档不了，陷入死循环。
 *
 * 判据：**只有成功的归档才调整 ACTIVE.md 的状态**。
 * 被拒绝时闸门提前返回，不会碰 ACTIVE.md。所以这里改看
 * 「该次调用之后，`memory_write` 的结果里是否出现成功归档的特征」——
 * 具体做法是看紧随其后的 `tool/result` 文本里有没有归档成功的标志
 * （`任务已归档` 是 `archive_task` 成功时独有的返回文案）。
 *
 * @param events - 会话事件
 * @returns 搜索起点下标（无成功归档则 0）
 */
export function findTaskBoundary(events) {
  /** 收集每个 callId 对应的工具结果文本。 */
  const resultText = new Map()
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'tool/result') continue
    const block = event.data?.message?.content?.[0]
    const callId = block?.toolCallId
    if (typeof callId !== 'string' || callId === '') continue
    const text = Array.isArray(block.content)
      ? block.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      : ''
    resultText.set(callId, text)
  }

  let boundary = 0
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (data.name !== 'memory_write') continue
    /*
     * 必须**解析参数**判断，不能对原始字符串做 `includes('archive_task')`。
     * 早期实现用的就是子串匹配，结果是：只要正文里提到过 "archive_task"
     * 这个词（例如讨论归档功能本身），就会被误判成一次归档，边界被错误推进，
     * 下一个任务的目标查找起点偏后 → 漏掉真正的目标。
     */
    let parsed
    try {
      parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    if (parsed.action !== 'archive_task') continue

    /*
     * 只认**成功**的归档：结果的文本里必须带 `ARCHIVED_MARKER`。
     *
     * 为什么用标记而不是判断文案：文案是给人读的，随时可能改；
     * 而"这次归档有没有真的发生"是个机器事实，需要一个稳定的判据。
     * 没有 result（调用还在飞、或日志被截断）时按**未成功**处理——
     * 真归档一定会产生 result，保守判断不会漏掉真归档，
     * 却能在闸门拒绝时正确地把边界留在原位。
     */
    const callId = data.callId
    const result = typeof callId === 'string' ? resultText.get(callId) : undefined
    if (result === undefined || !result.includes(ARCHIVED_MARKER)) continue
    boundary = index + 1
  }
  return boundary
}
/**
 * 判断**当前任务**是否已经往 L1 全局库写过东西。
 *
 * 用途：归档闸门（`archive_task` 前检查）。用户的设计里 L1 是
 * 「各工作区共同的大脑」，而经验沉淀完全靠模型自觉 —— 闸门把这件事
 * 从"靠自觉"变成"流程必经点"。
 *
 * 只统计**归档点之后**的写入，因为上一个任务写过的 L1 不能替这个任务交差。
 *
 * @param events - 会话事件
 * @returns `{ wrote, count, lastTurn }`
 */
export function findGlobalWrites(events) {
  const from = findTaskBoundary(events)
  let count = 0
  let lastTurn
  for (let index = from; index < events.length; index++) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (data.name !== 'memory_write') continue
    let parsed
    try {
      parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    if (parsed.target !== 'global') continue
    count += 1
    if (typeof data.turn === 'number') lastTurn = data.turn
  }
  return { wrote: count > 0, count, lastTurn }
}

/**
 * 判断某一轮里模型是否调用过 memory_write（任意 target）。
 *
 * 用途：轮询提醒（每 N 轮检查一次有没有要写 L1 的），
 * 已经写过就不再提醒，避免噪音。
 *
 * @param events - 会话事件
 * @param sinceTurn - 只统计该轮次之后的调用
 * @returns `{ anyWrite, globalWrite }`
 */
export function findWritesSince(events, sinceTurn) {
  let anyWrite = false
  let globalWrite = false
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (data.name !== 'memory_write') continue
    if (typeof data.turn === 'number' && sinceTurn !== undefined && data.turn < sinceTurn) continue
    anyWrite = true
    let parsed
    try {
      parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.target === 'global') globalWrite = true
  }
  return { anyWrite, globalWrite }
}

/** 一句话描述本轮做了什么（机械生成，不调用模型）。 */
export function describeTurn(snapshot) {
  const bits = []
  if (snapshot.filesWritten.length > 0) {
    const names = snapshot.filesWritten.map((path) => path.split(/[\\/]/u).at(-1)).slice(0, 4)
    bits.push(`改动 ${snapshot.filesWritten.length} 个文件（${names.join('、')}）`)
  }
  if (snapshot.filesRead.length > 0 && snapshot.filesWritten.length === 0) {
    bits.push(`查阅 ${snapshot.filesRead.length} 个文件`)
  }
  const counts = new Map()
  for (const name of snapshot.toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1)
  const notable = [...counts.entries()]
    .filter(([name]) => name !== 'read' && name !== 'write' && name !== 'edit')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
  if (notable.length > 0) bits.push(`工具：${notable.join('、')}`)
  return bits.length === 0 ? `第 ${snapshot.turn} 轮（无文件改动）` : bits.join('； ')
}

/** 把可能很长的单行压缩成适合放进时间线的一行。 */
function oneLine(text, max = 160) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * 任务锚点维护器。每个工作区一份 ACTIVE.md。
 */
export class AnchorKeeper {
  /**
   * @param store - MemoryStore
   * @param settings - 插件设置
   */
  constructor(store, settings) {
    this.store = store
    this.settings = settings
  }

  /**
   * 确保本会话有一个任务锚点。若 ACTIVE.md 空闲且本轮做了实事，
   * 用「**本任务**最初的实质用户消息」原文建立目标。
   *
   * 支持一个会话里**连续做多个任务**：每次归档后 ACTIVE.md 回到空闲，
   * 下一个任务会在归档点之后重新找到自己的目标。这是 L3「小组组长」
   * 在长会话里不失效的关键。
   *
   * @param cwd - 工作区
   * @param events - 会话事件
   * @param sessionId - 会话 id
   * @param options - `{ sinceIndex }`：本任务的起点（归档点之后）
   * @returns `{ created, goal }`
   */
  ensureAnchor(cwd, events, sessionId, options = {}) {
    const text = this.store.readActiveTask(cwd)
    if (text === undefined) return { created: false }
    const card = parseTaskCard(text)
    if (card.status !== '空闲' && card.goal.length > 0) return { created: false, goal: card.goal[0] }

    const original = findOriginalGoal(events, options)
    if (original === undefined) return { created: false }

    let next = text
    // 状态
    const statusRange = this.store.sectionRange(next, '状态')
    if (statusRange !== undefined) {
      const body = [
        '## 状态',
        '- 状态：进行中',
        `- 更新：${today()}`,
        `- 会话：${sessionId}`,
        `- 起始轮次：第 ${original.turn} 轮`,
        '',
      ].join('\n')
      next = next.slice(0, statusRange.start) + body + next.slice(statusRange.end)
    }
    // 目标：逐字原文
    const goalRange = this.store.sectionRange(next, '任务目标（原始表述，不要在推进中被改写）')
    if (goalRange !== undefined) {
      const body = [
        '## 任务目标（原始表述，不要在推进中被改写）',
        `- ${original.text}`,
        '',
      ].join('\n')
      next = next.slice(0, goalRange.start) + body + next.slice(goalRange.end)
    }
    // 换任务时清掉上一轮的时间线与约束，避免两个任务的经验混在一起。
    next = this.resetTaskSections(next)

    if (this.store.writeActiveTask(cwd, next)) {
      return { created: true, goal: original.text, sinceIndex: original.index }
    }
    return { created: false }
  }

  /**
   * 任务换挡时清空「进度时间线」与「关键约束与决定」。
   *
   * 为什么必须清：这两个小节描述的是**上一个任务**的过程与结论。
   * 如果不清，新任务的时间线里会混着旧任务的记录，归档时也会把
   * 两个任务的经验搅在一起——这正是用户担心的"写错文件"类问题。
   * 旧内容不会丢，归档时已随 ACTIVE.md 整体存进 archive/。
   *
   * @param text - ACTIVE.md 原文
   * @returns 清空后文本
   */
  resetTaskSections(text) {
    let next = text
    for (const title of ['进度时间线', '关键约束与决定', '验收标准']) {
      const range = this.store.sectionRange(next, title)
      if (range === undefined) continue
      next = `${next.slice(0, range.start)}## ${title}\n- （待补充）\n\n${next.slice(range.end).replace(/^\s+/u, '')}`
    }
    return next
  }

  /**
   * 记录一轮的进度到时间线。
   * @param cwd - 工作区
   * @param snapshot - `collectTurn()` 的返回值
   * @returns 是否写入
   */
  recordProgress(cwd, snapshot) {
    const text = this.store.readActiveTask(cwd)
    if (text === undefined) return false
    const card = parseTaskCard(text)
    if (card.status === '空闲') return false

    const line = `${nowStamp()}　${describeTurn(snapshot)}`
    // 同一秒重复记录去重。
    if (card.timeline.some((item) => item === line)) return false

    let next = this.store.appendBullet(text, '进度时间线', line)
    const statusRange = this.store.sectionRange(next, '状态')
    if (statusRange !== undefined) {
      next = next.replace(/^- 更新：.*$/mu, `- 更新：${today()}`)
    }
    return this.store.writeActiveTask(cwd, next)
  }

  /**
   * 把一条语义结论追加到任务档案的「关键约束与决定」。
   * @param cwd - 工作区
   * @param decision - 结论文本
   * @returns 是否写入
   */
  recordDecision(cwd, decision) {
    const text = this.store.readActiveTask(cwd)
    if (text === undefined) return false
    const next = this.store.appendBullet(text, '关键约束与决定', oneLine(decision, 300))
    return this.store.writeActiveTask(cwd, next)
  }

  /**
   * 生成 L4 会话轨迹文件内容。
   * @param context - `{ sessionId, cwd, snapshots, original, startedAt }`
   * @returns Markdown 文本
   */
  renderTrajectory(context) {
    const lines = [
      '---',
      `会话: ${context.sessionId}`,
      `工作区: ${context.cwd}`,
      `更新: ${new Date().toISOString()}`,
      `轮次: ${context.snapshots.length}`,
      '---',
      '',
      `# 会话轨迹 · ${context.sessionId}`,
      '',
      '> 自动生成，供回溯与沉淀参考。可随时删除，删除不影响 L2/L3。',
      '',
      '## 任务目标（原文）',
      context.original === undefined ? '- （未识别到实质任务）' : `- ${context.original}`,
      '',
      '## 轮次轨迹',
    ]
    for (const snapshot of context.snapshots) {
      lines.push('', `### 第 ${snapshot.turn} 轮`, `- ${describeTurn(snapshot)}`)
      if (snapshot.filesWritten.length > 0) {
        lines.push('- 写入：')
        for (const path of snapshot.filesWritten.slice(0, 12)) lines.push(`  - \`${path}\``)
      }
      if (snapshot.assistantText !== '') {
        lines.push('', '> 最终答复摘要：', `> ${oneLine(snapshot.assistantText, 600)}`)
      }
    }
    return `${lines.join('\n')}\n`
  }
}
