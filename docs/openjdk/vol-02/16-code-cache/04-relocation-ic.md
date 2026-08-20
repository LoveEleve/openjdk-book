# 04. 机器码怎么知道自己哪里能改？— `Relocation`、`NativeInst` 与 `Inline Cache`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot 如何让一段已经生成好的机器码在运行时仍然可被识别、可被更新、可被补丁：`relocInfo` 记录地址语义，`NativeInst` 家族负责读写具体指令字段，`InlineCacheBuffer` 保证调用点在并发切换时没有半成品。指令级示例以 x86_64 为主；其他平台的机器码形态会不同，但设计分层相同。
>
> **前置依赖**：[02 — 为什么一段编译方法必须自带完整说明书？— `nmethod` 的结构](02-nmethod-structure.md)、[03 — 为什么过时代码不能当场删？— `nmethod` 的生命周期](03-nmethod-lifecycle.md)
> → **后续**：[05 — `Dependencies` 与 `Deopt`](05-dependencies-deopt.md)

前两篇已经把两个关键前提搭好了。

一方面，`nmethod` 不是裸机器码，它里面埋着 oop、metadata、调用点、异常入口和各种能让 JVM 反查语义的结构。另一方面，这段代码一旦发布，就还会被 GC、sweeper、deoptimization、runtime linkage 一直触碰：有时要更新嵌入的 oop，有时要清理指向死亡方法的调用点，有时还要把一个虚调用从旧目标改到新目标。

这立刻逼出一个很具体的问题：

**机器码自己只是一串字节，它怎么知道自己哪些字节代表地址、哪些地址还能改、并发改的时候又怎么避免线程看到半成品？**

再往前推一步，问题其实更尖锐：**为什么 HotSpot 不把“代码里哪里有地址”硬编码在每个消费者逻辑里，而要专门设计 relocation 流、指令包装类和 IC 过渡桩三层机制？**

这篇先把答案压成一句话：**HotSpot 不是直接“去代码里找指针再改”，而是把可补丁性拆成三层：relocation 流先给机器码附上一张顺序可解码的地址地图，`NativeInst` 再教运行时怎样精确读写某种指令里的位移或立即数，Inline Cache 切换则在这两层之上再加一层过渡桩，保证调用点在并发补丁时任何时刻都只有旧形态或完整新形态，没有半成品。**

只要记住这句话，下面那堆类型、位宽、补丁顺序和桩代码就都能收回到一个完整设计里。

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：需要时再去反汇编整段机器码，现找哪里有地址

这是最自然的第一反应。

既然最后落地的是机器码，那 GC、IC 清理或者补丁逻辑需要改某个地址时，直接把相关指令重新反汇编一遍不就行了？看到像指针的立即数、看到像调用的位移，就把它当可更新位置来处理。

这个方案的问题在于，它把“这几个字节此刻长得像地址”和“编译器当初有意把它当成 oop、metadata、调用目标或 poll 标记发出来”混成了一件事。

运行时真正关心的从来不是“像不像地址”，而是“**它在编译期被赋予了什么语义**”。

比如同样是一段 4 字节或 8 字节数据：

- 有些是嵌入 oop；
- 有些是 metadata；
- 有些是 call 的位移；
- 有些只是普通数值常量；
- 有些甚至只是某条复杂 x86 指令里的其中一个可重定位操作数字段。

光靠运行时再看字节形状，是分不清这些语义差异的。更何况 x86 指令里还会出现“一条指令含多个可重定位位置”的情况。`relocInfo.hpp` 在注释里直接点明：像 Intel 这种机器有时一条指令里会含不止一个可重定位常量，所以需要 format codes 来区分到底对应哪个操作数。`share/code/relocInfo.hpp:88`

这句话其实已经判了第一种方案死刑：**运行时不应该靠重新猜测语义，而要复用编译期已经知道的语义标注。**

所以 HotSpot 不选择“现猜哪里有地址”，而是选择“编译时顺手把这件事记下来”。这就是 relocation 的出发点。

### 朴素方案二：既然知道调用点偏移，那就直接原地双写

第二个很自然的想法是：好，我接受需要一张地图。可 inline cache 看起来也没那么复杂，不就是一个 `mov rax, imm64` 加一个 `call target` 吗？既然编译器知道这两个字段的位置，运行时就直接把 cached value 和 call target 原地改掉不就行了。

