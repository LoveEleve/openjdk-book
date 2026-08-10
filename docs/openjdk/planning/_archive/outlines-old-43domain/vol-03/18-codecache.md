# CodeCache（代码缓存）— 文章大纲

> vol-03 · 域 18 · 🔴 A | 拓扑排序 #18
> 依赖：OS（内存分配）+ OOPs（Method 元数据）
>
> **→ 从 SymbolTable**：类名和字段名被 StringTable 内部化了——但加载一个类时生成的机器码存哪？不是在 GC 堆里——CodeCache 是 JVM 代码版的堆，有自己的三段式存储和生命周期管理。

## 叙事计划

**开篇场景**：JIT 编译了一个方法——字节码变成了机器码。但生成的机器码放哪？不能放栈上（方法返回就没），不能放 GC 堆（代码不回收）。JVM 用 `CodeCache`——一块从 OS `reserve` + `commit` 的独立内存区域，存所有 JIT 编译后的代码、解释器的 stub、运行时的 adapter。

**第一层：CodeCache——三段式代码存储**

`CodeCache::initialize()`（`codeCache.cpp:1115`）管理三种 `CodeBlobType`（`codeBlob.hpp:38-45`）：`MethodNonProfiled`（C1 无 profiling + native 方法）、`MethodProfiled`（C1 profiled + C2 编译代码）、`NonNMethod`（stubs / buffer blobs / adapter）。分段的意义：stubs 和编译方法混在一起会导致 stubs 被意外扫出——分段后 JVM 对每段独立控制 flush 策略。

内存从 `os::reserve_memory()` 分配——和堆一样的 reserve/commit 机制。大小由 `ReservedCodeCacheSize` 控制（平台相关默认，`globals.hpp:1949`），超出触发 `"CodeCache is full. Compiler has been disabled."`。

**第二层：CodeBlob——代码块的类型体系**

`CodeBlob` 是 CodeCache 中每个代码块的类型标记：`nmethod`（编译后的 Java 方法——最大类）、`RuntimeStub`（运行时桩——异常处理、deopt）、`BufferBlob`（临时代码缓存——编译器生成中间代码）、`AdapterBlob`（解释器↔编译代码适配器）、`SafepointBlob`（safepoint 控制代码）。

每种 Blob 有不同的生命周期和大小——`nmethod` 最大（完整编译方法体），`BufferBlob` 最小（临时分配用完就释放）。

**第三层：nmethod——编译后的 Java 方法**

`nmethod`（`code/nmethod.hpp`，2976 行 `.cpp`）是 CodeCache 中最重要的 Blob。包含：编译后的机器码（`code_begin()`→`code_end()`）、异常处理器表（`exception_begin()`）、元数据（`method()` 返回编译前 Method，`scopes_pcs_begin()` 返回 deoptimization 信息）、`_osr_link` 链。

编译完成后 `nmethod::_state`（`nmethod.hpp:128`）经历五个状态：`not_installed` → `in_use`（正常执行）→ `not_entrant`（新版本替代，禁止新调用）→ `zombie`（所有活跃调用已退出）→ `unloaded`（类被卸载，永久删除）。`make_not_entrant()` 标记为不可进入——旧版本方法调用时被新版本替代。`flush()` 回收 zombie nmethod 的空间。

**第四层：代码老化与刷新**

`CodeCache::do_unloading()` 在 GC 后进行——检查每个 nmethod 的 `is_unloading()`：如果方法对应的 Klass 被卸载（类被卸载了），nmethod 标记为 zombie → flush。`NMethodSweeper` 周期扫描 CodeCache，flush 僵尸 nmethod。`_flushed_nmethods` 计数器被 `jstat -printcompilation` 使用。

**设计权衡**

一、分段 vs 统一 CodeCache。分段允许独立控制 flush 策略（stubs 永不 flush，profiled 代码优先 flush）。代价是三段边界不可流动——一段满了另一段还有空间也没法借用。

二、nmethod 生命周期 vs 直接 delete。nmethod 的多状态（alive → not_entrant → zombie → flush）允许安全替换——旧代码逐步过渡，不在执行中的代码被替换。代价是 zombie 状态占用 CodeCache 空间直到 sweeper 来收。

## 核心悬念

**JIT 生成的机器码存哪——不是在栈上、不丢 GC 堆里，是一块专用的 CodeCache，用三段式存储管理、nmethod 多状态生命周期、sweeper 垃圾回收——就是代码版的 GC。**

## 预估

1 篇，4 层递进，预估 2000-2500 行。

**→ 下一域**：CodeCache 是编译代码的"堆"——管理分配、回收、碎片。但堆里放的代码自己也需要一些预生成的"桩代码"——解释器到编译代码的转换、monitor enter/exit 的快速通道。StubRoutines 篇见。
