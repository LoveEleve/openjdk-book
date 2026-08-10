# prompt-02: HotSpot 编译 — libjvm.so 如何诞生

## §〇 Production Scenario

你改了 `src/hotspot/share/gc/g1/g1SATBCardTableModRefBS.cpp` 一行代码。执行 `make hotspot-server-libs`。JVM_FEATURES 包含 `g1gc`，编译系统如何知道这个文件该编进 libjvm.so？如果 configure 时 `--with-jvm-features=-g1gc`，这个文件会被排除吗？排除机制是整目录排除还是 per-file 排除？

三个真实故障场景：

1. **G1 GC 的 cpp 没编进去**：configure 时误用 `--with-jvm-features=-g1gc`，生成的 JVM 无法运行任何使用 G1 的应用（`-XX:+UseG1GC` 会报错）。诊断：`nm -D build/*/jdk/lib/server/libjvm.so | grep "G1CollectedHeap"`——如果符号不在，说明文件被 JVM_EXCLUDE_PATTERNS 过滤了。源代码位置：`JvmFeatures.gmk:142-145` 的 `JVM_EXCLUDE_PATTERNS += gc/g1`。

2. **JVMTI 功能"半开半关"**：configure 时 `--with-jvm-features=-jvmti` 但忘记 `jvmti` 是 services 和 management 的依赖——依赖链（`hotspot.m4:338`）自动禁用了 services 和 management，导致 JMX 和其他诊断功能也消失。诊断：`grep INCLUDE_JVMTI build/*/spec.gmk` 和 `grep INCLUDE_SERVICES build/*/spec.gmk`。

3. **预编译头失效导致编译慢 3 倍**：`precompiled.hpp` 的 `.gch` 文件被误删或失效后，make 不自愈——每个 .cpp 都需要重新解析 50KB 的共享头文件。诊断：`ls build/*/hotspot/variant-server/libjvm/precompiled/*.gch`——如果 .gch 不存在或比 precompiled.hpp 旧，需要 `make clean-hotspot-server-libs && make hotspot-server-libs`。

## §一 Task + Narrative + Beginner Callouts

**任务**：分析 CompileJvm.gmk + JvmFeatures.gmk 的条件编译机制——JVM_FEATURES 如何通过 5 层过滤（CFLAGS 宏定义、SRC_DIRS 包含、EXCLUDES 目录排除、EXCLUDE_FILES 文件排除、EXCLUDE_PATTERNS 模式排除）精确控制哪些 .cpp 编译进 libjvm.so。

**叙事线索**：从 `SetupNativeCompilation(BUILD_LIBJVM)` 调用开始，追踪 JVM_FEATURES → JvmFeatures.gmk 的 ifeq 分支 → 5 层过滤集合的累积 → g++ 编译 → libjvm.so 链接。

**7 个 Beginner Callout**：

> **Callout 1 — check-jvm-feature 函数的实现**：`JvmFeatures.gmk` 不直接访问 `JVM_FEATURES` 变量，而是通过 `$(call check-jvm-feature, compiler1)` 宏间接检测。这个宏定义在 `make/common/MakeBase.gmk`，内部逻辑是 `$(if $(filter $1, $(JVM_FEATURES)), true, false)`——本质上是在 `JVM_FEATURES` 空白分隔的列表中搜索 feature 名。

> **Callout 2 — 5 层过滤而非 1 层**：不是简单地"有 feature 就编，没有就不编"。而是 5 层递进：① CFLAGS 宏定义（`-DCOMPILER1` 控制源码内的 `#ifdef`）、② SRC_DIRS 包含（`JVM_SRC_DIRS += ...` 添加源目录）、③ EXCLUDES 目录排除（`JVM_EXCLUDES += opto libadt` 跳过整个目录）、④ EXCLUDE_FILES 文件排除（精确到 .cpp 文件名）、⑤ EXCLUDE_PATTERNS 模式排除（`gc/g1` 匹配子路径）。5 层针对不同粒度——目录级快速排除、文件级精确控制、宏级源码内条件编译。

> **Callout 3 — INCLUDE_XXX=0 宏的语义**：`JvmFeatures.gmk` 对每个 feature 定义 `-DINCLUDE_XXX=0` 或 `-DINCLUDE_XXX=1`。源码中用 `#if INCLUDE_JFR` 而非 `#ifdef INCLUDE_JFR`——前者在宏未定义时编译报错（`#if` 求值失败），后者在宏未定义时静默跳转为 0（可能导致错误的 dead-code elimination）。这是 unsafe-by-default 而非 safe-by-default 的设计选择。

