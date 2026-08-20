# 13-atomic/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Striped64`、`LongAdder`。本文聚焦 `base` / `cells` / `cellsBusy`、`Cell`、`longAccumulate`、`sum()` 与 `@Contended`；不展开 LongAccumulator/DoubleAdder 过多分支和底层 CPU 指令细节证明。
> 目标：把“Striped64 与 LongAdder”改写成一篇围绕“为什么单点 CAS 在高竞争下会失速，以及 LongAdder 如何把一个热点计数器拆成多个槽位来分流竞争”的机制文章，并把伪共享与弱一致读的代价讲清楚。

## 1. 读者困惑

- AtomicLong 已经无锁了，为什么高并发计数还要 LongAdder？
- LongAdder 是不是“更强的 AtomicLong”，还是换了语义？
- `base` 和 `cells` 分别承担什么角色，什么时候从一个数变成多个格子？
- `cellsBusy` 为什么需要，它是锁吗？
- 每个线程怎么挑自己的 Cell，冲突了又怎么扩容？
- 为什么 `sum()` 不是原子快照，却在统计场景里仍然可用？
- `@Contended` 到底防的是什么，为什么 Cell 要专门加它？

## 2. 一句话顿悟

**LongAdder 不是去把单个 CAS 变得更强，而是把“所有线程争抢同一个值”这个问题本身拆掉：无竞争时大家仍然碰 `base`，一旦争用出现，就把更新分流到多个 `Cell` 槽位上，各线程大概率只 CAS 自己的格子；读的时候再把 `base + cells` 求和，因此它用空间和弱一致读取换来了高竞争下更高的写吞吐。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `base` / `cells` / `cellsBusy`、`Cell` + `@Contended`、`LongAdder.add` 路径、`longAccumulate`、`sum()` 弱一致。
- 已触及 probe、NCPU 上限和伪共享。
- 已把下一篇自然引到引用原子与 FieldUpdater。

### 必须重写

- 旧稿层次很多，容易像源码导读清单；需要先立住“单点 CAS 为什么会失速”这个统一问题。
- 第一篇的 AtomicInteger 心智应自然承接到“单点热点”问题，再过渡到 Striped64 的分片设计。
- `base` / `cells` 应讲成“性能阶梯”，不是平铺字段介绍。
- `@Contended` 需要更紧地围绕“数组里的多个 Cell 会共享缓存行”来讲，避免泛泛而谈缓存行。
- `sum()` 的弱一致要和“为什么它适合统计、不适合同步控制”绑在一起。

## 4. 理解路径

### 第一节：从 AtomicLong 的失败模式开场

先承接上一章：AtomicLong 的每次更新都围绕一个共享值做 CAS。高竞争下失败重试频繁，CPU 花在“抢同一个点”上。

主线：LongAdder 不是改良 CAS，而是规避热点。

### 第二节：Striped64 的三块状态到底想解决什么

证据：
- `Striped64.java:52-116`：类注释（动态分片、cellsBusy、probe、NCPU 上限）
- `Striped64.java:152-169`：`NCPU` / `cells` / `base` / `cellsBusy`
- `Striped64.java:180-192`：`casBase` / `casCellsBusy`

主线：
- `base`：低竞争快路径，像 AtomicLong 一样。
- `cells`：高竞争分片区域，真正分流热点。
- `cellsBusy`：只在初始化/扩容/挂新格子时短暂充当自旋锁。

### 第三节：Cell 为什么像“迷你 AtomicLong”，还必须加 `@Contended`

证据：
- `Striped64.java:118-149`：`Cell`
- `Striped64.java:59-66`：类注释解释为什么数组里的原子对象更需要 padding

主线：
- Cell 只有一个 `volatile long value` 和一个 CAS 方法，本质是简化版原子 long 槽位。
- 它们会装进数组，天然相邻；若不 padding，就可能把多个高频写槽位塞进同一缓存行，形成伪共享。
- `@Contended` 的意义是把“不同 Cell 看起来不共享但实际共享缓存行”的问题物理隔开。

### 第四节：LongAdder.add 的路径为什么是“性能阶梯”

证据：
- `LongAdder.java:80-94`：`add`
- `Striped64.java:228-298`：`longAccumulate`
- `Striped64.java:199-213`：`getProbe` / `advanceProbe`

主线：
- 一级：`cells == null` 且 `casBase` 成功 → 单点更新，最快。
- 二级：已有 `cells`，命中自己的 Cell 且 CAS 成功 → 分片更新，常态高吞吐路径。
- 三级：槽位为空、CAS 失败或碰撞严重 → 进入 `longAccumulate`，负责初始化表、挂新 Cell、扩容或换 probe 重试。

