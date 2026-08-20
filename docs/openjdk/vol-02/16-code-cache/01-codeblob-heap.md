# 01. 机器码为什么也要有正规住址？— `CodeBuffer`、`CodeBlob` 与 `CodeHeap`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot 如何安置 JIT 产出的机器码：编译期先在 `CodeBuffer` 中生成，再包装成 `CodeBlob`，最后放进 `CodeCache` 管理的 `CodeHeap`。`CodeEntryAlignment`、`CodeCacheSegmentSize`、分段 code cache 的默认值都带平台边界；文中数值以当前平台默认实现为准。AOT 方法与普通 `nmethod` 不走同一条内存路径，本文只点边界，不展开。
>
> **前置依赖**：[15-c2-compiler/06 — 图是怎样真正压成目标机方法的？— `Matcher + GCM + Output`](../15-c2-compiler/06-c2-codegen.md)、[15-c2-compiler/08 — 为什么有些方法根本不按普通调用编？— `LibraryCallKit + intrinsics`](../15-c2-compiler/08-c2-library-calls.md)
> → **后续**：[02 — `nmethod` 结构](02-nmethod-structure.md)

上一篇的终点，其实正好把这篇的问题推到了台前。

C1、C2、`Matcher`、寄存器分配、`Output` 这一整条流水线，已经把一个 Java 方法压成了真正的机器码。到这里，很多资料都会轻轻带过一句：代码被放进 CodeCache 了。

但如果你真的顺着源码往下追，很快就会发现这句话远远不够。

因为“放进 CodeCache”不是把一段字节拷到某块内存里那么简单。JIT 产出的这段机器码马上就会面对三件同时发生的事：

- 它可能立刻被某个线程跳进去执行；
- GC、栈遍历器、异常处理、反查逻辑可能随时拿着一个 `pc` 过来问：这个地址属于谁；
- 它以后还可能失效、被清扫、被复用，甚至在 code heap 紧张时影响后续编译策略。

也就是说，JIT 产出的不是一段“普通数据”，而是一段要被整个 JVM 当场信任的执行体。它既要能跑，又要能被查，又要能被回收，还不能把半成品暴露给别人。

这就是本篇真正要回答的问题：**为什么 JIT 机器码不能像普通对象那样“编完就 malloc 一块内存放进去”？为什么 HotSpot 要先用 `CodeBuffer` 当临时工地，再把成品包装成 `CodeBlob`，最后放进按类型切开的 `CodeHeap`，而且还要把 allocate 与 commit 分成两步？**

先把结论压成一句人话：**机器码的“家”不是一块普通内存，而是一套发布协议。编译阶段先在可丢弃、可扩容的 `CodeBuffer` 里搭临时工地；成品再包装成带布局与身份的 `CodeBlob`；最后放进只管理可执行代码的 `CodeHeap`。`CodeCache` 还要按代码寿命和用途把堆切开，并用 allocate/commit 两段式发布保证半成品代码不会暴露给执行器、GC 和遍历器。**

把这句话记住，后面所有零散类名就都能收回到一条主线上。

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：编译器边生成边直接往 `CodeCache` 写

这是最自然的第一反应。

既然最终机器码本来就要进入 CodeCache，那编译器为什么不一步到位？`MacroAssembler` 每吐出一条指令，就直接写进可执行内存。这样既省了一层中间缓冲，也省了一次拷贝，看上去很直接。

但这个办法一碰到真实编译过程就会出问题。

第一层问题是：**编译期的代码布局根本还没稳定。**

`CodeBuffer` 之所以一开始就被设计成多 section 的临时缓冲，不是风格问题，而是因为编译时常量区、指令区、桩区都在动态增长，而且彼此地址会互相影响。源码注释直接把这个前提写明了：`CodeBuffer` 的内存会被分成多个 section，section 可以独立积累代码、数据和重定位信息；如果空间不够，它甚至可以通过重分配和重拷贝继续扩容；等最终写入 `nmethod` 或其他 `CodeBlob` 时，这些 section 才会按对齐要求拼接成最终布局。`share/asm/codeBuffer.hpp:331`

这句话其实已经把第一层设计动机说透了：**编译中间态是可变的，发布后的成品必须是固定的。**

