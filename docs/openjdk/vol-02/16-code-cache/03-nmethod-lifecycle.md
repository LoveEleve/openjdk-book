# 03. 为什么过时代码不能当场删？— `nmethod` 的生命周期

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是普通 JIT 编译方法 `nmethod` 从可执行走向回收的主线：deoptimization、依赖失效、safepoint 标记、sweeper 清扫、GC 卸载交接以及 code cache 满时的应急。具体 relocation 格式、inline cache 清理细节、各个 GC 的完整内部实现不在本篇展开。
>
> **前置依赖**：[02 — 为什么一段编译方法必须自带完整说明书？— `nmethod` 的结构](02-nmethod-structure.md)
> → **后续**：[04 — `Relocation` 与 `Inline Cache`](04-relocation-ic.md)

上一篇的结尾，其实已经把这篇最重要的问题暴露出来了。

`nmethod` 不是一段裸机器码，而是一段可逆的、自描述的、可失效的代码对象。它知道怎么让调用方进来，知道自己埋了哪些 oop，知道怎么从一个 PC 反推出 Java 语义栈。

但这恰好也意味着：它一旦“过时”，事情就比普通对象复杂得多。

因为普通对象如果没人引用，GC 可以回收；而一段编译代码就算已经被证明不再正确，也可能还有线程正在它的栈帧里跑，可能还有 inline cache 指向它，可能还有 GC 或服务线程在遍历它，甚至还有解释器准备从 deopt 把它退回来。

所以这里真正要回答的问题不是“`not_entrant`、`zombie`、`unloaded` 分别是什么意思”，而是：**为什么一段编译代码明明已经被证明过时了，HotSpot 却不能立刻把它从 CodeCache 里删掉？谁负责判死、谁负责确认栈上没人、谁负责真正收尸？为什么整个过程还要跨 safepoint、跨多轮 sweeps，甚至可能先停编译再等清扫成功？**

先把答案压成一句话：**`nmethod` 的死亡不是一个瞬间事件，而是一段并发退出协议。deopt、依赖失效、分层替换和 sweeper 都只能先宣布“以后别再进来”；真正回收还要等 safepoint 栈扫描证明没有活帧、sweeper 在非 safepoint 里清掉入口和 IC 残留、GC 或清扫逻辑完成注销，最后才把空间还给 CodeHeap。HotSpot 把“判死”“验尸”“收尸”拆开，是因为代码一旦在别人栈上执行，就不能像普通对象那样当场搬走或释放。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：一旦证明代码过时，就立刻从 CodeCache 删掉

这是最直觉的想法。

既然编译假设已经失效，或者更新版本已经编好，旧 `nmethod` 看起来已经“不该再用”。那最干脆的办法就是：立刻把它从 CodeCache 删掉，空间腾出来给后面的编译任务。

这在普通缓存系统里可能说得通，但对 `nmethod` 不成立。

原因很简单：**“不该再接新调用”不等于“栈上已经没人”。**

一段方法代码变旧时，JVM 面对的至少是两拨完全不同的使用者：

- 未来的新调用者；
- 已经在这段代码内部执行的老栈帧。

新调用可以改道，老栈帧却不能凭空蒸发。你不能在线程还拿着返回地址、局部状态、异常处理路径的时候，直接把对应代码块 free 掉。否则轻则栈遍历和异常恢复失真，重则线程直接踩进已回收内存。

`sweeper.hpp` 开头的总注释就把这个约束说透了：`not-entrant` 的方法不能再被 Java 线程调用，但它仍然可能活跃在栈上；因此必须等下一轮标记阶段完成，如果一个 `not-entrant` 方法没有再被标成活跃，才可以转成 `zombie`；之后再清理所有指向它的 inline cache，最后才能从 code cache 驱逐出去。`share/runtime/sweeper.hpp:35`

这段注释其实已经给出整条主线：**先挡新客，再确认屋里没人，最后才能拆房。**

所以第一种朴素方案失败，不是因为 HotSpot 保守，而是因为代码本身可能还在被执行。

### 朴素方案二：那就只改状态位，等大家自己绕开

第二个很自然的想法是：好，我承认不能立刻 free。那不如简单一点，给 `nmethod` 打个 `not_entrant` 标记，告诉整个系统“别再调它了”，然后等后面自然没人用了再说。

