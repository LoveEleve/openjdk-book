# libjvm.so 源码精通总纲

> 方法论：程序 = 数据结构 + 算法；日志驱动源码分析
> 数据源：794 处 INST_* 插桩，覆盖 68+ 个 .cpp 文件，18 种日志宏
> 编译确认：所有插桩编译通过，无错误

---

## 一、12 模块全景

```
libjvm.so（hotspot 源码）核心模块

    ┌─────────────────────────────────────────────────────────────────┐
    │  [01] JVM 启动    Threads::create_vm() → os::init → Phase1~7   │
    │       ↓ 加载核心类                                               │
    │  [02] 类加载      ClassFileParser → SystemDictionary → link     │
    │       ↓ 产生 Klass 对象                                          │
    │  [03] 对象模型    oop/Klass/Method/ConstantPool/vtable          │
    │       ↓ 分配 + 执行                                              │
    │  [04] 解释器      TemplateInterpreter → 逐条字节码执行           │
    │  [05] JIT 编译    C1/C2 → 热点方法编译为机器码                   │
    │                                                                 │
    │  [06] GC 内存     G1（Young/Mixed/Full/Concurrent）             │
    │  [07] 线程与锁    JavaThread·ObjectMonitor·偏向锁               │
    │  [08] Safepoint   STW 协调·VM Operation·Polling Page            │
    │                                                                 │
    │  [09] JNI/JVMTI   本地方法调用·代理·事件                         │
    │  [10] 服务诊断    Attach·DCmd·JMX·hs_err                         │
    │  [11] OS 层      信号·线程·mmap·大页                             │
    │  [12] CPU 层     x86_64·栈帧·Stub·CPUID                         │
    └─────────────────────────────────────────────────────────────────┘
```

---

## 二、模块 → 源码 → 插桩 映射表

### 01 — JVM 启动与初始化 ✅ 文档已完成

| 项目 | 内容 |
|------|------|
| **核心文件** | `runtime/thread.cpp`, `runtime/init.cpp`, `os/linux/os_linux.cpp` |
| **关键函数** | `Threads::create_vm()` L3886, `os::init()` L5385, `init_globals()` |
| **INST_ 宏** | `INST_LOG_RUNTIME` (28处), `INST_PHASE_RUNTIME` (8处), `INST_LOG_SIGNAL` (22处) |
| **INST_ 在文件内分布** | thread.cpp:28, os_linux.cpp:39, init.cpp:15 |
| **日志过滤** | `-Xlog:probe_runtime=debug` |
| **已有文档** | 4 篇（01~04）✅ |
| **分析关键点** | Phase1~7 各阶段职责、信号初始化、系统类加载器启动、VM Thread 创建 |

### 02 — 类加载子系统 ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `classfile/classFileParser.cpp`, `classfile/systemDictionary.cpp`, `classfile/classLoader.cpp`, `oops/instanceKlass.cpp`, `oops/klassVtable.cpp` |
| **关键函数** | `parse_stream()` L6079, `resolve_or_null()` L250, `link_class()` L718, `initialize_vtable()` L171, `initialize_itable()` L1104, `rewrite_class()` L874 |
| **INST_ 宏** | `INST_LOG_CLASSLOAD` (45处), `INST_PHASE_CLASSLOAD` (5处), `INST_LOG_OOP` (26处) |
| **INST_ 在文件内分布** | systemDictionary.cpp:13, instanceKlass.cpp:12, classFileParser.cpp:8, klassVtable.cpp:7, constantPool.cpp:7, classLoader.cpp:4, verifier.cpp:3, stringTable.cpp:2, classLoaderData.cpp:2, klassFactory.cpp:1 |
| **日志过滤** | `-Xlog:probe_class=debug,probe_oop=debug` |
| **已有文档** | 0 篇 |
| **计划文档** | 7 篇 |
| **分析关键点** | ClassFileParser 6个解析阶段、SystemDictionary 5条查找路径、link/rewrite/init 三阶段 |

### 03 — 对象模型 ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `oops/instanceKlass.cpp`, `oops/constantPool.cpp`, `oops/method.cpp`, `oops/klassVtable.cpp`, `memory/universe.cpp` |
| **关键函数** | `klass_at_impl()` L458, `resolve_constant_at_impl()` L856, `InstanceKlass::allocate_instance()` L1275 |
| **INST_ 宏** | `INST_LOG_OOP` (26处), `INST_DATA_STRUCT` (43处), `INST_LOG_INTERP` (29处, resolve路径) |
| **INST_ 在文件内分布** | instanceKlass.cpp:12, constantPool.cpp:7, klassVtable.cpp:7, methodCounters.cpp:4, method.cpp:1, klass.cpp:1 |
| **日志过滤** | `-Xlog:probe_oop=debug,probe_interp=debug` |
| **已有文档** | 0 篇 |
| **计划文档** | 6 篇 |
| **分析关键点** | oop-Klass双端模型、markOop 5种状态编码、虚表构建与method重写、常量池4类解析 |

