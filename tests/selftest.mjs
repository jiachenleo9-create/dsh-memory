/**
 * dsh-memory · 离线自检脚本。
 *
 * 不需要启动 DSH：直接验证四层存储、简报组装、目标锚定、隐私自检的纯逻辑。
 * 用法： node tests/selftest.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, clipBytes, BRIEF_MARKER, ANCHOR_MARKER } from '../lib/store.js'
import { composeBrief, composeAnchor, parseTaskCard } from '../lib/brief.js'
import { AnchorKeeper, collectTurn, findOriginalGoal, looksLikeTask } from '../lib/harvest.js'
import { inspect, describe as describePrivacy } from '../lib/privacy.js'
import { normalize } from '../lib/config.js'
import { formatEntry, GLOBAL_CATEGORIES } from '../lib/tools.js'

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}${detail === '' ? '' : `  — ${detail}`}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail === '' ? '' : `  — ${detail}`}`)
  }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

// ---------------------------------------------------------------- 测试夹具
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const memoryRoot = join(sandbox, 'global-memory')
const workspace = join(sandbox, 'my-project')
mkdirSync(memoryRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

// 造一个仿真的全局记忆库
writeFileSync(join(memoryRoot, 'MEMORY.md'), [
  '# MEMORY · 记忆索引与核心摘要',
  '',
  '> 最后更新：2026-10-12　｜　条目总数：155 条',
  '',
  '## 1. 核心摘要（agent 优先读这 10 条）',
  '',
  '1. **身份**：称呼「小明」；建筑学背景。',
  '2. **沟通偏好**：直接、清晰、少废话。',
  '3. **技术环境**：Win10 / RTX 3060 12GB。',
  '',
  '## 3. 按需读取指南',
  '',
  '| 用户的问题类型 | 建议读取 |',
  '|---|---|',
  '| 任何个性化回答（兜底） | **11 雷区**（必读）+ 02 沟通偏好 |',
  '| ComfyUI / AI 工作流 | 03 + 05 + 10 |',
  '',
  '## 5. 变更历史',
  '| 日期 | 变更 |',
].join('\n'), 'utf8')

writeFileSync(join(memoryRoot, '00-隐私红线.md'), '# 隐私红线\n\n| # | 类别 |\n|---|---|\n| 1 | 证件号码 |\n', 'utf8')
writeFileSync(join(memoryRoot, '03-技术栈与工具.md'), [
  '---',
  '分类: 技术栈与工具',
  '条目数: 37',
  '更新: 2026-10-11',
  '---',
  '',
  '# 03 · 技术栈与工具',
  '',
  '## 条目',
  '',
  '### 显卡',
  '- **记忆**：RTX 3060 12GB。',
].join('\n'), 'utf8')
writeFileSync(join(memoryRoot, '12-记忆维护日志.md'), [
  '# 12 · 记忆维护日志',
  '',
  '| 时间 | 操作 | 文件 | 条目 | 操作者 | 原因 |',
  '|---|---|---|---|---|---|',
].join('\n'), 'utf8')

const settings = normalize({ memoryRoot, workspaceDir: '.dsh/memory' })
const store = new MemoryStore({ memoryRoot, workspaceDirName: settings.workspaceDir })

// ================================================================ 1. 截断
section('1. 字节安全截断')
check('短文本不截断', clipBytes('abc', 100) === 'abc')
const long = '中'.repeat(100) // 每字 3 字节 = 300
const clipped = clipBytes(long, 50)
check('超长文本被截断', Buffer.byteLength(clipped, 'utf8') <= 50, `${Buffer.byteLength(clipped, 'utf8')} 字节`)
check('截断不破坏多字节字符', !clipped.includes('\uFFFD') && clipped.endsWith('…'))
check('空输入返回空串', clipBytes(undefined, 50) === '')

// ================================================================ 2. 工作区端口
section('2. L2/L3 工作区记忆端口')
const seeded = store.ensurePort(workspace, { projectName: 'my-project' })
check('端口目录已创建', existsSync(seeded.dir), seeded.dir)
check('WORKSPACE.md 已创建', existsSync(join(seeded.dir, 'WORKSPACE.md')))
check('ACTIVE.md 已创建', existsSync(join(seeded.dir, 'ACTIVE.md')))
check('archive/ 已创建', existsSync(join(seeded.dir, 'archive')))
check('端口可读', store.readPort(workspace) !== undefined)
check('任务档案可读', store.readActiveTask(workspace) !== undefined)

const again = store.ensurePort(workspace, { projectName: 'my-project' })
check('重复 ensurePort 不重复创建', again.created.length === 0)

// ================================================================ 3. L1 解析
section('3. L1 全局库解析')
const highlights = store.globalHighlights(10)
check('解析出核心摘要要点', highlights.length === 3, `${highlights.length} 条`)
check('要点内容正确', highlights[0].includes('身份'))
const guide = store.globalRoutingGuide(10)
check('解析出读取指南', guide.length === 2, `${guide.length} 行`)
check('指南跳过表头', guide[0].topic.includes('个性化回答'))
const stats = store.globalStats()
check('解析出条目总数', stats.total === 155, `total=${stats.total}`)
check('解析出最后更新', stats.updated === '2026-10-12', `updated=${stats.updated}`)
check('枚举分类文件', store.listCategories().length === 3, `${store.listCategories().length} 个`)

// ================================================================ 4. 隐私自检
section('4. 隐私红线自检')
const idCard = inspect('他的身份证是 110101199003072316 请记住')
check('拦截身份证号', idCard.blocked, idCard.hits.map((h) => h.note).join(','))
check('脱敏后不含原文', !idCard.sanitized.includes('110101199003072316'))
check('脱敏后带占位符', idCard.sanitized.includes('已脱敏'))

const phone = inspect('手机号 13812345678 记一下')
check('拦截手机号', phone.blocked)

// 拼接构造，避免被 GitHub secret scanning 误报（这是**假密钥**，不是真凭据）
const key = inspect(`api_key = ${'sk-' + 'abcdef1234567890abcdef'}`)
check('拦截 API Key', key.blocked, key.hits.map((h) => h.id).join(','))

const normalDate = inspect('记录时间：2026-10-12，今天完成了插件')
check('普通日期不误伤', !normalDate.blocked, JSON.stringify(normalDate.hits.map((h) => h.id)))

const birth = inspect('出生于 1990-03-07，宁波人')
check('出生语境日期被拦截', birth.blocked, birth.hits.map((h) => h.id).join(','))

const relationship = inspect('我女朋友今天很开心')
check('人际关系命中软红线', relationship.warnings.length > 0, relationship.warnings.map((w) => w.category).join(','))
check('软红线不阻断（allowSoft）', inspect('我女朋友', { allowSoft: true }).blocked === false)

const clean = inspect('用户偏好使用内置 Python 而不是系统 Python')
check('技术内容不误伤', clean.ok && clean.warnings.length === 0, describePrivacy(clean))

// ================================================================ 5. 简报组装
section('5. 记忆简报组装')
const brief = composeBrief(store, settings, workspace)
check('简报非空', brief !== undefined && brief.length > 0)
check('含简报标记', brief.includes(BRIEF_MARKER))
check('含 L1 指引', brief.includes('L1') && brief.includes('全局个人记忆库'))
check('含 L2 端口', brief.includes('L2') && brief.includes('本工作区记忆端口'))
check('含用户画像', brief.includes('小明'))
check('含按需读取指南', brief.includes('按需读取指南'))
check('含隐私红线提示', brief.includes('00-隐私红线.md'))
check('受 maxInjectBytes 约束', Buffer.byteLength(brief, 'utf8') <= settings.maxInjectBytes,
  `${Buffer.byteLength(brief, 'utf8')} ≤ ${settings.maxInjectBytes}`)
console.log(`     [简报体积：${Buffer.byteLength(brief, 'utf8')} 字节 / 上限 ${settings.maxInjectBytes}]`)

// 空闲任务时不该出现 L3 段
check('空闲时不注入 L3 任务段', !brief.includes('L3 · 当前任务（进行中）'))

// ================================================================ 6. 目标锚定
section('6. 长任务目标锚定（防遗忘核心）')
const keeper = new AnchorKeeper(store, settings)

// 造一段仿真会话事件：插件注入 + 真人目标 + 工具调用 + 助手答复
const events = [
  { type: 'user/message', data: { turn: 1, source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md 内容' }] } },
  { type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '嗯' }] } },
  {
    type: 'user/message',
    data: {
      turn: 1,
      source: { kind: 'user' },
      content: [{ type: 'text', text: '帮我做一个自动记忆插件，要求新会话自动读取记忆，任务结束自动写入，并且长任务不能忘记最初目标。' }],
    },
  },
  { type: 'tool/call', data: { turn: 1, name: 'read', arguments: '{"file_path":"E:\\\\a\\\\b.js"}' } },
  { type: 'tool/call', data: { turn: 1, name: 'write', arguments: '{"file_path":"E:\\\\a\\\\plugin.js"}' } },
  { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '已完成插件骨架。' }] } } },
]

check('识别实质任务', looksLikeTask('帮我做一个自动记忆插件，要求新会话自动读取记忆') === true)
check('过滤寒暄', looksLikeTask('嗯') === false)
check('过滤确认语', looksLikeTask('好的，谢谢！') === false)

const original = findOriginalGoal(events)
check('找到原始目标', original !== undefined)
check('跳过插件注入', original.text.includes('自动记忆插件'))
check('逐字保留原文', original.text === '帮我做一个自动记忆插件，要求新会话自动读取记忆，任务结束自动写入，并且长任务不能忘记最初目标。')
check('记录起始轮次', original.turn === 1)

const ensured = keeper.ensureAnchor(workspace, events, 'session-test-1')
check('建立任务锚点', ensured.created === true, ensured.goal)
const activeText = store.readActiveTask(workspace)
check('ACTIVE.md 状态为进行中', activeText.includes('状态：进行中'))
check('ACTIVE.md 保留原始目标', activeText.includes('长任务不能忘记最初目标'))

const ensureAgain = keeper.ensureAnchor(workspace, events, 'session-test-1')
check('锚点幂等（不覆盖已有目标）', ensureAgain.created === false)

const snapshot = collectTurn(events, 1)
check('采集工具调用', snapshot.toolCalls.length === 2, snapshot.toolCalls.join(','))
check('采集写入文件', snapshot.filesWritten.length === 1, snapshot.filesWritten[0])
check('采集助手答复', snapshot.assistantText.includes('插件骨架'))

keeper.recordProgress(workspace, snapshot)
const withProgress = store.readActiveTask(workspace)
check('进度写入时间线', withProgress.includes('进度时间线') && withProgress.includes('改动 1 个文件'))

// ---- 锚点注入 ----
const anchor = composeAnchor(store, settings, workspace, 'compact', 12)
check('压缩后可生成锚点', anchor !== undefined)
check('锚点含标记', anchor.includes(ANCHOR_MARKER))
check('锚点重述原始目标', anchor.includes('长任务不能忘记最初目标'))
check('锚点说明触发原因', anchor.includes('上下文刚刚被压缩'))
check('锚点受预算约束', Buffer.byteLength(anchor, 'utf8') <= settings.anchorInlineBytes,
  `${Buffer.byteLength(anchor, 'utf8')} ≤ ${settings.anchorInlineBytes}`)

const card = parseTaskCard(store.readActiveTask(workspace))
check('解析任务卡片状态', card.status === '进行中', card.status)
check('解析任务目标', card.goal.length === 1 && card.goal[0].includes('自动记忆插件'))

// ================================================================ 7. 归档
section('7. 任务归档')
const archived = store.archiveActiveTask(workspace, '插件已完成')
check('生成归档文件', archived !== undefined && existsSync(archived), archived)
check('归档内容含原始目标', readFileSync(archived, 'utf8').includes('长任务不能忘记最初目标'))
check('ACTIVE.md 回到空闲', store.readActiveTask(workspace).includes('状态：空闲'))
check('空闲后不再生成锚点', composeAnchor(store, settings, workspace, 'interval', 20) === undefined)

// ================================================================ 8. L1 写入
section('8. L1 长期记忆写入')
const entry = formatEntry({
  title: '测试条目', body: '这是一条测试记忆。', source: '对话推断', confidence: '中', tags: ['测试'],
})
check('条目格式完整', entry.includes('**记忆**') && entry.includes('**可信度**') && entry.includes('#测试'))

const writeResult = store.appendGlobalEntry('03-技术栈与工具.md', entry)
check('写入分类文件成功', writeResult.ok, writeResult.path)
const afterWrite = readFileSync(writeResult.path, 'utf8')
check('条目数递增 37→38', afterWrite.includes('条目数: 38'))
check('条目已追加', afterWrite.includes('### 测试条目'))
check('frontmatter 更新日期', afterWrite.includes(`更新: ${new Date().toISOString().slice(0, 10)}`))

const logResult = store.appendMaintenanceLog('测试 | `03` | 测试条目 | selftest | 验证写入')
check('维护日志可写入', logResult === true)
check('维护日志含新行', readFileSync(store.globalLogPath, 'utf8').includes('测试条目'))

check('拒绝路径穿越', store.read('../../etc/passwd', workspace) === undefined)
check('拒绝非法分类名', store.read('evil.md', workspace) === undefined)

// ================================================================ 9. 检索
section('9. 记忆检索')
const hits = store.search('RTX 3060', workspace, 10)
check('检索到显卡信息', hits.length > 0, `${hits.length} 条命中`)
const hits2 = store.search('自动记忆插件', workspace, 10)
check('检索到任务档案内容', hits2.some((h) => h.file.includes('ACTIVE') || h.file.includes('archive')), `${hits2.length} 条`)
check('空查询返回空', store.search('', workspace, 10).length === 0)
check('无命中返回空', store.search('zzz不存在的词zzz', workspace, 10).length === 0)

// ================================================================ 10. 增量轨迹
section('10. L4 会话轨迹')
const traj = keeper.renderTrajectory({
  sessionId: 'session-test-1',
  cwd: workspace,
  snapshots: [snapshot],
  original: original.text,
})
check('轨迹含会话头', traj.includes('session-test-1'))
check('轨迹含原始目标', traj.includes('长任务不能忘记最初目标'))
check('轨迹含轮次', traj.includes('第 1 轮'))
check('轨迹可落盘', store.writeSessionLog(workspace, 'session-test-1', traj) === true)
check('轨迹文件存在', existsSync(join(store.sessionLogDir(workspace), 'session-test-1.md')))

// ================================================================ 11. 写权限演练
section('11. 写权限演练')
const probe = store.writePortProbe(workspace)
check('端口目录可写', probe.ok, probe.detail)
check('探针文件已清理', !existsSync(join(store.portDirFor(workspace), '.write-probe')))

// ================================================================ 12. 配置补全
section('12. 配置补全')
const defaults = normalize({})
/*
 * 默认路径必须**中立**——仓库是给所有人用的，不能写死任何个人路径。
 * 留空时落到 <DSH_HOME>/memory。
 */
