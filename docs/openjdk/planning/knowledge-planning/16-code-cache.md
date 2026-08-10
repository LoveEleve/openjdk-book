# 域 16: Code Cache — 知识规划

> 源码路径: hotspot/share/code/ + hotspot/share/asm/codeBuffer + hotspot/cpu/x86/
> 源码量: 62 文件 / ~28,000 行 | 🟡 大域（近巨型域阈值）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| codeBlob.hpp + codeBlob.cpp | **CodeBlob — 所有代码实体的基类**: 按 CodeBlobType 分 5 类，包含 layout(header+reloc+content+data)、frame_complete_offset、边界查询(blob_contains/code_contains)。层次: RuntimeBlob→BufferBlob(Adapter/Vtable/MethodHandles)/RuntimeStub/SingletonBlob(Deopt/UncommonTrap/Exception/Safepoint); CompiledMethod→nmethod | High |
| codeCache.hpp + codeCache.cpp | **CodeCache — 全局代码缓存管理器**: 多 CodeHeap 按 BlobType 分段(NonNMethod/MethodProfiled/MethodNonProfiled/All)，SegmentedCodeCache 条件启用(≥240MB+Tiered)，分配/查找/迭代/GC/Flush/deopt 全生命周期 | High |
| nmethod.hpp + nmethod.cpp | **nmethod — JIT 编译方法**: entry_point/verified_entry/osr_entry 三入口，state machine(not_installed→in_use→not_entrant→zombie→unloaded)，内含 consts/stubs/oops/metadata/scopes/pcs/dependencies/handler_table/nul_chk_table 8 个段，hotness_counter 驱动 sweeper 淘汰决策 | High |
| compiledMethod.hpp + compiledMethod.cpp | **CompiledMethod — 编译方法抽象层**: nmethod 的父类，flag bits(in_use/not_entrant/zombie/unloaded)，method() 回指 Method*，CompiledStaticCall 支持 | High |
| relocInfo.hpp + relocInfo.cpp | **relocInfo — 压缩重定位信息**: 16-bit 编码(4bit type+12bit offset delta)，类型: oop/IC/runtime_call/internal_word/external_word，RelocIterator 遍历，值在 GC 或 CodeHeap compact 时更新 | High |
| compiledIC.hpp + compiledIC.cpp | **CompiledIC — 编译后 Inline Cache**: 状态机 Clean→Interpreted→Monomorphic→Megamorphic，MT-safe 过渡用 ICStub/InlineCacheBuffer，cached_value 为 NULL/Klass*/CompiledICHolder* | High |
| icBuffer.hpp + icBuffer.cpp | **InlineCacheBuffer — IC 补丁安全缓冲区**: 异步 IC transition(非 safepoint)时先写入 buffer 再原子切换，避免其他线程看到半改的指令 | High |
| dependencies.hpp + dependencies.cpp | **Dependencies — nmethod 类层次假设**: 类型: unique_concrete_method/abstract_with_unique_concrete_subtype/no_finalizable_subclasses/evol_declared_methods 等 ~10 种，DepChange/KlassDepChange/CallSiteDepChange 触发，依赖失效→nmethod deopt | High |
| dependencyContext.hpp + dependencyContext.cpp | **DependencyContext — per-nmethod 依赖上下文**: nmethod 到 Dependencies 的关联，perf 计数器(nmethod_dep_total_checked/dep_broken/dep_failed)，批量 dep 检查 | Medium |
| codeBuffer.hpp + codeBuffer.cpp | **CodeBuffer — 代码生成缓冲器**: 4 段(consts/insts/stubs/oop_recorder)，section 抽象(offset/location/capacity)，SECT_STUBS/SECT_CONSTS/SECT_INSTS 三区，finalize_stubs→allocation_size→CodeBlob | High |
| nativeInst.hpp + nativeInst_x86.hpp + nativeInst_x86.cpp | **NativeInstruction — x86 指令包装器**: NativeCall(5-byte call+return addr)/NativeMovConstReg(mov reg,imm64 常量加载)/NativeMovRegMem(mov 内存转换)/NativeJump(5-byte unconditional jmp)/NativeIllegalInstruction | High |
| vtableStubs.hpp + vtableStubs.cpp + vtableStubs_x86_64.cpp | **VtableStubs — 虚方法分发桩**: itable/vtable stub，Number/Name 序列号，Monomorphic inline cache 替换，x86_64 mov rax,[receiver+klass_offset]+call [rax+itable_offset] | High |
| debugInfo.hpp + debugInfo.cpp + debugInfoRec.hpp + debugInfoRec.cpp | **DebugInformationRecorder — JIT 调试数据**: OopRecorder(嵌入 oop 表)+ScopeValue(Location/ConstantOopWriteValue)，为 scopeDesc 生成数据，OopMap recording | High |
| scopeDesc.hpp + scopeDesc.cpp + pcDesc.hpp + pcDesc.cpp | **ScopeDesc/PcDesc — 栈帧反推**: pc offset→Scope(bci+method+objects/locals)，PcDesc(PC→scope mapping)，deopt 时从 PC 还原 Java 栈帧 | High |
| location.hpp + location.cpp | **Location — 值存储位置**: 寄存器/栈偏移/常量，类型(normal/oop/narrow_oop)，在 deopt 栈帧重建时解码 | Medium |
| compressedStream.hpp + compressedStream.cpp | **CompressedWriteStream/CompressedReadStream — 压缩数据流**: 变长 LEB128 编码，dependencies/scopes/pcs 压缩存储 | Medium |
| oopRecorder.hpp + oopRecorder.cpp | **OopRecorder — 编译时 oop 索引**: 编译时遇到的 oop→索引→nmethod oops 表，GC reloc update 时用 | Medium |
| exceptionHandlerTable.hpp + exceptionHandlerTable.cpp | **ExceptionHandlerTable/ImplicitExceptionTable**: 异常表(bci 范围→handler pc)，隐式空指针表(pc→continuation)，nmethod 内嵌 | Medium |
| vmreg.hpp + vmreg.hpp + vmreg_x86.hpp + vmreg_x86.cpp | **VMReg — 虚拟机寄存器编号**: 统一编号(整数/浮点寄存器分离)，x86 映射(rsp/rbp/rax→VMReg)，用于 OopMap 和栈帧描述 | Medium |
| codeHeapState.hpp + codeHeapState.cpp | **CodeHeap State Analytics**: CodeHeap 使用统计(blob 数/大小/年龄分布/碎片率)，aggregate/discard，CompileBroker 调用，DCmd 输出 | Medium |
| stubs.hpp + stubs.cpp | **StubQueue — 桩队列**: stub 分配/释放/迭代，预分配空间，线程安全 | Low |

