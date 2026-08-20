# 01-profiler-command 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“ProfilerCommand 如何拼接 async-profiler 参数串”重构成一篇围绕“为什么 Arthas profiler 只是协议翻译层，而不是另一套采样引擎”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `ProfilerAction` 有哪些值
- `executeArgs()` 怎么拼参数
- `start` / `stop` / `dump` 怎么分支
- `Markdown` 怎么特殊处理
- `profilerInstance()` 怎么加载 native 库

这种按命令实现细节平铺的说明文。

更好的统一问题是：

**Arthas 明明有自己的命令系统、自己的 attach 入口和自己的输出模型，为什么到了 profiler 这里却不自己实现采样，而是要把用户命令翻译成 async-profiler 的字符串协议，再把结果包装回来？**

这样本篇就不再是“ProfilerCommand 导览”，而会被收束成一条更硬的委托链：

- 用户面对的是 Arthas 风格 CLI
- 采样引擎本体却在 async-profiler native 库里
- Arthas 做的是协议翻译、生命周期便利化和结果模型包装
- 少数格式与停止语义由 Arthas 额外增值，而不是改写采样引擎本体

## 2. 读者困惑

- 为什么 `profiler start --event cpu` 不是 Arthas 自己实现采样？
- 为什么 profiler 会有 15 个动作，却不等于 15 套独立实现？
- 为什么 `executeArgs()` 要把用户选项拼成一条字符串协议？
- 为什么 `--timeout`、`--duration`、`--format md` 这些选项不能简单理解为“都交给 native”或“都由 Arthas 处理”？
- 为什么 Arthas 一方面说自己是命令入口，另一方面又要复用 async-profiler 的 Java API 和 native 库？

## 3. 一句话顿悟

**Arthas 的 profiler 命令并不是另一套采样引擎，而是一个协议翻译层：它把更友好的 Arthas CLI 与生命周期能力，翻译成 async-profiler 理解的 `action,key=value,...` 字符串，再调用 AsyncProfiler Java API 进入 native 采样内核；采样本体、事件处理和输出文件生成仍属于 async-profiler，Arthas 负责的是外层命令编排、结果包装和少数格式的后处理。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码与 async-profiler 集成实现讨论
- 聚焦 Arthas ProfilerCommand 命令层，不展开 async-profiler native 采样引擎细节；那些属于后续边界篇和 async-profiler 卷
- 不把 Markdown 输出或 duration 调度写成 async-profiler 原生能力
- 这里讲的是 Arthas 如何“委托采样”，不等于所有 profiler 工具都采用字符串协议翻译层

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“Arthas 不负责采样，它负责把命令翻译出去”这个关键边界
- `ProfilerAction`、`executeArgs()`、`AsyncProfiler.execute()`、Markdown 特殊路径和 `--timeout`/`--duration` 分工都讲到了
- native library 临时复制的类加载器问题也有锚点

### 5.2 必须修复的问题

- 当前骨架仍偏“命令实现说明文”，主问题还不够集中
- 失败方案推演不够厚：为什么不直接在 Arthas 里实现采样、为什么不让所有参数都原样透传、为什么 Markdown 不该交给 native，都还没打透
- 15 个动作和字符串协议之间的关系还可以收得更紧
- `profilerInstance()` / 加载临时文件这层与“命令翻译器”主线的关系还可以更明确

## 6. 重写策略

本篇不按实现函数顺序推进，而按更强的问题链组织：

1. 先建立冲突：Arthas 有自己的命令系统，但 profiler 却不自己实现采样
2. 先排除几个错误直觉：
   - Arthas 直接自己做采样引擎
   - 每个 profiler action 都是一套独立实现
   - 所有参数与格式都原样交给 native
3. 再给总图：Arthas CLI → ProfilerCommand → 字符串协议 → AsyncProfiler Java API → native profiler
4. 然后分层拆：
   - ProfilerAction 为什么只是入口枚举
   - `executeArgs()` 为什么是协议翻译器
   - `ProfilerCommand.execute()` / `profilerInstance()` 如何把命令层接到 Java API 和 native 库
   - `--timeout` / `--duration` / `Markdown` 为什么体现了委托边界
5. 最后收束成“外层命令编排 + 内层 native 采样”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——Arthas 明明有自己的命令系统，为什么 profiler 却不自己采样

目标：建立真实困惑，而不是直接列动作枚举。

要回答：

- 用户面对的是 Arthas CLI
- 但最终却要进入 async-profiler native 库
- 本篇真正要追的是：为什么 Arthas 选择当“翻译器”，而不是再造一套采样引擎

预估字数：900-1100

### 第二节：先排除几个错误直觉——自己实现采样、15 个动作 = 15 套实现、所有参数都丢给 native

目标：做失败方案推演。

要回答：

