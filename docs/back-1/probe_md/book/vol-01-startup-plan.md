# 第1卷规划：启动 — JVM 从零到一

> **分析资产**: `probe_md/01-jvm-startup/docs/` 24 篇文档，22,208 行  
> **覆盖范围**: `java` 命令 → `JNI_CreateJavaVM` → `vm_init_globals` → `init_globals()` 全部 30 调用 → Stages 5-10 → Live Phase  
> **目标读者**: 有 3 年以上 Java/C++ 经验的系统工程师  
> **预计总篇幅**: ~50,000 字（书稿），分 5 章

---

## Step 1: 分析资产扫描

```
24 篇文档，22,208 行

文档                                      行数    角色
──────────────────────────────────────────────────────────────
00-JNI-CreateJavaVM.md                    657    JNI 入口 → Stages 0-4 骨架构建
00-init-globals-overview.md               479    init_globals 30 调用全链路总览 + classLoader_init1
01-CodeCache.md                           951    CodeCache 三段 heap + freelist + segmap + nmethod 5 态
02-G1-Heap-Startup.md                   1,403    G1 堆启动 18 步：mmap→commit + Card Table + 6 Mapper
03-Metaspace.md                           716    VSL + ChunkManager + CCS + lazy commit 6 步链路
04-SymbolTable.md                         684    Hashtable 20011 桶 + Arena 360KB + refcount
05-StringTable.md                         671    ConcurrentHashTable 65536 entries + OopStorage + GC 弱引用
06-Mutex.md                               775    Rank 10 级 ~90 锁 + PlatformMonitor=pthread_cond_t
07-PerfMemory.md                          784    mmap 32KB 共享内存 + magic 0xc0c0feca + jstat 读取
08-G1-Policy-Analytics.md               1,403    G1Policy 8 子组件 + G1MonitoringSupport + serviceability
09-G1-Concurrent-Marking-Infra.md         720    G1ConcurrentMark + 并发精炼 + 线程创建
10-JNIHandle-CompileQueue-JVMTI.md      1,194    JNIHandleBlock 4 路分配器 + CompileQueue + JVMTI Env
11-Stages5-10-Threads-And-ClassLoading.md 1,052    VMThread→Live Phase：VM_Operation 4 模式 + 17 核心类 + 8 线程
12-vm-init-globals-basic-infra.md         569    mutex_init/chunkpool/basic_types/EventLog
13-Management-Services.md               1,172    PerfDataManager(23 counter) + DcmdFactory + JMX optional
14-Interpreter-Bytecodes-TemplateTable.md 1,538    解释器 7 调用：bytecodes(14KB)→codelet(256)→Template(flags+TosState)
15-StubRoutines-SharedRuntime.md          988    StubRoutines init1/init2 + SharedRuntime 8 桩
16-Universe-Post-Init.md                1,240    genesis + basic_type_mirrors + exception pre-allocation + ref processor
17-VTable-IC-Compiler-Infra.md            913    vtable stubs 256 槽 + IC buffer 10KB + compilerOracle + deps context
18-VM-Version-CPU-Detection.md            829    cpuid + SSE/AVX/BMI 标志位 + 虚拟化类型 + 缓存行大小
19-vmStructs-SA-Debug-Infra.md            535    vmStructs 导出 + SA 类型信息验证
20-Compilation-Pipeline.md                678    InvocationCounter 32 位编码 + CompilationPolicy(3 策略) + CompileBroker
21-Universe-Type-System.md              1,212    genesis 创世(8 TypeArrayKlass) + compute_offsets(31 字段) + post_init 收尾
22-ClassLoader-Init.md                  1,045    classLoader_init1(PerfData+zip+bootstrap)/init2(module entry+package)
```

**质量评估**（基于 Phase 01 两轮审计+修复后的最终状态）：

| 维度 | 状态 |
|------|------|
| 函数覆盖 | ✅ 全部 30 个 init_globals 调用均有对应文档 |
| 数据结构深度 | ✅ 每个结构标注了类型、大小、分配器、内部设计 |
| 代码引用密度 | ✅ 平均每 50 行一个 `file:line` 锚点 |
| 诊断工具覆盖 | ✅ strace + jcmd + jstack + GDB + /proc 五件套 |
| man 手册引用 | ✅ 每个 syscall 标注 man 2/3 来源 |
| Counterfactual | ✅ 平均每篇 3-5 个反事实讨论 |

---

## Step 2: 5 章 3 级目录规划

### 第1章：基座层 — 从 OS 线程到 JVM 进程 (~8,000 字)

**核心问题**：
1. 一个裸 OS 线程如何变成"Java 虚拟机"——在 init_globals 之前发生了什么？
2. ~90 个全局锁的 Rank 10 级系统如何在启动前就防止死锁？
3. PerfMemory 共享内存如何通过 magic 数让 jstat 发现 JVM 进程？

**对应文档**：

| 文档 | 行数 | 映射到本章 |
|------|:---:|------|
| 00-JNI-CreateJavaVM | 657 | §1.1-1.3 JNI 入口 + Stages 0-4 |
| 06-Mutex | 775 | §1.4 全局锁 Rank 系统 |
| 07-PerfMemory | 784 | §1.5 PerfMemory mmap 共享内存 |
| 12-vm-init-globals-basic-infra | 569 | §1.4 ChunkPool + EventLog + 基本类型验证 |

**章节结构**：

