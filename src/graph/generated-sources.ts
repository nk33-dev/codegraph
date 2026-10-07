import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Node } from '../types';
import { loadGeneratedSourcesConfig, type GeneratedSourceConfig } from '../project-config';
import { validatePathWithinRoot } from '../utils';
import { stripCommentsForRegex } from '../resolution/strip-comments';

export interface GeneratedSource extends GeneratedSourceConfig {
  status: 'verified' | 'drifted' | 'unavailable';
  evidence: 'configuration' | 'static-assembly';
  ranges: Array<{ input: string; outputStartLine: number; outputEndLine: number }>;
  consumers: Array<{ filePath: string; line: number }>;
  reason?: string;
}

export interface GeneratedLocation {
  output: string;
  status: GeneratedSource['status'];
  generator?: string;
  manifest?: string;
  input?: string;
  startLine?: number;
  endLine?: number;
  outputStartLine?: number;
  outputEndLine?: number;
  consumers: GeneratedSource['consumers'];
  reason?: string;
}

const MAX_GENERATED_BYTES = 16 * 1024 * 1024;
const sourceCache = new Map<string, { fingerprint: string; revision: string | null; watched: string[]; sources: GeneratedSource[] }>();

function stamp(root: string, file: string): string {
  const absolute = validatePathWithinRoot(root, file);
  if (!absolute) return `${file}:outside`;
  try {
    const stat = fs.statSync(absolute);
    return `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return `${file}:missing`; }
}

function read(root: string, file: string): string {
  const absolute = validatePathWithinRoot(root, file);
  if (!absolute) throw new Error(`Generated source path is outside the project: ${file}`);
  const size = fs.statSync(absolute).size;
  if (size > MAX_GENERATED_BYTES) throw new Error(`Generated source exceeds the 16 MiB read limit: ${file}`);
  const content = fs.readFileSync(absolute, 'utf8');
  if (Buffer.byteLength(content) > MAX_GENERATED_BYTES) throw new Error(`Generated source grew beyond the read limit: ${file}`);
  return content;
}

/** Resolve a small static path expression without running the project's script. */
function staticPath(expression: string, values: Map<string, string>, directory: string): string | null {
  const text = expression.trim();
  if (values.has(text)) return values.get(text)!;
  if (text === 'import.meta.dirname' || text === '__dirname') return directory;
  if (/^(['"])[^'"\\]*\1$/.test(text)) return text.slice(1, -1);
  const call = /^(?:path\.)?(join|resolve)\s*\((.*)\)$/.exec(text);
  if (!call) return null;
  const args = call[2]!.split(',').map(argument => staticPath(argument, values, directory));
  if (args.some(argument => argument === null)) return null;
  return call[1] === 'join' ? path.join(...args as string[]) : path.resolve(...args as string[]);
}

function assemblyConfig(root: string, script: string, content: string): GeneratedSourceConfig | null {
  const safe = stripCommentsForRegex(content, 'javascript');
  if (!safe.includes('.fragments') || !/\b\w+\s*\+=\s*\w+\s*;/.test(safe)) return null;
  // Only ordered, unmodified concatenation qualifies for line remapping.
  if (!/for\s*\(\s*const\s+\w+\s+of\s+\w+\.fragments\s*\)/.test(safe)) return null;
  const absoluteScript = validatePathWithinRoot(root, script);
  if (!absoluteScript) return null;
  const values = new Map<string, string>();
  for (const declaration of safe.matchAll(/\bconst\s+(\w+)\s*=\s*((?:path\.)?(?:join|resolve)\([^;\n]+\)|['"][^'"\n]+['"])\s*;/g)) {
    const value = staticPath(declaration[2]!, values, path.dirname(absoluteScript));
    if (value !== null) values.set(declaration[1]!, value);
  }
  const manifestExpression = /(?:await\s+)?readFile\(\s*((?:path\.)?join\([^)]*['"]manifest\.json['"][^)]*\))/.exec(safe)?.[1];
  const outputName = /\bwriteFile\(\s*(\w+)\s*,/.exec(safe)?.[1];
  const manifestAbsolute = manifestExpression ? staticPath(manifestExpression, values, path.dirname(absoluteScript)) : null;
  const outputAbsolute = outputName ? values.get(outputName) : null;
  if (!manifestAbsolute || !outputAbsolute) return null;
  const manifest = path.relative(root, manifestAbsolute).replace(/\\/g, '/');
  const output = path.relative(root, outputAbsolute).replace(/\\/g, '/');
  if (!validatePathWithinRoot(root, manifest) || !validatePathWithinRoot(root, output)) return null;
  const data = JSON.parse(read(root, manifest)) as { fragments?: Array<{ name: string }> };
  if (!Array.isArray(data.fragments) || !data.fragments.length || data.fragments.length > 2048) return null;
  const inputs = data.fragments.map(fragment => {
    if (!fragment || typeof fragment.name !== 'string') throw new Error(`Invalid fragment in ${manifest}`);
    return path.posix.join(path.posix.dirname(manifest), fragment.name);
  });
  if (inputs.some(input => !validatePathWithinRoot(root, input))) return null;
  return { output, inputs, manifest, generator: script };
}

export function generatedSources(root: string, files: readonly string[], revision: string | null = null): GeneratedSource[] {
  const candidates = files.filter(file => file.endsWith('.rs') || /(?:^|\/)(?:scripts|tools|build)\/.*\.(?:[cm]?js|ts)$/.test(file)
    || /(?:assembl|generat|build)[^/]*\.(?:[cm]?js|ts)$/.test(file));
  const previous = sourceCache.get(root);
  // Consumer discovery follows the index generation; live artifact/input drift is checked on every request.
  const scripts = candidates.filter(file => !file.endsWith('.rs'));
  const watched = [...new Set([...(previous?.watched ?? []), 'codegraph.json', '.codegraph/codegraph.json', ...scripts])];
  const fingerprint = watched.map(file => stamp(root, file)).join('\n');
  if (previous?.fingerprint === fingerprint && previous.revision === revision) return previous.sources;
  const configs = new Map<string, { config: GeneratedSourceConfig; evidence: GeneratedSource['evidence'] }>();
  const consumers: Array<{ file: string; content: string }> = [];
  const discoveryWarnings: GeneratedSource[] = [];
  for (const file of candidates) {
    // Large source files and bundles cannot be assembler scripts.
    const absolute = validatePathWithinRoot(root, file);
    if (!absolute) continue;
    try {
      if (fs.statSync(absolute).size > 512 * 1024) continue;
      const content = read(root, file);
      if (file.endsWith('.rs') && content.includes('include_str!')) consumers.push({ file, content });
      if (!/\.(?:m?js|cjs|ts)$/.test(file) || !content.includes('manifest.json') || !content.includes('writeFile')) continue;
      const config = assemblyConfig(root, file, content);
      if (config) configs.set(config.output, { config, evidence: 'static-assembly' });
    } catch (error) {
      if (file.includes('assembl') || file.includes('generat')) discoveryWarnings.push({
        output: '', inputs: [], generator: file, status: 'unavailable', evidence: 'static-assembly', ranges: [], consumers: [],
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const config of loadGeneratedSourcesConfig(root)) configs.set(config.output, { config, evidence: 'configuration' });
  const sources = [...configs.values()].map(({ config, evidence }): GeneratedSource => {
    const source: GeneratedSource = { ...config, evidence, status: 'unavailable', ranges: [], consumers: [] };
    try {
      let assembled = '';
      let line = 1;
      let bytes = 0;
      for (const input of config.inputs) {
        const content = read(root, input);
        bytes += Buffer.byteLength(content);
        if (bytes > MAX_GENERATED_BYTES) throw new Error('Generated inputs exceed the 16 MiB aggregate read limit');
        if (!content.endsWith('\n')) throw new Error(`Cannot remap a fragment without a final newline: ${input}`);
        const lines = content.split('\n').length - 1;
        source.ranges.push({ input, outputStartLine: line, outputEndLine: line + lines - 1 });
        line += lines;
        assembled += content;
      }
      source.status = read(root, config.output) === assembled ? 'verified' : 'drifted';
      if (source.status === 'drifted') source.reason = 'Generated output differs from its ordered inputs; artifact coordinates are retained.';
      for (const consumer of consumers) for (const match of consumer.content.matchAll(/\binclude_str!\s*\(\s*"([^"\\]+)"\s*\)/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(consumer.file), match[1]!));
        if (target === config.output) source.consumers.push({ filePath: consumer.file, line: consumer.content.slice(0, match.index).split('\n').length });
      }
    } catch (error) { source.reason = error instanceof Error ? error.message : String(error); }
    return source;
  });
  sources.push(...discoveryWarnings);
  const nextWatched = [...new Set(['codegraph.json', '.codegraph/codegraph.json', ...scripts,
    ...sources.flatMap(source => [source.output, ...source.inputs, ...source.consumers.map(consumer => consumer.filePath),
      ...(source.manifest ? [source.manifest] : []), ...(source.generator ? [source.generator] : [])])])].filter(Boolean);
  // Limit retained projects: this module is also loaded by shared query workers.
  if (!sourceCache.has(root) && sourceCache.size >= 8) sourceCache.delete(sourceCache.keys().next().value!);
  sourceCache.set(root, { revision, watched: nextWatched, fingerprint: nextWatched.map(file => stamp(root, file)).join('\n'), sources });
  return sources;
}

export function generatedLocation(node: Node, sources: readonly GeneratedSource[]): GeneratedLocation | null {
  const source = sources.find(source => source.output === node.filePath || source.inputs.includes(node.filePath));
  if (!source) return null;
  const location: GeneratedLocation = { output: source.output, status: source.status, generator: source.generator,
    manifest: source.manifest, consumers: source.consumers, ...(source.reason ? { reason: source.reason } : {}) };
  if (source.status !== 'verified') return location;
  if (source.output !== node.filePath) {
    const input = source.ranges.find(range => range.input === node.filePath)!;
    return { ...location, input: node.filePath, startLine: node.startLine, endLine: node.endLine,
      outputStartLine: input.outputStartLine + node.startLine - 1, outputEndLine: input.outputStartLine + node.endLine - 1 };
  }
  const range = source.ranges.find(range => node.startLine >= range.outputStartLine && node.endLine <= range.outputEndLine);
  if (!range) return { ...location, reason: 'Symbol spans fragment boundaries; artifact coordinates are retained.' };
  return { ...location, input: range.input, startLine: node.startLine - range.outputStartLine + 1,
    endLine: node.endLine - range.outputStartLine + 1 };
}

export function foldGeneratedDefinitions(nodes: readonly Node[], sources: readonly GeneratedSource[]): Node[] {
  return nodes.filter(node => {
    const location = generatedLocation(node, sources);
    return !location?.input || location.input === node.filePath || !nodes.some(other => other.filePath === location.input && other.name === node.name
      && other.startLine === location.startLine && other.endLine === location.endLine);
  });
}