这比第一种方案聪明一些，但仍然不够。

因为“把状态位改了”只是 JVM 内部的一个事实，它并不会自动传播到所有已经成型的机器码调用点。调用者不会每次先读一遍 `nmethod->_state` 再决定要不要跳。上一章已经看到，很多调用方要么走 inline cache，要么直接跳 verified entry，它们手里拿的是实打实的目标入口地址。

这意味着只改状态位还差两步：

- 你得真的把后续新调用挡在门外；
- 你还得通过栈扫描分辨“现在没人再新进来”和“老栈帧已经走完了”是两件不同的事。

也就是说，死亡协议至少要同时处理三层问题：

- 判决层：这段代码从逻辑上该不该继续服役；
- 入口层：以后还能不能让新调用跳进去；
- 回收层：老栈帧和外部引用是否已经完全退出。

所以只改状态位不做后续工作，本质上还是把“逻辑过时”和“物理可回收”混成了一件事。

这两种失败方案合起来，正好引出 HotSpot 的正式设计：**一段 `nmethod` 的死亡必须被拆成多个阶段，而且这些阶段要由不同角色接力完成。**

## 谁在判死：四种入口，其实都只做第一步

先看“谁有资格宣布一段 `nmethod` 开始退出”。

`sweeper.hpp` 的注释给了最权威的名单：一个方法之所以会变成 `not-entrant`，来源有四种：

- sweeper；
- deoptimization；
- dependency invalidation；
- 被不同的方法版本替换，也就是 tiered compilation 下的新版本顶替旧版本。`share/runtime/sweeper.hpp:49`

这四种来源听起来很不一样，但它们有一个共同点：**它们都只能做死亡的第一步——宣布“以后别再进来了”。**

### 分层替换：新版本顶上来，旧版本先退出前台

这一类前面已经遇到过了。分层编译里，一个较新的、更高层级的版本编出来以后，旧版本不会突然消失，而是先退出入口资格。

这条链路的细节不在本篇展开，但它给全篇提供了一个非常重要的直觉：**就算只是“新版本替代旧版本”这么温和的场景，HotSpot 也不会直接删旧代码。**

因为“旧了”不等于“此刻没人踩着它”。

### uncommon trap / deoptimization：代码自己承认赌输了

第二类来源是 deoptimization，尤其是 uncommon trap。

C2 会带着很多乐观假设发码：某个范围检查大概率不会失败、某个类型检查大概率总成立、某个分支大概率很冷。一旦真实运行撞上了这些“本来不该发生”的路径，代码就会走进 deopt/uncommon trap 逻辑。

这里最值得强调的一点是：**不是每次 trap 都等于立即判死。**

`Deoptimization` 在处理 action 时，会先把几个布尔量拆开：`make_not_entrant`、`make_not_compilable`、`reprofile`。随后按 action 分流：

- `Action_none`：保留旧代码；
- `Action_maybe_recompile`：启动新编译，但不一定让旧代码失效；
- `Action_reinterpret`：回解释器一阵，并把旧代码设为 `not_entrant`；
- `Action_make_not_entrant`：立刻让旧代码退出入口资格；
- `Action_make_not_compilable`：不仅退出入口资格，还放弃继续编译。`share/runtime/deoptimization.cpp:1794`

这条分流特别重要，因为它说明 HotSpot 不是把“trap 发生了”粗暴地翻译成“代码死了”，而是在问：**这次赌输有多严重？是先观察、先重编、先回解释器，还是立刻判退出？**

所以 deoptimization 的本质角色不是“收尸人”，而是“裁判员”：它根据 trap 的严重程度，决定这段代码要不要先进入退出通道。

### 依赖失效：世界变了，不是这段代码自己跑坏了

第三类来源是 dependency invalidation。它和 deopt 的味道完全不同。

deopt 常常是代码在执行中自己撞上了不再成立的乐观路径；dependency invalidation 则是外部世界变了——最常见的是类层次关系变了。

`SystemDictionary` 在把一个新类挂进层次结构之后，会立刻调用：

```cpp
CodeCache::flush_dependents_on(k);
```

源码注释说得很直接：现在要 flush 掉所有依赖旧类层次的代码，而且这件事必须发生在把新类正式挂入层次之后。`share/classfile/systemDictionary.cpp:1817`

