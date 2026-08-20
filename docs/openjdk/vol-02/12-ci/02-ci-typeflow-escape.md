# 02. 编译器怎么知道“类型”与“逃逸”？— `ciTypeFlow + BCEscapeAnalyzer`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 使用的两台字节码级保守分析器：`ciTypeFlow` 与 `BCEscapeAnalyzer`。它们都运行在 `COMPILER2` 路径上，服务于 IR 构建和后续优化。最终的全局逃逸分析与标量替换兑现，发生在 C2 的 `ConnectionGraph` / `escape.cpp` / `macro.cpp`，本文只讲它们如何消费字节码级分析结果。
>
> **前置依赖**：[12-ci/01 — JIT 怎么看到 Java 类？— `ciObject` 镜像体系](01-ci-overview-mirror.md)、[08-interpreter/01 — 一条字节码的“档案”在哪？— Bytecode 定义表](../08-interpreter/01-bytecodes-definition.md)、[44-class-verification/01 — 恶意字节码怎么被拦下？— `ClassVerifier` 类型检查引擎](../44-class-verification/01-verifier.md)
> → **后续**：[12-ci/03 — `ciObjectFactory + ciReplay` — `ciObject` 生命周期与编译回放](03-ci-factory-runtime.md)

上一篇我们已经把 `ci` 镜像层拆开了：JIT 并不直接抱着 `InstanceKlass`、`Method`、`oop` 这些 VM 活对象跑，而是先把它们降成一份编译期稳定视图。那一篇解决的是“编译器如何安全地看见对象与元数据”。

但只看到这些对象，离真正做优化还差得很远。

编译器真正要回答的问题不是“这个方法是谁”，而是更细的两类问题：

- **执行到某个 bci 时，局部变量表和操作数栈里现在是什么类型？**
- **某个参数或新建对象，最后会不会跑出当前方法或当前调用链？**

这两张地图，`ciMethod`、`ciField`、`ciKlass` 并不会直接给。它们给的是“对象视图”，不是“程序点状态视图”。

于是 HotSpot 还得再做两次推导：

- `ciTypeFlow` 在字节码层面做一次抽象解释，算每个程序点的类型状态；
- `BCEscapeAnalyzer` 在字节码层面做一次快速、保守的逃逸估计，算对象与参数可能跑到哪里去。

也就是说，**编译器之所以还得在字节码层把方法自己“再跑一遍”，不是因为它没看见类和方法，而是因为它还没拿到“方法执行到每个点时可能是什么状态”这张地图。**

先把这句记住。后面无论是 `StateVector`、`meet`、`trap`，还是参数位图、乐观初始化、保守降级，都是在为这件事服务。

## 先试三个最自然的办法，看看为什么都不够

### 朴素方案一：只靠运行时 profile 不就行了吗？

很多人第一次接触内联、去虚拟化时，最先看到的是 profile：比如某个调用点 100% 都看见 `Square`，那就把它当成 `Square` 来优化。这个直觉没错，但它只覆盖了编译器真正想知道的一小部分。

profile 擅长回答“这个调用点过去常见什么接收者”“这条分支过去常走哪边”，却不直接回答“当前 bci 的整个局部变量表和操作数栈长什么样”。一个方法里可能有几十上百个字节码位置，而大多数位置都没有独立的 profile 条目。编译器不能因为 `invokevirtual` 有类型剖面，就顺便知道前一个 `getfield` 压栈的对象是什么、异常边进 handler 时 locals 该长什么样、某个 `aaload` 之后栈顶是不是一个已加载的对象数组元素类型。

更关键的是，很多方法并没有充分热到能积累完整 profile，但编译器照样需要对它们做基本推导。字节码已经摆在那里，编译器不能等“再跑热一点”才知道某个类型状态。

所以 profile 是很有价值的补充信息，但它不是程序点类型地图本身。

### 朴素方案二：那 verifier 和 `ciMethod` 快照里不已经有类型信息了吗？

