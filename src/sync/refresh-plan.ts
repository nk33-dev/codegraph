import * as path from 'path';
import { readFileSync } from 'fs';
import type { IndexTaskLevel } from '../resource-profile';

export type RefreshScope = 'file' | 'related' | 'project';

export interface RefreshPlan {
  filePath: string;
  taskLevel: IndexTaskLevel;
  scope: RefreshScope;
  reason: string;
}

const GLOBAL_CONFIG = /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|Cargo\.toml|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|requirements(?:\.txt|\.in)|pyproject\.toml|\.codegraph(?:\.json)?)$/i;
const STRUCTURAL = /\b(?:interface|trait|protocol|abstract\s+class|implements|extends|export\s*\{|module\.exports|exports\.|route|router\.|@(?:get|post|put|patch|delete|route)\b)\b/i;

/**
 * 生成一次局部刷新的资源与范围计划。
 *
 * 这是有意保守的语法启发式：普通函数体修改只刷新该文件；接口、导出
 * 和路由相关变更刷新关联图；项目配置变更刷新整个项目。无法读取文件时
 * 按普通文件处理，真正的 sync 仍会以文件系统为最终事实来源。
 */
export function planRefresh(projectRoot: string, filePath: string): RefreshPlan {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const absolute = path.resolve(projectRoot, normalized);
  if (GLOBAL_CONFIG.test(normalized)) {
    return { filePath: normalized, taskLevel: 'global', scope: 'project', reason: 'project configuration changed' };
  }
  let source = '';
  try { source = readFileSync(absolute, 'utf8'); } catch { /* sync will report missing files */ }
  if (STRUCTURAL.test(source)) {
    return { filePath: normalized, taskLevel: 'interface', scope: 'related', reason: 'interface/export/route structure may affect dependents' };
  }
  return { filePath: normalized, taskLevel: 'ordinary', scope: 'file', reason: 'body-level change is local to the file' };
}