> **Callout 4 — JVM_SRC_DIRS 的动态拼接**：CompileJvm.gmk 不硬编码源文件目录列表。`JVM_SRC_DIRS` 初始值来自 spec.gmk（configure 注入的 `JVM_FEATURES_*`），然后 JvmFeatures.gmk 的每个 `ifeq` 分支追加或移除目录。最终 SRC 参数传给 `SetupNativeCompilation`，该宏遍历 SRC 下的所有 .cpp 文件——每个 feature 的目录自动加入编译。

> **Callout 5 — 预编译头的 GCC 实现**：`CompileJvm.gmk:101-103` 的 `JVM_PRECOMPILED_HEADER := precompiled.hpp`。GCC 的预编译头机制：第一次编译 `precompiled.hpp` 时生成 `precompiled.hpp.gch`（~100MB 的序列化 AST），后续每个 .cpp 的 `#include "precompiled.hpp"` 自动检测 .gch 并跳过解析——编译时间从 ~45 秒/文件降到 ~3 秒/文件（~15 倍加速）。但 .gch 失效（源文件被修改但 .gch 未重建）会导致编译失败——因为 .gch 的 AST 与修改后的头文件不一致。

> **Callout 6 — mapfile 符号导出的 JVM_* 前缀约定**：`CompileJvm.gmk:175` 指定 mapfile 路径为 `$(JVM_OUTPUTDIR)/mapfile`。mapfile 的内容来自 `make/hotspot/symbols/symbols-$(OPENJDK_TARGET_OS)`，格式为 `SUNWprivate_1.1 { global: JVM_*; local: *; }`——只导出以 JVM_ 开头的函数符号，其他（ObjectMonitor::enter、Klass::vtable() 等）全部 hidden。这确保外部只能通过 JNI 接口与 JVM 交互。

> **Callout 7 — 多 variant 的并行编译隔离**：`build/*/hotspot/variant-server/libjvm/objs/` 和 `build/*/hotspot/variant-minimal/libjvm/objs/` 是完全独立的目录。`JVM_VARIANT_OUTPUTDIR` 宏确保同名的 .o（如 thread.o）在 server 和 minimal 变体中不会冲突——因为输出路径已经被 variant 名隔离。

---

## §二 Standard Environment

### Source Roots
```
make/hotspot/lib/CompileJvm.gmk      (line 153: BUILD_LIBJVM 调用)
make/hotspot/lib/JvmFeatures.gmk     (line 32-177: 22 个 ifeq 分支)
make/hotspot/lib/JvmFlags.gmk        (编译和链接标志)
make/hotspot/lib/JvmOverrideFiles.gmk (per-file 标志覆盖)
make/hotspot/lib/JvmDtraceObjects.gmk (dtrace 探测)
make/hotspot/lib/CompileLibraries.gmk (include CompileJvm.gmk)
make/common/NativeCompilation.gmk    (SetupNativeCompilation 宏, ~500 lines)
src/hotspot/share/precompiled/precompiled.hpp (预编译头)
make/hotspot/symbols/                (mapfile 符号列表)
```

### Build Commands
```bash
# 只编译 HotSpot
make hotspot-server-libs              # 编译 server variant
make hotspot-server-gensrc            # 生成 HotSpot 源码

# 编译其他 variant
make hotspot-minimal-libs             # 编译 minimal variant
make hotspot-client-libs               # 编译 client variant

# 增量编译（修改单个 .cpp 后）
touch src/hotspot/share/runtime/thread.cpp && make hotspot-server-libs -j8

# 全量重编译 HotSpot
make clean-hotspot-server-libs && make hotspot-server-libs -j8
```

