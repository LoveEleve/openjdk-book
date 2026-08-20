# 01. 谁决定编译、怎么排队、谁执行？— `CompileBroker` 编译队列

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是从“产生编译请求”到“编译线程真正执行编译”的中段流水线：`CompileTask`、`CompileQueue`、`CompileBroker`、`CompilerThread`。阈值算法与 tiered 分层策略本身，只做必要预告，留到下一篇 `TieredThresholdPolicy` 展开。
>
> **前置依赖**：[08-interpreter/03 — 解释器怎么安全地调 C++？— `InterpreterRuntime`](../08-interpreter/03-interpreter-runtime.md)、[12-ci/03 — 编译的“一次性生命”怎么收场？— `ciObjectFactory + ciReplay + ciMethodData`](../12-ci/03-ci-factory-runtime.md)、[16-code-cache/02 — `nmethod` 结构](../16-code-cache/02-nmethod-structure.md)
> → **后续**：[13-jit-framework/02 — `TieredThresholdPolicy` — 5 层编译策略](02-tiered-compilation-policy.md)

解释器里一个方法越跑越热，调用计数或者回边计数溢出了，`CompilationPolicy::event()` 觉得“该编了”。很多人看到这里，会自然地把故事补成一句话：既然策略已经说要编，那就直接调 C1 或 C2 把它编掉不就行了吗？

问题是，**“该编了”只是一个意愿，不是一个可以立刻执行的动作。**

真正的 JIT 编译是一件又重又慢、还会被别的 VM 机制反向牵制的事：

- 编译本身不便宜，不能把触发它的应用线程原地卡住；
- 请求发出到真正执行之间，方法的热度与世界状态可能已经变了；
- 编译产物最后要落进 CodeCache，CodeCache 紧张时，编译这件事本身还会被“反向限流”；
- C1 和 C2 是两种不同层级的消费者，OSR 编译和普通入口编译的语义也不一样；
- 有些任务只是“后台升级建议”，有些却是 replay、whitebox、must-be-compiled 这种根本不能随便丢弃的硬任务。

所以 HotSpot 做的不是“触发即执行”，而是一条完整的异步流水线：

- 解释器和策略层只负责生产“编译意愿”；
- `CompileBroker` 把这种意愿包装成任务；
- 任务按编译层级分流进队列；
- 编译线程在资源允许时异步消费；
- 排队期间旧任务允许作废；
- 真正的 `ciEnv` 与 C1/C2 编译，只在消费端创建。

先把这条主线记住。因为这一篇所有看起来分散的部件——`CompileTask`、双队列、stale task、动态编译线程、`invoke_compiler_on_method`——都在为“把编译意愿消化成可调度、可过期、受资源约束的异步执行”服务。

## 先试三个最自然的办法，看看为什么都不行

### 朴素方案一：谁触发谁编，应用线程自己同步跑编译

这是最直觉的想法。既然解释器已经知道某个方法足够热，那就让当前应用线程现场把它编了。没有队列，没有后台线程，也没有排队等待。

问题在于，JIT 编译本身就是 HotSpot 最重的一类工作之一。它要建 `ciEnv`、拉起类型流和逃逸分析、构造 IR、做寄存器分配、安装 `nmethod`。如果让应用线程自己同步做这些事，方法第一次触发升级时，应用线程就得吞下整段编译延迟。

这和 tiered compilation 想要的节奏正好相反。HotSpot 想要的是：应用线程继续跑解释器或旧版本机器码，后台线程慢慢准备更好的版本，准备好了再切换。也就是说，**触发编译的线程不是编译的执行者，它只是请求的生产者。**

所以“谁触发谁编”这条路从一开始就不成立。

### 朴素方案二：那就搞一个最简单的 FIFO 队列，谁先来谁先编

如果不同步编译，第二个最自然的想法就是排队：大家都来取号，谁先来谁先编。

这条路比同步编译现实得多，但它仍然太“老实”了。

首先，HotSpot 面对的并不是一种单一编译请求。C1 与 C2 是不同层级的消费者；OSR 编译和普通入口编译的紧迫度也不同；此外还有 replay、whitebox、must-be-compiled 这种调试或 VM 内部硬需求。把这些都扔进一根普通 FIFO 链表，等于默认“所有任务价值只由到达顺序决定”，这和编译请求的语义差异并不匹配。