这里最值得讲清楚的不是“会 flush dependents”，而是**它不是全量扫 CodeCache 找可疑对象**。

`CodeCache::mark_for_deoptimization(KlassDepChange&)` 会沿着 `DepChange::ContextStream` 给出的受影响上下文遍历，每个上下文类再通过 `InstanceKlass::mark_dependent_nmethods` 找到依赖它的 `nmethods`。`share/code/codeCache.cpp:1148` 底层真正逐个检查和打标的是 `DependencyContext::mark_dependent_nmethods`：如果某个 `nmethod` 还活着、还没被标过、并且 `check_dependency_on(changes)` 为真，就把它标成待反优化。`share/code/dependencyContext.cpp:62`

这条链路的设计味道很强：**依赖失效不是“全世界都重新体检”，而是“只把受这次变化影响的住户叫出来”。**

但就算如此，它做的仍然只是第一步：标记、去优化、推进到 `not_entrant`，而不是当场回收。

### sweeper：它不只是扫地，也会主动挑冷代码下线

第四类来源正是 sweeper 自己。

很多人第一次听 `NMethodSweeper` 这个名字，会以为它只是“给已经死掉的代码收尾”。其实不止。前面三类来源更多是在外部事件推动下触发退出；sweeper 则还会根据 hotness 和 code cache 空间压力，主动挑一部分冷代码先把入口关掉。

这意味着 sweeper 在生命周期里同时扮演两个角色：

- 清扫者：回收已经走到后期的代码；
- 淘汰者：在空间压力和冷却状态下，让一部分 still-alive 的代码先退出前台。

这一点等讲到 `possibly_flush` 时会更清楚。先记住结论就够了：**四种“死法”看起来不同，但它们都只是把代码送上退出通道，而不是直接完成回收。**

## 为什么必须分成 mark 与 sweep 两阶段

如果说前一节回答的是“谁先宣布退出”，那这一节要回答的就是“为什么宣布退出之后还要拖这么久”。

答案藏在 sweeper 的整体协议里。

`sweeper.hpp` 一开头就把流程拆成两步：

1. `mark_active_nmethods()`：在 safepoint 做，标记哪些方法此刻还活跃在 Java 线程栈上；
2. `sweep_code_cache()`：不在 safepoint 做，而且它是唯一真正回收内存的地方。`share/runtime/sweeper.hpp:35`

这两个步骤不会同时运行。注释甚至特意强调：如果有线程请求 safepoint，`sweep_code_cache()` 会停下来让路，因此 safepoint 标记阶段和普通时间的清扫阶段天然互斥。`share/runtime/sweeper.hpp:43`

这正是一整套“读阶段 / 写阶段”协议。

### 标记阶段：借 safepoint 的机会读栈

`mark_active_nmethods()` 自己很短，真正关键的是它必须在 safepoint 里执行。源码在 `prepare_mark_active_nmethods()` 一开头就断言：必须 `is_at_safepoint()`。`share/runtime/sweeper.cpp:203`

为什么非得是 safepoint？因为这一步要回答的问题是：**当前还有哪些线程栈帧踩着哪些 `nmethod`。**

这是一个典型的“读所有线程现场”操作。放在 safepoint 做最自然，因为线程本来就停下来了，不会一边扫栈一边被别人继续推进执行。

实际调用点也验证了这个理解。safepoint 收尾时，`ParallelSPCleanupThreadClosure` 会拿到 `NMethodSweeper::prepare_mark_active_nmethods()` 返回的闭包，然后对每个 Java 线程执行 `jt->nmethods_do(_nmethod_cl)`。`share/runtime/safepoint.cpp:613`

也就是说，safepoint 本来就要清理一批 VM 事情；HotSpot 顺手把“栈上哪些 nmethod 还活着”这件事也一起采样了。

### `MarkActivationClosure` 到底在记什么

真正做标记的是 `MarkActivationClosure`。它每看到一个栈上活跃的 `nmethod`，会做两件事：

- 把 hotness counter 重置成“满血”；
- 如果这个方法当前是 `not_entrant`，再调用 `mark_as_seen_on_stack()`。`share/runtime/sweeper.cpp:163`

