# 02. 为什么一段编译方法必须自带完整说明书？— `nmethod` 的结构

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot 里普通 JIT 编译方法 `nmethod` 的结构组织：入口协议、连续布局、`PcDesc/ScopeDesc`、状态字段与补丁边界。动态调用点、verified entry 补丁的具体指令以 x86_64 为例；其他平台实现会不同，但设计意图相同。JVMCI 和 native wrapper 路径有少量例外，正文以主流 C1/C2 路径为主。
>
> **前置依赖**：[01 — 机器码为什么也要有正规住址？— `CodeBuffer`、`CodeBlob` 与 `CodeHeap`](01-codeblob-heap.md)
> → **后续**：[03 — `nmethod` 生命周期](03-nmethod-lifecycle.md)

上一篇刚把“机器码的家”安顿好：`CodeBuffer` 解决编译期可变，`CodeBlob` 给出正式布局，`CodeCache` 和 `CodeHeap` 负责把成品发布到可执行内存里。

但房子安好了，新的问题马上就冒出来了。

假设现在 JIT 已经把一个 Java 方法编成了几 KB 机器码。按最直觉的想法，后面的事情似乎已经很简单：调用方拿到入口地址，CPU 跳进去执行，结束。

可 HotSpot 并没有把编译产物做成一段“只要能跳进去就行”的裸代码。它在 `nmethod` 里额外塞进了大量东西：多个入口地址、重定位流、常量区、oop 表、metadata 表、`PcDesc`、`ScopeDesc`、依赖表、异常表、隐式空指针表、状态字段、锁计数……第一次看源码时，这很容易让人产生一个疑问：

**为什么一段编译后的 Java 方法不能只是“机器码 + 若干辅助表”？为什么 HotSpot 要把入口协议、常量、重定位、oop/metadata 索引、`PcDesc/ScopeDesc`、依赖、异常表、状态机都塞进同一个 `nmethod`，而且这些东西还要按特定顺序紧贴在一起？**

换句更狠一点的人话：**JIT 编出来的机器码为什么必须是“可执行、可回收、可反查、可反优化”的自描述对象？**

这篇先把答案压成一句话：**`nmethod` 不是“机器码本体 + 配套材料”，而是一段带逆向导航能力的代码对象。线程要靠入口协议正确跳进去，GC 要靠 relocation 和 oop 表定位嵌入引用，deopt 要靠 `PcDesc + ScopeDesc` 把一个机器 PC 还原成一串 Java 帧，失效流程还要靠状态机与入口补丁阻止新调用继续闯入。HotSpot 把这些信息做成同一块连续内存，不是为了紧凑，而是为了让“给你一个 PC，就能恢复这段代码的全部语义身份”。**

把这句话记住，后面那堆字段就不再只是零件，而会变成一个完整协议。

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：`nmethod` 不就是“机器码 + 调试信息”吗

这是最常见的第一反应。

编译后的方法当然首先是一段机器码。为了调试、异常处理或者 GC，再额外挂几张表，也说得过去。照这个理解，机器码才是主体，其余不过是辅助材料。

这个理解的问题在于，它低估了运行时真正会对一段编译代码提出多少要求。

一段 `nmethod` 一旦发布，JVM 会立刻从多个方向同时依赖它：

- 普通调用方要知道从哪个入口进；
- inline cache 要知道是走带类型检查的入口，还是走免检入口；
- GC 要知道机器码里埋着哪些 oop 和 metadata 引用；
- deopt 要知道“当前 PC 对应哪个 Java 方法、哪条字节码、哪些局部变量和表达式栈值”；
- 失效流程要知道怎样阻止新线程再跳进来，同时允许老栈帧把剩下的路径走完。

这里每一项都不是“调试时也许会用到”的外围能力，而是代码作为 JVM 一等执行体的组成部分。换句话说，`nmethod` 不是“机器码先在，旁边再贴注释”，而是**机器码从一开始就被要求能回答运行时会追问的所有问题**。

所以如果你把其余内容都叫作“调试信息”，会立刻漏掉三类最关键的运行时责任：

- GC 责任：识别和更新嵌入引用；
- 反优化责任：从一个机器 PC 还原 Java 语义栈；
- 失效责任：在不撕裂并发执行的前提下阻止新调用进入。

这些都不是可有可无的注释，而是代码对象本身的生存条件。

### 朴素方案二：这些表就算需要，也没必要跟代码贴在一起

