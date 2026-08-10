# Prompt 04 — 自定义裁剪实战：三把刀打造最小化 JDK

## §〇 Production Scenario

三个真实场景锚定本文价值：

1. **容器环境：JDK 太大塞不进 image** — Docker image 里完整 JDK 300MB，Kubernetes pod 启动慢。你需要 <50MB 的 JDK——只保留 java.base + 一个 GC + 解释器。
2. **安全合规：关掉不需要的 feature** — 生产环境审计要求禁用 JFR（数据泄露风险）、串口通信（jdk.jdwp.agent 不需要）。怎么确认关掉了？
3. **嵌入式设备：libjvm.so 太大** — Raspberry Pi 上 256MB 内存，libjvm.so 15MB 都太大。能降到 5MB 吗？

每个场景配完整参数 + 验证命令。

---

## §一 Task + Narrative + Beginner Callouts

### Task
OpenJDK 的三把裁剪刀实战——JVM_FEATURES（22 项源码级开关）、JVM_VARIANTS（6 种预置变体）、JDK 模块（60+ 个模块的 --disable-module），组合出从 300MB 完整 JDK 到 25MB 最小 runtime 的多种配置。

### Narrative
"给我一个只包含 String 和 HashMap 的 JDK。"

不可能的——java.base 不可裁。但你可以：关掉 compiler2 用 interpreter-only、切到 serialgc、把 java.desktop/java.xml/jdk.unsupported 全砍掉、再用 jlink 二次裁切。

### 7 个 Beginner Callout（嵌在 §一 各小节）

> **Callout 1 — JVM_FEATURES 控制 C++ 源码编译** — JvmFeatures.gmk:32-45：`compiler1=false` → `JVM_EXCLUDE_PATTERNS += c1_ c1/` 直接跳过整个 `c1/` 目录（49 文件）。不是运行时开关，是编译时排除。
> **Callout 2 — JVM_VARIANTS 是 JVM_FEATURES 的快捷方式** — hotspot.m4:539-544：`server=compiler1+compiler2+NON_MINIMAL`、`client=compiler1+NON_MINIMAL`、`minimal=compiler1+serialgc+minimal+link-time-opt`。每个 variant 只新增 2-3 个 feature。
> **Callout 3 — --disable-module 控制 Java 模块编译** — 排除 `java.desktop` 时，AWT/Swing/Java2D 全部不编译——节省 ~20MB .class + 原生库。
> **Callout 4 — 三把刀可以同时用** — configure 同时指定 JVM_FEATURES、JVM_VARIANTS、--disable-module。先 variant 默认 → +指定的 feature → -禁用的 feature → -禁用的模块。
> **Callout 5 — 裁剪后必须验证** — `java -Xinternalversion` 看 JVM 配置、`java -XX:+PrintFlagsFinal | grep UseG1GC` 确认 GC 存在、`java --list-modules` 看模块。
> **Callout 6 — jlink 是第四把刀** — 即使编译了全模块，jlink 可以从 jmod 中生成只含 java.base 的 runtime image（~25MB）。`jlink --add-modules java.base --output mini-jdk`。
> **Callout 7 — volume comparison** — 完整 server JDK ~300MB → minimal variant JDK ~40MB → minimal + jlink ~25MB。差异来自：libjvm.so (15MB→5MB) + modules (200MB→15MB) + bin/ tools (50MB→5MB)。

---

## §二 Standard Environment

### Source Roots
```
make/autoconf/hotspot.m4              — JVM_FEATURES 22 项定义 + JVM_VARIANTS 6 种
make/hotspot/lib/JvmFeatures.gmk      — FEATURES → CFLAGS/EXCLUDES/PATTERNS 映射
make/common/Modules.gmk               — JDK 模块检测
```

### Key Configure Parameters
```bash
# 最小容器 JDK（interpreter + serialgc + java.base）
./configure \
  --with-jvm-variants=minimal \
  --with-jvm-features=-jfr,-management,-nmt,-cds \
  --disable-module=java.desktop,java.sql,java.xml,jdk.unsupported \
  --with-debug-level=release

# 完整开发 JDK（带符号表）
./configure \
  --with-jvm-variants=server \
  --with-jvm-features=compiler1,compiler2,g1gc,jfr,jvmti,management,cds \
  --with-debug-level=slowdebug

# 微服务 JDK（server + G1GC，jlink 二次裁切）
./configure \
  --with-jvm-variants=server \
  --with-jvm-features=compiler1,compiler2,g1gc,jfr \
  --with-debug-level=release
# 编译后用 jlink 生成 mini image
```

