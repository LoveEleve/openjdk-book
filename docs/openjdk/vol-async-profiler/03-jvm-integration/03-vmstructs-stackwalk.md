# 03. 采样拿到的是地址，为什么最后能看到 Java 方法名 —— VMStructs、三种 walker 与 CodeCache

> **前置依赖**：[02 —— 只插几条指令，为什么会牵动整套 class 文件](./02-bytecode-rewriter.md)：知道 JVM 集成不只要接事件和改字节码，还要把运行时地址恢复成可读帧。
> → **后续**：地址和帧身份有了，Java/JNI 世界怎样把它们变成 API 结果
>
> 本篇基于当前 async-profiler 源码。重点是“地址和寄存器如何恢复成帧身份”，不把 VMStructs 写成一次性结构扫描，也不把 FP / DWARF / VM walker 写成简单快慢排序。

## 采样拿到的是地址，用户为什么最后看到的是 Java 方法名

场景：采样真正拿到的通常只是 `ucontext`、PC、SP、FP，以及少量事件元数据。用户却希望最后看到的是：

```text
com.example.Service.doBiz(Service.java:42)
```

这中间至少隔着四层鸿沟：

1. 当前地址到底属于哪个 native 库、哪个 JIT blob、还是 JVM 自己的运行时代码；
2. 如果它落在普通 native 库里，能否靠 FP 或 DWARF 恢复出物理调用链；
3. 如果它落在 HotSpot 解释器/JIT 代码里，JVM 内部那些 Klass、Method、scope、inline 信息到底藏在哪里；
4. 恢复出来的 still 是“地址和方法身份”，还不是最终的人类可读帧名。

因此，本篇真正要回答的不是“有几种 walker”，而是：**为什么 async-profiler 不能只靠符号表把地址翻译成名字，而必须先读 JVM 内部地图，再在不同栈结构之间切换多种 walker。**

*关键设计（斜体）：* *地址不是名字，寄存器不是栈帧。async-profiler 先要把地址归属清楚，再把物理栈恢复出来，最后才能谈逻辑 Java/JIT/inline 帧。* [模式: 地址归属 → 栈恢复 → 帧身份]

## 先推翻四个最容易把栈恢复讲平的直觉

### 地址直接查 native 符号表就够了

这只能覆盖最简单的 native 库符号。JIT 代码并不天然在 ELF/Mach-O 符号表里有完整 Java 语义；inline Java 方法甚至没有独立的物理 native frame。只做符号表查找，连“这个地址是不是落在 CodeCache”都不一定先弄清，更别说 Java scope 展开。

### 只要保留 frame pointer，所有栈都能走出来

FP 链当然很快，但不是所有库都保留稳定可用的 frame pointer。编译器优化、trampoline、vDSO、某些 JIT/解释器帧都会让“沿着一条物理 FP 链往上走”失效或中断。

### 有 DWARF 就不需要 VM walker

DWARF 适合恢复 native frame 的寄存器与 CFA 规则，但它不理解 HotSpot 的 Method、nmethod、inline scope、JavaFrameAnchor。DWARF 能把你带到某个物理地址，却不能自动把这段 JIT 代码展开成多层逻辑 Java inline 帧。

### 只靠 VM walker 就能解决所有问题

VM walker 擅长理解 HotSpot/JIT/解释器专属结构，但它也不是 native 世界的万能钥匙。普通 C/C++ 库、无 JVM 语义的 syscall 路径、外部共享库帧，仍然要靠 FP 或 DWARF 这类 native walker 去恢复。

这四个失败方案合在一起，正是本篇骨架：

```text
先判断地址属于哪个世界
  → native 世界先靠 FP/DWARF
  → JVM/JIT 世界再靠 VMStructs + VM walker
    → 最后交给后续 naming/symbol 层变成可读帧
```

## 第一层：VMStructs 不是版本号猜测，而是运行时地图协议

### 为什么不把 HotSpot 偏移写死在代码里

如果 async-profiler 把 `Klass::_name`、`Method::_constMethod`、`CodeCache::_heap` 这类偏移硬编码成“JDK 17 下是多少、JDK 21 下是多少”，一旦 JVM 内部布局调整，栈恢复就会在错误地址上继续解引用，轻则名字错，重则直接把 profiler 自己走崩。

当前实现的思路是：让 libjvm 自己给出结构地图。