第二个也很自然的想法是：好，我承认这些表重要。但它们为什么一定要跟着 `nmethod` 一起放在同一块连续内存里？完全可以散落在别处：代码单独放，GC 表放一张全局大表，deopt 地图再放另一边，状态字段放管理器里。只要能查到，不也一样？

这听起来像是在做“模块分离”，但它忽略了一个决定性的使用模式：**运行时最经常拿到的，不是方法名，不是对象指针，而是一个落在机器码中的地址。**

比如：

- 栈遍历拿到返回地址；
- 异常处理拿到故障 PC；
- deopt 从某个 safepoint 或 trap 点恢复；
- inline cache 补丁、依赖失效、代码清扫都围绕具体代码地址运作。

也就是说，JVM 面对编译代码时，最常见的查询不是“给我这个方法的所有资料”，而是“给我这个 PC，我要立刻知道它属于谁、现在是什么状态、对应哪一层 Java 调用链、里面埋了哪些引用、能不能继续跳进去”。

如果这些信息全散落在全局侧表里，就会出现两类问题。

第一类是成本问题。每次遇到一个 `pc`，你都得多跳几层索引：

- 先从地址找出它属于哪个 `nmethod`；
- 再从 `nmethod id` 找到 GC 表；
- 再找 deopt 表；
- 再找状态字段；
- 再找依赖与异常表。

第二类是更麻烦的并发一致性问题。代码失效、补丁、清扫、注销这些动作本来就很敏感；如果结构信息散在好几个地方，就更难定义“何时算同一个版本”“半更新状态别人会不会看见”。

所以 HotSpot 的选择不是“为了省几个指针把东西挤一起”，而是明确承认：**编译方法必须支持按地址近距离自解释。** 把相关信息贴着代码放进同一块连续内存，可以让“从 PC 出发恢复语义身份”这件事既快又稳。

这就是全篇真正的总前提：`nmethod` 不是孤立代码段，而是一段自带完整导航数据的代码对象。

## 三扇门：为什么一段代码要有多个入口

先从最容易被低估的一层开始：入口。

如果你把 `nmethod` 想成普通函数，最自然的预期就是“一个函数一个入口地址”。但 HotSpot 在 `nmethod` 里明确存了三个入口：

```cpp
address _entry_point;
address _verified_entry_point;
address _osr_entry_point;
```

源码注释写得很干脆：`_entry_point` 是带类检查的入口，`_verified_entry_point` 是不带类检查的入口，`_osr_entry_point` 是 on-stack replacement 入口。`share/code/nmethod.hpp:90`

为什么非要三扇门？因为“进入一段编译代码”这件事，本来就不是单一场景。

### 第一扇门：`entry_point`，给还没验明正身的调用方

虚调用是最典型的例子。调用点常常只知道“我现在大概率要调这个实现”，但还不能完全保证接收者的实际类型就是缓存里那一个。这个时候，调用方需要的是：先带着一个期望 Klass 过去，由被调方法入口再做最后确认。

x86_64 上的未验证入口代码正是这么干的。`MachUEPNode::emit` 会在方法最前面发出一段比较：如果启用了压缩类指针，就先从接收者对象里取出实际 Klass；然后拿 `rax` 里的期望 Klass 和它比较；不等就跳到 `SharedRuntime::get_ic_miss_stub()`。`share/cpu/x86/x86_64.ad:1681`

这一小段代码有两个特别值得记住的设计点。

第一，**被比较的“期望 Klass”不在被调方内部硬编码，而是由调用方带过来。**

第二，**类型检查放在被调方入口，而不是铺在每个调用点上。**

这正是 inline cache 的闭环基础：调用方只负责缓存一个“我这次猜的是谁”，被调方负责在真正进入代码前验一下这次猜测还准不准。不准就统一跳 miss stub，让运行时重新解析并补丁调用点。

所以 `entry_point` 不是“入口 1 号”，而是“**带验票逻辑的入口协议**”。

### 第二扇门：`verified_entry_point`，给已经验过的调用方

如果某个调用方已经不需要再验接收者类型，或者这根本不是依赖 inline cache 的虚调用，那再走一遍入口检查就是重复劳动了。这个时候就应该直连免检入口。

`CompiledIC::compute_monomorphic_entry` 很清楚地写出了这条规则：如果调用被认为是 optimized，就取 `verified_entry_point()`；否则取 `entry_point()`。`share/code/compiledIC.cpp:463`

