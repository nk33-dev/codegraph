# 个人使用与安装

本轮面向个人开发和使用，不复制官方的多平台 npm 发行流程。本批个人版使用 `v1.6.0-personal.4` GitHub prerelease 交付 `.tgz`，不会发布到上游 npm scope，也不会自动替换这台机器上的全局 CodeGraph。

## 开发时使用哪个入口

```powershell
npm run build
npm run codegraph -- doctor --json
npm run codegraph -- explore target_value --mode definitions --backend auto
```

`npm run codegraph` 固定执行当前仓库 `dist/bin/codegraph.js`。`doctor` 无需索引，显示 CLI 绝对路径、Node 路径、包版本、个人发行标记、构建指纹、构建时的 Git 提交和未提交状态，以及 PATH 上的其他安装入口。个人预发布使用带 `personal` 标识的版本号，构建指纹继续用于区分实际产物；MCP 连接共享 daemon 时也会校验指纹。同版本但不同构建不能混用服务。

重建后应重新连接 MCP。旧 daemon 如仍占用项目写锁，应先通过 `codegraph daemon` 查看和停止对应服务，再启动个人构建；不要为了连接新版本直接删除活动锁文件。

## 从 GitHub 安装

安装机器使用 Node 20 至 24，推荐 Node 24。发布后可直接安装固定 Release 资产：

```powershell
npm install -g "https://github.com/nk33-dev/codegraph/releases/download/v1.6.0-personal.4/colbymchenry-codegraph-1.6.0-personal.4.tgz"
codegraph doctor --json
```

需要从 Git 标签自行打包时，推荐分两步执行：

```powershell
npm pack "github:nk33-dev/codegraph#v1.6.0-personal.4"
npm install -g ".\colbymchenry-codegraph-1.6.0-personal.4.tgz"
codegraph doctor --json
```

第二行使用第一行实际输出的文件名。需要开发分支或精确回退时，可将标签换成 `#personal` 或已验证的提交号。包名暂时仍沿用上游，不向上游 npm scope 发布；直接安装 `.tgz` 不要求在 npm registry 发布包。

当前 Windows / npm 11.13.0 实测，`npm install -g github:...` 的准备流程可能继承全局设置，并留下指向临时 Git 缓存的链接，命令退出成功但缓存清理后 CLI 不可用。因此使用 Release `.tgz`，或先 `npm pack`、再安装本地 `.tgz`；不能只用 npm 的退出码判断源码安装成功。

准备脚本会构建 TypeScript、UI 并复制 SQL/WASM，`dist/` 仍不提交到 Git。源码安装使用本机 Node，普通 Git/npm 包不包含官方捆绑 Node 和 Rust 原生内核；解析使用已有 WASM 回退，不能套用官方原生内核的性能数字。语言服务器单独安装，不随包下载。

`v1.6.0-personal.4` 的个人版 `upgrade` 只解析 `nk33-dev/codegraph` 的 GitHub Release，不会下载官方发行版。它从最近 20 个发布中按语义版本选择最新版本（含 prerelease）的 `.tgz`，也支持 `codegraph upgrade <tag>` / `CODEGRAPH_VERSION` 固定版本、`--check` 只检查和 `--force` 重装。原地升级只接受当前 npm 全局目录里的安装；源码 checkout、项目局部安装、npx 和未知布局不会被替换或悄悄新建另一份全局安装。升级后用 `doctor --json` 校验版本、个人发行身份和包路径，确认 PATH 没有遮蔽才刷新客户端配置。旧版 `v1.6.0-personal.3` 仍使用上述手动安装命令切换到新版。

## 切换已有安装

先用 `Get-Command codegraph -All` 和 `doctor` 确认入口。安装包验证完成后再处理旧的 npm 全局版与独立安装版，避免安装失败时失去可用入口。不要执行 `codegraph uninit`，它会删除项目索引。

MCP 如果配置的是 `command = "codegraph"`，会跟随启动它的应用所见的 PATH；如果写了绝对旧路径，需要改成个人版路径。工作区安装器与 `install --refresh` 会列出需要重启的已配置客户端，即使配置字节未变化也会提醒。需要完整退出并重新打开这些客户端：已经启动的窗口持有旧 MCP 子进程，不会因 PATH 或包文件变化自动热切换。也可以在开发期间手动固定为 Node 的绝对路径，参数为本仓库 `dist/bin/codegraph.js` 的绝对路径和 `serve --mcp`，绕过全局命令冲突。

## 开发验证

日常修改先运行 `npm run check:quick`，或用 `npm run test:focused -- <test files>` 指定专项测试。`npm run build`、`npm test` 与 `npm run verify:personal-install` 留给共享核心、构建/安装器和发布前检查，不在每次小改动后重复执行。具体改动、测试结果和环境范围见[开发验证记录](test-repairs.md)，项目首页只介绍功能和用法。
