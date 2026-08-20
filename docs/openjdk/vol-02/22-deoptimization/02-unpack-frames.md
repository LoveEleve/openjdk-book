# 02. 为什么 deopt 不能只改个 PC？— 从编译帧回到解释器的 `unpack` 帧重建

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是去优化执行链的“拆包半边”：`fetch_unroll_info`、`vframeArray`、`UnrollBlock`、`unpack_frames`、`unpack_on_stack` 怎样把一个编译帧恢复成一串解释器帧。编译器为什么决定回退、回退动作如何升级，放在上一篇；G1、GC 等后续主题不在本文展开。
>
> **前置依赖**：[01 — 为什么编译代码不是一出事就立刻退场？— Deopt 决策表](01-deopt-decision.md)、[16-code-cache/05 — JIT 为什么敢赌未来不会变？— `Dependencies` 与 `Deopt`](../16-code-cache/05-dependencies-deopt.md)、[24-frame/03 — Deopt 与 GC 扫描](../24-frame/03-deopt-gc-scan.md)
> → **后续**：[26-g1-gc/01 — HeapRegion + G1CollectedHeap](../26-g1-gc/01-heapregion.md)

上一篇已经把去优化的“决策半边”讲清楚了：编译器先在每个假设点写下默认 action，运行时再结合 MDO 里的 trap 历史决定这次是先解释、先重编、还是立刻让旧代码退场。

但那还只是“决定要回退”。

真正困难的问题紧接着就来了：**当前线程此刻还卡在一段已经高度压缩过的编译帧里，怎么继续往下跑？**

这不是改个 PC 那么简单。因为一个编译帧里可能已经：

- 把多层 Java 调用内联进一层机器栈帧；
- 把本来应该在局部变量表里的值塞进寄存器；
- 把对象拆成标量值；
- 把锁、表达式栈、mdp 等解释器期望状态压扁掉。

所以本篇最该回答的问题是：**deopt 的决定已经做完了，为什么 HotSpot 不能直接把 PC 改到解释器入口继续执行？为什么必须先构造 `vframeArray`、再算 `UnrollBlock`、再在栈上铺骨架帧、再逐层填 locals/expressions/monitors？一个编译帧里被内联压扁的几层 Java 语义，到底是怎样重新长回一串解释器帧的？**

先把答案压成一句话：**deopt 执行的难点从来不是“跳到解释器”，而是“恢复解释器此刻本应看到的 Java 语义现场”。编译帧已经把多层 Java 调用内联、把值塞进寄存器和栈槽、甚至把对象拆成标量。HotSpot 必须先把这份压缩语义打包成 `vframeArray + UnrollBlock`，再按解释器帧布局重新铺栈并填回 locals、表达式栈和锁，最后才能把控制权安全交还给解释器。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：直接把 PC 改到解释器入口，剩下让解释器自己接着跑

这是最自然的第一反应。

反正解释器最终也是按字节码执行，那当前机器码一旦决定回退，最简单的做法似乎就是：

- 找到当前 bci；
- 把控制权跳回解释器；
- 让解释器从这个 bci 继续。

这个方案的问题在于，它只回答了“控制流从哪继续”，完全没回答“**解释器此刻所依赖的 Java 语义现场在哪里**”。

解释器继续执行时，并不只需要一个 bci。它还需要：

- 这一层 Java 帧的 locals；
- 表达式栈里的值；
- 监视器（锁）状态；
- profiling 相关的 mdp；
- 如果当前帧其实折叠了多层内联调用，那还需要把那几层 Java 帧一层层重新长出来。

而这些信息在编译帧里根本不是按解释器想要的形状摆着的。它们可能：

- 在寄存器里；
- 在被复用的栈槽里；
- 在标量替换后的对象字段里；
- 甚至还分散在多层 inlined scope 描述里。

所以只改 PC，顶多只把“下一条指令”对齐了，却没有把“解释器此刻需要的语义现场”还给它。

这就像你告诉一个演员“从台词第 37 句继续演”，却没有把角色、道具、同场演员和当前舞台布景一起恢复。根本没法继续。

所以第一种朴素方案失败，不是因为 PC 不重要，而是因为**解释器要恢复的不是控制流位置，而是一整套 Java 帧语义。**

### 朴素方案二：那就现场按机器栈直接临时拼几个解释器帧

