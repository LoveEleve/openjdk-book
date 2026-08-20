# 03. Arena、ResourceArea 与 AllocateHeap：HotSpot 怎么把 C++ 临时对象的生命周期收拢到作用域里

> 前置阅读：[02-VirtualSpace：保留与提交为什么要分离](02-virtualspace.md)
> 相关篇章：[01-Universe + Heap：VM 启动时先搭什么台子](01-universe-heap.md)、[01-ClassFileParser：为什么 parser 要先接管半成品元数据](../07-classfile-classloader/01-classfile-parser.md)
> 版本边界：`OpenJDK 11u / HotSpot / Linux / x86_64`

## 这篇真正要回答的问题

HotSpot 自己也是一大坨 C++ 程序。它在解析 class 文件、做即时编译、跑 GC、拼诊断字符串时，也会不停创建临时对象。最朴素的做法当然是 `malloc` 时申请、用完 `free`。问题在于，VM 里很大一批对象并不是“各活各的”，而是“跟着一个作用域成批出生、再成批失效”。如果还按普通 `malloc/free` 管理，代码就会被释放逻辑拖着跑：每条错误路径都要补清理，每层调用都要想清楚谁拥有谁，稍一漏掉就变成泄漏，稍一提早就变成悬垂指针。

HotSpot 的回答不是再造一个“更快的 malloc”，而是先按生命周期把问题拆开：能跟着某个作用域整批回收的，放进 Arena；每线程那条最常用的临时分配路径，叫 ResourceArea；寿命不规则、跨作用域、没法整批回收的，才走 `AllocateHeap` 这一层普通 C-heap 包装；需要额外抓越界和错用的，再在外面套 `GuardedMemory`。整篇文章的主线就是这一句：**HotSpot 优化的重点不是单次分配指令数，而是让“释放”这件事重新变得有结构。**

## 如果全部都走 `malloc/free`，真正坏掉的是什么

先看三个最容易想到的方案。

第一种方案，是所有 VM 临时对象都直接 `malloc/free`。这当然能工作，但它把本来整齐的生命周期打散了。举个最常见的场景：`ResourceMark rm;` 在 HotSpot 里并不是角落技巧，而是很多路径的常规起手式。比如 `OopMapSet::update_register_map()` 一进来就先立 `ResourceMark rm;`，见 `share/compiler/oopMap.cpp:402`；`CompileBroker` 打印 code cache 摘要时也是先立 mark 再拼接 `stringStream`，见 `share/compiler/compileBroker.cpp:1977`；引用处理器为了 tracing 临时对象也会这么做，见 `share/gc/shared/referenceProcessor.cpp:1186`；`VMThread::evaluate_operation()` 在执行 VM operation 前同样先立 mark，见 `share/runtime/vmThread.cpp:403`。如果把这些对象全改成单独 `malloc/free`，每个调用链上的退出点都要补成对释放，错误路径和早返回路径尤其难管。问题不在于 `free` 慢一点，而在于释放责任被传播到了整条调用链。

第二种方案，是大家共享一个全局 Arena。这样能避免频繁 `malloc/free`，却表达不了“线程内、作用域内”这件事。`ResourceArea` 明确写着“actual allocation areas are thread local”，也就是底层区块虽然都叫 Arena，但真正承载临时对象的分配区是线程私有的，见 `share/memory/resourceArea.hpp:31`。如果改成全局共享，所有线程都要在同一条 chunk 链上 bump 指针，争用会立刻出现；更麻烦的是，一个线程根本没法安全地把另一个线程仍在使用的临时对象一起回滚。

第三种方案，是让 `AllocateHeap` 承担所有场景，然后用 NMT、调试器和人工纪律去兜底。这个方案适合长寿命、不规则寿命对象，却不适合“作用域退出就该一起死”的对象。`AllocateHeap` 只是 `os::malloc` 的包装，带失败策略和内存记账，见 `share/memory/allocation.cpp:39`。它能告诉你这块内存从哪来，却不会把一百个临时对象在作用域结束时自动卷走。也就是说，它解决的是“怎么申请、怎么记账”，不是“怎么表达生命周期”。

这三种失败方案推到最后，逼出的其实是同一个需求：**VM 需要一种 region allocator，让一批对象共享同一份释放边界；这条边界最好还能直接挂在 C++ 作用域上。** Arena 和 ResourceArea 就是为这个需求出现的。

## Arena 解决的不是“更快”，而是“整批释放”