### Binary Paths
```
build/linux-x86_64-normal-server-slowdebug/hotspot/variant-server/
├── libjvm/
│   ├── objs/                          # 所有 .o 文件 (~800 files for server)
│   ├── libjvm.so                      # 未 strip 的 debug 版本 (~200MB)
│   ├── libjvm.diz                     # DWARF 压缩符号
│   ├── mapfile                        # 符号导出表
│   └── precompiled/
│       └── precompiled.hpp.gch        # 预编译头 (~100MB)
└── gensrc/adfiles/                    # ADLC 生成的 .cpp
```

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| CompileJvm.gmk | make/hotspot/lib/CompileJvm.gmk | 220 | BUILD_LIBJVM, JVM_EXCLUDE_FILES, JVM_EXCLUDES, EXCLUDE_PATTERNS | 主编译定义 |
| JvmFeatures.gmk | make/hotspot/lib/JvmFeatures.gmk | 284 | 22 个 ifeq 分支, 5 层过滤 | JVM_FEATURES 条件编译 |
| JvmFlags.gmk | make/hotspot/lib/JvmFlags.gmk | ~100 | JVM_CFLAGS, JVM_LDFLAGS | 编译和链接标志 |
| JvmOverrideFiles.gmk | make/hotspot/lib/JvmOverrideFiles.gmk | ~80 | per-file CXXFLAGS override | 文件级标志覆盖 |
| JvmDtraceObjects.gmk | make/hotspot/lib/JvmDtraceObjects.gmk | ~50 | DTRACE_EXTRA_OBJECT_FILES | dtrace 探测文件 |
| CompileLibraries.gmk | make/hotspot/lib/CompileLibraries.gmk | ~200 | BUILD_HOTSPOT_LIBS, include CompileJvm.gmk | HotSpot .so 入口 |
| NativeCompilation.gmk | make/common/NativeCompilation.gmk | ~500 | SetupNativeCompilation, SetupNativeCompilationBody | 宏定义 |

---

## §四 Deep Dive Question Groups (≥8 组，含 counterfactual)

### 4.1 check-jvm-feature：22 个 ifeq 分支的统一入口

① `$(call check-jvm-feature, compiler1)` 的实现原理：`$(if $(filter compiler1, $(JVM_FEATURES)), true, false)`——在 `JVM_FEATURES` 空白分隔列表中精确匹配 feature 名。如果 `JVM_FEATURES = compiler1 compiler2 g1gc jfr`，则 `check-jvm-feature(compiler1)` 返回 true，`check-jvm-feature(zgc)` 返回 false。

② 为什么不用 `$(findstring ...)` 而用 `$(filter ...)`？`filter` 做完整的单词匹配，`findstring` 做子串匹配——`check-jvm-feature(jfr)` 如果用 findstring 也会匹配 `jfr` 这种子串（jfr 是 jfr 的子串）。filter 避免了子串导致的误判。

③ **Counterfactual**: 如果不用 check-jvm-feature 函数，每个 ifeq 直接操作 `JVM_FEATURES` 变量？→ 重复代码：每个 feature 都需要写 `ifeq ($(findstring jfr, $(JVM_FEATURES)), jfr)` vs `ifeq ($(call check-jvm-feature, jfr), true)`——后者更简洁且统一了空值（不存在的 feature 返回空而非 false）。

### 4.2 5 层过滤——同一 feature 的多种控制方式

① 为什么需要 5 层过滤？以 compiler2 为例（`JvmFeatures.gmk:38-45`）：
- **CFLAGS**：`JVM_CFLAGS_FEATURES += -DCOMPILER2`——源码可以用 `#ifdef COMPILER2` 选择 C2 专用路径
- **SRC_DIRS**：`JVM_SRC_DIRS += $(JVM_VARIANT_OUTPUTDIR)/gensrc/adfiles`——添加 ADLC 生成的 .cpp
- **EXCLUDES**：`JVM_EXCLUDES += opto libadt`——关掉 compiler2 时排除整个 opto/ 目录（129 文件）
- **EXCLUDE_FILES**：`JVM_EXCLUDE_FILES += bcEscapeAnalyzer.cpp ciTypeFlow.cpp`——精确排除跨目录文件
- **EXCLUDE_PATTERNS**：`JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/`——按文件名模式排除

② 5 层的优先级：CFLAGS（宏级）和 SRC_DIRS（目录级）在 feature=true 时执行；EXCLUDES（目录级）、EXCLUDE_FILES（文件级）、EXCLUDE_PATTERNS（模式级）在 feature=false 时执行。这形成了"默认全量编译 + feature 关闭时精确排除"的模型。

③ **Counterfactual**: 如果只有一层过滤（如只用 CFLAGS 宏）→ 所有 .cpp 都会被编译，但关键函数体被 `#ifdef COMPILER2` 包裹导致成空函数——libjvm.so 体积不变但功能缺失。如果只用 SRC_DIRS 包含（白名单模式）→ 新 .cpp 需要显式注册到 feature 的白名单，容易遗漏。

