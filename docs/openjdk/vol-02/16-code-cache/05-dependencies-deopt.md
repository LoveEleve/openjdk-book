# 05. JIT 为什么敢赌未来不会变？— `Dependencies` 与 `Deopt`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot 如何让 JIT 在“当前观察成立、未来世界仍可能变化”的前提下继续做激进优化：编译期用 `Dependencies` 记下可验证契约，运行时在类加载、方法演化、CallSite 变化时对账，契约破裂后再通过 `DeoptimizationBlob`、`vframeArray`、`Location` 把正在执行的编译帧退回解释器帧。各类具体依赖验证算法的全部细节不在本篇逐个展开。
>
> **前置依赖**：[02 — 为什么一段编译方法必须自带完整说明书？— `nmethod` 的结构](02-nmethod-structure.md)、[03 — 为什么过时代码不能当场删？— `nmethod` 的生命周期](03-nmethod-lifecycle.md)、[04 — 机器码怎么知道自己哪里能改？— `Relocation`、`NativeInst` 与 `Inline Cache`](04-relocation-ic.md)
> → **后续**：[38-perfdata/01 — PerfData 架构](../38-perfdata/01-perfdata.md)

到上一章为止，我们已经把一个 `nmethod` 从“怎么住进 CodeCache”“怎么携带自描述结构”“怎么进入生命周期退出通道”“怎么在运行时补丁调用点”这一整条链路走完了。

但这几章其实都还默认了一个更深的前提：**编译器为什么敢把动态语义压成更激进的静态代码？**

比如：

- 为什么一个虚调用有时会被去虚拟化；
- 为什么一个接口调用有时会被当成“当前只有唯一实现者”；
- 为什么某些 finalizer 相关路径可以被省掉；
- 为什么某些 `CallSite` 目标值会被当成稳定事实记进优化结果。

这些优化之所以成立，并不是因为 JVM 拿到了某种“永恒真理”，而只是因为**编译当下**看到的世界暂时满足某些条件。问题在于，类会继续加载，方法会继续演化，`invokedynamic` 背后的目标也可能继续变。那 JIT 为什么还敢据此下注？

所以这篇真正要回答的问题是：**JIT 明明知道未来类加载、方法演化、CallSite 目标变化都可能把当前观察打破，它为什么还敢做去虚拟化、唯一实现者假设、finalizer 跳过这类激进优化？而一旦赌输了，为什么不是局部修一下调用点，而是常常整段代码失效、整串内联 Java 帧都得退回解释器？**

先把答案压成一句话：**`Dependencies` 是 JIT 写下的“下注契约”：我之所以敢把某段动态语义压扁成静态代码，是因为我赌当前世界满足某个具体陈述。`Deoptimization` 则是契约失效后的退场保险：一旦类层次、方法内容或 `CallSite` 目标打破这些陈述，HotSpot 不去现场修补所有受影响机器码，而是让整段 `nmethod` 退出入口资格，并用 `ScopeDesc + vframeArray + UnrollBlock` 把正在执行的编译帧整串还原成解释器帧，再重新观察、重新编译。**

把这句话记住，后面“依赖类型枚举”“witness”“UnrollBlock”“unpack_frames”这些名字就都会回到同一条主线上。

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：JIT 只有完全确定未来不会变时才优化

这是最稳妥的第一反应。

如果编译器只在“这个类永远不会有新子类”“这个接口永远不会有第二个实现者”“这个 `CallSite` 目标永远不会变”这些绝对命题成立时才做优化，那当然最安全。

问题是，这几乎等于放弃 HotSpot 最有价值的一大类优化。

因为 Java 运行时的很多高收益优化，本来就是建立在“当前世界看起来是这样”的观察上，而不是建立在语言层面彻底封死变化的承诺上。类加载器会继续工作，动态链接会继续解析，程序的执行轨迹也会继续暴露新的类型事实。如果编译器要求“一定永远不变”才肯动手，那很多去虚拟化、内联、逃逸消除、调用折叠都会做不出来。

也就是说，JIT 的现实世界并不是“先证明绝对真理，再安全优化”，而是“**先基于当下最可信的观察下注，再准备好赌输时的退路**”。

