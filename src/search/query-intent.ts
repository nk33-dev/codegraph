/**
 * 查询意图识别（个人版精确检索契约）。
 *
 * 背景：`codegraph_explore` 同时接受符号名和自然语言。当查询里出现唯一的精确符号
 * （例如 `runUpgrade`）时，“定义、所有调用方和相关测试”这类词只说明**要什么**，
 * 不是额外的检索目标。此前把它们当作普通查询词继续走 FTS，camelCase 标识符会被切词，
 * `runUpgrade` 的片段 `run` 于是命中其他文件里同名的 `run()`，答案里混入噪声。
 *
 * 本模块是那层“意图词汇”的唯一来源：调用方先用 {@link stripQueryIntentWords} 把意图
 * 词与填充词剥离，再看剩下的是否还有别的检索目标。意图词永不参与模糊匹配。
 *
 * 边界（保持保守，避免过度收束）：
 *   - 只剥离列出的意图词、连接词与疑问/祈使填充词，**不**剥离主题名词
 *     （缓存、索引、部署…），因此“X 与缓存的关系”仍有第二个主题词。
 *   - 中文没有词边界，按最长优先做整词替换；副作用只影响“剩余文本是否为空”的判断，
 *     不改变实际匹配文本（匹配文本在收束成功时就是那个符号名本身）。
 */

/** 表达“我要什么”的意图词（英文 + 中文），长词必须排在同前缀短词之前。 */
const INTENT_WORDS: readonly string[] = [
  // --- 意图：结构关系 ---
  'definition', 'definitions', 'declaration', 'declarations', 'defined', 'declared',
  'caller', 'callers', 'callee', 'callees', 'calledby', 'call', 'calls', 'calling',
  'usage', 'usages', 'used', 'uses', 'use', 'using',
  'reference', 'references', 'referenced', 'mentioned',
  'implementation', 'implementations', 'implementer', 'implementers', 'implemented', 'implements',
  'override', 'overrides', 'overridee',
  'related', 'relevant', 'associated', 'impact', 'impacts', 'affected', 'affects',
  'test', 'tests', 'testing', 'tested', 'spec', 'specs', 'specification',
  'source', 'sources', 'symbol', 'symbols', 'method', 'methods', 'function', 'functions',
  'location', 'locations', 'located', 'where', 'file', 'files', 'code',
  'purpose', 'usage-doc', 'example', 'examples', 'explain', 'explanation', 'description', 'describe',
  'signature', 'body', 'behavior', 'behaviour', 'flow', 'dependency', 'dependencies',
  // --- 连接/数量/疑问/祈使（填充词） ---
  'all', 'every', 'each', 'any', 'both', 'and', 'or', 'its', 'their', 'the', 'this', 'that',
  'these', 'those', 'of', 'for', 'to', 'from', 'in', 'on', 'with', 'by', 'is', 'are', 'was',
  'were', 'does', 'do', 'did', 'please', 'show', 'list', 'give', 'find', 'search', 'which',
  'what', 'who', 'whom', 'why', 'how', 'a', 'an',
  // --- 中文：意图 ---
  '被谁调用', '谁调用了', '谁调用', '被调用', '调用关系', '调用链', '调用方', '调用者', '调用',
  '定义位置', '定义处', '定义', '声明', '实现者', '实现', '引用', '使用', '用例', '单元测试',
  '相关测试', '相关调用', '相关文件', '相关', '有关', '源码', '代码', '文件', '位置', '所在',
  '内容', '作用', '用途', '用法', '功能', '行为', '说明', '解释', '介绍', '示例', '例子', '举例',
  '关系', '影响', '范围', '测试', '上游', '下游', '依赖',
  // --- 中文：连接/数量/疑问/祈使（填充词） ---
  '所有', '全部', '每个', '各个', '各自', '分别', '以及', '还有', '并且', '而且', '或者',
  '之间', '哪些', '哪个', '哪里', '在哪', '什么', '怎么', '如何', '为什么', '是否', '能否',
  '可以', '需要', '这个', '那个', '这些', '那些', '一个', '一些', '我们', '他们', '它们',
  '帮我', '给我', '我想', '我要', '看看', '列出', '显示', '展示', '找出', '找到', '查找',
  '查询', '搜索', '请', '帮', '和', '与', '跟', '及', '或', '的', '得', '地', '是', '在',
  '有', '为', '了', '被', '把', '给', '对', '就', '都', '也', '还', '再', '又', '它', '其',
  '此', '该', '这', '那', '我', '你', '他', '她', '们', '会', '能', '要', '想', '去', '来',
  '看', '说', '做', '用', '中', '上', '下', '里', '后', '前', '时',
];

/** 纯 ASCII 词用词边界匹配；含中文的短语直接整串匹配（中文没有词边界）。 */
function buildIntentPattern(): RegExp {
  const ascii: string[] = [];
  const cjk: string[] = [];
  for (const word of INTENT_WORDS) {
    if (/^[a-z-]+$/.test(word)) ascii.push(word);
    else cjk.push(word);
  }
  // 长词优先，避免 '调用方' 先被 '调用' 吃掉后留下 '方'。
  const byLength = (a: string, b: string) => b.length - a.length;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts: string[] = [];
  if (ascii.length > 0) parts.push(`\\b(?:${[...ascii].sort(byLength).map(escape).join('|')})\\b`);
  if (cjk.length > 0) parts.push(`(?:${[...cjk].sort(byLength).map(escape).join('|')})`);
  return new RegExp(parts.join('|'), 'gi');
}

const INTENT_PATTERN = buildIntentPattern();

/**
 * 剥离意图词与填充词，返回剩下的文本（已折叠空白）。
 *
 * 调用方在读这个结果时只做一件事：判断“是否还有别的检索目标”。
 * 非 ASCII（中文）残词保留，因此主题名词不会被误删。
 */
export function stripQueryIntentWords(text: string): string {
  return text
    .replace(INTENT_PATTERN, ' ')
    // 标点、引号等非标识符字符不构成检索目标，统一折叠成空格。
    .replace(/[^A-Za-z0-9_$\u3400-\u9fff]+/g, ' ')
    .trim();
}

/**
 * 查询是否明确要求关联测试。
 * 与 {@link stripQueryIntentWords} 共用同一份词表，避免“意图词表”和“测试意图判断”漂移。
 */
export function queryWantsTests(query: string): boolean {
  return /\btests?\b|\btesting\b|\bspecs?\b|测试|用例/i.test(query);
}
