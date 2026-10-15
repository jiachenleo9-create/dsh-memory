/**
 * dsh-memory · 测试：四项职责 + 归档闸门 + L1 轮询。
 *
 * 这三个功能对应三句用户原话：
 *   1.「在每一个对话开始前都告诉模型，你有着四项任务，要记录四份东西」
 *   2.「可以加一道闸门」——归档时必须先判断有没有值得进 L1 的结论
 *   3.「每经过 3-5 轮对话都让模型自动检查一遍有没有要写入 L1 的」
 *
 * 用法： node tests/duties-gate-poll.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { composeBrief } from '../lib/brief.js'
import { MemoryStore } from '../lib/store.js'
import { normalize } from '../lib/config.js'
import { findGlobalWrites, findWritesSince, findTaskBoundary, ARCHIVED_MARKER } from '../lib/harvest.js'
import { isOwnSource } from '../lib/source.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-duties-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '## 1. 核心摘要', '1. 要点。',
  '## 3. 按需读取指南', '| a | b |', '|---|---|', '| t | 03 |', '## 5. x',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 红线\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 1\n---\n\n## 条目\n\n### A\n- x\n', 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 12\n\n| 时间 | 操作 |\n|---|---|\n', 'utf8')

// ================================================================
section('1. 会话开始时明确交代「四项职责」')

const settings = normalize({ memoryRoot, workspaceDir: '.dsh/memory' })
const store = new MemoryStore({ memoryRoot, workspaceDirName: settings.workspaceDir })
store.ensurePort(workspace, { projectName: 'project' })
store.writeActiveTask(workspace, [
  '# ACTIVE', '', '## 状态', '- 状态：进行中', '',
  '## 任务目标（原始表述，不要在推进中被改写）', '- 测试任务。', '',
  '## 验收标准', '- 无', '', '## 进度时间线', '- 已开始', '',
  '## 关键约束与决定', '- 无', '',
].join('\n'))

const brief = composeBrief(store, settings, workspace)
check('简报含四项职责标题', brief.includes('你的四项职责'))
check('① 交代 L1 要主动写', brief.includes('① L1 班长') && brief.includes('你主动写'))
check('① 强调 L1 是唯一跨工作区共享', brief.includes('唯一跨工作区共享'))
check('② 交代 L2 要主动写', brief.includes('② L2 课代表'))
check('② 明确 L2 不写任务进度', brief.includes('不要') && brief.includes('任务进度'))
check('③ 交代 L3 由插件自动维护', brief.includes('③ L3 小组组长') && brief.includes('插件自动维护'))
check('③ 指出模型在 L3 的关键动作', brief.includes('set_goal') && brief.includes('archive_task'))
check('④ 交代 L4 全自动', brief.includes('④ L4 工作日志') && brief.includes('全自动'))
check('有归纳总结句', brief.includes('L2 记「这个工作区是怎么运作的」'))
check('点明长任务最易漏 L1', brief.includes('最容易漏的是 **L1**'))
check('仍受体积上限约束',
  Buffer.byteLength(brief, 'utf8') <= settings.maxInjectBytes,
  `${Buffer.byteLength(brief, 'utf8')} ≤ ${settings.maxInjectBytes}`)
console.log(`     [简报体积：${Buffer.byteLength(brief, 'utf8')} 字节]`)

// ================================================================
section('2. 归档闸门')

const listeners = new Map()
const tools = new Map()
apply({
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
  },
  effect: (fn) => fn(),
  tools: { register: (d) => tools.set(d.name, d), get: (n) => tools.get(n) },
  get: () => undefined,
  inject: (services, callback) => {
    if (services.includes('systemPrompt')) {
      callback({ effect: (fn) => fn(), systemPrompt: { section: () => () => {} } })
    }
  },
}, { memoryRoot, workspaceDir: '.dsh/memory' })

const events = []
const agent = {
  session: {
    header: { id: 'sess-gate', cwd: workspace },
    surface: { nodes: [] },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
  },
  inject: () => {},
  steer: () => {},
}
const exec = { agent }

/** 建立任务（写 ACTIVE.md 为进行中）。 */
function startTask(goal) {
  store.writeActiveTask(workspace, [
    '# ACTIVE', '', '## 状态', '- 状态：进行中', '',
    '## 任务目标（原始表述，不要在推进中被改写）', `- ${goal}`, '',
    '## 验收标准', '- 无', '', '## 进度时间线', '- 已开始', '',
    '## 关键约束与决定', '- 无', '',
  ].join('\n'))
}

