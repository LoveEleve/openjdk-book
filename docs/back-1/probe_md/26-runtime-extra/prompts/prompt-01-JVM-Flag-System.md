# Prompt 01 — JVM Flag System（参数解析+Flag 注册+三层验证）

## §〇 Production Scenario（生产场景）

### 场景 1：错误的 -XX flag 导致 VM 崩溃

你负责维护一个核心 Java 服务。运维为了降低 GC 停顿，在启动脚本中加入了 `-XX:+UseConcMarkSweepGC`。但该服务运行在 JDK 14+ 上，CMS 已被移除。JVM 启动时报错：

```
Unrecognized VM option 'UseConcMarkSweepGC'
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

你需要理解：`parse_each_vm_init_arg` 如何把 "UseConcMarkSweepGC" 传给 `JVMFlag::find_flag()` 做线性搜索？搜索失败后 fuzzy_match() 能否给出 "did you mean UseG1GC"? 错误消息通过什么路径输出到标准错误？

### 场景 2：Ergonomic 与用户参数的冲突

你在容器化部署 (cgroups v1) 中同时使用了 `-Xmx4g` 和 `-XX:MaxRAMPercentage=75.0`。JVM 启动后发现实际堆只有 2.5G。为什么 -Xmx 被覆盖了？

原因链：`Arguments::apply_ergo()` 调用 `set_ergonomics_flags()` → `GCArguments::initialize_flags()` → 读取 cgroup 内存限制 → `FLAG_SET_ERGO(MaxHeapSize, ...)` → 因为 ERGONOMIC（优先级 5）低于 COMMAND_LINE（优先级 1），但 JVMFlag 内部通过 `set_origin()` 只保留最新 origin 的值，不保证 "命令行一定覆盖 ergonomic" —— 需要理解 origin 的优先级和 Flags 位域的具体语义。

### 场景 3：UnlockExperimentalVMOptions 忘记放在首位

开发想测试 ZGC，在启动命令中写：

```
java -XX:+UseZGC -XX:+UnlockExperimentalVMOptions -jar app.jar
```

报错：

```
Error: VM option 'UseZGC' is experimental and must be enabled via -XX:+UnlockExperimentalVMOptions.
Error: The unlock option must precede 'UseZGC'.
```

为什么顺序这么关键？`parse_each_vm_init_arg` 是**逐参数顺序解析**的，解析 `-XX:+UseZGC` 时 `find_flag()` 检查 `is_unlocked()` → 发现是 KIND_EXPERIMENTAL 但 `UnlockExperimentalVMOptions` 尚未设置 → 返回 NULL → 报错退出。此时全局变量 `UnlockExperimentalVMOptions` 还是 false。

---

## §一 Task + Narrative + 7 Beginner Callouts

### Task

编写一份面向中级 JVM 工程师的技术文档，深度分析 JVM Flag 系统的全链路：从 `Arguments::parse()` 的 4 源参数解析管线，到 `JVMFlag` 静态注册表的多类型系统，再到 `Constraint + Range + Writeable` 三层验证机制的注册和执行。

### Narrative

HotSpot 的参数系统是 JVM 可观测性和可调优性的基石。每天数百万次 `java -Xmx2g -XX:+UseG1GC` 调用背后，是一个严谨的**参数注册-解析-约束验证-工效应用**四阶段流水线。本文档以 `Arguments::parse()` 为主线，串联 `JVMFlag` 的位图编码、`flagTable` 的宏生成机制、以及 `ConstraintList/RangeList/WriteableList` 的三层守卫模型。

### 7 Beginner Callouts

> **Beginner Callout 1: -X vs -XX 的区别**
> `-X` 是非标准选项（如 `-Xmx`、`-Xms`），规范未定义，各 JVM 实现不同。`-XX` 是实验/调优选项，由 `Arguments::process_argument()` 统一处理。`-XX:+Flag` 开启 bool flag，`-XX:-Flag` 关闭，`-XX:Flag=value` 设置数值/字符串 flag。

> **Beginner Callout 2: Debug vs Release 构建**
> HotSpot 有两种构建模式：`PRODUCT`（发布版）和 `fastdebug`（调试版）。在 PRODUCT 构建中，`KIND_DEVELOP` 和 `KIND_NOT_PRODUCT` 类型的所有 flag 会被 `is_constant_in_binary()` 方法过滤掉，表现为"不存在"。这意味着 `-XX:+TraceBytecodes` 在 release JDK 上会报 "Unrecognized VM option"。

> **Beginner Callout 3: flag 值的来源优先级**
> JVM 有 9 个 origin 等级（DEFAULT=0, COMMAND_LINE=1, ENVIRON_VAR=2, ..., JIMAGE_RESOURCE=8），但 origin 编号越大不一定优先级越高。文档会揭示 origin 的真正语义：flag 的 `_flags` 位域存储的是"最后一次修改的来源"，不是"优先级最高者胜出"。

> **Beginner Callout 4: `ccstr` 和 `ccstrlist` 的差异**
> `ccstr` 是单值字符串 flag（如 `-XX:ErrorFile=/tmp/hs_err_%p.log`），`ccstrlist` 是可累积列表（如 `-XX:CompileOnly=com.foo.*`），值之间用换行符 `\n` 分隔。源码见 `jvmFlag.cpp:255-261` 中的 `is_ccstr()` 和 `ccstr_accumulates()`。

> **Beginner Callout 5: intx vs int 的区别**
> `intx` 和 `int` 在 64-bit 平台上完全相同（都是 64 位），在 32-bit 平台上 intx 是 32 位而 int 是 32 位。使用 `intx` 是为了平台兼容性——`max_intx` 在 64-bit 是 INT64_MAX，在 32-bit 是 INT32_MAX。

> **Beginner Callout 6: `FLAG_SET_*` 宏族**
> `FLAG_SET_DEFAULT(flag, value)`、`FLAG_SET_ERGO(flag, value)`、`FLAG_SET_CMDLINE(flag, value)` 等宏是对 `JVMFlag::xxxAtPut()` 的封装。每个宏设置 origin 并触发约束验证。`FLAG_IS_DEFAULT(flag)` 检查 origin 是否为 DEFAULT——这是区分"用户显式设置"和"JVM 默认值"的关键。

> **Beginner Callout 7: printFlags 系列诊断命令**
> `-XX:+PrintFlagsInitial`（打印所有 flag 默认值）、`-XX:+PrintFlagsFinal`（打印所有 flag 最终值+origin）、`-XX:+PrintFlagsRanges`（打印范围和约束信息）、`jcmd <pid> VM.flags`（运行时查询）。内部都调用 `JVMFlag::printFlags()`。

---

## §二 Standard Environment（标准环境）

### Base

- **源码根目录**: `src/hotspot/share/runtime/` + `src/hotspot/share/runtime/flags/`
- **Source roots** file:line:
  - `make/hotspot/lib/CompileJvm.gmk:153` — BUILD_LIBJVM 定义
- **构建命令** (debug 版):
  ```bash
  bash configure --with-debug-level=fastdebug --with-boot-jdk=/path/to/jdk
  make hotspot
  ```
- **产物路径**: `build/linux-x86_64-server-fastdebug/hotspot/variant-server/libjvm/hotspot/libjvm.so`
- **启动命令示例**:
  ```bash
  gdb --args ./build/linux-x86_64-server-fastdebug/jdk/bin/java \
    -XX:+UnlockDiagnosticVMOptions -XX:+PrintFlagsFinal -version
  ```

### 涉及的系统调用

| Syscall | Man 参考 | JVM 使用场景 |
|---------|---------|-------------|
| `read` | `man 2 read` | 读取 `.hotspotrc` / `-XX:Flags=` 配置文件 |
| `open/stat` | `man 2 open`, `man 2 stat` | 检查配置文件是否存在 |
| `malloc/free` | `man 3 malloc` | `os::strdup_check_oom()` 在 ccstr flag 设置时分配/释放 |
| `qsort` | `man 3 qsort` | `printFlags()` 和 `printSetFlags()` 中按名称排序 flagTable |
| `vfprintf` | `man 3 vfprintf` | `jio_vfprintf()` 输出约束违规错误到 stderr |

### 关键全局状态

| 变量 | 位置 (arguments.cpp) | 含义 |
|------|---------------------|------|
| `JVMFlag::flagTable[]` | jvmFlag.cpp:819 | 所有 JVM flag 的静态数组（编译时生成） |
| `JVMFlag::numFlags` | jvmFlag.cpp:896 | flag 总数（含 NULL 哨兵） |
| `JVMFlagConstraintList::_constraints` | jvmFlagConstraintList.cpp:272 | 约束对象动态数组 (72 容量起步) |
| `JVMFlagRangeList::_ranges` | jvmFlagRangeList.cpp:322 | 范围对象动态数组 (379 容量起步) |
| `JVMFlagWriteableList::_controls` | jvmFlagWriteableList.cpp:113 | 可写性对象动态数组 (2 容量起步) |

---

## §三 Source Files Table（源文件表）

| # | 文件路径 | 行数 | 角色 |
|:--|---------|:---:|------|
| 1 | `runtime/arguments.hpp` | 680 | `Arguments` 类声明：解析管线接口、静态成员、辅助结构体 |
| 2 | `runtime/arguments.cpp` | ~4,380 | `Arguments::parse()` 主解析管线 (15 阶段)、工效调整、环境变量解析 |
| 3 | `runtime/flags/jvmFlag.hpp` | 282 | `JVMFlag` 结构体：Flags 位域、Error 枚举、8 种类型 get/set |
| 4 | `runtime/flags/jvmFlag.cpp` | 1,537 | `flagTable[]` 静态注册表、`find_flag()` 线性搜索、fuzzy_match |
| 5 | `runtime/flags/jvmFlagConstraintList.hpp` | 101 | `JVMFlagConstraint` 基类 + `JVMFlagConstraintList` 容器 |
| 6 | `runtime/flags/jvmFlagConstraintList.cpp` | 369 | Constraint 子类化（按类型分 8 个子类）、init() 宏展开、三级验证调度 |
| 7 | `runtime/flags/jvmFlagRangeList.hpp` | 74 | `JVMFlagRange` 基类 + `JVMFlagRangeList` 容器 |
| 8 | `runtime/flags/jvmFlagRangeList.cpp` | 431 | Range 子类化（按类型分 7 个子类）、init() 含 379 容量预分配 |
| 9 | `runtime/flags/jvmFlagWriteableList.hpp` | 67 | `JVMFlagWriteable` 三态控制 + `JVMFlagWriteableList` |
| 10 | `runtime/flags/jvmFlagWriteableList.cpp` | 205 | Writeable init() + mark_startup() |
| 11 | `runtime/flags/jvmFlagConstraintsCompiler.hpp` | 74 | 18 个 Compiler flag 约束函数声明 |
| 12 | `runtime/flags/jvmFlagConstraintsCompiler.cpp` | 407 | Compiler 约束实现（CICompilerCount、CodeCacheSegmentSize 等） |
| 13 | `runtime/flags/jvmFlagConstraintsRuntime.hpp` | 50 | 8 个 Runtime flag 约束函数声明 |
| 14 | `runtime/flags/jvmFlagConstraintsRuntime.cpp` | 143 | Runtime 约束实现（ObjectAlignment、BiasedLocking 等） |

---

## §四 Deep Dive Question Groups（深度问题组）

### QG-1: Arguments::parse() 的 15 阶段解析管线

**原始问题**: `Arguments::parse()` 从接收 `JavaVMInitArgs*` 到 return JNI_OK，完整走过了多少个阶段？每个阶段负责什么？`ScopedVMInitArgs` 的生命周期如何保证 "展开后参数" 的内存安全？

**答案方向** (≥8 行):
1. 阶段 1-3: 初始化三层验证系统 `JVMFlagRangeList::init()` / `ConstraintList::init()` / `WriteableList::init()` — 这三个 init() 使用完全相同的宏展开模式（`emit_xxx_no(NULL VM_FLAGS(...))`），通过 `IGNORE_RANGE`/`IGNORE_CONSTRAINT`/`IGNORE_WRITEABLE` 参数在第三步才填充 payload
2. 阶段 4: 解析 `JAVA_TOOL_OPTIONS` 环境变量 (`:3844`)
3. 阶段 5: 解析 `_JAVA_OPTIONS` 环境变量 (:3844)
4. 阶段 6: 从 jimage resource 读取 vm options (ClassLoader::lookup_vm_options(), :3844)
5. 阶段 7-10: 四次 `expand_vm_options_as_needed()` 确保 `-XX:Flags=` 内联文件被展开
6. 阶段 11: 解析 `-XX:Flags=<file>` 指定的配置文件或 `.hotspotrc` (:3932-3950) — PRODUCT 构建中跳过 `.hotspotrc` 但打印 warning
7. 阶段 12: `parse_vm_init_args()` 按 4 个优先级源顺序解析: jimage resource → JAVA_TOOL_OPTIONS → 命令行 → _JAVA_OPTIONS (:3960)
8. 阶段 13-15: 后处理 — SharedArchivePath、VerifySharedSpaces、suppress 平台不支持的 flag

**追问**: `JVMFlag::JIMAGE_RESOURCE` (origin=8) 的优先级看起来最高，为什么 jimage 中的 option 可以被命令行覆盖？origin 值不直接等于优先级——`parse_vm_init_args()` 的调用顺序才是真正的优先级链。
**量化对比**: flagTable 大小 ~800+ entries，每次 `find_flag()` 是 O(n) 线性搜索。与 Go 的 flag 包（map-based O(1)）相比，HotSpot 选择线性搜索的设计权衡是什么？
**Counterfactual**: 如果 `IGNORE_RANGE`/`IGNORE_CONSTRAINT`/`IGNORE_WRITEABLE` 参数在 `VM_FLAGS()` 宏的两个展开中位置互换（第一步就填 range payload），会发生什么？—— 第一次遍历 `emit_range_no` 时收到 range 数据，导致 flagTable 定义和 range 定义的宏展开无法共用同一套 FLAG_STRUCT 分发。

### QG-2: JVMFlag 的位域编码与类型擦除

**原始问题**: `JVMFlag::_flags` 是一个 32-bit `Flags` 枚举，如何在一个 int 里同时存储 9 种 origin + 12 种 kind + 1 个 `ORIG_COMMAND_LINE` 持久标记？`get_origin()` 返回的是"最后一次设置的 origin"还是别的语义？

**答案方向** (≥8 行):
1. bit 布局: low 4 bits = VALUE_ORIGIN (origin 0-8 用 4 bit 编码，mask = `right_n_bits(4)` = 0xF)
2. bit 4-16 = KIND_* flags (KIND_PRODUCT=bit4, KIND_DIAGNOSTIC=bit6, KIND_EXPERIMENTAL=bit7, ... KIND_JVMCI=bit16)
3. bit 17 = ORIG_COMMAND_LINE — **持久位**，一旦设置永不清除。与 `get_origin()` 不同，后者会被后续 origin 覆盖
4. `set_origin()` (:280-284 jvmFlag.cpp): 如果是 COMMAND_LINE，同时设置 low bits 和 ORIG_COMMAND_LINE 位。否则只设置 low bits
5. `is_command_line()` (:294-296) 读 ORIG_COMMAND_LINE 持久位；`get_origin()` 读 VALUE_ORIGIN_MASK——两者可能不同步（ergonomic 覆盖 origin 后 `get_origin()==ERGONOMIC` 但 `is_command_line()==true`）
6. `print_origin()` (:683-709) 利用这个不同步设计，当 `ERGONOMIC` 且有 ORIG_COMMAND_LINE 时输出 "command line, ergonomic"
7. KIND_MASK = `~(VALUE_ORIGIN_MASK | ORIG_COMMAND_LINE)` = 位 4-16 的范围
8. `is_constant_in_binary()` (:338-344) — PRODUCT 构建中 develop/notproduct flag 返回 true

**追问**: 如果两个线程同时从不同 origin 设置同一个 flag（如 jcmd 和 ergonomic 触发的调整），位域操作的原子性如何保证？
**量化对比**: 12 种 kind × 9 种 origin = 108 种组合，但 flagTable 实际只有 ~800 entries，矩阵稀疏度 > 99%。
**Counterfactual**: 如果 ORIG_COMMAND_LINE 是一个独立的 bool 变量而不是位域的一位，会怎么影响 `print_origin` 的输出逻辑？`ERGONOMIC` origin 但曾经命令行设置过的状态将无法表达。

### QG-3: Constraint 三层验证的调度时序

**原始问题**: `JVMFlagConstraintList` 定义了 `AtParse`/`AfterErgo`/`AfterMemoryInit` 三级验证，何时从一级切换到下一级？`_validating_type` 状态机如何工作？

**答案方向** (≥8 行):
1. `AtParse` (0) — 在 `parse_each_vm_init_arg()` → `process_argument()` → `JVMFlag::xxxAtPut()` 中被触发 (`validated_after_ergo()==false`)
2. `AfterErgo` (1) — 在 `Threads::create_vm()` 中 `Arguments::apply_ergo()` 返回后，调用 `JVMFlagConstraintList::check_constraints(AfterErgo)` 触发 (:357-368)
3. `AfterMemoryInit` (2) — 在 `universe_init()` 中 `Metaspace::global_initialize()` 返回后触发
4. `check_constraints(type)` 递增 `_validating_type`，然后遍历所有 constraint 只执行 `constraint->type() == type` 的
5. `find_if_needs_check()` (:347-353) — 只有当 `constraint->type() <= _validating_type` 时才返回 constraint 指针，这是"已过阶段不再检查"的关键
6. 顺序保证: `check_constraints()` line 358 的 `guarantee(type > _validating_type, "Constraint check is out of order.")` 防止回退
7. `apply_constraint_and_check_range_intx()` (jvmFlag.cpp:1168-1181) — 被各个 `xxxAtPut()` 调用时，先 range check 后 constraint check，第 5 参数 `verbose` 传入 `!validated_after_ergo()` 控制早期解析时打印错误

**追问**: 为什么 `ConstraintType` 要设计为递增枚举而不是独立标识？—— 因为约束间有依赖顺序：`AfterMemoryInit` 的 ObjectAlignment 约束需要知道 page size，必须在 OS 初始化之后。
**量化对比**: ConstraintList 初始容量 72，RangeList 初始容量 379——验证层占内存约 `72×8 + 379×24 ≈ 9.7KB`。
**Counterfactual**: 如果约束验证不是推迟到 `parse()` 之外而是在每次 `FLAG_SET_DEFAULT` 时立即验证，CICompilerCount 约束会怎样失败？C1 flag 尚未定义时 check 报错。

### QG-4: Range check — 静态上下界验证

**原始问题**: `JVMFlagRangeList` 初始容量 379，哪些 flag 有显式范围？没有显式范围的 flag 如何获取默认范围？`check_ranges()` 什么时候被调用？

**答案方向** (≥8 行):
1. 每个 `JVMFlagRange_xxx` 子类存储 `{_min, _max, _ptr}` — `_ptr` 是指向全局变量的指针，`check()` 读取当前值做边界比较
2. init() 宏展开: `EMIT_RANGE_CHECK(a, b)` 展开为 `, a, b` — 这意味着 flag 宏声明中 range 是可选的，没提供则展开到 `emit_range_no()`
3. `print()` (:409-422) — 如果没找到自定义 range，回退到 `JVMFlagConstraintList::find()`——有 constraint 的 flag 用默认 `.hpp` 头文件中的 `get_xxx_default_range_str()`
4. `get_intx_default_range_str()` (jvmFlag.cpp:68-70) — 使用 `min_intx` 和 `max_intx` 宏，64-bit 平台输出 `[-9223372036854775808 ... 9223372036854775807]`
5. bool 和 ccstr/ccstrlist 类型不参与 range check（emit_range_bool 和 emit_range_ccstr 都是空函数）
6. `check_ranges()` (:424-431) — 遍历所有 range 调用 `range->check(true)`，**不在 `parse()` 中调用**，而是由 `JVMFlag::verify()` → `Arguments::check_vm_args_consistency()` 在 debug 构建中调用
7. `INITIAL_RANGES_SIZE = 379` — 预分配容量，作为对比 ConstraintList 初始只有 72

**追问**: 为什么 double 类型的 range check 在第 241 行用 `< min` 而非 `<= min`？C 浮点精度可能产生 `value == min - ε` 的情况。
**量化对比**: 379 个 range 对象，每个 JVMFlagRange_intx 占用 40 bytes (vtable ptr + 3 fields)，总计约 15KB。
**Counterfactual**: 如果没有 range check 机制，`-XX:CICompilerCount=0` 会发生什么？VM 会启动但无编译线程，后续所有编译请求永久阻塞。

### QG-5: Writeable check — 运行时修改控制

**原始问题**: `JVMFlagWriteable` 的 `Always`/`Once`/`CommandLineOnly` 三态在 flag 生命周期中如何变化？`mark_once()` 和 `mark_startup()` 分别什么时候被调用？

**答案方向** (≥8 行):
1. `check_writable()` (jvmFlag.cpp:96-125) — 每个 `set_xxx()` 方法的第一步就是调用这个函数
2. `is_constant_in_binary()` 返回 true → 直接 fatal (PRODUCT 构建中 develop/notproduct flag)
3. 第二步: `JVMFlagWriteableList::find(_name)` 查找该 flag 是否有 Writeable 控制
4. `Once` 类型: `mark_once()` 在 `check_writable()` 返回前调用 → 设置 `_writeable=false` → 下次调用时 check_writable 报 SET_ONLY_ONCE
5. `CommandLineOnly` 类型: `mark_startup()` 遍历所有 Writeable → 设置 `_writeable=false` → 启动完成后通过 jcmd 修改时报 COMMAND_LINE_ONLY
6. `Always` 类型: 不调用 mark_once/mark_startup → `_writeable` 保持 true → 随时可改
7. `mark_startup()` 在哪里调用？→ `JVMFlagWriteableList::mark_startup()` (jvmFlagWriteableList.cpp:199-203) → 在 `Threads::create_vm()` 的早期调用，紧接在 `JVMFlagConstraintList::check_constraints(AfterErgo)` 之后
8. `is_writeable()` (jvmFlag.cpp:399-401) — 综合判断: `is_manageable() || (is_product() && is_read_write()) || is_writeable_ext()`

**追问**: 为什么 `is_writeable()` 检查 kind 位（is_manageable/is_product) 而 `check_writable()` 还要再次检查 WriteableList？两者不冗余——kind 决定"是否能被改"，WriteableList 决定"什么时候能改几次"。
**量化对比**: `INITIAL_WRITEABLES_SIZE = 2` — 只有两个 flag 有显式 Writeable 控制（与 379 个 Range 形成对比）。
**Counterfactual**: 如果 CommandLineOnly 的 mark_startup() 从未被调用，`-XX:ErrorFile` 在运行时通过 jcmd 修改会发生什么？修改成功，但 ErrorFile 只影响下次错误输出，语义上不合理。

### QG-6: Unlock mechanism — Diagnostic 和 Experimental flag 的门控

**原始问题**: `-XX:+UnlockExperimentalVMOptions` 如何全局"解锁"所有实验性 flag？为什么 unlock flag 必须出现在被解锁的 flag 之前？`is_unlocker()` 的硬编码名单包含哪些？

**答案方向** (≥8 行):
1. `is_unlocker()` (jvmFlag.cpp:346-350) — 硬编码检查 `_name == "UnlockDiagnosticVMOptions"` 或 `UnlockExperimentalVMOptions`
2. `is_unlocked()` (jvmFlag.cpp:352-360) — diagnostic flag 读全局 `UnlockDiagnosticVMOptions` bool；experimental flag 读 `UnlockExperimentalVMOptions`
3. 关键在 `find_flag()` (jvmFlag.cpp:904-925): 遍历 flagTable → 匹配名称 → 跳过 `is_constant_in_binary()` → 跳过 `!(is_unlocked() || is_unlocker())` — 未解锁时返回 NULL
4. 因此当 `-XX:+UseZGC` 先于 `-XX:+UnlockExperimentalVMOptions` 被解析时: `find_flag("UseZGC")` 发现 `is_experimental()==true` 但 `UnlockExperimentalVMOptions==false` → `is_unlocked()==false` → `!is_unlocker()==true` → 跳过 → 返回 NULL → INVALID_FLAG 错误
5. `get_locked_message()` (jvmFlag.cpp:370-397) — 错误消息的生成处，告知用户需要 unlock
6. `clear_diagnostic()` (jvmFlag.cpp:362-366) — 清除 KIND_DIAGNOSTIC 位，使 flag 变为普通 product flag——某些 diagnostic flag 被 "promote" 为 product 后不再需要 unlock

**追问**: `is_unlocker_ext()` 是什么？— JVMCI 扩展点，允许 JVMCI 模块自定义额外的 unlocker flag。
**量化对比**: experimental flag 约占总 flagTable 的 8-12%，diagnostic 约 15-20%，其余为 product。
**Counterfactual**: 如果 unlock 机制不在 `find_flag()` 层面拦截而是在 `xxxAtPut()` 写值时拦截，会有什么变化？JVM 会继续解析后续参数（因为 find_flag 返回了指针），然后在使用时才发现 flag 未解锁，造成不一致行为。

---

## §五 Article Structure（文档结构）

```
# 01-JVM-Flag-System — HotSpot JVM 参数系统的全链路深度解析

