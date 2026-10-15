/**
 * dsh-memory · 审计功能测试（「班主任」视角）。
 *
 * 用户要的不是"某个工作区做得怎样"，而是**横向的总览**：
 * 「最近各工作区干得怎么样？有没有按时归档？有没有写错文件？」
 *
 * 所以审计必须：
 *   1. 发现**全部**带端口的工作区（漏一个就等于失明）；
 *   2. 只报**值得行动**的问题（噪音会毁掉可信度）；
 *   3. 纯只读（用户随时跑，不能改状态）。
 *
 * 用法： node tests/audit.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { MemoryStore } from '../lib/store.js'
import { buildAudit, renderReport, inspectPort, inspectGlobal, discoverWorkspaces } from '../lib/audit.js'
import { normalize } from '../lib/config.js'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-audit-'))
const memoryRoot = join(sandbox, 'global')
mkdirSync(memoryRoot, { recursive: true })

// ---------------------------------------------------------------- 全局库
writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '# MEMORY', '> 最后更新：2026-01-01　｜　条目总数：2 条', '',
  '## 2. 分类文件索引', '',
  '| # | 文件 | 内容 | 条目数 | 最近更新 |',
  '|---|---|---|---|---|',
  '| 00 | [红线](00-隐私红线.md) | 规则 | — | 2026-01-01 |',
  '| 03 | [技术栈](03-技术栈与工具.md) | 硬件 | 2 | 2026-01-01 |',
  '',
  '## 5. 变更历史',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 红线\n\n### 规则一\n- x\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), '---\n条目数: 2\n更新: 2026-01-01\n---\n\n## 条目\n\n### A\n- x\n\n### B\n- y\n\n## 备注\n\n- 说明。\n', 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 日志\n\n| 时间 | 操作 |\n|---|---|\n', 'utf8')

const settings = normalize({ memoryRoot, sessionRoot: join(sandbox, 'sessions') })
const store = new MemoryStore({ memoryRoot, workspaceDirName: '.dsh/memory' })

// ---------------------------------------------------------------- 造工作区
const sessions = join(sandbox, 'sessions')
mkdirSync(sessions, { recursive: true })

/** 造一个工作区 + 会话目录（头部带权威 cwd）。 */
function makeWorkspace(name, { taskStatus = '空闲', goal = '', archives = 0, sessionCount = 0 } = {}) {
  const cwd = join(sandbox, name)
  const portDir = join(cwd, '.dsh', 'memory')
  mkdirSync(portDir, { recursive: true })
  mkdirSync(join(portDir, 'archive'), { recursive: true })
  mkdirSync(join(portDir, 'sessions'), { recursive: true })

  writeFileSync(join(portDir, 'WORKSPACE.md'), [
    '---', `工作区: ${name}`, `路径: ${cwd}`, '创建: 2026-01-01', '更新: 2026-01-01', '---', '',
    '# 工作区记忆端口', '',
    '## 速览', '', '### 这个工作区是做什么的', '- 测试用。', '',
  ].join('\n'), 'utf8')

  writeFileSync(join(portDir, 'ACTIVE.md'), [
    '# 当前任务档案 · ACTIVE', '', '## 状态', `- 状态：${taskStatus}`, '- 更新：2026-01-01', '',
    '## 任务目标（原始表述，不要在推进中被改写）',
    goal === '' ? '- （当前没有进行中的任务）' : `- ${goal}`, '',
    '## 验收标准', '- （待补充）', '', '## 进度时间线', '- （待补充）', '',
    '## 关键约束与决定', '- （待补充）', '',
  ].join('\n'), 'utf8')

  for (let index = 0; index < archives; index++) {
    writeFileSync(join(portDir, 'archive', `2026-01-0${index + 1}-任务${index + 1}.md`),
      `<!-- 归档 -->\n> 归档说明：第 ${index + 1} 次\n\n## 任务目标\n- 目标 ${index + 1}\n`, 'utf8')
  }
  for (let index = 0; index < sessionCount; index++) {
    writeFileSync(join(portDir, 'sessions', `session-${index}.md`), '# 轨迹\n', 'utf8')
  }

  // 会话目录：目录名故意与 cwd 无关，证明发现逻辑靠**头部 cwd** 而非目录名。
  // 用计数器保证每个工作区拿到互不相同的目录名——否则纯中文名在
  // `[^\w]` 过滤后都变成空串，会撞进同一个目录，测试自己把自己测糊了。
  const tag = `w${(makeWorkspace.counter = (makeWorkspace.counter ?? 0) + 1)}`
  const header = JSON.stringify({ type: 'session', version: 4, id: 'x', cwd })

  // 压缩版与明文版各造一个：两条读取路径都要覆盖。
  const dir = join(sessions, `--X-${tag}--`, 's1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`, 'utf8')))

  const dir2 = join(sessions, `--Y-${tag}--`, 's2')
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, 'session.v4.jsonl'), header, 'utf8')

  return cwd
}