第二个想法也很自然：类验证器本来就在看类型兼容性，`ciMethod` 也已经把方法的签名、参数、字段、常量池这些都镜像出来了，为什么还要再做一层类型流？

因为 verifier 和 `ci` 镜像回答的其实是两种完全不同的问题。

verifier 的目标是“这段字节码是否合法、会不会破坏 JVM 安全模型”。它当然也会碰类型格、meet、控制流汇合，但它的核心使命是拒绝非法字节码，而不是给优化器产出一张可消费的程序点状态地图。

`ciMethod` 和 `ciField` 这类镜像则更偏“元数据问答”：方法有多大、字段偏移是多少、某个常量池项是否能链接、某个类是不是接口。它们告诉编译器“方法和类是什么”，但并不告诉编译器“方法执行到 bci=29 时，栈里第 0 个槽和 locals[3] 当前是什么抽象类型”。

所以 verifier、`ci` 镜像、类型流三者不是重复关系，而是逐层加码的关系：

- verifier 解决合法性；
- `ci` 镜像解决对象可见性；
- `ciTypeFlow` 解决程序点状态。

把这三者混成一层，是理解这篇最常见的误区。

### 朴素方案三：那编译器干脆把方法真的执行一遍，拿最精确状态不就行了？

第三个想法听起来最“精确”：如果想知道某个程序点的栈状态、某个对象会不会逃逸，那就真执行一遍方法，观察真正发生了什么。

这条路的问题更根本：编译器做的是**静态推导**，不是一次具体运行的观测。真执行一遍，你看到的只是某一组输入、某一路控制流、某一次对象分配行为。可编译器需要的是“对所有可能执行路径都安全”的结论。

例如某个 `if` 的一条分支从来没在这次运行中走到，编译器也不能就当那条分支不存在。某个对象这次没逃逸，不代表下一次输入不同它还不逃逸。优化器需要的是保守覆盖所有可能路径的抽象结果，而不是一次具体运行的精确日志。

所以它真正该做的，不是执行方法，而是 **用一套抽象状态在字节码层模拟执行方法**。这就是 `ciTypeFlow` 和 `BCEscapeAnalyzer` 的出发点。

到这里先立一个路标：这一篇真正要回答的是“为什么编译器还得自己在字节码层再跑一遍方法”，而不是“这两个类都有哪些字段”。

## `ciTypeFlow` 的本质：搭一台不会真的执行代码的“抽象 JVM”

`ciTypeFlow` 的输入不复杂：一个 `ciMethod`、一份 `ciMethodBlocks` 基本块图，以及一个可选的 `osr_bci`。它既能做普通入口分析，也能做从循环内部某个 bci 开始的 OSR 分析。`share/ci/ciTypeFlow.hpp:35`、`share/ci/ciTypeFlow.hpp:37`、`share/ci/ciTypeFlow.hpp:38`、`share/ci/ciTypeFlow.hpp:39`、`share/ci/ciTypeFlow.hpp:57`、`share/ci/ciTypeFlow.hpp:63`、`share/ci/ciTypeFlow.hpp:64`

这已经说明它不是“看一眼方法签名”的辅助器，而是一台真正要沿着字节码基本块跑起来的分析器。构造函数里第一件事也是抓住 method blocks、`max_locals`、`max_stack`、`code_size`，为后续构造抽象 frame 做准备。`share/ci/ciTypeFlow.cpp:1979`、`share/ci/ciTypeFlow.cpp:1982`、`share/ci/ciTypeFlow.cpp:1983`、`share/ci/ciTypeFlow.cpp:1984`、`share/ci/ciTypeFlow.cpp:1985`

这台“抽象 JVM”的核心数据结构是 `StateVector`。它表示某个程序点的抽象状态：局部变量表长什么样、操作数栈长什么样、当前监视器计数是多少。底层是 `ciType** _types` 数组、`_stack_size`、`_monitor_count`。更关键的是，locals 和 stack 共用这一条数组：前半段是 locals，后半段是当前栈。`share/ci/ciTypeFlow.hpp:158`、`share/ci/ciTypeFlow.hpp:160`、`share/ci/ciTypeFlow.hpp:162`、`share/ci/ciTypeFlow.hpp:163`、`share/ci/ciTypeFlow.hpp:164`

