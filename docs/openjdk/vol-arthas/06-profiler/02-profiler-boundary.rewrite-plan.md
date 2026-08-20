# 02-profiler-boundary 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“采样 vs 插桩 / native 边界”重构成一篇围绕“为什么插桩观察和采样观察不是同一种问题，也不该由同一种工具回答”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- native 库怎么加载
- 插桩和采样有什么区别
- async-profiler 拿到哪些栈
- 火焰图怎么读
- 输出格式有哪些

这种边界点平铺的说明文。

更好的统一问题是：

**Arthas 已经能通过 ByteKit 在方法里插桩、用 OGNL 看对象、用 thread 看热点，那为什么它还需要 profiler / async-profiler 这条 native 采样链？反过来，既然 profiler 能画全局火焰图，为什么它又不能取代 trace/watch 这种插桩观察？**

这样本篇就不再是“采样与插桩差异介绍”，而会被收束成一条更硬的观察边界链：

- 插桩回答单次调用现场
- 采样回答时间窗口里的整体热点
- native 加载只是集成前提，不是采样问题本身
- 火焰图与 trace 树不是同一种时间语义
- 输出格式差异本质上是消费方式差异

## 2. 读者困惑

- watch/trace 已经能看到方法调用现场，为什么还要 profiler？
- profiler 已经能画火焰图，为什么还不能直接看参数和返回值？
- 为什么 Arthas 在 profiler 这里非得接 async-profiler 的 native 路径？
- 为什么火焰图的横轴不能当成时间线来读？
- 为什么 `thread -n`、profiler、trace、watch 往往要按顺序串起来？

## 3. 一句话顿悟

**插桩观察和采样观察回答的是两种不同的问题：插桩让你知道“这一次调用发生了什么”，代价是每次命中都要付出织入与求值成本；采样让你知道“在整个观察窗口里时间主要花在哪里”，代价是它只能给出统计估计而不是单次现场。Arthas 需要 profiler，是因为只有 native 采样链才能低侵入地覆盖 JVM/Java/native 的整体热点；它又不能替代 watch/trace，因为采样不会凭空长出参数、返回值和单次调用语义。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码与 async-profiler 集成实现讨论
- 聚焦采样 vs 插桩的观察边界，不展开更深的 async-profiler native 细节；那些属于 async-profiler 卷
- 不把 native library 临时复制问题误写成采样算法主线；这里只把它当成集成前提
- 这里讲的是 Arthas 使用 async-profiler 的观察边界，不等于所有 profiler 工具或所有字节码观察工具都如此分工

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“插桩是每次调用都知道，采样是固定时刻抽样”这个关键边界
- 已经有 native 加载、火焰图读法、事件路径、输出格式等关键事实
- 也有把 `thread -> profiler -> trace -> watch` 串起来的生产路径

### 5.2 必须修复的问题

- 当前骨架仍偏主题清单式说明，主问题不够集中
- 失败方案推演不够厚：为什么不能只用插桩、为什么不能只用采样，还没完全打透
- native 库加载和 async-profiler 栈采集事实很重要，但需要更明确地服务于“为什么要委托 native 采样”这条主线
- 火焰图和 trace 树的差异还可以更集中地收在“时间语义不同”这个判断上

## 6. 重写策略

本篇不按主题并列推进，而按更强的问题链组织：

1. 先建立冲突：既然 watch/trace 已经能看现场，为什么还要 profiler；反过来 profiler 为什么又不能替代它们
2. 先排除两个错误直觉：
   - 全都靠插桩观察
   - 全都靠 profiler 采样
3. 再给总图：thread 瞬时线程视角 → profiler 窗口级热点 → trace/watch 单次调用验证
4. 然后分层拆：
   - native 加载前提与“不是采样算法”的边界
   - 插桩观察和采样观察的成本模型差异
   - async-profiler 为什么能拿到 JVM / native / Java 栈
   - 火焰图为什么不是时间线
   - 输出格式为什么本质上是消费方式差异
5. 最后收束成“采样缩范围，插桩解释细节”的观察组合哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——watch/trace 已经能看现场了，为什么还要 profiler

目标：建立真实困惑，而不是直接讲 native。

要回答：

- 插桩已经能看到参数、返回值、异常和调用树
- 但 CPU 100% / 多线程整体热点时，这些现场证据仍可能不够
- 本篇真正要追的是“为什么需要另一条观察范式”