/** 追加一条 memory_write 的 tool/call 事件。 */
function recordWrite(turn, args) {
  const callId = `c${events.length}`
  events.push({
    type: 'tool/call',
    data: { turn, callId, name: 'memory_write', arguments: JSON.stringify(args) },
  })
  return callId
}

/**
 * 追加一条 tool/result 事件，模拟真实会话里工具的执行结果。
 *
 * `findTaskBoundary` 靠结果文本里的 ARCHIVED_MARKER 判断归档是否真的成功，
 * 所以测试必须如实构造 result——否则测不出"被拒绝的归档不该推进边界"。
 */
function recordResult(callId, text, turn = 1) {
  events.push({
    type: 'tool/result',
    data: {
      turn,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text }],
          isError: false,
        }],
      },
    },
  })
}

/** 走真实的工具执行，并把它的结果记进事件流（最贴近真实会话）。 */
async function callTool(toolName, args, turn = 1) {
  const callId = recordWrite(turn, args)
  const result = await tools.get(toolName).execute(args, exec)
  // 工具返回的 note 就是模型看到的结果文本
  recordResult(callId, result.note ?? '', turn)
  return result
}

startTask('闸门测试任务')
// 清空事件，模拟"本任务还没写过 L1"
events.length = 0

const blocked = await callTool('memory_write', {
  target: 'task', action: 'archive_task', content: '想直接归档',
}, 2)

check('未写 L1 时归档被拒绝', blocked.rejected === true, `rejected=${blocked.rejected}`)
check('拒绝时 ok=false', blocked.ok === false)
check('拒绝时给出行动指引', blocked.note.includes('memory_write') && blocked.note.includes('skipGlobalCheck'))
check('拒绝时解释了原因', blocked.note.includes('跨工作区共享'))
check('ACTIVE.md 仍停在进行中（没被误归档）',
  readFileSync(join(workspace, '.dsh', 'memory', 'ACTIVE.md'), 'utf8').includes('状态：进行中'))

// --- 写一条 L1 后再归档，应通过 ---
await callTool('memory_write', { target: 'global', category: 'tech', title: 'T', content: 'C' }, 1)
const allowed = await callTool('memory_write', {
  target: 'task', action: 'archive_task', content: '已沉淀',
}, 3)
check('写过 L1 后归档通过', allowed.ok === true && allowed.rejected === false)
check('ACTIVE.md 回到空闲',
  readFileSync(join(workspace, '.dsh', 'memory', 'ACTIVE.md'), 'utf8').includes('状态：空闲'))

// --- 显式跳过 ---
startTask('第二个任务')
const skipped = await callTool('memory_write', {
  target: 'task', action: 'archive_task', content: '确实没内容', skipGlobalCheck: true,
}, 4)
check('显式 skipGlobalCheck 可跳过闸门', skipped.ok === true, `ok=${skipped.ok}`)

// --- 上一个任务写过 L1 不能替下一个任务交差 ---
startTask('第三个任务')
const blockedAgain = await callTool('memory_write', {
  target: 'task', action: 'archive_task', content: '又想直接归档',
}, 5)
check('上个任务写过的 L1 不算数（按任务起点统计）', blockedAgain.rejected === true)

// --- 闸门可关掉 ---
const listeners2 = new Map()
const tools2 = new Map()
apply({
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (event, handler) => {
    if (!listeners2.has(event)) listeners2.set(event, [])
    listeners2.get(event).push(handler)
  },
  effect: (fn) => fn(),
  tools: { register: (d) => tools2.set(d.name, d), get: (n) => tools2.get(n) },
  get: () => undefined,
  inject: () => {},
}, { memoryRoot, workspaceDir: '.dsh/memory', archiveGate: false })
const gateOff = await tools2.get('memory_write').execute({
  target: 'task', action: 'archive_task', content: '闸门关闭',
}, exec)
check('archiveGate:false 时直接放行', gateOff.ok === true)