这在单线程世界里也许可以凑合，但在 HotSpot 的真实场景里不行。

原因很简单：**调用点有两个相互关联的字段，而并发线程可能正好在你改到一半时走过这里。**

如果它看到的是：

- 新的 call target + 旧的 cached value；或者
- 旧的 call target + 新的 cached value；

那这个调用点就处于逻辑撕裂状态。它既不是完整旧状态，也不是完整新状态。对于带接收者类型检查的调用协议，这种半成品状态是绝对不能暴露出去的。

所以第二种方案的问题不在于“原地改两处有点麻烦”，而在于：**你不仅要知道哪里能改，还要保证任何执行线程都只会看到一致状态。**

这正是为什么 HotSpot 不把“地址地图”“改哪几个字节”“怎样无中间态切换”揉成一层，而是专门拆成三层：

- relocation：说明哪些地方有语义上可更新的地址；
- `NativeInst`：说明某类指令的哪几个字节该怎么读写；
- `ICBuffer`：说明多字段状态切换怎样分阶段完成而不暴露半成品。

## relocation 流：为什么先要一张顺序地图

先看最底层也最根本的一层：relocation。

它解决的问题非常纯粹：**机器码里哪些位置在运行时值得被当成“有语义的地址”看。**

`relocInfo.hpp` 一开头就把设计写得很明白：一条 `relocInfo` 只有 16 位，其中 4 位表示 relocation type，12 位表示“相对前一条 relocation 地址的偏移”。这些偏移沿着 relocation 流累加，最终得到 code blob 内的地址，也就是 `RelocIterator::addr()`。并且这个地址永远指向“相关指令的第一个字节”，而不是某个子字段本身。`share/code/relocInfo.hpp:75`

这句话里藏着两个极重要的设计决定。

第一，**relocation 记录的不是“绝对地址表”，而是一条顺序可累积的语义流。**

第二，**它记录的是指令语义起点，不是某个立即数字段本体。**

为什么要这样做？因为 HotSpot 真正想保留的不是“第几字节有个数值”，而是“从这条指令开始，有一个特定类型的可重定位操作数，后续读写方式由架构相关逻辑决定”。

### 16 位为什么够用

乍一看，16 位像是非常紧张的预算。但 HotSpot 这里根本不追求随机索引，而是押注于“消费者本来就会顺序扫 relocation 流”。于是 12 位偏移不存绝对位置，只存“距离上一条 relocation 多远”。

这就是典型的 delta 编码。`RelocIterator::next()` 在推进时的关键动作就是：

```cpp
_addr += _current->addr_offset();
```

`share/code/relocInfo.hpp:569`

也就是说，地址不是单独存出来的，而是沿着流一点点累出来的。这样一来，小偏移就足以覆盖很长的 code 区，只要大部分 relocation 彼此之间相距不太夸张就行。

这非常符合真实使用场景：GC、IC 清理、调用点扫描本来就是沿代码或沿 relocation 顺序走，不需要“给我第 17 个 relocation 直接跳过去”。

所以这里的核心权衡很清楚：**牺牲随机访问，换顺序编码的紧凑和简单。**

### x86 为什么还要额外塞 format 位

但 16 位内部也不是死板的 `4 + 12`。

`relocInfo.hpp` 说得很清楚：某些机器如果需要 N 个 format bits，那 offset 就只剩 `12-N` 位，format 会被插在 offset 和 type 之间。`share/code/relocInfo.hpp:88`

x86 正是这种机器。`relocInfo_x86.hpp` 里定义了：

- `offset_unit = 1`，因为 Intel 指令按字节对齐；
- AMD64 下 `format_width = 2`。`cpu/x86/relocInfo_x86.hpp:30`

这意味着在 x86_64 上，relocation 不只是“你是哪种类型”，还得告诉消费者“这一类重定位落在这条指令的哪种操作数字段上”。这和上一节的失败方案正好对上：**仅凭运行时再看字节形状，是不够区分复杂指令内部不同可重定位操作数的。**

### 类型枚举不是分类账，而是消费者协议