预估字数：900-1100

### 第二节：先排除两个错误直觉——全都靠插桩，或全都靠采样

目标：做失败方案推演。

要回答：

- 为什么不能把 every-call 插桩当成整体热点工具
- 为什么火焰图不能取代单次调用现场
- 真正需要的是：采样负责缩范围，插桩负责解释细节

预估字数：1400-1700

### 第三节：第一层——native 库加载问题为什么只是集成前提，不是采样问题本身

目标：把 native 加载与观察边界分开。

要回答：

- `profilerInstance()` 的临时复制解决了什么
- 为什么这是类加载身份和 stop/start 可重复性问题
- 为什么它不能被误讲成 profiler 采样本体

证据锚点：

- `ProfilerCommand.java:551-590`

预估字数：1300-1600

### 第四节：第二层——插桩观察和采样观察到底在回答什么不同问题

目标：把两种成本模型与证据形态写清楚。

要回答：

- watch/trace 回答的是“一次调用里发生了什么”
- profiler 回答的是“整个观察窗口里，时间主要花在哪里”
- 前者成本与调用次数和织入方法数相关
- 后者成本与采样频率、线程数和栈展开成本相关

预估字数：1800-2200

### 第五节：第三层——async-profiler 为什么能覆盖 JVM / Java / native 的整体热点

目标：把采样链能力写成“全景来源”而不是实现清单。

要回答：

- CPU / wall-clock / alloc / lock 分别可能走什么 native/JVMTI 路径
- 为什么这说明采样本身也不是单一路径
- Arthas 只把字符串交给 AsyncProfiler Java API，真正的多来源采样能力来自 native 内核

证据锚点：

- `async-profiler/src/cpuEngine.cpp` 等桥接锚点
- `vmEntry.cpp` / `perfEvents_linux.cpp` / `wallClock.cpp` 等

预估字数：1800-2200

### 第六节：第四层——火焰图为什么不是时间线，而 trace 树又为什么不是火焰图

目标：把两种可视化/输出语义差异收紧。

要回答：

- 火焰图横轴、纵轴各自表示什么
- 为什么宽块代表频度估计，不是单次耗时
- `--event` 变化后，同样形状为什么不能按同一种语义解释
- trace 树为什么更接近单次调用内部结构，而不是全局聚合

预估字数：1700-2100

### 第七节：第五层——输出格式为什么本质上是消费方式差异

目标：把 html / collapsed / tree / md 的边界写清楚。

要回答：

- html/flamegraph 给人看
- collapsed 给后续火焰图工具
- tree/JFR 相关输出解决什么消费方式
- Markdown 为什么是 Arthas 后处理，而不是 async-profiler 原生格式

证据锚点：

- `ProfilerCommand.processStopMarkdown()` 路径桥接

预估字数：1400-1800

### 第八节：收网——采样缩范围，插桩解释细节

目标：把全文收成一句话并桥接后续。

必须点名：

- thread 瞬时线程视角
- profiler 聚合热点视角
- trace/watch 单次调用视角
- native 采样与字节码插桩的组合关系
- 后续进入 async-profiler native 项目

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 只用插桩解释所有 CPU / alloc / lock 热点
2. 只用 profiler 解释单次调用参数和返回值
3. 把 native 库加载问题误当成采样算法问题
4. 把火焰图横轴当时间线
5. 把所有 profiler 输出格式当成同一种消费语义

## 9. 本篇必须明确澄清的误解

1. watch/trace 和 profiler 不是同类观察工具
2. profiler 提供的是统计热点，不是单次调用现场
3. `thread -n`、profiler、trace、watch 是递进关系，不是随意互换关系
4. 临时复制 native 库解决的是加载身份，不是采样能力
5. 火焰图、trace 树、Markdown 报告三者的消费语义不同

## 10. 证据清单（正文托底）

- `ProfilerCommand.java:551-590`
- 前置 `thread` / `trace` / `watch` / profiler 文章桥接
- async-profiler 卷里的关键锚点桥接
- `ProfilerCommand.processStopMarkdown()` 路径

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么插桩观察和采样观察不是一回事”
3. 是否至少展开了 4 个失败方案
4. 是否把 native 集成、采样能力、火焰图语义、格式消费统一到同一条观察边界主线上
5. 是否明确把更深 native 原理留给 async-profiler 卷
6. 是否完成 `file:line` 重核与边界声明