```
§1.1  入口：JNI_CreateJavaVM — 单 VM 进程保证
  §1.1.1  公共入口的原子性保证——Atomic::xchg(&vm_created)
  §1.1.2  JNI_CreateJavaVM_inner——安全保护、vm_created 标志、重试禁止
  §1.1.3  Windows SEH vs POSIX 信号处理的平台差异

§1.2  Threads::create_vm — 10 个阶段全景
  §1.2.1  Stage 0: ThreadLocalStorage + VM_Version::early_initialize——最早期的 CPU 检测
  §1.2.2  Stage 1: os::init()——信号集、时钟分辨率、页大小、errno 线程本地存储
  §1.2.3  Stage 2: Arguments::parse/apply_ergo——JVM 参数解析与自适应优化

§1.3  Agent 与 JVMTI 的原始阶段
  §1.3.1  Stage 3: create_vm_init_agents——dlopen agent .so + Agent_OnLoad 回调
  §1.3.2  JVMTI_PHASE_ONLOAD 的限制——哪些 API 在此时可用

§1.4  Stage 4: vm_init_globals——锁和分配器就位
  §1.4.1  mutex_init——10 级 Rank 等级制度的设计原理
  §1.4.2  chunkpool_init——4 层固定大小分配器
  §1.4.3  basic_types_init——jbyte=1..jlong=8 的生存依赖性验证
  §1.4.4  eventlog_init——4 事件日志的无锁环形缓冲区
  §1.4.5  perfMemory_init——mmap 32KB + magic 0xc0c0feca + /tmp/hsperfdata_<user>/<pid>

§1.5  主线程附加——Threads::attach_main_thread
  §1.5.1  JavaThread 对象的创建——栈保护、handle area、线程状态位
  §1.5.2  从 OS 线程到 Java 线程的身份转换
```

**需要补充分析的内容**：
- `os::init()` 中的 Linux 特定细节——`pthread_sigmask`、`sched_getaffinity`、`sysconf(_SC_PAGESIZE)`
- `Arguments::apply_ergo()` 的内存大小自动计算——G1 heap size、MetaspaceSize、CodeCacheSegmentSize
- `chunkpool_init()` 的 4 层大小：16B、64B、256B、1KB——为什么选择这 4 个尺寸

---

### 第2章：init_globals() — 30 次调用的有序交响乐 (~9,000 字)

**核心问题**：
1. 为什么 init_globals 的 30 个调用必须按此精确顺序——违反顺序会发生什么？
2. 三条错误短路路径（universe_init、compileBroker_init、universe_post_init）各自保护了怎样的失败？
3. CodeCache 三段堆如何在这种"所有桩代码都还没生成"的时刻被初始化？

**对应文档**：

| 文档 | 行数 | 映射到本章 |
|------|:---:|------|
| 00-init-globals-overview | 479 | §2.1-2.2 30 调用全景 + 依赖链 |
| 01-CodeCache | 951 | §2.4 CodeCache 三段 heap |
| 18-VM-Version-CPU-Detection | 829 | §2.5 CPU 特性检测 |
| 20-Compilation-Pipeline | 678 | §2.3 compilationPolicy + §2.8 compileBroker |
| 22-ClassLoader-Init | 1,045 | §2.3 classLoader_init1 |

**章节结构**：

```
§2.1  全景图：init_globals 的 5 个阶段
  §2.1.1  基础设施层（#1-#5）：管理→字节码→类加载→编译策略→CodeCache
  §2.1.2  运行时核心层（#6-#9）：CPU 检测→桩代码→universe_init
  §2.1.3  解释器层（#10-#17）：GC 屏障→解释器 codelet→模板表→SharedRuntime
  §2.1.4  类型系统层（#18-#22）：Universe 创世→偏移量→引用处理→JNI 句柄
  §2.1.5  编译底座层（#23-#30）：虚表桩→IC 缓冲→编译代理→Universe 收尾

§2.2  依赖关系网络——为什么错了就会崩溃
  §2.2.1  数据依赖链：management_init→codeCache_init（PerfData 必须最先）
  §2.2.2  能力依赖链：codeCache_init→stubRoutines_init1（桩代码的载体必须就绪）
  §2.2.3  语义依赖链：universe_init→universe2_init→universe_post_init
  §2.2.4  CDS 模式下的跳过路径——哪些调用被裁剪

§2.3  基础设施层详细走读（#1-#5）
  §2.3.1  management_init——PerfDataManager + JMX optional_support + 23 PerfCounter
  §2.3.2  bytecodes_init——6 个静态数组 ~14KB（_name/_flags/_format/_result_type/_depth/_can_trap）
  §2.3.3  classLoader_init1——PerfData 计数器 + libzip.so dlsym + bootstrap 搜索路径
  §2.3.4  compilationPolicy_init——Simple/StackWalk/Tiered 三策略 switch
  §2.3.5  codeCache_init——三段 CodeHeap + freelist + segmap + nmethod 生命周期的容器

§2.4  CodeCache：所有生成代码的容器
  §2.4.1  三段划分原理——NonNMethod(4MB)/Profiled(120MB)/NonProfiled(120MB)
  §2.4.2  CodeHeap 内部：freelist 双向链表 + segmap 段标记 + _next_segment
  §2.4.3  nmethod 在 CodeHeap 中的 14 段布局（header→scopes data→scopes pcs→reloc→...）
  §2.4.4  CodeCache::allocate 的 best-fit 搜索——为什么不是 first-fit

§2.5  运行时核心层（#6-#9）
  §2.5.1  VM_Version_init——cpuid 指令 + SSE/AVX/BMI/AES 特性位图
  §2.5.2  stubRoutines_init1——原子操作桩（atomic_xchg/cmpxchg/add/fence）+ verify_oop
  §2.5.3  universe_init（入口）——#9 是整个 init_globals 最重调用

§2.6  错误短路路径设计
  §2.6.1  universe_init 失败→return status——为何跳过 #10-#30
  §2.6.2  compileBroker_init 失败→return JNI_EINVAL——invalid argument vs JNI_ERR
  §2.6.3  universe_post_init 失败→return JNI_ERR——系统类加载失败的 fatal 性质
```