`CodeBuffer` 明确分成三段：`SECT_CONSTS`、`SECT_INSTS`、`SECT_STUBS`，顺序就代表最终布局顺序。常量、可执行指令、出站跳板并不是一次性写完的，而是在编译推进过程中不断追加、回填、调整。`share/asm/codeBuffer.hpp:353`

如果你边编边直接往共享的 CodeCache 写，就会立刻遇到一个难题：某个 section 扩容了怎么办？某个跳板最后发现地址不够近了怎么办？某个分支回填后整段布局改变了怎么办？编译器需要的是一块“写坏了也能重来、布局变了也能重排、空间不够还能扩”的工地，而不是一块一旦暴露出去就必须对外负责的正式住址。

第二层问题更致命：**半成品代码不能让别人看到。**

`CodeCache::allocate` 前面那段注释非常直白：这里不能抢锁做成随手可见的普通分配，因为如果调用方还没来得及把子类构造函数跑完，code cache 里就会暂时躺着一个垃圾 `CodeBlob`。`share/code/codeCache.cpp:475`

这句话背后其实藏着整个发布语义：

- 线程执行器可能会遍历 code cache；
- 反查逻辑可能会拿着一个地址来问“这是哪段代码”；
- GC 或服务性遍历器也可能在扫 CodeBlob。

如果一段代码还没写完、重定位还没贴好、OopMap 还没挂上、I-cache 还没失效刷新，别人却已经能看见它，那 JVM 就不是“读到旧数据”这么简单，而是可能直接跳进半构造对象或错误布局的指令流里。

所以第一种朴素方案失败的根本原因不是“实现起来麻烦”，而是：**编译期的可变工地和运行期的可见成品，本来就必须分离。**

### 朴素方案二：就算不能边写边发，那最后也放进一个统一大堆不就行了

第二个很自然的想法是：好，编译时先放临时缓冲我认了；那成品为什么不能全进一个统一的大 code heap？反正都是机器码，最多在对象头里打个标签，没必要再拆成 profiled、non-profiled、non-nmethod 这些堆。

这看上去比上一种靠谱一些，但它同样忽略了“代码的寿命和用途并不一样”这件事。

`CodeCache` 的头文件从一开始就把整个结构定义成“一个或多个 CodeHeap”，而且每个 heap 存的是特定 `CodeBlobType` 的代码。当前实现至少区分三类：

- Non-nmethods：Buffer、Adapter、Runtime Stub 这类非编译方法代码；
- Profiled nmethods：执行层级 2、3 的带画像编译方法；
- Non-profiled nmethods：执行层级 1、4 以及 native 方法对应的编译方法。`share/code/codeCache.hpp:42`

这不是为了把概念分得更细，而是在给不同寿命的代码隔离生存空间。

因为 runtime stubs、解释器桥接、适配器这些基础设施代码，本质上更像 JVM 的地基：生成一次，长期驻留，很少回收。而普通编译方法尤其是带画像的那批方法，则是典型的短命产品：今天热，明天可能就不热了；今天有效，明天可能因为依赖失效或清扫器策略而被回收。

如果所有东西共住一个大堆，最坏情况不是“统计数字不好看”，而是：

- 常驻基础设施代码会和短命编译方法互相挤占空间；
- 短命代码回收出来的空洞会污染所有代码类型的布局；
- 当某一类代码暴涨时，会把另一类本应保底存在的代码逼到边缘。

`CodeCache` 甚至明确写了一个退路：在极少见的情况下，如果 non-nmethod heap 满了，非方法代码可以退到 non-profiled heap 里当 fallback。`share/code/codeCache.hpp:52` 这句注释本身已经说明两点：第一，分堆是常态；第二，跨堆退避只是救急，不是默认组织方式。

所以第二种方案失败的根本原因是：**不是所有机器码都只是“代码字节数组”，它们还带着完全不同的生命周期与资源优先级。**

到这里先收一下主线。前面两个失败方案分别告诉我们：

- 不能把编译期工地和运行期成品混在一起；
- 也不能把不同用途、不同寿命的成品全塞进一个统一堆里。

接下来就能顺着这个结论看 HotSpot 的正式设计了。