`relocType` 枚举把 0 到 15 几乎用满了：`oop_type`、`virtual_call_type`、`opt_virtual_call_type`、`static_call_type`、`runtime_call_type`、`external_word_type`、`internal_word_type`、`poll_type`、`metadata_type`、`data_prefix_tag` 等。`share/code/relocInfo.hpp:257`

这里最值得记住的是：这些类型不是为了“统计都有哪些重定位”，而是在给不同消费者发协议。

比如：

- GC 更关心 `oop_type` 和 `metadata_type`；
- inline cache 和调用点清理更关心 `virtual_call_type`、`opt_virtual_call_type`、`static_call_type`；
- safepoint 机制会关心 `poll_type` 和 `poll_return_type`；
- blob 内/外地址引用则落在 `internal_word_type`、`external_word_type` 等上。

也就是说，一条 relocation 记录不是在说“这里有个地址”，而是在说“**这里有个属于某种语义家族的可更新点**”。

### prefix 和 filler：16 位不够时怎么续命

那如果 16 位真的装不下怎么办？HotSpot 没有扩大主记录，而是提供了两种补丁手段。

第一种是 prefix。`data_prefix_tag` 允许在某条真正的 relocation 之前携带额外半字数据。`relocInfo.hpp` 注释明确说，这些额外数据以一串 halfwords 形式紧挨着真正记录之前，客户端不会直接看到它。`share/code/relocInfo.hpp:99`

第二种是 filler，也就是 `none` 记录。源码直接列出了它的三种用途：

- 跳过大段没有重定位的代码；
- 把 relocation 数组 pad 到 oop 对齐要求；
- 失效旧的 relocation 信息。`share/code/relocInfo.hpp:360`

这两种补丁手段合起来，等于给了 16 位主记录一套“别变宽，必要时外挂补充信息”的弹性。

所以 relocation 这一层最该记住的结论是：**它不是地址表，而是一条顺序可解码的语义地图。**

## RelocIterator：为什么顺序解码就够用

有了地图，下一步就是怎么读。

`RelocIterator` 的接口看起来朴素得甚至有点寒酸：构造时给一个 `CompiledMethod` 和可选地址范围，之后不断 `next()`。`share/code/relocInfo.hpp:560`

但这恰恰说明 HotSpot 对这层工具的定位非常克制：它不是要做“随时随机访问 relocation 数据库”，而是要做“**顺着一段代码范围往前走，看看哪些地方值得处理**”。

`next()` 的流程也完全服务于这个目标：

- 先推进到下一条记录；
- 如果遇到 prefix，就先跨过去；
- 然后把当前记录的 delta offset 累加到 `_addr`；
- 如果超出 limit，就停。`share/code/relocInfo.hpp:569`

你几乎可以把它想成一个“小型流解释器”：每走一步，就告诉你“代码区的下一个语义点到了”。

### 为什么 `oops_reloc_begin()` 不从方法开头算起

前两篇已经看到，`not_entrant` 或 `zombie` 方法的 verified entry 可能会被入口补丁覆盖。所以 `CompiledMethod::oops_reloc_begin()` 特意避开这片区域：默认从 `verified_entry_point()` 开始；如果方法已经不在 in_use 状态，还会额外跳过一条 `NativeJump::instruction_size`。源码注释直接解释了原因：前几字节可能已经被一条 JMP 糊住，如果旧代码那里原本有 oop，就不该再被 GC 当成有效嵌入引用处理。`share/code/compiledMethod.cpp:234`

这条边界非常漂亮，因为它说明 relocation 不是“永远无脑从头扫”，而是始终服从当前代码状态。

也就是说，地图本身并不足够；**读地图的人还得知道从哪一段开始，哪些区域当前已经失去原语义。**

### 三个典型消费者，为什么都适合顺序迭代

顺序迭代看起来像是个保守选择，但其实正好契合几个最重要的消费者。

第一类是 GC/卸载相关逻辑。前一篇已经看过，`do_unloading_oops` 会沿 relocation 迭代去找 `oop_type` 这样的记录；它的任务不是“随机跳到第 N 个 oop”，而是“把当前代码区里所有仍需处理的嵌入引用挨个过一遍”。

