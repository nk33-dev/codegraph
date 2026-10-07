import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Edge, Language, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { enclosingFn } from './synth-utils';
import { literalValue, visitSyntax, withSourceTree, type SyntaxNode } from '../graph/source-syntax';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import type { QueryBuilder } from '../db/queries';
import { generatedSources } from '../graph/generated-sources';
import { stripCommentsForRegex } from './strip-comments';

export const STRING_ROUTE_PREFIX = 'string-route:';
export const STRING_BRIDGE_LANGUAGES: Language[] = ['rust', 'javascript', 'typescript', 'tsx', 'jsx'];

function routeNode(file: string, language: Language, key: string, site: SyntaxNode, owner: Node): Node {
  const qualifiedName = `${owner.qualifiedName}::bridge:${key}`;
  return {
    id: STRING_ROUTE_PREFIX + createHash('sha256').update(`${file}\0${qualifiedName}`).digest('hex').slice(0, 24),
    kind: 'route', name: key, qualifiedName, filePath: file, language,
    startLine: site.startPosition.row + 1, endLine: site.endPosition.row + 1,
    startColumn: site.startPosition.column, endColumn: site.endPosition.column,
    signature: `bridge ${key}${site.type === 'pair' && /^\w+$/.test(site.childForFieldName('value')?.text ?? '')
      ? ` -> ${site.childForFieldName('value')!.text}` : ''}`, updatedAt: Date.now(),
  };
}

/** A path parameter dispatching literal arms is a registration, not every string in a function. */
export function extractStringRoutes(file: string, source: string, language: Language, nodes: readonly Node[]): Node[] | null {
  return withSourceTree(source, language, root => {
    const routes: Node[] = [];
    visitSyntax(root, selector => {
      if (!['match_expression', 'switch_statement', 'switch_expression'].includes(selector.type)) return;
      const value = selector.childForFieldName('value') ?? selector.childForFieldName('condition');
      if (!value || !/^\(?\s*(?:path|route|url|request\.path)\s*\)?$/.test(value.text)) return;
      const owner = enclosingFn(nodes, selector.startPosition.row + 1);
      if (!owner || !/\b(?:path|route|url|request)\b/.test(owner.signature ?? '')) return;
      const body = selector.childForFieldName('body') ?? selector;
      visitSyntax(body, arm => {
        if (!['match_arm', 'switch_case', 'switch_expression_arm'].includes(arm.type)) return;
        // Only direct arms belong to this dispatcher; nested matches have their own keys.
        for (let ancestor = arm.parent; ancestor && ancestor.id !== body.id; ancestor = ancestor.parent) {
          if (['match_expression', 'switch_statement'].includes(ancestor.type)) return;
        }
        const pattern = arm.childForFieldName('pattern') ?? arm.childForFieldName('value') ?? arm.namedChild(0);
        const keys: string[] = [];
        if (pattern) visitSyntax(pattern, node => {
          const key = literalValue(node);
          if (key?.startsWith('/')) keys.push(key);
        });
        for (const key of new Set(keys)) routes.push(routeNode(file, language, key, arm, owner));
      });
    });
    // JS/TS route tables count only when a path parameter calls that same table.
    if (language !== 'rust') visitSyntax(root, declaration => {
      if (declaration.type !== 'variable_declarator') return;
      const name = declaration.childForFieldName('name');
      const value = declaration.childForFieldName('value');
      if (!name || value?.type !== 'object') return;
      const safe = stripCommentsForRegex(source, 'javascript');
      if (!new RegExp(`\\b${name.text}\\s*\\[\\s*(?:path|route|url)\\s*\\]\\s*(?:\\?\\.)?\\s*\\(`).test(safe)) return;
      const owner = enclosingFn(nodes, declaration.startPosition.row + 1)
        ?? nodes.find(node => node.kind === 'file');
      if (!owner) return;
      for (const property of value.namedChildren) {
        const key = literalValue(property.childForFieldName('key'));
        if (key?.startsWith('/')) routes.push(routeNode(file, language, key, property, owner));
      }
    });
    return routes;
  });
}

function tauriRoot(file: string): string {
  const marker = file.indexOf('/src-tauri/');
  return marker < 0 ? '' : file.slice(0, marker);
}

function callName(call: SyntaxNode): string {
  let callee = call.childForFieldName('function') ?? call.childForFieldName('name');
  if (callee?.type === 'generic_function') callee = callee.childForFieldName('function') ?? callee.namedChild(0);
  return callee?.text.replace(/<[^]*>$/, '') ?? '';
}

