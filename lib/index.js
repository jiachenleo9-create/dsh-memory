/**
 * dsh-memory — DSH 四层自动记忆系统。
 *
 * 解决的问题：用户有一个 `personal-memory` 技能，但每次都得**手动唤起**。
 * 本插件把它变成全自动基础设施：
 *
 *   ① 会话开始 → 自动注入记忆简报（不再需要手动选技能）
 *   ② 长任务中 → 定期 + 压缩后重注入目标锚点（不会忘记最初设定的重点）
 *   ③ 每轮结束 → 零 token 机械采集进度，并在适当时候自动沉淀长期记忆
 *   ④ 每个工作区 → 独立的记忆端口（知道这个工作区是做什么的、有哪些规范）
 *
 * 四层架构（参考 Claude Code 的 managed/user/project/local 四层，
 * 但把「全量注入」换成「索引 + 按需检索」以省 token）：
 *
 *   L1 全局长期记忆   `<memoryRoot>`（默认 `<DSH_HOME>/memory`，只注入指针+摘要）
 *   L2 工作区记忆端口 `<workspace>/.dsh/memory/WORKSPACE.md`
 *   L3 任务档案      `<workspace>/.dsh/memory/ACTIVE.md`（+ archive/）
 *   L4 会话轨迹      `<workspace>/.dsh/memory/sessions/<id>.md`
 *
 * 省 token 的四个关键决定：
 *   1. **只注入索引，不注入全文**。研究结论：~300 token 的聚焦输入优于 ~113k 全量，
 *      因为全量迫使模型同时做检索与推理（Chroma《Context Rot》）。
 *   2. **零 token 采集**。轮次/工具/文件改动直接从会话事件读，不需要额外模型调用。
 *   3. **压缩感知**。目标锚点在 compaction 之后立即重注入；研究确认
 *      「早期指令会随压缩丢失」，且「Lost in the Middle」表明开头与结尾位置最有效。
 *   4. **提醒有冷却与循环护栏**。唯一会额外花 token 的 steer 被限制为
 *      每轮最多一次、每 N 轮最多一次触发。参考 Claude Code Stop hook 的
 *      `stop_hook_active` 防死循环经验。
 *
 * @module dsh-memory
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config, normalize } from './config.js'
import { MemoryStore, BRIEF_MARKER, ANCHOR_MARKER } from './store.js'
import { composeBrief, composeAnchor, parseTaskCard } from './brief.js'
import { AnchorKeeper, collectTurn, findGlobalWrites, findTaskBoundary, looksLikeTask } from './harvest.js'
import { buildAudit, renderReport } from './audit.js'
import { isInjectedSource, producerSource } from './source.js'
import { registerMemoryTools } from './tools.js'
import { RULE_TABLE } from './privacy.js'

export { Config }

/** Cordis 插件名。 */
export const name = 'memory'

/** `tools` 必需；`webServer` / `systemPrompt` 通过 `ctx.inject` 可选接入。 */
export const inject = ['tools']

/**
 * 注入上下文的来源标签。
 *
 * ⚠️ 必须是**生产者自有 kind**，不能用已退役的 `{kind:'plugin', plugin:'...'}`。
 * 详见 `./source.js` 的模块注释（那里有完整的准入规则说明）。
 */
const SOURCE = producerSource()

/** 系统提示词小节的排序位置。 */
const GUIDANCE_ORDER = 2600

/** HTTP 诊断路由前缀。 */
const PREFIX = '/memory'

/** 本模块被求值的时间，用于 `/memory/ping` 证明插件真的重新加载过。 */
const LOADED_AT = new Date().toISOString()

/** 把 ContentBlock[] 拍平成文本。 */
function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/**
 * 判断某个标记当前是否对模型可见（在会话表层里）。
 *
 * 这是「按需注入」的正确性基础：压缩会把历史节点遮蔽掉，
 * 所以必须查**表层**而不是完整日志——否则压缩后我们会误以为目标还在。
 *
 * @param agent - 当前 agent
 * @param marker - 标记字符串
 * @returns 是否可见
 */
