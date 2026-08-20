# 08. 同一条回调链，为什么会长成四种完全不同的观察模型？——watch、trace、stack、tt 的 listener 消费方式

> 基于 `arthas` 当前源码实现讨论；本文聚焦 watch / trace / stack / tt / monitor / line 这些 listener 如何解释同一批 Advice/Spy 回调，不重复展开上一章的 `SpyAPI -> AdviceListenerManager` 分发细节，也不把下一篇 OGNL / 表达式与输出渲染提前写成本篇主线。
> **前置依赖**：[07 —— 业务代码只喊了一声，为什么正确的监听器就能听到？](../02-command-enhance/03-spy-dispatch.md)：知道 `SpyAPI` 的调用已经被分发到正确的 listener。
> → **后续**：AR-5 OGNL——`params[0] > 100`、`cost`、对象展开和输出模型到底在哪里被执行。
> 关联域：Advice 现场模型、TraceTree、ThreadLocalWatch、反射重放。
> 本篇所有源码锚点均已回对，不靠猜。

## 先看真正的分叉：同一条 Advice 回调，为什么最后会长成完全不同的观察模型

场景：上一章已经把最难的一步解决了——目标方法里那句 `SpyAPI.atEnter(...)` 已经被稳定地送到了正确的 listener。可这时一个更容易被低估的问题才真正浮出来：**同样一条回调链，为什么最后会长成完全不同的用户体验？**

- `watch` 给你的是一行调用现场；
- `trace` 给你的是一棵树；
- `stack` 给你的是一段业务调用栈；
- `tt` 给你的是一条可查询、还能再次重放的历史记录。

如果只从“功能列表”看，这四个命令像四套彼此独立的工具；但从源码看，它们并没有重新发明一套增强引擎，也没有各自重新织字节码。它们共享的是**同一批事件源**：

```text
业务方法运行
  → SpyAPI.atEnter / atExit / atExceptionExit / atInvoke / atLine
    → AdviceListener 收到统一事件
      → 各自按不同模型去解释这批事件
```

所以本篇真正要回答的不是：

> watch、trace、stack、tt 分别怎么实现？

而是：

> **同一个 Advice/Spy 回调，为什么最终会长成四种完全不同的观察模型；而这些模型各自又在避免什么失真和误用？**

先把全篇总图立住：

```text
统一事件源：Advice / Spy 回调
  → watch：把一次调用解释成单一现场输出
  → trace：把入口和子调用解释成合并后的树
  → stack：把当前线程解释成业务侧可读栈
  → tt：把一次调用解释成可查询、可重放的历史记录
  → monitor / line：同一事件源下的两个变体消费者
```

这张图里最重要的一刀就是：

