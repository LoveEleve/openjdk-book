# 03. 编译的“一次性生命”怎么收场？— `ciObjectFactory + ciReplay + ciMethodData`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 `ci` 域的收尾三件事：一次编译结束后镜像怎么清场、编译期间 profile 怎么稳定读取、JIT bug 怎么做 compile replay。`ReplayCompiles` 属于 debug VM 的调试能力，不是普通用户运行时功能。
>
> **前置依赖**：[12-ci/01 — JIT 怎么看到 Java 类？— `ciObject` 镜像体系](01-ci-overview-mirror.md)、[12-ci/02 — 编译器怎么知道“类型”与“逃逸”？— `ciTypeFlow + BCEscapeAnalyzer`](02-ci-typeflow-escape.md)、[16-code-cache/02 — `nmethod` 结构](../16-code-cache/02-nmethod-structure.md)
> → **后续**：[13-jit-framework/01 — `CompileBroker` 编译队列](../13-jit-framework/01-compile-broker-queue.md)

前两篇把 `ci` 域最重要的两件事讲完了：

- `ci` 镜像层把 VM 活对象降成了编译期稳定视图；
- `ciTypeFlow` 和 `BCEscapeAnalyzer` 又在字节码层补出了程序点状态视图。

如果只看这两篇，`ci` 世界像一个非常清爽的短命王国：一次编译，建一份 `ciEnv`，按需造镜像、造分析结果，编完就扔。

但一旦继续追，你会发现这里其实藏着三个互相拉扯的问题：

- 这次编译结束后，成百上千个 `ciObject` 怎么收场？
- 编译过程中，`MethodData` 里的 profile 还在被解释器和别的线程改，编译器怎么稳定地读它？
- 某次编译已经结束甚至已经把 JVM 弄崩了，为什么还能把“那次编译”原样重现出来？

这三个问题表面上一个讲生命周期，一个讲 profile，一个讲调试，好像不属于同一条主线。但它们其实是在回答同一个设计约束：

**`ci` 世界必须保持短命，不能自己膨胀成一套长期运行时系统；可短命并不等于草率，它仍然得让本次编译看到稳定输入，并且在需要时把这次短命编译事后复活。**

所以，本篇真正要回答的不是“`ciReplay` 怎么用”，也不是“`ciMethodData` 有哪些字段”，而是：**这个短命的 `ci` 世界，怎么同时做到快收场、稳读入、还能死后复活。**

## 先试三个最容易想到的办法，看看为什么都不对

### 朴素方案一：给每个 `ciObject` 做引用计数，编译结束后逐个析构

这很像普通对象系统的做法：谁创建谁持有，最后一层层释放。对于一个充满 `ciMethod`、`ciKlass`、`ciField`、`ciTypeFlow`、`BCEscapeAnalyzer`、`ciMethodData` 的复杂对象图来说，这似乎很自然。

但 HotSpot 从一开始就没走这条路。`ci` 对象绝大多数都分配在当前编译的 Arena 里，它们设计上就是“一次编译一锅端”。如果再给每个对象加独立寿命管理、显式析构与引用计数，不但会把编译热路径复杂化，还会把“本来应该一次性回收的临时世界”重新变成长命对象系统。

更关键的是，`ci` 域前两篇反复强调过：普通镜像不跨编译复用。既然对象天然只活一场编译，那最合理的释放方式就不是“逐个回收”，而是“整场编译结束时把整块 Arena 一起扔掉”。

换句话说，逐个析构并不是做不到，而是它在这个世界观里根本不划算。

### 朴素方案二：编译器直接读活的 `MethodData`，反正它就在 VM 里

第二个想法和上一篇开场的问题很像。`MethodData` 本来就活在 VM 里，里面已经攒着 invocation count、backedge count、类型 profile、分支 profile。那编译器为什么不一边编一边直接看活的 MDO？

问题是，MDO 正在被写。解释器还在继续记 profile，别的线程还在继续增长计数，甚至 concurrent class unloading 还会让里面一部分 metadata 变陈旧。你如果直接抱着活的 `MethodData` 结构边编边读，那么同一次编译里前半段看到的数据和后半段看到的数据就可能不是同一份状态。

对优化器来说，这比“数据不够新”更糟糕。优化器不怕看见一份稍旧的快照，它怕的是同一次编译内部失去自洽。

所以 `ciMethodData` 的任务不是“把 MDO 包一层更好看”，而是**把仍在变化的 profile 冻成一次编译内部可稳定读取的快照。**