---

## §三 Source Files Table

| File | Full Path | Lines | Core Functions | Role |
|------|-----------|:---:|----------------|------|
| hotspot.m4 | make/autoconf/hotspot.m4 | 658 | `VALID_JVM_FEATURES`, `HOTSPOT_SETUP_JVM_VARIANTS`, `JVM_FEATURES_server=...` | Feature 定义 |
| JvmFeatures.gmk | make/hotspot/lib/JvmFeatures.gmk | ~250 | `ifeq ($(call check-jvm-feature,...), true)` → `CFLAGS/EXCLUDES/PATTERNS` | 编译控制 |
| Modules.gmk | make/common/Modules.gmk | ~100 | `FindAllModules`, `BOOT_MODULES` | 模块检测 |

---

## §四 Deep Dive Question Groups（≥7 组，每组含 counterfactual）

### 4.1 剪刀 #1：JVM_FEATURES 的精确效果

① 关掉 `compiler2`（JvmFeatures.gmk:38-45）：`JVM_EXCLUDES += opto libadt`、`JVM_EXCLUDE_FILES += bcEscapeAnalyzer.cpp ciTypeFlow.cpp`、`JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/`。精确列出被排除的源文件和目录。

② 关掉 `jfr`（JvmFeatures.gmk:174-177）：`JVM_CFLAGS_FEATURES += -DINCLUDE_JFR=0`、`JVM_EXCLUDE_PATTERNS += jfr`——整个 `src/hotspot/share/jfr/` 目录（215 文件 ~34K 行）跳过编译。libjvm.so 减少 ~3-5MB。

③ 关掉 `jvmti`（JvmFeatures.gmk:71-78）：`JVM_EXCLUDE_FILES += jvmtiGetLoadedClasses.cpp jvmtiThreadState.cpp ...` ——精确列出 18 个被排除的源文件。

④ **Counterfactual**: 如果不在 JvmFeatures.gmk 统一控制，每个 .cpp 自己 `#ifdef`？编译时检测到 feature 不可用但——依赖的文件已经在 Makefile 级别被排除了——`#ifdef` 解决的是"feature X 的代码中引用 feature Y 的符号"这种跨文件依赖，不是源码排除。

### 4.2 剪刀 #2：JVM_VARIANTS 的 feature 预设

① 6 种 variant 的 feature 默认值（hotspot.m4:539-544）：server(`compiler1+compiler2+NON_MINIMAL`)、client(`compiler1+NON_MINIMAL`)、minimal(`compiler1+serialgc+minimal+link-time-opt`)、core(`serialgc+minimal+link-time-opt`)、zero(`NON_MINIMAL`)、custom(`NON_MINIMAL`)。

② minimal variant 的额外优化（JvmFeatures.gmk:190-248）：per-file `OPT_SPEED_SRC` 列表，50+ 个源文件强制 `-O3` 优化——compiler1/codeBlob/constantPool/classLoaderData/method 等热点文件即使在 `SIZE` 模式下也保持性能。

③ **Counterfactual**: 如果自定义 variant 不从 `custom=NON_MINIMAL` 继承？你需要显式列出所有想保留的 feature——任何遗漏都会静默砍掉对应功能。

### 4.3 剪刀 #3：--disable-module

① `--disable-module=java.desktop` → `ALL_MODULES` 变量过滤掉 java.desktop 及其依赖模块（java.datatransfer）。树形传递链：java.desktop → java.datatransfer → java.prefs（如果无其他依赖）。

② 哪些模块不可 disable？java.base 是硬依赖——它是所有模块的根。java.logging 和 java.management 如果启用了 jvmti/services 则不可 disable（management 依赖 `java.lang.management`）。

③ **Counterfactual**: 如果不做树形传递，只 disable 本级？java.desktop 没了但 java.datatransfer 还在——它没有使用者却占用空间。Modules.gmk 的模块依赖分析保证了级联清除。

### 4.4 GC feature 的交叉依赖

① 关掉 `serialgc` 的副作用（JvmFeatures.gmk:152-157）：`JVM_EXCLUDE_FILES += psMarkSweep.cpp psMarkSweepDecorator.cpp`——因为 ParallelGC 的 Old GC 借用 SerialGC 的 MarkSweep 实现。serialgc=false 时 parallelgc 还能用吗？

② GC 的最小保留：必须至少保留一个 GC——否则 JVM 启动时 `Universe::initialize_heap()` 失败。serialgc 是最小最可靠的兜底。

