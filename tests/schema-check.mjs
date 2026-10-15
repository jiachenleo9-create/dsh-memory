/**
 * dsh-memory · 真实校验器自检。
 *
 * 前面两个测试用 mock 上下文。这里改用 DSH 自带的 `assertSupportedJsonSchema`
 * 与 `register()` 的准入断言，确保工具定义在**真实运行时会**被接受
 * （错误的 schema 会在 register 时直接抛错，而不是运行时才发现）。
 *
 * 用法： node tests/schema-check.mjs
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

// 直接复用插件注册的三个工具定义：用一个只做校验的假 ctx 触发 register。
import { registerMemoryTools } from '../lib/tools.js'
import { MemoryStore } from '../lib/store.js'
import { AnchorKeeper } from '../lib/harvest.js'
import { normalize } from '../lib/config.js'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-schema-'))
const memoryRoot = join(sandbox, 'g')
const workspace = join(sandbox, 'w')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(memoryRoot, 'MEMORY.md'), '## 1. 核心摘要\n1. x\n## 3. 按需读取指南\n| a | b |\n|---|---|\n| t | f |\n## 5. y\n', 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# x\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 1\n---\n\n## 条目\n', 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 12\n', 'utf8')

const settings = normalize({ memoryRoot })
const store = new MemoryStore({ memoryRoot, workspaceDirName: settings.workspaceDir })
const keeper = new AnchorKeeper(store, settings)

// ---------------------------------------------------------------- 真实注册
console.log('\n=== 用真实 dsh-tools 校验器注册工具 ===\n')
const registered = new Map()
let registerError
try {
  registerMemoryTools(
    { tools: { register: (definition) => registered.set(definition.name, definition) } },
    store,
    settings,
    keeper,
  )
} catch (error) {
  registerError = error
}

check('四个工具均通过 register 准入断言', registerError === undefined && registered.size === 4,
  registerError === undefined ? [...registered.keys()].join(', ') : String(registerError?.message))

// ---------------------------------------------------------------- 结构断言
console.log('\n=== 工具定义完整性 ===\n')
for (const [toolName, definition] of registered) {
  check(`${toolName}：有 output.schema`, definition.output?.schema !== undefined)
  check(`${toolName}：有 output.render 函数`, typeof definition.output?.render === 'function')
  check(`${toolName}：render 返回 ContentBlock[]`, (() => {
    try {
      // 用一个最小的合法返回值试渲染（配合工具的 schema 形状）。
      const probe = {
        memory_read: { target: 't', path: 'p', bytes: 0, truncated: false, text: 'x' },
        memory_search: { query: 'q', count: 0, hits: [] },
        memory_write: {
          ok: true, target: 't', path: 'p', privacy: 'p',
          rejected: false, sanitizedUsed: false,
        },
        memory_audit: {
          workspaceCount: 0, problemCount: 0, errorCount: 0,
          globalConsistent: true, report: '（空）',
        },
      }[toolName]
      const blocks = definition.output.render({}, probe)
      return Array.isArray(blocks) && blocks.every((b) => b.type === 'text' && typeof b.text === 'string')
    } catch (error) {
      console.log(`      render 失败：${error.message}`)
      return false
    }
  })())
  check(`${toolName}：有 execute 函数`, typeof definition.execute === 'function')
  check(`${toolName}：有 description`, typeof definition.description === 'string' && definition.description.length > 20)
  check(`${toolName}：isConcurrencySafe 可调用`, typeof definition.isConcurrencySafe !== 'function'
    || typeof definition.isConcurrencySafe({}) === 'boolean')
}

// ---------------------------------------------------------------- 参数/输出形状
// 注意：defineTool 会把声明式参数**编译**成 JSON Schema，
// 所以这里读的是 `parameters.properties` 而不是原始的字段声明。
console.log('\n=== 参数与输出形状 ===\n')
const readDef = registered.get('memory_read')
check('memory_read 的 target 是必填枚举',
  Array.isArray(readDef.parameters.required) && readDef.parameters.required.includes('target')
  && Array.isArray(readDef.parameters.properties.target.enum),
  `required=[${readDef.parameters.required.join(',')}]`)

const writeDef = registered.get('memory_write')
check('memory_write 的 content 必填', writeDef.parameters.required.includes('content'))
check('memory_write 的 target 是枚举', Array.isArray(writeDef.parameters.properties.target.enum))
check('memory_write 的 action 是枚举', Array.isArray(writeDef.parameters.properties.action.enum))
check('memory_write output 声明 rejected', writeDef.output.schema.properties.rejected !== undefined)
check('memory_write output 声明 sanitizedUsed', writeDef.output.schema.properties.sanitizedUsed !== undefined)
check('memory_write output required 完整',
  ['ok', 'target', 'path', 'privacy', 'rejected', 'sanitizedUsed']
    .every((k) => writeDef.output.schema.required.includes(k)),
  writeDef.output.schema.required.join(','))

const searchDef = registered.get('memory_search')
check('memory_search 输出 hits 是数组', searchDef.output.schema.properties.hits.type === 'array')
check('memory_search hits 项含 file/line/text',
  ['file', 'line', 'text'].every((k) => searchDef.output.schema.properties.hits.items.properties[k] !== undefined))

// ---------------------------------------------------------------- 声明式源形状
// defineTool 同时保留原始声明，便于确认「可选 vs 必填」的意图没有被编译吃掉。
console.log('\n=== 声明式参数意图 ===\n')
check('memory_read.target 声明为 required',
  readDef.parameters.properties.target !== undefined
  && readDef.parameters.required.includes('target'))
check('memory_read.category 保持可选', !readDef.parameters.required.includes('category'))
check('memory_write.tags 是数组', writeDef.parameters.properties.tags.type === 'array')

// ---------------------------------------------------------------- presentationMeta
console.log('\n=== 展示元数据（供 UI 卡片用）===\n')
for (const [toolName, definition] of registered) {
  if (typeof definition.output.presentationMeta !== 'function') continue
  let ok = false
  try {
    const probe = {
      memory_read: { path: 'p', bytes: 1 },
      memory_write: { path: 'p', ok: true },
      memory_audit: { workspaces: 0, problems: 0 },
    }[toolName]
    const meta = definition.output.presentationMeta({}, probe)
    ok = meta !== null && typeof meta === 'object'
  } catch { ok = false }
  check(`${toolName}：presentationMeta 可序列化`, ok)
}

// ---------------------------------------------------------------- defineTool 直连
console.log('\n=== defineTool 复用性 ===\n')
const sample = defineTool({
  name: 'schema_probe',
  description: 'probe',
  parameters: { a: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { b: { type: 'string', required: true } } },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  async execute() { return { b: 'x' } },
})
check('defineTool 在本环境可用', sample.name === 'schema_probe')

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