- 为什么不该在 Arthas 里重复实现 CPU/perf/JVMTI/JFR 采样链
- 为什么 profiler 的 15 个动作不是 15 套不同引擎
- 为什么有些选项必须由 Arthas 增值或截断，而不是 native 统一解决

预估字数：1400-1700

### 第三节：第一层——ProfilerAction 为什么只是入口枚举，不是实现边界

目标：把动作系统写成命令层分派，不是能力层复制。

要回答：

- `ProfilerAction` 有哪些动作
- `process()` 为什么按动作分派
- 为什么分派后的大多数路径最后仍然会收束到同一条协议翻译与 Java API 调用链

证据锚点：

- `ProfilerCommand.java:595-604`
- `ProfilerCommand.java:746-751`
- `ProfilerCommand.java:736-744`（桥接回指）

预估字数：1500-1800

### 第四节：第二层——`executeArgs()` 为什么是整个 profiler 命令层的核心翻译器

目标：把字符串协议写成主冲突解法。

要回答：

- 为什么要把 CLI 选项拼成 `action,key=value,...`
- 哪些选项是直接透传的
- `jfrsync` 为什么会强制设置 `format=jfr`
- Markdown 为什么不能原样透传给 native
- 为什么这说明 Arthas 做的是协议翻译，而不是采样实现

证据锚点：

- `ProfilerCommand.java:606-734`
- `ProfilerCommand.java:627-642`

预估字数：1900-2300

### 第五节：第三层——`profilerInstance()` 与 `AsyncProfiler.execute()` 如何把命令层接到 native 采样内核

目标：把 Java API / native 加载桥接层写清楚。

要回答：

- `one.profiler.AsyncProfiler` 为什么是命令层唯一真正触碰的采样入口
- `execute()` 为什么统一走 Java API，而不是在 ProfilerCommand 里做 native 逻辑
- 为什么 native library 需要临时复制以规避类加载器冲突
- 这层与“翻译器而非引擎”主线的关系是什么

证据锚点：

- `ProfilerCommand.java:38-40`
- `ProfilerCommand.java:736-744`
- `ProfilerCommand.java:551-590`

预估字数：1800-2200

### 第六节：第四层——`--timeout`、`--duration`、Markdown 为什么正好暴露了委托边界

目标：把命令编排和 native 能力边界写成最强证据。

要回答：

- `--timeout` 为什么属于 async-profiler 参数语义
- `--duration` 为什么是 Arthas 的调度器增值
- `processStop()` 和 `processStopMarkdown()` 为什么体现了“同一 native 结果，两种消费方式”
- 为什么 Markdown 明确不是 async-profiler 原生格式

证据锚点：

- `ProfilerCommand.java:766-821`
- `ProfilerCommand.java:878-959`

预估字数：1900-2300

### 第七节：收网——Arthas 不是在做另一套 profiler，而是在做命令入口、协议翻译和结果包装

目标：把全文收成一句话并桥接下一篇。

必须点名：

- Arthas CLI
- 字符串协议
- AsyncProfiler Java API
- native profiler
- Markdown / duration 这类额外命令层能力
- 下一篇边界：采样 vs 插桩 / native 原理

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 在 Arthas 里再实现一套采样引擎
2. 把 15 个 profiler action 误解成 15 套独立实现
3. 把所有格式和选项都原样透传给 native
4. 把 Markdown 当成 async-profiler 原生格式
5. 把 `--duration` 和 `--timeout` 当成同一层负责的自动停止机制

## 9. 本篇必须明确澄清的误解

1. Arthas profiler 不是采样引擎本体
2. ProfilerCommand 的动作分派不等于 native 能力分派
3. `executeArgs()` 的字符串协议是集成边界，不是历史包袱
4. `--timeout` 与 `--duration` 分属 native 和 Arthas 两层生命周期
5. Markdown 是 Arthas 后处理，不是 async-profiler 原生格式
6. native library 的临时复制解决的是类加载器和加载身份问题，不是采样算法问题

## 10. 证据清单（正文托底）

- `ProfilerCommand.java:38-40`
- `ProfilerCommand.java:48-71`
- `ProfilerCommand.java:551-590`
- `ProfilerCommand.java:595-604`
- `ProfilerCommand.java:606-734`
- `ProfilerCommand.java:627-642`
- `ProfilerCommand.java:736-744`
- `ProfilerCommand.java:746-751`
- `ProfilerCommand.java:766-821`
- `ProfilerCommand.java:878-959`

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么 Arthas profiler 只是翻译器，而不是引擎本体”
3. 是否至少展开了 4 个失败方案
4. 是否把动作分派、协议拼接、Java API 调用、native 委托统一到同一条命令翻译链上
5. 是否明确保留 Markdown / duration / timeout 的层次边界
6. 是否完成 `file:line` 重核与边界声明
