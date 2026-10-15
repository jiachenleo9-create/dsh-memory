/**
 * 排查工具：正确解出 DSH 会话日志的**全部** zstd 帧，并审计消息来源。
 *
 * 背景：`session.v4.jsonl.zstd` 是**多帧拼接**（每次 checkpoint 追加一帧）。
 * Node 的 `zstdDecompressSync` 与 `createZstdDecompress` 都只解第一帧，
 * 所以必须自己按 zstd 魔数（28 B5 2F FD）切帧再逐帧解压。
 *
 * 用途：找出携带已退役 `{kind:'plugin'}` 来源的消息。
 *
 * 用法： node tests/inspect-log-format.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = 'D:\\DSH\\.dsh\\sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 按 zstd 魔数把 buffer 切成多帧，逐帧解压后拼接。 */
function decompressAllFrames(buffer) {
  const offsets = []
  let index = buffer.indexOf(MAGIC, 0)
  while (index >= 0) {
    offsets.push(index)
    index = buffer.indexOf(MAGIC, index + 4)
  }
  if (offsets.length === 0) throw new Error('没有找到 zstd 帧头')

  const parts = []
  let decoded = 0
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
      decoded++
    } catch {
      // 这个"魔数"可能是压缩数据里的巧合字节，跳过即可
    }
  }
  return { text: parts.join(''), frames: offsets.length, decoded }
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const MESSAGE_SLOTS = new Set([
  'user/message', 'developer/message', 'system/message',
  'assistant/message', 'tool/result', 'agent/inbox/spliced', 'session/title-llm-request',
])

function messagesOf(event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return []
  if (event.type === 'user/message') return [data]
  if (['developer/message', 'system/message', 'assistant/message', 'tool/result'].includes(event.type)) {
    return data.message !== null && typeof data.message === 'object' ? [data.message] : []
  }
  if (event.type === 'agent/inbox/spliced') return Array.isArray(data.inserted) ? data.inserted : []
  if (event.type === 'session/title-llm-request') return Array.isArray(data.messages) ? data.messages : []
  return []
}

const files = walk(SESSIONS)
  .filter((file) => file.endsWith('.zstd'))
  .map((file) => ({ file, mtime: statSync(file).mtime, size: statSync(file).size }))
  .sort((a, b) => b.mtime - a.mtime)

console.log(`共 ${files.length} 个会话日志\n`)

const kindCounts = new Map()
const shapeCounts = new Map()
const retired = []
const errorHits = []
let scanned = 0
let messageSlots = 0
let totalFrames = 0

for (const row of files) {
  let result
  try {
    result = decompressAllFrames(readFileSync(row.file))
  } catch (error) {
    console.log(`  ⚠️ 解压失败 ${row.file.replace(SESSIONS, '')}：${error.message}`)
    continue
  }
  scanned++
  totalFrames += result.decoded

  // 该文件是否含报错字符串（在解压后的明文里找）
  const errorCount = result.text.split('producer-owned source kind').length - 1
  if (errorCount > 0) errorHits.push({ file: row.file, mtime: row.mtime, count: errorCount })

  for (const line of result.text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (!MESSAGE_SLOTS.has(event.type)) continue
    for (const message of messagesOf(event)) {
      messageSlots++
      const source = message.source
      const kind = source !== null && typeof source === 'object' && typeof source.kind === 'string'
        ? source.kind
        : '(无 source / 无 kind)'
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
      if (source !== null && typeof source === 'object') {
        const shape = `${kind} {${Object.keys(source).sort().join(',')}}`
        shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1)
      }
      if (source !== null && typeof source === 'object' && source.kind === 'plugin') {
        retired.push({
          file: row.file.replace(SESSIONS, ''),
          mtime: row.mtime,
          type: event.type,
          plugin: typeof source.plugin === 'string' ? source.plugin : '(缺 plugin 字段)',
          seq: event.seq,
        })
      }
    }
  }
}

console.log(`解析成功 ${scanned} 个文件 / 共 ${totalFrames} 帧 / ${messageSlots} 个消息槽位\n`)

console.log('='.repeat(96))
console.log('source.kind 分布')
console.log('='.repeat(96))
if (kindCounts.size === 0) console.log('  （没有解出任何消息槽位）')
for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const flag = kind === 'plugin' ? '   ⛔ 已退役（会触发该报错）' : ''
  console.log(`  ${String(count).padStart(7)}  ${kind}${flag}`)
}

console.log(`\n${'='.repeat(96)}`)
console.log('source 字段形状（前 25）')
console.log('='.repeat(96))
for (const [shape, count] of [...shapeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  const flag = shape.startsWith('plugin ') ? '   ⛔' : ''
  console.log(`  ${String(count).padStart(7)}  ${shape}${flag}`)
}

console.log(`\n${'='.repeat(96)}`)
console.log('日志里含报错字符串「producer-owned source kind」的文件')
console.log('='.repeat(96))
if (errorHits.length === 0) console.log('  （无 —— 报错本身没有被写进会话日志）')
for (const row of errorHits) {
  console.log(`  ${row.mtime.toISOString().replace('T', ' ').slice(0, 19)}  ×${row.count}  ${row.file.replace(SESSIONS, '')}`)
}

if (retired.length > 0) {
  console.log(`\n${'='.repeat(96)}`)
  console.log(`⛔ 发现 ${retired.length} 处已退役的 kind:'plugin'`)
  console.log('='.repeat(96))
  const byPlugin = new Map()
  for (const row of retired) byPlugin.set(row.plugin, (byPlugin.get(row.plugin) ?? 0) + 1)
  console.log('按插件名汇总：')
  for (const [pluginName, count] of [...byPlugin.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(7)}  ${pluginName}`)
  }
  console.log('\n前 20 处明细：')
  for (const row of retired.slice(0, 20)) {
    console.log(`  ${row.mtime.toISOString().replace('T', ' ').slice(0, 19)}  seq=${String(row.seq).padStart(6)}  ${row.type.padEnd(22)} plugin=${row.plugin}`)
    console.log(`        ${row.file}`)
  }
}
