# Explore 响应稳定性

本轮只处理可以确定验证的响应稳定性，不改变检索范围、源码预算、关系证据或默认去重策略。

## 点名文件的头部保留与续读脚注

问题：按路径点名一个文件和按符号点名它，结果不一样，而且差的那半没有任何提示。

- 成因一（头部）：Vue SFC 的 `component` 节点覆盖整份文件（`src/extraction/vue-extractor.ts`），必然命中 envelope 过滤的「容器覆盖超过半文件就丢弃」规则。按**符号**点名时 `flow.namedNodeIds` 豁免了它，按**路径**点名时没有——而它是唯一覆盖文件顶部的节点（`<template>`、`<style>` 都在 `<script setup>` 之前）。丢掉之后没有任何 range 覆盖头部，1..N 行整段消失，`gap` 标记也不会出现：它只标注两个已渲染片段**之间**的洞，不标注头顶和尾巴。
  - 修法：被 pin 的文件在 `ranges` 里补一个有界头部区间（`PINNED_HEAD_MAX_LINES = 200`，与 `OVERSIZE_SPINE_LINES` 同量级），`importance = EXACT_IMPORTANCE` 保证它在簇排序里不被挤掉。缺口小于该文件的 `budget.gapThreshold` 时不补——那是合并本来就会跨过的常规间距。
  - 没有选择「豁免 envelope 容器」：容器保留后整份文件会并成一个巨簇，再被 `shrinkCluster` 按成员重要性裁掉，头部照样丢；而且与 `ENVELOPE_KINDS` 的设计意图、`explore-output-budget` 的回归门冲突。
- 成因二（尾部）：section 用尽预算就停，而「停了」只体现为一句泛化的 *Some file sections were trimmed for size*。700 行的组件按符号点名回 1-503 行，剩下 197 行既没有行段也没有取法。
  - 修法：`uncoveredRuns` 用 `explore-dedup` 的 `subtractRange` 求已交付区间的补集（复用既有代数，`MIN_UNCOVERED_RUN = 12` 以下的洞是 section 自身间距，不报），`formatContinuationNote` 在围栏**之外**输出一行，给出未覆盖行段与 `mode:"source"` + `startLine` + `limit` 的取法。作用范围是 cluster 路径且 `isNamedFile` 的文件；整份渲染覆盖到末行不需要，focused/skeleton 已有逐洞行号文案。
- 计费：脚注在围栏外，不计入 `emittedChars`/`newSourceChars`（CG-26/CG-31 的源码账本读的是这两个），但计入 `totalChars` 与 `costOfSection`，所以它挤的是**该文件自己**的簇。`fileBudget` 与 `SPINE_CEILING` 同时扣 `CONTINUATION_NOTE_MAX_CHARS`——限定名查询的簇走后者，只扣前者等于没扣，脚注会拿走下层文件的预留（`explore-named-file-valve` 就是这条的守门测试，第一版实测红了 183 字符）。脚注写不下时降级为短句，再写不下就不发，绝不为了说明缺口去动源码。
- 硬顶切断那条路也补了：当整个响应超 `hardCeiling`、且最后一个 section 落在前半段时，会按行边界切在正文中间，此时 section 内的脚注会一起丢。`cutMidSectionNote` 由切断点自己补发同一格式的说明。
- 常量依据：`PINNED_HEAD_MAX_LINES = 200` 借用脊窗口量级；`MIN_UNCOVERED_RUN = 12` 与 `CONTINUATION_NOTE_MAX_CHARS = 240` 是按「多小的洞算 section 自身间距」「备注最长多少字符还不至于挤掉它要说明的源码」定的经验值，不是推导出来的。

## 已实现

- stale banner、footer 与文本 status 不再输出 `edited 123ms ago` 这类随调用时刻变化的相对时间，只显示 `pending sync` / `indexing`。
- 所有模型可见的待同步文件列表按路径排序，同一待同步集合得到逐字节一致的文本。
- 结构化 `mode:"status"` 同样按路径排序，但继续保留 `firstSeenMs`、`lastSeenMs` 和 `indexing`，避免字段级兼容性破坏。
- 现有跨调用源码去重仍由 `CODEGRAPH_EXPLORE_DEDUP=1` 显式开启，默认关闭。无会话记录或新会话都会重新发送源码；文件变化后由内容指纹阻止错误回指。

## 未合入的实验

没有加入按查询意图改变总预算、关系条数或源码范围的生产逻辑，也没有加入仅用于 A/B 的预算环境变量。此类改动必须证明不会增加 Read/Grep 回退；本轮未执行模型级 A/B，因此不改变默认检索行为，也不声称 token、工具调用或任务耗时收益。

本轮只验证固定字符、稳定排序、会话隔离和已有内容指纹边界。模型级 A/B 成本较高，后续只有在确实要改变默认检索预算时再单独开展。
