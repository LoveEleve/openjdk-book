# Prompt-04: SA 启动流水线（Java 层）— HotSpotAgent → TypeDataBase → VM 初始化

> **目标文档**: `probe_md/20-sa-postmortem/docs/04-SA-Bootstrap.md`
>
> **预计篇幅**: 2500-3500 行
>
> **质量锚点**: `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (521 行, 12 个 Section)

---

## §〇 Production Scenario

**场景**: 运维工程师执行 `jhsdb jstack --pid 4451` 分析挂起的 JVM 进程。命令执行后，SA 需要完成以下启动流水线：

1. **附加到进程**: 通过 `ptrace(PTRACE_ATTACH)` 附加到 PID 4451
2. **符号解析**: 在 `libjvm.so` 中查找 `gHotSpotVMTypes`、`gHotSpotVMStructs` 等全局符号
3. **类型系统反序列化**: 从目标 JVM 进程内存中读取 C++ 结构体布局（偏移量、大小、类型）
4. **VM 初始化**: 创建 `VM` 单例，懒加载 `Universe`、`Threads`、`SystemDictionary` 等子系统

**问题**: 如果 SA 的 `sa-jdi.jar` 是用 JDK 17 编译的，但目标 JVM 是 JDK 11，启动会失败吗？失败在哪个阶段？报错信息是什么？

**真实案例**: 某团队用 JDK 17 的 `jhsdb` 分析 JDK 11 的 core dump，在 `HotSpotTypeDataBase.readVMTypes()` 阶段失败，报错 `NoSuchSymbolException: gHotSpotVMTypes`。原因是 JDK 11 的 `vmStructs` 宏系统生成的符号名称与 JDK 17 不同（`gHotSpotVMTypes` vs `gHotSpotVMTypes` 实际相同，但 `VMTypeEntry` 的字段偏移量不同）。

**本文档目标**: 深入 SA Java 层的启动流水线，解释：
1. `HotSpotAgent` 的四阶段启动协议（为什么顺序是 setupDebugger → attachDebugger → setupVM？）
2. `HotSpotTypeDataBase` 如何"反序列化"目标 JVM 的 C++ 内存布局（这是 SA 最核心的魔法）
3. `VM.java` 的懒加载模式 + Observer 模式的作用
4. `PageCache` 如何优化 SA 的内存读取性能

---

## §一 Task + Narrative + Beginner Callouts

### Task

写出一篇深度技术文档，覆盖：

1. **HotSpotAgent 四阶段启动协议**: `attach()` → `go()` → `setupDebugger()` → `attachDebugger()` → `setupVM()` 的完整调用链
2. **gHotSpotVMTypes + gHotSpotVMStructs 双符号解析**: 为什么需要两个全局符号？`VMTypeEntry` vs `VMStructEntry` 各自描述什么？
3. **TypeDataBase 反序列化引擎**: 从 JVM 进程内存中读取 C++ 结构体布局，如何保证 SA 运行时和目标 JVM 编译时的结构体布局一致？
4. **VM.java 的懒加载模式**: 为什么 `Universe`/`Threads`/`SystemDictionary` 不用构造函数初始化，而用 getter 懒加载？Observer 模式的作用？
5. **PageCache 与 SA 读取性能**: 16MB 4096 页缓存，命中率如何影响 `jstack`/`jmap` 的性能？什么情况下缓存失效？
6. **Address / OopHandle 抽象层**: 为什么需要 `Address` 接口而非直接用 `long`？`OopHandle` 和 `Address` 的区别？

### Narrative

文档应该以**执行流**为主线：

```
jhsdb jstack --pid 4451
    ↓
HotSpotAgent.attach(pid)                   # 入口
    ↓
go()                                        # 协调器
    ↓
setupDebugger()                             # 阶段 1: 创建 Debugger 对象
    ├─ setupDebuggerLinux()                 #   Linux 平台
    │   ├─ new LinuxDebuggerLocal()         #     创建 Native Debugger
    │   └─ attachDebugger()                 #     附加到进程
    │       └─ debugger.attach(pid)          #       ptrace(PTRACE_ATTACH)
    ↓
setupVM()                                   # 阶段 2: 创建 TypeDataBase + VM
    ├─ new HotSpotTypeDataBase()            #   创建类型数据库
    │   ├─ readVMTypes()                    #     从 gHotSpotVMTypes 读取类型
    │   ├─ initializePrimitiveTypes()       #     初始化 Java 基本类型
    │   ├─ readVMStructs()                   #     从 gHotSpotVMStructs 读取字段
    │   ├─ readVMIntConstants()              #     读取 int 常量
    │   ├─ readVMLongConstants()            #     读取 long 常量
    │   └─ readExternalDefinitions()         #     加载外部类型定义（扩展/补丁机制）
    └─ VM.initialize(db, debugger)          #   初始化 VM 单例
        ├─ new VM(db, debugger, ...)        #     创建 VM 实例
        └─ notifyObservers()                #     通知所有 Observer
            ├─ Universe 初始化              #       懒加载触发
            ├─ Threads 初始化                #       懒加载触发
            └─ SystemDictionary 初始化       #       懒加载触发
```

### Beginner Callouts (≥7 个，只在 §一 内)

> **💡 初学者提示 1**: SA（Serviceability Agent）的 Java 层是一个**独立的 Java 程序**（`sa-jdi.jar`），它不依赖 `libjvm.so` 的 Java 代码。它通过 `Debugger` 接口（JNI 桥接到 `libsaproc.so`）读取目标 JVM 的内存。

> **💡 初学者提示 2**: `gHotSpotVMTypes` 和 `gHotSpotVMStructs` 是 `vmStructs` 宏系统在**编译时**生成的全局符号。它们存储在 `libjvm.so` 的 `.data` 段，SA 通过符号查找（`lookupInProcess("gHotSpotVMTypes")`）获取它们的地址，然后读取目标 JVM 内存中的数组。

> **💡 初学者提示 3**: `VMTypeEntry` 描述一个 C++ 类型（名称、父类、大小、是否是 Oop），而 `VMStructEntry` 描述一个 C++ 结构体的**字段**（类型名、字段名、偏移量、是否是静态字段）。两者配合，SA 才能"知道"目标 JVM 中 `Klass` 的大小是 192 字节，`_name` 字段在偏移量 48 处。

> **💡 初学者提示 4**: SA 的"反序列化"不是读取 Java 对象，而是读取**目标 JVM 的 C++ 内存布局**。比如，SA 需要"知道" `InstanceKlass` 的 `_methods` 字段在哪个偏移量，才能在目标 JVM 内存中找到方法数组。这就像"在运行时读取 C++ 的头文件"。

> **💡 初学者提示 5**: `VM.java` 的懒加载模式是为了**解决循环依赖**。`Universe` 的构造函数需要 `VM`，`VM` 的构造函数需要 `Universe`（因为要读取堆布局）。用 Observer 模式，等 `VM` 完全初始化后，再通知 `Universe` 初始化自己。

> **💡 初学者提示 6**: `Address` 接口是对目标进程虚拟地址的抽象。为什么不用 `long`？因为 (1) `long` 无法区分"地址"和"整数"; (2) `Address` 可以有方法（`addOffsetTo`、`getCIntegerAt`）; (3) `OopHandle` 是 `Address` 的子类，专门表示对象引用（防止误用）。

> **💡 初学者提示 7**: `PageCache` 是 `DebuggerBase.java` 中的 16MB 缓存（4096 页 × 4KB）。SA 读取目标 JVM 内存时，先查缓存，未命中才调用 `ptrace(PTRACE_PEEKDATA)`。这对于 `jstack` 这种需要读取大量小对象的工具至关重要（可以减少 90%+ 的 `ptrace` 调用）。

---

## §二 Standard Environment

### Source Roots

```
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/              # SA Java 层主目录
  — HotSpotAgent.java (684 lines)    attach():134, go():305, setupDebugger():310, setupVM():380
  — HotSpotTypeDataBase.java (868 lines)  constructor:81, readVMTypes():142, readVMStructs():391
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/     # Debugger 抽象层
  — Debugger.java (133 lines)        attach():43, readBytesFromProcess():128
  — DebuggerBase.java (582 lines)    cache:66, initCache():178, readBytes():222
  — Address.java (215 lines)         getCIntegerAt():86, addOffsetTo():159
  — MachineDescription.java (59 lines)  getAddressSize():36, isBigEndian():54
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/runtime/     # VM + 运行时子系统
  — VM.java (964 lines)              constructor:304, initialize():423, getUniverse():635
  — Universe.java (~300 lines)       heap 字段, getMethodsFromKlass()
  — Threads.java (~270 lines)        first(), next()
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/types/       # TypeDataBase 接口
  — TypeDataBase.java, Type.java, Field.java
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/types/basic/  # BasicType/BasicField 实现
  — BasicTypeDataBase.java (~800 lines)  addType(), lookupType()
