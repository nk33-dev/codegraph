import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Node } from '../types';
import { getParser } from '../extraction/grammars';
import { vueScriptSource } from '../extraction/vue-script-source';
import { callBinding } from './store-binding';
import { resolveImportPath } from './import-resolver';
import type { ResolutionContext, UnresolvedRef } from './types';
import type { MaybeYield } from './cooperative-yield';
import { enclosingFn, makeLineAt } from './synth-utils';

function refAt(node: Node, name: string, line: number, column = 0): UnresolvedRef {
  return { fromNodeId: node.id, referenceName: name, referenceKind: 'calls', filePath: node.filePath, language: node.language, line, column };
}

interface Dispatch { node: Node; channel: string; line: number; kind: 'vue-emit' | 'component-prop' }

function dispatches(component: Node, ctx: ResolutionContext): Dispatch[] {
  const source = ctx.readFile(component.filePath);
  if (!source) return [];
  const vue = component.language === 'vue';
  const tree = getParser(vue ? 'typescript' : component.language)?.parse(vue ? vueScriptSource(source) : source);
  if (!tree) return [];
  const nodes = ctx.getNodesInFile(component.filePath);
  const out: Dispatch[] = [];
  const visit = (syntax: SyntaxNode): void => {
    if (syntax.type === 'call_expression') {
      const callee = syntax.childForFieldName('function');
      const line = syntax.startPosition.row + 1;
      const caller = enclosingFn(nodes, line) ?? (vue ? component : null);
      if (callee && caller && (vue || (line >= component.startLine && line <= component.endLine))) {
        const text = callee.text;
        const member = /^([\w$]+)\.([\w$]+)$/.exec(text);
        const binding = callBinding(member?.[1] ?? text, refAt(caller, text, line, syntax.startPosition.column), ctx);
        const macro = binding?.callee && !nodes.some(node => node.name === binding.callee && ['function', 'constant', 'variable'].includes(node.kind))
          && !ctx.getImportMappings(component.filePath, component.language).some(imp => imp.localName === binding.callee);
        if (vue && macro && binding?.callee === 'defineEmits' && !member) {
          const event = syntax.childForFieldName('arguments')?.namedChildren[0];
          if (event?.type === 'string') out.push({ node: caller, channel: event.text.slice(1, -1), line, kind: 'vue-emit' });
        } else if (vue && macro && member && binding?.callee === 'defineProps') {
          out.push({ node: caller, channel: member[2]!, line, kind: 'component-prop' });
        } else if (!vue) {
          let fn: SyntaxNode | null = syntax.parent;
          while (fn) {
            const fnName = fn.childForFieldName('name')?.text ?? (fn.type === 'arrow_function' ? fn.parent?.childForFieldName('name')?.text : null);
            if (['function_declaration', 'arrow_function', 'function_expression'].includes(fn.type) && fnName === component.name) break;
            fn = fn.parent;
          }
          const parameters = fn?.childForFieldName('parameters') ?? fn?.childForFieldName('parameter');
          const parameter = parameters?.namedChildren[0] ?? parameters;
          const pattern = parameter?.childForFieldName('pattern') ?? parameter;
          if (!fn || !binding?.parameter || binding.start !== fn.startIndex || binding.end !== fn.endIndex) return;
          if (member && pattern?.type === 'identifier' && pattern.text === member[1]) {
            out.push({ node: caller, channel: member[2]!, line, kind: 'component-prop' });
          } else if (!member && pattern?.type === 'object_pattern') {
            const prop = pattern.namedChildren.find(p => p.type === 'shorthand_property_identifier_pattern' && p.text === text
              || p.type === 'pair_pattern' && p.childForFieldName('value')?.text === text);
            const key = prop?.type === 'pair_pattern' ? prop.childForFieldName('key')?.text : prop?.text;
            if (key) out.push({ node: caller, channel: key, line, kind: 'component-prop' });
          }
        }
      }
    }
    for (const child of syntax.namedChildren) visit(child);
  };
  try { visit(tree.rootNode); } finally { tree.delete(); }
  return out;
}