## §〇 生产场景回顾
- 场景 A: 错误的 -XX flag → unrecognized → fuzzy_match 过程
- 场景 B: ergonomic 与用户参数冲突 → origin 叠加语义
- 场景 C: unlock flag 顺序错误 → find_flag 返回 NULL 的根因

## §一 JVM Flag 系统架构全景
- 静态注册表 + 动态验证的三层模型
- flagTable 的宏生成机制概览
- 类型系统: bool/int/uint/intx/uintx/uint64_t/size_t/double/ccstr(ccstrlist)

## §二 Source Files Table（14 文件映射表）

## §三 Arguments::parse() 15 阶段解析管线
- 3.1 初始化三层验证系统 (Range/Constraint/Writeable)
- 3.2 环境变量解析 (JAVA_TOOL_OPTIONS + _JAVA_OPTIONS)
- 3.3 jimage resource 中的 VM options
- 3.4 -XX:Flags= 配置文件和 .hotspotrc
- 3.5 parse_vm_init_args() 四源优先级链
- 3.6 后处理: SharedArchivePath、VerifySharedSpaces
- 3.7 apply_ergo() 工效调整：set_ergonomics_flags → GCArguments + GCConfig

## §四 JVMFlag 的位域编码与类型系统
- 4.1 _flags 位域布局：origin (4bit) + kind (13bit) + ORIG_COMMAND_LINE (1bit)
- 4.2 origin 与 priority 的非等价关系
- 4.3 8 种数据类型的 get/set 实现
- 4.4 flagTable[] 的宏魔法：STRUCT 宏 + 条件编译控制
- 4.5 find_flag() 线性搜索详解
- 4.6 fuzzy_match(): StringUtils::similarity() 的 70% 阈值

