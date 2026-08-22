# 01. 机器码为什么也要有正规住址？— `CodeBuffer`、`CodeBlob` 与 `CodeHeap`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot 如何安置 JIT 产出的机器码：编译期先在 `CodeBuffer` 中生成，再包装成 `CodeBlob`，最后放进 `CodeCache` 管理的 `CodeHeap`。`CodeEntryAlignment`、`CodeCacheSegmentSize`、分段 code cache 的默认值都带平台边界；文中数值以当前平台默认实现为准。AOT 方法与普通 `nmethod` 不走同一条内存路径，本文只点边界，不展开。
>
> **前置依赖**：[15-c2-compiler/06 — 图是怎样真正压成目标机方法的？— `Matcher + GCM + Output`](../15-c2-compiler/06-c2-codegen.md)、[15-c2-compiler/08 — 为什么有些方法根本不按普通调用编？— `LibraryCallKit + intrinsics`](../15-c2-compiler/08-c2-library-calls.md)
> → **后续**：[02 — `nmethod` 结构](02-nmethod-structure.md)

C1、C2、`Matcher`、寄存器分配、`Output` 这一整条流水线，已经把一个 Java 方法压成了真正的机器码。到这里，很多资料都会轻轻带过一句：代码被放进 CodeCache 了。

但“放进 CodeCache”不是把一段字节拷到某块内存里那么简单。JIT 产出的这段机器码马上就会面对三件同时发生的事：

- 它可能立刻被某个线程跳进去执行；
- GC、栈遍历器、异常处理、反查逻辑可能随时拿着一个 `pc` 过来问：这个地址属于谁；
- 它以后还可能失效、被清扫、被复用，甚至在 code heap 紧张时影响后续编译策略。

本篇要回答的核心问题是：**为什么 JIT 机器码不能像普通对象一样“编完就 malloc 一块内存放进去”？为什么 HotSpot 要先用 `CodeBuffer` 当临时工地，再把成品包装成 `CodeBlob`，最后放进按类型切开的 `CodeHeap`，而且还要把 allocate 与 commit 分成两步？**

答案先压成一句人话：**机器码的“家”不是一块普通内存，而是一套发布协议。编译阶段先在可丢弃、可扩容的 `CodeBuffer` 里搭临时工地；成品再包装成带布局与身份的 `CodeBlob`；最后放进只管理可执行代码的 `CodeHeap`。`CodeCache` 还要按代码寿命和用途把堆切开，并用 allocate/commit 两段式发布保证半成品代码不会暴露给执行器、GC 和遍历器。**

---

## 1. 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：编译器边生成边直接往 `CodeCache` 写

既然最终机器码本来就要进入 CodeCache，那编译器为什么不一步到位？`MacroAssembler` 每吐出一条指令，就直接写进可执行内存。

但编译期的代码布局根本还没稳定。

`CodeBuffer` 被设计成多 section 的临时缓冲，是因为编译时常量区、指令区、桩区都在动态增长，而且彼此地址会互相影响。section 可以独立积累代码、数据和重定位信息；空间不够时还能重分配和重拷贝；等最终写入 `CodeBlob` 时，才按对齐要求拼成最终布局。`codeBuffer.hpp:331-353`

编译中间态是可变的，发布后的成品必须是固定的。更致命的是，**半成品代码不能让别人看到**：如果调用方还没把 CodeBlob 子类构造完，CodeCache 里就会暂时躺着一个垃圾对象。`codeCache.cpp:475`

所以不能把编译期工地和运行期正式住址混在一起。编译器需要的是一块“写坏了也能重来、布局变了也能重排、空间不够还能扩”的工地，而不是一个一旦暴露就必须对整个 JVM 负责的正式地址。

### 朴素方案二：最后放进一个统一大堆就够了

好,编译时先放临时缓冲；那成品为什么不能全进一个统一的大 code heap？反正都是机器码。

问题在于代码的寿命和用途并不一样。`CodeCache` 从一开始就定义成“一个或多个 CodeHeap”，每个 heap 存特定 `CodeBlobType` 的代码。当前至少区分：

- Non-nmethods：Buffer、Adapter、Runtime Stub 等非编译方法代码；
- MethodProfiled：带画像的中间编译方法；
- MethodNonProfiled：稳定的最终编译方法和 native 方法编译代码。`codeBlob.hpp:36-45`

runtime stubs、解释器桥接、适配器更像 JVM 的地基，通常长期驻留；编译方法则可能因为依赖失效或清扫策略变成垃圾。如果所有代码共住一个大堆，短命代码回收出来的空洞会污染常驻基础设施，某一类代码暴涨也会挤压另一类代码。

