# 01 - JVM 启动与初始化

> 源码索引：`source_index/02-runtime.md` (runtime 173文件)
> 核心入口：`runtime/thread.cpp:3884` Threads::create_vm()
> 插桩覆盖：`-Xlog:probe_runtime=debug` (13 个运行时探针)

---

## 〇、上手指南 ⭐（新手必读）

### 0.1 本文档适合谁？

| 水平 | 特征 | 建议路径 |
|------|------|---------|
| 🟢 初级 | 会用 Java，知道 JVM 是个"黑盒子"，没读过源码 | 先读本节 → 入门路径 |
| 🟡 中级 | 读过 JVM 文章，知道堆/栈/GC 概念，想系统学习 | 入门路径速览 → 进阶路径 |
| 🔴 高级 | 读过部分 JVM 源码，需要参考手册 | 直接进进阶路径 → 按需查阅 |

### 0.2 你需要什么基础？

| 必须 | 可选但更好 |
|------|-----------|
| C/C++ 能读懂基础语法（指针/类/继承） | 接触过 OpenJDK 源码目录结构 |
| Linux 基础命令（`ps`/`pmap`/`cat /proc`） | 用过 GDB 调试 C++ 程序 |
| 知道 Java 代码怎么变成字节码的 | 读过 G1 GC 的基本概念 |

### 0.3 JVM 启动的本质（三句话）

> 你在命令行敲下 `java Main`，到 `main()` 方法被执行，中间发生了什么？

```
java 命令 → libjli.so 加载 libjvm.so → JNI_CreateJavaVM() → Threads::create_vm()
```

JVM 启动就是 `Threads::create_vm()` 这个函数在 2 秒内：

1. **建立地基**（0~0.01s）：初始化 CPU 特性、操作系统接口、解析 `-Xms -Xmx` 等参数
2. **搭建骨架**（0.01~0.22s）：创建 8GB 堆（2048 个 Region）、模板解释器（274KB 机器码）、CodeCache（48MB）
3. **装载灵魂**（0.22~2.18s）：加载 Object/String/Thread 等 200+ Java 核心类、初始化模块系统、启动编译器线程

**本文档就是把这 2 秒掰开揉碎，告诉你每一毫秒 JVM 到底做了什么。**

### 0.4 核心术语速查表

| 术语 | 一句话解释 | 出现位置 |
|------|----------|---------|
| **Safepoint** | JVM 让所有线程"暂停"的点，GC 必须在此执行 | 05 §阶段1, 15 §3.2 |
| **TLAB** | Thread-Local Allocation Buffer，每个线程私有的堆上分配缓冲区（无锁快分配） | 02 §2.2, 03 §十 |
| **RSet** (Remembered Set) | G1 记录"谁引用了我"，避免全堆扫描 | 03 §八 |
| **SATB** (Snapshot At The Beginning) | G1 并发标记的"快照"算法，防止漏标 | 03b §四 |
| **IHOP** (Initiating Heap Occupancy Percent) | 决定何时启动并发标记的阈值 | 03b §1.3 |
| **Card Table** | 512B/卡的"脏页标记"数组，写屏障更新 | 01 §四 |
| **CSet** (Collection Set) | 本次 GC 要回收的 Region 集合 | 03b §二 |
| **CompressedOops** | 64位下用32位存对象指针的压缩技术 | 06 §2 |
| **Metaspace** | 存放类元数据（Class/Method/ConstantPool）的内存区 | 01 §八, 02 §一 |
| **CodeCache** | 存放 JIT 编译后机器码的内存区 | 01 §六, 10 §3.2 |

### 0.5 如何阅读本文档？三条路径

**🟢 入门路径**（预计 2-3 小时，得"骨架"）：

```
1. 先看本节（0.1-0.5）                                ← 你现在在这里
2. 01-JVM-Startup-Structure-Init.md（只看第 §一~§四）   ← 建立"什么阶段做了什么"的感觉
3. 04-Threads-create-vm-Trace.md（只看 Mermaid 图和总结）← 建立"17 个阶段按什么顺序"的认知
4. 02-All-Core-Structures.md（只扫表格，不读细节）      ← 知道"有哪些结构"
5. 05-create_vm-Deep-Dive.md（只看 §一概述 + §七总结）  ← 理解 create_vm 的设计哲学
```

**🟡 进阶路径**（预计 5-8 小时，得"血肉"）：

```
在入门路径基础上：
6. 03-Structure-Fields-Deep.md  §一~§五（HeapRegion/G1CM/ObjectMonitor/InstanceKlass/Method）
7. 06-universe_init-Deep-Dive.md                    ← 堆是怎么建起来的
8. 10-interpreter_init-Deep-Dive.md                 ← 解释器是怎么生成的
9. 17-call_initPhase2-3-Deep-Dive.md                ← 模块系统为什么耗时 1.2s
10. 15-Thread-Mutex-JVMFlag-Deep-Dive.md            ← 线程/锁/参数系统
```