function markerVisible(agent, marker) {
  try {
    const session = agent.session
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      if (flattenText(event.data.content).includes(marker)) return true
    }
  } catch {
    /* 表层不可用时按"不可见"处理，宁可多注入一次 */
  }
  return false
}

/**
 * 是否为子代理会话。
 *
 * 子代理生命周期短、任务聚焦，注入记忆是纯浪费——这与 Claude Code
 * 「auto memory 不注入 subagent」的行为一致。
 *
 * @param agent - 待判断的 agent
 * @returns 是否应跳过
 */
function isSubagent(agent) {
  try {
    const header = agent?.session?.header
    if (header === undefined || header === null) return false
    return header.origin === 'subagent' || header.parentSession !== undefined
  } catch {
    return false
  }
}

/**
 * 安装插件。
 * @param ctx - profile scope
 * @param config - profile patch 层配置
 */
export function apply(ctx, config) {
  const settings = normalize(config)
  if (settings.enabled === false) return

  const log = (level, message) => {
    try {
      ctx.logger?.('memory')?.[level]?.(message)
    } catch {
      /* 日志失败不能影响记忆路径 */
    }
  }

  const store = new MemoryStore({
    memoryRoot: settings.memoryRoot,
    workspaceDirName: settings.workspaceDir,
  })
  const keeper = new AnchorKeeper(store, settings)

  /*
   * 启动时确保 L1 记忆库存在。
   *
   * 新用户装完插件是"空手"的：如果 memoryRoot 指向不存在的目录，
   * 整套 L1 会静默失效（简报不出 L1 段、写 global 报"分类文件不存在"），
   * 用户会以为是 bug。所以这里自建一套最小骨架（带填写指引），
   * 已存在的文件绝不覆盖。
   */
  try {
    const bootstrap = store.ensureMemoryRoot()
    if (bootstrap.created.length > 0) {
      log('info', `记忆库已初始化：${settings.memoryRoot}（新建 ${bootstrap.created.length} 个文件）`)
    } else if (!bootstrap.existed) {
      log('warn', `记忆库目录不可写：${settings.memoryRoot}（L1 功能将不可用）`)
    }
  } catch (error) {
    log('warn', `记忆库初始化失败：${String(error)}`)
  }

  /** 每个 agent 的运行时状态。WeakMap 保证 agent 消失后自动回收。 */
  const state = new WeakMap()

  /**
   * session → agent 注册表。
   *
   * `session/event` 只给 session，而压缩处理需要拿到 agent 才能排重注入。
   * 这里自己维护映射，而不是依赖 `ctx.get('agents')` 服务——后者在某些
   * 组装里可能缺席，会让压缩感知静默失效（而它正是防遗忘的关键路径）。
   */
  const sessionAgents = new Map()

  /** 取（或初始化）某个 agent 的记忆状态。 */
  const stateOf = (agent) => {
    let entry = state.get(agent)
    if (entry === undefined) {
      entry = {
        sessionId: undefined,
        cwd: undefined,
        /** 工作区端口是否已准备（幂等标记，覆盖延迟挂载）。 */
        initialized: false,
        /** 简报是否已排队/注入（避免重复扫描表层）。 */
        briefQueued: false,
        /** 刚压缩过，下一轮需要重注入目标。 */
        compactionPending: false,
        /** 已经注入过锚点的轮次。 */
        anchorQueuedTurns: new Set(),
        /** 已经提醒过沉淀的轮次（防循环的核心护栏）。 */
        steeredTurns: new Set(),
        /** 最近一次发出任何 steer 提醒的轮次（4d 与 4e 共用，避免叠加刷屏）。 */
        lastSteerTurn: Number.NEGATIVE_INFINITY,
        /** 最近一次 L1 轮询检查的轮次（避免同一轮重复检查）。 */
        lastL1PollTurn: -1,
        /** 最近一次注入锚点的轮次。 */
        lastAnchorTurn: -1,
        /** 最近一次模型主动写/读记忆的轮次。 */
        lastMemoryWriteTurn: Number.NEGATIVE_INFINITY,
        /** 增量缓存的轮次轨迹，避免每轮 O(轮次²) 重算。 */
        snapshots: new Map(),
      }
      state.set(agent, entry)
    }
    return entry
  }

  /** 会话工作目录；拿不到就退回进程 cwd。 */
  const cwdOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
  }

  /**
   * 幂等地准备一个会话的工作区记忆端口。
   *
   * 会被调用两次：`agent/session-start` 时（正常路径），
   * 以及首次 `pre-step` 时（兜底）——后者覆盖「插件在会话开始之后才挂载」
   * 的情况（profile 冷启动顺序、热加载、或用户中途启用插件）。
   *
   * @param agent - 当前 agent
   * @param entry - 该 agent 的运行时状态
   * @param cwd - 会话工作目录
   */
  const ensureWorkspace = (agent, entry, cwd) => {
    entry.cwd = cwd
    entry.sessionId = agent?.session?.header?.id
    if (agent?.session !== undefined) sessionAgents.set(agent.session, agent)
    entry.initialized = true

    try {
      const { created } = store.ensurePort(cwd, {
        projectName: cwd.split(/[\\/]/u).filter(Boolean).at(-1),
        sessionId: entry.sessionId,
      })
      if (created.length > 0) log('info', `工作区记忆端口已创建：${created.join('、')}`)
    } catch (error) {
      // 工作区可能只读（只读挂载、沙箱限制）。降级为"没有 L2/L3"，
      // 而不是让整轮失败——L1 全局库仍然可读可用。
      log('warn', `工作区端口不可用（降级为仅 L1）：${String(error)}`)
    }
  }

  // ================================================================
  // 1. 会话开始：创建/复用工作区记忆端口
  // ================================================================
  ctx.on('agent/session-start', ({ agent, source }) => {
    if (isSubagent(agent) && settings.injectIntoSubagents !== true) return
    try {
      const entry = stateOf(agent)
      const cwd = cwdOf(agent)
      ensureWorkspace(agent, entry, cwd)

      // 压缩（source==='compact'）或恢复时，表层已被替换/重建，简报需重新注入。
      entry.briefQueued = false
      entry.lastAnchorTurn = -1
      entry.anchorQueuedTurns.clear()
      entry.steeredTurns.clear()

      log('info', `会话开始（${source}），cwd=${cwd}`)
    } catch (error) {
      log('warn', `会话初始化失败：${String(error)}`)
    }
  })

  // ================================================================
  // 2. 压缩感知：标记"原始目标可能已被摘要掉"，下一轮立即重注入
  // ================================================================
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'compaction/end') return
      if (event.data?.error !== undefined) return

      // 优先用自维护的注册表；退化时再问 agents 服务。
      const candidates = []
      const registered = sessionAgents.get(session)
      if (registered !== undefined) candidates.push(registered)
      if (candidates.length === 0) {
        for (const agent of ctx.get('agents')?.list?.() ?? []) {
          if (agent?.session === session) candidates.push(agent)
        }
      }

      for (const agent of candidates) {
        if (isSubagent(agent) && settings.injectIntoSubagents !== true) continue
        const entry = stateOf(agent)
        entry.briefQueued = false
        entry.compactionPending = true
        entry.lastAnchorTurn = -1
        entry.anchorQueuedTurns.clear()
        log('info', '检测到上下文压缩，已安排下一轮重注入目标锚点')
      }
    } catch (error) {
      log('warn', `压缩事件处理失败：${String(error)}`)
    }
  })

  // 会话销毁时清理注册表，避免长期运行下无界增长。
  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (agent?.session !== undefined) sessionAgents.delete(agent.session)
    } catch {
      /* 清理失败不影响功能 */
    }
  })

  // ================================================================
  // 3. pre-step：注入记忆简报与目标锚点（瀑布流，可改写进入本步的消息）
  // ================================================================
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (signal?.aborted) return decision
    if (isSubagent(agent) && settings.injectIntoSubagents !== true) return decision

    try {
      const entry = stateOf(agent)
      const cwd = cwdOf(agent)
      const additions = []

      // ---- 延迟初始化 ----
      // 插件是**会话开始之后**才挂载的（profile 冷启动 / 热加载），
      // 那时 `agent/session-start` 已经派发完毕，端口就会漏建。
      // 所以每个会话在这里补一次幂等的初始化。
      if (entry.initialized !== true) {
        ensureWorkspace(agent, entry, cwd)
      }

      // ---- 记忆简报：只在当前表层里看不到时才注入 ----
      if (settings.autoRead !== false && !entry.briefQueued) {
        if (!markerVisible(agent, BRIEF_MARKER)) {
          const brief = composeBrief(store, settings, cwd)
          if (brief !== undefined) {
            additions.push(createUserMessage({
              content: [{ type: 'text', text: brief }],
              source: SOURCE,
            }))
            entry.briefQueued = true
            log('info', `记忆简报已注入（turn=${turn} step=${step}，${Buffer.byteLength(brief, 'utf8')} 字节）`)
          }
        } else {
          // 表层里已有（例如恢复的会话），无需再注入。
          entry.briefQueued = true
        }
      }

      // ---- 目标锚点：压缩后立即重注入；否则按周期重述 ----
      if (settings.autoAnchor !== false && !entry.anchorQueuedTurns.has(turn)) {
        const sinceCompaction = entry.compactionPending === true
        const intervalHit = settings.anchorEveryTurns > 0
          && turn > 0
          && turn % settings.anchorEveryTurns === 0
          && entry.lastAnchorTurn !== turn

        if (sinceCompaction || intervalHit) {
          const reason = sinceCompaction ? 'compact' : 'interval'
          entry.compactionPending = false
          const anchor = composeAnchor(store, settings, cwd, reason, turn)
          if (anchor !== undefined) {
            additions.push(createUserMessage({
              content: [{ type: 'text', text: anchor }],
              source: SOURCE,
            }))
            entry.anchorQueuedTurns.add(turn)
            entry.lastAnchorTurn = turn
            log('info', `目标锚点已注入（turn=${turn}, reason=${reason}）`)
          }
        }
      }

      if (additions.length === 0) return decision

      // 插到本步"被认领的消息"之后——越靠前越不容易被忽略。
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message))
      const at = lastClaimedIndex < 0 ? decision.messages.length : lastClaimedIndex + 1
      return { ...decision, messages: decision.messages.toSpliced(at, 0, ...additions) }
    } catch (error) {
      log('warn', `记忆注入失败（不影响本轮）：${String(error)}`)
      return decision
    }
  })

  // ================================================================
  // 4. 轮次结束：零 token 机械采集 + 条件式沉淀提醒
  // ================================================================
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal?.aborted) return
    if (isSubagent(agent) && settings.injectIntoSubagents !== true) return
    try {
      const entry = stateOf(agent)
      const cwd = cwdOf(agent)
      const events = agent?.session?.snapshotEvents?.() ?? []
      const sessionId = entry.sessionId ?? agent?.session?.header?.id ?? 'unknown'

      /*
       * ---- 4a. 目标锚定：L3「小组组长」的核心职责 ----
       *
       * 关键在于**每个任务都要锚定**，而不只是本会话的第一个。
       * 搜索起点用 `findTaskBoundary(events)` 从日志里推出来：
       * 它是「最近一次 archive_task 之后」的位置，**无状态**，
       * 因此进程重启、会话恢复、连续做多个任务都不会错位。
       *
       * 早期版本用一个 "已锚定过就不再锚定" 的布尔守卫（存在内存里），
       * 导致任务一归档后任务二永远不会被锚定 —— L3 在长会话里直接失效。
       */
      if (settings.autoHarvest !== false) {
        const ensured = keeper.ensureAnchor(cwd, events, sessionId, {
          sinceIndex: findTaskBoundary(events),
        })
        if (ensured.created) {
          log('info', `已建立任务锚点：${String(ensured.goal).slice(0, 60)}`)
        }
      }

      // ---- 4b. 机械进度采集（不花任何 token）----
      const snapshot = collectTurn(events, turn)
      entry.snapshots.set(turn, snapshot)
      const substantive = snapshot.toolCalls.length >= settings.harvestMinToolCalls

      if (settings.autoHarvest !== false && substantive) {
        keeper.recordProgress(cwd, snapshot)
      }

      // ---- 4c. L4 会话轨迹（用增量缓存渲染，避免每轮重算全部轮次）----
      if (settings.persistTrajectory !== false && substantive) {
        const original = events
          .filter((event) => event?.type === 'user/message'
            && !isInjectedSource(event.data?.source))
          .map((event) => flattenText(event.data?.content))
          .find((text) => looksLikeTask(text))
        const text = keeper.renderTrajectory({
          sessionId,
          cwd,
          snapshots: [...entry.snapshots.values()]
            .filter((item) => item.toolCalls.length > 0 || item.assistantText !== ''),
          original,
        })
        store.writeSessionLog(cwd, sessionId, text)
      }

      // ---- 4d. 沉淀提醒：唯一会额外花 token 的机制，带双重护栏 ----
      const wroteThisTurn = events.some((event) =>
        event?.type === 'tool/call'
        && event.data?.turn === turn
        && typeof event.data?.name === 'string'
        && event.data.name.startsWith('memory_'))

      if (wroteThisTurn) entry.lastMemoryWriteTurn = turn

      // 护栏一：同一轮内最多提醒一次。steer 只会在本 turn 内再跑一步而编号不变，
      //        因此"每轮一次"就足以终止循环（对应 Claude Code 的 stop_hook_active）。
      // 护栏二：冷却期，两次提醒之间至少隔 N 轮。
      const loopGuard = !entry.steeredTurns.has(turn)
      const cooldownOk = turn - entry.lastMemoryWriteTurn >= settings.steerCooldownTurns
      const worthIt = snapshot.toolCalls.length >= settings.steerMinToolCalls

      if (
        settings.steerOnHarvest !== false
        && substantive
        && worthIt
        && !wroteThisTurn
        && loopGuard
        && cooldownOk
      ) {
        entry.steeredTurns.add(turn)
        entry.lastSteerTurn = turn
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: [
              '【记忆沉淀检查】本轮完成了实质工作，但还没有更新记忆。',
              '如果本轮产生了**下次仍会用到的**结论（新事实、规范、踩坑、决定、任务进展），',
              '现在用一次 `memory_write` 记录：',
              '- 本工作区的稳定事实/规范 → `target:"port"`；踩坑 → `target:"pitfall"`',
              '- 任务目标或进度 → `target:"task"`',
              '- 关于用户本人的长期信息 → `target:"global"`（需 `category`）',
              '如果没有值得复用的内容，直接回复「无需记录」即可——不要为了记录而记录。',
            ].join('\n'),
          }],
          source: SOURCE,
        }))
        log('info', `已提醒沉淀记忆（turn=${turn}）`)
      }

      /*
       * ---- 4e. L1 轮询检查（每 N 轮一次）----
       *
       * 与上面 4d 的分工：
       *   4d 管**本轮**——做了实事却没写任何记忆 → 催
       *   4e 管**跨轮**——连续几轮都没往 L1 写过 → 催
       *
       * 为什么单独需要它：L2/L3 由插件自动维护，模型不写也不会漏；
       * 但 **L1 只能靠模型主动写**。长任务里模型很容易一路只更新进度
       * （那是 L3，自动的），从不回头沉淀结论——任务一归档，
       * 那些经验就困在本工作区了（只有 L1 跨工作区共享）。
       *
       * 三重护栏避免变成骚扰：
       *   ① 已经写过 L1 就不提醒（按本任务起点统计，上个任务写的不算）；
       *   ② 本轮的 4d 提醒过就不再叠一次；
       *   ③ 走冷却期，两次提醒之间至少隔 `steerCooldownTurns` 轮。
       */
      if (
        settings.l1PollEveryTurns > 0
        && turn > 0
        && turn % settings.l1PollEveryTurns === 0
        && entry.lastL1PollTurn !== turn
        && substantive
      ) {
        entry.lastL1PollTurn = turn
        const globalWrites = findGlobalWrites(events)
        const alreadySteeredThisTurn = entry.steeredTurns.has(turn)
        // 与 4d 共用同一个"最近提醒轮次"，两种提醒不会叠加刷屏。
        const cooldownOkForL1 = turn - entry.lastSteerTurn >= settings.steerCooldownTurns

        if (!globalWrites.wrote && !alreadySteeredThisTurn && cooldownOkForL1) {
          entry.steeredTurns.add(turn)
          entry.lastSteerTurn = turn
          agent.steer(createUserMessage({
            content: [{
              type: 'text',
              text: [
                `【L1 轮询检查 · 第 ${turn} 轮】`,
                '',
                '本任务进行到现在，**还没有往全局记忆库（L1）写过任何东西**。',
                '',
                'L1 是**唯一跨工作区共享**的一层——不写进去，这次任务的经验就只留在本工作区，',
                '换到别的项目时完全看不到。',
                '',
                '请花一秒判断：到目前为止有没有**下次仍会用到的**结论？',
                '',
                '- 新踩的坑 / 新学到的规律 → `memory_write` `target:"global"`',
                '- 关于用户本人的新信息（偏好、技术栈、项目）→ `target:"global"`',
                '- 技术选型、方法论等可复用决定 → `target:"global"`',
                '',
                '有就现在写（可一次写多条）；确实没有就回复「暂无」继续干活，不必勉强。',
              ].join('\n'),
            }],
            source: SOURCE,
          }))
          log('info', `L1 轮询提醒（turn=${turn}）`)
        }
      }
    } catch (error) {
      log('warn', `轮次采集失败（不影响会话）：${String(error)}`)
    }
  })

  // ================================================================
  // 5. 系统提示词常驻指引（约 120 token，换来每轮自动沉淀）
  // ================================================================
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () => promptCtx.systemPrompt.section({
        name: 'dsh-memory:auto',
        order: GUIDANCE_ORDER,
        text: ({ scope }) => {
          if (ctx.tools.get('memory_write', scope) === undefined) return ''
          return [
            '## 自动记忆（dsh-memory）',
            '',
            '本会话已启用四层自动记忆，**不需要**等用户手动唤起记忆技能：',
            '',
            '- 会话开始时，关于用户的长期记忆（L1）、本工作区的定位与规范（L2）、当前任务目标（L3）已自动注入；',
            '- 每轮结束时插件会自动把进度写入任务档案；',
            '- **你自己要做的**：当你在本回合得出「下次仍会用到」的结论时，用 `memory_write` 记一条——',
            '  - 关于**本工作区**的稳定事实（它做什么、约定、踩坑）→ `target:"port"` 或 `"pitfall"`；',
            '  - 任务目标/进度/关键决定 → `target:"task"`；',
            '  - 关于**用户本人**的长期信息（偏好、身份、技术栈、项目）→ `target:"global"` 并选对 `category`'
            + '（插件会先做隐私红线自检，命中硬红线会拒绝写入并给出脱敏版）。',
            '- 推进长任务时，若发现当前工作偏离了注入的原始目标，先指出偏离再继续。',
            '- 检索用 `memory_search`，按需精读用 `memory_read`；**不要**一次性读完整库。',
            '- 任务完成时用 `memory_write` 的 `action:"archive_task"` 归档，让目标与进度沉淀进 `archive/`。',
          ].join('\n')
        },
      }),
      'dsh-memory: system prompt guidance',
    )
  })

  // ================================================================
  // 6. 模型工具
  // ================================================================
  if (settings.tools !== false) {
    registerMemoryTools(ctx, store, settings, keeper)
    log('info', '记忆工具已注册：memory_read / memory_search / memory_write')
  }

  // ================================================================
  // 7. 诊断路由
  // ================================================================
  if (settings.diagnostics !== false) {
    ctx.inject(['webServer'], (webCtx) => {
      const respond = (res, status, body) => {
        const text = JSON.stringify(body, null, 2)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(text),
        })
        res.end(text)
      }
      const handler = (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method !== 'GET') {
          respond(res, 405, { error: 'method-not-allowed' })
          return
        }
        const cwd = url.searchParams.get('cwd') ?? process.cwd()

        if (url.pathname === `${PREFIX}/ping`) {
          respond(res, 200, {
            ok: true,
            plugin: 'dsh-memory',
            version: '0.1.0',
            loadedAt: LOADED_AT,
            memoryRoot: settings.memoryRoot,
            workspaceDir: settings.workspaceDir,
            toggles: {
              autoRead: settings.autoRead !== false,
              autoAnchor: settings.autoAnchor !== false,
              autoHarvest: settings.autoHarvest !== false,
              steerOnHarvest: settings.steerOnHarvest !== false,
              privacyGuard: settings.privacyGuard !== false,
              injectIntoSubagents: settings.injectIntoSubagents === true,
            },
            anchorEveryTurns: settings.anchorEveryTurns,
            steerCooldownTurns: settings.steerCooldownTurns,
            steerMinToolCalls: settings.steerMinToolCalls,
            budgets: {
              maxInjectBytes: settings.maxInjectBytes,
              portInlineBytes: settings.portInlineBytes,
              globalInlineBytes: settings.globalInlineBytes,
              anchorInlineBytes: settings.anchorInlineBytes,
            },
          })
          return
        }

        if (url.pathname === `${PREFIX}/brief`) {
          const text = composeBrief(store, settings, cwd)
          respond(res, 200, {
            ok: true,
            cwd,
            bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
            injected: text !== undefined,
            sources: {
              globalIndex: store.readGlobalIndex() !== undefined,
              port: store.readPort(cwd) !== undefined,
              task: store.readActiveTask(cwd) !== undefined,
            },
            preview: text ?? '（当前没有可注入的记忆内容）',
          })
          return
        }

        if (url.pathname === `${PREFIX}/anchor`) {
          const text = composeAnchor(store, settings, cwd, 'manual', 0)
          respond(res, 200, {
            ok: true,
            cwd,
            bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
            active: text !== undefined,
            preview: text ?? '（当前没有进行中的任务，无需锚定）',
          })
          return
        }

        if (url.pathname === `${PREFIX}/status`) {
          const card = store.readActiveTask(cwd)
          respond(res, 200, {
            ok: true,
            cwd,
            memoryRoot: settings.memoryRoot,
            memoryRootReadable: store.readGlobalIndex() !== undefined,
            globalStats: store.globalStats() ?? null,
            categories: store.listCategories().map((item) => ({ name: item.name, bytes: item.bytes, updated: item.updated })),
            port: { path: store.portPath(cwd), exists: store.readPort(cwd) !== undefined },
            task: {
              path: store.activeTaskPath(cwd),
              exists: card !== undefined,
              card: card === undefined ? null : parseTaskCard(card),
            },
            sessionLogDir: store.sessionLogDir(cwd),
          })
          return
        }

        if (url.pathname === `${PREFIX}/seed`) {
          const result = store.ensurePort(cwd, { projectName: cwd.split(/[\\/]/u).filter(Boolean).at(-1) })
          respond(res, 200, { ok: true, dir: result.dir, created: result.created })
          return
        }

        if (url.pathname === `${PREFIX}/rules`) {
          respond(res, 200, { ok: true, rules: RULE_TABLE })
          return
        }

        /*
         * 跨工作区审计 —— 「班主任」视角。
         *
         * 前四层都是单工作区内部的视角；用户要的是横向汇总：
         * 「最近各工作区干得怎么样？有没有按时归档？有没有写错文件？」
         * 这个问题任何单个工作区都答不了，必须扫全部端口。
         *
         * 纯只读：不修改任何记忆文件，用户可以随时跑。
         *   ?format=md    返回 Markdown 报告（默认，给人看）
         *   ?format=json  返回结构化结果（给程序/模型看）
         *   ?cwd=<路径>   额外纳入一个未在 sessions 里登记的工作区
         */
        if (url.pathname === `${PREFIX}/audit`) {
          const extra = url.searchParams.get('cwd')
          const report = buildAudit(store, settings, extra)
          if (url.searchParams.get('format') === 'json') {
            respond(res, 200, { ok: true, ...report })
          } else {
            const markdown = renderReport(report)
            res.writeHead(200, {
              'content-type': 'text/markdown; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(markdown),
            })
            res.end(markdown)
          }
          return
        }

        if (url.pathname === `${PREFIX}/selftest`) {
          respond(res, 200, { ok: true, ...selfTest(store, cwd) })
          return
        }

        respond(res, 404, { error: 'not-found' })
      }
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
        'dsh-memory: http routes',
      )
      log('info', `诊断路由已就绪：${PREFIX}/ping · /brief · /anchor · /status · /seed · /rules · /selftest`)
    })
  }
}

