# 个人使用与安装

本轮面向个人开发和使用，不复制官方的多平台 npm 发行流程。本批个人版使用 `v1.6.0-personal.6` GitHub prerelease 交付 `.tgz`，不会发布到上游 npm scope，也不会自动替换这台机器上的全局 CodeGraph。

## 开发时使用哪个入口

```powershell
npm run build
npm run codegraph -- doctor --json
npm run codegraph -- explore target_value --mode definitions --backend auto
```

`npm run codegraph` 固定执行当前仓库 `dist/bin/codegraph.js`。`doctor` 无需索引，显示 CLI 绝对路径、Node 路径、包版本、个人发行标记、构建指纹、构建时的 Git 提交和未提交状态，以及 PATH 上的其他安装入口。个人预发布使用带 `personal` 标识的版本号，构建指纹继续用于区分实际产物；MCP 连接共享 daemon 时也会校验指纹。同版本但不同构建不能混用服务。

重建后应重新连接 MCP。发现 daemon 版本不一致时，新客户端会自己完成切换（见下节）；仍在运行的旧 MCP 会话持有旧的子进程，必须完整退出并重开客户端。不要为了连接新版本直接删除活动锁文件。

## 升级后的 daemon 版本切换

安装新版后，旧版 daemon 可能仍在跑，并继续占着项目的 `.codegraph/daemon.pid` 与 socket。以前的结果是：新客户端每次都要退回进程内服务，编辑命令甚至在写路径上只报“未能确认”，必须手工 `codegraph daemon` 停掉旧进程才恢复。

现在的行为（`src/mcp/daemon-spawn.ts` 是唯一实现，MCP 代理与 CLI 共用）：

1. 客户端在 hello 握手阶段发现版本不一致（`version-mismatch`）。这一步**没有**发送任何 `tools/call`，所以后续行为是安全的、可证明的；
2. 先请旧进程优雅退出：只对“能通过 socket hello 证明是本项目 daemon”的 pid 发信号，无法证明时返回 `unverified` 并放弃切换，绝不误杀无关进程；
3. 以分离进程启动当前版本的 daemon，轮询候选 socket 直到 hello 与本版一致（约 6 秒预算），然后照常共享它；
4. 只读调用会在新 daemon 上重试一次并直接返回结果；写操作（`codegraph edit`）不在本进程重放同一请求，而是在本进程执行这次编辑——因为它可证明从未送达，不存在重复写入，同时 stderr 明确写出“旧 daemon 已被停止、当前版本正在启动”。

人工出口是 `codegraph daemon --restart`（可加 `-p <path>`、`--json`）：停止该项目的 daemon 并启动当前版本，用于“没有客户端在跑，但想把 daemon 换成新版”。失败时以非零退出码说明原因（无法证明身份 / 启动窗口内没有起来）。

## 索引升级：`codegraph sync --upgrade-index`

提取版本落后时，`status`/`sync`/`upgrade` 会提示 `reindexRecommended`；以前唯一可行的手工动作是完整重建（`codegraph index -f .`），大仓库上这是一次没有预告、没有确认的重建。现在用：

```powershell
codegraph sync --upgrade-index          # 先打印范围/文件数/预计耗时/预计峰值磁盘，再询问
codegraph sync --upgrade-index --yes    # 非交互运行（agent/CI/git hook）必须显式确认
```

- 规划逻辑在 `src/sync/upgrade-index.ts`（只读计算，不写文件）：耗时优先取自本项目的全量索引基线（`.codegraph/resource-metrics.json`），没有基线时退化为每文件经验值，并如实标注依据；磁盘按“现有 DB + WAL × 1.5”估计峰值占用。
- 范围来自 `EXTRACTION_UPGRADES`（`src/extraction/extraction-version.ts`）：登记为部分语言时只重新提取这些语言的文件，随后补一次 `sync` 完成引用解析与孤边清理，并在确认覆盖后才盖新的提取版本戳（`CodeGraph.stampExtractionVersion()`）。
- **当前历史递增没有登记范围**，因此从旧索引升级一律按完整重建处理，计划里会写明“升级区间没有登记，无法证明增量迁移安全”。这是有意保守：宁可不承诺兼容，也不谎称已经迁移。
- 非交互运行（非 TTY、`--quiet`）且没有 `--yes` 时，命令只打印计划并以非零退出码结束，不会猜着重建。
- 迁移结束后会再次校验 `isIndexStale()`；仍为陈旧时按失败处理，提示改用完整重建。

## 从 GitHub 安装

安装机器使用 Node 20 至 24，推荐 Node 24。发布后可直接安装固定 Release 资产：

