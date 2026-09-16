# 个人版生产硬化与发布准备

阶段六的可审查提交链、仓库自动化、本地产物验证和首个 GitHub prerelease 已纳入本轮交付；跨平台工作流、真实 LSP 和真实仓库 Agent A/B 的结果仍必须在实际运行后再记录，不能把工作流配置当成通过结果。

## 已实现

- 常规 CI 在 Windows、Ubuntu、macOS 执行 `npm ci`、build 和全量测试。
- `Hardening` 夜间/手动工作流验证三平台安装包、三平台原生 kernel、真实 TypeScript/Python LSP，以及 daemon/事务恢复和并发客户端。
- `Personal Release` 手动工作流验证并上传个人 `.tgz` 与 `SHA256SUMS`，创建或刷新个人 GitHub prerelease，不写回分支、不发布 npm。
- 上游 `Release` 工作流增加仓库身份保护，在 `nk33-dev/codegraph` 不运行上游标签、PAT、npm scope 和 `main` 写回流程。
- 根包元数据指向 `nk33-dev/codegraph`，并设置 `private: true`，防止把根包误发到 registry。版本号和包名未擅自修改。
- 安装产物验证覆盖 doctor、构建指纹、UI/WASM 资源、Graph 查询、编辑预览、事务 apply 和相同 operation ID 重放。

## 评测记录要求

真实仓库评测继续使用 `docs/validation.md` 的小、中、大仓库方法和
`scripts/agent-eval/ab-new-vs-baseline.sh`。每个问题至少每臂两次，记录 duration、Read、Grep、工具调用、输出利用率、错误边、索引时间、内存和数据库大小。结果必须包含：

- 个人构建的 build ID、提交、dirty 状态、Node/平台；
- 仓库提交与规模，问题原文和两臂使用的同一模型；
- 每次运行而不是只有均值，并标明 CLI 污染检查；
- 未安装 LSP、跳过 kernel、共享 runner 抖动等限制。

当前没有在本工作区内伪造这些数字。`v1.6.0-personal.1` 的三平台运行 `35126540607` 构建均通过，但测试暴露了 Windows 短路径、macOS `/var` 路径、跨平台 URI 断言和事务测试注入问题；这些根因已在 `v1.6.0-personal.2` 修复。修订版仍按要求不等待远端矩阵，也不代表真实仓库 Agent A/B、能耗测量或 npm registry 发布已经完成。

个人功能已按核心运行能力、测试与平台稳定性、发行基础设施、文档和发布记录形成可独立审查的提交链；发布说明覆盖结构化查询、LSP、共享 daemon、事务编辑、资源治理、稳定性和安装交付，不只罗列六阶段计划。

## 本地验证记录

环境：Windows、Node 24.16.0、npm 11.13.0。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过；TypeScript、viewer、29 个 grammar WASM 和 build info 完整 |
| `npm test` | 274 个文件、4666 项通过；21 个文件/234 项按当前环境跳过；无失败 |
| `npm run test:perf` | 7 个文件、279 项通过 |
| `npm run test:eval` | 评分器契约 4 项通过；真实语料 runner 未冒充执行 |
| `npm run verify:personal-install` | 隔离 tarball 安装通过；doctor、UI/WASM、Graph 查询、事务 apply 和幂等重放均通过 |
| `npm audit --omit=dev` | 生产依赖 0 个已知漏洞；开发链已应用兼容范围内修复 |
| `git diff --check` | 通过；只有工作区既有的 CRLF 转换提示 |

这些结果只代表本机。修订后的 GitHub 工作流尚未实跑完成，因此不能写成 Windows/Linux/macOS 矩阵已通过。

完整开发依赖审计仍报告 Vitest 2/Vite 5 链上的 7 条告警，自动修复要求跨大版本升级到 Vitest 5 或 Svelte 插件 7。当前未使用 `--force`；这部分只影响测试/开发服务器，不进入发布运行时，但仍应在独立升级分支验证后清零。
