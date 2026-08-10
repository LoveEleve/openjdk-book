# libjvm.so 深度分析 — 写作进度

> 最后更新: 2026-05-19 (os_linux.cpp + os_linux_x86.cpp 深度插桩完成)

---

## 插桩进度（os_linux.cpp + os_linux_x86.cpp）

> 对应章节：07-thread-lock / 08-safepoint / 11-os-layer

| 文件 | 探针总数 | 新增 | 状态 |
|------|---------|------|------|
| `os_linux.cpp` | 101 | 约50 | ✅ 完成 |
| `os_linux_x86.cpp` | 20 | 20 | ✅ 完成 |
| **合计** | **121** | **约70** | |

### os_linux.cpp 插桩点清单（101 个）

**已有插桩（约 51 个，第一轮工作时已有）：**
- `signal_sets_init()`: 9 个（START/unblocked/Shutdown/COMPLETE）
- `hotspot_sigmask()`: 7 个（ENTRY/saved/UNBLOCKED/paths/COMPLETE）
- `thread_native_entry()`: 9 个（ENTRY→stack_base→sigmask→FPU→INITIALIZED→started→call_run→RETURNED）
- `os::create_thread()`: 7 个（CREATE/WAITING/state-changed/ZOMBIE/SUCCESS）
- `signalHandler()`: 1 个（SIGNAL_SAFE）
- `chained_handler()`: 4 个（DELEGATING/chained/no-handler/skip）
- `set_signal_handler()`: 4 个（sig/set_installed/THIRD_PARTY/INSTALLED）
- `libjsig` 加载: 1 个
- 其他: 约 9 个

**新增插桩（约 50 个）：**
- `SR_handler()`: 5 个（thread-terminated/signal-received/SUSPEND_REQUEST/SUSPENDED/RESUMED）
- `SR_initialize()`: 3 个（START/SR_signum确定/COMPLETE）
- `create_main_thread()`: 1 个（ENTRY）
- `create_attached_thread()`: 6 个（START/FAILED/thread_id/ALLOCATED/primordial/COMPLETE）
- `pd_start_thread()`: 2 个（ENTRY/COMPLETE）
- `free_thread()`: 3 个（ENTRY/caller_sigmask RESTORED/COMPLETE）
- `create_thread()`: 2 个增强（PARAMS/pthread_create FAILED）
- `anon_mmap()`: 2 个（SUCCESS/FAILED）
- `anon_mmap_aligned()`: 2 个（SUCCESS/FAILED）
- `commit_memory_impl()`: 2 个（SUCCESS/FAILED）
- `linux_mprotect()`: 1 个（addr/size/pages/prot）
- `os::protect_memory()`: 1 个（prot_type/committed）
- `os::guard_memory()`: 1 个
- `os::unguard_memory()`: 1 个
- `reserve_memory_special_huge_tlbfs_only()`: 3 个（START/FAILED/SUCCESS）
- `call_chained_handler()`: 4 个（SIG_DFL/USER flags/returned/SIG_IGN）
- `os::abort()`: 5 个（CALLED+signal_safe/dumping core/exiting）
- `os::die()`: 3 个（immediate/SIGKILL/::abort）
- `os::shutdown()`: 3 个（ENTRY/perfMemory/AttachListener）
- `javaTimeMillis()`: 1 个
- `javaTimeNanos()`: 2 个（CLOCK_MONOTONIC/gettimeofday）
- `pd_map_memory()`: 3 个（ENTRY/FAILED/SUCCESS）
- `pd_unmap_memory()`: 3 个（ENTRY/SUCCESS/FAILED）

### os_linux_x86.cpp 插桩点清单（20 个）

**全部为新增（`JVM_handle_linux_signal` 分支追踪）：**
- 信号入口过滤: 2 个（过滤 SIGPIPE/SIGXFSZ，记录其他信号号）
- 线程分类: 2 个（JavaThread/VMThread）
- 栈溢出分支: 4 个（RESERVED zone / YELLOW zone Java / YELLOW non-Java / RED zone）
- _thread_in_Java 异常: 4 个（Polling page / SIGBUS unsafe / SIGFPE div-by-zero / Implicit null）
- _thread_in_vm 异常: 1 个（SIGBUS unsafe）
- JNI_FastGetField: 1 个
- Memory Serialize Page: 1 个
- Stub 分发: 1 个
- Signal Chaining: 2 个（trying / handled）
- 崩溃路径: 2 个（return false / VMError::report_and_die）

---

## 总体进度