```

### Key Package Paths

| 包路径 | 核心类 | 用途 |
|--------|--------|------|
| `debugger/` | `Debugger.java`, `DebuggerBase.java`, `Address.java` | Debugger 抽象层 |
| `debugger/linux/` | `LinuxDebuggerLocal.java` | Linux 平台 JNI 桥接 |
| `runtime/` | `VM.java`, `Universe.java`, `Threads.java` | 运行时子系统 |
| `types/` | `TypeDataBase.java`, `Type.java`, `Field.java` | 类型系统接口 |
| `types/basic/` | `BasicTypeDataBase.java`, `BasicType.java`, `BasicField.java` | 类型系统实现 |
| `oops/` | `ObjectHeap.java`, `InstanceKlass.java` | Java 对象堆 |

### Build Command

```bash
# 全量构建 (产出 sa-jdi.jar)
make images

# 单独构建 sa-jdi.jar
make jdk.hotspot.agent-java

# 产出路径
images/jdk/lib/sa-jdi.jar
```

### Binary Paths

| 组件 | 路径 | 类型 |
|------|------|------|
| `sa-jdi.jar` | `images/jdk/lib/sa-jdi.jar` | Java JAR (包含 SA 所有 Java 类) |
| `libsaproc.so` | `images/jdk/lib/libsaproc.so` | Native 库 (JNI 实现) |
| `jhsdb` | `images/jdk/bin/jhsdb` | Shell script launcher |

### Running Commands

```bash
# 附加到运行中的进程
jhsdb jstack --pid <pid>

# 分析 core dump
jhsdb jstack --exe <java-binary> --core <core-file>

# 交互式 CLHSDB
jhsdb clhsdb --pid <pid>

