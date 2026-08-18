# 02. 流水线结构与惰性机制 — Pipeline 链、Sink 链、求值时机

> **前置依赖**: [16-stream/01 — Stream 接口全景与函数式接口](01-stream-api-lambda.md)(中间/终端分类、lambda 机制)、[08-collections/01 — ArrayList](../08-collections/01-arraylist.md)(集合数据源)
> → **后续**: [16-stream/03 — 中间操作实现](03-intermediate-ops.md)
> 关联: 域 08 集合(数据源);域 04 反射(indy 引导);内部卷 13-jit-framework(分层编译)

## 一行链式调用,内存里是什么形状

`list.stream().filter(x -> x > 0).map(x -> x * 2).collect(toList())`——上一篇把操作分成了中间/终端两类。这一篇回答下一个问题: 这条链在内存里到底是什么?答案是**两条链**: 构建期的 **Pipeline 链**(静态结构,描述"有哪些操作"),求值期的 **Sink 链**(运行时消费管道,描述"数据怎么流过")。中间操作惰性的秘密就在这里: 链构建不触碰数据,求值才把两条链焊在一起。

## 1. "filter() 返回了什么" — Pipeline 链: 挂节点

### 1.1 链的四个字段

`AbstractPipeline`(`AbstractPipeline.java`,712 行)是 Pipeline 链的基类,链由三个引用串起来(行内注释为解释):

```java
// AbstractPipeline.java:82 + 88 + 101(字段声明截取,逐字,省略前置 @SuppressWarnings 注解行;行内注释为解释)
    private final AbstractPipeline sourceStage;      // 回溯到链头(自身即源时 = this)
    private final AbstractPipeline previousStage;    // 上游节点(源节点为 null)
    private AbstractPipeline nextStage;              // 下游节点(链接时被填充)
```

外加三个状态字段:

- `depth`(`:108`): 距源的中间操作数——`filter` 是 1,`map` 是 2
- `combinedFlags`(`:115`): 源与之前所有操作的标志合成(短路标记靠它传播,§4)
- `linkedOrConsumed`(`:135`): 本节点是否已被"链接或消费"

`list.stream()` 创建的是 `ReferencePipeline.Head`(`StreamSupport.java:67-72`): 头节点构造时用 `StreamOpFlag.fromCharacteristics(spliterator)` 从 Spliterator 的特性里提取源标志。

### 1.2 构造器: 链接即消费

每次中间操作都会 new 一个节点。节点构造器:

```java
// AbstractPipeline.java:201-214(逐字)
    AbstractPipeline(AbstractPipeline<?, E_IN, ?> previousStage, int opFlags) {
        if (previousStage.linkedOrConsumed)
            throw new IllegalStateException(MSG_STREAM_LINKED);
        previousStage.linkedOrConsumed = true;
        previousStage.nextStage = this;

        this.previousStage = previousStage;
        this.sourceOrOpFlags = opFlags & StreamOpFlag.OP_MASK;
        this.combinedFlags = StreamOpFlag.combineOpFlags(opFlags, previousStage.combinedFlags);
        this.sourceStage = previousStage.sourceStage;
        if (opIsStateful())
            sourceStage.sourceAnyStateful = true;
        this.depth = previousStage.depth + 1;
    }
```

三个动作: ① 前驱若已被链接/消费,直接抛 `IllegalStateException`("stream has already been operated upon or closed",消息常量在 `:74`);② 把前驱标记为已链接,并把**前驱的** `nextStage` 指向自己;③ 算自己的 `depth`/`combinedFlags`/`sourceStage`。

这解释了经典报错:

```java
// 用法示意(API 形式,非源码片段)
Stream<String> s = list.stream();
s.filter(x -> x.length() > 0);   // 首次: 把 s(头节点)标记为已链接
s.filter(x -> x.length() > 0);   // 第二次: 构造器检查到 s 已链接 → IllegalStateException
```

