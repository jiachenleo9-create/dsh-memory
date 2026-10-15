/**
 * 验证：不同环境下 L1 记忆库会落在哪里。
 *
 * 这直接回答用户的问题——「别人装到自己电脑上，L1 在哪？」
 * 必须在**同一进程内改环境变量**再调 normalize()，因为它是每次调用时读 env。
 *
 * 用法： node tests/l1-location.mjs
 */
import { normalize } from '../lib/config.js'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`) }

/** 在指定环境下解析默认路径。 */
function resolveWith({ dshHome, userprofile }) {
  const savedDsh = process.env.DSH_HOME
  const savedProfile = process.env.USERPROFILE
  try {
    if (dshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = dshHome
    if (userprofile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = userprofile
    const settings = normalize({})   // 完全不传配置 = 新用户装完即用
    return {
      memoryRoot: settings.memoryRoot,
      sessionRoot: settings.sessionRoot,
    }
  } finally {
    if (savedDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDsh
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }
}

section('1. 场景 A：DSH 装在默认位置（最常见）')
const normal = resolveWith({ userprofile: 'C:\\Users\\alice' })
check('L1 落在 ~/.dsh/memory', normal.memoryRoot === join('C:\\Users\\alice', '.dsh', 'memory'),
  normal.memoryRoot)
check('会话目录同源推导', normal.sessionRoot === join('C:\\Users\\alice', '.dsh', 'sessions'),
  normal.sessionRoot)

section('2. 场景 B：用户把 DSH 装到别的盘（你就是这样）')
const customHome = resolveWith({ dshHome: 'D:\\DSH\\.dsh', userprofile: 'C:\\Users\\bob' })
check('L1 跟随 DSH_HOME', customHome.memoryRoot === join('D:\\DSH\\.dsh', 'memory'),
  customHome.memoryRoot)
check('不再指向 ~/.dsh', !customHome.memoryRoot.includes('Users'),
  customHome.memoryRoot)

section('3. 场景 C：两个环境变量都没有（极端情况）')
const noEnv = resolveWith({})
check('退回到当前工作目录下的 memory/（仍能工作，不会崩）',
  noEnv.memoryRoot.endsWith(join('memory')) || noEnv.memoryRoot.endsWith('memory'),
  noEnv.memoryRoot)
check('sessionRoot 为空串（审计会优雅降级）', noEnv.sessionRoot === '',
  JSON.stringify(noEnv.sessionRoot))

section('4. 场景 D：用户想自己指定位置')
// 显式配置必须**完全覆盖**自动推导
const savedDsh = process.env.DSH_HOME
try {
  process.env.DSH_HOME = 'D:\\DSH\\.dsh'
  const explicit = normalize({ memoryRoot: 'E:\\我的记忆库' })
  check('显式 memoryRoot 优先', explicit.memoryRoot === 'E:\\我的记忆库', explicit.memoryRoot)
  const obsidian = normalize({ memoryRoot: 'D:\\Obsidian\\vault\\记忆' })
  check('可以指向 Obsidian 库等任意位置',
    obsidian.memoryRoot === 'D:\\Obsidian\\vault\\记忆', obsidian.memoryRoot)
  // 空串/纯空白 → 视为"未配置"，回落到默认
  const blank = normalize({ memoryRoot: '   ' })
  check('留空/空白视为未配置', blank.memoryRoot === join('D:\\DSH\\.dsh', 'memory'),
    blank.memoryRoot)
} finally {
  if (savedDsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDsh
}

section('5. 关键：目录不存在时会不会自动建？')
// 这个由 store.ensureMemoryRoot() 负责，插件启动时调用
const { MemoryStore } = await import('../lib/store.js')
const { mkdtempSync, rmSync, existsSync, readdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const sandbox = mkdtempSync(join(tmpdir(), 'l1loc-'))
const freshRoot = join(sandbox, 'never-existed')   // 故意不创建
const store = new MemoryStore({ memoryRoot: freshRoot, workspaceDirName: '.dsh/memory' })

check('建库前目录不存在', !existsSync(freshRoot))
const boot = store.ensureMemoryRoot()
check('自动创建成功', existsSync(freshRoot))
check('建出 7 个文件', boot.created.length === 7, boot.created.join(', '))
check('含入口索引', boot.created.includes('MEMORY.md'))
check('含隐私红线', boot.created.includes('00-隐私红线.md'))
check('含维护日志', boot.created.includes('12-记忆维护日志.md'))
check('7 个文件都真的落盘了', readdirSync(freshRoot).length === 7,
  `${readdirSync(freshRoot).length} 个`)

// 幂等 + 不覆盖
const boot2 = store.ensureMemoryRoot()
check('二次调用不重复创建', boot2.created.length === 0)

// 已有内容不被覆盖
const { writeFileSync, readFileSync } = await import('node:fs')
writeFileSync(join(freshRoot, 'MEMORY.md'), '# 我自己写的索引\n', 'utf8')
store.ensureMemoryRoot()
check('绝不覆盖用户已有内容',
  readFileSync(join(freshRoot, 'MEMORY.md'), 'utf8') === '# 我自己写的索引\n')

rmSync(sandbox, { recursive: true, force: true })

section('6. 结论')
console.log(`
  新用户装完 → **不用指定任何东西**，L1 自动落在：
      <DSH_HOME>/memory
  其中 DSH_HOME 优先取环境变量 DSH_HOME；没设就用 ~/.dsh
  （Windows 即 C:\\Users\\<用户名>\\.dsh\\memory）

  目录不存在时插件**自动建一套带填写指引的骨架**（7 个文件），
  已存在的文件绝不覆盖。

  想放别处 → 在 profile 的 cordis.patch.yml 里写 memoryRoot 指过去。
`)

console.log(`${'='.repeat(74)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
