# 阶段三：高价值动态分派补全

本页对应[开发计划](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)阶段三。目标是在不增加 MCP 工具的前提下，让 `codegraph_explore` 沿既有图与共享合成器跨过常见运行时分派点；不能证明的运行时键仍作为 boundary 返回。

## 覆盖范围

阶段三复用并收拢现有分派形状，没有按框架复制查询逻辑：

| 分派形状 | 主要实现 | 代表场景 |
| --- | --- | --- |
| 抽象声明到具体实现 | `interfaceOverrideEdges`、`goImplementsEdges` | Java/Kotlin/C#/TS/Swift/Scala/Go/Rust/ArkTS 的 interface、trait、protocol、override 与注入接口 |
| 发布者到消费者 | `crossTierEdges` 及语言专项 pass | Bull/BullMQ、Nest 事件、socket、Celery、Spring 事件、MediatR、Sidekiq、Laravel 事件 |
| 协议桩到处理器 | `goGrpcStubImplEdges`、`objectRegistryEdges` | Go gRPC、命令/handler/plugin 注册表 |
| ORM 与 repository | `mybatisJavaXmlEdges` 及既有 receiver 类型解析 | MyBatis Java/Kotlin 到 XML、Spring/Nest repository 调用 |
| 状态与路由 | Redux/Pinia/Vuex/RTK/router pass、`store-binding.ts` | thunk、字符串 action、Pinia、Zustand、六类前端路由 |

只有对应语言存在时才进入 synthesis pass；框架专项逻辑还要求依赖、导入、装饰器、注册调用或工厂形状命中。普通项目不会仅凭同名方法生成边。

## Zustand 绑定契约

`src/resolution/store-binding.ts` 处理静态解析无法直接连接的四种调用：

- `const { reset } = useStore.getState(); reset()`；
- `const selected = useStore(state => state.reset); selected()`；
- `useStore.getState().reset()`；
- store 工厂内部的 `get().reset()`。

规则必须同时证明 store 来源是 `zustand` 或 `zustand/vanilla` 的 `create` / `createStore`，并且 action 在该 store 的范围内唯一。参数、局部变量和块级绑定会遮蔽外层 store/accessor；普通工厂、跨语言同名符号、重复目标和无法证明的成员链保持未解析。

生成边使用：

- `provenance: "heuristic"`；
- `metadata.synthesizedBy: "zustand-binding"`；
- `metadata.registeredAt` 指向 action 定义；
- `confidence: 0.9`。

因此阶段二证据层会把它显示为启发式路径并给出注册位置，不会与语法确认边混淆。

## 未连接边界

运行时变量键、反射、外部容器配置和候选超过 fan-out 预算时不造边。TS/JS 未知成员链保留完整调用文本供 effect/boundary 分析，但不会退化成末尾方法名匹配；`chrome.storage.local.get()`、计算属性链和匿名 receiver 不会误连到项目内同名函数。

## 验证

环境：Windows、Node 24.16.0、npm 11.13.0。

专项测试覆盖：

- 解构、selector、`getState()`、store 内 `get()` 的完整路径；
- 证据类型、`synthesizedBy` 与注册位置；
- 同名 store 的来源区分、参数/局部/块级遮蔽；
- 普通工厂、跨语言同名符号、静态访问控制项目；
- action 删除后清边、恢复后在 caller 未修改时按真实 action 名重建；
- 事件/队列、对象注册表、接口实现、Go gRPC、MyBatis 与现有状态管理回归。

本轮结果：

- 阶段三专项：18 个文件、347 项通过；
- `npm run build`：通过，包含 TypeScript、viewer、29 个 grammar WASM 与产物检查；
- `npm test`：271 个文件、4644 项通过，21 个文件/234 项按当前环境跳过；
- `git diff --check`：通过。

小、中、大真实仓库的 Agent A/B、Read/Grep 降幅、索引时间和数据库体积需要在固定个人版构建上重新测量，统一放到阶段六记录；在那之前不把历史上游数字写成本轮结果。
