/**
 * dsh-memory · 诊断路由自检。
 *
 * 用 mock webServer 挂载 `/memory/*` 路由并真实发起请求，
 * 确认诊断端点返回的结构正确（这些端点是安装后的主要验证手段）。
 *
 * 用法： node tests/routes.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ---------------------------------------------------------------- 夹具
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-routes-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '# MEMORY',
  '> 最后更新：2026-10-12　｜　条目总数：155 条',
  '## 1. 核心摘要',
  '1. **身份**：称呼「小明」。',
  '2. **沟通偏好**：直接。',
  '## 3. 按需读取指南',
  '| 问题类型 | 建议读取 |',
  '|---|---|',
  '| 技术问题 | 03 + 05 |',
  '## 5. 变更历史',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 隐私红线\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 37\n---\n\n## 条目\n', 'utf8')

// ---------------------------------------------------------------- mock webServer
/** 已注册的路由。 */
const routes = []

/** 极简的 req/res 假的实现。 */
function makeReqRes(method, url) {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(text) { this.body = text ?? '' },
  }
  return [{ method, url }, res]
}

// ---------------------------------------------------------------- 挂载
section('1. 路由注册')
const registered = new Map()
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: () => {},
  effect: (fn) => fn(),
  tools: { register: (d) => registered.set(d.name, d), get: (n) => registered.get(n) },
  get: () => undefined,
  inject: (services, callback) => {
    if (services.includes('webServer')) {
      callback({
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {} } },
      })
    }
  },
}
apply(ctx, { memoryRoot, workspaceDir: '.dsh/memory' })

check('注册了一个 prefix 路由', routes.length === 1, `${routes.length} 条`)
check('路由前缀是 /memory', routes[0]?.path === '/memory', routes[0]?.path)
check('路由类型是 prefix', routes[0]?.kind === 'prefix')

/** 走一遍路由并返回解析后的 JSON。 */
async function hit(pathname) {
  const [req, res] = makeReqRes('GET', `${pathname}`)
  await routes[0].handler(req, res)
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers }
}

// ---------------------------------------------------------------- /ping
section('2. /memory/ping —— 确认插件已加载')
const ping = await hit('/memory/ping')
check('返回 200', ping.status === 200)
check('ok=true', ping.json.ok === true)
check('plugin 名正确', ping.json.plugin === 'dsh-memory', ping.json.plugin)
check('带 version', typeof ping.json.version === 'string', ping.json.version)
check('带 loadedAt（可判断是否重启过）', typeof ping.json.loadedAt === 'string', ping.json.loadedAt)
check('回显 memoryRoot', ping.json.memoryRoot === memoryRoot)
check('回显各项开关', ping.json.toggles.autoRead === true && ping.json.toggles.privacyGuard === true)
check('回显预算', ping.json.budgets.maxInjectBytes === 6000, String(ping.json.budgets.maxInjectBytes))
check('JSON 响应头正确', ping.headers['content-type'].includes('application/json'))

// ---------------------------------------------------------------- /seed
// 先建工作区端口：真实流程里这一步由 session-start 完成，
// 本测试没有 agent，所以显式走 /seed（顺序也更贴近实际）。
section('3. /memory/seed —— 建立端口')
const freshWorkspace = join(sandbox, 'brand-new')
mkdirSync(freshWorkspace, { recursive: true })
const seed = await hit(`/memory/seed?cwd=${encodeURIComponent(freshWorkspace)}`)
check('返回 200', seed.status === 200)
check('创建了端口文件', seed.json.created.length === 2, `${seed.json.created.length} 个文件`)
check('目录路径正确', seed.json.dir.includes('brand-new'), seed.json.dir)

// 给 /brief 与 /status 用同一个工作区也建一次
await hit(`/memory/seed?cwd=${encodeURIComponent(workspace)}`)

// ---------------------------------------------------------------- /brief
section('4. /memory/brief —— 预览将被注入的内容')
const brief = await hit(`/memory/brief?cwd=${encodeURIComponent(workspace)}`)
check('返回 200', brief.status === 200)
check('injected=true', brief.json.injected === true)
check('报告来源齐全', brief.json.sources.globalIndex === true && brief.json.sources.port === true,
  JSON.stringify(brief.json.sources))
check('preview 含简报标记', brief.json.preview.includes('<!-- dsh-memory:brief -->'))
check('preview 含用户画像', brief.json.preview.includes('小明'))
check('bytes 与实际相符',
  brief.json.bytes === Buffer.byteLength(brief.json.preview, 'utf8'),
  `${brief.json.bytes} 字节`)

// ---------------------------------------------------------------- /anchor
section('5. /memory/anchor —— 查看目标锚点')
const anchorIdle = await hit(`/memory/anchor?cwd=${encodeURIComponent(workspace)}`)
check('空闲时 active=false', anchorIdle.json.active === false)
check('空闲时给出说明', anchorIdle.json.preview.includes('没有进行中的任务'))