### 朴素方案三：回放时重建一整套“假的 VM 世界”

第三个想法经常出现在理解 replay 时：既然要复现一次历史编译，那是不是得把当时整个 JVM 的状态都重建出来——类加载器、堆对象、类层级、profile、计数器、内联决策、所有相关对象全部克隆一遍？

这听起来最“完整”，实际却过重。JIT replay 真正要复原的不是“一台历史 JVM”，而是**“那次编译看到的输入事实”**。也就是说，哪些类当时已链接、某些 static final 字段值是多少、方法计数器是多少、MDO 里的 profile 数据是什么、内联树当时怎么决策——只要这些输入条件能被重现，编译器就能在当前 debug VM 里重新走出一遍尽量相同的编译过程。

所以 replay 文件记录的不是一份“ci 对象 dump”，也不是整机快照，而是一份“编译输入清单”。而回放时也不是伪造整个 VM，而是在当前 VM 里正常建 `ci` 镜像，然后把那些历史输入覆写进去。

到这里，三个失败方案已经把答案围出来了：

- 清场不能靠逐个对象管理，要靠 Arena 整体回收；
- 稳定读 profile 不能直接抱活的 MDO，要先做本地快照；
- 回放也不该克隆整台 VM，只需要复原那次编译的输入事实。

## 生命周期为什么这么短：一次编译就是一个 `ciEnv`，结束时只做两件事

`ci` 世界的收场方式，其实简单得近乎粗暴。`ciEnv::~ciEnv()` 只有两件显式动作：

- 让工厂把本次编译新建的符号引用计数减回去；
- 把当前编译线程上的 `env` 指针清掉。 `share/ci/ciEnv.cpp:215`、`share/ci/ciEnv.cpp:218`、`share/ci/ciEnv.cpp:221`

这两步之外，你看不到“遍历所有 `ciObject` 逐个 delete”的代码。原因很直接：**Arena 才是真正的释放者。**

普通 `ci` 对象、分析器对象、profile 快照、方法块图，全都活在这次编译的 Arena 里。编译结束，Arena 整体作废，对象就跟着一起消失。这个模型的价值恰恰在于，它不要求每个临时对象自己管理寿命，也不要求工厂维护一个能跨编译存活的活对象图。

那为什么还需要 `remove_symbols()`？因为符号这一层有额外的 VM 侧引用计数语义。`ciObjectFactory::get_symbol()` 对非 vmSymbols 的符号会新建 `ciSymbol`，并把它记进 `_symbols`。编译结束时，`remove_symbols()` 逐个把这些符号的 refcount 减回去。这里补的是“Arena 以外那点还需要显式善后的资源”，不是在替代 Arena 回收对象本身。`share/ci/ciObjectFactory.cpp:209`、`share/ci/ciObjectFactory.cpp:217`、`share/ci/ciObjectFactory.cpp:218`、`share/ci/ciObjectFactory.cpp:222`、`share/ci/ciObjectFactory.cpp:223`、`share/ci/ciObjectFactory.cpp:226`

而 `set_env(NULL)` 也不是随手清个指针那么简单。源码注释明确提醒：这样做要在受保护的 VM 入口语境里，因为 `RedefineClasses` 之类的逻辑可能正在通过这个 env 指针看编译上下文。也就是说，连“清场”这件事 HotSpot 都没有假设世界是静止的。`share/ci/ciEnv.cpp:216`、`share/ci/ciEnv.cpp:219`、`share/ci/ciEnv.cpp:220`

到这里，这一节最该记住的一句话是：**`ci` 世界的默认寿命管理不是对象级，而是会话级。**

## replay 文件录下来的不是“ci 对象”，而是“那次编译看到的输入”

既然普通 `ci` 对象死得这么彻底，那要怎么复原某次历史编译？答案不是把它们留住，而是把**那次编译赖以成立的输入事实**另外记下来。

`ciEnv::dump_compile_data()` 和 `dump_replay_data_unsafe()` 就在做这件事。前者负责把“本次编译任务是什么、入口 bci 是多少、编译层级是多少、内联决策是什么”写出去；后者则枚举工厂里当前已有的所有 `ciMetadata`，让每个对象各自把 replay 所需的数据打印出来。`share/ci/ciEnv.cpp:1203`、`share/ci/ciEnv.cpp:1209`、`share/ci/ciEnv.cpp:1214`、`share/ci/ciEnv.cpp:1231`、`share/ci/ciEnv.cpp:1239`、`share/ci/ciEnv.cpp:1242`、`share/ci/ciEnv.cpp:1244`

