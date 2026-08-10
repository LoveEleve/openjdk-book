# 01 — JVM Startup: libjvm.so 初始化全景

> BUILD_LIBJVM → libjvm.so。JNI_CreateJavaVM → Threads::create_vm → init_globals → return JNI_OK。共 78 个初始化步骤。

## 恢复指南（给新会话）

### 已做完

- [x] Scout: 定位了所有核心符号和文件（见下方 §核心符号 + §源码文件）
- [x] Reader: 完整覆盖了 100+ 初始化步骤，每个标注了数据结构名、大小、失败处理、依赖关系（见 §init_globals 31 次调用清单 + §Stages 5-10 线程表）
- [x] Reader: universe_init() 深入展开（13 步子调用、12 个核心数据结构、SymbolTable 516KB / StringTable 520KB 等精确大小）
- [x] Project: CODEBUDDY.md + 4 个 Skills + Hooks 已配置（Harness 框架就绪）
- [x] **Deep Dive 第1批**: Mutex (级别系统, ~90锁, PlatformMonitor=pthread_cond_t), PerfMemory (mmap布局, magic 0xc0c0feca, jstat读取路径), CodeCache (3段堆, freelist+segmap, nmethod生命周期)
- [x] **Deep Dive 第2批**: SymbolTable (Hashtable 20011桶+Arena 360KB+refcount), Metaspace (VSL+CCS, 8MB reserve/0 commit, 2×multiplier策略), StringTable (ConcurrentHashTable 65536 entries+OopStorage 64slot/block+GC弱引用), G1Heap (mmap reserve~phys/4, Region~2048个, CardTable 512B/card)
- [x] **Prompt-01**: `prompts/prompt-01-CodeCache.md` (327行) — 3段 CodeHeap + freelist + segmap + nmethod 5 态
- [x] **Prompt-02**: `prompts/prompt-02-G1-Heap-Startup.md` (450行) — mmap reserve→commit, 6 Mapper, Card Table
- [x] **Prompt-03**: `prompts/prompt-03-Metaspace.md` (191行) — VSL + ChunkManager + CCS + lazy commit
- [x] **Prompt-04**: `prompts/prompt-04-SymbolTable.md` (113行) — HashtableEntry 24B + dual allocator + PERM_REFCOUNT
- [x] **Prompt-05**: `prompts/prompt-05-StringTable.md` (118行) — ConcurrentHashTable + OopStorage + GC weak ref
- [x] **Prompt-06**: `prompts/prompt-06-Mutex.md` (102行) — Rank 10级 + LockWord + pthread_cond_t
- [x] **Prompt-07**: `prompts/prompt-07-PerfMemory.md` (106行) — mmap 32KB + magic + jstat attach
- [x] **Prompt-08**: `prompts/prompt-08-G1-Policy-Analytics.md` (519行) — G1Policy 8 子组件 + G1MonitoringSupport + initialize_serviceability + 构造函数遗漏子系统
- [x] **Prompt-09**: `prompts/prompt-09-G1-Concurrent-Marking-Infra.md` (507行) — G1ConcurrentMark 构造函数 + 并发精炼 + 线程创建
- [x] **Prompt-10**: `prompts/prompt-10-JNIHandle-CompileQueue-JVMTI.md` (462行) — JNIHandleBlock 4路径分配器 + CompileQueue + JVMTI Env + Stage 3 agent 初始化
- [x] **Prompt-11**: `prompts/prompt-11-Stages5-10-Threads-And-ClassLoading.md` (510行) — Stages 5-10 线程创建 + Java 核心类加载 + 模块系统 + Live Phase

### 接下来需要做 (会话 B4: 新会话生成 2 篇 Phase 01 收尾文档)

复制以下内容到新会话执行：

