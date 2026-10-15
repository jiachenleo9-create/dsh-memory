/**
 * dsh-memory · 集成自检。
 *
 * 用 mock cordis 上下文真正调用插件的 `apply()`，验证：
 *   - 插件能被正常挂载（事件/工具/系统提示词注册齐全）
 *   - 会话开始 → 简报注入
 *   - 压缩之后 → 目标锚点重注入
 *   - 轮次结束 → 进度采集 + 沉淀提醒（且提醒有循环护栏）
 *   - 记忆工具能被真实调用（write → read → search 闭环）
 *
 * 用法： node tests/integration.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'
import { isOwnSource } from '../lib/source.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ---------------------------------------------------------------- 测试夹具
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-int-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '# MEMORY',
  '> 最后更新：2026-10-12　｜　条目总数：155 条',
  '## 1. 核心摘要',
  '1. **身份**：称呼「小明」。',
  '2. **沟通偏好**：直接、少废话。',
  '## 3. 按需读取指南',
  '| 问题类型 | 建议读取 |',
  '|---|---|',
  '| 技术问题 | 03 + 05 |',
  '## 5. 变更历史',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 隐私红线\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 37\n更新: 2026-10-01\n---\n\n# 03\n\n## 条目\n', 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 12\n\n| 时间 | 操作 |\n|---|---|\n', 'utf8')

// ---------------------------------------------------------------- mock 环境
/**
 * 每个上下文自带一套注册表，互不污染 —— 这样 `enabled:false` 之类的
 * 隔离断言才真正有效。
 */
function makeRegistry() {
  return { listeners: new Map(), tools: new Map(), promptSections: [] }
}

const registry = makeRegistry()
const listeners = registry.listeners
const tools = registry.tools
const promptSections = registry.promptSections

/** 采集到的注入消息（agent.inject / pre-step 改写 / steer）。 */
const injected = []
const steered = []
const logs = []

/** 构造一个假 agent。 */
function makeAgent({ surfaceText = '', isSubagentAgent = false } = {}) {
  const surfaceNodes = []
  const events = []
  const session = {
    header: { id: 'sess-1', cwd: workspace, ...(isSubagentAgent ? { origin: 'subagent' } : {}) },
    surface: { nodes: surfaceNodes },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
  }
  return {
    session,
    inject: (message) => injected.push(message),
    steer: (message) => steered.push(message),
    /** 测试辅助：往表层与日志里加一条事件。 */
    _push(event, { surface = true } = {}) {
      events.push(event)
      if (surface) surfaceNodes.push(events.length - 1)
      return events.length - 1
    },
    _events: events,
    _surface: surfaceNodes,
  }
}

/** 构造 mock cordis 上下文。 */
function makeCtx(reg = registry) {
  const ctx = {
    logger: () => ({ info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }),
    on: (event, handler) => {
      if (!reg.listeners.has(event)) reg.listeners.set(event, [])
      reg.listeners.get(event).push(handler)
    },
    effect: (fn) => { const d = fn(); return d },
    tools: {
      register: (definition) => { reg.tools.set(definition.name, definition) },
      get: (toolName) => reg.tools.get(toolName),
    },
    get: (service) => {
      if (service === 'agents') return { list: () => [], get: () => undefined }
      return undefined
    },
    inject: (services, callback) => {
      if (services.includes('systemPrompt')) {
        callback({
          effect: (fn) => fn(),
          systemPrompt: { section: (spec) => { reg.promptSections.push(spec); return () => {} } },
        })
      }
      // webServer 缺失即不注册诊断路由——正是我们想要的降级行为
    },
  }
  return ctx
}

/**
 * 触发某事件的所有监听器。
 * `session/event` 这类事件带多个参数，所以用 rest 参数透传。
 */
async function emit(event, ...args) {
  const reg = args.at(-1)?.__registry ?? registry
  if (args.at(-1)?.__registry) args.pop()
  const handlers = reg.listeners.get(event) ?? []
  for (const handler of handlers) await handler(...args)
}