这也是 `Dependencies` 设计存在的根本原因：它不是在记录“永远成立的性质”，而是在记录“我这次优化依赖了哪些暂时成立、但可被重新核验的事实”。

所以第一种朴素方案失败，不是因为 HotSpot 喜欢冒险，而是因为**不冒险就做不出足够激进的优化**。

### 朴素方案二：就算赌输了，也只要局部修一下调用点

第二个很自然的想法是：好，我接受 JIT 会下注。但如果某个赌注破了，干嘛要整段 `nmethod` 失效？像上一章 inline cache 那样，补一下调用点不就够了。

这个想法只对了一半。

如果某个优化只改变了“这次调用暂时指向哪儿”，那确实可以局部补丁，IC 就是干这个的。但很多 dependency 驱动的优化影响的远不只是一个 call target，而是**整段代码的世界观**。

比如：

- 一个虚调用被去虚拟化以后，后续整个内联体都可能已经被铺进当前方法；
- 某个对象分配因为逃逸分析被消掉，后面读写都改写成了标量值；
- 某个 finalizer 路径因为“没有 finalizable 子类”而被整个略过；
- 某个 `CallSite` 目标稳定性被用来常量传播到更深层控制流里。

这些结果不是“把调用目的地从 A 改成 B”那么局部，而是已经把动态语义压扁进整片图和整段机器码里了。一旦基础假设失效，局部修一个入口地址并不能把整段代码重新变回“未优化之前的保守版本”。

这就是 dependency 失效和 inline cache miss 的根本分界：

- IC miss 常常只是“这个调用点的观测值变了”；
- dependency 失效常常意味着“**编译期对这段代码所依据的世界模型本身变了**”。

所以第二种朴素方案的问题是：它把“局部调用缓存失效”和“整体优化前提失效”混成了一类问题。

这也正是本篇后半要讲 deopt 的原因：当赌注已经渗进整段编译结果时，真正的补救方式不是局部修补，而是让整段代码安全退场。

## 依赖契约：JIT 到底把什么写成了赌注

先看契约本体。

`dependencies.hpp` 里的 `DepType` 枚举，就是 HotSpot 明确定义出来的一组“可以下注、也必须能被逐条验证”的命题集合。里面包括：

- `leaf_type`
- `abstract_with_unique_concrete_subtype`
- `abstract_with_no_concrete_subtype`
- `concrete_with_no_concrete_subtype`
- `unique_concrete_method`
- `abstract_with_exclusive_concrete_subtypes_2`
- `exclusive_concrete_methods_2`
- `unique_implementor`
- `no_finalizable_subclasses`
- `call_site_target_value`
- 以及 `evol_method` 这种“方法内容被用过，演化后必须重编”的依赖。`share/code/dependencies.hpp:104`

第一次看这串枚举，很容易把它当成一张“优化点清单”。

但更准确的理解是：**它们是 HotSpot 允许编译器写下的契约模板。**

也就是说，编译器不能泛泛地说“我感觉这个类层次挺稳定”“我猜这里只有一个实现者”。它必须把这种感觉写成某一种被系统预定义、可核验的具体陈述。

### 为什么依赖类型必须是“具体陈述”

拿几个例子看最清楚。

`unique_concrete_method` 不是在说“这个调用我优化了”，而是在说：在某个 context class 下，与某个方法签名和 vtable index 相匹配、真实可能被调到的具体方法集合，目前不超过这一个。`share/code/dependencies.hpp:125`

`unique_implementor` 不是在说“这个接口看起来现在只有一个实现类”，而是在说：在当前世界里，这个接口下面的唯一实现者就是某个具体类型。`share/code/dependencies.hpp:160`

`no_finalizable_subclasses` 也很有代表性。它不是说“我做了 finalizer 优化”，而是在说：当前这个类及其子类中，不存在需要 finalization 注册的实例路径。`share/code/dependencies.hpp:163`

连 `call_site_target_value` 这种看起来偏 invokedynamic 世界的依赖，也被定义成明确命题：我赌某个 `CallSite.target` 当前就是这个值。`share/code/dependencies.hpp:167`

