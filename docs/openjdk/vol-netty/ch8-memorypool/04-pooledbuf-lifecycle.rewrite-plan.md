# Ch8-04 PooledByteBuf 生命周期 rewrite plan

## 一句话困惑

同样都是 `release()`，为什么池化 `ByteBuf` 的收尾远不只是把引用计数减到 0；它到底在把什么归还给谁，为什么派生视图还要刻意颠倒“先释放资源、再回收对象”的直觉顺序？

## 一句话顿悟

池化 `ByteBuf` 结束生命周期时，真正要回收的是两套彼此独立、但必须按正确顺序衔接的资源：底层内存要回到 Arena/Chunk/Subpage 体系，对象外壳要回到 Recycler；而派生视图之所以先 recycle 自己再 release parent，是为了防止对象池复用把“对哪个 parent 做 release”这件事搞错。

## 读者困惑与文章目标

读者到 Ch8-03 为止，已经知道 small/normal 内存如何被切出来，也知道 ThreadCache 试图让高频路径少碰 Arena 锁。但还有三个关键问题没有闭环：

1. 当 `PooledByteBuf` 用完时，内存具体怎么回去？
2. `slice()`、`retainedSlice()`、`duplicate()` 这些共享底层内存的视图，为什么不会把 parent 提前释放？
3. 如果业务代码忘了 `release()`，到底泄漏的是“对象”、还是“底层 run/subpage 元素”、还是两者都会卡住？

本文目标是把“池化分配”收束成“池化生命周期”，为下一章进入 Bootstrap 之前，把 ByteBuf 这条资源线真正闭环。

## 依赖声明

```text
本篇
├── HARD 前置：ch4-bytebuf/01-dual-index-and-refcnt.md
├── HARD 前置：ch4-bytebuf/04-views-and-zerocopy.md
├── HARD 前置：ch8-memorypool/01-allocator-and-arena.md
├── HARD 前置：ch8-memorypool/02-chunk-and-buddy.md
├── HARD 前置：ch8-memorypool/03-subpage-and-threadcache.md
├── SOFT 复用：ch6-promise/01-state-model-and-listeners.md（引用计数状态式阅读习惯）
├── NAV 导航：ch9-bootstrap/01-...（后续 bind 时这些资源第一次汇总被用起来）
└── COMPARE：UnpooledHeapByteBuf / UnpooledDirectByteBuf 的非池化释放路径
```

## 结构设计

### 1. 开场困惑：分配已经讲完了，为什么生命周期还没闭环
- 从 `alloc.buffer()` 很快、`release()` 看似简单切入。
- 点出前 3 篇讲的是“怎么借出来”，这一篇讲“怎么还回去”。
- 预埋核心结论：池化 ByteBuf 结束时有两份资源要归还。
- 预计 800-1000 字。

### 2. 失败方案推演：如果把池化回收想成一次普通 free，会错在哪里
- 失败方案 A：把 `PooledByteBuf` 当成 `UnpooledHeapByteBuf`，以为 `deallocate()` 只做一件事。
- 失败方案 B：以为对象和底层内存是一体资源，可以随便选顺序释放。
- 失败方案 C：以为派生视图释放时直接 `parent.release()` 最自然。
- 用这些失败方案引出“双归还”和“派生链顺序”的必要性。
- 预计 1200-1600 字。

### 3. 主线一：`PooledByteBuf.deallocate()` 的双归还
- 讲 `handle`、`chunk`、`memory`、`cache` 在 buf 活着时分别代表什么。
- 顺着 `release() -> refCnt=0 -> deallocate()` 解释：先 `arena.free(...)` 归还内存，再 `recyclerHandle.unguardedRecycle(this)` 归还对象。
- 明确这是“底层内存池”和“对象池”分离，不是同一套池。
- 结合前文 Arena free 三态/ThreadCache 回收路径做文字图。
- 回答“为什么先 free memory 再 recycle 对象”。
- 预计 1800-2200 字。

### 4. 主线二：和 `UnpooledHeapByteBuf` 对照，为什么 pooled 的代价更高
- 对照 `UnpooledHeapByteBuf.deallocate()` 的 `freeArray(array)`。
- 点明 unpooled 只有底层数组/直接内存的退出路径，没有对象复用池与 handle 回程票。
- 回答“为什么 pooled 快的前提是生命周期更讲究”。
- 预计 900-1200 字。

