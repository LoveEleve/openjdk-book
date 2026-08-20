# CompletableFuture 基础：为什么它不只是一个 Future，而是结果、依赖和执行模型三合一对象

> 本文基于 JDK 11 `CompletableFuture`。讨论范围聚焦 `result` / `AltResult`、`stack` / `Completion`、`completeValue` / `completeThrowable` / `postComplete`、`thenApply` / `uniApplyStage` 以及同步/异步执行差异；多源组合与异常编排放到下一篇。本文讨论的是 JDK 11 Java 层实现路径，不把这里的内部节点形态和默认执行行为外推成所有 CompletionStage 实现都必须遵守的统一规范。
> **前置依赖**：[AtomicInteger 与 CAS](../13-atomic/01-atomicinteger-cas.md)、[FutureTask 与定时调度](../14-threadpool/04-futuretask-scheduled.md)
> **后续**：组合与异常编排

## 先看一个最常见、也最容易把 CompletableFuture 误讲成“会链式调用的 Future”的误区

很多人第一次介绍 `CompletableFuture`，都会从 API 体验出发：它像 `Future`，但多了 `thenApply`、`thenCompose`、`thenAccept` 这些链式方法。这种说法并不完全错，但它很容易把最关键的问题掩盖掉：**普通 Future 为什么不够，非得再造一个能挂一串 thenXxx 的对象？**

上一域的 `FutureTask` 已经解决了结果、异常、取消和等待。调用方可以 `get()`，执行方可以 `run()`，两边通过同一个状态机对象对齐。但它仍然有一个非常明显的缺口：结果到了以后，下一步逻辑谁来推进？如果任务 A 完成后要立刻喂给任务 B，再喂给任务 C，普通 Future 不会主动把这些后继动作组织起来。调用方只能在外部写大量阻塞等待、回调桥接或手工编排代码。

这就是 `CompletableFuture` 真正补的那一层：**它不只保存“将来会有一个结果”，还把“结果完成后挂着哪些后继依赖、由谁来执行这些依赖”也一并收进同一个对象。**

所以这篇不把 `CompletableFuture` 当成“会链式调用的 Future”来讲，而是把它拆成三部分：结果状态机、依赖节点栈、回调执行模型。只有这三部分放在一起，`thenApply` 这种 API 才不只是语法糖，而是一条真正的异步传播链。

## 一、为什么 CompletableFuture 不能只存一个值：它首先是一套完成状态机

### 先看最容易低估的字段：`result`

JDK 11 的 `CompletableFuture` 最核心的两个字段就在这里：

- `result`（`CompletableFuture.java:264`）
- `stack`（`CompletableFuture.java:265`）

先只看第一个。很多人会下意识把 `result` 理解成“结果值存放处”，但对 CompletableFuture 来说，它其实同时承担着**完成状态入口**的职责：

- `result == null`：表示当前还没完成
- `result` 是普通值：表示正常完成且结果非 null
- `result` 是 `AltResult`：表示完成了，但结果是 `null` 或异常

这说明 `result` 不是一个单纯的数据字段，而是一块把“有没有完成”与“完成结果长什么样”一起编码进去的状态入口。

### 为什么要有 `AltResult` 和 `NIL`

`AltResult` 定义在 `CompletableFuture.java:285-291`，其中 `NIL` 是一个 `ex == null` 的特殊哨兵。这个设计非常值得停一下，因为它正好说明：**CompletableFuture 不能只靠“普通值字段”来区分所有完成形态。**

如果正常结果本来就可能是 `null`，那你不能再拿 `null` 自己当“未完成”标志。异常也不能直接和普通值混在一起，否则读取侧根本不知道看到的是业务结果还是异常包装。因此 JDK 必须再引入一层结果装箱语义：

- 普通值：正常完成，且值不为 null
- `NIL`：正常完成，但业务结果是 null
- `AltResult(ex)`：异常完成

这就是为什么 `AltResult` 不只是“异常盒子”，它也是 `null` 结果的区分器。

### `completeValue` / `completeThrowable` 为什么说明完成只能赢一次

结果写入的关键方法是：

- `completeValue()`（`CompletableFuture.java:304`）
- `completeThrowable()`（`CompletableFuture.java:318`）

它们的共同特征很重要：都通过对 `result` 的 CAS 来尝试“第一次完成”。这说明 CompletableFuture 的完成不是随便赋值，而是一场**谁先把结果稳定发布出去，谁就赢**的竞争。一旦某条路径已经把结果写稳，后续再来的完成尝试就必须失败或被忽略。