## §五 Constraint 验证层
- 5.1 JVMFlagConstraint 基类与 8 个类型子类
- 5.2 AtParse/AfterErgo/AfterMemoryInit 三级时序
- 5.3 _validating_type 状态机
- 5.4 Compiler 约束函数 18 个（CICompilerCount、CodeCacheSegmentSize、AliasLevel 等）
- 5.5 Runtime 约束函数 8 个（ObjectAlignment、BiasedLocking、ThreadLocalHandshakes 等）
- 5.6 约束互依赖性实例：CompileThreshold ↔ OnStackReplacePercentage ↔ InterpreterProfilePercentage

## §六 Range 检查层
- 6.1 JVMFlagRange 基类与 7 个类型子类
- 6.2 默认范围的生成策略
- 6.3 check_ranges() 的使用时机

## §七 Writeable 控制层
- 7.1 Always/Once/CommandLineOnly 三态的含义
- 7.2 mark_once() 与 mark_startup() 的生命周期
- 7.3 与 is_manageable() / is_read_write() 的关系

## §八 Unlock 机制
- 8.1 is_unlocker() 的硬编码名单
- 8.2 find_flag() 中的 unlock 检查位置
- 8.3 错误消息的生成与 get_locked_message()
- 8.4 clear_diagnostic() 的 "promote" 机制

