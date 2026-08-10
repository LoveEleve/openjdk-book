# Prompt 00 — configure 系统：从参数到 Makefile

## §〇 Production Scenario

写一个真实场景：

你在 GitHub 上 clone 了 OpenJDK 源代码，输入 `./configure`。终端滚动了 3 分钟，最后输出 `Configuration summary`。这 3 分钟里发生了什么？

三个故障场景锚定本文价值：
1. **"Unknown JVM features specified"** — 你输入 `--with-jvm-features=foo`，configure 报错。怎么知道哪些 feature 是合法的？
2. **"Specified JVM feature 'jvmti' requires feature 'services'"** — 你用 `--with-jvm-features=-services,jvmti` 想关掉 services 但保留 jvmti，configure 拒绝。依赖关系是什么？
3. **构建产物路径之谜** — `build/linux-x86_64-normal-server-slowdebug/` 这个目录名从哪来的？哪些参数影响了它？

每个场景配三步诊断：`grep` 对应的 `.m4` 文件 → 理解校验逻辑 → 修正参数。

---

## §一 Task + Narrative + Beginner Callouts

### Task
分析 OpenJDK configure 系统的完整检测链：从 `./configure` 命令到 `spec.gmk` 产物的全过程。覆盖 autoconf 框架、JVM 特性校验、JVM 变体展开、平台检测、编译器检测。

### Narrative
"执行 `./configure` 时到底发生了什么？"

跟随 configure 的执行顺序叙事：shell 层参数解析 → autoconf 宏展开 → platform.m4 的平台检测 → hotspot.m4 的 JVM 特性校验 → 最终 spec.gmk 文件生成。

### 7 个 Beginner Callout（嵌在 §一 各小节）

> **Callout 1 — 什么是 autoconf？** 不是一个特殊程序，而是一个将 `configure.ac` + `.m4` 宏文件展开成 `configure` shell 脚本的工具链。OpenJDK 的 `make/autoconf/configure` 就是预先展开好的成品 (~357 行顶部逻辑 + 大量 m4 展开后的正文)。

> **Callout 2 — 什么是 .m4 文件？** M4 是一种宏语言。autoconf 用它定义可复用的检测逻辑。例如 `hotspot.m4:46` 的 `AC_DEFUN([HOTSPOT_CHECK_JVM_VARIANT], ...)` 定义了一个可在 configure 中多次调用的检查函数。

> **Callout 3 — OpenJDK 构建目录命名规则** — `build/linux-x86_64-normal-server-slowdebug/` 的四个段：`$OS-$CPU` (来自 platform.m4) + `normal` (来自 debug level) + `$JVM_VARIANTS` (来自 hotspot.m4:104 的 AND 拼接) + `$DEBUG_LEVEL`。

> **Callout 4 — `--with-jvm-features` 的 +foo/-foo 语法** — `hotspot.m4:305-307`：前缀 `-name` 表示 disable，无前缀 `name` 表示 enable。`JVM_FEATURES` 变量收集 enable 项，`DISABLED_JVM_FEATURES` 收集 disable 项。注意：`--with-jvm-features` 是追加到 variant 默认值之上，不是替换！

> **Callout 5 — JVM variant 的特征依赖关系** — `hotspot.m4:338-352`：四个硬性依赖链。jvmti→services, management→nmt, jvmci→compiler1|compiler2, cmsgc→serialgc。关掉前置 feature 会导致依赖它的 feature 也被关掉或被 configure 报错。

> **Callout 6 — `NON_MINIMAL_FEATURES` 设计模式** — `hotspot.m4:520`：所有共享 feature 定义在一个变量里，然后 `JVM_FEATURES_server/client/core/minimal/zero/custom` 各自添加 variant 专属 feature。这是"模板方法"模式在 shell 中的实现。

> **Callout 7 — configure 的输出产物清单** — 不只是打印 `Configuration summary`。实际上生成了 `build/linux-x86_64-normal-server-slowdebug/spec.gmk`（所有 `AC_SUBST` 变量的键值对）、`make-support/` 辅助文件、`configure-support/` 检测日志。

---

## §二 Standard Environment

### Source Roots
```
make/autoconf/configure        — 预生成的 configure shell 脚本
make/autoconf/hotspot.m4       — JVM 特性与变体检测 (658 lines)
make/autoconf/platform.m4      — 平台检测 (600+ lines)
make/autoconf/toolchain.m4     — 编译器检测 (1200+ lines)
make/autoconf/buildjdk-spec.gmk.in — spec.gmk 模板
```

### Build Command
```bash
# 默认构建
bash configure

# 自定义构建
bash configure \
  --with-jvm-variants=server \
  --with-jvm-features=compiler1,compiler2,g1gc,jfr \
  --with-debug-level=slowdebug \
  --with-boot-jdk=/path/to/jdk-11

# configure 帮助
bash configure --help | grep -i jvm
```