# 直接用 Java 调用
java -cp $JAVA_HOME/lib/sa-jdi.jar sun.jvm.hotspot.HotSpotAgent
```

### Syscall 速查表

| Syscall | 用途 | 手册页 | SA 层 |
|---------|------|--------|-------|
| `ptrace(2)` | Live Mode 内存读写 + 寄存器访问 | `man 2 ptrace` | Native (`libsaproc.so`) |
| `pread(2)` | Core Mode 文件读取 | `man 2 pread` | Native (`libsaproc.so`) |
| `mmap(2)` | PageCache 内存映射（可选） | `man 2 mmap` | `DebuggerBase.java` |
| `open(2)` | 打开 `/proc/<pid>/mem` 或 core 文件 | `man 2 open` | Native (`libsaproc.so`) |

---

## §三 Source Files Table

| 文件 | 路径 | 行数 | 核心内容 |
|------|------|------|----------|
| `HotSpotAgent.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/` | 684 | **启动协调器**: `attach()` (line 134), `go()` (line 305), `setupDebugger()` (line 310), `setupDebuggerLinux()` (line 584), `attachDebugger()` (line 675), `setupVM()` (line 380) |
| `HotSpotTypeDataBase.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/` | 868 | **类型系统反序列化引擎**: 构造函数 (line 81), `readVMTypes()` (line 142), `readVMStructs()` (line 391), `readVMIntConstants()` (line 480), `readVMLongConstants()` (line 537), `lookupInProcess()` (line 607) |
| `VM.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/runtime/` | 964 | **VM 单例 + Observer 模式**: 构造函数 (line 304), `initialize()` (line 423), `registerVMInitializedObserver()` (line 450), 懒加载 getter (`getUniverse()` line 635, `getThreads()` line 663) |
| `Debugger.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/` | 133 | **Debugger 接口**: `attach()` (line 43), `detach()` (line 55), `readBytesFromProcess()` (line 128), `getMachineDescription()` (line 88) |
| `DebuggerBase.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/` | 582 | **PageCache 实现**: `cache` 字段 (line 66), `initCache()` (line 178), `readBytes()` (line 222), `configureJavaPrimitiveTypeSizes()` (line 93) |
| `Address.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/` | 215 | **地址抽象接口**: `getCIntegerAt()` (line 86), `getAddressAt()` (line 89), `addOffsetTo()` (line 159), `minus()` (line 176) |
| `MachineDescription.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/` | 59 | **机器描述接口**: `getAddressSize()` (line 36), `isBigEndian()` (line 54), `isLP64()` (line 58) |
| `BasicTypeDataBase.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/types/basic/` | 508 | **TypeDataBase 基类**: `addType()` (line 122), `lookupType()` (line 66), `createField()` (line 96), `addressTypeIsEqualToType()` (line 172) |
| `LinuxVtblAccess.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/linux/` | ~200 | **vtable 访问**: 用于读取 C++ 虚函数表（SA 需要调用目标 JVM 的虚函数） |

---

## §四 Deep Dive Question Groups

### 问题组 1: HotSpotAgent 的四阶段启动协议

**问题**: 为什么 `go()` 方法中先调用 `setupDebugger()` 再调用 `setupVM()`？如果顺序反过来会怎样？`setupDebugger()` 内部为什么还要分 `setupDebuggerLinux()` + `attachDebugger()` 两个步骤？

**答案方向** (≥8 行):

在 `HotSpotAgent.java:305-308`，`go()` 方法定义了严格的启动顺序：
```java
private void go() {
    setupDebugger();  // 阶段 1: 创建 Debugger 对象
    setupVM();        // 阶段 2: 创建 TypeDataBase + VM
}
```

**为什么不能反过来？**

1. **依赖关系**: `setupVM()` 需要 `Debugger` 对象来读取目标 JVM 内存（`readVMTypes()` 需要调用 `lookupInProcess()` → `symbolLookup.lookup()` → `debugger.lookup()`）。如果先调用 `setupVM()`，`debugger` 字段为 `null`，会抛出 `NullPointerException`。

2. **符号查找依赖调试器**: `HotSpotTypeDataBase` 的构造函数（line 81-95）需要 `symbolLookup`（即 `Debugger` 对象）来查找 `gHotSpotVMTypes` 等符号。没有 `Debugger`，就无法读取类型系统。

**为什么 `setupDebugger()` 分两个步骤？**

- `setupDebuggerLinux()` (line 584-616): 创建 `LinuxDebuggerLocal` 对象，设置 `MachineDescription`，但**不附加**到进程
- `attachDebugger()` (line 675-683): 调用 `debugger.attach(pid)`，实际附加到进程

**分离的原因**: `setupDebuggerLinux()` 需要知道目标进程的地址大小（32-bit vs 64-bit）来创建正确的 `MachineDescription`。但对于远程调试（`REMOTE_MODE`），地址大小是从 `RemoteDebuggerClient` 获取的，不需要本地 `attach`。

**Counterfactual（反事实讨论）**:
> 如果合并 `setupDebuggerLinux()` 和 `attachDebugger()`，代码会更简单（一次方法调用完成创建 + 附加）。但这样会失去灵活性：某些场景下需要"先创建 Debugger 对象，稍后附加"（如 SA 的 GUI 工具 `HSDB`，用户先选择进程，再点击"Attach"按钮）。分离的设计支持这种**延迟附加**模式。

**量化对比**:

| 方案 | 代码行数 | 灵活性 | 延迟附加支持 |
|------|---------|--------|-------------|
| 合并（一步到位） | 少 20 行 | 低 | 不支持 |
| 分离（两步走） | 多 20 行 | 高 | 支持 |

**源码引用**: `HotSpotAgent.java:305-308` (`go()`), `HotSpotAgent.java:584-616` (`setupDebuggerLinux()`), `HotSpotAgent.java:675-683` (`attachDebugger()`)

---

### 问题组 2: gHotSpotVMTypes + gHotSpotVMStructs 双符号解析

**问题**: 为什么 SA 需要两个全局符号（`gHotSpotVMTypes` 和 `gHotSpotVMStructs`）？`VMTypeEntry` 和 `VMStructEntry` 各自描述什么？如果只用一个符号会怎样？

**答案方向** (≥8 行):

**双符号的设计意图**:

在 `HotSpotTypeDataBase.java:142-207` (`readVMTypes()`) 和 `HotSpotTypeDataBase.java:391-478` (`readVMStructs()`)，SA 分别读取两个全局符号：

1. **`gHotSpotVMTypes`**: 指向 `VMTypeEntry[]` 数组，描述**类型**（C++ 类名、父类、大小、是否是 Oop）
2. **`gHotSpotVMStructs`**: 指向 `VMStructEntry[]` 数组，描述**字段**（类型名、字段名、偏移量、是否是静态字段）

**为什么需要两个？**

- **关注点分离**: 类型定义（"有哪些类型？"）和字段定义（"类型的字段在哪？"）是两层抽象
- **顺序依赖**: `readVMStructs()` 需要 `readVMTypes()` 先执行，因为 `VMStructEntry` 中的 `typeName` 引用了 `VMTypeEntry` 中定义的类型

**VMTypeEntry 结构** (从目标 JVM 内存中读取):
```c
// 目标 JVM 中的 C++ 结构体 (vmStructs.cpp)
struct VMTypeEntry {
  const char* typeName;           // 类型名 ("Klass", "InstanceKlass", ...)
  const char* superclassName;    // 父类名 ("Metadata", "Klass", ...)
  bool isOopType;                // 是否是 Oop (对象引用)
  bool isIntegerType;            // 是否是 C 整数类型
  bool isUnsigned;               // 是否无符号
  int64_t size;                  // 类型大小 (字节)
  // ... 其他字段
};
```

**VMStructEntry 结构** (从目标 JVM 内存中读取):
```c
// 目标 JVM 中的 C++ 结构体 (vmStructs.cpp)
struct VMStructEntry {
  const char* typeName;          // 所属类型名 ("InstanceKlass")
  const char* fieldName;         // 字段名 ("_methods")
  const char* typeString;        // 字段类型名 ("Array<Method*>*")
  bool isStatic;                 // 是否是静态字段
  int64_t offset;                // 字段偏移量 (非静态) / 地址 (静态)
  // ... 其他字段
};
```

**Counterfactual**:
> 如果只用一个符号（合并 `VMTypeEntry` 和 `VMStructEntry`），每个字段定义都会重复类型信息（类型名、大小、父类），导致符号表膨胀 10x+。`gHotSpotVMTypes` 有 ~500 个条目，`gHotSpotVMStructs` 有 ~2000 个条目。合并后每个字段条目都要包含类型信息，浪费 ~16 字节 × 2000 = 32KB。

**量化对比**:

| 方案 | 符号数量 | 内存占用 (目标 JVM) | 读取复杂度 |
|------|---------|---------------------|-----------|
| 双符号（当前） | 500 + 2000 = 2500 | ~50KB | 两遍扫描 |
| 单符号（合并） | 2000（每个字段包含类型信息） | ~80KB | 一遍扫描 |

**源码引用**: `HotSpotTypeDataBase.java:142-207` (`readVMTypes()`), `HotSpotTypeDataBase.java:391-478` (`readVMStructs()`), `HotSpotTypeDataBase.java:607-627` (`lookupInProcess()`)

---

### 问题组 3: TypeDataBase 的反序列化引擎

**问题**: SA 如何从 JVM 进程内存中读取 C++ 结构体布局？如何保证 SA 运行时和目标 JVM 编译时的结构体布局一致？如果目标 JVM 是用不同的编译器优化选项编译的（如 `-O3` vs `-O0`），SA 还能工作吗？

**答案方向** (≥8 行):

**反序列化原理**:

SA 的"反序列化"不是读取序列化后的数据，而是**直接读取目标 JVM 内存中的 C++ 结构体布局**。关键机制：

1. **编译时生成符号表**: `vmStructs` 宏系统（在 `src/hotspot/share/runtime/vmStructs.hpp` 中定义）在**编译时**生成 `gHotSpotVMTypes` 和 `gHotSpotVMStructs` 全局符号
2. **运行时读取符号表**: SA 通过 `lookupInProcess("gHotSpotVMTypes")` 获取符号地址，然后读取目标 JVM 内存中的数组
3. **重建类型系统**: SA 用读取到的类型信息创建 `BasicType` 和 `BasicField` 对象，构建本地的类型数据库

**一致性保证**:

- **编译时绑定**: `gHotSpotVMTypes` 和 `gHotSpotVMStructs` 是在**编译目标 JVM 时**生成的，包含了准确的类型信息（偏移量、大小）
- **版本检查**: `VM.java:253-285` (`checkVMVersion()`) 检查 SA 的版本 (`sa.properties`) 和目标 JVM 的版本 (`_s_vm_release`) 是否匹配
- **如果不匹配**: 报错 `VMVersionMismatchException`，但可以通过 `-Dsun.jvm.hotspot.runtime.VM.disableVersionCheck=true` 禁用

**编译器优化的影响**:

- **`-O3` vs `-O0`**: 结构体字段偏移量通常不受优化影响（C++ 标准保证字段按顺序布局，除非有 `#pragma pack` 或 `__attribute__((packed))`）
- **字段重排**: GCC/Clang 的 `-fipa-sra` 或 `-foverride-options` 可能重排字段，但 HotSpot 禁用这些优化（`-fno-ipa-sra`）
- **问题场景**: 如果目标 JVM 是用非标准布局（如 `-malign-double`）编译的，SA 读取的偏移量会错误