也就是说，`StateVector` 就是一张“当前抽象 frame 快照”。`ciTypeFlow` 并不真的在跑解释器，而是在维护一套 “如果控制流走到这里，局部变量和栈上可能有哪些抽象类型” 的数据结构。

为了让这套状态能合并、能收敛，`ciTypeFlow` 还预先定义了一套类型格。最重要的几个特殊点是：

- `T_TOP`：还什么都不知道；
- `T_BOTTOM`：冲突或矛盾；
- `T_NULL`：显式的 null 引用；
- `T_LONG2` / `T_DOUBLE2`：long/double 的第二个槽位。 `share/ci/ciTypeFlow.hpp:175`、`share/ci/ciTypeFlow.hpp:177`、`share/ci/ciTypeFlow.hpp:178`、`share/ci/ciTypeFlow.hpp:179`、`share/ci/ciTypeFlow.hpp:180`、`share/ci/ciTypeFlow.hpp:181`

这套类型格不是装饰。没有它，控制流一汇合，你根本不知道该怎么把两条路径的状态合成一份安全结果。

## 编译器为什么一定要做 meet：因为分支和循环不会替你保持“类型一致”

一旦方法里有 `if`、`switch`、异常边、循环回边，你就不再面对一条直线字节码，而是面对“多个状态可能在同一个块入口相遇”。这时编译器必须回答：我该拿哪一种类型状态继续往下分析？

答案就是 meet。

`StateVector::meet` 会把当前状态和 incoming 状态逐槽合并；只要有某个槽位不同，就交给 `type_meet` 去求一个更保守但仍然安全的结果。返回值还是一个很关键的信号：状态有没有变化。因为只要变化了，后继块就得重新分析。`share/ci/ciTypeFlow.cpp:433`、`share/ci/ciTypeFlow.cpp:438`、`share/ci/ciTypeFlow.cpp:470`、`share/ci/ciTypeFlow.cpp:472`、`share/ci/ciTypeFlow.cpp:476`、`share/ci/ciTypeFlow.cpp:483`

单槽的合并规则全写在 `type_meet_internal` 里，这段源码几乎就是整个类型流的语义中心。

- `top` 遇见任何类型，就让给对方；
- `null` 遇见引用类型，结果是那个引用类型；
- 非 top 的原语类型互相不兼容，直接掉到底部 `bottom`；
- 两个引用类型相遇，一方是 `Object` 就直接退成 `Object`；
- 只要有未加载类，也先退成 `Object`；
- 接口和非接口相遇，也退成 `Object`；
- 两个对象数组会递归合并元素类型；
- 两个普通实例类，则取最近公共父类。 `share/ci/ciTypeFlow.cpp:272`、`share/ci/ciTypeFlow.cpp:274`、`share/ci/ciTypeFlow.cpp:278`、`share/ci/ciTypeFlow.cpp:281`、`share/ci/ciTypeFlow.cpp:292`、`share/ci/ciTypeFlow.cpp:297`、`share/ci/ciTypeFlow.cpp:302`、`share/ci/ciTypeFlow.cpp:305`、`share/ci/ciTypeFlow.cpp:309`、`share/ci/ciTypeFlow.cpp:314`、`share/ci/ciTypeFlow.cpp:336`

这套规则和 verifier 同源，但用途完全不同。verifier 是靠它保证字节码合法；这里则是靠它保证 **优化器接下来看到的状态是安全收敛的**。

这一步最该记住的，不是哪条规则细节，而是这句话：**meet 的本质是“精度往下掉，安全往上升”。**

编译器永远宁可把某个很精确的类型退成 `Object`，也不会为了多拿一点优化空间去猜一个更窄但可能错的类型。类型流允许自己“不够精确”，但绝不允许自己“精确错了”。