// ================================================================
section('3. findGlobalWrites 只统计本任务')
/*
 * 注意：归档成功与否由结果文本里的 ARCHIVED_MARKER 判定，
 * 所以这里必须构造配套的 `tool/result`——真实会话里每个 tool/call
 * 后面一定跟着它的 result。只造 call 不造 result 会被（正确地）
 * 当成"还没成功归档"。
 */
const mkCall = (turn, callId, args) => ({
  type: 'tool/call',
  data: { turn, callId, name: 'memory_write', arguments: JSON.stringify(args) },
})
const mkResult = (callId, text, turn = 1) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 1,
    message: {
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
      }],
    },
  },
})

const ev = [
  mkCall(1, 'k1', { target: 'global', category: 'tech', title: 'T1', content: 'x' }),
  mkResult('k1', '✅ 已写入记忆。'),
  mkCall(2, 'k2', { target: 'task', action: 'archive_task', content: 'done' }),
  mkResult('k2', `任务已归档到 archive/。\n${ARCHIVED_MARKER}`, 2),
  mkCall(3, 'k3', { target: 'port', content: 'y' }),
  mkResult('k3', '✅ 已写入记忆。', 3),
]
const afterArchive = findGlobalWrites(ev)
check('归档点之后的 L1 写入为 0', afterArchive.wrote === false, `count=${afterArchive.count}`)

ev.push(mkCall(4, 'k4', { target: 'global', category: 'tech', title: 'T2', content: 'z' }))
ev.push(mkResult('k4', '✅ 已写入记忆。', 4))
const withGlobal = findGlobalWrites(ev)
check('新任务写了 L1 后为 true', withGlobal.wrote === true && withGlobal.count === 1, `count=${withGlobal.count}`)

/*
 * 关键回归：**被闸门拒绝的归档不能推进边界**。
 * 否则前面写过的 L1 会被划到"上一个任务"，闸门会再次拒绝 → 死循环。
 */
const rejectedAttempt = [
  mkCall(1, 'r1', { target: 'global', category: 'tech', title: 'T', content: 'x' }),
  mkResult('r1', '✅ 已写入记忆。'),
  mkCall(2, 'r2', { target: 'task', action: 'archive_task', content: '尝试归档' }),
  // 被闸门拒绝：结果里没有 ARCHIVED_MARKER
  mkResult('r2', '⏸ 归档被闸门拦下：本任务还没有往 L1 全局库写过任何东西。', 2),
]
check('被拒绝的归档不推进边界', findTaskBoundary(rejectedAttempt) === 0,
  `boundary=${findTaskBoundary(rejectedAttempt)}`)
check('被拒绝后仍能看到本任务的 L1 写入',
  findGlobalWrites(rejectedAttempt).wrote === true,
  `count=${findGlobalWrites(rejectedAttempt).count}`)

check('无事件时返回 false', findGlobalWrites([]).wrote === false)
check('坏 JSON 不崩', findGlobalWrites([{ type: 'tool/call', data: { name: 'memory_write', arguments: '{坏' } }]).wrote === false)

// ================================================================
section('4. findWritesSince：轮询判断用')
const pollEvents = [
  { type: 'tool/call', data: { turn: 1, name: 'memory_write', arguments: JSON.stringify({ target: 'port', content: 'a' }) } },
  { type: 'tool/call', data: { turn: 5, name: 'memory_write', arguments: JSON.stringify({ target: 'global', category: 'tech', title: 'T', content: 'b' }) } },
]
check('统计到任意写入', findWritesSince(pollEvents, 0).anyWrite === true)
check('统计到 global 写入', findWritesSince(pollEvents, 0).globalWrite === true)
check('只看第 5 轮之后：仍有 global', findWritesSince(pollEvents, 5).globalWrite === true)
check('只看第 6 轮之后：无写入', findWritesSince(pollEvents, 6).anyWrite === false)

// ================================================================
section('5. L1 轮询提醒（每 N 轮检查一次）')

const pollDir = join(sandbox, 'poll-project')
mkdirSync(pollDir, { recursive: true })
const pollEvents2 = []
const pollSteers = []
const pollAgent = {
  session: {
    header: { id: 'sess-poll', cwd: pollDir },
    surface: { nodes: [] },
    eventAt: (seq) => pollEvents2[seq],
    snapshotEvents: () => pollEvents2,
  },
  inject: () => {},
  steer: (message) => pollSteers.push(message),
}

