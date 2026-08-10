# prompt-01: Main.gmk — 构建管线

## §〇 Production Scenario

你改了 `src/hotspot/share/runtime/thread.cpp` 一行代码，执行 `make jdk-image`。Main.gmk 如何决定只重编译受影响的 .o 并重新链接 libjvm.so，而不是全量编译？

三个真实故障场景：

1. **增量编译失败→全量重编**：改了 `thread.hpp` 但 make 没检测到依赖变化，libjvm.so 链接了旧 .o → 运行时行为与源码不一致。根因：依赖追踪丢失。诊断：`make --debug=b jdk-image 2>&1 | grep "Prerequisite.*newer"`
2. **"SPEC not found"**：直接执行 `make` 而非 `make jdk-image`，Main.gmk:34-36 立即报错。诊断：检查 `build/*/spec.gmk` 是否存在、configure 是否成功
3. **并行构建死锁**：`make -j16 jdk-image` 时 `java.base-libs` 等待 `java.base-gensrc` 完成，但后者被 `make -j16` 的 job server 排到队列末尾——表象是卡在 99%。诊断：`make -j1` 单线程验证是否真的存在循环依赖

## §一 Task + Narrative + Beginner Callouts

**任务**：分析 Main.gmk 的主构建管线——`make jdk-image` 经过哪些 target、各 target 的输入输出、中间产物路径、增量编译的判断逻辑。

**叙事线索**：从 `make jdk-image` 命令开始，跟踪 Main.gmk 的 target 依赖图，展示 7 个核心构建阶段的完整执行路径。

**7 个 Beginner Callout**（嵌在 §一 各小节中）：

> **Callout 1 — SPEC 文件的角色**：`Main.gmk:34-39` 严格校验 SPEC 文件存在性。`SPEC` 变量来自顶层 `Makefile:33` 的自动检测逻辑——先找 `build/$CONF/spec.gmk`，找不到就用 `build/spec.gmk`。SPEC 不是一个文件，而是一个 `include` 进来的变量集合——它定义了 ALL_MODULES、JVM_FEATURES_server、OPENJDK_TARGET_OS、CFLAGS_JDKLIB 等数百个变量。

> **Callout 2 — Make 入口链路**：用户输入 `make jdk-image` 的实际执行链：顶层 `Makefile`（自动检测 SPEC → include spec.gmk → include Main.gmk）→ Main.gmk 找到 `jdk-image` target 的定义 → 展开依赖链 → 执行 recipes。顶层 `Makefile` 的存在使得用户无需关心 SPEC 路径——自动检测逻辑处理了 `build/linux-x86_64-normal-server-slowdebug/spec.gmk` 的完整路径。

> **Callout 3 — DeclareRecipesForPhase 宏的批量生成**：`Main.gmk:112-117` 的 5 个参数：`TARGET_SUFFIX := gensrc-src` 控制 target 命名（`java.base-gensrc-src`），`FILE_PREFIX := Gensrc` 控制调用的子 Makefile（`gensrc/Gensrc-java.base.gmk`），`MAKE_SUBDIR := gensrc` 控制子 make 的工作目录，`CHECK_MODULES := $(ALL_MODULES)` 指定对哪些模块生成 target。这个宏一次性为 60+ 个模块生成 target——如果手写，Main.gmk 会从 1,400 行膨胀到 10,000 行。

> **Callout 4 — 构建阶段的顺序约束**：`GENSRC → GENDATA → COPY → JAVA → LIBS → LAUNCHER → IMAGE` 这个顺序不是随意的。GENSRC 必须在 JAVA 之前（javac 需要生成的源码），GENDATA 必须在 JAVA 之前（时区/字符映射数据文件），LIBS 和 JAVA 可以并行（两者互不依赖），IMAGE 必须在所有 LIBS+JAVA+LAUNCHER 完成后（需要全部 .so 和 .class）。

> **Callout 5 — ALL_MODULES 的动态计算**：`Main.gmk:57` 的 `ALL_MODULES := $(call FindAllModules)` 调用 `make/common/Modules.gmk` 的检测逻辑——遍历 `src/` 下的所有模块目录，过滤 `--disable-module` 排除的模块，最终生成模块列表。`--disable-module=java.desktop` 后，`java.desktop-*` 的 200+ 个 target 全部消失——不影响构建系统的结构，只影响 ALL_MODULES 的内容。

