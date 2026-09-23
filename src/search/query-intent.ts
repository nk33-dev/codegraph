/**
 * Query-intent recognition for the personal fork's exact-retrieval contract.
 *
 * `codegraph_explore` accepts both symbol names and natural language. When a query contains
 * one uniquely exact symbol, phrases such as definitions, all callers, and related tests describe
 * the requested view rather than additional search targets. Sending those words through FTS caused
 * camelCase fragments such as `run` from `runUpgrade` to match unrelated functions.
 *
 * This module is the single source of structured intent. {@link parseQueryIntent} separates
 * relationships, scope, and test requests from topical text; intent words never enter fuzzy search.
 *
 * Conservative boundaries:
 *   - Strip only listed intent, connector, question, and imperative words. Keep topical nouns,
 *     so a query about the relationship between X and caching still has a second topic.
 *   - Chinese has no word boundaries, so phrases are replaced longest-first. This affects only
 *     whether topical text remains; a focused match still uses the exact symbol itself.
 */

export interface ExploreQueryIntent {
  definitions: boolean;
  callers: boolean;
  callees: boolean;
  flow: boolean;
  references: boolean;
  tests: boolean;
  direct: boolean;
  all: boolean;
  related: boolean;
  /** Topical text that remains after structured intent and filler words are removed. */
  remainder: string;
}

/** Group by semantics instead of growing one undifferentiated stop-word list. */
const INTENT_GROUPS = {
  definitions: [
    'definition', 'definitions', 'declaration', 'declarations', 'defined', 'declared',
    '定义位置', '定义处', '定义', '声明',
  ],
  callers: [
    'caller', 'callers', 'calledby', 'calling',
    '被谁调用', '谁调用了', '谁调用', '被调用', '调用方', '调用者', '上游',
  ],
  callees: ['callee', 'callees', 'calls', '调用链', '下游'],
  flow: ['flow', 'flows', 'pipeline', '流程', '调用链', '链路'],
  references: [
    'usage', 'usages', 'used', 'uses', 'use', 'using',
    'reference', 'references', 'referenced', 'mentioned', '引用', '使用',
  ],
  tests: ['test', 'tests', 'testing', 'tested', 'spec', 'specs', 'specification', '相关测试', '单元测试', '测试', '用例'],
  direct: ['direct', 'directly', 'immediate', '直接'],
  all: ['all', 'every', 'each', 'any', 'both', '所有', '全部', '每个', '各个', '各自', '分别'],
  related: ['related', 'relevant', 'associated', '相关调用', '相关文件', '相关', '有关'],
} as const;

/** Remaining words connect the sentence without naming another code topic. */
const FILLER_WORDS: readonly string[] = [
  // Other structural relationships.
  'call', '调用',
  'implementation', 'implementations', 'implementer', 'implementers', 'implemented', 'implements',
  'override', 'overrides', 'overridee',
  'impact', 'impacts', 'affected', 'affects',
  'source', 'sources', 'symbol', 'symbols', 'method', 'methods', 'function', 'functions',
  'location', 'locations', 'located', 'where', 'file', 'files', 'code',
  'purpose', 'usage-doc', 'example', 'examples', 'explain', 'explanation', 'description', 'describe',
  'signature', 'body', 'behavior', 'behaviour', 'dependency', 'dependencies',
  // English connectors, quantities, questions, and imperatives.
  'and', 'or', 'its', 'their', 'the', 'this', 'that',
  'these', 'those', 'of', 'for', 'to', 'from', 'in', 'on', 'with', 'by', 'is', 'are', 'was',
  'were', 'does', 'do', 'did', 'please', 'show', 'list', 'give', 'find', 'search', 'which',
  'what', 'who', 'whom', 'why', 'how', 'a', 'an',
  // Chinese intent words.
  '调用关系', '实现者', '实现',
  '源码', '代码', '文件', '位置', '所在',
  '内容', '作用', '用途', '用法', '功能', '行为', '说明', '解释', '介绍', '示例', '例子', '举例',
  '关系', '影响', '范围', '依赖',
  // Chinese connectors, quantities, questions, and imperatives.
  '以及', '还有', '并且', '而且', '或者',
  '之间', '哪些', '哪个', '哪里', '在哪', '什么', '怎么', '如何', '为什么', '是否', '能否',
  '可以', '需要', '这个', '那个', '这些', '那些', '一个', '一些', '我们', '他们', '它们',
  '帮我', '给我', '我想', '我要', '看看', '列出', '显示', '展示', '找出', '找到', '查找',
  '查询', '搜索', '请', '帮', '和', '与', '跟', '及', '或', '的', '得', '地', '是', '在',
  '有', '为', '了', '被', '把', '给', '对', '就', '都', '也', '还', '再', '又', '它', '其',
  '此', '该', '这', '那', '我', '你', '他', '她', '们', '会', '能', '要', '想', '去', '来',
  '看', '说', '做', '用', '中', '上', '下', '里', '后', '前', '时',
];

