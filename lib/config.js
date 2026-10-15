/**
 * dsh-memory · 配置模式。
 *
 * 所有字段都有可用默认值：装好即可运行，不需要任何配置。
 * 想改就在 profile 的 cordis.patch.yml 里覆盖。
 *
 * ## 默认路径保持中立
 *
 * 本文件**不写死任何个人路径**——仓库是给所有人用的。
 * `memoryRoot` 留空时落到 `<DSH_HOME>/memory`（由 `normalize()` 推导）。
 * 已经有自己记忆库的人，在 profile 里显式指定即可：
 *
 * ```yaml
 * - id: memory
 *   name: 'dsh-memory'
 *   config:
 *     memoryRoot: 'D:\我的记忆库'
 * ```
 *
 * @module dsh-memory/config
 */
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'

/** 全局个人记忆库的默认根目录名（相对 DSH_HOME）。 */
export const DEFAULT_MEMORY_ROOT_NAME = 'memory'

export const Config = z.object({
  /** 总开关。false 时插件完全不注册。 */
  enabled: z.boolean().default(true),

  /** L1 全局记忆库根目录；留空则用 DEFAULT_MEMORY_ROOT。 */
  memoryRoot: z.string().default(''),

  /** L2/L3 相对工作区的目录名。 */
  workspaceDir: z.string().default('.dsh/memory'),

  /**
   * DSH 的会话根目录，用于**发现所有带记忆端口的工作区**。
   * 留空则用 `<DSH_HOME>/sessions`（DSH_HOME 取环境变量）。
   * 「班主任审计」依赖它做跨工作区汇总。
   */
  sessionRoot: z.string().default(''),

  // ---------------------------------------------------------------- 自动读取
  /** 会话开始时自动注入记忆简报（L1 入口指针 + L2 端口 + L3 活跃任务）。 */
  autoRead: z.boolean().default(true),

  /** 是否也向子代理注入简报。默认 false：子代理生命短、任务聚焦，注入是纯浪费。 */
  injectIntoSubagents: z.boolean().default(false),

  // ---------------------------------------------------------------- 目标锚定
  /** 长任务目标锚定：定期重注入目标，防「忘记最初设定」。 */
  autoAnchor: z.boolean().default(true),

  /** 每隔多少轮重注入一次目标锚点。0 = 只在压缩后注入。 */
  anchorEveryTurns: z.number().default(10),

  // ---------------------------------------------------------------- 自动沉淀
  /** 每轮结束自动提取会话轨迹，写入 L2/L3（纯机械操作，不花 token）。 */
  autoHarvest: z.boolean().default(true),

  /** 一轮里至少几次工具调用才认为"做了实事"，值得记进度。 */
  harvestMinToolCalls: z.number().default(2),

  /**
   * 沉淀提醒（steer）：模型本轮做了实事却没写记忆时，提醒它补一次。
   *
   * ⚠️ 这是本插件唯一会额外消耗 token 的机制：一次 steer 会让模型多跑一步。
   * 已用冷却期把它压到「每 N 轮最多一次」。想极致省 token 就设为 false——
   * 此时仍有三重保障：系统提示词常驻指引、目标锚点末尾的提醒、机械进度采集。
   */
  steerOnHarvest: z.boolean().default(true),

  /** 两次沉淀提醒之间至少间隔多少轮。 */
  steerCooldownTurns: z.number().default(6),

  /** 触发沉淀提醒最少需要几次工具调用。 */
  steerMinToolCalls: z.number().default(3),

  // ---------------------------------------------------------------- L1 轮询
  /**
   * L1 轮询提醒：每隔 N 轮检查一次「本任务往全局库写过东西没有」，
   * 没写过就问一句。0 = 关闭。
   *
   * 与 `steerOnHarvest` 的分工：
   *   - `steerOnHarvest` 管**本轮**：做了实事却没写任何记忆 → 提醒
   *   - `l1PollEveryTurns` 管**跨轮**：连续几轮都没往 L1 写过 → 提醒
   *
   * 为什么需要它：L2/L3 由插件自动维护，模型不写也不会漏；
   * 但 **L1 只能靠模型主动写**，长任务里很容易一直只更新进度、
   * 从不沉淀结论 —— 结果任务归档后经验就困在本工作区了。
   */
  l1PollEveryTurns: z.number().default(4),

  // ---------------------------------------------------------------- 预算
  /** 单次注入的硬上限（字节），保护上下文预算。 */
  maxInjectBytes: z.number().default(6000),

  /** L2 工作区端口「速览」部分最多内联多少字节。 */
  portInlineBytes: z.number().default(2200),

  /** L1 全局索引最多内联多少字节（默认只给指针，不给全文）。 */
  globalInlineBytes: z.number().default(1400),

  /** L3 任务锚点最多内联多少字节。 */
  anchorInlineBytes: z.number().default(1600),

  /** L1 入口超过多少字节时在简报里给出超限告警（对应 Claude Code 的 25KB 上限实践）。 */
  globalIndexWarnBytes: z.number().default(25600),

  // ---------------------------------------------------------------- 其它
  /** 写入 L1 前的隐私红线自检（强烈建议保持开启）。 */
  privacyGuard: z.boolean().default(true),

  /**
   * 归档闸门：`archive_task` 前检查本任务是否往 L1 写过东西，
   * 没写过就拒绝归档并要求先判断一次（可用 `skipGlobalCheck: true` 跳过）。
   *
   * 目的是把「经验沉淀」从靠自觉变成流程必经点。
   */
  archiveGate: z.boolean().default(true),

  /** 注册 memory_* 工具。 */
  tools: z.boolean().default(true),

  /** 注册 /memory/ping 等诊断路由。 */
  diagnostics: z.boolean().default(true),

  /** 会话轨迹保留份数，超出后删除最旧的。 */
  keepSessionLogs: z.number().default(40),

  /** 是否把轨迹写入磁盘（关闭则只做内存锚点）。 */
  persistTrajectory: z.boolean().default(true),
})