`VMStructs::init()` 在 `src/vmStructs.cpp:133-139` 的作用很短：保存 `libjvm` 对应的 `CodeCache*`，然后调用 `initOffsets()`。真正的大头在 `initOffsets()`（`src/vmStructs.cpp:148-339`）：它先读出 `gHotSpotVMStructs`、entry stride、type/field/offset/address 这些元数据，再逐条扫描 VMStructs 表，把当前 JVM 自己暴露出来的偏移和地址抄进 async-profiler 的静态字段。

这张运行时地图里会抽出很多后面要靠的结构信息，例如：

- `Klass::_name`；
- `Symbol::_length` / `_body`；
- `oopDesc` 的 Klass 指针；
- `CompiledMethod` / `nmethod` 的 method、entry、scope data；
- `JavaThread`、`OSThread`、`JavaFrameAnchor` 的关键偏移；
- `CodeCache` / `CodeHeap` 相关地址与边界。

也就是说，VMStructs 在当前实现里首先解决的是：**不要猜当前 JVM 的内部布局，而是让当前 JVM 自己把地图给你。**

### 为什么还要分成 `initOffsets()` 和 `ready()` 两段

现稿里最容易被写错的一点，就是把 `VMStructs::ready()` 讲成“重新扫描全部 VMStructs 表”。源码不是这样。

- `VMStructs::init()` + `initOffsets()`：在 agent load 时先把能从 VMStructs 表与固定符号里读出来的原始偏移/地址记下来；
- `VMStructs::ready()`（`src/vmStructs.cpp:141-146`）：当前只做三件事——`resolveOffsets()`、`patchSafeFetch()`、`initThreadBridge()`。

这三件事的意义不同：

- `resolveOffsets()`（`src/vmStructs.cpp:445+`）用当前 JVM flag 和已收集的地址，把“原始偏移/地址片段”解析成真正可用的能力位：例如 `_has_class_names`、`_has_method_structs`、`_has_compiler_structs`、`_has_stack_structs`，以及压缩 class pointer、CodeHeap 范围等条件；
- `patchSafeFetch()`（`:576+`）只针对当前实现覆盖的少数 JDK/WX_MEMORY 组合给 safefetch 入口打 workaround 补丁，而不是所有平台上的通用修复层；
- `initThreadBridge()`（`:600+`）用 JNI/JVMTI 找到 `Thread.tid`，并按 OpenJ9/HotSpot 不同分支去寻找线程桥与 TLS index。

因此 `ready()` 不是又扫一遍地图，而是：**等 JVM 和 JNI 真正 ready 之后，把早先拿到的原始地图解析成一组“今天哪些结构能力真的可用”的 capability bits，并把安全读取/线程桥这些“必须等 JVM 活起来才能碰”的设施补上。**

*关键设计（斜体）：* *VMStructs 的兼容性来自“当前 JVM 交地图 + ready 阶段再把地图解析成能力”，而不是靠版本号分支猜结构。* [模式: 运行时地图 + 两段式准备]

## 第二层：walkFP 与 walkDwarf 恢复的是物理 native frame，不是逻辑 Java 帧

### `walkFP()`：最快，但前提是栈上真有一条可信的 FP 链

`StackWalker::walkFP()` 位于 `src/stackWalker.cpp:73-120`。它的结构非常直接：

1. 从 `ucontext` 或 caller 环境取出 PC、FP、SP；
2. 先把当前 PC 记进 callchain；
3. 检查下一个 frame pointer 是否位于合理栈区间；
4. 验证对齐和死区；
5. 从 FP 槽位读返回地址和下一个 FP；
6. 遇到 CodeHeap、非法地址或栈边界问题时停止。

它快，是因为只沿物理链走；它脆弱，也正因为只沿物理链走。编译器不保 FP、叶子函数优化、trampoline、特殊 stub，都会让这条链断掉。换句话说，FP walker 回答的是“栈上有没有一条我还能顺着走的原生链”，不是“程序逻辑调用关系一定完整”。

### `walkDwarf()`：用解帧规则恢复寄存器，而不是靠显式链条

`StackWalker::walkDwarf()` 在 `src/stackWalker.cpp:122-212`。这里关键不在“DWARF 更慢”，而在“它换了一套证据来源”：

- 先用当前 PC 找到所属库，再从 `CodeCache` 里拿到 `FrameDesc`（`stackWalker.cpp:150-152`）；
- 根据 CFA、FP offset、PC offset 这些规则重新计算下一帧；
- 遇到 vDSO/default frame 之类特殊情况，还会 retry；
- 一样会检查栈边界、对齐和死区。