| 章节 | 计划文档 | 已完成 | 进度 |
|------|---------|--------|------|
| 01-jvm-startup | 4 | 13 | ✅ **325%** |
| 02-class-loading | 7 | 0 | ⬜ 0% |
| 03-object-model | 6 | 0 | ⬜ 0% |
| 04-interpreter | 4 | 0 | ⬜ 0% |
| 05-jit-compiler | 6 | 0 | ⬜ 0% |
| 06-gc-memory | 10 | 3 | 🟡 30% |
| 07-thread-lock | 6 | 0 | 🟡 插桩完成 |
| 08-safepoint | 5 | 0 | 🟡 插桩完成 |
| 09-native-interface | 5 | 0 | ⬜ 0% |
| 10-services-diag | 5 | 0 | ⬜ 0% |
| 11-os-layer | 4 | 0 | 🟡 插桩完成 |
| 12-cpu-layer | 4 | 0 | ⬜ 0% |
| **合计** | **71** | **16** | **23%** |

---

## 详细进度

### 01-jvm-startup ✅ 已完成（13/4，超额 9 篇）
- [x] JVM 启动全流程 (Threads::create_vm 17阶段逐段解析 + Mermaid + GDB脚本)
- [x] java 命令到 JVM 的加载链 (libjli → libjvm)
- [x] JVM 参数系统 (Arguments 解析与自动调优 + JVMFlag 字段级分析)
- [x] JVM 日志系统 (LogConfiguration vs InstrumentLog 双阶段切换)
- [x] ★ 22个核心结构字段级分析 (含GDB实测sizeof + 值域图 + 3张Mermaid关系图)
- [x] ★ 算法补充: Region惰性commit / CardTable映射 / Metaspace三层 / TLAB refill链

**2026-05-20 新增 9 篇深度分析：**
- [x] 05-create_vm-Deep-Dive: create_vm() 10阶段概览 + 预初始化 + 主线程创建 + init_globals 全景
- [x] 06-universe_init-Deep-Dive: initialize_heap(120ms) + Metaspace + TLAB + 压缩指针（GDB修正sizeof）
- [x] 07-G1CollectedHeap-Initialize-Deep-Dive: 12步骤全景 + CardTable(512B) + Double-Buffered Bitmap + expand vs reserve + 304MB辅助开销表
- [x] 08-HeapRegionManager-Deep-Dive: 2048 Region创建 + G1HeapRegionTable O(1)地址映射 + FreeRegionList + GDB验证(Region=432B)
- [x] 09-G1ConcurrentMark-Constructor-Deep-Dive: 1840B引擎 + 双缓冲swap O(1) + SATB不漏标 + finger机制 + 8 CMTask + 2 ConcGCThreads
- [x] 10-interpreter_init-Deep-Dive: 202条字节码→机器码 + TemplateTable + StubQueue(~162KB) + DispatchTable O(1)分派 + iconst_0 示例
- [x] 11-universe2_init-Deep-Dive: 8 TypeArrayKlass + 5空数组 + WK_KLASS(~30基类) + vmSymbols + SharedRuntime::generate_stubs
- [x] 12-javaClasses_init-Deep-Dive: ~20核心类字段偏移计算 + BASIC_JAVA_CLASSES_DO 宏 + Thread示例
- [x] 13-init_globals-Tail-Deep-Dive: ReferenceProcessor + vtableStubs + compileBroker + universe_post_init(OOM预分配) + stubRoutines2 + MethodHandles

**init_globals() 100% 覆盖** — 20+ 子函数逐个分析，其中核心子函数含 GDB 验证
- [x] ★ 交互补充: Symbol查找 / SystemDictionary / 编译触发

### 02-class-loading
- [ ] ClassFileParser 完整解析链
- [ ] ConstantPool 结构与解析
- [ ] SystemDictionary 类查找算法
- [ ] LinkResolver 方法/字段链接
- [ ] 类加载器隔离机制 (ClassLoaderData)
- [ ] 字节码验证流程 (Verifier)
- [ ] Symbol/String Table 管理

### 03-object-model
- [ ] markOop 对象头深度解析（bit编码 × 5种状态）
- [ ] Java 对象分配完整路径（TLAB/慢速/Humongous）
- [ ] InstanceKlass 内存布局（vtable/itable）
- [ ] oop/Klass 二分模型
- [ ] 压缩指针 (CompressedOops)
- [ ] TLAB 机制详解

### 04-interpreter
- [ ] TemplateInterpreter 生成流程
- [ ] 解释器栈帧结构 (interpreterFrame vs C2 frame)
- [ ] 关键字节码实现 (invoke/new/monitor/ldc)
- [ ] invokedynamic 与 MethodHandles

### 05-jit-compiler
- [ ] C2 编译全流程 (Parse→IDEAL→MATCH→REGALLOC→CODE)
- [ ] 内联决策机制 (InlineTree)
- [ ] 寄存器分配 (Chaitin 着色算法)
- [ ] CodeCache 与 NMethodSweeper
- [ ] 去优化机制 (Deoptimization)
- [ ] OopMap 与 GC 根扫描

