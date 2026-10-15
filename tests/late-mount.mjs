/**
 * dsh-memory · 回归测试：延迟挂载时的兜底初始化。
 *
 * ## 这个测试为什么存在
 *
 * 真实场景：插件是 profile **冷启动之后**才挂载的（或热加载），
 * 此时 `agent/session-start` 早已派发完毕，插件错过了唯一一次建端口的机会。
 * 结果是：简报能注入（pre-step 每次都有），但 `.dsh/memory/` 从未被创建，
 * L2/L3 永远不存在——功能"看起来在工作"，实则少了三层。
 *
 * 修复方式：把工作区准备做成**幂等**的，并同时在 `agent/session-start`
 * 与首次 `pre-step` 两处调用。
 *
 * 用法： node tests/late-mount.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { isOwnSource } from '../lib/source.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ---------------------------------------------------------------- 夹具
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-late-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '## 1. 核心摘要', '1. 测试要点。',
  '## 3. 按需读取指南', '| a | b |', '|---|---|', '| 主题 | 03 |',
  '## 5. x',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 红线\n', 'utf8')

/** 挂载插件，返回它的注册表。 */
function mount() {
  const listeners = new Map()
  const tools = new Map()
  const ctx = {
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
  }
  apply(ctx, { memoryRoot, workspaceDir: '.dsh/memory' })
  return { listeners, tools }
}

/** 造一个 agent。 */
function makeAgent() {
  const events = []
  const surface = []
  return {
    session: {
      header: { id: 'sess-late', cwd: workspace },
      surface: { nodes: surface },
      eventAt: (seq) => events[seq],
      snapshotEvents: () => events,
    },
    inject: () => {},
    steer: () => {},
    _push(event, onSurface = true) {
      events.push(event)
      if (onSurface) surface.push(events.length - 1)
      return events.length - 1
    },
  }
}

/** 跑一次 pre-step 瀑布。 */
async function preStep(listeners, agent, messages, turn, step = 1) {
  const handlers = listeners.get('agent/pre-step') ?? []
  let index = 0
  const run = async () => {
    if (index >= handlers.length) return { kind: 'enter', messages }
    return handlers[index++]({ agent, messages, turn, step, signal: { aborted: false } }, run)
  }
  return run()
}

const portDir = join(workspace, '.dsh', 'memory')

// ---------------------------------------------------------------- 场景 A
section('A. 延迟挂载：session-start 从未派发')
const late = mount()
const agentA = makeAgent()

check('挂载前端口不存在', !existsSync(join(portDir, 'WORKSPACE.md')))

// 注意：**不**派发 session-start，直接进 pre-step
const userMsg = createUserMessage({
  content: [{ type: 'text', text: '帮我做一个自动记忆插件，要求新会话自动读取记忆。' }],
  source: { kind: 'user', rpcId: 'r1' },
})
agentA._push({ type: 'user/message', data: userMsg })

const decision = await preStep(late.listeners, agentA, [userMsg], 1, 1)

check('pre-step 仍注入了简报', decision.messages.some((m) => isOwnSource(m.source)))
check('兜底创建了 WORKSPACE.md', existsSync(join(portDir, 'WORKSPACE.md')))
check('兜底创建了 ACTIVE.md', existsSync(join(portDir, 'ACTIVE.md')))
check('兜底创建了 archive/', existsSync(join(portDir, 'archive')))

// 幂等性：再来一步不应重复创建/覆盖
const before = readFileSync(join(portDir, 'WORKSPACE.md'), 'utf8')
await preStep(late.listeners, agentA, [userMsg], 1, 2)
const after = readFileSync(join(portDir, 'WORKSPACE.md'), 'utf8')
check('重复 pre-step 不覆盖端口文件（幂等）', before === after)

// 轮次结束也应正常工作
for (const handler of late.listeners.get('agent/turn-stopping') ?? []) {
  await handler({ agent: agentA, turn: 1, signal: { aborted: false } })
}
check('轮次采集在延迟挂载下也能建锚点',
  readFileSync(join(portDir, 'ACTIVE.md'), 'utf8').includes('帮我做一个自动记忆插件'))

// ---------------------------------------------------------------- 场景 B
section('B. 正常挂载：session-start 先派发')
const freshRoot = join(sandbox, 'global2')
mkdirSync(freshRoot, { recursive: true })
writeFileSync(join(freshRoot, 'MEMORY.md'), '## 1. 核心摘要\n1. x\n## 3. 按需读取指南\n| a | b |\n|---|---|\n| t | f |\n## 5. z\n', 'utf8')
writeFileSync(join(freshRoot, '00-隐私红线.md'), '# x\n', 'utf8')

const workspaceB = join(sandbox, 'project-b')
mkdirSync(workspaceB, { recursive: true })

const listenersB = new Map()
apply({
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (event, handler) => {
    if (!listenersB.has(event)) listenersB.set(event, [])
    listenersB.get(event).push(handler)
  },
  effect: (fn) => fn(),
  tools: { register: () => {}, get: () => undefined },
  get: () => undefined,
  inject: () => {},
}, { memoryRoot: freshRoot, workspaceDir: '.dsh/memory' })

const agentB = makeAgent()
agentB.session.header.cwd = workspaceB
for (const handler of listenersB.get('agent/session-start') ?? []) {
  await handler({ agent: agentB, source: 'startup' })
}
check('session-start 路径建出端口', existsSync(join(workspaceB, '.dsh', 'memory', 'WORKSPACE.md')))

// ---------------------------------------------------------------- 场景 C
section('C. 只读工作区：必须降级而不是崩溃')
const readOnlyCwd = 'Z:\\definitely\\not\\writable\\path'
const agentC = makeAgent()
agentC.session.header.cwd = readOnlyCwd
let crashed = false
let result
try {
  result = await preStep(late.listeners, agentC, [], 1, 1)
} catch (error) {
  crashed = true
  console.log(`     异常：${error.message}`)
}
check('不可写工作区不抛异常', crashed === false)
check('仍能返回决策', result !== undefined && result.kind === 'enter')
check('不可写时不注入 L2/L3（降级为仅 L1）',
  (result?.messages ?? []).every((m) => !String(m.content?.[0]?.text ?? '').includes('WORKSPACE.md')))

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