## 为什么 `ciTypeFlow` 不是算一遍就完，而是要反复迭代到 fixpoint

如果方法没有分支也没有循环，按字节码线性扫一遍当然够了。但现实里的方法几乎总有控制流汇合，尤其是循环回边。只要有回边，某个块入口的状态就可能先窄后宽，分析必须不断重算直到不再变化。

入口状态怎么来？普通编译下，`get_start_state()` 会把方法签名压进最前面的 locals：非静态方法先把 `this` 放到 local 0，再按签名把参数类型翻译进 locals，剩余 locals 初始化成 `bottom`，同步方法还会把 monitor count 置成 1。`share/ci/ciTypeFlow.cpp:363`、`share/ci/ciTypeFlow.cpp:396`、`share/ci/ciTypeFlow.cpp:398`、`share/ci/ciTypeFlow.cpp:402`、`share/ci/ciTypeFlow.cpp:407`、`share/ci/ciTypeFlow.cpp:415`

OSR 入口更有意思：它不是凭空起步，而是先找普通分析在该 `osr_bci` 处已有的块状态，把那一刻的抽象 frame 复制过来。如果普通分析都到不了那个点，OSR 也直接失败。`share/ci/ciTypeFlow.cpp:368`、`share/ci/ciTypeFlow.cpp:369`、`share/ci/ciTypeFlow.cpp:375`、`share/ci/ciTypeFlow.cpp:377`、`share/ci/ciTypeFlow.cpp:381`

真正的主循环在 `flow_types()`：

1. 建入口块；
2. 把入口状态 `meet` 进去；
3. 深度优先先走一遍块图；
4. 如果发现循环，而且编译层级够高，还可能 clone loop heads；
5. 然后进入 worklist，不断拿块出来重跑 `flow_block()`，直到 worklist 为空。 `share/ci/ciTypeFlow.cpp:2727`、`share/ci/ciTypeFlow.cpp:2733`、`share/ci/ciTypeFlow.cpp:2736`、`share/ci/ciTypeFlow.cpp:2738`、`share/ci/ciTypeFlow.cpp:2741`、`share/ci/ciTypeFlow.cpp:2747`、`share/ci/ciTypeFlow.cpp:2751`、`share/ci/ciTypeFlow.cpp:2774`、`share/ci/ciTypeFlow.cpp:2778`

`flow_block()` 自己就是一台块内小解释器：

- 先把块入口状态复制到临时 `state`；
- 对块内每条字节码，如果它可能抛异常，先把当前状态沿异常边流给 handlers；
- 再调用 `apply_one_bytecode()` 更新当前状态；
- 如果字节码分析触发 trap，就记录 trap 并停在这里；
- 否则继续扫到块尾；
- 最后把状态 meet 给所有正常后继。 `share/ci/ciTypeFlow.cpp:2326`、`share/ci/ciTypeFlow.cpp:2343`、`share/ci/ciTypeFlow.cpp:2359`、`share/ci/ciTypeFlow.cpp:2364`、`share/ci/ciTypeFlow.cpp:2375`、`share/ci/ciTypeFlow.cpp:2396`、`share/ci/ciTypeFlow.cpp:2426`

所以 fixpoint 的必要性其实很朴素：**循环头第一次看到的是“刚进循环”的状态，第二次看到的是“绕了一圈回来”的状态。只有把这两者反复 meet 到不再变化，编译器才真正拿到一个对整个循环都成立的类型地图。**

## 异常边和 `trap` 说明它不是在“执行方法”，而是在构造一张保守状态图

如果把 `ciTypeFlow` 误解成“在编译期跑解释器”，有两处实现会立刻把这种理解打破。