const INTENT_WORDS: readonly string[] = [
  ...Object.values(INTENT_GROUPS).flat(),
  ...FILLER_WORDS,
];

/** ASCII words use word boundaries; Chinese phrases use direct matching because Chinese has no word boundaries. */
function buildIntentPattern(): RegExp {
  const ascii: string[] = [];
  const cjk: string[] = [];
  for (const word of INTENT_WORDS) {
    if (/^[a-z-]+$/.test(word)) ascii.push(word);
    else cjk.push(word);
  }
  // Replace longer phrases first so a shorter term cannot leave a meaningless suffix.
  const byLength = (a: string, b: string) => b.length - a.length;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts: string[] = [];
  if (ascii.length > 0) parts.push(`\\b(?:${[...ascii].sort(byLength).map(escape).join('|')})\\b`);
  if (cjk.length > 0) parts.push(`(?:${[...cjk].sort(byLength).map(escape).join('|')})`);
  return new RegExp(parts.join('|'), 'gi');
}

const INTENT_PATTERN = buildIntentPattern();

const ASCII_INTENT_WORDS = new Set(INTENT_WORDS.filter((word) => /^[a-z-]+$/.test(word)));
const CJK_INTENT_PATTERN = new RegExp(
  INTENT_WORDS
    .filter((word) => !/^[a-z-]+$/.test(word))
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

function containsAny(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => /^[a-z-]+$/.test(word)
    ? new RegExp(`\\b${word}\\b`, 'i').test(lower)
    : lower.includes(word));
}

/**
 * Remove intent words from a query while preserving qualified-name punctuation.
 * `keep` protects real symbols whose names also happen to be intent words.
 */
export function removeQueryIntentWords(text: string, keep?: (word: string) => boolean): string {
  const ascii = text.replace(/[A-Za-z][A-Za-z-]*/g, (word) => {
    if (!ASCII_INTENT_WORDS.has(word.toLowerCase())) return word;
    return keep?.(word) ? word : ' ';
  });
  return ascii.replace(CJK_INTENT_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}

/** Remove intent and filler words, then fold punctuation for topic-presence checks. */
export function stripQueryIntentWords(text: string): string {
  return text
    .replace(INTENT_PATTERN, ' ')
    .replace(/[^A-Za-z0-9_$\u3400-\u9fff]+/g, ' ')
    .trim();
}

/** Separate relationships, scope, and test requests so callers never guess which modifiers belong in FTS. */
export function parseQueryIntent(text: string): ExploreQueryIntent {
  const remainder = stripQueryIntentWords(text);
  return {
    definitions: containsAny(text, INTENT_GROUPS.definitions),
    callers: containsAny(text, INTENT_GROUPS.callers),
    callees: containsAny(text, INTENT_GROUPS.callees),
    flow: containsAny(text, INTENT_GROUPS.flow),
    references: containsAny(text, INTENT_GROUPS.references),
    tests: containsAny(text, INTENT_GROUPS.tests),
    direct: containsAny(text, INTENT_GROUPS.direct),
    all: containsAny(text, INTENT_GROUPS.all),
    related: containsAny(text, INTENT_GROUPS.related),
    remainder,
  };
}