/** 模拟一次 pre-step：走完整瀑布流。 */
async function preStep(agent, messages, turn, step = 1, reg = registry) {
  const handlers = reg.listeners.get('agent/pre-step') ?? []
  let index = 0
  const run = async () => {
    if (index >= handlers.length) return { kind: 'enter', messages }
    const handler = handlers[index++]
    return handler({ agent, messages, turn, step, signal: { aborted: false } }, run)
  }
  return run()
}

// ---------------------------------------------------------------- 挂载插件
section('1. 插件挂载')
const ctx = makeCtx()
apply(ctx, { memoryRoot, workspaceDir: '.dsh/memory' })

check('导出插件名', name === 'memory', name)
check('声明 inject 依赖', Array.isArray(inject) && inject.includes('tools'), inject.join(','))
check('注册了 session-start', (listeners.get('agent/session-start') ?? []).length === 1)
check('注册了 pre-step', (listeners.get('agent/pre-step') ?? []).length === 1)
check('注册了 turn-stopping', (listeners.get('agent/turn-stopping') ?? []).length === 1)
check('注册了 session/event', (listeners.get('session/event') ?? []).length === 1)
check('注册了 4 个记忆工具', tools.size === 4, [...tools.keys()].join(', '))
check('工具名正确', ['memory_read', 'memory_search', 'memory_write', 'memory_audit'].every((n) => tools.has(n)))
check('注册了系统提示词小节', promptSections.length === 1, promptSections[0]?.name)
check('系统提示词非空', promptSections[0].text({ scope: undefined }).includes('自动记忆'))

// ---------------------------------------------------------------- 会话开始
section('2. 会话开始 → 工作区端口自动建立')
const agent = makeAgent()
await emit('agent/session-start', { agent, source: 'startup' })
check('端口目录已自动创建', existsSync(join(workspace, '.dsh', 'memory', 'WORKSPACE.md')))
check('任务档案已创建', existsSync(join(workspace, '.dsh', 'memory', 'ACTIVE.md')))
check('archive 目录已创建', existsSync(join(workspace, '.dsh', 'memory', 'archive')))

// ---------------------------------------------------------------- 简报注入
section('3. 简报自动注入（第 1 步）')
const userMsg = createUserMessage({
  content: [{ type: 'text', text: '帮我做一个自动记忆插件，要求新会话自动读取，任务结束自动写入。' }],
  source: { kind: 'user' },
})
agent._push({ type: 'user/message', data: userMsg })

const decision1 = await preStep(agent, [userMsg], 1, 1)
check('pre-step 正常进入', decision1.kind === 'enter')
const briefMsg = decision1.messages.find((m) => isOwnSource(m.source))
check('简报已注入', briefMsg !== undefined)
if (briefMsg) {
  const text = briefMsg.content.map((b) => b.text).join('')
  check('简报含标记', text.includes('<!-- dsh-memory:brief -->'))
  check('简报含 L1 画像', text.includes('小明'))
  check('简报含 L2 端口路径', text.includes('WORKSPACE.md'))
  check('简报含隐私红线', text.includes('00-隐私红线.md'))
  console.log(`     [简报体积：${Buffer.byteLength(text, 'utf8')} 字节]`)
}
agent._push({ type: 'user/message', data: briefMsg })

// 第二次 pre-step 不应重复注入
const decision2 = await preStep(agent, [userMsg], 1, 2)
check('同一会话不重复注入简报', decision2.messages.filter((m) => isOwnSource(m.source)).length === 0)

// ---------------------------------------------------------------- 轮次采集
section('4. 轮次结束 → 机械采集与目标锚定')
agent._push({ type: 'tool/call', data: { turn: 1, name: 'read', arguments: '{"file_path":"E:\\\\x\\\\a.js"}' } }, { surface: false })
agent._push({ type: 'tool/call', data: { turn: 1, name: 'write', arguments: '{"file_path":"E:\\\\x\\\\plugin.js"}' } }, { surface: false })
agent._push({ type: 'tool/call', data: { turn: 1, name: 'pwsh', arguments: '{}' } }, { surface: false })
agent._push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '已完成骨架。' }] } } }, { surface: false })

await emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })

const activePath = join(workspace, '.dsh', 'memory', 'ACTIVE.md')
const activeText = readFileSync(activePath, 'utf8')
check('任务锚点已建立', activeText.includes('状态：进行中'))
check('原始目标逐字保留', activeText.includes('帮我做一个自动记忆插件，要求新会话自动读取，任务结束自动写入。'))
check('进度时间线已记录', activeText.includes('进度时间线') && activeText.includes('改动 1 个文件'))
check('会话轨迹已落盘', existsSync(join(workspace, '.dsh', 'memory', 'sessions', 'sess-1.md')))

// ---------------------------------------------------------------- 沉淀提醒
section('5. 沉淀提醒与循环护栏')
check('已发出一次沉淀提醒', steered.length === 1, `steer × ${steered.length}`)
if (steered.length > 0) {
  const text = steered[0].content.map((b) => b.text).join('')
  check('提醒提到 memory_write', text.includes('memory_write'))
  check('提醒允许「无需记录」', text.includes('无需记录'))
}

// 同一轮重复触发 → 不能再次提醒（这正是防死循环的关键）
await emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
check('同一轮不重复提醒（循环护栏）', steered.length === 1, `steer × ${steered.length}`)

// ---------------------------------------------------------------- 压缩感知
section('6. 压缩之后重注入目标锚点')
await emit('session/event', agent.session, { type: 'compaction/end', data: { compactionId: 'c1' } })

const decision3 = await preStep(agent, [userMsg], 3, 1)
const anchorMsg = decision3.messages.find((m) => isOwnSource(m.source))
check('压缩后自动重注入锚点', anchorMsg !== undefined)
if (anchorMsg) {
  const text = anchorMsg.content.map((b) => b.text).join('')
  check('锚点含标记', text.includes('<!-- dsh-memory:anchor -->'))
  check('锚点重述原始目标', text.includes('帮我做一个自动记忆插件'))
  check('锚点说明压缩原因', text.includes('上下文刚刚被压缩'))
  check('锚点提醒归档', text.includes('archive_task'))
}

// ---------------------------------------------------------------- 周期锚定
section('7. 周期锚定（每 N 轮）')
const agent2 = makeAgent()
await emit('agent/session-start', { agent: agent2, source: 'startup' })
agent2._push({ type: 'user/message', data: createUserMessage({
  content: [{ type: 'text', text: '实现记忆管理插件，需要做到任务沉淀、目标不遗忘、工作区独立端口三个目标。' }],
  source: { kind: 'user' },
}) })
agent2._push({ type: 'tool/call', data: { turn: 1, name: 'write', arguments: '{"file_path":"E:\\\\y\\\\b.js"}' } }, { surface: false })
await emit('agent/turn-stopping', { agent: agent2, turn: 1, signal: { aborted: false } })

const early = await preStep(agent2, [], 2, 1)
check('非周期轮不注入锚点', !early.messages.some((m) => m.content?.some?.((b) => String(b.text ?? '').includes('dsh-memory:anchor'))))

// 第 10 轮应触发周期锚定
const periodic = await preStep(agent2, [], 10, 1)
const periodicAnchor = periodic.messages.find((m) => m.content?.some?.((b) => String(b.text ?? '').includes('dsh-memory:anchor')))
check('第 10 轮触发周期锚定', periodicAnchor !== undefined)
if (periodicAnchor) {
  const text = periodicAnchor.content.map((b) => b.text).join('')
  check('周期锚点含轮次说明', text.includes('第 10 轮'))
}

// ---------------------------------------------------------------- 子代理豁免
section('8. 子代理不注入（省 token）')
const child = makeAgent({ isSubagentAgent: true })
await emit('agent/session-start', { agent: child, source: 'startup' })
const childDecision = await preStep(child, [], 1, 1)
check('子代理不注入简报', childDecision.messages.length === 0)
await emit('agent/turn-stopping', { agent: child, turn: 1, signal: { aborted: false } })
check('子代理不触发提醒', steered.length === 1)

