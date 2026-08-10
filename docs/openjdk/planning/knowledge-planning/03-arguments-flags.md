# 域 03: Arguments & Flags — 知识规划

> 源码路径: runtime/arguments.* + runtime/globals.* + runtime/flags/ + services/writeableFlags.* + os/linux/globals_* + cpu/x86/globals_*
> 源码量: ~31 文件 / ~15,000 行 | 非巨型域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| runtime/globals.hpp:100-2840 | **JVMFlags 宏声明体系**: RUNTIME_FLAGS/FLAG_MATERIALIZE/PRODUCT_FLAG/DIAGNOSTIC_FLAG/EXPERIMENTAL_FLAG 七层宏——每个flag一次声明生成5+份代码(constant/flag/declare/define/materialize) | High |
| runtime/globals.hpp:45-99 + globals_extension.hpp | **Flag类型系统**: JVMFlag(Value/Origin/Kind), JVMFlagType枚举(int/uint/bool/ccstr/double/uint64_t/size_t), intx/uintx平台自适应类型 | High |
| runtime/flags/jvmFlag.cpp:1-1536 | **JVMFlag — 单flag状态机**: Origin(DEFAULT→ARG→ERGONOMIC→MANAGEABLE→INTERNAL), set_bool/set_int/check_constraint, Flag值的读/写/锁 | High |
| runtime/flags/jvmFlagConstraintList.cpp + jvmFlagConstraintsCompiler.cpp + jvmFlagConstraintsRuntime.cpp | **Flag约束验证**: JVMFlagConstraintFunc(含check函数), 按phase注册(AfterParse→AfterErgo→AfterMemoryInit), Compiler/Runtime约束分离 | High |
| runtime/flags/jvmFlagRangeList.cpp | **Flag范围检查**: JVMFlagRangeFunc(int/bool/intx/uintx/uint64_t/size_t/double范围), 每个flag可有min+max | High |
| runtime/flags/jvmFlagWriteableList.cpp | **可写Flag注册表**: JVMFlagWriteable检查, MANAGEABLE flag才可在运行时通过jcmd/Attach修改, 非MANAGEABLE拒绝写入 | High |
| runtime/arguments.cpp:1-4278 | **命令行解析引擎**: parse_vm_init_args/parse_each_vm_init_arg/Arguments::parse, -XX:+Flag/-XX:-Flag/-XX:Flag=value三种语法, 聚合参数(UseParallelGC+UseConcMarkSweepGC→互斥), System.getProperty设置 | High |
| runtime/arguments.cpp:2400-4278 | **自动调节(Ergonomics)**: 根据平台(class_server/HasVitals/PhysicalMemory/CPUCount)自动设置ParallelGCThreads/ConcGCThreads/InitialHeapSize等, 平台检测→flag自动调整 | High |
| services/writeableFlags.cpp + writeableFlags.hpp | **jcmd可写Flag API**: pd_set_flag/pd_print_flag, 通过dynamic DCmd热修改flag值, MANAGEABLE flag管理 | Medium |
| os/linux/globals_linux.hpp + cpu/x86/globals_x86.hpp + c1_globals_linux.hpp + c2_globals_linux.hpp + c1_globals_x86.hpp + c2_globals_x86.hpp | **平台特有Flags**: 6个平台文件定义OS/CPU/C1/C2专用flag——通过GLOBALS_EXTENSION宏注入globals_extension.hpp的聚合体系 | High |
| runtime/flags/jvmFlag.cpp:200-800 | **Flag类型转换与检查**: type2enum→enum2type双向映射, Flag_writelock(修改时加锁), Flag值修改的原子性保证 | Medium |
| runtime/arguments.cpp:800-1200 | **Agent加载与JVM初始化顺序**: -agentlib/-javaagent解析→加载agent库→ABORT_ON_ERROR→agent初始化顺序与flag设置顺序的依赖管理 | Medium |

*12 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)

| KP | 出现文件 |
|----|---------|
| Flag声明宏体系 + globals_extension聚合 | globals.hpp, arguments.cpp, jvmFlag.cpp, globals_linux.hpp, globals_x86.hpp, c1_globals_*, c2_globals_*, globals_extension.hpp |
| 命令行解析与Ergonomics | arguments.cpp, jvmFlag.cpp, jvmFlagConstraintList.cpp, jvmFlagRangeList.cpp, globals.hpp |