*21 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| nmethod 生命周期 (state machine+sweeper+GC) | nmethod.*, compiledMethod.*, codeCache.*, dependencies.*, compiledIC.*, icBuffer.* |
| CodeBlob 层次 + CodeHeap 分段管理 | codeBlob.*, codeCache.*, codeHeapState.*, stubs.*, codeBuffer.* |
| Relocation 系统 (relocInfo+oopRecorder) | relocInfo.*, oopRecorder.*, codeBuffer.*, compiledIC.*, nativeInst.*, debugInfoRec.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| CompiledIC + ICBuffer | compiledIC.*, icBuffer.*, nativeInst_x86.* |
| Dependencies 系统 | dependencies.*, dependencyContext.*, nmethod.*, compiledIC.* |
| DebugInfo 体系 (scopeDesc/pcDesc/location) | debugInfoRec.*, scopeDesc.*, pcDesc.*, location.* |
| NativeInst x86 平台层 | nativeInst.*, nativeInst_x86.*, compiledIC_x86.*, relocInfo_x86.* |
| CodeBuffer + section 抽象 | codeBuffer.*, oopRecorder.*, codeBlob.* |
| VtableStubs 虚方法分发 | vtableStubs.*, vtableStubs_x86_64.*, compiledIC.* |
| Exception Handling | exceptionHandlerTable.*, nmethod.* |