Arena 的底层模型很简单：它维护一串 `Chunk` 链表，当前 chunk 里靠 `_hwm` 和 `_max` 表示“已经用到哪”和“还能用到哪”，见 `share/memory/arena.hpp:102`。真正的快路径在 `Arena::Amalloc`：先对齐，再做溢出检查，然后只判断 `_hwm + x > _max`。还塞得下，就返回旧 `_hwm` 并把它向前推；塞不下，才走 `grow`，见 `share/memory/arena.hpp:144`。

这就是大家熟悉的 bump-pointer 分配，但只看到这里还不够，因为 Arena 的关键不在分配，而在释放语义。`Afree` 并不是普通意义上的 `free`。它只在一个非常窄的条件下回退：被释放的那块内存恰好是最近一次分配、并且位于当前水位顶部时，才把 `_hwm` 指回去；否则什么都不做，见 `share/memory/arena.hpp:201`。这说明 Arena 从设计上就不打算支持“任意对象随时归还”。它承认块内会留空洞，但换来的是对象完全不需要逐个登记、逐个析构、逐个回收。

真正的释放发生在 Arena 本身结束时。`Arena::~Arena` 会调用 `destruct_contents()`，后者把 `_first` 开始的 chunk 链整个 `chop()` 掉，见 `share/memory/arena.cpp:284` 与 `share/memory/arena.cpp:312`。`Chunk::chop()` 又沿着链表逐块 `delete`，见 `share/memory/arena.cpp:221`。所以从语义上说，Arena 更像“一个生命周期容器”，不是“一个更聪明的 malloc 替身”。它的承诺是：你只要接受对象们一起死，我就把释放成本压缩到一次 mark 回退或一次 region 销毁。

这也解释了为什么把 Arena 说成“更快的 malloc”会误导读者。更快只是表象。真正让它成立的前提是：这批对象本来就该一起失效。如果生命周期本身不整齐，Arena 反而会把问题藏起来，让内存拖得更久。

## Chunk 为什么有四种规格，而且第一个 chunk 不是 32K

`Chunk` 的规格定义在 `share/memory/arena.hpp:55`。HotSpot 预设了 `tiny_size`、`init_size`、`medium_size`、`size` 四档，分别对应大约 256B、1K、10K、32K，再减去一段 `slack`。源码注释明确说，这些大小故意“slightly smaller than 2**k to guard against buddy-system style malloc implementations”，见 `share/memory/arena.hpp:56`。也就是说，它不是数学上的整齐尺寸，而是刻意避开某些底层 buddy 风格分配器对 2 的幂大小的特殊处理。

更常见的误解是“Arena 第一个 chunk 就是 32KB”。默认构造函数不是这么做的。`Arena(MEMFLAGS flag)` 直接拿的是 `Chunk::init_size`，也就是 1K 这一档，见 `share/memory/arena.cpp:259`。只有当前 chunk 不够用时，`grow()` 才按 `MAX2(x, Chunk::size)` 决定新块大小，也就是至少给你一个 32K 默认块；如果你一次请求本身更大，就按更大的请求来，见 `share/memory/arena.cpp:353`。这意味着“32K”既不是第一块固定尺寸，也不是所有后续块的绝对上限；它只是 grow 路径上的默认下限。

再往下看，ChunkPool 只缓存四种 canonical 尺寸。`Chunk::operator new` 会根据 `length` 落到 large、medium、small、tiny 四个静态池；不属于这四种尺寸的块，直接 `os::malloc`，见 `share/memory/arena.cpp:182`。`Chunk::operator delete` 也是同样逻辑：四种标准尺寸回池，其他尺寸直接 `os::free`，见 `share/memory/arena.cpp:204`。所以池化只是 backing storage 复用优化，不是 Arena 语义本身的一部分。

ChunkPool 的实现也值得记一笔。它不是一个池，而是四个池，见 `share/memory/arena.cpp:49`。初始化发生在 `chunkpool_init()`，而 `vm_init_globals()` 启动时就会调它，见 `share/runtime/init.cpp:47` 和 `share/runtime/init.cpp:90`。运行中如果 `CleanChunkPoolAsync` 打开，VM 还会启动定期清理任务，每 5 秒执行一次 `ChunkPool::clean()`，每个池只保留 5 块，其余归还给系统，见 `share/memory/arena.cpp:169`、`share/runtime/globals.hpp:259`、`share/runtime/thread.cpp:3953`。这层设计回答的不是“生命周期怎么表达”，而是“表达完以后，底层这些标准块怎么避免反复向系统 malloc/free 抖动”。

## ResourceArea 不是另一套分配器，它是 Arena 的线程内使用协议