这说明 HotSpot 并不是简单做了个“快入口”，而是在编码一种非常具体的承诺：

- 走 `entry_point` 的调用方，还没把接收者类型这张票验完；
- 走 `verified_entry_point` 的调用方，已经为“这个目标现在可进”负责。

这也是为什么 verified entry 后面会成为失效补丁的关键拦截点：既然很多调用方已经绕过了入口检查，那一旦方法失效，就必须能快速把这条直连通路切断。

### 第三扇门：`osr_entry_point`，给“从半路接管”的调用方

还有一类进入方式根本不是“从方法开头调进来”，而是解释器正在某个热循环里跑着，突然决定切到编译代码继续执行。这就是 OSR。

OSR 的判据也写在结构里：`_entry_bci != InvocationEntryBci` 就说明这不是普通入口编译，而是某个特定字节码位置的 on-stack replacement。`InvocationEntryBci` 在 JDK 11u 里定义为 `-1`，注释直说“not a on-stack replacement compilation”。`share/compiler/compilerDefinitions.hpp:44`、`share/code/nmethod.hpp:63`

这意味着 `osr_entry_point` 不是第三个普通门，而是一扇“**从中途接手解释器现场**”的门。它的存在告诉我们：`nmethod` 不只是给未来的新调用准备的，还要能接住已经在路上的执行流。

### 调用点为什么也要配合这三扇门

如果只看被调方入口，还少了一半故事。另一半在调用点自己身上。

x86_64 的动态 Java 调用模板 `CallDynamicJavaDirect` 直接把指令形状固定成：

```text
movq rax, imm64
call,dynamic
```

也就是先把一个 64 位立即数塞进 `rax`，再发动态调用。`share/cpu/x86/x86_64.ad:12834`

这 64 位立即数正是 inline cache 携带的“期望 Klass”缓存位。也就是说，调用点和入口之间形成了一个很精巧的配合：

- 调用点把自己的猜测写进 `rax`；
- 被调方 `entry_point` 用接收者真实 Klass 来验；
- 不命中就跳 miss stub；
- 运行时修补调用点的缓存值和目标入口。

这套协议再往前一步，就会连到 `CompiledIC::set_to_monomorphic` 这样的安装逻辑上。那段代码里最核心的选择只有一句：调用已优化就直指 `verified_entry_point`，否则走 `entry_point`。`share/code/compiledIC.cpp:373`

这样再回头看，三扇门的意义就很清楚了：**它们不是为了多存几个地址，而是把“谁负责验类型、谁可以跳过检查、谁从中途切入”这些进入责任明确编码进了结构。**

## 连续布局：为什么所有东西要挤在同一块内存里

入口协议说明了“怎么进”，接下来该看“进到的到底是什么”。

`nmethod.hpp` 开头那段注释，是整篇最重要的总图之一。它直接把 `nmethod` 包含的东西列出来：

- header
- relocation information
- constant part
- oop table
- code body
- exception handler
- stub code
- oop array
- data array
- pcs
- handler entry point array
- implicit null table array。`share/code/nmethod.hpp:36`

这里最值得记住的不是项目名，而是这种排列方式本身。HotSpot 并没有把它组织成“对象指针 + 一堆外部数组”，而是用一串偏移字段把整块连续空间切成多个功能区。`_consts_offset`、`_stub_offset`、`_oops_offset`、`_metadata_offset`、`_scopes_pcs_offset`、`_dependencies_offset`、`_handler_table_offset`、`_nul_chk_table_offset`、`_nmethod_end_offset` 这些字段全在 `nmethod` 头里。`share/code/nmethod.hpp:100`

也就是说，**`nmethod` 自己知道各段从哪里开始、到哪里结束。**

### 偏移链为什么比“分散对象指针”更合适

普通 Java 方法的 `nmethod` 构造函数里，这些偏移是按严格顺序一段一段推出来的：

- `consts` 起点由 `CodeBuffer` 的 consts section 偏移决定；
- `stub` 起点由 stubs section 偏移决定；
- `oops` 从 data 区开头开始；
- `metadata` 紧跟 `oops`；
- `scopes data` 紧跟 metadata；
- `scopes pcs` 紧跟 scopes data；
- 之后依次是 dependencies、handler table、null check table，最后得到 `_nmethod_end_offset`。`share/code/nmethod.cpp:685`