**🔴 专家路径**（按需查阅）：

| 你想了解 | 直接看 |
|---------|--------|
| 一个 Region 有哪些字段，每个字段干嘛的 | 03 §一 |
| ObjectMonitor 的 wait/notify 怎么实现的 | 03 §三 |
| G1Policy 怎么决定何时回收 | 03b §一 |
| SATB 队列是怎么工作 | 03b §四 |
| 8GB 堆在 /proc/maps 中长什么样 | 21-JVM-Memory-Layout-Real.md |
| G1CMBitMap 2MB 还是 128MB？（已修复） | 01 §五, 03 §二 |

### 0.6 环境准备（如果你想自己跑 GDB）

```bash
# 1. 编译 slowdebug 版 JVM（已完成，本仓库使用 build/ 下已编译的版本）
# 2. 准备一个简单的 Java 程序
echo 'public class Demo { public static void main(String[] a) throws Exception {
  System.out.println("hello"); Thread.sleep(99999); }}' > /tmp/Demo.java
javac /tmp/Demo.java

# 3. GDB 附加调试
gdb --args build/linux-x86_64-normal-server-slowdebug/jdk/bin/java -Xms512m -Xmx512m -XX:+UseG1GC -Xint -cp /tmp Demo

# 4. 在 GDB 中设断点
(gdb) break Threads::create_vm
(gdb) run
(gdb) p sizeof(G1Policy)        # 现在可以了！
```

---

## 一、启动链

```
java 命令
  └── libjli.so (启动器)
        └── JNI_CreateJavaVM()
              └── libjvm.so 加载
                    └── Threads::create_vm() ← ★ 核心入口 (thread.cpp:3884)
```

## 二、核心源码文件

| 文件 | 核心内容 | 关键行号 |
|------|---------|---------|
| `runtime/thread.cpp` | `Threads::create_vm()` | 3884-4161 |
| `runtime/init.cpp` | `init_globals()` | 141 |
| `runtime/arguments.cpp` | `Arguments::parse()` / `parse_vm_init_args()` | 2257 |
| `runtime/mutexLocker.cpp` | `mutex_init()` — 80+ Mutex/Monitor | 194 |
| `runtime/os.cpp` | `os::init()` / `os::init_2()` | |
| `runtime/vm_version.cpp` | `VM_Version::initialize()` | |
| `os/linux/os_linux.cpp` | `os::Linux::init()` + 信号处理器 | 593 (signal_sets_init), 5370 (install_signal_handlers) |
| `os_cpu/linux_x86/os_linux_x86.cpp` | 上下文/栈帧/寄存器 | |
| `cpu/x86/vm_version_x86.cpp` | CPU 特性检测 (CPUID) | 1728 |
| `interpreter/templateInterpreter.cpp` | TemplateInterpreter::initialize() | 42 |
| `utilities/instrumentLog.cpp` | InstrumentLog::initialize() | 14 |

## 三、Threads::create_vm() 的 15 个阶段

```
thread.cpp:3884  Threads::create_vm()
  ├── 1. VM_Version::early_initialize()     ← 检测 CPU 指令集
  ├── 2. ThreadLocalStorage::init()          ← TLS
  ├── 3. ostream_init()                      ← 输出流
  ├── 4. os::init()                          ← ★ 系统初始化(信号/时钟/page_size)
  ├── 5. InstrumentLog::initialize()         ← ★ 插桩日志启动 (3909)
  ├── 6. Arguments::init_system_properties() ← 系统属性
  ├── 7. LogConfiguration::initialize()      ← JVM统一日志 (3930)
  ├── 8. Arguments::parse()                  ← ★ 解析 -Xlog/-Xms/-Xmx/-XX: (3935)
  ├── 9. os::init_before_ergo()             ← 调优前置(NUMA/大页)
  ├── 10. Arguments::apply_ergo()           ← 自动调优
  ├── 11. os::init_2()                       ← 线程/信号第二阶段
  ├── 12. SafepointMechanism::initialize()   ← Polling Page
  ├── 13. Universe::genesis()               ← 创建核心 Klass(Object/Class/String...)
  ├── 14. init_globals()                     ← ★ 编译器/解释器/GC/VTable初始化 (4073)
  │       ├── bytecodes_init()
  │       ├── compilationPolicy_init()
  │       ├── codeCache_init()
  │       ├── stubRoutines_init()
  │       ├── universe_init()               ← ★ 创建 Java 堆
  │       ├── interpreter_init()            ← TemplateInterpreter::initialize()
  │       ├── invocationCounter_init()
  │       └── ...
  ├── 15. set_init_completed()               ← 基础VM初始化完成
  ├── 16. LogConfiguration::post_initialize() ← (4158)
  └── 17. InstrumentLog::mark_jvm_logging_ready() ← ★ 切换到JVM统一日志 (4161)
```