### 04 — 解释器执行引擎 ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `interpreter/interpreterRuntime.cpp`, `interpreter/linkResolver.cpp`, `interpreter/templateInterpreter.cpp`, `interpreter/bytecodeInterpreter.cpp` |
| **关键函数** | `ldc()` L151, `resolve_get_put()` L701, `resolve_invoke()` L877, `_new()` L231, `monitorenter()` L796 |
| **INST_ 宏** | `INST_LOG_INTERP` (29处), `INST_PHASE_INTERP` (1处) |
| **INST_ 在文件内分布** | interpreterRuntime.cpp:16, linkResolver.cpp:9, interpreter.cpp:2, templateInterpreter.cpp:1 |
| **日志过滤** | `-Xlog:probe_interp=debug` |
| **已有文档** | 0 篇 |
| **计划文档** | 4 篇 |
| **分析关键点** | 字节码dispatch循环、运行时解析(invoke/field/ldc)、LinkResolver全链路、栈帧结构 |

### 05 — JIT 编译器 ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `compiler/compileBroker.cpp`, `compiler/compileTask.cpp`, `compiler/compilationPolicy.cpp`, `code/codeCache.cpp` |
| **关键函数** | `compile_method()` L1244, `CompileTaskWrapper()` L254, `CompileTask::set_code()` L170 |
| **INST_ 宏** | `INST_LOG_JIT` (68处), `INST_PHASE_JIT` |
| **INST_ 在文件内分布** | compileBroker.cpp:10, compileTask.cpp:3, oopMap.cpp:1, methodLiveness.cpp:1, compilerDirectives.cpp:1 |
| **日志过滤** | `-Xlog:probe_jit=debug` |
| **已有文档** | 0 篇 |
| **计划文档** | 6 篇 |
| **分析关键点** | 编译触发(计数器+策略+OSR)、CompileTask生命周期、分层编译4级切换、CodeCache管理 |

### 06 — GC 内存管理 🟡 30%

| 项目 | 内容 |
|------|------|
| **核心文件** | `gc/g1/g1CollectedHeap.cpp`, `gc/g1/g1ConcurrentMark.cpp`, `gc/g1/g1Policy.cpp`, `gc/g1/g1RemSet.cpp`, `gc/g1/heapRegionManager.cpp`, `gc/g1/g1Allocator.cpp`, `memory/metaspace.cpp` |
| **关键函数** | `do_collection_pause()` L3335, `collect()` L2820, `attempt_allocation()` |
| **INST_ 宏** | `INST_LOG_GC` (269处), `INST_GC_DECISION` (46处), `INST_GC_PHASE` (14处), `INST_DATA_STRUCT` (43处), `INST_LOG_META` (26处) |
| **INST_ 在文件内分布** | g1CollectedHeap.cpp:76, g1ConcurrentMark.cpp:57, g1Policy.cpp:29, g1RemSet.cpp:17, g1ConcurrentRefine.cpp:17, g1CollectionSet.cpp:16, g1ConcurrentMarkThread.cpp:14, g1Allocator.cpp:13, heapRegionManager.cpp:11, g1FullCollector.cpp:11 |
| **日志过滤** | `-Xlog:probe_gc=debug,probe_meta=trace` |
| **已有文档** | 3 篇 ✅ |
| **计划文档** | 剩余 7 篇 |
| **分析关键点** | Young GC暂停全路径、Concurrent Mark SATB+Finger、RSet三级结构、Mixed GC candidate选择、Full GC、IHOP自适应、Humongous分配 |

### 07 — 线程与锁 🟡 插桩完成

| 项目 | 内容 |
|------|------|
| **核心文件** | `runtime/thread.cpp`, `runtime/objectMonitor.cpp`, `runtime/synchronizer.cpp`, `runtime/biasedLocking.cpp`, `runtime/park.cpp` |
| **关键函数** | `JavaThread::JavaThread()` L1787/L1851, `~JavaThread()` L1878, `run()` L1927, `ObjectMonitor::enter()` L266, `EnterI()` L454, `exit()` L921, `wait()` L1444, `notify()` L1798, `ExitEpilog()` L1304 |
| **INST_ 宏** | `INST_LOG_RUNTIME` (~50处 线程相关), `INST_LOG_SIGNAL_SAFE` (22处) |
| **INST_ 在文件内分布** | thread.cpp:28, objectMonitor.cpp:15, synchronizer.cpp:9, biasedLocking.cpp:2, park.cpp:若干 |
| **日志过滤** | `-Xlog:probe_runtime=debug` |
| **已有文档** | 0 篇 |
| **计划文档** | 6 篇 |
| **分析关键点** | JavaThread 4状态转换、锁升级全链(偏向→轻量→重量)、ObjectMonitor enter/exit/wait/notify 完整路径、Parker/LockSupport |

### 08 — Safepoint 机制 🟡 插桩完成

| 项目 | 内容 |
|------|------|
| **核心文件** | `runtime/safepoint.cpp`, `runtime/vmThread.cpp`, `runtime/vmOperations.cpp`, `runtime/safepointMechanism.cpp` |
| **关键函数** | `SafepointSynchronize::begin()` L156, `end()` L527, `block()` L859, `VMThread::loop()` |
| **INST_ 宏** | `INST_LOG_RUNTIME` (~20处 safepoint相关), `INST_LOG_SIGNAL` |
| **INST_ 在文件内分布** | safepoint.cpp:13, vmThread.cpp:5, vmOperations.cpp:1, safepointMechanism.cpp:1 |
| **日志过滤** | `-Xlog:probe_runtime=debug` |
| **已有文档** | 0 篇 |
| **计划文档** | 5 篇 |
| **分析关键点** | begin/end完整流程、ThreadBlocking协调机制、Polling Page原理、VMOperation队列调度、ThreadSMR |