const pollListeners = new Map()
apply({
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (event, handler) => {
    if (!pollListeners.has(event)) pollListeners.set(event, [])
    pollListeners.get(event).push(handler)
  },
  effect: (fn) => fn(),
  tools: { register: () => {}, get: () => undefined },
  get: () => undefined,
  inject: () => {},
}, { memoryRoot, workspaceDir: '.dsh/memory', l1PollEveryTurns: 4, steerOnHarvest: false })

for (const handler of pollListeners.get('agent/session-start') ?? []) {
  await handler({ agent: pollAgent, source: 'startup' })
}

/** 造一轮实质工作。 */
function workTurn(turn, count = 3) {
  for (let i = 0; i < count; i++) {
    pollEvents2.push({ type: 'tool/call', data: { turn, name: 'write', arguments: `{"file_path":"E:\\\\p\\\\f${i}.js"}` } })
  }
}
async function endTurn(turn) {
  for (const handler of pollListeners.get('agent/turn-stopping') ?? []) {
    await handler({ agent: pollAgent, turn, signal: { aborted: false } })
  }
}

// 第 1-3 轮：不应触发轮询
for (const t of [1, 2, 3]) { workTurn(t); await endTurn(t) }
check('第 1-3 轮不触发轮询', pollSteers.length === 0, `steer × ${pollSteers.length}`)

// 第 4 轮：应触发
workTurn(4)
await endTurn(4)
check('第 4 轮触发 L1 轮询', pollSteers.length === 1, `steer × ${pollSteers.length}`)
if (pollSteers.length > 0) {
  const text = pollSteers[0].content.map((b) => b.text).join('')
  check('提醒点明是 L1 轮询', text.includes('L1 轮询检查'))
  check('提醒说明 L1 跨工作区共享', text.includes('跨工作区共享'))
  check('提醒给出写入方式', text.includes('target:"global"'))
  check('提醒允许"暂无"', text.includes('暂无'))
  check('提醒消息来源合法', isOwnSource(pollSteers[0].source))
}

// 同一轮重复结束不应重复提醒
await endTurn(4)
check('同一轮不重复提醒', pollSteers.length === 1, `steer × ${pollSteers.length}`)

// 写了 L1 之后，第 8 轮不应再提醒
pollEvents2.push({ type: 'tool/call', data: { turn: 5, name: 'memory_write', arguments: JSON.stringify({ target: 'global', category: 'tech', title: 'T', content: 'x' }) } })
for (const t of [5, 6, 7]) { workTurn(t); await endTurn(t) }
workTurn(8)
await endTurn(8)
check('写过 L1 后不再提醒', pollSteers.length === 1, `steer × ${pollSteers.length}`)

// 关掉轮询
const quietSteers = []
const quietAgent = { ...pollAgent, steer: (m) => quietSteers.push(m) }
const quietEvents = []
quietAgent.session = { ...pollAgent.session, snapshotEvents: () => quietEvents }
const quietListeners = new Map()
apply({
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (event, handler) => {
    if (!quietListeners.has(event)) quietListeners.set(event, [])
    quietListeners.get(event).push(handler)
  },
  effect: (fn) => fn(),
  tools: { register: () => {}, get: () => undefined },
  get: () => undefined,
  inject: () => {},
}, { memoryRoot, workspaceDir: '.dsh/memory', l1PollEveryTurns: 0, steerOnHarvest: false })
for (const handler of quietListeners.get('agent/session-start') ?? []) {
  await handler({ agent: quietAgent, source: 'startup' })
}
for (const t of [4, 8, 12]) {
  for (let i = 0; i < 3; i++) quietEvents.push({ type: 'tool/call', data: { turn: t, name: 'write', arguments: '{}' } })
  for (const handler of quietListeners.get('agent/turn-stopping') ?? []) {
    await handler({ agent: quietAgent, turn: t, signal: { aborted: false } })
  }
}
check('l1PollEveryTurns:0 时完全不提醒', quietSteers.length === 0, `steer × ${quietSteers.length}`)

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