## 四、JVM 参数系统

```
Arguments::parse() (arguments.cpp:2257)
  ├── parse_vm_init_args()         ← JavaVMInitArgs 四重来源
  │     ├── -XX:Flags (vm_options_args)
  │     ├── JAVA_TOOL_OPTIONS 环境变量
  │     ├── _JAVA_OPTIONS 环境变量
  │     └── 命令行参数
  ├── 每个参数 → parse_each_vm_init_arg()
  │     ├── -Xms/-Xmx → set_heap_size()
  │     ├── -Xss → set_thread_stack_size()
  │     ├── -XX:+UseG1GC → set_gc_policy()
  │     ├── -Xlog:... → LogConfiguration::configure_output()
  │     └── -Dkey=value → add_property()
  └── apply_ergo() → 自动调整未设置的参数
```

## 五、Mutex 层级

```
mutexLocker.cpp:194 mutex_init()
  每个 Mutex/Monitor 有 rank 属性:
    event → special → suspend_resume → leaf → safepoint → ...
  
  关键锁:
    Threads_lock        (Monitor)  ← 线程列表保护
    VMOperationQueue_lock (Monitor) ← VM操作队列
    Safepoint_lock      (Monitor)  ← Safepoint 同步
    Heap_lock           (Monitor)  ← 堆操作
    SystemDictionary_lock (Monitor) ← 类字典
    CodeCache_lock      (Monitor)  ← 编译代码缓存
```

## 六、探针覆盖

| 探针 | 来源 | 数据内容 |
|------|------|---------|
| `Threads::create_vm() starting` | thread.cpp:3910 | InstrumentLog 就绪标记 |
| `init_globals()` Phase | thread.cpp:4072 | 进入阶段 |
| `set_init_completed()` | thread.cpp:4156 | 基础VM完成 |
| `mutex_init() done` | mutexLocker.cpp | 80+ mutex 初始化完成 |
| `Arguments::parse_vm_init_args()` | arguments.cpp | 参数解析入口 |
| `VM_Version::initialize()` | vm_version_x86.cpp | CPU特性检测 |
| `SafepointMechanism::default_initialize` | safepointMechanism.cpp | ThreadLocalHandshakes |
| `ICache::initialize()` | icache.cpp | 指令缓存大小 |
| `TemplateInterpreter::initialize()` | templateInterpreter.cpp | InterpreterCodeSize |
| `CardTable CREATED` | cardTable.cpp | heap地址/card_size/page_size |
| `Space::initialize` | space.cpp | start/end 地址 |
| `libjsig LOADED` | os_linux.cpp | ★ begin/end信号设置函数地址 |
| `signalHandler` | os_linux.cpp | ★ 信号到达 (仅write()) |

## 七、早期日志说明

```
阶段 5-16 之间: 日志写入 /tmp/jvm_instrument_<pid>.log (fileStream)
阶段 17 之后:    日志通过 -Xlog:probe_*=debug 输出到 stdout
```

## 八、文档清单（共 23 篇）

### 概览层
| # | 文档 | 内容 |
|---|------|------|
| README | README.md | 专题索引 + 启动链概览 |
| 01 | 01-JVM-Startup-Structure-Init.md | 数据结构初始化全景 + 内存布局 |
| 02 | 02-All-Core-Structures.md | 全部核心结构总表（34 结构） |
| 03 | 03-Structure-Fields-Deep.md | 20 个结构字段级深度分析 |
| 03b | 03b-Missing-Structures-Deep.md | 补齐 7 个缺失结构（G1Policy/CollectionSet/HotCardCache/SATB/Mutex/PRT/SparsePRT）⭐ NEW |

### 流程追踪层
| # | 文档 | 内容 |
|---|------|------|
| 04 | 04-Threads-create-vm-Trace.md | create_vm() 17 阶段完整追踪 + GDB 脚本 |
| 05 | 05-create_vm-Deep-Dive.md | create_vm() 深度分析（Phase 0-4）+ 反向验证表 |
| 17 | 17-call_initPhase2-3-Deep-Dive.md | Phase 5-8 深度分析（类加载/编译/模块系统/Live Phase）⭐ NEW |

