/**
 * dsh-memory · 回归测试：消息来源（source.kind）必须符合 V4 会话格式。
 *
 * ## 这个测试为什么存在
 *
 * 曾经的真实缺陷：插件用已退役的 `{kind:'plugin', plugin:'dsh-memory'}` 注入消息。
 * 应用使用 V4 会话格式，其写路径准入检查 `assertV4MessageSources` **显式拒绝**
 * `source.kind === 'plugin'`，抛
 * `format v4 message requires a producer-owned source kind`，导致整轮失败。
 *
 * 本测试把这条平台规则固化成断言，防止再次回归。
 *
 * 用法： node tests/source-format.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRODUCER_KIND, producerSource, isOwnSource, isInjectedSource } from '../lib/source.js'
import { apply } from '../lib/index.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readFileSync, readdirSync } from 'node:fs'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ---------------------------------------------------------------- 平台规则
section('1. V4 准入规则（模拟 assertV4MessageSources）')

/**
 * 复刻 app.asar 里 `assertV4MessageSources` 的判定：
 * kind 必须是非空字符串，且不等于 'plugin'。
 */
function v4Accepts(source) {
  if (source === null || typeof source !== 'object') return false
  const kind = source.kind
  if (typeof kind !== 'string' || kind.length === 0) return false
  return kind !== 'plugin'
}

check('复刻的规则拒绝 {kind:"plugin"}', v4Accepts({ kind: 'plugin', plugin: 'dsh-memory' }) === false)
check('复刻的规则接受 {kind:"plugin:dsh-memory"}', v4Accepts({ kind: 'plugin:dsh-memory' }) === true)
check('复刻的规则拒绝空 kind', v4Accepts({ kind: '' }) === false)
check('复刻的规则拒绝缺 kind', v4Accepts({ plugin: 'x' }) === false)

// ---------------------------------------------------------------- 插件常量
section('2. 插件导出的 source 必须通过 V4 准入')
check('PRODUCER_KIND 是命名空间形式', PRODUCER_KIND === 'plugin:dsh-memory', PRODUCER_KIND)
check('producerSource() 通过 V4 准入', v4Accepts(producerSource()) === true, JSON.stringify(producerSource()))
check('producerSource() 不再携带 plugin 字段', producerSource().plugin === undefined)
check('producerSource() 每次返回新对象', producerSource() !== producerSource())

// ---------------------------------------------------------------- 源码扫描
section('3. 源码里不得再出现已退役的写路径用法')

/** 递归收集 lib/ 下的所有 js。 */
function libFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) libFiles(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const LIB = join(import.meta.dirname, '..', 'lib')
let retiredWrites = []
for (const file of libFiles(LIB)) {
  const text = readFileSync(file, 'utf8')
  // 只看真正的**代码**（去掉注释行），避免文档说明被误判。
  const codeLines = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
  })
  codeLines.forEach((line, index) => {
    // 匹配 `kind: 'plugin'` 或 `kind: "plugin"`（不带命名空间前缀）
    if (/kind\s*:\s*['"]plugin['"]/u.test(line)) {
      retiredWrites.push(`${file.replace(LIB, 'lib')}:${index + 1}  ${line.trim()}`)
    }
  })
}
check('lib/ 中不存在 kind:"plugin" 字面量', retiredWrites.length === 0,
  retiredWrites.length === 0 ? '' : `\n      ${retiredWrites.join('\n      ')}`)

// ---------------------------------------------------------------- 归属判定
section('4. 来源归属判定')
check('认出新写法', isOwnSource({ kind: 'plugin:dsh-memory' }) === true)
check('认出旧写法（兼容历史轨迹）', isOwnSource({ kind: 'plugin', plugin: 'dsh-memory' }) === true)
check('不认别的插件', isOwnSource({ kind: 'plugin:dsh-media-gen' }) === false)
check('不认真人输入', isOwnSource({ kind: 'user', rpcId: 'x' }) === false)
check('不认 null', isOwnSource(null) === false)

check('真人输入不算注入', isInjectedSource({ kind: 'user', rpcId: 'r1' }) === false)
check('新写法算注入', isInjectedSource({ kind: 'plugin:dsh-memory' }) === true)
check('旧写法算注入', isInjectedSource({ kind: 'plugin', plugin: 'x' }) === true)
check('agent-instructions 算注入', isInjectedSource({ kind: 'agent-instructions' }) === true)
check('time-context 算注入', isInjectedSource({ kind: 'time-context' }) === true)
check('goal 算注入', isInjectedSource({ kind: 'goal' }) === true)
check('未知 producer kind 不算注入', isInjectedSource({ kind: 'something-else' }) === false)
check('空 source 不算注入', isInjectedSource({}) === false)
check('null 不算注入', isInjectedSource(null) === false)