## `CodeBuffer`：为什么编译器一定要先搭一个临时工地

如果只看类名，`CodeBuffer` 很容易被误解成“放机器码的字节数组”。

这会低估它的作用。

`CodeBuffer` 真正解决的问题是：**编译器需要一个可变中间态，用来承受布局尚未稳定时的一切试错。**

源码注释里有三层信息值得记住。第一，内存会被拆成多个 section；第二，每个 section 可以独立积累自己的代码和重定位；第三，如果某个 section 空间不够，整体缓冲区可以重分配并把所有 section 复制到新位置。`share/asm/codeBuffer.hpp:331`

这意味着 `CodeBuffer` 从设计上就不是“最终地址”，而是“最终地址出来前的工作台”。

三段 section 的定义也很有讲究：

```cpp
enum {
  SECT_FIRST = 0,
  SECT_CONSTS = SECT_FIRST,
  SECT_INSTS,
  SECT_STUBS,
  SECT_LIMIT, SECT_NONE = -1
};
```

`SECT_CONSTS` 放浮点常量、跳转表这类非指令数据；`SECT_INSTS` 放真正要执行的指令；`SECT_STUBS` 放出站跳板和支撑调用点的桩。源码还特意写明：这个顺序反映最终布局顺序。`share/asm/codeBuffer.hpp:353`

这件事为什么重要？因为编译器在生成代码时，最常见的烦恼之一就是“现在先写下去，但最终地址以后才知道”。

举个典型场景：

- 某条指令现在要引用常量区里的一个表项；
- 某个调用点以后可能需要一段跳板桩；
- 某个 section 的增长又会反过来改变另一段的绝对位置。

如果你一开始就把所有东西扁平地塞进一个不可移动的终局缓冲区，那么每一次扩容、每一次补桩、每一次重新对齐都会让之前已经生成的内容承受极高的回填成本。`CodeBuffer` 则反过来承认：**布局在编译完成前就是不稳定的。**

所以它先把“写代码”与“定住址”分开：

- 写的时候，允许 section 独立增长；
- 不够时，可以扩容；
- 真正提交前，再统一计算最终偏移和拼接顺序。

这正是源码里 `compute_final_layout`、`copy_relocations_to`、`copy_code_to` 那组接口存在的原因：先算最终模型，再把临时工地里的内容搬成正式成品。`share/asm/codeBuffer.hpp:434`

这里先别急着背函数名，先记住一句话：**`CodeBuffer` 的职责不是“保存代码”，而是“承受代码尚未稳定时的变化”。**

这个中间态一旦被拿掉，后面的 `CodeBlob`、`CodeHeap` 就会被迫承担编译期变动，而它们本来是给发布后的稳定状态准备的。

## `CodeBlob`：为什么机器码正式入住前必须先拿到身份和布局

有了临时工地之后，下一步不是“拷进 CodeCache 就完事”，而是先变成 `CodeBlob`。

这一步也常被低估成“加个对象头”。

其实 `CodeBlob` 干的是两件大事：

- 给这段代码一个稳定的内存布局；
- 给这段代码一个 JVM 可识别的身份。

先看布局。`codeBlob.hpp` 直接把普通 CodeBlob 的连续布局写成了四部分：header、relocation、content space、data space。`share/code/codeBlob.hpp:71`

这和很多人脑子里“机器码 = 一段指令字节”的图像完全不同。HotSpot 这里保存的不只是可执行指令，还要带着：

- 头部元信息；
- 重定位信息；
- consts/insts/stubs 组合起来的 content；
- 各类 data，例如 OopMap、作用域数据等。

`CodeBlob` 本体里的关键边界字段也把这种连续对象模型写死了：`_code_begin`、`_code_end`、`_content_begin`、`_data_end`、`_relocation_begin`、`_relocation_end`。`share/code/codeBlob.hpp:103`

也就是说，对 JVM 来说，一段已发布的代码从来不是“只有 code 段”，而是一个带多重边界、能支撑执行与反查的整体对象。

更关键的是，`CodeBlobLayout` 会把前面 `CodeBuffer` 的临时三段压成最终四区布局。构造函数里可以直接看到：header 之后先放 relocation，接着通过 `align_code_offset` 算 content 起点，`code_offset` 则在 content 内进一步落到 insts 的实际偏移上，最后 `data_offset` 落到 content 之后。`share/code/codeBlob.hpp:282`

