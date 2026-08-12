# 01. 机器码的家 — CodeBlob 与 CodeHeap

> **前置依赖**:[02-assembler/04 — MacroAssembler 运行时](openjdk/vol-02/02-assembler/04-x86-macroassembler-runtime.md):编译期把机器码写进 CodeBuffer;[06-oops/04 — 常量池与解析](openjdk/vol-02/06-oops/04-constantpool-method.md):方法编译后要找个地方住
> → **后续**:[02 — nmethod 结构](02-nmethod-structure.md)
> 关联域: 13-jit(编译产物落地)、23-stub(桩也是 CodeBlob)

## 编译完的机器码住哪

C1/C2 把方法编译成机器码之后,JVM 不是随便找块内存放下——机器码进 **CodeCache**: 一块预留的、可执行的内存区,按代码类型分成若干段(非方法桩、带画像的编译方法、不带画像的编译方法)。这篇拆这个"家": 编译期的临时工地 CodeBuffer 怎么变成正式的 CodeBlob、CodeBlob 家族有哪几类、以及 CodeHeap 怎么分段与分配。

## 1. CodeBuffer: 编译期的临时工地

编译器写机器码时不直接碰 CodeCache——先写进临时的 `CodeBuffer`,它把内容分成三段(codeBuffer.hpp:353-361,逐字):

```cpp
// codeBuffer.hpp:353-361(截取核心,逐字)
  enum {
    // Here is the list of all possible sections.  The order reflects
    // the final layout.
    SECT_FIRST = 0,
    SECT_CONSTS = SECT_FIRST, // Non-instruction data:  Floats, jump tables, etc.
    SECT_INSTS,               // Executable instructions.
    SECT_STUBS,               // Outbound trampolines for supporting call sites.
    SECT_LIMIT, SECT_NONE = -1
  };
```

- **CONSTS**(0): 非指令数据——浮点常量、跳转表;
- **INSTS**(1): 指令本体;
- **STUBS**(2): 出站桩——远距离调用的跳板。

每段由 `CodeBuffer::Section` 管理(codeBuffer.hpp:86-92): `_start`/`_end`/`_limit`(内容起止与上限)+ `_locs_start`/`_locs_end`(该段的重定位信息)。分段的理由: 三类内容的**最终地址要统一计算**——布局时按"常量在前、指令居中、桩最后"排,桩的地址在一切确定后才回填(跳板地址依赖前两段的最终大小)。

**关键设计 (斜体)**: *编译期用独立的临时缓冲区,成品才进 CodeCache——编译过程可以随时失败、丢弃、重来,不污染共享的代码区;CodeBuffer 本身可以 expand(不够大时扩大),成品 CodeBlob 一旦提交就是固定的。*

## 2. 从 CodeBuffer 到 CodeBlob: 布局与提交

### 2.1 布局: 四区

CodeBuffer 定稿后,`CodeBlobLayout`(codeBlob.hpp:248)算出最终边界: 头部(header)+ 重定位表 + 内容(consts+insts+stubs)+ 数据区(oops/metadata/scopes)。`CodeBlob::allocation_size(CodeBuffer*, header_size)`(codeBlob.hpp:121)给出总大小,内容区按 `CodeEntryAlignment`(x86 为 32,globals_x86.hpp:49)对齐——方法入口落在 32 字节边界上。

### 2.2 提交: 半成品不可见

真正落地的两步在 CodeCache 上(codeCache.cpp:482 起):

- `CodeCache::allocate(size, code_blob_type)`(:482): 按类型找对应的 CodeHeap → `heap->allocate(size)` 拿到内存 → 在内存上构造 CodeBlob 对象;堆不够先 `expand_by` 扩容,再不行就走**降级路径**——非方法桩可以放进非画像堆(注释 :510-512 "Fallback solution: Try to store code in another code heap")。
- `CodeCache::commit(cb)`(:588): **内容全部填完之后**才调——此后 blob 对其他线程可见。

**关键设计 (斜体)**: *allocate 与 commit 分离,是"发布"语义: 构造/填充阶段别的线程(比如正在扫 CodeCache 的 GC)即使看到这个 blob 也当它不存在;commit 之后才进入可遍历、可执行的状态。半构造的代码绝不泄漏给世界。*

## 3. CodeBlob: 五种身份,两类寿命

### 3.1 类型枚举

CodeCache 里的东西按用途分五类(codeBlob.hpp:40-44,逐字):