### 子组件深度层
| # | 文档 | 内容 |
|---|------|------|
| 06 | 06-universe_init-Deep-Dive.md | Universe 初始化（堆 + Metaspace） |
| 07 | 07-G1CollectedHeap-Initialize-Deep-Dive.md | G1 堆 12 步初始化（~115ms） |
| 08 | 08-HeapRegionManager-Deep-Dive.md | HeapRegionManager 分析 |
| 09 | 09-G1ConcurrentMark-Constructor-Deep-Dive.md | G1ConcurrentMark 构造 |
| 10 | 10-interpreter_init-Deep-Dive.md | 模板解释器初始化 + 反向验证表 |
| 11 | 11-universe2_init-Deep-Dive.md | 原始类加载 |
| 12 | 12-javaClasses_init-Deep-Dive.md | 核心类字段偏移 |
| 13a | 13a-universe_post_init-Deep-Dive.md | Universe 后初始化 |
| 13b | 13b-Compiler-Stubs-MH-Deep-Dive.md | 编译器桩 + MethodHandle |
| 14 | 14-create_vm-Stage5-8-Deep-Dive.md | 阶段 5-8 概览（已被 17 替代） |
| 15 | 15-Thread-Mutex-JVMFlag-Deep-Dive.md | 线程/锁/参数系统 + 反向验证表 |
| 16 | 16-G1Policy-SubComponents-Deep-Dive.md | G1Policy 子组件 |
| 18 | 18-Interpreter-Template-Dispatch-Deep-Dive.md | 解释器模板分派 |

### 验证层
| # | 文档 | 内容 |
|---|------|------|
| 21 | 21-JVM-Memory-Layout-Real.md | /proc/maps + pmap + GDB 三方交叉验证 |

---

## 九、最终覆盖率表

| 结构名 | sizeof(GDB) | 完整字段列表 | 设计原因 | GDB验证 | 状态 |
|--------|:---:|:---:|:---:|:---:|:---:|
| G1CollectedHeap | ✅ 1864 | ✅ | ✅ | ✅ | ✅ |
| HeapRegionManager | ✅ 208 | ✅ | ✅ | ✅ | ✅ |
| HeapRegion | ✅ 432 | ✅ | ✅ | ✅ | ✅ |
| G1ConcurrentMark | ✅ 1840 | ✅ | ✅ | ✅ | ✅ |
| G1CMTask | ✅ 392 | ✅ | ✅ | ✅ | ✅ |
| G1CMBitMap | ✅ 56+128MB | ✅ | ✅ | ✅ | ✅ |
| G1RemSet | ✅ 120 | ✅ | ✅ | ✅ | ✅ |
| OtherRegionsTable | ✅ 136 | ✅ | ✅ | ✅ | ✅ |
| G1CardTable | ✅ 136 | ✅ | ✅ | ✅ | ✅ |
| CardTable byte_map | ✅ 16MB | N/A | N/A | ✅ | ✅ |
| G1Allocator | ✅ 224 | ✅ | ✅ | ✅ | ✅ |
| TLAB | ✅ 144 | ✅ | ✅ | ✅ | ✅ |
| G1Policy | ✅ 552 | ✅ | ✅ | ✅ GDB | ✅ |
| G1CollectionSet | ✅ 128 | ✅ | ✅ | ✅ GDB | ✅ |
| G1HotCardCache | ✅ 384 | ✅ | ✅ | ✅ | ✅ |
| SATBMarkQueueSet | ✅ 160 | ✅ | ✅ | ✅ GDB | ✅ |
| ObjectMonitor | ✅ 216 | ✅ | ✅ | ✅ | ✅ |
| InstanceKlass | ✅ 600-2000 | ✅ | ✅ | ✅ | ✅ |
| Method | ✅ 104 | ✅ | ✅ | ✅ GDB | ✅ |
| ConstantPool | ✅ 72 | ✅ | ✅ | ✅ GDB | ✅ |
| ConstantPoolCache | ✅ 40 | ✅ | ✅ | ✅ GDB | ✅ |
| JavaThread | ✅ 1888 | ✅ | ✅ | ✅ | ✅ |
| OSThread | ✅ 232 | ✅ | ✅ | ✅ | ✅ |
| Thread (base) | ✅ 856 | ✅ | ✅ | ✅ | ✅ |
| JVMFlag | ✅ 48 | ✅ | ✅ | ✅ | ✅ |
| Mutex | ✅ 152 | ✅ | ✅ | ✅ | ✅ |
| Symbol | ✅ 6+len | ✅ | ✅ | ✅ | ✅ |
| DictionaryEntry | ✅ 40 | ✅ | ✅ | ✅ GDB | ✅ |
| ClassLoaderData | ✅ 168 | ✅ | ✅ | ✅ GDB | ✅ |
| VirtualSpaceNode | ✅ 208 | ✅ | ✅ | ✅ GDB | ✅ |
| Metachunk | ✅ 64 | ✅ | ✅ | ✅ GDB | ✅ |
| SpaceManager | ✅ 104 | ✅ | ✅ | ✅ GDB | ✅ |
| nmethod | ✅ 392 | ✅ | ✅ | ✅ GDB | ✅ |
| PerRegionTable | ✅ 72 | ✅ | ✅ | ✅ GDB | ✅ |
| SparsePRT | ✅ 40 | ✅ | ✅ | ✅ GDB | ✅ |

