# 01. 编译好的机器码放在哪？— CodeBlob 层次与 CodeHeap

> 🔴 Deep | 5 KP 中的入口机制
> 读者处境: JVM 刚编译完一个方法——它要把机器码存在哪里？为什么一个"缓存"需要分成不同类型的堆？
>
> ⚠️ 写作期修正(2026-08-12, vol-02/16-code-cache/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **codeBuffer.hpp 在 share/asm/ 不在 share/code/**: section 枚举在 :353-361(SECT_FIRST=0,CONSTS=0/INSTS/STUBS,顺序即最终布局,compute_final_layout codeBuffer.cpp:472 按枚举序紧凑排);Section 类字段 _start/_end/_limit/_locs_start/_locs_end 在 :86-92(非 :200-230)
> - **NonNMethodCodeHeapSize x86 默认 32M**(globals.hpp:92 define_pd_global 32*M),非"~5MB"
> - **CodeCache::allocate 在 codeCache.cpp:482**(非 :181-210): get_code_heap→heap->allocate(:497)→失败 expand_by→再失败降级路径(注释 :510-512 "NonNMethod -> MethodNonProfiled -> MethodProfiled");commit 在 :588
> - **find_blob 反查不是二分**: CodeHeap::find_blob_unsafe→find_start(heap.cpp:486)= 地址右移段大小算段号,沿段映射定位
> - CodeBlobType(:40-44,struct 含 NumTypes=5)✓、层次(RuntimeBlob :340/BufferBlob :383/AdapterBlob :424/VtableBlob :437/RuntimeStub :468/SingletonBlob :517/各单例 blob :554-703)✓、get_code_blob_type(codeCache.hpp:260-273)✓、SegmentedCodeCache 条件(:61-66 注释)✓、CodeHeap 在 share/memory/heap.hpp:81 ✓、VirtualSpace 页对齐=ReservedSpace::page_align_size_up(virtualspace.cpp:256)✓、CodeEntryAlignment=32(globals_x86.hpp:49)✓

### 1. "我从哪来？" — CodeBuffer 到 CodeBlob 的转译

场景: C1/C2 刚完成一个方法的编译——CodeBuffer 里装满了 insts/stubs/consts 三段数据。现在要把它变成 CodeBlob 存进 CodeCache。

**CodeBuffer 的三段抽象** (`codeBuffer.hpp:167-185`):
- `SECT_CONSTS` (0): 常量段 — 地址池、浮点常量、Symbol 引用
- `SECT_INSTS` (1): 指令段 — x86 机器码（mov/call/jmp/cmp...）
- `SECT_STUBS` (2): 桩段 — 尾调用桩、deopt 桩、异常桩
- 每个 section 有 `align_offset()` + `total_content_size()` — 决定了 CodeBlob 的最终布局
- 源码: `codeBuffer.hpp:200-230` Section 类 — `_start/_end/_limit/_locs_start/_locs_end` + `expandable/contains/size`
- [C++: CodeBuffer 的 section 用 `GrowableArray<label>` 追踪 label offsets → `finalize_stubs()` 给桩分配最后地址 → `compute_alignment()` 确保各段对齐到 oopSize ]

**CodeBuffer → allocation_size → CodeBlob Layout** (`codeBlob.hpp:249-322`):
- `allocation_size(cb, header_size)`: header + reloc + content + data — 四区总大小
- `CodeBlobLayout`: 计算各边界地址 — header_begin/code_begin/code_end/data_end
- 源码: `codeBlob.hpp:265-322` CodeBlobLayout 两个构造 — 手动(reverse engineer) vs CodeBuffer(forward compute)
- [C++: `align_code_offset()` — 代码区必须对齐到 CodeEntryAlignment (典型 32 bytes) — 因为 x86 的分支预测/缓存行对齐]
- [x86: CodeEntryAlignment=32 → 每个 nmethod 入口对齐到 32-byte 边界 → L1 icache 的 32-byte cache line 友好 → 减少 HSD(processor front end) 的 BTB miss]

**CodeCache::allocate + commit** (`codeCache.hpp:145-146`):
- allocate: 找对应 CodeHeap，预留空间，构造 CodeBlob
- commit: 填充内容后确认——之后可被其他线程看到
- 源码: `codeCache.cpp:181-210` allocate → get_code_heap(type)→heap->allocate(size)→构造 CodeBlob
- 关键设计: allocate 不 commit——先构造 CodeBlob 对象→内容填入完成→再 commit——防止其他线程看到半构造的代码

### 2. "我有五种身份" — CodeBlob 的类型层次

场景: CodeCache 里不只有编译方法——还有 interpreter 代码、GC safepoint 桩、deopt 桩。它们都是 CodeBlob。

**CodeBlobType 五分类** (`codeBlob.hpp:38-47`):
```
MethodNonProfiled = 0    // C1 full(C0 lv1) + C2(lv4) + native methods
MethodProfiled    = 1    // C1 profiled(lv2-3) — profiling data
NonNMethod        = 2    // stubs/adapters/buffers — 不包含 Java method
All               = 3    // 分段关闭时统一 Heap
AOT               = 4    // AOT 编译 — 不在常规 CodeHeap(C-Heap)
```
- 源码: `codeBlob.hpp:38-47` enum
- 为什么分？: Profiled nmethod 更大(多 profiling data 段)，NonProfiled 更小但要更精细的优化。分开后各 Heap 不互相挤压
- [C++: 编译级别映射: 见 `codeCache.hpp:260-273` get_code_blob_type(comp_level)—CompLevel_none/simple/full_optimization → NonProfiled, limited_profile/full_profile → Profiled]

**CodeBlob 层次体系** (`codeBlob.hpp:49-68`):
```
CodeBlob (abstract base)
├── RuntimeBlob — 运行时代码(非编译)
│   ├── BufferBlob → AdapterBlob(C2I/I2C 适配器)
│   │              → VtableBlob(虚表分派)
│   │              → MethodHandlesAdapterBlob
│   ├── RuntimeStub — 运行时调用桩(code→VM C++ 桥)
│   └── SingletonBlob → DeoptimizationBlob(逆优化)
│                      → UncommonTrapBlob(C2 罕见路径)
│                      → ExceptionBlob(C2 异常展开)
│                      → SafepointBlob(安全点 illega 指令)
└── CompiledMethod — 编译方法(含 Method* 指针)
    └── nmethod — JIT 编译产物(含 8 个数据段)
```
- 关键设计: RuntimeBlob 的 is_alive() 始终返回 true——永不回收(interpreter/safepoint stub 只在 VM 退出时释放)。nmethod 则有生命周期(sweeper)

**CodeBlob 内存布局** (`codeBlob.hpp:84-116`):
```
[header(padding+oop_maps+strings)] [relocation] [content=consts+insts+stubs] [data=oops+metadata+scopes]
```
- `_code_begin`: 指令段起始
- `_data_end`: 整个 blob 结束
- `_content_begin`: const+inst+stub 起始(用于 contains 查询)
- `_relocation_begin/end`: 重定位表边界(GC 需要遍历)

### 3. "我们分家" — CodeHeap 的分段管理

场景: 240MB+ CodeCache 且 TieredCompilation 开启 → 三个独立 Heap。但小内存配置下所有代码共用一块 Heap。

**SegmentedCodeCache 条件** (`codeCache.hpp:61-64`):
- TieredCompilation + ReservedCodeCacheSize ≥ 240MB → 默认开启 SegmentedCodeCache
- 源码: `codeCache.cpp:117-125` 初始化 — check_heap_sizes→reserve_heap_memory→add_heap×3

**三个 Heap 的分配** (`codeCache.hpp:42-53`):
```
NonNMethod Heap    →  stubs/adapters/buffers (size: ~5MB)
Profiled Heap      →  C1 profiled nmethods (level 2-3) 
NonProfiled Heap   →  C1 full/C2/native nmethods (level 1/4)
```
- 关键设计: NonNMethod Heap 满时 fallback 到 NonProfiled Heap(`codeCache.cpp:106` 注释)——因为 stubs/adapters 的分配是不可预测的（编译器动态生成）
- 用户控制: `-XX:ProfiledCodeHeapSize` / `-XX:NonProfiledCodeHeapSize` / `-XX:ReservedCodeCacheSize`

**CodeHeap 底层 VirtualSpace** (`heap.hpp`):
- VirtualSpace 预留虚拟地址空间 → committed 实际分配
- 原理同 Metaspace chunk 管理(域 10)
- `CodeHeap::allocate(int size)`: 从 FreeList 找合适块→切分→返回地址
- `CodeHeap::deallocate(void* p)`: 归还到 FreeList→相邻块合并→防碎片
- [C++: VirtualSpace 的 commit 粒度是 os::vm_page_size() (4K on x86_64)。CodeHeap 内部用 FreeBlockList 管理空闲块——类似 malloc 的 buddy allocator]

**CodeCache 静态 API 全览** (`codeCache.hpp:78-317`):
- 分配: allocate/commit/free
- 查找: find_blob/find_nmethod(按 pc 地址反查)
- 迭代: first_blob/next_blob + CodeBlobIterator (NMethodFilter/CompiledMethodFilter)
- GC: gc_prologue/gc_epilogue/do_unloading/scavenge_root_nmethods_do
- Flush: flush_dependents_on/mark_all_nmethods_for_deoptimization
- 统计: capacity/unallocated_capacity/blob_count/nmethod_count
- 日志: print_summary/aggregate_detailed/CodeHeap State Analytics

---

### 核心悬念

**"一个方法编译完后，JVM 把它放到一个分段的内存区域中——不同类型的代码存放在不同的 Heap 里，避免互相挤压。"** — CodeBlob 是容器基础，但真正的核心数据是 nmethod——下一篇: 一段编译后的方法里到底装着什么？

> → [02-nmethod-structure.md](02-nmethod-structure.md)
