# 16-stream/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Stream`、`BaseStream` 与 `java.util.function` 基础接口。本文聚焦中间/终端操作分类、短路语义、函数式接口家族、lambda 作为 SAM 实例、流的主要创建方式，以及 Optional 的求值时机差异；惰性求值内部结构放到下一篇。
> 目标：把“Stream 接口全景与函数式接口”改写成一篇围绕“为什么 Stream 不只是几串链式 API，而是把惰性操作、终端触发和函数对象协议绑在一起”的机制文章，并把 lambda/Optional 都拉回这条主线。

## 1. 读者困惑

- `list.stream().map(...).filter(...).collect(...)` 看起来像连续方法调用，为什么中间大多数时候并没有立刻执行？
- 什么叫中间操作、终端操作、短路操作，它们对执行时机有什么实质差异？
- lambda 为什么能直接塞给 `map`、`filter`、`forEach`，这些函数参数背后到底是什么对象？
- `Stream.of`、`iterate`、`generate`、集合 `stream()` 创建出来的流，在使用边界上为什么差别这么大？
- Optional 的 `orElse` 和 `orElseGet` 看起来只差一个 Supplier，为什么实际性能和副作用风险会差这么多？

## 2. 一句话顿悟

**Stream 的核心不是“链式写法很优雅”，而是把数据处理拆成两层：前半段是一串惰性描述（中间操作），后半段是一颗真正按下开关的终端操作；而 lambda 之所以能塞进这些节点，是因为它们本质上都在接收 `Function`、`Predicate`、`Consumer`、`Supplier` 这类函数式接口实例。没有终端操作，前面的描述根本不会落地；没有函数式接口，链上的每个节点也无从承载转换、过滤和消费逻辑。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖中间/终端操作、短路分类、函数式接口四大族、lambda 的 invokedynamic 背景、流创建方式与 Optional 的 `orElse` / `orElseGet` 差异。
- 已抓到“没有终端操作，中间操作什么都不做”这个第一原理。
- 已把惰性机制内部实现留给下一篇，篇章边界合理。

### 必须重写

- 旧稿像 API 地图速览，需要先建立总问题：为什么 Stream 看似连环调用，前半段却并不真正执行。
- 函数式接口与 lambda 要服务于“这些中间节点拿什么承载逻辑”这条主线，而不是独立讲语言特性。
- Optional 应收束为“惰性 vs 立即求值”的补充案例，而不是单独扩题。
- 收尾要把 API 分类、函数接口、流创建和下一篇惰性内部结构更自然地串起来。

## 4. 理解路径

### 第一节：从“为什么不 collect 时什么都没发生”开场

用最常见困惑开场：写了 `stream().filter(...).map(...)` 但不加终端操作时，看起来像已经做完两步处理，实际什么副作用都没有。先立住总问题：链式调用并不等于立刻执行。

### 第二节：中间操作与终端操作真正差在哪

证据：
- `Stream.java:182`：`filter`
- `Stream.java:197`：`map`
- `Stream.java:283`：`flatMap`
- `Stream.java:372`：`distinct`
- `Stream.java:388`：`sorted`
- `Stream.java:441`：`peek`
- `Stream.java:468`：`limit`
- `Stream.java:497`：`skip`
- `Stream.java:555`：`takeWhile`
- `Stream.java:647`：`forEach`
- `Stream.java:757/797`：`reduce`
- `Stream.java:905/961`：`collect`
- `Stream.java:1027`：`count`
- `Stream.java:1048`：`anyMatch`
- `Stream.java:1108`：`findFirst`

主线：
- 中间操作返回的还是 Stream，本质是在往流水线上追加处理描述。
- 终端操作才真正触发求值，把之前的描述落实到元素消费上。
- “没有终端操作就不执行”应作为本文第一原理收束全篇。

### 第三节：为什么短路是另一层重要分类

证据：
- `Stream.java:468`：`limit`
- `Stream.java:555`：`takeWhile`
- `Stream.java:1048`：`anyMatch`
- `Stream.java:1108`：`findFirst`

主线：
- 短路中间操作和短路终端操作都在表达“结果足够确定时就不必再往后消费所有元素”。
- 这说明 Stream 的执行模型不是固定全量扫描，而是会受操作语义影响提早停下。

### 第四节：lambda 为什么能塞进 Stream 链——因为节点接收的是函数式接口实例

证据：
- `Function.java:40-41`
- `Predicate.java:39-40`
- `Consumer.java:41-42`
- `Supplier.java:40-41`
- `Stream.java:182` / `197` / `441` / `905`：这些操作分别消费 Predicate / Function / Consumer / Supplier

