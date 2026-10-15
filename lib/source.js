/**
 * dsh-memory · 消息来源（source）判定。
 *
 * 为什么单独成模块：写入路径和读取路径都要用同一套判定，
 * 而 `index.js` 与 `harvest.js` 互相引用会造成循环依赖。
 *
 * ## 背景：V4 会话格式对 source.kind 的准入规则
 *
 * 应用（app.asar）使用 V4 会话格式。写路径的准入检查
 * `assertV4MessageSources` 要求 source.kind 是**生产者自有 kind**，
 * 并**显式拒绝** `kind === 'plugin'`：
 *
 * ```
 * format v4 message requires a producer-owned source kind
 * ```
 *
 * 而 `producerKind()` 里那张 `RELEASED_SAME_NAME_PRODUCERS` 白名单
 * 只服务于**读取旧 V3 文件的迁移路径**，不能在写路径上"豁免"自己。
 *
 * 所以第三方插件注入消息时必须用：
 *   - `{ kind: 'plugin:<插件名>' }`  ← 命名空间形式，本插件采用
 *   - `{ kind: '<自有生产者名>' }`
 *
 * 用退役的 `{kind:'plugin', plugin:'...'}` 会导致整轮失败。
 *
 * @module dsh-memory/source
 */

/** 本插件的生产者 kind（V4 合法）。 */
export const PRODUCER_KIND = 'plugin:dsh-memory'

/** 构造一条注入消息使用的 source。 */
export function producerSource() {
  return { kind: PRODUCER_KIND }
}

/**
 * 判断一条消息是否由**本插件**注入。
 * 兼容历史会话里可能存在的旧 `{kind:'plugin', plugin:'dsh-memory'}` 形态，
 * 这样读取旧轨迹时仍能正确识别自己注入的内容。
 *
 * @param source - `UserMessage.source`
 * @returns 是否为本插件注入
 */
export function isOwnSource(source) {
  if (source === null || typeof source !== 'object') return false
  if (source.kind === PRODUCER_KIND) return true
  return source.kind === 'plugin' && source.plugin === 'dsh-memory'
}

/**
 * 平台自身的注入 kind（非真人输入）。
 * 这些是平台各个 producer 直接使用的 kind，不是命名空间形式。
 */
const PLATFORM_INJECTED_KINDS = new Set([
  'agent-instructions',
  'time-context',
  'runtime-context',
  'skill-catalog',
  'skill-invocation',
  'goal',
  'subagent-settled',
  'subagent-report',
  'agent-message',
  'team-message',
  'tool-jobs',
  'tool-goal',
  'model-selection',
  'session-reference',
  'user-approval',
  'compact-checkpoint',
  'compact-basic',
  'tool-registry',
  'dsh-session-title-llm',
  'plan-mode',
  'tmux-context',
  'repeat-tool-reminder',
  'system-prompt',
  'hooks-claude-code',
  'hooks-codex',
  'schedule',
  'webhook',
  'coordinator',
  'tool-cordis',
  'cordis-host-runner',
])

/**
 * 判断一条用户消息是否来自注入（而非真人输入）。
 *
 * 用于「找出原始任务目标」——必须只认真人输入，否则会把插件的
 * 记忆简报当成用户的任务描述。
 *
 * @param source - `UserMessage.source`
 * @returns 是否为注入内容
 */
export function isInjectedSource(source) {
  if (source === null || typeof source !== 'object') return false
  const kind = source.kind
  if (typeof kind !== 'string' || kind === '') return false
  // 真人输入
  if (kind === 'user') return false
  // 历史遗留的 plugin 包装形态
  if (kind === 'plugin') return true
  // 命名空间形式：plugin:<任意插件名>
  if (kind.startsWith('plugin:')) return true
  // 平台自身的 producer kind
  return PLATFORM_INJECTED_KINDS.has(kind)
}
