# 测试与前后端关联

## 测试关联

`affected`、`codegraph_explore` 的改动上下文和 `query --mode tests` 共用文件依赖图。结果中的 `confidence` 表示图上的传播置信度，`testTypes` 表示额外证据：

- `direct` / `indirect`：直接依赖改动文件，或通过依赖链间接到达；
- `parameterized`：检测到参数化/表格驱动测试；
- `mockmvc`：检测到 MockMvc、supertest 或请求构造器；
- `dynamic`：检测到动态测试工厂、属性测试或运行时生成用例；
- `frontend`：检测到 Vue 测试工具、浏览器测试或 `.vue` 测试目标。

未命中某一类只表示当前源码和索引没有足够证据，不表示项目没有该类测试。高扇入改动没有图中关联测试时，输出使用“图中未发现覆盖”的措辞。

## HTTP 前后端关联

跨层边统一按 HTTP 方法、规范化路径、路径参数和查询参数匹配。支持 `fetch`、Axios/实例、ky、got、`useFetch`/`useSWR` 等客户端，以及 Express、Spring 等框架产生的路由节点。唯一最佳匹配才会作为确定关联；平局会保留多个候选，并在边元数据中标注 `confidence: "candidate"`、`inferred: true` 和 `candidateTargets`。

关联默认开启。初始化时可以选择关闭并填写客户端/服务端路径；设置会写入项目根 `codegraph.json`：

```json
{
  "apiCorrelation": {
    "enabled": true,
    "clientPaths": ["web", "frontend"],
    "serverPaths": ["api", "server"]
  }
}
```

路径为空表示不限制该侧。修改 `codegraph.json` 后重新运行 `codegraph index` 或 `codegraph sync` 即可生效。

## Vue 与动态关系

Vue SFC 的 `<template>`、kebab-case/PascalCase 子组件、`@click`/`v-on` 处理器、`<router-link>`/`<NuxtLink>`、路径别名和 Pinia/Vuex 已纳入共享解析。`<component :is="...">`、变量路由和多个路由候选等无法静态证明的关系会带 `inferred: true` 或候选元数据；不会伪装成确定调用。