### 09 — JNI / JVMTI / Reflection ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `prims/jni.cpp`, `prims/jvmtiImpl.cpp`, `runtime/reflection.cpp` |
| **关键函数** | JNI 入口函数、JVMTI 事件回调、Reflection::invoke_method() |
| **INST_ 宏** | `INST_LOG_JNI` (17处), `INST_LOG_JVMTI` (1处) |
| **日志过滤** | `-Xlog:probe_jni=debug` |

### 10 — 服务与诊断 ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `services/attachListener.cpp`, `services/diagnosticCommand.cpp`, `services/management.cpp`, `utilities/vmError.cpp` |
| **关键函数** | AttachListener::init()、DCmd 命令分发、hs_err 生成 |
| **INST_ 宏** | `INST_LOG_SERVICE` (6处), `INST_LOG_JFR` (6处) |
| **日志过滤** | `-Xlog:probe_service=debug` |

### 11 — OS 层 🟡 插桩完成

| 项目 | 内容 |
|------|------|
| **核心文件** | `os/linux/os_linux.cpp`, `os/linux/os_linux_x86.cpp` |
| **关键函数** | `create_thread()`, `thread_native_entry()`, `signal_sets_init()`, `hotspot_sigmask()`, `mmap/mprotect`, `os::abort()` |
| **INST_ 宏** | `INST_LOG_RUNTIME`, `INST_LOG_SIGNAL_SAFE`, `INST_LOG_SIGNAL` |
| **INST_ 在文件内分布** | os_linux.cpp:39, os_linux_x86.cpp:若干 |
| **日志过滤** | `-Xlog:probe_runtime=debug` |
| **已有文档** | 0 篇（插桩完成） |
| **计划文档** | 4 篇 |

### 12 — CPU 层 ⬜ 0%

| 项目 | 内容 |
|------|------|
| **核心文件** | `cpu/x86/vm_version_x86.cpp`, `cpu/x86/templateInterpreterGenerator_x86.cpp`, `cpu/x86/stubGenerator_x86.cpp` |
| **关键函数** | VM_Version::get_processor_features()、Stub 代码生成、模板解释器 x86 生成 |
| **INST_ 宏** | （暂未插桩） |
| **已有文档** | 0 篇 |

---

## 三、日志驱动分析工作流

```
┌──────────────────────────────────────────────────────────────────┐
│              日志驱动源码分析工作流                                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: 配置 JVM 参数                                           │
│          java -Xlog:probe_runtime=debug:stdout \                 │
│               -Xlog:probe_class=debug:stdout \                   │
│               -cp demo.jar com.example.Main > trace.log          │
│                                                                  │
│  Step 2: 搜索关键入口                                            │
│          grep "Threads::create_vm() ENTRY" trace.log              │
│          grep "ClassFileParser::parse_stream ENTRY" trace.log    │
│          grep "ObjectMonitor::enter" trace.log                   │
│                                                                  │
│  Step 3: 跟随 INST_PHASE_* 标记理解阶段                           │
│          grep "PHASE:" trace.log                                 │
│                                                                  │
│  Step 4: 每个 INST_LOG 调用 → 打开对应源码                        │
│          PROGRESS.md 中有完整探针清单和源码行号                      │
│                                                                  │
│  Step 5: 从函数入口开始，追踪完整调用链                              │
│          按照 Doc-DataStructure-First 规则：                       │
│          ① 穷举数据结构清单                                        │
│          ② 逐个完整分析每个结构（6项标准）                          │
│          ③ 分析算法流程（源码级深度）                               │
│          ④ GDB 验证                                                │
│          ⑤ 数据结构关系图                                          │
│                                                                  │
│  Step 6: 产出分析文档到对应子目录                                   │
│          probe_md/libjvm-analysis/XX-module/XX-doc.md             │
│          更新 PROGRESS.md 进度                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 按模块过滤日志

```bash
# 启动 + 信号
-Xlog:probe_runtime=debug:stdout

# 类加载 + 对象模型
-Xlog:probe_class=debug,probe_oop=debug:stdout

# 解释器
-Xlog:probe_interp=debug:stdout

# JIT 编译
-Xlog:probe_jit=debug:stdout

# G1 GC
-Xlog:probe_gc=debug:stdout

# 元空间（注意：trace 级别）
-Xlog:probe_meta=trace:stdout

# JNI
-Xlog:probe_jni=debug:stdout