这一步很能说明 replay 的粒度。`ciEnv` 并没有在文件里写“第 42 号 `ciMethod` 对象内存长什么样”，而是写：

- 某个类在那次编译时是否已链接、是否已初始化、常量池 tag 序列是什么；
- 某些 static final 字段值是什么；
- 某个方法的解释器调用计数、回边计数、指令大小快照是什么；
- 某个 `ciMethodData` 的 header、profile data、类型 profile、方法 profile 是什么；
- 本次编译入口和内联树是什么。

`ciInstanceKlass::dump_replay_data()` 里尤其典型：它会输出常量池 tag 状态，并在类已初始化时把本地 static final 字段也一并打印出来。源码注释直接说了，后者是为了防止“编译依赖它们的值”。`share/ci/ciInstanceKlass.cpp:728`、`share/ci/ciInstanceKlass.cpp:729`、`share/ci/ciInstanceKlass.cpp:732`、`share/ci/ciInstanceKlass.cpp:738`、`share/ci/ciInstanceKlass.cpp:739`

`ciMethodData::dump_replay_data()` 也一样：它写的不是“某个对象地址”，而是 MDO 头部原始字节、data 区原始内容，以及那些原本以 oop/metadata 形式埋在 profile 里的引用，重新编码成“偏移 + 类名/方法”的形式，供回放时再重建。`share/ci/ciMethodData.cpp:673`、`share/ci/ciMethodData.cpp:685`、`share/ci/ciMethodData.cpp:693`、`share/ci/ciMethodData.cpp:703`、`share/ci/ciMethodData.cpp:707`、`share/ci/ciMethodData.cpp:733`

所以 replay 文件的本质不是“保存短命 ci 对象”，而是“保存让那次编译成立的输入事实”。

## replay 为什么是 debug VM 的工具，而不是普通运行时功能

理解了 replay 文件的内容，再看回放入口就更清楚了。`ciReplay.hpp` 顶部的注释把边界说得很死：这些 replay 函数只存在于 debug 版本 VM。它同时也把三种数据来源讲清楚了：

- 编译线程 crash 时，按 `DumpReplayDataOnError` 自动生成；
- 正常运行时用 `CompileCommand=...DumpReplay` 主动导出；
- 只有 core 文件时，还可以靠 SA 提取。`share/ci/ciReplay.hpp:33`、`share/ci/ciReplay.hpp:36`、`share/ci/ciReplay.hpp:41`、`share/ci/ciReplay.hpp:59`、`share/ci/ciReplay.hpp:63`、`share/ci/ciReplay.hpp:74`

真正回放时，`ciReplay::replay()` 只是调 `replay_impl()`，然后销毁 VM 并退出。`replay_impl()` 读取 replay 文件、交给 `CompileReplay` 解析和 `process`，没有正常业务程序要继续跑。注释里也说得很清楚：VM 在初始化后就把这份编译任务塞进 compile queue，自己进入等待，等回放编译结束后直接退出。`share/ci/ciReplay.cpp:1037`、`share/ci/ciReplay.cpp:1040`、`share/ci/ciReplay.cpp:1074`、`share/ci/ciReplay.cpp:1090`、`share/ci/ciReplay.cpp:1093`、`share/ci/ciReplay.hpp:76`、`share/ci/ciReplay.hpp:77`、`share/ci/ciReplay.hpp:79`

这就决定了 replay 的定位：它不是“让用户在生产环境里稳定复用某次编译”的功能，而是 **HotSpot 工程师把一场已经消失的编译重新搬上实验台的调试机制。**

这里最容易产生的误解是把 replay 想成某种“持久化 JIT cache”。两者完全不是一回事。JIT cache 追求运行时复用产物；replay 追求离线重现编译输入与决策过程。

## 回放真正复活的，不是那批 `ci` 对象，而是“那次编译看到的事实”

理解 replay 最关键的一步，是别把它想成“把旧 `ciMethod`、旧 `ciMethodData`、旧 `ciInstanceKlass` 对象复活”。HotSpot 从来没想这么做。

真正的回放流程是：**当前 debug VM 照常建自己的 `ci` 世界，然后 `ciReplay::initialize(...)` 在镜像构造过程中，把录制文件里的历史输入覆写到这些新镜像上。**