因此分堆不是装饰，而是**按寿命和用途隔离资源**。fallback 只是资源失衡时的救急，不是否定分堆原则。`codeCache.hpp:42-61`

---

## 2. `CodeBuffer`：编译器先搭一个可变临时工地

如果只看类名，`CodeBuffer` 很容易被误解成“放机器码的字节数组”。

它真正解决的问题是：**编译器需要一个可变中间态，承受布局尚未稳定时的一切试错。**

源码注释有三层信息：

1. 内存拆成多个 section;
2. 每个 section 独立积累代码和重定位;
3. 空间不够时，整体缓冲区可以重分配并把 section 复制到新位置。`codeBuffer.hpp:331`

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

- `SECT_CONSTS`：浮点常量、跳转表等非指令数据；
- `SECT_INSTS`：真正执行的指令；
- `SECT_STUBS`：出站跳板和支撑调用点的桩。`codeBuffer.hpp:353`

编译期可能发生的事情包括：常量区增长、跳板桩追加、分支回填、section 对齐变化。`CodeBuffer` 因此先把“写代码”和“定最终地址”分开：写的时候允许增长，空间不足可以扩容，最终提交前再统一计算布局和偏移。`compute_final_layout`、`copy_relocations_to`、`copy_code_to` 就是这一阶段的接口。`codeBuffer.hpp:434`

**`CodeBuffer` 的职责不是保存最终代码，而是承受代码尚未稳定时的变化。**

---

## 3. `CodeBlob`：正式入住前先拿到布局和身份

有了临时工地之后，下一步不是直接拷进 CodeCache，而是先变成 `CodeBlob`。

### 正式布局

`CodeBlob` 的连续布局由四部分组成：header、relocation、content space、data space。`codeBlob.hpp:71`

这意味着 JVM 维护的不只是可执行指令，还包括：

- 头部元信息；
- 重定位信息；
- consts/insts/stubs 组成的 content；
- OopMap、作用域数据等 data。

关键边界字段包括 `_code_begin`、`_code_end`、`_content_begin`、`_data_end`、`_relocation_begin`、`_relocation_end`。`codeBlob.hpp:103-117`

`CodeBlobLayout` 会把 `CodeBuffer` 的临时三段压成最终四区布局：header 后放 relocation，content 起点按对齐计算，code offset 落到 insts，data offset 落到 content 之后。`codeBlob.hpp:282`

所以两者职责不同：

- `CodeBuffer` 关心编译时怎样暂存和重排；
- `CodeBlobLayout` 关心发布后怎样一锤定音。

### 正式身份

`CodeBlobType` 把 CodeCache 里的对象分成 `MethodNonProfiled`、`MethodProfiled`、`NonNMethod`、`All`、`AOT` 等类别。`codeBlob.hpp:36-45`

其中最重要的边界是 `RuntimeBlob` 与 `CompiledMethod`：

- `RuntimeBlob` 下的 `BufferBlob`、`RuntimeStub`、`SingletonBlob` 等通常长期驻留；
- `nmethod` 则有 `not_entrant`、`zombie`、`unloaded` 等失效状态。`codeBlob.hpp:340-468`、`nmethod.hpp:322`

所以 `CodeBlob` 不只是“机器码壳子”，而是**正式布局 + JVM 可识别身份**。

---

## 4. `CodeCache::allocate/commit`：正式入住为什么分两段发布

到这一步，`CodeBuffer` 已定稿，`CodeBlobLayout` 已算出最终布局，接下来才是申请可执行内存。

### allocate：先拿一块构造者私有的壳空间

`CodeCache::allocate` 负责：

- 根据 `CodeBlobType` 找目标 `CodeHeap`；
- 申请足够空间；
- 空间不够时尝试 `expand_by(CodeCacheExpansionSize)`；
- 分段 code cache 下必要时按规则 fallback 到其他 heap。`codeCache.cpp:475-506`

fallback 不是常态，而是资源暂时失衡时的退路。正常情况下，代码仍尽量住进自己的 heap。

但 allocate 还不是发布完成。内容可能还没拷完，重定位区、OopMap、作用域描述、异常信息也可能还没填完。

### commit：把成品正式发布

`CodeCache::commit` 的关键动作包括更新计数，并调用 `ICache::invalidate_range(cb->content_begin(), cb->content_size())` 失效硬件 I-cache。`codeCache.cpp:588`

因此 allocate/commit 的关系不是“分配 + 记账”，而是：

- **allocate**：拿到一块暂时只属于构造者的壳；
- **commit**：完成发布，告诉整个系统这块地址现在可以当正式代码使用。

如果没有这条边界，执行器、反查逻辑、GC 和服务性遍历器都有可能看到半构造结果。

---

## 5. `CodeHeap`：可执行代码为什么按 segment 管理

