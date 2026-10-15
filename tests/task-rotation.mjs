/**
 * dsh-memory · 回归测试：**连续任务**的锚定（L3「小组组长」核心职责）。
 *
 * ## 这个测试为什么存在
 *
 * 用户对 L3 的要求是：「在对话篇幅过长或压缩之后，模型依然知道自己在干什么，
 * 减少幻觉的风险」。这要求**每一个任务**都被锚定，而不只是本会话的第一个。
 *
 * 但代码里有两个缺陷会让第二个任务起就没有锚点：
 *
 *   1. `entry.anchorEstablished` 一旦置 true 就**再不复位**。
 *      任务一归档后 ACTIVE.md 回到空闲，但守卫条件 `if (!entry.anchorEstablished)`
 *      直接跳过 —— 第二个任务永远不会被锚定。
 *
 *   2. `findOriginalGoal(events)` 从**整个会话的开头**找第一条实质用户消息。
 *      即使缺陷 1 修好，它也会把**任务一的目标**当成任务二的目标重新写进去，
 *      反而制造了幻觉（"我记得我在做 A"，其实在做 B）。
 *
 * 两者叠加的后果：长会话里做完第一个任务后，L3 彻底失效。
 *
 * 用法： node tests/task-rotation.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { findOriginalGoal } from '../lib/harvest.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ---------------------------------------------------------------- 夹具
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-rot-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '## 1. 核心摘要', '1. 测试要点。',
  '## 3. 按需读取指南', '| a | b |', '|---|---|', '| t | 03 |', '## 5. x',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 红线\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 1\n---\n\n## 条目\n', 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 12\n', 'utf8')

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

/** 造一个 agent（同一会话内可连续做多个任务）。 */
function makeAgent() {
  const events = []
  const surface = []
  return {
    session: {
      header: { id: 'sess-rot', cwd: workspace },
      surface: { nodes: surface },
      eventAt: (seq) => events[seq],
      snapshotEvents: () => events,
    },
    inject: () => {},
    steer: () => {},
    /** 追加一条真人用户消息。 */
    _say(text) {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `r${events.length}` } })
      events.push({ type: 'user/message', data: message })
      surface.push(events.length - 1)
      return this
    },
    /** 追加一轮的工具调用，让它算"做了实事"。 */
    _work(turn, count = 3) {
      for (let i = 0; i < count; i++) {
        events.push({ type: 'tool/call', data: { turn, name: 'write', arguments: `{"file_path":"E:\\\\p\\\\f${i}.js"}` } })
      }
      return this
    },
    /** 追加一条 memory_write 的 tool/call 事件（真实会话里由模型调用产生）。 */
    _recordArchiveCall(turn) {
      events.push({
        type: 'tool/call',
        data: {
          turn,
          callId: `call-archive-${events.length}`,
          name: 'memory_write',
          arguments: JSON.stringify({ target: 'task', action: 'archive_task', content: '完成' }),
        },
      })
      return this
    },
    get _events() { return events },
  }
}

const activePath = join(workspace, '.dsh', 'memory', 'ACTIVE.md')
const readActive = () => readFileSync(activePath, 'utf8')
const exec = { agent: undefined }

async function turnEnd(agent, turn) {
  for (const handler of listeners.get('agent/turn-stopping') ?? []) {
    await handler({ agent, turn, signal: { aborted: false } })
  }
}

// ================================================================
section('1. 任务一：正常锚定')
const agent = makeAgent()
exec.agent = agent
for (const handler of listeners.get('agent/session-start') ?? []) {
  await handler({ agent, source: 'startup' })
}

agent._say('我想让你帮我做一个自动记忆插件，要求新会话自动读取记忆并在结束时自动写入。')
agent._work(1)
await turnEnd(agent, 1)

check('任务一目标已锚定', readActive().includes('帮我做一个自动记忆插件'), '')
check('状态为进行中', readActive().includes('状态：进行中'))

// ================================================================
section('2. 归档任务一')
/*
 * 归档现在有**闸门**：必须先往 L1 写过东西（否则拒绝）。
 * 这是用户要求的功能，所以测试要如实走一遍：
 *   1. 写一条 L1（并把它的 tool/call + tool/result 记进事件流）
 *   2. 再归档（同样记录 call + result，边界靠结果里的 ARCHIVED_MARKER 判定）
 */