### 4.3 GC feature 的条件编译——整目录排除

① GC 类的 feature（g1gc/parallelgc/serialgc/cmsgc/epsilongc/zgc/shenandoahgc）都使用 `JVM_EXCLUDE_PATTERNS` 整目录排除（`JvmFeatures.gmk:137-177`）。如 `g1gc` 关闭时，`JVM_EXCLUDE_PATTERNS += gc/g1` 排除整个 `src/hotspot/share/gc/g1/` 目录（193 文件）。编译阶段跳过而非源码阶段 `#ifdef`——因为 GC 代码不与其他子系统共享，整目录排除最简洁。

② serialgc 是唯一有特殊处理的 GC：`JvmFeatures.gmk:152-157` 的 `JVM_EXCLUDE_FILES += psMarkSweep.cpp psMarkSweepDecorator.cpp`——原因：ParallelScavenge GC 在 Old 代回收时复用 SerialGC 的 mark-sweep 代码（`psMarkSweep.cpp` 包含 `#include "gc/serial/..."`）。如果 serialgc 被关闭，ParallelScavenge 需要排除这两个文件以防止编译错误。

③ **Counterfactual**: 如果所有 GC 用 `#ifdef` 在源码中条件编译？→ 优点：可以用相同函数名在不同 GC 间复用接口（如 `CollectedHeap::collect()` 的多态分派）。缺点：即使不编译进 libjvm.so，代码路径依然需要被解析和维护——且 macro 嵌套层次的增加会严重降低代码可读性。

### 4.4 JVMTI/JVMCI/Services/Management 的特有文件排除

① JVMTI 关闭时的文件排除最详细（`JvmFeatures.gmk:71-78`）：17 个精确文件名。因为 JVMTI 代码散布在 `prims/`/`runtime/`/`services/` 等多个目录——不能整目录排除（其他非 JVMTI 代码也在同一目录）。

② JVMCI 关闭时整目录排除 `jvmci`（`JvmFeatures.gmk:80-84`）：`JVM_EXCLUDES += jvmci`。但文件名排除只用一个 `jvmciCodeInstaller_$(HOTSPOT_TARGET_CPU_ARCH).cpp`——因为 JVMCI 的其他 .cpp 都在 `src/hotspot/share/jvmci/` 下，整目录排除即可。

③ Services 关闭的影响最大（`JvmFeatures.gmk:96-100`）：`heapDumper.cpp` 和 `attachListener.cpp` 被排除——`jmap` 和 `jcmd` 的部分功能失效。`VMError_report_and_die()` 中嵌入的 `heapDumper::dump()` 调用也会静默失败（`#if INCLUDE_SERVICES` 保护）。

④ **Counterfactual**: 如果 JVMTI 不用精确文件排除而用目录排除 → `prims/` 目录不能整目录排除（因为 JNI 代码也在同一目录），唯一的替代方案是单独建 `jvmti/` 目录把所有文件移过去——但这破坏了按接口类型（`prims/` = 原生接口）的分组逻辑。

### 4.5 CDS 和 AOT 的特殊编译依赖

① CDS（Class Data Sharing）关闭时排除 11 个文件（`JvmFeatures.gmk:106-120`）：`classLoaderExt.cpp`、`filemap.cpp`、`heapShared.cpp`、`metaspaceShared.cpp` 及其平台特定文件——因为这些文件互相引用（`filemap.cpp` 调用 `metaspaceShared::...`），排除不完整会导致链接错误。

② AOT（Ahead-of-Time）关闭时的排除含平台特定文件（`JvmFeatures.gmk:129-135`）：`compiledIC_aot_x86_64.cpp`、`compiledIC_aot_aarch64.cpp`、`compiledIC_aot.cpp`——同一个功能有多个 CPU 特定实现，需要全部排除。

③ **Counterfactual**: 如果 CDS 只在源码中用 `#if INCLUDE_CDS` 包裹而非文件排除→ 未编译的文件依然被 make 的 dependency scanner 检测到。修改 CDS 相关的 .hpp 后，make 会认为"所有 include 该头文件的 .cpp 都需要重编"——即使 CDS 已被关闭。文件排除避免了这种误判。

