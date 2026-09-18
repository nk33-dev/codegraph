const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/** 从可能夹杂生命周期日志的 npm pack stdout 中提取末尾 JSON 数组。 */
export function parseNpmPackOutput(output) {
  const clean = output.replace(ANSI_PATTERN, '');
  const starts = [...clean.matchAll(/(?:^|\r?\n)(\[\s*\{)/g)]
    .map((match) => match.index + match[0].length - match[1].length)
    .reverse();
  for (const start of starts) {
    try {
      const parsed = JSON.parse(clean.slice(start).trim());
      if (Array.isArray(parsed) && typeof parsed[0]?.filename === 'string') return parsed;
    } catch {
      // 继续尝试更早的 JSON 数组起点。
    }
  }
  throw new Error('npm pack 输出中没有可识别的包元数据 JSON；请检查生命周期脚本日志。');
}
