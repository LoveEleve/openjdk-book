# 01. 为什么编译代码不是一出事就立刻退场？— Deopt 决策表

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是去优化的“决策半边”：`DeoptReason`、`DeoptAction`、`trap_request`、`MethodData` 里的 trap 历史，以及 `uncommon_trap_inner` 怎样结合编译期意图和运行时统计决定是否让代码退场。编译帧如何真正拆回解释器帧，放到下一篇展开。
>
> **前置依赖**：[16-code-cache/05 — JIT 为什么敢赌未来不会变？— `Dependencies` 与 `Deopt`](../16-code-cache/05-dependencies-deopt.md)、[13-jit-framework/02 — 为什么先 C1 再 C2？— `TieredThresholdPolicy`](../13-jit-framework/02-tiered-compilation-policy.md)、[21-shared-runtime/01 — 编译代码遇到问题——向谁求助?— Runtime Stubs](../21-shared-runtime/01-runtime-stubs.md)
> → **后续**：[02 — 从编译帧回到解释器：`unpack` 帧重建](02-unpack-frames.md)

很多人第一次接触 deopt，脑子里会自动形成一个很简单的画面：编译代码在运行时某个假设失效了，于是“回到解释器”。

这个画面不能说错，但它把去优化里真正复杂的部分全抹平了。

因为 HotSpot 真正在做的不是一个单按钮动作，而是一套决策系统。它要同时回答两件事：

- 这次为什么出事；
- 出事以后先怎么办。

而且后一个问题还不能只看“这次”的原因，它还要看：

- 这个字节码位置以前是不是已经栽过；
- 同一个坑是不是已经重编过还没改好；
- 整个方法是不是正在陷入 deopt → 重编 → 再 deopt 的死循环。

这就逼出本篇最该回答的问题：**JIT 代码在运行时为什么不是简单地“遇到问题就 deopt 回解释器”，而要区分这么多 reason、action、per-bci/per-method 历史、trap_request 位域和阈值？到底是谁决定‘这次只回解释器看看’、‘这次立刻 make_not_entrant’、‘这次永远别再编了’——编译器还是运行时？**

先把答案压成一句话：**Deopt 决策不是运行时现想现算的一张静态查表，而是两层协议：编译器在每个假设点预先写下“如果这里出事，默认该采取什么 action”，运行时再结合该方法/该字节码位置过去已经出过几次事、是否已经重编过、是否触发全方法上限，决定是否升级动作。也就是说，Reason 解释‘为什么这次出事’，Action 解释‘先怎么处理’，MDO trap 历史则负责‘别在同一个坑里无限重编死循环’。**

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：运行时根据 reason 现查一张固定 reason→action 表

这是最自然的第一反应。

既然去优化有各种 reason，比如 `class_check`、`range_check`、`unloaded`、`unstable_if`，那最直觉的设计就是：运行时拿到一个 reason，查一张固定表，表里写着“遇到这个 reason 就该 reinterpret / make_not_entrant / make_not_compilable”。

这个理解的问题在于，它把 Reason 和 Action 误当成了一一对应的映射关系。

源码恰恰说明它们不是一回事。`DeoptReason` 回答的是“**为什么这次 trap 发生**”；`DeoptAction` 回答的是“**默认打算怎么处置**”。它们是两个维度，不是一张单向查表。`src/hotspot/share/runtime/deoptimization.hpp:42`、`src/hotspot/share/runtime/deoptimization.hpp:108`

更关键的是，Action 很多时候不是运行时临时从 reason 推出来的，而是编译器在发出这个 uncommon trap 时就已经带上的。`GraphKit::uncommon_trap(reason, action, ...)` 这一层会直接把二者编码进 trap_request。`src/hotspot/share/opto/graphKit.hpp:733`

也就是说，运行时首先是在消费一份**编译期已经预设好的意图**，不是在从零做一张 reason→action 的决策映射。

所以第一种朴素方案失败，不是因为运行时完全不参与决策，而是因为**它参与的是“在编译器给的默认 action 之上，再根据历史做调节”，不是“独自查表拍板”。**

### 朴素方案二：只要某个点 deopt 过一次，就该立刻永久放弃编译

