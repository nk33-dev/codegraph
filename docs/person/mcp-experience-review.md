# MCP 体验问题处理记录

2026-09-23 对 Claude Code 的 `1.6.0-personal.10` 体验报告逐项复核。本页记录此次修复和验证边界；当前功能契约分别由链接文档维护，未发布改动不能视为已安装服务的行为。

| 报告项 | 处理结果 | 契约或验证位置 |
| --- | --- | --- |
| 1 源码被结构化摘要遮蔽 | 默认 MCP Explore 仅传完整文本；库和 CLI 保留结构化证据 | [结构化查询](structured-queries.md)；`mcp-experience.test.ts` |
| 2 改动噪声、行号与换行符误报 | 明确改动意图才分析；统一换行符后比较正文，保留重命名 | [改动上下文](change-context.md)；`change-context.test.ts` |
| 3 流程失败结论被埋没 | 保留已实现的失败优先及流程输出收束；普通查询不再支付改动分析成本 | `explore-intent-topic-query.test.ts` |
| 4 自然语言 MCP 被当符号 | 保留普通缩写识别与真实 handler 分发边验证 | [统一证据](flow-evidence.md) |
| 5 大文件全文漏检 | 持久化超限文件列表、有界补扫、未扫描警告；同时修复字内子串漏检 | [结构化查询](structured-queries.md)；`file-text-search.test.ts` |
| 6 定义与编辑候选排序 | 生产代码优先，测试其次，fixture 最后；歧义保护不变 | `mcp-experience.test.ts` |
| 7 影响距离排序 | 先距离，再文件类别和稳定位置排序；合并结果遵守相同原则 | `code-query-impact.test.ts`、`code-query-routing.test.ts` |
| 8 子进程测试遗漏 | 独立返回低置信度文件名候选，不伪造依赖距离或覆盖关系 | [结构化查询](structured-queries.md) |
| 9 名称建议 | 复用已有符号搜索候选；建议与精确目标分开，编辑仍拒绝错名 | `symbol-lookup.test.ts`、`mcp-experience.test.ts` |
| 10 不相关文件 | 按报告建议保留检索策略，不扩大此次启发式调整；真实仓库 A/B 仍待完成 | [评估方法](../validation.md) |
| 11 diagnostics 参数与路线 | MCP、CLI、统一 API 默认 auto；query 可提供路径；异常保留真实路由 | `lsp-code-query.test.ts` |
| 12 LSP 部分结果 | 即使结果非空，indexing 状态也附英文不完整警告 | `lsp-code-query.test.ts` |
| 13 HEAD 状态一致性 | 全模式报告当前 HEAD，普通查询短缓存，状态查询强制新读 | [索引状态](index-refresh-and-versioning.md) |
| 14 编辑换行符 | 现有转换正确，新增 LF 文件接收 CRLF 内容的预览回归 | `mcp-experience.test.ts`、`edit-text-edits.test.ts` |
| 15 编辑保护 | 保留默认预览、歧义拒绝和写前校验 | [结构化编辑](structured-edits.md) |
| 16 聊天 Hook | 只对实际存在的代码形状标识符或源码路径注入；忽略图片/文档附件名、普通聊天和空结果 | `frontload-hook.test.ts`、`mcp-experience.test.ts` |
| 17 隐藏工具提示 | 默认查询引导使用 Explore/source，修正文档旧入口 | [查询输出](query-output-indexing.md) |

## 性能与复用

- `analyzeImpact` 一次按边累计 `via`，移除每节点扫描全部边的 O(V×E) 行为；0–1 BFS 队列不再使用移动整个数组的 shift/unshift。
- `findAffectedTests` 先合并依赖路径，最后对每个唯一测试读取一次源码并分类。文件名候选复用当前索引文件列表，无额外扫描仓库。
- 定义查询复用符号解析已经拿到的模糊候选；需要分词建议时复用标识符分词函数。Explore 的非生产文件判断复用共享 helper。
- Hook 收束后删除无运行调用方的多语言关键词表及其纯关键词触发测试，保留代码形状、路径命中和普通聊天静默回归。
- 复用 SQLite trigram FTS 与既有编辑换行符函数，不增加依赖。旧词索引的替换和重建在事务内完成，失败时保留原索引并回退字面扫描。

## 验证与发布

验证结果统一记录在[开发验证记录](test-repairs.md)。针对复杂度的测试使用边访问次数和唯一文件读取次数，不把一次耗时当作真实仓库性能收益。真实 Claude Code 客户端展示、真实语言服务器、跨平台 CI、检索 A/B 与发行安装验证仍需对应环境完成。