链式写法 `list.stream().filter(...).map(...)` 没问题——每次操作的是**上一个操作返回的新节点**,而不是已被消费的头节点。

### 1.3 filter: 只 new 一个节点

`filter` 的实现(`ReferencePipeline.java:162-182`)——除了参数判空和 new 一个 `StatelessOp`,什么都没干(操作配方省略,§2.3 全量展示):

```java
// ReferencePipeline.java:162-165(构造部分截取,逐字)
    public final Stream<P_OUT> filter(Predicate<? super P_OUT> predicate) {
        Objects.requireNonNull(predicate);
        return new StatelessOp<P_OUT, P_OUT>(this, StreamShape.REFERENCE,
                                     StreamOpFlag.NOT_SIZED) {
            ...
        };
    }
```

谓词此刻**一次都没执行**。链的形状(以 `filter → map → collect` 为例):

```
 list.stream()          filter()             map()               collect()
      │                    │                    │                    │
   Head 节点  ──next──▶ filter 节点 ──next──▶ map 节点 ──(终端不进链)──▶ TerminalOp
      ▲                    ▲                    ▲
      └────── sourceStage/previousStage 回溯指针(每个节点都指回源头)
```

终端操作(collect/toList)不创建 Pipeline 节点——它是另一个体系(TerminalOp,§3)。

关键设计(斜体):*中间操作 = 往链上挂节点——每次调用只 new 一个 Pipeline 节点、链上指针、O(1) 构建,不触碰任何数据。面试"为什么说 Stream 是懒的": 链构建期零执行,元素直到终端操作才流动;面试画"链条"图(源 → op1 → op2 → 终端),能画出双向指针 + depth 计数就是完整答案。*

## 2. "数据怎么穿过每个操作" — Sink 链: 消费管道

### 2.1 Sink 协议: begin → accept × N → end

Pipeline 链是"静态图纸",真正让元素流动的是 **Sink**——一个带生命周期协议的 Consumer。契约写在 `Sink.java:33-51` 的 Javadoc 里(摘录): 调 `accept` 前必须先调 `begin(size)`(数据要来了,可选告知数量),全部数据送完后调 `end()`;Sink 有 initial ↔ active 两个状态,`begin` 进入 active、`end` 回到 initial 可复用。

接口默认实现(三个方法分散,行内注释标注行号):

```java
// Sink.java:128 + 138 + 147-149(逐字;行内注释标注对应行号)
    default void begin(long size) {}      // :128  数据到来前回调
    default void end() {}                 // :138  数据送完回调
    default boolean cancellationRequested() {   // :147  默认不取消
        return false;
    }
```

### 2.2 ChainedReference: 把下游攥在手里

中间操作的 Sink 都继承 `Sink.ChainedReference`(`Sink.java:244` 起): 构造时接收下游 Sink 存进 `downstream` 字段,`begin/end/cancellationRequested` 全部委托给下游——链式结构就是这么来的:

```java
// Sink.java:244-249(逐字)
    abstract static class ChainedReference<T, E_OUT> implements Sink<T> {
        protected final Sink<? super E_OUT> downstream;

        public ChainedReference(Sink<? super E_OUT> downstream) {
            this.downstream = Objects.requireNonNull(downstream);
        }
```

### 2.3 操作 → Sink: opWrapSink

每个中间操作在自己的 Pipeline 节点里实现 `opWrapSink(flags, sink)`——把"下游 sink"包成"带本操作语义的 sink"。filter 的:

```java
// ReferencePipeline.java:167-180(逐字)
            Sink<P_OUT> opWrapSink(int flags, Sink<P_OUT> sink) {
                return new Sink.ChainedReference<P_OUT, P_OUT>(sink) {
                    @Override
                    public void begin(long size) {
                        downstream.begin(-1);
                    }

                    @Override
                    public void accept(P_OUT u) {
                        if (predicate.test(u))
                            downstream.accept(u);
                    }
                };
            }
```

