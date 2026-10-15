/**
 * dsh-memory · 回归测试：数据完整性与结构正确性。
 *
 * ## 这个测试为什么存在
 *
 * 一轮独立代码审查 + 实证验证发现了若干**已造成真实损坏**的缺陷：
 *
 *   1. `appendGlobalEntry` 直接追加到文件末尾，不看 `## 条目` 小节。
 *      真实库 03 文件的 `## 备注` 之下已堆积 18 条错位条目。
 *   2. 归档文件名 `${日期}-${slug}` 在同日同目标时**静默覆盖**，
 *      archive/ 里少了文件，"有没有按时归档"的审计依据被破坏。
 *   3. `discoverWorkspaces` 的解码器多吃一个尾随 `~`，
 *      跨工作区审计几乎失明（3 个真实工作区只发现 1 个）。
 *   4. `parseTaskCard` 的正则 `\s*$` 无 `m` 标志，**每小节只取第一行**，
 *      导致 L3 注入的进度/约束永远只有 1 条。
 *   5. `findTaskBoundary` 用子串匹配 `archive_task`，正文提到该词即误判。
 *
 * 这些都属于"mock 测试全绿但真实数据已经烂了"的类型，必须逐条锁死。
 *
 * 用法： node tests/integrity.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, countEntries } from '../lib/store.js'
import { parseTaskCard } from '../lib/brief.js'
import { findTaskBoundary, ARCHIVED_MARKER } from '../lib/harvest.js'
import { discoverWorkspaces } from '../lib/audit.js'

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-mem-integ-'))
const memoryRoot = join(sandbox, 'global')
const workspace = join(sandbox, 'project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

// 造一个**结构接近真实库**的分类文件：条目区之后还有别的章节。
// 这正是旧实现会写错位置的原因。
const CATEGORY = [
  '---',
  '分类: 技术栈与工具',
  '编号: 03',
  '更新: 2026-01-01',
  '条目数: 2',
  '---',
  '',
  '# 03 · 技术栈与工具',
  '',
  '## 条目',
  '',
  '### 已有条目 A',
  '- **记忆**：A。',
  '',
  '### 已有条目 B',
  '- **记忆**：B。',
  '',
  '---',
  '',
  '## 备注',
  '',
  '- 这是文末的说明章节，新条目**不应该**落在这里。',
  '',
].join('\n')

writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '# MEMORY · 索引',
  '> 最后更新：2026-01-01　｜　条目总数：2 条',
  '',
  '## 2. 分类文件索引',
  '',
  '| # | 文件 | 内容 | 条目数 | 最近更新 |',
  '|---|---|---|---|---|',
  '| 00 | [隐私红线](00-隐私红线.md) | 规则清单 | — | 2026-01-01 |',
  '| 03 | [技术栈](03-技术栈与工具.md) | 硬件 | 2 | 2026-01-01 |',
  '| 12 | [日志](12-记忆维护日志.md) | 变更流水 | — | 2026-01-01 |',
  '',
  '## 5. 变更历史',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 红线\n\n### 规则一\n- x\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), CATEGORY, 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), '# 日志\n\n| 时间 | 操作 |\n|---|---|\n', 'utf8')

const store = new MemoryStore({ memoryRoot, workspaceDirName: '.dsh/memory' })

// ================================================================
section('1. 条目必须落进 `## 条目` 小节（不是文件末尾）')
const appendResult = store.appendGlobalEntry('03-技术栈与工具.md', '### 新条目 C\n- **记忆**：C。')
check('写入成功', appendResult.ok === true, appendResult.path)

const after = readFileSync(join(memoryRoot, '03-技术栈与工具.md'), 'utf8')
const lines = after.split(/\r?\n/u)
const entrySectionAt = lines.findIndex((l) => /^##\s*条目\s*$/u.test(l))
const remarkSectionAt = lines.findIndex((l) => /^##\s*备注\s*$/u.test(l))
const newEntryAt = lines.findIndex((l) => /^### 新条目 C/u.test(l))

check('`## 条目` 存在', entrySectionAt >= 0)
check('`## 备注` 存在', remarkSectionAt >= 0)
check('新条目落在 `## 条目` 之后', newEntryAt > entrySectionAt, `条目@${entrySectionAt} 新条目@${newEntryAt}`)
check('新条目落在 `## 备注` **之前**（关键）', newEntryAt < remarkSectionAt,
  newEntryAt < remarkSectionAt ? '' : `错位！新条目@${newEntryAt} 在 备注@${remarkSectionAt} 之后`)
check('备注章节内容未被污染', /说明章节，新条目\*\*不应该\*\*落在这里/u.test(after))
check('没有条目落在备注之后',
  lines.slice(remarkSectionAt).filter((l) => /^### /u.test(l)).length === 0)

// ================================================================
section('2. 归档不得同名覆盖')
const activePath = join(workspace, '.dsh', 'memory', 'ACTIVE.md')
store.ensurePort(workspace, { projectName: 'project' })

const taskTemplate = (goal) => [
  '# 当前任务档案 · ACTIVE', '', '## 状态', '- 状态：进行中', '',
  '## 任务目标（原始表述，不要在推进中被改写）', `- ${goal}`, '',
  '## 验收标准', '- 无', '', '## 进度时间线', '- 已开始', '',
  '## 关键约束与决定', '- 无', '',
].join('\n')

store.writeActiveTask(workspace, taskTemplate('完成一个重复归档测试任务'))
const first = store.archiveActiveTask(workspace, '第一次')
store.writeActiveTask(workspace, taskTemplate('完成一个重复归档测试任务'))
const second = store.archiveActiveTask(workspace, '第二次')

check('第一次归档成功', first !== undefined)
check('第二次归档成功', second !== undefined)
check('两次归档路径不同', first !== second, `first=${first?.split('\\').pop()} second=${second?.split('\\').pop()}`)
check('archive/ 里有两个文件', readdirSync(join(workspace, '.dsh', 'memory', 'archive')).filter((f) => f.endsWith('.md')).length === 2)
if (first !== undefined && second !== undefined) {
  check('第一次归档内容仍在', readFileSync(first, 'utf8').includes('第一次'))
  check('第二次归档内容也在', readFileSync(second, 'utf8').includes('第二次'))
}

// ================================================================
section('3. parseTaskCard 必须取到全部行（不能只取第一行）')
const multiLine = [
  '# ACTIVE', '', '## 状态', '- 状态：进行中', '',
  '## 任务目标（原始表述，不要在推进中被改写）',
  '- 目标第一行。',
  '', '## 验收标准', '- 标准一', '- 标准二', '- 标准三', '',
  '## 进度时间线',
  '- 第 1 步完成',
  '- 第 2 步完成',
  '- 第 3 步完成',
  '- 第 4 步完成',
  '- 第 5 步完成',
  '- 第 6 步完成',
  '',
  '## 关键约束与决定',
  '- 约束甲',
  '- 约束乙',
  '- 约束丙',
  '',
].join('\n')

const card = parseTaskCard(multiLine)
check('状态正确', card.status === '进行中', card.status)
check('目标取到 1 条', card.goal.length === 1, `${card.goal.length} 条`)
check('验收标准取到 3 条', card.acceptance.length === 3, `${card.acceptance.length} 条`)
check('进度时间线取到 6 条（关键）', card.timeline.length === 6,
  card.timeline.length === 1 ? '只取到 1 条 → 正则截断 bug 未修' : `${card.timeline.length} 条`)
check('关键约束取到 3 条', card.constraints.length === 3, `${card.constraints.length} 条`)
check('进度条目内容正确', card.timeline[5] === '第 6 步完成', card.timeline[5])
check('约束条目内容正确', card.constraints[2] === '约束丙', card.constraints[2])

// ---- 边界：占位符应被过滤 ----
const idle = parseTaskCard([
  '## 状态', '- 状态：空闲', '',
  '## 任务目标（原始表述，不要在推进中被改写）',
  '- （当前没有进行中的任务）', '',
].join('\n'))
check('占位行被过滤', idle.goal.length === 0, `${idle.goal.length} 条`)

// ---- 边界：下一个同级标题必须终止收集 ----
const adjacent = parseTaskCard([
  '## 进度时间线', '- 甲', '', '## 关键约束与决定', '- 乙', '',
].join('\n'))
check('相邻小节不串味', adjacent.timeline.length === 1 && adjacent.timeline[0] === '甲',
  `timeline=${JSON.stringify(adjacent.timeline)}`)
check('相邻小节正确', adjacent.constraints.length === 1 && adjacent.constraints[0] === '乙')

// ================================================================
section('4. findTaskBoundary 必须解析参数（不能子串匹配）')
const withMention = [
  { type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '任务一：讨论 archive_task 这个功能该怎么设计比较好。' }] } },
  { type: 'tool/call', data: { turn: 1, name: 'memory_write', arguments: JSON.stringify({ target: 'port', content: '提到 archive_task 的说明' }) } },
]
check('正文提到 archive_task 不算边界', findTaskBoundary(withMention) === 0,
  `boundary=${findTaskBoundary(withMention)}（应为 0）`)

const realArchive = [
  { type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '任务一：做插件。' }] } },
  { type: 'tool/call', data: { turn: 1, callId: 'a1', name: 'memory_write', arguments: JSON.stringify({ target: 'task', action: 'archive_task', content: '完成' }) } },
  // 成功的归档会产生带 ARCHIVED_MARKER 的结果——边界判定依赖它
  {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'a1',
          content: [{ type: 'text', text: `任务已归档。\n${ARCHIVED_MARKER}` }],
          isError: false,
        }],
      },
    },
  },
]
check('真实归档算边界', findTaskBoundary(realArchive) === 2, `boundary=${findTaskBoundary(realArchive)}`)

// 被闸门拒绝的归档**不能**推进边界（否则闸门会陷入死循环）
const rejectedArchive = [
  { type: 'tool/call', data: { turn: 1, callId: 'a2', name: 'memory_write', arguments: JSON.stringify({ target: 'task', action: 'archive_task', content: '尝试' }) } },
  {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'a2',
          content: [{ type: 'text', text: '⏸ 归档被闸门拦下：本任务还没有往 L1 全局库写过任何东西。' }],
          isError: false,
        }],
      },
    },
  },
]
check('被拒绝的归档不推进边界', findTaskBoundary(rejectedArchive) === 0,
  `boundary=${findTaskBoundary(rejectedArchive)}`)

check('目标含 archive_task 字样的参数不误判',
  findTaskBoundary([{ type: 'tool/call', data: { turn: 1, name: 'memory_write', arguments: JSON.stringify({ target: 'port', content: 'archive_task' }) } }]) === 0)
check('非法 JSON 参数不崩',
  findTaskBoundary([{ type: 'tool/call', data: { turn: 1, name: 'memory_write', arguments: '{坏的' } }]) === 0)
check('空事件返回 0', findTaskBoundary([]) === 0)

// ================================================================
section('5. 工作区发现（跨工作区审计的基础）')
check('不存在的 sessions 目录返回空数组',
  Array.isArray(discoverWorkspaces(join(sandbox, 'nonexistent-sessions'))) &&
  discoverWorkspaces(join(sandbox, 'nonexistent-sessions')).length === 0)

/*
 * 发现逻辑现在以**会话日志头部的 cwd 字段**为权威来源。
 *
 * 为什么不测目录名反解：DSH 的目录名编码本质上是有损的——
 * 路径里原本的 `-` 与作为分隔符的 `-` 无法区分
 * （例：`dec-h41ZXk` 与 `dec\h41ZXk` 编码后一样）。
 * 任何反解都只能猜，所以改用日志头部，反解仅作兜底且必须验证存在性。
 */