const wsHealthy = makeWorkspace('健康工作区', { taskStatus: '空闲', archives: 2, sessionCount: 3 })
const wsActive = makeWorkspace('进行中工作区', { taskStatus: '进行中', goal: '做一件正在进行的事。', archives: 1 })
const wsStale = makeWorkspace('陈旧工作区', { taskStatus: '进行中', goal: '很久没动的任务。' })

// 把陈旧工作区的 ACTIVE 更新日期改老
const staleActive = join(wsStale, '.dsh', 'memory', 'ACTIVE.md')
writeFileSync(staleActive, readFileSync(staleActive, 'utf8').replace('更新：2026-01-01', '更新：2025-01-01'), 'utf8')

// ================================================================
section('1. 发现全部工作区（漏一个就是失明）')
const found = discoverWorkspaces(sessions)
const foundNames = found.map((entry) => entry.cwd.split(/[\\/]/u).pop()).sort()
check('三个工作区都被发现', found.length === 3, `发现 ${found.length} 个：${foundNames.join(', ')}`)
check('找到健康工作区', foundNames.includes('健康工作区'))
check('找到进行中工作区', foundNames.includes('进行中工作区'))
check('找到陈旧工作区', foundNames.includes('陈旧工作区'))
check('压缩与明文日志都能读', found.length === 3)
check('不含未还原的转义', found.every((entry) => !entry.cwd.includes('~')))

// ================================================================
section('2. 审计报告（班主任总览）')
const audit = buildAudit(store, settings, wsHealthy)
check('报告含生成时间', typeof audit.generatedAt === 'string' && audit.generatedAt.length > 0)
check('全局库已检查', audit.global !== undefined)
check('工作区已检查', audit.workspaces.length === 3, `${audit.workspaces.length} 个`)

const markdown = renderReport(audit)
check('报告是 Markdown', markdown.startsWith('# 记忆系统审计报告'))
check('含总览表格', markdown.includes('| 工作区 | 任务状态 |'))
check('含全局库章节', markdown.includes('## 二、全局记忆库（班长）'))
check('含问题清单章节', markdown.includes('## 三、发现的问题'))
check('含归档明细章节', markdown.includes('## 四、最近归档'))
check('总览列出全部工作区',
  ['健康工作区', '进行中工作区', '陈旧工作区'].every((n) => markdown.includes(n)))
check('归档数被统计', markdown.includes('| 2 |') || markdown.includes('归档'))

// ================================================================
section('3. 关键检查：陈旧任务应被标记')
const staleReport = audit.workspaces.find((ws) => ws.cwd === wsStale)
check('找到陈旧工作区条目', staleReport !== undefined)
check('标记出任务陈旧（忘了归档）',
  staleReport?.problems.some((p) => p.kind === 'stale-task') === true,
  staleReport?.problems.map((p) => p.kind).join(', ') || '(无)')

// ================================================================
section('4. 精度：不该报的别报')
const healthyReport = audit.workspaces.find((ws) => ws.cwd === wsHealthy)
check('健康工作区无 warn/error',
  healthyReport?.problems.filter((p) => p.level !== 'info').length === 0,
  healthyReport?.problems.map((p) => `${p.level}:${p.kind}`).join(', ') || '(无)')
check('空闲任务不报 stale', !healthyReport?.problems.some((p) => p.kind === 'stale-task'))
check('全局库无误报', audit.global.problems.length === 0,
  audit.global.problems.map((p) => p.kind).join(', ') || '(无)')
check('隐私红线不被要求有 ## 条目',
  !audit.global.problems.some((p) => p.kind === 'no-entries-section' && p.detail.includes('00-')))
