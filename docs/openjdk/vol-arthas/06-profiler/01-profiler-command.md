# 15. Arthas 明明有自己的命令系统，为什么 profiler 却不自己采样？——ProfilerCommand、字符串协议与 async-profiler 委托链

> 基于 `arthas` 当前源码与 async-profiler 集成实现讨论；本文聚焦 Arthas profiler 命令层，不展开 async-profiler native 采样引擎细节；那些属于后续边界篇和 async-profiler 卷。
> **前置依赖**：[15 —— 同一套表达式引擎，为什么在不同命令里会做完全不同的事？](../05-ognl-expression/02-express-usage.md)：知道 Arthas 已经能通过插桩、表达式和对象观察回答很多方法级问题。
> → **后续**：Profiler native 边界——采样引擎、perf/JVMTI 与输出格式。
> 关联域：AsyncProfiler Java API、native library 加载、Markdown 后处理。
> 本篇所有源码锚点均已回对，不靠猜。

## 先看真正的冲突：Arthas 明明有自己的命令系统，为什么 profiler 却不自己采样

场景：你执行：

```text
profiler start --event alloc --timeout 30s -f /tmp/result.html
```

30 秒后拿到火焰图。对使用者来说，这看起来像 Arthas 自己完成了：

- 参数解析；
- 采样；
- 调用栈收集；
- 火焰图输出。

于是一个极其自然的直觉就会出现：

> Arthas 既然已经有自己的命令系统、自己的 attach 入口、自己的类加载隔离和自己的输出模型，那 profiler 应该也是它自己实现的一套采样引擎吧？

这恰恰是最需要先打掉的误解。

Arthas 在 profiler 这里做的，并不是“再造一套采样器”，而是：

```text
用户友好的 Arthas CLI
  → ProfilerCommand 解析和编排
    → async-profiler action,key=value 字符串协议
      → AsyncProfiler Java API
        → native profiler 库
```

所以本篇真正要回答的不是：

> ProfilerCommand 有哪些 action、哪些参数？

而是：

> **Arthas 明明有自己的命令系统、自己的 attach 入口和自己的输出模型，为什么到了 profiler 这里却不自己实现采样，而是要把用户命令翻译成 async-profiler 的字符串协议，再把结果包装回来？**

这张图里最重要的一刀就是：