### Binary Paths
- configure 脚本: `make/autoconf/configure`
- 产物 spec.gmk: `build/$CONF_NAME/spec.gmk`
- configure 日志: `build/$CONF_NAME/configure.log`

### Syscall 速查表
本文涉及 configure 执行的 shell 级别操作（文件检测、字符串匹配、编译测试），不涉及直接 syscall。

---

## §三 Source Files Table

| File | Full Path | Lines | Core Functions | Role |
|------|-----------|:-----:|----------------|------|
| hotspot.m4 | make/autoconf/hotspot.m4 | 658 | `VALID_JVM_FEATURES`, `HOTSPOT_SETUP_JVM_VARIANTS`, `HOTSPOT_SETUP_JVM_FEATURES`, `HOTSPOT_FINALIZE_JVM_FEATURES` | JVM 特性检测核心 |
| platform.m4 | make/autoconf/platform.m4 | 600+ | `PLATFORM_EXTRACT_VARS_FROM_CPU`, `PLATFORM_SETUP_OPENJDK_TARGET_BITS` | 平台检测 |
| toolchain.m4 | make/autoconf/toolchain.m4 | 1200+ | 编译器检测、CFLAGS 设置 | 编译工具链 |
| buildjdk-spec.gmk.in | make/autoconf/buildjdk-spec.gmk.in | ~100 | spec.gmk 模板 | 产物模板 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 `VALID_JVM_FEATURES` 22 项列表从何而来？

① `hotspot.m4:27-29` 中的 22 项字符串是如何被校验的？`BASIC_GET_NON_MATCHING_VALUES` (`hotspot.m4:310`) 的 shell 实现原理是什么？

② **Counterfactual**: 如果不用集中定义的 `VALID_JVM_FEATURES` 白名单，而是每个 `.gmk` 文件各自检查 feature 是否可用？编译到一半才发现"feature X 需要文件 Y 但 Y 不存在"���—configure 阶段集中校验的设计理由是什么？

### 4.2 `HOTSPOT_SETUP_JVM_VARIANTS` 的变体展开

① `hotspot.m4:84-151`：`--with-jvm-variants` 参数如何从逗号分隔字符串展开为 `server`, `client`, `minimal`, `core`, `zero`, `custom`？当用户指定多 variant（如 `server,client`）时 `JVM_VARIANT_MAIN` (`hotspot.m4:129-139`) 如何选择主 variant？

② **Counterfactual**: 如果去掉 `JVM_VARIANT_MAIN` 概念，所有 variant 平等对待？那其他 .so（如 libjava.so）链接时——找不到唯一 libjvm.so 来解析符号。

### 4.3 `--with-jvm-features` 的追加语义

① `hotspot.m4:298-326`：用户指定的 feature 是**追加**到 variant 默认值之上（不是替换）。`JVM_FEATURES` vs `DISABLED_JVM_FEATURES` vs variant 默认值的三者如何合并？`HOTSPOT_FINALIZE_JVM_FEATURES` (`hotspot.m4:563-592`) 的最终过滤逻辑是什么？

② **Counterfactual**: 如果 `--with-jvm-features` 是替换而非追加？用户需要显式列出 variant 的所有默认 feature——每次升级都要更新命令行，极易遗漏。

### 4.4 Feature 依赖关系链

① `hotspot.m4:338-352`：四条硬性依赖链（jvmti→services, management→nmt, jvmci→compiler, cmsgc→serialgc）。为什么这些依赖必须在 configure 阶段校验而不能在 make 阶段延迟校验？

② **Counterfactual**: 如果在 make 阶段延迟校验？`#ifndef INCLUDE_JVMTI` 在 .cpp 中已经用了，但 configure 不报错会导致 make 时 `.cpp` 里 `JVMTI_ONLY(code)` 宏展开为空——悄无声息地把功能砍掉。

### 4.5 平台能力对 feature 的约束

① `hotspot.m4:364-389`：shenandoahgc 需要 x86/aarch64，zgc 需要 linux+x86_64，zero 变体禁用大多数 GC。平台检测 (`platform.m4:32-37` 的 `case $1` 分支) 如何影响 feature 可用性？

② **Counterfactual**: 如果不做平台约束，信任用户在无支持平台上启用 zgc？`src/hotspot/share/gc/z/z_<arch>.cpp` 不存在——编译失败，错误信息混乱。

### 4.6 `spec.gmk` 的生成机制

① configure 的所有 `AC_SUBST` 变量（`JVM_FEATURES_server`, `JVM_VARIANTS`, `OPENJDK_TARGET_OS` 等）如何注入 `buildjdk-spec.gmk.in` 模板生成最终 `spec.gmk`？