这才是 dependency 系统真正的精髓：**每条契约都必须被表达到足够具体，才能在未来某个变化点被逐条核验。**

所以 `Dependencies` 不是“记录优化发生过”，而是“记录优化依赖了什么具体可检验事实”。

## 编译期记账：为什么还要登记反向索引

有了契约模板，下一步就是编译期怎样记账。

HotSpot 这里的思路并不神秘：某次优化一旦基于某个假设成立，就在 `Dependencies` 对象里记一笔。比如基于唯一具体方法做优化时，会走 `assert_unique_concrete_method(...)` 这类接口。

真正的记账底层会落到 `assert_common_2`、`assert_common_3` 这样的公共函数上。以 `assert_common_2` 为例，它会：

- 根据依赖类型找到对应 bucket；
- 看是否已有相同或可合并的断言；
- 必要时做去重或 context merge；
- 最后把参数 append 进这一类依赖自己的数组。`share/code/dependencies.cpp:236`

这说明依赖记录并不是随手写几行日志，而是一套**类型分桶、去重、结构化持久化**的账本。

### 为什么除了写进 `nmethod`，还要登记到被依赖对象身上

如果只是把依赖清单塞进 `nmethod` 的 dependencies 段，似乎已经能在需要时再拿出来检查了。那为什么还要有第二步，把它们登记到被依赖的类或 `CallSite` 侧？

答案就在 `nmethod.cpp` 那段注释里：这样做是为了让类加载时的 dependency checking 足够快。否则“慢办法”就是每次变化都检查 every nmethod，这对类很多的应用来说太慢。`share/code/nmethod.cpp:512`

真正的登记逻辑也很直接：

- 如果依赖类型是 `call_site_target_value`，就把 `nmethod` 登记到这个 `CallSite` 的依赖列表里；
- 否则取出 context klass，把 `nmethod` 登记到对应 `InstanceKlass` 的依赖列表里。`share/code/nmethod.cpp:521`

这就是典型的反向索引思想：

- 正向看，`nmethod` 知道自己赌了谁；
- 反向看，被赌的类或 `CallSite` 也知道“谁在拿我下注”。

这一步非常关键，因为它把未来对账时的复杂度从“全量扫 CodeCache”降成了“**沿着发生变化的对象局部追溯受影响者**”。

所以编译期记账实际上分两层：

- 把契约正文写进 `nmethod`；
- 再把“谁在赌我”记到相关类或 `CallSite` 身上。

没有第二层，dependency 系统就很难在类加载和动态变化频繁的真实 JVM 里高效工作。

## 运行时对账：谁来证明契约被打破了

有了契约和反向索引，下一步就是对账。

这里最值得强调的一点是：**HotSpot 不会在平时热路径上反复检查依赖是否还成立。** 它把验证成本压到“世界发生变化”的时刻——类加载、方法演化、`CallSite` 目标变化这些事件上。

这也是 dependency 系统相比“每次调用前都做防守式检查”的巨大优势：平时零额外成本，出事时再集中核验。

### `spot_check_dependency_at`：先判断这条契约跟这次变化有没有关系

真正的入口非常直接：`DepStream::spot_check_dependency_at(DepChange& changes)`。它先看这次变化是不是 klass change，且是否涉及这条 dependency 的 context type；如果是，就走 `check_klass_dependency`。否则如果是 `CallSite` 变化，就走 `check_call_site_dependency`。再不相关，就直接跳过。`share/code/dependencies.cpp:2047`

这一步很像合同审查里的第一道筛选：先别急着翻条款细节，先看这次事故是不是压根和这张合同有关。

### `check_klass_dependency` / `check_call_site_dependency`：逐条契约逐条核验

如果有关，接下来就进入真正的一对一核验。

`check_klass_dependency` 的 switch 非常能说明问题：

- `leaf_type` 对应 `check_leaf_type`；
- `abstract_with_unique_concrete_subtype` 对应 `check_abstract_with_unique_concrete_subtype`；
- `unique_concrete_method` 对应 `check_unique_concrete_method`；
- `unique_implementor` 对应 `check_unique_implementor`；
- `no_finalizable_subclasses` 对应 `check_has_no_finalizable_subclasses`。`share/code/dependencies.cpp:1984`