**Counterfactual**:
> 如果 SA 不依赖 `vmStructs` 宏系统，而是直接解析目标 JVM 的 DWARF 调试信息（`.debug_info` section），可以支持任意编译选项。但 DWARF 解析复杂（需要理解 ABI、调用约定、优化信息），且 Debug 构建才会包含完整的 DWARF 信息。HotSpot 的 `vmStructs` 宏系统是一种**轻量级替代方案**，只导出 SA 需要的类型信息，不依赖完整的调试信息。

**量化对比**:

| 方案 | 复杂性 | 覆盖范围 | 性能 |
|------|--------|---------|------|
| `vmStructs` 宏系统（当前） | 低（只导出 ~500 类型 + ~2000 字段） | 仅 SA 需要的类型 | 高（符号表查找 O(1)） |
| DWARF 调试信息 | 高（需要解析 `.debug_info`、`.debug_abbrev`、`.debug_line`） | 全部类型 + 函数 + 变量 | 低（解析耗时秒级） |

**源码引用**: `HotSpotTypeDataBase.java:142-207` (`readVMTypes()` 读取类型), `VM.java:253-285` (`checkVMVersion()` 版本检查), `vmStructs.hpp` (宏系统定义，需搜索 `src/hotspot/share/runtime/vmStructs.hpp`)

---

### 问题组 4: VM.java 的懒加载模式 + Observer 模式

**问题**: 为什么 `VM.java` 中的 `Universe`、`Threads`、`SystemDictionary` 不用构造函数初始化，而用 getter 懒加载？Observer 模式的作用是什么？如果不使用 Observer 模式，会出现什么循环依赖问题？

**答案方向** (≥8 行):

**懒加载模式**:

在 `VM.java:635-668`，核心子系统都用 getter 懒加载：
```java
public Universe getUniverse() {
    if (universe == null) {
        universe = new Universe();  // 第一次调用时创建
    }
    return universe;
}
```

**为什么不用构造函数初始化？**

1. **循环依赖**: `VM` 的构造函数需要读取目标 JVM 的内存（如 `Abstract_VM_Version` 来获取版本信息），而读取内存需要 `Universe`（因为对象引用需要通过堆布局解码）。如果 `VM` 的构造函数创建 `Universe`，`Universe` 的构造函数又需要 `VM` 来读取内存，形成循环依赖。

2. **初始化顺序不确定**: SA 的子系统之间有复杂的依赖关系（`Threads` 依赖 `Universe`，`SystemDictionary` 依赖 `Threads`）。用懒加载，第一次调用 getter 时自动触发初始化，保证依赖顺序正确。

**Observer 模式**:

在 `VM.java:68-70`，`VM` 维护了一个 `vmInitializedObservers` 列表：
```java
private static List vmInitializedObservers = new ArrayList();
```

**Observer 的注册** (`VM.java:450-453`):
```java
public static void registerVMInitializedObserver(Observer o) {
    vmInitializedObservers.add(o);
    o.update(null, null);  // 立即通知（用于首次初始化）
}
```

**Observer 的触发** (`VM.java:430-436`):
```java
// VM.initialize() 中
for (Iterator iter = vmInitializedObservers.iterator(); iter.hasNext(); ) {
    ((Observer) iter.next()).update(null, null);
}
```

**哪些类注册了 Observer？**

- `Universe`: 注册 Observer 来初始化堆布局
- `Threads`: 注册 Observer 来初始化线程表
- `SystemDictionary`: 注册 Observer 来初始化类字典

**Counterfactual**:
> 如果不使用 Observer 模式，而是在 `VM.initialize()` 中显式调用 `Universe.initialize()`、`Threads.initialize()` 等，代码会更简单。但这样会失去**扩展性**：如果未来添加新的子系统（如 `CodeCache`），需要修改 `VM.initialize()` 的代码。用 Observer 模式，新子系统只需在自己的静态初始化器中调用 `VM.registerVMInitializedObserver()`，不需要修改 `VM.java`。

**量化对比**:

| 方案 | 代码耦合度 | 扩展性 | 初始化顺序控制 |
|------|-----------|--------|---------------|
| 显式调用（无 Observer） | 高（VM 知道所有子系统） | 低（添加新子系统需改 VM） | 容易（顺序由代码决定） |
| Observer 模式（当前） | 低（VM 不知道具体子系统） | 高（新子系统自己注册） | 困难（依赖注册顺序） |

**实际初始化顺序** (由注册顺序决定):
1. `Universe`（第一个注册）
2. `Threads`（第二个注册）
3. `SystemDictionary`（第三个注册）
4. ...

**源码引用**: `VM.java:635-640` (`getUniverse()` 懒加载), `VM.java:450-453` (`registerVMInitializedObserver()`), `VM.java:423-437` (`initialize()` 触发 Observer)

---

### 问题组 5: PageCache 与 SA 读取性能

**问题**: `DebuggerBase.java` 的 PageCache 是如何减少 `ptrace(PTRACE_PEEKDATA)` 调用次数的？16MB 缓存（4096 页 × 4KB）在实际的 `jstack` 执行中能减少多少 syscall？什么情况下缓存失效？

**答案方向** (≥8 行):

**PageCache 设计** (`DebuggerBase.java:66`):

```java
// DebuggerBase.java:66
private PageCache cache;  // 16MB 缓存 (4096 页 × 4KB)
```

**初始化** (`DebuggerBase.java:178-183`):
```java
protected final void initCache(long pageSize, long maxNumPages) {
    cache = new PageCache(pageSize, maxNumPages, new Fetcher());
    // pageSize = 4096 (4KB), maxNumPages = 4096 → 16MB
}
```

**读取流程** (`DebuggerBase.java:222-233`):
```java
protected final byte[] readBytes(long address, long numBytes) {
    if (cache != null) {
        return cache.getData(address, numBytes);  // 缓存命中：直接返回
    } else {
        ReadResult res = readBytesFromProcess(address, numBytes);  // 缓存未命中：调用 ptrace
        // ...
    }
}
```

**性能优化原理**:

1. **局部性原理**: `jstack` 读取线程栈时，会连续读取同一页上的多个字段（如 `JavaThread` 的 `_stack_overflow_state`、`_exception_oop` 等），这些字段通常在同一 4KB 页内
2. **缓存命中**: 第一次读取某个地址时，缓存未命中，调用 `readBytesFromProcess()`（底层是 `ptrace` 或 `pread`）；后续读取同一页的地址时，缓存命中，直接返回缓存数据
3. **减少 syscall**: 对于 4KB 顺序读取，无缓存需要 512 次 `ptrace`（每次 8 字节），有缓存只需 1 次 `readBytesFromProcess()` 调用