**需要补充分析的内容**：
- 用 Mermaid 图绘制完整的 30 调用数据流图（目前是文本列表）
- CodeCache 三段划分的 JVM flag 调优指南（-XX:NonNMethodCodeHeapSize 等）
- stubRoutines_init1 中 atomic_xchg 为什么必须在 universe_init 之前——循环依赖的具体解释

---

### 第3章：内存体系 — 堆、元空间、符号表与字符串表 (~12,000 字)

**核心问题**：
1. G1 在启动时如何不花一分物理内存就"拥有" 8GB 堆？
2. SymbolTable 的 Arena bump-pointer 与 StringTable 的 ConcurrentHashTable——为什么同一模块用两种完全不同策略？
3. 在 Java 对象还不存在时，JVM 如何创建 SymbolTable 和 StringTable 的 C++ 内部数据结构？

**对应文档**：

| 文档 | 行数 | 映射到本章 |
|------|:---:|------|
| 02-G1-Heap-Startup | 1,403 | §3.1-3.3 G1 堆 18 步启动 |
| 03-Metaspace | 716 | §3.4-3.5 Metaspace lazy commit |
| 04-SymbolTable | 684 | §3.6 SymbolTable Hashtable + Arena |
| 05-StringTable | 671 | §3.7 StringTable ConcurrentHashTable + OopStorage |
| 08-G1-Policy-Analytics | 1,403 | §3.3 G1Policy + G1MonitoringSupport |
| 09-G1-Concurrent-Marking-Infra | 720 | §3.3 G1ConcurrentMark + 并发精炼 |

**章节结构**：

```
§3.1  G1 堆 18 步启动全链路
  §3.1.1  G1CollectedHeap 构造函数——20+ 成员初始化列表
  §3.1.2  G1CollectorPolicy 选择——Server 还是 Client
  §3.1.3  initialize() 主流程——18 步按顺序执行

§3.2  mmap 预留策略：虚拟空间 vs 物理内存
  §3.2.1  MAP_NORESERVE + PROT_NONE——占用地址空间但不占物理内存
  §3.2.2  G1PageBasedVirtualSpace——按 page 粒度管理虚拟空间
  §3.2.3  6 个独立 Mapper——Heap/PrevBitmap/NextBitmap/BOT/CardTable/CardCounts
  §3.2.4  commit_regions 的 MAP_FIXED 策略——在预留空间内精确提交

§3.3  G1 辅助数据结构
  §3.3.1  Card Table——_byte_map_base 偏移优化与写后屏障触发链
  §3.3.2  BlockOffsetTable——G1BlockOffsetTablePart 的 512B/card 粒度
  §3.3.3  HeapRegionManager——2048 个 HeapRegion 的 Free List 初始化
  §3.3.4  G1Policy——8 子组件（pause predictor + IHOP + young list target + ...）
  §3.3.5  G1ConcurrentMark——并发标记线程 + SATB queue + task queue
  §3.3.6  G1MonitoringSupport——PerfData 计数器 + MemoryPool + GCManager

§3.4  Metaspace：类元数据的家
  §3.4.1  VirtualSpaceList——单链表 + 2× multiplier 策略
  §3.4.2  ChunkManager——SpecializedChunk/MediumChunk/SmallChunk 三类 free list + HumongousDict
  §3.4.3  CompressedClassSpace——独立 1GB VSL + Klass* = base + 32bit offset 数学推导

§3.5  Metaspace lazy commitment 全链路
  §3.5.1  global_initialize——8MB reserve / 0 commit 的启动时刻状态
  §3.5.2  首次类加载触发——ClassLoaderMetaspace::allocate() → SpaceManager
  §3.5.3  ChunkManager::get_chunk——三层 free list 查找
  §3.5.4  VirtualSpaceList::get_new_chunk——expand_by → commit_memory → mmap(MAP_FIXED)
  §3.5.5  Metaspace OOM——report_metadata_oome 与预分配异常的协作

§3.6  SymbolTable：符号的永久存储
  §3.6.1  Hashtable<Symbol*, mtSymbol>——20011 个桶 + 单链表链接
  §3.6.2  Arena bump-pointer 分配——无 free、不可变的 immutability 保证
  §3.6.3  _refcount 引用计数——PERM_REFCOUNT 的永久标记含义
  §3.6.4  Symbol 的内部结构——_length + _body[1]（头部+尾部数据）

§3.7  StringTable：GC 可回收的字符串表
  §3.7.1  ConcurrentHashTable——读无锁、写 CAS 的并发设计
  §3.7.2  OopStorage 后端——64 slot/block 的分配单元
  §3.7.3  GC 弱引用的生命周期——Mark→Weak Processing→StringTable::unlink→CleanupTask
  §3.7.4  与 SymbolTable 的并置对比——ConcurrentHashTable vs Hashtable 的设计取舍
```