check('维护日志不被要求有 ## 条目',
  !audit.global.problems.some((p) => p.kind === 'no-entries-section' && p.detail.includes('12-')))

// ================================================================
section('5. 数据损坏必须被发现')
const brokenRoot = join(sandbox, 'broken')
mkdirSync(brokenRoot, { recursive: true })
writeFileSync(join(brokenRoot, 'MEMORY.md'), '# MEMORY\n> 最后更新：2026-01-01　｜　条目总数：99 条\n', 'utf8')
writeFileSync(join(brokenRoot, '03-x.md'), '---\n条目数: 5\n---\n\n## 条目\n\n### A\n- x\n', 'utf8')
const brokenReport = inspectGlobal(brokenRoot)
check('条目数不符被发现', brokenReport.problems.some((p) => p.kind === 'count-mismatch'),
  brokenReport.problems.map((p) => p.kind).join(', '))
check('索引总数不符被发现', brokenReport.problems.some((p) => p.kind === 'total-mismatch'))

// 索引缺失
const emptyRoot = join(sandbox, 'empty')
mkdirSync(emptyRoot, { recursive: true })
check('L1 入口缺失被报为 error',
  inspectGlobal(emptyRoot).problems.some((p) => p.kind === 'missing-index' && p.level === 'error'))

// 状态与目标不一致
const badPort = join(sandbox, '坏端口', '.dsh', 'memory')
mkdirSync(badPort, { recursive: true })
writeFileSync(join(badPort, 'ACTIVE.md'),
  '# ACTIVE\n\n## 状态\n- 状态：进行中\n\n## 任务目标（原始表述，不要在推进中被改写）\n- （当前没有进行中的任务）\n', 'utf8')
const badReport = inspectPort(badPort)
check('状态与目标不一致被发现',
  badReport.problems.some((p) => p.kind === 'state-mismatch' || p.kind === 'task-without-goal'),
  badReport.problems.map((p) => p.kind).join(', '))

// 归档文件命名
const badArchivePort = join(sandbox, '坏归档', '.dsh', 'memory')
mkdirSync(join(badArchivePort, 'archive'), { recursive: true })
writeFileSync(join(badArchivePort, 'WORKSPACE.md'), '# 端口\n', 'utf8')
writeFileSync(join(badArchivePort, 'archive', '随手起的名字.md'), '# x\n', 'utf8')
check('归档命名不规范被发现',
  inspectPort(badArchivePort).problems.some((p) => p.kind === 'bad-archive-name'),
  inspectPort(badArchivePort).problems.map((p) => p.kind).join(', '))

// ================================================================
section('6. 审计必须纯只读')
const beforeSnapshot = new Map()
for (const file of ['MEMORY.md', '03-技术栈与工具.md', '12-记忆维护日志.md']) {
  beforeSnapshot.set(file, readFileSync(join(memoryRoot, file), 'utf8'))
}
const activeBefore = readFileSync(join(wsActive, '.dsh', 'memory', 'ACTIVE.md'), 'utf8')

buildAudit(store, settings, wsHealthy)
renderReport(buildAudit(store, settings, wsHealthy))

let unchanged = true
for (const [file, text] of beforeSnapshot) {
  if (readFileSync(join(memoryRoot, file), 'utf8') !== text) unchanged = false
}
check('全局库文件未被修改', unchanged)
check('工作区任务档案未被修改',
  readFileSync(join(wsActive, '.dsh', 'memory', 'ACTIVE.md'), 'utf8') === activeBefore)

// ================================================================
section('7. 空/异常输入不崩')
const emptySessions = join(sandbox, 'no-sessions')
mkdirSync(emptySessions, { recursive: true })
check('无会话目录时返回空', discoverWorkspaces(emptySessions).length === 0)
check('sessions 不存在时不崩', discoverWorkspaces(join(sandbox, 'nope')).length === 0)

const emptyAudit = buildAudit(store, { memoryRoot: join(sandbox, 'nope'), sessionRoot: join(sandbox, 'nope') }, undefined)
check('库不存在时审计不崩', emptyAudit.workspaces.length === 0)
check('库不存在时报告仍可渲染', renderReport(emptyAudit).includes('# 记忆系统审计报告'))
check('库不存在时报 error',
  emptyAudit.global.problems.some((p) => p.level === 'error' && p.kind === 'missing-index'))

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
