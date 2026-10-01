/** Keeps Vue script text at its original UTF-16 offsets for scope analysis. */
export function vueScriptSource(source: string): string {
  let masked = source.replace(/[^\r\n]/g, ' ');
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const start = match.index! + match[0].indexOf('>') + 1;
    masked = masked.slice(0, start) + match[1]! + masked.slice(start + match[1]!.length);
  }
  return masked;
}