第二类是 inline cache 清理。`cleanup_inline_caches_impl()` 会从 `oops_reloc_begin()` 开始顺序迭代，遇到 `virtual_call_type`、`opt_virtual_call_type`、`static_call_type` 就检查它们是否还指向活着的方法，必要时清理。`share/code/compiledMethod.cpp:556`

第三类是调用点定位本身。`CompiledIC` 在拿到某个调用点位置后，也是沿着 relocation 语义来识别自己到底是普通 virtual call、优化 virtual call 还是其它类型。

这三类消费者有个共同点：**它们都是“沿一段代码范围做筛选与处理”，不是“建一个高频随机查表服务”。**

所以 RelocIterator 的简单，不是能力不够，而是刚好对准了需求。

## `NativeInst`：为什么有地图还不够，还要懂指令格式

到这里 relocation 已经告诉我们：哪里有可更新点、它属于什么语义家族。

但它还没解决一个更低层也更现实的问题：**要改，具体改哪几个字节？**

因为 relocation 记录的始终是“指令起点语义”，不是“直接把这个 4 字节槽写成某值”。真正下手改字节，还得理解该指令自己的编码布局。

这就是 `NativeInstruction` 家族的职责。

它不是为了做通用反汇编，而是为了给运行时补丁提供“针对某种已知指令形态的读写器”。

### `NativeCall`、`NativeMovConstReg`、`NativeJump` 各管哪一类字段

在 x86 这一侧，几个最常见的主角分工非常明确：

- `NativeCall` 负责 5 字节 call 指令，知道位移字段在哪里、怎样设置新目标；
- `NativeMovConstReg` 负责 `mov reg, imm64` 这类把立即数直接塞进寄存器的指令，适合读写缓存值、嵌入元数据等；
- `NativeJump` 负责无条件跳转，常出现在入口补丁或一些控制流重写里。

也就是说，relocation 说“这里是一个 virtual call 语义点”，`NativeCall` 才真正知道“位移字段从 opcode 后第几字节开始写”。

这两层一定要分开：

- relocation 关心“有没有语义上的可更新位置”；
- `NativeInst` 关心“这个位置在机器码字节层面怎么改”。

### `set_destination_mt_safe` 的真正难点不是会不会算位移

`NativeCall::set_destination_mt_safe` 这一段源码非常值得细读。开头的注释就把问题说透了：call 指令在任何时候都必须保持为一条合法 call；如果位移字段是对齐的，就利用 32 位写的原子性；如果不对齐，就先把 call 前两个字节原子改成一条跳向自身的短跳转，保护补丁窗口。`cpu/x86/nativeInst_x86.cpp:250`

这段逻辑的关键根本不是“怎样把目标地址换算成 rel32”，而是“怎样让别的自由运行线程在补丁期间也永远看不到半条坏指令”。

源码里的三步写序特别漂亮：

1. 先把前两个字节改成 `jmp rel8 -2`，也就是跳向自身；
2. 再把后面的位移字节改成新 call 目标对应的样子；
3. 最后把前两个字节再改回真正的 call 前缀。`cpu/x86/nativeInst_x86.cpp:261`

这套写序的意义是：

- 已经完整读到旧 call 的线程，可以正常执行旧路径；
- 正在补丁窗口里闯进来的线程，会先在自旋跳里原地打转；
- 没有线程会看到“opcode 已经是 call，但后面位移还是一半旧一半新”的半成品。

所以 `NativeInst` 这一层的真正价值，不是抽象了几种指令，而是把“读写机器码字段”提升成**并发下也合法的更新协议**。

## Inline Cache 为什么还要再多一层过渡桩

如果只有单字段补丁，到 `NativeInst` 这一层其实已经差不多够了。

inline cache 麻烦就麻烦在：它不是一个字段，而是一个小状态对。

前面讲过，典型的动态调用点既带有：

- `mov rax, imm64` 里的 cached value；
- 又带有 `call target` 里的目标入口。

你不能要求这两处在普通并发运行中“像一个 16 字节原子结构一样同时更新”。硬件不提供这种保证，运行时也不能指望自由运行线程在这里配合停下来等你改。

所以 HotSpot 的办法不是想办法做更大的原子写，而是**先把新状态搬到别处组装好，再让调用点只做一次单字段切换**。