其次，编译请求不是 static work item。它们排在队列里时，方法热度还在继续变化，旧结果可能已经装上了，类卸载和重定义也可能发生。一个纯 FIFO 队列默认假设“请求一旦来了，就只会越来越值得做”，这恰恰和编译请求的现实相反。

再往深一点说，tiered compilation 的世界里，“谁先来”本来就不等于“谁更该先编”。有的任务代表的是解释器第一次想给方法找个 C1 版本，有的任务代表的是一个已经很热的方法想从 C1 再升到 C2，还有的任务压根不是热度触发，而是 replay 或 whitebox 这类调试语义。

所以 HotSpot 虽然用的是链表队列，但“入队顺序”并不等于“最终消费顺序”，更不等于“每个入队任务都值得被消费到底”。队列只负责保存请求，真正决定“现在最值得拿哪张票据去编”的，还得交给 broker 和 policy 联手判断。

### 朴素方案三：任务一旦入队，就必须编到底

第三个直觉也很常见：既然系统已经把任务对象建出来、还排进了队列，那就说明它肯定值得做。中途再放弃，不就是白排了吗？

可真实情况是，**编译请求在排队期间会变旧。**

触发请求时某个方法可能很热，过几十毫秒后它未必还那么急；更现实的是，它可能已经有了同层级结果，或者持有它的类加载器已经死了，再或者因为策略与资源条件变化，根本不值得继续消耗 CodeCache 和编译线程。

如果系统不允许这种旧请求自然作废，就会把有限的编译资源浪费在“几分钟前还重要、现在已经不值钱”的任务上。HotSpot 在这里反而非常现实：**编译意愿不是不可撤销命令，它只是一张会过期的单子。**

这也正是后面 `can_become_stale`、`remove_and_mark_stale`、`purge_stale_tasks` 那条线存在的原因。

到这里先立一个路标：这一篇真正要回答的，是“HotSpot 为什么需要一条会分流、会过期、会被 CodeCache 反压的异步编译流水线”，而不是“`CompileTask` 有哪些字段”。

## 为什么“编译意愿”必须先变成 `CompileTask`

既然“该编了”只是一个意愿，系统就需要一个对象把这次编译尝试完整描述下来。这个对象就是 `CompileTask`。

从类注释就能看出来，它不是“队列节点”这么简单，而是“pending or current compilation”的代表。它描述的是一次编译尝试，而不是某个方法的永久编译属性。`share/compiler/compileTask.hpp:36`

它内部真正重要的字段也正体现了这一点：`_compile_id`、`_method`、`_osr_bci`、`_comp_level`、`_is_complete`、`_is_success`、`_is_blocking`、`_time_queued`、`_time_started`、`_hot_method`、`_hot_count`、`_compile_reason`、`_failure_reason`。这些字段合在一起，描述的不是“方法是什么”，而是“这一次为什么、何时、以哪种方式、在什么层级上尝试编译它”。`share/compiler/compileTask.hpp:79`、`share/compiler/compileTask.hpp:82`、`share/compiler/compileTask.hpp:83`、`share/compiler/compileTask.hpp:85`、`share/compiler/compileTask.hpp:91`、`share/compiler/compileTask.hpp:97`、`share/compiler/compileTask.hpp:99`、`share/compiler/compileTask.hpp:101`、`share/compiler/compileTask.hpp:102`、`share/compiler/compileTask.hpp:103`

其中最有味道的是 `CompileReason`。HotSpot 明确区分了：这是调用计数触发、回边触发、tiered 升级、CTW、replay、whitebox、must-be-compiled 还是 bootstrap。它不是为了日志好看，而是直接影响这个任务的行为语义。`share/compiler/compileTask.hpp:44`、`share/compiler/compileTask.hpp:48`、`share/compiler/compileTask.hpp:50`、`share/compiler/compileTask.hpp:52`、`share/compiler/compileTask.hpp:54`、`share/compiler/compileTask.hpp:56`、`share/compiler/compileTask.hpp:57`