### 06-gc-memory
- [x] Probe-01: HeapRegion 数据结构与堆初始化
- [x] Probe-02: G1 对象分配路径 (TLAB + Humongous)
- [x] G1-GC-Runtime-Workflow-Deep-Dive (43517行日志分析)
- [ ] G1 Young GC 完整流程
- [ ] G1 Concurrent Mark 深度解析 (SATB/Finger/MarkStack)
- [ ] G1 RSet 三级结构 (sparse/fine/coarse)
- [ ] G1 Evacuation Failure 机制
- [ ] G1 Mixed GC 与 Candidate 选择
- [ ] G1 Full GC 流程
- [ ] G1 IHOP 自适应阈值

### 07-thread-lock
- [ ] OSThread 生命周期追踪（ALLOCATED→INITIALIZED→RUNNABLE→ZOMBIE 状态转换已插桩）
- [ ] os::create_thread 完整参数插桩（thr_type/stack_size/guard_size/vm_page_size）
- [ ] thread_native_entry 完整流程插桩（已覆盖）
- [ ] create_attached_thread 插桩（新增：thread_id/pthread_id/primordial栈扩展）
- [x] 插桩：os_linux.cpp 线程管理 6 个新探针点 ✔
- [ ] Java 锁机制完整分析 (偏向→轻量→重量→降级)
- [ ] ObjectMonitor 内部实现 (enter/exit/wait/notify)
- [ ] hashCode 计算与存储 (get_next_hash 六种策略)
- [ ] 偏向锁批量撤销机制
- [ ] JavaThread 生命周期
- [ ] JVM 内部 Mutex/Monitor 层级

### 08-safepoint
- [ ] SR_handler 完整流程插桩（5个信号安全探针：终止检测/信号到达/SUSPEND_REQUEST/SUSPENDED/RESUMED）
- [ ] SR_initialize 插桩（3个探针：START/SR_signum/COMPLETE）
- [ ] JVM_handle_linux_signal 分支追踪（20个探针：线程分类/栈溢出4分支/4种隐式异常/Stub分发/Chaining/崩溃）
- [x] 插桩：os_linux.cpp 信号系统 7 个新探针点 ✔
- [x] 插桩：os_linux_x86.cpp 信号分支追踪 20 个新探针点 ✔
- [ ] Safepoint 完整机制 (发起→等待→执行→恢复)
- [ ] Polling Page 原理（全局 vs ThreadLocal）
- [ ] VMThread 事件循环与 VM Operations 体系
- [ ] ThreadSMR 安全内存回收
- [ ] GCLocker: JNI Critical Section

### 09-native-interface
- [ ] JNI 调用全链路 (native → JVM)
- [ ] JNI 引用管理 (GlobalRef/WeakRef)
- [ ] JVMTI 代理机制与事件分发
- [ ] Reflection 实现
- [ ] invokedynamic 与 MethodHandles

### 10-services-diag
- [ ] Attach 机制 (jcmd/jstack/jmap 全链路)
- [ ] DCmd 诊断命令体系
- [ ] MemoryService 与 JMX MXBean
- [ ] hs_err 崩溃日志生成 (VMError)
- [ ] JVM 低内存检测

### 11-os-layer
- [ ] JVM 信号处理与 libjsig.so 信号链（signalHandler/set_signal_handler/chained_handler/call_chained 已有完整插桩）
- [ ] JVM 线程模型 (pthread → JavaThread)（create_thread/create_attached/thread_native_entry 已有完整插桩）
- [ ] 堆内存映射 (mmap/mprotect/Commit)（anon_mmap/anon_mmap_aligned/commit_memory_impl/linux_mprotect/protect_memory/guard_memory/unguard_memory 已有完整插桩）
- [ ] 大页分配（reserve_memory_special_huge_tlbfs_only/mixed 已有插桩）
- [ ] 崩溃诊断 (hs_err 与寄存器 dump)（os::abort/os::die 已有信号安全插桩）
- [x] 插桩：os_linux.cpp 全部 41 个新探针点 ✔

### 12-cpu-layer
- [ ] x86_64 JVM 栈帧布局
- [ ] 模板解释器 x86 代码生成
- [ ] Stub 代码生成 (异常/去优化)
- [ ] CPU 特性检测 (VM_Version + CPUID)

---

## 写作顺序

按依赖关系：
1. 01-jvm-startup (基础)
2. 02-class-loading (依赖启动)
3. 03-object-model (依赖类加载)
4. 06-gc-memory (核心)
5. 07-thread-lock (核心)
6. 08-safepoint (依赖线程)
7. 04-interpreter (依赖类加载)
8. 05-jit-compiler (依赖解释器)
9. 09-native-interface (跨层)
10. 10-services-diag (跨层)
11. 11-os-layer (跨层)
12. 12-cpu-layer (跨层)
