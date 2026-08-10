# Part 0 — 前置知识

HotSpot JVM 是 150 万行 C++ + 汇编代码。如果不先讲清楚反复出现的底层机制，正文会不断被打断。

## 拆分方案

| 编号 | 标题 | 聚焦 |
|:---:|------|------|
| 00 | C++ in HotSpot | 模板、虚函数、placement new、Arena 分配、X-MACRO、RAII |
| 01 | Linux 系统编程 | mmap/mprotect、futex、pthread、信号、/proc、ELF、clock |
| 02 | HotSpot 源码导读 | 目录结构、.so 映射、构建系统、全局数据结构速查 |

---

## 00 — C++ in HotSpot — 模板、分配器、惯用法

### 为什么需要这一章

probe_md 文档中高频出现的 C++ 模式，不提前讲会导致读者每个都去查：

| C++ 模式 | 出现位置 | 不讲的后果 |
|---------|---------|-----------|
| **X-MACRO** | LOG_TAG_LIST, VM_OPERATION 枚举 | 看不懂 LogTag::fuzzy_match() 为何编译期生成 |
| **placement new** | nmethod、Metachunk 的空间复用 | 不理解 "在 mmap'd 内存上构造对象" |
| **CRTP** | GrowableArray<T>、Hashtable<T,F> | 不明白模板层次为什么这样设计 |
| **Arena 分配器** | Amalloc/ResourceObj/NEW_RESOURCE_ARRAY | 不知道为什么 JVM 不用 new/delete |
| **虚函数分派** | outputStream::write() 6 种子类 | 不理解 fdStream 如何绕道 POSIX |
| **RAII** | MutexLocker/ThreadInVMfromNative/ResourceMark | 不理解作用域锁和线程状态切换 |
| **constexpr** | exact_log2、JVMFlag 的 compile-time 位域 | 不明白宏为什么淘汰 |

### 建议内容结构

```
§1. HotSpot 为什么不用 STL？ — Arena/C_HEAP 二分法
§2. 模板惯用法 — CRTP(HashtableEntry)、类型擦除(LogHandle)、静态多态
§3. placement new 与原地构造 — nmethod 内存布局、Metachunk 复用
§4. X-MACRO 模式 — 一次定义、多次展开的代码生成术
§5. 虚函数与多态 — outputStream 6 层继承、CodeBlob→nmethod
§6. RAII 的四种面孔 — MutexLocker、ThreadBlockInVM、ResourceMark、HandleMark
§7. 编译期计算 — exact_log2、round_up_power_of_2、align_up/down
```

---

## 01 — Linux 系统编程 — 内存、同步、信号、诊断接口

### 为什么需要这一章

JVM 的一切都运行在 Linux 之上。probe_md 文档中分析的每个子系统最终都落到 syscall。

| Linux 概念 | 在 JVM 中的角色 | 典型 probe_md 文档 |
|-----------|---------------|-------------------|
| **mmap(2) 家族** | ReservedSpace→VirtualSpace 的 commit 模型 | 27-memory-extra |
| **mprotect(2)** | 栈溢出保护、代码段 RWX 权限切换 | 26-runtime-extra |
| **futex(2)** | 所有线程同步的底层原语 | 26-runtime-extra (ThreadSMR) |
| **sigaction(2)** | 信号链、NullPointer 的硬件异常分发 | 19-signal-chaining |
| **pthread** | JavaThread 1:1 映射、TLS | 07-thread-lock |
| **/proc** | hs_err 报告、诊断信息收集 | 24-utilities (vmError) |
| **ELF + dladdr(3)** | 栈回溯、nativeCallStack | 24-utilities (decoder) |
| **clock_gettime(2)** | JFR 纳秒时间戳 | 25-jfr |
| **write(2) + 信号安全** | hs_err 的崩溃报告写入 | 24-utilities (vmError) |

### 建议内容结构

```
§1. mmap(2) 四重境界 — MAP_ANONYMOUS/NORESERVE/POPULATE/FIXED
§2. mprotect(2) 与内存保护 — 从 PROT_NONE 到 PROT_READ|WRITE 的分段提交
§3. futex(2) 的内核路径 — FUTEX_WAIT/FUTEX_WAKE 的精确时序
§4. pthread 与 JVM 的 1:1 线程模型 — pthread_create、TLS、信号掩码
§5. 信号处理全貌 — sigaction、signal chaining、硬件异常→信号→Java 异常
§6. /proc 诊断接口 — /proc/self/maps、/proc/self/smaps、/proc/<pid>/fd
§7. ELF 与栈回溯 — .symtab/.dynsym、dladdr(3)、_Unwind_Backtrace
§8. 时间测量 — clock_gettime(2)、CLOCK_MONOTONIC 的精度保证
§9. 信号安全 I/O — write(2) vs printf(3) 在信号处理器中的生死差别
```

---

## 02 — HotSpot 源码导读 — 目录、构建、全局状态

### 为什么需要这一章

读者拿到 src/hotspot/ 后第一个问题永远是"从哪开始看"。

### 建议内容结构

```
§1. 目录结构全景 — share/os/os_cpu/cpu 四层分工
§2. .so 映射表 — 源码→共享库的对应关系 (libjvm/libjava/libnio/...)
§3. 构建系统速览 — ./configure → make jdk 的关键路径
§4. 全局数据结构索引 — Universe/SymbolTable/StringTable/JvmtiExport/...
§5. 核心抽象链 — Klass→Method→ConstantPool, OOP→Handle→JNIHandle
```

---

## 后续 Part

```
Part 1 — JVM 启动：从 java 命令到 main() (Phase 13 + 01-jvm-startup)
Part 2 — 类加载：.class → InstanceKlass 全链路 (libjvm-analysis 02)
Part 3 — 对象模型：OOP/Klass 二分 + TLAB + HashCode (libjvm-analysis 03)
Part 4 — 执行引擎：解释器 + C1/C2 编译管道 (libjvm-analysis 04/05)
Part 5 — 内存与 GC：G1 + Metaspace + VirtualSpace (Phase 27 + libjvm-analysis 06)
Part 6 — 并发：线程、锁、Safepoint、ThreadSMR (Phase 26 + libjvm-analysis 07/08)
Part 7 — 诊断：Xlog、JFR、JMX、SA、hs_err (Phase 23/25/17/20)
```
