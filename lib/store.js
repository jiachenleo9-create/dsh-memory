/**
 * dsh-memory · 四层记忆存储层。
 *
 * 全部使用同步 fs：写入量很小（几 KB），同步比异步更简单也更可靠——
 * 插件的注入路径必须在下一次模型请求之前完成，异步会引入竞态。
 *
 * 层级：
 *   L1 全局长期记忆   <memoryRoot>/MEMORY.md + 分类文件
 *   L2 工作区记忆端口 <workspace>/<workspaceDir>/WORKSPACE.md
 *   L3 任务档案      <workspace>/<workspaceDir>/ACTIVE.md + archive/
 *   L4 会话轨迹      <workspace>/<workspaceDir>/sessions/<id>.md（可丢）
 *
 * @module dsh-memory/store
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 记忆端口文件里各小节的标准标题。
 *
 * ## 职责边界（对应「班级」分工，不能串岗）
 *
 *   - `about` / `rules`  → **课代表（L2）**：本工作区是什么、要守什么规矩。
 *     这两节会随简报注入，是"课代表站在讲台上说的话"。
 *   - `facts` / `pitfalls`（→ 踩坑与教训）→ **课代表（L2）**：
 *     本工作区沉淀下来的稳定事实与教训，跨任务复用。
 *   - `milestones` → **课代表（L2）**：本工作区的**里程碑**（大事记），
 *     例如"完成插件 v0.1.0"。注意这**不是**任务进度——进度是组长（L3）的事。
 *
 * 早期版本这里有一节叫「进行中与已完成的任务」，与 L3 的 ACTIVE.md 职责重叠：
 * 同一个任务的状态会同时写在两个文件里，两边一旦不同步就互相矛盾，
 * 而且归档时不知道该以哪个为准。现在明确：**进度只写 L3**。
 */
/**
 * 数一个文件里真正的条目数（`### ` 标题），**排除代码块里的示例**。
 *
 * 为什么必须排除：分类文件普遍在文末附一段「条目格式」示例，
 * 包在 ```markdown 里。如果直接正则数 `### `，那个示例会被算成一条真实记忆，
 * 于是空文件（frontmatter 写 0）被误报为"声明 0 实际 1、可能绕过工具写入"。
 * 审计的价值在于每条告警都值得行动，这种噪音会直接毁掉可信度。
 *
 * @param text - 文件原文
 * @returns 真实条目数
 */