第一处是异常边处理。`flow_block()` 在真正应用一条可能抛异常的字节码之前，就先把当前状态沿异常边送出去。handler 侧不会继承原来的整个栈，而是通过 `meet_exception()` 把 locals 正常合并，同时把栈重置成“只有一个异常对象”。这和真实解释器的语义一致，但它的目的不是去抛异常，而是给 handler 块建立一份抽象入口状态。`share/ci/ciTypeFlow.cpp:2120`、`share/ci/ciTypeFlow.cpp:2135`、`share/ci/ciTypeFlow.cpp:487`、`share/ci/ciTypeFlow.cpp:499`、`share/ci/ciTypeFlow.cpp:503`、`share/ci/ciTypeFlow.cpp:521`

第二处是 `trap`。`StateVector` 明确提供了 `trap(ciBytecodeStream*, ciKlass*, int)`，而 `apply_one_bytecode()` 会在很多“不能安全继续信”的场景下触发它。比如 `anewarray` 的元素类如果不能链接，就 trap；`aaload` 发现元素类没加载，也 trap；`invoke*` 找不到可链接的方法，同样 trap。`share/ci/ciTypeFlow.hpp:464`、`share/ci/ciTypeFlow.hpp:480`、`share/ci/ciTypeFlow.cpp:868`、`share/ci/ciTypeFlow.cpp:898`、`share/ci/ciTypeFlow.cpp:903`、`share/ci/ciTypeFlow.cpp:565`、`share/ci/ciTypeFlow.cpp:567`、`share/ci/ciTypeFlow.cpp:651`、`share/ci/ciTypeFlow.cpp:655`、`share/ci/ciTypeFlow.cpp:663`

有一处 `getstatic/getfield` 的处理特别能看出它的保守味道。字段本身若能链接，但字段类型还没加载，`ciTypeFlow` 并不会立刻 trap；源码注释解释得很细：字段值可能一直是 null，只要没看到非 null，就未必需要把那个类加载起来。因此这里走的是 `do_null_assert`，让后续分析保守继续，而不是武断宣布这条路一定走不通。`share/ci/ciTypeFlow.cpp:613`、`share/ci/ciTypeFlow.cpp:616`、`share/ci/ciTypeFlow.cpp:621`、`share/ci/ciTypeFlow.cpp:626`、`share/ci/ciTypeFlow.cpp:640`

这正好说明 `ciTypeFlow` 的身份：它不是在“证明这条路径一定能执行完”，而是在说“就编译器当前掌握的信息，我还能不能继续安全推导”。一旦不敢继续信，它就 trap 或降级，而不是瞎猜。

## `BCEscapeAnalyzer` 的本质：它不是对象图分析器，而是“对象去向估算器”

`ciTypeFlow` 解决的是“每个程序点此刻栈和 locals 里是什么类型”。但仅有类型还不够，编译器还想知道一件和分配优化直接相关的事：**这个参数或这个新对象，会不会跑出当前方法、当前调用链、甚至全局可见范围？**

`BCEscapeAnalyzer` 就是为这个问题存在的。类注释一上来就把定位写死了：它是 “fast, conservative” 的分析，而且分析层级是 bytecode level。翻译成人话就是：它追求快，追求保守，不追求把所有对象关系都建成一张完美图。`share/ci/bcEscapeAnalyzer.hpp:38`、`share/ci/bcEscapeAnalyzer.hpp:39`

这也是为什么它和 `ciTypeFlow` 不是同一类工具。后者维护的是一个程序点的抽象 frame；前者维护的是几组“参数/返回值/新分配对象的去向位图”。字段定义就能看出来：`_arg_local`、`_arg_stack`、`_arg_returned`、`_return_local`、`_return_allocated`、`_allocated_escapes`、`_unknown_modified`。`share/ci/bcEscapeAnalyzer.hpp:49`、`share/ci/bcEscapeAnalyzer.hpp:54`、`share/ci/bcEscapeAnalyzer.hpp:55`、`share/ci/bcEscapeAnalyzer.hpp:56`、`share/ci/bcEscapeAnalyzer.hpp:61`、`share/ci/bcEscapeAnalyzer.hpp:62`、`share/ci/bcEscapeAnalyzer.hpp:63`、`share/ci/bcEscapeAnalyzer.hpp:64`