## §九 诊断工具与调试方法
- 9.1 PrintFlags{Initial,Final,Ranges} + jcmd VM.flags
- 9.2 GDB 断言：flagTable、origin 位域
- 9.3 strace 追踪 .hotspotrc 读取
- 9.4 /proc/self/environ 查看 JAVA_TOOL_OPTIONS 和 _JAVA_OPTIONS

## §十 边界场景与潜在陷阱
- 竞态: 多线程并发 set flag 时 origin 覆盖
- 资源耗尽: ccstr flag 无限追加 (ccstrlist) 导致 OOM
- 跨功能交互: GC ergonomic 覆盖用户 -Xmx 设定的 MaxHeapSize
- SELinux: .hotspotrc 文件权限读取失败
- LD_PRELOAD: 被 hook 的 strlen/memcmp 影响 find_flag 的线性搜索

## §十一 反事实分析
（独立 section，≥3 个设计决策的反事实讨论）

## §十二 总结
```
**注意**: §九作为独立 section 出现，包含 strace、jcmd、GDB、/proc 四件套，不在 §一 中重复。

---

## §六 Writing Requirements（写作要求）

### "不要写成 → 应该写成" 对照表 (≥8 条)

| # | 不要写成 | 应该写成 |
|:--|---------|---------|
| 1 | "Arguments::parse() 解析命令行参数" — 一句话带过 | 展开 15 个阶段的完整调用链，每阶段标注 arguments.cpp:line，区分 ScopedVMInitArgs 生命周期 |
| 2 | "JVMFlag 有一个 flags 字段存储类型和来源" — 笼统描述 | 精确画出 32-bit 位域布局: bit[0:3]=origin, bit[4:16]=kind, bit[17]=ORIG_COMMAND_LINE，每位置标注对应的 Flags 枚举值 |
| 3 | "find_flag() 搜索 flag 表" — 不提实现细节 | 描述线性搜索 O(n) 的每一层过滤: constant_in_binary → is_unlocked → 匹配返回 (/jvmFlag.cpp:904-925) |
| 4 | "约束函数检查 flag 是否有效" — 堆砌函数名列表 | 选取 3 个有代表性的约束函数逐行分析: CICompilerCount(线程数下限)、CodeCacheSegmentSize(三重对齐)、ObjectAlignment(power2+page_limit) |
| 5 | "Range 检查 flag 的上下界" — 只说存在 | 展示 JVMFlagRange_intx 的 `{_min, _max, _ptr}` 三元组，对比有约束 flag 的默认范围生成 vs 无约束 flag 的 `get_intx_default_range_str()` 回退 |
| 6 | "Writeable 控制 flag 能否在运行中被修改" — 概念层面 | 追踪 `Once` 类型的完整生命周期: 构造函数 _writeable=true → mark_once() _writeable=false → check_writable() SET_ONLY_ONCE 错误 |
| 7 | "解锁 flag 需要 -XX:+UnlockExperimentalVMOptions" — 抄 man 手册 | 从 find_flag() 源码证明为什么顺序关键: `is_unlocked()` 读全局 bool 而该 bool 由锁 flag 的 set_bool() 设置——解析时尚未执行到 unlock flag 所以返回 NULL |
| 8 | "宏展开生成 flagTable" — 跳过细节 | 用 RUNTIME_PRODUCT_FLAG_STRUCT 为例，展示从 `{type, name, &name, doc, Flags}` 五元组到完整 flagTable 数组的展开过程 |
| 9 | "fuzzy_match 提供建议" — 不说明算法 | 展示 StringUtils::similarity() 的 70% 阈值判断 (/jvmFlag.cpp:935-964)，给出 "UseConcMarkSweepGC" → "UseG1GC" 或 "UseSerialGC" 的实际建议输出 |
| 10 | "origin 表示优先级" — 错误概念 | 纠正: origin 是"最后一次设置来源"而非"优先级"。真正优先级由 parse_vm_init_args() 的调用顺序控制（后解析的高优先级覆盖低优先级） |

### 额外要求

- 每个技术断言必须标注 `file:line` 引用，格式 `(/path:line)`
- 源码引用占正文 ≤20%，80% 是原理分析和设计动机解释
- §四 问题组答案方向 ≥8 行/组，含文件引用 + 追问 + 量化对比 + 内核/OS 引用
- Callout 框 ≥7 个，放入 §一 Task+Narrative 节（不是独立 §二）
- PrintFlagsFinal 的输出示例（2-3 行即可）展示 `{product}` `{command line}` `{ergonomic}` 等标识的实际含义

---

## §七 Output Format（输出格式）

```markdown
# 01-JVM-Flag-System — HotSpot JVM 参数系统的全链路深度解析