第二个也很自然的想法是：好，我承认得把语义状态恢复回来。那不如一边读当前机器栈，一边临时把解释器帧直接拼出来。没必要先做什么 `vframeArray` 中间表示，直接原地拆不就行了。

这个方案的问题在于，它把“收集语义信息”和“按解释器布局落栈”两件事混在了一个阶段里。

而 deopt 恰恰最怕这种混合。

因为在真正开始改栈之前，HotSpot 需要先知道：

- 一共要恢复多少层 Java 帧；
- 每层帧有多大；
- 每层的 locals/expressions/monitors 分别有哪些值；
- 哪些对象需要重分配、哪些锁需要重建；
- 最终栈空间要预留多少，caller/callee 参数怎么衔接；
- 这一层究竟是“重执行当前字节码”还是“从下一条继续”。

如果不先把这些都算清，再一边读编译状态一边铺解释器帧，就会把 deopt 变成一个极难验证的边改边猜过程。

HotSpot 的做法正好相反：**先打包，再拆包。** 先把编译帧里压缩着的 Java 语义收成一份稳定的中间表示，再按这份蓝图去铺解释器骨架帧并逐层填充。

所以第二种方案失败，不是因为中间表示“更优雅”，而是因为**deopt 需要先冻结语义快照，再做物理栈改造。**

这两个失败方案合起来，正好引出本篇主线：**去优化执行链真正难的不是跳转，而是先打包语义，再拆包落栈。**

## pack 阶段：为什么 `fetch_unroll_info` 先收集 `compiledVFrame` 链

真正的执行链从 `fetch_unroll_info()` 开始。`src/hotspot/share/runtime/deoptimization.cpp:139`

这个函数一上来就做了一件很重要的事：给线程记一笔“我现在在 deopt handler 里”，防止异步栈遍历被临时帧状态搞乱。随后它把主要工作交给 `fetch_unroll_info_helper()`。`src/hotspot/share/runtime/deoptimization.cpp:139`

### 第一步不是铺栈，而是先找到 deoptee 以及它压扁的 Java 帧链

`fetch_unroll_info_helper()` 先拿到 `thread->last_frame()` 的 stub frame，再通过 `sender(&map)` 找到真正的 deoptee 编译帧。接着，它并没有急着构造解释器帧，而是先沿着 `vframe::new_vframe(&deoptee, &map, thread)` 拿到的 vframe 链一路 `sender()` 走下去，把每一层 `compiledVFrame` 收进一个 `GrowableArray`。源码注释说得非常直白：这里创建的是一个 growable array，其中每个 `VFrame` 代表一个 inlined Java frame。`src/hotspot/share/runtime/deoptimization.cpp:158`、`src/hotspot/share/runtime/deoptimization.cpp:184`

这一步的意义极大。

因为它回答的是：**当前这一个机器编译帧，语义上到底折叠了几层 Java 调用。**

没有这条链，后面根本不知道该恢复成 1 个解释器帧、3 个解释器帧，还是更多。

### 为什么这一步之后就不能再 safepoint

在 helper 的中后段，源码会显式加上 `NoSafepointVerifier`，并且注释说明：一旦 `vframeArray` 创建出来，后面如果再 safepoint，就有 Java 状态会躲在 `vframeArray` 里却不被正确扫描到。`src/hotspot/share/runtime/deoptimization.cpp:305`

这很能说明中间表示在 deopt 里的地位：**它不是“调试方便的临时结构”，而是一份正在接管线程 Java 语义状态的真正快照。**

所以 pack 阶段的核心不是“先做一点前置工作”，而是：先把所有后续恢复所需的 Java 语义冻结下来。

## `vframeArray`：为什么要有一份 C-heap 语义快照

这份被冻结的语义快照就是 `vframeArray`。

`vframeArray.hpp` 里的注释把它的内存结构画得很清楚：

- 固定部分：原始 frame 描述、帧数、callee save 区；
- 变长部分：每层一个 `vframeArrayElement`。`src/hotspot/share/runtime/vframeArray.hpp:121`

而 `vframeArrayElement` 自己则持有：

- `_frame`（将来要 unpack 进的解释器帧位置）
- `_bci`
- `_reexecute`
- `_method`
- `_monitors`
- `_locals`
- `_expressions`。`src/hotspot/share/runtime/vframeArray.hpp:50`