> **Callout 6 — HotSpot 与 JDK 类库是两条独立管线**：`Main.gmk:253-278` 的 `hotspot-server-gensrc` 和 `hotspot-server-libs` 通过 `make/hotspot/gensrc/GenerateSources.gmk` 和 `make/hotspot/lib/CompileLibraries.gmk` 独立执行——与 JDK 类库的 `CompileJavaModules.gmk` 完全无关。两条管线在 `IMAGE` 阶段通过 `Images.gmk` 汇合——libjvm.so 和 .class 文件一起被 jlink 打包。

> **Callout 7 — exploded image 与 images/jdk 的区别**：`build/*/jdk/`（exploded image）是直接可运行的展开目录——修改一个 .so 后替换 `jdk/lib/server/libjvm.so` 即可运行新版本（增量开发的核心）。`build/*/images/jdk/` 是 jlink 打包的精简镜像——bin/java 启动时只加载用到的模块，去掉未引用的类（适合分发）。两者的桥梁是 `jlink` 工具：`exploaded image → jlink --add-modules=... → images/jdk`。

---

## §二 Standard Environment

### Source Roots (file:line)
```
make/Main.gmk                       — 主构建管线, 目标定义和依赖 (~1,400 lines)
make/MainSupport.gmk                — DeclareRecipesForPhase 等辅助宏 (~100 lines)
make/common/MakeBase.gmk            — 基础 Make 函数, 日志和错误处理 (~300 lines)
make/common/Modules.gmk             — 模块检测, FindAllModules (~100 lines)
make/common/FindTests.gmk           — 测试发现 (~100 lines)
make/CompileJavaModules.gmk         — Java 类库编译 (~200 lines)
make/hotspot/lib/CompileLibraries.gmk  — HotSpot .so 编译入口 (~200 lines)
make/hotspot/gensrc/GenerateSources.gmk — HotSpot 源码生成 (~200 lines)
build/linux-x86_64-normal-server-slowdebug/spec.gmk  — configure 生成的配置
```

### Build Commands
```bash
bash configure --with-jvm-variants=server --with-debug-level=slowdebug

# 构建目标
make jdk-image           # 构建 JDK 镜像 (最常用)
make images              # 构建全部镜像（JDK + JRE + 静态库 + symbols）
make exploded-image      # 构建 exploded image (增量开发推荐)

# 增量/子目标
make hotspot-server-libs # 仅重编译 HotSpot 库
make java.base-libs      # 仅重编译 java.base 的 native 库
make java.base            # 编译 java.base 模块（Java 代码）

# 调试构建
make --debug=b jdk-image 2>&1 | head -100  # 追踪依赖重新评估
make -n jdk-image 2>&1 | head -50          # dry-run 查看将执行什么
make -j1 jdk-image                          # 单线程排查循环依赖
```

### Binary Paths
```
build/linux-x86_64-normal-server-slowdebug/
├── jdk/                          # exploded image (开发用)
├── images/jdk/                   # 打包的 JDK 镜像 (分发用)
├── hotspot/variant-server/libjvm/objs/  # HotSpot .o 中间文件
├── hotspot/variant-server/libjvm/libjvm.so  # 编译产物
├── support/                      # 构建辅助文件 (failure-logs, etc.)
└── make-support/                 # Main.gmk 内部辅助
```

### Syscall 速查表
本文涉及构建阶段的执行模型（GNU Make 进程树、文件系统 I/O），不涉及直接的 syscall。

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| Main.gmk | make/Main.gmk | ~1,400 | DeclareRecipesForPhase, ALL_TARGETS, hotspot-*-libs | 主构建管线 |
| MainSupport.gmk | make/MainSupport.gmk | ~100 | DeclareRecipesForPhase 宏定义 | 批量 target 生成 |
| MakeBase.gmk | make/common/MakeBase.gmk | ~300 | LogInfo, SetupLogging, ExecuteWithLog | 基础工具 |
| Modules.gmk | make/common/Modules.gmk | ~100 | FindAllModules, FindTestModules | 模块检测 |
| CompileJavaModules.gmk | make/CompileJavaModules.gmk | ~200 | SetupJavaCompilation per module | Java 类库编译 |
| CompileLibraries.gmk | make/hotspot/lib/CompileLibraries.gmk | ~200 | BUILD_HOTSPOT_LIBS, include CompileJvm.gmk | HotSpot .so 入口 |
| GenerateSources.gmk | make/hotspot/gensrc/GenerateSources.gmk | ~200 | 生成 JVMTI/JFR/JVMCI 的 .cpp | HotSpot 源码生成 |
| Images.gmk | make/Images.gmk | ~400 | jmod_create, jlink, JRE image | 镜像组装 |