/** Registration and import evidence is kept on every synthesized hop. */
export async function stringBridgeEdges(queries: QueryBuilder, ctx: ResolutionContext, yieldToLoop: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const routes = ctx.getNodesByKind('route').filter(node => node.id.startsWith(STRING_ROUTE_PREFIX));
  const commands = new Map<string, Array<{ node: Node; root: string; registeredAt: string }>>();
  const files = ctx.getAllFiles();
  for (const file of files) {
    if (!file.endsWith('.rs')) continue;
    await yieldToLoop();
    if (ctx.fileContains && !ctx.fileContains(file, 'generate_handler!')) continue;
    const source = ctx.readFile(file);
    if (!source?.includes('generate_handler!')) continue;
    const safe = stripCommentsForRegex(source, 'rust');
    for (const registration of safe.matchAll(/(?:tauri::)?generate_handler!\s*\[([^\]]*)\]/g)) {
      for (const member of registration[1]!.split(',')) {
        const name = member.trim().split('::').pop();
        if (!name || !/^\w+$/.test(name)) continue;
        const module = member.trim().split('::').slice(0, -1).filter(part => !['crate', 'self', 'super'].includes(part));
        const targets = ctx.getNodesByName(name).filter(node => node.language === 'rust'
          && (!tauriRoot(file) || node.filePath.startsWith(`${tauriRoot(file)}/`))
          && module.every(part => node.filePath.split('/').some(segment => segment.replace(/\.rs$/, '') === part))
          && (node.decorators?.includes('tauri::command') || /#\s*\[\s*tauri::command\b/.test(
            (ctx.readFile(node.filePath)?.split('\n').slice(Math.max(0, node.startLine - 5), node.startLine).join('\n')) ?? '')));
        if (targets.length !== 1) continue;
        const list = commands.get(name) ?? [];
        list.push({ node: targets[0]!, root: tauriRoot(file), registeredAt: `${file}:${safe.slice(0, registration.index).split('\n').length}` });
        commands.set(name, list);
      }
    }
  }
  if (!routes.length && !commands.size) return edges;
  const languages = ctx.getAllFileLanguages?.();
  await loadGrammarsForLanguages(STRING_BRIDGE_LANGUAGES.filter(language => languages?.has(language)));
  const assemblies = generatedSources(ctx.getProjectRoot(), files).filter(source => source.status === 'verified');
  const wrapperFiles = new Map<string, Set<string>>();
  const tauriWrapperFiles = new Map<string, Set<string>>();
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = ctx.readFile(file);
    if (!source || !/bridge|invoke|fetch|axios/i.test(source)) continue;
    const nodes = ctx.getNodesInFile(file);
    const language = nodes[0]?.language;
    if (!language) continue;
    withSourceTree(source, language, root => visitSyntax(root, call => {
      if (call.type !== 'call_expression') return;
      const name = callName(call);
      const args = call.childForFieldName('arguments')?.namedChildren ?? [];
      const tauriTransport = ctx.getImportMappings(file, language).some(imported => imported.localName === name
        && imported.exportedName === 'invoke' && /^@tauri-apps\/api\/(?:core|tauri)$/.test(imported.source));
      if (!['path', 'route', 'url', 'command'].includes(args[0]?.text ?? '') || (!tauriTransport && !/(?:bridge|invoke|fetch|axios)/i.test(name))) return;
      const owner = enclosingFn(nodes, call.startPosition.row + 1);
      if (!owner || !/\b(?:path|route|url|command)\b/.test(owner.signature ?? '')) return;
      const sites = wrapperFiles.get(owner.name) ?? new Set<string>();
      sites.add(file);
      wrapperFiles.set(owner.name, sites);
      if (tauriTransport) {
        const tauriSites = tauriWrapperFiles.get(owner.name) ?? new Set<string>();
        tauriSites.add(file); tauriWrapperFiles.set(owner.name, tauriSites);
      }
    }));
  }
  for (const file of files) {
    await yieldToLoop();
    const nodes = ctx.getNodesInFile(file);
    const language = nodes[0]?.language;
    if (!language || !STRING_BRIDGE_LANGUAGES.includes(language) || language === 'rust') continue;
    const source = ctx.readFile(file);
    if (!source || (!source.includes('invoke') && !source.includes('/'))) continue;
    const importNames = new Set<string>();
    for (const imported of ctx.getImportMappings(file, language)) {
      if (/^@tauri-apps\/api\/(?:core|tauri)$/.test(imported.source) && imported.exportedName === 'invoke') importNames.add(imported.localName);
      if (/^@tauri-apps\/api\/(?:core|tauri)$/.test(imported.source) && imported.isNamespace) importNames.add(`${imported.localName}.invoke`);
    }
    for (const [name, sites] of tauriWrapperFiles) if (sites.has(file)) importNames.add(name);
    const wrappers = new Set<string>();
    for (const [name, sites] of wrapperFiles) {
      if (sites.has(file) || assemblies.some(assembly => [assembly.output, ...assembly.inputs].includes(file)
        && [...sites].some(site => [assembly.output, ...assembly.inputs].includes(site)))) wrappers.add(name);
      for (const imported of ctx.getImportMappings(file, language)) {
        if (imported.exportedName !== name) continue;
        const from = path.posix.normalize(path.posix.join(path.posix.dirname(file), imported.source));
        if ([...sites].some(site => site.replace(/\.[cm]?[jt]sx?$/, '') === from.replace(/\.[cm]?[jt]sx?$/, ''))) wrappers.add(imported.localName);
      }
    }
    withSourceTree(source, language, root => {
      visitSyntax(root, call => {
        if (call.type !== 'call_expression') return;
        const name = callName(call);
        const args = call.childForFieldName('arguments')?.namedChildren ?? [];
        if (!['path', 'route', 'url'].includes(args[0]?.text ?? '')) return;
        // A wrapper must forward its parameter to an explicit bridge or HTTP transport.
        if (!/(?:bridge|invoke|fetch|axios)/i.test(name)) return;
        const owner = enclosingFn(nodes, call.startPosition.row + 1);
        if (owner && /\b(?:path|route|url)\b/.test(owner.signature ?? '')) wrappers.add(owner.name);
      });
      visitSyntax(root, call => {
        if (call.type !== 'call_expression') return;
        const name = callName(call);
        const argument = call.childForFieldName('arguments')?.namedChild(0) ?? null;
        const key = literalValue(argument);
        if (!key) return;
        const line = call.startPosition.row + 1;
        const owner = enclosingFn(nodes, line) ?? nodes.find(node => node.kind === 'file');
        if (!owner) return;
        const parameterShadow = new RegExp(`(?:\\(|,)\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:[:,)=])`).test(owner.signature ?? '');
        const tauri = (importNames.has(name) && !parameterShadow)
          || /^(?:window\.)?__TAURI__\.(?:core\.|tauri\.)?invoke$/.test(name);
        if (tauri) {
          const candidates = (commands.get(key) ?? []).filter(command => !command.root || file.startsWith(`${command.root}/`));
          for (const command of candidates) edges.push({
            source: owner.id, target: command.node.id, kind: 'calls', line,
            column: call.startPosition.column, provenance: 'heuristic',
            metadata: { synthesizedBy: 'string-bridge', channel: 'tauri', key,
              registeredAt: command.registeredAt, confidence: candidates.length === 1 ? 'inferred' : 'candidate',
              ...(candidates.length > 1 ? { candidateTargets: candidates.map(candidate => candidate.node.id) } : {}) },
          });
        } else if (key.startsWith('/') && (wrappers.has(name) || /(?:^|\.)[\w$]*bridge[\w$]*$/i.test(name))) {
          const candidates = routes.filter(route => route.name === key);
          const app = /^(?:apps|packages)\/[^/]+/.exec(file)?.[0];
          const scoped = candidates.filter(route => !app || !/^(?:apps|packages)\//.test(route.filePath) || route.filePath.startsWith(`${app}/`));
          const local = scoped.filter(route => path.posix.dirname(route.filePath) === path.posix.dirname(file));
          const targets = local.length ? local : scoped;
          for (const target of targets) edges.push({
            source: owner.id, target: target.id, kind: 'calls', line, column: call.startPosition.column,
            provenance: 'heuristic', metadata: { synthesizedBy: 'string-bridge', channel: 'bridge', key,
              registeredAt: `${target.filePath}:${target.startLine}`, confidence: targets.length === 1 ? 'inferred' : 'candidate',
              ...(targets.length > 1 ? { candidateTargets: targets.map(candidate => candidate.id) } : {}) },
          });
        }
      });
    });
  }
  // Preserve only calls inside the selected arm; linking to the dispatcher would include every route.
  for (const route of routes) {
    const nodes = ctx.getNodesInFile(route.filePath);
    const owner = enclosingFn(nodes, route.startLine);
    if (!owner) continue;
    const mapped = / -> (\w+)$/.exec(route.signature ?? '')?.[1];
    if (mapped) {
      const targets = nodes.filter(node => node.name === mapped && ['function', 'method'].includes(node.kind));
      if (targets.length === 1) edges.push({ source: route.id, target: targets[0]!.id, kind: 'calls',
        line: route.startLine, column: route.startColumn, provenance: 'heuristic',
        metadata: { synthesizedBy: 'string-bridge', channel: 'bridge-map', key: route.name,
          registeredAt: `${route.filePath}:${route.startLine}` } });
      continue;
    }
    for (const edge of queries.getOutgoingEdges(owner.id)) {
      if (edge.kind !== 'calls' || edge.line === undefined || edge.line < route.startLine || edge.line > route.endLine) continue;
      if (edge.metadata?.synthesizedBy) continue;
      if (edge.column !== undefined && ((edge.line === route.startLine && edge.column < route.startColumn)
        || (edge.line === route.endLine && edge.column >= route.endColumn))) continue;
      edges.push({ ...edge, source: route.id, provenance: 'heuristic', metadata: {
        ...edge.metadata, synthesizedBy: 'string-bridge', channel: 'bridge-arm', key: route.name,
        registeredAt: `${route.filePath}:${route.startLine}`,
      } });
    }
  }
  return edges;
}