```text
增强层只负责“把事件送到现场”
listener 才真正决定“用户最后看到什么模型”
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除几个最直觉、也最容易让输出失真的方案

### 1.1 错觉一：before / return / throw 各写各的输出逻辑就行

最直觉的 watch 实现方式，是把三种回调各管各的：

- before 自己输出 before 模型；
- afterReturning 自己输出返回模型；
- afterThrowing 自己输出异常模型。

这看起来很顺手，但会马上带来语义漂移：

- 条件表达式可能在三条路径上各算一遍、结果不一致；
- 展开深度、sizeLimit、输出时间和耗时逻辑会在三处分叉；
- `-n` 限次逻辑也会在多个出口重复实现。

所以 watch 真正需要的不是“三种事件三份输出逻辑”，而是：**多事件输入，单出口解释。**

### 1.2 错觉二：trace 每次子调用都单独展开成一条输出

第二个最直觉的方案是：每次方法内部调用一个子方法，就即时打印一条 trace 记录。这样做最直接，但很快会失控：

- 循环体里 100 次同一调用，会变成 100 条重复输出；
- 调用关系难以收束成结构；
- 用户想找“时间花在哪”，却先被海量重复节点淹没。

所以 trace 真正需要的不是“把事件一条条打印出来”，而是：**把它们合成一棵可累积统计、可压缩重复调用的树。**

### 1.3 错觉三：stack 直接打印当前线程完整栈

如果用户想看业务栈，最直觉的办法当然是直接把当前线程栈打出来。

问题是：此时线程正站在 Arthas 自己的回调链里。你如果直接打印整段栈，最醒目的很可能不是业务调用，而是：

```text
SpyImpl -> AdviceListenerAdapter -> StackAdviceListener -> ThreadUtil
```

这会把用户真正想看的业务栈淹没在 Arthas 自己的工作栈里。stack 真正需要的不是“全栈打印”，而是：**一个稳定的裁剪边界，把 Arthas 自己这段调用栈整体切掉。**

### 1.4 错觉四：tt 保存的是一个完整、无副作用的深拷贝快照

`tt` 最容易被误解成“时间机器”：好像它把一次调用完整冻结下来，之后你再 `tt -p` 只是看看历史。

这并不准确。它既不会默认深拷贝整棵对象图，也不会保证重放无副作用。相反，`tt -p` 最终会再次真实调用业务方法。

所以 tt 真正要解决的不是“保存一份绝对静态的快照”，而是：**老老实实保存一条足以查询、足以再次调用、但不伪装成无副作用记录的历史调用材料。**

---

## 二、第一层：watch 为什么要把四种回调收敛到一个输出出口

### 2.1 watch 真正想表达的是“一次调用现场”

`core/command/monitor200/WatchAdviceListener.java:20` 开始的实现里，before、正常返回、异常返回和默认完成态都存在：

- `before()`（`WatchAdviceListener.java:38-45`）先 `ThreadLocalWatch.start()` 开始计时；只有配置了 `-b` 才会输出入口现场；
- `afterReturning()`（`:48-56`）创建 returning Advice；按 `-s` 决定是否输出；
- `afterThrowing()`（`:59-67`）创建 throwing Advice；按 `-e` 决定是否输出；
- `isFinish()`（`:33-35`）在没有显式 `-b/-e/-s` 时提供默认完成态输出。

这几条路径看起来像分散实现，但它们最终都在汇向同一件事：**如何把一次调用解释成一份用户可读的现场。**

### 2.2 为什么真正的输出必须收束到 `watching()` 这一个出口

真正的统一出口是 `watching()`（`WatchAdviceListener.java:76-116`）：

1. `threadLocalWatch.costInMillis()` 取耗时（`:79`）；
2. `isConditionMet(conditionExpress, advice, cost)` 判断条件（`:80`）；
3. `getExpressionResult(express, advice, cost)` 求值（`:87`）；
4. 组装 `WatchModel`，带上时间、耗时、表达式结果、展开深度、sizeLimit、类名、方法名和 AccessPoint（`:89-102`）；
5. `process.appendResult(model)` 输出结果（`:104`）；
6. 计数并在达到 `-n` 上限时调用 `abortProcess`（`:106-108`）。

这里的关键不是“代码集中写了一处”，而是：watch 这类命令面对的是同一个逻辑收口点——**无论入口、返回、异常还是默认完成态，它最终都要通过同一组条件、同一套表达式求值、同一份模型组装和同一个限次语义。**

关键设计（斜体）：*多事件输入，单出口解释。*[模式: 模板方法 + 单一出口] 这避免了 before/return/throw 三条路径各自长出一套语义，最后把同一个命令拆成三种稍有偏差的行为。

### 2.3 为什么对象展开也要外包给 `ObjectVO`

`-x` 的对象展开并不是 `WatchAdviceListener` 自己递归打印，而是交给 `arthas-model/src/main/java/com/taobao/arthas/model/ObjectVO.java:12-33`。

这说明 watch 的模型也在做分层：

- listener 决定“这次要不要输出、输出哪个表达式结果”；
- `ObjectVO` 决定“结果对象怎么按深度、数组、sizeLimit 规则展示”。

也就是说，watch 要的是“现场模型”，不是“把所有对象递归打印逻辑都塞进 listener”。

---

## 三、第二层：trace 为什么要把入口节点和子调用节点合成一棵树

### 3.1 trace 真正想表达的是“这次调用内部的结构”，不是事件流水账

`trace` 和 watch 的关键区别，不只是输出格式不同，而是**它在描述完全不同的观察对象**：

- watch 关注的是单次调用现场；
- trace 关注的是这次调用内部又发生了哪些子调用，以及时间花在什么地方。

所以 trace 的问题天然不是“打一串日志”，而是“怎样把入口节点与子调用点组织成一棵可读的树”。

### 3.2 为什么入口节点和 invoke 子调用节点来自两套回调

方法入口和出口来自 `AbstractTraceAdviceListener`：

- `before()`（`AbstractTraceAdviceListener.java:52`）调用 `tree.begin(clazz.getName(), method.getName(), -1, false)`；
- `afterReturning()` 等在结束时关闭当前节点。

而方法体内部的子调用节点，来自 `TraceAdviceListener.invokeBeforeTracing()`（`TraceAdviceListener.java:23-27`），也就是上一章 ByteKit `@AtInvoke` 织入的调用点回调。

这意味着 trace 面对的不是一种统一事件，而是两类不同来源：

```text
入口 / 出口事件
  +
