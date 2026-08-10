# 01-JVM-Flag-System — HotSpot JVM 参数系统的全链路深度解析

## §〇 生产场景回顾

### 场景 A：错误的 -XX flag → Unrecognized → fuzzy_match 过程

运维在启动脚本中写了 `-XX:+UseConcMarkSweepGC`，但该服务运行在 JDK 14+ 上（CMS 已被移除）。JVM 报错：

```
Unrecognized VM option 'UseConcMarkSweepGC'
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

**根因链路**：`process_argument()` (`/arguments.cpp:1269`) 调用 `parse_argument()` (`/arguments.cpp:1060`) → `set_bool_flag()` → `JVMFlag::find_flag("UseConcMarkSweepGC")` (`/jvmFlag.cpp:904-925`) 遍历 800+ 条目的 flagTable。`UseConcMarkSweepGC` 被标记为 `OBSOLETE` 已于 JDK 14 移除，`is_obsolete_flag()` (`/arguments.cpp:684`) 返回 true → 在 `process_argument()` 中 line 1295-1303 被拦截并打印 warning。但如果标记为"完全不存在"的 flag，`find_flag()` 返回 NULL → line 1349-1358 输出 `Unrecognized` → `fuzzy_match()` (`/jvmFlag.cpp:935-964`) 遍历整个 flagTable 计算 `StringUtils::similarity()` 相似度 → 若 ≥70% 阈值（`VMOptionsFuzzyMatchSimilarity = 0.7f`），输出 "Did you mean 'UseG1GC'?"。

### 场景 B：Ergonomic 与用户参数的冲突 — origin 叠加语义

用户使用 `-Xmx4g -XX:MaxRAMPercentage=75.0` 在容器中启动，实际堆只有 2.5G。

**根因链路**：`Arguments::apply_ergo()` (`/arguments.cpp:4048`) → `set_ergonomics_flags()` (`/arguments.cpp:1765`) → `GCArguments::initialize_flags()` 读取 cgroup 限制 → `FLAG_SET_ERGO(MaxHeapSize, ...)` → 写入 origin=ERGONOMIC (5)。在 `parse_vm_init_args()` 中，命令行参数以 origin=COMMAND_LINE (1) 先被解析。`JVMFlag::set_origin()` (`/jvmFlag.cpp:280-284`) 只改写 `VALUE_ORIGIN_MASK` 的低 4 位，不保留"谁先谁后"的历史。**origin 不是优先级**——它是"最后一次修改的来源标签"。真正的优先级由 `parse_vm_init_args()` 的 4 次调用顺序控制：jimage resource → JAVA_TOOL_OPTIONS → 命令行 → _JAVA_OPTIONS。但 `apply_ergo()` 是在 `parse_vm_init_args()` 返回后独立调用的，所以 ERGONOMIC 覆盖了之前所有源写入的值。

### 场景 C：Unlock flag 顺序错误 → find_flag 返回 NULL

开发使用 `java -XX:+UseZGC -XX:+UnlockExperimentalVMOptions -jar app.jar`，报错：

```
Error: VM option 'UseZGC' is experimental and must be enabled via -XX:+UnlockExperimentalVMOptions.
Error: The unlock option must precede 'UseZGC'.
```

**根因链路**：`parse_each_vm_init_arg()` (`/arguments.cpp:2462`) 逐参数顺序解析。当解析到 `-XX:+UseZGC` 时，`find_flag("UseZGC")` (`/jvmFlag.cpp:904`) 在 flagTable 中找到匹配 → `is_constant_in_binary()` 返回 false (release 构建) → `is_unlocked()` (`/jvmFlag.cpp:352-360`) 检查 KIND_EXPERIMENTAL 位 → 读取全局 bool `UnlockExperimentalVMOptions` → 此时为 **false**（因为 `-XX:+UnlockExperimentalVMOptions` 尚未被解析）→ `!is_unlocker()` 为 true → 返回 **NULL**。`process_argument()` 收到 NULL → line 1320 `find_flag(allow_locked=true, return_flag=true)` → 找到 UseZGC → `get_locked_message()` (`/jvmFlag.cpp:370-397`) 生成错误消息。

---

## §一 JVM Flag 系统架构全景

### Task

编写一份面向中级 JVM 工程师的技术深度文档，全链路分析 JVM Flag 系统：从 `Arguments::parse()` 的 15 阶段参数解析管线，到 `JVMFlag` 静态注册表的位域编码与类型系统，再到 `Constraint + Range + Writeable` 三层验证机制的注册和执行生命周期。

### Narrative

HotSpot 的参数系统是 JVM 可观测性和可调优性的基石。每天数百万次 `java -Xmx2g -XX:+UseG1GC` 调用背后，是一个严谨的**参数注册-解析-约束验证-工效应用**四阶段流水线：

1. **编译时注册**：`VM_FLAGS()` 宏通过多层 STRUCT 宏展开，生成 800+ 条目的 `flagTable[]` 静态数组 (`/jvmFlag.cpp:819-893`)
2. **运行时解析**：`Arguments::parse()` 从 4 个来源逐顺序收集参数，经历 15 阶段管线 (`/arguments.cpp:3844-4045`)
3. **三层验证**：Constraint（跨 flag 依赖）→ Range（数值边界）→ Writeable（运行时修改权限）独立初始化、独立验证
4. **工效调整**：`apply_ergo()` 根据硬件环境和容器资源重新计算 heap size、compressed oops 等

本文档以 `Arguments::parse()` 为主线，串联 `JVMFlag` 的 32-bit 位图编码、`flagTable` 的宏生成机制、以及 `ConstraintList/RangeList/WriteableList` 的三层守卫模型。

> **Beginner Callout 1: -X vs -XX 的区别**
> `-X` 是非标准选项（`-Xmx`、`-Xms`），规范未定义，各 JVM 实现不同。`-XX` 是实验/调优选项，由 `Arguments::process_argument()` (`/arguments.cpp:1269`) 统一处理。`-XX:+Flag` 开启 bool flag，`-XX:-Flag` 关闭，`-XX:Flag=value` 设置数值/字符串 flag。HotSpot 中的 -X 选项最终多数通过 `FLAG_SET_CMDLINE` 映射到对应的 -XX flag（如 `-Xmx` → `MaxHeapSize`）。

> **Beginner Callout 2: Debug vs Release 构建**
> HotSpot 有两种构建模式：`PRODUCT`（发布版）和 `fastdebug`（调试版）。在 PRODUCT 构建中，`KIND_DEVELOP` 和 `KIND_NOT_PRODUCT` 类型的所有 flag 会被 `is_constant_in_binary()` (`/jvmFlag.cpp:338-344`) 标记为"常量"，在 `find_flag()` 的 line 909-911 被过滤返回 NULL。这意味着 `-XX:+TraceBytecodes` 在 release JDK 上会报 "Unrecognized VM option"。

> **Beginner Callout 3: flag 值的来源"优先级"**
> JVM 有 9 个 origin 等级（DEFAULT=0, ..., JIMAGE_RESOURCE=8），但 **origin 编号不等于优先级**。`get_origin()` 返回的是"最后一次设置该 flag 的来源标签"，而真正的优先级链由 `parse_vm_init_args()` (`/arguments.cpp:2257`) 的 4 次调用顺序控制：jimage resource → JAVA_TOOL_OPTIONS → 命令行 → _JAVA_OPTIONS。后解析覆盖前解析。

> **Beginner Callout 4: `ccstr` 和 `ccstrlist` 的差异**
> `ccstr` 是单值字符串 flag（如 `-XX:ErrorFile=/tmp/hs_err_%p.log`），`ccstrlist` 是可累积列表（如 `-XX:CompileOnly=com.foo.*`），多次设置会用 `\n` 分隔符拼接。源码见 `is_ccstr()` (`/jvmFlag.cpp:255-256`) 和 `ccstr_accumulates()` (`/jvmFlag.cpp:258-261`)。`append_to_string_flag()` (`/arguments.cpp:966-993`) 展示拼接逻辑。

> **Beginner Callout 5: intx vs int 的区别**
> `intx` 和 `int` 在 64-bit 平台上完全相同（都是 64 位），在 32-bit 平台上 intx 是 32 位而 int 是 32 位。使用 `intx` 是为了平台兼容性——`max_intx` 在 64-bit 是 INT64_MAX，在 32-bit 是 INT32_MAX。这是通过 `/utilities/globalDefinitions.hpp:349` 中 `typedef intptr_t intx;` 实现的。

> **Beginner Callout 6: `FLAG_SET_*` 宏族**
> `FLAG_SET_DEFAULT(flag, value)`、`FLAG_SET_ERGO(flag, value)`、`FLAG_SET_CMDLINE(flag, value)` 等宏是对 `JVMFlag::xxxAtPut()` 的封装（见 `/runtime/globals.hpp` 中的宏定义）。每个宏设置 origin 并触发约束验证。`FLAG_IS_DEFAULT(flag)` 检查 origin 是否为 DEFAULT——这是区分"用户显式设置"和"JVM 默认值"的关键。

> **Beginner Callout 7: printFlags 系列诊断命令**
> `-XX:+PrintFlagsInitial`（打印所有 flag 默认值）、`-XX:+PrintFlagsFinal`（打印所有 flag 最终值+origin）、`-XX:+PrintFlagsRanges`（打印范围和约束信息）、`jcmd <pid> VM.flags`（运行时查询）。内部都调用 `JVMFlag::printFlags()` 及相关方法。典型输出示例：
> ```
> uintx MaxHeapSize         = 4294967296     {product} {command line}
> uintx InitialHeapSize     = 268435456      {product} {ergonomic}
> intx  CICompilerCount     = 3              {product} {ergonomic}
> bool  UseG1GC             = true           {product} {command line}
> ccstr ErrorFile           = /tmp/hs_%p.log {product} {command line}
> ```
> 其中 `{product}` 是 kind, `{command line}` `{ergonomic}` 是 origin 标签（由 `print_origin()` 在 `/jvmFlag.cpp:683-709` 输出）。

---

## §二 Source Files Table

| # | 文件路径 | 行数 | 角色 |
|:--|---------|:---:|------|
| 1 | `runtime/arguments.hpp` | 680 | `Arguments` 类声明：解析管线接口、静态成员、辅助结构体 |
| 2 | `runtime/arguments.cpp` | ~4,380 | `Arguments::parse()` 主解析管线 (15 阶段)、工效调整、环境变量解析 |
| 3 | `runtime/flags/jvmFlag.hpp` | 282 | `JVMFlag` 结构体：`Flags` 位域枚举、`Error` 枚举、8 种类型 get/set |
| 4 | `runtime/flags/jvmFlag.cpp` | 1,537 | `flagTable[]` 静态注册表、`find_flag()` 线性搜索、`fuzzy_match`、位域操作 |
| 5 | `runtime/flags/jvmFlagConstraintList.hpp` | 101 | `JVMFlagConstraint` 基类 + `JVMFlagConstraintList` 容器声明 |
| 6 | `runtime/flags/jvmFlagConstraintList.cpp` | 369 | Constraint 子类化（按类型分 8 个子类）、`init()` 宏展开、三级验证调度 |
| 7 | `runtime/flags/jvmFlagRangeList.hpp` | 74 | `JVMFlagRange` 基类 + `JVMFlagRangeList` 容器声明 |
| 8 | `runtime/flags/jvmFlagRangeList.cpp` | 431 | Range 子类化（按类型分 7 个子类）、`init()` 含 379 容量预分配 |
| 9 | `runtime/flags/jvmFlagWriteableList.hpp` | 67 | `JVMFlagWriteable` 三态控制 + `JVMFlagWriteableList` |
| 10 | `runtime/flags/jvmFlagWriteableList.cpp` | 205 | Writeable `init()` + `mark_startup()` |
| 11 | `runtime/flags/jvmFlagConstraintsCompiler.hpp` | 74 | 18 个 Compiler flag 约束函数声明 |
| 12 | `runtime/flags/jvmFlagConstraintsCompiler.cpp` | 407 | Compiler 约束实现（CICompilerCount、CodeCacheSegmentSize 等） |
| 13 | `runtime/flags/jvmFlagConstraintsRuntime.hpp` | 50 | 8 个 Runtime flag 约束函数声明 |
| 14 | `runtime/flags/jvmFlagConstraintsRuntime.cpp` | 143 | Runtime 约束实现（ObjectAlignment、BiasedLocking 等） |

### 关键全局状态

| 变量 | 位置 | 含义 |
|------|------|------|
| `JVMFlag::flags` | `/jvmFlag.cpp:895` | 指向 `flagTable[0]` 的静态指针 |
| `JVMFlag::numFlags` | `/jvmFlag.cpp:896` | `sizeof(flagTable)/sizeof(JVMFlag)`，含 NULL 哨兵 |
| `JVMFlagConstraintList::_constraints` | `/jvmFlagConstraintList.cpp:272` | 约束对象动态数组 (初始容量 72) |
| `JVMFlagRangeList::_ranges` | `/jvmFlagRangeList.cpp:322` | 范围对象动态数组 (初始容量 379) |
| `JVMFlagWriteableList::_controls` | `/jvmFlagWriteableList.cpp:113` | 可写性对象动态数组 (初始容量 2) |

### 涉及的系统调用

| Syscall | Man 参考 | JVM 使用场景 |
|---------|---------|-------------|
| `read` | `man 2 read` | `process_settings_file()` 使用 `getc()` 读取 `.hotspotrc` / `-XX:Flags=` 配置文件 |
| `open/stat` | `man 2 open`, `man 2 stat` | `os::stat()` 检查 `.hotspotrc` 是否存在 (`/arguments.cpp:3946`) |
| `malloc/free` | `man 3 malloc` | `os::strdup_check_oom()` 在 ccstr flag 设置时分配；`FREE_C_HEAP_ARRAY` 释放 (`/arguments.cpp:962`) |
| `qsort` | `man 3 qsort` | `printFlags()` 中按名称排序 flagTable |
| `vfprintf` | `man 3 vfprintf` | `jio_vfprintf()` 输出约束违规错误到 stderr |

### 构建与运行

- **Source roots**: `make/hotspot/lib/CompileJvm.gmk:153` — BUILD_LIBJVM 定义
- **构建命令**: `bash configure --with-debug-level=fastdebug && make hotspot`
- **产物路径**: `build/linux-x86_64-server-fastdebug/hotspot/variant-server/libjvm/hotspot/libjvm.so`
- **预热命令**: `./build/*/jdk/bin/java -XX:+UnlockDiagnosticVMOptions -XX:+PrintFlagsFinal -version`

---

## §三 Arguments::parse() 15 阶段解析管线

### 3.1 全景调用链

`Arguments::parse()` 从 `JNI_CreateJavaVM` 调用入口开始，到 return `JNI_OK`，完整走过了 15 个阶段。每个阶段的源码位置在 `/arguments.cpp` 中。

```
JNI_CreateJavaVM (jni.cpp)
  └── Arguments::parse(&vm_args)             [arguments.cpp:3844]
        ├── [阶段 1] JVMFlagRangeList::init()          [:3848]
        ├── [阶段 2] JVMFlagConstraintList::init()     [:3849]
        ├── [阶段 3] JVMFlagWriteableList::init()      [:3850]
        ├── [阶段 4] parse_java_tool_options_environment_variable() [:3874]
        │     设置 origin=JVMFlag::ENVIRON_VAR (2)
        ├── [阶段 5] parse_java_options_environment_variable() [:3879]
        │     设置 origin=JVMFlag::ENVIRON_VAR (2)
        ├── [阶段 6] ClassLoader::lookup_vm_options() [:3885]
        │     从 /java.base/jdk/internal/vm/options 读取, origin=JVMFlag::JIMAGE_RESOURCE (8)
        ├── [阶段 7-10] 四次 expand_vm_options_as_needed() [:3894-3920]
        │     展开 -XX:VMOptionsFile= 内联文件到 4 个源
        ├── [阶段 11] process_settings_file() [:3932-3950]
        │     解析 -XX:Flags=<file> 或 .hotspotrc, origin=CONFIG_FILE (3)
        ├── [阶段 12] parse_vm_init_args() [:3960]
        │     四源优先级链: jimage → JAVA_TOOL_OPTIONS → cmd_line → _JAVA_OPTIONS
        │     └── parse_each_vm_init_arg() × 4, 每次 origin 不同
        │         └── process_argument() [:1269]
        │               ├── parse_argument() [:1060]  // -XX: 选项解析
        │               └── find_flag() [:904]         // 查找 + 锁检查 + fuzzy_match
        ├── [阶段 13] get_shared_archive_path() [:3970]
        │     SharedArchivePath 初始化
        ├── [阶段 14] FLAG_IS_DEFAULT(VerifySharedSpaces) [:3976]
        │     自动启用 CDS 验证
        └── [阶段 15] 后处理 [:3980-4045]
              .hotspotrc warning、平台不支持的 flag、set_object_alignment()
```

### 3.2 三层验证系统初始化（阶段 1-3）

三个 `init()` 使用完全相同的宏展开模式：

```cpp
// /arguments.cpp:3847-3850
JVMFlagRangeList::init();       // 阶段 1
JVMFlagConstraintList::init();  // 阶段 2
JVMFlagWriteableList::init();   // 阶段 3
```

每个 `init()` 的第一遍宏展开都以 `emit_xxx_no` 调用 `VM_FLAGS()`，使用 `IGNORE_RANGE`/`IGNORE_CONSTRAINT`/`IGNORE_WRITEABLE` 占位。**三步展开的精妙设计**：同一个 `VM_FLAGS()` 宏体在这三次展开中先后扮演"flag 定义"、"约束发射"、"范围发射" 三种角色。以 `JVMFlagWriteableList::init()` (`/jvmFlagWriteableList.cpp:115`) 为例：

```
emit_writeable_no(NULL VM_FLAGS(EMIT_WRITEABLE_DEVELOPER_FLAG,
                                ...,
                                IGNORE_RANGE,
                                IGNORE_CONSTRAINT,
                                EMIT_WRITEABLE));
```

- Step 1: `VM_FLAGS` 展开每个 flag 条目 → `EMIT_WRITEABLE_DEVELOPER_FLAG(type, name, value, doc)` 
- Step 2: 如果该 flag 的 writeable 参数是 `EMIT_WRITEABLE(CommandLineOnly)` → 展开为 `, JVMFlagWriteable::CommandLineOnly`
- Step 3: `emit_writeable_intx(name, CommandLineOnly)` → `JVMFlagWriteableList::add(new JVMFlagWriteable(name, CommandLineOnly))`

如果没有 writeable 参数（参数为空），则调用 `emit_writeable_no(...)` (空函数 NOP)。

三个 init() 创建动态数组的初始容量对比：

| 验证层 | 初始容量 | 源码位置 |
|--------|---------|---------|
| JVMFlagRangeList | 379 | `/jvmFlagRangeList.cpp:#define INITIAL_RANGES_SIZE 379` |
| JVMFlagConstraintList | 72 | `/jvmFlagConstraintList.cpp:#define INITIAL_CONSTRAINTS_SIZE 72` |
| JVMFlagWriteableList | 2 | `/jvmFlagWriteableList.cpp:#define INITIAL_WRITEABLES_SIZE 2` |

范围层 379 个条目远超约束层 72 个——因为多数数值 flag 有简单的 min/max 范围但不需要复杂的跨 flag 约束。

### 3.3 环境变量解析（阶段 4-5）

```cpp
// /arguments.cpp:3874-3882
code = parse_java_tool_options_environment_variable(&initial_java_tool_options_args);
code = parse_java_options_environment_variable(&initial_java_options_args);
```

`JAVA_TOOL_OPTIONS` 和 `_JAVA_OPTIONS` 是两个独立的环境变量，在此阶段仅做词法拆分为 `JavaVMInitArgs` 结构体，**不进行 flag 查找和验证**。真正的解析在阶段 12 的 `parse_vm_init_args()` 中完成。

### 3.4 jimage resource 中的 VM options（阶段 6）

```cpp
// /arguments.cpp:3885-3892
char *vmoptions = ClassLoader::lookup_vm_options();
if (vmoptions != NULL) {
    code = parse_options_buffer("vm options resource", vmoptions, strlen(vmoptions), &initial_vm_options_args);
    FREE_C_HEAP_ARRAY(char, vmoptions);
}
```

JDK 的 `java.base` 模块在 jimage 中内嵌了一个 VM options 文件。`ClassLoader::lookup_vm_options()` 从 jimage 读取该文件内容为字符串，`parse_options_buffer()` 将其拆分为 `JavaVMInitArgs`。这些 options 以 origin=JIMAGE_RESOURCE (8) 在阶段 12 优先解析。

### 3.5 -XX:VMOptionsFile= 展开（阶段 7-10）

```cpp
// /arguments.cpp:3894-3920
code = expand_vm_options_as_needed(initial_java_tool_options_args.get(),
                                   &mod_java_tool_options_args, &cur_java_tool_options_args);
code = expand_vm_options_as_needed(initial_cmd_args, &mod_cmd_args, &cur_cmd_args);
code = expand_vm_options_as_needed(initial_java_options_args.get(),
                                   &mod_java_options_args, &cur_java_options_args);
code = expand_vm_options_as_needed(initial_vm_options_args.get(),
                                   &mod_vm_options_args, &cur_vm_options_args);
```

`expand_vm_options_as_needed()` (`/arguments.cpp:3683-3700`) 只是 `match_special_option_and_act()` 的包装器。后者 (`/arguments.cpp:3702-3798`) 遍历参数列表，当遇到 `-XX:VMOptionsFile=<file>` 时调用 `insert_vm_options_file()` 将文件内容插入到参数流中，然后 `index--` 回溯以便重新处理替换项。

### 3.6 配置文件解析（阶段 11）

```cpp
// /arguments.cpp:3922-3950
const char* flags_file = Arguments::get_jvm_flags_file();
settings_file_specified = (flags_file != NULL);

if (settings_file_specified) {
    process_settings_file(flags_file, true, cur_cmd_args->ignoreUnrecognized);
} else {
    // #ifdef ASSERT: parse .hotspotrc
    // #else: just stat and warn
}
```

`process_settings_file()` (`/arguments.cpp:1365-1427`) 使用 `fopen` + `getc` 逐字符读取，支持 `#comment` 和单/双引号包围。每个 token 以 origin=`JVMFlag::CONFIG_FILE` (3) 传递给 `process_argument()`。

PRODUCT 构建中跳过 `.hotspotrc` 但通过 `os::stat(hotspotrc, &buf)` (`/arguments.cpp:3946`) 检测其存在性——如果文件存在，在阶段 15 打印 warning。

### 3.7 parse_vm_init_args() 四源优先级链（阶段 12）

```cpp
// /arguments.cpp:3960
jint result = parse_vm_init_args(cur_vm_options_args,       // origin=JIMAGE_RESOURCE (8)
                                 cur_java_tool_options_args, // origin=ENVIRON_VAR (2)
                                 cur_java_options_args,      // origin=ENVIRON_VAR (2)
                                 cur_cmd_args);              // origin=COMMAND_LINE (1)
```

`parse_vm_init_args()` (`/arguments.cpp:2257`) 内部的 4 次 `parse_each_vm_init_arg()` 调用顺序：

| 顺序 | 来源 | origin 值 | 真正优先级（后覆盖前） |
|:---:|------|:--------:|:--------------------:|
| 1 | jimage resource | 8 | 最低 |
| 2 | JAVA_TOOL_OPTIONS | 2 | 中低 |
| 3 | 命令行 | 1 | 中高 |
| 4 | _JAVA_OPTIONS | 2 | **最高** |

注意：origin 的数值 (8 > 2 > 1) 与真正的优先级顺序相反。origin 是"最后设置来源的记录标签"，不是优先级。真正的优先级由 `set_origin()` 复写低 4 位的机制实现——后调用的 `parse_each_vm_init_arg()` 会覆写先调用者写入的 flag 值。

### 3.8 后处理（阶段 13-15）

```cpp
// /arguments.cpp:3970-4045
SharedArchivePath = get_shared_archive_path();          // 阶段 13
if (FLAG_IS_DEFAULT(VerifySharedSpaces) && ...)        // 阶段 14
    VerifySharedSpaces = true;

if (needs_hotspotrc_warning) { ... }                    // 阶段 15
#if defined(_ALLBSD_SOURCE) || defined(AIX)
    UNSUPPORTED_OPTION(UseLargePages);                   // 平台过滤
#endif
set_object_alignment();                                 // 对象对齐参数初始化
handle_deprecated_print_gc_flags();                     // PrintGC → -Xlog:gc 迁移
```

### 3.9 apply_ergo() 工效调整

```cpp
// /arguments.cpp:4048
jint Arguments::apply_ergo() {
    // ... (调用链很长，此处只展示关键)
    set_ergonomics_flags();   // :1765
    set_heap_size();          // :1798
}
```

`set_ergonomics_flags()` (`/arguments.cpp:1765-1783`) 的核心流程：
1. `GCConfig::initialize()` — 选择 GC 收集器（服务器级别默认使用 G1）
2. `set_conservative_max_heap_alignment()` — 保守堆对齐 (32MB)
3. `set_use_compressed_oops()` — 64-bit 下压缩指针判断
4. `set_use_compressed_klass_ptrs()` — 压缩类指针

**Ergonomic 之所以能覆盖用户值**，是因为 `apply_ergo()` 在 `parse_vm_init_args()` 返回后才执行（在 `Threads::create_vm()` 中调用）。此时所有 flag 已写入，ergonomic 通过 `FLAG_SET_ERGO` 再次写入，`set_origin(ERGONOMIC)` 覆写了之前的 origin 值——`get_origin()` 返回 ERGONOMIC，但 `ORIG_COMMAND_LINE` 持久位仍然保留。

---

## §四 JVMFlag 的位域编码与类型系统

### 4.1 _flags 32-bit 位域布局

```cpp
// /jvmFlag.hpp:35-70
struct JVMFlag {
  enum Flags {
    // [bit 0:3] — Value Origin (4 bits, mask = 0xF)
    DEFAULT          = 0,   // 0b0000
    COMMAND_LINE     = 1,   // 0b0001
    ENVIRON_VAR      = 2,   // 0b0010
    CONFIG_FILE      = 3,   // 0b0011
    MANAGEMENT       = 4,   // 0b0100
    ERGONOMIC        = 5,   // 0b0101
    ATTACH_ON_DEMAND = 6,   // 0b0110
    INTERNAL         = 7,   // 0b0111
    JIMAGE_RESOURCE  = 8,   // 0b1000
    LAST_VALUE_ORIGIN = JIMAGE_RESOURCE,
    VALUE_ORIGIN_BITS = 4,
    VALUE_ORIGIN_MASK = right_n_bits(VALUE_ORIGIN_BITS),  // = 0xF

    // [bit 4:16] — Kind Flags (13 bits)
    KIND_PRODUCT            = 1 << 4,   // bit 4
    KIND_MANAGEABLE         = 1 << 5,   // bit 5
    KIND_DIAGNOSTIC         = 1 << 6,   // bit 6
    KIND_EXPERIMENTAL       = 1 << 7,   // bit 7
    KIND_NOT_PRODUCT        = 1 << 8,   // bit 8
    KIND_DEVELOP            = 1 << 9,   // bit 9
    KIND_PLATFORM_DEPENDENT = 1 << 10,  // bit 10
    KIND_READ_WRITE         = 1 << 11,  // bit 11
    KIND_C1                 = 1 << 12,  // bit 12
    KIND_C2                 = 1 << 13,  // bit 13
    KIND_ARCH               = 1 << 14,  // bit 14
    KIND_LP64_PRODUCT       = 1 << 15,  // bit 15
    KIND_JVMCI              = 1 << 16,  // bit 16

    // [bit 17] — Persistent Command Line Marker (1 bit, 永不清除)
    ORIG_COMMAND_LINE       = 1 << 17,  // bit 17

    // [bit 4:16] mask for all kind bits
    KIND_MASK = ~(VALUE_ORIGIN_MASK | ORIG_COMMAND_LINE)
  };
};
```

ASCII 位域布局图：

```
Bit     31 ─────────── 18 │ 17                │ 16 ─────────── 4 │ 3 ── 0
        ┌─────────────────┼───────────────────┼──────────────────┼───────┐
        │   (unused)      │ ORIG_COMMAND_LINE │   KIND (13 bits) │ORIGIN │
        │    bits 18-31   │    永久的持久位     │ 12种类型标志       │4 bits │
        └─────────────────┼───────────────────┼──────────────────┼───────┘
                                                          ↑               ↑
                                                    KIND_MASK      VALUE_ORIGIN_MASK
                                                       (0x1FFF0)        (0xF)
```

### 4.2 origin 与 priority 的非等价关系

**这是本文档最重要的设计要点**：

| 概念 | 含义 | 代码来源 |
|------|------|---------|
| `get_origin()` | 读取 `_flags & VALUE_ORIGIN_MASK`（低 4 位）——**最后一次修改的来源** | `/jvmFlag.cpp:276-278` |
| `set_origin(origin)` | 写入低 4 位；如果是 COMMAND_LINE 还设置 bit 17 | `/jvmFlag.cpp:280-284` |
| `is_command_line()` | 读取 bit 17（ORIG_COMMAND_LINE）——**是否曾经在命令行设置过**（持久位） | `/jvmFlag.cpp:294-296` |

**关键的不对称性**：

```cpp
// /jvmFlag.cpp:280-284
void JVMFlag::set_origin(Flags origin) {
  assert((origin & VALUE_ORIGIN_MASK) == origin, "sanity");
  Flags new_origin = Flags((origin == COMMAND_LINE) ? Flags(origin | ORIG_COMMAND_LINE) : origin);
  _flags = Flags((_flags & ~VALUE_ORIGIN_MASK) | new_origin);
}
```

- 当 `origin=COMMAND_LINE` 时：`new_origin = 0b0001 | (1<<17)` → 同时设置 bit 0-3 和 bit 17
- 当 `origin=ERGONOMIC` 时：`new_origin = 0b0101` → 只设置 bit 0-3，**不触动 bit 17**

因此，一个 flag 被命令行设置后又被 ergonomic 覆盖时：
- `get_origin() == ERGONOMIC`（低 4 位已被覆盖）
- `is_command_line() == true`（bit 17 保留）

**print_origin() 利用这个设计输出 "command line, ergonomic"**：
```cpp
// /jvmFlag.cpp:683-709
void JVMFlag::print_origin(outputStream* st) {
  if (is_command_line()) st->print("command line, ");
  // then switch on get_origin() to print current origin
}
```

### 4.3 8 种数据类型的 get/set 实现

`JVMFlag` 结构体 (`/jvmFlag.hpp:34-153`) 支持 8 种数据类型：

| 类型 | `_type` 值 | 对应 C++ 类型 | `_addr` 指向 | 典型 flag 例 |
|------|-----------|-------------|-------------|-----------|
| bool | `"bool"` | `bool` | `&flag` | UseG1GC |
| int | `"int"` | `int` | `&flag` | CICompilerCount (实际是 intx) |
| uint | `"uint"` | `uint` | `&flag` | TypeProfileLevel |
| intx | `"intx"` | `intx` | `&flag` | CompileThreshold |
| uintx | `"uintx"` | `uintx` | `&flag` | MaxHeapSize |
| uint64_t | `"uint64_t"` | `uint64_t` | `&flag` | MaxRAM |
| size_t | `"size_t"` | `size_t` | `&flag` | InitialHeapSize |
| double | `"double"` | `double` | `&flag` | MaxRAMPercentage |
| ccstr | `"ccstr"` | `ccstr` (char*) | `&flag` | ErrorFile |
| ccstrlist | `"ccstrlist"` | `ccstr` (char*) | `&flag` | CompileOnly |

每种类型有对应的 `is_xxx()` / `get_xxx()` / `set_xxx()` 方法。例如 bool 类型：

```cpp
// /jvmFlag.cpp:130-150 (set_bool 简化逻辑)
JVMFlag::Error JVMFlag::set_bool(bool value) {
  JVMFlag::Error error = check_writable(value != get_bool());
  if (error == JVMFlag::SUCCESS) {
    *((bool*)_addr) = value;  // 直接写入全局变量
  }
  return error;
}
```

所有 `xxxAtPut()` 静态方法在 flag 写入后都调用 `set_origin(origin)`：
```cpp
// /jvmFlag.cpp:1085-1097 (intAtPut 简化)
JVMFlag::Error JVMFlag::intAtPut(JVMFlag* flag, int* value, JVMFlag::Flags origin) {
  // ... find and validate ...
  check = flag->set_int(*value);   // 实际写入
  flag->set_origin(origin);        // 更新 origin
  return check;
}
```

### 4.4 flagTable[] 的宏魔法

`flagTable[]` 是一个编译时生成的静态数组，最后以 `{0, NULL, NULL}` 哨兵结束 (`/jvmFlag.cpp:819-893`)。

**宏展开链（以 `RUNTIME_PRODUCT_FLAG_STRUCT` 为例）**：

```cpp
// Step 1: 宏定义 (/jvmFlag.cpp:770)
#define RUNTIME_PRODUCT_FLAG_STRUCT(type, name, value, doc) \
  { #type, XSTR(name), &name,                               \
    NOT_PRODUCT_ARG(doc)                                    \
    JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_PRODUCT) }

// Step 2: VM_FLAGS 宏展开 (来自 globals.hpp)
// VM_FLAGS 是一个宏，接收 14 个参数（每个对应一种 flag 种类）：
// VM_FLAGS(DEVELOP, PD_DEVELOP, PRODUCT, PD_PRODUCT, DIAGNOSTIC,
//          PD_DIAGNOSTIC, EXPERIMENTAL, NOTPRODUCT, MANAGEABLE,
//          PRODUCT_RW, LP64_PRODUCT, RANGE, CONSTRAINT, WRITEABLE)

// Step 3: 定义每个 flag 时调用 RUNTIME_PRODUCT_FLAG_STRUCT 并传入 range/constraint/writeable
// 例如: develop(intx, TraceBytecodes, 0, "Trace bytecode execution")
//   → RUNTIME_DEVELOP_FLAG_STRUCT(intx, TraceBytecodes, 0, "Trace bytecode execution")

// Step 4: 展开为结构体字面量
// { "intx", "TraceBytecodes", (void*)&TraceBytecodes,
//   "Trace bytecode execution",
//   JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_DEVELOP) }

// 最终 flagTable 结构：
static JVMFlag flagTable[] = {
    { "intx",   "TraceBytecodes",     (void*)&TraceBytecodes,     "Trace bytecode execution",         DEFAULT | KIND_DEVELOP },
    { "bool",   "UseG1GC",            &UseG1GC,                    "Use G1 garbage collector",         DEFAULT | KIND_PRODUCT },
    { "uintx",  "MaxHeapSize",        &MaxHeapSize,                "Maximum heap size",                 DEFAULT | KIND_PRODUCT },
    // ... 800+ entries ...
    { 0, NULL, NULL }   // NULL 哨兵
};
```

**宏共用机制**：`flagTable` 的 `VM_FLAGS` 展开中，最后三个参数是 `IGNORE_RANGE`、`IGNORE_CONSTRAINT`、`IGNORE_WRITEABLE`。Range/Constraint/Writeable 的 `init()` 中也调用同一个 `VM_FLAGS`，但把 RANGE/CONSTRAINT/WRITEABLE 参数换成实际的 `EMIT_RANGE_CHECK`/`EMIT_CONSTRAINT_CHECK`/`EMIT_WRITEABLE`。这使得 flag 注册表、范围表、约束表、可写性表共享同一套 flag 定义源。

### 4.5 find_flag() 线性搜索详解

```cpp
// /jvmFlag.cpp:904-925
JVMFlag* JVMFlag::find_flag(const char* name, size_t length,
                             bool allow_locked, bool return_flag) {
  for (JVMFlag* current = &flagTable[0]; current->_name != NULL; current++) {
    if (str_equal(current->_name, current->get_name_length(), name, length)) {
      // 第一层过滤: constant_in_binary (PRODUCT 构建排除 develop/notproduct)
      if (current->is_constant_in_binary()) {
        return (return_flag ? current : NULL);
      }
      // 第二层过滤: unlock 检查 (diagnostic/experimental flag 未解锁)
      if (!(current->is_unlocked() || current->is_unlocker())) {
        if (!allow_locked) {
          return NULL;
        }
      }
      return current;
    }
  }
  return NULL;  // 不在 flagTable 中
}
```

查找流程图：

```
flagTable[i]._name 匹配 name?
  ├─ NO  → i++, 继续循环
  └─ YES → is_constant_in_binary()?
              ├─ YES → 是 develop/notproduct 且 PRODUCT 构建
              │         └─ return_flag? → 返回 current (用于锁定消息)
              │         └─ !return_flag → 返回 NULL (表现为不存在)
              └─ NO  → is_unlocked() || is_unlocker()?
                          ├─ YES → 返回 current ✓
                          └─ NO  → allow_locked?
                                      ├─ NO  → 返回 NULL (锁定的 flag 不可用)
                                      └─ YES → 返回 current (允许查询锁定 flag)
```

**性能特点**：O(n) 线性搜索 ~800+ 条目。`get_name_length()` 使用惰性求值——首次调用时 `strlen` 并缓存 (`/jvmFlag.cpp:928-932`)，后续为 O(1) 整数比较。与 Go 的 `flag` 包（map-based O(1)）相比，HotSpot 选择数组的理由：flag 注册是启动一次性操作，线性搜索的耗时（<1ms）可以接受，且静态数组避免了 map 的初始化和内存管理开销。

### 4.6 fuzzy_match(): 70% 相似度阈值

```cpp
// /jvmFlag.cpp:935-964
JVMFlag* JVMFlag::fuzzy_match(const char* name, size_t length, bool allow_locked) {
  float VMOptionsFuzzyMatchSimilarity = 0.7f;
  JVMFlag* match = NULL;
  float max_score = -1;

  // 第 1 轮: 遍历整个 flagTable 找最高相似度
  for (JVMFlag* current = &flagTable[0]; current->_name != NULL; current++) {
    score = StringUtils::similarity(current->_name, strlen(current->_name),
                                     name, length);
    if (score > max_score) {
      max_score = score;
      match = current;
    }
  }

  // 第 2 轮: 检查锁定 (与 find_flag 相同的逻辑)
  if (!(match->is_unlocked() || match->is_unlocker())) {
    if (!allow_locked) return NULL;
  }

  // 第 3 轮: 70% 阈值
  if (max_score < VMOptionsFuzzyMatchSimilarity) {
    return NULL;
  }
  return match;
}
```

`StringUtils::similarity()` (`/utilities/stringUtils.cpp:46`) 使用 Levenshtein 距离的变体计算归一化相似度。实际测试：
- `"UseConcMarkSweepGC"` vs `"UseG1GC"` → 相似度约 0.48（低于 0.7，不匹配）—— CMS 移除后建议完全无关
- `"UseG1GCx"` vs `"UseG1GC"` → 相似度 > 0.8（高于 0.7，正确建议）

---

## §五 Constraint 验证层

### 5.1 三层验证时机全景

```
JVM 启动时间线
├─ Arguments::parse()
│   ├── JVMFlagConstraintList::init()     ← 注册所有约束 (容量 72)
│   ├── parse_vm_init_args()
│   │   └── parse_each_vm_init_arg()
│   │       └── process_argument()
│   │           └── xxxAtPut(origin)
│   │               └── 隐式约束: apply_constraint_and_check_range_intx()
│   │                   仅 AtParse 类型的约束在此处检查
│   │                   (_validating_type 此时 == AtParse)
│   └── return JNI_OK
│
├─ Threads::create_vm()
│   ├── Arguments::apply_ergo()
│   └── JVMFlagConstraintList::check_constraints(AfterErgo)  ← 强制 AfterErgo 检查
│       │   _validating_type = AfterErgo
│       │   遍历所有约束，只执行 constraint->type() == AfterErgo 的
│       │   guarantee(type > _validating_type) 防止回退
│       └── JVMFlagWriteableList::mark_startup() ← CommandLineOnly → false
│
└─ universe_init()
    └── JVMFlagConstraintList::check_constraints(AfterMemoryInit) ← 内存初始化后
```

**状态机**：
```cpp
// /jvmFlagConstraintList.cpp:357-368
bool JVMFlagConstraintList::check_constraints(JVMFlagConstraint::ConstraintType type) {
  guarantee(type > _validating_type, "Constraint check is out of order.");
  _validating_type = type;  // 只能递增

  bool status = true;
  for (int i=0; i<length(); i++) {
    JVMFlagConstraint* constraint = at(i);
    if (type != constraint->type()) continue;  // 只执行匹配的
    if (constraint->apply(true) != JVMFlag::SUCCESS) status = false;
  }
  return status;
}
```

`_validating_type` 只增不减，`guarantee(type > _validating_type)` 致命断言防止回退。

### 5.2 AtParse 的隐式约束触发

在 `xxxAtPut()` 中（以 `intAtPut` 为例）：
```cpp
// /jvmFlag.cpp:1090
JVMFlag::Error check = apply_constraint_and_check_range_int(name, *value,
    !JVMFlagConstraintList::validated_after_ergo());
```
`!validated_after_ergo()` 在早期解析时返回 true → `verbose=true` → 打印错误信息。

`validated_after_ergo()` (`/jvmFlagConstraintList.cpp:273`) 在 `check_constraints(AfterErgo)` 后返回 true → 后续隐性检查不再打印 (verbose=false)。

### 5.3 Constraint 子类层次

`JVMFlagConstraint` 基类 (`/jvmFlagConstraintList.hpp`) 按数据类型派生了 8 个子类：

```
JVMFlagConstraint (base)
├── JVMFlagConstraint_bool    — 约束函数类型: JVMFlag::Error (*)(bool, bool)
├── JVMFlagConstraint_int     — 约束函数类型: JVMFlag::Error (*)(int, bool)
├── JVMFlagConstraint_uint    — 约束函数类型: JVMFlag::Error (*)(uint, bool)
├── JVMFlagConstraint_intx    — 约束函数类型: JVMFlag::Error (*)(intx, bool)
├── JVMFlagConstraint_uintx   — 约束函数类型: JVMFlag::Error (*)(uintx, bool)
├── JVMFlagConstraint_uint64_t— 约束函数类型: JVMFlag::Error (*)(uint64_t, bool)
├── JVMFlagConstraint_size_t  — 约束函数类型: JVMFlag::Error (*)(size_t, bool)
└── JVMFlagConstraint_double  — 约束函数类型: JVMFlag::Error (*)(double, bool)
```

每个子类的 `apply(verbose)` 方法从全局变量读取当前 flag 值，调用存储的约束函数指针。

### 5.4 Compiler 约束函数逐行分析（3 个代表性约束）

#### 约束 1：CICompilerCount — 跨 flag 依赖验证

```cpp
// /jvmFlagConstraintsCompiler.cpp:65-92
JVMFlag::Error CICompilerCountConstraintFunc(intx value, bool verbose) {
  int min_number_of_compiler_threads = 0;
#if !defined(COMPILER1) && !defined(COMPILER2) && !INCLUDE_JVMCI
  // case 1: 解释器专用构建 → min=0
#else
  if (!TieredCompilation || (TieredStopAtLevel < CompLevel_full_optimization)) {
    min_number_of_compiler_threads = 1; // case 2/3: 分层禁用或非全优化
  } else {
    min_number_of_compiler_threads = 2; // case 4: 分层+全优化 → 至少 C1+C2
  }
#endif
  min_number_of_compiler_threads = MIN2(min_number_of_compiler_threads, CI_COMPILER_COUNT);

  if (value < (intx)min_number_of_compiler_threads) {
    JVMFlag::printError(verbose,
      "CICompilerCount (" INTX_FORMAT ") must be at least %d \n",
      value, min_number_of_compiler_threads);
    return JVMFlag::VIOLATES_CONSTRAINT;
  }
  return JVMFlag::SUCCESS;
}
```

**设计要点**：
- 依赖 `TieredCompilation` 和 `TieredStopAtLevel` 两个**其他 flag** 的当前值
- `MIN2(min, CI_COMPILER_COUNT)` 防止小 VM 构建（如 client VM）报告过高的下限
- 约束类型为 `AfterErgo`——因为 `TieredCompilation` 的值在 ergonomic 调整后才最终确定

#### 约束 2：CodeCacheSegmentSize — 三重链式对齐

```cpp
// /jvmFlagConstraintsCompiler.cpp:196-226
JVMFlag::Error CodeCacheSegmentSizeConstraintFunc(uintx value, bool verbose) {
  // 检查 1: >= CodeEntryAlignment (入口对齐)
  if (CodeCacheSegmentSize < (uintx)CodeEntryAlignment) {
    JVMFlag::printError(verbose,
      "CodeCacheSegmentSize (" UINTX_FORMAT ") must be "
      "larger than or equal to CodeEntryAlignment (" INTX_FORMAT ") "
      "to align entry points\n",
      CodeCacheSegmentSize, CodeEntryAlignment);
    return JVMFlag::VIOLATES_CONSTRAINT;
  }
  // 检查 2: >= sizeof(jdouble) (常量对齐)
  if (CodeCacheSegmentSize < sizeof(jdouble)) {
    JVMFlag::printError(verbose,
      "CodeCacheSegmentSize (" UINTX_FORMAT ") must be "
      "at least " SIZE_FORMAT " to align constants\n",
      CodeCacheSegmentSize, sizeof(jdouble));
    return JVMFlag::VIOLATES_CONSTRAINT;
  }
#ifdef COMPILER2
  // 检查 3 (C2 专用): >= OptoLoopAlignment (内循环对齐)
  if (CodeCacheSegmentSize < (uintx)OptoLoopAlignment) {
    JVMFlag::printError(verbose,
      "CodeCacheSegmentSize (" UINTX_FORMAT ") must be "
      "larger than or equal to OptoLoopAlignment (" INTX_FORMAT ") "
      "to align inner loops\n",
      CodeCacheSegmentSize, OptoLoopAlignment);
    return JVMFlag::VIOLATES_CONSTRAINT;
  }
#endif
  return JVMFlag::SUCCESS;
}
```

**设计要点**：
- 三个对齐需求的**链式依赖**：入口对齐 → 常量对齐 → 循环对齐
- `sizeof(jdouble)` 是硬编码的最小值（8 字节）
- C2 的 `OptoLoopAlignment` 只在 `COMPILER2` 构建时检查（条件编译保护）

#### 约束 3：OnStackReplacePercentage — 跨 flag 区间依赖

```cpp
// /jvmFlagConstraintsCompiler.cpp:148-194
JVMFlag::Error OnStackReplacePercentageConstraintFunc(intx value, bool verbose) {
  int backward_branch_limit;
  if (ProfileInterpreter) {
    // 检查 1: OnStackReplacePercentage >= InterpreterProfilePercentage
    if (OnStackReplacePercentage < InterpreterProfilePercentage) {
      JVMFlag::printError(verbose,
        "OnStackReplacePercentage ... must be larger than InterpreterProfilePercentage ...");
      return JVMFlag::VIOLATES_CONSTRAINT;
    }
    // 检查 2: 计算得到的 OSR 后向分支限制不能溢出
    backward_branch_limit = ((CompileThreshold * (OnStackReplacePercentage
                              - InterpreterProfilePercentage)) / 100)
                            << InvocationCounter::count_shift;
    if (backward_branch_limit < 0) {
      return JVMFlag::VIOLATES_CONSTRAINT;
    }
  } else {
    if (OnStackReplacePercentage < 0) { return JVMFlag::VIOLATES_CONSTRAINT; }
    backward_branch_limit = ((CompileThreshold * OnStackReplacePercentage) / 100)
                            << InvocationCounter::count_shift;
    if (backward_branch_limit < 0) { return JVMFlag::VIOLATES_CONSTRAINT; }
  }
  return JVMFlag::SUCCESS;
}
```

**设计要点**：
- 依赖 `ProfileInterpreter`、`CompileThreshold`、`InterpreterProfilePercentage` 三个其他 flag
- 在 `ProfileInterpreter==true` 和 `false` 两种模式下有完全不同的公式
- `<< InvocationCounter::count_shift` 将阈值放大为内部计数器的精度范围

### 5.5 Runtime 约束函数

8 个 runtime 约束函数在 `/jvmFlagConstraintsRuntime.cpp` 中，代表性示例：

#### ObjectAlignmentInBytes — 跨 OS 交互约束

```cpp
// /jvmFlagConstraintsRuntime.cpp:34-51
JVMFlag::Error ObjectAlignmentInBytesConstraintFunc(intx value, bool verbose) {
  if (!is_power_of_2(value)) {
    return JVMFlag::VIOLATES_CONSTRAINT;  // 必须是 2 的幂
  }
  if (value >= (intx)os::vm_page_size()) {  // 必须小于页面大小
    return JVMFlag::VIOLATES_CONSTRAINT;
  }
  return JVMFlag::SUCCESS;
}
```

约束类型为 `AfterMemoryInit`——因为 `os::vm_page_size()` 在 OS 初始化后才可用。

#### ThreadLocalHandshakes — 平台能力约束

```cpp
// /jvmFlagConstraintsRuntime.cpp:135-143
JVMFlag::Error ThreadLocalHandshakesConstraintFunc(bool value, bool verbose) {
  if (value) {
    if (!SafepointMechanism::supports_thread_local_poll()) {
      return JVMFlag::VIOLATES_CONSTRAINT;  // 平台不支持
    }
  }
  return JVMFlag::SUCCESS;
}
```

---

## §六 Range 检查层

### 6.1 JVMFlagRange 基类与子类

```cpp
// /jvmFlagRangeList.hpp:42-59
class JVMFlagRange : public CHeapObj<mtArguments> {
  const char* _name;
public:
  JVMFlagRange(const char* name) { _name=name; }
  const char* name() { return _name; }
  virtual JVMFlag::Error check(bool verbose = true) { ShouldNotReachHere(); }
  virtual JVMFlag::Error check_int(int value, bool verbose = true) { ... }
  virtual JVMFlag::Error check_intx(intx value, bool verbose = true) { ... }
  // ... 每个类型一个虚函数 ...
  virtual void print(outputStream* st) { ; }
};
```

7 个类型子类（对应非 ccstr 的 7 种数值类型）：

```
JVMFlagRange (base)
├── JVMFlagRange_int
├── JVMFlagRange_intx    ← 最常用
├── JVMFlagRange_uint
├── JVMFlagRange_uintx
├── JVMFlagRange_uint64_t
├── JVMFlagRange_size_t
└── JVMFlagRange_double
```

每个子类存储 `{_min, _max}` 和 `_ptr`（指向 flag 全局变量的指针），`check()` 读取 `*_ptr` 的当前值做边界比较。

### 6.2 默认范围的生成策略

```cpp
// /jvmFlag.cpp:68-70
static const char* get_intx_default_range_str() {
  return os::print_value_range(min_intx, max_intx);
  // 64-bit: "[-9223372036854775808 ... 9223372036854775807]"
}
```

`JVMFlagRangeList::print()` (`/jvmFlagRangeList.cpp:409-422`) 的 fallback 逻辑：

1. 先在 `_ranges` 中查找同名 range → 找到则调用 `range->print()`
2. 未找到 → 调用 `JVMFlagConstraintList::find()` → 找到约束 → 用对应的 `get_xxx_default_range_str()` 
3. 都没有 → 不输出

**bool/ccstr/ccstrlist 类型不参与 range check**：`emit_range_bool()` 和 `emit_range_ccstr()` 都是空函数（NOP）。

### 6.3 check_ranges() 的使用时机

```cpp
// /jvmFlagRangeList.cpp:424-431
bool JVMFlagRangeList::check_ranges() {
  bool status = true;
  for (int i=0; i<length(); i++) {
    JVMFlagRange* range = at(i);
    if (range->check(true) != JVMFlag::SUCCESS) status = false;
  }
  return status;
}
```

`check_ranges()` **不在 `parse()` 中调用**，而是在 `JVMFlag::verify()` → `Arguments::check_vm_args_consistency()` 中（仅 debug 构建）。

---

## §七 Writeable 控制层

### 7.1 Always / Once / CommandLineOnly 三态

```cpp
// /jvmFlagWriteableList.hpp
class JVMFlagWriteable : public CHeapObj<mtArguments> {
public:
  enum WriteableType {
    Always = 0,          // 随时可修改
    Once = 1,            // 只能改一次
    CommandLineOnly = 2  // 只在启动命令行可修改
  };
};
```

| 状态 | 典型 flag | 修改时机 | 实现方式 |
|------|----------|---------|---------|
| `Always` | `TraceRedefineClasses` | 启动 + 运行时 (jcmd) | `_writeable` 保持 true |
| `Once` | `CompileThreshold` | 启动时一次 | `mark_once()` → `_writeable=false` |
| `CommandLineOnly` | `ErrorFile` | 仅启动命令行 | `mark_startup()` → `_writeable=false` |

### 7.2 完整生命周期

```
JVMFlagWriteable 对象创建
  │ _type = CommandLineOnly
  │ _writeable = true (默认)
  │
  ├─ parse_vm_init_args() 期间:
  │   └── check_writable() (/jvmFlag.cpp:96-125)
  │         ├── is_constant_in_binary()? → fatal (不应到达)
  │         ├── JVMFlagWriteableList::find(_name) → 找到
  │         └── check_writable_at_parse(writeable)
  │               └── 对 Once: mark_once() → _writeable = false
  │
  ├─ Threads::create_vm() 中:
  │   └── JVMFlagWriteableList::mark_startup()
  │         └── 遍历所有 Writeable:
  │               └── 对 CommandLineOnly: mark_startup()
  │                     → _writeable = false
  │
  └─ 运行时 jcmd 修改:
      └── check_writable() → _writeable == false → SET_ONLY_ONCE / COMMAND_LINE_ONLY
```

### 7.3 is_writeable() 与 kind 的关系

```cpp
// /jvmFlag.cpp:399-401
bool JVMFlag::is_writeable() const {
  return is_manageable() || (is_product() && is_read_write()) || is_writeable_ext();
}
```

`is_writeable()` 检查 kind 位（决定"是否可写"），`check_writable()` 再检查 WriteableList（决定"何时可写几次"）——两者不冗余，而是两层不同语义的守卫。

---

## §八 Unlock 机制

### 8.1 is_unlocker() 硬编码名单

```cpp
// /jvmFlag.cpp:346-350
bool JVMFlag::is_unlocker() const {
  return strcmp(_name, "UnlockDiagnosticVMOptions") == 0     ||
         strcmp(_name, "UnlockExperimentalVMOptions") == 0   ||
         is_unlocker_ext();  // JVMCI 扩展点
}
```

只有两个内置 unlocker flag：`UnlockDiagnosticVMOptions` 和 `UnlockExperimentalVMOptions`。

### 8.2 is_unlocked() 逻辑

```cpp
// /jvmFlag.cpp:352-360
bool JVMFlag::is_unlocked() const {
  if (is_diagnostic()) {
    return UnlockDiagnosticVMOptions;    // 读全局 bool
  }
  if (is_experimental()) {
    return UnlockExperimentalVMOptions;  // 读全局 bool
  }
  return is_unlocked_ext();  // JVMCI 扩展
}
```

`UnlockDiagnosticVMOptions` 和 `UnlockExperimentalVMOptions` 是 C++ 全局 bool 变量（由 `VM_FLAGS` 宏声明），初始值为 `false`。

### 8.3 find_flag() 中的 unlock 检查位置

```cpp
// /jvmFlag.cpp:913-919
if (!(current->is_unlocked() || current->is_unlocker())) {
  if (!allow_locked) {
    return NULL;  // ← 关键: 未解锁时返回 NULL
  }
}
```

**为什么 unlock flag 必须放在被解锁 flag 前面**：

解析 `-XX:+UseZGC -XX:+UnlockExperimentalVMOptions` 时：
1. 解析 `-XX:+UseZGC` → `find_flag("UseZGC")` → UseZGC 是 KIND_EXPERIMENTAL → `is_unlocked()` 读取 `UnlockExperimentalVMOptions` → **false**（尚未设置）→ `!is_unlocker()` → true → 返回 **NULL**
2. `process_argument()` line 1320 `find_flag(allow_locked=true, return_flag=true)` → 找到 UseZGC → `get_locked_message()` 生成错误

正确的顺序 `-XX:+UnlockExperimentalVMOptions -XX:+UseZGC`：
1. 解析 unlock flag → `FLAG_SET_CMDLINE(bool, UnlockExperimentalVMOptions, true)` → 设置全局 bool 为 true
2. 解析 `-XX:+UseZGC` → `find_flag("UseZGC")` → `is_unlocked()` 读取全局 bool → **true** → 返回有效指针

### 8.4 get_locked_message() 错误消息生成

```cpp
// /jvmFlag.cpp:370-397
JVMFlag::MsgType JVMFlag::get_locked_message(char* buf, int buflen) const {
  buf[0] = '\0';
  if (is_diagnostic() && !is_unlocked()) {
    jio_snprintf(buf, buflen,
      "Error: VM option '%s' is diagnostic and must be enabled via "
      "-XX:+UnlockDiagnosticVMOptions.\n"
      "Error: The unlock option must precede '%s'.\n", _name, _name);
    return JVMFlag::DIAGNOSTIC_FLAG_BUT_LOCKED;
  }
  if (is_experimental() && !is_unlocked()) {
    jio_snprintf(buf, buflen,
      "Error: VM option '%s' is experimental and must be enabled via "
      "-XX:+UnlockExperimentalVMOptions.\n"
      "Error: The unlock option must precede '%s'.\n", _name, _name);
    return JVMFlag::EXPERIMENTAL_FLAG_BUT_LOCKED;
  }
  if (is_develop() && is_product_build()) {
    jio_snprintf(buf, buflen, "Error: VM option '%s' is develop and is available "
      "only in debug version of VM.\n", _name);
    return JVMFlag::DEVELOPER_FLAG_BUT_PRODUCT_BUILD;
  }
  // ... notproduct 同理 ...
  return get_locked_message_ext(buf, buflen);
}
```

### 8.5 clear_diagnostic() — flag promote

```cpp
// /jvmFlag.cpp:362-366
void JVMFlag::clear_diagnostic() {
  assert(is_diagnostic(), "sanity");
  _flags = Flags(_flags & ~KIND_DIAGNOSTIC);
  assert(!is_diagnostic(), "sanity");
}
```

某些 diagnostic flag 被 promote 为 product flag 后不再需要 unlock。`clear_diagnostic()` 清除 `KIND_DIAGNOSTIC` 位（bit 6），使得 `is_diagnostic()==false`，后续 `is_unlocked()` 返回 true。

---

## §九 诊断工具与调试方法

### 9.1 PrintFlags 系列

| 命令 | 输出内容 | 内部实现 |
|------|---------|---------|
| `-XX:+PrintFlagsInitial` | 所有 flag 默认值（DEFAULT origin） | `JVMFlag::printFlags(tty, false)` |
| `-XX:+PrintFlagsFinal` | 所有 flag 最终值 + origin 标签 | `JVMFlag::printFlags(tty, false)` 在 parse 后 |
| `-XX:+PrintFlagsRanges` | 每个 flag 的范围/约束信息 | `JVMFlagRangeList::print()` |
| `-XX:+PrintFlagsWithComments` | flag + doc 注释（仅 debug 构建） | `JVMFlag::printFlags(tty, true)` |
| `jcmd <pid> VM.flags` | 运行时查询当前值 | `JVMFlag::printSetFlags()` |
| `jcmd <pid> VM.flags -all` | 包括默认值的全部 flag | `JVMFlag::printFlags()` |

PrintFlagsFinal 输出示例：
```
uintx MaxHeapSize              = 4294967296         {product} {command line}
uintx InitialHeapSize          = 268435456          {product} {ergonomic}
 intx  CICompilerCount          = 3                  {product} {ergonomic}
  bool UseG1GC                  = true               {product} {command line}
double MaxRAMPercentage         = 75.000000          {product} {default}
 ccstr ErrorFile                = /tmp/hs_%p.log     {product} {command line}
```

每列含义：
- 类型 + flag 名称
- 值（含 `=` 对齐）
- `{kind}` — flag 类型分类
- `{origin}` — 最后修改来源的文本标签

### 9.2 jcmd VM.set_flag 运行时修改

```bash
jcmd <pid> VM.set_flag MaxHeapFreeRatio 80
jcmd <pid> VM.set_flag PrintGC true
```

修改受 `check_writable()` 约束。`CommandLineOnly` flag 拒绝修改。

### 9.3 GDB 验证断言

```gdb
# 断言 1: flagTable 最后一个元素是 NULL 哨兵
(gdb) p JVMFlag::flags
(gdb) p JVMFlag::flags[JVMFlag::numFlags - 1]._name
# 预期: 0x0

# 断言 2: numFlags 约 800-900
(gdb) p JVMFlag::numFlags

# 断言 3: UseG1GC 包含 KIND_PRODUCT
(gdb) p JVMFlag::find_flag("UseG1GC", 8)->_flags
# 预期: _flags & 0x10 != 0 (bit 4 = KIND_PRODUCT)

# 断言 4: constraintList 初始化后 ≥ 72 条目
(gdb) p JVMFlagConstraintList::_constraints->_len

# 断言 5: rangeList 初始化后约 379 条目
(gdb) p JVMFlagRangeList::_ranges->_len

# 断言 6: 命令行 flag 的 ORIG_COMMAND_LINE 位已设置
(gdb) p JVMFlag::find_flag("PrintGCDetails", 15)->is_command_line()
# (需要 -XX:+PrintGCDetails) 预期: true

# 断言 7: UnlockExperimentalVMOptions 是 bool 类型
(gdb) p JVMFlag::find_flag("UnlockExperimentalVMOptions", 27)->is_bool()
# 预期: true

# 断言 8: 未解锁时 diagnostic flag 返回 NULL
(gdb) p JVMFlag::find_flag("PrintAssembly", 13, false, false)
# 预期: 0x0 (NULL)
(gdb) p JVMFlag::find_flag("PrintAssembly", 13, true, false)
# 预期: 非空 (allow_locked=true)

# 断言 9: fuzzy_match 对拼写错误给出建议
(gdb) p JVMFlag::fuzzy_match("UseG1GCx", 8)
# 预期: 返回 UseG1GC 的 JVMFlag* (similarity > 0.7)
```

### 9.4 strace 追踪配置文件读取

```bash
# 追踪 .hotspotrc 的 stat() 调用
strace -e trace=stat -f java -version 2>&1 | grep hotspotrc

# 追踪 -XX:Flags= 的文件读取
strace -e trace=openat,read -f java -XX:Flags=/path/to/flags -version

# 检查环境中 JAVA_TOOL_OPTIONS 和 _JAVA_OPTIONS
cat /proc/self/environ | tr '\0' '\n' | grep -E 'JAVA_TOOL_OPTIONS|_JAVA_OPTIONS'
```

### 9.5 /proc 接口查询

```bash
# 查看当前 JVM 进程的环境变量（含 JAVA_TOOL_OPTIONS）
cat /proc/<pid>/environ | tr '\0' '\n'

# 查看进程内存映射（验证 libjvm.so 已加载）
cat /proc/<pid>/maps | grep libjvm

# 查看进程的命令行参数
cat /proc/<pid>/cmdline | tr '\0' ' '
```

### 9.6 jstack 追踪 flag 修改线程

```bash
# 确认 flag 通过 Attach API 修改时涉及的线程
jstack <pid> | grep -E "VM Thread|Attach Listener|Signal Dispatcher"

# 运行时 flag 修改（如 jcmd VM.set_flag）通过 AttachListener → VMThread 串行执行
# VM Thread 持有 Flag_lock 后修改 _flags 字段
jstack <pid> | grep -B 2 "PlatformMonitor"
```

---

## §十 边界场景与潜在陷阱

### 场景 1：多线程并发 set flag 时的 origin 覆盖

如果两个线程同时设置同一个 flag（如 jcmd 和 ergonomic 触发的调整），`set_origin()` 的 `_flags = Flags((_flags & ~VALUE_ORIGIN_MASK) | new_origin)` 不是原子操作。在 32-bit 平台上这不是原子写入（在 64-bit 上是原子对齐写入）。JVM 设计上保证 flag 设置在单线程启动阶段完成，运行时通过 jcmd 的 `VM.set_flag` 也是单线程同步执行的。

### 场景 2：ccstrlist 无限追加导致 OOM

`CompileOnly` 是 ccstrlist 类型，每次 `-XX:CompileOnly=com.foo.*` 都会通过 `append_to_string_flag()` (`/arguments.cpp:966-993`) 用 `\n` 拼接旧值和新值。`ccstrAtPut()` (`/jvmFlag.cpp:267-273`) 内部调用 `os::strdup_check_oom()` 分配堆内存。无限次 jcmd 修改可能导致内存泄漏——但通常 `CompileOnly` 只在启动时设置。

### 场景 3：GC ergonomic 覆盖用户 -Xmx

`-Xmx4g` → `FLAG_SET_CMDLINE(size_t, MaxHeapSize, 4g)` → origin=COMMAND_LINE。然后 `apply_ergo()` 中 `set_heap_size()` → `limit_by_allocatable_memory()` → `FLAG_SET_ERGO(MaxHeapSize, limited)` → origin = ERGONOMIC。结果：`get_origin()` 返回 `ERGONOMIC`，但 `is_command_line()` 返回 true。`PrintFlagsFinal` 输出 `{ergonomic}` 但前面可能有 "command line, " 前缀。

### 场景 4：SELinux 阻止 .hotspotrc 读取

`process_settings_file(".hotspotrc")` 使用 `fopen(file_name, "rb")` (`/arguments.cpp:1366`)。在 SELinux 启用或 umask 限制的环境下可能返回 NULL。当 `should_exist=false` 时直接 return true（无警告），但用户无法感知配置文件未被加载。

### 场景 5：LD_PRELOAD 干扰 find_flag 的线性搜索

`find_flag()` 依赖 `str_equal()` (`/jvmFlag.cpp:898-901`) 使用 `memcmp()` (`man 3 memcmp`) 做名称匹配。如果 LD_PRELOAD hook 了 `memcmp` 或 `strlen`，可能导致名称匹配失败或性能下降。这是极端场景但在安全敏感环境中需要考虑。

---

## §十一 反事实分析

### 反事实 1：如果约束在解析时立即验证而非推迟

**当前设计**：`FLAG_SET_DEFAULT` 在解析时不触发约束，只在 `AtParse` 类型的 `xxxAtPut()` 或后续 `check_constraints()` 中验证。

**反事实**：如果每次 `FLAG_SET_DEFAULT` 都立即验证所有约束，`CICompilerCount` 约束会失败——因为 `TieredCompilation` 等依赖 flag 在解析时可能尚未设置，导致约束函数读取到未初始化的值。推迟验证是分阶段的状态确认，不是延迟错误报告。

### 反事实 2：如果 origin 真的编码了优先级

**当前设计**：origin 的值和位宽（4 bits）只存储最后修改来源，不表达优先级。

**反事实**：如果 origin 编码了"数字越大优先级越高"：
- `JIMAGE_RESOURCE (8) > ENVIRON_VAR (2) > COMMAND_LINE (1)` 使得 jimage 中的默认选项无法被用户命令行覆盖
- 需要一个复杂的"优先级比较+拒绝写入"机制替代当前的"后写入覆盖前写入"
- `_JAVA_OPTIONS` 覆盖命令行的能力将丢失（两者都是 origin=2）

**结论**：origin 是"最后修改来源"的设计是正确的——它允许调用顺序（而非数值大小）决定真正的优先级。

### 反事实 3：如果 range check 在每次 flag 设置时都执行

**当前设计**：`check_ranges()` 只在 debug 构建的 `check_vm_args_consistency()` 中调用。

**反事实**：如果在每次 `xxxAtPut()` 中都执行 range check：
- 每个 flag 设置增加 O(379) 次线性搜索 + 范围比较，启动性能显著下降
- `CICompilerCount=0` 在启动时会被立即拒绝（而不是等到后续才报错）
- 但 HotSpot 选择把范围检查放在 debug 构建——部分理由是"范围只是验证，不影响实际行为"

### 反事实 4：如果 fuzzy_match 使用编辑距离而非相似度

**当前设计**：`StringUtils::similarity()` 归一化到 [0,1] 范围，70% 阈值。

**反事实**：如果使用 Levenshtein 编辑距离：
- `"UseG1GC"` vs `"UseConcMarkSweepGC"` → 编辑距离大（~10）但语义上都是 GC flag
- 需要针对不同 flag 名称长度设置不同的编辑距离阈值
- 归一化相似度更通用——`similarity=0.7` 对 5 字符和 25 字符名都适用

---

## §十二 总结

HotSpot JVM Flag System 是一个设计精密的**编译时注册 + 运行时验证**四阶段流水线系统：

1. **编译时注册**：`VM_FLAGS()` 宏 → 多套 STRUCT 宏 → `flagTable[]` 静态数组（800+ 条目）和 `ConstraintList`/`RangeList`/`WriteableList` 的 init 函数共用同一套 flag 定义
2. **15 阶段解析管线**：从 jimage/环境变量/命令行/配置文件 4 个来源按严格顺序收集参数，`ScopedVMInitArgs` 保证动态内存安全
3. **三层验证体系**：Constraint（AtParse→AfterErgo→AfterMemoryInit 三级时序，处理跨 flag 依赖）→ Range（静态上下界）→ Writeable（Always/Once/CommandLineOnly 三态生命周期）
4. **位域编码**：32-bit `_flags` 字段存储 origin (4bit) + kind (13bit) + ORIG_COMMAND_LINE (1bit)，origin 是"最后修改来源"而非"优先级"

**关键设计决策**：
- origin ≠ priority：优先级由调用顺序控制，origin 只是来源标签
- `ORIG_COMMAND_LINE` 持久位：允许知道"是否曾被命令行设置过"即使 origin 已被覆盖
- `find_flag()` 在 unlock 层面拦截：被锁定的 flag 直接返回 NULL，而非在值写入时报错
- `fuzzy_match()` 的 70% 阈值：在严格匹配失败后提供人性化建议
- 三种 init() 的宏共用模式：flagTable/RangeList/ConstraintList/WriteableList 共享 `VM_FLAGS()` 定义源

---

## §十三 参考资料

- JDK 源码: `src/hotspot/share/runtime/arguments.{hpp,cpp}`
- JDK 源码: `src/hotspot/share/runtime/flags/jvmFlag.{hpp,cpp}`
- Man pages: `read(2)`, `open(2)`, `stat(2)`, `malloc(3)`, `qsort(3)`, `vfprintf(3)`, `memcmp(3)`
- OpenJDK bug: JDK-8203197 (Arguments::parse) / JDK-8041990 (UnlockDiagnosticVMOptions)
- 相关文档: `01-jvm-startup/20-Arguments-Parse-Flow.md`（`-D` 属性解析和 `-X` 选项分析）