**统计**：
- ✅ 完成：35/35（100%）
- 🟡 部分完成：0/35
- ❌ 未分析：0/35

> 🎉 全部 35 个结构：sizeof（GDB 实测）+ 完整字段列表 + 设计原因分析 + GDB 验证，四项俱全。
> 编译参数：`-femit-class-debug-always` 注入 `flags-cflags.m4` 和 `spec.gmk`，GCC 12 实测有效。

---

## 十、面试高频问题 × 文档直接对应

| 面试问题 | 直接看这篇 | 为什么这篇能回答 |
|----------|-----------|----------------|
| "`java Main` 到 `main()` 执行，中间发生了什么？" | 04-Threads-create_vm-Trace.md | 17 阶段完整追踪，每阶段有耗时 + 调用链 |
| "为什么 `-Xms` 和 `-Xmx` 设为一样？" | 01-JVM-Startup-Structure-Init.md | 堆初始化流程 + ergo 决策逻辑（§四参数系统 + §六堆创建） |
| "JVM 启动时创建了多少个线程？" | 15-Thread-Mutex-JVMFlag-Deep-Dive.md + 04 | 15 §线程创建时间线（JavaThread/CompilerThread/VmThread/WatcherThread/GC task threads × N） |
| "G1 堆从 0 到 8GB 的具体步骤？" | 07-G1CollectedHeap-Initialize-Deep-Dive.md | G1CollectedHeap 12 步初始化（~115ms）：mmap → CardTable → HotCardCache → 5×Mapper → 2048 Regions → G1RemSet → SATB → Policy |
| "TemplateInterpreter 是什么？为什么需要？" | 10-interpreter_init-Deep-Dive.md | 239 条字节码 → 机器码模板生成 + StubQueue/DispatchTable 设计理由 |
| "Symbol 表为什么用 `Symbol` 而不是 `String`？" | 03-Structure-Fields-Deep.md | Symbol 字段级分析：`_length+_refcount+_identity_hash` 三合一头部（6 byte overhead），vs String 的 24 byte 对象头 |
| "Safepoint 在启动阶段什么时候第一次出现？" | 04-Threads-create_vm-Trace.md | Phase 12（SafepointMechanism::initialize()）— Polling Page 创建，早于 init_globals() |
| "G1CMBitMap 为什么是这个大小？" | 03b-Missing-Structures-Deep.md | bitmap sizing 推导：Region 4MB / 对象对齐 8B × 2 bits = 1MB per Region，含设计理由 |
| "`-XX:+UseG1GC` 和 `-XX:+UseSerialGC` 启动流程哪里分叉？" | 01-JVM-Startup-Structure-Init.md + 07 | 01 的 init_globals() 中通过 `UseG1GC` 标志分叉到 G1CollectedHeap::initialize() vs GenCollectedHeap |
| "Metaspace 和 Heap 在启动阶段哪个先初始化？" | 06-universe_init-Deep-Dive.md | Metaspace 在 Universe::genesis()（Phase 13），Heap 在 universe_init()（Phase 14 内子步骤）— Metaspace 先于 Heap |
| "CodeCache 48MB 是怎么定出来的？" | 10-interpreter_init-Deep-Dive.md + 05 | 10 §3.2 CodeCache 划分（non-method/method/profiled/non-profiled），05 的 codeCache_init() 逻辑 |
| "启动阶段最耗时的是哪一步？" | 17-call_initPhase2-3-Deep-Dive.md | Phase 5-8 深度分析：模块系统 call_initPhase2 耗时 ~1.2s，占启动总时间的 55%+ |

---

## 十一、生产故障 × 文档诊断指引

