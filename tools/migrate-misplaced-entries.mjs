/**
 * 一次性修复：把落在 `## 条目` 之外的历史条目搬回正确位置。
 *
 * ## 背景
 *
 * 早期 `appendGlobalEntry` 直接追加到文件末尾，不看 `## 条目` 小节的位置。
 * 真实库里有 14/15 个分类文件末尾是 `## 备注` 之类的说明章节，
 * 于是历史写入的条目全落进了说明区（实测 03 文件堆了 18 条）。
 *
 * 文件没丢、条目没丢，但**结构错了**：按小节阅读的人（和 agent）
 * 永远看不到那些条目，而且它们混在说明文字里。
 *
 * ## 做法
 *
 * 把「最后一个非条目小节」之后的所有 `### ` 板块整体搬到 `## 条目` 末尾。
 * 纯文本重排，不改动任何条目内容，且**先备份再动手**。
 *
 * 用法：
 *   node tools/migrate-misplaced-entries.mjs --dry-run   只看会改什么
 *   node tools/migrate-misplaced-entries.mjs             真正执行（自动备份）
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 要修复的记忆库根目录。**必须显式指定**，不设默认值——
 * 这是个会改写文件的脚本，宁可让调用者多打几个字，
 * 也不要因为默认值猜错而改到别的目录。
 */
const MEMORY_ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : undefined
const DRY_RUN = process.argv.includes('--dry-run')

if (MEMORY_ROOT === undefined || MEMORY_ROOT.trim() === '') {
  console.error('用法： node tools/migrate-misplaced-entries.mjs --root "<记忆库路径>" [--dry-run]')
  console.error('')
  console.error('作用：把落在 `## 条目` 小节之外的历史条目搬回正确位置。')
  console.error('      这是给早期版本（会追加到文件末尾）的用户做一次性修复用的。')
  console.error('      **执行前会自动备份为 .bak-migrate**。')
  process.exit(1)
}

/** 不是条目容器的文件，跳过。 */
const SKIP = new Set(['00-隐私红线.md', '12-记忆维护日志.md'])

/**
 * 把文件切成「按 `##` 小节」的块。
 * @param text - 原文
 * @returns `{ preamble, sections: [{ title, lines }] }`
 */
function splitSections(text) {
  const lines = text.split(/\r?\n/u)
  const sections = []
  let preamble = []
  let current = null

  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      if (current !== null) sections.push(current)
      current = { title: line, lines: [] }
    } else if (current === null) {
      preamble.push(line)
    } else {
      current.lines.push(line)
    }
  }
  if (current !== null) sections.push(current)
  return { preamble, sections }
}

/**
 * 从一段行里抽出 `### ` 板块（含其下内容）。
 *
 * ⚠️ **必须跳过代码围栏内部**：分类文件普遍在文末附「条目格式」示例，
 * 包在 ```markdown 里。若不排除，示例会被当成一条真实条目搬走，
 * 破坏文档。这是本脚本最容易出错的地方。
 *
 * @param lines - 行数组
 * @returns `{ entries: string[], rest: string[] }`
 */
function extractEntryBlocks(lines) {
  const entries = []
  const rest = []
  let buffer = null
  let inFence = false
  let fenceMarker = ''

  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/u.exec(line)
    if (fence !== null) {
      const marker = fence[1][0]
      if (!inFence) { inFence = true; fenceMarker = marker } else if (marker === fenceMarker) { inFence = false; fenceMarker = '' }
      // 围栏行本身永远属于 rest（或当前条目的内容），不触发新条目
      if (buffer !== null) buffer.push(line)
      else rest.push(line)
      continue
    }

    if (!inFence && /^###\s+/u.test(line)) {
      if (buffer !== null) entries.push(buffer.join('\n').replace(/\s+$/u, ''))
      buffer = [line]
    } else if (buffer !== null) {
      buffer.push(line)
    } else {
      rest.push(line)
    }
  }
  if (buffer !== null) entries.push(buffer.join('\n').replace(/\s+$/u, ''))
  return { entries, rest }
}

const files = readdirSync(MEMORY_ROOT).filter((name) => /^\d{2}-.*\.md$/u.test(name)).sort()
let fixedCount = 0

console.log(`记忆库：${MEMORY_ROOT}`)
console.log(DRY_RUN ? '模式：DRY RUN（不落盘）\n' : '模式：执行（自动备份为 .bak-migrate）\n')

for (const name of files) {
  if (SKIP.has(name)) continue
  const path = join(MEMORY_ROOT, name)
  const text = readFileSync(path, 'utf8')
  const { preamble, sections } = splitSections(text)

  const entryIndex = sections.findIndex((s) => /^##\s*条目\s*$/u.test(s.title))
  if (entryIndex < 0) continue

  // 收集「条目小节之后」的其它小节里错放的条目
  const misplaced = []
  for (let index = entryIndex + 1; index < sections.length; index++) {
    const section = sections[index]
    const { entries, rest } = extractEntryBlocks(section.lines)
    if (entries.length > 0) {
      misplaced.push({ index, count: entries.length, title: section.title.trim(), entries, rest })
    }
  }
  if (misplaced.length === 0) continue

  const total = misplaced.reduce((sum, item) => sum + item.count, 0)
  console.log(`● ${name}：发现 ${total} 条错位条目`)
  for (const item of misplaced) {
    console.log(`    小节 ${item.title} 下 ${item.count} 条`)
  }

  if (DRY_RUN) { fixedCount++; continue }

  // ---- 重排 ----
  const entrySection = sections[entryIndex]
  const { entries: ownEntries, rest: ownRest } = extractEntryBlocks(entrySection.lines)

  // 条目小节：保留自己的条目 + 追加错位的
  const allEntries = [...ownEntries]
  for (const item of misplaced) allEntries.push(...item.entries)

  const rebuiltEntry = {
    title: entrySection.title,
    lines: [
      ...ownRest.filter((l) => l.trim() !== '' || true),
      ...allEntries.flatMap((block) => ['', ...block.split('\n')]),
      '',
    ],
  }

  // 其它小节：去掉被搬走的条目，保留说明文字
  const nextSections = sections.map((section, index) => {
    if (index === entryIndex) return rebuiltEntry
    const found = misplaced.find((item) => item.index === index)
    if (found === undefined) return section
    return { title: section.title, lines: found.rest }
  })

  const rebuilt = [
    ...preamble,
    ...nextSections.flatMap((section) => [section.title, ...section.lines]),
  ].join('\n').replace(/\n{4,}/gu, '\n\n\n').replace(/\s+$/u, '') + '\n'

  copyFileSync(path, `${path}.bak-migrate`)
  writeFileSync(path, rebuilt, 'utf8')
  console.log(`    ✅ 已修复（备份 ${name}.bak-migrate）`)
  fixedCount++
}

console.log(`\n${DRY_RUN ? '将修复' : '已修复'} ${fixedCount} 个文件。`)
if (DRY_RUN && fixedCount > 0) console.log('去掉 --dry-run 即可执行。')
