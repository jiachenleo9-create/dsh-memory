/**
 * dsh-memory · 记忆简报与目标锚点的组装。
 *
 * 这一层决定「注入什么」——本项目省 token 的核心：
 *   - 默认只注入**指针 + 高信号摘要**，不灌全文；
 *   - 分层预算，任一层超限即截断并注明来源，让模型按需再读；
 *   - 简报与锚点各带标记，可去重、可识别。
 *
 * @module dsh-memory/brief
 */
import { ANCHOR_MARKER, BRIEF_MARKER, clipBytes } from './store.js'

/** 把要点数组渲染成紧凑的 bullet 块。 */
function bullets(items, indent = '') {
  return items.map((item) => `${indent}- ${item}`).join('\n')
}

/**
 * 从任务档案 Markdown 里抽出结构化字段。
 *
 * ## 为什么用逐行扫描而不是正则
 *
 * 早期实现用了这么一条正则：
 *   `^##\s*<标题>[^\n]*\n([\s\S]*?)(?=^##\s|\s*$)`
 * 其中收尾的 `\s*$` **没有 `m` 标志**，于是 `$` 匹配的是"字符串任意位置"，
 * 而 `\s*` 又能匹配空串——整个前瞻几乎立刻成功。
 * 结果是**每个小节只取到第一行**。
 *
 * 后果很隐蔽但严重：`composeAnchor` 里的 `timeline.slice(-6)` 与
 * `constraints.slice(-5)` 形同虚设，L3 注入的"进度/约束"**永远只有 1 条**，
 * 直接削弱了"长任务不忘记在干什么"这个核心能力。
 *
 * 现在改成显式逐行扫描：找到 `## 标题` 后一直收集到下一个 `## ` 为止。
 *
 * @param text - ACTIVE.md 原文
 * @returns `{ status, goal, acceptance, timeline, constraints }`
 */
export function parseTaskCard(text) {
  /** 逐行取出某个 `##` 小节的内容行（去掉列表符号与占位符）。 */
  const pick = (title) => {
    if (typeof text !== 'string') return []
    const lines = text.split(/\r?\n/u)
    let start = -1
    const head = new RegExp(`^##\\s*${title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u')
    for (let index = 0; index < lines.length; index++) {
      if (head.test(lines[index])) { start = index + 1; break }
    }
    if (start < 0) return []

    const collected = []
    for (let index = start; index < lines.length; index++) {
      // 下一个同级或更高级标题即为小节结束
      if (/^#{1,2}\s/u.test(lines[index])) break
      collected.push(lines[index])
    }
    return collected
      .map((line) => line.replace(/^\s*[-*]\s?/u, '').trim())
      .filter((line) => line !== '')
      // 去掉模板占位行
      .filter((line) => !/^（(?:待补充|当前没有进行中的任务)）$/u.test(line))
      // 去掉代码围栏标记，避免把示例算成内容
      .filter((line) => !/^(`{3,}|~{3,})/u.test(line))
  }
  return {
    status: pick('状态')[0]?.replace(/^状态[:：]\s*/u, '') ?? '未知',
    goal: pick('任务目标'),
    acceptance: pick('验收标准'),
    timeline: pick('进度时间线'),
    constraints: pick('关键约束与决定'),
  }
}

/**
 * 组装「记忆简报」——会话开始时注入一次。
 *
 * 结构（按 token 性价比排序）：
 *   1. 指令：这一层告诉模型怎么用记忆（最高信号，几十 token）
 *   2. L2 工作区端口速览：这个工作区是做什么的、规范（最相关）
 *   3. L3 当前任务锚点：正在推进的目标与进度（防遗忘）
 *   4. L1 全局：入口指针 + 核心画像要点 + 按需读取指南
 *
 * @param store - MemoryStore 实例
 * @param settings - 已补全的插件设置
 * @param cwd - 会话工作目录
 * @returns 注入文本；无可注入内容时返回 undefined
 */