/** A typed receiver ties a static JSON key to its declared model; untyped text stays text. */
export async function fieldContractEdges(queries: QueryBuilder, ctx: ResolutionContext, yieldToLoop: MaybeYield): Promise<Edge[]> {
  const contracts = queries.getFieldContracts();
  if (!contracts.length) return [];
  const keys = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    const list = keys.get(contract.externalName) ?? [];
    if (!list.some(item => item.nodeId === contract.nodeId)) list.push(contract);
    keys.set(contract.externalName, list);
  }
  const edges: Edge[] = [];
  const languages = ctx.getAllFileLanguages?.();
  await loadGrammarsForLanguages(['rust', 'go', 'python', 'java', 'csharp', 'javascript', 'typescript', 'tsx', 'jsx']
    .filter(language => languages?.has(language)) as Language[]);
  for (const file of ctx.getAllFiles()) {
    await yieldToLoop();
    const source = ctx.readFile(file);
    const nodes = ctx.getNodesInFile(file);
    const language = nodes[0]?.language;
    if (!source || !language || !/[\[.]/.test(source)) continue;
    if (![...keys.keys()].some(key => source.includes(`"${key}"`) || source.includes(`'${key}'`) || source.includes(`.${key}`))) continue;
    withSourceTree(source, language, root => visitSyntax(root, literal => {
      const key = literalValue(literal) ?? (literal.type === 'property_identifier'
        && literal.parent?.type === 'member_expression' ? literal.text : null);
      if (!key || !keys.has(key)) return;
      const parent = literal.parent;
      let receiver: string | undefined;
      if (parent && ['subscript', 'subscript_expression', 'element_access_expression'].includes(parent.type)) {
        receiver = (parent.childForFieldName('value') ?? parent.childForFieldName('object') ?? parent.namedChild(0))?.text;
      } else if (parent?.type === 'member_expression') {
        receiver = parent.childForFieldName('object')?.text;
      } else if (parent?.type === 'arguments' && parent.parent?.type === 'call_expression') {
        receiver = /^(\w+)\.(?:get|get_item)$/.exec(callName(parent.parent))?.[1];
      }
      if (!receiver || !/^\w+$/.test(receiver)) return;
      const line = literal.startPosition.row + 1;
      const owner = enclosingFn(nodes, line);
      if (!owner) return;
      const scoped = source.split('\n').slice(owner.startLine - 1, line).join('\n');
      const type = new RegExp(`\\b${receiver}\\s*:\\s*(?:&\\s*)?(?:mut\\s+)?([\\w:]+)`).exec(scoped)?.[1]
        ?? new RegExp(`\\b([A-Z]\\w*)\\s+${receiver}\\b`).exec(scoped)?.[1];
      if (!type) return;
      const candidates = keys.get(key)!.filter(contract => contract.owner.split(/::|\./).pop() === type.split('::').pop());
      for (const target of candidates) edges.push({ source: owner.id, target: target.nodeId,
        kind: 'references', provenance: 'heuristic', line, column: literal.startPosition.column,
        metadata: { synthesizedBy: 'field-contract', externalName: key, fieldType: target.fieldType,
          registeredAt: `${target.filePath}:${target.line}`, confidence: candidates.length === 1 && target.language === language ? 'inferred' : 'candidate',
          ...(candidates.length > 1 ? { candidateTargets: candidates.map(candidate => candidate.nodeId) } : {}) },
      });
    }));
  }
  return edges;
}