### P3 — 孤立 (1-2 文件)
| KP | 文件 |
|----|------|
| compressedStream | compressedStream.* |
| VMReg 寄存器编号 | vmreg.*, vmreg_x86.* |
| CodeHeap State Analytics | codeHeapState.* |
| StubQueue | stubs.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (6 KP)
| KP | 为什么 🔴 |
|----|---------|
| nmethod 状态机 | 5 状态(C++ enum: not_installed→in_use→not_entrant→zombie→unloaded)——JVM 编译代码生命周期的唯一真相源。每个状态转换都有并发协议(CodeCache_lock/Patching_lock)，zombie→unloaded 依赖 sweeper 的 stack_traversal_mark 确保无活跃栈帧 |
| CodeCache 分段 Heap 设计 | SegmentedCodeCache 将 NonNMethod/Profiled/NonProfiled 分入独立 CodeHeap——防止编译器 stub 耗尽空间导致 nmethod 无法分配。条件: TieredCompilation + ≥240MB ReservedCodeCacheSize。fallback: NonNMethod 满可借用 NonProfiled heap |
| CompiledIC 状态机 + MT-safe 补丁 | 4 状态(Clean/Monomorphic/Megamorphic/Interpreted)——IC transition 的非原子本质要求 ICBuffer 中间缓冲。先写 stub buffer→cmpxchg 切换→旧 stub 废。并发线程看到 Clean 就查 debug info 找 receiver |
| Dependencies 类层次假设系统 | ~10 种 dep 类型——unique_concrete_method(单实现虚拟方法静态绑定)/abstract_with_unique_concrete_subtype/no_finalizable_subclasses/concrete_with_no_concrete_subtype→C2 激进内联依赖。dep 失效→DepChange→nmethod::make_not_entrant→重新编译 |
| CodeBuffer 段抽象 → CodeBlob 布局 | 编译时的 CodeBuffer(insts/stubs/consts section)→计算 allocation_size→CodeBlob Layout(header+reloc+content+data)→CodeCache::allocate→commit。constant pool 重排/stub 尾调用需要 section 间偏移计算 |
| relocInfo 16-bit 压缩编码 | 16 bits = 4 bit type + 12 bit offset delta。oop/IC/runtime_call/internal_word/external_word 5 大类→GC 时遍历更新 embedded oop/IC 状态/runtime call 地址。压缩是因为每个 nmethod 的 relocation entry 数量可达编译代码大小的 10-15% |

### 🟡 Working — 有设计但非核心 (7 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| ScopeDesc/PcDesc 栈帧反推 | deopt 时从 PC 反推 Java scope——scopeDesc 链 = 内联树 [bci→method→locals→monitors]，pcDesc 实现 pc→scope 映射 | 栈帧反推是 deopt 的支撑机制——理解 deopt 必须懂，但它本身是"数据格式+查找"而非独立设计决策。🔴的 Dependencies 才决定 *什么时候* deopt |
| OopRecorder + CompressedStream 编码 | 编译时 oop→index→压缩流→nmethod oops/scope 表。GC 遍历 reloc 更新 embedded oop | LEB128 压缩是通用编码方案——类似 Protobuf varint——不是 JVM 特有设计。🟡 因为写作时需讲但不需要花整节 |
| NativeInst x86 平台层 | call/jump/mov/cmp 等 x86 指令的 C++ wrapper——NativeCall(nmethod IC 在 x86 上是 5-byte call+link)+NativeMovConstReg(64-bit immediate load)+NativeJump(5-byte unconditional)——地址→指令操作→更新 call target | 平台层适配代码——x86 细节按需讲（在 reloc/IC 文章中嵌入），不需要独立一篇文章 |
| VtableStubs 虚方法分发 | Klass::vtable+itable stub——itable stub 在线程本地每 pair(klass+itable_index)首次查表→mega stub 分发优化 | vtable 查找发生在 Interpreter→Compiled 的边界——属于 CodeCache 但与域17-19(Sync/VMOps/SharedRuntime)的交互更紧。𖦹因需跨域讲但非 🔴 |
| DebugInformationRecorder | JIT 编译时收集 debug info——找到解释器 frame→重建 deopt 后的栈帧。记录 pcs/scopes/oops/monitors | 是 deopt 管线的一部分——原理重要但不决定 CodeCache 架构。scopeDesc/pcDesc 的编码格式是非核心 |
| ExceptionHandlerTable | bci 到 handler pc 映射——发生在 nmethod 中而不是解释栈帧，隐式 null check 表: pc→continuation(throw NullPointerException 还是继续) | 异常处理是编译代码的标准能力——和 JIT 的关系比和 CodeCache 更紧。🟡 因为写作时需讲但不占主要篇幅 |
| CodeHeap State Analytics | 统计 nmethod 分布——blob 数/平均大小/年龄四分位数/free block 碎片→CompileBroker 根据 code heap full 事件决定停止编译 | 运维工具——不是运行时正确性所需——但对生产排查重要。🟡 因为使用者(SRE/性能工程师)需要但不决定设计