过滤语义就藏在 `accept` 里: 谓词通过才传给下游。`begin(-1)` 是向下游传"大小未知"——过滤后剩几个元素只有天知道。

map 的:

```java
// ReferencePipeline.java:191-199(逐字)
            Sink<P_OUT> opWrapSink(int flags, Sink<R> sink) {
                return new Sink.ChainedReference<P_OUT, R>(sink) {
                    @Override
                    public void accept(P_OUT u) {
                        downstream.accept(mapper.apply(u));
                    }
                };
            }
```

### 2.4 wrapSink: 反向包裹,拼出整条消费链

组装发生在终端求值时——`wrapSink` 从**最深处的 Pipeline 节点**出发,沿 previousStage 一路反向,每步把自己的 Sink 包在现有链条外面:

```java
// AbstractPipeline.java:518-525(逐字)
    final <P_IN> Sink<P_IN> wrapSink(Sink<E_OUT> sink) {
        Objects.requireNonNull(sink);

        for ( @SuppressWarnings("rawtypes") AbstractPipeline p=AbstractPipeline.this; p.depth > 0; p=p.previousStage) {
            sink = p.opWrapSink(p.previousStage.combinedFlags, sink);
        }
        return (Sink<P_IN>) sink;
    }
```

反向包裹的结果——**先构造下游、再包上游**,最外层的 sink 就是链头的第一个操作:

```
终端 sink(collect 容器) ←─ map 的 accept 包一层 ←─ filter 的 accept 包一层
                                                          │
                源 Spliterator.forEachRemaining(最外层 filter sink) 驱动数据流
```

关键设计(斜体):*"操作 → Sink"是惰性 → 执行的转换点: 中间操作只提供 opWrapSink 的"配方",终端触发时才按配方把整条 Sink 链反向组装;数据从源头 Spliterator 单遍流过每条 Sink——无状态链不建任何中间集合(空间 O(1))。面试"数据被处理几次": 单遍;面试"Sink 和 Pipeline 的关系": Pipeline 描述结构(有哪些操作),Sink 描述消费行为(数据怎么流)。*

## 3. "求值时机" — 终端按下开关

### 3.1 evaluate: 终端入口

绝大多数终端操作最终都调 `evaluate(terminalOp)`——唯一例外是 `toArray`,它走 `evaluateToArrayNode`(`AbstractPipeline.java:244-262`),串行分支最终同样落在 `wrapAndCopyInto` 上(`:550`):

```java
// AbstractPipeline.java:226-235(逐字)
    final <R> R evaluate(TerminalOp<E_OUT, R> terminalOp) {
        assert getOutputShape() == terminalOp.inputShape();
        if (linkedOrConsumed)
            throw new IllegalStateException(MSG_STREAM_LINKED);
        linkedOrConsumed = true;

        return isParallel()
               ? terminalOp.evaluateParallel(this, sourceSpliterator(terminalOp.getOpFlags()))
               : terminalOp.evaluateSequential(this, sourceSpliterator(terminalOp.getOpFlags()));
    }
```

串行分支: `terminalOp.evaluateSequential(this, sourceSpliterator(...))`——`sourceSpliterator` 从链头取出数据源,取完置 null(`AbstractPipeline.java:397-410`,源只被消费一次)。

终端操作自己提供链底的 sink: collect 走 `ReduceOps.makeRef(collector)`(`ReduceOps.java:155-156`),求值时先 `makeSink()` 建容器 sink 再灌:

```java
// ReduceOps.java:911-914(逐字)
        public <P_IN> R evaluateSequential(PipelineHelper<T> helper,
                                           Spliterator<P_IN> spliterator) {
            return helper.wrapAndCopyInto(makeSink(), spliterator).get();
        }
```