check('默认全局库路径中立（不含个人路径）',
  /memory$/u.test(defaults.memoryRoot.replace(/[\\/]+$/u, '')),
  defaults.memoryRoot)
check('默认路径基于 DSH_HOME', defaults.memoryRoot === join(process.env.DSH_HOME ?? '', 'memory')
  || defaults.memoryRoot.endsWith('memory'), defaults.memoryRoot)
check('配置可覆盖默认路径',
  normalize({ memoryRoot: 'D:\\my-memory' }).memoryRoot === 'D:\\my-memory')
check('默认 sessionRoot 基于 DSH_HOME', defaults.sessionRoot.endsWith('sessions'), defaults.sessionRoot)
check('默认工作区目录', defaults.workspaceDir === '.dsh/memory')
check('默认锚定周期 10', defaults.anchorEveryTurns === 10)
check('默认冷却 6 轮', defaults.steerCooldownTurns === 6)
check('负数被修正', normalize({ anchorEveryTurns: -5 }).anchorEveryTurns === 10)
check('0 锚定周期被保留（只在压缩后注入）', normalize({ anchorEveryTurns: 0 }).anchorEveryTurns === 0)
check('分类映射完整', Object.keys(GLOBAL_CATEGORIES).length === 13, `${Object.keys(GLOBAL_CATEGORIES).length} 类`)

// ================================================================ 清理
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