// ---------------------------------------------------------------- 工具闭环
section('9. 记忆工具闭环（write → read → search）')
/*
 * exec 里带上 `snapshotEvents`：归档闸门要读会话事件判断
 * "本任务有没有往 L1 写过"。没有事件流时闸门会保守地拒绝，
 * 所以这里必须提供，才能测出真实的归档流程。
 */
const integrationEvents = []
const exec = {
  agent: {
    session: {
      header: { cwd: workspace },
      snapshotEvents: () => integrationEvents,
    },
  },
  signal: undefined,
}

/** 把一次工具调用如实记进事件流（call + result），模拟真实会话。 */
async function runTool(toolName, args, turn = 1) {
  const callId = `ic${integrationEvents.length}`
  integrationEvents.push({
    type: 'tool/call',
    data: { turn, callId, name: toolName, arguments: JSON.stringify(args) },
  })
  const result = await tools.get(toolName).execute(args, exec)
  integrationEvents.push({
    type: 'tool/result',
    data: {
      turn,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: result.note ?? '' }],
          isError: false,
        }],
      },
    },
  })
  return result
}

// 写入工作区端口
const writePort = await tools.get('memory_write').execute({
  target: 'port',
  content: '本项目是 DSH 的记忆插件，所有改动需通过 selftest。',
  section: '行为规范与约定',
}, exec)
check('写入 port 成功', writePort.ok === true, writePort.path)
const portAfter = readFileSync(writePort.path, 'utf8')
check('端口含新规范', portAfter.includes('所有改动需通过 selftest'))
check('端口 frontmatter 已更新日期', portAfter.includes(`更新: ${new Date().toISOString().slice(0, 10)}`))

// 写入踩坑
const writePitfall = await tools.get('memory_write').execute({
  target: 'pitfall',
  content: 'PowerShell 5.1 不支持 pwsh 命令名，脚本要用 powershell.exe。',
}, exec)
check('写入踩坑成功', writePitfall.ok === true)

// 写入全局（合法）
const writeGlobal = await tools.get('memory_write').execute({
  target: 'global',
  category: 'tech',
  title: '测试：记忆插件',
  content: '已验证 dsh-memory 插件可写入全局库。',
  source: '对话推断',
  confidence: '高',
  tags: ['测试'],
}, exec)
check('写入 global 成功', writeGlobal.ok === true, writeGlobal.path)
check('未触发脱敏', writeGlobal.sanitizedUsed === false)

// 写入全局（命中硬红线）
const writeSensitive = await tools.get('memory_write').execute({
  target: 'global',
  category: 'tech',
  title: '测试：敏感',
  content: '用户手机号是 13812345678，身份证 110101199003072316。',
}, exec)
check('敏感内容被脱敏后写入', writeSensitive.sanitizedUsed === true)
check('隐私报告说明命中类别', writeSensitive.privacy.includes('联系方式') || writeSensitive.privacy.includes('证件号码'))
const techAfter = readFileSync(writeGlobal.path, 'utf8')
check('落盘内容不含手机号', !techAfter.includes('13812345678'))
check('落盘内容不含身份证', !techAfter.includes('110101199003072316'))

// 写入任务
const writeTask = await tools.get('memory_write').execute({
  target: 'task', action: 'decision', content: '决定采用四层记忆架构。',
}, exec)
check('写入 task 成功', writeTask.ok === true)
check('任务档案含决定', readFileSync(writeTask.path, 'utf8').includes('四层记忆架构'))

// 读取
const readPort = await tools.get('memory_read').execute({ target: 'port' }, exec)
check('memory_read 读 port', readPort.text.includes('所有改动需通过 selftest'))
check('memory_read 返回路径', readPort.path.endsWith('WORKSPACE.md'))

const readGlobal = await tools.get('memory_read').execute({ target: 'global' }, exec)
check('memory_read 读 global', readGlobal.text.includes('小明'))

const readCategory = await tools.get('memory_read').execute({ target: 'category', category: 'tech' }, exec)
check('memory_read 按分类读', readCategory.path.endsWith('03-技术栈与工具.md'))