export async function componentBindingEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const cached = new Map<string, Dispatch[]>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!/\.(?:vue|tsx|jsx)$/.test(file)) continue;
    if ((++scanned & 15) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source) continue;
    const vue = file.endsWith('.vue');
    const nodes = ctx.getNodesInFile(file);
    const component = nodes.find(n => n.kind === 'component');
    const imports = ctx.getImportMappings(file, vue ? 'vue' : file.endsWith('.tsx') ? 'tsx' : 'jsx');
    const markup = vue ? source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, match => match.replace(/[^\r\n]/g, ' ')) : source;
    const safe = markup.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\r\n]/g, ' '));
    const jsxSites = new Set<number>();
    const jsxAttributeSites = new Set<number>();
    if (!vue) {
      const tree = getParser(file.endsWith('.tsx') ? 'tsx' : 'jsx')?.parse(source);
      if (!tree) continue;
      const visit = (node: SyntaxNode): void => {
        if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') jsxSites.add(node.startIndex);
        if (node.type === 'jsx_attribute') {
          const value = node.namedChildren.find(child => child.type === 'jsx_expression');
          if (value?.namedChildren.length === 1 && value.namedChildren[0]?.type === 'identifier') jsxAttributeSites.add(node.startIndex);
        }
        for (const child of node.namedChildren) visit(child);
      };
      try { visit(tree.rootNode); } finally { tree.delete(); }
    }
    const lineAt = makeLineAt(source, 1);
    const tags = /<([A-Z][\w$]*|[a-z][\w]*-[\w-]+)\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?\s*>/g;
    for (const tag of safe.matchAll(tags)) {
      if (!vue && !jsxSites.has(tag.index!)) continue;
      const name = tag[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, c => c.toUpperCase());
      const mapping = imports.find(imp => imp.localName === name);
      const childFile = mapping && (mapping.resolvedPath ?? resolveImportPath(mapping.source, file, vue ? 'vue' : 'tsx', ctx));
      const candidates = childFile ? ctx.getNodesInFile(childFile).filter(n =>
        n.kind === 'component' || (n.isExported && (n.name === mapping!.exportedName || mapping!.exportedName === 'default') && n.kind === 'function'))
        : nodes.filter(n => n.name === name && (n.kind === 'component' || n.kind === 'function'));
      if (candidates.length !== 1) continue;
      const child = candidates[0]!;
      const parent = enclosingFn(nodes, lineAt(tag.index!)) ?? component;
      if (!parent || parent.id === child.id) continue;
      let sites = cached.get(child.id);
      if (!sites) { sites = dispatches(child, ctx); cached.set(child.id, sites); }
      const attrs = vue ? /(?:@|v-on:|:|v-bind:)([\w-]+)(?:\.[\w]+)*\s*=\s*(["'])([\w$]+)\2/g : /([\w$]+)\s*=\s*\{\s*([\w$]+)\s*\}/g;
      for (const attr of tag[2]!.matchAll(attrs)) {
        if (!vue && !jsxAttributeSites.has(tag.index! + tag[0].indexOf(tag[2]!) + attr.index!)) continue;
        const channel = attr[1]!;
        const handlerName = vue ? attr[3]! : attr[2]!;
        const handlers = nodes.filter(n => n.name === handlerName && (n.kind === 'function' || n.kind === 'method'));
        const event = vue && /^(?:@|v-on:)/.test(attr[0]);
        const prop = channel.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const registrationLine = lineAt(tag.index! + tag[0].indexOf(tag[2]!) + attr.index!);
        if (!event) {
          const values = nodes.filter(n => n.name === handlerName && ['constant', 'variable', 'property'].includes(n.kind));
          if (values.length === 1) edges.push({ source: child.id, target: values[0]!.id, kind: 'references', provenance: 'heuristic',
            metadata: { synthesizedBy: 'component-prop', via: prop, registeredAt: `${file}:${registrationLine}`, inferred: true } });
        }
        if (handlers.length !== 1) continue;
        for (const site of sites.filter(s => s.kind === (event ? 'vue-emit' : 'component-prop') && s.channel === (event ? channel : prop))) {
          edges.push({ source: site.node.id, target: handlers[0]!.id, kind: 'calls', line: site.line, provenance: 'heuristic',
            metadata: { synthesizedBy: site.kind, via: channel, registeredAt: `${file}:${registrationLine}`, inferred: true } });
        }
      }
    }
  }
  return edges;
}