**需要补充分析的内容**：
- Card Table _byte_map_base 偏移量方案的数学证明——为何 `card_mark = card_byte_map + ((addr-heap_base)>>card_shift)` 是安全的
- G1PageBasedVirtualSpace::pretouch 的并行实现细节
- ConcurrentHashTable 的 lock-free 读路径——内存序 (memory_order_acquire/release) 关键点

---

### 第4章：类型系统 — Klass、oop 与 Java 类的引导 (~9,000 字)

**核心问题**：
1. 在 Java 类还没加载时，JVM 如何创建 8 种 TypeArrayKlass——基本类型数组的 C++ 表示？
2. 为什么 10 个异常对象必须预先分配——JVM 如何在自己 OOM 时还能抛出 OOM？
3. universe_post_init 的 7 阶段设计如何解开 vtable、itable、类加载的循环依赖？

**对应文档**：

| 文档 | 行数 | 映射到本章 |
|------|:---:|------|
| 21-Universe-Type-System | 1,212 | §4.1 genesis + §4.2 compute_offsets + §4.3 post_init |
| 16-Universe-Post-Init | 1,240 | §4.3-4.5 post_init 详细走读 |
| 19-vmStructs-SA-Debug-Infra | 535 | §4.6 vmStructs 导出 |
| 10-JNIHandle-CompileQueue-JVMTI | 1,194 | §4.7 JNIHandle + OopStorage |

**章节结构**：

```
§4.1  Universe::genesis()——类型世界的创世纪
  §4.1.1  universe2_init 入口——EXCEPTION_MARK + genesis(CHECK)
  §4.1.2  8 种 TypeArrayKlass 的创建——bool→byte→char→short→int→long→float→double
  §4.1.3  SystemDictionary 初始化——_pd_cache_table + _shared_dictionary + _well_known_klasses
  §4.1.4  基本类型 mirrors 的 fixup_mirrors——延迟修复的设计智慧
  §4.1.5  CDS 模式下的 genesis 短路——ro/rw 区域直接映射

§4.2  JavaClasses::compute_offsets——31 个核心类字段偏移计算
  §4.2.1  compute_offset 的实现——find_local_field 按名字+签名匹配
  §4.2.2  java_lang_Class 的偏移量——oop_size/_klass_offset/_array_klass_offset
  §4.2.3  java_lang_String——value/coder/hash 的 3 字段偏移 + CompactStrings
  §4.2.4  java_lang_Thread——eetop/priority/daemon/thread_status 的线程状态映射
  §4.2.5  JSR 292 类——MemberName/ResolvedMethodName/MethodHandle/DirectMethodHandle
  §4.2.6  版本不匹配的检测——Invalid layout of well-known class → vm_exit

§4.3  universe_post_init：类型系统的最后一块拼图
  §4.3.1  7 阶段执行顺序——为什么这个顺序不能乱
  §4.3.2  Phase 1: vtable/itable 重初始化——Initialization 后修正虚表
  §4.3.3  Phase 2: 10 种异常预分配——7 OOM variants + NPE + ArithmeticException + VME
  §4.3.4  Phase 3: Universal VM Error——OutOfMemoryError::new_instance_java_lang_InternalError
  §4.3.5  Phase 4: 6 个 KnownMethod 缓存——Object::<init>/ClassLoader::loadClass/...
  §4.3.6  Phase 5: GC 特殊对象——空 Class 数组、null_string、min_jint_string
  §4.3.7  Phase 6: 回溯数组——backtrace_buf 用于 OOM 快速诊断
  §4.3.8  Phase 7: heap()->post_initialize——堆后置初始化

§4.4  为什么预分配异常：OOM 递归的 O(1) 解
  §4.4.1  问题建模——GC OOM 时 new OutOfMemoryError → 递归 OOM → stack overflow
  §4.4.2  解方案——PreallocatedOutOfMemoryErrorCount 个已分配实例
  §4.4.3  原子递减分配——gen_out_of_memory_error 的 CAS 递减逻辑
  §4.4.4  fallback 通道——池耗尽时返回无 backtrace 的 default_err
  §4.4.5  backtrace 节省——预分配 OOM 的 backtrace 长度为 0（节省内存）

§4.5  ReferenceProcessor 初始化
  §4.5.1  init_statics——获取单调时钟 + jlong 原子读取
  §4.5.2  Server/Client 双 LRU 策略——AlwaysClearPolicy vs LRUMaxHeapPolicy/LRUCurrentHeapPolicy

§4.6  vmStructs_init——调试基础设施
  §4.6.1  VMStructs::init——验证 SA Type 信息（INCLUDE_VM_STRUCTS 编译开关）
  §4.6.2  SA agent 如何使用 vmStructs 离线分析 core dump

§4.7  JNI Handle 基础设施
  §4.7.1  jni_handles_init——创建 global/weak_global 两个 OopStorage
  §4.7.2  JNIHandleBlock——4 路分配器（_first/_last/_free_list/_pop_frame_link）
```

**需要补充分析的内容**：
- Klass 层级结构可视化——InstanceKlass→InstanceMirrorKlass→TypeArrayKlass→ObjArrayKlass 的继承树
- OopStorage 分配/释放时序——什么场景触发 new block 分配、什么场景触发内存回收
- fixup_mirrors 为什么必须延迟——立即修复需要 SymbolTable 中有 "Ljava/lang/Class;" 等符号