这条偏移链特别像一张装配单：前一段的终点，直接决定后一段的起点。它把 `nmethod` 做成了真正意义上的“单体对象”，而不是一个对象图。

为什么这很重要？因为这让很多运行时动作都能在“已知 nmethod 基址”的前提下局部完成：

- 入口地址可由 `code_begin() + offset` 算出；
- 某张表的起点可由 `header_begin() + _xxx_offset` 算出；
- 代码区与数据区天然共版本；
- 发布时也能定义出清晰的一次性拷贝和可见性边界。

### 两个反直觉的布局细节

这条偏移链里有两个地方特别容易被想错。

第一，**常量区在机器码前面。**

很多人脑子里的布局会默认成“code 在前，常量和附表在后”。但 `nmethod` 这里的 `consts` 属于 content 区最前面的部分，它来自上一篇 `CodeBuffer` 的 `SECT_CONSTS`。这意味着代码并不是孤立发射的，它天然依赖旁边的常量布局。

第二，**异常处理和 deopt handler 归在 stub section，而不是 code body 正文里。**

源码在构造阶段直接写了注释：`Exception handler and deopt handler are in the stub section`。`share/code/nmethod.cpp:718` 这句话的设计意味很强：HotSpot 把“主路径指令体”和“后备处理路径”在布局上刻意分开了。前者是正常执行主线，后者是故障、异常、去优化时的补救跳板。

这不是简单分类，而是在内存层面保留“主流程”和“兜底流程”的结构差异。

### 为什么发布顺序也写进了结构语义里

构造函数后半段还有一个非常值得停一下的细节：数据拷贝顺序。

普通 `nmethod` 会先做这些事：

- `copy_code_and_locs_to(this)` 拷代码和重定位；
- `copy_values_to(this)` 拷 `CodeBuffer` 记录的值；
- `debug_info->copy_to(this)` 拷调试/作用域数据；
- `dependencies->copy_to(this)` 拷依赖；
- 然后先 `CodeCache::commit(this)`；
- 最后才拷 `handler_table` 和 `nul_chk_table`。`share/code/nmethod.cpp:756`、`share/code/nmethod.cpp:766`、`share/code/nmethod.cpp:768`

这个顺序说明一件很重要的事：**不是所有附表都处在同一个发布时机上。**

GC、地址反查、基本调试/反优化这些结构，要在 commit 之前就准备好；`handler_table` 和 `nul_chk_table` 则是在 `CodeCache::commit(this)` 之后补进去。更稳妥的理解不是“后者不重要”，而是“当前实现把它们放在了发布后的补齐阶段”。

这反过来再次证明：这些段不是随便拼的附件，而是按运行时使用方式被分批安放进 `nmethod` 的结构组成。

## GC 字典：为什么 relocation、oop 表、metadata 表必须在场

前面说这些段不是附件，现在可以把 GC 这条线单独拎出来。

如果 `nmethod` 真是纯机器码，GC 最大的问题就是：**它根本不知道代码里哪些位置藏着对象引用或元数据引用。**

而编译代码里确实会嵌引用。

比如：

- 某些常量可能直接指向 oop；
- 某些调用点、内联缓存、klass 常量、method 常量会把 metadata 地址埋进代码或附表；
- 垃圾收集、类卸载、补丁和依赖失效都需要理解这些嵌入项的性质。

所以 `nmethod` 必须带两样东西：

- relocation 信息，告诉系统哪些位置需要按特定语义解释；
- oop/metadata 索引表，提供稳定的引用槽位。

`nmethod` 结构里专门有 `_oops_offset` 和 `_metadata_offset`。`share/code/nmethod.hpp:100` 更关键的是，源码把索引语义直接写死了：`index 0 is reserved for null`。`share/code/nmethod.hpp:362`

这条规则背后的好处很大。它让代码里出现的“引用编号”不需要额外引入一个“无值”标志位；0 就自然表示空，真正有效项从 1 开始。这样无论是解码 relocation，还是在 deopt/debug 信息里引用对象、metadata，都能共享同一套稠密索引语义。

从写作主线角度，最该记住的是一句话：**代码不是不碰对象，恰恰相反，代码区里也会埋对象世界的入口。**

一旦承认这一点，`nmethod` 就绝不可能只是“执行字节流”。它必须额外带着一份词典，让 GC 和补丁逻辑知道这些字节里到底藏了什么。