这说明 `CodeBuffer` 和 `CodeBlob` 不是同义词，而是两个阶段：

- `CodeBuffer` 关心“编译时怎样暂存和重排”；
- `CodeBlobLayout` 关心“发布后怎样一锤定音”。

再看身份。

`CodeBlobType` 把 code cache 里的对象至少分成五类：`MethodNonProfiled`、`MethodProfiled`、`NonNMethod`、`All`、`AOT`。`share/code/codeBlob.hpp:38`

这里最该注意的不是枚举值本身，而是它背后的组织原则：**代码被放进 CodeCache 之前，就已经被 JVM 认定成某种角色。**

角色一旦不同，后面的可见性、回收、统计、分配堆选择都会不同。

其中最重要的一条边界是 `RuntimeBlob` 和 `CompiledMethod` 这两大子树。`RuntimeBlob` 是所有非编译方法代码的共同基类。`share/code/codeBlob.hpp:340` 下面的 `BufferBlob`、`RuntimeStub`、`SingletonBlob` 这些子类，很多都表现出“活到 JVM 退出”的寿命特征。比如 `BufferBlob::is_alive()` 直接恒为 `true`，`RuntimeStub::is_alive()` 也一样恒为 `true`。`share/code/codeBlob.hpp:383`、`share/code/codeBlob.hpp:468`

而 `nmethod` 这边则完全不同。它的状态机里，`is_alive()` 的条件是 `_state < zombie`，还明确区分 `not_entrant`、`zombie`、`unloaded`。`share/code/nmethod.hpp:322`

这条边界非常值得单独记一下：**HotSpot 不是先有一块统一代码内存，再在里面顺便放各种代码；它是一开始就承认“基础设施代码”和“编译产品代码”活法不同，所以必须通过 `CodeBlob` 身份系统把它们分出来。**

这样一来，`CodeBlob` 就不只是“机器码壳子”，而是“正式入住前的法律身份 + 房屋户型”。

## `CodeCache::allocate/commit`：为什么正式入住必须分成两段发布

到这一步，`CodeBuffer` 已经定稿，`CodeBlobLayout` 已经算出最终布局，听起来只差最后一件事：找块可执行内存，把内容拷进去。

真正容易出错的地方恰恰在这里。

`CodeCache::allocate` 顶部那段注释前面已经提过一次，现在可以把它放回完整语境里理解：如果调用方还没把 CodeBlob 子类构造完成，code cache 里就会暂时存在一个垃圾对象，因此这里绝不能让“刚分配出来的半成品”以正式成员身份暴露出去。`share/code/codeCache.cpp:475`

这就是 allocate/commit 分离的核心原因。

`CodeCache::allocate` 负责的事情很克制：

- 根据 `code_blob_type` 找到对应的 `CodeHeap`；
- 向 heap 申请一块足够大的空间；
- 不够就尝试 `expand_by(CodeCacheExpansionSize)`；
- 还不够且开启分段 code cache 时，按既定顺序尝试 fallback 到其他 heap。`share/code/codeCache.cpp:482`

这里最值得注意的是 fallback 顺序。源码明确写了：`NonNMethod -> MethodNonProfiled -> MethodProfiled`，必要时再回试 non-profiled，但要避免死循环。`share/code/codeCache.cpp:506`

这段逻辑说明 HotSpot 不是简单“申请失败就报错”，而是在保留主要组织原则的前提下给系统留了一条喘气的退路：先尽量住进自己那类 heap，实在不行再临时借住别的 heap。

但无论分配到哪里，`allocate` 都还不是“发布完成”。

真正的边界在 `CodeCache::commit`。这个函数看起来很短：更新 nmethod 或 adapter 计数，然后调用 `ICache::invalidate_range(cb->content_begin(), cb->content_size())` 失效硬件 I-cache。`share/code/codeCache.cpp:588`

看起来动作不多，但语义非常重：**到 commit 为止，这段代码才从“我已经拿到一块壳内存”变成“别人现在可以把你当真代码执行”。**