const fakeSessions = join(sandbox, 'sessions')
const realTarget = join(sandbox, '中文工作区')
mkdirSync(join(realTarget, '.dsh', 'memory'), { recursive: true })
writeFileSync(join(realTarget, '.dsh', 'memory', 'ACTIVE.md'), '# ACTIVE\n', 'utf8')

/** 造一个带头部 cwd 的会话目录（未压缩的 .jsonl 也要能读）。 */
const makeSession = (workdir, cwd) => {
  const dir = join(fakeSessions, workdir, `session-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'),
    JSON.stringify({ type: 'session', version: 4, id: 'x', cwd }), 'utf8')
  return dir
}
// 目录名故意与 cwd 无关，证明"不靠目录名猜"。
makeSession('--C-some-mangled-name-with-dashes--', realTarget)

const discovered = discoverWorkspaces(fakeSessions)
check('靠日志头部 cwd 发现工作区（不靠目录名）',
  discovered.some((entry) => entry.cwd === realTarget),
  `发现 ${discovered.length} 个：${discovered.map((d) => d.cwd).join(' | ')}`)
check('发现结果都是真实存在的端口目录',
  discovered.every((entry) => existsSync(entry.portDir)))
check('目录名有歧义时不误报（含连字符路径）',
  discovered.every((entry) => !entry.cwd.includes('~')),
  discovered.map((d) => d.cwd).join(' | '))

// 没有端口的会话不应被收进来
makeSession('--D-no-port-here--', join(sandbox, '没有端口的工作区'))
check('没有记忆端口的工作区不入列',
  !discoverWorkspaces(fakeSessions).some((entry) => entry.cwd.includes('没有端口')),
  `${discoverWorkspaces(fakeSessions).length} 个`)

// ================================================================
section('6. countEntries 必须排除代码块里的示例')
const withFence = [
  '# 文件', '', '## 条目', '', '_（空）_', '',
  '## 条目格式', '', '```markdown', '### 示例条目', '- **记忆**：<占位>', '```', '',
].join('\n')
check('代码块里的 ### 不计入', countEntries(withFence) === 0, `counted=${countEntries(withFence)}`)

const realEntries = [
  '# 文件', '', '## 条目', '', '### 真条目一', '- x', '### 真条目二', '- y', '',
  '```markdown', '### 示例', '```', '',
].join('\n')
check('真实条目正常计入', countEntries(realEntries) === 2, `counted=${countEntries(realEntries)}`)

check('波浪号围栏也排除', countEntries('~~~\n### 示例\n~~~\n') === 0)
check('空文本返回 0', countEntries('') === 0)
check('非字符串返回 0', countEntries(undefined) === 0)

// ================================================================
section('7. 索引同步必须与实际一致')
store.syncIndex()
const indexText = readFileSync(join(memoryRoot, 'MEMORY.md'), 'utf8')
// 03 现有 3 条（A/B/C），00 与 12 不是条目容器
const categoryEntries = countEntries(readFileSync(join(memoryRoot, '03-技术栈与工具.md'), 'utf8'))
check('03 实际有 3 条', categoryEntries === 3, `${categoryEntries} 条`)
check('索引声明 3 条', /条目总数：3 条/u.test(indexText), indexText.split('\n').find((l) => l.includes('条目总数'))?.trim())
check('索引表 03 行为 3', /\|\s*03\s*\|[^|]*\|[^|]*\|\s*3\s*\|/u.test(indexText))
check('非条目容器标 —（不写成 0）',
  /\|\s*00\s*\|[^|]*\|[^|]*\|\s*—\s*\|/u.test(indexText),
  indexText.split('\n').find((l) => l.includes('00-隐私红线'))?.trim())
check('非条目容器不被打上今天的日期',
  !/\|\s*00\s*\|[^|]*\|[^|]*\|\s*—\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/u.test(indexText.replace(/2026-01-01/u, '2026-01-01')) ||
  indexText.split('\n').find((l) => l.includes('00-隐私红线'))?.includes('2026-01-01') === true,
  indexText.split('\n').find((l) => l.includes('00-隐私红线'))?.trim())

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