这一步最该记住的一句话是：**`vframeArray` 不是新的栈帧，它是“解释器帧该长什么样”的语义蓝图。**

### 为什么 locals / expressions / monitors 都要先收进来

解释器继续执行时，至少要拿到三类核心状态：

- locals
- 表达式栈
- 监视器（锁）

而 `vframeArrayElement` 恰恰把它们都单独存了下来。也就是说，HotSpot 在中间表示阶段就承认：**恢复执行不是“找个 bci 接着跑”，而是“把这一层 Java 帧的全部可观察语义重建出来”。**

### 为什么它要放在 C-heap，而不是直接借用当前机器栈

`vframeArray` 明确是 `CHeapObj<mtCompiler>`。`src/hotspot/share/runtime/vframeArray.hpp:121`

这不是偶然。因为在真正改造线程栈之前，HotSpot 需要一份稳定、独立、不依赖当前机器栈布局继续存在的语义快照。把它放在 C-heap，正好把“语义收集”与“物理栈改造”分离开来。

所以本节最该记住的一句话是：**`vframeArray` 不是执行现场，而是执行现场的恢复蓝图。**

## `UnrollBlock`：为什么要先算尺寸总账，再铺解释器骨架帧

有了语义蓝图，下一步并不是马上去填 locals，而是要先回答另一个很硬核的问题：**这些解释器帧总共要占多少栈空间，排列顺序是什么，caller/callee 参数怎么接。**

这正是 `UnrollBlock` 的职责。

### 先算尺寸，是为了让汇编先铺出 walkable skeleton frames

`fetch_unroll_info_helper()` 在收集完语义后，会计算：

- `frame_sizes[]`
- `frame_pcs[]`
- `caller_adjustment`
- `return_type`
- 等等，最后打成一个 `UnrollBlock`。`src/hotspot/share/runtime/deoptimization.cpp:377`、`src/hotspot/share/runtime/deoptimization.cpp:514`

这里有个特别值得讲清楚的细节：`frame_sizes[]` 的方向和 `vframeArray` 的元素方向是反的。`vframeArray` 里 index 0 是最年轻帧，而 `frame_sizes[]` 则按最老到最年轻的方向准备，方便后续汇编端按栈布局铺骨架。源码注释自己就特别提醒了这点。`src/hotspot/share/runtime/deoptimization.cpp:377`

这说明 `UnrollBlock` 的重点不是“保存一组整数”，而是**把恢复动作先变成一份可供汇编照表施工的尺寸预算单。**

### 为什么先用 `Interpreter::deopt_entry` 放一个占位 pc

在 frame_pcs 初始化阶段，源码会先给每层放一个 `Interpreter::deopt_entry(vtos, 0) - frame::pc_return_offset` 作为占位，注释明说：这里的 pc 不必完美，只要足够让骨架帧可走查；真正的精确 pc 会在后面单帧填充阶段再改写。`src/hotspot/share/runtime/deoptimization.cpp:387`、`src/hotspot/share/runtime/deoptimization.cpp:447`

这非常能说明 HotSpot 的工程顺序：**先让新栈帧“可走查”，再让它“语义精确”。**

所以 `UnrollBlock` 真正解决的是：解释器帧的物理容器怎么先腾出来，而不是恢复所有业务细节。

## `unpack_on_stack`：为什么单帧恢复要分续点、布局、锁和 mdp 四步

等 `DeoptimizationBlob` 按 `UnrollBlock` 先把 skeletal interpreter frames 铺好之后，真正的“把语义灌进去”的工作，落在 `vframeArrayElement::unpack_on_stack()`。`src/hotspot/share/runtime/vframeArray.cpp:171`

这一段最容易被源码细节淹没，但如果按职责拆开，其实正好是四步。

### 第一步：先决定解释器应该从哪条字节码继续

`unpack_on_stack()` 一上来先看：

- `raw_bci()`
- `should_reexecute()`
- `exec_mode`

然后在：

- `Interpreter::deopt_entry`
- `Interpreter::deopt_reexecute_entry`
- `Interpreter::deopt_continue_after_entry`

三类续点之间选。`src/hotspot/share/runtime/vframeArray.cpp:192`、`src/hotspot/share/runtime/vframeArray.cpp:196`、`src/hotspot/share/runtime/vframeArray.cpp:199`

