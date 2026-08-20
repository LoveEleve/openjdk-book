# 流水线结构与惰性机制：为什么中间操作不碰数据，直到终端操作把两条链焊在一起

> 本文基于 JDK 11 `AbstractPipeline`、`ReferencePipeline`、`Sink`、`ReduceOps`、`ForEachOps`。讨论范围聚焦 Pipeline 链、Sink 链、`evaluate`、`wrapSink`、`copyInto` / `copyIntoWithCancel`、`opWrapSink` 与终端触发；并行路径和具体中间/终端实现细节放到后续篇章。
> **前置依赖**：[Stream 接口全景与函数式接口](01-stream-api-lambda.md)、[集合与数据源基础](../08-collections/01-arraylist.md)
> **后续**：[中间操作实现](03-intermediate-ops.md)

## 先看一个最容易让人嘴上说“Stream 是惰性的”，心里却仍当成立刻执行的疑问

上一章已经把最表层的事实立住了：中间操作惰性，终端操作触发求值。可如果继续追问一句——`list.stream().filter(...).map(...).sorted()` 这串调用在内存里到底长什么样？为什么它明明调用了这么多方法，却在 `collect()` 之前完全没扫一遍数据？如果答不上来，那“Stream 惰性”这句话其实还只是口号。

真正的答案不是“JVM 很聪明，先忍着不执行”，而是 Stream 从设计上就把构建期和执行期拆成了两套不同结构：

- 构建期是一条 **Pipeline 链**，它只记录“有哪些操作、前后关系是什么、标志怎么合成”；
- 执行期则是一条 **Sink 链**，它才负责“元素来了以后，怎样一层层过滤、映射、消费”。

这就是 Stream 惰性的真正秘密：**前半段连环调用只是挂节点，真正按元素流动要等终端操作把这张静态图翻译成一条运行时消费管道。**

所以这篇不只是继续证明它“惰性”，而是要把惰性拆开成一个可见结构：Pipeline 链像图纸，Sink 链像管道；终端操作一来，两者才被焊在一起。

## 一、为什么中间操作只是“挂节点”：Pipeline 链本质上是一张静态图纸

### 先看它到底记了什么，而不是做了什么

`AbstractPipeline` 是整条 Stream 流水线的骨架，定义在 `AbstractPipeline.java:72`。最关键的几个字段是：

- `sourceStage`（`AbstractPipeline.java:82`）
- `previousStage`（`88`）
- `nextStage`（`101`）
- `sourceSpliterator`（`123`）
- `linkedOrConsumed`（`135`）

这组字段看起来很像普通链表，但它们真正表达的不是“元素已经在流动”，而是“**这条流从哪来、前后有哪些阶段、源还在不在、这条管线是不是已经被接上或消费掉了**”。

也就是说，Pipeline 链更像一张数据处理图纸，而不是一条已经开始输送元素的管道。

### 为什么构造器只做连接，不碰元素

中间阶段节点构造器在 `AbstractPipeline.java:201-213`。它最重要的动作是：

- 检查前驱是否已经 `linkedOrConsumed`
- 把前驱标成已链接
- 把前驱的 `nextStage` 指向当前新节点
- 计算 `combinedFlags`、`depth`、`sourceStage`

这里最值得停下来看的是：**它完全没有读取源 Spliterator 的元素。** 也就是说，`filter()`、`map()` 这些方法在构造期真正做的，并不是处理数据，而是把“后面要做这个操作”登记到链上，并顺便维护一些和执行策略相关的元信息。

这就解释了为什么下面这种代码会抛异常：

```java
Stream<String> s = list.stream();
s.filter(x -> x.length() > 0);
s.filter(x -> x.length() > 0);
```

因为在第一次 `filter` 时，头节点就已经被标记为 `linkedOrConsumed`，你不能再拿同一条原始流去重新挂另一条链。这不是防御式小细节，而是在明确告诉你：**一条 Stream 不是一个可反复随意拼装的容器，它是一张一旦接线就不可回头重布的图纸。**

### `filter` / `map` 为什么证明了“节点注册”而不是“数据处理”