# 全部模块
-Xlog:probe*=debug:stdout
```

---

## 四、所有 INST_ 宏速查

| 宏名 | 数量 | 模块 | 过滤 tag |
|------|------|------|----------|
| `INST_LOG_GC` | 269 | G1 GC | `probe_gc` |
| `INST_LOG_RUNTIME` | 145 | 运行时/线程/信号 | `probe_runtime` |
| `INST_LOG_JIT` | 68 | JIT 编译 | `probe_jit` |
| `INST_GC_DECISION` | 46 | GC 决策 | `probe_gc` |
| `INST_LOG_CLASSLOAD` | 45 | 类加载 | `probe_class` |
| `INST_DATA_STRUCT` | 43 | 数据结构 | `probe_gc` |
| `INST_LOG_INTERP` | 29 | 解释器 | `probe_interp` |
| `INST_LOG_OOP` | 26 | 对象模型 | `probe_oop` |
| `INST_LOG_META` | 26 | 元空间 | `probe_meta` |
| `INST_LOG_SIGNAL_SAFE` | 22 | 信号安全（文件） | 无 |
| `INST_LOG_JNI` | 17 | JNI | `probe_jni` |
| `INST_GC_PHASE` | 14 | GC 阶段 | `probe_gc` |
| `INST_PHASE_RUNTIME` | 10 | 运行时阶段 | `probe_runtime` |
| `INST_LOG_SERVICE` | 6 | 服务诊断 | `probe_service` |
| `INST_LOG_JFR` | 6 | JFR | `probe_jfr` |
| `INST_LOG_SIGNAL` | 5 | 信号 | `probe_runtime` |
| `INST_PHASE_CLASSLOAD` | 5 | 类加载阶段 | `probe_class` |
| `INST_PHASE_INTERP` | 1 | 解释器阶段 | `probe_interp` |
| `INST_LOG_JVMTI` | 1 | JVMTI | `probe_jni` |
| **总计** | **794** | | |

---

## 五、已验证关键函数清单（28/28 确认存在）

### Runtime

| 函数 | 文件 | 行号 |
|------|------|------|
| `Threads::create_vm()` | `runtime/thread.cpp` | 3886 |
| `JavaThread::JavaThread(bool)` | `runtime/thread.cpp` | 1787 |
| `JavaThread::JavaThread(ThreadFunction, size_t)` | `runtime/thread.cpp` | 1851 |
| `JavaThread::~JavaThread()` | `runtime/thread.cpp` | 1878 |
| `JavaThread::run()` | `runtime/thread.cpp` | 1927 |
| `SafepointSynchronize::begin()` | `runtime/safepoint.cpp` | 156 |
| `SafepointSynchronize::end()` | `runtime/safepoint.cpp` | 527 |
| `SafepointSynchronize::block()` | `runtime/safepoint.cpp` | 859 |
| `ObjectMonitor::enter()` | `runtime/objectMonitor.cpp` | 266 |
| `ObjectMonitor::EnterI()` | `runtime/objectMonitor.cpp` | 454 |
| `ObjectMonitor::exit()` | `runtime/objectMonitor.cpp` | 921 |
| `ObjectMonitor::ExitEpilog()` | `runtime/objectMonitor.cpp` | 1304 |
| `ObjectMonitor::wait()` | `runtime/objectMonitor.cpp` | 1444 |
| `ObjectMonitor::notify()` | `runtime/objectMonitor.cpp` | 1798 |
| `SharedRuntime::generate_stubs()` | `runtime/sharedRuntime.cpp` | 101 |

### Oops / Classfile

| 函数 | 文件 | 行号 |
|------|------|------|
| `InstanceKlass::initialize()` | `oops/instanceKlass.cpp` | 697 |
| `InstanceKlass::link_class()` | `oops/instanceKlass.cpp` | 718 |
| `InstanceKlass::rewrite_class()` | `oops/instanceKlass.cpp` | 874 |
| `InstanceKlass::link_methods()` | `oops/instanceKlass.cpp` | 889 |
| `ConstantPool::klass_at_impl()` | `oops/constantPool.cpp` | 458 |
| `ConstantPool::resolve_constant_at_impl()` | `oops/constantPool.cpp` | 856 |
| `klassVtable::initialize_vtable()` | `oops/klassVtable.cpp` | 171 |
| `klassItable::initialize_itable()` | `oops/klassVtable.cpp` | 1104 |
| `SystemDictionary::resolve_or_null()` | `classfile/systemDictionary.cpp` | 250 |
| `SystemDictionary::resolve_or_fail()` | `classfile/systemDictionary.cpp` | 199 |
| `SystemDictionary::resolve_instance_class_or_null()` | `classfile/systemDictionary.cpp` | 643 |
| `ClassFileParser::parse_stream()` | `classfile/classFileParser.cpp` | 6079 |

### Interpreter / Compiler / GC

| 函数 | 文件 | 行号 |
|------|------|------|
| `InterpreterRuntime::ldc()` | `interpreter/interpreterRuntime.cpp` | 149 |
| `InterpreterRuntime::resolve_get_put()` | `interpreter/interpreterRuntime.cpp` | 701 |
| `InterpreterRuntime::resolve_invoke()` | `interpreter/interpreterRuntime.cpp` | 877 |
| `CompileBroker::compile_method()` | `compiler/compileBroker.cpp` | 1244 |
| `CompileTaskWrapper::CompileTaskWrapper()` | `compiler/compileBroker.cpp` | 254 |
| `CompileTaskWrapper::~CompileTaskWrapper()` | `compiler/compileBroker.cpp` | 271 |
| `G1CollectedHeap::do_collection_pause()` | `gc/g1/g1CollectedHeap.cpp` | 3335 |
| `G1CollectedHeap::collect()` | `gc/g1/g1CollectedHeap.cpp` | 2820 |

---

## 六、写作计划与进度

| # | 模块 | 计划 | 已完成 | 进度 | 依赖 |
|---|------|------|--------|------|------|
| 01 | JVM 启动 | 4 | 4 | ✅ 100% | 无 |
| 02 | 类加载 | 7 | 0 | ⬜ 0% | 01 |
| 03 | 对象模型 | 6 | 0 | ⬜ 0% | 02 |
| 04 | 解释器 | 4 | 0 | ⬜ 0% | 02, 03 |
| 05 | JIT 编译 | 6 | 0 | ⬜ 0% | 04 |
| 06 | GC 内存 | 10 | 3 | 🟡 30% | 03 |
| 07 | 线程与锁 | 6 | 0 | 🟡 插桩完成 | 01 |
| 08 | Safepoint | 5 | 0 | 🟡 插桩完成 | 07 |
| 09 | JNI/JVMTI | 5 | 0 | ⬜ 0% | 03, 07 |
| 10 | 服务诊断 | 5 | 0 | ⬜ 0% | 09 |
| 11 | OS 层 | 4 | 0 | 🟡 插桩完成 | 01 |
| 12 | CPU 层 | 4 | 0 | ⬜ 0% | 05 |
| **合计** | | **71** | **7** | **10%** | |

### 推荐写作顺序（按依赖）

```
01-startup ✅ → 02-classloading → 03-object-model → 04-interpreter
                                 → 06-gc-memory    → 07-thread-lock → 08-safepoint
                                                    → 05-jit-compiler
                                                    → 09-jni → 10-services
                                    11-os-layer（可并行）
                                    12-cpu-layer（可并行）