③ **Counterfactual**: 如果所有 GC 都关了？configure 阶段 `HOTSPOT_FINALIZE_JVM_FEATURES`（hotspot.m4:563-592）会检测到没有任何 GC feature 启用→报错或强制启用 serialgc。

### 4.5 实战配置矩阵（4 场景）

① **容器 JVM**：`--with-jvm-variants=minimal --with-jvm-features=-jfr,-management,-nmt,-cds --disable-module=java.desktop,...` → libjvm.so ~5MB, JDK ~35MB。

② **微服务 JVM**：`--with-jvm-variants=server --with-jvm-features=compiler1,compiler2,g1gc,jfr` → 编译后用 `jlink --add-modules java.base,java.logging --strip-debug --output app-jdk` → ~45MB。

③ **完整 JDK**：`--with-jvm-variants=server --with-debug-level=slowdebug` → ~300MB。

④ **学习分析 JDK**：`--with-jvm-variants=server --with-debug-level=slowdebug --with-jvm-features=compiler1,compiler2,g1gc,jfr,jvmti,cds,nmt` → 带全符号、全特性，~350MB。

### 4.6 jlink 二次裁切

① 从已编译的 jmod 集合生成最小 runtime：`jlink --module-path images/jdk/jmods/ --add-modules java.base --strip-debug --compress=2 --no-man-pages --no-header-files --output mini-jdk`。

② `--compress=2` 的压缩级别：0=不压缩、1=常量池共享、2=ZIP 压缩—在 ARM 和容器环境中可节省 30% 磁盘。

③ **Counterfactual**: 如果不用 jlink 二次裁切，每个微服务实例带一个完整 JDK？300MB × 1000 个 pod = 300GB 磁盘浪费。

### 4.7 验证方法

① `java -Xinternalversion` — 展示 JVM 的 variant 和 feature list。
② `java -XX:+PrintFlagsFinal 2>&1 | grep -E "UseG1GC|UseSerialGC"` — 验证 GC 可用性。
③ `java -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly -version 2>&1 | head -3` — 有 compiler2 时会输出汇编，只有 compiler1 时 silent 失败。
④ `du -sh images/jdk/lib/server/libjvm.so` — precise size check。
⑤ `java --list-modules` — module count。

**所有指标必须达标**。

---

## §五 Article Structure

```markdown
# 3.4 自定义裁剪 — 三把刀打造你的 JDK

## 一、三把刀全貌
## 二、剪刀 #1：JVM_FEATURES — C++ 源码级开关
## 三、剪刀 #2：JVM_VARIANTS — 预置配置速成
## 四、剪刀 #3：--disable-module — Java 模块裁切
## 五、GC 的交叉依赖：至少留一个
## 六、实战配置矩阵：4 场景全参数
## 七、jlink 二次裁切：从 300MB 到 25MB
## 八、验证矩阵：每场景的验证命令
## 九、Counterfactual 分析
```

---

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| `--with-jvm-features` 关掉 feature | JvmFeatures.gmk:38-44 的精确排除链：`compiler2=false` → `JVM_EXCLUDES += opto libadt`（2 个目录）、`JVM_EXCLUDE_FILES += bcEscapeAnalyzer.cpp ciTypeFlow.cpp`（2 个文件）、`JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/`（3 个前缀模式） |
| jfr 关掉后 215 文件跳过编译 | JvmFeatures.gmk:174-177 只有 4 行：`JVM_CFLAGS_FEATURES += -DINCLUDE_JFR=0` + `JVM_EXCLUDE_PATTERNS += jfr`。215 文件的排除不是因为名字匹配了 215 次——而是 `jfr` 这个 pattern 在 `CompileJvm.gmk` 的 `FindFiles` 宏中被展开为对 `src/hotspot/share/jfr/` 下所有 .cpp 文件的 glob 排除 |
| minimal variant 编译出小 libjvm.so | JvmFeatures.gmk:190-248 的 `OPT_SPEED_SRC` 列表有 50+ 个文件强制 `-O3`。这意味着 minimal variant 不是简单的"全 SIZE 优化"——它精确地将编译器/类加载器/GC 热点保留在 -O3 级别 |
| jlink 可以裁切 | 完整命令：`jlink --module-path images/jdk/jmods/ --add-modules java.base,java.logging --strip-debug --compress=2 --no-man-pages --no-header-files --output mini-jdk`。从 ~300MB → ~25MB。`--compress=2` 在 ARM/x86 上的解压开销和性能影响 |
| 4 种场景的配置矩阵 | 每场景含 4 列：configure 参数 / libjvm.so 体积 / JDK 总体积 / 完整验证命令。体积数据从 JvmFeatures.gmk+CompileJvm.gmk 的排除效果推算 |
| serialgc 是兜底 GC | JvmFeatures.gmk:152-157：serialgc=false 时还要排除 `psMarkSweep.cpp`——因为 ParallelGC 的 Old GC 复用 SerialGC 的 MarkSweep。关掉 serialgc 需要同时确认 parallelgc 的 Old GC 降级到其他算法 |
| cmake/autotools 对比 | autoconf 的 "configure 一次→增量 make 不需要重跑" 设计适合大型项目管理。`--disable-module` 做模块树传递——你只禁用 java.desktop，但 java.datatransfer+java.prefs 自动跟着被禁——Modules.gmk 的模块依赖传递规则 |
| `--with-jvm-features` 的 +name/-name 语法 | hotspot.m4:305-307 的 `AC_ARG_WITH` 解析：前缀 `-` 表示 disable，无前缀表示 enable。`JVM_FEATURES` 变量收集 enable 项，`DISABLED_JVM_FEATURES` 收集 disable 项。最终 `HOTSPOT_FINALIZE_JVM_FEATURES` (hotspot.m4:563-592) 做合并—从 variant 默认值中减去 disable 项，再加上 enable 项 |