## §〇 生产场景回顾
...

## §一 Task + Narrative + Beginner Callouts
...

## §二 Source Files Table
...

## §三 Arguments::parse() 15 阶段解析管线
### 3.1 ...
### 3.2 ...
...

## §四 JVMFlag 的位域编码与类型系统
...

## §五 Constraint 验证层
...

## §六 Range 检查层
...

## §七 Writeable 控制层
...

## §八 Unlock 机制
...

## §九 诊断工具与调试方法
...

## §十 边界场景与潜在陷阱
...

## §十一 反事实分析
...

## §十二 总结
...

## §十三 参考资料
- JDK 源码: src/hotspot/share/runtime/arguments.{hpp,cpp}
- Man pages: read(2), open(2), stat(2), malloc(3), qsort(3), vfprintf(3)
- OpenJDK bug: JDK-8203197 (Arguments::parse) / JDK-8041990 (UnlockDiagnosticVMOptions)
```

**验证命令**:
```bash
# 检查 section 连续无跳号
rg '^## §' <doc_file> | cat -n
```

---

## §八 Prohibited（禁止事项，≥8 条）

1. **禁止列出所有 800+ flag**: 只选取代表性 flag（≥15 个）深入分析，其余用统计数字（占比、类型分布）
2. **禁止将 origin 描述为"优先级"**: 必须反复强调 origin 是"最后修改来源"标识，优先级由 `parse_vm_init_args()` 的调用顺序控制
3. **禁止跳过宏展开机制**: `VM_FLAGS()` → `RUNTIME_PRODUCT_FLAG_STRUCT` 的展开链路是理解 flagTable 如何生成的唯一钥匙，必须至少分析 3 层展开
4. **禁止将 Constraint/Range/Writeable 三层验证混为一谈**: 每层有独立的 init()、独立的 base class 层次、不同的验证时机。三者对比表必须出现
5. **禁止不提 fuzzy_match()**: 这是用户最直接受益的机制——拼写错误自动建议——不能忽略
6. **禁止用伪代码替代源码引用**: 所有技术断言必须标注 `file:line`，不能凭空描述
7. **禁止省略 ccstr 的特殊内存管理**: `ccstrAtPut()` 中的 `os::strdup_check_oom()` + `FREE_C_HEAP_ARRAY` 双端管理是与数值类型最大的区别
8. **禁止不提 `_has_jimage` 和 `is_constant_in_binary()`**: jimage resource 路径和 PRODUCT vs debug 构建差异是 flag 可见性的两个关键维度
9. **禁止将文档写成源码行注释翻译**: 源码行注释可以帮助解释但应是补充，正文主体是"为什么这样设计"和"设计选择的影响"

---

## §九 Required（必须包含，≥8 条）

1. **parse_vm_init_args() 的完整调用链图**: 4 个源 → 4 次 parse_each_vm_init_arg → finalize_vm_init_args，每个调用标注 file:line + origin 值
2. **_flags 位域布局图**: ASCII 图示 bit[0] 到 bit[17] 每个位的含义，区分 "低 4 位可覆写" 和 "ORIG_COMMAND_LINE 永久位"
3. **Constraint 三级时序示意**: AtParse → 解析期 → AfterErgo → 工效后 → AfterMemoryInit → 内存初始化后，标注状态转换点
4. **至少 3 个约束函数的逐行源码分析**: CICompilerCount（演示跨 flag 依赖）、ObjectAlignmentInBytes（演示与 OS 的交互）、CodeCacheSegmentSize（演示三重链式约束）
5. **find_flag() 的多层过滤流程图**: name 匹配 → constant_in_binary 过滤 → lock 检查 → 返回，标注每层过滤条件
6. **mark_once() / mark_startup() 的生命周期图**: 展示 Writeable._writeable 从 true→false 的两次触发时机
7. **PrintFlagsFinal 完整输出示例**: 至少 5 行（含不同 type、不同 origin、不同 kind 的对比），并标注每个字段的含义
8. **至少 3 个反事实讨论**（对应 §四 中 ≥3 个问题组的 counterfactual）: 如果约束在解析时验证而不是推迟、如果 origin 编码了优先级而非来源、如果 range check 在每次 flag 设置时都执行

---

## §十 GDB Verification（GDB 验证断言，≥7 个）

使用 fastdebug 构建，在 `Arguments::parse()` 入口设断点:

```gdb
# 断言 1: flagTable 非空且最后一个元素是 NULL 哨兵
(gdb) p JVMFlag::flags
(gdb) p JVMFlag::flags[JVMFlag::numFlags - 1]._name
# 预期: 0x0 (NULL)