```

---

## 七、标准测试环境

```bash
# JVM 路径
JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java

# 快速测试（Xint 解释模式 + 日志）
$JAVA -Xms512m -Xmx512m -XX:+UseG1GC -Xint \
      -Xlog:probe_runtime=debug:stdout \
      -Xlog:probe_class=debug:stdout \
      -cp demo.jar com.example.Main 2>&1 | tee trace.log

# 深度分析（含 JIT）
$JAVA -Xms8g -Xmx8g -XX:+UseG1GC \
      -Xlog:probe_gc=debug:stdout \
      -Xlog:probe_jit=debug:stdout \
      -cp demo.jar com.example.Main 2>&1 | tee gc-jit.log
```

---

## 八、文档编写规范

每篇文档遵守以下结构（引自 `Doc-DataStructure-First` + `Source-Code-Depth` 规范）：

```markdown
# 标题
> 纯源码分析，基于 OpenJDK 11 slowdebug
> 方法论：程序 = 数据结构 + 算法

## 0. 核心原理（本质→为什么→怎么解决→为什么这样设计）

## 1. 数据结构全景（必须在算法之前）
### 1.x 每个结构 6 项：字段+含义+sizeof+创建位置+生命周期+值域图

## 2. 算法/流程分析
### 2.x 每个函数 4 要素：文件:行号+解决什么问题+源码+注释+设计决策

## 3. 实际验证（INST_* 日志 + GDB 双验证）

## 4. 数据结构关系图（Mermaid）

## 5. 总结（数据结构层面 + 算法层面）
```

---

## 九、Java 测试程序集

> 设计原则：每个程序精确触发目标代码路径，代码极简（20~80 行），
> 单文件独立运行，日志输出聚焦可控。

### 程序总览（文件名 → 阶段 → 触发路径）

| 程序 | 对应阶段 | 触发路径 | 关注日志 |
|------|---------|---------|---------|
| `P01-StartupTracer` | 阶段1 启动 | `Threads::create_vm()` 全流程 | `INST_PHASE_RUNTIME` |
| `P02-ClassLoadTracer` | 阶段2 类加载 | ClassFileParser → link → init | `INST_LOG_CLASSLOAD` `INST_PHASE_CLASSLOAD` |
| `P03-ObjectModelTracer` | 阶段3 对象模型 | new/字段访问/方法调用 | `INST_LOG_OOP` `INST_LOG_INTERP` |
| `P04-InterpBytecodeTracer` | 阶段4 解释器 | ldc/getfield/invoke/monitor 等 10+ 字节码 | `INST_LOG_INTERP` |
| `P05-ThreadLockTracer` | 阶段5 线程锁 | 线程创建 + synchronized + wait/notify | `INST_LOG_RUNTIME` |
| `P06-JITCompileTracer` | 阶段6 JIT编译 | 热点方法编译 + OSR | `INST_LOG_JIT` |
| `P07-G1AllocTracer` | 阶段7 G1 GC | TLAB/Humongous/YoungGC | `INST_LOG_GC` `INST_GC_PHASE` |
| `P08-MetaspaceTracer` | 阶段8 内存区域 | 大量类加载 + 反射 | `INST_LOG_META` `INST_LOG_CLASSLOAD` |

### 九.1 P01-StartupTracer.java —— JVM 启动追踪

```java
/** JVM 启动完整追踪
 *  用法：java -Xint -Xlog:probe_runtime=debug:stdout P01-StartupTracer
 *  关注：INST_PHASE_RUNTIME 的 7 个阶段标记
 */