```text
Arthas profiler 是命令翻译层
async-profiler 才是采样引擎本体
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除几个最直觉、也最容易把边界讲坏的方案

### 1. 在 Arthas 里再实现一套采样引擎

最直觉的方案当然是：

- 既然 Arthas 已经能 attach；
- 也已经能增强字节码；
- 那干脆自己再做一套 CPU / alloc / lock / JFR 采样链。

这看起来“统一”，实际上会让 Arthas 陷入重复造轮子的泥潭：

- 一套 native 栈收集；
- 一套 perf/JVMTI/信号处理；
- 一套 JFR / flamegraph / collapsed 输出；
- 一套平台兼容性、权限和性能边界。

而 async-profiler 本来就在专门解决这些事情。

所以更理智的做法不是“在 Arthas 里再造一个 profiler”，而是：**把 Arthas 擅长的命令入口、会话编排和结果包装，与 async-profiler 擅长的采样引擎本体接起来。**

### 2. 看到 15 个 profiler action，就以为有 15 套独立实现

`ProfilerAction` 的动作很多：start、resume、stop、dump、status、meminfo、list、version、load、execute、dumpCollapsed、dumpFlat、dumpTraces、getSamples、actions。

很容易让人误会成：

> profiler 在 Arthas 里有 15 套不同能力实现。

但这些动作大多最终还是在把用户意图翻译给同一套 AsyncProfiler Java API / native 协议。也就是说，动作数量反映的是 Arthas 命令入口的分派面，不是 native 引擎数量。

### 3. 把所有选项和格式都原样丢给 native

另一个极端是：

> 既然 async-profiler 才是引擎，那 Arthas 就别加自己的生命周期和输出语义，全部透传好了。

这也不对。因为 Arthas 的价值恰恰在于：

- 对用户提供更友好的 CLI；
- 在命令层做自动文件、duration 调度；
- 对 Markdown 这种非 native 原生格式做额外后处理。

所以“完全自己做”和“完全不做”都不对。Arthas 真正做的是：**不碰采样引擎本体，但在命令入口与结果消费层做增值。**

---

## 二、第一层：ProfilerAction 为什么只是入口枚举，而不是实现边界

### 2.1 15 个动作首先表达的是命令入口的分派面

`ProfilerCommand` 的命令声明在 `core/command/monitor200/ProfilerCommand.java:48-71`。而 `ProfilerAction` 枚举位于 `ProfilerCommand.java:595-604`，包含：

- start
- resume
- stop
- dump
- status
- meminfo
- list
- version
- load
- execute
- dumpCollapsed
- dumpFlat
- dumpTraces
- getSamples
- actions

这些动作首先解决的是：**用户希望在 Arthas 命令行里以多少种姿势发起 profiler 行为。**

### 2.2 为什么动作分派不等于引擎分派

`ProfilerCommand.process()` 在 `ProfilerCommand.java:746-751` 先把用户输入转成动作枚举，再分流：

- `actions`：列出支持的 Arthas 动作；
- `execute`：原样透传 async-profiler 字符串命令；
- `start` / `resume`：拼启动参数；
- `stop` / `dump`：停止或转储结果；
- `version` / `status` / `meminfo` / `list`：请求 profiler 当前信息；
- `dumpCollapsed` / `dumpFlat` / `dumpTraces` / `getSamples`：调用 AsyncProfiler 对应 API。

这里的关键是：动作分派主要决定“怎么翻译用户意图”，而不是“进入哪个独立采样实现”。

关键设计（斜体）：*ProfilerAction 是命令层入口枚举，不是采样能力边界枚举。*[模式: 命令分派 + 委托入口] 动作多，说明 Arthas CLI 入口丰富；不说明 native 里就有同样数量的实现分叉。

---

## 三、第二层：`executeArgs()` 为什么是整个 profiler 命令层的核心翻译器

### 3.1 真正的核心不是某个 action，而是“怎么把 CLI 翻成协议”

`executeArgs(ProfilerAction)` 在 `ProfilerCommand.java:606-734`。它做的不是采样本身，而是把用户选项统一拼成 async-profiler 能理解的：

```text
action,key=value,...
```

例如：

```text
start,event=alloc,file=/tmp/result.html,interval=10,threads,
```

这一步非常关键，因为它说明 Arthas profiler 的核心工作不是“自己采样”，而是“把更友好的 CLI 折叠成引擎理解的协议字符串”。

### 3.2 为什么大部分选项是透传，但不是所有选项都能原样透传

`executeArgs()` 收集的 `@Option` 很多：

- `event`、`alloc`、`live`、`lock`
- `jfrsync`
- `interval`、`jstackdepth`、`threads`
- `clock`、`cstack`、`sched`、`signal`
- `include`、`exclude`
- `begin`、`end`、`wall`
- `title`、`minwidth`、`reverse`、`total`
- `chunksize`、`chunktime`、`loop`、`timeout`

这意味着 Arthas 尽量不重新定义参数语义，而是把大部分选项直接翻译成 async-profiler 协议。

### 3.3 为什么 `jfrsync` 和 Markdown 正好暴露了命令层增值边界

`jfrsync` 在 `ProfilerCommand.java:627-630` 会自动把 `format` 设为 `jfr`。这说明“同步 JFR”不是 native 猜出来的，而是 Arthas 命令层理解了用户意图，再翻译成对应格式。

Markdown 更能说明边界。`isMarkdownFormat()` 成立时，`executeArgs()` 不会把 `file` 和 `format=md` 原样透传给 async-profiler（`:631-642`），而是让 Arthas 在 stop 路径里自己做 collapsed → Markdown 的后处理。

关键设计（斜体）：*大多数参数直接透传，少数格式和生命周期由 Arthas 在命令层增值。*[模式: 协议翻译 + 特殊格式适配] Arthas 不改写采样引擎，却也不只是“无脑转发器”。

---

## 四、第三层：`AsyncProfiler.execute()` 与 `profilerInstance()` 如何把命令层接到 native 内核

### 4.1 为什么命令层真正触碰的采样入口只有 Java API

`ProfilerCommand` 引入的是：

```java
one.profiler.AsyncProfiler
```

对应 `ProfilerCommand.java:38-40`。实际执行统一经过静态 `execute()`（`ProfilerCommand.java:736-744`）：

```java
String result = asyncProfiler.execute(arg);
```

这说明对 Arthas 命令层来说，真正的采样入口并不是“直接碰 native 库的每一个细节”，而是 AsyncProfiler 提供的 Java API 桥。

### 4.2 为什么 `profilerInstance()` 本身也体现了“命令层不是引擎层”

`profilerInstance()` 在 `ProfilerCommand.java:551-590`：

- 已经有 profiler 实例就复用；
- `load` action 可从指定路径加载；
- 如果有 native library 路径，先复制到临时文件，再调用 `AsyncProfiler.getInstance(libPath)`（`:561-580`）；
- 只支持 Linux/Mac，其它系统直接不支持（`:582-585`）。

这里临时复制 native library 的目的，是规避多次 attach、不同 ClassLoader 重复加载同一路径 `.so` 时出现的 `Native Library already loaded in another classloader` 风险。

这恰好再次说明：Arthas 在 profiler 这里解决的是**命令层集成问题和类加载问题**，不是采样算法问题。

关键设计（斜体）：*命令层负责把 Java API 和 native 库稳定接进来，但不接管 native 引擎内部的采样职责。*[模式: Java API 桥接 + 加载身份适配]

---

## 五、第四层：`--timeout`、`--duration`、Markdown 为什么正好暴露了委托边界

### 1. `--timeout` 为什么属于 native 参数语义

`start` 路径在 `ProfilerCommand.java:766-821`。`--timeout` 会被拼进 async-profiler 的参数串，由 native profiler 负责在到时后自动停止。

也就是说，`--timeout` 不是 Arthas 自己定时去 stop，而是：

```text
Arthas 翻译成协议
  → native profiler 自己按参数完成超时停止
