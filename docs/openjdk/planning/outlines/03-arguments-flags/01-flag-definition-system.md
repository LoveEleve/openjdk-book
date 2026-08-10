# 01. Flag 定义体系 — 一个宏，五份代码

> 🔴 Deep | 12 KP 中的 4 个核心机制
> 读者处境: 你用过 `-XX:+UseG1GC`。这个字符串怎么变成 C++ bool——在编译期，不是运行时。

### 1. 七层宏声明 — 为什么不用 JSON config？

场景: JVM 启动——命令行上出现了 `-XX:+UseG1GC`。JVM 怎么知道 UseG1GC 是个 bool？怎么知道它默认是 true？

**`PRODUCT_FLAG(bool, UseG1GC, true, ...)`** (`globals.hpp:100`):
- 一行宏 → C 预处理器展开为 5+ 份独立代码:
  - `const bool UseG1GC = true;` — 直接当 C++ 常量用
  - `JVMFlag UseG1GcFlag = { "UseG1GC", JVMFlagType::bool, ... }` — JVMFlag 对象用于 jcmd/PrintFlagsFinal
  - `extern "C" { JVMFlag* UseG1GC_flag_addr(); }` — SA (Serviceability Agent) 通过地址读 flag
  - `static JVMFlag UseG1GC_data;` — 每个 flag 的静态存储
- 源码链: `globals.hpp:100` PRODUCT_FLAG 宏定义 → `globals_extension.hpp:40` GLOBALS_EXTENSION 聚合 → `globals.cpp:25` 实际 flag 实例化
- [C++: C 预处理器宏展开——`#define PRODUCT_FLAG(type, name, value, doc)` → `const type name = value;` + `JVMFlag name##Flag(...)`。宏在预处理阶段 (cc -E) 展开为纯 C++ 代码——编译器看到的是展开后的内容。每个 flag 约 200B 的 static 存储 + 1 个 JVMFlag 对象]
- 为什么不是运行时 JSON config？→ 编译期类型检查——`-XX:UseG1GC=hello` 直接编译错误 (bool 不接受字符串)，不等到运行时

**七层宏的分类** (`globals.hpp:100-200`):
- RUNTIME_FLAGS: 通用 flag — 所有版本编译
- PRODUCT_FLAG: 生产环境 — 正式 release 包含
- DIAGNOSTIC_FLAG: 诊断 — `-XX:+UnlockDiagnosticVMOptions` 解锁
- EXPERIMENTAL_FLAG: 实验 — `-XX:+UnlockExperimentalVMOptions` 解锁
- MANAGEABLE_FLAG: 运行时修改 — jcmd VM.set_flag 可改
- MATERIALIZE_FLAG: 物化 — 内存映射别名 (SA 访问)

**Origin 5 级优先层次** (`jvmFlag.hpp:68`):
- DEFAULT → ARG(命令行) → ERGONOMIC(自动调整) → MANAGEABLE(运行时修改) → INTERNAL(VM内部)
- 实际语义: `set_bool(UseG1GC, false, ARG)` 后 `set_bool(UseG1GC, true, ERGO)` 被忽略 — 用户显式设置 > 平台自适应
- [C++: enum 值代表 "这个设置从哪来的"——dcmd VM.flags 输出时 Origin 列显示来源。`ARG=2` vs `ERGO=4` 在 debug 时区分"用户指定的" vs "JVM 自动调整的"]

**flag 类型系统** (`jvmFlag.cpp:200-400`):
- bool / int / uint / uint64_t / intx / uintx / size_t / ccstr / double
- intx/uintx 平台自适应: 32-bit 时 intx=32bit (int), 64-bit 时 intx=64bit (long)
- [C++: `#ifdef _LP64` intx=long (8B) `#else` intx=int (4B)。flag 值在不同指针宽度下 "类型一致" — `-XX:NewSize=4m` 在 32-bit 和 64-bit 上含义相同]

### 2. 平台 Flags — GLOBALS_EXTENSION 聚合注入

场景: UseAVX 是 x86 专有的 flag——ARM JVM 里没有它。怎么做到 ARM 编译时自动排除 UseAVX？

**globals_extension.hpp 宏注入链** (`globals_extension.hpp:40`):
- `GLOBALS_EXTENSION` 宏——空的扩展槽——被 6 个平台文件接管
- 机制: 每个平台文件先 `#define GLOBALS_EXTENSION(Name) Name(FLAG1) Name(FLAG2)...` 定义自己的 flags→再 `#include globals_extension.hpp`→GLOBALS_EXTENSION 展开为平台特有 flag 的声明
- [C++: 宏注入——不是 include 链是宏重定义链。每次 `#define GLOBALS_EXTENSION` + `#include` = 一次新的代码生成。6 个平台文件=6 次不同的 GLOBALS_EXTENSION 展开——生成 6 份不同的 flag 集合]
- `os/linux/globals_linux.hpp`: Linux 特有—UseLinuxPosixThreadCPUClocks, UseCGroupMemoryLimit
- `cpu/x86/globals_x86.hpp`: x86 特有—UseAVX, UseSSE, UseSHA
- `c1_globals_linux.hpp` + `c2_globals_linux.hpp` + `c1_globals_x86.hpp` + `c2_globals_x86.hpp`: C1/C2 编译器专用 flag

### 3. Flag 约束 + 范围 — 启动时 5 道关卡

**jvmFlagConstraintList / jvmFlagRangeList** (`jvmFlagConstraintList.cpp`, `jvmFlagRangeList.cpp`):
- Constraint: flag 间的逻辑关系—"UseCompressedOops=true → heap ≤32GB" (`jvmFlagConstraintsRuntime.cpp:52`)
- Range: 单 flag 合法值—"NewRatio 必须在 0~100" (`jvmFlagRangeList.cpp`)
- [C++: `JVMFlagConstraintFunc` 是 `bool (*)(JVMFlag*, JVMFlagOrigin)` 函数指针。每个 flag 注册一个 constraint 函数——每次 flag set 后立即调用。返回 false→set 被拒绝→JVM 打印错误并 exit]
- 三阶段 check:
  - AfterParse: 纯语法—所有 flag 解析完成
  - AfterErgo: 语义—Ergo 调整后 (Ergo 可能改值释放新冲突)
  - AfterMemoryInit: 内存—Metaspace/CodeCache 分配后 (heap 大小相关约束现在才能检查)

---

### 核心悬念

**"一行 `PRODUCT_FLAG(bool, UseG1GC, true, ...)` → 5 份独立代码 + 5 道验证关卡——没有 flag 能绕过这个体系。"** — 编译期的宏展开让 flag 定义同时充当 C++ 常量声明、JVMFlag 对象、SA 访问入口——三者从同一行源码生成。平台 flag 通过 GLOBALS_EXTENSION 宏注入——ARM/PPC 编译时自动排除 x86 专属 flag。下一章: 这些 flag 怎么被解析——怎么从命令行字符串变成 JVMFlag::set？

> → [02-flag-processing-and-management.md](02-flag-processing-and-management.md)