这一层一定要讲透，因为它解释了 CompletableFuture 为什么首先是个结果状态机：**链式依赖的前提，是源结果本身必须先有一个稳定、唯一、可观察的结局。**

## 二、为什么 thenApply 不会立刻执行：回调先变成 `Completion` 节点，挂在源上等结果

### 先推演一个最直觉但根本行不通的实现方式

很多人第一次看到 `thenApply(fn)`，会潜意识把它想成“调用时就把 `fn` 跑掉”。可这在异步场景下大多数时候根本不成立：源 Future 很可能此刻还没完成，你连输入值是什么都不知道，当然不可能立刻执行转换函数。

所以 `thenApply` 做的第一件事，不是执行回调，而是**把这个回调登记成一个依赖节点，挂在源 Future 上，等源完成后再推进。**

这就是 `Completion` 出场的原因。`Completion` 在 `CompletableFuture.java:463`，而依赖压栈和清理相关入口包括：

- `pushStack`（`CompletableFuture.java:279`）
- `cleanStack`（`512+`）
- `postComplete`（`488-498`）

### 为什么这里是一条栈，而不是一个“回调立刻执行列表”

当调用者不断对同一个源 Future 追加 `thenApply`、`thenAccept` 等依赖时，CompletableFuture 需要一个地方挂住这些“未来待办”。这个地方就是 `stack` 字段，也就是一条 Treiber 栈式的依赖链。

这件事的意义不在于数据结构本身，而在于它把异步编排变成了一套事件驱动模型：

```text
调用 thenApply
  → 不是立刻执行
  → 先创建目标 future
  → 再创建一个 Completion 节点
  → 把它压到源 future 的 stack 上

源 future 完成
  → postComplete 触发 stack 上节点
  → 每个节点再去推进自己的目标 future
```

所以你看到的链式 API，底层并不是“连续同步调用”，而是“**在源上挂了一串待结果完成后再推进的依赖节点**”。

### `postComplete` 为什么是整条链真正开始动起来的地方

只要源 Future 还没完成，所有依赖都只是挂在那里的等待项。一旦源真正完成，`postComplete` 才会把这些 Completion 节点逐步弹出并触发它们的 `tryFire` 路径。也就是说，**CompletableFuture 的链式传播并不是由调用 thenXxx 时启动，而是由源结果完成事件真正点燃。**

这一层是本文最重要的第二个主心骨：CF 不是只有结果值，它还是一条依赖传播链的宿主。

## 三、为什么 `thenApply` 本质上等于“注册一个 UniApply 节点”

### 先把 API 名字翻译回内部动作

JDK 11 中，`thenApply` / `thenApplyAsync` 的核心落点在：

- `uniApplyStage`（`CompletableFuture.java:653`）
- `thenApply` / `thenApplyAsync` 公开入口（`2098-2108`）

这说明表面上的“thenApply”其实不是某种神奇关键字，而是“**为源 future 注册一个 UniApply 依赖节点，并返回一个新的目标 future**”。

这个节点里至少要绑定三件事：

- 源 future
- 目标 future
- 转换函数 `fn`

然后等源结果可用时，节点才真正读取源结果、执行 `fn.apply`、把结果发布到目标 future，再触发目标的下游依赖。

### 这就是为什么 CompletableFuture 看起来像链，实际上更像一张依赖传播图

对调用方来说，你写的是：

```java
a.thenApply(f).thenApply(g)
```

但内部真实语义更像：

```text
a 完成
  → 推动 UniApply(f)
      → 生成目标 future b
          → b 完成后推动 UniApply(g)
              → 生成目标 future c
```

也就是说，每个 then 节点都不是“对同一个 future 原地加工”，而是在**源和目标之间架一座桥**。这也解释了为什么 CompletableFuture 能自然形成异步依赖链：每一步都有自己的目标对象、自己的完成时刻、自己的下游 stack。

## 四、thenApply 和 thenApplyAsync 为什么不是命名差异，而是在回答“谁来跑你的回调”

### 先看同步链为什么并不总是“更简单”

很多人看到 `thenApply` 和 `thenApplyAsync` 的第一反应是：一个同步，一个异步。但如果不继续追问“同步/异步到底同步/异步在哪”，这个区分就仍然很虚。

更准确的说法是：**它们在决定由谁来执行这个回调。**