const readFiltered = await tools.get('memory_read').execute({ target: 'port', query: 'selftest' }, exec)
check('memory_read 支持关键词过滤', readFiltered.text.includes('selftest') && readFiltered.text.split('\n').length < 40)

const readList = await tools.get('memory_read').execute({ target: 'list' }, exec)
check('memory_read 列目录', readList.text.includes('MEMORY.md') || readList.text.includes('L1'))

// 检索
const search = await tools.get('memory_search').execute({ query: '四层记忆架构' }, exec)
check('memory_search 命中', search.count > 0, `${search.count} 条`)
check('检索结果带文件与行号', search.hits[0].file !== undefined && search.hits[0].line > 0)

/*
 * 归档 —— 现在有**闸门**：必须先往 L1 写过东西。
 * 这里如实走一遍真实流程：先被拦下 → 写 L1 → 再归档成功。
 */
const gatedArchive = await runTool('memory_write', {
  target: 'task', action: 'archive_task', content: '验证完成',
})
check('闸门拦下未沉淀的归档', gatedArchive.rejected === true,
  gatedArchive.rejected ? '' : '（闸门未生效）')

// 补一条 L1 结论（这也是闸门期望模型做的事）
const globalForGate = await runTool('memory_write', {
  target: 'global', category: 'tech', title: '归档闸门验证', content: '闸门要求归档前先沉淀 L1。',
})
check('补写 L1 成功', globalForGate.ok === true)

const archive = await runTool('memory_write', {
  target: 'task', action: 'archive_task', content: '验证完成',
})
check('任务归档成功', archive.ok === true)
check('归档文件存在', archive.path.includes('archive') && existsSync(archive.path))
check('ACTIVE 回到空闲', readFileSync(join(workspace, '.dsh', 'memory', 'ACTIVE.md'), 'utf8').includes('状态：空闲'))
check('归档结果带成功标记', (archive.note ?? '').includes('任务已归档'))

// 错误路径
let threw = false
try {
  await tools.get('memory_write').execute({ target: 'global', content: 'x', category: '不存在的分类' }, exec)
} catch { threw = true }
check('非法分类被拒绝', threw)

threw = false
try {
  await tools.get('memory_write').execute({ target: 'global', content: 'x' }, exec)
} catch { threw = true }
check('global 缺 title 被拒绝', threw)

// ---------------------------------------------------------------- 幂等与健壮性
section('10. 健壮性')
const isolated = makeRegistry()
apply(makeCtx(isolated), { memoryRoot, workspaceDir: '.dsh/memory', enabled: false })
check('enabled:false 时完全不注册', (isolated.listeners.get('agent/pre-step') ?? []).length === 0)
check('enabled:false 时不注册工具', isolated.tools.size === 0)
void emit

const badAgent = { session: { header: { id: 'x', cwd: 'Z:\\definitely\\missing\\path' }, surface: { nodes: [] }, eventAt: () => undefined, snapshotEvents: () => [] } }
let crashed = false
try {
  await emit('agent/session-start', { agent: badAgent, source: 'startup' })
  const d = await preStep(badAgent, [], 1, 1)
  await emit('agent/turn-stopping', { agent: badAgent, turn: 1, signal: { aborted: false } })
  crashed = d === undefined
} catch (error) {
  crashed = true
  console.log(`     异常：${error.message}`)
}
check('不可写工作区不导致崩溃', crashed === false)

const abortedAgent = makeAgent()
const aborted = await preStepAborted(abortedAgent)
check('已中止的 step 不注入', aborted.kind === 'enter' && aborted.messages.length === 0)

async function preStepAborted(a) {
  const handlers = listeners.get('agent/pre-step') ?? []
  let index = 0
  const run = async () => {
    if (index >= handlers.length) return { kind: 'enter', messages: [] }
    const h = handlers[index++]
    return h({ agent: a, messages: [], turn: 1, step: 1, signal: { aborted: true } }, run)
  }
  return run()
}

// ---------------------------------------------------------------- 清理
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