```
请按以下顺序执行生成工作。⚠️ 关键：你必须逐个读源文件（用 codegraph_explore 或 Read），不可把 prompt 的"答案方向"直接抄到文档里。prompt 是导航，源码是证据。

1. 先读项目约定：
   /data/workspace/openjdk-cut-new/CODEBUDDY.md

2. 读质量锚点，理解文档结构和深度标准：
   /data/workspace/openjdk-cut-new/probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md

3. 读已完成的 09-G1-Concurrent-Marking-Infra 文档作为上下文（Phase 01 最新完成的高质量文档）：
   /data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/09-G1-Concurrent-Marking-Infra.md

4. 逐文件读源码 + 按 prompt-10 指令生成文档 10：
   - 读 prompt: /data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/prompts/prompt-10-JNIHandle-CompileQueue-JVMTI.md
   - 读 prompt §三 列出的每个核心源文件（共 15 个文件，至少读核心段落）
   - 输出: /data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/10-JNIHandle-CompileQueue-JVMTI.md

5. 逐文件读源码 + 按 prompt-11 指令生成文档 11：
   - 读 prompt: /data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/prompts/prompt-11-Stages5-10-Threads-And-ClassLoading.md
   - 读 prompt §三 列出的每个核心源文件（共 17 个文件，至少读核心段落）
   - 输出: /data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/11-Stages5-10-Threads-And-ClassLoading.md

6. 用 jvm-quality-check skill 自检两篇文档（12 项完整性 + 8 项 review gap）。

重点检查项：
- Mermaid 图存在（prompt §九 Required 明确要求 ≥7 个图）
- Callout 框 ≥7 且只在 §一 中，无 §二 重复
- 每个技术断言有 file:line 引用
- 源码粘贴而非文字描述（源码 20%，分析洞察 80%）
- 标题格式 # NN-Name — Subtitle
- §六 "不要写成→应该写成"对照表严格遵循
- man 2/man 3/man 5 引用覆盖所有 syscall 和 /proc 接口
- Section 编号连续无跳号
```

