/**
 * dsh-memory · 隐私红线自检。
 *
 * 把 `00-隐私红线.md` 的「绝不记录」清单落成可执行代码，在**写入落盘前**拦截。
 * 两道闸门：
 *   1. 硬红线（PATTERNS）——高精度正则，命中即拒绝写入；
 *   2. 软红线（SOFT_RULES）——语境关键词，命中即提示，默认整类不记录。
 *
 * 设计原则：宁可误拦，不可误放。用户明确要求记录时可用 `force` 绕过软红线，
 * 但硬红线永远不可绕过。
 *
 * @module dsh-memory/privacy
 */

/**
 * 硬红线：高精度、可判定的敏感串。命中即必须拒绝或脱敏。
 * `context` 非空时，只有就近出现该语境词才算命中（避免误伤普通日期）。
 */
const PATTERNS = [
  {
    id: 'cn-id-card',
    category: '证件号码',
    note: '中国大陆身份证号',
    // 18 位：6 位地区 + 8 位生日 + 3 位顺序 + 1 位校验
    re: /(?<![0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g,
  },
  {
    id: 'phone-cn',
    category: '联系方式',
    note: '中国大陆手机号',
    re: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
  },
  {
    id: 'email',
    category: '联系方式',
    note: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    id: 'bank-card',
    category: '财务信息',
    note: '疑似银行卡号（16–19 位连续数字）',
    re: /(?<![0-9])[0-9]{16,19}(?![0-9])/g,
  },
  {
    id: 'api-key',
    category: '凭证与密钥',
    note: 'API Key / 访问令牌',
    /*
     * 为什么写得这么啰嗦：早期版本用 `(?:sk|pk|rk|...)[-_A-Za-z0-9]{12,}`，
     * 结果把普通英文词**误报**成密钥——最典型的是 `skipGlobalCheck`：
     * "sk" + "ipGlobalCheck"（13 个字母）刚好满足 `{12,}`。
     * 误报会导致正常技术内容被静默替换成【已脱敏·凭据】，属于真的丢信息。
     *
     * 两道收紧：
     *   1. 短前缀（sk/pk/rk 等）后面**必须**紧跟分隔符 `-` 或 `_`
     *      —— 真实密钥都是 `sk-xxx` / `sk_live_xxx` / `ghp_xxx` 这种形式，
     *      而英文单词不会在词中间插分隔符；
     *   2. 主体必须**含至少一个数字**（用前瞻断言），
     *      真实密钥是高频随机串，几乎必然带数字。
     */
    re: /(?<![A-Za-z0-9])(?:(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xoxb|xoxp|xapp)[-_](?=[A-Za-z0-9._-]{11,})(?=[A-Za-z0-9._-]*[0-9])[A-Za-z0-9._-]{12,}|AKIA(?=[0-9A-Z]{16})(?=[0-9A-Z]*[0-9])[0-9A-Z]{16}|LTAI(?=[A-Za-z0-9]{12,})(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{12,}|AIza(?=[A-Za-z0-9_-]{30,})(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{30,})(?![A-Za-z0-9])/g,
  },
  {
    id: 'bearer',
    category: '凭证与密钥',
    note: 'Bearer 令牌',
    re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    id: 'private-key',
    category: '凭证与密钥',
    note: '私钥内容块',
    re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/g,
  },
  {
    id: 'secret-assign',
    category: '凭证与密钥',
    note: '密钥/密码赋值语句',
    re: /(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|passwd|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    id: 'private-ip',
    category: '凭证与密钥',
    note: '内网 IP 地址',
    re: /(?<![0-9.])(?:10\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3})\.[0-9]{1,3}(?![0-9])/g,
  },
  {
    id: 'door-number',
    category: '精确位置',
    note: '门牌 / 楼栋 / 单元号',
    re: /[0-9]{1,4}\s*(?:号楼|号院|号房|栋|幢|单元|室|门牌|弄)/g,
  },
  {
    id: 'precise-birth',
    category: '身份可组合信息',
    note: '精确出生日期',
    re: /(?:19|20)[0-9]{2}\s*[年./-]\s*(?:0?[1-9]|1[0-2])\s*[月./-]\s*(?:0?[1-9]|[12][0-9]|3[01])\s*日?/g,
    // 只在「出生」语境附近才算红线，否则普通日期（如记录时间）会被误伤。
    context: ['出生', '生日', '生于', '生辰', '阳历', '农历'],
    contextWindow: 24,
  },
  {
    id: 'long-account-id',
    category: '证件号码',
    note: '疑似账号/证件编号',
    re: /(?:学号|工号|税号|社保号|驾照号|护照号|银行卡号)\s*[:：]?\s*[A-Za-z0-9]{6,}/g,
  },
]

/**
 * 软红线：语境类。命中即「默认整类不记录」，除非用户单独明确要求。
 */
const SOFT_RULES = [
  {
    id: 'relationship',
    category: '人际关系 / 家庭 / 朋友 / 社交',
    note: '本库默认整类不记录（除非用户单独明确要求）',
    words: [
      '女朋友', '男朋友', '老婆', '老公', '妻子', '丈夫', '儿子', '女儿',
      '爸爸', '妈妈', '父亲', '母亲', '父母', '家人', '亲戚', '岳父', '岳母',
      '公公', '婆婆', '同事', '上司', '老板', '室友', '同学', '朋友', '闺蜜',
      '恋爱', '结婚', '离婚', '分手', '相亲',
    ],
  },
  {
    id: 'health',
    category: '医疗健康',
    note: '诊断、病历、用药、手术等属健康红线',
    words: [
      '确诊', '病历', '诊断', '处方', '用药', '吃药', '手术', '住院', '体检报告',
      '抑郁症', '焦虑症', '失眠症', '癌', '化疗', '放疗', '血糖', '血压', '过敏史',
    ],
  },
  {
    id: 'biometric',
    category: '生物特征',
    note: '人脸 / 指纹 / 声纹 / 虹膜 / DNA 属红线',
    words: ['指纹', '声纹', '虹膜', 'DNA', '人脸数据', '基因检测'],
  },
  {
    id: 'third-party',
    category: '他人隐私',
    note: '他人真实姓名、联系方式、住址、病情不可记录',
    words: ['我朋友', '我同事', '我家人', '我亲戚', '我室友', '我同学'],
  },
  {
    id: 'sensitive-attribute',
    category: '敏感属性',
    note: '政治立场、宗教信仰、性取向、民族、犯罪记录默认不记录',
    words: ['政治立场', '宗教信仰', '信佛', '信教', '基督教', '伊斯兰', '党籍', '性取向', '同性恋', '犯罪记录', '案底'],
  },
]

/** 脱敏后的替代写法。 */
const MASK = {
  '证件号码': '【已脱敏·证件号】',
  '联系方式': '【已脱敏·联系方式】',
  '财务信息': '【已脱敏·财务数字】',
  '凭证与密钥': '【已脱敏·凭据】',
  '精确位置': '【已脱敏·精确位置】',
  '身份可组合信息': '【已脱敏·可识别信息】',
}

/**
 * 判断某个匹配位置附近是否出现指定语境词。
 * @param text - 全文
 * @param index - 匹配起始下标
 * @param window - 语境窗口（字符）
 * @param words - 语境词
 * @returns 是否处于该语境
 */
function inContext(text, index, window, words) {
  const from = Math.max(0, index - window)
  const to = Math.min(text.length, index + window)
  const nearby = text.slice(from, to)
  return words.some((word) => nearby.includes(word))
}

/**
 * 对一段准备落盘的文本做隐私自检。
 * @param text - 待写入内容。
 * @param options - `{ allowSoft }`：用户明确要求记录时把软红线降级为提示。
 * @returns `{ ok, blocked, warnings, hits, sanitized }`
 *   - `ok`：是否可以直接原样写入；
 *   - `blocked`：是否命中硬红线（硬红线不可绕过）；
 *   - `sanitized`：脱敏后的文本（可直接使用）；
 *   - `hits` / `warnings`：命中明细，用于回报用户。
 */
export function inspect(text, options = {}) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const allowSoft = options.allowSoft === true
  const hits = []

  for (const rule of PATTERNS) {
    rule.re.lastIndex = 0
    let match
    while ((match = rule.re.exec(raw)) !== null) {
      if (Array.isArray(rule.context) && rule.context.length > 0) {
        if (!inContext(raw, match.index, rule.contextWindow ?? 24, rule.context)) continue
      }
      hits.push({
        kind: 'hard',
        id: rule.id,
        category: rule.category,
        note: rule.note,
        matched: match[0],
        index: match.index,
      })
      if (match[0].length === 0) rule.re.lastIndex += 1
    }
  }

  const warnings = []
  for (const rule of SOFT_RULES) {
    const found = rule.words.filter((word) => raw.includes(word))
    if (found.length === 0) continue
    warnings.push({
      kind: 'soft',
      id: rule.id,
      category: rule.category,
      note: rule.note,
      matched: found,
    })
  }

  // 脱敏：按 category 把硬红线命中替换成占位符。
  let sanitized = raw
  const byCategory = new Map()
  for (const hit of hits) {
    if (!byCategory.has(hit.category)) byCategory.set(hit.category, new Set())
    byCategory.get(hit.category).add(hit.matched)
  }
  for (const [category, values] of byCategory) {
    const replacement = MASK[category] ?? '【已脱敏】'
    for (const value of values) {
      sanitized = sanitized.split(value).join(replacement)
    }
  }

  return {
    ok: hits.length === 0 && (allowSoft || warnings.length === 0),
    blocked: hits.length > 0,
    warnings,
    hits,
    sanitized,
    /** 被替换掉的具体片段（截断展示），用于让误报可见、可纠正。 */
    masked: hits.map((hit) => ({
      rule: hit.id,
      category: hit.category,
      sample: hit.matched.length > 24 ? `${hit.matched.slice(0, 12)}…${hit.matched.slice(-6)}` : hit.matched,
      length: hit.matched.length,
    })),
  }
}

/**
 * 生成给模型/用户看的一行式自检结论。
 * @param report - `inspect()` 的返回值。
 * @returns 中文说明，可直接放进工具返回值。
 */
export function describe(report) {
  const lines = []
  if (report.hits.length > 0) {
    const groups = new Map()
    for (const hit of report.hits) {
      if (!groups.has(hit.category)) groups.set(hit.category, [])
      groups.get(hit.category).push(hit.note)
    }
    lines.push('🚫 命中硬红线（不可记录，已脱敏）：')
    for (const [category, notes] of groups) {
      lines.push(`   - ${category}：${[...new Set(notes)].join('、')}`)
    }
    /*
     * 关键：必须告诉调用方**具体替换了什么**。
     * 早期版本只报类别，于是一次误报（把 skipGlobalCheck 当成 sk- 开头的密钥）
     * 会静默把正常技术内容改成【已脱敏·凭据】，用户和模型都无从察觉，
     * 结果是"记忆里丢了一段话"却没人知道。展示样本后，误报可被立刻发现并纠正。
     */
    const masked = report.masked ?? []
    if (masked.length > 0) {
      lines.push('   被替换的片段（若属于误报，请改写措辞后重试）：')
      for (const item of masked.slice(0, 8)) {
        lines.push(`     · \`${item.sample}\`（${item.rule}，${item.length} 字符）`)
      }
      if (masked.length > 8) lines.push(`     · …另有 ${masked.length - 8} 处`)
    }
  }
  if (report.warnings.length > 0) {
    lines.push('⚠️ 命中默认不记录类别（除非用户单独明确要求）：')
    for (const warning of report.warnings) {
      lines.push(`   - ${warning.category}：出现「${warning.matched.slice(0, 6).join('、')}」`)
    }
  }
  if (lines.length === 0) lines.push('✅ 隐私自检通过，无红线命中。')
  return lines.join('\n')
}

/** 导出规则表，供文档与自检路由使用。 */
export const RULE_TABLE = {
  hard: PATTERNS.map(({ id, category, note }) => ({ id, category, note })),
  soft: SOFT_RULES.map(({ id, category, note }) => ({ id, category, note })),
}