② **Counterfactual**: 如果不用 spec.gmk 而是把所有变量通过环境变量传给 make？`make` 命令行会爆炸（50+ 变量），且增量构建时环境变量丢失——每次都要完整 configure。

### 4.7 configure 的整体流程时序

① 从 `bash configure` 到 `Configuration summary` 打印的完整时序：shell 参数解析 → autoconf 宏展开 → platform 检测 → toolchain 检测 → HotSpot 检测 → 产物输出。每个阶段的输入和输出是什么？

② **Counterfactual**: 如果不需要 configure，直接在 Makefile 中检测？这是 CMake 的思路——但 GNU Autoconf 更适合"一次 configure 多次 make"的工作流，且对 32 位/交叉编译等边缘场景的检测更成熟。

### 4.8 `--with-debug-level` 的影响

① `--with-debug-level=slowdebug` 如何影响 CFLAGS（`-O0 -g` vs `-O2`）和 feature 选择？

② **Counterfactual**: 如果 debug level 不做任何编译标志改变，只是打印更多日志？那 `-O0` vs `-O2` 的区别——`-O0` 禁用内联后的调用栈完全不同——GDB 断点位置会变，调试体验会差很多。

### 4.9 阅读 `configure --help` 输出

① configure --help 的分类组织：JVM Features / Toolchain Options / Build Target / Debugging。如何高效查找和校验参数？

② **Counterfactual**: 如果不看 `--help` 直接凭经验输入？OpenJDK 的 configure 选项数量远超任何其他开源项目——`make/autoconf/spec.gmk.in` 有数百个占位符，凭记忆不可能全记住。

---

## §五 Article Structure

```markdown
# 3.0 configure 系统 — 从参数到 Makefile

## 一、configure 是什么？为什么需要它？
## 二、平台检测：首次握手
## 三、编译器检测：找对工具
## 四、JVM 变体展开：6 种面孔
## 五、JVM 特性校验：22 项开关矩阵
## 六、Feature 依赖链：谁依赖谁
## 七、spec.gmk 产物：configure 的输出
## 八、完整 configure 参数速查表
## 九、阅读 configure --help
## 十、Counterfactual 分析
```

---

## §六 Writing Requirements

### 不要写成 → 应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| hotspot.m4 包含 JVM 特性列表 | hotspot.m4:27-29 的 `VALID_JVM_FEATURES="compiler1 compiler2 ... jfr"` 是通过 `--with-jvm-features` 的 `+name/-name` 前缀语法校验的白名单。设计理由：集中式白名单让用户拼写错误时立即看到可用的 feature 列表——比编译到一半失败友好得多 |
| configure 校验 feature 依赖 | hotspot.m4:338-352 的四条硬性依赖链（jvmti→services, management→nmt, jvmci→compiler, cmsgc→serialgc）必须在 configure 阶段校验，因为 make 阶段 `JVMTI_ONLY()` 宏会静默展开为空——用户以为开着 jvmti 实际却没编译进去 |
| JVM variant 定义了一组 feature | hotspot.m4:539-544 的六行赋值揭示了 variant 的精简设计：server=compiler1+compiler2+NON_MINIMAL、client=compiler1+NON_MINIMAL、minimal=compiler1+serialgc+minimal+link-time-opt。每个 variant 只新增 2-3 个 feature，其余从 `NON_MINIMAL_FEATURES` 继承 |
| feature 合并后过滤禁用项 | hotspot.m4:571 的 `BASIC_GET_NON_MATCHING_VALUES(JVM_FEATURES_FOR_VARIANT, $JVM_FEATURES_FOR_VARIANT, $DISABLED_JVM_FEATURES)` 是从 variant 默认值中减去用户禁用的 feature。注意：它只处理 feature 名匹配，不处理 feature 依赖的级联禁用——那是 hotspot.m4:338-352 的职责 |
| spec.gmk 是 configure 的输出产物 | `build/$CONF_NAME/spec.gmk` 是 `AC_SUBST` 宏将所有检测结果（JVM_FEATURES_server、OPENJDK_TARGET_OS、DEBUG_LEVEL 等 50+ 变量）注入 `buildjdk-spec.gmk.in` 模板后自动替换生成的。它的存在使得 `make` 不需要重新运行 configure——增量构建的核心 |
| platform.m4 检测 CPU 架构 | platform.m4:32-37 的 `case "$1" in x86_64)` 分支设置 `VAR_CPU=x86_64 VAR_CPU_ARCH=x86 VAR_CPU_BITS=64 VAR_CPU_ENDIAN=little`——这四个变量被后续 .gmk 文件用于确定 `src/hotspot/cpu/` 和 `src/hotspot/os_cpu/` 的源码路径 |
| `--with-jvm-variants=server,client` 构建多份 JVM | hotspot.m4:98-102：多个 variant 时 `BUILDING_MULTIPLE_JVM_VARIANTS=true` 触发多份 libjvm.so 编译——每个 variant 一套源码路径和一套输出目录。注意：只能 `server|client|minimal` 组合（hotspot.m4:121） |
| configure --help 列出参数 | `bash configure --help` 输出的不是简单列表——autoconf 的 `AS_HELP_STRING` 宏（hotspot.m4:86-87）生成的格式包含默认值标记 `@<:@server@:>@`，且在 JVM Features 部分按字母序排列（hotspot.m4:294 的 `BASIC_SORT_LIST`），这是 configure 精度的最后一道防线 |

