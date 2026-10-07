import type CodeGraph from '../index';
import type { TextHit } from '../db/file-text';
import { lookupSymbolNodes } from './symbol-lookup';

export interface DocumentMention {
  kind: 'document-mention';
  filePath: string;
  line: number;
  text: string;
  matchedTerms: string[];
  freshness: TextHit['freshness'];
  source: TextHit['source'];
}

/** Expand a symbol to its names; prose mentions never become graph dependencies. */
export function searchDocumentMentions(cg: CodeGraph, query: string, options: { offset?: number; limit?: number; file?: string } = {}) {
  const terms = new Set([query]);
  const nodes = lookupSymbolNodes(cg, query).nodes;
  for (const node of nodes.slice(0, 8)) {
    terms.add(node.name);
    terms.add(node.qualifiedName);
    for (const contract of cg.getFieldContracts(node.id)) terms.add(contract.externalName);
  }
  const mentions = new Map<string, DocumentMention>();
  const warnings = new Set<string>();
  for (const term of [...terms].filter(Boolean).slice(0, 16)) {
    const page = cg.searchText(term, { limit: 200, file: options.file, documentsOnly: true });
    page.warnings.forEach(warning => warnings.add(warning));
    if (page.nextOffset !== null) warnings.add('Document search reached its 200-file budget for a term; narrow the symbol or file filter.');
    for (const hit of page.items) {
      if (hit.freshness !== 'current') { warnings.add(`Document changed after indexing: ${hit.filePath}; run codegraph sync.`); continue; }
      for (const line of hit.lines) {
        const key = `${hit.filePath}:${line.line}`;
        const previous = mentions.get(key);
        if (previous) previous.matchedTerms.push(term);
        else mentions.set(key, { kind: 'document-mention', filePath: hit.filePath, line: line.line,
          text: line.text, matchedTerms: [term], freshness: hit.freshness, source: hit.source });
      }
    }
  }
  const items = [...mentions.values()].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  return { items: items.slice(offset, offset + limit), total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null, warnings: [...warnings] };
}