**然后 (会话 A2: 写剩余 prompt)**：
- Prompt-02 (init_globals #14-31: 执行引擎) + Prompt-03 (Stages 5-10: VM激活)
- Deep dive: CompileQueue, JNIHandleBlock, JVMTI Env

**P0 — 数据结构内部设计 deep dive**（用户要求必须覆盖到每个结构的内部设计，不是大小清单）：

需要读源码理解内部设计的核心结构（每个 30-60 分钟，用 jvm-reader 并行分析）：

| 结构 | 关键问题 | 读哪些文件 |
|------|---------|-----------|
| SymbolTable | hash 策略、Arena bump-pointer 分配、引用计数（非 GC） | symbolTable.cpp/hpp + hashtable.cpp/hpp |
| StringTable | ConcurrentHashTable 设计、OopStorage 后端、GC 弱引用 | stringTable.cpp/hpp + oopStorage.cpp/hpp |
| CodeCache | 三段 heap 的 FreeList 管理、sweeper、CodeHeap 分配/释放 | codeCache.cpp/hpp + codeHeap.cpp/hpp |
| Metaspace | VirtualSpaceNode commit 策略、ChunkManager 空闲链表、CompressedClassSpace | metaspace.cpp/hpp + metaspaceShared.cpp |
| G1 Heap (启动时) | Region 布局、Card Table、SATB queue（细节留给 GC Phase） | g1CollectedHeap.cpp/hpp |
| JNIHandleBlock | 块链表分配、OopStorage 后端、全局 vs 局部引用 | jniHandles.cpp/hpp + jni.cpp |
| CompileQueue | 优先级双队列、任务 steal、perf 计数器 | compileQueue.cpp/hpp |
| PerfMemory | mmap 共享内存布局、命名空间、计数器类型 | perfMemory.cpp/hpp |
| JVMTI Env | agent 环境结构、事件使能位图、capabilities | jvmtiEnv.cpp/hpp |
| Monitor/Mutex | safepoint 检查锁、PlatformMonitor 底层实现 | mutex.cpp/hpp + mutexLocker.cpp |

分析标准（不能是"购物清单"，必须是内部设计描述）：
```
以 SymbolTable 为例，不能写：
  ❌ "SymbolTable: 20011桶, 516KB"
应该写：
  ✅ "SymbolTable 是 Hashtable<Symbol*, mtSymbol>，20011 个桶。
     每个 entry 是一个 HashtableEntry，通过 _next 指针单向链表链接。
     插入时 Arena 用 bump-pointer 分配 entry（无 free，不可变），
     所以不需要并发控制。查找走 hash → bucket → 遍历链表 →
     Symbol::equals 比较。回收走引用计数（_refcount），
     为 0 时标记为 dead（不立即 free，Arena 不支持单个释放）。
     区别于 StringTable：StringTable 用 ConcurrentHashTable + OopStorage，
     支持 GC 弱引用，因为 Java 字符串可被 GC 回收。"
```

### 如何执行

1. 用 `jvm-scout` 定位每个数据结构的 .hpp + .cpp 文件
2. 用 `jvm-reader` 并行 deep dive 上面 10 个结构（3 批，每批 3-4 个）
3. 汇总后评估：如果 10 个结构的分析加上现有 100+ 步骤已经足够详细 → 直接写 prompt；如果还需要补充 → 再追加分析
4. 写 prompt（参照 prompt-00 锚点标准，§〇→§十一）
5. 新会话中按 prompt 生成文档

### 质量锚点

`probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md`（521行，12 Section）
所有 prompt 必须达到同等深度和密度。

## Phase 定义

| 属性 | 值 |
|------|-----|
| **Phase 编号** | 01 |
| **目标 .so** | libjvm.so (`make/hotspot/lib/CompileJvm.gmk:153 BUILD_LIBJVM`) |
| **入口函数** | `JNI_CreateJavaVM` @ `src/hotspot/share/prims/jni.cpp:4143` |
| **核心函数** | `Threads::create_vm()` @ `src/hotspot/share/runtime/thread.cpp:3886-4348` |
| **初始化核心** | `init_globals()` @ `src/hotspot/share/runtime/init.cpp:109-212` |
| **源码文件** | 见下表 |
| **边界（包含/不包含）** | |
| 包含 | JNI_CreateJavaVM → Threads::create_vm 全部 78 步骤 |
| 不包含 | libjli 的 Launcher 层（13-launcher 已覆盖） |
| 不包含 | 各模块的运行时内部实现（后续 Phase 各自负责） |

## 背景

13-launcher 覆盖了 `main.c` → `JLI_Launch()` → `LoadJavaVM()` → `ifn->CreateJavaVM()` 调用。但在 README 第 218 行明确标注：

> 🔴 从这一行开始，进入 01-jvm-startup §一，即 JNI_CreateJavaVM() 内部

**01-jvm-startup 从未被创建**。填补这个空白是本 Phase 的目标。

## 核心符号

| 符号 | 文件:行号 | 简述 |
|------|----------|------|
| `JNI_CreateJavaVM` | `src/hotspot/share/prims/jni.cpp:4143` | JNI 公开入口，薄封装 |
| `JNI_CreateJavaVM_inner` | `src/hotspot/share/prims/jni.cpp:3984` | 实际实现，含原子性保证 vm_created |
| `Threads::create_vm` | `src/hotspot/share/runtime/thread.cpp:3886` | JVM 启动全部逻辑，~460行 |
| `vm_init_globals` | `src/hotspot/share/runtime/init.cpp:95` | VM 线程阶段全局初始化 |
| `init_globals` | `src/hotspot/share/runtime/init.cpp:109` | Java 线程阶段 31 个模块初始化 |
| `universe_init` | `src/hotspot/share/memory/universe.cpp:682` | Java 堆 + 元空间 + 符号表创建 |
| `initialize_java_lang_classes` | `src/hotspot/share/runtime/thread.cpp:3822` | 加载 17 个 java.lang 核心类 |
| `call_initPhase2` | `src/hotspot/share/runtime/thread.cpp:3791` | 模块系统初始化 |
| `call_initPhase3` | `src/hotspot/share/runtime/thread.cpp:3815` | SecurityManager + SystemClassLoader |

## 源码文件

| 文件 | 行数 | 角色 |
|------|:---:|------|
| `src/hotspot/share/runtime/thread.cpp` | ~6300 | Threads::create_vm + Java 核心类加载 |
| `src/hotspot/share/runtime/init.cpp` | ~300 | init_globals + vm_init_globals |
| `src/hotspot/share/prims/jni.cpp` | ~5000 | JNI_CreateJavaVM 入口 |
| `src/hotspot/share/memory/universe.cpp` | ~2000 | universe_init + universe_post_init + Universe:genesis |
| `src/hotspot/share/runtime/os.cpp` | ~1500 | os::init / init_2 / JDK signal support |
| `src/hotspot/os/linux/os_linux.cpp` | ~6000 | Linux 平台 os::init_2 实现 |
| `src/hotspot/share/runtime/arguments.cpp` | ~4000 | Arguments::parse + apply_ergo |
| `src/hotspot/share/code/codeCache.cpp` | ~1500 | CodeCache 初始化 |
| `src/hotspot/share/interpreter/bytecodes.cpp` | ~600 | bytecodes_init |
| `src/hotspot/share/interpreter/interpreter.cpp` | ~200 | interpreter_init |
| `src/hotspot/share/interpreter/templateTable.cpp` | ~600 | templateTable_init |
| `src/hotspot/share/compiler/compileBroker.cpp` | ~1000 | 编译线程创建 |
| `src/hotspot/share/services/management.cpp` | ~200 | JMX 管理初始化 |
| `src/hotspot/share/classfile/classLoader.cpp` | ~2000 | classLoader_init1 |
| `src/hotspot/share/prims/jvmtiExport.cpp` | ~2800 | JVMTI Phase 转变 + 回调 |
| `src/hotspot/share/services/attachListener.cpp` | ~500 | Attach Listener |
| `src/hotspot/share/runtime/serviceThread.cpp` | ~150 | ServiceThread |
| `src/hotspot/share/memory/metaspace.cpp` | ~1500 | Metaspace::global_initialize |
| `src/hotspot/share/classfile/symbolTable.cpp` | ~1000 | SymbolTable::create_table |
| `src/hotspot/share/classfile/stringTable.cpp` | ~300 | StringTable::create_table |
| `src/hotspot/share/runtime/jniHandles.cpp` | ~400 | jni_handles_init |
| `src/hotspot/share/gc/shared/barrierSet.cpp` | ~80 | gc_barrier_stubs_init |

## 10 个阶段总览

```
Threads::create_vm()   thread.cpp:3886
│
├─ Stage 0: 预初始化 (3886-3908)
│   VM_Version::early_initialize, ThreadLocalStorage::init, ostream_init
│
├─ Stage 1: OS init + 参数解析 (3908-3960)
│   os::init(), Arguments::parse(), Arguments::apply_ergo(), 约束检查
│
├─ Stage 2: OS init 第二阶段 + Safepoint (3962-3988)
│   os::init_2(), SafepointMechanism::initialize(), ostream_init_log
│
├─ Stage 3: Agent 初始化 (3990-4009)
│   create_vm_init_agents() → Agent_OnLoad 回调
│
├─ Stage 4: 主线程 + vm_init_globals + init_globals (4011-4084) ★★★
│   new JavaThread() → vm_init_globals() → init_globals()【31 次子调用】
│
├─ Stage 5: VMThread 创建 (4102-4131)
│   VMThread::create() → pthread_create → wait ready
│
├─ Stage 6: Java 核心类加载 (4141-4162)
│   initialize_java_lang_classes()【17 个类】+ quicken_jni_functions + set_init_completed
│
├─ Stage 7: Post-init + Signal + Attach (4165-4190)
│   LogConfiguration, Metaspace post_init, Signal Dispatcher, Attach Listener
│
├─ Stage 8: ServiceThread + Compiler (4198-4233)
│   ServiceThread, Compilation Init Phase 1+2, JSR292 核心类
│
├─ Stage 9: 模块系统 + 最终初始化 (4239-4265)
│   call_initPhase2 → call_initPhase3 → SystemDictionary::compute_java_loaders
│
└─ Stage 10: Live Phase + 收尾 (4280-4348)
    JvmtiExport::enter_live_phase, BiasedLocking::init, WatcherThread::start, return JNI_OK
```

## init_globals() 31 次调用清单

| # | 函数 | file:line | 创建的核心数据结构 | 内存分配 | 大小 |
|---|------|-----------|-------------------|---------|------|
| 1 | management_init | management.cpp:84 | PerfDataManager, 23 个 PerfCounter, JMX optional_support 位域 | PerfMemory + C-Heap | ~32KB |
| 2 | bytecodes_init | bytecodes.cpp:561 | 256 条目字节码属性表 (_name, _flags, _format, _result_type, _depth, _can_trap) | BSS 静态 | ~5KB |
| 3 | classLoader_init1 | classLoader.cpp:1853 | 20 个 PerfCounter + libzip.so 7 个函数指针 + ZipOpen/ZipClose/FindEntry... | C-Heap + dlopen | 很小 |
| 4 | compilationPolicy_init | compilationPolicy.cpp:61 | CompilationPolicy 单例 (Simple/StackWalk/Tiered), 线程数计算, 内联阈值 | C-Heap | ~100B |
| 5 | codeCache_init | codeCache.cpp:1141 | 3 个 CodeHeap (NonNMethod/Profiled/NonProfiled) + GrowableArray×4 | mmap 预留 | ~240MB |
| 6 | VM_Version_init | vm_version.cpp:34 | cpu_features 位图 (SSE/AVX/BMI...), 缓存行大小, 虚拟化类型 | BSS 静态 | ~1KB |
| 7 | os_init_globals | os.cpp:92 | (Linux 上空实现) | 无 | 0 |
| 8 | stubRoutines_init1 | stubRoutines.cpp:411 | call_stub, catch_exception, forward_exception, 原子 CAS/xchg/add, fence, CRC32 共 18 个桩 | CodeCache | ~30KB |
| 9 | universe_init | universe.cpp:682 | Java Heap (CollectedHeap*), Metaspace, SymbolTable, StringTable, OopStorage, 6 个 LatestMethodCache | mmap 预留 + C-Heap | ~1GB虚拟 + ~1MB C-Heap |
| 10 | gc_barrier_stubs_init | barrierSet.cpp:49 | (G1 下为空; ZGC/Shenandoah 生成 barrier 桩) | CodeCache | 0(G1) |
| 11 | interpreter_init | interpreter.cpp:116 | AbstractInterpreter::_code (StubQueue + 全部 Codelet) | CodeCache | ~50KB |
| 12 | invocationCounter_init | invocationCounter.cpp:201 | InvocationCounter::_init[], _action[], InterpreterInvocationLimit 等 | BSS 静态 | ~50B |
| 13 | accessFlags_init | accessFlags.cpp:74 | (纯 assert 验证) | 无 | 0 |
| 14 | templateTable_init | templateTable.cpp:547 | TemplateTable::_template_table[256], Template 对象, _bs 指针 | BSS 静态 | ~8KB |
| 15 | InterfaceSupport_init | interfaceSupport.cpp:264 | (DEBUG 下 srand) | 无 | 0 |
| 16 | VMRegImpl::set_regName | vmreg_x86.cpp:31 | regName[] 寄存器名称映射表 | BSS 静态 | ~4KB |
| 17 | SharedRuntime::generate_stubs | sharedRuntime.cpp:101 | wrong_method_blob, ic_miss_blob, 4 个 resolve_call_blob, deopt_blob, uncommon_trap_blob, 3 个 safepoint handler | CodeCache | ~30KB |
| 18 | universe2_init | universe.cpp:1220 | 8 个基础类型数组 Klass (_boolArrayKlassObj 等), objectArrayKlassObj, null_string, min_jint_string, _the_null_sentinel | Metaspace + Java Heap | ~50KB |
| 19 | javaClasses_init | javaClasses.cpp:4597 | 所有核心 Java 类 C++ 字段偏移量 (java_lang_Class::oop_size/_klass_offset 等) | BSS 静态 | ~2KB |
| 20 | referenceProcessor_init | referenceProcessor.cpp:47 | AlwaysClearPolicy + LRUMaxHeapPolicy/LRUCurrentHeapPolicy 对象 | C-Heap | ~100B |
| 21 | jni_handles_init | jniHandles.cpp:343 | JNI Global + Weak Global OopStorage | C-Heap | ~500B |
| 22 | vmStructs_init | vmStructs.cpp:3208 | (仅 DEBUG 验证 SA 类型信息) | 无 | 0 |
| 23 | vtableStubs_init | vtableStubs.cpp:299 | VtableStubs::_table[256] + 哈希表初始化 | BSS 静态 | ~2KB |
| 24 | InlineCacheBuffer_init | icBuffer.cpp:167 | InlineCacheBuffer::_buffer (StubQueue, 10KB) | C-Heap (非 CodeCache) | 10KB |
| 25 | compilerOracle_init | compilerOracle.cpp:767 | BasicMatcher/TypedMethodOptionMatcher 对象链表 | C-Heap | ~1KB |
| 26 | dependencyContext_init | dependencyContext.cpp:39 | 4 个 PerfCounter (nmethodBucketsAllocated 等) | PerfMemory | ~32B |
| 27 | compileBroker_init | compileBroker.cpp:236 | CompilationLog + DirectivesStack + 默认 CompilerDirectives | C-Heap | ~1KB |
| 28 | universe_post_init | universe.cpp:1230 | 预分配 OOM/NPE/ClassCast/Arithmetic/StackOverflow 异常, 空 Class 数组, 6 个 KnownMethod cache, 回溯数组 | Java Heap | ~20KB |
| 29 | stubRoutines_init2 | stubRoutines.cpp:412 | 第二批桩: arraycopy 所有变体 + fill + SafeFetch | CodeCache | ~30KB |
| 30 | MethodHandles::generate_adapters | methodHandles.cpp:75 | MethodHandlesAdapterBlob, 约 30 个适配器 (invokeBasic/linkToVirtual/linkToStatic...) | CodeCache | ~182KB(debug)/32KB(product) |
| 31 | JVMFlag::printFlags | jvmFlag.cpp:1489 | (条件: PrintFlagsFinal) 排序数组 + 打印 | C-Heap 临时 | ~几KB |

## Stages 5-10 创建的线程

| # | 线程名 | 创建位置 | 入口函数 | 类型 | 优先级 | Daemon |
|---|--------|---------|---------|------|--------|--------|
| T1 | VM Thread | thread.cpp:4110 | VMThread::run() | NonJavaThread | 可高于 Java max | N/A |
| T2 | Signal Dispatcher | os.cpp:502 | signal_thread_entry | JavaThread | NearMaxPriority | Yes |
| T3 | Attach Listener | attachListener.cpp:472 | attach_listener_thread_entry | JavaThread | NearMaxPriority | Yes |
| T4 | Service Thread | serviceThread.cpp:68 | service_thread_entry | ServiceThread | NearMaxPriority | Yes |
| T5 | C1 CompilerThread×N | compileBroker.cpp:918 | CompilerThread::run | CompilerThread | NearMaxPriority | Yes |
| T6 | C2 CompilerThread×N | compileBroker.cpp:898 | CompilerThread::run | CompilerThread | NearMaxPriority | Yes |
| T7 | CodeCache Sweeper | compileBroker.cpp:925 | sweeper_thread_entry | JavaThread | NearMaxPriority | Yes |
| T8 | WatcherThread | thread.cpp:1620 | WatcherThread::run() | NonJavaThread | MaxPriority | N/A |

## JVMTI Phase 转变时间线

| 阶段 | create_vm 位置 | Phase 值 | 回调事件 |
|------|---------------|---------|---------|
| Early Start | thread.cpp:4145-4148 | JVMTI_PHASE_ONLOAD | post_early_vm_start → VMStart (only early env) |
| Start | thread.cpp:4252-4255 | JVMTI_PHASE_START | post_vm_start → VMStart (non-early env) |
| Live | thread.cpp:4283-4286 | JVMTI_PHASE_LIVE | post_vm_initialized → VMInit |

## Java 核心类加载顺序（Stage 6, initialize_java_lang_classes）

| 序号 | 类名 | 原因 |
|------|------|------|
| 1 | java.lang.String | 最基本的数据类型 |
| 2 | java.lang.System | 创建主线程前需要（initPhase1） |
| 3 | java.lang.Class | VM 创建并返回此类对象 |
| 4 | java.lang.ThreadGroup | 线程组层级结构 |
| 5 | java.lang.Thread | 创建主线程 Java 对象 |
| 6 | java.lang.Module | VM 创建此类对象 |
| 7 | java.lang.reflect.Method | VM 预解析方法 |
| 8 | java.lang.ref.Finalizer | VM 预解析 |
| 9-17 | 9 个异常类 | VM 内部抛出，预分配实例：OutOfMemoryError/NPE/ClassCastException/ArrayStoreException/ArithmeticException/StackOverflowError/IllegalMonitorStateException/IllegalArgumentException |

## JSR292 核心类预加载（Stage 9, 编译器初始化之后）

| 类 | 原因 |
|----|------|
| java.lang.invoke.MethodHandle | 签名多态 intrinsic 编译 |
| java.lang.invoke.ResolvedMethodName | 死锁避免 |
| java.lang.invoke.MemberName | 死锁避免 |
| java.lang.invoke.MethodHandleNatives | 死锁避免 |

## universe_init() 创建的 12 个核心数据结构

| 数据结构 | 变量名 | 大小 | 存储位置 |
|---------|--------|------|---------|
| Java Heap | Universe::_collectedHeap | 默认物理内存/4 | mmap 虚拟预留 |
| Metaspace VSL | Metaspace::_space_list | 8MB 初始预留 | mmap |
| Compressed Class Space | (via _space_list) | 1GB 虚拟预留 | mmap |
| VM Weak OopStorage | SystemDictionary::_vm_weak_oop_storage | ~64B + 8 Block* | C-Heap |
| Null ClassLoaderData | _the_null_class_loader_data | ~2KB (含 PackageEntryTable + Dictionary) | C-Heap |
| SymbolTable | SymbolTable::_the_table | ~516KB (20011桶 + 360KB Arena) | C-Heap |
| StringTable | StringTable::_the_table | ~520KB (65536桶 + OopStorage) | C-Heap |
| ResolvedMethodTable | ResolvedMethodTable::_the_table | ~8KB (1007桶) | C-Heap |
| LatestMethodCache×6 | Universe::_*_cache | 96B | C-Heap |
| MetaspaceCounters | _perf_counters | 8 个 PerfCounter | PerfMemory |
| MetaspaceTracer | Metaspace::_tracer | ~100B | C-Heap |
| G1 barrier stubs | (空, 内联生成) | 0 (G1 default) | N/A |

## 已完成的工作

- [x] Scout: 定位所有核心符号和文件
- [x] Reader: init_globals 31 调用完整分析（数据结构名/大小/失败处理/依赖）
- [x] Reader: Threads::create_vm Stages 0-10 全部 78+ 步骤覆盖
- [x] Reader: universe_init() 深入展开（13 个子步骤、12 个数据结构）
- [x] CODEBUDDY.md + Skills + Hooks 已配置（Harness 框架就绪）

## 当前状态

**已完成**: Scout + Reader 覆盖 100+ 初始化步骤，每个标注了数据结构名/大小/失败处理/依赖关系。
**下一步**: 数据结构内部设计 deep dive（详见顶部 §恢复指南 → 接下来需要做）。
**质量目标**: 对齐 prompt-00 锚点标准 (§〇→§十一, ≥450行, ≥6组 §四 问题)
