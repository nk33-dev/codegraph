# Rust 符号的构建上下文

`codegraph node` 与 MCP `codegraph_node` 渲染 Rust 符号时多输出一行构建上下文：这个文件属于哪个 crate、是不是 workspace 成员、该 crate 的 manifest 声明了哪些 feature 和依赖。

```
**Build context:** crate `alpha`; workspace member `crates/alpha`; declares features: `extra`; declared deps: `beta` (path ../beta)
```

一次接缝覆盖两条入口——CLI `codegraph node` 委托给 MCP 的同一个 handler，所以没有第二份渲染逻辑。

## 证据从哪来

`src/graph/rust-context.ts` 读取 Cargo.toml，**查询期现算，不落库**：不动 schema、不给节点加 metadata、不新增边。manifest 读取走 `src/cargo-manifest.ts`，和 workspace 解析器（`src/resolution/frameworks/cargo-workspace.ts`）是同一套函数——`use foo::...` 解析出来的 crate 名和这里报的 crate 名不可能不一致。

- 文件归属按**最长 crate 目录前缀**判定，所以 `crates/alpha/src/lib.rs` 报的是 `alpha` 而不是 workspace 根。
- `[workspace].members` 支持 glob（`crates/*`），展开时深度上限 5，跳过 `target`、`node_modules`、`.git`、`dist`、`build` 和隐藏目录。
- catalog 按项目根缓存，用每个 manifest 的 mtime + size 复核，所以改 Cargo.toml 不需要重启进程。复核是每个 crate 一次 `stat`，因此结果要缓存而不是每次重算。

## 局限（这是声明的清单，不是解析后的构建图）

- **不调用 `cargo metadata`**。`features` 是 crate 在 `[features]` 里**声明**的键，不是某次构建实际启用的集合：没有 feature 统一、没有 `--features` 选择、没有 cfg 求值。
- **`#[cfg(...)]` 根本没有被提取**。整个提取树里唯一处理 `attribute_item` 的地方是 `src/extraction/tree-sitter.ts` 里识别 `tauri::command` 的那一处。所以这里无法回答「这个符号在哪个 feature 下编译」，只能回答「它所在的 crate 声明了什么」。
- **依赖是「声明了什么」**，包含 dev / build / optional。`source: 'path'` 只表示写了 `path =`，不表示能解析成功；`git` 同理。
- **只认 `[workspace].members`**：不读 `exclude`、`default-members`、`[target.'cfg(...)'.dependencies]`、`[workspace.dependencies]`。这几种表头和依赖表的形状不匹配，会被跳过而不是半解析成假依赖。
- **单行 inline 依赖表**：`foo = { path = ".." }` 必须写在一行；多行写法按 `[dependencies.foo]` 表处理（Cargo 生态里也是这么写的）。
- 注释按既有的「`#` 到行尾」规则剥掉，因此引号里的 `#` 会截断该值——和解析器原有行为一致，没有单方面改严。

## 验证

`__tests__/rust-context.test.ts` 覆盖 manifest 解析（inline / per-name / dev / build 依赖、path / git / registry 来源、optional 与 features、workspace members、虚拟 workspace 无 package 名）、以及上面每条局限的反向断言（`[target...]` 与 `[workspace.dependencies]` 不得漏进依赖表，其他 section 的键不得被当成依赖）。catalog 侧覆盖最长前缀归属、glob member 展开、无 Cargo.toml 返回 null、改了 manifest 立即生效。端到端一条：索引一个含 Rust 与 TS 文件的 workspace，Rust 符号拿到 crate、TS 符号返回 null。

同一次改动还做了一次纯粹的搬移：Cargo.toml 的 section/数组/带引号值解析从 `src/resolution/frameworks/cargo-workspace.ts` 移到 `src/cargo-manifest.ts`，由解析器与新模块共同引用。搬移没有行为变化，由 `rust-*.test.ts` 与 `resolution.test.ts` 覆盖（本次 36 passed / 0 failed，另有既有用例）。