function recordCall(turn, callId, args) {
  agent._events.push({ type: 'tool/call', data: { turn, callId, name: 'memory_write', arguments: JSON.stringify(args) } })
}
function recordResult(callId, text, turn = 1) {
  agent._events.push({
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

// 先沉淀一条 L1（满足闸门）
recordCall(1, 'g1', { target: 'global', category: 'tech', title: '任务一结论', content: '已沉淀。' })
await tools.get('memory_write').execute(
  { target: 'global', category: 'tech', title: '任务一结论', content: '已沉淀。' }, exec)
recordResult('g1', '✅ 已写入记忆。')

// 再归档
recordCall(1, 'a1', { target: 'task', action: 'archive_task', content: '任务一完成' })
const archived = await tools.get('memory_write').execute({
  target: 'task', action: 'archive_task', content: '任务一完成',
}, exec)
recordResult('a1', archived.note ?? '')

check('归档成功', archived.ok === true, archived.rejected ? `被闸门拒绝：${archived.note.slice(0, 40)}` : '')
check('ACTIVE.md 回到空闲', readActive().includes('状态：空闲'))

// ================================================================
section('3. 任务二：必须被重新锚定（关键）')
agent._say('现在开始第二个任务：把 README 文档重写一遍，要能发给朋友使用。')
agent._work(2)
await turnEnd(agent, 2)

const afterTask2 = readActive()
check('ACTIVE.md 重新变为进行中', afterTask2.includes('状态：进行中'),
  afterTask2.includes('状态：空闲') ? '仍是空闲 → 第二个任务没被锚定' : '')
check('任务二目标已锚定', afterTask2.includes('README 文档重写'),
  afterTask2.includes('自动记忆插件') && !afterTask2.includes('README')
    ? '锚定成了任务一的目标（张冠李戴）'
    : '')
check('不再残留任务一的目标', !afterTask2.includes('新会话自动读取记忆并在结束时自动写入'))

// ================================================================
section('4. 单元级：findOriginalGoal 支持起点边界')
const events1 = [
  { type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '第一个任务：做一个自动记忆插件，要求新会话自动读取记忆。' }] } },
  { type: 'tool/call', data: { turn: 1, name: 'write', arguments: '{}' } },
  { type: 'user/message', data: { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '第二个任务：把 README 文档重写一遍，要能发给朋友使用。' }] } },
]
const fromStart = findOriginalGoal(events1)
check('不给边界时取第一条', fromStart.text.includes('第一个任务'), fromStart.text.slice(0, 20))

const fromIndex = findOriginalGoal(events1, { sinceIndex: 2 })
check('给边界后取边界之后的', fromIndex !== undefined && fromIndex.text.includes('第二个任务'),
  fromIndex === undefined ? '返回 undefined（不支持边界参数）' : fromIndex.text.slice(0, 20))

// ================================================================
section('5. 第三个任务：连续归档后仍要工作')
// 任务二也要先沉淀 L1 才能归档（闸门对每个任务都生效）
recordCall(2, 'g2', { target: 'global', category: 'tech', title: '任务二结论', content: '已沉淀。' })
await tools.get('memory_write').execute(
  { target: 'global', category: 'tech', title: '任务二结论', content: '已沉淀。' }, exec)
recordResult('g2', '✅ 已写入记忆。')

recordCall(2, 'a2', { target: 'task', action: 'archive_task', content: '任务二完成' })
const archived2 = await tools.get('memory_write').execute({ target: 'task', action: 'archive_task', content: '任务二完成' }, exec)
recordResult('a2', archived2.note ?? '')
check('任务二归档成功', archived2.ok === true, archived2.rejected ? '被闸门拒绝' : '')

agent._say('第三个任务：给插件加一个跨工作区的审计报告功能，方便我定期检查。')
agent._work(3)
await turnEnd(agent, 3)

const afterTask3 = readActive()
check('任务三也被锚定', afterTask3.includes('审计报告'), '')
check('不残留任务二目标', !afterTask3.includes('README 文档重写'))

// ================================================================
section('6. 任务一的目标仍应可追溯（归档里）')
const { readdirSync } = await import('node:fs')
const archiveDir = join(workspace, '.dsh', 'memory', 'archive')
const files = readdirSync(archiveDir)
check('归档文件数 = 2', files.length === 2, `${files.length} 个`)
const allArchived = files.map((f) => readFileSync(join(archiveDir, f), 'utf8')).join('\n')
check('归档中保留了任务一目标', allArchived.includes('自动记忆插件'))
check('归档中保留了任务二目标', allArchived.includes('README 文档重写'))

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