### 4.6 minimal variant 的 SIZE 优化——per-file 编译标志覆盖

① `JvmFeatures.gmk:190-283`：当 `jvm-variants=minimal` 且 `link-time-opt=false` 时，`JVM_OPTIMIZATION := SIZE`（多数 .cpp 用 -Os 编译）。但 `OPT_SPEED_SRC` 列表中的约 50 个性能关键文件用 `HIGHEST_JVM`（-O3）编译——因为 startup 路径（classLoader.cpp、instanceKlass.cpp）和 GC 路径即使在小变体中也需要可接受的性能。

② per-file 覆盖的机制（`:278-279`）：`$(foreach s, $(OPT_SPEED_SRC), $(eval BUILD_LIBJVM_$s_OPTIMIZATION := HIGHEST_JVM))`——生成 `BUILD_LIBJVM_classLoader.cpp_OPTIMIZATION := HIGHEST_JVM` 变量，`SetupNativeCompilation` 宏自动检测并应用 per-file 优化级别。

③ 特殊文件 `systemDictionary.cpp`（`:281`）：`BUILD_LIBJVM_systemDictionary.cpp_CXXFLAGS := -fno-optimize-sibling-calls`——关闭兄弟调用优化，因为 `SystemDictionary::load_instance_class()` 的调用栈被字节码直解器依赖，兄弟调用优化会合并栈帧破坏回溯。

④ **Counterfactual**: 如果 minimal variant 不用 per-file 优化、全部 -Os → startup 时间比正常 server variant 慢 ~3 倍（classFileParser.cpp 被 -Os 编译后内联全部损失）。如果全部 -O3 → libjvm.so 从 < 5MB 膨胀到 ~15MB——minimal 变体的主要卖点（体积小）消失。

### 4.7 mapfile 符号导出——JVM_* 前缀约定

① `CompileJvm.gmk:175` 的 mapfile 生成路径：`JVM_MAPFILE := $(JVM_OUTPUTDIR)/mapfile`。mapfile 的内容来自 `make/hotspot/symbols/symbols-unix`，格式为：
```
{
  global:
    JVM_*;
    jio_*;
    AsyncGetCallTrace;
  local:
    *;
};
```
只有匹配 `JVM_*` 和 `jio_*` 模式的符号导出为 global，其他全部为 local（hidden）。

② 为什么 `ObjectMonitor::enter` 不导出：外部应用（JNI agent、profiler）应该通过 `JVM_MonitorWait` 等高层 API 与 JVM 交互，而不是直接调用内部 C++ 方法。mapfile 强制执行了这个封装边界。

③ **Counterfactual**: 如果不用 mapfile，所有符号都导出 → libjvm.so 的符号表从 ~200 个膨胀到 ~5000 个。符号冲突风险：用户代码中如果定义了同名 C++ 方法（`SomeClass::do_stuff`），链接器可能错误地绑定到 libjvm.so 的版本 → 运行时 crash 且错误信息不明确。

### 4.8 预编译头——precompiled.hpp 的生成和使用

① 预编译头的工作流程：`src/hotspot/share/precompiled/precompiled.hpp` 包含了 HotSpot 最常引用的 50+ 个头文件（`jvm.h`、`oops/oopsHierarchy.hpp`、`runtime/thread.hpp` 等）。首次编译时 GCC 生成 `precompiled.hpp.gch`（~100MB），后续每个 .cpp 的 `#include "precompiled.hpp"` 自动检测 .gch 并跳过解析。

② 为什么 .gch 需要 100MB：它序列化了所有包含的头文件的完整 AST + 宏定义展开 + 类型信息——不是文本缓存，而是编译器内部表示。包含的 50KB 头文件文本 × 20x 膨胀（AST 比源码大）= ~1MB。加上平台特定的宏展开（x86_64 的 `#define AMD64` 等），最终 .gch ~100MB。

③ **Counterfactual**: 如果不用预编译头 → 每个 .cpp 解析 50KB 头文件 × ~800 个 .cpp = 40MB 文本需要解析。编译器需要 parse + semantic + template instantiation 为每个 .cpp 重复做，编译时间 × 5-15 倍（取决于并行度）。但如果 .gch 失效（precompiled.hpp 被修改但 .gch 未重建 → make 不自愈），所有 .cpp 都会报"header mismatch"错误——需要手动 `make clean`。