### 5. 主线三：派生视图为什么必须沿 parent 链逐层退场
- 讲 `retainedSlice()` / `retainedDuplicate()` 走 `AbstractPooledDerivedByteBuf.init(...)` 先 `wrapped.retain()`。
- 讲每个派生对象都有自己的 refCnt，但共享 root parent 内容。
- 解释 `deallocate()` 中“先抓本地 parent 引用、清空 parent/rootParent、recycle 自己、再 parent.release()` 的真实目的：防止对象池复用后对错误 parent 调用 release，同时让 leak detection 不再被旧引用链拖住。
- 区分 retained 派生对象与 non-retained 视图：后者把引用计数委托给 referenceCountDelegate，不拥有单独的 parent 释放义务。
- 预计 1800-2200 字。

### 6. 主线四：忘记 release 时，卡住的不只是一个 Java 对象
- 说明 `ResourceLeakDetector.track()` 只是追踪器，真正的泄漏后果是 refCnt 不归零，`PooledByteBuf.deallocate()` 根本不会走。
- 于是 `arena.free(...)` 不执行，run/subpage elem 无法回池；`recyclerHandle.unguardedRecycle(this)` 也不会执行，对象外壳同样回不去。
- 结合 `SimpleLeakAwareByteBuf.release()`、`closeLeak()`、`trackForcibly()` 讲检测与生命周期的关系。
- 强调泄漏检测是补救观察，不是回收机制本身。
- 预计 1200-1600 字。

### 7. 主线五：是否要展开 `AdaptivePoolingAllocator`
- 只做边界说明，不扩成第二条主线。
- 当前 Adaptive allocator 确实存在，但它有独立的 `AdaptiveByteBuf/Chunk/Magazine` 生命周期，不复用 `PooledByteBuf` 这套 `arena.free + recyclerHandle` 主体叙事。
- 因此本篇只在边界节说明“并存，不混讲”，防止大纲把两个体系揉在一起。
- 预计 500-800 字。

### 8. 收网与桥接
- 回收全文：池化生命周期的关键词不是 `release()` 三个字，而是“引用计数归零后，两套资源按正确顺序退场”。
- 回答开头困惑。
- 桥接下一章：Bootstrap 把 allocator、Channel、EventLoop、Pipeline 第一次装配成活系统，届时这些被借出的 ByteBuf 才开始大规模流动。
- 预计 500-700 字。

## 证据清单（待在正文中使用）

- `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:173`
- `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:50`
- `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:62`
- `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:85`
- `buffer/src/main/java/io/netty/buffer/PooledSlicedByteBuf.java:43`
- `buffer/src/main/java/io/netty/buffer/PooledDuplicatedByteBuf.java:41`
- `buffer/src/main/java/io/netty/buffer/UnpooledHeapByteBuf.java:547`
- `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40`
- `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:143`
- `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:186`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:253`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:266`
- `buffer/src/main/java/io/netty/buffer/AdaptivePoolingAllocator.java:254`

## 误解清单

1. `release()` 只是在减引用计数，真正的内存回收由 GC 负责。
2. `slice()`/`duplicate()` 既然共享底层内存，就一定共享同一个引用计数对象。
3. 派生对象释放时先 `parent.release()` 才符合“先释放资源、再回收对象”的常识。
4. Leak detector 发现泄漏后会帮助把底层 run 或 subpage 元素回收掉。
5. `AdaptivePoolingAllocator` 是 `PooledByteBufAllocator` 的简单升级版，因此可以直接套用同一套生命周期描述。

## 边界清单

- 本篇只讨论当前 Netty 中 `PooledByteBuf` / `AbstractPooledDerivedByteBuf` 这一支生命周期，不把 `AdaptiveByteBuf` 混进主线。
- 本篇不重讲 `PoolArena.free(...)` 的 small/normal/huge 分流细节，只复用 Ch8-01~03 已建立的模型。
- 本篇不展开 direct 内存最终如何交给 JDK cleaner/unsafe 释放，那是非池化 direct 路径或更底层平台话题。
- 泄漏检测讲的是“如何发现没有 release”，不是 JVM 级内存分析工具总览。