这一步特别重要，因为它说明 deopt 恢复的不是一个抽象“回解释器”，而是非常具体地恢复成：

- 从当前字节码重做；
- 从下一条继续；
- 或走异常/特殊模式入口。

也就是说，**继续执行点本身就是被精确重建的一部分。**

### 第二步：让解释器自己决定帧长什么样

选好续点后，`unpack_on_stack()` 不会自己手搓解释器帧布局，而是调用：

```cpp
Interpreter::layout_activation(...)
```

`src/hotspot/share/runtime/vframeArray.cpp:292`

而 `layout_activation` 的注释也说得很明白：传进来的 `interpreter_frame` 已经保证大小正确、且处于 skeletal but walkable 状态。`src/hotspot/cpu/x86/abstractInterpreter_x86.cpp:57`

这说明 deopt 并不自己定义解释器帧布局规则，而是把“怎样排成一帧合法解释器帧”的权力交还给解释器一侧。

这是非常干净的边界：**deopt 负责恢复语义，解释器负责解释器帧的物理布局规则。**

### 第三步：把锁状态搬回解释器帧

单帧恢复里还有一个非常容易被低估的环节：监视器。

`unpack_on_stack()` 会遍历 `_monitors`，然后把每个 `BasicObjectLock` 通过 `move_to` 搬进新的解释器帧锁槽。`src/hotspot/share/runtime/vframeArray.cpp:312`

这说明 deopt 恢复的不只是 locals 和表达式栈，还包括“此刻这层 Java 帧正持有什么锁”。如果锁状态不回去，解释器世界看到的就不是一份语义连续的线程现场。

### 第四步：把 bcp 和 mdp 对回正确位置

最后它还会：

- `interpreter_frame_set_bcp(bcp)`
- 如果 `ProfileInterpreter` 开着，再按 bci 回填 mdp。`src/hotspot/share/runtime/vframeArray.cpp:322`

这一步再次印证：deopt 不是让解释器“随便接着跑”，而是让它拿回这一层 Java 帧**此刻本应拥有的执行点和 profiling 上下文。**

所以本节最该记住的一句话是：**单帧恢复的关键不是把栈铺出来，而是把“从哪继续 + 这层锁着什么 + 这层有哪些值 + profiling 走到哪”一起恢复。**

## `unpack_to_stack` 与 `cleanup_deopt_info`：为什么还要 oldest→youngest 填充与最后清场

单帧怎么恢复讲清之后，再看多帧怎么组合起来。

### `unpack_to_stack`：先给每层找骨架帧，再从最老到最年轻填

`vframeArray::unpack_to_stack()` 先从 `unpack_frame.sender()` 出发，把每个 `element(index)->iframe()` 指向已经铺好的 skeletal interpreter frame。`src/hotspot/share/runtime/vframeArray.cpp:567`

然后它从 `frames() - 1` 到 `0`，也就是从最老帧到最年轻帧，逐层调用 `unpack_on_stack()`。`src/hotspot/share/runtime/vframeArray.cpp:567`

这个顺序值得专门讲清楚，因为它和 `vframeArray` 自己的索引方向正好相反。这样安排不是巧合，而是为了在 caller/callee 参数关系上传递正确的上下文：恢复某层时，需要知道它下一层 callee 的参数数和 locals 规模。`src/hotspot/share/runtime/vframeArray.cpp:597`

所以 oldest→youngest 的 unpack 顺序，不是某种偶然遍历顺序，而是恢复调用链的一部分。

### 为什么还要 `cleanup_deopt_info`

等 `unpack_frames()` 调完 `array->unpack_to_stack(...)`，还不能就此撒手。它最后还会调用 `cleanup_deopt_info(thread, array)`，清掉：

- `vframe_array_head`
- 旧 `UnrollBlock`
- 旧 `vframeArray`
- `deopt_mark`
- `deopt_compiled_method`
- 以及相关 JVMTI/popframe 状态。`src/hotspot/share/runtime/deoptimization.cpp:540`

这一步很值得讲，因为它说明 deopt 执行链不是“恢复完新帧就结束”，而是**还要把那份中间语义快照和线程上的 deopt 现场标记一起收掉。**

所以 pack/unpack 真正构成了一次完整生命周期：

- 先冻结旧编译现场；
- 再生成中间表示；
- 再把它拆成新解释器现场；
- 最后再回收中间表示和线程辅助状态。

