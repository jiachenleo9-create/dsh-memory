/**
 * dsh-memory · 全部测试入口。
 *
 * 用法： node tests/run-all.mjs
 * 退出码 0 = 全部通过。
 *
 * 说明：子进程用 `stdio: 'inherit'`（直接继承终端），不做管道捕获。
 * 某些受限沙箱会拒绝带管道的 spawn（EPERM），继承式 stdio 不受影响，
 * 而且各测试自己的彩色输出能原样透出来，更好读。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
/**
 * 测试套件清单。
 *
 * 两个必须常驻的回归测试：
 *   - `source-format.mjs`：曾经用已退役的 `{kind:'plugin'}` 注入消息，
 *     被 V4 准入检查拒绝，导致**整轮失败**。
 *   - `late-mount.mjs`：插件若在 session-start 之后才挂载，端口会漏建，
 *     L2/L3 静默消失。
 *   - `tool-output-json.mjs`：工具返回值里带 `undefined` 会让真实调用报
 *     "value is not lossless JSON"——mock 测试不校验返回值，只有这道关能拦住。
 *   - `task-rotation.mjs`：连续做多个任务时，第二个任务起 L3 锚定会失效
 *     （内存布尔守卫 + 目标查找无边界），长会话里"忘记在干什么"。
 *   - `integrity.mjs`：条目错位、归档同名覆盖、解析截断等**已造成真实损坏**的问题。
 *   - `audit.mjs`：跨工作区审计必须发现全部工作区（漏一个=失明）。
 *   - `duties-gate-poll.mjs`：归档闸门 + L1 轮询；含"被拒绝的归档
 *     不能推进边界"的**死循环回归**。
 * `loadtest.mjs` 从真实安装位置加载，验证依赖解析与挂载。
 */
const suites = [
  'selftest.mjs',
  'integration.mjs',
  'schema-check.mjs',
  'source-format.mjs',
  'late-mount.mjs',
  'privacy-precision.mjs',
  'duties-gate-poll.mjs',
  'tool-output-json.mjs',
  'task-rotation.mjs',
  'integrity.mjs',
  'audit.mjs',
  'routes.mjs',
  'loadtest.mjs',
]

console.log('dsh-memory · 运行全部测试\n')

const results = []
for (const file of suites) {
  console.log(`▶ ${file}`)
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  const ok = result.status === 0
  results.push({ file, ok, status: result.status })
  if (result.error !== undefined && result.error !== null) {
    console.log(`  启动失败：${result.error.message}`)
  }
  console.log('')
}

console.log('='.repeat(72))
for (const item of results) {
  console.log(`${item.ok ? '✅' : '❌'}  ${item.file.padEnd(20)} 退出码 ${item.status}`)
}
console.log('='.repeat(72))
const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? '全部通过 ✅' : `${failed} 个测试文件失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