第二个也很自然的想法是：既然一个编译假设已经被事实打脸，那是不是最安全的做法就是马上承认这段代码不可靠，从此不要再编它了。

这个理解也太粗暴了。

因为一次 trap 可能有很多层严重程度：

- 有些只是“这次先回解释器，但旧代码还能留着”；
- 有些值得“重编一次看看”；
- 有些才需要“立刻 make_not_entrant”；
- 真到了 repeatedly deopt、重编也救不回来，才值得“永久放弃该编译级别”。

如果每次一出事就直接 `make_not_compilable`，JIT 几乎等于不允许自己犯任何乐观错误。那它就不再是一个会下注、会修正的优化系统，而更像一个只敢在绝对安全区里活动的保守解释器补丁。

HotSpot 真正的策略是反过来的：**先允许乐观，允许出错，允许重编，再通过 trap 历史逐步收紧。**

这才解释了为什么去优化路径里会有：

- `Action_none`
- `Action_maybe_recompile`
- `Action_reinterpret`
- `Action_make_not_entrant`
- `Action_make_not_compilable`。`src/hotspot/share/runtime/deoptimization.hpp:108`

它们不是“同一件事的不同写法”，而是一条逐渐升级的处置梯度。

所以第二种朴素方案失败，不是因为永久放弃永远不该发生，而是因为**HotSpot 需要的是渐进止损，而不是第一次出错就一刀切。**

这两个失败方案合起来，正好引出本篇主线：**编译器先给出默认 action，运行时再拿 trap 历史决定要不要把事情做重。**

## Reason 与 Action：为什么 HotSpot 要把“为什么”和“怎么办”拆开

先把两个维度分清。

### `DeoptReason`：解释“为什么出事”

`DeoptReason` 枚举很长，但最重要的结构不是名字多，而是它把原因分成了两层：

- 前面一批是按 bytecode 点记录的 reason，比如 `Reason_null_check`、`Reason_range_check`、`Reason_class_check`、`Reason_intrinsic`、`Reason_bimorphic`、`Reason_profile_predicate`；
- 后面一批则更偏 whole-method 或 whole-nmethod 层面，比如 `Reason_unloaded`、`Reason_uninitialized`、`Reason_unhandled`、`Reason_constraint`、`Reason_age`、`Reason_predicate`、`Reason_unstable_if` 等。`src/hotspot/share/runtime/deoptimization.hpp:42`

这一步特别重要，因为它说明“为什么出事”本身就有粒度差异：

- 有些坑是“这个具体 bci 的这个假设破了”；
- 有些坑则更像“这整个方法当前所处的运行条件变了”。

这也是后面为什么要同时有 per-bci 和 per-method 两套历史账本。

### `DeoptAction`：解释“默认该怎么处理”

`DeoptAction` 则要短得多：

- `Action_none`
- `Action_maybe_recompile`
- `Action_reinterpret`
- `Action_make_not_entrant`
- `Action_make_not_compilable`。`src/hotspot/share/runtime/deoptimization.hpp:108`

这几类动作最该记住的不是中文解释，而是它们的递进关系：

- `none`：先只回解释器，不动旧代码；
- `maybe_recompile`：可以考虑重编，但未必要立刻让旧代码退场；
- `reinterpret`：旧代码要退场，但先给解释器更多时间重新观察；
- `make_not_entrant`：立刻让旧代码退出入口资格，尽快重编；
- `make_not_compilable`：这个级别别再编了。

这样一来，Reason 和 Action 的关系就很清楚了：**Reason 说的是“摔在哪”，Action 说的是“摔完先怎么处置”。**

它们本来就不该被揉成一张映射表。

## `trap_request`：为什么一次回退要压成一个整型协议字

有了 Reason 和 Action，下一步就是：这一趟 uncommon trap 是怎么把它们带进运行时的。

答案是 `trap_request`。

### 位域不是历史账本，它只描述“这一次调用”

`deoptimization.hpp` 明确给出了位宽：

- `_action_bits = 3`
- `_reason_bits = 5`
- `_debug_id_bits = 23`。`src/hotspot/share/runtime/deoptimization.hpp:117`