尤其是 `can_become_stale()`。源码把规则写得很明确：只有 `Reason_BackedgeCount`、`Reason_InvocationCount`、`Reason_Tiered` 这几类由热度与策略驱动、而且还是非阻塞的任务，才允许在排队期间变旧；其余像 replay、whitebox、must-be-compiled 这类任务，不允许随便作废。`share/compiler/compileTask.hpp:124`、`share/compiler/compileTask.hpp:125`、`share/compiler/compileTask.hpp:126`、`share/compiler/compileTask.hpp:128`、`share/compiler/compileTask.hpp:129`

这说明 `CompileTask` 不是一个无脑排队单元，而是一张带取消语义、带来源语义的编译票据。

还有一个很关键但容易被忽略的点：`CompileTask` 自己也不是每次都 new 新对象。它有 free list，`allocate()` 会优先从空闲链表拿旧 task，`free()` 则把任务回收到 free list。这说明 HotSpot 连“任务对象”本身都在尽量避免多余分配。`share/compiler/compileTask.cpp:40`、`share/compiler/compileTask.cpp:44`、`share/compiler/compileTask.cpp:49`、`share/compiler/compileTask.cpp:61`、`share/compiler/compileTask.cpp:75`、`share/compiler/compileTask.cpp:77`

而真正把“方法编译意愿”包装成任务的，是 `create_compile_task()`：分配 task，初始化，再立即加到目标队列里。这里没有额外戏法，说明任务包装本身就是 broker 的核心职责之一。`share/compiler/compileBroker.cpp:1528`、`share/compiler/compileBroker.cpp:1532`、`share/compiler/compileBroker.cpp:1541`、`share/compiler/compileBroker.cpp:1542`、`share/compiler/compileBroker.cpp:1545`

## 为什么任务允许过期：编译意愿不是不可撤销命令

理解 `CompileTask` 之后，下一步就该回答一个反直觉问题：既然都已经把任务对象建好了，为什么系统还允许它在队列里过期？

`CompileTask::select_for_compilation()` 先做的一件事就很能说明问题：它先看任务是不是已经 unloaded。如果方法所属类加载器已经死了，直接不选。若还活着，再把原本的 weak global handle 升成 global handle，防止这次编译过程中对象再被卸掉。也就是说，**被真正选去编译的那一刻，任务才从“可丢弃请求”变成“必须保护住的方法编译尝试”。** `share/compiler/compileTask.cpp:136`、`share/compiler/compileTask.cpp:138`、`share/compiler/compileTask.cpp:143`、`share/compiler/compileTask.cpp:145`、`share/compiler/compileTask.cpp:147`

排队侧的 stale 处理更直接。`CompileQueue::remove_and_mark_stale()` 会把任务从主队列摘掉，挂到 `_first_stale` 链表；之后 `purge_stale_tasks()` 在合适时机释放这些 stale tasks，并给它们统一记上 `"stale task"` 失败原因。这里最值得记住的不是回收细节，而是语义：**队列里的任务并不是神圣不可动的，只要它已经不值得编，就应该被清掉。** `share/compiler/compileBroker.cpp:482`、`share/compiler/compileBroker.cpp:484`、`share/compiler/compileBroker.cpp:491`、`share/compiler/compileBroker.cpp:497`、`share/compiler/compileBroker.cpp:498`、`share/compiler/compileBroker.cpp:525`、`share/compiler/compileBroker.cpp:529`、`share/compiler/compileBroker.cpp:532`

所以 broker 不是“把策略层说过的话机械执行下去”，而是在排队这一层继续不断问：这张编译票据现在还值不值得消费？

## 队列为什么不是“一个普通 FIFO”

`CompileQueue` 的定义其实很朴素：就是一条双向链表，维护 `_first`、`_last`、`_size`，以及一条 `_first_stale`。它看起来像一个普通队列，但别被这个外形骗了：**它只负责保存任务，不负责决定谁先编。** `share/compiler/compileBroker.hpp:76`、`share/compiler/compileBroker.hpp:83`、`share/compiler/compileBroker.hpp:84`、`share/compiler/compileBroker.hpp:86`、`share/compiler/compileBroker.hpp:88`