---

## §四 Deep Dive Question Groups (≥8 组，每组含 counterfactual)

### 4.1 SPEC 文件：configure 到 Main.gmk 的桥梁

① `Main.gmk:34-39` 的 SPEC 校验逻辑：`ifeq ($(wildcard $(SPEC)),)` 检测 SPEC 变量指向的文件是否存在。如果不存在，`$(error ...)` 立即中止 make。`SPEC` 变量来自顶层 `Makefile:33` 的自动检测——`build/$CONF_NAME/spec.gmk` 或 `build/spec.gmk`。

② **Counterfactual**: 如果不用 SPEC 文件，把配置变量全部放在 Make 命令行参数中？→ 不可行：configure 检测了数百个变量（编译器和库的路径、CFLAGS、DEBUG_LEVEL、JVM_FEATURES 的全排列展开）。命令行传递无法承载这些复杂状态，且每次 make 都需要重新指定——增量构建时的环境变量可能丢失。

③ SPEC 文件中的关键变量列表（影响 Main.gmk 行为）：`JVM_VARIANTS`（如 server）、`JVM_FEATURES_server`（如 compiler1 compiler2 g1gc jfr）、`DEBUG_LEVEL`（slowdebug）、`COMPILER_TYPE`（gcc/clang）、`JDK_MODULES`（所有 Java 模块）、`HOTSPOT_MODULES`（HotSpot 相关模块）、`OPENJDK_TARGET_OS`（linux）、`OPENJDK_TARGET_CPU`（x86_64）、`CFLAGS_JDKLIB`（编译标志）、`LDFLAGS_JDKLIB`（链接标志）。

④ 如果 configure 没有运行但 `spec.gmk` 还在（上次构建残留）→ Main.gmk 会继续使用旧的 SPEC——增量构建不受影响，但新的 configure 选项不会生效。解决方案：先 `make reconfigure` 或 `rm build/*/spec.gmk && bash configure`。

### 4.2 DeclareRecipesForPhase 宏：60+ 模块 target 的一键生成

① `Main.gmk:112-117` 的 `DeclareRecipesForPhase(GENSRC, TARGET_SUFFIX := gensrc-src, FILE_PREFIX := Gensrc, MAKE_SUBDIR := gensrc, CHECK_MODULES := $(ALL_MODULES))` 内部逻辑：遍历 `CHECK_MODULES` 列表，对每个模块 `$m` 生成 target `$m-$TARGET_SUFFIX`（如 `java.base-gensrc-src`），recipe 为 `cd make/$MAKE_SUBDIR && make -f $FILE_PREFIX-$m.gmk`（如 `cd make/gensrc && make -f Gensrc-java.base.gmk`）。

② 同一宏被调用 5 次——`GENSRC`（调用 `Gensrc-*.gmk`）、`GENDATA`（调用 `Gendata-*.gmk`）、`COPY`（调用 `Copy-*.gmk`）、`JAVA`（调用 `CompileJavaModules-*.gmk`）、`LIBS`（调用 `Lib-*.gmk`）、`LAUNCHER`（调用 `Launcher-*.gmk`）。每个 phase 有各自的 target suffix 和 make 子目录。

③ **Counterfactual**: 如果不用宏，手写 60+ 模块 × 6 phases = 360 个 target？→ 手工维护必然产生遗漏和不一致——新模块（如 `jdk.incubator.vector`）需要手动添加到 6 个不同的位置，极易漏掉某个 phase 的 target。

④ 宏的 `CHECK_MODULES` 参数使用 `$(wildcard $(TOPDIR)/make/$MAKE_SUBDIR/$FILE_PREFIX-$m.gmk)` 过滤——只有对应文件存在的模块才会生成 target。这防止了"target 存在但对应的 .gmk 不存在"导致的空 make。

### 4.3 HotSpot 编译管线：gensrc → libs 双阶段