---

## §七 Output Format

文档使用书籍章节格式（非 probe_md prompt 格式）：
- 标题：`# 3.0 — 副标题`（`# 数字.数字 标题`）
- 次级标题：`## 节名`
- 源码引用：`hotspot.m4:27` 格式
- Mermaid 图用 ` ```mermaid ` 块
- 表格用标准 Markdown 表格
- Callout 用 `> **Callout N — ...**` 块引用

---

## §八 Prohibited（≥8 条）

1. 不要写成 autoconf 教程——本文聚焦 OpenJDK 的 autoconf 使用方式，不是一般性 autoconf 教学
2. 不要把 hotspot.m4 全文翻译成中文——只提取关键逻辑段，标注 file:line
3. 不要忽略 `NON_MINIMAL_FEATURES` 的设计意图——这是 JVM 特性的共享层的核心设计模式
4. 不要跳过 `HOTSPOT_FINALIZE_JVM_FEATURES` 的过滤+排序+去重逻辑
5. 不要忽略 `JVM_VARIANT_MAIN` 的选择优先级——多 variant 构建的关键
6. 不要漏掉 configure 输出产物的完整清单（spec.gmk + configure.log + make-support）
7. 不要只列 feature 名称不说明作用——每个 feature 需要一句话解释
8. 不要漏掉 `--with-debug-level` 对编译标志的精确影响
9. 不要漏掉 configure 的错误处理——用户输错 feature 时的精确错误消息和修复建议
10. 不要跳过 `BASIC_GET_NON_MATCHING_VALUES` / `BASIC_SORT_LIST` 等辅助宏的实现——它们是校验的核心

---

## §九 Required（≥8 条）

1. 所有技术断言必须标注 `hotspot.m4:行号` 或 `platform.m4:行号`
2. Mermaid 流程图展示 `configure` 的执行阶段顺序（5-6 个阶段）
3. VALID_JVM_FEATURES 22 项全表——含名称、中文说明、默认状态
4. JVM_FEATURES 6 variant 的默认值对照表
5. Feature 依赖关系图（有向图：jvmti→services, management→nmt, ...）
6. configure 完整参数速查表（≥15 个常用参数）
7. spec.gmk 模板的关键占位符表（≥10 个 `@...@` 变量）
8. 每个 counterfactual 用 `> **Counterfactual** —` 块引用嵌入对应小节
9. 包含 configure 输出示例（真实的 `Configuration summary` 文本）
10. `configure --help` 的输出片段——帮助读者理解帮助系统本身

---

## §十 GDB Verification

构建系统是非运行时代码，不适合 GDB 断言。但可以通过以下方式验证：

1. `grep "JVM_FEATURES_server" build/*/spec.gmk` → 验证 feature 列表是否正确
2. `grep "VALID_JVM_FEATURES" make/autoconf/hotspot.m4` → 验证 22 项列表
3. `bash configure --help | grep "jvm-features"` → 验证帮助输出包含 feature 说明
4. `grep -rn "JVM_FEATURES_server" make/` → 验证 feature 变量在哪些 .gmk 中被引用
5. `grep "NON_MINIMAL_FEATURES" make/autoconf/hotspot.m4` → 验证共享 feature 列表
6. `grep "BASIC_GET_NON_MATCHING_VALUES" make/autoconf/*.m4` → 验证校验函数的使用范围
7. `cat build/*/spec.gmk | head -50` → 验证 spec.gmk 格式

---

## §十一 与 README 和同组 prompt 的连续性

本文是 Phase 29 的第 0 篇。与后续文档的关系：
- **01-main-pipeline.md**: configure 生成 spec.gmk 后，Main.gmk 读取它启动构建管线
- **02-hotspot-compile.md**: JVM_FEATURES 变量传入 CompileJvm.gmk 控制条件编译
- **03-image-assembly.md**: configure 的输出路径变量被 Images.gmk 使用
- **04-trim-customize.md**: configure 参数是裁剪的第一把刀

本文是构建系统的入口——不读懂 configure，后面都无从谈起。