export function countEntries(text) {
  if (typeof text !== 'string') return 0
  let inFence = false
  let fenceMarker = ''
  let count = 0
  for (const line of text.split(/\r?\n/u)) {
    const fence = /^\s*(`{3,}|~{3,})/u.exec(line)
    if (fence !== null) {
      const marker = fence[1][0]
      if (!inFence) { inFence = true; fenceMarker = marker } else if (marker === fenceMarker) { inFence = false; fenceMarker = '' }
      continue
    }
    if (inFence) continue
    if (/^### /u.test(line)) count++
  }
  return count
}

export const SECTIONS = {
  about: '这个工作区是做什么的',
  rules: '行为规范与约定',
  facts: '关键事实',
  pitfalls: '踩坑与教训',
  milestones: '里程碑（本工作区大事记）',
}

/** 会话开始时注入的「记忆简报」分隔标记；用于去重与识别。 */
export const BRIEF_MARKER = '<!-- dsh-memory:brief -->'
/** 目标锚点注入的分隔标记。 */
export const ANCHOR_MARKER = '<!-- dsh-memory:anchor -->'

/** 字节数安全截断（按 UTF-8 计），超长时补省略号。 */
export function clipBytes(text, maxBytes) {
  if (typeof text !== 'string') return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  // 留出省略号的余量，然后按字符回退，绝不切断多字节字符。
  let cut = text
  while (Buffer.byteLength(cut, 'utf8') > maxBytes - 3 && cut.length > 0) {
    cut = cut.slice(0, Math.max(0, cut.length - Math.max(1, Math.ceil(cut.length * 0.05))))
  }
  return `${cut.replace(/\s+$/u, '')}…`
}

/** 把 Windows/任意路径统一成可比较的形式。 */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return resolve(value).replace(/[\\/]+$/u, '').toLowerCase()
  } catch {
    return undefined
  }
}

/** 读取文本文件，失败返回 undefined（不抛错）。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 原子写入：先写临时文件再 rename，避免半截文件。
 * @param path - 目标绝对路径
 * @param text - 完整内容
 * @returns 是否写入成功
 */
export function writeAtomic(path, text) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(join(path, '..'), { recursive: true })
  } catch {
    /* 目录已存在 */
  }
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
    return true
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
    return false
  }
}

/** 确保目录存在。 */
export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 记忆存储。绑定一个全局记忆库根 + 一个工作区。
 */
export class MemoryStore {
  /**
   * @param options - `{ memoryRoot, workspaceDirName }`
   */
  constructor(options) {
    this.memoryRoot = options.memoryRoot
    this.workspaceDirName = options.workspaceDirName
    /** 工作区路径 → 该工作区端口目录的缓存。 */
    this.portCache = new Map()
  }

  /** L1：全局库入口文件路径。 */
  get globalIndexPath() {
    return join(this.memoryRoot, 'MEMORY.md')
  }

  /** L1：隐私红线文件路径。 */
  get globalPrivacyPath() {
    return join(this.memoryRoot, '00-隐私红线.md')
  }

  /** L1：维护日志路径。 */
  get globalLogPath() {
    return join(this.memoryRoot, '12-记忆维护日志.md')
  }

  /**
   * 解析某个工作区的记忆端口目录（L2/L3 的家）。
   * 会向上寻找已有端口，使子目录会话复用父级工作区端口。
   * @param cwd - 会话工作目录
   * @returns 端口目录绝对路径（不保证已存在）
   */
  portDirFor(cwd) {
    const key = normalizePath(cwd) ?? '(none)'
    const cached = this.portCache.get(key)
    if (cached !== undefined) return cached

    // 向上查找：允许在一个仓库/工程根建端口，子目录自动继承。
    let current = cwd
    let resolvedDir
    for (let depth = 0; depth < 8 && current !== undefined; depth++) {
      const candidate = join(current, this.workspaceDirName)
      if (existsSync(join(candidate, 'WORKSPACE.md'))) {
        resolvedDir = candidate
        break
      }
      const parent = resolve(current, '..')
      if (parent === current) break
      current = parent
    }
    if (resolvedDir === undefined) resolvedDir = join(cwd, this.workspaceDirName)

    this.portCache.set(key, resolvedDir)
    return resolvedDir
  }

  /** L2：工作区端口文件路径。 */
  portPath(cwd) {
    return join(this.portDirFor(cwd), 'WORKSPACE.md')
  }

  /** L3：当前任务档案路径。 */
  activeTaskPath(cwd) {
    return join(this.portDirFor(cwd), 'ACTIVE.md')
  }

  /** L4：会话轨迹目录。 */
  sessionLogDir(cwd) {
    return join(this.portDirFor(cwd), 'sessions')
  }

  /**
   * 确保 L1 记忆库存在；不存在就**引导创建**一套最小可用骨架。
   *
   * ## 为什么需要
   *
   * 用户已有的库是长年积累的结果，但新用户装完插件是"空手"的——
   * 如果 `memoryRoot` 指向一个不存在的目录，整套 L1 会静默失效：
   * 简报里不出 L1 段、`memory_write target:"global"` 报"分类文件不存在"。
   * 新用户会以为是 bug，其实是没建库。
   *
   * 所以这里自建最小骨架：入口索引 + 隐私红线 + 4 个常用分类 + 维护日志。
   * 每个文件都带**填写指引**，让用户知道这里该放什么，而不是丢一个空文件。
   *
   * 已存在的文件**绝不覆盖**（用户内容优先）。
   *
   * @returns `{ created: string[], existed: boolean }`
   */
  ensureMemoryRoot() {
    const created = []
    const existed = existsSync(this.globalIndexPath)
    if (!ensureDir(this.memoryRoot)) return { created, existed }

    const seed = [
      ['MEMORY.md', [
        '# MEMORY · 记忆索引与核心摘要',
        '',
        '> **给 AI 的读取入口**：任何涉及「用户本人」的任务，先读本文件，',
        '> 再按需读取下方对应的分类文件。不要一次读完整个库。',
        `> 最后更新：${today()}　｜　条目总数：0 条`,
        '',
        '---',
        '',
        '## 0. 一句话画像',
        '',
        '> （待补充）一句话说清"这个人是谁、在做什么"。',
        '',
        '---',
        '',
        '## 1. 核心摘要（agent 优先读这 10 条）',
        '',
        '1. （待补充）',
        '',
        '---',
        '',
        '## 2. 分类文件索引',
        '',
        '| # | 文件 | 内容范围 | 条目数 | 最近更新 |',
        '|---|---|---|---|---|',
        `| 00 | [隐私红线](00-隐私红线.md) | 禁止记录清单、脱敏规则 | — | ${today()} |`,
        `| 01 | [身份与基本档案](01-身份与基本档案.md) | 称呼、职业定位、地域 | 0 | ${today()} |`,
        `| 02 | [沟通与协作偏好](02-沟通与协作偏好.md) | 回答风格、输出格式 | 0 | ${today()} |`,
        `| 03 | [技术栈与工具](03-技术栈与工具.md) | 硬件、软件、踩坑结论 | 0 | ${today()} |`,
        `| 04 | [工作与项目](04-工作与项目.md) | 行业、项目、工作目标 | 0 | ${today()} |`,
        `| 12 | [记忆维护日志](12-记忆维护日志.md) | 变更记录 | — | ${today()} |`,
        '',
        '<!-- 需要更多分类时：复制任一分类文件、改编号与名称，',
        '     再在 lib/tools.js 的 GLOBAL_CATEGORIES 里加一行映射即可。 -->',
        '',
        '---',
        '',
        '## 3. 按需读取指南',
        '',
        '| 用户的问题类型 | 建议读取 |',
        '|---|---|',
        '| 任何个性化回答（兜底） | 00 隐私红线 + 02 沟通偏好 |',
        '| 技术问题、工具、选型 | 03 技术栈 |',
        '| 工作、项目、职业方向 | 04 工作与项目 |',
        '',
        '---',
        '',
        '## 4. 待补充清单',
        '',
        '- [ ] 身份与职业定位（01）',
        '- [ ] 沟通与协作偏好（02）',
        '- [ ] 技术栈与环境（03）',
        '- [ ] 工作与项目（04）',
        '',
      ].join('\n')],

      ['00-隐私红线.md', [
        '---',
        '分类: 隐私红线',
        '编号: 00',
        `更新: ${today()}`,
        '---',
        '',
        '# 00 · 隐私红线与脱敏规则',
        '',
        '> **AI 在写入本库之前，必须逐条核对本文件。**',
        '> 命中任意一条「绝不记录」的内容 → **不写入磁盘**，改为泛化表述并告知用户已脱敏。',
        '',
        '`dsh-memory` 插件已把下面的「绝不记录」清单落成**可执行代码**',
        '（`lib/privacy.js`），写入前自动拦截并脱敏——但人工核对仍然是最终防线。',
        '',
        '---',
        '',
        '## 1. 绝不记录（硬性红线）',
        '',
        '| # | 类别 | 具体例子 |',
        '|---|---|---|',
        '| 1 | 证件号码 | 身份证、护照、驾照、社保号、学号、工号、税号 |',
        '| 2 | 联系方式 | 手机号、座机、邮箱、微信号/QQ、各类账号的用户名、密码、验证码 |',
        '| 3 | 财务信息 | 银行卡号、支付账号、账单流水、负债、投资持仓、精确资产数字 |',
        '| 4 | 凭证与密钥 | API Key、Token、密码、证书、私钥、服务器地址、内网 IP、数据库连接串 |',
        '| 5 | 精确位置 | 住址门牌、公司具体地址、车牌号、实时定位 |',
        '| 6 | 医疗健康 | 诊断、病历、用药、手术、体检报告、心理健康史 |',
        '| 7 | 生物特征 | 人脸、指纹、声纹、虹膜、DNA |',
        '| 8 | 身份可组合信息 | 精确出生日期、出生地、母亲姓名等可用于撞库的组合 |',
        '| 9 | 他人隐私 | 家人/朋友/同事的真实姓名、联系方式、住址、病情 |',
        '| 10 | 商业机密 | 未公开的公司计划、客户名单、合同条款、内部文档 |',
        '| 11 | 敏感属性 | 政治立场、宗教信仰、性取向、民族、犯罪记录（默认不记录） |',
        '| 12 | 未成年人信息 | 任何可识别到具体未成年人的信息 |',
        '',
        '### 默认不记录（除非用户单独明确要求）',
        '',
        '| 类别 | 说明 |',
        '|---|---|',
        '| **人际关系 / 家庭 / 朋友 / 社交** | 默认整类不记录；对话中出现也不主动落盘 |',
        '| 感情 / 婚姻状况 | 同上 |',
        '| 个人情绪与心理状态 | 默认不记录 |',
        '',
        '---',
        '',
        '## 2. 可以记录，但必须泛化（降级写法）',
        '',
        '| 原始信息 | 允许的写法 |',
        '|---|---|',
        '| 住在 XX 市 XX 区 XX 路 XX 号 | 「常驻中国华东地区城市」（**地级市粒度可以**） |',
        '| 1998-03-12 出生 | 「20 多岁，25–30 岁区间」 |',
        '| 月收入 18500 元 | 「收入属于中等水平」 |',
        '| 在某公司做后端 | 「在互联网行业做后端开发」 |',
        '| 确诊 XX 病 | 默认不记录；仅当用户要求保留提醒时才写泛化表述 |',
        '',
        '**泛化原则**：保留对回答有用的**决策相关信息**，剥离可用于识别或滥用的**标识信息**。',
        '',
        '---',
        '',
        '## 3. 例外（需用户明确授权）',
        '',
        '- 求职用的**薪资档位**与**目标区间**',
        '- **地级市粒度**的地域信息',
        '- **副业项目与收益**（不含收款账号、流水、税务信息）',
        '',
        '> 例外只在用户明确要求时适用；写入前仍需通过第 1 节的红线检查。',
        '',
      ].join('\n')],

      ['01-身份与基本档案.md', this.categorySkeleton('身份与基本档案', '01', [
        '称呼 / 昵称', '年龄段（不要写精确生日）', '常驻地（地级市粒度）',
        '职业定位与自我认知', '教育背景（专业方向）', '语言与时区',
      ])],

      ['02-沟通与协作偏好.md', this.categorySkeleton('沟通与协作偏好', '02', [
        '回答风格（直接/详细、要不要例子）', '术语解释的深度',
        '输出格式偏好（表格/清单/代码块）', '反感的说辞与表达',
        '协作方式（要不要同步进度、什么时候该问）',
      ])],

      ['03-技术栈与工具.md', this.categorySkeleton('技术栈与工具', '03', [
        '硬件配置（型号 + 关键限制，如显存）', '操作系统与版本',
        '常用软件与工具链', '环境相关的踩坑结论',
      ])],

      ['04-工作与项目.md', this.categorySkeleton('工作与项目', '04', [
        '所在行业与岗位', '主要项目与职责', '工作目标与阶段',
        '正在求职 / 转型时的关注点',
      ])],

      ['12-记忆维护日志.md', [
        '---',
        '分类: 记忆维护日志',
        '编号: 12',
        `更新: ${today()}`,
        '---',
        '',
        '# 12 · 记忆维护日志',
        '',
        '> 每次增删改记忆后，由 `dsh-memory` 自动追加一行。',
        '',
        '## 记录',
        '',
        '| 时间 | 操作 | 文件 | 条目 | 操作者 | 原因 |',
        '|---|---|---|---|---|---|',
        `| ${today()} | 建库 | — | — | dsh-memory | 首次运行自动创建最小骨架 |`,
        '',
        '## 待办',
        '',
        '- [ ] 填写 `MEMORY.md` 的一句话画像与核心摘要',
        '- [ ] 按需补充 01–04 分类文件',
        '',
      ].join('\n')],
    ]

    for (const [name, content] of seed) {
      const path = join(this.memoryRoot, name)
      if (existsSync(path)) continue
      if (writeAtomic(path, content)) created.push(name)
    }

    return { created, existed }
  }

  /**
   * 生成一个分类文件的骨架（frontmatter + 记录范围 + 空条目区 + 填写指引）。
   * @param label - 中文分类名
   * @param number - 两位编号
   * @param hints - 建议记录的要点
   * @returns Markdown 文本
   */
  categorySkeleton(label, number, hints) {
    return [
      '---',
      `分类: ${label}`,
      `编号: ${number}`,
      '敏感等级: 低（禁止写入证件号、联系方式、密钥、精确位置）',
      `更新: ${today()}`,
      '条目数: 0',
      '---',
      '',
      `# ${number} · ${label}`,
      '',
      '**建议记录**：',
      ...hints.map((hint) => `- ${hint}`),
      '',
      '> 条目格式（`dsh-memory` 的 `memory_write` 会自动按这个格式写）：',
      '',
      '```markdown',
      '### 条目标题',
      '- **记忆**：一句话说清的内容',
      '- **来源**：用户口述 / 用户确认 / 对话推断',
      '- **记录时间**：YYYY-MM-DD',
      '- **可信度**：高 / 中 / 低',
      '- **标签**：#标签1 #标签2',
      '```',
      '',
      '---',
      '',
      '## 条目',
      '',
      '<!-- 暂无内容，新增条目由 memory_write 自动追加到这里 -->',
      '',
      '_（空）_',
      '',
    ].join('\n')
  }

  /**
   * 初始化工作区端口：目录 + WORKSPACE.md + ACTIVE.md + archive/。
   * 已经存在则不覆盖（只补缺失的文件）。
   * @param cwd - 会话工作目录
   * @param hint - `{ projectName, sessionId }` 用于首次生成的占位内容
   * @returns `{ dir, created: string[] }`
   */
  ensurePort(cwd, hint = {}) {
    const dir = this.portDirFor(cwd)
    const created = []
    ensureDir(dir)
    ensureDir(join(dir, 'archive'))

    const port = join(dir, 'WORKSPACE.md')
    if (!existsSync(port)) {
      const name = hint.projectName ?? cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'workspace'
      const body = [
        '---',
        `工作区: ${name}`,
        `路径: ${cwd}`,
        `创建: ${today()}`,
        '更新: ' + today(),
        '条目数: 0',
        '---',
        '',
        `# 工作区记忆端口 · ${name}`,
        '',
        '> 这是**本工作区专属**的记忆端口，与全局个人记忆库（L1）相互独立。',
        '> AI 在每次会话开始时会自动读取本文件，不需要用户手动唤起。',
        '> 写入由 `dsh-memory` 插件与 `memory_write` 工具自动完成。',
        '',
        '## 速览（会话开始时注入给 AI 的部分，请保持精炼）',
        '',
        '### 这个工作区是做什么的',
        '- （待补充）首次进入时请让 AI 根据实际任务填写。',
        '',
        '### 行为规范与约定',
        '- （待补充）例如：语言、风格、禁止事项、必须遵守的流程。',
        '',
        '## 详述',
        '',
        `### ${SECTIONS.facts}`,
        '- （待补充）',
        '',
        `### ${SECTIONS.pitfalls}`,
        '- （待补充）',
        '',
        `### ${SECTIONS.tasks}`,
        '- （待补充）',
        '',
      ].join('\n')
      if (writeAtomic(port, body)) created.push(port)
    }

    const active = join(dir, 'ACTIVE.md')
    if (!existsSync(active)) {
      const body = [
        '# 当前任务档案 · ACTIVE',
        '',
        '> 长任务的目标与进度锚点。**每轮会话结束由插件自动更新**，',
        '> 会话开始与上下文压缩后会自动重注入，用于防止「忘记最初设定的目标」。',
        '> 任务完成后请归档到 `archive/`，本文件回到空闲状态。',
        '',
        '## 状态',
        '- 状态：空闲',
        `- 更新：${today()}`,
        '',
        '## 任务目标（原始表述，不要在推进中被改写）',
        '- （当前没有进行中的任务）',
        '',
        '## 验收标准',
        '- （待补充）',
        '',
        '## 进度时间线',
        '- （待补充）',
        '',
        '## 关键约束与决定',
        '- （待补充）',
        '',
      ].join('\n')
      if (writeAtomic(active, body)) created.push(active)
    }

    return { dir, created }
  }

  /** L2：读工作区端口原文。 */
  readPort(cwd) {
    return readText(this.portPath(cwd))
  }

  /** L3：读当前任务档案原文。 */
  readActiveTask(cwd) {
    return readText(this.activeTaskPath(cwd))
  }

  /** L1：读全局入口原文。 */
  readGlobalIndex() {
    return readText(this.globalIndexPath)
  }

  /** L1：列出分类文件（`NN-*.md`）。 */
  listCategories() {
    try {
      return readdirSync(this.memoryRoot)
        .filter((name) => /^\d{2}-.*\.md$/u.test(name))
        .sort()
        .map((name) => {
          const full = join(this.memoryRoot, name)
          let size = 0
          let mtime = ''
          try {
            const info = statSync(full)
            size = info.size
            mtime = info.mtime.toISOString().slice(0, 10)
          } catch {
            /* 读不到就留空 */
          }
          return { name, path: full, bytes: size, updated: mtime }
        })
    } catch {
      return []
    }
  }

  /**
   * L1：从 MEMORY.md 抽取「核心摘要」要点。
   * 只取编号列表的首行，避免把整个文件灌进上下文。
   * @param limit - 最多几条
   * @returns 要点字符串数组
   */
  globalHighlights(limit = 10) {
    const text = this.readGlobalIndex()
    if (text === undefined) return []
    const lines = text.split(/\r?\n/u)
    const points = []
    let inSummary = false
    for (const line of lines) {
      if (/^##\s*1\.\s*核心摘要/u.test(line)) { inSummary = true; continue }
      if (inSummary && /^##\s/u.test(line)) break
      if (!inSummary) continue
      const match = /^\s*\d+\.\s+(.*)$/u.exec(line)
      if (match !== null && match[1].trim() !== '') points.push(match[1].trim())
      if (points.length >= limit) break
    }
    return points
  }

  /**
   * L1：从 MEMORY.md 抽取「按需读取指南」表格行。
   * @param limit - 最多几行
   * @returns `{ topic, files }` 数组
   */
  globalRoutingGuide(limit = 20) {
    const text = this.readGlobalIndex()
    if (text === undefined) return []
    const lines = text.split(/\r?\n/u)
    const rows = []
    let inGuide = false
    for (const line of lines) {
      if (/^##\s*3\.\s*按需读取指南/u.test(line)) { inGuide = true; continue }
      if (inGuide && /^##\s/u.test(line)) break
      if (!inGuide) continue
      const match = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/u.exec(line)
      if (match === null) continue
      const topic = match[1].trim()
      if (topic === '' || topic === '用户的问题类型' || /^-+$/u.test(topic)) continue
      rows.push({ topic, files: match[2].trim() })
      if (rows.length >= limit) break
    }
    return rows
  }

  /** L1：从 MEMORY.md 头部解析 `最后更新 / 条目总数`。 */
  globalStats() {
    const text = this.readGlobalIndex()
    if (text === undefined) return undefined
    const updated = /最后更新[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/u.exec(text)?.[1]
    const total = /条目总数[:：]\s*([0-9]+)/u.exec(text)?.[1]
    return { updated, total: total === undefined ? undefined : Number(total) }
  }

  /**
   * 在文件里定位某个 `##`/`###` 小节的范围。
   * @param text - 全文
   * @param title - 小节标题（不含 # 号）
   * @param level - 标题级别，默认按 `##` 找
   * @returns `{ start, end }`（end 为小节结束的换行下标）
   */
  sectionRange(text, title, level = 2) {
    const hashes = '#'.repeat(level)
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const head = new RegExp(`^${hashes}\\s*${escaped}\\s*$`, 'mu')
    const match = head.exec(text)
    if (match === null) return undefined
    const start = match.index
    const rest = text.slice(start + match[0].length)
    const next = new RegExp(`^#{1,${level}}\\s`, 'mu').exec(rest)
    const end = next === null ? text.length : start + match[0].length + next.index
    return { start, end }
  }

  /**
   * 通用「在小节下追加一条 bullet」。
   * @param text - 原文
   * @param title - 小节标题
   * @param bullet - 要追加的内容（不含 `- `）
   * @param level - 标题级别
   * @returns 新文本
   */
  appendBullet(text, title, bullet, level = 2) {
    const range = this.sectionRange(text, title, level)
    const line = `- ${bullet}`
    if (range === undefined) {
      return `${text.replace(/\s*$/u, '')}\n\n${'#'.repeat(level)} ${title}\n${line}\n`
    }
    let body = text.slice(range.start, range.end).replace(/\s+$/u, '')
    // 占位行清理：`- （待补充）` 首次写入时移除。
    body = body.replace(/^- （待补充）$/gmu, '').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '')
    const updated = `${body}\n${line}\n`
    return text.slice(0, range.start) + updated + text.slice(range.end)
  }

  /**
   * 更新 frontmatter 的某个字段（没有就插到末尾）。
   * @param text - 原文（以 `---` 开头）
   * @param field - 字段名
   * @param value - 字段值
   * @returns 新文本
   */
  setFrontmatter(text, field, value) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
    const line = `${field}: ${value}`
    if (match === null) return `---\n${line}\n---\n\n${text}`
    const body = match[1]
    const fieldRe = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:.*$`, 'mu')
    const nextBody = fieldRe.test(body)
      ? body.replace(fieldRe, line)
      : `${body}\n${line}`
    return text.slice(0, match.index) + `---\n${nextBody}\n---` + text.slice(match.index + match[0].length)
  }

  /** 读 frontmatter 的某个字段。 */
  getFrontmatter(text, field) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text ?? '')
    if (match === null) return undefined
    const fieldRe = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:\\s*(.*)$`, 'mu')
    return fieldRe.exec(match[1])?.[1]?.trim()
  }

  /** 写工作区端口文件。 */
  writePort(cwd, text) {
    this.ensurePort(cwd)
    return writeAtomic(this.portPath(cwd), text)
  }

  /** 写当前任务档案。 */
  writeActiveTask(cwd, text) {
    this.ensurePort(cwd)
    return writeAtomic(this.activeTaskPath(cwd), text)
  }

  /**
   * L4：保存一份会话轨迹。
   * @param cwd - 工作区
   * @param sessionId - 会话 id
   * @param text - 轨迹内容
   */
  writeSessionLog(cwd, sessionId, text) {
    const dir = this.sessionLogDir(cwd)
    ensureDir(dir)
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/gu, '_')
    const ok = writeAtomic(join(dir, `${safe}.md`), text)
    if (ok) this.pruneSessionLogs(cwd)
    return ok
  }

  /** 只保留最近 N 份会话轨迹。 */
  pruneSessionLogs(cwd, keep = 40) {
    const dir = this.sessionLogDir(cwd)
    try {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
          const full = join(dir, name)
          let mtime = 0
          try { mtime = statSync(full).mtimeMs } catch { /* ignore */ }
          return { name, full, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
      for (const file of files.slice(keep)) {
        try { rmSync(file.full, { force: true }) } catch { /* ignore */ }
      }
    } catch {
      /* 目录不存在即无事可做 */
    }
  }

  /**
   * 归档当前任务：ACTIVE.md → archive/<日期>-<slug>.md，并清空 ACTIVE.md。
   *
   * ## 同名冲突必须自动让位
   *
   * 真实事故：文件名是 `${today()}-${slug}`，而 slug 取目标前 40 字。
   * 同一天对同一目标归档两次 → 文件名完全相同 → **第二次静默覆盖第一次**，
   * archive/ 里只剩 1 个文件。这直接破坏"有没有按时归档"的审计依据：
   * 看起来只做过一件事，实际做了两件。
   *
   * 因此写入前先探测同名，依次尝试 `-2`、`-3`…；绝不允许覆盖已有归档。
   *
   * @param cwd - 工作区
   * @param summary - 归档原因/结论
   * @returns 归档文件路径，失败返回 undefined
   */
  archiveActiveTask(cwd, summary = '') {
    const content = this.readActiveTask(cwd)
    if (content === undefined) return undefined
    const goal = /^## 任务目标[^\n]*\n+([^\n#]+)/mu.exec(content)?.[1]?.replace(/^-\s*/u, '').trim() ?? 'task'
    const slug = goal.slice(0, 40).replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/^-+|-+$/gu, '') || 'task'
    const dir = join(this.portDirFor(cwd), 'archive')
    ensureDir(dir)

    // 找一个不冲突的文件名。上限 999 只是防御性封顶，避免极端情况下死循环。
    const base = `${today()}-${slug}`
    let target = join(dir, `${base}.md`)
    for (let index = 2; index < 1000; index++) {
      if (!existsSync(target)) break
      target = join(dir, `${base}-${index}.md`)
    }
    if (existsSync(target)) return undefined

    const body = [
      `<!-- 归档于 ${new Date().toISOString()} -->`,
      summary === '' ? '' : `> 归档说明：${summary}`,
      '',
      content,
    ].join('\n')
    if (!writeAtomic(target, body)) return undefined

    const idle = [
      '# 当前任务档案 · ACTIVE',
      '',
      '> 长任务的目标与进度锚点。**每轮会话结束由插件自动更新**，',
      '> 会话开始与上下文压缩后会自动重注入，用于防止「忘记最初设定的目标」。',
      '> 任务完成后请归档到 `archive/`，本文件回到空闲状态。',
      '',
      '## 状态',
      '- 状态：空闲',
      `- 更新：${today()}`,
      `- 上次归档：${target.split(/[\\/]/u).at(-1)}`,
      '',
      '## 任务目标（原始表述，不要在推进中被改写）',
      '- （当前没有进行中的任务）',
      '',
      '## 验收标准',
      '- （待补充）',
      '',
      '## 进度时间线',
      '- （待补充）',
      '',
      '## 关键约束与决定',
      '- （待补充）',
      '',
    ].join('\n')
    writeAtomic(this.activeTaskPath(cwd), idle)
    return target
  }

  /**
   * L1 写入：把一条长期记忆追加到全局库的分类文件，并同步索引与日志。
   * 真实写入由 `memory_write` 工具编排（需要隐私自检 + 分类选择）。
   *
   * 同时同步 `MEMORY.md` 的索引（条目总数 + 最后更新）。
   * **为什么必须做**：用户的设计里，L1 是"各个工作区共同的大脑"，
   * 而 `MEMORY.md` 是它唯一的入口。如果只递增分类文件的计数而不动索引，
   * 索引会越漂越远（实测漂到 173 vs 186），后进来的 agent 看到的就是错的，
   * 相当于班长记错了人数——正是用户担心的"写错文件"。
   *
   * @param categoryFile - 分类文件名，例如 `03-技术栈与工具.md`
   * @param entry - 完整条目 Markdown
   * @returns `{ ok, path, error }`
   */
  appendGlobalEntry(categoryFile, entry) {
    const path = join(this.memoryRoot, categoryFile)
    const existing = readText(path)
    if (existing === undefined) return { ok: false, path, error: `分类文件不存在：${categoryFile}` }

    /*
     * ⚠️ 必须插入 `## 条目` 小节内部，不能直接追加到文件末尾。
     *
     * 真实事故：早期实现直接拼到文末，而 14/15 个分类文件末尾是 `## 备注`
     * 之类的说明章节——结果新条目全落进说明区，实测 03 文件的 `## 备注`
     * 之下堆了 18 条错位条目。文件没报错、条目也没丢，但结构已经烂了：
     * 按小节阅读的人（和 agent）永远看不到它们。
     */
    const range = this.sectionRange(existing, '条目')
    let next
    if (range === undefined) {
      // 没有 `## 条目` 容器：补一个到文末，而不是继续污染末尾章节。
      next = `${existing.replace(/\s+$/u, '')}\n\n## 条目\n\n${entry.replace(/\s+$/u, '')}\n`
    } else {
      // 插到该小节内容的最后（保留小节后方的说明章节）。
      const body = existing.slice(range.start, range.end).replace(/\s+$/u, '')
      const rest = existing.slice(range.end)
      next = `${existing.slice(0, range.start)}${body}\n\n${entry.replace(/\s+$/u, '')}\n${rest}`
    }

    const countMatch = /条目数[:：]\s*([0-9]+)/u.exec(next)
    if (countMatch !== null) {
      next = next.replace(countMatch[0], `条目数: ${Number(countMatch[1]) + 1}`)
    }
    next = this.setFrontmatter(next, '更新', today())
    if (!writeAtomic(path, next)) return { ok: false, path, error: '写入失败（权限或磁盘）' }
    // 索引跟着一起动，避免长期漂移。
    this.syncIndex()
    return { ok: true, path }
  }

  /**
   * 让 `MEMORY.md` 的索引与实际内容一致。
   *
   * 做两件事：
   *   1. 顶部统计的「条目总数」改为**实际统计值**（不靠累加，避免误差累积）；
   *   2. 「最后更新」改为今天；
   *   3. 第 2 节索引表里每个分类的条目数与日期也刷新。
   *
   * 全量重算而不是增量累加，是因为增量一旦错过一次（例如历史手工编辑、
   * 插件未加载时的写入）就会永久漂移，且没有任何机制能发现。
   *
   * @returns 是否写入成功
   */
  syncIndex() {
    const path = this.globalIndexPath
    const text = readText(path)
    if (text === undefined) return false

    const categories = this.listCategories()
    let total = 0
    const counts = new Map()
    for (const category of categories) {
      const fileText = readText(category.path)
      const counted = fileText === undefined ? 0 : countEntries(fileText)
      // 非条目容器（隐私红线、维护日志等）不计入总数
      const isContainer = !/^(?:00|12)-/u.test(category.name)
      if (isContainer) total += counted
      counts.set(category.name, counted)
    }

    let next = text
    // ---- 顶部统计 ----
    next = next.replace(/条目总数[:：]\s*[0-9]+\s*条/u, `条目总数：${total} 条`)
    next = next.replace(/最后更新[:：]\s*[0-9]{4}-[0-9]{2}-[0-9]{2}/u, `最后更新：${today()}`)

    /*
     * 索引表逐行刷新。
     *
     * 列位置**从表头推断**，不写死下标：真实 MEMORY.md 是 7 列
     * （`| # | 文件 | 内容范围 | 条目数 | 最近更新 |`），
     * 但列数可能随库的演进变化。写死 cells[4] 一旦列数不同，
     * 就会把日期写进条目数列、把计数写进日期列——静默改坏索引表。
     */
    const tableLines = next.split(/\r?\n/u)
    // 找表头行（含「条目数」且以 | 开头）
    let headerCells = null
    for (const line of tableLines) {
      if (!line.startsWith('|')) continue
      const cells = line.split('|')
      if (cells.some((cell) => /条目数/u.test(cell))) { headerCells = cells; break }
    }
    const countCol = headerCells === null ? -1 : headerCells.findIndex((cell) => /条目数/u.test(cell))
    const dateCol = headerCells === null ? -1 : headerCells.findIndex((cell) => /最近更新|更新/u.test(cell))
    const nameCol = headerCells === null ? -1 : headerCells.findIndex((cell) => /文件/u.test(cell))

    next = tableLines.map((line) => {
      if (!line.startsWith('|')) return line
      const cells = line.split('|')
      if (headerCells !== null && cells.length !== headerCells.length) return line
      // 数据行：文件列里应有一个 `NN-xxx.md` 链接
      const probe = nameCol >= 0 && cells[nameCol] !== undefined
        ? cells[nameCol]
        : (cells.find((cell) => /\d{2}-[^)]+\.md/u.test(cell)) ?? '')
      const match = /\((\d{2}-[^)]+\.md)\)/u.exec(probe)
      if (match === null) return line
      const counted = counts.get(match[1])
      if (counted === undefined) return line

      const isContainer = !/^(?:00|12)-/u.test(match[1])
      // 非条目容器（隐私红线、维护日志）标 `—`：写 0 会让人以为"这个分类是空的"。
      if (countCol > 0) cells[countCol] = isContainer ? ` ${counted} ` : ' — '
      // 非容器文件不因一次写入就被打上今天的日期。
      if (dateCol > 0 && isContainer) cells[dateCol] = ` ${today()} `
      return cells.join('|')
    }).join('\n')

    return writeAtomic(path, next)
  }

  /**
   * 写权限演练：在端口目录里写一个探针文件、读回、删除。
   * 不触碰任何真实记忆文件。
   * @param cwd - 工作区
   * @returns `{ ok, detail }`
   */
  writePortProbe(cwd) {
    const dir = this.portDirFor(cwd)
    if (!ensureDir(dir)) return { ok: false, detail: `无法创建目录：${dir}` }
    const probe = join(dir, '.write-probe')
    const token = String(Date.now())
    try {
      writeFileSync(probe, token, 'utf8')
      const readBack = readText(probe)
      rmSync(probe, { force: true })
      if (readBack !== token) return { ok: false, detail: '写入后读回内容不一致' }
      return { ok: true, detail: dir }
    } catch (error) {
      try { rmSync(probe, { force: true }) } catch { /* 忽略清理失败 */ }
      return { ok: false, detail: String(error?.message ?? error) }
    }
  }

  /**
   * L1：在维护日志追加一行。
   * @param cells - 完整的日志行（不含开头 `| `）
   * @returns 是否成功
   */
  appendMaintenanceLog(cells) {
    const text = readText(this.globalLogPath)
    if (text === undefined) return false
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const next = `${text.replace(/\s+$/u, '')}\n| ${stamp} | ${cells} |\n`
    return writeAtomic(this.globalLogPath, next)
  }

  /**
   * 读取任意记忆文件的原始内容（供 `memory_read` 工具与注入使用）。
   * 只允许访问记忆库内部，防止越权读文件。
   * @param target - `global` / `port` / `task` / 分类文件名
   * @param cwd - 工作区
   * @returns `{ text, path }` 或 undefined
   */
  read(target, cwd) {
    if (target === 'global') {
      const text = this.readGlobalIndex()
      return text === undefined ? undefined : { text, path: this.globalIndexPath }
    }
    if (target === 'port') {
      const text = this.readPort(cwd)
      return text === undefined ? undefined : { text, path: this.portPath(cwd) }
    }
    if (target === 'task') {
      const text = this.readActiveTask(cwd)
      return text === undefined ? undefined : { text, path: this.activeTaskPath(cwd) }
    }
    // 分类文件：只接受 `NN-name.md` 形状，杜绝路径穿越。
    if (!/^\d{2}-[^\\/]+\.md$/u.test(target)) return undefined
    const path = join(this.memoryRoot, target)
    const text = readText(path)
    return text === undefined ? undefined : { text, path }
  }

  /**
   * 在记忆库里做关键词检索（跨全局分类文件 + 工作区端口 + 任务档案）。
   * 用极简的逐行打分，避免为记忆引入向量库依赖。
   * @param query - 关键词（空格分隔，全部命中优先）
   * @param cwd - 工作区
   * @param limit - 最多返回多少条
   * @returns 命中数组
   */
  search(query, cwd, limit = 20) {
    const terms = String(query ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
    if (terms.length === 0) return []
    const sources = []
    for (const category of this.listCategories()) sources.push({ label: category.name, path: category.path })
    const port = this.readPort(cwd)
    if (port !== undefined) sources.push({ label: 'WORKSPACE.md（工作区端口）', path: this.portPath(cwd), text: port })
    const active = this.readActiveTask(cwd)
    if (active !== undefined) sources.push({ label: 'ACTIVE.md（任务档案）', path: this.activeTaskPath(cwd), text: active })

    const results = []
    for (const source of sources) {
      const text = source.text ?? readText(source.path)
      if (text === undefined) continue
      const lines = text.split(/\r?\n/u)
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (line.trim() === '') continue
        const lower = line.toLowerCase()
        let score = 0
        for (const term of terms) if (lower.includes(term)) score += 1
        if (score === 0) continue
        results.push({
          file: source.label,
          line: index + 1,
          score: score === terms.length ? score + 100 : score,
          text: line.trim().slice(0, 300),
        })
      }
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}

/** 今天的 ISO 日期。 */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/** 现在的时间戳（本地可读）。 */
export function nowStamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}