为什么一定要这样？因为在 commit 之前，下面这些东西都可能还没完全就位：

- 指令内容可能还没全拷完；
- 重定位区可能还没填完；
- data 区里的 OopMap、作用域描述、异常处理信息可能还没挂好；
- CPU 的指令缓存还没知道这块地址现在是新代码。

如果没有这条发布边界，JVM 里任何能遍历 code cache 的角色都有机会看到半构造结果。

所以 allocate/commit 的关系不是“分配 + 记账”，而是：

- `allocate`：先拿到一块暂时只属于构造者的壳；
- `commit`：完成发布，告诉整个系统这块地址现在可当正式代码使用。

从这个角度看，CodeCache 不是普通 allocator，而更像一个“代码发布总线”。

## `CodeHeap`：为什么代码区只能做段级分配，而不能按普通堆思路处理

接下来该看这套发布协议底下真正的房东了：`CodeHeap`。

如果说 `CodeBuffer` 解决的是编译期可变，`CodeBlob` 解决的是正式身份，那么 `CodeHeap` 解决的就是：**可执行代码应该怎样在稀缺、难搬移、需要快速反查的内存上生活。**

`CodeHeap` 的底层不是随手 `malloc` 出来的内存，而是两个 `VirtualSpace`：一个放真正的代码块，一个放 segment map，也就是 `_segmap`。`share/memory/heap.hpp:84`

这已经暴露出它和普通堆分配器的根本差异：它从第一天起就在为“地址反查”服务。

先看内存取得方式。`ReservedSpace::page_align_size_up` 先把预留空间往页大小对齐。`share/memory/virtualspace.cpp:255` 后面 `VirtualSpace::expand_by` 再按需提交这块预留空间的一部分，只有真的需要更多 committed memory 时才往上推高边界。`share/memory/virtualspace.cpp:844`

这套“先 reserve，再 commit”的做法并不新鲜，但放在代码区里尤其关键。因为可执行内存比普通数据内存更敏感：

- 地址稳定性更重要；
- 修改和回收成本更高；
- 不是说搬就能搬；
- 硬件执行缓存也会参与可见性问题。

所以 HotSpot 先把一整片潜在地址空间圈下来，再一点点提交使用，而不是每次临时找一块新地址拼进去。

再看分配算法。`CodeHeap::allocate` 的开头先把请求大小换算成 segment 数量，然后优先查 freelist；如果 freelist 找不到合适块，再看 `_next_segment` 后面是否还有连续已提交空间，有的话就顺序切下一块。`share/memory/heap.cpp:285`

这套逻辑其实非常朴素：

- 能复用老洞，先复用；
- 不能复用，就从当前已提交空间尾部继续顺序切；
- 真不够了，再让外层 `CodeCache` 想办法扩 committed space。

它看上去像一个普通内存分配器，但这里的粒度是“segment”，不是任意字节。x86 当前平台默认 `CodeCacheSegmentSize` 是 `64`，启用 tiered 时会额外增加 `64`，也就是默认变成 `128` 字节。`cpu/x86/globals_x86.hpp:40` 这就是 code heap 的最小组织粒度。

而且入口对齐也带平台边界。x86 上如果启用了 C2 或 JVMCI，`CodeEntryAlignment` 默认是 `32`。`cpu/x86/globals_x86.hpp:49` 这解释了为什么 `CodeBlobLayout` 和 `CodeBuffer` 一直在强调最终拼接时的对齐要求：代码不是只要能放下就行，入口位置还直接影响执行约束。

真正把 `CodeHeap` 和普通堆彻底区分开的，是 segmap。

`heap.cpp` 里有一大段注释专门解释 segment map 的存在理由：给定一个指向 code heap 内部任意位置的指针，要快速找到它所属代码块的起点。做法是把整片 code heap 按 `CodeCacheSegmentSize` 切成段，并为每个段维护一个字节大小的映射值。这个值不是“对象 ID”，而是“从当前段往回跳多少段能更接近块起点”。起点段的映射值为 0，尚未分配的段是 `free_sentinel = 255`。`share/memory/heap.cpp:384`

这套设计的妙处在于：反查时完全不用全堆扫描，也不用额外树结构。拿到一个 `pc`：

