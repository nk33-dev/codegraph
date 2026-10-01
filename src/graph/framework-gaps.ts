import type CodeGraph from '../index';

export function frameworkRelationWarnings(cg: CodeGraph, files: Iterable<string>): string[] {
  const frontend = [...new Set(files)].filter(file => /\.(?:vue|tsx|jsx)$/.test(file)).slice(0, 10);
  if (!frontend.length) return [];
  const unresolved = frontend.flatMap(file => cg.getUnresolvedReferencesInFile(file, 100)
    .filter(ref => ref.referenceKind === 'calls')
    .map(ref => `${file}:${ref.line} ${ref.referenceName}`)).slice(0, 10);
  return [
    `Framework/dynamic relationships are partial in ${frontend.join(', ')}: only statically evidenced composables, stores, routes, component callbacks, props and emits are connected. Computed destinations, dynamic components, spread props, inline callback bindings and runtime event names may omit callers or impact results.${unresolved.length ? ` Unresolved call sites (may include external APIs): ${unresolved.join('; ')}.` : ''}`,
  ];
}