| 生产场景 | 症状 | 看这篇 | 怎么诊断 |
|---------|------|--------|---------|
| 启动慢 (>5s) | `java -version` 卡住数秒 | 04-Threads-create_vm-Trace.md + 17 | 04 提供 17 阶段耗时拆分（按 Phase 1-17 逐段定位），17 提供 Phase 5-8 细分（模块系统/类加载瓶颈） |
| RSS > -Xmx | `top` 显示 RES 10GB，`-Xmx`=4GB | 21-JVM-Memory-Layout-Real.md | `/proc/<pid>/maps` 对照：堆外内存（CodeCache + Metaspace + 线程栈 × N + G1 辅助结构 + mmap 元数据）逐一核算 |
| GC 日志异常 | Full GC 频繁、Mixed GC 不触发 | 01-JVM-Startup-Structure-Init.md + 07 | 01 验证 Region 大小 = Heap/2048 是否如预期；07 检验 G1Policy 阈值（IHOP/G1ReservePercent）是否在 init 时被意外覆盖 |
| Metaspace 初始占 20MB | 还没加载类就 `NMT` 显示 Metaspace 20MB | 06-universe_init-Deep-Dive.md | Universe::genesis() 在 Metaspace 创建 200+ 核心 Klass（Object/Class/String/Thread 等）+ ConstantPool 预分配 |
| 参数不生效 | `-XX:+UnlockExperimentalVMOptions` 或 `-XX:MaxGCPauseMillis=100` 没反应 | 01-JVM-Startup-Structure-Init.md + 04 | 01 §四参数系统说明四重来源（`-XX:Flags` → `JAVA_TOOL_OPTIONS` → `_JAVA_OPTIONS` → 命令行）的覆盖顺序；04 Phase 8 追踪 `Arguments::parse()` 的 exact 调用链 |
| 线程数爆炸 | `top -H` 显示 200+ 线程 | 15-Thread-Mutex-JVMFlag-Deep-Dive.md | 15 的线程创建时间线：区分 JVM 自身线程（CompilerThread×N、GC task threads×(N workers)、WatcherThread、ServiceThread 等）vs 应用线程 |
| 大页配置无效 | `-XX:+UseLargePages` 设了但 `pmap` 还是 4KB | 01-JVM-Startup-Structure-Init.md + 07 | 01 Phase 9（os::init_before_ergo）检查 NUMA/大页设置；07 Step 1 reserve_heap 检查页对齐是否满足大页对齐要求 |
| `os::init()` 失败 | 启动崩溃在信号安装阶段 | 04-Threads-create_vm-Trace.md | 04 Phase 4 信号处理器安装（`os_linux.cpp::install_signal_handlers`）— 检查与 libjsig 的冲突 |

---

## 十二、深度评审检查点（自检 23 篇已写文档是否达标）

| # | 文档 | 生产故障可直接参考？ | 面试题可直接回答？ | 解释了"为什么这样设计"？ | sizeof 是 GDB 实测？ | 评级 |
|---|------|:---:|:---:|:---:|:---:|:---:|
| README | README.md | ✅ | ✅ | ✅ | N/A | ✅ |
| 01 | 01-JVM-Startup-Structure-Init.md | ✅ (参数不生效/GC异常) | ✅ (Xms=Xmx/GC分叉) | ✅ (启动三阶段设计) | N/A | ✅ |
| 02 | 02-All-Core-Structures.md | ⚠️ 需补充 | ✅ (结构全景) | ⚠️ 以"是什么"为主 | N/A | 🟡 |
| 03 | 03-Structure-Fields-Deep.md | ⚠️ 需补充 | ✅ (Symbol vs String) | ✅ (每个字段的设计理由) | ✅ | ✅ |
| 03b | 03b-Missing-Structures-Deep.md | ⚠️ 需补充 | ✅ (G1CMBitMap大小) | ✅ (SATB/Mutex层级设计) | ✅ | ✅ |
| 04 | 04-Threads-create_vm-Trace.md | ✅ (启动慢/参数/os::init) | ✅ ("java Main 全过程") | ⚠️ 以追踪为主 | N/A | 🟡 |
| 05 | 05-create_vm-Deep-Dive.md | ⚠️ 需补充 | ✅ (Phase 0-4 设计) | ✅ (Safepoint为什么早于GC) | N/A | 🟡 |
| 06 | 06-universe_init-Deep-Dive.md | ✅ (Metaspace初始占用) | ✅ (Metaspace vs Heap顺序) | ✅ (CompressedOops vs ZeroBasedNarrowOop) | ✅ | ✅ |
| 07 | 07-G1CollectedHeap-Initialize-Deep-Dive.md | ✅ (大页/Region大小) | ✅ (G1 12步) | ✅ (5×Mapper架构设计) | ✅ | ✅ |
| 08 | 08-HeapRegionManager-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ✅ (Region管理设计) | ✅ | 🟡 |
| 09 | 09-G1ConcurrentMark-Constructor-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ✅ (并发标记构造阶段) | ✅ | 🟡 |
| 10 | 10-interpreter_init-Deep-Dive.md | ⚠️ 需补充 | ✅ (TemplateInterpreter) | ✅ (解释器为什么用模板表) | ✅ | ✅ |
| 11 | 11-universe2_init-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ⚠️ 需重写(缺设计理由) | ⚠️ 需验证 | 🔴 |
| 12 | 12-javaClasses_init-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ⚠️ 以字段偏移为主 | ⚠️ 需验证 | 🔴 |
| 13a | 13a-universe_post_init-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ⚠️ 需重写 | ⚠️ 需验证 | 🔴 |
| 13b | 13b-Compiler-Stubs-MH-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ⚠️ 需重写 | ⚠️ 需验证 | 🔴 |
| 14 | 14-create_vm-Stage5-8-Deep-Dive.md | ⚠️ 已被17替代 | ⚠️ 已被17替代 | ⚠️ 已被17替代 | N/A | 🟡 (历史) |
| 15 | 15-Thread-Mutex-JVMFlag-Deep-Dive.md | ✅ (线程数爆炸) | ✅ (启动创建多少线程) | ✅ (Mutex层级/JVMFlag设计) | ✅ | ✅ |
| 16 | 16-G1Policy-SubComponents-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ✅ (G1Policy子组件) | ✅ | 🟡 |
| 17 | 17-call_initPhase2-3-Deep-Dive.md | ✅ (启动瓶颈定位) | ✅ (启动最耗时步骤) | ✅ (模块系统为什么耗时) | N/A | ✅ |
| 18 | 18-Interpreter-Template-Dispatch-Deep-Dive.md | ⚠️ 需补充 | ⚠️ 需补充 | ⚠️ 需重写 | ⚠️ 需验证 | 🔴 |
| 21 | 21-JVM-Memory-Layout-Real.md | ✅ (RSS > Xmx) | ⚠️ 需补充 | ✅ (三源验证方法论) | ✅ (源自GDB+pmap+maps) | ✅ |