这两件事背后对应的是两个不同问题：

- 对活着的普通方法来说，这说明“你最近真有人在栈上跑，不是冷掉的孤儿”；
- 对已经 `not_entrant` 的方法来说，这说明“虽然你不再接新客，但这一轮栈扫描仍然看到屋里有人”。

而 `mark_as_seen_on_stack()` 的实现又把这个语义写得很明白：它把 `_stack_traversal_mark` 设置成当前的 `NMethodSweeper::traversal_count()`，注释直说这是为了确保 sweeper 在把方法变成 zombie 之前，先经历两轮 cleaning pass。`share/code/nmethod.cpp:989`

这已经开始接近全篇最重要的安全边界了。

### 为什么一轮“没看到”还不够

决定 `not_entrant` 方法能不能变 zombie 的判据在 `can_convert_to_zombie()`：

```cpp
return stack_traversal_mark()+1 < NMethodSweeper::traversal_count() &&
       !is_locked_by_vm();
```

`share/code/nmethod.cpp:999`

这里的 `stack_traversal_mark()+1 < traversal_count()` 不是小技巧，而是整个 sweeper 协议的核心。它要求：**当前 sweep 所处的 traversal 编号，至少比这段代码最后一次被栈扫描看见时大两轮。**

为什么要这么保守？因为 sweeper 自己不是一次性全量扫完整个 CodeCache，而是增量前进。某个方法被打成 `not_entrant` 的那一轮，它很可能刚好还在栈上；而且就算 traversal 计数已经前进，sweeper 也未必已经再次走到这个方法这里。所以“一轮没看见”并不能证明安全。

`sweeper.hpp` 的总注释直接把这个结论写出来了：每个 `nmethod` 的状态变化发生在不同 sweeps 中，真正释放空间至少可能需要 3 次 sweeps。`share/runtime/sweeper.hpp:57`

这句话非常值得翻成人话：

- 第一轮：某段代码被判 `not_entrant`；
- 中间的标记轮：确认它此后是否还出现在栈上；
- 再下一轮：只有连续确认“已经没人踩着它”，它才有资格变 zombie；
- 再之后才能 flush 回收。

所以“至少 3 sweeps”不是实现拖沓，而是退出协议故意拉开的安全距离。

## sweeper 怎么在普通时间里增量收尸

标记阶段解决的是“谁还活着”，但真正归还内存不能在 safepoint 里狠狠干完。否则 code cache 大一点、方法多一点，每次 safepoint 都会被拖得很重。

所以 HotSpot 把真正的回收工作放给 sweeper 线程，在普通时间里增量完成。

### sweeper 平时怎么被叫醒

`sweeper_loop()` 的主体很朴素：线程平时睡在 `CodeCache_lock` 上，收到通知就跑 `possibly_sweep()`。`share/runtime/sweeper.cpp:265`

而 `notify()` 也不是每次分配都无脑把它叫醒。它会先看 code cache 的 `reverse_free_ratio`，只有当压力达到阈值时才真正 `notify`。`share/runtime/sweeper.cpp:283`

这意味着 sweeper 不是一个定时器式后台工，而更像一个**按压力和状态变化被唤醒的维护线程**。

`possibly_sweep()` 里也把触发条件写得很清楚：

- code cache 正在变满；
- 自上次 sweep 以来状态变化足够多；
- 已经有一段时间没 sweep 了。`share/runtime/sweeper.cpp:327`

另外还有一个非常重要的硬触发：如果 non-profiled code heap 的可用空间低到阈值以下，就强制做一次 `do_stack_scanning()`。源码注释写明：只在 non-profiled heap 逼近满载时强制栈扫描，因为关键分配落在这个 heap 上，必须保证它别真的憋死。`share/runtime/sweeper.cpp:373`

### 清扫阶段为什么不能卡住 safepoint

`sweep_code_cache()` 一开始就断言：这里不在 safepoint。`share/runtime/sweeper.cpp:429`

但它也不会一意孤行地霸占执行权。每处理完一个方法，都会通过 `handle_safepoint_request()` 检查 JVM 是不是正在发起 safepoint；如果是，就让出 `CodeCache_lock` 并 `java_suspend_self()`。`share/runtime/sweeper.cpp:313`