---

### 第5章：执行引擎 — 解释器、编译器、线程与 Live Phase (~12,000 字)

**核心问题**：
1. 解释器的 codelet 模板机制如何将 256 字节码的 CPU 分支预测失败率从 ~50% 降到 ~0%？
2. 8 个后台线程的优先级层级设计：为什么 WatcherThread 必须高于 VMThread？
3. 从 VMThread 创建到 Live Phase，JVM 如何一步步从"一个线程"变成"一个可运行 Java 代码的完整运行时"？

**对应文档**：

| 文档 | 行数 | 映射到本章 |
|------|:---:|------|
| 14-Interpreter-Bytecodes-TemplateTable | 1,538 | §5.1-5.3 解释器 7 调用 |
| 15-StubRoutines-SharedRuntime | 988 | §5.4 StubRoutines 两阶段 |
| 20-Compilation-Pipeline | 678 | §5.5 编译底座 |
| 17-VTable-IC-Compiler-Infra | 913 | §5.5 vtable + IC + compilerOracle + deps |
| 11-Stages5-10-Threads-And-ClassLoading | 1,052 | §5.6-5.10 Stages 5-10 |
| 13-Management-Services | 1,172 | §5.11 JMX + DCmd |

**章节结构**：

```
§5.1  解释器基础设施全景——7 个初始化调用的协作
  §5.1.1  在 init_globals 中的位置——#2, #11-#16
  §5.1.2  从 bytecodes_init 到 templateTable_init 的数据流

§5.2  字节码属性表——256 条目的 6 个数组
  §5.2.1  Bytecodes::initialize + def()×~200——字节码的元数据注册
  §5.2.2  _name[256]/_flags[512]/_format[256]/_result_type[256]/_depth[256]/_lengths[256]
  §5.2.3  java_code vs 快速码——_fast_agetfield 的重写语义

§5.3  解释器 Codelet 的生成
  §5.3.1  TemplateInterpreter::initialize——StubQueue + generate_all
  §5.3.2  TemplateInterpreterGenerator::generate_all——生成所有 codelet
  §5.3.3  TemplateTable::initialize——256 字节码的 TosState + flags + generator
  §5.3.4  VMRegImpl::set_regName——569 条目 ×86-64 寄存器名映射（GPR→FPR→XMM→KREG）
  §5.3.5  InvocationCounter::reinitialize——2 状态机 + do_decay 启动平滑原理

§5.4  StubRoutines：从原子操作到 Intrinsic
  §5.4.1  stubRoutines_init1——atomic_xchg/cmpxchg/add/fence + verify_oop crash protection
  §5.4.2  SharedRuntime::generate_stubs——deopt/uncommon_trap/exception/safepoint handler
  §5.4.3  stubRoutines_init2——arraycopy 24 入口 + AES/SHA/CRC32 intrinsic
  §5.4.4  MethodHandles::generate_adapters——invokeBasic/linkToVirtual 等 30+ 适配器

§5.5  编译底座
  §5.5.1  vtableStubs_init——256 槽虚表桩缓存哈希表
  §5.5.2  InlineCacheBuffer_init——IC 更新的 10KB StubQueue
  §5.5.3  compilerOracle_init——-XX:CompileCommand 和 .hotspot_compiler 文件
  §5.5.4  dependencyContext_init——4 PerfCounter 追踪 nmethod 依赖桶
  §5.5.5  compileBroker_init——CompilationLog + DirectivesStack + 默认指令

§5.6  Stage 5：VMThread——安全点执行引擎
  §5.6.1  VMThread::create——单例模式 + VMOperationQueue 3 优先级循环双向链表
  §5.6.2  VMThread::run→loop——无限循环消费 VM_Operation
  §5.6.3  VM_Operation 4 种执行模式——_safepoint/_no_safepoint/_concurrent/_async_safepoint
  §5.6.4  Safepoint 握手协议——polling page mprotect 武装/解除
  §5.6.5  GuaranteedSafepointInterval——定时 no-op safepoint 保证响应性

§5.7  Stage 6：Java 核心类加载
  §5.7.1  initialize_java_lang_classes——17 个类的严格依赖顺序
  §5.7.2  类加载管线——load→link(verify+prepare+resolve)→initialize(<clinit>)
  §5.7.3  SystemDictionary::resolve_or_fail——双亲委派在 bootstrap 中的实现
  §5.7.4  主线程的 Java 对象创建——ThreadGroup + Thread oop + set_threadObj

§5.8  Stage 7：Signal Dispatcher + AttachListener
  §5.8.1  Signal Dispatcher——signal_thread_entry + sigwait + SIGBREAK 处理
  §5.8.2  SIGBREAK→thread dump 的 6 步 VM_Operation 链
  §5.8.3  Java 层 Signal 分派——JavaCalls::call_static 到 jdk.internal.misc.Signal
  §5.8.4  AttachListener——UNIX domain socket + /tmp/.java_pid<PID> + lazy init 状态机

§5.9  Stage 8：ServiceThread + Compiler 线程
  §5.9.1  ServiceThread——5 种事件循环（JVMTI/StringTable/LowMem/GCNotif/DCmd）
  §5.9.2  compilation_init_phase1——C1/C2 编译器实例 + 线程数计算
  §5.9.3  compilation_init_phase2——CompileQueue 就绪 + JSR292 核心类预加载

§5.10  Stage 9-10：模块系统 + Live Phase
  §5.10.1  call_initPhase2——模块系统解析 java.base（失败 fatal）
  §5.10.2  call_initPhase3——SecurityManager + SystemClassLoader
  §5.10.3  enter_live_phase——JVMTI_PHASE_LIVE 的 agent 回调
  §5.10.4  BiasedLocking::init——延迟启用 + PeriodicTask 注册
  §5.10.5  WatcherThread::start——最高优先级线程 + PeriodicTask 调度
  §5.10.6  return JNI_OK——启动完成

§5.11  运行时线程优先级体系
  §5.11.1  8 线程优先级对照——Watcher(Max) > VMThread(NearMax) > 6×(NearMax)
  §5.11.2  Linux 实现——nice 值映射与 SCHED_OTHER 策略
  §5.11.3  WatcherThread 优先级的双刃剑——profiling vs GC pause 延长

§5.12  JVMTI Phase 转变时间线
  §5.12.1  PRIMORDIAL→ONLOAD→PRIMORDIAL→START→LIVE 五阶段
  §5.12.2  各阶段的 API 可用性矩阵
  §5.12.3  post_vm_start/post_vm_initialized/VMDeath 回调时序
```