// ---------------------------------------------------------------- 端到端
section('5. 端到端：注入的消息必须能通过 V4 准入')

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-src-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '## 1. 核心摘要', '1. 测试要点。', '## 3. 按需读取指南', '| a | b |', '|---|---|', '| t | f |', '## 5. x',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# x\n', 'utf8')

const listeners = new Map()
const registered = new Map()
const driven = []

const mockCtx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
  },
  effect: (fn) => fn(),
  tools: { register: (d) => registered.set(d.name, d), get: (n) => registered.get(n) },
  get: () => undefined,
  inject: (services, callback) => {
    if (services.includes('systemPrompt')) {
      callback({ effect: (fn) => fn(), systemPrompt: { section: () => () => {} } })
    }
  },
}
apply(mockCtx, { memoryRoot, workspaceDir: '.dsh/memory' })

/** 造一个 agent，记录所有注入/steer 的消息。 */
function makeAgent() {
  const events = []
  const surface = []
  return {
    session: {
      header: { id: 'sess-src', cwd: workspace },
      surface: { nodes: surface },
      eventAt: (seq) => events[seq],
      snapshotEvents: () => events,
    },
    inject: (message) => driven.push({ via: 'inject', message }),
    steer: (message) => driven.push({ via: 'steer', message }),
    _push(event, onSurface = true) {
      events.push(event)
      if (onSurface) surface.push(events.length - 1)
      return events.length - 1
    },
  }
}

const agent = makeAgent()
for (const handler of listeners.get('agent/session-start') ?? []) {
  await handler({ agent, source: 'startup' })
}

const userMsg = createUserMessage({
  content: [{ type: 'text', text: '帮我做一个自动记忆插件，要求新会话自动读取记忆并在结束时自动写入。' }],
  source: { kind: 'user', clientTimeZone: 'Asia/Shanghai', rpcId: 'r1' },
})
agent._push({ type: 'user/message', data: userMsg })

// 走完整 pre-step 瀑布
async function preStep(messages, turn, step = 1) {
  const handlers = listeners.get('agent/pre-step') ?? []
  let index = 0
  const run = async () => {
    if (index >= handlers.length) return { kind: 'enter', messages }
    return handlers[index++]({ agent, messages, turn, step, signal: { aborted: false } }, run)
  }
  return run()
}

const decision = await preStep([userMsg], 1, 1)
const brief = decision.messages.find((m) => isOwnSource(m.source))
check('简报已注入', brief !== undefined)
check('简报 source 通过 V4 准入', brief !== undefined && v4Accepts(brief.source) === true,
  brief === undefined ? '' : JSON.stringify(brief.source))
check('简报 source 是命名空间形式', brief?.source?.kind === 'plugin:dsh-memory', brief?.source?.kind)
check('简报 source 不再带 plugin 字段', brief?.source?.plugin === undefined)

// 触发 steer 路径
agent._push({ type: 'tool/call', data: { turn: 1, name: 'write', arguments: '{"file_path":"E:\\\\a\\\\b.js"}' } }, false)
agent._push({ type: 'tool/call', data: { turn: 1, name: 'edit', arguments: '{"file_path":"E:\\\\a\\\\c.js"}' } }, false)
agent._push({ type: 'tool/call', data: { turn: 1, name: 'pwsh', arguments: '{}' } }, false)
for (const handler of listeners.get('agent/turn-stopping') ?? []) {
  await handler({ agent, turn: 1, signal: { aborted: false } })
}

const steered = driven.filter((d) => d.via === 'steer')
check('触发了沉淀提醒', steered.length >= 1, `steer × ${steered.length}`)
check('提醒 source 通过 V4 准入', steered.every((d) => v4Accepts(d.message.source)),
  JSON.stringify(steered[0]?.message.source))

// 所有被驱动的消息都必须合法
const allDriven = driven.map((d) => d.message)
check('全部注入/steer 消息都通过 V4 准入', allDriven.every((m) => v4Accepts(m.source)),
  `${allDriven.length} 条`)
check('没有任何消息使用 {kind:"plugin"}', allDriven.every((m) => m.source?.kind !== 'plugin'))

// ---------------------------------------------------------------- 目标识别
section('6. 原始目标识别不受注入干扰')
const active = readFileSync(join(workspace, '.dsh', 'memory', 'ACTIVE.md'), 'utf8')
check('任务目标取自真人输入', active.includes('帮我做一个自动记忆插件'))
check('没有把简报误当成目标', !active.includes('记忆系统已自动接管'))

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