① `Main.gmk:253-278` 为每个 JVM_VARIANT 生成 `hotspot-$1-gensrc` 和 `hotspot-$1-libs` target。`hotspot-$1-gensrc`（`:258-262`）调用 `make/hotspot/gensrc/GenerateSources.gmk`（生成 JVMTI/JFR/JVMCI 的模板 .cpp），`hotspot-$1-libs`（`:267-270`）调用 `make/hotspot/lib/CompileLibraries.gmk`（编译 .cpp → .o → .so）。

② `JVM_VARIANT` 变量从 make 命令行传入（`CompileJvm.gmk:2` 的注释：`# This file is called with JVM_VARIANT set to the variant to build`）。如 `make hotspot-server-libs` 时 `JVM_VARIANT=server`。

③ **Counterfactual**: 如果 HotSpot 编译逻辑直接放在 Main.gmk 中而非独立文件 → 编译逻辑太复杂（JVM_FEATURES 条件编译 22 项 × 平台过滤 3 种 × 预编译头 × dtrace 探测 × mapfile 生成），会导致 Main.gmk 从 1,400 行膨胀到 5,000+ 行，难以维护。

④ 编译产物隔离：`hotspot-server-libs → build/*/hotspot/variant-server/libjvm/`，`hotspot-minimal-libs → build/*/hotspot/variant-minimal/libjvm/`。多变体并行编译时产物互不干扰。

### 4.4 7 个构建阶段的全链路和并行策略

① 完整管线：`buildtools → GENSRC → GENDATA → COPY → JAVA ‖ LIBS ‖ LAUNCHER → IMAGE`。`‖` 表示可并行。
- `buildtools`（Main.gmk:72-91）：编译构建工具（langtools/jdk/hotspot 工具链）
- `GENSRC`（`:112-135`）：生成 Java 和 C++ 源码（JFR metadata、JMX beans、模块信息）
- `GENDATA`（`:150-202`）：生成数据文件（时区、字符映射、货币）
- `COPY`（`:204-236`）：复制资源文件（配置文件、字体、安全策略）
- `JAVA`（`:238-260`）：编译 Java 源码为 .class（per-module）
- `LIBS`（`:262-290`）：编译 .cpp 为 .so（per-module native 库）
- `LAUNCHER`（`:292-310`）：编译 java/javac 等启动器
- `IMAGE`（`:312-410`）：jmod → jlink → 最终镜像

② 为什么 `GENSRC→GENDATA→COPY` 必须串行？GENSRC 生成的 Java 源码是 GENDATA 的部分输入（如 `java.base` 的 module-info 类），GENDATA 的数据文件是 COPY 的源（如复制的配置文件名称依赖 GENDATA 列表）。依赖链是功能性的，不是性能选择。

③ 为什么 LIBS 和 JAVA 可以并行？它们完全独立：JAVA 用 javac 编译，LIBS 用 g++ 编译，两者不共享源文件也不共享中间产物。并行加速比 ≈ min(core_count, |modules|)。

④ **Counterfactual**: 如果所有阶段串行 → 8 核编译时间从 ~20 分钟膨胀到 ~80 分钟。如果过度并行（抹掉串行约束）→ GENSRC 未完成时 JAVA 启动编译，javac 找不到生成的源文件，报错。

### 4.5 exploded image vs images/jdk——开发用 vs 分发用

① `build/*/jdk/`（exploded image）= 运行时的目录树直接展开在文件系统上，未经过 jlink 精简化。`build/*/images/jdk/` = jlink 从 exploded image 中提取依赖模块的精简镜像。

② exploded image 的增量开发优势：修改 `thread.cpp` → `make hotspot-server-libs` 只编译一个 .o 并重新链接 libjvm.so → 产物直接覆盖 `build/*/jdk/lib/server/libjvm.so` → `build/*/jdk/bin/java -version` 直接验证（0 次文件复制，3 秒完成）。

③ **Counterfactual**: 如果每次修改都走完整 jmod + jlink 打包 → 增量编译从 3 秒变成 30 秒（jlink 需要扫描所有模块的依赖图 × 重新打包所有 .jmod），开发体验严重下降。

④ `make jdk-image` 依赖 `make exploded-image`——先构建 exploded image，再 jlink 打包。这意味着 exploded image 是 images/jdk 的必须前置步骤——即使不需要 exploded image，它也会被构建。

### 4.6 增量编译——make 的依赖追踪和传播