```powershell
npm install -g "https://github.com/nk33-dev/codegraph/releases/download/v1.6.0-personal.6/colbymchenry-codegraph-1.6.0-personal.6.tgz"
codegraph doctor --json
```

需要从 Git 标签自行打包时，推荐分两步执行：

```powershell
npm pack "github:nk33-dev/codegraph#v1.6.0-personal.6"
npm install -g ".\colbymchenry-codegraph-1.6.0-personal.6.tgz"
codegraph doctor --json
```

第二行使用第一行实际输出的文件名。需要开发分支或精确回退时，可将标签换成 `#personal` 或已验证的提交号。包名暂时仍沿用上游，不向上游 npm scope 发布；直接安装 `.tgz` 不要求在 npm registry 发布包。

当前 Windows / npm 11.13.0 实测，`npm install -g github:...` 的准备流程可能继承全局设置，并留下指向临时 Git 缓存的链接，命令退出成功但缓存清理后 CLI 不可用。因此使用 Release `.tgz`，或先 `npm pack`、再安装本地 `.tgz`；不能只用 npm 的退出码判断源码安装成功。

准备脚本会构建 TypeScript、UI 并复制 SQL/WASM，`dist/` 仍不提交到 Git。源码安装使用本机 Node，普通 Git/npm 包不包含官方捆绑 Node 和 Rust 原生内核；解析使用已有 WASM 回退，不能套用官方原生内核的性能数字。语言服务器单独安装，不随包下载。

`v1.6.0-personal.6` 的个人版 `upgrade` 只解析 `nk33-dev/codegraph` 的 GitHub Release，不会下载官方发行版。它从最近 20 个发布中按语义版本选择最新版本（含 prerelease）的 `.tgz`，也支持 `codegraph upgrade <tag>` / `CODEGRAPH_VERSION` 固定版本、`--check` 只检查和 `--force` 重装。原地升级只接受当前 npm 全局目录里的安装；源码 checkout、项目局部安装、npx 和未知布局不会被替换或悄悄新建另一份全局安装。升级后用 `doctor --json` 校验版本、个人发行身份和包路径，确认 PATH 没有遮蔽才刷新客户端配置。旧版可使用上述固定 Release 安装命令切换到新版。

## 在 GitHub 发布

个人 fork 的 GitHub 默认分支是 `personal`，因此该分支上的 `Personal Release` 可直接从 Actions 页面或 CLI 触发。常规发布不依赖开发机持续开机，也不在本地生成 `.tgz`：

1. 在 `personal` 完成版本号、lockfile、发行说明和分层提交；
2. 一次推送 `personal`，等待同一提交的 Windows、Ubuntu、macOS CI 全部成功；
3. 触发 `Personal Release`（tag 可留空，工作流按 `package.json` 自动推导）；
4. GitHub runner 重新安装依赖、构建、隔离验证、打包、生成 `SHA256SUMS`，并把精确提交 SHA 标记为 prerelease。

```powershell
gh workflow run "Personal Release" --repo nk33-dev/codegraph --ref personal
gh run list --repo nk33-dev/codegraph --workflow "Personal Release" --limit 1
```

工作流会拒绝以下情况：同一提交的 CI 尚未成功、输入 tag 与包版本不一致、发行说明缺失，或既有 tag 指向另一个提交。AI 常规发布不得在本地运行 build、全量测试、隔离安装、`npm pack` 或 `gh release create/upload`；本地只保留开发所需的快速检查，发布产物与临时构建由 runner 生命周期自动清理。

## 切换已有安装

先用 `Get-Command codegraph -All` 和 `doctor` 确认入口。安装包验证完成后再处理旧的 npm 全局版与独立安装版，避免安装失败时失去可用入口。不要执行 `codegraph uninit`，它会删除项目索引。

MCP 如果配置的是 `command = "codegraph"`，会跟随启动它的应用所见的 PATH；如果写了绝对旧路径，需要改成个人版路径。工作区安装器与 `install --refresh` 会列出需要重启的已配置客户端，即使配置字节未变化也会提醒。需要完整退出并重新打开这些客户端：已经启动的窗口持有旧 MCP 子进程，不会因 PATH 或包文件变化自动热切换。也可以在开发期间手动固定为 Node 的绝对路径，参数为本仓库 `dist/bin/codegraph.js` 的绝对路径和 `serve --mcp`，绕过全局命令冲突。

## 开发验证

日常修改先运行 `npm run check:quick`，或用 `npm run test:focused -- <test files>` 指定专项测试。本地完整构建只用于确有必要的共享核心、构建/安装器调试；发布前的 build、全量测试和隔离安装由 GitHub CI / `Personal Release` 执行，不在开发机重复。具体改动、测试结果和环境范围见[开发验证记录](test-repairs.md)，项目首页只介绍功能和用法。