④ 预编译头失效的检测：`ls -l build/*/hotspot/variant-server/libjvm/precompiled/*.gch` 和 `ls -l src/hotspot/share/precompiled/precompiled.hpp`——如果 .gch 的时间戳比 .hpp 旧，说明失效。

---

## §五 Article Structure

```
# 3.2 HotSpot 编译 — libjvm.so 从哪来

5.1 编译入口 — CompileLibraries.gmk → CompileJvm.gmk
5.2 BUILD_LIBJVM — SetupNativeCompilation 的 25+ 参数
5.3 JVM_FEATURES 的 5 层过滤
    5.3.1 CFLAGS 宏定义（源码内 #ifdef）
    5.3.2 SRC_DIRS 目录包含（添加源码路径）
    5.3.3 EXCLUDES 目录排除（整目录跳过）
    5.3.4 EXCLUDE_FILES 文件排除（精确文件名）
    5.3.5 EXCLUDE_PATTERNS 模式排除（子路径匹配）
5.4 22 个 ifeq 分支逐个分析
    5.4.1 compiler1/compiler2 的代码生成 vs 解释执行
    5.4.2 GC 系列：7 种 GC 的整目录排除
    5.4.3 JVMTI/JVMCI/Services：精确文件排除
    5.4.4 CDS/AOT/NMT：特殊编译依赖
    5.4.5 minimal variant 的 SIZE 优化
5.5 平台过滤：EXCLUDE_PATTERNS 的架构差异
5.6 预编译头：precompiled.hpp.gch 的 100MB 秘密
5.7 mapfile 符号导出：JVM_* 前缀约定
5.8 JVM_VARIANTS 多编译：同一源码 → 多个 libjvm.so
5.9 增量编译验证
```

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| JVM_FEATURES 是一个变量列表 | 展示 JvmFeatures.gmk 中 JVM_FEATURES → 5 层过滤的完整映射逻辑：每个 feature 的 CFLAGS（-DCOMPILER2）、SRC_DIRS（gensrc/adfiles）、EXCLUDES（opto libadt）、EXCLUDE_FILES（bcEscapeAnalyzer.cpp）、EXCLUDE_PATTERNS（c2_）。以 compiler2 为例（JvmFeatures.gmk:38-45）逐行解释为什么需要 5 种不同粒度的控制 |
| g1gc 关闭时排除 gc/g1 目录 | 解释 JVM_EXCLUDE_PATTERNS = gc/g1 的实现方式：SetupNativeCompilation 的 SRC 遍历会检查每个文件名是否匹配——匹配的方式是 $(filter %gc/g1%, files)，不是精确路径比较。展示整目录排除 vs 文件排除的性能差异：目录排除只需 1 次模式匹配，文件排除需要 N 次精确字符串比较 |
| JVMTI 不编译时排除 17 个 .cpp | 展示 JvmFeatures.gmk:71-78 的完整排除列表。解释为什么 JVMTI 用精确文件排除而 JVMCI 用整目录排除——JVMTI 代码散布在 prims/runtime/services 等多个目录，不能整目录排除。对比 CDS 的 11 个文件排除——CDS 也散布但文件数可控 |
| 预编译头加速编译 | 解释 GCC 预编译头机制：首次编译 precompiled.hpp 生成 .gch（100MB AST），后续 .cpp 的 #include 自动跳过解析（~3s vs ~45s per file）。解释 .gch 失效的诅咒：修改 precompiled.hpp 或其中的任何头文件后 .gch 需要重建但 make 不自愈 |
| mapfile 控制符号导出 | 展示 mapfile 的实际内容格式：{ global: JVM_*; jio_*; local: *; }。解释 "只导出 JVM_* 前缀" 的设计理由——强制外部通过 JNI 接口而非内部 C++ 类交互 |
| minimal variant 较小 | 解释 minimal 变体的 SIZE 优化策略：绝大多数 .cpp 用 -Os 编译，OPT_SPEED_SRC 列表的 50 个文件用 -O3。展示 per-file 优化覆盖的宏机制：$(eval BUILD_LIBJVM_xxx.cpp_OPTIMIZATION := HIGHEST_JVM) |
| EXCLUDE_PATTERNS 过滤 x86_32 文件 | 展示 CompileJvm.gmk:105-108 的平台过滤链：linux-x86 → exclude x86_64 / linux-x86_64 → exclude x86_32。解释什么是 `ifeq ($(OPENJDK_TARGET_CPU), x86_64)` 的 multi-way branch——如果直接匹配 CPU 名而非文件模式，需要 N 套手工文件列表 |