如果说 Arena 只是“region allocator”这个抽象，那么 HotSpot 最常走的那条具体路径就是 ResourceArea。`ResourceArea` 直接继承自 `Arena`，见 `share/memory/resourceArea.hpp:44`。它没有换一套 chunk 算法，也没有换一套底层内存来源，区别在于它把 Arena 固定成了“每线程一份的临时区”。

线程对象构造时就会安装自己的 `ResourceArea`：`Thread::Thread()` 里直接 `set_resource_area(new (mtThread) ResourceArea())`，见 `share/runtime/thread.cpp:230`；访问入口也只是 `Thread::resource_area()` 这个 getter，见 `share/runtime/thread.hpp:505`。编译线程还会在构造时调用 `resource_area()->bias_to(mtCompiler)`，见 `share/runtime/thread.cpp:3446`。这个 `bias_to` 只是让 NMT 归类成编译器内存，不会把 ResourceArea 的生命周期语义改掉。

真正落到 ResourceArea 的接口也很直白。`ResourceObj::operator new(size_t)` 默认调用 `resource_allocate_bytes(size)`，见 `share/memory/allocation.hpp:393`；而这条路径最终就是当前线程的 `ResourceArea::allocate_bytes()`，它在 ASSERT 模式下甚至会直接检查有没有外层 `ResourceMark`，见 `share/memory/resourceArea.inline.hpp:30`。如果 `_nesting < 1`，就报 fatal：`memory leak: allocating without ResourceMark`。这段检查很能说明设计意图：HotSpot 并不希望你把 ResourceArea 当成一个随便可用的线程本地大袋子，而是希望每一次临时分配都明确挂在某个 mark 作用域下面。

所以，ResourceArea 的正确理解不是“另一种新分配器”，而是“把 Arena 变成线程私有、并且默认要求作用域化使用的协议层”。底层仍是 chunk 链 + bump pointer，变化的是使用纪律。

## ResourceMark 真正回滚的是一个 checkpoint，不只是 top 指针

理解 ResourceArea，最关键的对象不是它自己，而是 `ResourceMark`。它的构造函数会把当前线程 `resource_area()` 的四样状态全部保存下来：当前 chunk、当前 `_hwm`、当前 `_max`、当前累计 `size_in_bytes`，见 `share/memory/resourceArea.hpp:84`。这四样合在一起，才是一个完整的 checkpoint。

因此析构时也不是简单把 top 指回去。`reset_to_mark()` 先看保存时那个 chunk 后面有没有新 chunk。如果有，先把 arena 的统计尺寸调回旧值，再执行 `_chunk->next_chop()` 把 mark 之后新增的整段 chunk 链全部砍掉，见 `share/memory/resourceArea.hpp:129`。只有处理完这些“后来扩出来的块”之后，才把 `_area->_chunk`、`_area->_hwm`、`_area->_max` 恢复到保存值。

这一步非常重要，因为它纠正了一个很流行但不完整的说法：ResourceMark 不是“把 top 指针回滚一下”而已。如果中途 grow 过，mark 之后长出来的 chunk 也必须一起回收。否则某次大编译或大扫描阶段临时扩出来的 chunk 会一直挂在线程的 ResourceArea 上，后续再也用不到，却也不归还。

`ResourceMark` 还把这种回滚语义变成了标准 C++ 作用域模式。进入阶段时立一个局部变量，离开作用域时自动析构，释放点就和代码结构绑定在一起。嵌套使用也天然成立：内层 mark 只退回到内层的 checkpoint，外层继续保留自己的临时对象。HotSpot 到处都能看到这种写法，本质上是在用语言作用域给临时对象的生命周期画边界。

再看 ASSERT 侧的辅助措施：`ZapResourceArea` 打开时，回滚后会把废弃区间填成 `badResourceValue`，见 `share/memory/resourceArea.hpp:145`，配合 `Afree` 和 `Chunk::chop()` 里的同类填充，可以帮助尽早暴露 use-after-reset 或越界写。这也再次说明，Arena/ResourceArea 的正确使用姿势不是“对象活多久随缘”，而是“只在明确的短作用域里借用”。

## `AllocateHeap` 负责的是不规则寿命，不是 Arena 的低配版

另一条常见误解是把 `AllocateHeap` 看成“慢一点但更通用的 Arena”。实际上它们解决的是不同维度的问题。

