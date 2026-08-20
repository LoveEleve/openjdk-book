# 09-memory-core/01-universe-heap 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JVM 在还没有完整 Java 世界时，如何先建立 GC 堆和最小元数据骨架，再分阶段造出第一批类、镜像和规范对象

## 1. 选题判断

现稿已经抓到“先有堆，再有第一批对象”的反直觉顺序，也覆盖了 `universe_init`、`genesis`、`CollectedHeap` 与 `MemAllocator`。但文章仍偏事实并列：时序、创建、预分配对象、分配路径一起铺开，读者容易得到“Universe 就是一堆全局变量 + genesis 全做了”的印象。

真正的读者困惑是：

**JVM 在还没有完整 Java 世界、连 `java.lang.Class` 镜像都没就绪的时候，靠什么把第一批对象和类“生出来”？为什么堆必须先于镜像和系统类出现？`Universe` 到底只是全局仓库，还是整个引导链条的调度台？又为什么 `create_heap()` 和 `_collectedHeap->initialize()` 要严格拆成两步？**

## 2. 一句话顿悟

**`Universe` 不是“存全局单例的袋子”，而是 JVM 启动里的引导台：`universe_init()` 先选 GC、构造并初始化堆与基础元数据设施；`Universe::genesis()` 再在 `_bootstrapping` 模式下按依赖顺序造出最小可运行的类宇宙——先 primitive array klass 和 canonical metadata arrays，再通过 `SystemDictionary` 落地 Object/String/Class，随后补基本类型镜像和延迟 mirror fixup；真正的 Java 世界是分阶段被点亮的，不是一次性同时出现。**

## 3. 总图

