/**
 * dsh-memory · 回归测试：工具返回值必须是**无损 JSON**。
 *
 * ## 这个测试为什么存在
 *
 * 真实缺陷：`memory_read` 在**没有传 query** 时把 `note: undefined` 放进返回值。
 * DSH 用 `isJsonValue` 校验每个工具的成功返回值，`undefined` 不是合法 JSON 值，
 * 于是真实调用直接失败：
 *
 * ```
 * Error: tool "memory_read" returned invalid output: value is not lossless JSON
 * ```
 *
 * 这个缺陷**只在真实调用路径上暴露**——mock 测试不校验返回值，所以之前全绿。
 * 本测试补上这道关：对所有工具、所有分支的返回值做一次 JSON 往返校验。
 *
 * 用法： node tests/tool-output-json.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerMemoryTools } from '../lib/tools.js'
import { MemoryStore } from '../lib/store.js'
import { AnchorKeeper } from '../lib/harvest.js'
import { normalize } from '../lib/config.js'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ---------------------------------------------------------------- 校验器
/** 复刻 DSH 的 isJsonValue：undefined / 函数 / symbol / NaN / 循环引用都不合法。 */
function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return false
  if (type === 'object') {
    if (seen.has(value)) return false
    seen.add(value)
    const ok = Array.isArray(value)
      ? value.every((item) => isLosslessJson(item, seen))
      : Object.values(value).every((item) => isLosslessJson(item, seen))
    seen.delete(value)
    return ok
  }
  return false
}

/** 找出非法字段的路径，便于定位。 */
function findBadPaths(value, path = '$', out = [], seen = new Set()) {
  if (value === null) return out
  const type = typeof value
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    out.push(`${path} = ${type}`)
    return out
  }
  if (type === 'number' && !Number.isFinite(value)) { out.push(`${path} = ${value}`); return out }
  if (type === 'object') {
    if (seen.has(value)) { out.push(`${path} = <circular>`); return out }
    seen.add(value)
    for (const [key, item] of Object.entries(value)) findBadPaths(item, `${path}.${key}`, out, seen)
    seen.delete(value)
  }
  return out
}

// ---------------------------------------------------------------- 夹具
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-json-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '## 1. 核心摘要', '1. 要点。',
  '## 3. 按需读取指南', '| a | b |', '|---|---|', '| t | f |',
  '## 5. x',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 红线\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 1\n---\n\n## 条目\n', 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 12\n', 'utf8')

const settings = normalize({ memoryRoot })
const store = new MemoryStore({ memoryRoot, workspaceDirName: settings.workspaceDir })
const keeper = new AnchorKeeper(store, settings)

const tools = new Map()
registerMemoryTools(
  { tools: { register: (d) => tools.set(d.name, d) } },
  store,
  settings,
  keeper,
)

/** 用真实 store 造出完整的四层，让所有分支都能走通。 */
store.ensurePort(workspace, { projectName: 'project' })
store.writeActiveTask(workspace, [
  '# ACTIVE', '', '## 状态', '- 状态：进行中', '',
  '## 任务目标（原始表述，不要在推进中被改写）', '- 做一个测试任务。', '',
  '## 验收标准', '- 全部通过', '',
  '## 进度时间线', '- 已开始', '',
  '## 关键约束与决定', '- 无', '',
].join('\n'))

const exec = { agent: { session: { header: { cwd: workspace } } } }

/** 调用一个工具并校验返回值。 */
async function invoke(label, toolName, args) {
  let value
  try {
    value = await tools.get(toolName).execute(args, exec)
  } catch (error) {
    check(label, false, `抛异常：${error.message}`)
    return undefined
  }
  const bad = findBadPaths(value)
  check(label, bad.length === 0, bad.length === 0 ? `${Object.keys(value).length} 个字段` : bad.join('; '))
  return value
}