这说明 sweeper 的身份非常克制：它是“普通时间里的维护者”，不是“我最重要，你们都等我扫完”。

### `process_compiled_method`：alive、not_entrant、zombie 各走各的命

`sweep_code_cache()` 真正逐个裁决方法时，核心逻辑在 `process_compiled_method()`。`share/runtime/sweeper.cpp:595`

这段分流特别适合拿来建立整篇的心智图：

- 如果方法已经 `zombie`：直接 `flush()`，空间归还；
- 如果方法是 `not_entrant`：满足条件就 `make_zombie()`，不满足就继续清理它指向别人的 inline caches；
- 如果方法是 `unloaded`：普通方法先变 zombie，OSR 方法可直接 flush；
- 如果方法仍然 alive：先走 `possibly_flush()`，看看要不要因为太冷而先打成 `not_entrant`，然后再清理 inline caches。`share/runtime/sweeper.cpp:617`

这几条分流把 sweeper 的两层职责全暴露出来了：

- 对已经进入退出通道的方法，它负责推进后续状态；
- 对还活着但很冷的方法，它也可能主动送你进退出通道。

这就是为什么我前面说它不是纯粹收尸人，而兼任了一部分淘汰器角色。

## 热度计数器：为什么“冷了”才会被牺牲

讲到这里，最容易冒出来的误解是：sweeper 是不是就按调用次数删代码？

不是。

`sweeper.cpp` 里的 hotness 计数器，描述的不是“你总共被调了多少次”，而更接近“**你距离上次在栈上被看见，已经凉了多久**”。

`MarkActivationClosure` 每次在栈扫描里看到一个活跃方法，就把 hotness 重置成 `hotness_counter_reset_val()`。`share/runtime/sweeper.cpp:168` 而这个 reset 值本身取决于 `ReservedCodeCacheSize`：小 cache 就小一点，大 cache 就给更高的缓冲值。`share/runtime/sweeper.cpp:188`

反过来，在 `possibly_flush()` 里，活着的方法每轮 sweep 都会 `dec_hotness_counter()`。随后 sweeper 用当前 hotness、code heap 的 `reverse_free_ratio`、`NmethodSweepActivity` 以及 `MinPassesBeforeFlush` 这些量来算：这个方法是不是已经冷到值得先把它打成 `not_entrant`。`share/runtime/sweeper.cpp:689`

这套算法背后的直觉并不复杂：

- 最近频繁出现在线程栈上的方法，不该轻易牺牲；
- 很久没被看到的方法，在空间紧张时可以优先送下线；
- 空间越紧，淘汰阈值越激进；
- 但再激进，也要给新编译出来的方法一个冷静期，不能刚生成就立刻处刑。

最关键的一点还是：**即便 sweeper 决定“这方法太冷了，该退场”，它做的第一步仍然只是 `make_not_entrant()`。** 真正回收空间还得回到前面的 epoch 协议里继续等待。

所以 hotness 不是“删除开关”，而是“谁先进入退出通道”的排序依据。

## GC 与 CodeCache 的交接：谁负责看代码里的活引用

到这里为止，我们已经讲清楚 sweeper 怎么根据栈活跃性和热度推进 `nmethod` 的退出。

但这还差一层非常关键的交接：**代码里自己埋着 oop 和 metadata 引用，GC 怎么参与这件事？**

### 年轻代 GC：不是全扫 CodeCache，而是先看 scavenge roots

`CodeCache` 专门维护了一条 `_scavenge_root_nmethods` 链。`register_scavenge_root_nmethod()` 会在某个 `nmethod` 检测到自己含有可 scavengable oop 时，把它挂进这条链。`share/code/codeCache.cpp:772`

年轻代相关处理时，`scavenge_root_nmethods_do()` 不会全扫 code cache，而是遍历这条链，对还活着、还没卸载的 `nmethods` 调用 `do_code_blob`。如果 `fix_relocations` 开启，还会顺手把已经不再需要留在这条链上的方法摘掉。`share/code/codeCache.cpp:730`

这说明年轻代 GC 看待 code cache 的方式非常克制：**只碰那些明确声明“我这里埋着需要你关心的年轻代引用”的方法。**

### 卸载 / 全堆处理：由代码自己检查自己身上的活引用