```

### 2. `--duration` 为什么是 Arthas 的命令层增值

`--duration` 则不同。它会：

1. 先执行 start；
2. 再由 Arthas 自己的 scheduled executor 安排延时任务；
3. 到时间异步调用 `processStop(asyncProfiler, stop)`（`ProfilerCommand.java:797-819`）。

这说明 `--duration` 并不是 native 语义，而是 Arthas 额外提供的命令编排能力：让用户不必一直盯着会话，也能在未来某个时刻自动停。

### 3. 为什么 Markdown 再次证明 Arthas 不是纯透传器

普通 stop 走 `processStop()`（`ProfilerCommand.java:878-910`）：

- 复用或生成输出文件；
- 拼 `stop/dump` 参数；
- 调 async-profiler；
- 把结果包装成 `ProfilerModel`。

Markdown stop 则走 `processStopMarkdown()`（`ProfilerCommand.java:912-959`）：

1. 创建临时 collapsed 文件；
2. 暂时把格式改成 collapsed；
3. 调 native profiler 输出 collapsed 文本；
4. 读出文本后删除临时文件；
5. 在 Arthas 侧调用 `ProfilerMarkdown.toMarkdown(...)` 转成 Markdown；
6. 再决定是写文件还是回到模型。

关键设计（斜体）：*`--timeout`、`--duration`、Markdown 三者正好划出了 native 语义与 Arthas 增值语义的边界。*[模式: 原生参数语义 + 命令层编排/后处理]

这条边界如果讲不清，就很容易把“Arthas 提供的便利能力”和“async-profiler 本体能力”混成一锅。

---

## 收网：Arthas 不是在做另一套 profiler，而是在做命令入口、协议翻译和结果包装

现在把整条链收成一张图：

```text
用户输入 Arthas 风格 profiler 命令
  → ProfilerAction 决定命令层入口分派
    → executeArgs() 把 CLI 折叠成 async-profiler 字符串协议
      → AsyncProfiler Java API
        → native profiler 引擎真正采样
          → Arthas 再按需要做 duration 调度、Markdown 后处理和结果模型包装
```

把这张图压成一句话，就是：

**Arthas 的 profiler 命令不是另一套采样引擎，而是一个协议翻译层：它把更友好的 Arthas CLI 与生命周期能力，翻译成 async-profiler 理解的 `action,key=value,...` 字符串，再通过 AsyncProfiler Java API 进入 native 采样内核；采样本体仍属于 async-profiler，Arthas 负责的是命令编排、加载适配和结果包装。**

到这里为止，主线其实只发生了四件事：

- 15 个动作是命令入口面，不是 15 套采样实现；
- `executeArgs()` 是整个 profiler 命令层的核心翻译器；
- Java API / native 加载桥解决的是集成问题，不是采样算法问题；
- `--timeout`、`--duration`、Markdown 三者正好暴露了委托边界。

这也解释了为什么 Arthas 在 profiler 这里没有自己重复实现采样：**真正有价值的不是再造一套引擎，而是把 Arthas 擅长的命令入口和 async-profiler 擅长的 native 采样能力稳稳接起来。**

跨层标注：[AR-2 ByteKit——插桩观察与 profiler 采样不是同一条能力链]；[AsyncProfiler Java API——Arthas 真正触碰的采样入口]；[native library 加载——临时复制解决的是类加载身份问题]；[Markdown 后处理——Arthas 命令层的增值输出]

本篇解决的是“为什么 Arthas profiler 只是翻译器，而不是采样引擎本体”。下一篇继续进入真正的边界问题：**插桩观察和采样观察到底各自适合回答什么，哪些问题不能混着看，又为什么 async-profiler 的 native 路径天然更擅长整体热点而不是调用现场？**

**→ 下一篇：采样 vs 插桩，以及 async-profiler 的 native 边界。**
