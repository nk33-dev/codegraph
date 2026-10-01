import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';
import { extractVueScriptBlocks } from '../extraction/vue-script-blocks';
import type { Language, Node } from '../types';
import { resolveViaImport } from './import-resolver';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

interface Binding {
  name: string;
  start: number;
  end: number;
  local: boolean;
  parameter?: boolean;
  store?: string;
  action?: string;
  /** Callee of the declarator's initializer call — `useRouter` for `const nav = useRouter()`. */
  callee?: string;
}

const JS = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
const FUNCTIONS = new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration']);
const cache = new WeakMap<ResolutionContext, Map<string, { source: string; bindings: Binding[] }>>();

function patternNames(node: SyntaxNode): string[] {
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') return [node.text];
  if (node.type === 'pair_pattern') {
    const value = node.childForFieldName('value');
    return value ? patternNames(value) : [];
  }
  if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') {
    const left = node.childForFieldName('left');
    return left ? patternNames(left) : [];
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    const pattern = node.childForFieldName('pattern');
    return pattern ? patternNames(pattern) : [];
  }
  if (!['object_pattern', 'array_pattern', 'rest_pattern', 'formal_parameters'].includes(node.type)) return [];
  return node.namedChildren.flatMap(patternNames);
}

/** 只保留绑定和词法范围，解析树立即释放；同名参数、局部变量会遮蔽外层 action。 */
function bindingsFor(filePath: string, language: Language, context: ResolutionContext, source: string): Binding[] {
  let files = cache.get(context);
  if (!files) { files = new Map(); cache.set(context, files); }
  const hit = files.get(filePath);
  if (hit?.source === source) return hit.bindings;
  const tree = getParser(language)?.parse(source);
  if (!tree) return [];
  const bindings: Binding[] = [];
  const add = (pattern: SyntaxNode, scope: SyntaxNode) => {
    const entries = patternNames(pattern).map((name) => ({
      name,
      start: scope.startIndex,
      end: scope.endIndex,
      local: scope.type !== 'program',
    } as Binding));
    bindings.push(...entries);
    return entries;
  };
  const visit = (node: SyntaxNode, scope: SyntaxNode, functionScope: SyntaxNode): void => {
    if (FUNCTIONS.has(node.type)) {
      const name = node.childForFieldName('name');
      if (name) add(name, scope);
      scope = node;
      functionScope = node;
      const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
      if (params) for (const entry of add(params, scope)) entry.parameter = true;
    } else if (node.type === 'statement_block' || node.type === 'catch_clause' || node.type === 'for_statement' || node.type === 'for_in_statement') {
      scope = node;
      const param = node.childForFieldName('parameter');
      if (param) add(param, scope);
    }
    if (node.type === 'variable_declarator') {
      const pattern = node.childForFieldName('name');
      const value = node.childForFieldName('value');
      if (pattern) {
        const entries = add(pattern, node.parent?.type === 'variable_declaration' ? functionScope : scope);
        if (value?.type === 'call_expression') {
          const callee = value.childForFieldName('function')?.text.replace(/\s+/g, '');
          const args = value.childForFieldName('arguments')?.namedChildren ?? [];
          const store = callee?.match(/^([A-Za-z_$][\w$]*)(?:\.getState)?$/)?.[1];
          // Records where the binding came from, so a caller can attribute
          // `nav.push(...)` to the composable rather than to a same-named array.
          if (store) for (const entry of entries) entry.callee = store;
          if (store && args.length === 0 && pattern.type === 'object_pattern') {
            for (const prop of pattern.namedChildren) {
              const key = prop.type === 'pair_pattern' ? prop.childForFieldName('key')?.text : prop.text;
              const local = patternNames(prop);
              const entry = entries.find((binding) => local.length === 1 && binding.name === local[0]);
              if (entry && key && /^[\w$]+$/.test(key)) Object.assign(entry, { store, action: key });
            }
          } else if (store && pattern.type === 'identifier' && args.length === 1 && args[0]?.type === 'arrow_function') {
            const selector = args[0];
            const params = selector.childForFieldName('parameters') ?? selector.childForFieldName('parameter');
            const names = params ? patternNames(params) : [];
            const body = selector.childForFieldName('body');
            if (names.length === 1 && body?.type === 'member_expression' && body.childForFieldName('object')?.text === names[0]) {
              const action = body.childForFieldName('property')?.text;
              if (action) Object.assign(entries[0]!, { store, action });
            }
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child, scope, functionScope);
  };
  try { visit(tree.rootNode, tree.rootNode, tree.rootNode); } finally { tree.delete(); }
  if (files.size >= 32) files.delete(files.keys().next().value!);
  files.set(filePath, { source, bindings });
  return bindings;
}

/**
 * The text a reference's own positions are relative to, and the file line its
 * first line sits on.
 *
 * Normally the whole file. A `.vue` SFC is the exception: its references carry
 * `language: 'vue'`, which `getParser` has nothing for, and their columns are
 * relative to the `<script>` block while their lines are not — so the block is
 * what gets parsed, and `lineOffset` maps the file's line numbers onto it.
 */
function sourceFor(
  ref: UnresolvedRef,
  context: ResolutionContext
): { text: string; language: Language; lineOffset: number } | null {
  const file = context.readFile(ref.filePath);
  if (!file) return null;
  if (ref.language !== 'vue') return { text: file, language: ref.language, lineOffset: 0 };
  for (const block of extractVueScriptBlocks(file)) {
    const lines = block.content.split('\n').length;
    if (ref.line > block.startLine && ref.line <= block.startLine + lines) {
      return {
        text: block.content,
        language: block.isTypeScript ? 'typescript' : 'javascript',
        lineOffset: block.startLine,
      };
    }
  }
  return null;
}

export function callBinding(name: string, ref: UnresolvedRef, context: ResolutionContext): Readonly<Binding> | null {
  const source = sourceFor(ref, context);
  if (!source) return null;
  const offset = callOffsetAt(source.text, ref.line - source.lineOffset, ref.column);
  return bindingsFor(ref.filePath, source.language, context, source.text)
    .filter(binding => binding.name === name && binding.start <= offset && offset < binding.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
}

function storeNode(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const source = context.readFile(ref.filePath);
  if (source) {
    const offset = callOffset(source, ref);
    if (bindingsFor(ref.filePath, ref.language, context, source).some((binding) =>
      binding.name === name && binding.local && binding.start <= offset && offset < binding.end)) return null;
  }
  const imported = resolveViaImport({ ...ref, referenceKind: 'references', referenceName: name }, context);
  if (imported) return context.getNodeById?.(imported.targetNodeId) ?? null;
  const local = context.getNodesInFile(ref.filePath).filter((n) => n.name === name && (n.kind === 'constant' || n.kind === 'variable'));
  return local.length === 1 ? local[0]! : null;
}

function callOffset(source: string, ref: UnresolvedRef): number {
  return callOffsetAt(source, ref.line, ref.column);
}

/** UTF-16 offset matching web-tree-sitter indices and columns. */
function callOffsetAt(source: string, line: number, column: number): number {
  const prefix = source.split('\n').slice(0, line - 1).join('\n');
  return prefix.length + (line > 1 ? 1 : 0) + column;
}

function actionOnStore(store: Node, action: string, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const source = context.readFile(store.filePath);
  if (!source) return null;
  const declaration = source.split('\n').slice(store.startLine - 1, store.endLine).join('\n');
  const factories = context.getImportMappings(store.filePath, store.language).filter((imp) =>
    /^zustand(?:\/vanilla)?$/.test(imp.source) && ['create', 'createStore'].includes(imp.exportedName));
  if (!factories.some((imp) => new RegExp('=\\s*' + imp.localName.replace(/[$]/g, '\\$') + '\\s*(?:<[^;=]*>)?\\s*\\(').test(declaration))) return null;
  // 解构别名（clearSession）失败后仍要在 reset 定义恢复时被增量同步重试。
  ref.retryName = action;
  const targets = context.getNodesInFile(store.filePath).filter((node) =>
    node.name === action && (node.kind === 'function' || node.kind === 'method') &&
    node.startLine >= store.startLine && node.endLine <= store.endLine);
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.9,
    resolvedBy: 'framework',
    provenance: 'heuristic',
    metadata: {
      synthesizedBy: 'zustand-binding',
      via: `${store.name}.${action}`,
      registeredAt: `${target.filePath}:${target.startLine}`,
    },
  };
}

export function resolveComposableBinding(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'calls' || ![...JS, 'vue'].includes(ref.language)) return null;
  const member = /^([\w$]+)\.([\w$]+)$/.exec(ref.referenceName);
  const binding = callBinding(member?.[1] ?? ref.referenceName, ref, context);
  const factoryName = member ? binding?.callee : binding?.store;
  const action = member?.[2] ?? binding?.action;
  if (!factoryName || !action || !/^use[A-Z]/.test(factoryName)) return null;
  if (callBinding(factoryName, ref, context)?.local) return null;
  const imported = resolveViaImport({ ...ref, referenceKind: 'references', referenceName: factoryName }, context);
  const local = context.getNodesInFile(ref.filePath).filter(n => n.name === factoryName && n.kind === 'function');
  const factory = imported ? context.getNodeById?.(imported.targetNodeId) : local.length === 1 ? local[0] : null;
  if (!factory || factory.kind !== 'function') return null;
  const source = context.readFile(factory.filePath)?.split('\n').slice(factory.startLine - 1, factory.endLine).join('\n');
  if (!source) return null;
  const tree = getParser(factory.language)?.parse(source);
  if (!tree) return null;
  const returned = new Set<string>();
  const declaration = tree.rootNode.namedChildren.flatMap(n => n.type === 'export_statement' ? n.namedChildren : [n])
    .find(n => ['function_declaration', 'lexical_declaration'].includes(n.type));
  const rootFn = declaration?.type === 'lexical_declaration'
    ? declaration.namedChildren[0]?.childForFieldName('value') : declaration;
  const visit = (syntax: SyntaxNode): void => {
    if (syntax !== rootFn && ['function_declaration', 'arrow_function', 'function_expression'].includes(syntax.type)) return;
    if (syntax.type === 'return_statement') {
      const object = syntax.namedChildren[0];
      if (object?.type === 'object') for (const field of object.namedChildren) {
        if (field.type === 'shorthand_property_identifier' && field.text === action) returned.add(action);
        if (field.type === 'pair' && field.childForFieldName('key')?.text === action) {
          const value = field.childForFieldName('value');
          if (value?.type === 'identifier') returned.add(value.text);
        }
      }
    }
    for (const child of syntax.namedChildren) visit(child);
  };
  try { if (rootFn) visit(rootFn); } finally { tree.delete(); }
  const targets = context.getNodesInFile(factory.filePath).filter(n => returned.has(n.name) && (n.kind === 'function' || n.kind === 'method') && n.startLine >= factory.startLine && n.endLine <= factory.endLine);
  if (targets.length !== 1) return null;
  return { original: ref, targetNodeId: targets[0]!.id, confidence: 0.9, resolvedBy: 'framework', provenance: 'heuristic',
    metadata: { synthesizedBy: 'composable-binding', via: `${factoryName}.${action}`, registeredAt: `${ref.filePath}:${ref.line}` } };
}

/**
 * A HARD refusal: the caller must not let any other strategy resolve this
 * reference either. Returned when the accessor is itself shadowed by a local
 * binding (`useSession` as a parameter) — binding it to the file-scope store
 * would be a fabricated edge, not a guess worth taking.
 *
 * Plain `null` keeps its older meaning of "a store reference this pass cannot
 * prove"; the caller is free to try other strategies on those.
 */
export const STORE_BINDING_SHADOWED: unique symbol = Symbol('store-binding-shadowed');

/** undefined 表示不属于已识别的 store 绑定；null 表示有绑定但不能证明目标。 */
export function resolveStoreBinding(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null | undefined | typeof STORE_BINDING_SHADOWED {
  if (ref.referenceKind !== 'calls' || !JS.has(ref.language)) return undefined;
  const sibling = /^get\(\)\.([\w$]+)$/.exec(ref.referenceName);
  if (sibling) {
    const source = context.readFile(ref.filePath) ?? '';
    const offset = callOffset(source, ref);
    const visibleGetters = bindingsFor(ref.filePath, ref.language, context, source).filter((binding) =>
      binding.name === 'get' && binding.start <= offset && offset < binding.end);
    // Two visible `get`s means an inner one (a method's own parameter,
    // `shadowGet: (get: any) => get().reset()`) shadows the store factory's —
    // indistinguishable from the store's own `get` at this offset, so refuse
    // hard rather than bind the action through the shadowed accessor.
    if (visibleGetters.length > 1) return STORE_BINDING_SHADOWED;
    const getters = visibleGetters;
    if (getters.length !== 1) return null;
    const containers = context.getNodesInFile(ref.filePath).filter((node) =>
      (node.kind === 'constant' || node.kind === 'variable') && node.startLine <= ref.line && node.endLine >= ref.line);
    const targets = containers.flatMap((store) => {
      const declaration = source.split('\n').slice(store.startLine - 1, store.endLine).join('\n');
      if (!/\(\s*[\w$]+\s*,\s*get\s*\)\s*=>/.test(declaration)) return [];
      const target = actionOnStore(store, sibling[1]!, ref, context);
      return target ? [target] : [];
    });
    return targets.length === 1 ? targets[0]! : null;
  }
  const chain = /^([A-Za-z_$][\w$]*)\.getState\(\)\.([\w$]+)$/.exec(ref.referenceName);
  if (chain) {
    const store = storeNode(chain[1]!, ref, context);
    return store ? actionOnStore(store, chain[2]!, ref, context) : null;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(ref.referenceName)) return undefined;
  const source = context.readFile(ref.filePath);
  if (!source) return undefined;
  const bindings = bindingsFor(ref.filePath, ref.language, context, source);
  if (!bindings.some((binding) => binding.name === ref.referenceName && binding.store)) return undefined;
  const offset = callOffset(source, ref);
  const visible = bindings.filter((binding) => binding.name === ref.referenceName && binding.start <= offset && offset < binding.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const binding = visible[0];
  if (!binding?.store || !binding.action) return undefined;
  // accessor 本身也可能被参数遮蔽，不能借用文件顶部的同名 import。
  if (bindings.some((b) => b.name === binding.store && b.local && b.start <= binding.start && b.end >= binding.end)) {
    return STORE_BINDING_SHADOWED;
  }
  const store = storeNode(binding.store, ref, context);
  return store ? actionOnStore(store, binding.action, ref, context) : null;
}