对外接口也都是这种“去向判定口味”：

- 参数是否只在 callee 内部；
- 参数是否只逃到栈上游调用者但不全局；
- 参数是否可能被返回；
- 返回值是否只由输入参数组成；
- 返回值是否只由新分配且未逃逸对象组成。 `share/ci/bcEscapeAnalyzer.hpp:124`、`share/ci/bcEscapeAnalyzer.hpp:131`、`share/ci/bcEscapeAnalyzer.hpp:136`、`share/ci/bcEscapeAnalyzer.hpp:139`、`share/ci/bcEscapeAnalyzer.hpp:144`

一个很关键的边界是：**它并不依赖 `ciTypeFlow` 结果。** `do_analysis()` 自己先拿 `_method->get_method_blocks()`，然后 `iterate_blocks()` 直接扫字节码块图。也就是说，类型地图和逃逸地图是两张独立生成的地图，各自服务不同优化问题。`share/ci/bcEscapeAnalyzer.cpp:1201`、`share/ci/bcEscapeAnalyzer.cpp:1204`、`share/ci/bcEscapeAnalyzer.cpp:1206`

## 为什么逃逸分析必须先乐观，再不停降级

`BCEscapeAnalyzer` 最值得记住的不是某一条 bytecode 规则，而是它的整体工作哲学：**乐观起步，遇到不放心的地方就降级，必要时整次分析退回最大保守值。**

`initialize()` 里它会先把所有引用参数都标成 `_arg_local` 和 `_arg_stack`，也就是“先假设这些参数不全局逃逸”。如果方法有引用返回值，还先假设 `_return_local` 和 `_return_allocated` 成立。`share/ci/bcEscapeAnalyzer.cpp:1233`、`share/ci/bcEscapeAnalyzer.cpp:1239`、`share/ci/bcEscapeAnalyzer.cpp:1242`、`share/ci/bcEscapeAnalyzer.cpp:1249`、`share/ci/bcEscapeAnalyzer.cpp:1257`、`share/ci/bcEscapeAnalyzer.cpp:1263`、`share/ci/bcEscapeAnalyzer.cpp:1264`

这个起点看起来很激进，但它只是分析算法的初始假设，不是最终结论。后面只要看到更危险的操作，就会一点点把这些位图清掉、把结果往“更逃逸、更保守”那边推。

如果方法天生就不适合分析，HotSpot 连“乐观后再降级”都不做，直接跳到全保守。比如：

- 抽象方法；
- native 方法；
- holder 还没初始化；
- 递归层级超过 `MaxBCEAEstimateLevel`；
- 方法体大小超过 `MaxBCEAEstimateSize`。 `share/ci/bcEscapeAnalyzer.cpp:1298`、`share/ci/bcEscapeAnalyzer.cpp:1300`、`share/ci/bcEscapeAnalyzer.cpp:1301`、`share/ci/bcEscapeAnalyzer.cpp:1302`、`share/ci/bcEscapeAnalyzer.cpp:1303`、`share/ci/bcEscapeAnalyzer.cpp:1321`

这一步特别说明它的立场：看不懂，不猜；太深，别硬算；太大，别冒险。宁可失去优化，也不让错误逃逸结论流进 C2。

而即便进入了正常分析，结果也不一定会被写回 `MethodData`。如果分析过程中引入了跨方法依赖，或者方法数据本身是空的，HotSpot 干脆不存这份 interprocedural escape info。这又是一层“有价值才留，代价太高就放弃”的克制。`share/ci/bcEscapeAnalyzer.cpp:1354`、`share/ci/bcEscapeAnalyzer.cpp:1357`

所以 `BCEscapeAnalyzer` 的风格和 `ciTypeFlow` 很像：它不是一台想方设法求最精确答案的机器，而是一台不停问“我现在还能安全相信多少”的机器。

## 它最后怎么影响优化：不是直接做标量替换，而是把保守结论喂给 C2