**统计**：✅ 全绿 10 篇 | 🟡 缺生产/面试关联 6 篇 | 🔴 需重写 5 篇（11/12/13a/13b/18）| 🗑️ 历史 1 篇（14）

> ⚠️ 标识含义：
> - "生产故障可直接参考" = 读者能在生产故障表(§十一)找到本文档的映射
> - "面试题可直接回答" = 读者能在面试题表(§十)找到本文档的映射
> - "解释了为什么这样设计" = 文中有 ≥3 处"为什么这样设计"的明确分析段落
> - "sizeof 是 GDB 实测" = 文中出现的每个 sizeof 附带 GDB session 截图或输出原文

---

## 十三、深度审计问题（用于审计现有文档质量）

### Tier 1：概览层（覆盖 01/02/03/03b）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q1 | ❓ 为什么先 parse 参数（Phase 8）再 init GC（Phase 14）？如果反过来会怎样？ | 01 §四 参数系统 → 05 §阶段分析 |
| Q2 | ❓ 34 个核心结构中，哪些是 C-heap 分配的、哪些是 Arena 分配的、哪些是 resource area 分配的？为什么区分？ | 02 §分类表 |
| Q3 | ❓ ObjectMonitor 的 `_cxq` / `_EntryList` / `_WaitSet` 三队列模型的死锁路径是什么？ | 03 §三 ObjectMonitor 字段分析 |
| Q4 | ❓ SATBMarkQueue 在启动阶段是空的——第一个 enqueue 操作发生在什么时候？ | 03b §四 SATB 队列分析 |

### Tier 2：流程追踪层（覆盖 04/05/17）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q5 | ❓ Phase 12（SafepointMechanism::initialize）在 Phase 14（init_globals）之前——如果顺序颠倒，GC 初始化会怎样？ | 04 §阶段分析 → 05 §Architecture |
| Q6 | ❓ 17 个阶段中，哪些是 O(1) 固定耗时、哪些是 O(HeapSize)、哪些是 O(Regions)？ | 04 §耗时总表 |
| Q7 | ❓ `call_initPhase1` / `call_initPhase2` / `call_initPhase3` 各自做了什么？为什么拆成三个阶段而不是合并？ | 17 §模块系统三阶段 |
| Q8 | ❓ Phase 14（init_globals）内部 10+ 个 `_init()` 调用的顺序能不能调整？如果 `interpreter_init()` 在 `universe_init()` 之前会怎样？ | 05 §init_globals 调用图 |

### Tier 3：子组件深度层（覆盖 06-18）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q9 | ❓ `G1RegionToSpaceMapper × 5` 为什么是 5 个而不是 1 个？5 个 Mapper 各自管理什么地址空间？ | 07 §Step 4: G1RegionToSpaceMapper × 5 |
| Q10 | ❓ TemplateInterpreter::initialize() 中 239 条字节码 → 机器码的生成顺序是由谁驱动的？TCP (Template Code Pointer) vs ICP (Interpreter Code Pointer) 的跳转网络如何闭合？ | 10 §生成流程 → 18 §分派机制 |
| Q11 | ❓ Metaspace 的 VirtualSpaceNode 为什么要做 `commit` / `uncommit` 而不像堆那样一次性 `mmap`？ | 06 §VirtualSpaceNode 分析 |
| Q12 | ❓ `G1ConcurrentMark` 构造时创建了 `G1CMTask × N`（默认 8 个）——这些 Task 和 GC 线程是什么对应关系？如果一个 Task 没有对应线程会怎样？ | 09 §G1CMTask 分配 |
| Q13 | ❓ JVMFlag 的 `origin` 字段（DEFAULT/ERGONOMIC/ENVIRON_VAR/CONFIG_FILE/MANAGEMENT/COMMAND_LINE）在 `Arguments::parse()` 中分别由哪些代码路径写入？ | 15 §JVMFlag 字段分析 |
| Q14 | ❓ `Method` 结构的 sizeof 是 104 B（GDB），其中 `_from_compiled_entry` 和 `_from_interpreted_entry` 两个指针在初始化时分别指向什么？ | 03 §Method 字段分析 |