ForEachOps 更极端——`ForEachOp` 自己就是 Sink(`ForEachOps.java:127-128`,`implements TerminalOp<T, Void>, TerminalSink<T, Void>`),`evaluateSequential` 直接把 `this` 塞进去(`:146-149`)。

### 3.2 wrapAndCopyInto: 组装 + 单遍遍历

`wrapAndCopyInto`(`AbstractPipeline.java:473-476`)两步走: wrapSink 组装 → copyInto 驱动:

```java
// AbstractPipeline.java:473-476(逐字)
    final <P_IN, S extends Sink<E_OUT>> S wrapAndCopyInto(S sink, Spliterator<P_IN> spliterator) {
        copyInto(wrapSink(Objects.requireNonNull(sink)), spliterator);
        return sink;
    }
```

`copyInto` 就是完整生命周期——**begin → forEachRemaining → end**,短路标志决定走不走取消路径:

```java
// AbstractPipeline.java:479-490(逐字)
    final <P_IN> void copyInto(Sink<P_IN> wrappedSink, Spliterator<P_IN> spliterator) {
        Objects.requireNonNull(wrappedSink);

        if (!StreamOpFlag.SHORT_CIRCUIT.isKnown(getStreamAndOpFlags())) {
            wrappedSink.begin(spliterator.getExactSizeIfKnown());
            spliterator.forEachRemaining(wrappedSink);
            wrappedSink.end();
        }
        else {
            copyIntoWithCancel(wrappedSink, spliterator);
        }
    }
```

### 3.3 全景: collect(toList()) 按下开关后

```
collect(toList())                        // ReferencePipeline.java:568
  └─ ReduceOps.makeRef(collector)        // 建 TerminalOp(ReduceOps.java:155)
  └─ evaluate(op)                        // AbstractPipeline.java:226
      └─ evaluateSequential              // ReduceOps.java:911
          └─ makeSink()                  // 终端 sink(链底,collect 容器)
          └─ wrapAndCopyInto            // AbstractPipeline.java:473
              ├─ wrapSink               // 反向组装 filter/map 的 Sink
              └─ copyInto               // begin(大小) → forEachRemaining → end
                  └─ 源 Spliterator.tryAdvance 逐个拉元素 → 灌进最外层 Sink
```

类注释的原话(`AbstractPipeline.java:57-65`,摘录): "the source data is not consumed until a terminal operation begins"——数据在终端操作开始前从未被消费。顺带一提: 绕开终端操作直接 `stream.iterator()` 也是惰性的——非头节点走 `wrap(...)`(`:366-368`)包一个惰性 Spliterator,元素照样按需拉取。

关键设计(斜体):*求值 = "链组装 + 单遍遍历"——中间操作构建期零执行成本,全部成本在终端。面试"collect 前发生了什么": 只有链构建,直到 evaluate 数据才流动;面试"惰性有什么好处": 短路(§4)、无限流、免中间集合。*

## 4. "惰性的收益" — 短路与无限流

### 4.1 SHORT_CIRCUIT: 短路标记

`StreamOpFlag`(`StreamOpFlag.java`,753 行)里定义了一个特殊标志:

```java
// StreamOpFlag.java:326-328(逐字)
    // 12, 0x01000000
    SHORT_CIRCUIT(12,
                  set(Type.OP).set(Type.TERMINAL_OP));
```

`IS_SHORT_CIRCUIT`(`:628-630`)是注入位。谁注入它:

- **中间**: limit 系(`SliceOps.java:543-545`)——注意是**带 limit 才注入**,纯 skip 不注入;takeWhile(`WhileOps.java:50`)
- **终端**: anyMatch/allMatch/noneMatch(`MatchOps.java:218-219`)、findFirst/findAny(`FindOps.java:130`)

标志沿构造器里的 `combineOpFlags`(`AbstractPipeline.java:209`)一路合成进每个节点的 `combinedFlags`;终端标志在 `evaluate` 时经 `sourceSpliterator(terminalOp.getOpFlags())` 并入最后一段(`AbstractPipeline.java:447-450`)。