- 先右移或按段大小换算出所在 segment 编号；
- 查看 segmap；
- 如果当前值大于 0，就往前跳对应段数；
- 重复直到遇到 0；
- 起点段对应的块头就找到了。

源码里的 `find_block_for`、`find_start`、`find_blob_unsafe` 正是按这条链在做：先通过 segmap 反推出块头，再判断它是不是正在使用、是不是确实包含这个地址。`share/memory/heap.cpp:456`、`share/memory/heap.cpp:486`、`share/memory/heap.cpp:493`

这件事特别值得停一下。

因为很多人第一次听说 CodeCache 时，会以为“代码已经在内存里了，执行时直接跳地址就好”。但 JVM 不只是执行，还要频繁回答“这个地址属于哪段代码”“这是不是一个活着的 `nmethod`”“这个返回地址该去哪个 OopMap 里找根”。如果没有这种近乎 O(1) 的段级反查能力，整个运行期围绕代码地址做的工作都会变重。

所以 `CodeHeap` 的重点从来不是“把代码摆进去”，而是：**把代码摆进去以后，还要能用地址高效地把它认出来。**

## 分段 CodeCache：为什么要按用途和画像拆 heap

前面我们已经知道 CodeCache 可以由多个 CodeHeap 组成，现在该看拆分规则本身了。

`CodeCache` 头文件把默认条件写得很清楚：`SegmentedCodeCache` 控制是否分段；默认情况下，如果开启了 `TieredCompilation` 且 `ReservedCodeCacheSize >= 240 MB`，分段 code cache 就会打开。`share/code/codeCache.hpp:61`

这个门槛说明 HotSpot 并不是无脑追求“堆越多越好”。当 code cache 很小的时候，过度切分只会让每个 heap 更局促；而当 tiered 编译和较大的 code cache 同时出现时，不同代码类型开始足够值得隔离。

几个默认参数也能帮我们把这种隔离想具体。当前平台下，`ReservedCodeCacheSize` 默认是 `32M`，`NonNMethodCodeHeapSize` 默认也是 `32M`。`share/runtime/globals.hpp:89`、`share/runtime/globals.hpp:92` 这两个值只是当前平台的参数定义，不代表默认就已经进入“分段 code cache”场景；真正默认启用分段，还得满足前面的 `>= 240 MB` 门槛。把它们放在一起看，更适合帮助我们理解：non-nmethod 这类基础设施代码在 HotSpot 眼里值得被单独预算。

编译级别到 `CodeBlobType` 的映射也服务于这套隔离：

- `CompLevel_none`、`CompLevel_simple`、`CompLevel_full_optimization` 映射到 `MethodNonProfiled`；
- `CompLevel_limited_profile`、`CompLevel_full_profile` 映射到 `MethodProfiled`。`share/code/codeCache.hpp:259`

这不是在说 level 1、4 的方法天生更高级，而是在把“带画像的中间产物”和“最终不再依赖画像的产物”分开对待。

如果把 tiered 编译看成一条生产线，这种分堆就很好理解了：

- `MethodProfiled` 更像生产过程中的中间件，来得快，去得也快；
- `MethodNonProfiled` 更像稳定成品；
- `NonNMethod` 则是整条产线赖以运转的固定设备。

把它们全塞进一个堆里不是不行，但会让完全不同的生存模式彼此干扰。分段 code cache 的真正目标不是“更优雅”，而是让这些干扰尽量局部化。

这里顺手再纠正一个容易想错的点：fallback 逻辑不是在否定分堆，而是在承认现实世界里资源会暂时失衡。正常情况仍然是各住各的 heap；只有某类 heap 顶不住时，系统才会让代码跨 heap 借住。`share/code/codeCache.cpp:506`

所以，分段 code cache 不是性能调味料，而是资源治理策略。

## 到这里为止，主线其实只发生了四件事

如果前面细节有点多，这里先立一个路标，把整件事压回四个动作：