也就是说，一次 trap 请求会把：

- 这次 action
- 这次 reason
- 以及一个 debug id

编码进同一个 int 里。

`make_trap_request(reason, action, index)` 负责打包；`trap_request_reason`、`trap_request_action`、`trap_request_debug_id`、`trap_request_index` 负责解包。`src/hotspot/share/runtime/deoptimization.hpp:303`

这里最该讲清楚的一点是：**`trap_request` 描述的是“这一次 trap 调用”，不是历史账本。**

它只是把“这次为什么来、默认想怎么办、调试上下文是谁”压成一份运行时参数协议，好让 uncommon trap 路径在进入 `uncommon_trap_inner` 时有一份明确的输入。

### 为什么 `trap_request` 和 `trap_state` 必须严格分开

这一点极其容易混淆。

- `trap_request` 是一次 trap 调用的即时编码；
- `trap_state` 是 MDO 里某个 bci 的历史状态编码。

前者强调“当前调用携带什么意图”，后者强调“这个点以前出过什么事、重编过没有”。如果把两者混成一个东西，就会把“本次动作意图”和“历史防抖账本”搞到一起，根本看不清 uncommon trap 是怎么决策的。

所以本节最该记住的一句话是：**`trap_request` 是现场通行证，`trap_state` 是案底。**

## 编译器预设：为什么默认 action 来自 `GraphKit::uncommon_trap`

讲到这里，真正重要的问题终于能落地了：Action 到底是谁先选的？

答案是：**编译器。**

`GraphKit` 里有一个很关键的重载：

```cpp
void uncommon_trap(Deoptimization::DeoptReason reason,
                   Deoptimization::DeoptAction action,
                   ...)
{
    uncommon_trap(Deoptimization::make_trap_request(reason, action), ...);
}
```

`src/hotspot/share/opto/graphKit.hpp:733`

这段代码几乎把全篇主线写在脸上了：编译器在生成某个 uncommon trap 点时，不只是说“这里可能因为某个 reason 出事”，还会同时写下“出事后默认该走哪个 action”。

这意味着运行时不是拿到 reason 后从零推断动作，而是拿到一个**已经写着默认 action 的 trap_request**。

所以如果你想理解“为什么这次只是 `maybe_recompile`，而另一次却是 `make_not_entrant`”，首先要回到编译器当时为什么在这个假设点选择了这样的默认动作，而不是去运行时里找一张 reason→action 总表。

这也是 Deopt 决策最有意思的一点：**运行时并不是唯一的决策者，编译器已经先下注了一半。**

## 运行时调节：为什么 `uncommon_trap_inner` 还要加 trap 历史的 hysteresis

既然编译器已经给了默认 action，运行时还要做什么？

答案是：**防抖和止损。**

`uncommon_trap_inner` 里从 1745 开始有一大段注释，标题就叫 “Flush the nmethod if necessary and desirable”。这几乎就是整套运行时调节策略的设计文档。`src/hotspot/share/runtime/deoptimization.cpp:1745`

它列了三类防死循环措施：

1. 同一位置、同一原因，如果已经重编过还继续掉坑，就把动作往 `reinterpret` 方向收紧，让解释器多跑一会儿；
2. 如果 `overflow_recompile_count` 一直涨，超过 `PerBytecodeRecompilationCutoff`，那就升级成 `make_not_compilable`；
3. 还有更大的 per-method recompilation cutoff 兜底，防整方法反复重编不止。

这段注释特别值得讲出来，因为它告诉我们：**运行时在这里关心的不是“这次 trap 对不对”，而是“这件事是不是已经坏到足以停止继续乐观”。**

### Action switch：运行时先尊重默认意图

真正的 action switch 非常直白：

- `Action_none`：连 trap state 都不更新；
- `Action_maybe_recompile`：旧代码可留着，等编译器有空再说；
- `Action_reinterpret`：让旧代码退场，并 reprofile；
- `Action_make_not_entrant`：立刻让旧代码退出入口资格；
- `Action_make_not_compilable`：退场，并且以后别再编。`src/hotspot/share/runtime/deoptimization.cpp:1793`