这说明 DWARF walker 仍然在恢复物理 native frame，只是它不依赖栈上显式 FP 链，而依赖外部解帧规则。它能覆盖很多“没有稳定 frame pointer，但有有效 unwind info”的库；但同样，它也不会自动理解 HotSpot inline scope。

所以 FP 与 DWARF 不是“一个原始、一个高级”，而是：

```text
FP     → 栈上的物理链
DWARF  → 库外带的物理解帧规则
```

它们都在解决 native frame 的恢复问题，而不是 Java 逻辑帧的展开问题。更具体地说，真正的调用桥在 `Profiler::getNativeTrace()`（`src/profiler.cpp:303-318`）：非 perf 执行样本时，`_cstack == CSTACK_DWARF` 才显式走 `walkDwarf()`，否则默认走 `walkFP()`；而 `_cstack == CSTACK_VM` 时直接返回 0，把 native trace 的解释留给 VM walker。

*关键设计（斜体）：* *FP 和 DWARF 都在恢复物理 native frame，只是证据来源不同：一个用栈上的链，一个用外部 unwind 规则。* [模式: 物理帧恢复的两条证据链]

## 第三层：`walkVM()` 为什么更像“逻辑 Java/JIT/inline 帧恢复器”

到了 `StackWalker::walkVM()`（`src/stackWalker.cpp:214+`），问题不再是“下一帧的返回地址在哪”，而是“当前这段地址怎样映射成 Java/JIT/inline 的逻辑帧”。

这条路径一开始就显得更重：

- 它会保存 `lock_index` 对应的 `jmp_buf` 到 `crash_protection_ctx`，一旦途中触碰不可安全解引用的地址，可以 longjmp 回来并写入 `break_not_walkable`（`stackWalker.cpp:235-247`）；
- 它会通过 `VMThread::current()`、`JavaFrameAnchor` 去确定自己是不是处于 JavaThread 上下文（`:252-260`）；
- 后面还要结合 `CodeHeap::contains(pc)`、VMStructs 偏移、compiled method / interpreter frame / scope data 等结构继续向下解。

这说明 VM walker 的核心不是“多走几帧”，而是**把 HotSpot/JIT 内部地址恢复成逻辑 Java 帧身份**。尤其是 inline：一个物理 JIT frame 里可能折叠了多层 Java 方法，native 符号表与 FP/DWARF 都不会替你把这些逻辑层次重新展开。

但它并不是总能从任何线程上下文直接起跑。`stackWalker.cpp:252-260` 明确显示：当当前线程能解析成 `JavaThread` 时，若不是 details 路径且 `anchor->restoreFrame(pc, sp, fp)` 失败，`walkVM()` 会直接返回 0。也就是说，VM walker 的前提之一就是线程桥与 JavaFrameAnchor 至少能把你带到第一个可解释的 Java frame。

所以更准确的说法是：

```text
walkFP / walkDwarf 解决“物理 native frame 怎么走”
walkVM             解决“JVM/JIT 逻辑 Java frame 怎样认出来”
```

这也是为什么三种 walker 不能互相替代：它们看的不是同一个层次的问题。

到这里可以先把主线收一下：前两个 walker 先回答“native 物理 frame 能不能安全走出来”，`walkVM()` 再回答“这些地址能不能恢复成 Java/JIT 逻辑帧”；后面的 CodeCache/CodeHeap 章节，就是把这两种恢复动作重新挂回地址归属主线。

### safe fetch、thread bridge 和 crash protection 为什么属于主线

`walkVM()` 之所以看起来比前两个 walker 重得多，不是因为作者“写得复杂”，而是它在碰 JVM 内部结构前必须先铺三层防护：

- `resolveOffsets()` 得先确认哪些结构和偏移今天可用；
- `patchSafeFetch()` 得先把当前实现支持的少数 JDK/WX_MEMORY safefetch 入口补到可安全读取的版本；
- `initThreadBridge()` 得先按 OpenJ9/HotSpot 分支找到 Java Thread 到 VMThread/j9thread 的桥；
- `setjmp`/`longjmp` crash protection 得保证即使中途碰到不可走的 frame，也别把 profiler 自己炸掉。

如果没有这些防护，VM walker 就会把“理解 JVM 逻辑帧”直接变成“盲目解引用 libjvm 内存”。所以这些并不是附属工程细节，而是 JVM 内部栈恢复得以成立的前提。

## 第四层：CodeCache/CodeHeap 先回答“这个地址属于谁”，再谈名字