1. 编译期先在 `CodeBuffer` 里生成可扩容、可重排的临时布局；
2. 定稿后用 `CodeBlobLayout` 把它压成带 header/reloc/content/data 的正式 `CodeBlob`；
3. `CodeCache::allocate` 先从目标 `CodeHeap` 拿壳空间，必要时扩容或 fallback；
4. 内容填完后由 `CodeCache::commit` 完成发布，之后 JVM 里的执行、反查、GC、回收才把它当正式代码。

只要这四步还在脑子里，后面的误解就不容易钻进来了。

## 常见误解澄清

### 误解一：`CodeBuffer` 就是最终代码对象

不是。

`CodeBuffer` 是编译期工作台，职责是承受 section 扩容、布局重排和重定位收集。最终被运行期持有、遍历、按地址反查的是 `CodeBlob` 及其子类，而不是 `CodeBuffer`。前者是正式住址，后者是施工现场。`share/asm/codeBuffer.hpp:331`、`share/code/codeBlob.hpp:71`

### 误解二：`CodeBlob` 只是给机器码套一层 C++ 壳

也不是。

`CodeBlob` 同时定义了连续内存布局和运行期身份系统。没有这层对象，JVM 很难统一表达“这段代码的可执行区在哪里、重定位区在哪里、data 区在哪里、它到底是 runtime stub 还是可回收 `nmethod`”。`share/code/codeBlob.hpp:103`、`share/code/codeBlob.hpp:38`

### 误解三：`CodeCache::commit` 只是做统计记账

不对。

`commit` 的关键动作是把这段内容作为正式代码发布出去，并失效对应 I-cache 范围。它和 `allocate` 分开，正是为了不让半成品被别人看见。`share/code/codeCache.cpp:588`

### 误解四：segmented code cache 只是性能微调

不只是。

分段背后是不同代码类型的寿命隔离和资源治理。常驻 runtime blobs 与可回收编译方法不是同一种住户，把它们分开住能减少互相挤压，也能让退避策略更可控。`share/code/codeCache.hpp:42`、`share/code/codeCache.hpp:61`

### 误解五：代码回收和普通堆压缩差不多

差得很远。

普通对象堆可以靠搬移整理来缓解碎片；代码区里的机器码则牵着跳转地址、重定位、返回地址语义、执行缓存等一串约束。HotSpot 在这里采用的是段级分配、freelist 复用和 segmap 反查，而不是“随时把代码搬走重排”。`share/memory/heap.cpp:285`、`share/memory/heap.cpp:384`

## 收网：机器码的家，本质上是一套发布协议

现在再回头看开头那个问题，答案已经能收成一张完整总图了。

```text
编译器生成机器码时
  CodeBuffer
    ├─ consts
    ├─ insts
    └─ stubs
        ↓ 定稿后计算最终布局
  CodeBlobLayout
    ├─ header
    ├─ relocations
    ├─ content(consts/insts/stubs)
    └─ data
        ↓ 申请可执行内存
  CodeCache::allocate(type)
        ↓ 放进对应 CodeHeap
  CodeHeap
    ├─ NonNMethod
    ├─ MethodProfiled
    └─ MethodNonProfiled
        ↓ 内容填完后发布
  CodeCache::commit(blob)
        ↓ 其他线程此后才把它当成正式代码
  查找/执行/GC/回收
```

把它再压成三句话：

- `CodeBuffer` 解决的是编译期“还没定稿”的问题，所以它必须可扩容、可重排、可丢弃。
- `CodeBlob` 解决的是发布后“别人怎么认你”的问题，所以它必须同时给出正式布局与正式身份。
- `CodeHeap` 和 `CodeCache` 解决的是运行期“怎么让代码活下去”的问题，所以它们必须提供类型隔离、段级分配、地址反查和两段式发布。

这也解释了为什么“机器码的家”会是一整套系统，而不是一次普通分配。

因为对 JVM 来说，代码一旦住进去，就不只是要放着，而是要随时被跳转、被扫描、被质询、被回收。能承担这种责任的，从来不是一块裸内存，而是一套完整的入住协议。

下一篇就顺着这个协议继续往里走：`CodeBlob` 这个大类里，最重要也最复杂的住户其实是 `nmethod`。机器码、常量、oops、metadata、作用域描述、异常表这些东西在一段编译方法里到底怎么排布，下一篇展开。

> → [02-nmethod-structure.md](02-nmethod-structure.md)