① make 如何检测需要重编：compiler 生成 `.d` 文件（`-MMD -MF $@.d`），记录每个 .o 依赖的 .cpp 和所有 include 的 .hpp。make 比较每个 .o 和其依赖的时间戳——如果任何依赖比 .o 新，重新编译。

② 修改 `thread.cpp` 的传播链：`thread.cpp → thread.o（重编）→ libjvm.so（重新链接，因为有 .o 变化）→ build/*/jdk/lib/server/libjvm.so（替换）`。不需要重新编译其他 .cpp（它们的依赖未变），不需要重新链接其他 .so（它们不依赖 thread.o）。

③ **Counterfactual**: 如果不用 make 的自动依赖追踪（`-MMD`），用脚本手动比较时间戳 → 不可靠：头文件修改（如 `thread.hpp` 包含的新头文件）需要手动维护"谁包含了谁"的全量映射——遗漏就会导致 .o 不重编 → 链接到旧代码 → 运行时 bug。

④ 全量重编的判断：`make jdk-image` 不带参数时，make 会检查所有 target 的依赖——如果 dependencies 全部 up-to-date，make 输出 `Nothing to be done for 'jdk-image'`（完全跳过，0 秒）。这是 make 的标准行为，不是 Main.gmk 的特殊逻辑。

### 4.7 并行构建——make -j8 的策略和陷阱

① make 的并行粒度是 target 级别：`make -j8 jdk-image` 时，make 会同时执行最多 8 个独立的 target recipe。对于 JDK 构建，这意味着最多 8 个模块的 GENSRC/JAVA/LIBS 可以同时编译。

② 但以下 target 必然串行（因为显式依赖）：
- `GENSRC → JAVA`（各模块内部）：`Main.gmk:119` 的 `$m-gensrc: $m-gensrc-src` 声明了 per-module 依赖
- `JAVA + LIBS → IMAGE`：IMAGE 需要所有模块的 .class 和 .so 就绪
- `buildtools → 后续所有阶段`：构建工具必须先编译完

③ **Counterfactual**: 如果 `make -j16` 在 8 核机器上 → 不会更快，因为 CPU 核数限制。但 `make -j` 不带数字会无限并行——可能导致 OOM（每个 g++ 进程约 500MB，10 个并行 = 5GB）。

④ 并行构建的常见故障——"build.log 里没有错误但编译失败"：原因是 make 的 job server 把错误输出路由到了错误的 job 的日志。解决方案：先用 `make -j1` 确认是否有真实错误，再用 `make -j8` 扩展。

### 4.8 ALL_MODULES 的动态计算和构建影响

① `Main.gmk:57` 的 `ALL_MODULES := $(call FindAllModules)` 的内部逻辑（`make/common/Modules.gmk`）：`FindAllModules = $(filter-out $(EXCLUDE_MODULES), $(shell ls $(TOPDIR)/src/ | grep -E "jdk\.|java\.|jdk\.internal\." | sort))`——遍历 `src/` 下的目录名，排除 `--disable-module` 指定的模块。开放式检测而非硬编码列表——新模块只需在 `src/` 下创建目录即可被自动发现。

② `--disable-module=java.desktop` 后的级联效果：`java.desktop-gensrc/java.desktop-gendata/java.desktop-java/java.desktop-libs/java.desktop-launcher` 5 个 phase 的 target 全部消失——ALL_MODULES 删减后，`DeclareRecipesForPhase` 不再为 java.desktop 生成 target。

③ **Counterfactual**: 如果 ALL_MODULES 是硬编码的 `JDK_MODULES = java.base java.compiler java.datatransfer ...`（约 60 模块）→ 新模块（如 `jdk.incubator.vector`）需要手动添加到硬编码列表，且 `JAVA_PHASE_MODULES` / `LIBS_MODULES` 等分组列表也需要独立维护——容易遗漏和导致不一致。

④ `HOTSPOT_MODULES` 是一个特殊子集——只有 `jdk.hotspot.agent` 和 `jdk.internal.vm.ci` 等少数几个——它们包含 HotSpot 的 Java 端代码。这些模块的 `-gensrc` target 调用 HotSpot 的源码生成器（如 JFR 的 metadata→.java），而非通用的 Gensrc-jdk.hotspot.agent.gmk。

---

## §五 Article Structure