**需要补充分析的内容**：
- TemplateInterpreterGenerator::generate_all 中 codelet 生成的顺序——为何某些 codelet 必须在其他之前
- InvocationCounter 的 32 位编码方案——如何在一个 jint 中编码 carry/state/count
- 模块系统 Phase 1/2/3 的 Java 层实现——`System.initPhase1/2/3` 的源码
- SafepointSynchronize::begin 中的自旋策略——`GuaranteedSafepointInterval` 与 `-XX:+SafepointTimeout` 的关系

---

## Step 3: 源文件映射

### 第1章源文件

| 文件 | 关键行 | 为什么 |
|------|--------|--------|
| `src/hotspot/share/prims/jni.cpp` | :3984-4143 | JNI_CreateJavaVM + inner |
| `src/hotspot/share/runtime/thread.cpp` | :3886-4011 | Threads::create_vm Stages 0-4 |
| `src/hotspot/share/runtime/os.cpp` | :92-300 | os::init() + os::init_2() |
| `src/hotspot/os/linux/os_linux.cpp` | :4000-4200 | Linux_os::init/init_2 |
| `src/hotspot/share/runtime/arguments.cpp` | :3000-4000 | Arguments::parse + apply_ergo |
| `src/hotspot/share/runtime/init.cpp` | :95-108 | vm_init_globals |
| `src/hotspot/share/runtime/mutex.cpp` | :100-300 | mutex_init + rank system |
| `src/hotspot/share/services/perfMemory.cpp` | :200-400 | perfMemory_init + mmap |
| `src/hotspot/share/runtime/thread.cpp` | :100-200 | ThreadLocalStorage::init |
| `src/hotspot/share/runtime/thread.cpp` | :3800-3850 | attach_main_thread |

### 第2章源文件

| 文件 | 关键行 | 为什么 |
|------|--------|--------|
| `src/hotspot/share/runtime/init.cpp` | :109-212 | init_globals() 本体 |
| `src/hotspot/share/services/management.cpp` | :84 | management_init |
| `src/hotspot/share/interpreter/bytecodes.cpp` | :561 | bytecodes_init |
| `src/hotspot/share/classfile/classLoader.cpp` | :1853 | classLoader_init1 |
| `src/hotspot/share/runtime/compilationPolicy.cpp` | :61 | compilationPolicy_init |
| `src/hotspot/share/code/codeCache.cpp` | :1141 | codeCache_init |
| `src/hotspot/share/code/codeHeap.cpp` | :100-300 | CodeHeap::allocate |
| `src/hotspot/cpu/x86/vm_version_x86.cpp` | :34 | VM_Version_init |
| `src/hotspot/share/runtime/vm_version.cpp` | :20-50 | VM_Version::initialize |
| `src/hotspot/share/runtime/stubRoutines.cpp` | :411 | stubRoutines_init1 |
| `src/hotspot/share/memory/universe.cpp` | :682 | universe_init 入口 |
| `src/hotspot/share/compiler/compileBroker.cpp` | :236-770 | compileBroker_init + compilation_init |

### 第3章源文件