**实际性能影响** (`jstack` 分析 100 个线程):

假设每个线程需要读取：
- `JavaThread` 结构体: 512 字节（~64 次 `ptrace`）
- 栈帧遍历: 每个帧 256 字节 × 10 帧 = 2560 字节（~320 次 `ptrace`）
- 总计: 100 线程 × (64 + 320) = 38400 次 `ptrace`

**有 PageCache**:
- 假设缓存命中率 80%（因为栈帧通常在连续内存区域）
- 实际 `ptrace` 调用: 38400 × 20% = **7680 次**
- **加速比**: 5x

**缓存失效场景**:

1. **目标进程恢复执行**: `VM.fireVMResumed()` 会调用 `disableCache()` (`DebuggerBase.java:205-209`)，因为目标进程的堆布局可能变化（GC 移动对象）
2. **跨页读取**: 如果读取的地址跨越两个 4KB 页，且第二页未缓存，会触发额外的 `readBytesFromProcess()` 调用
3. **缓存大小不足**: 如果分析的堆很大（> 16MB），缓存会频繁淘汰（LRU），导致命中率下降

**Counterfactual**:
> **方案 A**: 如果 PageCache 改用 **2MB 大页**（匹配 Linux THP），TLB miss 从 ~200 次降到 ~2 次（4KB 页需要 200+ 个 TLB entry 覆盖 1MB，2MB 大页只需 1 个），但内存占用从 16MB 暴增到 8GB（4096 页 × 2MB），不现实。
>
> **方案 B**: 如果使用 **自适应页大小**（adaptive page size）— 检测读取模式，顺序读取用 2MB 大页（预加载 512 个连续 4KB 页），随机读取用 4KB 小页。这可以在不增加内存的前提下，顺序遍历（如 jmap -histo 扫堆）获得 20x 加速。代价是实现复杂度增加 ~200 行 Java 代码。
>
> **方案 C**: 如果完全取消 PageCache，直接使用 `process_vm_readv(2)`（Linux 3.2+ 的基础系统调用）一次读取多个 iovec。对于分散的 8 字节读取，`process_vm_readv` 比 `ptrace(PEEKDATA)` 少一次上下文切换（不需要 wait+SIGSTOP 协议），延迟从 ~4μs 降到 ~2μs。但 `process_vm_readv` 在容器环境中受限（PID namespace），且没有信号控制的优势（不能保证目标进程冻结状态）。

**量化对比**:

| 方案 | 内存 | 顺序读取加速 | 随机读取加速 | 容器兼容 | 实现复杂度 |
|------|------|-------------|-------------|---------|-----------|
| 4KB 固定页（当前） | 16MB | 5x | 1x | ✅ | 低 |
| 2MB 大页 | 8GB | 20x | 1x | ✅ | 低 |
| 自适应页 | 16MB | 20x | 1x | ✅ | 中 (+200行) |
| process_vm_readv 替代 | 0 | 2x | 2x | ⚠️ 受限 | 中 |

**量化对比**:

| 场景 | 无 PageCache (ptrace 次数) | 有 PageCache (ptrace 次数) | 加速比 |
|------|---------------------------|---------------------------|--------|
| `jstack` 100 线程 | 38400 | 7680 (命中率 80%) | 5x |
| `jmap -histo` (扫堆) | 1000000+ | 200000 (命中率 80%) | 5x |
| 跨页随机读取 | 无优化 | 无优化（每次都未命中） | 1x |

**源码引用**: `DebuggerBase.java:66` (`cache` 字段), `DebuggerBase.java:178-183` (`initCache()`), `DebuggerBase.java:222-233` (`readBytes()`), `DebuggerBase.java:205-209` (`disableCache()`)

---

### 问题组 6: Address / OopHandle 抽象层

**问题**: 为什么 SA 需要 `Address` 接口而非直接用 `long` 表示地址？`OopHandle` 和 `Address` 的区别是什么？如果用 `long` 会有什么问题？

**答案方向** (≥8 行):

**Address 接口的设计意图** (`Address.java:66-215`):

1. **类型安全**: `long` 无法区分"地址"和"整数"。`Address` 是**强类型**的地址封装，防止误用（如把整数当地址、把地址当整数）
2. **方法封装**: `Address` 提供了地址操作的方法（`addOffsetTo()`、`getCIntegerAt()`、`minus()`），这些方法会检查边界、对齐、未映射地址
3. **平台抽象**: `Address` 的实现可以是 `long`（64-bit 系统）或 `int`（32-bit 系统），上层代码无需关心
4. **不可变性**: `Address` 是不可变的（类似 `String`），避免意外修改

**OopHandle 的特殊性**:

`OopHandle` 是 `Address` 的子类，**专门表示对象引用**（Java 对象的地址）。为什么需要单独的类型？

1. **压缩 Oop 支持**: 如果目标 JVM 启用了 `UseCompressedOops`（32-bit Oop 在 64-bit 系统上），`OopHandle` 需要解码（通过 `narrowOopBase` + `narrowOopShift`）才能变成真实地址
2. **GC 安全**: `OopHandle` 在目标进程恢复执行时**失效**（因为 GC 可能移动对象）。`Address` 表示"任意地址"，不一定失效
3. **类型区分**: `getOopHandleAt()` 返回 `OopHandle`，`getAddressAt()` 返回 `Address`，编译器可以检查类型错误

**如果直接用 `long` 会有什么问题？**

1. **类型混淆**:
   ```java
   long addr = 0x7ff800001234;  // 是地址还是整数？
   long value = addr + 8;       // 编译通过，但语义错误（应该是 addr.addOffsetTo(8)）
   ```

2. **压缩 Oop 解码错误**:
   ```java
   long oop = 0x12345678;  // 压缩 Oop (32-bit)
   // 如果直接用 long，需要手动解码：
   long realAddr = narrowOopBase + (oop << narrowOopShift);
   // 但 OopHandle 自动处理解码
   ```

3. **边界检查缺失**:
   ```java
   long addr = ...;
   long value = readLong(addr);  // 如果 addr 未映射，崩溃
   // Address 版本：
   Address addr = ...;
   long value = addr.getJLongAt(0);  // 抛出 UnmappedAddressException
   ```

**Counterfactual**:
> 如果 SA 用 `Long` 包装类（而非 `Address` 接口），可以获得类型安全，但失去方法封装（`Long` 没有 `addOffsetTo()`、`getCIntegerAt()` 等方法）。`Address` 接口是正确的设计：它既是**强类型**的地址封装，又提供了**地址操作**的方法。

**量化对比**:

| 方案 | 类型安全 | 方法封装 | 压缩 Oop 支持 | 边界检查 |
|------|---------|---------|--------------|---------|
| `long`（当前如果用它） | 无 | 无（需要工具类） | 手动解码 | 无（崩溃） |
| `Long` 包装类 | 有 | 无（需要工具类） | 手动解码 | 可添加 |
| `Address` 接口（当前） | 有 | 有（`addOffsetTo()` 等） | `OopHandle` 自动解码 | 有（异常） |