看 `ReferencePipeline.filter()`（`ReferencePipeline.java:162-167`）和 `map()`（`186-191`），你会发现构造阶段最重要的动作就是 new 一个新的 `StatelessOp` 节点，再把当前阶段 `this` 作为前驱传进去。逻辑函数虽然已经作为参数传入，但它此刻并没有作用在任何元素上。

这说明中间操作调用时完成的，主要是两件事：

- 把“要做什么逻辑”存进新节点；
- 把节点接到前一阶段后面。

而不是“现在就把所有元素过滤一遍再保存结果”。

这一层必须讲透，因为它让读者真正接受一个反直觉事实：**Stream 链的大部分方法调用发生时，数据根本还没开始流动。**

## 二、为什么 Pipeline 链还不够：执行期必须再生成一条真正消费元素的 Sink 链

### 先看为什么“图纸”不能直接执行

Pipeline 链记录了有哪些阶段，但它还不直接告诉你：当一个元素真的来到这里，应该先做什么、后做什么、有没有必要提前停下。静态节点描述和运行时逐元素消费，是两件事。

这就是 `Sink` 要解决的问题。`Sink` 在 `Sink.java` 的 Javadoc 一开头就把协议讲得很清楚：一个 sink 在真正接收元素前，会先 `begin(size)`；元素进来时不断 `accept()`；结束后再 `end()`；必要时还可以通过 `cancellationRequested()` 提前要求停流。

默认方法锚点也很清楚：

- `begin`（`Sink.java:128`）
- `end`（`138`）
- `cancellationRequested`（`147`）

这说明 Sink 不是“另一个 Consumer 接口”而已，而是一份完整的**运行时消费协议**。

### 为什么 ChainedReference 正好说明了它是一条管道

`Sink.ChainedReference` 位于 `Sink.java:244-263`。它的关键在于持有 `downstream`，并把 `begin/end/cancellationRequested` 默认委托给下游。这就意味着：每个中间操作都可以把自己的逻辑包在下游外面，形成一层套一层的消费链。

也就是说，Pipeline 链记录“这一步存在”；Sink 链才定义“这一步对元素做什么”。两者并不是同义重复，而是分别回答结构和行为两种问题。

### `opWrapSink` 为什么是从“中间操作”变成“真正行为”的转换点

真正把静态节点翻译成消费行为的，是每个节点的 `opWrapSink`。看 `ReferencePipeline` 里的 filter 和 map：

- filter 的 `opWrapSink` 在 `ReferencePipeline.java:167-180`
- map 的 `opWrapSink` 在 `191-199`

这两段代码恰好说明了 Stream 的惰性秘密：构造期只是保存谓词和映射函数；执行期才通过 `opWrapSink` 生成真正的 sink，把 `predicate.test(u)` 或 `mapper.apply(u)` 放进 `accept()` 路径里。

换句话说，**中间操作在构造期只是“配方”，到了执行期才被烹饪成真正会对元素生效的行为。**

## 三、为什么终端操作一来，Pipeline 链才会被“反向包裹”成 Sink 链

### 先看 evaluate 为什么是总开关

`evaluate()` 位于 `AbstractPipeline.java:226-234`。它最重要的职责不是返回一个结果，而是宣布：从现在起，这条之前还只是描述的流水线，要正式进入求值阶段了。

一旦进入 evaluate：

- 流会被标记为已消费，不能再反复跑；
- 会从 `sourceSpliterator(...)` 取出真正的数据源；
- 会根据串行/并行路径选择具体执行分支；
- 最终把前面积累的 Pipeline 描述翻译成实际消费动作。

所以终端操作真正做的第一件事，不是“最后收个结果”，而是**按下整条流水线的执行开关**。

### 为什么 `wrapSink` 是反向组装，而不是顺着 nextStage 正向拼接

`wrapSink()` 位于 `AbstractPipeline.java:518-522`。它从当前终端 sink 出发，沿着 `previousStage` 一路往前，把每个中间阶段的 `opWrapSink` 反向包在外面。这个顺序特别值得记住，因为它说明：

- 构建期链条是从源到终端逐段长出来的；
- 执行期消费链则是从终端 sink 往回包，最后得到一个最外层 sink，让源元素一进来就能穿过整条逻辑。

这就是为什么我们需要两条链：一条适合描述“有哪些阶段”，另一条适合真正承载“元素怎么经过这些阶段”。