而 `call_site_target_value` 则走单独的 `check_call_site_target_value`。`share/code/dependencies.cpp:2029`

这再次印证前面的主线：**依赖不是模糊信任，而是具体契约，所以验证函数也必须一条契约对应一类核验逻辑。**

### witness 是什么：不是“发现变化了”，而是“找到了打脸证据”

这些 `check_xxx` 最终都返回一个 `witness`。这个设计特别值得停一下。

它不是只返回 `true/false`，而是返回“把这条契约打破的见证者”。比如某个原本声称“只有一个具体子类”的 context，现在真的多出了第二个子类；某个原本唯一的具体方法集合，现在真的发现了第二个实现；某个原本不该 finalizable 的家族里，现在真的出现了需要 finalization 的子类。

也就是说，依赖验证不是在问“我心里不舒服”，而是在问：**有没有找到一个具体新事实，足以证明当初的赌注现在已经不成立。**

这就是为什么 dependency 系统既敢让编译器下注，又不会沦为含糊的启发式系统。它的失效是有证据的，不是拍脑袋的。

## 为什么赌输后常常要整段 deopt，而不是局部修补

到这里终于能回到开头那个最关键的问题：既然 dependency 是逐条契约、逐条核验的，为什么赌输后往往还是整段 `nmethod` 退场？

答案在于：**契约约束的不是一个表面地址，而是整段编译代码成立的前提。**

上一章的 inline cache 补丁之所以能局部修，是因为它解决的主要是“这个调用点当前该跳到谁”——哪怕目标变了，调用的整体语义结构还在，调用点依然是调用点。

但 dependency 驱动的优化经常已经把更大范围的动态结构压扁了：

- 某个虚调用可能已经不再是“查分派再调”，而是直接内联成了一串静态代码；
- 某个接口唯一实现者假设可能让后续控制流、类型流和对象形状都被特化；
- 某个 `CallSite` 目标常量可能已被向下传播进更深的图优化；
- 某个 finalizer 约束可能让整条初始化路径被删减。

所以 dependency 破裂时，不是“这个 call target 要改一下”，而是“**编译器当时理解这段程序的方式已经失效了**”。

这就是为什么 HotSpot 的策略不是“尝试把坏掉的那一小块本地修回来”，而是让这段 `nmethod` 退出入口资格，再把正在里面执行的编译帧整体退回解释器，让程序回到那个最保守、最能重新观察真实世界的执行模型上。

这一步看似重，但其实是最稳定的办法：解释器永远知道怎样按最新世界语义执行；JIT 则可以在观察够新的数据后重新编译出新版本。

所以本篇最该记住的分界线是：**IC 是局部缓存修补；dependency 失效往往意味着整体编译世界观失效。**

## 退场保险：`DeoptimizationBlob` 怎么把机器帧还原回 Java 帧

既然赌输了常常需要整段退场，执行线程此刻如果还在 `nmethod` 里面怎么办？

这就是 deopt 的真正价值：不是“判代码错了”，而是“**把已经跑进优化世界的线程安全送回解释器世界**”。

`DeoptimizationBlob` 正是这条退场通道的入口。它在 `codeBlob.hpp` 里直接暴露了多个入口：

- `unpack()`
- `unpack_with_exception()`
- `unpack_with_reexecution()`
- 以及 C1 特有的 `unpack_with_exception_in_tls()`。`share/code/codeBlob.hpp:554`

这已经说明 deopt 不是单一动作，而是一组退场模式：普通退场、带异常退场、需要重新执行当前字节码的退场、以及 C1 的特殊异常路径。

### 第一步：`fetch_unroll_info` 先把“要还原成什么”算出来

真正的重建流程不是一头扎进汇编乱铺帧，而是先让 C++ 把账算清。

`fetch_unroll_info()` 在 deoptimization handler 一开始被调用，并把实际工作交给 `fetch_unroll_info_helper()`。`share/runtime/deoptimization.cpp:139`