---

## §七 Output Format 同 prompt-01

---

## §八 Prohibited（≥8 条）

1. 不要写成 configure 参数参考手册
2. 不要只列出参数不解释精确效果（JvmFeatures.gmk 的具体 EXCLUDES）
3. 不要忽略验证步骤——每场景必须配验证命令
4. 不要遗漏 jlink 二次裁切及其 `--compress=2` 选项
5. 不要忽略体积对比——每个场景给出 libjvm.so + JDK 总体积
6. 不要遗漏 GC 交叉依赖（serialgc=false → psMarkSweep.cpp 排除）
7. 不要忽略 `HOTSPOT_FINALIZE_JVM_FEATURES` 的最终合并逻辑
8. 不要遗漏 `OPT_SPEED_SRC` 的 per-file optimization 设计
9. 不要跳过 `NON_MINIMAL_FEATURES` 共享层的设计意图

---

## §九 Required（≥8 条）

1. 必须有 JvmFeatures.gmk:38-44,71-78,174-177 的精确排除效果表
2. 必须有 4+ 场景配置矩阵（容器/微服务/学习/完整）
3. 必须有每场景的体积对比表（libjvm.so + JDK total）
4. 必须有每场景的完整验证命令
5. 必须有 GC 交叉依赖图（有向图：serial→parallel, g1→parallel?）
6. 必须有 jlink 二次裁切完整命令及 `--compress=2` 解释
7. 必须有 22 项 JVM_FEATURES 全表——名字+brief+默认状态
8. 必须有 `HOTSPOT_FINALIZE_JVM_FEATURES` 的合并流程图
9. 必须有验证检查表——每场景≥5 条检查项

---

## §十 Verification（≥7 assertions）

1. `java -Xinternalversion` — 查看 JVM 构建配置（variant + features）
2. `java -XX:+PrintFlagsFinal 2>&1 | grep -E "UseG1GC|UseSerialGC|UseParallelGC"` — 验证哪些 GC 可用
3. `java -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly -version 2>&1 | head -5` — 验证 compiler2 是否可用
4. `du -h build/*/images/jdk/lib/server/libjvm.so` — libjvm.so 精确大小
5. `du -sh build/*/images/jdk` — JDK 总大小
6. `build/*/images/jdk/bin/java --list-modules` — 模块数量和清单
7. `nm -D build/*/images/jdk/lib/server/libjvm.so | wc -l` — 导出符号计数（minimal vs server 对比）
8. `build/*/images/jdk/bin/java -Xlog:gc -version` — GC 日志校验（确认 GC 工作）
9. `objdump -h build/*/images/jdk/lib/server/libjvm.so | grep -c '\.debug_'` — DWARF section 数量（slowdebug vs release 对比）

---

## §十一 与 README 和同组 prompt 的连续性

- **前接 prompt-00/01/02/03**——这是 Phase 29 所有知识的综合应用
- 与 Phase 23-jfr、Phase 24-utilities 的直接关联——关掉 jfr feature 意味着 Phase 25 的 3 篇文档分析的源码全部不编译
- 与 book/00-prerequisites/02-hotspot-source-guide 的对应——裁剪后的源码阅读路径变化