而当进入更重的 unloading 语境时，关键入口是 `nmethod::do_unloading_oops()`。这段逻辑会沿 relocation 迭代，检查 immediate oop 引用；如果发现某个嵌入引用已经死了，就可能触发 unload。`share/code/nmethod.cpp:1496`

一旦确认要卸载，`make_unloaded()` 会在 GC 期间打断 `nmethod` 和 method 的环、flush 依赖，并推进到 `unloaded` 语义。源码里甚至专门断言：这件事只应在 GC 活跃期间调用。`share/code/nmethod.cpp:1020`

这一点特别值得讲清楚：**GC 不是直接把 `nmethod` free 掉，而是先宣布“你和活对象世界的关系已经断了”。** 真正把这段代码壳体从 CodeCache 里拿走，仍然要靠后续 sweeper / flush 流程。

### G1 只是换了并行清理入口，不改变职责边界

以 G1 为例，并行清理入口会在 `clean_nmethod()` 里调用 `nm->do_unloading_parallel(...)`，然后更新 unloading clock。`share/gc/g1/g1CollectedHeap.cpp:3414`

这里不需要把 G1 的整个实现细讲一遍，正文只要记住边界就够了：**GC 负责判定代码是否还引用着活对象或活元数据，sweeper 负责把已经死亡的代码对象推进到真正可回收的终点。**

这两个角色互相配合，但不互相替代。

## CodeCache 满了怎么办：为什么先停编译，再等真的腾出字节

讲完正常生命周期，再看最容易把系统逼急的场景：code cache 满了。

这时最直觉的问题是：JVM 会不会直接卡死？

不会。

但它会进入一套明确的应急链路。

### 第一步：先尽量叫醒 sweeper 和补做栈扫描

前面已经看到，分配过程本身就会通过 `NMethodSweeper::notify` 提醒 sweeper 注意空间压力。真正临界时，`possibly_sweep()` 还会因为 non-profiled heap 太紧而强制 `do_stack_scanning()`。`share/runtime/sweeper.cpp:256`、`share/runtime/sweeper.cpp:373`

也就是说，系统会先尽量自救：多做一次“谁还在栈上”的确认，看看有没有过时冷代码可以推进回收流程。

### 第二步：真的顶不住，就先停新编译，保留解释器

如果再往下，CodeCache 分配链路还是失败，最后会走到 `CompileBroker::handle_full_code_cache()`。这段代码一上来就做了一件非常值得记住的事：

```cpp
UseInterpreter = true;
```

随后如果 `UseCodeCacheFlushing` 开着，就停止新的编译任务；否则彻底永久禁用编译。`share/compiler/compileBroker.cpp:2292`

这件事背后的设计取舍非常清楚：**JIT 是性能层，不是生存层。** code cache 满了以后，系统宁可先退回解释器，也不强行冒险继续发码。

所以这里的“满了”不是 JVM 终止服务，而是“先别再产生新代码，先把已有代码生态理顺”。

### 第三步：恢复编译不能只看空闲比例，必须真的收回过字节

最容易被忽视的一步，是编译恢复条件。

`sweep_code_cache()` 结束时，会检查：如果当前编译是停着的，而且这次 sweep `freed_memory > 0`，才重新允许编译。源码注释甚至特别解释：只看 code cache 里“似乎还有几 MB 空闲”是不可靠的，因为碎片化可能让你看起来有空间，却拼不出可用连续块。`share/runtime/sweeper.cpp:543`

这条规则非常有设计感。

它不是问“统计数字好看了吗”，而是在问：**这轮清扫有没有真把尸体抬出去，释放成可再次分配的块。**

如果没有，就算空闲比例看上去变好，也不代表问题真的解决了。

所以 code cache 满时的应急链路，实际上把全篇的主线又重演了一遍：

- 先别再让新代码进场；
- 先确认旧代码谁还能活、谁该退出；
- 真正腾出可用空间之后，再恢复正常发码。

## 到这里为止，主线其实只发生了五件事

如果前面机制比较多，这里先把整件事压回五个动作：

