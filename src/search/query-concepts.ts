/**
 * 中英概念映射，用于扩展中文查询的检索词。
 * 保持映射表简短（~20 组），只覆盖明确的技术术语对应关系。
 */

export const CONCEPT_MAP: Record<string, string[]> = {
  '前端': ['frontend', 'client', 'view', 'ui'],
  '后端': ['backend', 'server', 'service', 'api'],
  '后台': ['backend', 'admin', 'server'],
  '入口': ['entry', 'main', 'bootstrap', 'init', 'start'],
  '启动': ['startup', 'bootstrap', 'boot', 'init'],
  '初始化': ['initialize', 'init', 'setup'],
  '路由': ['router', 'route', 'routing'],
  '控制器': ['controller'],
  '服务': ['service'],
  '组件': ['component'],
  '配置': ['config', 'configuration'],
  '设置': ['settings', 'config'],
  '加载': ['load'],
  '保存': ['save', 'persist'],
  '序列化': ['serialize', 'serde', 'json'],
  '反序列化': ['deserialize', 'serde', 'json'],
  '字段': ['field', 'property'],
  '密钥': ['key', 'secret'],
  '加密': ['encrypt', 'crypto'],
  '解密': ['decrypt', 'crypto'],
  '桥接': ['bridge', 'invoke'],
  '生成物': ['generated', 'assemble'],
  '分片': ['fragment'],
  '文档': ['docs', 'documentation'],
  '数据库': ['database', 'db'],
  '接口': ['interface', 'api'],
  '模型': ['model'],
  '视图': ['view'],
  '中间件': ['middleware'],
  '工具': ['util', 'utility', 'helper'],
  '常量': ['constant', 'const'],
  '类型': ['type'],
  '枚举': ['enum'],
};

/**
 * 扩展中文查询，为已知的中文技术术语添加对应的英文词。
 * 例如："前端入口" → "前端 frontend client 入口 entry main"
 */
export function expandChineseQuery(query: string): string {
  let expanded = query;
  for (const [zh, enTerms] of Object.entries(CONCEPT_MAP)) {
    if (expanded.includes(zh)) {
      // 在中文词后添加英文等价词，用空格分隔
      expanded = expanded.replace(
        new RegExp(zh, 'g'),
        `${zh} ${enTerms.join(' ')}`
      );
    }
  }
  return expanded;
}