这就是 `InlineCacheBuffer` 的存在理由。

### `create_transition_stub`：先在桩里组装完整新状态

`InlineCacheBuffer::create_transition_stub()` 的流程非常清晰：

- 如果当前 IC 已经处于 transition 状态，先清掉旧关联；
- 从 buffer 里拿一个新的 `ICStub`；
- 用 `set_stub(ic, cached_value, entry)` 把新状态写进这个 out-of-line stub；
- 再让原调用点的 destination 改指向这个 stub。`share/code/icBuffer.cpp:172`

这一步最值得记住的是：**调用点本体并没有立刻同时改两处字段，它只是把“下一跳”换成了过渡桩。**

而 `ICStub::set_stub()` 里真正组装桩代码的地方也很直白：`assemble_ic_buffer_code` 会发出一段“把 cached value 放进 `rax`，再 jump 到新 entry”的小桩。`share/code/icBuffer.cpp:71`、`cpu/x86/icBuffer_x86.cpp:52`

也就是说，一旦切到 transition stub，线程虽然仍从旧调用点出发，但后半段看到的已经是一个完整新状态：

- 新的 cached value；
- 新的目标入口；
- 而不是调用点本体上的一半旧一半新组合。

### `ICStub::finalize`：真正把新状态落回调用点，要等 safepoint

过渡桩不是永久形态。`ICStub::finalize()` 最终会重建出对应的 `CompiledIC`，然后调用 `set_ic_destination_and_value(destination(), cached_value())`，把桩里暂存的新状态真正写回调用点本体。`share/code/icBuffer.cpp:50`

而这个落地发生在 `update_inline_caches()` 驱动的 safepoint 语境里：buffer 会把积累的 stubs remove 掉，再初始化新的哨兵。`share/code/icBuffer.cpp:145`

这正是两阶段协议最精妙的地方：

- 第一阶段，在普通并发执行期只做“单字段改向 stub”的切换；
- 第二阶段，在 safepoint 里再做“多字段落回本体”的完整写回。

于是调用点在任何时刻都只会处于三种状态之一：

- 完整旧形态；
- 指向过渡桩的完整过渡形态；
- 完整新形态。

不会出现半成品。

### 为什么 buffer 满了要强制 safepoint

`InlineCacheBuffer` 不是无穷大。初始化时它就是一个 `StubQueue`，大小来自 `InlineCacheBufferSize`。`share/code/icBuffer.cpp:112`

如果 `new_ic_stub()` 发现队列满了，就会发起 `VM_ICBufferFull`，强制进一次 safepoint，把积压的 transition stubs finalize 掉。`share/code/icBuffer.cpp:120`

这再次说明过渡桩不是另类常驻执行路径，而是**为并发安全切换服务的短命中间态**。它存在的时间应该尽量短，积压多了就得集中落地清空。

## IC miss 与调用点闭环：谁发起补丁，谁看见新状态

到这里三层都已经齐了，但还差最后一个闭环问题：这些补丁到底由谁发起？

在调用点这一侧，真正把 destination 切到新入口或新桩上的底层入口是 `CompiledIC::internal_set_ic_destination()`。它会在 `CompiledIC_lock` 和必要时的 `Patching_lock` 保护下调用 `_call->set_destination_mt_safe(entry_point)`；如果是普通非 optimized 情况，再更新 cached metadata。`share/code/compiledIC.cpp:70`

这段代码还暴露出另一个关键事实：`CompiledIC` 自己知道是否处于 transition 状态。`ic_destination()` 如果发现 `_call->destination()` 指向的是 `InlineCacheBuffer` 里的地址，就会转而从 stub 里取当前逻辑上的 destination；`is_in_transition_state()` 也是据此判断。`share/code/compiledIC.cpp:132`、`share/code/compiledIC.cpp:142`

这说明 HotSpot 在调用点对象层面也承认：**“当前真实语义目标”和“call 指令里当前写着什么地址”在过渡期可能暂时分离。**

而这个分离之所以安全，正是因为前面三层机制一起兜住了它：

- relocation 知道这里是一个 virtual/opt virtual/static call 语义点；
- `NativeInst` 知道怎样 mt-safe 地改那条 call 指令本身；
- `ICBuffer` 知道怎样让多字段状态先在桩里成型，再落回本体。