更重要的是，HotSpot 不是只有一个编译队列，而是按编译层级分成了 `_c1_compile_queue` 和 `_c2_compile_queue`。`compile_queue(comp_level)` 会按 comp level 把请求导向 C1 或 C2 对应的消费通道。也就是说，从一开始“排去哪条队”就已经带着 tiered 框架的分层信息了。`share/compiler/compileBroker.hpp:179`、`share/compiler/compileBroker.hpp:180`、`share/compiler/compileBroker.cpp:546`、`share/compiler/compileBroker.cpp:547`、`share/compiler/compileBroker.cpp:548`

但最容易误解的一点在这里：**任务入队虽然是链表追加，可出队并不等于简单 FIFO。**

`CompileQueue::get()` 在真正取任务之前，不是直接拿 `_first`，而是在 `NoSafepointVerifier` 保护下调用 `CompilationPolicy::policy()->select_task(this)`，然后再让任务 `select_for_compilation()`。也就是说，policy 层不只在“该不该编”时出场，在“队列里谁先编”这一步也还在影响顺序。`share/compiler/compileBroker.cpp:461`、`share/compiler/compileBroker.cpp:463`、`share/compiler/compileBroker.cpp:464`、`share/compiler/compileBroker.cpp:466`

这就是为什么“队列是 FIFO”只说对了一半。链表结构是 FIFO，实际消费顺序却仍然会被策略筛选与 stale 清理打断。队列层只提供保存和基础摘取能力，真正的“优先拿谁”仍然是 broker 与 policy 的合谋结果。

## 并不是所有编译任务都只是“丢进去我先走了”

在继续看编译线程之前，还要补一个经常被忽略的分岔：不是所有任务都是完全异步、提交完就与请求线程无关。

`CompileTask` 自带 `_is_blocking`，而且源码还明确区分了哪些 blocking reason 需要真的等待：像 CTW、replay、whitebox、must-be-compiled、bootstrap 这类任务，就和普通计数触发编译不是同一种语义。`share/compiler/compileTask.hpp:83`、`share/compiler/compileTask.hpp:85`、`share/compiler/compileTask.hpp:135`、`share/compiler/compileTask.hpp:138`、`share/compiler/compileTask.hpp:142`

这特别能说明 broker 不是一个“统一后台池”。它既要支持最常见的非阻塞计数触发编译——请求线程把任务丢进队列后继续跑解释器；又要支持少量必须等结果的阻塞编译——请求线程在任务完成前不能往下走。

这种区别最后也落在 `CompileTaskWrapper` 析构里：阻塞任务要 `mark_complete()` 并 `notify_all()` 唤醒等待者；非阻塞任务则直接由编译线程自己 `mark_complete()` 后回收。`share/compiler/compileBroker.cpp:270`、`share/compiler/compileBroker.cpp:274`、`share/compiler/compileBroker.cpp:285`、`share/compiler/compileBroker.cpp:295`、`share/compiler/compileBroker.cpp:299`

所以“异步编译”并不等于“所有请求线程永远不等”。它真正表达的是：**编译执行与请求生产默认解耦，但 broker 仍保留让少数任务同步等待结果的能力。**

## `CompilerThread` 为什么必须是专门的 `JavaThread`

既然编译不能在应用线程里同步做，系统就需要一批专门消费者。这批消费者就是编译线程。

`compiler_thread_loop()` 一开头有一个很有代表性的细节：第一个走到这里的编译线程会在 `CompileThread_lock` 下初始化 `ciObjectFactory`。这说明编译线程不只是“跑编译算法的人手”，它本身还是整个编译器运行时世界的承载者。`share/compiler/compileBroker.cpp:1790`、`share/compiler/compileBroker.cpp:1799`、`share/compiler/compileBroker.cpp:1801`、`share/compiler/compileBroker.cpp:1802`、`share/compiler/compileBroker.cpp:1803`

然后它进入主循环：

- 先 `queue->get()` 取任务；
- 没任务时等待；
- 如果开了动态编译线程数调整，还可能因为空闲太久被移除；
- 取到任务后，用 `CompileTaskWrapper` 把任务绑定到当前线程；
- 再真正调用 `invoke_compiler_on_method(task)`。 `share/compiler/compileBroker.cpp:1823`、`share/compiler/compileBroker.cpp:1830`、`share/compiler/compileBroker.cpp:1834`、`share/compiler/compileBroker.cpp:1836`、`share/compiler/compileBroker.cpp:1860`、`share/compiler/compileBroker.cpp:1864`、`share/compiler/compileBroker.cpp:1873`