这一步说明运行时第一反应仍然是尊重编译器预设的默认动作。

### 但 trap 历史会让动作“升级”

真正让运行时变成“第二层决策者”的，是后面的 `query_update_method_data()` 和阈值判断。

如果 profiling/trap 历史打开，运行时会：

- 更新该 reason 的 trap 计数；
- 看这个 bci 以前是不是出过同类 trap；
- 看这个点以前是不是已经重编过；
- 再根据 `PerBytecodeTrapLimit` 和 `per_method_trap_limit` 决定要不要把 `make_not_entrant` 打开。`src/hotspot/share/runtime/deoptimization.cpp:1857`、`src/hotspot/share/runtime/deoptimization.hpp:408`

其中 `PerBytecodeTrapLimit` 默认就是 4。`src/hotspot/share/runtime/globals.hpp:1788`

这一步最该记住的不是具体数字，而是它的结构：**运行时并没有推翻编译器的默认动作，而是在问“你这套默认乐观已经反复失败到什么程度，需不需要收紧”。**

这就是 hysteresis 的含义：不是第一次就拉满惩罚，而是允许少量失败，随后逐步升级。

所以本节最该记住的一句话是：**编译器负责定基调，运行时负责防止这份乐观演变成死循环。**

## MDO 里的账：per-bci trap_state 与 per-method trap_hist 为什么要并存

最后该看账本本身了。

如果运行时要做防抖和止损，它就必须记账。但 HotSpot 这里并不是只用一张账本，而是用了两套。

### `query_update_method_data`：运行时先同时摸两类历史

`query_update_method_data()` 会先更新 per-method 计数：按 reason 索引 `trap_mdo->trap_count(idx)` / `inc_trap_count(idx)`，得到这类 trap 在整个方法里的累计情况。`src/hotspot/share/runtime/deoptimization.cpp:1989`

然后，如果这个 reason 本来就属于“recorded per bytecode”的那批，它还会再拿到该 bci 对应的 `ProfileData`，检查和更新 `trap_state()`。`src/hotspot/share/runtime/deoptimization.cpp:2026`

这说明 HotSpot 不是在二选一，而是在同时问两件事：

- 这个方法整体是不是越来越不靠谱；
- 这个具体 bci 是不是已经成了反复出事的热点坑位。

### `trap_state`：它不是计数器，而是一个小型状态格

`trap_state_reason()`、`trap_state_has_reason()`、`trap_state_add_reason()` 这一组函数特别重要，因为它们揭示了 per-bci 历史并不是一个“精确计数器”。`src/hotspot/share/runtime/deoptimization.cpp:2114`

这里的编码本质上更像一个小型格：

- 0 表示没有记录到 reason；
- 某个具体 reason 表示目前只看到这一类；
- 如果并入了不同 reason，就掉到 `Reason_many`；
- 另外还有 `DS_RECOMPILE_BIT` 表示这里是否已经触发过重编。`src/hotspot/share/runtime/deoptimization.cpp:2114`

这一步很值得专门讲清楚，因为它能打掉一个常见误解：**per-bci trap_state 不是“这里第 1 次、第 2 次、第 3 次”的精确计数器，而是一份压缩过的局部案底。**

### `MethodData::_trap_hist`：真正的全方法计数在这里

Whole-method 的计数账本则在 `MethodData::_trap_hist` 里。`methodData.hpp` 里可以直接看到它是一段 `u1 _array[...]`，旁边还带着 `_nof_decompiles`、`_nof_overflow_recompiles`、`_nof_overflow_traps` 这些 whole-method 级别的计数器。`src/hotspot/share/oops/methodData.hpp:1984`

这说明 per-method 这层账本的职责，是提供：

- 某类 trap 在整个方法里的累计压力；
- 全方法的“这已经不是某个孤立坑位，而是方法整体在出问题”的信号。

所以两套账本并存，不是重复设计，而是各自回答不同粒度的问题：

- per-bci trap_state：这个具体点是不是已经多次踩坑、是否已经重编过；
- per-method trap_hist：这个方法整体是不是快被 trap 历史淹没了。

这就是为什么 uncommon trap 决策既像局部调节，又像全方法止损。

