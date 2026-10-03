# 依赖边界与循环依赖检查

`codegraph architecture` 报告两件事：声明的依赖方向被违反的地方，以及模块之间的循环依赖。两者都从**已索引的图和已解析的文件依赖**推导，不落库、不新增边类型、不改 schema——因此结果总是反映当前索引，也不牵动 `EDGE_KINDS` 这条 native kernel 线协议。

## 配置

规则写在项目根的 `codegraph.json`（提交进 Git，因为禁止的依赖方向是代码库的属性）；`.codegraph/codegraph.json` 作为本机覆盖层，只覆盖它显式写出的字段。

```json
{
  "architecture": {
    "root": "src",
    "depth": 2,
    "minConfidence": 0.6,
    "requireDeclared": true,
    "boundaries": {
      "deny": [
        { "from": "src/graph", "to": "src/bin", "reason": "公共核心不得依赖 CLI" },
        { "from": "src/db", "to": "src/ui-server", "reason": "存储层不依赖查看器" }
      ]
    }
  }
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | `""` | 模块划分的起点目录，空串是仓库根 |
| `depth` | `2` | `root` 下把路径前几段当作一个模块；默认 2 使 `src/graph` 与 `src/bin` 是两个模块 |
| `minConfidence` | `0.6` | 低于该置信度的边不计入任何计数 |
| `requireDeclared` | `true` | 只统计「源码写下来」的边：import、限定名、继承子句、带类型接收者的调用 |
| `boundaries.deny[].from` / `.to` | — | 模块 id 或目录前缀，匹配自身及其任意子目录 |
| `boundaries.deny[].reason` | 无 | 违反时一并返回的原因文本 |

`architecture` 在两层配置之间**逐字段**合并：本机层只关掉 `requireDeclared` 不会清掉共享层的 `deny` 规则表（其他顶层键仍是整键覆盖）。非法值 warn-and-skip 到该字段的默认值：`depth` 必须在 1–4，`minConfidence` 必须在 0–1，缺少 `from` 或 `to` 的规则被丢弃，都不影响同一文件里的其它字段。

## 模块划分

与查看器地图（`GET /api/map`）用同一套实现 `src/graph/module-map.ts`：一个模块就是一个目录，不是聚类猜测。`moduleIdFor` 取 `root` 下前 `depth` 层，其中「一层」是一个目录加上紧随其后的 pass-through 目录（只有一个子目录、自身没有文件的目录，例如 Maven 的 `src/main/java/…`）；松散文件进 `(root files)`，`index.ts` / `lib.rs` / `__init__.py` 这类门面文件独享一格。模块 id 是仓库根相对的 posix 路径。

`MAP_EDGE_KINDS` 现在 re-export `src/graph/architecture.ts` 的 `MODULE_DEPENDENCY_EDGE_KINDS`（`calls`、`imports`、`references`、`instantiates`、`extends`、`implements`、`navigates`；不含 `contains`），所以报告和地图统计的是同一批关系。

## 输出

```json
{
  "root": "src",
  "depth": 2,
  "minConfidence": 0.6,
  "requireDeclared": true,
  "modules": 42,
  "dependencies": 137,
  "rules": { "configured": 2, "violated": 1 },
  "uncertainPairs": 1,
  "violationsTruncated": false,
  "violations": [
    {
      "rule": { "from": "src/graph", "to": "src/bin", "reason": "公共核心不得依赖 CLI" },
      "source": "src/graph",
      "target": "src/bin",
      "count": 3,
      "declared": 2,
      "evidenceTotal": 3,
      "evidence": [
        {
          "fromFile": "src/graph/engine.ts",
          "toFile": "src/bin/cli.ts",
          "fromName": "run",
          "toName": "main",
          "kind": "calls",
          "line": 5,
          "column": 9,
          "declared": true
        }
      ]
    }
  ],
  "cycles": { "total": 1, "shown": 1, "truncated": false, "items": [] }
}
```

- `dependencies` 按边类型计数（未按 pair 折叠）；`violations` 里同一个模块对的多种边类型已合并成一条，`count`/`declared` 是该 pair 的合计。
- `uncertainPairs` 是「命中规则、但所有边都只是裸名称匹配因而被 `requireDeclared` 排除」的 pair 数。被排除的量单独报出来，不用静默丢弃换取一份干净的清单。
- `evidence` 带具体位置，`evidenceTotal` 是该 pair 的边总数；`maxEdgesPerViolation`（默认 5）截断 `evidence`，超过时 `evidenceTotal > evidence.length`。
- `cycles.files` 是环内模块之间那些边背后的文件，不是整个模块的文件列表。

## 命令

```sh
codegraph architecture [path] [--json] [--root <dir>] [--depth <n>] [--min-confidence <n>]
                       [--allow-undeclared] [--cycles-only] [--max-violations <n>] [--strict]
```

命令行选项覆盖配置文件里的对应字段。`--strict` 在有违规时以退出码 1 结束，用于 CI 门禁；`--json` 输出上面的报告。

## 已知限制

- **名称匹配仍然会漏。** `requireDeclared` 默认打开，会把「只有裸名称匹配」的依赖排除在外。这类边里有真依赖（接收者类型无法解析时），它们只计入 `uncertainPairs`，不计入违反。想看全量用 `--allow-undeclared`。
- **模块 id 依赖 `root`/`depth`。** 改这两个值会改变模块 id，规则里写的 `from`/`to` 也要跟着改；用目录前缀写规则（`src/graph`）比写具体模块名更稳。
- **循环只报模块级。** 同一模块内部的环被有意忽略；把 `depth` 调深可以看到更细的环。
- **不落库。** 每次查询重新计算，大仓库上 `getCrossFileDependencyPairs` 与模块聚合都是整表扫描；与地图页共用同一量级。
- 目前只做只读报告，不提供豁免清单（waiver）机制。

## 验证

`__tests__/architecture.test.ts` 覆盖两部分：`src/graph/architecture.ts` 的纯函数（按 pair 折叠、规则前缀匹配、`requireDeclared` 的排除语义、模块环与单向依赖的区别），以及真实索引上的端到端报告（违规命中带 `file:line` 证据、模块环、无规则时只报环）；配置加载另有一组用例覆盖共享层与本机层的逐字段合并、非法规则与越界取值的降级。