### `wrapAndCopyInto` / `copyInto` 为什么证明了“单遍消费”这件事不是口号

一旦 sink 链组好，`wrapAndCopyInto()`（`AbstractPipeline.java:473-476`）会调用 `copyInto()`（`479-490`）正式驱动源数据流过这条链。关键点在于：这里并不是“每个中间操作自己各扫一遍源”，而是由同一个源 Spliterator 把元素单遍送进最外层 sink，然后一层层往下传。

也就是说，常见的无状态 Stream 链条之所以高效，不是因为 JVM 后面帮你神奇优化，而是因为内部结构本来就是：**一次遍历，元素穿过整条 sink 管道。**

## 四、为什么终端操作的区别，不在“前面链怎么建”，而在“谁来当链底 sink”

### collect / reduce / forEach 真正分歧发生在最底端

Pipeline 的前半段构建方式对大多数终端操作来说都差不多，差别主要在最后一层 sink 上是谁承担最终消费语义。

例如：

- `collect` 对应 `ReferencePipeline.java:568`，底层会通过 `ReduceOps.makeRef(...)`（`ReduceOps.java:156`）构造归约 sink；`evaluateSequential` 关键锚点在 `911`。
- `forEach` 对应 `ForEachOps.ForEachOp`（`ForEachOps.java:132`），其顺序执行入口在 `148`。

这说明终端操作真正不同的，不是“前面链条怎样描述”，而是“**最后由哪种 sink 来收口整个流，并决定最终怎么消费元素、怎么产出结果**”。

所以终端操作不是被动结果读取器，而是这条执行管道真正的收口设计者。

## 五、为什么短路能在执行期真正停下：因为 Sink 协议本来就允许取消请求往上冒

### 先看短路不是构建期就停，而是执行期判断“够了”

上一章已经从 API 分类上区分了短路中间操作和短路终端操作。但真正把“短路”从概念变成行为的，是执行期的取消协议。

在 `copyInto()` 里，如果管线标记中带着短路语义，执行路径会转向 `copyIntoWithCancel()`（`AbstractPipeline.java:494+`），而不再是简单地 `forEachRemaining` 一把到底。这说明短路不是“链构建时就知道只要前几个元素”，而是**在运行时根据 sink 的取消请求决定是不是继续往后消费**。

### 这正好把上一章的短路分类和本章的执行骨架接起来

所以短路并不是 API 表面的语法便利，而是 Sink 协议里 `cancellationRequested()` 这一层真正发挥作用的结果。也正因为此，`limit`、`takeWhile`、`anyMatch`、`findFirst` 才不只是名字不同，而是在执行控制流上真的能让源数据提前停下。

这一层最后把前后两章真正接通了：上一章讲“哪些操作语义允许短路”，这一章讲“这些语义在内部怎样通过执行协议真正停流”。

## 收网：Stream 的惰性不是“先不执行”这么简单，而是“先建图纸，终端再焊管道”

回到开头那个问题，现在已经能看清为什么中间操作在终端操作之前什么都没做了。因为它们在构建期的职责，本来就不是处理元素，而是搭一张 Pipeline 图纸：节点有哪些、前后怎么连、源头在哪、这条流是否还能继续链接或已经被消费。真正会碰元素的行为，则要等到终端操作通过 evaluate 按下开关，再把这些节点反向包成一条 Sink 消费管道。

把整篇压成一张总图，就是：

```text
构建期
  → Pipeline 链
  → previousStage / nextStage / sourceStage
  → 只登记操作，不碰数据

执行期
  → 终端操作调用 evaluate
  → 反向 wrapSink 组装 Sink 链
  → copyInto 单遍驱动源数据流过整条管道
  → 短路时通过取消协议提前停流
```

如果说上一章解决的是“Stream 看起来像链式 API，但为什么前半段没有立刻执行”，这一章真正补上的就是：**这些看似静态的 API 链，内部到底怎样在终端操作来临时变成一条真正会逐元素消费的运行时管道。**

下一篇继续顺着这条执行骨架往下走：既然 filter/map 等中间操作本质上是在提供 `opWrapSink` 配方，那无状态操作、有状态操作、短路操作各自在封装什么不同的行为？这就进入 `16-stream/03-intermediate-ops.md` 的主线。