`AllocateHeap` 的代码非常薄：调用 `os::malloc`，失败时按 `AllocFailStrategy` 决定是直接 OOM 退出，还是返回 `NULL`，见 `share/memory/allocation.cpp:39` 和 `share/memory/allocation.hpp:34`。配套的 `ReallocateHeap`、`FreeHeap` 也只是 `os::realloc`、`os::free` 包装，见 `share/memory/allocation.cpp:57` 与 `share/memory/allocation.cpp:68`。`CHeapObj<F>`、`NEW_C_HEAP_ARRAY` 这些模板和宏只是把这条路径用类型和 `MEMFLAGS` 封装起来，见 `share/memory/allocation.hpp:174` 与 `share/memory/allocation.hpp:456`。

它适合的对象画像很明确：寿命长、跨作用域、可能被多个阶段共享，或者虽然不一定长寿，但根本没有一个单一 checkpoint 可以把它们一锅端掉。换句话说，Arena 和 `AllocateHeap` 的边界不是“快慢”，而是“生命周期能不能被结构化”。能结构化，就让释放跟着 mark 或 region 走；不能结构化，就老老实实走普通 C-heap。

`ResourceObj` 的多个 `operator new` 也把这条分界线写死在接口里了。默认 `new ResourceObj` 走 ResourceArea，`new (arena)` 走显式 Arena，`new (ResourceObj::C_HEAP, flags)` 则改走 `AllocateHeap`，见 `share/memory/allocation.cpp:101` 与 `share/memory/allocation.cpp:113`。同一个基类之所以要保留这三条路，正是因为 HotSpot 不认为“所有 C++ 对象都该用同一种内存纪律”。

## NMT header 记录的是索引，不是把调用栈塞进每个块头里

谈 `AllocateHeap` 时，另一个很常见的误传是“每个 malloc 块头里直接嵌了一份调用栈”。OpenJDK 11u 不是这么干的。

NMT 这层的块头叫 `MallocHeader`。在 LP64 下，它占两个 machine word，源码里还有 `assert(sizeof(MallocHeader) == sizeof(void*) * 2)`，见 `share/services/mallocTracker.hpp:246`。头里放的是 `_size`、`_flags`、`_pos_idx`、`_bucket_idx`。也就是说，它保存了块大小、内存类别，以及在 malloc site 表里的位置索引。

真正的调用栈并不在块头里，而在全局 `MallocSiteTable`。分配时 `MallocHeader::record_malloc_site()` 会把当前 `NativeCallStack` 录到站点表里，再把 bucket/position 索引写回 header，见 `share/services/mallocTracker.cpp:79`、`share/services/mallocSiteTable.hpp:200`、`share/services/mallocSiteTable.cpp:142`。后面要取回栈信息时，`MallocHeader::get_stack()` 也是按这两个索引去表里查，见 `share/services/mallocTracker.cpp:92`。

这样做的收益很直接：每个分配块只背固定头开销，而不是复制整份栈轨迹。副作用是，如果站点表插入失败，比如 OOM 或 bucket 溢出，NMT 会退化到 summary 级别，见 `share/services/mallocTracker.cpp:83`。这也说明 NMT 的重点是全局记账可用性，不是执着于给每个块都保一份完整细节。

顺带一提，调用栈采样本身也是条件触发的。`CURRENT_PC` 和 `CALLER_PC` 宏只有在 NMT detail 级别且 `NMT_stack_walkable` 为真时，才会真的抓 `NativeCallStack`；否则就是空栈，见 `share/services/memTracker.hpp:88`。所以 `AllocateHeap` 路径里的“我能看到调用点”并不是无条件能力，而是一套按 tracking level 打开的追踪体系。

## GuardedMemory 不是玩具，它真正在给 checked JNI 兜底

`GuardedMemory` 最容易被轻视成“调试时才会顺手开的护栏”。实际上它至少服务两类真实路径。

第一类是 ASSERT 构建里的 `os::malloc`。在 ASSERT 下，`os::malloc` 申请的并不是“用户大小 + NMT 头”，而是再额外包一层 `GuardedMemory::get_total_size(...)`，然后把用户区指针交给后续逻辑，见 `share/runtime/os.cpp:700`。到了 `os::free()`，顺序也不是“只检查 guard 然后释放”这么简单：它先经 `MemTracker::record_free` 退回到带 NMT 头的基地址，再做 `verify_memory(membase)`，之后才把这块内存重新包成 `GuardedMemory guarded(membase)`，取出 user size，最后 `release_for_freeing()` 交给 `::free`，见 `share/runtime/os.cpp:801`。也就是说，ASSERT 路径里真正被验证的是“普通分配 + NMT 头 + guard 外壳”这整层包装，而不只是最外面的 guard。