export function composeBrief(store, settings, cwd) {
  const parts = []
  const sources = []

  // 先探明哪些层真的可用——工作区只读或尚未建端口时，
  // 不能把不存在的路径当成"已加载"报给模型。
  const port = store.readPort(cwd)
  const active = store.readActiveTask(cwd)
  const globalIndex = store.readGlobalIndex()
  const portAvailable = port !== undefined || active !== undefined

  // ---------- 0. 使用说明（对模型的行为指令） ----------
  const layerLines = []
  if (portAvailable) {
    layerLines.push(`- **L2 工作区记忆端口**（本工作区专属）：\`${store.portPath(cwd)}\``)
    layerLines.push(`- **L3 任务档案**（长任务目标与进度）：\`${store.activeTaskPath(cwd)}\``)
  }
  if (globalIndex !== undefined) {
    layerLines.push(`- **L1 全局个人记忆库**（关于用户的一切）：\`${store.globalIndexPath}\``)
    layerLines.push(`- **隐私红线**（写入前必读）：\`${store.globalPrivacyPath}\``)
  }
  if (!portAvailable) {
    layerLines.push(
      '- ⚠️ **本工作区没有可写的记忆端口**：L2/L3 不可用（工作区只读或尚未创建）。',
      '  本轮只使用 L1 全局库；工作区相关结论请写 `target:"global"`，并告知用户端口不可写。',
    )
  }
  /*
   * L1 缺失必须**显式告警**，不能静默消失。
   *
   * 真实风险：`memoryRoot` 默认是一个绝对路径。换机器、换用户、
   * 或记忆库被移动之后，L1 会指向不存在的目录。早期实现只是"不注入 L1 段"，
   * 于是模型完全不知道"关于用户"的记忆存在过——它会照常回答，
   * 但已经不再"懂用户"了，而用户看不出任何异常。
   *
   * 现在明确告诉模型：L1 不可用，请提醒用户检查路径。
   */
  if (globalIndex === undefined) {
    layerLines.push(
      `- ⚠️ **L1 全局记忆库不可读**：\`${store.globalIndexPath}\` 不存在或无法访问。`,
      '  这意味着「关于用户」的长期记忆本轮完全不可用。',
      '  **请主动告知用户**：记忆库路径可能不对（换机器 / 移动过目录 / 权限问题），',
      '  建议核对配置里的 `memoryRoot`。',
    )
  }

  /*
   * ---------- 四份职责 ----------
   *
   * 用户的设计是按「班级分工」组织的，并且明确要求：
   * 「在每一个对话开始前都告诉模型，你有着四项任务，要记录四份东西」。
   *
   * 所以这里不是罗列"有几层文件"，而是**逐项交代你要负责什么**：
   * 谁自动维护、谁要你主动写。这是整份简报里信号最高的一段。
   */
  const duties = []
  if (globalIndex !== undefined) {
    duties.push(
      '**① L1 班长（全局库）—— 你主动写**',
      `   关于用户本人的长期信息、跨项目可复用的结论 → \`memory_write\` \`target:"global"\` + \`category\`。`,
      '   ⚠️ 这是**唯一跨工作区共享**的一层；你不写，别的项目就永远看不到。',
    )
  }
  if (portAvailable) {
    duties.push(
      '**② L2 课代表（本工作区）—— 你主动写**',
      '   本工作区的稳定事实：它是做什么的、要守什么规矩、踩过什么坑、有什么里程碑',
      '   → `target:"port"`（一般事实）/ `target:"pitfall"`（踩坑教训）。',
      '   注意：**不要**把任务进度写这里，那是 L3 的事。',
    )
    duties.push(
      '**③ L3 小组组长（当前任务）—— 插件自动维护，你只在关键处补**',
      '   插件每轮自动记进度、压缩后自动重述目标；你要做的是：',
      '   新任务开始时把目标写准（`target:"task"` + `action:"set_goal"`），',
      '   做出重要决定时记一条（`action:"decision"`），任务完成时归档（`action:"archive_task"`）。',
    )
    duties.push(
      '**④ L4 工作日志（会话轨迹）—— 全自动，你无需管**',
      '   插件每轮自动落盘；它可丢，不影响其它三层。',
    )
  }

  const actions = [
    '涉及用户本人的任务，直接使用下方已注入内容；需要更多细节时用 `memory_read` 按需读取，**不要**读整个库。',
    '推进长任务时，若发现当前工作偏离了注入的原始目标，先指出偏离再继续。',
    '检索用 `memory_search`，按需精读用 `memory_read`。',
  ]

  parts.push([
    BRIEF_MARKER,
    '## 🧠 记忆系统已自动接管（dsh-memory）',
    '',
    '你**不需要**等用户手动唤起 `personal-memory` 技能。以下记忆已自动加载：',
    '',
    ...layerLines,
    '',
    '### 你的四项职责（要维护的四份东西）',
    '',
    ...duties,
    '',
    '### 通用要求',
    '',
    ...actions.map((line, index) => `${index + 1}. ${line}`),
    '',
    '> 归纳一句：**L2 记「这个工作区是怎么运作的」，L3 记「这个任务做到哪了」，',
    '> L1 记「关于用户和可复用的知识」，L4 自动记录不用你管。**',
    '> 长任务里最容易漏的是 **L1**——因为它只能靠你主动写。',
  ].join('\n'))

  // ---------- 1. L2 工作区端口 ----------
  if (port !== undefined) {
    const quick = extractQuickView(port)
    if (quick !== undefined && quick.trim() !== '') {
      parts.push([
        `## 📍 L2 · 本工作区记忆端口`,
        `> 文件：\`${store.portPath(cwd)}\`（完整版请用 \`memory_read target:"port"\`）`,
        '',
        clipBytes(quick.trim(), settings.portInlineBytes),
      ].join('\n'))
      sources.push('port')
    }
  }

  // ---------- 2. L3 任务锚点 ----------
  if (active !== undefined) {
    const card = parseTaskCard(active)
    if (card.status !== '空闲' && card.goal.length > 0) {
      const lines = [`## 🎯 L3 · 当前任务（进行中）`, `**状态**：${card.status}`, '']
      lines.push('**任务目标（原始表述）**', bullets(card.goal))
      if (card.acceptance.length > 0) lines.push('', '**验收标准**', bullets(card.acceptance))
      if (card.timeline.length > 0) {
        lines.push('', `**进度（最近 ${Math.min(card.timeline.length, 6)} 条）**`, bullets(card.timeline.slice(-6)))
      }
      if (card.constraints.length > 0) lines.push('', '**关键约束**', bullets(card.constraints.slice(-5)))
      parts.push(clipBytes(lines.join('\n'), settings.anchorInlineBytes))
      sources.push('task')
    }
  }

  // ---------- 3. L1 全局库 ----------
  if (globalIndex !== undefined) {
    const highlights = store.globalHighlights(10)
    const guide = store.globalRoutingGuide(20)
    const stats = store.globalStats()
    const lines = [
      '## 🌐 L1 · 全局个人记忆库',
      `> 根目录：\`${store.memoryRoot}\`　｜　入口：\`${store.globalIndexPath}\``,
      stats === undefined ? '' : `> 条目总数：${stats.total ?? '?'}　｜　最后更新：${stats.updated ?? '?'}`,
      '',
      '**关于用户的核心画像（10 条）**',
      highlights.length > 0 ? bullets(highlights) : '- （索引为空）',
    ].filter((line) => line !== '')
    if (guide.length > 0) {
      lines.push('', '**按需读取指南**（先读入口，再按主题取 1–3 个分类文件，不要一次读完整个库）')
      lines.push(bullets(guide.map((row) => `${row.topic} → ${row.files}`)))
    }
    lines.push('', `**写入前必读隐私红线**：\`${store.globalPrivacyPath}\`（插件已在 \`memory_write\` 内置自动自检）`)
    parts.push(clipBytes(lines.join('\n'), settings.globalInlineBytes))
    sources.push('global')
  }

  if (sources.length === 0) return undefined

  const text = parts.join('\n\n---\n\n')
  return clipBytes(text, settings.maxInjectBytes)
}

