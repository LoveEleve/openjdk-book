# 03-allocation-events 重写规划

> 状态：deep review 完成，待修订同步
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Java alloc vs native malloc 路径说明”重写成一篇围绕“看到‘谁在分配’这个问题时，为什么 async-profiler 必须把 JVM 对象分配、outside-TLAB、live object 与 native malloc/free 拆成多条来源链”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成“AllocTracer 一段、ObjectSampler 一段、MallocTracer 一段”的并列盘点。真正的统一问题是：**当用户说‘我想知道内存是谁涨出来的’，他实际上混合了 Java 对象分配、JVM 外/内 TLAB、live object 存活视角、native malloc/free 四个不同问题；而 async-profiler 只能把这些问题分解成多条来源链，最后再统一到记录后端。**

本篇要避免两个极端：

- 把 `alloc` 统一讲成 `ObjectSampler` 的 JVM 采样分配通知；
- 把 `alloc` 统一讲成 `AllocTracer` 的 trap 路径，或把 `nativemem` 讲成 Java alloc 的附属视图。

## 2. 读者困惑

- “谁在 new” 与 “谁在 malloc” 为什么不是同一个问题？
- `event=alloc` 为什么有时走 JVMTI SampledObjectAlloc，有时又退回 HotSpot AllocTracer trap？
- `outside-TLAB`、`live object` 与普通 allocation sample 是同一种事件吗？
- `--live` 为什么不是简单过滤，而是另一套存活对象跟踪和 stop 时 dump 逻辑？
- `MallocTracer` 为什么既会写 sample，又会写 event-only free？
- 为什么同样叫“内存热点”，Java 对象分配与 native malloc 的采样精度和来源语义完全不同？

## 3. 一句话顿悟

**async-profiler 在“内存是谁涨出来的”这个问题上，至少维护了两大来源家族：JVM 对象分配家族通过 ObjectSampler / AllocTracer / live refs 跟踪对象创建与存活；native memory 家族通过 malloc/free hooks 追踪库层分配与释放。它们统一的是记录后端，不是来源语义，更不是同一种精度承诺。**

总图：

```text
Java object allocation family
  → selectAllocEngine()
    ├─ ObjectSampler / J9ObjectSampler
    ├─ AllocTracer (fallback / trap)
    └─ LiveRefs / LIVE_OBJECT dump

Native memory family
  → MallocTracer hooks
    ├─ malloc/calloc/realloc/aligned_alloc sample path
    └─ free event-only path

Both
  → recordSample / recordExternalSamples / recordEventOnly
```

## 4. 版本与范围边界

- 基于当前 async-profiler 源码；重点是 allocation 来源语义，不是输出格式。
- `selectAllocEngine()` 决定 JVM alloc 前端；ObjectSampler 不是所有 JVM/所有模式的固定主入口。
- `AllocTracer` 依赖 HotSpot 内部符号和 trap；不能外推成所有 JDK 都保证可用。
- `--live` 的语义包含 weak ref 跟踪、GC start 重置和 stop 时 dump，不只是“保留存活对象”。
- `nativemem` 通过 malloc/free hooks 观察 native 分配，不等于 Java alloc 的另一种显示格式。
- free 事件当前走 `recordEventOnly()`；不能写成“每次 free 都有完整调用栈样本”。

## 5. 现稿方法论差距审计

- 开场已经区分 Java 对象与 native malloc，但整体仍偏对象清单，缺少“用户以为是一个问题，源码其实拆成多条来源链”的主冲突。
- `ObjectSampler` 讲得太像固定主路径，缺少 `selectAllocEngine()` 的选择条件。
- `AllocTracer` 章节没有把 trap 命中、字节累计阈值和 `recordAllocation()` 时序拆开。
- `--live` 只被描述为“建立存活对象引用跟踪”，缺少 `LiveRefs` 的弱引用表、GC start 重置、stop 时 `dumpLiveRefs()` 的完整链。
- native memory 章节没有突出 malloc sample 路径与 free event-only 路径的语义差异。
- 还缺“同样是内存热点，但 Java alloc 和 native malloc 的输入上下文、计量对象、回收语义不同”的收网。

## 6. 重写策略