而 helper 里最关键的一步，就是从当前 deoptee 编译帧出发，沿 `vframe::sender()` 一路收集所有内联层，构造出一个 `GrowableArray<compiledVFrame*>`。源码注释直接说：这里创建的是一个 growable array，其中每个 `VFrame` 代表一个 inlined Java frame。`share/runtime/deoptimization.cpp:158`、`share/runtime/deoptimization.cpp:184`

这一步的意义非常大。

因为线程此刻虽然只踩着一段机器码，但那段机器码背后可能折叠了多层 Java 调用链。deopt 不是把“一帧机器帧”退回“一帧解释器帧”，而是要把这条被内联压扁的语义栈重新展开。

所以 `fetch_unroll_info_helper()` 本质上先在回答：**你这次不是要退回一个 frame，而是要退回哪一串 Java frames。**

### 第二步：`UnrollBlock` 先算总账，再动手铺栈

前面收集到的 `compiledVFrame` 链不会直接变成解释器帧，它们还要先被整理成一份“怎么拆、要拆多大、返回值怎么带、需要多少 caller 参数”的总计划。

这份总计划就是 `UnrollBlock`。虽然这部分细节在现稿里没有被完全拆开，但 `deoptimization.hpp` 已经明确说它是由 `fetch_unroll_info()` 返回给 deoptimization handler 的对象。`share/runtime/deoptimization.hpp:176`

这一步的设计味道非常明确：**先算账，再施工。**

因为解释器帧比编译帧更胖，内联展开后还可能要恢复多层 locals、expressions、monitors。如果不先统一算好，会把本就脆弱的退场流程搞成边铺边猜的混乱现场。

### 第三步：`unpack_frames` 把骨架解释器帧填成真帧

等前面的账都算好之后，`unpack_frames()` 会从线程当前的 `vframe_array_head()` 取出 `vframeArray`，拿到 `UnrollBlock`，再调用 `array->unpack_to_stack(...)`。`share/runtime/deoptimization.cpp:623`

`vframeArray::unpack_to_stack()` 的注释也很直白：当前栈上已经有“skeletal but walkable”的新解释器帧骨架，这个函数负责把缺的数据填进去。`share/runtime/vframeArray.cpp:567`

这就是 deopt 两段式设计的关键：

- 前一段先决定要恢复哪些 Java 帧，以及每层值从哪里来；
- 后一段再按计划把这些解释器帧真正填成可继续执行的状态。

这样一来，汇编桩负责最机械的铺架子，真正的语义决策集中在 C++ 里完成，错误面就小得多。

## 值是怎么找回来的：`Location` 与 `ScopeValue` 地图

讲到这里，还有最后一个最容易被低估的点：deopt 不是“把返回地址改一改，跳回解释器”就完了。

真正困难的是：**解释器帧里的 locals、表达式栈、监视器状态，到底要从当前编译帧的哪里取回来？**

这一步仍然依赖上一篇建立的自描述地图系统。`ScopeDesc` 负责指出“某层 Java 帧有哪些值需要恢复”，而具体“这个值现在躺在编译帧的寄存器里还是栈槽里、它是普通整数还是 oop 或 narrowoop”，则由 `Location` 这类编码来表达。

`Location` 里最关键的就是两组枚举：

- `Where`：`on_stack` 或 `in_register`；
- `Type`：`normal`、`oop`、`narrowoop`、`dbl`、`lng` 等。`share/code/location.hpp:45`

这说明 deopt 恢复的不是抽象值名字，而是非常具体的“取值说明书”：

- 值现在在哪；
- 它应该按什么类型解读；
- 它如果是 oop，还要不要按 GC 规则参与后续解释器帧语义。

这就是为什么 deopt 能把优化过、寄存器分配过、栈槽复用过的编译状态再拉回 Java 语义层。它不是盲猜，而是消费编译时就留下的值位置信息。

所以本篇后半真正要记住的一句话是：**deopt 恢复的不是“控制流能继续跑”，而是“Java 语义状态也能继续成立”。**

## 到这里为止，主线其实只发生了五件事

如果前面细节较多，这里先把整件事压回五个动作：