**源码引用**: `Address.java:66-215` (接口定义), `OopHandle.java` (需搜索 `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/OopHandle.java`), `DebuggerBase.java:460-482` (压缩 Oop 解码)

---

## §五 Article Structure

文档应按以下结构组织（## 表示一级章节，### 表示二级章节）：

```
# 04 SA 启动流水线（Java 层）— HotSpotAgent → TypeDataBase → VM 初始化

### §一 HotSpotAgent 四阶段启动协议
### 1.1 attach() 入口：三种模式（PROCESS_MODE / CORE_FILE_MODE / REMOTE_MODE）
### 1.2 go() 协调器：为什么先 setupDebugger 再 setupVM？
### 1.3 setupDebugger() 详解：平台分派 + Debugger 对象创建
### 1.4 attachDebugger() 详解：ptrace(PTRACE_ATTACH) 的 JNI 调用链
### 1.5 setupVM() 详解：TypeDataBase 创建 + VM.initialize()

### §二 gHotSpotVMTypes + gHotSpotVMStructs 双符号解析
### 2.1 vmStructs 宏系统：编译时生成全局符号
### 2.2 VMTypeEntry 结构：描述 C++ 类型（名称/父类/大小/是否是 Oop）
### 2.3 VMStructEntry 结构：描述 C++ 字段（类型名/字段名/偏移量/是否静态）
### 2.4 readVMTypes() 深度分析：从目标 JVM 内存读取类型定义
### 2.5 readVMStructs() 深度分析：从目标 JVM 内存读取字段定义
### 2.6 符号查找失败的场景：NoSuchSymbolException 的触发条件

### §三 TypeDataBase 反序列化引擎
### 3.1 反序列化原理：如何"在运行时读取 C++ 的头文件"？
### 3.2 一致性保证：编译时绑定 + 版本检查
### 3.3 编译器优化的影响：-O3 字段重排是否会影响 SA？
### 3.4 BasicType / BasicField 实现：SA 如何表示目标 JVM 的类型？
### 3.5 类型系统输出示例：Type 对象 + Field 对象如何被 VM.java 使用

### §四 VM.java 的懒加载模式 + Observer 模式
### 4.1 为什么不用构造函数初始化？循环依赖问题
### 4.2 懒加载 getter 详解：getUniverse() / getThreads() / getSystemDictionary()
### 4.3 Observer 模式详解：registerVMInitializedObserver() + notifyObservers()
### 4.4 初始化顺序：Universe → Threads → SystemDictionary → ...
### 4.5 扩展性：如何添加新子系统（无需修改 VM.java）

### §五 PageCache 与 SA 读取性能
### 5.1 PageCache 设计：16MB 缓存（4096 页 × 4KB）+ LRU 淘汰
### 5.2 读取流程：缓存命中 vs 缓存未命中
### 5.3 性能量化：jstack 的 ptrace 调用次数减少 5x
### 5.4 缓存失效场景：目标进程恢复执行 + 跨页读取 + 缓存大小不足
### 5.5 未来优化：process_vm_readv(2) + 增大缓存到 64MB

### §六 Address / OopHandle 抽象层
### 6.1 为什么需要 Address 接口？类型安全 + 方法封装 + 平台抽象
### 6.2 OopHandle 的特殊性：压缩 Oop 解码 + GC 安全
### 6.3 如果直接用 long 会有什么问题？类型混淆 + 解码错误 + 边界检查缺失
### 6.4 Address 核心方法详解：addOffsetTo() / getCIntegerAt() / minus()

### §七 边缘场景与诊断工具
### 7.1 版本不匹配：VMVersionMismatchException + 如何禁用检查
### 7.2 符号查找失败：NoSuchSymbolException（目标不是 HotSpot VM）
### 7.3 权限不足：ptrace 权限（cap_sys_ptrace / yama/ptrace_scope）
### 7.4 诊断工具五件套：strace + jhsdb + jstack + GDB + /proc

### §八 总结：SA Java 层设计的权衡
### 8.1 四阶段启动协议：严格的顺序依赖
### 8.2 双符号解析：关注点分离 + 减少符号表膨胀
### 8.3 懒加载 + Observer：解决循环依赖 + 扩展性强
### 8.4 PageCache：应用层补偿 ptrace 的低效
### 8.5 Address / OopHandle：类型安全优先于性能

---

## §六 Writing Requirements

### 6.1 总体原则

1. **源码是证据（20%），原理是正文（80%）**: 不要写成源码翻译，要解释"为什么这么设计"
2. **每个技术断言必须标注 file:line 引用**: 如 `HotSpotAgent.java:305-308`
3. **量化对比优先**: 用表格/数字说明性能差距、内存占用、复杂度
4. **Counterfactual 讨论**: 每个设计决策都要讨论"如果选另一个方案会怎样"
5. **解释 SA 的"反序列化"魔法**: 这是 SA 最核心的机制，必须详细解释

### 6.2 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 只列 HotSpotAgent 的方法调用顺序 | 解释为什么是这个顺序（依赖关系分析）+ 如果顺序反过来会怎样 |
| 只说"gHotSpotVMTypes 存储类型信息" | 解释 VMTypeEntry 的每个字段（typeName/superclassName/isOopType/size）+ 如何从目标 JVM 内存中读取 |
| 只贴 readVMTypes() 代码 | 解释反序列化原理（"在运行时读取 C++ 的头文件"）+ 一致性保证（编译时绑定） |
| 只说"VM 用懒加载" | 解释循环依赖问题（为什么构造函数不能初始化 Universe）+ Observer 模式的作用 |
| 只说"PageCache 缓存内存" | 量化：jstack 的 ptrace 调用次数减少 5x + 缓存失效场景 |
| 只说"Address 是地址封装" | 对比 long：类型安全/方法封装/压缩 Oop 支持/边界检查 |
| 只贴代码不解释 | 每个代码块后跟 3-5 行解释：这段代码的意图、关键点、与前后文的关联 |
| 只说"详见 man 手册" | 具体引用 man 章节（如 `man 2 ptrace` 的 `PTRACE_PEEKDATA` 部分），并解释关键参数 |

### 6.3 源码阅读要求

1. **必须读源码**: 不要依赖 prompt 中的摘要，直接读 `.java` 文件
2. **追踪执行流**: 从 `HotSpotAgent.attach()` → `go()` → `setupDebugger()` → `setupVM()` → `VM.initialize()`，完整追踪调用链
3. **理解 vmStructs 宏系统**: 搜索 `src/hotspot/share/runtime/vmStructs.hpp`，理解 `VM_STRUCTS` / `VM_TYPES` 宏如何生成 `gHotSpotVMTypes` 和 `gHotSpotVMStructs`
4. **对比 Native 层**: 本文档是 Java 层，但要提及与 Native 层（`libsaproc.so`）的交互（如 `lookupInProcess()` → JNI → `libsaproc.lookup_symbol()`）

---

## §七 Output Format

### 7.1 文件格式

- **格式**: GitHub Flavored Markdown (`.md`)
- **编码**: UTF-8
- **行宽**: 100 字符（方便终端阅读）

### 7.2 代码块格式

```java
// 代码块必须标注文件路径和行号范围
// 示例：
// HotSpotAgent.java:305-308

