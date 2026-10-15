/**
 * 排查：扫描**所有已安装的第三方插件**，找出会写入已退役
 * `{kind:'plugin'}` 消息来源的代码。
 *
 * 为什么这会导致「本轮运行失败」：
 *   - 应用（app.asar）使用 V4 会话格式，其写路径准入检查
 *     `assertV4MessageSources` 会**拒绝** `source.kind === 'plugin'`，
 *     抛 `format v4 message requires a producer-owned source kind`。
 *   - 而 `producerKind()`（把 'plugin' 映射成生产者 kind）**只用于 V3→V4 迁移读路径**。
 *   - 因此任何第三方插件用 `createUserMessage({source:{kind:'plugin',...}})`
 *     并把消息交给 `agent.inject()` / `agent.steer()` / pre-step，都会在写入时被拒。
 *
 * 用法： node tests/audit-installed-plugins.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = 'D:\\DSH\\.dsh\\profiles\\desktop'

/** 待审计的插件根目录。 */
const ROOTS = [
  join(PROFILE, 'plugins'),
  join(PROFILE, 'node_modules'),
]

/** 非第三方（第一方/工具链）目录，跳过以免噪音。 */
const SKIP_PREFIXES = ['@deepseek-ai', '.pnpm', '.bin', '.dsh-module-fallback', '@img', '@swc', '@vscode', '@koromix']

/** 只用名字判断：这些是明显的依赖包，不是插件。 */
const DEP_ONLY = new Set([
  'schemastery', 'cordis', 'zod', 'yaml', 'ws', 'semver', 'sharp', 'undici-types',
  'standardwebhooks', 'side-channel', 'tslib', 'which', 'wrappy', 'vary', 'send',
  'serve-static', 'statuses', 'toidentifier', 'unpipe', 'web-streams-polyfill',
  'zod-to-json-schema', 'ts-algebra', 'node-addon-system', 'wsl-utils', 'shebang-command',
  'shebang-regex', 'setprototypeof', 'side-channel-list', 'side-channel-map', 'side-channel-weakmap',
])

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkFiles(full, out, depth + 1)
    } else if (/\.(js|mjs|cjs)$/u.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** 收集候选插件目录。 */
const candidates = []
for (const root of ROOTS) {
  if (!existsSync(root)) continue
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (SKIP_PREFIXES.includes(entry.name) || DEP_ONLY.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.name.startsWith('@')) {
      // scope 目录：逐个子包
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        if (SKIP_PREFIXES.includes(`${entry.name}/${sub.name}`)) continue
        candidates.push({ name: `${entry.name}/${sub.name}`, dir: join(full, sub.name) })
      }
    } else {
      candidates.push({ name: entry.name, dir: full })
    }
  }
}

console.log(`扫描 ${candidates.length} 个候选插件目录\n`)

/** 关注点。 */
const FINDINGS = [
  {
    id: 'retired-source-literal',
    label: '写入已退役 {kind:"plugin"}（会让本轮失败）',
    severity: 'HIGH',
    re: /kind\s*:\s*['"]plugin['"]/gu,
  },
  {
    id: 'producer-safe-literal',
    label: '使用生产者自有 kind（安全）',
    severity: 'OK',
    re: /kind\s*:\s*['"]plugin:[\w@/.-]+['"]/gu,
  },
  {
    id: 'inject-call',
    label: '调用 agent.inject()（会把消息落盘）',
    severity: 'INFO',
    re: /\.inject\s*\(/gu,
  },
  {
    id: 'steer-call',
    label: '调用 agent.steer()（会把消息落盘）',
    severity: 'INFO',
    re: /\.steer\s*\(/gu,
  },
  {
    id: 'create-user-message',
    label: '构造 createUserMessage',
    severity: 'INFO',
    re: /createUserMessage\s*\(/gu,
  },
]

const results = []

for (const candidate of candidates) {
  const files = walkFiles(candidate.dir)
  if (files.length === 0) continue

  const perPlugin = { name: candidate.name, dir: candidate.dir, findings: new Map(), files: 0 }
  let source

  for (const file of files) {
    let text
    try {
      const info = statSync(file)
      if (info.size > 4 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch { continue }
    perPlugin.files++

    for (const finding of FINDINGS) {
      finding.re.lastIndex = 0
      let match
      while ((match = finding.re.exec(text)) !== null) {
        // 计算行号
        const before = text.slice(0, match.index)
        const line = before.split('\n').length
        if (!perPlugin.findings.has(finding.id)) {
          perPlugin.findings.set(finding.id, { finding, hits: [] })
        }
        const bucket = perPlugin.findings.get(finding.id)
        if (bucket.hits.length < 8) {
          bucket.hits.push({ file: file.replace(PROFILE, ''), line, text: match[0] })
        }
        if (match[0].length === 0) finding.re.lastIndex += 1
      }
    }
  }

  if (perPlugin.findings.size > 0) results.push(perPlugin)
}

// ---------------------------------------------------------------- 汇总
const culprits = results.filter((row) => row.findings.has('retired-source-literal'))

console.log('='.repeat(96))
console.log(`⛔ 使用已退役 {kind:"plugin"} 的插件：${culprits.length} 个`)
console.log('='.repeat(96))
if (culprits.length === 0) {
  console.log('（无）')
} else {
  for (const row of culprits) {
    console.log(`\n● ${row.name}`)
    console.log(`  目录：${row.dir}`)
    for (const hit of row.findings.get('retired-source-literal').hits) {
      console.log(`    ${hit.file}:${hit.line}`)
      console.log(`      ${hit.text}`)
    }
    const injects = row.findings.get('inject-call')?.hits.length ?? 0
    const steers = row.findings.get('steer-call')?.hits.length ?? 0
    const creates = row.findings.get('create-user-message')?.hits.length ?? 0
    console.log(`    关联：createUserMessage×${creates}  inject×${injects}  steer×${steers}`)
  }
}

console.log(`\n${'='.repeat(96)}`)
console.log('全部插件的关注点明细')
console.log('='.repeat(96))
for (const row of results.sort((a, b) => a.name.localeCompare(b.name))) {
  const tags = []
  for (const [id, bucket] of row.findings) {
    tags.push(`${bucket.finding.severity === 'HIGH' ? '⛔' : '·'}${id}×${bucket.hits.length}`)
  }
  console.log(`  ${row.name.padEnd(38)} ${tags.join('  ')}`)
}

console.log(`\n${'='.repeat(96)}`)
console.log('结论')
console.log('='.repeat(96))
console.log(`
写路径规则（来自 app.asar 的 V4 准入检查）：
  source.kind 必须是「生产者自有 kind」。以下写法会被拒绝：
      { kind: 'plugin', plugin: '任意名字' }        ⛔ 已退役
  安全写法：
      { kind: 'plugin:<插件名>' }                   ✅ 命名空间形式
      { kind: '<自有生产者名>' }                     ✅ 如 'agent-instructions'

producerKind() 的白名单（RELEASED_SAME_NAME_PRODUCERS）**只用于读取旧 V3 文件时的迁移**，
不能用来在写路径上"豁免"自己的 kind。
`)