### 🟢 Surface — 了解即可 (8 KP)
| KP | 说明 |
|----|------|
| VMReg 寄存器编号 | 统一的虚拟寄存器编号系统—x86 rsp=0, rbp=5, rax=6 |
| Location 值存储位置 | deopt 时重建 local 的位置编码 |
| ICBuffer 补丁缓冲 | MT-safe IC transition 的临时 stubs |
| StubQueue 通用桩队列 | 预分配空间+迭代=CodeBlob 的另一种组织方式 |
| CodeHeap 底层 Memory Heap | VirtualSpace + FreeBlockList = 类似 Metaspace 的 chunk 管理 |
| DependencyContext | per-nmethod dep 跟踪+perf counter |
| codeBlob hierachy types | BufferBlob/AdapterBlob/VtableBlob/MethodHandlesAdapterBlob 等 10+ 种 RuntimeBlob 子类型 |
| compressedStream LEB128 | 变长编码压缩 relocation/scope data |

## 04 聚类 — 依赖图+教学顺序+文章拆分

### 依赖图
```
                CodeBuffer (代码生成)
                     ↓
                CodeBlob Layout
                     ↓
          ┌──────────┼──────────┐
    BufferBlob        CompiledMethod
    (stubs/adapters)    (nmethod)
                     ↓
       relocInfo → compiledIC → dependencies
                     ↓
       scopeDesc → pcDesc → debugInfo
```

### 教学顺序

**基础 → 容器 → 内容 → 自描述 → 生命周期**:
1. 先建立"编译代码需要一个容器"的认知(CodeBuffer→CodeBlob→CodeHeap)
2. 再理解 nmethod 的具体结构和状态机
3. 然后看代码如何自描述(relocation)
4. 接着看优化依赖和 IC 系统
5. 最后收束到 sweeper 和全局分析

### 文章拆分: 5 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | CodeBlob 层次与 CodeHeap | CodeBlob层次, CodeBlobType分级, CodeHeap分段, CodeCache::allocate/commit, CodeBuffer→CodeBlob 转译 | "编译完成的机器码到底放在了哪里？" | 核心 |
| 2 | nmethod 内部结构 | nmethod 8段布局(consts/stubs/oops/metadata/scopes/pcs/dependencies/handler/nul_chk), entry points(entry/verified/osr), 编译创建(new_nmethod/CodeBuffer→nmethod) | "一段编译后的方法里到底装着什么数据？" | 核心 |
| 3 | nmethod 生命周期与 Sweeper | 5状态转换(not_installed→in_use→not_entrant→zombie→unloaded), sweeper 决策(hotness_counter+stack_traversal_mark), GC 交互(scavenge_root_oops+do_unloading), nmethodLocker | "一段代码什么时候被淘汰？JVM 怎么判断它不再需要了？" | 核心 |
| 4 | Relocation 与 Inline Caches | relocInfo 16-bit 编码, oop/IC/runtime_call/internal_word/external_word 各类, RelocIterator, CompiledIC 状态机(Clean→Mono→Mega), ICBuffer MT-safe补丁, NativeInst x86 wrapper | "GC 移动对象时，编译代码里的指针怎么更新？方法调用怎么从动态变成静态？" | 深度 |
| 5 | 依赖、Deopt 与调试 | Dependencies 10种类型(class hierarchy/single impl/final), DepChange 触发链, DebugInfoRecorder→scopeDesc→pcDesc 栈帧反推, VtableStubs 虚方法分发, CodeHeap State Analytics | "JIT 的乐观优化假设什么时候会破灭？破了怎么自救？" | 深度 |