```
# 3.1 Main.gmk 构建管线 — make jdk-image 的 7 个阶段

5.1 SPEC 文件：configure 到 Main.gmk 的桥梁 — spec.gmk 的 10 个关键变量
5.2 构建阶段全景 — 7 阶段管线 Mermaid 流程图
5.3 buildtools 阶段 — 编译构建工具链
5.4 GENSRC 阶段 — 源码生成 (DeclareRecipesForPhase 详解)
5.5 GENDATA + COPY 阶段 — 数据文件和资源复制
5.6 JAVA 阶段 — JDK 类库编译 (CompileJavaModules.gmk)
5.7 LIBS + LAUNCHER 阶段 — 原生代码编译
5.8 HotSpot 编译 — gensrc→libs 双阶段链路
5.9 IMAGE 阶段 — jmod→jlink→tar.gz
5.10 exploded image — 增量开发的核心
5.11 增量编译 — 依赖追踪和传播链
5.12 并行构建 — -j8 的策略和常见陷阱
5.13 ALL_MODULES 动态计算 — 模块系统的构建侧实现
5.14 构建失败诊断 — 看哪些日志、查哪些文件
```

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| Main.gmk 第 112 行使用了 DeclareRecipesForPhase 宏 | 展示 DeclareRecipesForPhase 的完整参数解析：TARGET_SUFFIX（如 gensrc-src）决定 target 命名，FILE_PREFIX（如 Gensrc）决定调用的子 Makefile，MAKE_SUBDIR（如 gensrc）决定 sub-make 的工作目录，CHECK_MODULES（如 $(ALL_MODULES)）控制对哪些模块生成 target。这个宏 5 次被调用为 60+ 模块 × 6 phases = 360 个 target |
| 构建阶段顺序是 GENSRC→GENDATA→COPY→JAVA→LIBS | 解释每个阶段为什么必须在当前位置：GENSRC→GENDATA→COPY 串行是功能性依赖（生成的文件是后续输入），LIBS ‖ JAVA 并行是因为两者互不依赖（javac vs g++），IMAGE 必须在最后因为需要所有 .class 和 .so 就绪才能 jlink |
| exploded image 是 build/*/jdk/ 目录 | 对比 exploded image（增量开发，3 秒增量）和 images/jdk（分发，30 秒打包）的本质区别：exploded image 用 cp 替换文件，images/jdk 用 jlink 重新扫描模块依赖图。列出 exploded image 的完整文件系统布局（bin/lib/modules/） |
| 增量编译靠 make 的 MMD 依赖 | 追踪修改 thread.cpp 的完整传播链：thread.o 重编 → libjvm.so 重新链接 → build/*/jdk/lib/server/libjvm.so 替换。不重编其他 .cpp（依赖未变），不重链其他 .so（不依赖 thread.o）。验证方法：`touch thread.cpp && make hotspot-server-libs -j8 2>&1 | grep "Compiling\|Linking"` |
| 并行构建用 make -j8 | 解释哪些阶段可并行（GENSRC 各模块 / JAVA 各模块 / LIBS 各模块可并行），哪些必须串行（GENSRC→JAVA 在单模块内串行，IMAGE 依赖所有模块完成）。并行陷阱：-j 不带数字可能 OOM，job server 可能路由错误输出 |
| HotSpot 编译是独立的 make/hotspot 子构建 | 展示 hotspot-server-libs 的完整执行路径：Main.gmk:267-270 → CompileLibraries.gmk(JVM_VARIANT=server) → CompileJvm.gmk:153 BUILD_LIBJVM → SetupNativeCompilation → g++ 编译每个 .cpp。每个 JVM_VARIANT 有独立的 gensrc 和 libs target |
| ALL_MODULES 是模块列表 | 展示 FindAllModules 的动态检测原理：遍历 src/ 目录 → 匹配模块命名模式 → 排除 --disable-module 指定的模块。解释 --disable-module=java.desktop 后哪些 target 消失——java.desktop 的 5 个 phase × 60+ 子 target 全部消失 |
| SPEC 文件包含配置 | 列出 SPEC 中影响 Main.gmk 的 10 个关键变量的名称、类型、来源（configure 的哪个宏设置的）和影响范围（哪个 phase 使用它） |

## §七 Output Format

书籍章节格式：
- 标题：`# 3.1 Main.gmk 构建管线 — make jdk-image 的 7 个阶段`
- 原理驱动，源码引用 `Main.gmk:line` 作证据
- Mermaid flowchart 展示 5 阶段构建管线 + 各个阶段的并行/串行关系
- 关键概念用 `> **概念名** — 解释` blockquote