所以 IC miss 或其它调用点重解析最终能形成一个非常强的闭环：**运行时不是直接把调用点“改成另一个样子”，而是始终让它在一组受控、可解释、无半成品的状态之间切换。**

## 到这里为止，主线其实只发生了四件事

如果前面细节偏多，这里先立一个路标，把整件事压回四步：

1. 编译期用 relocation 流把“哪些指令位置带语义地址”记成一张顺序地图；
2. 运行时用 `RelocIterator` 顺着地图找到值得处理的代码点；
3. 真正改字节时交给 `NativeInst` 这类懂指令格式的读写器；
4. 遇到像 inline cache 这种多字段状态切换，再通过过渡桩把“切换引用”和“落地数据”拆成两阶段。

只要这四步还在脑子里，就不会把 `relocInfo`、`NativeCall`、`ICStub` 这些名字看成互不相干的技巧集。

## 常见误解澄清

### 误解一：relocation 就是一张“实际地址表”

不是。

它首先记录的是语义类型和相对前一条记录的偏移，不是随手可随机索引的绝对地址数组。它更像顺序可解释的地图，而不是定位数据库。`share/code/relocInfo.hpp:75`

### 误解二：RelocIterator 必须支持随机定位才高级

没必要。

这里的主要消费者——GC、卸载、IC 清理、调用点扫描——本来就是顺序遍历代码语义点。顺序解码既更紧凑，也更符合实际访问模式。`share/code/relocInfo.hpp:569`

### 误解三：`NativeInst` 只是反汇编工具壳

不对。

它最重要的价值是把“如何在并发下安全改某种机器指令字段”封装成协议，而不只是提供几个字段偏移访问器。`cpu/x86/nativeInst_x86.cpp:250`

### 误解四：IC 过渡桩只是一个性能补丁

不是。

它首先是正确性机制：调用点同时携带 cached value 和 call target，两字段无法在普通运行期原子同改，所以必须先在桩里组装完整新状态，再切调用点过去。性能只是副产品。`share/code/icBuffer.cpp:172`

### 误解五：既然后来还是要在 safepoint 落地，那运行时过渡态就是不安全的

恰恰相反。

之所以要分“运行时切到过渡桩”和“safepoint 落回本体”两步，正是为了让运行时过渡态本身也保持完整可执行，而不是暴露半成品。`share/code/icBuffer.cpp:50`、`share/code/compiledIC.cpp:142`

## 收网：可更新机器码，本质上要同时满足三件事

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
编译期
  机器码 + relocation 记录
    └─ 这条指令里埋的是 oop / metadata / 调用点 / poll / 内部地址

运行时读取
  RelocIterator
    └─ 顺序解码：给你一个代码区范围，告诉你哪些位置值得看

运行时改字节
  NativeInst / NativeCall / NativeMovConstReg / NativeJump
    └─ 根据指令格式读写位移、立即数、入口补丁

并发切换调用点
  InlineCacheBuffer
    ├─ 先在桩里组装 (cached_value, entry)
    ├─ 调用点原子改向桩
    └─ safepoint 再把新状态落回调用点本体
```

把它再压成三句话：

- relocation 解决的是“哪里有语义上可更新的地址”；
- `NativeInst` 解决的是“这些地址在机器码字节层面具体怎么改”；
- `ICBuffer` 解决的是“当一个逻辑状态横跨多个字段时，怎样在并发执行里永远不暴露半成品”。

所以 HotSpot 让机器码“认识自己”的方法，并不是给字节流加某种神秘自省能力。

它做的是更朴素也更工程化的事情：编译时把语义位置记下来，运行时用专门的读写器改这些位置，再用过渡桩把高风险状态切换拆成无中间态的两阶段协议。

下一篇就顺着这条线继续往上走。你会发现 relocation 和 inline cache 解决的是“怎么安全记住并修改地址”，但 JIT 还有一类更高层的赌注：它会直接对类层次、实现唯一性、类型稳定性下注。这类假设不是单个调用点补丁能兜住的，一旦破了，往往整段代码都要去优化或重编。下一篇展开 `Dependencies` 与 `Deopt`。

> → [05-dependencies-deopt.md](05-dependencies-deopt.md)