### Tier 4：验证层（覆盖 21）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q15 | ❓ `/proc/<pid>/maps` 中 G1 堆的 8GB 映射为什么显示为 `---p`（无权限）而不是 `rw-p`？第一次 `rw-p` commit 出现在什么时机？ | 21 §maps 段分析 |
| Q16 | ❓ 如果 `-Xms 8g -Xmx 8g`，GDB `info proc mappings` 显示 mmap 区域实际大小是 8GB 还是 8GB + 对齐填充？对齐填充来自哪里？ | 21 §GDB 交叉验证 |

---

## 十四、和后续阶段的连接（前瞻）

Phase 01 是 JVM 的"地基"——后续 11 个阶段每个都直接依赖 01 的初始化产物。

| 后续阶段 | 依赖 01 的 | 具体依赖内容 |
|---------|-----------|-------------|
| 02-class-loading | Universe::genesis() 创建的基础 Klass | Object/Class/String/Thread 等 200+ 核心 Klass 在 Universe::genesis() 中预创建在 Metaspace；类加载器依赖这些 Klass 作为"根" |
| 03-object-model | §九 的 35 结构 sizeof | G1CollectedHeap/HeapRegion/ObjectMonitor/InstanceKlass/Method 等 35 个结构的 sizeof（GDB 实测）为 03 的 OOP 布局、对象头、字段偏移计算提供精确基线 |
| 04-interpreter | interpreter_init() 的 TemplateInterpreter + StubQueue + DispatchTable | 01 Phase 14 生成的模板解释器就是 04 的执行引擎；239 条字节码模板 + 274KB 机器码（slowdebug）是 04 的全部"素材" |
| 05-jit-compiler | init_globals() 中的 codeCache_init() + stubRoutines_init() + compilationPolicy_init() | 01 Phase 14 创建了 CodeCache（48MB）、编译策略、桩例程——JIT 编译的"舞台"在 01 就搭好了 |
| 06-gc-memory | G1CollectedHeap::initialize() 的完整 12 步 | 8GB 堆、2048 Regions、G1Policy、G1ConcurrentMark（含 G1CMTask×8）、SATB 队列、G1RemSet——G1 GC 的全部数据结构在 01 就完成了构造 |
| 07-thread-lock | mutex_init() 的 80+ Mutex/Monitor + Phase 15 线程创建 | 01 造好了所有锁（Threads_lock / Safepoint_lock / Heap_lock / CodeCache_lock 等）并明确了 rank 层级；JavaThread 创建模式在 01 确立 |
| 08-safepoint | Phase 12 SafepointMechanism::initialize() + Polling Page | 01 创建了 safepoint 的底层机制（polling page + ThreadLocalHandshakes）；后续 safepoint 操作只是"用"这个机制 |
| 09-native-interface | Phase 14 init_globals() 中的 MethodHandle/编译器桩 + 模块系统 call_initPhase2/3 | 01 完成了 JNI 核心桩（`SharedRuntime::generate_stubs`）和模块系统初始化——JNI/JVMTI 调用链的"路"在 01 铺好 |
| 10-services-diag | Phase 5 InstrumentLog::initialize() + Phase 7 LogConfiguration::initialize() | 01 建立了 JVM 统一日志框架和 InstrumentLog 探针基础设施；NMT/DTrace/PerfData 等诊断工具依赖这些"管道" |
| 11-os-layer | Phase 4 os::init() + Phase 11 os::init_2() | 信号处理器（SIGSEGV/SIGBUS/SIGILL）、线程栈大小、NUMA 拓扑、大页支持、`os::create_thread` 的 OS 级接口——全部在 01 中完成初始化和参数绑定 |
| 12-cpu-layer | Phase 1 VM_Version::early_initialize() + Phase 15 VM_Version::initialize() | CPUID 检测（SSE/AVX/HT/POPCNT/CLFLUSH/TSC 等）、Cache Line 大小、Prefetch 距离——这些 CPU 特性标志决定了编译器生成什么指令；CodeCache 在 Phase 14 创建（依赖 Phase 1 的 CPU 特性确认） |

> **所有 12 个 phases 共享的基线**：
> - `_java_mirror` / `_klass` / `_method` / `_constant_pool` 等核心 oop 字段偏移 → 来自 01 Phase 14 的 `javaClasses_init()`
> - `UseCompressedOops` / `UseCompressedClassPointers` 决定 → 来自 01 Phase 14 `universe_init()` 的 narrow oop 基址计算
> - 所有 Phase 共享同一份 GDB 验证方法论（`sizeof` 实测 + `/proc/maps` 对照 + `-Xlog:probe_*=debug` 日志 → 首次在 01 建立并文档化
