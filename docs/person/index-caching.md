# 索引期读缓存与失效规则

索引与解析会对同一批数据反复读取：文件清单被约 50 处调用（其中约 25 个框架 detector 各扫一遍），`getDistinctFileLanguages()` 被每轮合成的语言门禁查询，框架 detector 之间还会重复读同一批 manifest。这些读取原来每次重跑 SQL 或重读磁盘。现在它们按下面的规则缓存，本文是这些规则的唯一权威说明——缓存数量多不等于更快，**生命周期和失效点才是契约**。

## QueryBuilder 的整表读缓存

`getAllFilePaths()`、`getAllNodeNames()`、`getDistinctFileLanguages()` 按**变更戳**memo（与 `getDominantFile()` 同一机制）：

- 变更戳 = `total_changes()` + `PRAGMA data_version`，两者都是 O(1)。前者覆盖本连接的写入，后者覆盖**其它连接/进程**的提交（daemon、并行的 `codegraph index`、store worker 自己的连接）。因此没有任何写路径需要记得失效。
- **事务内不缓存。** `total_changes()` 会把回滚掉的写入算进去，事务里读到的值可能在 `ROLLBACK` 后仍然挂着同一个戳。`inTransaction !== false` 时照算不缓存。
- **`rebind()` 必须清空。** 两条指向不同数据库的新连接可以报告相同的变更戳；worker 跟随重建后的索引重绑连接时，只靠戳会返回旧答案。`reopenReplacedDatabase()` 走的是新建 `QueryBuilder`，天然是干净的。
- 返回的数组**已冻结**，调用方只能读。约 50 处调用都是遍历 / 过滤 / `new Set(...)`；冻结同时让「数组同一性」可以安全地当缓存的 key（见下）。

## 框架检测的语言前置过滤

`detectFrameworks()` 在调用 `resolver.detect()` **之前**按 `FrameworkResolver.languages` 跳过语言不存在的 detector：纯 Python 仓不再让 Swift / C# / Terraform / Go 的 detector 各扫一遍文件清单。未声明 `languages` 的 detector 保持通用，一律执行。

**空集 = 未知 = 全跑**，这条是必须的：索引前的构造期检测数据库还是空的，跳过任何 detector 都会漏掉框架。

**索引前的检测上下文刻意不实现 `getAllFileLanguages`。** 那时只能按扩展名猜语言，而 `detectLanguage()` 对 `.h`（C/C++/ObjC）、`.inc`（PHP/Pascal）、带 Flow 注解的 `.js`（→ tsx）是**按文件内容**决定的——猜错会静默跳过 detector，这是真回归。解析期的上下文从 `files.language` 列取答案，那里的值本来就是带着内容算出来的，可信。

detector 之间重复的文件系统探测（`readFile` / `fileExists` / `listDirectories`）在检测上下文内做闭包 memo，生命周期就是这个上下文对象；它由 `ensureDetectedFrameworks()` 创建一次并缓存，构造即失效，不存在变旧的窗口。

`declaredDependencies()` 的缓存改按**文件清单的数组同一性**判定，而不是文件个数：同数量换文件（删一个、加一个）在旧的 `files.length` key 下会被当成命中，让解析器拿着过期的文件清单继续跑。

## 逐 ref 的框架调用过滤

每轮解析对每个未解析引用都会调用所有已检出框架的 `resolve()`，事后才由 `gateFrameworkLanguage` 过滤。现在事前跳过——但判据是**事后门禁必然拒绝**，不是重新判断语言：

- 门禁只在 `crossesCodeBoundary(目标语言, 引用语言)` 时丢弃结果，而 `languages` 就是该框架产出目标的语言域。若声明的每种语言都与引用跨代码族，任何结果都过不了门禁。
- `calls` 引用**豁免**：门禁对它们无条件放行（React Native / Expo 的 JS → native 桥接是刻意保留的证据），声明列表排除不掉它们。
- 未声明语言的框架不受影响。

## 每 pass 重置的配置派生缓存

`ReferenceResolver.clearCaches()` 现在一并清掉 `projectAliases`、`dirAliases`、`goModule`、`workspacePackages` 和 `import-resolver` 的 `cppIncludeDirCache`。这些字段原来的注释称「在 resolver 生命周期内不可变」，但 watch 模式下 resolver 比一次改写的 `tsconfig` / `go.mod` / `package.json` / `compile_commands.json` 活得久。`clearCaches()` 是 pass 边界——所有「文件系统在 pass 内稳定」的假设都在那里统一作废——成本是每 pass 重读几个配置文件。`fileContains` 的探测结果也在这里清，并按 (路径, needle) memo，避免对未读取的文件每次重读整个文件。

死缓存 `import-resolver.ts` 的 `importMappingCache` 已删除（从未被写入或读取）。

## 验证

`__tests__/query-cache.test.ts` 钉住：同一变更戳下返回同一引用、返回值已冻结、本连接写入后可见、**同数量换文件可见**、其它连接提交后可见、事务回滚后不留脏值、`rebind()` 后清空。框架语言过滤与逐 ref 过滤由 `__tests__/frameworks*.test.ts`、`monorepo-app-frameworks.test.ts`、`graph-baseline.test.ts`、`resolution.test.ts` 覆盖（本次 417 passed / 4 skipped / 0 failed）。

**没有实测数字。** 本机不跑构建与基准，上面是语义与正确性验证；实际耗时与内存改善需要在固定代码快照上用 `scripts/benchmarks/measure-index.cjs` 补测，未做之前不得声称已加速。