/**
 * 把插件配置补全成可直接使用的设置对象。
 * @param config - profile patch 层传进来的配置行。
 * @returns 补全后的设置。
 */
export function normalize(config) {
  const settings = { ...(config ?? {}) }

  // DSH 主目录：优先环境变量，其次 ~/.dsh。多处复用，先算好。
  const dshHome = process.env.DSH_HOME
    ?? (process.env.USERPROFILE === undefined ? undefined : join(process.env.USERPROFILE, '.dsh'))

  /*
   * L1 记忆库根目录。
   *
   * 留空时**不写死任何个人路径**，落到 `<DSH_HOME>/memory`——
   * 这样仓库对所有人都能"装好即用"，而已经有自己记忆库的人
   * 在 profile 里用 `memoryRoot` 指过去即可（README 有示例）。
   */
  if (typeof settings.memoryRoot !== 'string' || settings.memoryRoot.trim() === '') {
    settings.memoryRoot = dshHome === undefined
      ? join(process.cwd(), DEFAULT_MEMORY_ROOT_NAME)
      : join(dshHome, DEFAULT_MEMORY_ROOT_NAME)
  }
  if (typeof settings.workspaceDir !== 'string' || settings.workspaceDir.trim() === '') {
    settings.workspaceDir = '.dsh/memory'
  }
  // 审计要枚举全部工作区，因此需要知道 DSH 的 sessions 在哪。
  if (typeof settings.sessionRoot !== 'string' || settings.sessionRoot.trim() === '') {
    settings.sessionRoot = dshHome === undefined ? '' : join(dshHome, 'sessions')
  }
  const positive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  const nonNegative = (value, fallback) =>
    Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

  settings.anchorEveryTurns = nonNegative(settings.anchorEveryTurns, 10)
  settings.l1PollEveryTurns = nonNegative(settings.l1PollEveryTurns, 4)
  settings.steerCooldownTurns = nonNegative(settings.steerCooldownTurns, 6)
  settings.harvestMinToolCalls = Math.max(1, positive(settings.harvestMinToolCalls, 2))
  settings.steerMinToolCalls = Math.max(1, positive(settings.steerMinToolCalls, 3))
  settings.maxInjectBytes = positive(settings.maxInjectBytes, 6000)
  settings.portInlineBytes = positive(settings.portInlineBytes, 2200)
  settings.globalInlineBytes = positive(settings.globalInlineBytes, 1400)
  settings.anchorInlineBytes = positive(settings.anchorInlineBytes, 1600)
  settings.globalIndexWarnBytes = positive(settings.globalIndexWarnBytes, 25600)
  settings.keepSessionLogs = positive(settings.keepSessionLogs, 40)
  return settings
}