```text
init_globals()
  │
  ├─ universe_init()
  │    ├─ GCConfig 已选定 GCArguments
  │    ├─ Universe::create_heap()      -> 构造 CollectedHeap C++ 对象
  │    ├─ CollectedHeap::initialize()  -> reserve/commit/aux structures
  │    ├─ metaspace / CLD / SymbolTable / StringTable / caches
  │    └─ heap substrate ready
  │
  ├─ interpreter_init / stubs / ...
  │
  ├─ universe2_init()
  │    └─ Universe::genesis()
  │         ├─ _bootstrapping = true
  │         ├─ fixup lists + base vtable size
  │         ├─ primitive TypeArrayKlass objects
  │         ├─ canonical metadata arrays
  │         ├─ vmSymbols + SystemDictionary::initialize()
  │         ├─ String/Class offsets, primitive mirrors, mirror fixups
  │         ├─ Object[] klass, sentinel strings
  │         └─ minimal class universe ready
  │
  ├─ javaClasses_init()
  │
  └─ universe_post_init()
       ├─ fully_initialized = true
       ├─ reinitialize vtables/itables
       ├─ canonical empty Class[]
       ├─ preallocated OOME pool
       └─ known methods / late bootstrap objects
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——第一个 Java 对象出生前，JVM 靠什么活着

目标约 1000 字。

- 从“`new Object()` 分配在哪”反推“堆是谁先造出来的”
- 进一步追问：还没有 `java.lang.Class` 镜像时，JVM 怎么加载 `Object`/`String`/`Class`
- 提出反直觉主线：先有堆和元数据设施，再有类宇宙，再有 Java 世界的核心镜像
- 回收前文：javaClasses 的 mirror fixup / basic type mirrors 在这里闭合

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 一次性同时创建堆、类、镜像和对象 → 依赖环无从解开
2. `create_heap()` 一步完成所有虚拟内存与运行时结构 → GC 选择与堆初始化强耦合
3. 把所有 canonical objects 都叫“genesis 造的第一批对象” → 混淆 metaspace metadata arrays、heap objects 和后置预分配异常对象

引出：
- heap substrate
- bootstrap class universe
- post-init canonical objects
三阶段分离。

### 第三节：`init_globals`——Universe 为什么要夹在解释器、stubs 和 javaClasses 之间

目标约 1700 字。

- `init_globals` 顺序：`universe_init` → `gc_barrier_stubs_init` → `interpreter_init` → `generate_stubs` → `universe2_init` → `javaClasses_init`
- `universe_init` 与 `universe2_init` 的职责分离
- 解释器与 SharedRuntime stubs 早于 genesis 的意义
- `javaClasses_init` 晚于 genesis 的原因
- 引出：堆/基础设施先点亮，再有类宇宙，再有 offset contract 完整收敛

### 第四节：`universe_init()`——先把“能承载世界的地基”搭出来

目标约 2000 字（核心拆解层）。

- `compute_hard_coded_offsets()` / metaspace init / CLD / SymbolTable/StringTable / latest method caches 等基础设施
- `Universe::create_heap()` 只做 GC-specific C++ object construction
- `Universe::initialize_heap()` 才调用 `_collectedHeap->initialize()` 并建立虚拟地址空间、压缩 oop 边界、TLAB 支持
- G1 路径：policy + heap object 构造 vs `initialize()` 中 reserve 最大堆、region/bitmap/card table 辅助结构
- GCConfig ergonomics 与显式 `Use*GC`
- 纠偏：G1 是 server-class 默认，不是“JDK 11 永远默认 G1”

### 第五节：`Universe::genesis()`——为什么 primitive array klass 要先于 Object 镜像

目标约 2300 字（核心拆解层）。

- `_bootstrapping` 标志和 `Compile_lock`
- `java_lang_Class::allocate_fixup_lists()`
- `compute_base_vtable_size()` 来自 `Object` vtable 基数
- primitive `TypeArrayKlass::create_klass` × 8 的时序原因
- 这些 klass 在 bootstrapping 期是部分初始化状态：super/vtable 稍后补
- canonical metadata arrays（`Array<Klass*>`/`Array<int>`/`Array<Method*>` 等）
- `vmSymbols::initialize` + `SystemDictionary::initialize`
- 这一节要强调“最早期世界是最小骨架，不是完整 Java 对象世界”

### 第六节：SystemDictionary 初始化、primitive mirrors 与 mirror fixup——类宇宙是怎样被点亮的

目标约 2200 字（核心拆解层）。

- `SystemDictionary::initialize` 先建字典、再 `resolve_well_known_classes`
- `Object`/`String`/`Class` 先加载
- 立刻计算 `String`/`Class` offsets
- `Universe::initialize_basic_type_mirrors`：9 个 primitive mirrors
- `Universe::fixup_mirrors`：为早于 `java.lang.Class` 出生的 klass 补镜像
- 其余 well-known classes 后加载
- `Object[]` klass 与 sentinel strings (`"null"`, `"-2147483648"`)
- 强调：primitive mirrors / fixup list 属于 genesis 中途点亮，不是 `javaClasses_init` 自己创造的

### 第七节：canonical metadata arrays、empty `Class[]` 与 OOME 预分配——为什么“预分配对象”不能混成一类

目标约 1900 字。

- metaspace canonical arrays：`_the_empty_int_array` / `_the_empty_method_array` / `_the_array_interfaces_array` 等
- 它们不是 Java heap 数组，不对应所有 `new int[0]`
- 唯一 canonical heap-side `Class[]` 在 `universe_post_init` 才创建
- 纠偏：不能写成“genesis 预分配所有零长度数组”
- OOME 预分配两层：6 个 no-backtrace defaults + 一组 preallocated OOME with backtrace
- `gen_out_of_memory_error` 的 fallback / backtrace pool 语义
- verifier recursion 的 preallocated `VirtualMachineError` 作为旁例

### 第八节：`CollectedHeap` 与 `MemAllocator`——普通对象分配真正在哪发生

目标约 2200 字。

- `CollectedHeap` 抽象接口：`allocate_new_tlab`、`mem_allocate`、`collect`、`object_iterate`
- `oopFactory` 只是便利层，真正分配/初始化由 `CollectedHeap` + `MemAllocator`
- `MemAllocator::allocate`：TLAB fast path -> slow path -> outside-TLAB
- `allocate_inside_tlab_slow` 的 refill waste heuristic：不一定补新 TLAB，也可能直接 outside-TLAB
- outside-TLAB 进入 collector `mem_allocate`，G1 对 humongous 走特殊路径
- `finish()` 里 mark 先、klass 后的发布顺序
- array/Class allocator 的特殊前置初始化（length / oop_size）

### 第九节：`Universe` 仓库——为什么它像“引导台”，不只是“全局变量表”

目标约 1400 字。

- `_collectedHeap`、primitive array klasses、canonical metadata arrays、mirrors、preallocated exceptions、sentinels
- `Universe::heap()` / `intArrayKlassObj()` / `the_empty_class_klass_array()` / `non_oop_word()` 的不同角色
- `non_oop_word` 不是空对象，不是零数组，而是 compiled IC/metadata 伪空哨兵
- 总结：Universe 的意义在于把前文分散的 bootstrap 依赖收口到一个可按阶段初始化的仓库

### 第十节：误解澄清与收网

目标约 1100 字。

至少回答：

1. `create_heap()` 是否就已经 reserve 了整个 Java heap
2. G1 是否总是默认 GC
3. `genesis` 是否创造了“所有第一批对象”
4. primitive array klass 是否就是“第一个 klass”的绝对答案
5. `_the_empty_int_array` 是否意味着所有 `new int[0]` 复用它
6. `_the_empty_class_klass_array` 与 metaspace empty arrays 是否是一回事
7. `oopFactory` 是否就是对象真正分配器
8. TLAB miss 是否一定会 refill 一个新 TLAB

## 5. 失败方案必须写进正文

1. 一次性同时创建堆、类、镜像和对象
2. `create_heap()` 一步完成所有堆初始化
3. 把所有预分配对象/数组都混叫为“genesis 第一批对象”

## 6. 证据清单

- `init.cpp:101-127`：`init_globals` 顺序
- `universe.cpp:675-750`：`universe_init`
- `universe.cpp:752-825`：`create_heap` / `initialize_heap`
- `gcConfig.cpp:102-184,237-240`：GC ergonomics 与 selected arguments
- `gcArguments.inline.hpp:29-34`：`create_heap_with_policy`
- `g1Arguments.cpp:151-153`：G1 create_heap
- `g1CollectedHeap.cpp:1533-1674`：G1 initialize/reserve/aux structures/expand
- `universe.cpp:321-462`：`genesis`
- `universe.cpp:1115-1117`：base vtable size
- `arrayKlass.cpp:84-95`、`klassVtable.cpp:103-123,186-191`：bootstrapping partial array klass / vtable behavior
- `universe.cpp:354-358`：canonical metadata arrays
- `metadataFactory.hpp:35-40`、`array.hpp:35-58`：metaspace arrays
- `systemDictionary.cpp:1907-2055`：SystemDictionary initialize + well-known classes + String/Class offsets + primitive mirrors
- `universe.cpp:464-534`：basic type mirrors / mirror fixups
- `universe.cpp:397-422`：`_the_null_sentinel` and `Object[]` klass path
- `universe.cpp:1002-1111`：`universe_post_init`, empty `Class[]`, preallocated OOME, late bootstrap
- `universe.hpp:143,154-160,178-183,205-212,522-526`：canonical empty `Class[]`, OOME pools, `_bootstrapping`, `non_oop_word`
- `universe.cpp:600-672`：OOME generation and `non_oop_word`
- `compiledIC.cpp:54-64,112-123`、`relocInfo.cpp:574-615`：`non_oop_word` usage
- `collectedHeap.hpp:140-160,395-447`：heap allocation/collection/iteration interfaces
- `memAllocator.hpp:34-70`、`memAllocator.cpp:270-445`：TLAB/outside-TLAB/finish ordering
- `threadLocalAllocBuffer.hpp:134-161`：refill waste heuristic API
- `g1CollectedHeap.hpp:409-427`、`g1CollectedHeap.cpp:389-408`：G1 TLAB vs non-TLAB allocation
- `oopFactory.hpp:37-72`、`oopFactory.cpp:82-88`：oopFactory convenience layer

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- `Universe` 的“bootstrapping platform”角色重于“全局仓库”角色，但两者都存在
- `create_heap()` 只构造 collector object/policy；虚拟内存 reserve/auxiliary structures 在 `initialize()`
- primitive array klasses 是最早的一批 freshly created klass 之一，但不是“所有环境下绝对第一个 klass”
- canonical metadata arrays 属于 metaspace，不是 Java heap arrays；heap-side canonical `Class[]` 在更晚阶段创建
- OOME 预分配分成 no-backtrace defaults 与 backtrace pool 两层
- `oopFactory` 是便利 API，不是 TLAB/collector 分配器本身
- `_bootstrapping` 允许临时不完整状态，但不是普通执行模式

## 8. 完成后 review

- 删除代码后能否复述“heap substrate -> genesis minimal class universe -> mirrors/fixups -> post-init canonical objects -> normal allocation protocol”
- 是否纠正了 `create_heap`, G1 默认、空数组预分配、TLAB refill、oopFactory 等常见误解
- 是否把 metaspace metadata arrays、heap objects、sentinel/OOME 池明确分层
- 是否解释了 `_bootstrapping` 为什么允许部分初始化状态存在
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