它之所以要做成专门的 `JavaThread` 风格线程，而不是一个随便的 native worker，原因也很硬：编译过程中要频繁创建 `HandleMark`、进出 VM、参与 safepoint、被 GC 正确阻塞，还要能安全持有 `ciEnv`、JNI handle block、`Method*` 等 VM 内部资源。如果它只是普通后台线程，这些机制都得重造一遍。

所以“异步编译”的真实含义不是“另开几个线程”这么简单，而是**让编译本身也成为 VM 里一等公民的线程活动。**

## 从任务到真正编译：`invoke_compiler_on_method` 才是 12-ci 域的诞生点

前面讲的都是“请求怎么变成任务、任务怎么排队、谁来取”。真正把任务变成编译的，是 `invoke_compiler_on_method()`。

这段函数一开头就会打印 `PrintCompilation`、记录事件、抽出 `compile_id`、`osr_bci`、`comp_level`、`compiler` 这些公共信息。然后有一个特别重要的动作：`push_jni_handle_block()`。这相当于给本次编译准备一块新的 JNI handle 容器，后面 `ci` 世界里大量 local handle 都会挂在这里。`share/compiler/compileBroker.cpp:2062`、`share/compiler/compileBroker.cpp:2064`、`share/compiler/compileBroker.cpp:2078`、`share/compiler/compileBroker.cpp:2083`、`share/compiler/compileBroker.cpp:2109`

接下来才是最关键的一步：创建 `ciEnv ci_env(task)`。这就是 12-ci 整个域真正诞生的地方。前面三篇反复讲过的 `ciObjectFactory`、`ciMethodData`、`ciTypeFlow`、`BCEscapeAnalyzer`，都不是在“任务入队时”就出现，而是在这里——某个编译线程真正接手了一个任务、准备消费它的时候——才把本次编译的 `ci` 世界搭起来。`share/compiler/compileBroker.cpp:2147`、`share/compiler/compileBroker.cpp:2148`、`share/compiler/compileBroker.cpp:2150`、`share/compiler/compileBroker.cpp:2157`

然后编译线程缓存当前 JVMTI 与 DTrace 状态，从 handle 拿到 `ciMethod* target`，最后才进入 `comp->compile_method(&ci_env, target, osr_bci, directive)`，正式调用 C1 或 C2。也就是说，`CompileBroker` 不负责编译本身，它负责把任务准备到“编译器现在可以安全开始干活”的那一步。`share/compiler/compileBroker.cpp:2160`、`share/compiler/compileBroker.cpp:2163`、`share/compiler/compileBroker.cpp:2166`、`share/compiler/compileBroker.cpp:2180`

这一节最值得记住的，是 `CompileBroker` 和 `ci` 域的真正接缝：**broker 负责把“异步任务”变成“可进入 `ci` 世界的一次编译执行”，而 `ciEnv` 则从这里开始接管编译期对象视图。**

## `CompileTaskWrapper` 说明“进行中”不是一个显式状态，而是一个作用域

如果你去找“任务状态机”，会发现源码并没有写出一个很完整的 `queued -> compiling -> success/failed` 枚举机。真正表达“当前正在编译这件事”的，是 `CompileTaskWrapper` 的生命周期。

构造函数里，它把 task 绑定到当前编译线程，并记录 log 起点。析构时则做一串非常关键的收尾：

- 写结束日志；
- 把 `thread->task(NULL)` 清掉；
- 把 task 上挂的 code handle 丢掉；
- 把 `thread->env(NULL)` 清掉；
- 阻塞任务就 `mark_complete()` 并唤醒等待者；
- 非阻塞任务则直接 `mark_complete()` 后由编译线程回收。 `share/compiler/compileBroker.cpp:250`、`share/compiler/compileBroker.cpp:252`、`share/compiler/compileBroker.cpp:258`、`share/compiler/compileBroker.cpp:262`、`share/compiler/compileBroker.cpp:267`、`share/compiler/compileBroker.cpp:268`、`share/compiler/compileBroker.cpp:269`、`share/compiler/compileBroker.cpp:274`、`share/compiler/compileBroker.cpp:295`、`share/compiler/compileBroker.cpp:299`