第二类，也是更值得写进正文的一类，是 checked JNI。`GuardedMemory` 自己的头文件就直接写了 “Primarily used by debug malloc and checked JNI”，见 `share/memory/guardedMemory.hpp:31`。它的布局是：头部 16 字节 guard，加上用户区大小和 tag，再接用户数据，最后还有尾部 16 字节 guard，见 `share/memory/guardedMemory.hpp:39` 与 `share/memory/guardedMemory.hpp:96`。guard 的内容是 `badResourceValue`，也就是 `0xAB`；用户区初始填 `uninitBlockPad` 即 `0xF1`，释放时改填 `freeBlockPad` 即 `0xBA`，见 `share/memory/guardedMemory.hpp:51` 到 `share/memory/guardedMemory.hpp:55`。

checked JNI 里这套机制是真正在用的。数组元素的包装通过 `GuardedMemory::wrap_copy` 完成，原始指针塞在 tag 里；释放时先 `verify_guards()`，再按模式决定是否拷回并 `free_copy`，见 `share/prims/jniCheck.cpp:377` 与 `share/prims/jniCheck.cpp:415`。字符串路径也是同样套路：`checked_jni_GetStringChars` 和 `checked_jni_GetStringUTFChars` 都会把返回内容包进 `GuardedMemory`，释放时再核对 guard 和 tag，见 `share/prims/jniCheck.cpp:1463` 与 `share/prims/jniCheck.cpp:1547`。而这一整套检查受 `CheckJNICalls` 开关控制，见 `share/runtime/globals.hpp:913`。

这里最值得纠正的误解有两个。第一，`verify_guards()` 只验证头尾 guard，没有承诺用户区内容仍是 `0xF1` 或 `0xBA`，见 `share/memory/guardedMemory.hpp:212`。第二，`0xAB`、`0xF1`、`0xBA` 分别扮演不同角色：`0xAB` 是 guard，本体负责检测越界；`0xF1` 和 `0xBA` 是用户区填充值，用来帮助识别未初始化或已释放状态。把它们混成“同一个 canary”会把这层设计讲糊。

## 把三条路放回同一张图里

到这里，HotSpot 在 C++ 侧内存分配上的分工就清楚了。

Arena 解决的是“这批对象能不能共享一个释放边界”。如果答案是能，它就用 chunk 链和 bump pointer 把单次分配压到很薄，把释放推迟到 checkpoint 或 region 销毁时一次完成。ResourceArea 则把这套机制进一步收紧成“每线程、默认必须挂在 `ResourceMark` 作用域下”的协议。它不是新的底层算法，而是把 Arena 变成了 VM 临时对象的日常用法。

`AllocateHeap` 处理的是另一类对象：生命周期不整齐，不能跟着某个 mark 一起丢，也不适合长期挂在线程私有临时区里。它保留普通 C-heap 的自由度，同时叠加 `MEMFLAGS`、OOM 策略和 NMT 记账。GuardedMemory 又是在这些普通分配外面再套一层 guard，用来抓越界和错配释放，尤其在 checked JNI 上是真实生产检查路径的一部分。

所以最应该记住的不是四个类名，而是一条分界线：**生命周期整齐、能按作用域整批失效的，进 Arena/ResourceArea；生命周期不规则、需要独立拥有权的，进 `AllocateHeap`；需要调试护栏时，再额外包 `GuardedMemory`。**

## 最后把常见误解一次说清

Arena 不是“更快的 malloc”，而是 region-based lifetime discipline。第一个 chunk 默认也不是 32K，而是 `init_size` 这一档，见 `share/memory/arena.cpp:259`。grow 也不是永远固定 32K，而是至少 32K，遇到更大的单次请求就按更大值走，见 `share/memory/arena.cpp:353`。`Afree` 不能释放任意对象，它只优化最近一次分配，见 `share/memory/arena.hpp:202`。`ResourceArea` 不是全局共享 Arena，而是线程私有 Arena，见 `share/runtime/thread.cpp:230`。`ResourceMark` 也不只是回滚 top 指针，它还会把 mark 之后新增的 chunk 链一起 chop 掉，见 `share/memory/resourceArea.hpp:132`。`MallocHeader` 不直接携带完整调用栈，只存站点索引，见 `share/services/mallocTracker.hpp:246`。`GuardedMemory` 也不只是调试玩具，checked JNI 就在靠它检查数组与字符串缓冲区边界，见 `share/prims/jniCheck.cpp:395` 与 `share/prims/jniCheck.cpp:1502`。

把这些误解剥掉之后，Arena 这一章真正成立的结论只有一个：**HotSpot 在 C++ 侧最重要的优化，不是把分配做成一条更快的指令路径，而是把临时对象的寿命压缩回代码作用域，让释放再次可推理。**