| 文件 | 关键行 | 为什么 |
|------|--------|--------|
| `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | :1490-1800 | G1CollectedHeap ctor + initialize |
| `src/hotspot/share/gc/g1/g1PageBasedVirtualSpace.cpp` | :50-200 | reserve + commit |
| `src/hotspot/share/gc/g1/g1CardTable.cpp` | :50-150 | CardTable ctor + byte_map_base |
| `src/hotspot/share/gc/g1/g1BlockOffsetTable.cpp` | :30-100 | BOT 512B/card |
| `src/hotspot/share/gc/g1/g1Policy.cpp` | :50-150 | G1Policy ctor + 8 sub-components |
| `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp` | :100-300 | G1ConcurrentMark ctor |
| `src/hotspot/share/gc/g1/g1MonitoringSupport.cpp` | :50-100 | create counters |
| `src/hotspot/share/gc/g1/heapRegionManager.cpp` | :30-80 | HeapRegionManager::initialize |
| `src/hotspot/share/gc/g1/heapRegion.cpp` | :50-100 | HeapRegion ctor + bottom/end |
| `src/hotspot/share/memory/metaspace.cpp` | :1391-1494 | Metaspace::global_initialize |
| `src/hotspot/share/memory/virtualSpaceList.cpp` | :50-100 | VSL ctor |
| `src/hotspot/share/memory/chunkManager.cpp` | :30-150 | three free lists |
| `src/hotspot/share/memory/metachunk.cpp` | :30-80 | Metachunk header layout |
| `src/hotspot/share/classfile/symbolTable.cpp` | :50-200 | SymbolTable create + add |
| `src/hotspot/share/classfile/stringTable.cpp` | :50-200 | StringTable create + do_intern |
| `src/hotspot/share/gc/shared/oopStorage.cpp` | :100-300 | OopStorage allocation |
| `src/hotspot/share/utilities/concurrentHashTable.inline.hpp` | :100-300 | get/insert internals |
| `src/hotspot/share/utilities/hashtable.cpp` | :50-150 | Hashtable::add_entry |

### 第4章源文件

| 文件 | 关键行 | 为什么 |
|------|--------|--------|
| `src/hotspot/share/memory/universe.cpp` | :1220-1350 | universe2_init + universe_post_init |
| `src/hotspot/share/memory/universe.cpp` | :300-500 | Universe::genesis |
| `src/hotspot/share/oops/typeArrayKlass.cpp` | :50-100 | TypeArrayKlass::create_klass |
| `src/hotspot/share/oops/instanceKlass.cpp` | :200-400 | InstanceKlass 布局 |
| `src/hotspot/share/oops/klass.cpp` | :50-150 | Klass 基类 |
| `src/hotspot/share/classfile/javaClasses.cpp` | :100-600 | compute_offsets + 字段偏移 |
| `src/hotspot/share/classfile/systemDictionary.cpp` | :100-300 | WK_KLASS resolve |
| `src/hotspot/share/memory/universe.cpp` | :600-700 | gen_out_of_memory_error |
| `src/hotspot/share/gc/shared/referenceProcessor.cpp` | :47-100 | ReferenceProcessor::init_statics |
| `src/hotspot/share/prims/jniHandles.cpp` | :340-400 | jni_handles_init |
| `src/hotspot/share/runtime/vmStructs.cpp` | :100-200 | vmStructs_init |
| `src/hotspot/share/utilities/globalDefinitions.hpp` | :50-100 | BASIC_JAVA_CLASSES_DO |

### 第5章源文件

| 文件 | 关键行 | 为什么 |
|------|--------|--------|
| `src/hotspot/share/interpreter/bytecodes.cpp` | :561-620 | bytecodes_init + def() |
| `src/hotspot/share/interpreter/templateInterpreter.cpp` | :50-120 | interpreter_init |
| `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp` | :50-300 | generate_all |
| `src/hotspot/share/interpreter/templateTable.cpp` | :540-600 | templateTable_init |
| `src/hotspot/cpu/x86/templateTable_x86.cpp` | :100-500 | 字节码模板实现 |
| `src/hotspot/share/interpreter/invocationCounter.cpp` | :50-350 | 2-state machine |
| `src/hotspot/cpu/x86/vmreg_x86.cpp` | :31 | set_regName |
| `src/hotspot/share/runtime/stubRoutines.cpp` | :411-450 | init1 + init2 |
| `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp` | :200-700 | generate stub |
| `src/hotspot/share/runtime/sharedRuntime.cpp` | :100-500 | generate_stubs |
| `src/hotspot/share/prims/methodHandles.cpp` | :75-200 | generate_adapters |
| `src/hotspot/share/code/vtableStubs.cpp` | :299 | vtableStubs_init |
| `src/hotspot/share/code/icBuffer.cpp` | :167 | IC buffer init |
| `src/hotspot/share/compiler/compilerOracle.cpp` | :767 | compilerOracle_init |
| `src/hotspot/share/compiler/dependencyContext.cpp` | :39 | deps context init |
| `src/hotspot/share/compiler/compileBroker.cpp` | :236-950 | compileBroker init |
| `src/hotspot/share/runtime/vmThread.cpp` | :240-580 | VMThread::create/run/loop |
| `src/hotspot/share/runtime/safepoint.cpp` | :156-600 | SafepointSynchronize |
| `src/hotspot/share/runtime/vmOperations.hpp` | :134 | VM_Operation modes |
| `src/hotspot/share/runtime/thread.cpp` | :4102-4348 | Stages 5-10 |
| `src/hotspot/share/runtime/os.cpp` | :346-530 | Signal Dispatcher |
| `src/hotspot/share/services/attachListener.cpp` | :435-500 | AttachListener init |
| `src/hotspot/share/runtime/serviceThread.cpp` | :51-149 | ServiceThread |
| `src/hotspot/share/prims/jvmtiExport.cpp` | :600-700 | Phase transitions |
| `src/hotspot/share/runtime/biasedLocking.cpp` | :95-112 | BiasedLocking::init |
| `src/hotspot/share/runtime/thread.cpp` | :1477-1630 | WatcherThread |
| `src/hotspot/share/services/management.cpp` | :84-300 | JMX + DCmd |
| `src/hotspot/share/classfile/systemDictionary.cpp` | :130-200 | compute_java_loaders |

---

## Step 4: 第一卷特有挑战

### 挑战 1: init_globals() 的 30 调用——如何避免流水账？

**问题**: 30 个初始化的顺序执行在代码层面就是 30 个函数调用。直接按调用顺序逐一讲解会变成枯燥的流水账。

**叙事设计策略**：

1. **按"能力阶段"分组而非按调用编号**：
   - 第2章将 30 个调用分成 5 个"能力阶段"（基础设施→运行时核心→解释器→类型系统→编译底座），每个阶段回答一个"JVM 获得了什么新能力"的问题。
   - 例：基础设施层回答"JVM 有了锁、计数器、代码容器——可以开始做真正的工作了"。

2. **用依赖链作为故事线**：
   - 不是"第 1 步做 A，第 2 步做 B"，而是"A 的输出是 B 的输入，所以必须先 A 后 B"。
   - 在每个阶段结尾放 Mermaid 依赖图，让读者看到数据如何流动——而非步骤编号。

3. **突出三条"不能失败"的短路点**：
   - universe_init、compileBroker_init、universe_post_init 这三个调用有 `return status` 而非 void。用这三个点作为章节的"高潮"：每到一个短路点，解释"如果这里失败，JVM 为什么不能继续"。

4. **"如果顺序错了"反事实剧透**：
   - 在第2章开头放一个反事实表格：
     ```
     | 如果 codeCache_init 在 universe_init 之后 | stubRoutines_init1 生成的所有桩无处存放 → SIGSEGV |
     | 如果 universe2_init 在 javaClasses_init 之后 | 偏移量计算找不到 TypeArrayKlass → vm_exit |
     ```
   - 让读者在阅读前就知道"顺序错了会导致多惨"，激发好奇心。

5. **三条阅读路径设计**：
   - 快速路径（~30 分钟）：仅读每章开头的能力阶段图 + 依赖图
   - 标准路径（~3 小时）：逐阶段走读，每完成一个阶段验证理解
   - 专家路径（~8 小时）：深入每个调用的源码细节 + GDB 验证

### 挑战 2: 代码引用密度——如何平衡源码与解释？

**问题**: 启动过程的每步都是 C++ 代码。如果每 3 行解释就插入 10 行 C++ 源码，文档会变成代码清单而非技术书。

**平衡策略**：

1. **"20/80 原则"贯穿全书**：
   - 20% 源码粘贴（关键路径的核心行）、80% 分析洞察（这些行在做什么、为什么这样设计、不这样会怎样）。
   - 源码块限制为 10-25 行，超过的行用 `// ... (详见 file:line)` 省略。
   - 重要但非核心的源码用 `file:line` 引用指路（"见 `thread.cpp:4018`"），而非全部粘贴。