这特别能说明 HotSpot 的风格：**“这次编译正在进行”不是靠 task 里某个显式状态字段单独维护，而是靠 wrapper 这个作用域对象隐含表达。**

同样，这里也把上一域的 `ciEnv` 生命周期和 broker 域收尾严丝合缝地接上了：编译结束，wrapper 析构时顺手把线程上的 `env` 清掉。

## CodeCache 不是编译的仓库，而是编译流水线的刹车片

还有一个经常被忽略的问题：大家容易把编译看成“只要线程空着就能一直干”的后台工作，但实际上，编译产物最后是要落进 CodeCache 的。

这意味着 CodeCache 本身会反过来制约编译流水线。`CompileQueue::get()` 在空队列时并不是无条件忙等，它会 timed wait；注释里专门提到一种“没有任务”的重要原因：不是想编的都编完了，而是 CodeCache 空间紧张、编译被停掉了。此时系统甚至会借等待期去做 sweeper 工作，尝试腾空间。`share/compiler/compileBroker.cpp:430`、`share/compiler/compileBroker.cpp:431`、`share/compiler/compileBroker.cpp:432`、`share/compiler/compileBroker.cpp:446`、`share/compiler/compileBroker.cpp:449`

在编译线程主循环里也能看到这一层：只有 `(UseCompiler || AlwaysCompileLoopMethods) && should_compile_new_jobs()` 为真时，才真的调用 `invoke_compiler_on_method`。否则就把方法从 queued-for-compilation 状态里清掉，并把失败原因记成 “compilation is disabled”。`share/compiler/compileBroker.cpp:1870`、`share/compiler/compileBroker.cpp:1872`、`share/compiler/compileBroker.cpp:1877`、`share/compiler/compileBroker.cpp:1878`

这说明编译系统不是一条只看“需求侧热度”的单向流水线，它还时刻受“产物空间侧容量”的反压。**编译再值得做，也得先有地方放结果。**

## 收网：`CompileBroker` 解决的不是“如何调用编译器”，而是“如何把编译意愿变成可调度的异步执行”

现在可以把整篇压成一张总图了。

解释器与策略层负责发现“这个方法值得编译”，但这个结论本身太粗：它没有说明谁来编、什么时候编、在排队期间方法会不会变旧、CodeCache 顶不顶得住。于是 HotSpot 用 `CompileTask` 把一次编译意愿包装成一张带层级、带原因、带热度、带过期语义的任务票据；再按 comp level 把任务分流进 C1/C2 队列；队列取任务时不是死守 FIFO，而是让 policy 继续选择最值得消费的任务，并顺手淘汰 stale task；编译线程作为专门的 `JavaThread` 后台消费者异步取任务，在 `invoke_compiler_on_method` 里创建 `ciEnv`，真正调用 C1/C2 编译；最后用 `CompileTaskWrapper` 把一次编译的在场语义和收尾逻辑一起打包。`share/compiler/compileTask.hpp:44`、`share/compiler/compileTask.hpp:124`、`share/compiler/compileBroker.cpp:463`、`share/compiler/compileBroker.cpp:478`、`share/compiler/compileBroker.cpp:546`、`share/compiler/compileBroker.cpp:1834`、`share/compiler/compileBroker.cpp:1864`、`share/compiler/compileBroker.cpp:2150`

所以，这一篇最核心的一句话不是“`CompileBroker` 维护两个队列”，而是：

**`CompileBroker` 把“该编了”这种策略意愿，变成了一条可排队、可过期、可分流、受 CodeCache 反压制约的异步编译流水线。**

只要这句话抓住了，下一篇 `TieredThresholdPolicy` 就好理解了：broker 只回答“怎么调度与执行”，真正决定“为什么是 tier3、为什么再升到 tier4、为什么有的请求 stale、有的不能 stale”的，是策略层自己。

> → [13-jit-framework/02 — `TieredThresholdPolicy` — 5 层编译策略](02-tiered-compilation-policy.md)