### CodeCache 不是 frame naming，它先做地址身份

`src/codeCache.cpp:32-154` 描述的是一套地址区间索引：

- `add()` 把 `[start, end)`、名称、库索引放进 `CodeBlob` 数组；
- `updateBounds()` 和 `sort()` 维护整体地址范围；
- `findBlobByAddress()` 与 `binarySearch()` 负责按地址找 blob；
- `findSymbolByPrefix()` 则用于更早阶段的内部符号定位。

如果只盯着这些函数名，很容易把 CodeCache 误读成“又一个符号表容器”。但它在本篇主线中的位置更准确地说是：**地址先要有归属，walker 才知道自己此刻站在 native lib、JIT blob 还是 JVM runtime 上。**在 `Profiler::findNativeMethod()`（`src/profiler.cpp:294-297`）里，这条桥已经很明确：先 `findLibraryByAddress()` 找到地址属于哪一个库，再用 `binarySearch()` 在该库的 CodeBlob 区间里取符号名。

### `CodeHeap::contains(pc)` 是 walker 选路边界

在 `walkFP()` 和 `walkDwarf()` 中，都会先用 `CodeHeap::contains(pc)` 判断地址是不是已经落入 Java/JIT code heap；一旦是，而且不是 depth 0 的特例，就停止继续按纯 native frame 走（`stackWalker.cpp:94-96`、`:144-145`）。

这意味着 CodeHeap/CodeCache 在这里承担的是两级边界：

- `CodeHeap::contains(pc)` 先回答“地址是不是已经进入 JVM/JIT 世界”；
- 进入具体库或 blob 之后，CodeCache 再回答“它属于哪一个地址区间、后续该按哪个实体继续解释”。

换句话说，CodeHeap 更像世界边界，CodeCache 更像世界内部的地址身份索引。它们还没把地址翻译成最终帧名，但已经把“接下来该走哪个世界、哪个区间的解释规则”决定了下来。

*关键设计（斜体）：* *CodeCache/CodeHeap 先解决地址身份，再决定 walker 应该继续按 native 规则走，还是切到 JVM/JIT 规则。* [模式: 地址归属先行]

## 第五层：在 AP-4 命名前，AP-3 先把地址恢复成帧身份

把整篇压缩成一句话：

```text
地址先判归属
  → JVM 地图提供内部偏移
    → FP/DWARF 恢复物理 native frame
      → VM walker 恢复逻辑 Java/JIT/inline frame
        → CodeCache/CodeHeap 维持地址身份边界
          → AP-4 再把帧身份翻译成人类可读名字
```

换一种不看图的复述方式：

- VMStructs 解决“今天这个 JVM 的内部地图长什么样”；
- FP 与 DWARF 解决“native 栈的物理 frame 怎样走”；
- VM walker 解决“JIT/解释器/inline 帧怎样恢复成逻辑 Java 身份”；
- CodeCache 解决“这个地址先属于哪个 blob/哪个世界”；
- AP-4 才继续把这些帧身份变成最终的人类可读名字。

本篇的一句话困惑是：**为什么 async-profiler 明明已经拿到了地址和寄存器，还不能直接查符号表生成 Java 方法名？**

本篇的一句话顿悟是：**因为地址先要被归类到 native 库、CodeHeap 或 JVM 内部结构，再结合 VMStructs 地图与合适的 walker 恢复成物理或逻辑帧身份；名字只是最后一步，不是第一步。**

*关键设计（斜体）：* *AP-3 的任务不是给帧起名字，而是把“地址/寄存器状态”先恢复成可靠的帧身份；只有身份站稳，AP-4 的命名才不会建立在错误地址上。* [模式: 身份先于命名]

[跨层标注：VMStructs——运行时 JVM 地图协议；FP/DWARF——native 物理帧恢复；VM walker——Java/JIT/inline 逻辑帧恢复；CodeCache/CodeHeap——地址身份和选路边界；safe fetch / thread bridge / crash protection——JVM 内部栈恢复防护层]

## 下一篇：地址和帧身份有了，Java/JNI 世界怎样把它们变成 API 结果

这一篇先解决“地址怎么恢复成帧身份”。下一篇继续看：

- native profiler 怎样把结果通过 JNI/Java API 暴露出去；
- execute0/execute1、RegisterNatives 与 Java helper 各自承担什么角色；
- 为什么 Java API 只是桥，不是参数或语义中心。

**→ 下一篇：JNI/Java API 桥接与结果消费。**