## 到这里为止，主线其实只发生了四件事

如果前面细节很多，这里先把整件事压回四步：

1. `fetch_unroll_info_helper()` 先沿内联 sender 链把当前编译帧里压扁的 Java 语义收成 `compiledVFrame` 列表；
2. `create_vframeArray + UnrollBlock` 再把这些语义冻结成一份 C-heap 快照和一份栈空间预算单；
3. 汇编端先铺出 skeletal interpreter frames；
4. `unpack_frames -> unpack_to_stack -> unpack_on_stack` 最后再把续点、布局、锁、locals、mdp 等一层层灌回解释器帧。

只要这四步还在脑子里，deopt 的执行链就不会再像一堆分散函数调用。

## 常见误解澄清

### 误解一：deopt 就是简单把 PC 跳回解释器入口

不是。

PC 续点只是恢复的一小部分；真正困难的是把多层 Java 帧语义、locals、表达式栈、锁和 profiling 上下文一起重建。`src/hotspot/share/runtime/vframeArray.cpp:171`

### 误解二：`vframeArray` 就是已经在栈上的解释器帧

不对。

它是 C-heap 上的语义快照和恢复蓝图；真正的解释器骨架帧是 deopt blob 按 `UnrollBlock` 先在栈上铺出来的。`src/hotspot/share/runtime/vframeArray.hpp:121`

### 误解三：`UnrollBlock` 只是一个尺寸数组

也不止。

它承载的是后续汇编端怎样铺 skeletal frames 的整份预算结果，包括 frame sizes、caller adjustment、return type 等恢复所需信息。`src/hotspot/share/runtime/deoptimization.hpp:176`

### 误解四：`deopt_continue_after_entry` 和 `deopt_reexecute_entry` 只是两个名字不同的入口

不是。

一个表达“当前字节码已经执行过，继续下一条”，另一个表达“这个字节码要重新执行”。它们恢复的是不同的 Java 执行语义。`src/hotspot/share/runtime/vframeArray.cpp:192`

### 误解五：oldest→youngest 的 unpack 顺序就等于骨架帧铺设顺序

不能直接画等号。

骨架帧早在汇编端按 `UnrollBlock` 预算铺好了；`unpack_to_stack` 的 oldest→youngest 更关心的是 caller/callee 参数语义如何逐层传递。`src/hotspot/share/runtime/vframeArray.cpp:567`

## 收网：deopt 执行的本质，是先冻结压缩语义，再把它拆回解释器现场

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
deopt 决策已完成
  ↓
fetch_unroll_info / helper
  ├─ 找到 deoptee compiled frame
  ├─ 沿 sender 链收集 compiledVFrame
  ├─ create_vframeArray      -> 语义快照
  └─ 计算 UnrollBlock        -> 栈尺寸预算

DeoptimizationBlob 汇编
  └─ 先在栈上铺 skeletal interpreter frames

unpack_frames
  └─ vframeArray::unpack_to_stack
       ├─ 给每层 element 指定 iframe
       └─ 从最老到最年轻 unpack_on_stack
            ├─ 选 bcp/pc 续点
            ├─ layout_activation
            ├─ 恢复 monitors
            └─ 恢复 locals/expressions/mdp
```

把它再压成三句话：

- 去优化真正难的不是“跳回解释器”，而是把已经被内联、寄存器化、标量化的编译语义先冻结下来。
- `vframeArray` 负责冻结语义，`UnrollBlock` 负责预算物理栈形，`unpack_on_stack` 负责把二者重新落回解释器帧。
- 只有控制流续点、locals/expressions、锁状态和 profiling 上下文一起恢复，解释器才真的能无缝接着跑。

所以这一篇真正该记住的，不是 pack 和 unpack 这两个术语本身。

真正该记住的是：**deopt 执行链本质上是一场“语义压缩格式 → 解释器现场”的解码过程。编译帧不是简单坏掉了，而是要先把自己压缩着的 Java 现场完整吐出来，解释器才能接盘。**

至此，deoptimization 这一域也在“为什么退、怎么退、退完怎么继续”三件事上闭环了。再往后切域，就回到内存和收集器本体。

> → [26-g1-gc/01 — HeapRegion + G1CollectedHeap](../26-g1-gc/01-heapregion.md)