## deopt 地图：为什么一个机器 PC 能还原出一串 Java 帧

如果 GC 这条线告诉我们“代码里还埋着引用语义”，那 deopt 这条线则更进一步：**一个机器 PC 背后还埋着完整的 Java 执行语义。**

这也是 `nmethod` 最不像普通本地函数的地方。

一个普通 C 函数如果崩在某个 PC 上，调试器顶多给你一条本地调用栈。但 JVM 在 deopt 时要求的远比这多：给你一个正在执行的机器码地址，你要能说出：

- 它对应哪个 Java 方法；
- 正在执行哪条字节码；
- 如果这个位置是内联出来的，那它属于内联链里的哪一层；
- 每一层 Java 帧的局部变量、表达式栈和监视器状态该怎样恢复。

这件事只靠“机器码地址”当然做不到，所以 `nmethod` 里有两张配套地图：`PcDesc` 和 `ScopeDesc`。

### 第一张图：`PcDesc`，把机器 PC 接到解码入口

`PcDesc` 的结构非常小，关键只有三个字段：

- `_pc_offset`
- `_scope_decode_offset`
- `_obj_decode_offset`。`share/code/pcDesc.hpp:34`

其中最关键的就是前两个：一个记录“这个描述对应 `nmethod` 起点之后多远的 PC”，另一个记录“对应的 scope 信息从 debug 数据区里的哪个偏移开始解码”。

也就是说，`PcDesc` 不直接存大段语义内容，它更像一张路由表：**先把机器地址定位到某个解码入口。**

### 第二张图：`ScopeDesc`，把 Java 语义一层层展开

真正的 Java 语义记录在 `ScopeDesc` 里。解码头部时会顺序读出：

- `_sender_decode_offset`
- `_method`
- `_bci`
- `_locals_decode_offset`
- `_expressions_decode_offset`
- `_monitors_decode_offset`。`share/code/scopeDesc.cpp:79`

这几项几乎就是一张最小可恢复 Java 栈帧说明书：

- 这是哪个方法；
- 这是哪条字节码位置；
- 局部变量怎么解码；
- 表达式栈怎么解码；
- 监视器状态怎么解码。

而这里最有设计味道的一点，是 `_sender_decode_offset`。

它不是直接存一个“外层 ScopeDesc 指针”，而是存一个偏移。`is_top()` 判断它是不是最外层，`sender()` 再顺着这个偏移去解码上一层。`share/code/scopeDesc.cpp:148`

为什么不用指针链，而要用偏移链？因为这些记录本来就不是常驻展开对象，而是一段紧凑压缩流。真正需要某层 Java 语义时，才顺着偏移现场解码。这样既节省空间，也让整个 `nmethod` 仍然保持“单块连续、按需反解”的结构风格。

### 为什么一个 PC 会对应一串 Java 帧

这一步是很多读者最容易一下子看通的地方。

如果没有内联，一个机器 PC 顶多只对应一个 Java 方法位置。但一旦内联发生，机器码里的某一段实际上同时代表了多层 Java 调用链：

- 最内层是当前真正执行的那段内联方法逻辑；
- 外面一层是把它内联进来的调用者；
- 再外面还可能有更上层调用者。

所以 deopt 时不能只恢复“一帧”，而要恢复一串逻辑 Java 帧。HotSpot 的做法正是：

- 先用 `PcDesc` 把当前机器 PC 接到最内层 scope；
- 再沿着 `ScopeDesc` 的 sender 偏移一层层往外走；
- 每一层都带着 method、bci、locals、expressions、monitors 的解码入口；
- 于是整条 Java 语义栈就能重新拼出来。

这就是为什么我前面一直说 `nmethod` 是“可逆”的。因为它不只是能执行，还能在必要时**从机器码世界逆向长回 Java 世界**。

到这里先立一个路标：如果你现在只记得一句话，那就记住——**`PcDesc` 负责把 PC 接到地图上，`ScopeDesc` 负责把地图一层层展开成 Java 帧。**

## 状态机与并发协议：为什么结构对象本身还要带生命体征

讲完入口、布局、GC、deopt，很多人会以为 `nmethod` 的结构已经差不多了：无非是一段代码附带一堆说明书。

还差最后一个常被低估的维度：**这段代码不是静态文档，它是会失效、会被判死刑、会被延迟回收的活动对象。**

所以 `nmethod` 结构里不仅有布局字段，还有生命体征字段。