## 到这里为止，主线其实只发生了四件事

如果前面信息很多，这里先把整件事压回四步：

1. 编译器在每个 uncommon trap 点预先写下 reason 和默认 action；
2. 运行时用 `trap_request` 解出“这次为什么来、默认想怎么处理”；
3. 然后再用 `query_update_method_data()` 同时查看 per-bci 与 per-method 的历史；
4. 最终在默认 action 基础上做防抖和止损，决定旧代码是继续留、先解释、立刻退场，还是干脆别再编。

只要这四步还在脑子里，去优化决策就不会再像一堆枚举和位域定义。

## 常见误解澄清

### 误解一：Action 是运行时根据 Reason 现查表推出的

不是。

编译器在 `GraphKit::uncommon_trap(reason, action, ...)` 里就已经把默认 action 编进 trap_request 了；运行时是在这份默认意图上做调节。`src/hotspot/share/opto/graphKit.hpp:733`

### 误解二：`trap_request` 和 MDO 里的 `trap_state` 是同一种编码

不对。

前者是“一次 trap 调用”的即时参数字，后者是“某个 bci 过往案底”的压缩状态。它们服务的是两个完全不同的层次。`src/hotspot/share/runtime/deoptimization.hpp:303`、`src/hotspot/share/runtime/deoptimization.cpp:2118`

### 误解三：`Action_none` 也会顺手更新 trap 历史并失效旧代码

不会。

`Action_none` 这条分支直接把 `update_trap_state` 关掉，也不会让旧代码退场。它表达的是“先解释执行，但别动现有编译结果”。`src/hotspot/share/runtime/deoptimization.cpp:1793`

### 误解四：`PerBytecodeTrapLimit` 是精确的 per-bci 计数阈值

不能这么理解。

源码注释自己就提醒了：per-bci 这层历史因为编码紧凑，真实表达会比较粗糙，更多是在提供 hysteresis，而不是精确计数器。`src/hotspot/share/runtime/deoptimization.cpp:1875`

### 误解五：`Reason_many` 是一种真实 trap 来源

不是。

它是 trap_state 解码时的格底语义，表示“这里已经混入了多个不同 reason”，不是编译器直接写进 trap_request 的某类现场原因。`src/hotspot/share/runtime/deoptimization.cpp:2118`

## 收网：Deopt 决策的本质，是“编译器先下注，运行时再防抖和止损”

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
编译期
  GraphKit::uncommon_trap(reason, action, ...)
    └─ 把默认 action 编进 trap_request

运行时触发
  uncommon_trap(trap_request)
    ├─ 解包 reason / action / debug_id
    ├─ uncommon_trap_inner
    └─ query_update_method_data
         ├─ per-bci trap_state
         └─ per-method trap_hist counters

最终动作
  ├─ Action_none               -> 只解释执行
  ├─ Action_maybe_recompile    -> 先留旧代码，可能重编
  ├─ Action_reinterpret        -> make_not_entrant + reprofile
  ├─ Action_make_not_entrant   -> 立刻退场等待重编
  └─ Action_make_not_compilable-> 永久放弃该编译级别
```

把它再压成三句话：

- Reason 负责解释“这次为什么出事”，Action 负责表达“编译器默认想怎么处理”。
- 运行时不会重新发明一张 reason→action 总表，而是在编译器给的默认动作上，利用 trap 历史做防抖和止损。
- per-bci 与 per-method 两套账本并存，是因为 HotSpot 既要看“这个坑位是不是反复出事”，也要看“这个方法整体是不是已经陷入重编死循环”。

所以这一篇真正该记住的，不是那串枚举名。

真正该记住的是：**Deopt 决策不是一个按钮，而是一套分层协议。编译器先把默认退路写进代码，运行时再根据历史决定要不要把这条退路走得更重。**

下一篇就顺着这条线继续往下走。决策已经做完，接下来真正困难的问题是：既然已经决定退回解释器，那么当前这串被内联、被寄存器分配、被优化过的编译帧，究竟怎样拆回一串可继续执行的解释器帧？

> → [02 — 从编译帧回到解释器：`unpack` 帧重建](02-unpack-frames.md)