方法内部 invoke 事件
```

trace 的关键价值，就在于把这两类事件最后收成同一棵树。

### 3.3 为什么不能每次子调用都生成一个全新节点

`model/TraceTree.java:30-41` 的 `begin()` 会通过 `findChild()` 按“类、方法、行号”查找已有子节点。这正是为了解决前面那个失败方案：循环体里 100 次同一调用，不应该在树里膨胀成 100 个重复节点。

也就是说，trace 的树不是“调用次数树”，而是：

```text
按调用点合并后的前缀树
  → 节点再累计次数、耗时等统计量
```

关键设计（斜体）：*trace 追求的是“调用点结构 + 统计累积”，不是“每次调用都独立留痕”。*[模式: 前缀树 + 节点合并] 这样输出规模才跟调用点数量相关，而不是与实际循环次数线性爆炸。

### 3.4 为什么 `deep == 0` 才是整棵树真正结束的时刻

`AbstractTraceAdviceListener.java:88-101` 用 `deep` 计数判断整棵调用树何时结束。只有回到 `deep == 0`，整棵 trace 才算真正封口：这时才计算总耗时、裁剪树并输出模型。

这也是 trace 和 watch 的另一个本质区别：watch 的输出时机和单次事件直接相关；trace 的输出时机则和**整棵树是否回到根**相关。

### 3.5 为什么 TraceView 关心“最大耗时节点”而不是完整平铺

`view/TraceView.java:42-171` 里：

- `recursive()` 递归生成 `+---` / `|` 前缀；
- `renderCost()` 算子节点相对父节点的耗时占比；
- `findMaxCostNode()` 找到最大耗时节点并高亮。

这说明 trace 不只是“把树画出来”，它还在帮用户回答一个更具体的问题：**这次调用里，热点到底聚在哪个子分支。**

### 3.6 path 变体为什么仍属于同一模型

`PathTraceAdviceListener` 虽然不织 invoke 级桩，而是扩大类匹配、让方法全匹配，再靠 before/after 的 `deep` 嵌套构造路径；但它本质上仍然是在用另一种采集方式构造同类树模型。这不是另一套工具，而是同一观察模型的另一种入口。

---

## 四、第三层：stack 为什么要先找到 SpyAPI 边界，再一次裁掉 Arthas 自己的栈帧

### 4.1 stack 想看的不是“当前线程全栈”，而是“业务侧可读栈”

用户执行：

```text
stack com.example.Service doBiz
```

真正想看的通常不是：

```text
SpyImpl -> AdviceListenerAdapter -> StackAdviceListener -> ThreadUtil
```

而是业务代码是怎么走到 `doBiz` 这个点的。

所以 stack 的问题不是“能不能拿到线程栈”，而是：**怎样把 Arthas 自己这段回调栈整体切掉。**

### 4.2 为什么不能靠猜哪些栈帧像 Arthas

一个很糟的方案是：

> 遇到包名像 `com.taobao.arthas` 的帧就跳过。

这会很脆弱：包名策略可以变、调用层次可能调深、某些边界帧不一定稳定。

Arthas 选择的是更稳定的哨兵边界：`SpyAPI`。

`ThreadUtil.java:381-420` 里：

1. `findTheSpyAPIDepth()`（`:381-395`）先找 `SpyAPI` 帧；
2. 找到后用 `System.arraycopy`（`:414-417`）一次性截取业务侧部分；
3. `StackView.java:19-37` 再负责格式化。

关键设计（斜体）：*stack 不是靠类名模糊猜测 Arthas 栈帧，而是借 `SpyAPI` 这个稳定哨兵，一次裁掉自身回调链。*[模式: 哨兵边界 + 栈视图]

### 4.3 为什么 `StackView` 只做展示，不做裁剪

`StackAdviceListener.java:33-76` 的职责，是在合适的回调点拿到 Advice、触发计时并调用 `ThreadUtil.getThreadStackModel(...)`；真正的栈裁剪由 `ThreadUtil` 做；`StackView` 则只负责把线程标题、类名方法名和逐帧 `at ...` 信息格式化。

这其实也在重复整篇的主线：**同一个事件源不会直接生成最终用户输出，中间总有“裁剪模型”和“展示模型”的责任分层。**

---

## 五、第四层：tt 为什么必须老实承认自己保存的是参数引用，而且重放是一场真实调用

### 5.1 tt 真正表达的不是“快照”，而是“历史调用材料”

`tt` 最容易被误用，因为它最像“时间机器”。

用户常常会把它理解成：

- `tt -t` 录下一次调用；
- 之后任何查看、查询、`tt -p` 都只是在玩一份静态快照。

这不准确。tt 在实现上更接近：**保存足够描述一次历史调用的材料，然后允许你再拿这些材料去查询甚至重放。**

### 5.2 为什么 before 阶段保存的是参数引用，而不是深拷贝快照

`core/command/monitor200/TimeTunnelAdviceListener.java:22` 开始的实现里，before 阶段会把进入时的 `Object[]` 参数引用压入固定 ring stack（`:57-61`）；返回或异常时再从 ring stack 取回（`:64-82`）。

这里的精度边界非常重要：当前实现保存的是**数组引用**，并不深拷贝参数数组或参数对象。

这意味着：

- tt 保证 after 回调拿回的是当时保存下来的那份参数引用；
- 但它不承诺对象本身后续不会被业务代码修改；
- 所以它不是“冻结整个对象世界”的深拷贝快照。

关键设计（斜体）：*tt 保存的是足以描述历史调用的引用材料，而不是伪装成“所有对象都被冻结”的完美快照。*[模式: 时间隧道 + 引用保存]

### 5.3 为什么 `TimeFragment` 只是历史记录容器，不是时间机器本体

完成返回或异常后，listener 会创建 `TimeFragment`（`TimeTunnelAdviceListener.java:123`），记录 Advice、时间和耗时，再交给 `TimeTunnelCommand.putTimeTunnel()`（`TimeTunnelCommand.java:278-282`）。全局记录使用 `LinkedHashMap<Integer, TimeFragment>` 和原子序号（`TimeTunnelCommand.java:55-57`）。

这说明 tt 真正保存的是：

- 现场引用材料；
- Advice 快照；
- 耗时与时间戳；
- 一个可查询索引。

但这并不自动意味着“之后的任何操作都无副作用”。

### 5.4 为什么 `tt -p` 必须被当成一次真实业务调用

`TimeTunnelCommand.java:502-563` 的 `processPlay()` 会：

1. 拿 `advice.getMethod()`；
2. 必要时 `setAccessible(true)`；
3. 用当时的 target 和 params 再次执行 `method.invoke(...)`；
4. 组装 `TimeTunnelModel` 返回结果。

而 `ArthasMethod.java:26-102,155-164` 负责把方法描述符解析成真正可反射调用的方法。

这说明 `tt -p` 不是“在内存里重放一段纯观察记录”，而是：

```text
拿着历史 target 和 params
  → 再真实调用一次业务方法