public class P01_StartupTracer {
    public static void main(String[] args) {
        System.out.println("Hello JVM — startup trace complete");
    }
}
```

**关键日志搜索**：
```bash
grep "PHASE:" trace.log                    # 7 个阶段
grep "create_vm" trace.log                 # 启动全流程
grep "signal_sets_init" trace.log          # 信号初始化
grep "java.lang.System" trace.log          # 系统类加载
```

### 九.2 P02-ClassLoadTracer.java —— 类加载追踪

```java
import java.util.*;

/** 类加载完整追踪
 *  用法：java -Xint -Xlog:probe_class=debug,probe_oop=debug:stdout P02-ClassLoadTracer
 *  关注：ClassFileParser 解析阶段 → SystemDictionary 查找 → link/init
 */
public class P02_ClassLoadTracer {
    public static void main(String[] args) {
        // 触发 String 类解析（常量池 ldc）
        String s = "hello";

        // 触发 ArrayList 类加载 + 方法调用（invokevirtual → vtable）
        ArrayList<String> list = new ArrayList<>();
        list.add(s);
        list.size();

        // 自定义接口 + 实现类（触发 itable）
        Greeter g = new EnglishGreeter();
        g.greet("world");    // invokeinterface → itable
    }
}
interface Greeter { void greet(String name); }
class EnglishGreeter implements Greeter {
    public void greet(String name) {
        System.out.println("Hello, " + name + "!");
    }
}
```

**关键日志搜索**：
```bash
grep "parse_stream ENTRY" trace.log        # ClassFileParser 入口
grep "PHASE.*classfile" trace.log          # 解析各阶段
grep "SystemDictionary::resolve" trace.log # 类查找路径
grep "link_class\|rewrite_class\|initialize" trace.log  # 链接/重写/初始化
grep "initialize_vtable\|initialize_itable" trace.log   # 虚表/接口表构建
```

### 九.3 P03-ObjectModelTracer.java —— 对象模型追踪

```java
/** 对象模型追踪：分配 + 字段布局 + 方法分派
 *  用法：java -Xint -Xlog:probe_oop=debug,probe_interp=debug:stdout P03-ObjectModelTracer
 *  关注：oop 分配、klass_at_impl 常量池解析、虚表方法查找
 */
public class P03_ObjectModelTracer {
    private int    id;
    private String name;
    private long   timestamp;

    public P03_ObjectModelTracer(int id, String name) {
        this.id = id;
        this.name = name;
        this.timestamp = System.currentTimeMillis();
    }

    public int getId()        { return id; }        // getfield
    public String getName()   { return name; }      // getfield（引用类型）
    public long getTimestamp(){ return timestamp; }  // getfield（long，8字节）

    public static void main(String[] args) {
        P03_ObjectModelTracer obj = new P03_ObjectModelTracer(1, "test");  // new + invokespecial
        int    i = obj.getId();        // invokevirtual（vtable index 查找）
        String n = obj.getName();      // invokevirtual
        long   t = obj.getTimestamp(); // invokevirtual
        System.out.println(i + ", " + n + ", " + t);
    }
}
```

**关键日志搜索**：
```bash
grep "klass_at_impl\|resolve_constant" trace.log  # 常量池解析
grep "DS\[oop\]" trace.log                         # oop 数据结构 dump
grep "allocate_instance" trace.log                 # 对象分配
```

### 九.4 P04-InterpBytecodeTracer.java —— 解释器字节码追踪

```java
/** 解释器字节码追踪：覆盖 10+ 种关键字节码
 *  用法：java -Xint -Xlog:probe_interp=debug:stdout P04-InterpBytecodeTracer
 *  关注字节码：ldc / getstatic / new / dup / invokespecial / invokevirtual /
 *              getfield / putfield / monitorenter / monitorexit / return
 */
public class P04_InterpBytecodeTracer {
    private int counter;           // putfield / getfield

    public void increment() {      // aload_0 / dup / getfield / iconst_1 / iadd / putfield
        counter++;
    }

    public int getCounter() {      // aload_0 / getfield / ireturn
        return counter;
    }

    public static void main(String[] args) {
        // ldc: 字符串常量
        String label = "counter value: ";

        // new + dup + invokespecial
        P04_InterpBytecodeTracer obj = new P04_InterpBytecodeTracer();

        // getfield (counter=0) + iconst_1 + iadd + putfield (counter=1)
        obj.increment();

        // invokevirtual → getfield
        int val = obj.getCounter();

        // getstatic (System.out) + ldc + invokevirtual (println)
        System.out.println(label + val);

        // monitorenter + monitorexit
        synchronized (obj) {
            obj.increment();       // synchronized 块内的 invokevirtual
        }
    }
}
```

**关键日志搜索**：
```bash
grep "ldc:" trace.log                        # ldc 字节码
grep "resolve_get_put" trace.log             # getfield/putfield 解析
grep "resolve_invoke" trace.log              # invokevirtual 解析
grep "monitorenter\|monitorexit" trace.log   # 同步块
grep "_new:" trace.log                       # new 对象分配
```

### 九.5 P05-ThreadLockTracer.java —— 线程与锁追踪

```java
/** 线程与锁追踪：线程创建 + synchronized + wait/notify + 锁竞争
 *  用法：java -Xint -Xlog:probe_runtime=debug:stdout P05-ThreadLockTracer
 *  关注：JavaThread 创建/运行/销毁、ObjectMonitor enter/exit/wait/notify 全路径
 */