### 状态不是附属概念，而是结构的一部分

`CompiledMethod` 的状态枚举写得非常清楚：`not_installed`、`in_use`、`not_used`、`not_entrant`、`zombie`、`unloaded`。`share/code/compiledMethod.hpp:188`

这几个状态不是为了打印日志好看，而是在回答一个运行时根本问题：**这段代码现在还能不能接新调用，老栈帧还能不能留在里面，回收器能不能动它。** 这里尤其别把 `unloaded` 误会成“结构生命周期的绝对终点”：按 03 篇会展开的清扫路径，普通 non-OSR 方法在 `unloaded` 之后通常还会继续推进到 `zombie` 再 `flush`，只是它在语义上已经不再可执行。

这意味着 `nmethod` 的结构解释和生命周期解释其实没有完全分家。因为只要入口地址还暴露给别人，状态就会直接决定入口应不应该继续工作。

### 为什么要补丁 verified entry

`make_not_entrant_or_zombie` 这段状态转换逻辑，最值得盯住的动作不是“改 `_state`”，而是更早发生的入口补丁。

在真正改状态之前，如果这不是 OSR 方法，而且当前还没到 `not_entrant`，HotSpot 会调用 `NativeJump::patch_verified_entry(entry_point(), verified_entry_point(), SharedRuntime::get_handle_wrong_method_stub())`。`share/code/nmethod.cpp:1144`、`share/code/nmethod.cpp:1191`

这件事的设计含义非常直接：

- 已经走 verified entry 的调用方，本来跳过了类型检查与其它入口协议；
- 一旦方法失效，不能指望所有调用方自己“下次别来了”；
- 所以必须在被调方门口直接换一个路牌，让后来者一律改道去 `handle_wrong_method_stub`。

也就是说，失效不是靠“状态字段改成 not_entrant 然后大家自觉遵守”，而是靠**结构内的入口地址本身被补丁成新的控制流出口。**

这再次证明：入口字段和状态字段不是两套互不相干的资料，它们在同一个对象里共同构成可执行协议。

### 为什么还要 `mark_as_seen_on_stack`

同一段状态转换逻辑里还有另一句很关键的话：如果目标状态是 `not_entrant`，必须先 `mark_as_seen_on_stack()`，再做状态写入，而且中间还有一个 `storestore` 屏障。`share/code/nmethod.cpp:1212`

这在写作上最值得翻译成一句人话：**HotSpot 不仅要阻止新调用进去，还要谨慎地区分“门口关了”和“屋里已经没人了”。**

`not_entrant` 只说明不再接待新客；但老栈帧可能还在里面跑。所以从 `not_entrant` 到 `zombie` 中间必须留出一段等待窗口，靠栈遍历来确认这段代码是不是还被任何线程踩着。

这也解释了为什么状态转换前后会带着入口补丁、栈标记和方法引用清理这些操作。它不是单纯改一个枚举值，而是在推进一整套并发退出协议。

### `nmethodLocker` 不是状态锁，而是“先别动我”计数

除了状态机本身，`nmethod` 结构里还带着 `_lock_count`，`is_locked_by_vm()` 的定义就是 `_lock_count > 0`。`share/code/nmethod.hpp:438`

对应的 `nmethodLocker` 逻辑非常朴素：`lock_nmethod` 做原子加一，`unlock_nmethod` 做原子减一，并断言不能给 zombie 方法乱加锁。`share/code/nmethod.cpp:2037`

这把“锁”的意义特别容易想错。它不是拿来决定状态流转的互斥锁，也不是替代 `Patching_lock` 的结构锁。它做的事情更轻：**谁现在还在危险地用这段代码，先报个数，告诉回收逻辑别急着把尸体拖走。**

所以这里一定要区分两个层次：

- `Patching_lock` 管的是“状态和入口补丁这套转换动作本身怎么安全发生”；
- `nmethodLocker` 管的是“虽然你已经该死了，但此刻还有 VM 角色在读你，暂时别清走”。

这两个层次叠在一起，才让 `nmethod` 真正具备“既能失效，又不撕裂并发读者”的能力。

## 到这里为止，主线其实只发生了五件事

如果前面信息很多，这里先把它们压回五个动作：