`CodeHeap` 的底层不是随手 `malloc`，而是两个 `VirtualSpace`：一个放代码块，一个放 segment map `_segmap`。`heap.hpp:84`

它先 reserve，再按需 commit：`ReservedSpace::page_align_size_up` 负责页对齐，`VirtualSpace::expand_by` 在需要更多 committed memory 时推进边界。`virtualspace.cpp:255`、`:844`

代码区尤其需要这种模式，因为：

- 地址稳定性更重要；
- 修改和回收成本更高；
- 代码不能随便搬动；
- 硬件执行缓存参与可见性问题。

`CodeHeap::allocate` 先把请求换算成 segment 数量，优先查 freelist；找不到合适块，再从 `_next_segment` 后面的连续已提交空间顺序切分。`heap.cpp:285`

因此它的分配策略是：能复用老洞先复用，不能复用就从尾部继续切，不够了再由外层 CodeCache 扩 committed space。

x86 当前平台的 `CodeCacheSegmentSize` 默认是 64，启用 tiered 时会额外增加 64，默认变成 128 字节；`CodeEntryAlignment` 在启用 C2/JVMCI 时默认是 32。`globals_x86.hpp:40`、`:49`

### segmap：拿着 pc 反查 CodeBlob

segmap 是 CodeHeap 与普通堆分配器最不同的地方。它把 code heap 按 `CodeCacheSegmentSize` 切成段，并为每段维护一个映射值：起点段为 0，空闲段为 `free_sentinel = 255`，其他段记录“往前跳多少段能接近块起点”。`heap.cpp:384`

拿到一个 `pc` 后：

1. 换算所在 segment 编号；
2. 查看 segmap；
3. 如果值大于 0，就往前跳对应段数；
4. 重复直到遇到 0；
5. 找到 CodeBlob 起点，再确认它确实包含这个地址。

`find_block_for`、`find_start`、`find_blob_unsafe` 正是按这条链反查。`heap.cpp:456`、`:486`、`:493`

所以 `CodeHeap` 的重点不是“把代码摆进去”，而是：**摆进去以后，还要能用地址高效地把它认出来。**

---

## 6. 分段 CodeCache：为什么按用途和画像拆 heap

`SegmentedCodeCache` 控制是否分段；默认情况下，开启 tiered compilation 且 `ReservedCodeCacheSize >= 240 MB` 时，分段 code cache 才打开。`codeCache.hpp:61`

这个门槛说明 HotSpot 不会无条件切分：code cache 较小时，过度分段只会让每个 heap 更局促；代码量足够大、tiered 产物寿命差异明显时，隔离才值得。

`CodeBlobType` 与编译级别也对应起来：

- `CompLevel_none`、`CompLevel_simple`、`CompLevel_full_optimization` → `MethodNonProfiled`；
- `CompLevel_limited_profile`、`CompLevel_full_profile` → `MethodProfiled`。`codeCache.hpp:259`

可以把它理解为：

- `MethodProfiled`：生产过程中的中间件，来得快、去得也快；
- `MethodNonProfiled`：相对稳定的成品；
- `NonNMethod`：整条编译产线赖以运行的固定设备。

分段 code cache 的目标不是“更优雅”，而是让不同寿命和用途的代码互相少干扰。fallback 只是资源失衡时的借住，不是否定分堆原则。`codeCache.cpp:506`

---

## 7. 误解澄清与收网

1. **`CodeBuffer` 是最终代码对象吗?** 不是。它是编译期工作台，`CodeBlob` 才是运行期持有、遍历和反查的正式对象。
2. **`CodeBlob` 只是机器码外壳吗?** 不是。它同时定义正式布局、重定位、data 区和代码身份。
3. **`CodeCache::commit` 只是统计记账吗?** 不是。它是发布边界，并负责 I-cache 失效。
4. **segmented code cache 只是性能微调吗?** 不只是。它隔离不同代码类型的寿命和资源优先级。
5. **代码回收和普通堆压缩一样吗?** 不一样。代码区牵涉入口地址、重定位、返回地址、OopMap 和 I-cache，采用 segment 分配、freelist 复用和 segmap 反查。

把这一篇压成三句话：

- `CodeBuffer` 解决编译期“还没定稿”，必须可扩容、可重排、可丢弃；
- `CodeBlob` 解决发布后“别人怎么认你”，同时提供正式布局与正式身份；
- `CodeHeap` / `CodeCache` 解决运行期“怎么让代码活下去”，提供类型隔离、segment 分配、地址反查和 allocate/commit 两段式发布。

下一篇: `nmethod` 结构——机器码、常量、oops、metadata、作用域描述和异常表在一段编译方法里到底怎么排布。

> → [02-nmethod-structure.md](02-nmethod-structure.md)