强调：大多数请求不是每次都走慢路径；慢路径是为把系统拉回“多数线程各写各格子”的稳定态。

### 第五节：longAccumulate 到底做哪几件事

证据：
- `Striped64.java:228-235`：probe 初始化
- `Striped64.java:240-259`：挂新 Cell
- `Striped64.java:262-264`：现有 Cell CAS
- `Striped64.java:269-278`：扩容 `cells`
- `Striped64.java:281-292`：初始化 `Cell[2]`
- `Striped64.java:98-107` / `152-153`：NCPU 上限语义

主线：
- 第一次 contention 才从 `base` 升级到 `cells[2]`。
- 之后按当前线程 probe 选槽位；槽位为空则尝试挂新 Cell；槽位冲突严重则扩容；CAS 失败后 probe 变换，相当于二次哈希避让。
- `cells` 大小上限和 CPU 数相关，因为格子数超过核心数后收益迅速减弱。

### 第六节：为什么 `sum()` 注定是弱一致

证据：
- `LongAdder.java:110-128`：`sum`
- `LongAdder.java:130-166`：`reset` / `sumThenReset` 可作为弱一致边界辅助

主线：
- `sum()` 只是把 `base` 和所有非空 Cell 逐个加起来，没有停世界，也没有冻结写入。
- 因此它不是原子快照；并发更新正在发生时，部分写入可能来不及被纳入。
- 这就是 LongAdder 不适合“精确同步控制”的原因，但非常适合监控统计、频次计数等最终一致就够的场景。

### 第七节：LongAdder 与 AtomicLong 的真正选型边界

- 低竞争或需要每次精确读取：AtomicLong / AtomicInteger
- 高竞争写多读少统计：LongAdder
- 需要自定义结合运算：LongAccumulator（可略点为后续知识延展）

强调：LongAdder 快不是免费午餐，它用空间、实现复杂度和弱一致读换吞吐。

## 5. 失败方案清单

1. 在高竞争计数场景继续使用单点 AtomicLong，却期待吞吐线性扩展。
2. 把 LongAdder 当成“任何场景都比 AtomicLong 更好”的升级版。
3. 用 LongAdder.sum() 作为严格同步判断条件。
4. 忽略 `@Contended` 和伪共享，以为多个 Cell 只要逻辑上不同就不会互相拖慢。
5. 误以为 `cellsBusy` 是常驻粗粒度锁，而不是只在结构调整时短暂抢占。

## 6. 误解清单

1. LongAdder 的快来自某种更强的 CPU 原子指令。
2. LongAdder 一开始就有很多 Cell。
3. `sum()` 返回的一定是所有线程此刻最新值的精确快照。
4. 伪共享等同于两个线程写同一个变量。
5. `@Contended` 只是“锦上添花”的性能注解，没有结构性意义。
6. `cells` 无限扩容会一直线性提升吞吐。

## 7. 证据清单

- `Striped64.java:52-116`：类注释（动态分片、contended、cellsBusy、probe）
- `Striped64.java:118-149`：`Cell` + `@Contended`
- `Striped64.java:152-169`：`NCPU` / `cells` / `base` / `cellsBusy`
- `Striped64.java:180-192`：`casBase` / `casCellsBusy`
- `Striped64.java:199-213`：`getProbe` / `advanceProbe`
- `Striped64.java:228-298`：`longAccumulate`
- `LongAdder.java:40-54`：类注释（高竞争吞吐更高、空间开销更大）
- `LongAdder.java:80-94`：`add`
- `LongAdder.java:97-107`：`increment` / `decrement`
- `LongAdder.java:110-128`：`sum`
- `LongAdder.java:130-166`：`reset` / `sumThenReset`

## 8. 版本与边界

- 基于 JDK 11。
- 不展开 DoubleAdder/LongAccumulator 的完整实现细节，只在需要时点到“分片要求运算可结合”。
- 不做完整 CPU 缓存一致性证明，只把伪共享讲到足以支撑 `@Contended` 的设计必要性。
- 不在本文展开 ConcurrentHashMap 里的 LongAdder 组合用法，只提示是典型统计场景。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“AtomicLong 的问题是单点 CAS 热点 → Striped64 用 base + cells 分片 → contention 触发表初始化/扩容/换 probe → Cell 因数组相邻需 `@Contended` 防伪共享 → LongAdder 读用 sum 聚合，因此是弱一致”。
- 必须明确 LongAdder 不是更强原子性，而是更高写吞吐。
- 必须把 `sum()` 的弱一致与统计场景绑定，不能只说“不精确”。
- 必须说明 `@Contended` 的必要性来自数组中 Cell 的物理相邻。
- 结尾要自然引到 `03-reference-updater.md`。