public class P05_ThreadLockTracer {
    private static final Object LOCK = new Object();
    private static volatile boolean ready = false;

    public static void main(String[] args) throws Exception {
        // 1. 线程创建与启动（JavaThread 构造 → create_thread → run）
        Thread worker = new Thread(() -> {
            // 2. 无竞争快速加锁（FAST_PATH uncontended CAS）
            synchronized (LOCK) {
                ready = true;
                try {
                    // 3. wait + notify（ObjectMonitor 等待/唤醒）
                    LOCK.wait(100);
                } catch (InterruptedException e) { }
            }
        }, "Worker-1");
        worker.start();

        // 4. 主线程竞争同一把锁（EnterI 慢路径）
        synchronized (LOCK) {
            while (!ready) {
                LOCK.wait(10);    // wait 重入
            }
            LOCK.notifyAll();     // notify 唤醒 worker
        }

        worker.join();            // 线程退出 → 析构
    }
}
```

**关键日志搜索**：
```bash
grep "ThreadCreate\|ThreadDestroy" trace.log   # 线程创建/销毁
grep "ObjectMonitor::enter" trace.log          # 加锁全路径（CAS→自旋→EnterI）
grep "ObjectMonitor::EnterI" trace.log         # 慢路径
grep "ObjectMonitor::wait\|notify" trace.log   # wait/notify
grep "ObjectMonitor::exit\|ExitEpilog" trace.log  # 解锁
grep "SPIN_WON\|early_spin FAILED" trace.log   # 自旋结果分支
```

### 九.6 P06-JITCompileTracer.java —— JIT 编译追踪

```java
/** JIT 编译追踪：热点方法编译 + OSR 栈上替换
 *  用法：java -Xlog:probe_jit=debug:stdout -XX:+PrintCompilation P06-JITCompileTracer
 *  注意：不加 -Xint，让 JIT 自然触发
 *  关注：compile_method 触发、CompileTaskWrapper 生命周期、分层编译升级
 */
public class P06_JITCompileTracer {

    // 热点方法1：纯计算，触发 C1 编译
    static long hotLoop(int n) {
        long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += i * i;
        }
        return sum;
    }

    // 热点方法2：字符串操作，触发 C2 编译（profile 充足后）
    static String hotString(int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            sb.append(i % 10);
        }
        return sb.toString();
    }

    public static void main(String[] args) {
        long total = 0;
        // 循环 10000 次 → hotLoop 热点触发编译
        for (int i = 0; i < 10_000; i++) {
            total += hotLoop(100);
        }
        // 循环 5000 次 → hotString 热点触发编译
        String result = "";
        for (int i = 0; i < 5_000; i++) {
            result = hotString(50);
        }
        System.out.println("total=" + total + ", last=" + result);
    }
}
```

**关键日志搜索**：
```bash
grep "compile_method:" trace.log              # 编译提交
grep "CompileTaskWrapper START\|DONE" trace.log  # 编译任务开始/完成
grep "REJECTED" trace.log                     # 编译被拒原因
grep "CompileTask::set_code" trace.log        # 编译结果安装
```

### 九.7 P07-G1AllocTracer.java —— G1 GC 追踪

```java
import java.util.ArrayList;

/** G1 分配与 GC 追踪：TLAB 分配 / Humongous 对象 / Young GC 触发
 *  用法：java -Xms256m -Xmx256m -XX:+UseG1GC \
 *            -Xlog:probe_gc=debug:stdout \
 *            -Xlog:probe_runtime=debug:stdout \
 *            -cp . P07-G1AllocTracer
 *  注意：256MB 堆 → 1MB Region（快速触发 GC）
 *  关注：TLAB refill、Humongous 分配、Young GC pause 全路径
 */
public class P07_G1AllocTracer {
    public static void main(String[] args) {
        ArrayList<byte[]> list = new ArrayList<>();

        // Phase 1: 小对象 TLAB 分配（不触发 GC）
        for (int i = 0; i < 100; i++) {
            list.add(new byte[1024]);        // 1KB 对象 → TLAB 分配
        }

        // Phase 2: 中等对象分配 → 触发 Young GC
        for (int i = 0; i < 50; i++) {
            list.add(new byte[512 * 1024]);  // 512KB 对象 → 可能导致 TLAB refill
        }

        // Phase 3: Humongous 对象（> 512KB，Region 大小一半）
        byte[] humongous = new byte[600 * 1024];  // 600KB → Humongous Region

        // Phase 4: 释放一半，触发 Mixed/Full GC
        for (int i = 0; i < list.size() / 2; i++) {
            list.set(i, null);
        }

        System.gc();  // 显式触发 GC
        System.out.println("humongous size=" + humongous.length + ", list size=" + list.size());
    }
}
```

**关键日志搜索**：
```bash
grep "GC PHASE:" trace.log                   # GC 各阶段
grep "TLAB\|tlob" trace.log                  # TLAB 分配
grep "Humongous\|humongous" trace.log        # 大对象分配
grep "Young GC\|do_collection_pause" trace.log  # Young GC
grep "DECISION:" trace.log                   # GC 决策分支
```

### 九.8 P08-MetaspaceTracer.java —— 元空间追踪

```java
import java.lang.reflect.*;