1. deopt、依赖失效、分层替换和 sweeper 都只能先把代码送进 `not_entrant`；
2. safepoint 收尾阶段负责读线程栈，记录哪些代码仍然被踩着；
3. sweeper 在线程正常运行期间增量推进 `not_entrant -> zombie -> flush`；
4. GC 负责判定代码里的嵌入引用和依赖是不是还活着，但不直接 free 代码壳体；
5. code cache 满时，系统先停新编译、退回解释器，再等 sweeper 真正腾出字节后恢复。

只要这五步还在脑子里，`nmethod` 的生命周期就不会再被看成一串孤立状态名。

## 常见误解澄清

### 误解一：`not_entrant` 就等于可以回收

不是。

`not_entrant` 只意味着不再接待新调用；它仍可能有老栈帧在执行。真正能不能进 `zombie`，还要看后续 traversal 判据和 VM 锁状态。`share/code/nmethod.cpp:999`

### 误解二：sweeper 就是一个“定时删代码”的后台线程

不对。

它不是固定周期瞎扫，而是按空间压力、状态变化和时间窗口决定是否工作；而且它自己既做清扫，也可能主动把冷代码送进 `not_entrant`。`share/runtime/sweeper.cpp:327`、`share/runtime/sweeper.cpp:689`

### 误解三：hotness 就是方法调用计数

不是。

这里更接近“距上次在栈上被看到过了多久”。一个方法哪怕历史上很热，只要长期不再活跃，也会慢慢冷却到可被牺牲。`share/runtime/sweeper.cpp:163`、`share/runtime/sweeper.cpp:188`

### 误解四：GC 会直接 free `nmethod`

不会直接这么做。

GC 负责检查代码里的嵌入引用是否还活着，并在需要时把方法推到 `unloaded` 等语义状态；真正把空间归还给 CodeHeap 的仍是后续 `flush` 路径。`share/code/nmethod.cpp:1496`、`share/code/nmethod.cpp:1020`

### 误解五：CodeCache 满就等于 JVM 不能运行

不是。

HotSpot 的优先级是先保生存：停新编译，保解释器，等 sweeper 真回收出空间再恢复。JVM 会变慢，但不会因为 code cache 满就自动失去执行能力。`share/compiler/compileBroker.cpp:2292`、`share/runtime/sweeper.cpp:543`

## 收网：`nmethod` 的死亡，本质上是一段并发退出协议

现在再回头看开头那个问题，答案已经能收成一张总图了。

```text
死亡入口
  ├─ tiered replacement
  ├─ uncommon trap / deoptimization
  ├─ dependency invalidation
  └─ sweeper hotness eviction
        ↓ 统一先变 not_entrant

等待退出
  safepoint 末尾 mark_active_nmethods
    └─ 记录哪些 not_entrant 方法仍在栈上

增量清扫
  sweeper thread / sweep_code_cache
    ├─ alive        -> 视热度决定是否 make_not_entrant
    ├─ not_entrant  -> 满足 epoch 条件后 make_zombie
    └─ zombie       -> flush 回收空间

GC / unloading 交接
  ├─ young GC: scavenge root nmethods
  ├─ full/unloading: do_unloading_oops
  └─ unloaded / zombie -> flush -> CodeHeap freelist
```

把它再压成三句话：

- 判死不等于收尸，四种死亡入口做的都只是“以后别再进来”。
- 真正能不能回收，要等 safepoint 栈扫描和 sweeper 的多轮 epoch 协议共同证明“栈上已经没人”。
- JVM 在 code cache 压力下宁可先停编译、退回解释器，也不冒险打破这套退出协议。

所以 `nmethod` 生命周期里最重要的事实，不是哪几个状态名，而是这套设计态度：**代码一旦可能还在别人栈上运行，就绝不能像普通缓存项那样说删就删。**

HotSpot 把死亡拆成 `not_entrant`、栈扫描、`zombie`、`flush`，把 deopt、sweeper、GC、CompileBroker 都接进同一条链，目的就是把“逻辑上已经过时”和“物理上可以安全回收”这两件事彻底分开。

下一篇就顺着这条链继续往下追。你会发现无论是 GC 更新嵌入 oop、依赖失效检查、还是 sweeper 清理 inline cache，最后都一再依赖同一个基础设施：`Relocation`。一段机器码是怎么知道自己身上哪些字节是 oop、哪些是 metadata、哪些是调用目标的？下一篇展开。

> → [04-relocation-ic.md](04-relocation-ic.md)
