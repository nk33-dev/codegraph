# CodeGraph · 个人版

把代码库变成可以查询、追踪和浏览的本地代码图。

这是 [CodeGraph](https://github.com/colbymchenry/codegraph) 的个人 fork，维护于 [nk33-dev/codegraph](https://github.com/nk33-dev/codegraph) 的 `personal` 分支。在上游的代码索引、调用链和可视化基础上，加入 Graph/LSP 统一查询、影响分析与符号编辑，方便个人开发和 AI 编程工具使用。

## 能做什么

- **理解代码**：按符号或自然语言查找相关源码、调用者、被调用者及跨文件依赖，追踪两个符号之间的调用路径。
- **分析改动**：查看影响范围和关联测试，查询定义、引用、文件符号与索引状态。
- **使用语言服务**：按需调用 LSP 获取定义、引用、诊断和符号信息，可自动选择后端或合并 Graph/LSP 结果。
- **编辑符号**：跨文件重命名、替换符号正文、在符号前后插入内容，默认先预览。
- **浏览代码图**：在浏览器中查看符号关系、模块地图、入口、执行步骤与页面跳转，保存浏览路径。
- **接入编程助手**：通过 MCP 给 Claude Code、Cursor、Codex 等工具提供代码查询与编辑能力。

源码解析与索引在本机进行，项目索引保存在 `.codegraph/`。图解析覆盖 TypeScript、JavaScript、Python、Java、C/C++、Rust、Go、C#、PHP、Swift、Kotlin 等多种语言，以及 Vue、Svelte、Astro 等文件格式。不同语言和框架的调用推导能力有差异，详见[框架覆盖](docs/design/framework-coverage.md)。

## 安装个人版

使用 **Node.js 24.x 和 Git**。个人分支推送到 GitHub 后，可直接从源码打包安装，无需向 npm registry 发布：

```powershell
npm pack "github:nk33-dev/codegraph#personal"
npm install -g ".\colbymchenry-codegraph-1.6.0-personal.3.tgz"
codegraph doctor
```

第二步使用 `npm pack` 实际输出的文件名。更新时重复这两步；固定版本可将 `#personal` 换成提交号或标签。源码准备阶段会构建 CLI 和 UI，因此首次安装需要下载构建依赖。

当前包名沿用 `@colbymchenry/codegraph`；从 npm registry 安装该名称取得的是**官方版**。个人版与官方版共用 `codegraph` 命令，切换后可用 `codegraph doctor` 核对实际入口、发行标记和构建信息。旧安装处理及其他安装方式见[个人使用与安装](docs/person/personal-usage.md)。

## 快速开始

在要分析的项目目录中执行：

```sh
codegraph init
codegraph explore "入口函数如何调用业务逻辑"
codegraph explore UserService
codegraph status
```

`init` 创建索引并进行首次扫描。MCP 服务运行时会监听代码变化；需要手动更新时执行 `codegraph sync`，完整重建使用 `codegraph index`。

扫描遵循 `.gitignore`，默认排除依赖和构建目录。项目范围配置放在根目录 `codegraph.json`，例如：

```json
{
  "exclude": ["vendor/**", "generated/**"],
  "includeIgnored": ["packages/internal/"]
}
```

## Graph 与 LSP 查询

普通 `explore` 返回源码和调用关系；指定 `--mode` 时返回结构化 JSON：

```sh
codegraph explore UserService --mode definitions --backend auto
codegraph explore fetchUser --mode references --backend both --file src/api.ts
codegraph explore src/main.py --mode symbols --backend lsp
codegraph explore src/main.py --mode diagnostics --backend lsp
codegraph explore fetchUser --mode impact
codegraph explore src/api.ts --mode tests
codegraph explore status --mode status --backend lsp
```

| 后端 | 适用场景 |
| --- | --- |
| `graph`（默认） | 从本地索引查询代码结构、调用关系和影响范围 |
| `lsp` | 使用语言服务器的定义、引用、诊断和符号能力 |
| `auto` | 按查询类型、语言和服务可用性选择后端，必要时回退并说明原因 |
| `both` | 合并图和语言服务结果，标记来源与双方确认的位置 |

### 配置语言服务

LSP 覆盖 **C、C++、JavaScript、TypeScript、Java、Rust、Go、Python**。语言服务器需要单独安装；CodeGraph 在实际需要时启动服务，并在空闲后释放进程。

| 语言 | 服务 |
| --- | --- |
| C / C++ | `clangd`，建议提供 `compile_commands.json` |
| JavaScript / TypeScript（含 JSX / TSX） | `typescript-language-server` 或 `vtsls` |
| Java | Eclipse JDT LS，需要配置完整启动命令 |
| Rust | `rust-analyzer` |
| Go | `gopls` |
| Python | `pyright-langserver`（默认）或 `pylsp` |

例如安装 Python 服务：

```sh
npm install -g pyright
```

命令在 PATH 中时即可自动发现，也可以在项目的 `.codegraph/lsp.json` 中指定：

```json
{
  "servers": {
    "python": {
      "command": "pyright-langserver",
      "args": ["--stdio"]
    }
  }
}
```

Pyright 读取项目的 Python 环境与配置。服务启动参数、超时和禁用设置见 [LSP 配置](docs/person/lsp-mvp.md#configuring-language-servers)。

## 符号编辑

编辑命令默认生成预览，只有加上 `--apply` 才写入文件：

```sh
codegraph edit fetchUser --file src/api.ts --operation rename --new-name loadUser
codegraph edit fetchUser --file src/api.ts --operation rename --new-name loadUser --apply
```

支持 `rename`、`replace-body`、`insert-before` 和 `insert-after`。重命名需要对应语言服务器；其余操作基于索引中的符号范围。目标不明确、索引过期或预览后文件发生变化时会拒绝执行。更多参数见 `codegraph edit --help` 和[结构化编辑](docs/person/structured-edits.md)。

## 可视化

```sh
codegraph ui
codegraph ui --no-open
codegraph ui --port 8080
```

`codegraph web` 是 `ui` 的别名。服务默认使用本机端口 `4747`，终端会显示实际地址；按 `Ctrl+C` 退出。**不启动 UI 命令就不会启动可视化 HTTP 服务**；MCP 和按需启动的 LSP 有各自独立的生命周期。

可视化来自上游项目，本分支沿用它。主要视图包括符号源码与调用关系、Map 模块地图、Entry points 入口、Steps 执行步骤和 Screens 页面关系；可展示的内容取决于项目语言、框架和索引信息。保存的浏览路径位于 `.codegraph/ui/trails/`。

## MCP 接入

运行配置向导，为使用的编程助手配置 MCP：

```sh
codegraph install
```

也可手动添加 stdio 服务：

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

客户端需要提供项目根目录，也可以在 `args` 后追加 `"--path", "项目绝对路径"`。本分支默认提供 `codegraph_explore` 查询与 `codegraph_edit` 编辑工具。多个客户端访问同一项目时共享后台服务和语言服务。

## 本地开发

```sh
git clone --branch personal https://github.com/nk33-dev/codegraph.git
cd codegraph
npm ci
npm run codegraph -- doctor
```

`npm ci` 的准备脚本会构建项目；改动源码后运行 `npm run build`。`npm run codegraph -- ...` 固定使用当前仓库构建的 CLI，便于与全局安装区分。开发约定见[开发参考](docs/development.md)。

## 文档

- [个人功能与维护导航](docs/person/README.md)
- [个人安装、更新与入口切换](docs/person/personal-usage.md)
- [结构化查询](docs/person/structured-queries.md) · [LSP](docs/person/lsp-mvp.md) · [自动路由与影响分析](docs/person/unified-routing.md) · [符号编辑](docs/person/structured-edits.md)
- [上游同步与个人发行](docs/person/maintenance.md)
- [检索质量](docs/retrieval.md) · [框架覆盖](docs/design/framework-coverage.md)

## 遥测

项目保留上游的匿名使用统计机制，字段和开关见 [TELEMETRY.md](TELEMETRY.md)。可随时关闭：

```sh
codegraph telemetry off
```

也支持环境变量 `CODEGRAPH_TELEMETRY=0` 或 `DO_NOT_TRACK=1`。

## 致谢与许可

基于 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) 开发，遵循 [MIT License](LICENSE)。个人扩展维护在 `personal` 分支，上游项目的功能、文档和贡献归原作者及贡献者所有。