## §八 Prohibited（≥10 条）

1. 不要写成 GNU Make 语法教程——读者已经知道 make 的基本用法
2. 不要逐行翻译 Main.gmk——提取关键宏和设计意图
3. 不要忽略 SPEC 文件的作用——Main.gmk:34-39 的 SPEC 校验是理解整个管线的入口
4. 不要忽略 DeclareRecipesForPhase 的参数解析——这个宏是理解批量 target 生成的关键
5. 不要忽略增量编译机制——这是开发者日常最重要的性能优化
6. 不要混淆 exploded image 和 images/jdk——两者的用途和构建方式完全不同
7. 不要遗漏 HotSpot 编译与 JDK 类库编译的独立性和交汇点
8. 不要遗漏 ALL_MODULES 的动态计算——这是模块系统在构建侧的体现
9. 不要遗漏并行构建的策略和陷阱——make -j 的常见问题
10. 不要忽略构建失败的诊断方法——失败时应该看哪些日志/文件

## §九 Required（≥10 条）

1. 必须有 SPEC 文件的 10 个关键变量表（名称、类型、来源、影响范围）
2. 必须有 Mermaid 流程图展示 7 个构建阶段 + 并行/串行关系
3. 必须有 DeclareRecipesForPhase 宏的 5 参数解析表
4. 必须追踪 hotspot-server-libs 的完整执行路径（Main.gmk → CompileLibraries.gmk → CompileJvm.gmk）
5. 必须有 exploded image（开发用）vs images/jdk（分发用）的对比表
6. 必须有增量编译的完整传播链（thread.cpp → thread.o → libjvm.so）
7. 必须有并行构建的策略说明（哪些可并行、哪些串行、-j 的风险）
8. 必须有 ALL_MODULES 的动态计算源码和 --disable-module 的影响
9. 必须有构建失败的诊断步骤（看哪些日志、检查什么文件）
10. 必须有 Main.gmk 的核心 target 依赖图（从 jdk-image 向下追溯）

## §十 Verification（≥8 assertions）

1. `make -n jdk-image 2>&1 | head -50` — dry-run 查看会执行哪些命令，验证 target 依赖链
2. `grep -n "JVM_FEATURES" build/*/spec.gmk` — 验证 configure 生成的 JVM 特性列表
3. `ls build/*/jdk/lib/server/libjvm.so` — 验证 libjvm.so 已生成
4. `file build/*/jdk/lib/server/libjvm.so` — 验证是 debug/release 版本
5. `build/*/jdk/bin/java -Xlog:gc -version` — 验证 JDK 镜像可运行
6. `build/*/jdk/bin/java --list-modules` — 验证 JDK 模块列表
7. `touch src/hotspot/share/runtime/thread.cpp && make -n hotspot-server-libs 2>&1 | grep "Compiling\|Linking" | head -5` — 验证增量编译只重编译 thread.o 和重新链接 libjvm.so
8. `make --debug=b jdk-image 2>&1 | grep "Must remake\|Successfully remade" | head -30` — 追踪增量编译的依赖重新评估
9. `grep "JVM_SRC_DIRS" build/*/spec.gmk` — 验证 JVM 源码目录由 configure 决定

## §十一 与 README 和同组 prompt 的连续性

- **前接 prompt-00（configure）**: 00 分析了 SPEC 文件是如何生成的（autoconf 宏展开 → spec.gmk）；01 分析 SPEC 如何被 Main.gmk 消费（include → 驱动 7 个构建阶段）
- **后接 prompt-02（HotSpot 编译）**: 01 展示了 `hotspot-server-libs` target 的定义（Main.gmk:267-270）；02 深入分析 CompileJvm.gmk 的条件编译逻辑（JVM_FEATURES 如何控制 22 个源目录的编译）
- **后接 prompt-03（镜像组装）**: 01 提到了 LIBS+JAVA 完成后进入 IMAGE 阶段；03 深入分析 Images.gmk 的 jmod/jlink 流程（exploded image → images/jdk）
- **后接 prompt-04（裁剪实战）**: 01 解释了 ALL_MODULES 和 JVM_VARIANTS 如何影响 target 生成；04 展示如何用 --disable-module 和 --with-jvm-features 实现最小化构建