private void go() {
    setupDebugger();  // 阶段 1
    setupVM();        // 阶段 2
}
```

### 7.3 表格格式

使用 GitHub Flavored Markdown 表格，对齐列宽。

### 7.4 Callout 格式

使用 `> **💡 初学者提示 X**` 格式（仅在 §一 中，不重复）：

```markdown
> **💡 初学者提示 8**: 这是第 8 个 callout（如果需要超过 7 个）。
```

### 7.5 章节编号

使用 `## §一` `### 1.1` 格式，确保 `rg '^## §' file.md` 能验证连续无跳号。

---

## §八 Prohibited（≥8 条）

1. **禁止写成源码翻译**: 不要逐行解释代码，要提炼设计原理和权衡
2. **禁止遗漏 file:line 引用**: 每个技术断言必须标注源码位置
3. **禁止只列结构体定义不解释**: 每个字段都要解释用途和活进程/core dump 时的不同取值
4. **禁止跳过 counterfactual 讨论**: §四 的每个问题组必须包含"如果选另一个方案会怎样"
5. **禁止在 §一 以外添加 Beginner Callout**: Callout 只能在 §一 内，避免重复
6. **禁止遗漏 man 手册引用**: 每个系统调用必须标注 `man 2 xxx` 或 `man 3 xxx`
7. **禁止写成科普文**: 本文档的目标读者是有 Java 和 Linux 系统编程经验的工程师，不要解释"什么是 JVM"
8. **禁止遗漏边缘场景**: §七 必须包含 ≥3 个边缘场景（版本不匹配/符号查找失败/权限不足）
9. **禁止混淆 Live/Postmortem Mode**: 明确标注每个函数/数据结构的适用模式
10. **禁止遗漏 SA 的"反序列化"魔法**: §三 必须详细解释如何从目标 JVM 内存中读取 C++ 结构体布局

---

## §九 Required（≥8 条）

1. **必须包含 HotSpotAgent 四阶段启动协议的完整调用链**: 从 `attach()` 到 `setupVM()` 的每一步
2. **必须解释 gHotSpotVMTypes + gHotSpotVMStructs 的双符号设计**: VMTypeEntry vs VMStructEntry 的字段含义
3. **必须包含 TypeDataBase 反序列化引擎的深度分析**: 如何"在运行时读取 C++ 的头文件"？
4. **必须解释 VM.java 的懒加载模式 + Observer 模式**: 为什么不用构造函数？如何解决循环依赖？
5. **必须包含 PageCache 的性能量化**: jstack 的 ptrace 调用次数减少 5x（用表格）
6. **必须解释 Address / OopHandle 抽象层**: 为什么需要接口而非直接用 long？
7. **必须包含边缘场景 section**: ≥3 个场景（版本不匹配/符号查找失败/权限不足）
8. **必须使用 man 手册验证系统调用**: `ptrace(2)` 等（虽然 SA Java 层不直接调用，但要提及 Native 层的调用）
9. **必须包含诊断工具五件套**: `strace` + `jhsdb` + `jstack` + `GDB` + `/proc`
10. **必须验证 §四 答案方向 ≥8 行**: 随机抽取 3 个问题组验证

---

## §十 GDB Verification（≥7 断言）

以下是可以通过 GDB 验证的断言（在 Live Mode 中验证）：

### 断言 1: HotSpotAgent.go() 的四阶段执行顺序

```gdb
# 启动目标 JVM
java -cp test.jar TestWait &  # PID=12345

# 在 SA 进程中用 GDB 附加
gdb --args java -cp $JAVA_HOME/lib/sa-jdi.jar \
    sun.jvm.hotspot.tools.JStack 12345

# 在 go() 方法打断点
(gdb) break HotSpotAgent.java:305
# 期望: 断点命中，当前方法为 HotSpotAgent.go()

# 单步到 setupDebugger() 调用
(gdb) step
# 期望: 进入 HotSpotAgent.setupDebugger() (HotSpotAgent.java:310)

# 单步到 setupVM() 调用
(gdb) step
# 期望: 进入 HotSpotAgent.setupVM() (HotSpotAgent.java:380)

# 验证执行顺序
(gdb) where
# 期望: 栈帧显示 go() → setupDebugger() 先于 setupVM()
```

### 断言 2: gHotSpotVMTypes 符号查找成功

```gdb
# 附加到正在运行 jhsdb 的 JVM（不是目标 JVM）
gdb -p <jhsdb-pid>

# 在 lookupInProcess() 打断点，只在查找 gHotSpotVMTypes 时触发
(gdb) break HotSpotTypeDataBase.java:607
(gdb) condition 1 strstr(symbol, "gHotSpotVMTypes") != 0

# 继续执行并触发 jhsdb 操作
(gdb) continue

# 当断点命中后，检查返回值
(gdb) finish
(gdb) print $rax  # (x86_64 返回值在 rax)
# 期望: 返回非零值 (Address 对象指针)，具体值取决于目标 JVM 中符号加载地址
# 通常范围: 0x7f<...>  (libjvm.so 的 .data 段地址，在 64-bit 地址空间高位)

# 验证 libjvm.so 基址
(gdb) info proc mappings
# 期望: 找到 libjvm.so 映射行，基址 + 符号偏移 = lookup 返回的地址
```

### 断言 3: readVMTypes() 读取具体类型数量

```gdb
# 在 readVMTypes() 结束后打断点，检查类型数量
(gdb) break HotSpotTypeDataBase.java:207  # readVMTypes() 返回处
# 或搜索代码中 typeCount 累加位置

# 查看类型数据库中的类型数量
(gdb) print typeDataBase.typeMap.size()
# 期望: 具体数字，对于 JDK 17 ~500-600，对于 JDK 11 ~450-550
# 打印前 5 个类型名验证
(gdb) print typeDataBase.typeMap.keySet().toArray()[0..4]
# 期望: 看到 "Metadata", "Klass", "InstanceKlass", "ArrayKlass", "ObjArrayKlass" 等类型名
```

### 断言 4: VM.initialize() 触发 Observer 通知

```gdb
# 在 VM.initialize() 的 Observer 遍历处打断点
(gdb) break VM.java:430  # for (Iterator iter = vmInitializedObservers.iterator())
(gdb) continue

# 检查 vmInitializedObservers 列表
(gdb) print vmInitializedObservers.size()
# 期望: ≥3 (Universe, Threads, SystemDictionary 至少注册了 3 个 Observer)

# 打印每个 observer 类名
(gdb) print vmInitializedObservers.get(0).getClass().getName()
# 期望: 包含 "Universe" 或类似的类名
```

### 断言 5: PageCache 缓存命中减少 ptrace 调用

```gdb
# 设置两个条件断点
(gdb) break DebuggerBase.java:222  # readBytes() 入口，检查缓存
(gdb) break ps_proc.c:69           # process_read_data() — Native 层 ptrace 调用点

# 第一次读取线程栈区域地址 (冷启动)
(gdb) continue
# 期望: 先命中 readBytes() → 缓存未命中 → 命中 process_read_data() (ptrace 调用)
# 验证: readBytes 后 process_read_data 确实被调用

# 第二次读取同一地址 (缓存命中)
(gdb) ignore 2  # 忽略 Native 端断点
(gdb) continue  
# 期望: 再次命中 readBytes() → 缓存命中 → 不会命中 process_read_data() (无 ptrace 调用)
```

