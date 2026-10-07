import type CodeGraph from '../index';
import type { TextHit } from '../db/file-text';
import { removeQueryIntentWords } from '../search/query-intent';

export interface QueryTextEvidence extends TextHit {
  matchedTerms: string[];
  evidence: 'text-candidate';
}

/** Local lexical recovery; a text hit does not prove the requested behavior exists. */
export function queryTextFallback(cg: CodeGraph, query: string, file?: string): { items: QueryTextEvidence[]; warnings: string[] } {
  if (!cg.isTextIndexReady()) return { items: [], warnings: ['File text is not indexed; run codegraph sync.'] };
  const topic = removeQueryIntentWords(query);
  const code = topic.match(/(?:[A-Za-z_$][\w$]*(?:[./:][\w$]+)+|[A-Za-z_$][\w$]{2,})/g) ?? [];
  const precise = code.filter(term => /[a-z][A-Z]|_|[./:]/.test(term));
  const chinese = topic.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const terms = [...new Set(precise.length ? precise : [...code, ...chinese])]
    .filter(term => term.length <= 80).slice(0, 8);
  const hits = new Map<string, QueryTextEvidence>();
  const warnings = new Set<string>();
  for (const term of terms) {
    const page = cg.searchText(term, { limit: 8, file });
    page.warnings.forEach(warning => warnings.add(warning));
    for (const hit of page.items) {
      if (hit.freshness !== 'current') continue;
      const previous = hits.get(hit.filePath);
      if (previous) {
        previous.matchedTerms.push(term);
        previous.lines = [...new Map([...previous.lines, ...hit.lines].map(line => [line.line, line])).values()].slice(0, 5);
      } else hits.set(hit.filePath, { ...hit, matchedTerms: [term], evidence: 'text-candidate' });
    }
  }
  const items = [...hits.values()].sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.filePath.localeCompare(b.filePath)).slice(0, 5);
  return { items, warnings: [...warnings] };
}