// 建立任务后再查
const { MemoryStore } = await import('../lib/store.js')
const store = new MemoryStore({ memoryRoot, workspaceDirName: '.dsh/memory' })
store.writeActiveTask(workspace, [
  '# 当前任务档案 · ACTIVE',
  '',
  '## 状态',
  '- 状态：进行中',
  '',
  '## 任务目标（原始表述，不要在推进中被改写）',
  '- 为 DSH 开发自动记忆插件，要求长任务不遗忘最初目标。',
  '',
  '## 验收标准',
  '- 三个目标全部达成',
  '',
  '## 进度时间线',
  '- 已完成设计',
  '',
  '## 关键约束与决定',
  '- 采用四层架构',
  '',
].join('\n'))

const anchorActive = await hit(`/memory/anchor?cwd=${encodeURIComponent(workspace)}`)
check('进行中时 active=true', anchorActive.json.active === true)
check('锚点含原始目标', anchorActive.json.preview.includes('长任务不遗忘最初目标'))
check('锚点含锚定标记', anchorActive.json.preview.includes('<!-- dsh-memory:anchor -->'))
check('锚点带字节数', anchorActive.json.bytes > 0, `${anchorActive.json.bytes} 字节`)

// ---------------------------------------------------------------- /status
section('6. /memory/status —— 四层状态总览')
const status = await hit(`/memory/status?cwd=${encodeURIComponent(workspace)}`)
check('返回 200', status.status === 200)
check('全局库可读', status.json.memoryRootReadable === true)
check('统计出条目总数', status.json.globalStats.total === 155, String(status.json.globalStats.total))
/*
 * 分类文件数 = 夹具自造的 + 插件自动引导补建的。
 *
 * 插件启动时会确保记忆库有最小骨架（见 store.ensureMemoryRoot）：
 * 夹具已有 00 与 03，引导补上 01/02/04/12 —— 共 6 个 `NN-*.md`。
 * 这是**有意的行为**：新用户装完插件若 memoryRoot 为空目录，
 * 应该拿到一套可用的骨架，而不是静默失效。
 */
check('列出分类文件（含引导补建的）',
  Array.isArray(status.json.categories) && status.json.categories.length === 6,
  `${status.json.categories?.length} 个：${status.json.categories?.map((c) => c.name).join(', ')}`)
check('引导补建了身份档案', status.json.categories.some((c) => c.name.startsWith('01-')))
check('引导补建了维护日志', status.json.categories.some((c) => c.name.startsWith('12-')))
check('不覆盖已存在的分类', status.json.categories.some((c) => c.name === '03-技术栈与工具.md'))
check('端口存在', status.json.port.exists === true)
check('任务档案存在', status.json.task.exists === true)
check('任务卡片解析出状态', status.json.task.card.status === '进行中', status.json.task.card.status)
check('任务卡片解析出目标', status.json.task.card.goal.length === 1 && status.json.task.card.goal[0].includes('自动记忆插件'))

// ---------------------------------------------------------------- /rules
section('7. /memory/rules —— 隐私规则表')
const rules = await hit('/memory/rules')
check('返回 200', rules.status === 200)
check('有硬红线规则', Array.isArray(rules.json.rules.hard) && rules.json.rules.hard.length > 5,
  `${rules.json.rules.hard?.length} 条`)
check('有软红线规则', Array.isArray(rules.json.rules.soft) && rules.json.rules.soft.length > 0,
  `${rules.json.rules.soft?.length} 条`)
check('硬红线含证件号码类', rules.json.rules.hard.some((r) => r.category === '证件号码'))
check('软红线含人际关系类', rules.json.rules.soft.some((r) => r.category.includes('人际关系')))

// ---------------------------------------------------------------- /selftest
section('8. /memory/selftest —— 四层读写自检')
const selftest = await hit(`/memory/selftest?cwd=${encodeURIComponent(workspace)}`)
check('返回 200', selftest.status === 200)
check('自检全部通过', selftest.json.ok === true,
  `${selftest.json.passed}/${selftest.json.total}`)
check('逐项结果完整', Array.isArray(selftest.json.checks) && selftest.json.checks.length >= 8,
  `${selftest.json.checks?.length} 项`)
for (const item of selftest.json.checks ?? []) {
  if (!item.ok) console.log(`      ❌ ${item.name} — ${item.detail}`)
}

// ---------------------------------------------------------------- 错误处理
section('9. 错误处理')
const notFound = await hit('/memory/nope')
check('未知路径返回 404', notFound.status === 404)
check('404 带错误码', notFound.json.error === 'not-found')

const [postReq, postRes] = makeReqRes('POST', '/memory/ping')
await routes[0].handler(postReq, postRes)
check('非 GET 返回 405', postRes.statusCode === 405)

// 不存在的 cwd 不应崩溃
const badCwd = await hit('/memory/brief?cwd=Z%3A%5Cno%5Csuch%5Cplace')
check('异常 cwd 不崩溃', badCwd.status === 200, `status=${badCwd.status}`)

// ---------------------------------------------------------------- 清理
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