```

所以它可能再次：

- 改状态；
- 写库；
- 发消息；
- 抛业务异常。

关键设计（斜体）：*tt 的诚实性在于，它不伪装成无副作用快照；它承认自己在重放时就是一次真实调用。*[模式: 历史记录 + 真实反射重放]

---

## 六、第五层：monitor 与 line 为什么只是同一事件源下的两个变体分支

这里先给一个路标：前面四节是本篇主线。`monitor` 与 `line` 更像证明“统一事件源可以继续长出别的观察模型”的两个分支例子；赶时间可以先记结论——**增强层只负责喊一声，消费模型都在 listener 里。**

### 6.1 monitor：把每次回调折叠成统计模型

`monitor200/MonitorAdviceListener.java:67` 开始处理回调，核心是 `ConcurrentHashMap<Key, AtomicReference<MonitorData>>`（`:72`）按方法聚合调用次数、耗时和异常，再由 `MonitorTimer`（`:186`）定时输出快照。

这说明 monitor 不想要“每次调用的现场”，而想要“时间窗口内的聚合统计”。

### 6.2 line：消费 `atLine` 事件，强调执行行与局部变量

line 则消费上一章 `SpyLineInterceptor` 织出来的 `atLine` 回调，关注的是“当前执行到哪一行、有哪些局部变量”。它说明同一条增强与分发主链，还可以继续长出另一种基于行级事件的观察模型。

关键设计（斜体）：*增强层只负责把事件送到现场，观察方式全都由 listener 自己决定。*[模式: 统一事件源 + 多模型消费者]

---

## 收网：Arthas 不是在“实现四个命令”，而是在用四种观察模型解释同一事件源

现在把整条链收成一张图：

```text
统一事件源：Advice / Spy 回调
  → watch：把一次调用解释成单次现场模型
  → trace：把入口与子调用解释成合并树模型
  → stack：把当前线程解释成业务侧栈模型
  → tt：把一次调用解释成可查询、可重放的历史记录模型
  → monitor / line：统一事件源下的分支消费者