1. `nmethod` 用多入口协议区分未验证调用、已验证调用和 OSR 切入；
2. 它把代码、常量、重定位、各种表紧贴成一块连续对象；
3. 它带着 oop/metadata 词典，让 GC 和补丁逻辑读懂代码里埋了什么；
4. 它带着 `PcDesc + ScopeDesc` 地图，让机器 PC 可以逆向恢复 Java 语义栈；
5. 它带着状态字段、入口补丁和锁计数，让失效与回收按并发协议发生。

只要这五件事还在脑子里，`nmethod` 就不再是字段清单，而会重新变成一个完整设计。

## 常见误解澄清

### 误解一：`nmethod` 只是带调试信息的机器码

不是。

调试信息只是其中一部分。真正关键的是它还承担 GC 引用索引、deopt 逆向恢复、入口补丁和状态失效协议。没有这些，JVM 根本不能把它当成熟的编译方法对象使用。`share/code/nmethod.hpp:36`

### 误解二：verified/unverified entry 只是性能优化

不只是。

它们首先是调用协议分层：谁还需要验接收者类型，谁已经可以直连，谁从 OSR 半路切进来。性能收益只是这套协议顺带带来的结果，不是唯一目的。`share/code/nmethod.hpp:90`、`share/code/compiledIC.cpp:463`

### 误解三：`ScopeDesc` 只是给 debugger 用

不对。

`ScopeDesc` 最重要的使命是 deopt 时恢复 Java 语义帧，尤其是在内联把多层 Java 调用压成同一段机器码之后。它是反优化与栈语义恢复的核心地图，不是外设。`share/code/scopeDesc.cpp:79`

### 误解四：`CodeCache::commit(this)` 之后再拷异常表，说明异常表不重要

不能这么理解。

它只说明当前实现把 `handler_table` 和 `nul_chk_table` 放在 `CodeCache::commit(this)` 之后补齐；不代表它们在功能上可有可无，也不该直接外推出“它们整体不重要”。更稳妥的结论只是：这些结构和 commit 前那批必须先就位的内容不在同一个发布时机里。`share/code/nmethod.cpp:766`、`share/code/nmethod.cpp:768`

### 误解五：`nmethodLocker` 就是状态锁

不是。

状态转换的关键互斥在 `Patching_lock`；`nmethodLocker` 只是用一个原子计数告诉回收逻辑“现在还有人安全地持有我，别清”。它延迟回收，但不主导状态机。`share/code/nmethod.hpp:438`、`share/code/nmethod.cpp:2037`

## 收网：`nmethod` 是一段能从 PC 反推出完整 Java 语义的代码对象

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
调用者进入 nmethod
  ├─ entry_point            : 带接收者类型检查
  ├─ verified_entry_point   : 已验证调用方直连
  └─ osr_entry_point        : 从解释器栈中途切入

nmethod 连续布局
  header
  relocations
  consts
  code body
  handlers / stubs
  oops / metadata
  scopes data
  pcs
  dependencies
  exception table
  implicit null table

运行时读取它
  ├─ IC / 调用协议：决定从哪扇门进
  ├─ GC：沿 relocation + oop/metadata 表更新嵌入引用
  ├─ Deopt：pc -> PcDesc -> ScopeDesc sender 链 -> Java 帧重建
  └─ 状态机：补丁 verified entry，禁止新调用继续进入
```

把它再压成三句话：

- 入口协议让 `nmethod` 不只是“能执行”，还知道“谁以什么资格进来”。
- 连续布局和各类表让 `nmethod` 不只是“有代码”，还知道“这段代码里埋了什么、发生了什么、怎么退回 Java 世界”。
- 状态机和补丁让 `nmethod` 不只是“曾经可用”，还知道“什么时候该拒绝新调用、什么时候还能等老栈帧走完”。

所以 `nmethod` 的本质，从来都不是一段机器码加几张附表。

它是一段**可逆的、自描述的、可失效的代码对象**。给你一个落在其中的 PC，HotSpot 不但要能让线程继续跑，还要能回答它属于哪个方法、哪条字节码、哪层内联调用链、现在还能不能再进，以及将来该怎样安全地退出历史舞台。

下一篇就顺着最后一个问题继续往下走：结构已经看懂了，但谁在什么时候把一个 `nmethod` 从 `in_use` 推到 `not_entrant`、再推到 `zombie`？谁来证明栈上已经没人？空间又是怎么回到 `CodeHeap` 的？——下一篇展开 `nmethod` 生命周期。

> → [03-nmethod-lifecycle.md](03-nmethod-lifecycle.md)