// ---------------------------------------------------------------- memory_read
section('1. memory_read —— 所有 target 分支')
await invoke('target=global', 'memory_read', { target: 'global' })
// ★ 就是这一条曾经失败：不传 query 时 note 曾为 undefined
await invoke('target=port（不传 query）', 'memory_read', { target: 'port' })
await invoke('target=port（传 query）', 'memory_read', { target: 'port', query: '状态' })
await invoke('target=port（query 无命中）', 'memory_read', { target: 'port', query: 'zzz不存在zzz' })
await invoke('target=task', 'memory_read', { target: 'task' })
await invoke('target=category', 'memory_read', { target: 'category', category: 'tech' })
await invoke('target=category（中文键）', 'memory_read', { target: 'category', category: '03-技术栈与工具.md' })
await invoke('target=list', 'memory_read', { target: 'list' })
await invoke('带 maxBytes', 'memory_read', { target: 'port', maxBytes: 10 })
await invoke('无 cwd 的 exec（降级到进程 cwd）', 'memory_read', { target: 'global' }, )
// 上面那行传了 exec，这里单独验证 exec 缺失时不崩
let degraded
try {
  degraded = await tools.get('memory_read').execute({ target: 'global' }, undefined)
  check('exec 为 undefined 时不崩', isLosslessJson(degraded), findBadPaths(degraded).join('; '))
} catch (error) {
  check('exec 为 undefined 时不崩', false, error.message)
}

// ---------------------------------------------------------------- memory_search
section('2. memory_search —— 命中与未命中')
await invoke('有命中', 'memory_search', { query: '测试任务' })
await invoke('无命中', 'memory_search', { query: 'zzz绝对不存在的词zzz' })
await invoke('带 limit', 'memory_search', { query: '任务', limit: 1 })

// ---------------------------------------------------------------- memory_write
section('3. memory_write —— 所有 target/action 分支')
await invoke('port', 'memory_write', { target: 'port', content: '这是一条工作区事实。' })
await invoke('pitfall', 'memory_write', { target: 'pitfall', content: '这是一条踩坑记录。' })
await invoke('section', 'memory_write', { target: 'section', section: '行为规范与约定', content: '这是规范。' })
await invoke('global', 'memory_write', {
  target: 'global', category: 'tech', title: '测试条目', content: '内容。', tags: ['a'],
})
await invoke('global（命中硬红线→脱敏）', 'memory_write', {
  target: 'global', category: 'tech', title: '敏感', content: '手机号 13812345678 记一下。',
})
// ★ 整条都是敏感信息 → 应返回 rejected:true 且 ok:false（而不是写入空话）
const rejected = await invoke('global（整条敏感→拒绝）', 'memory_write', {
  target: 'global', category: 'tech', title: '纯敏感', content: '13812345678',
})
check('整条敏感时 rejected=true', rejected?.rejected === true, `rejected=${rejected?.rejected}`)
check('整条敏感时 ok=false', rejected?.ok === false)
check('整条敏感时 path 为空串（非 undefined）', rejected?.path === '', JSON.stringify(rejected?.path))

await invoke('task/progress', 'memory_write', { target: 'task', action: 'progress', content: '推进了一步。' })
await invoke('task/decision', 'memory_write', { target: 'task', action: 'decision', content: '决定用四层架构。' })
await invoke('task/set_goal', 'memory_write', { target: 'task', action: 'set_goal', content: '新目标。' })
await invoke('task/set_acceptance', 'memory_write', { target: 'task', action: 'set_acceptance', content: '新标准。' })
await invoke('task/archive_task', 'memory_write', { target: 'task', action: 'archive_task', content: '完成。' })

// ---------------------------------------------------------------- 错误路径
section('4. 错误路径必须是异常，而不是非法返回值')
for (const [label, args] of [
  ['content 为空', { target: 'port', content: '   ' }],
  ['global 缺 title', { target: 'global', category: 'tech', content: 'x' }],
  ['global 非法 category', { target: 'global', category: 'nope', title: 't', content: 'x' }],
  ['section 缺 section 参数', { target: 'section', content: 'x' }],
]) {
  let threw = false
  try {
    await tools.get('memory_write').execute(args, exec)
  } catch { threw = true }
  check(`${label} → 抛异常`, threw)
}

// ---------------------------------------------------------------- 校验器自检
section('5. 校验器本身正确（防止测试假绿）')
check('拒绝 undefined 字段', isLosslessJson({ a: undefined }) === false)
check('拒绝函数字段', isLosslessJson({ a: () => {} }) === false)
check('拒绝 NaN', isLosslessJson({ a: Number.NaN }) === false)
check('拒绝 Infinity', isLosslessJson({ a: Number.POSITIVE_INFINITY }) === false)
check('拒绝循环引用', (() => { const o = {}; o.self = o; return isLosslessJson(o) === false })())
check('接受正常对象', isLosslessJson({ a: 1, b: 'x', c: true, d: null, e: [1, 2] }) === true)
check('能定位 undefined 路径', findBadPaths({ a: { b: undefined } })[0] === '$.a.b = undefined')

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