这在 `ciMethod` 和 `ciMethodData` 两个钩子里都看得很清楚。

`ciMethod` 构造末尾，如果开了 `ReplayCompiles`，就调用 `ciReplay::initialize(this)`。回放代码会去 replay state 里找对应的方法记录，然后把解释器调用次数、throwout 次数、invocation counter、backedge counter 等数据灌回当前环境里的 `ciMethod` / `MethodCounters`。注意，类和方法本身还是当前 VM 正常解析出来的，只是“这次编译看到的方法热度与状态”被改写成了历史值。`share/ci/ciMethod.cpp:149`、`share/ci/ciMethod.cpp:151`、`share/ci/ciMethod.cpp:152`、`share/ci/ciReplay.cpp:1206`、`share/ci/ciReplay.cpp:1215`、`share/ci/ciReplay.cpp:1226`、`share/ci/ciReplay.cpp:1227`、`share/ci/ciReplay.cpp:1231`

`ciMethodData` 也是同一个路子。`load_data()` 在把 MDO 快照拷进当前 Arena 之后，如果 `ReplayCompiles` 打开，就再调用 `ciReplay::initialize(this)`。回放逻辑会拿录制的类/方法引用列表，用当前 env 的 `get_metadata()` 重新解析成本次回放环境里的 `ciKlass`/`ciMethod`，然后把历史的 data 数组、header 原始字节等内容覆写到当前 `ciMethodData` 里。`share/ci/ciMethodData.cpp:250`、`share/ci/ciMethodData.cpp:255`、`share/ci/ciMethodData.cpp:256`、`share/ci/ciReplay.cpp:1115`、`share/ci/ciReplay.cpp:1133`、`share/ci/ciReplay.cpp:1139`、`share/ci/ciReplay.cpp:1140`、`share/ci/ciReplay.cpp:1146`、`share/ci/ciReplay.cpp:1152`、`share/ci/ciReplay.cpp:1157`、`share/ci/ciReplay.cpp:1164`

这一步特别值得收成一句人话：**回放不是复活旧对象，而是把旧输入灌进新对象。**

这就是为什么 replay 文件里要用类名、方法名、偏移这些“可在新 VM 里再定位”的描述，而不是直接存死指针。

## `ciMethodData` 为什么必须先快照：因为编译器要看的不是“最新 profile”，而是“本次编译内部一致的 profile”

回到第三件事：编译期间怎么稳定读 MDO。

`ciMethod::ensure_method_data()` 很能说明 HotSpot 的态度。它并不是在 `ciMethod` 构造时就强制给每个方法配上 `ciMethodData`。如果方法是 native、abstract 或 accessor，直接返回 true；如果 VM 侧还没有 MDO，就现场调用 `Method::build_interpreter_method_data` 造一个；若最终有了 `MethodData*`，再由当前 env 把它翻成 `ciMethodData` 并 `load_data()`。否则就退回空的 `ciMethodData`。`share/ci/ciMethod.cpp:961`、`share/ci/ciMethod.cpp:965`、`share/ci/ciMethod.cpp:967`、`share/ci/ciMethod.cpp:970`、`share/ci/ciMethod.cpp:976`、`share/ci/ciMethod.cpp:977`、`share/ci/ciMethod.cpp:978`、`share/ci/ciMethod.cpp:979`、`share/ci/ciMethod.cpp:980`

这已经能看出一个关键信号：**`ciMethodData` 不是方法镜像构造时天然自带的一块附属物，而是编译器真的需要 profile 时才现场要的一份快照。**

更有意思的是，`ciMethodData` 构造函数自己几乎什么都不干，只是把 `_data_size`、`_extra_data_size`、`_data`、计数器、状态位、参数区这些字段设成初始空值。也就是说，构造本身只是占位。真正把活的 MDO 变成编译器快照的，是后面的 `load_data()`。`share/ci/ciMethodData.cpp:40`、`share/ci/ciMethodData.cpp:42`、`share/ci/ciMethodData.cpp:46`、`share/ci/ciMethodData.cpp:49`、`share/ci/ciMethodData.cpp:50`