1. 用“堆在涨，native RSS 也在涨，但它们未必是同一来源”的事故场景开篇。
2. 推演并否定：所有内存增长都能靠一个 `alloc` 事件解决；`--live` 只是普通过滤；malloc/free 与对象分配是同一种事件。
3. 给出两大家族总图：JVM object allocation vs native memory。
4. 分层讲：
   - `selectAllocEngine()` 如何决定 JVM alloc 前端；
   - ObjectSampler 的 JVMTI 路径与 live refs；
   - AllocTracer 的 trap 路径与 outside-TLAB；
   - MallocTracer hooks 的 sample/free 差异；
   - 最后统一回到记录后端，但保留语义与精度边界。
5. 收网时明确：内存热点的“来源问题”必须先回答，输出聚合只是最后一步。

## 7. 结构大纲

### 第一节：事故开场——堆在涨，RSS 也在涨，但“谁在分配”根本不是一个问题

回答：Java heap 与 native malloc 增长为何需要分家；为什么本篇不是简单讲一个 alloc engine。

预估字数：900-1100

### 第二节：先排除四个错误直觉——一个 alloc 事件解决全部、ObjectSampler 永远主路、`--live` 只是过滤、free 也会生成完整 sample

预估字数：1500-1900

### 第三节：第一层——`selectAllocEngine()` 先决定 JVM 对象分配到底走哪条前端

证据：`profiler.cpp:798-805`。

回答：sample objects capability、OpenJ9、AllocTracer fallback 的条件。

预估字数：1400-1700

### 第四节：第二层——ObjectSampler：JVMTI SampledObjectAlloc + live refs + stop dump

证据：`objectSampler.cpp:134-193`。

回答：heap sampling interval、recordAllocation、LiveRefs、GC start、dumpLiveRefs、LIVE_OBJECT 外部样本。

预估字数：1900-2300

### 第五节：第三层——AllocTracer：trap 命中不等于每次都记 sample

证据：`allocTracer.cpp:21-122`。

回答：符号版本探测、TLAB/outside-TLAB、`frame.ret()`、`updateCounter()` 之后才 `recordAllocation()`、`--live` 在旧 JDK 上的限制。

预估字数：1800-2200

### 第六节：第四层——MallocTracer：malloc sample 与 free event-only 不是同一种记录

证据：`mallocTracer.cpp:35-97`、`:214-254`。

回答：各种 malloc 家族 hook、nested malloc 检测、patchLibraries、recordMalloc vs recordFree、`_nofree` 边界。

预估字数：1800-2200

### 第七节：第五层——统一后端不抹平来源语义与精度承诺

证据：`objectSampler.cpp:121`、`:153-156`、`allocTracer.cpp:96`、`mallocTracer.cpp:221`、`:231`。

回答：recordSample / recordExternalSamples / recordEventOnly 的不同入口；Java alloc 与 native malloc 的不同计量对象和回收语义。

预估字数：1500-1800

### 第八节：收网——先回答“涨的是哪类内存”，再谈火焰图上谁最宽

桥接 lock/wall 篇。

预估字数：800-1000

## 8. 必须展开的失败方案

1. 所有内存增长都能用一个 `alloc` 事件看懂。
2. `ObjectSampler` 永远是 JVM alloc 主路径。
3. `--live` 只是 allocation 结果上的普通过滤条件。
4. trap 命中就等于一定记录了一条 allocation sample。
5. native free 也会像 malloc 一样生成完整 sample。

## 9. 证据清单

- `src/profiler.cpp:798-805`
- `src/objectSampler.cpp:32-129`
- `src/objectSampler.cpp:134-193`
- `src/allocTracer.cpp:21-122`
- `src/mallocTracer.cpp:35-97`
- `src/mallocTracer.cpp:152-254`
- 必要时补 `j9ObjectSampler.cpp` 的 OpenJ9 路径边界

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“Java object family vs native memory family”。
2. 至少展开 4 个失败方案。
3. 不把 ObjectSampler/AllocTracer/MallocTracer 写成同一种精度语义。
4. 明确 `--live` 的 stop dump 与 LIVE_OBJECT 外部样本。
5. 明确 malloc sample 与 free event-only 的区别。
6. 每个 `file:line` 重新核对，链接与禁用词通过。