/**
 * 抽取工作区端口的「速览」部分（`## 速览` 到下一个 `##`），
 * 没有标记时退回文件头部若干行。
 * @param text - WORKSPACE.md 原文
 * @returns 速览文本
 */
export function extractQuickView(text) {
  if (typeof text !== 'string') return undefined
  // 逐行扫描比正则更可靠：正则在"空行也算行尾"的情况下会提前匹配。
  const lines = text.split(/\r?\n/u)
  let start = -1
  for (let index = 0; index < lines.length; index++) {
    if (/^##\s*速览/u.test(lines[index])) { start = index + 1; break }
  }
  if (start >= 0) {
    const body = []
    for (let index = start; index < lines.length; index++) {
      if (/^##(?!#)/u.test(lines[index])) break
      body.push(lines[index])
    }
    const joined = body.join('\n').trim()
    if (joined !== '') return joined
  }
  // 退回：跳过 frontmatter 与首行标题，取正文前 40 行。
  return text
    .replace(/^---[\s\S]*?---\s*/u, '')
    .split(/\r?\n/u)
    .slice(0, 40)
    .join('\n')
    .trim()
}

/**
 * 组装「目标锚点」——在长会话中定期、以及 compaction 之后重注入。
 *
 * 这是解决「长任务忘记最初目标」的关键：把原始目标 + 验收标准 + 关键约束
 * 放到最近的位置，抵消「lost in the middle」与压缩造成的目标漂移。
 *
 * @param store - MemoryStore 实例
 * @param settings - 已补全的插件设置
 * @param cwd - 会话工作目录
 * @param reason - 触发原因（`interval` | `compact` | `resume`）
 * @param turn - 当前轮次
 * @returns 注入文本；没有进行中任务时返回 undefined
 */
export function composeAnchor(store, settings, cwd, reason, turn) {
  const active = store.readActiveTask(cwd)
  if (active === undefined) return undefined
  const card = parseTaskCard(active)
  if (card.status === '空闲' || card.goal.length === 0) return undefined

  const why = {
    interval: `已进行到第 ${turn} 轮，按周期重述目标以防偏移`,
    compact: '上下文刚刚被压缩，原始目标可能已不在可见范围内——立即重述',
    resume: '会话恢复，重述目标',
    manual: '手动重述目标',
  }[reason] ?? '重述目标'

  const lines = [
    ANCHOR_MARKER,
    `## 🎯 目标锚点（${why}）`,
    '',
    '**这项任务最初设定的目标（原文，不要在推进中被改写）**',
    bullets(card.goal),
  ]
  if (card.acceptance.length > 0) lines.push('', '**验收标准**', bullets(card.acceptance))
  if (card.constraints.length > 0) lines.push('', '**必须遵守的约束**', bullets(card.constraints.slice(-6)))
  if (card.timeline.length > 0) {
    lines.push('', `**已完成（最近 ${Math.min(card.timeline.length, 5)} 条）**`, bullets(card.timeline.slice(-5)))
  }
  lines.push(
    '',
    '> 若当前工作已偏离上述目标，请先说明偏离点再继续；',
    '> 若目标已完成，请调用 `memory_write` 以 `action:"archive_task"` 归档，然后开始新任务。',
  )
  return clipBytes(lines.join('\n'), settings.anchorInlineBytes)
}