### P2 — 局部重要 (2-4 文件)

| KP | 出现文件 |
|----|---------|
| JVMFlag 状态机 + 类型转换 | jvmFlag.cpp.hpp, arguments.cpp |
| Flag 约束验证 | jvmFlagConstraintList.cpp, jvmFlagConstraintsCompiler.cpp, jvmFlagConstraintsRuntime.cpp |
| Flag 范围检查 | jvmFlagRangeList.cpp, jvmFlag.cpp |
| 平台 Flags (OS+CPU+C1+C2) | 6个平台文件 |

### P3 — 孤立 (1 文件/小系统)

| KP | 文件 |
|----|------|
| jcmd可写Flag API | writeableFlags.cpp.hpp |
| Agent加载与初始化顺序 | arguments.cpp (单文件内) |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (4 KP)

| KP | 为什么 🔴 |
|----|---------|
| Flag声明宏体系 | **架构决策**: 为什么用7层宏(RUNTIME/PRODUCT/DIAGNOSTIC/EXPERIMENTAL/MANAGEABLE/MATERIALIZE)而不是简单的key-value表？→ 每个flag需要同时初始化(declare)+定义(define)+物化(materialize)三份代码到不同编译单元(globals.cpp/adlc/vmStructs)。宏展开一次→生成5+份不同形式的代码, 比手工维护5份独立声明更不易出错 |
| 命令行解析 + Ergonomics | **自动调节策略**: Ergo阶段在parse之后自动调整flag值。ParallelGCThreads=CPU_COUNT*8/8→Ergo设置。为什么parse和ergo分开？→ parse只做参数解析, ergo做语义级调节——分离后parse的结果可预测(不受以后ergo规则变化影响) |
| Flag约束 (Constraint) | **约束体系**: 为什么分Compiler/Runtime两个约束文件？→ Compiler约束(如UseAVX需要C2)在Compiler初始化时检查; Runtime约束(如UseCompressedOops需要heap≤32GB)在运行时检查。不同的check时机避免过早(pre-init crash)或过晚(已在运行)的检查 |
| 平台Flags (6文件) | **可扩展体系**: globals_extension.hpp是JVMFlags枚举的"聚合入口"——每平台文件通过GLOBALS_EXTENSION宏注入自己的flags。Linux/CPU/C1/C2各自独立维护flag, 编译时统一聚合到一个JVMFlags枚举 |

### 🟡 Working — 有设计但非核心 (4 KP)

| KP | 说明 |
|----|------|
| JVMFlag 状态机 (Origin+Lock) | 精巧但模式固定——DEFAULT→ARG→ERGONOMIC→MANAGEABLE→INTERNAL的5级Origin |
| Flag 范围检查 | 每个flag的合法范围 (min/max) 验证, 防止-XX:NewRatio=0或负数 |
| Writeable Flag API | jcmd可修改运行中flag——MANAGEABLE flag的热更新机制 |
| Agent加载顺序 | -agentlib vs -javaagent的先后加载和初始化顺序 |

### 🟢 Surface — 了解即可 (3 KP)

| KP | 说明 |
|----|------|
| Flag类型转换 (type2enum↔enum2type) | 簿记账——类型映射表 |
| JVMFlag修改锁 (Flag_writelock) | 标准mutex lock |

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: Flag声明宏体系 — 无前置
  ├─ B: 命令行解析 — 依赖A(parsed flags store into Flag values)
  │    ├─ C: Ergonomics — 依赖B(after parse, auto-tune flags)
  │    └─ D: 约束验证 — 依赖B+FlagRange (check constraints)
  └─ E: 平台Flags — 依赖A(GLOBALS_EXTENSION聚合—独立扩展点)
       └─ F: WriteableFlag — 依赖A(MANAGEABLE flag标记)
```

### 教学顺序

```
1. Flag定义层 — 宏体系 + 平台Flags (A+E)
2. Flag处理层 — 解析 + Ergonomics + 约束 + 范围 (B+C+D)
3. Flag管理层 — Writeable + 修改锁 + 类型转换 (F+辅助)
```

### 文章拆分建议

非巨型域 (~15K行, 中等), 拆 2 篇：

- **01-flag-definition-system.md** — Flag宏体系 + 平台Flags + 聚合扩展
- **02-flag-processing-and-management.md** — 解析+Ergonomics+约束验证+管理API