/**
 * 自检：确认四层存储都能读写。供 `/memory/selftest` 使用。
 * @param store - MemoryStore
 * @param cwd - 工作区
 * @returns 逐项检查结果
 */
function selfTest(store, cwd) {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })

  // ---- L1 全局库 ----
  push('L1 全局库入口可读', store.readGlobalIndex() !== undefined, store.globalIndexPath)
  const categories = store.listCategories()
  push('L1 分类文件可枚举', categories.length > 0, `${categories.length} 个分类文件`)
  const highlights = store.globalHighlights(5)
  push('L1 核心摘要可解析', highlights.length > 0, `${highlights.length} 条要点`)
  const guide = store.globalRoutingGuide(5)
  push('L1 按需读取指南可解析', guide.length > 0, `${guide.length} 行指南`)
  push('L1 隐私红线存在', store.read('00-隐私红线.md', cwd) !== undefined, '00-隐私红线.md')

  // ---- L2/L3 工作区端口 ----
  let dir
  try {
    const seeded = store.ensurePort(cwd, { projectName: 'selftest' })
    dir = seeded.dir
    push('L2/L3 端口目录可创建', true, dir)
  } catch (error) {
    push('L2/L3 端口目录可创建', false, String(error))
    dir = '(failed)'
  }
  const port = store.readPort(cwd)
  push('L2 工作区端口可读', port !== undefined, store.portPath(cwd))
  const active = store.readActiveTask(cwd)
  push('L3 任务档案可读', active !== undefined, store.activeTaskPath(cwd))

  // ---- 写权限演练（写-读-删）----
  let writable = false
  let detail = ''
  try {
    const ok = store.writePortProbe(cwd)
    writable = ok.ok
    detail = ok.detail
  } catch (error) {
    detail = String(error)
  }
  push('L2 目录可写', writable, detail)

  const failed = checks.filter((check) => !check.ok)
  return {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
  }
}