# 断言 2: numFlags ≈ 800-900
(gdb) p JVMFlag::numFlags

# 断言 3: flagTable 中 UseG1GC 的 _flags 包含 KIND_PRODUCT
(gdb) p JVMFlag::find_flag("UseG1GC", 8)->_flags

# 断言 4: constraintList 初始化后至少 72 个条目
(gdb) p JVMFlagConstraintList::_constraints->_len

# 断言 5: rangeList 初始化后约 379 个条目
(gdb) p JVMFlagRangeList::_ranges->_len

# 断言 6: Find a flag that was set on command line after parse_vm_init_args
(gdb) p JVMFlag::find_flag("PrintGCDetails", 15)->is_command_line()
# (with -XX:+PrintGCDetails) 预期: true

# 断言 7: UnlockExperimentalVMOptions flag exists and is_bool()
(gdb) p JVMFlag::find_flag("UnlockExperimentalVMOptions", 27)->is_bool()
# 预期: true

# 断言 8: After parse, check a diagnostic flag is accessible only with unlock
(gdb) p JVMFlag::find_flag("PrintAssembly", 13, false, false)
# 预期: NULL (未解锁时返回 NULL)
(gdb) p JVMFlag::find_flag("PrintAssembly", 13, true, false)
# 预期: 非空 (allow_locked=true 时返回指针)