最后还得把一个经常被讲混的边界说清：`BCEscapeAnalyzer` 不是 C2 最终的逃逸分析，也不是它直接把 `new Point` 改写成寄存器标量。

真正的对象图级逃逸分析与标量替换兑现，发生在 C2 的 `ConnectionGraph` 和后续 `escape.cpp` / `macro.cpp` 里。`BCEscapeAnalyzer` 负责的是“把字节码级、跨调用的保守去向估计”先交给 C2 参考。`share/opto/escape.cpp:970`、`share/opto/escape.cpp:971`

例如在 `ConnectionGraph::process_call_result` / `process_call_arguments` 这类地方，C2 会拿 `meth->get_bcea()` 的结果来看：

- 如果 callee `is_return_allocated()`，那返回值可以被当成新分配且未逃逸的对象看待；
- 如果某个参数 `is_arg_returned()`，那调用结果和那个参数之间要连边；
- 如果某个参数不是 `is_arg_stack()`，就把它提升到 `GlobalEscape`；
- 如果它虽然不全局逃逸但也不是 `is_arg_local()`，那它字段里的对象还得进一步视为更容易逃逸。 `share/opto/escape.cpp:972`、`share/opto/escape.cpp:980`、`share/opto/escape.cpp:985`、`share/opto/escape.cpp:990`、`share/opto/escape.cpp:1154`、`share/opto/escape.cpp:1165`、`share/opto/escape.cpp:1175`、`share/opto/escape.cpp:1180`

也就是说，`BCEscapeAnalyzer` 的结果更像“喂给全局 EA 的先验条件”或“跨调用点的摘要信息”，而不是最终裁决。

把它和最终 `ConnectionGraph` 混成一层，就会把 HotSpot 的优化管线讲扁。字节码级 bcea 负责快而保守地给摘要；IR 级 EA 负责在图上做更完整的全局推理；标量替换则是在更后面的阶段真正兑现。

## 收网：`ci` 镜像解决“看见对象”，类型流和逃逸分析解决“看见程序状态”

现在可以把全篇收成一张总图了。

`ci` 镜像层让编译器安全持有类、方法、字段和对象，但它并不会直接告诉编译器：执行到某个字节码位置时，栈和 locals 里各是什么类型；也不会直接告诉编译器：某个参数或新对象会不会逃出当前方法或调用链。于是 HotSpot 还得在字节码层把方法“再跑一遍”，不过跑的是抽象状态，不是真实值。`ciTypeFlow` 用 `StateVector + meet + worklist + fixpoint` 算出每个程序点的类型地图；`BCEscapeAnalyzer` 用“乐观初始化 + 位图跟踪 + 保守降级”估计参数和新分配对象的去向；两者都宁可退成更保守的结论，也不冒险给出错误的精确答案。`share/ci/ciTypeFlow.hpp:158`、`share/ci/ciTypeFlow.cpp:438`、`share/ci/ciTypeFlow.cpp:2727`、`share/ci/bcEscapeAnalyzer.hpp:38`、`share/ci/bcEscapeAnalyzer.cpp:1233`、`share/ci/bcEscapeAnalyzer.cpp:1300`

所以，这一篇最核心的一句话不是“`ciTypeFlow` 做类型流、`BCEscapeAnalyzer` 做逃逸分析”，而是：

**编译器之所以还得自己在字节码层再跑一遍方法，是因为对象视图不等于程序点状态视图；类型流回答“此刻是什么”，逃逸分析回答“最后会去哪”。**

只要这句抓住了，下一篇把 `ciObjectFactory`、`ciReplay` 和 `ciMethodData` 收尾时就好理解了：一旦这些分析每次编译都要重跑，编译数据本身如何缓存、复用、回放，就会变成 `ci` 域最后一个必须收拢的问题。

> → [12-ci/03 — `ciObjectFactory + ciReplay` — `ciObject` 生命周期与编译回放](03-ci-factory-runtime.md)
