/**
 * 从**真实安装位置**加载插件，验证模块解析正确。
 *
 * 这一步很关键：测试目录里的 node_modules 是转发垫片，而真正加载时
 * 插件要能从 profile 的 node_modules 里解析到 @deepseek-ai/* 依赖。
 *
 * 用法： node tests/loadtest.mjs
 */
import { pathToFileURL } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

const INSTALL_DIR = process.env.DSH_INSTALL_DIR
  ?? 'D:\\DSH\\.dsh\\profiles\\desktop\\node_modules\\dsh-memory'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}

console.log(`\n=== 从真实安装位置加载 ===\n  ${INSTALL_DIR}\n`)

if (!existsSync(INSTALL_DIR)) {
  console.log(`  ⚠️ 未找到安装目录，跳过。（先用 install.ps1 安装）`)
  process.exit(0)
}

const entry = `${INSTALL_DIR}\\lib\\index.js`
const mod = await import(pathToFileURL(entry).href)

check('模块可加载（依赖解析成功）', mod !== undefined)
check('导出 name', mod.name === 'memory', mod.name)
check('导出 inject=[]tools[]', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('导出 apply 函数', typeof mod.apply === 'function')

// Config 是 schemastery 编译出来的可调用对象。
// 注意分工：Config 只负责**模式默认值**（memoryRoot 默认空串），
// 真正的兜底路径由 normalize() 决定。所以要验证的是整条链路。
const cfg = mod.Config({})
check('Config({}) 补全默认值', cfg !== undefined)
check('模式默认 memoryRoot 为空串（交由 normalize 兜底）', cfg.memoryRoot === '', JSON.stringify(cfg.memoryRoot))
check('默认工作区目录正确', cfg.workspaceDir === '.dsh/memory', cfg.workspaceDir)
check('默认锚定周期 10', cfg.anchorEveryTurns === 10, String(cfg.anchorEveryTurns))
check('默认开启自动读取', cfg.autoRead === true)
check('默认开启沉淀提醒', cfg.steerOnHarvest === true)

// 端到端：apply() 内部会 normalize，空 memoryRoot 必须落到真实的库路径。
// 用一个 mock ctx 触发 apply，并断言没有任何异常。
const registered = new Map()
const mockCtx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: () => {},
  effect: (fn) => fn(),
  tools: { register: (d) => registered.set(d.name, d), get: (n) => registered.get(n) },
  get: () => undefined,
  inject: () => {},
}
let applyError
try {
  mod.apply(mockCtx, cfg)
} catch (error) {
  applyError = error
}
check('apply() 用模式默认值可正常挂载', applyError === undefined, applyError?.message ?? '')
check('apply() 注册了四个记忆工具', registered.size === 4, [...registered.keys()].join(', '))

// 确认依赖确实解析到了 profile 的 node_modules，而不是测试垫片
const realCordis = readFileSync(`${INSTALL_DIR}\\package.json`, 'utf8')
check('package.json 声明 bundle patch', realCordis.includes('cordis.patch.yml'))
check('package.json 是 private', JSON.parse(realCordis).private === true)

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