/** 元空间追踪：类加载 → Metaspace 分配 → Reflection 元数据
 *  用法：java -Xint \
 *            -Xlog:probe_meta=trace:stdout \
 *            -Xlog:probe_class=debug:stdout \
 *            -cp . P08-MetaspaceTracer
 *  注意：probe_meta 是 trace 级别
 *  关注：Metaspace 分块分配、ClassLoaderData、Klass 元数据创建
 */
public class P08_MetaspaceTracer {

    static class InnerA { int x; }
    static class InnerB { long y; String z; }
    static class InnerC { double a; float b; }
    static class InnerD implements java.io.Serializable { }
    static class InnerE extends InnerD { int[] arr; }

    public static void main(String[] args) throws Exception {
        // 加载内部类（触发 Klass 创建 → Metaspace 分配）
        Class<?>[] classes = {
            InnerA.class, InnerB.class, InnerC.class,
            InnerD.class, InnerE.class
        };

        // 反射访问（触发 ConstantPool 和 Method 元数据）
        for (Class<?> c : classes) {
            for (Field f : c.getDeclaredFields()) {
                System.out.println(c.getSimpleName() + "." + f.getName());
            }
        }

        // 动态代理（生成新类 → Metaspace）
        InvocationHandler handler = (proxy, method, args1) -> "proxy result";
        Runnable proxy = (Runnable) Proxy.newProxyInstance(
            P08_MetaspaceTracer.class.getClassLoader(),
            new Class<?>[] { Runnable.class },
            handler
        );
        proxy.run();

        System.out.println("Metaspace trace complete");
    }
}
```

**关键日志搜索**：
```bash
grep "probe_meta" trace.log                  # 元空间分配
grep "InstanceKlass::link_class" trace.log   # 类链接
grep "DS\[InstanceKlass\]" trace.log         # Klass 数据结构创建
grep "ClassLoaderData" trace.log             # 类加载器数据
```

---

## 十、测试程序编译与运行脚本

### 编译（已完成 ✅）

```bash
# 源码位置：probe_md/test-programs/
# 编译输出：probe_md/test-programs/classes/
cd probe_md/test-programs
javac -d classes *.java
# 8 个文件全部编译通过
```

### 运行

```bash
JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java
CP=probe_md/test-programs/classes
LOG=probe_md/logs
mkdir -p $LOG

# P01: 启动（已实测通过 ✅）
$JAVA -Xint -Xlog:probe_runtime=debug:stdout -cp $CP P01_StartupTracer 2>&1 | tee $LOG/01-startup.log

# P02: 类加载（已实测通过 ✅）
$JAVA -Xint -Xlog:probe_class=debug,probe_oop=debug:stdout -cp $CP P02_ClassLoadTracer 2>&1 | tee $LOG/02-classload.log

# P03: 对象模型
$JAVA -Xint -Xlog:probe_oop=debug,probe_interp=debug:stdout -cp $CP P03_ObjectModelTracer 2>&1 | tee $LOG/03-object.log

# P04: 解释器
$JAVA -Xint -Xlog:probe_interp=debug:stdout -cp $CP P04_InterpBytecodeTracer 2>&1 | tee $LOG/04-interp.log

# P05: 线程锁（已实测通过 ✅）
$JAVA -Xint -Xlog:probe_runtime=debug:stdout -cp $CP P05_ThreadLockTracer 2>&1 | tee $LOG/05-thread.log

# P06: JIT（不加 -Xint）
$JAVA -Xlog:probe_jit=debug:stdout -XX:+PrintCompilation -cp $CP P06_JITCompileTracer 2>&1 | tee $LOG/06-jit.log

# P07: G1 GC
$JAVA -Xms256m -Xmx256m -XX:+UseG1GC -Xlog:probe_gc=debug:stdout -cp $CP P07_G1AllocTracer 2>&1 | tee $LOG/07-gc.log

# P08: Metaspace
$JAVA -Xint -Xlog:probe_meta=trace,probe_class=debug:stdout -cp $CP P08_MetaspaceTracer 2>&1 | tee $LOG/08-meta.log
```

### 注意事项

1. **ResourceMark**：`INST_LOG_CLASSLOAD`、`INST_LOG_OOP`、`INST_LOG_INTERP`、`INST_LOG_JIT` 已内置 `ResourceMark`，可安全使用 `Symbol::as_C_string()`
2. **thread_native_entry 限制**：native 线程入口处不能调用 `Thread::name()`（无 ResourceMark + Thread::current() 可能为 NULL），已改用 `p2i(thread)` / `osthread_id`
3. **INST_GC_DECISION**：使用独立宏展开，避免 `##__VA_ARGS__` 多级嵌套问题

---

> 最后更新: 2026-05-20
> 基于 794 处 INST_* 插桩 + 28/28 关键函数源码验证
> 新增：8 个阶段专用测试程序 + 编译/运行脚本
