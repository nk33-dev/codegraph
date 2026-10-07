# 字符串契约与生成来源

字段外部名称、字符串调用和生成来源由公共 `CodeGraph` 接口提供，CLI/MCP 使用同一份结果。

## 字段契约

`definitions` 可用源码字段名、JSON 键或 `Type.externalName` 查询。`CodeSymbol.fieldContracts` 返回所属类型、字段名称、外部名称、声明类型、序列化/反序列化方向及声明位置。例如 `officialMixApiKey` 会同时保留 JS/TS 字段和 Rust `official_mix_api_key: bool`；名称后缀不能证明字段是密钥。

支持 serde `rename`、`rename_all`、`alias`、方向限定及 skip，Go `json` tag，Pydantic `Field` 的显式别名，Jackson `JsonProperty` 和 C# JSON 属性。运行时命名生成器、动态别名和自定义序列化实现保留为边界。字段名称相同但属于不同模型时保留所有声明；声明可以用 `file` 或限定名消歧。

目录存入 `field_contracts`，已有字段节点复用，缺失声明补字段节点。文件删除、字段或别名变更会清理旧目录；重复同步按内容及保留行数跳过解析。具有声明类型的静态键访问可以产生 `references`；跨语言同名模型保留候选，普通字符串只作为文本证据。原有字符串处理逻辑仍可用 `mode:"text"` 查询。

## 字符串调用

Tauri 的命令必须同时有命令声明和 `generate_handler!` 注册。客户端必须有 `@tauri-apps/api/core` / `tauri` 的导入或明确全局入口，支持导入别名、泛型调用和同文件包装函数。按 `src-tauri` 的应用根隔离同名命令；同名参数不能借用导入绑定。

桥接识别 Rust `match path/route/url`、JS/TS `switch` 及由路径参数实际调用的静态映射表。客户端包装函数须把参数转发到桥接或 HTTP transport；可经静态导入和已校验的分片组装关联。合成边带 `channel`、键名、注册位置和 inferred/candidate 证据。路径分支只连接本分支调用；变量键不猜目标。共享后端或多个注册位置无法唯一对应时保留候选。

实现使用既有 synthesis stage 原子替换，注册增删和未修改客户端的关系随同步更新。

## 生成来源

自动识别 `scripts` / `tools` / `build` 下的静态路径组装脚本，以及带 assemble/generate/build 名称的脚本。manifest 必须有有序 `fragments[].name`，脚本必须执行直接拼接；不执行项目脚本。实际分片内容与产物完全一致才建立行映射，manifest 的 `lines` 不作为证据。

其他生成方式可在共享或本地 `codegraph.json` 声明：

```json
{
  "generatedSources": [{
    "output": "assets/inject/renderer-inject.js",
    "inputs": ["assets/inject/renderer-inject/00-prelude.js", "assets/inject/renderer-inject/10-style.js"],
    "generator": "scripts/assemble-renderer-inject.mjs",
    "manifest": "assets/inject/renderer-inject/manifest.json"
  }]
}
```

路径须在项目内，`inputs` 按顺序填写完整清单。本地配置仅覆盖明确提供的顶层字段。

`CodeSymbol.generatedSource` 返回来源、生成脚本、manifest、产物坐标及字面量 `include_str!` 消费位置。默认查询折叠内容和位置相同的产物定义，保留原始图；显式指定产物 `file` 仍返回产物。漂移、来源不可读或符号跨分片边界时保留产物坐标并说明原因。读取限制为每文件及聚合输入 16 MiB；分片须以换行结尾。缓存随索引代次和依赖文件状态失效。

## 本地查询恢复

中文意图识别和概念词仍是第一层。未命中符号时，以最多 8 个词、每词 8 个文件、最终 5 个文件的预算查询现有全文索引；显示匹配词和原文。文本候选不视为定义或调用路径，也不证明所问行为存在。精确 camelCase / snake_case / 限定名未命中时不使用无关概念词扩散。

文档反查的参数和结果见[结构化查询](structured-queries.md)。数据格式与升级见[索引状态](index-refresh-and-versioning.md)，验证记录见[开发记录](test-repairs.md)。
