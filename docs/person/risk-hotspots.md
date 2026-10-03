# 风险热点报告与阈值门禁

`codegraph hotspots` 与 MCP `codegraph_hotspots` 回答同一个问题：这个仓库里最该先打开看的是哪些函数。排名用的是图里已有信号加上一个图里没有的信号——函数自己的分支复杂度。

```
Risk hotspots: 20 shown (1843 file(s) parsed, 12044 symbol(s) scored)

  1. 268.5 classify src/classify.ts
     src/classify.ts:420 (function)
     complexity 17 x 11 caller(s) — untested
```

## 打分

```
score = complexity × (1 + callerCount) × (changed ? 1.5 : 1) × (hasTests ? 0.75 : 1)
```

改动**提高**风险，被测试覆盖**降低**风险；两个权重由 `HOTSPOT_WEIGHTS` 给定，可在 `codegraph.json` 的 `hotspots.changedBoost` / `testPenalty` 覆盖。真正改动过的符号由 `--base <ref>` 传入（内部走 `analyzeChangeContext`），调用方计数走一次批量 `getIncomingEdgesTo(ids, ['calls'])`，关联测试按文件 memo 后走 `findAffectedTests`。

候选取 `function` / `method` / `component`，按路径稳定排序后取前 `maxFiles` 个文件。`scannedFiles`、`truncatedFiles`、`skipped`、`scoredSymbols` 都如实上报。

## 复杂度是读时算的

AST 在提取后就丢了：没有节点带构造计数，kernel 那个预留的 per-node metrics 槽没有写入。所以落库一个复杂度意味着改提取、升 `KERNEL_ABI_VERSION`、加 schema 迁移。报告只在有界的候选集上跑，不需要这些——`src/graph/hotspots.ts` 直接在读时用磁盘上的 tree-sitter grammar 数决策点，**不写库**。

一个决策点是：一个 `if`/`elif`/`guard`、一个 `case`/`match` 分支、一个 `catch`、一个循环、一个三元，以及一个逻辑 `&&`/`||`/`and`/`or`/`??`。`switch` 本身不算，它的分支才算。复杂度 = `1 + 决策数`。

- 每文件只解析一次，决策点按行号归到**最内层**包含它的可调用范围；可调用范围之外的顶层代码不计给任何人。解析走 `src/graph/tree-cache.ts` 的共享 LRU（与 branch-guards 共用），字节上限按调用传：Symbol 视图仍是 256 KiB，报告用 `MAX_SOURCE_FILE_SIZE_BYTES`（1 MiB）。
- 规则表按语言分列（TS/JS、Java、C#、C/C++/ObjC、Go、Swift、Python、Kotlin、Rust），`case`-家族的名字是这些 grammar 里分歧最大的一处，全部照 grammar 读出而非猜。不在表里的语言（如 YAML、Markdown）返回"没有规则"，被计为 `skipped`，而不是当成复杂度 1 混进排名。

## 门禁

`threshold`（默认 50）只定义"什么算被门禁的对象"；只有 `--strict` 会把它变成退出码：

```
codegraph hotspots --base origin/main --strict   # 有符号达到阈值就 exit 1
```

`gated` 是**在所有被评分的符号上**统计的，不只是在列出来的那些上。`maxItems` 只截断输出，不影响门禁——排在 21 位、没被打印出来的符号照样能让 CI 失败。

注意门禁的覆盖范围就是被扫描的集合：触及 `maxFiles` 时报告会说明只扫了路径序靠前的文件，`--strict` 的保证不超过这个范围。

## 配置

`codegraph.json` 的 `hotspots` 块。每个字段单独校验、单独合并，坏字段告警后丢弃而不影响其他字段；不写就是内置默认（阈值 50、20 条、2000 文件、权重 1.5/0.75）。

```json
{ "hotspots": { "threshold": 120, "maxItems": 50, "changedBoost": 2 } }
```

字段语义是"`null` 表示用内置默认"，所以配置层不复制算法常量——改 `HOTSPOT_WEIGHTS` 不会被一份过期的配置镜像抵消。CLI 标志优先于配置。

| 入口 | 用法 |
| --- | --- |
| CLI | `codegraph hotspots [path] [--base <ref>] [--threshold <n>] [--max-items <n>] [--strict] [-j, --json]` |
| MCP | `codegraph_hotspots`（默认不在工具表面内，需 `CODEGRAPH_MCP_TOOLS` 显式开启） |
| 公共 API | `cg.getRiskHotspots(options)` → `RiskHotspotReport` |

## 这是线索不是结论

决策计数是粗代理：TypeScript 把普通 `&&` 记作一个决策点，规则表本身对 grammar 版本敏感——错一个名字只会**少算**，不会报错。所以每种语言都由 `__tests__/hotspots.test.ts` 里一个已知决策数的夹具钉住，那张表才是验收门。分数排序同理：它是"先看哪里"的建议，不是质量结论。

## 验证

- `__tests__/hotspots.test.ts`：逐语言夹具的决策计数（含"比较与算术运算符不是决策点"的反向断言）、打分权重、排序确定性。
- `__tests__/hotspots-report.test.ts`：真实索引上的组装——分支多且被广泛调用的函数排在前、`maxItems` 只截输出而 `gated` 覆盖全部已评分符号、`threshold: null` 不门禁、`--files` 指定的不支持语言计为 `skipped`、`maxFiles` 截断上报、改动符号加权。
- `__tests__/mcp-tools-hotspots.test.ts`：工具存在一次、只读注解、参数面、默认表面仍只有 explore + edit。

未验证的部分：本机不跑构建、无基准，所以整体耗时与 `maxFiles` 截断的实际影响没有实测数据；`codegraph hotspots` 的 CLI 参数解析本身也没有测试覆盖（与 `architecture` 同现状，两者都只测到它调用的那层接口）；全量套件交 CI。