# 断言 9: verify fuzzy_match with typo
(gdb) p JVMFlag::fuzzy_match("UseG1GCx", 8)
# 预期: 返回 UseG1GC 的 JVMFlag* (similarity > 0.7)
```

---

## §十一 Continuity with README

### 与 Phase 26 README 的关系

本文档对应 `probe_md/26-runtime-extra/README.md` §二 的 doc-01: JVM Flag System。

**README 关键问题复述**:
1. Arguments::parse() 15 阶段解析管线（10 级优先级）
2. JVMFlag 的三值类型系统（bool/intx/uintx/uint64_t/size_t/double/ccstr）
3. Constraint + Range + Writeable 三层验证
4. jvmFlagConstraintList::init() 注册机制
5. -XX:+UnlockExperimentalVMOptions / -XX:+UnlockDiagnosticVMOptions
6. aliased options (废弃/重命名 flag 映射)

**回答映射**:
- 问题 1 → §四 QG-1 + §五 §3
- 问题 2 → §四 QG-2 + §五 §4
- 问题 3 → §四 QG-3,4,5 + §五 §5,6,7
- 问题 4 → §四 QG-3 答案方向中有 init() 宏展开分析
- 问题 5 → §四 QG-6 + §五 §8
- 问题 6 → 文档应包含 aliased options 的 `handle_aliases_and_deprecation()` 分析 (arguments.cpp)

### 与同组 prompt 的连续性

- doc-00 (Handshake & ThreadSMR): 与本文档无直接依赖关系，但 ThreadSMR 的 `ThreadLocalHandshakes` flag 在 `jvmFlagConstraintsRuntime.cpp:135-143` 中有约束函数
- doc-02 (VM Thread, VM Ops & Services): VM_Operation 的 flag 控制（如 SafepointTimeout、GuaranteedSafepointInterval）通过本文档的 flag 系统注册

### source files 重叠声明

- `01-jvm-startup/20-Arguments-Parse-Flow.md` 部分覆盖 Arguments::parse()，本文档重点补充三层验证机制和 flag 位域编码，不重复旧文档已有的 `-D` 属性解析和 `-X` 选项分析