### 4.2 取消传播: 每轮拉取前先问一句

`copyInto` 检查到短路标志就走 `copyIntoWithCancel`(`AbstractPipeline.java:492-505`)——沿 previousStage 走回头节点,调 `forEachWithCancel`:

```java
// ReferencePipeline.java:125-129(逐字)
    final boolean forEachWithCancel(Spliterator<P_OUT> spliterator, Sink<P_OUT> sink) {
        boolean cancelled;
        do { } while (!(cancelled = sink.cancellationRequested()) && spliterator.tryAdvance(sink));
        return cancelled;
    }
```

**每拉一个新元素之前,先问 Sink 链要不要取消**。`cancellationRequested()` 默认 false(`Sink.java:147-149`),`ChainedReference` 委托下游(`:262-264`),终点是各操作的 Sink: limit 的切片 Sink 计数归零即取消(`SliceOps.java:186-208` 区间,截取):

```java
// SliceOps.java:186-187 + 206-208(截取,逐字;行内注释标注对应行号)
                    long n = skip;
                    long m = limit >= 0 ? limit : Long.MAX_VALUE;   // 186-187
...
                    @Override
                    public boolean cancellationRequested() {        // 206
                        return m == 0 || downstream.cancellationRequested();
                    }
```

findFirst 的 `FindSink` 拿到值就取消(`FindOps.java:185-188`):

```java
// FindOps.java:185-188(逐字)
        @Override
        public boolean cancellationRequested() {
            return hasValue;
        }
```

### 4.3 无限流为什么不死循环

`Stream.iterate(seed, f)`(`Stream.java:1214`)返回的是 `Spliterators.AbstractSpliterator(Long.MAX_VALUE, ORDERED|IMMUTABLE)`——一个**按需生成**的 Spliterator,`tryAdvance` 才计算下一个值:

```java
// 用法示意(API 形式,非源码片段)
Stream.iterate(0, n -> n + 1)     // 惰性序列: 不被拉就不生成
    .filter(x -> x % 2 == 0)      // 谓词在 accept 里,拉一个测一个
    .limit(3)                     // 注入 SHORT_CIRCUIT;m 归零请求取消
    .findFirst()                  // FindSink 有值即取消
```

`forEachWithCancel` 的循环保证: 拉→测→findFirst 命中→`cancellationRequested` 返回 true→循环终止。三个要素缺一不可——**惰性生成(iterate)+ 标志传播(combinedFlags)+ 每轮检查(forEachWithCancel)**。

关键设计(斜体):*短路 = "提前终止传播"——短路操作注入 SHORT_CIRCUIT 标志,combinedFlags 合成后,遍历循环每轮检查 cancellationRequested,任一环节请求取消即停。面试"无限流为什么不死循环": 惰性 + 短路;面试"短路操作有哪些": limit/takeWhile(中间)、findFirst/anyMatch/allMatch/noneMatch(终端,分类见 01 篇 §1.2)。*

跨层标注: [域 08 集合——数据源是集合的 Spliterator,`Collection.stream()` 直接走 `StreamSupport.stream(spliterator, false)`(`Collection.java:710-712`);域 04 反射 / 域 01 字符串(03-build-concat)——filter/map 的谓词与函数是 invokedynamic 引导的 lambda,执行期可被 JIT 内联]

## 核心悬念

链与惰性通了——**每个中间操作怎么实现**?filter 包装 Sink 已经看过,那 sorted 为什么"有状态"(要缓存全部元素再排序)?distinct 用什么去重?limit 怎么精确切片?takeWhile 怎么靠 SHORT_CIRCUIT 停住?——下一篇: 中间操作实现。

> → [16-stream/03 — 中间操作实现](03-intermediate-ops.md)