### 断言 6: Address.addOffsetTo(8) 正确偏移

```gdb
# 创建 Address 对象 (通过 Debugger 解析地址字符串)
(gdb) break Address.java:159  # addOffsetTo() 方法
(gdb) continue

# 检查输入地址
(gdb) print this.target  # (根据 LinuxAddress 实现)
# 期望: 如 0x7f1234000000

# 步过 addOffsetTo 调用
(gdb) next

# 检查输出
(gdb) print result.target  # 或 getAddressValue()
# 期望: 0x7f1234000008 (= 0x7f1234000000 + 8)
```

### 断言 7: OopHandle 的解码逻辑

```gdb
# 目标 JVM 必须启用 -XX:+UseCompressedOops
# java -XX:+UseCompressedOops -cp test.jar TestWait &
# 32-bit compressed oop 范围: 0x00000000 - 0xFFFFFFFF (前 32GB 堆)

# 在 LinuxDebuggerLocal 或 DebuggerBase 的 Oop 解码处打断点
(gdb) break DebuggerBase.java:460  # narrowOopBase + (oop << narrowOopShift)

# 检查解码前压缩 Oop 值
(gdb) print narrowOopBase
# 期望: 0 (JDK 8+) 或 堆基址 (JDK 7)
(gdb) print narrowOopShift
# 期望: 3 (8字节对齐的32-bit压缩指针 → addr = base + oop << 3)

# 验证解码结果
(gdb) print (oop << narrowOopShift) + narrowOopBase
# 期望: 完整 64-bit 地址，在堆范围内 (heapStart, heapEnd)

---

## §十一 与 README 和同组 prompt 的连续性

### 11.1 与 README 的关系

本文档是 Phase 20 的第 04 篇，对应 `probe_md/20-sa-postmortem/README.md` 中的：

- **§§ 04 - SA 启动流水线（Java 层）** (`README.md` 待补充)
- 核心内容: HotSpotAgent → TypeDataBase → VM 初始化

**连续性保证**:
- 本文档覆盖 `HotSpotAgent.java`、`HotSpotTypeDataBase.java`、`VM.java` 三个核心文件
- 前文（prompt-00/01/02/03）覆盖了 Native 层，本文档覆盖 Java 层，形成完整图景
- 后文（prompt-05/06）覆盖工具链（`jstack`/`jmap` 实现），依赖本文档的 VM 初始化解释

### 11.2 与同组 prompt 的关系

| Prompt | 文件 | 与本文档的关系 |
|--------|------|---------------|
| prompt-00 | SA 架构 + Native 核心数据结构 | 本文档的 Java 层是 prompt-00 的延续（三层架构：Java → JNI → Native） |
| prompt-01 | Live Debugging (ps_proc.c) | 本文档的 `setupDebugger()` 调用 prompt-01 的 `process_read_data()` |
| prompt-02 | Postmortem Debugging (ps_core.c) | 本文档的 `setupDebugger()` 也支持 core dump 模式（调用 `ps_core.c`） |
| prompt-03 | JNI Bridge + Symbol (LinuxDebuggerLocal.c) | 本文档的 `lookupInProcess()` 通过 JNI 调用 prompt-03 的 `lookupByName0()` |
| prompt-04 (本文档) | SA 启动流水线（Java 层） | 核心：HotSpotAgent → TypeDataBase → VM 初始化 |
| prompt-05 | jstack 实现 | 依赖本文档的 VM 初始化（需要 `VM.getVM().getThreads()`） |
| prompt-06 | jmap 实现 | 依赖本文档的 VM 初始化（需要 `VM.getVM().getObjectHeap()`） |

### 11.3 避免重复

- **不与 prompt-00 重复**: 本文档不展开 Native 层细节（那是 prompt-00/01/02 的内容），只解释 Java 层如何调用 Native 层
- **不与 prompt-03 重复**: 本文档只解释 `lookupInProcess()` 的 Java 层逻辑，不展开 JNI 桥接层细节（那是 prompt-03 的内容）
- **不与 prompt-05/06 重复**: 本文档只解释启动流水线，不展开 `jstack`/`jmap` 的具体实现（那是 prompt-05/06 的内容）

---

## §十二 质量自检清单

写完文档后，逐项检查：

- [ ] §四 深度问题组 ≥6 组，每组含 counterfactual
- [ ] §八 Prohibited ≥8 条
- [ ] §九 Required ≥8 条
- [ ] §十 Verification ≥7 断言
- [ ] §四 答案方向 ≥8 行（随机抽取 3 个验证）
- [ ] Beginner Callout ≥7 个，且只在 §一 内
- [ ] man 手册引用覆盖所有核心 syscall
- [ ] 独立的边缘场景 section ≥3 场景
- [ ] §二 有 syscall/二进制/全局状态表
- [ ] 标题格式 `# NN-Name — Subtitle`
- [ ] 运行 `rg '^## §' file.md` 验证连续无跳号
- [ ] 总行数 ≥450 行（目标是 2500-3500 行）
- [ ] 解释 SA 的"反序列化"魔法（这是核心要求）

---

## 附录: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `HotSpotAgent.attach()` | `HotSpotAgent.java:134` | 入口方法 |
| `HotSpotAgent.go()` | `HotSpotAgent.java:305` | 协调器 |
| `HotSpotAgent.setupDebugger()` | `HotSpotAgent.java:310` | 阶段 1: 创建 Debugger |
| `HotSpotAgent.setupDebuggerLinux()` | `HotSpotAgent.java:584` | Linux 平台实现 |
| `HotSpotAgent.attachDebugger()` | `HotSpotAgent.java:675` | 附加到进程 |
| `HotSpotAgent.setupVM()` | `HotSpotAgent.java:380` | 阶段 2: 创建 TypeDataBase + VM |
| `HotSpotTypeDataBase()` 构造函数 | `HotSpotTypeDataBase.java:81` | 反序列化引擎入口 |
| `HotSpotTypeDataBase.readVMTypes()` | `HotSpotTypeDataBase.java:142` | 读取类型定义 |
| `HotSpotTypeDataBase.readVMStructs()` | `HotSpotTypeDataBase.java:391` | 读取字段定义 |
| `HotSpotTypeDataBase.lookupInProcess()` | `HotSpotTypeDataBase.java:607` | 符号查找 |
| `VM.initialize()` | `VM.java:423` | VM 单例初始化 |
| `VM.registerVMInitializedObserver()` | `VM.java:450` | Observer 注册 |
| `VM.getUniverse()` | `VM.java:635` | 懒加载 Universe |
| `DebuggerBase.cache` | `DebuggerBase.java:66` | PageCache 字段 |
| `DebuggerBase.initCache()` | `DebuggerBase.java:178` | PageCache 初始化 |
| `DebuggerBase.readBytes()` | `DebuggerBase.java:222` | 通过缓存读取 |
| `Address` 接口 | `Address.java:66` | 地址抽象 |
| `MachineDescription` 接口 | `MachineDescription.java:33` | 机器描述 |

---

**END OF PROMPT**
