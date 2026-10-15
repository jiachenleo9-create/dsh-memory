/**
 * dsh-memory · 回归测试：隐私自检的**误报**防线。
 *
 * ## 这个测试为什么存在
 *
 * 真实误报：往 ACTIVE.md 写技术说明时，`api-key` 规则把普通英文词
 * **`skipGlobalCheck`** 当成密钥——因为旧正则 `(?:sk|pk|...)[-_A-Za-z0-9]{12,}`
 * 匹配了 `sk` + `ipGlobalCheck`（13 个字母，满足 `{12,}`）。
 *
 * 后果不只是"多报一个警告"：`blocked=true` 会触发自动脱敏，
 * 把那句正常说明替换成【已脱敏·凭据】——**静默丢信息**。
 *
 * 本测试锁两道：
 *   1. **假阳性**：常见英文/技术词不得被误判；
 *   2. **假阴性**：真实密钥形态必须仍然被拦。
 *
 * 用法： node tests/privacy-precision.mjs
 */
import { inspect, describe as describePrivacy } from '../lib/privacy.js'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

// ================================================================ 假阳性
section('1. 假阳性：正常技术内容不得被误判为密钥')

const INNOCENT = [
  // ★ 真实踩到的那个
  ['skipGlobalCheck（本次真实误报）', '用显式参数（如 skipGlobalCheck:true）允许跳过'],
  ['skip 开头的普通词', '可以 skip 掉这一步，或者 skipIf 判断一下'],
  ['skill / skills 目录', '把技能放在 .dsh/skills/personal-memory 下面'],
  ['sk 开头的驼峰标识符', '函数 skipGlobalCheckEnabled 用来控制开关'],
  ['task / risky 等含 sk 的词', '这是个 risky 操作，也是 task 级别的'],
  ['disk 一词', '保存到 disk 上，注意 diskUsage 指标'],
  ['mask / ask 等', 'need to ask the user, then mask the value'],
  ['pkh 形式的普通词', 'pkey 这个缩写不要用'],
  ['真·技术术语 passwordless', '支持 passwordless 登录方式（无密码）'],
  ['accessKeyId 字段名（无值）', '配置项 accessKeyId 需要填写'],
  ['文档里的占位说明', '把 API Key 填进配置文件里（这里只讲概念，没有真 key）'],
  ['十六进制哈希（非密钥）', 'commit 哈希是 a3f9c2e81b7d4056 这种'],
  ['日期与版本号', '版本 v1.2.3 发布于 2026-10-15'],
  ['路径里的 sk', '路径 C:\\work\\sketch\\demo.psd 也要检查'],
]

for (const [label, text] of INNOCENT) {
  const report = inspect(text, { allowSoft: true })
  const bad = report.hits.map((h) => `${h.id}=${h.matched}`).join(', ')
  check(`不误报：${label}`, report.blocked === false, report.blocked ? bad : '')
}

// 那条完整原文（最贴近真实场景）
const REAL_CASE = 'dsh-memory 的待改进设计缺口：建议方案是在 memory_write 的 archive_task 分支加"归档前闸门"——若本任务从未写过 global，则拒绝归档并提示模型先判断一次；用显式参数（如 skipGlobalCheck:true）允许确认无内容时跳过，避免变成骚扰。'
const realReport = inspect(REAL_CASE, { allowSoft: true })
check('不误报：本次真实原文', realReport.blocked === false,
  realReport.hits.map((h) => `${h.id}=${h.matched}`).join(', '))
check('原文内容不被改动', realReport.sanitized === REAL_CASE)
check('不出现脱敏占位符', !realReport.sanitized.includes('【已脱敏'))

// ================================================================ 假阴性
section('2. 假阴性：真实密钥形态必须仍然被拦')

/*
 * ⚠️ 这些是**构造的假密钥**，不是真凭据。
 *
 * 用字符串拼接而不是直接写字面量，是为了避免 GitHub secret scanning
 * 在推送时把测试文件误报成"泄露了密钥"——那会阻断 CI/推送，
 * 而维护者一眼看不出这是测试数据。
 *
 * 拼接后得到的字符串与真实密钥**形状完全一致**（前缀 + 分隔符 + 足够长度 + 含数字），
 * 所以照样能验证隐私规则的有效性。
 */
const FAKE = (...parts) => parts.join('')

const REAL_SECRETS = [
  ['OpenAI 风格 sk-', `api key: ${FAKE('sk-proj-', 'A1b2C3d4E5f6G7h8I9j0K1l2')}`],
  ['sk_live 风格', `token = ${FAKE('sk_live_', '51H8xY2eZvKYlo2C9dEfGhIjK')}`],
  ['ghp_ GitHub token', FAKE('ghp_', '16C7e42F292c6912E7710c838347Ae178B4a')],
  ['github_pat 细粒度', FAKE('github_pat_', '11ABCDEFG0aBcDeFgHiJkL_9xYzAbCdEfGhIjKlMnOpQrStUvWx')],
  ['xoxb Slack', FAKE('xoxb-', '123456789012-abcdefghijklmnop')],
  ['AKIA AWS', FAKE('AKIA', 'IOSFODNN7EXAMPLE')],
  ['AIza Google', FAKE('AIza', 'SyD8fG9hJ0kL1mN2oP3qR4sT5uV6wX7yZ8a')],
  ['pk- 前缀带数字', FAKE('pk_test_', '51H8xY2eZvKYlo2C9dEfGhIjK')],
]

for (const [label, text] of REAL_SECRETS) {
  const report = inspect(text, { allowSoft: true })
  check(`仍拦截：${label}`, report.blocked === true,
    report.blocked ? '' : '⚠️ 漏报了！')
}

// ================================================================ 可纠正性
section('3. 误报必须可见、可纠正')

const report2 = inspect('手机号 13812345678 记一下', { allowSoft: true })
check('命中时报 blocked', report2.blocked === true)
check('report.masked 存在', Array.isArray(report2.masked) && report2.masked.length > 0)
check('masked 含规则名', report2.masked[0].rule === 'phone-cn', report2.masked[0].rule)
check('masked 含类别', report2.masked[0].category === '联系方式', report2.masked[0].category)
check('masked 含样本（可核对是否误报）', typeof report2.masked[0].sample === 'string' && report2.masked[0].sample !== '')
check('masked 含长度', Number.isInteger(report2.masked[0].length))

const text2 = describePrivacy(report2)
check('说明里列出被替换的片段', text2.includes('被替换的片段'), '')
check('说明里给出样本', text2.includes('13812345678'))
check('说明里提示可改写重试', text2.includes('误报'))

// 长密钥样本要截断展示，避免把密钥本身又写进日志
const longKey = inspect('sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2', { allowSoft: true })
check('长密钥样本被截断（不完整回显）',
  longKey.masked[0].sample.length < longKey.masked[0].length,
  `sample=${longKey.masked[0].sample.length} 字符 / 原长 ${longKey.masked[0].length}`)

// ================================================================ 精度统计
section('4. 精度汇总')
const innocentPassed = INNOCENT.filter(([, text]) => !inspect(text, { allowSoft: true }).blocked).length
const secretsCaught = REAL_SECRETS.filter(([, text]) => inspect(text, { allowSoft: true }).blocked).length
check('正常内容零误报', innocentPassed === INNOCENT.length, `${innocentPassed}/${INNOCENT.length}`)
check('真实密钥全拦截', secretsCaught === REAL_SECRETS.length, `${secretsCaught}/${REAL_SECRETS.length}`)

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