## §七 Output Format

书籍章节格式：
- 标题：`# 3.2 HotSpot 编译 — libjvm.so 从哪来`
- 原理驱动，源码引用 `JvmFeatures.gmk:line` 作证据
- Mermaid 流程图：JVM_FEATURES → 5 层过滤 → g++ 编译 → libjvm.so 链接
- 每节末尾有关键要点

## §八 Prohibited（≥10 条）

1. 不要写成 g++ 编译教程——读者不需要知道 -c -o -shared 的语法
2. 不要跳过 check-jvm-feature 函数的实现——它是理解所有 ifeq 分支的钥匙
3. 不要忽略 5 层过滤的设计层次——CFLAGS/SRC_DIRS/EXCLUDES/EXCLUDE_FILES/PATTERNS 各有特定用途
4. 不要只列 feature 名称而不说明它控制哪些文件——必须列出被排除的文件列表
5. 不要跳过 GC feature 的特殊处理（serialgc 排除 psMarkSweep 的级联效应）
6. 不要忽略预编译头 .gch 的失效问题——这是实际开发中的高频问题
7. 不要遗漏 mapfile 符号导出的设计原因和内容格式
8. 不要遗漏 minimal variant 的 SIZE 优化——per-file 优化级别的机制
9. 不要忽略 EXCLUDE_PATTERNS 的平台特定过滤（x86_64 vs arm 的排除差异）
10. 不要遗漏多 variant 编译的产物隔离机制

## §九 Required（≥10 条）

1. 必须有 check-jvm-feature 宏的实现源码和调用位置
2. 必须有 5 层过滤的完整说明（CFLAGS/SRC_DIRS/EXCLUDES/EXCLUDE_FILES/PATTERNS）
3. 必须有 JVM_FEATURES 22 个 ifeq 分支的映射表——feature → 过滤类型 → 具体内容
4. 必须有 compiler2 关闭时的完整过滤效果——排除哪些目录、哪些文件、哪些模式
5. 必须有 JVMTI 关闭时的 17 个精确文件排除列表及其散布目录
6. 必须有 GC 系列 feature 的整目录排除对照表
7. 必须有预编译头的完整工作流程图
8. 必须有 mapfile 的内容示例和符号导出策略
9. 必须有 minimal variant 的 per-file 优化表
10. 必须有 EXCLUDE_PATTERNS 的平台特定过滤对照表（x86_64 vs arm vs aarch64）
11. 必须有增量编译验证方法

## §十 Verification（≥8 assertions）

1. `make hotspot-server-libs 2>&1 | grep "Compiling.*g1SATB"` — 验证 G1 文件编译
2. `find build/*/hotspot/variant-server/libjvm/objs -name "*.o" | wc -l` — 计数 .o 文件
3. `nm -D build/*/hotspot/variant-server/libjvm/libjvm.so | grep "JVM_" | wc -l` — 验证符号导出
4. `nm build/*/hotspot/variant-server/libjvm/libjvm.so | grep "ObjectMonitor"` — 验证内部符号不导出
5. `grep JVM_FEATURES build/*/spec.gmk` — 验证当前 feature 配置
6. `touch src/hotspot/share/runtime/thread.cpp && time make hotspot-server-libs -j8 2>&1 | tail -10` — 验证增量编译速度
7. `ls -la build/*/hotspot/variant-server/libjvm/precompiled/*.gch` — 验证预编译头存在
8. `make hotspot-server-libs JVM_VARIANT=minimal 2>&1 | head -20` — 验证 minimal 变体
9. `gcc -E -dM - < /dev/null | grep INCLUDE` — 验证宏定义（只看 compilation environment）

## §十一 与 README 和同组 prompt 的连续性

- **前接 prompt-01（Main.gmk 管线）**: 01 展示了 `hotspot-server-libs` target 的定义；02 深入分析 CompileJvm.gmk + JvmFeatures.gmk 的条件编译逻辑
- **后接 prompt-03（镜像组装）**: 02 生成了 libjvm.so；03 展示它如何被放入 JDK 镜像
- **后接 prompt-04（裁剪实战）**: 02 解释了 JVM_FEATURES 的 5 层过滤机制；04 展示如何利用这些机制实现裁剪