`load_data()` 一开头的注释已经把根问题写透了：它取的是一个 **approximate snapshot**。因为在复制过程中，别的线程可能还在并发更新这些数据。HotSpot 的做法不是去冻结整个解释器世界，而是原子拷 header 和主 data 区，再额外处理 parameter data 和 extra data，最后把其中涉及的 oop/metadata 翻译成当前 env 里的 `ci` 等价物。`share/ci/ciMethodData.cpp:170`、`share/ci/ciMethodData.cpp:179`、`share/ci/ciMethodData.cpp:181`、`share/ci/ciMethodData.cpp:205`、`share/ci/ciMethodData.cpp:209`、`share/ci/ciMethodData.cpp:212`、`share/ci/ciMethodData.cpp:224`、`share/ci/ciMethodData.cpp:227`、`share/ci/ciMethodData.cpp:230`

`load_remaining_extra_data()` 这一段也很说明问题：extra data 里可能埋着对 `Method*` 的引用，甚至可能遇到 concurrent class unloading 带来的陈旧 metadata。于是它会先在锁下做一轮 `prepare_metadata()`，必要时触发新的 `ciMethod` 缓存填充，再在 `NoSafepointVerifier` 保护下把剩余 extra data 拷进当前快照。`share/ci/ciMethodData.cpp:106`、`share/ci/ciMethodData.cpp:112`、`share/ci/ciMethodData.cpp:114`、`share/ci/ciMethodData.cpp:123`、`share/ci/ciMethodData.cpp:125`、`share/ci/ciMethodData.cpp:127`、`share/ci/ciMethodData.cpp:130`、`share/ci/ciMethodData.cpp:135`

这一步最该记住的结论是：**`ciMethodData` 要防的不是 GC 把 MDO 搬走，而是别的线程还在继续改它。** 编译器真正需要的是一次编译内部能自洽的一份 profile 副本，而不是“永远最新”的实时 MDO。

## `ciMethodData` 快照和 replay，其实是在做同一类事

看到这里，前面三块终于能收成一条线了。

- 生命周期问题的答案是：普通 `ci` 对象不要长寿，Arena 一次回收；
- profile 稳定性问题的答案是：活的 MDO 不要直接读，先拷成 `ciMethodData`；
- 事后回放问题的答案是：死掉的编译不要试图保留对象，另记一份 replay 输入。

看起来是三个技巧，本质上却是一种统一思路：**`ci` 世界自己始终保持短命；一切需要在短命之外继续稳定存在的东西，都不要让 `ci` 对象自己背，而是拆给“快照”与“录制文件”去背。**

`ciMethodData` 冻结的是“现在还活着、但仍在变化的数据”；replay 文件冻结的是“那次编译已经消失，但以后还想再喂给编译器的数据”。前者服务当前编译的稳定读取，后者服务未来调试的确定性重演。它们做的其实是同一类动作：**把外部还会变化或已经消失的输入，冻结成一份编译器可重复消费的事实。**

## 收网：`ci` 世界之所以能“短命而不乱”，靠的是 Arena、快照和 replay 三件套

现在可以把整个 `ci` 域收起来了。

`ci` 镜像层前两篇之所以能这么坚决地坚持“一次编译一份快照，用完即弃”，不是因为 HotSpot 不在乎调试、profile、收尾，而是因为它把这些额外需求拆开处理了：普通镜像与分析结果都交给 `ciEnv` 的 Arena，编译结束整锅端掉；编译过程中需要稳定看的 MDO 内容，翻成 `ciMethodData` 快照留在当前 Arena；而想在事后重现某次编译，就把那次编译看到的类状态、static final、计数器、MDO、内联树等输入事实单独写进 replay 文件，回放时再灌回当前 debug VM 里新建的镜像。`share/ci/ciEnv.cpp:215`、`share/ci/ciObjectFactory.cpp:223`、`share/ci/ciMethod.cpp:965`、`share/ci/ciMethodData.cpp:170`、`share/ci/ciEnv.cpp:1231`、`share/ci/ciReplay.cpp:1115`、`share/ci/ciReplay.cpp:1206`

所以，本篇最核心的一句话不是“`ciReplay` 可以回放编译”，也不是“`ciMethodData` 是 profile 快照”，而是：

**短命的 `ci` 世界并不自己追求长寿；它靠 Arena 管死亡，靠 `ciMethodData` 管当前稳定输入，靠 replay 文件管死后的重演。**

到这里 `ci` 域就收束了。下一篇往外走一步：这些编译任务到底从哪里来、为什么同一个方法会被编多次、谁在排队、谁在唤醒编译线程——那就是 `CompileBroker` 的问题了。

> → [13-jit-framework/01 — `CompileBroker` 编译队列](../13-jit-framework/01-compile-broker-queue.md)