```cpp
// codeBlob.hpp:38-46(截取核心,逐字)
struct CodeBlobType {
  enum {
    MethodNonProfiled   = 0,    // Execution level 1 and 4 (non-profiled) nmethods (including native nmethods)
    MethodProfiled      = 1,    // Execution level 2 and 3 (profiled) nmethods
    NonNMethod          = 2,    // Non-nmethods like Buffers, Adapters and Runtime Stubs
    All                 = 3,    // All types (No code cache segmentation)
    AOT                 = 4,    // AOT methods
  };
```

编译级别映射到类型(`get_code_blob_type`,codeCache.hpp:260-273): 无画像的级别(none/simple/full_optimization)→ MethodNonProfiled;带画像的级别(limited_profile/full_profile)→ MethodProfiled。AOT 方法特殊——**不在 CodeCache 里**,在 C 堆(codeBlob.hpp:54-56 注释)。

### 3.2 层次: 运行时代码 vs 编译方法

CodeBlob 家族两棵子树(codeBlob.hpp:340 起):

- **RuntimeBlob**(:340)——运行时代码,`is_alive()` 恒真,永不回收: BufferBlob(:383,含 AdapterBlob :424/VtableBlob :437)、RuntimeStub(:468,代码↔VM 的桥)、SingletonBlob(:517,含 DeoptimizationBlob :554/UncommonTrapBlob :642/ExceptionBlob :672/SafepointBlob :703);
- **CompiledMethod**——编译的 Java 方法,有生命周期(扫除器 sweeper 管理),它的具体形态 nmethod 是下一篇的主角。

**关键设计 (斜体)**: *两类寿命的划分是"基础设施 vs 产品": 解释器入口、safepoint 桩、异常处理代码是 JVM 的地基,创建一次用到退出;编译方法是"产品",热度没了就要回收。回收代码和回收堆一样需要纪律——所以只有编译方法走生命周期管理。*

### 3.3 布局字段

CodeBlob 的核心边界(codeBlob.hpp:103-107,截取核心,逐字):

```cpp
// codeBlob.hpp:103-107(截取核心,逐字)
  address    _code_begin;
  address    _code_end;
  ...
  address    _data_end;
```

`code_begin`/`code_end` 界定指令区,`data_end` 是整个 blob 的末尾;`header_begin` 就是对象自身地址(:154)。反查("这个 pc 属于哪个 blob")是 CodeCache 最频繁的操作之一: `CodeCache::find_blob` → `CodeHeap::find_blob_unsafe` → `find_start`(heap.cpp:486)——**地址右移段大小直接算出段号**,沿段映射定位块头,不用遍历、不用二分。

## 4. CodeHeap: 分段与分配

### 4.1 什么时候分段

默认分段开关: **分层编译开启且 ReservedCodeCacheSize ≥ 240MB**(codeCache.hpp:61-66 注释原文 "segmentation is turned on if TieredCompilation is enabled and ReservedCodeCacheSize >= 240 MB")。小配置下所有代码共用一个堆。分段后是三个 CodeHeap: 非方法堆、画像方法堆、非画像方法堆——`NonNMethodCodeHeapSize` 的 x86 默认是 **32MB**(globals.hpp:92),不是随便划的: 桩和适配器由编译器动态生成,分配不可预测,给它独立空间避免挤占编译方法。

### 4.2 分配: 空闲链表 + 顺序后备

`CodeHeap` 底层是一块 `VirtualSpace`(heap.hpp:84)——预留虚拟地址空间、按页粒度提交(预留空间本身按页对齐,`ReservedSpace::page_align_size_up`,virtualspace.cpp:256)。块分配(heap.cpp:285 起):

- 需求换算成段数(`size_to_segments(instance_size + header_size())`);
- 先查空闲链表 `search_freelist`(:291)——按大小找合适块;
- miss 就从已提交区的末尾顺序切(`_next_segment`,:310 附近),靠**段映射表**(segmap)记录每段归属;
- 释放 `deallocate`(:369): 块标记归还空闲链表(`add_to_freelist`,:380),相邻块合并防碎片。

**关键设计 (斜体)**: *CodeCache 是"可执行内存",比堆更稀缺——不能像堆那样轻易搬移(代码重定位代价高),所以用"预留 + 按需提交 + 段级管理"控制实际占用;扫除器(sweeper)回收死方法后,块回到链表被复用,这就是代码区的 malloc。*

## 核心悬念

机器码的家到齐: CodeBuffer 三段的临时工地、CodeBlobLayout 的四区布局、allocate/commit 两段发布、五类身份与两类寿命、CodeHeap 的分段与段级分配。但到目前为止,"编译方法"还是个黑盒——它除了机器码还装着什么?oops 表、重定位信息、作用域描述、异常处理——下一篇: nmethod 结构——一段编译后的方法里到底装着什么。

> → [02-nmethod-structure.md](02-nmethod-structure.md)