- `thenApply` 往往由“让源完成的那个线程”顺手推进下游
- `thenApplyAsync` 则把回调包装后交给默认执行器或指定执行器去跑

这不是一个轻微差异，而是实打实的执行模型选择。同步链少一次调度提交，通常更轻；但如果回调本身很重、会阻塞、会做 IO，它就可能拖住完成源的那个线程，把原本只该负责“发布结果”的线程也卷进后续长逻辑里。

### 为什么 Async 也不是无脑更高级

异步版本能隔离执行线程，但它同时引入了任务提交、排队和调度开销。也就是说，Async 不是“更先进”，而是“**我愿意为线程隔离付额外调度成本**”。

这就把工程问题摆得很清楚了：

- 回调很轻、只是小转换：同步链常常更合适
- 回调会阻塞或执行很重：Async 更能保护完成线程

这一层必须讲透，因为它会直接影响读者后面在 `CompletableFuture` 链上到处乱加 Async 还是乱省 Async 的习惯。

## 五、四个最容易混掉的边界：CompletableFuture 不只是 Future+语法糖，thenApply 不会立刻跑，result 不等于链已跑完，Async 也不是无脑更高级

在收网之前，先把这一篇最容易记错的四条边界压实。

第一，`CompletableFuture` 不是普通 `Future` 外面多包一层链式 API。它真正多出来的是依赖传播能力：结果一旦完成，不只是调用方可以来取，挂在它身上的下游节点也会被继续推进。少了这层 Completion 传播模型，thenXxx 这套 API 就只是看起来顺手，实际上仍然得靠外层手工编排。

第二，`thenApply` 也不会在你调用它的那一刻立刻执行函数。绝大多数你真正需要它的时候，源 future 还没完成，输入值根本都不存在。它当下能做的只是先注册依赖、创建目标 future，把真正执行推迟到源结果稳定之后。

第三，`result` 字段一旦非空，也不等于整条异步链已经跑完。它首先只说明“当前这个 CompletableFuture 自己已经有了稳定结局”；至于挂在它 stack 上的下游节点是否已经都被推进、目标 future 是否又带出了更长的链，那是下一层传播问题，不能和当前节点的完成状态混成一件事。

第四，Async 版本也不是无脑更高级。它解决的是“别让完成源的那个线程顺手背下整个回调逻辑”，但代价是真正多了一次调度和执行器切换。如果回调本来就很轻，盲目 Async 只是在给每一步都额外加一层任务提交成本。

把这四条边界记住，CompletableFuture 才不会重新塌回“Future 的升级语法”这种扁平印象。它真正做的是把结果状态、依赖注册和回调执行责任压进同一个对象模型里，让异步链在结果完成时自己继续往下流，而不是等外层线程来手工接线。

## 收网：CompletableFuture 真正把三样东西压到了一起——结果状态、依赖节点、回调执行模型

现在回到开头那个问题，就能看清为什么 CompletableFuture 绝不只是“能链式调用的 Future”了。普通 Future 解决的是结果、异常、取消与等待；CompletableFuture 在这之上多做的关键一步，是把“结果完成后挂着哪些后继依赖、由谁来执行这些后继”也压进同一个对象模型里。

所以它的本体至少有三层：

```text
result
  → 表示是否完成、结果是值/null/异常中的哪一种

Completion stack
  → 挂住所有等待源结果后再推进的依赖节点

执行模型
  → 决定回调是由完成线程顺手跑，还是交给执行器异步跑
```

正因为这三层合在一起，`thenApply` 才不是立即执行，而是注册一个 UniApply 节点；`postComplete` 才成为整条异步传播链真正动起来的时刻；`thenApplyAsync` 也才不只是 API 名称变化，而是在切换“谁来跑回调”的责任归属。

把整篇压成一张总图，就是：

```text
源 CompletableFuture
  → result 决定完成状态
  → stack 挂住下游 Completion
  → 完成时 postComplete 逐步推进依赖
  → 每个 thenXxx 产生新的目标 future
  → 同步版/异步版决定谁执行节点逻辑
```

如果说上一域的 FutureTask 解决的是“结果怎么被保存和等待”，这一篇真正补上的就是：**结果一旦到了，后面那串异步步骤如何自己接着往下流。**

下一篇继续把这条链往复杂处推进：一旦不再只是单源单链，而是两个 future 要合流、异常要接管、`allOf/anyOf` 要批量协同，CompletableFuture 又是怎样把这些组合关系塞回同一套 Completion 传播模型里的。