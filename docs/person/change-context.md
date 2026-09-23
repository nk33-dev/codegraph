# AI 改动上下文与语义差异

阶段四把 Git 工作区变化、改动符号、语义边、影响入口和关联测试合并到现有 `codegraph_explore`。底层推导位于 `src/graph/change-context.ts`，MCP 和 CLI 只负责触发与渲染。

## 使用契约

- 查询明确包含 review/change/diff/impact/改动/审查等意图时自动分析；也可传 `includeChanges:true`。
- 普通源码查询不运行 Git 改动分析；只有明确改动意图、`includeChanges:true`、`baseRef` 或 `deepChanges:true` 才触发。
- 默认基准是 `HEAD`，`baseRef` 可指定其他提交或分支。CLI 对应 `--changes` 与 `--base <ref>`。
- `deepChanges:true` / `--deep-changes` 才创建基准提交的临时索引，用于比较解析后的语义边；默认局部分析不会复制完整数据库。
- 文本输出供模型直接阅读，库返回值及 CLI `--json` 的 `changes` 保存版本化字段：文件、行区间、符号、语义边、影响入口、关联测试、无测试风险、警告和裁剪状态。

## 推导边界

普通模式从 Git name-status、零上下文 hunk、基准文件源码和当前文件源码定位新增、修改、删除符号，并比较 `calls`、`extends`、`implements`、`overrides`、`navigates`。调用目标尚未解析时保留语法级名称；深度模式用独立基准图补充 resolved 边差异。

影响入口与测试复用 `src/graph/change-impact.ts`。传播距离是图距离，不是必然故障；动态调用、未解析引用和删除后已不存在的节点可能漏报。关联测试分为 `direct`、`high` 和 `indirect`：默认只返回直接测试与低扇出依赖链上的高置信度测试，经公共模块或较长依赖链扩散的候选通过 `includeIndirect:true` / `--include-indirect` 按需展开。没有找到关联测试只会对高扇入改动发出风险提示，不会声称“没有测试”或“没有影响”。

未暂存移动在 Git 中通常表现为删除加未跟踪新增；只有新旧内容完全相同时才合并为 rename，避免猜测相似文件。`.codegraph*` 数据目录不进入改动上下文。

显式 review/change/impact 查询分析完整工作区。比较前统一 LF/CRLF，再以改动区间与符号正文判断修改；单纯行号偏移、换行符转换不产生符号或语义边变更，文件重命名仍保留移动记录。间接测试的展开参数用于独立的 `mode:"tests"` 查询，不用于默认 explore 的改动上下文。

## 深度模式与清理

深度模式在系统临时目录创建 `codegraph-change-baseline-*`，通过本地共享 clone 检出基准提交并初始化独立索引。当前项目的 `.codegraph/` 不会被覆盖。无论成功或失败都会在 `finally` 中关闭数据库并删除临时目录；下一次深度分析还会尽力清理超过 24 小时的遗留目录。

## 验证

`__tests__/change-context.test.ts` 覆盖：

- 修改符号及调用边的新增/删除；
- 一次 `explore` 返回改动符号、影响入口和关联测试；
- 无关普通查询不附加改动上下文；
- 分支工作区中的重命名、删除和未跟踪文件；
- 显式 `baseRef` 下的双向分支切换差异；
- 深度临时索引完成后清理。

本地验证和发布状态见[开发验证记录](test-repairs.md)。