1. JIT 基于当前观察做激进优化时，会把前提写成具体依赖契约；
2. 这些契约既写进 `nmethod`，也反向登记到被依赖的类或 `CallSite` 上；
3. 世界变化时，HotSpot 只对相关契约逐条核验，并用 witness 证明哪条契约被打破；
4. 如果破裂影响的是整段编译世界观，而不是单个调用缓存，就让 `nmethod` 退场；
5. `DeoptimizationBlob + vframeArray + Location` 再把正在执行的编译帧整串恢复成解释器帧。

只要这五步还在脑子里，`Dependencies` 和 `Deopt` 就不会再显得像两套孤立机制。

## 常见误解澄清

### 误解一：Dependencies 只是调试日志

不是。

它们是编译器正式写下的可验证契约，后续类加载、方法演化、`CallSite` 变化都要靠它们逐条对账。没有这些契约，HotSpot 既不敢激进优化，也无法知道赌输后该让谁退场。`share/code/dependencies.hpp:104`

### 误解二：witness 只是“发现了新类”这么粗糙

不对。

witness 的意义是“找到了能把某条具体契约打破的见证事实”。它对应的是某条依赖验证函数返回的实际反例，而不是含糊地说“世界有变化了”。`share/code/dependencies.cpp:1984`

### 误解三：`CallSite` 目标变化不属于同一套契约框架

也属于。

`call_site_target_value` 就是正式的依赖类型之一，而且它走的是 `CallSite` 自己的反向依赖登记路径，不和 klass 侧混在一起。`share/code/dependencies.hpp:167`、`share/code/nmethod.cpp:521`

### 误解四：deopt 就是简单跳回解释器入口

不是。

它要先收集整串内联 `compiledVFrame`，算出 `UnrollBlock`，再把骨架解释器帧填成完整可执行状态。恢复的是整串 Java 语义帧，不只是程序计数器。`share/runtime/deoptimization.cpp:158`、`share/runtime/deoptimization.cpp:623`

### 误解五：dependency 失效和 IC miss 没什么本质区别

区别很大。

IC miss 常常只是调用点缓存失效；dependency 失效往往意味着整段代码所依赖的编译世界观失效，局部补丁已经不够，必须整体退场并重新观察。这个边界正是上一章和本章的分界线。

## 收网：`Dependencies` 是下注契约，`Deopt` 是退场保险

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
编译期
  C1/C2 观察当前世界
    └─ assert_xxx(...) 记下依赖契约
         ↓
  dependencies 段 + 反向索引
    ├─ nmethod 自带赌注清单
    └─ 被依赖类 / CallSite 反向记住“谁在赌我”

世界变化时
  类加载 / 方法演化 / CallSite 变化
    └─ spot_check_dependency_at / check_xxx
         ↓ witness != NULL
  标记 nmethod for deoptimization / not_entrant

执行线程仍在代码里时
  DeoptimizationBlob
    ├─ fetch_unroll_info -> 收集内联 vframes / 计算 UnrollBlock
    └─ unpack_frames -> 把编译帧还原成解释器帧
```

把它再压成三句话：

- `Dependencies` 让 JIT 不必等到“未来永远不会变”才优化，而是可以把优化前提写成可核验契约。
- 契约一旦破裂，HotSpot 不去临时修补整段已经被压扁的优化结果，而是让 `nmethod` 整体退出前台。
- `Deopt` 的价值不是“认错”，而是把已经深入优化世界的执行线程安全送回解释器世界，再重新观察、重新编译。

所以 HotSpot 之所以敢激进，不是因为它相信自己永远正确。

恰恰相反，是因为它把“不永远正确”这件事工程化了：**编译时敢下注，运行时能对账，赌输后有保险，退场后还能重来。**

这也正好给 16 域做了收尾。到这里，一段编译代码从诞生、安家、携带语义、运行时补丁、进入退出协议，再到依赖失效后的整体退场，这一整条生命链路已经闭环。

下一域会换一个视角：这些编译、清扫、去优化、补丁动作在运行中都离不开一类东西——计数器、采样、事件和可观测数据。JVM 是怎么把这些运行时数字组织出来，又怎样让 `jstat`、JFR、管理接口看到它们的？后面转到 PerfData。

> → [38-perfdata/01 — PerfData 架构](../38-perfdata/01-perfdata.md)