```

把这张图压成一句话，就是：

**Arthas 并不是在“输出四种命令结果”，而是在拿同一批 Advice/Spy 回调，分别套上 watch 的现场模型、trace 的合并树模型、stack 的业务栈模型、tt 的历史记录模型，再由 listener 决定用户最终看到什么。**

到这里为止，主线其实只发生了四件事：

- watch 通过单一出口防止多事件路径语义漂移；
- trace 通过树节点合并防止输出规模随调用次数爆炸；
- stack 通过 SpyAPI 哨兵边界防止 Arthas 自己污染业务栈视图；
- tt 通过“引用保存 + 真实反射重放”防止把历史记录误讲成无副作用快照。

这也解释了为什么同一条回调链最后会长成完全不同的用户体验：**事件源是统一的，模型解释却是不同的；而这些差异并不是随便换个输出格式，而是在各自对抗不同的失真与误用。**

跨层标注：[AR-2 Spy 分发链——统一事件源先到 listener]；[Advice 模型——现场快照与 `ThreadLocalWatch` 耗时模型分离]；[TraceTree——调用点合并与统计累积]；[反射重放——tt 不是快照回放，而是真实调用]

本篇解决的是“同一条 Advice/Spy 回调，为什么最终会长成四种不同的观察模型，以及它们各自在防什么失真和误用”。下一篇继续进入这些模型背后的表达式世界：**`params[0] > 100`、`cost`、对象展开、结果裁剪，到底是谁在算、怎么算、又为什么不会把终端和堆一起打爆？**

**→ 下一篇：AR-5 OGNL 与表达式现场。**