主线：
- lambda 不是“魔法匿名代码块”，而是 SAM 接口实例的语法糖。
- `filter` 要 Predicate，`map` 要 Function，`forEach` 要 Consumer，部分工厂与降级 API 要 Supplier。
- 这样就能把“链上每个节点拿什么承载逻辑”讲回到 Stream 主线里。

### 第五节：流的创建方式为什么决定了使用边界

证据：
- `BaseStream.java:113/125/138`：`sequential` / `parallel` / `unordered`
- `Stream.java:1159`：`of(T)`
- `Stream.java:1187`：`of(T...)`
- `Stream.java:1214`：`iterate`
- `Stream.java:1331`：`generate`
- `Stream.java:1374`：`concat`

主线：
- 集合/数组来源通常是有限源；iterate/generate 可以天然变成无限流。
- 这就是为什么无限流必须和 limit / takeWhile 等短路逻辑配合，否则“终端触发”会变成永远算不完。
- BaseStream 的 sequential/parallel/unordered 为后续执行策略埋钩子，但本文先点到为止。

### 第六节：Optional 为什么是本文的尾声案例——它把“惰性求值”暴露得最直白

证据：
- `Optional.java:354-368`：`orElse` / `orElseGet`

主线：
- `orElse` 参数会先求值，哪怕 Optional 非空也一样。
- `orElseGet` 把默认值延后到真正需要时再用 Supplier 计算。
- 这正好把 Supplier 家族和“惰性 vs 立即”再回钩一次，为下一篇讲内部惰性机制收束。

## 5. 失败方案清单

1. 写完一串中间操作就以为数据已经被处理了，却没有终端操作。
2. 把 `peek` 当业务副作用主通道，而不是调试观察点。
3. 对无限流使用普通终端操作，却不加任何短路约束。
4. 把 lambda 误解成没有接口类型的匿名代码块。
5. 在 `orElse` 里直接塞昂贵默认值计算，还以为非空时不会执行。
6. 把 parallel/sequential 之类 API 当成交错细节，不回到数据源与执行策略上理解。

## 6. 误解清单

1. Stream 链式写法意味着每个中间操作在调用点就已经执行。
2. 中间操作和终端操作只是“返回值不同”的分类。
3. lambda 比匿名类“快”，所以 Stream 才用它。
4. `peek` 和 `forEach` 都是消费，所以作用差不多。
5. `orElseGet` 只是写法更麻烦，没有本质语义差别。
6. 只要数据源是集合，Stream 就一定是有限且安全的。

## 7. 证据清单

- `Stream.java:182`：`filter`
- `Stream.java:197`：`map`
- `Stream.java:283`：`flatMap`
- `Stream.java:372`：`distinct`
- `Stream.java:388`：`sorted`
- `Stream.java:441`：`peek`
- `Stream.java:468`：`limit`
- `Stream.java:497`：`skip`
- `Stream.java:555`：`takeWhile`
- `Stream.java:647`：`forEach`
- `Stream.java:757/797`：`reduce`
- `Stream.java:905/961`：`collect`
- `Stream.java:1027`：`count`
- `Stream.java:1048`：`anyMatch`
- `Stream.java:1108`：`findFirst`
- `Stream.java:1159/1187`：`of`
- `Stream.java:1214`：`iterate`
- `Stream.java:1331`：`generate`
- `Stream.java:1374`：`concat`
- `BaseStream.java:113/125/138`：`sequential` / `parallel` / `unordered`
- `Function.java:40-41`
- `Predicate.java:39-40`
- `Consumer.java:41-42`
- `Supplier.java:40-41`
- `Optional.java:354-368`：`orElse` / `orElseGet`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 API 分类和函数式接口，不展开内部流水线节点与 Sink 链结构，那些放到下一篇。
- lambda 的 invokedynamic 背景只可作为点到说明，不把本篇变成字节码专题。
- Optional 只作为求值时机补充案例，不扩写成空安全总论。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么没有终端操作时中间链不会执行 → 中间/终端/短路操作如何区分 → lambda 为什么能承载 Stream 节点逻辑 → 数据源创建方式如何影响流的使用边界 → Optional 的 orElse/orElseGet 怎样回扣惰性求值”。
- 必须把 Stream 的 API 分类讲回惰性执行主线。
- 必须让函数式接口服务于 Stream 节点理解，而不是独立百科。
- 必须自然引到 `02-pipeline-lazy.md`。