2. **Mermaid 图代替长源码**：
   - 每个阶段的入口函数放流程图（而非源码）。
   - 并发交互（如 Safepoint 握手）放 sequence diagram。
   - 每个数据结构放类图（成员变量 + 方法，不放大段实现）。

3. **"读者已经知道了什么"分层假设**：
   - 第1章：默认读者不熟悉 HotSpot 代码（多解释 C++ 模式）→ "`MutexLocker ml(lock)` 是 RAII 锁——构造时获取、析构时释放"
   - 第3章：默认读者已理解锁系统（不再解释 MutexLocker）→ "`CodeCache_lock->lock_without_safepoint_check()` 获取非安全点锁"
   - 第5章：默认读者已理解所有基础模式 → 聚焦交互与设计权衡

4. **"为什么"句必须跟随每个代码块**：
   - 每放一段源码，后用 3-5 行解释："这段代码解决了什么问题？如果不这样写会怎样？"
   - 禁止"源码翻译"模式（"第 1 行做了 X，第 2 行做了 Y"——读者自己能看懂代码）。

5. **用 @file:line 锚点代替全量粘贴**：
   - 仅粘贴"读者需要逐行理解的"核心代码——init_globals() 本体、universe_init() 入口、VMThread::loop()。
   - 其他代码用 `@jni.cpp:4018` 指路——信任读者能用 IDE 或 codegraph 跳转。
   - 最后附每章的"源码导航索引"表，列出所有引用的 file:line 方便跳转。

### 跨卷一致性

- **术语一致性**: 全书统一使用 `file:line` 引用格式，Mermaid 图用 `flowchart TD/LR`。
- **反事实设计**: 每章至少 3 个反事实讨论（覆盖设计决策点），统一放在章节末尾的 "Design Tradeoffs" 小节。
- **诊断五件套**: 每章至少出现 1 次 strace + jcmd + jstack + GDB + /proc 组合，确保读者获得实用技能。
- **版本锚定**: 所有源码引用使用 HotSpot JDK 17 主线（commit bisection 已做），在卷首声明分析的代码版本。

---

## 进度规划

| 阶段 | 任务 | 工作量 | 依赖 |
|------|------|:---:|------|
| 1 | 补充分析（每章 2-3 个缺口） | 2-3 天 | 本文 |
| 2 | 章序、读者指南、代码版本声明 | 0.5 天 | — |
| 3 | 第1-2章首稿 | 3-4 天 | 阶段1 |
| 4 | 第3-5章首稿 | 4-5 天 | 阶段1 |
| 5 | 交叉审校 + 质量检查（jvm-quality-check） | 2 天 | 阶段3-4 |
| 6 | 终稿 + 统一修订 | 1-2 天 | 阶段5 |

**预计完成**: ~2 周（从补充分析开始）
