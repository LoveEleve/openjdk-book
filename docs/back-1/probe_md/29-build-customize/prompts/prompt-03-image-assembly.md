# Prompt 03 — JDK 镜像组装：exploded image → jmod → jlink → tar.gz

## §〇 Production Scenario

三个真实故障场景锚定本文价值：

1. **jlink 失败：找不到模块** — `make jdk-image` 在 jlink 阶段报 `Error: Module java.desktop not found`。你明明已经 `--disable-module=java.desktop`，为什么 jlink 还在找它？
2. **exploded image 能跑但 images/jdk 不行** — `build/*/jdk/bin/java -version` 正常，但 `build/*/images/jdk/bin/java -version` segfault。是 jlink 裁切了什么导致的？怎么对比两个目录？
3. **tar.gz 包含了不该有的文件** — 最终分发包里有 `src.zip` 和 `demo/`，怎么去掉？

每个场景配完整诊断链。

---

## §一 Task + Narrative + Beginner Callouts

### Task
分析 OpenJDK 镜像组装的完整流程：从编译产物（.class + .so）→ jmod 模块打包 → jlink 镜像生成 → exploded image → images/jdk → tar.gz 分发包。

### Narrative
"make jdk-image 的最后一步到底做了什么？"

跟随镜像组装的实际执行顺序：编译完成 → jmod create 打包各个模块 → jlink 链接生成 `images/jdk/` → tar 打包分发。

### 7 个 Beginner Callout（嵌在 §一 各小节）

> **Callout 1 — 什么是 exploded image？** `build/*/jdk/` 是一个"摊开"的 JDK——所有文件以原始形式放在对应目录下，`bin/java` 直接指向编译产物，不做 jlink 链接。
> **Callout 2 — jmod 不是 .jar** — .jar 只有 .class 文件。jmod 包含 .class + .so 原生库 + bin/ 可执行文件 + conf/ 配置 + legal/ 许可证——一个完整模块的全部内容。
> **Callout 3 — jlink 做了什么？** 从 jmod 集合中挑选 `--add-modules` 指定的模块，生成一个精简的 JDK/JRE 目录。它不是"复制文件"，而是在 class/module-info.class 级别做哈希去重和压缩。
> **Callout 4 — exploded image vs images/jdk 的关键差异** — exploded image ~300MB（含所有模块、未 strip 的 .so、man pages）；images/jdk ~180MB（jlink 裁切、--strip-debug、去除 man pages）。
> **Callout 5 — Images.gmk 不是单文件** — 它 include 了 Modules.gmk、通过 `$(call IncludeCustomExtension, Images-pre.gmk)` 钩子加载自定义文件，并通过 `$(TOUCH)` 标记 jlink 成功状态防止重复执行。
> **Callout 6 — mac/linux 镜像差异** — macOS 生成 `.dmg` bundle (`mac-jdk-bundle` target)，Linux 生成 `.tar.gz`。`release-file` target 生成 `release` 文件记录构建配置。
> **Callout 7 — tar.gz 的生成不是 make 干的** — `make product-bundles` 调用 `make/common/Bundles.gmk`，用 JDK 自带的 `jdk.tar.gz` 脚本打包 `images/jdk/` 目录。

---

## §二 Standard Environment

### Source Roots
```
make/Images.gmk                        — 镜像组装主入口 (~300 lines)
make/Modules.gmk                       — 模块检测和分类
make/common/Bundles.gmk                — tar.gz 分发包生成
build/*/support/jmods/                 — 中间 jmod 文件目录
```

### Build Command
```bash
# 生成 exploded image（开发用）
make exploded-image

# 生成 JDK image（分发用）
make jdk-image

# 生成分发包
make product-bundles
```

### Binary Paths
```
build/$CONF_NAME/jdk/                        exploded image（增量开发用，~300MB）
build/$CONF_NAME/images/jdk/                 JDK image（分发用，~180MB）
build/$CONF_NAME/support/jmods/              中间 jmod 文件
build/$CONF_NAME/images/jdk.tar.gz           最终分发包
```

### Syscall 速查表
镜像组装不直接调用 syscall——jlink 是 Java 工具，通过 JDK 自带的 `bin/jlink` 运行。

---

## §三 Source Files Table

| File | Full Path | Lines | Core Functions | Role |
|------|-----------|:---:|----------------|------|
| Images.gmk | make/Images.gmk | ~300 | `JDK_MODULES_LIST`, `JLINK_TOOL`, `$(JDK_IMAGE_DIR)/$(JIMAGE_TARGET_FILE)` | 镜像组装主入口 |
| Modules.gmk | make/Modules.gmk | ~100 | `FindAllModules`, `BOOT_MODULES`, `PLATFORM_MODULES` | 模块检测和分类 |
| Bundles.gmk | make/common/Bundles.gmk | ~150 | tar.gz 生成 | 分发包生成 |
| Images-jdk.gmk | make/Images-jdk.gmk | ~200 | JDK 镜像规则 | JDK 镜像细节 |

---

## §四 Deep Dive Question Groups（≥7 组，每组含 counterfactual）

### 4.1 exploded image 的生成机制

① `build/*/jdk/` 目录的内容从哪来？`Main.gmk:1070` 称它为"locally runnable JDK"——但它的 bin/lib/modules 是如何从编译产物一步步复制/链接过来的？简单复制还是符号链接？

② **Counterfactual**: 如果每次增量开发都走完整 jlink 而非 exploded image？每次改一行代码后 `make jdk-image` 30s 而非 `make exploded-image` 3s——开发迭代慢 10 倍。exploded image 是开发者的加速器。

### 4.2 jmod create：模块打包

① Images.gmk:57 — `JMODS := $(wildcard $(IMAGES_OUTPUTDIR)/jmods/*.jmod)`。这些 jmod 文件是上一个构建阶段（CompileJavaModules.gmk）产出的。jmod 文件内部包含哪 5 类内容？classes/（.class）、lib/（.so）、bin/（可执行文件）、conf/（配置文件）、legal/（许可证）。

② **Counterfactual**: 如果不用 jmod 中间格式，直接把编译产物复制到 images/jdk？jlink 需要 module-info.class 元数据来解析模块依赖图和做可达性裁切——没有 jmod，jlink 无法工作。

### 4.3 jlink 调用：Images.gmk 的核心逻辑

① Images.gmk:76-83 的 `JLINK_TOOL` 变量定义：`$(JLINK) -J-Djlink.debug=true --module-path $(IMAGES_OUTPUTDIR)/jmods --endian $(OPENJDK_TARGET_CPU_ENDIAN) --release-info $(BASE_RELEASE_FILE) --order-resources=... --dedup-legal-notices=error-if-not-same-content`。逐个参数解释作用。

② Images.gmk:91-100 — JDK 镜像的 jlink 调用：`$(JLINK_TOOL) --add-modules $(JDK_MODULES_LIST) --output $(JDK_IMAGE_DIR)`。JDK_MODULES_LIST 是从 Modules.gmk 的 `ALL_MODULES` 变量计算出来的。

③ **Counterfactual**: 如果不设置 `--dedup-legal-notices=error-if-not-same-content`？多个模块包含相同 legal 文件时，jlink 默认行为是任意选一份——可能导致 tzdata 的 LICENSE 被 java.base 的 LICENSE 覆盖。

### 4.4 JRE vs JDK 镜像的差异

① Images.gmk:85 — `JLINK_JRE_EXTRA_OPTS := --no-man-pages --no-header-files --strip-debug`。JRE 镜像比 JDK 镜像多去掉：man pages、C 头文件、调试符号。

② Images.gmk:87-89 — JDK 镜像的 `--keep-packaged-modules` 选项：JDK 保留 jmod 文件放在 `images/jdk/jmods/` 下，供用户二次 jlink。

③ **Counterfactual**: 如果 JDK 不保留 jmod 文件？用户无法用 `jlink` 从已安装的 JDK 生成自定义 runtime image——分发版就缺少了二次裁剪能力。

### 4.5 镜像的目录结构

① `images/jdk/bin/java` — 启动器如何找到 libjvm.so？`java` 通过 `$JAVA_HOME/lib/server/libjvm.so` 路径查找，这是硬编码在启动器源码（`src/java.base/share/native/libjli/java.c`）中的。

② `images/jdk/lib/server/libjvm.so` — 为什么在 `lib/server/` 下？因为 `lib/` 下可能有 `client/`（client variant），`server/` 是默认的生产 variant。

③ `images/jdk/conf/` vs `images/jdk/lib/security/` — JVM 配置文件和 Java 安全策略分开存放。

### 4.6 调试信息的处理

① `--with-debug-level=slowdebug` → `.so` 文件内嵌 DWARF 调试信息 → `images/jdk/lib/server/libjvm.so` ~200MB（含符号）vs release ~15MB（strip 后）。

② `--strip-debug` (JRE) → 去除 DWARF sections → `.so` 变小但 GDB 失去行号信息。`images/jdk` 的 JDK 镜像默认保留调试信息吗？取决于 `--with-debug-level`。

③ **Counterfactual**: 如果发布版默认保留符号？libjvm.so 从 15MB → 200MB——不仅体积暴增，运行时 mmap 也会更慢（DWARF 段虽然不映射但占用 VMA）。

### 4.7 tar.gz 的生成

① `make product-bundles` → `make/common/Bundles.gmk` → 调用 `tar -czf jdk-11.0.24_linux-x64_bin.tar.gz images/jdk/`。Bundles.gmk 的 `CreateBundle` 宏如何组装最终文件名（含版本号、平台、架构）？

② `release-file` target (Main.gmk:407) → 生成 `images/jdk/release` 文件，内容为 `JAVA_VERSION="11.0.24"` 等。

③ **Counterfactual**: 如果手动 `tar -czf` 而非用 Bundles.gmk？你会漏掉 release 文件、忘记排除 `build/` 临时文件、文件名不标准——`Bundles.gmk` 封装了这些规则。

### 4.8 验证：exploded image vs images/jdk 对比

① `build/*/jdk/bin/java -version` vs `build/*/images/jdk/bin/java -version` — 都能输出相同版本号。但如果 `--with-debug-level=release` 且 jlink 做了 strip，images/jdk 的 libjvm.so 会更小。

② `diff -rq build/*/jdk build/*/images/jdk` — 精确对比两个目录的差异文件清单。

③ `jlink` 的输出目录结构——与 exploded image 的目录扁平化差异：jlink 生成 `lib/modules` 文件（JDK 9+ 的运行时镜像格式）而非 `jmods/` 目录。

---

## §五 Article Structure

```markdown
# 3.3 JDK 镜像组装 — 从 .so 和 .class 到 jdk.tar.gz

## 一、exploded image：开发者的工作区
## 二、jmod create：模块打包
## 三、jlink 调用：Images.gmk 的核心
## 四、JRE vs JDK 镜像的差异
## 五、images/jdk 的内部目录结构
## 六、调试信息：slowdebug 对镜像的影响
## 七、tar.gz：最终分发包
## 八、验证：三阶段（exploded → image → tar.gz）
## 九、Counterfactual 分析
```

---

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| jlink 是一个镜像工具 | Images.gmk:76-83 的 `JLINK_TOOL` 变量定义展示了 jlink 的 8 个核心参数：`--module-path $(IMAGES_OUTPUTDIR)/jmods` (jmod 来源)、`--endian $(OPENJDK_TARGET_CPU_ENDIAN)` (字节序)、`--release-info $(BASE_RELEASE_FILE)` (release 文件)、`--order-resources=...` (资源排序)、`--dedup-legal-notices=error-if-not-same-content` (LICENSE 去重) |
| exploded image 可以运行 | 对比 exploded image 和 images/jdk 的目录树差异：exploded 的 lib/ 是原始编译产物（未 strip、含所有 variant .so），images/jdk 的 lib/ 是 jlink 处理后挑选并 strip 过的。`diff -rq` 输出精确差异清单 |
| jmod 是中间格式 | jmod 文件的 5 类内容：classes/（模块的 .class 文件）、lib/（.so 原生库）、bin/（可执行文件）、conf/（配置文件）、legal/（LICENSE 文件）。`jmod list java.base.jmod \| head -20` 展示实际内容 |
| make jdk-image 生成 tar.gz | `make jdk-image` 只生成 `images/jdk/` 目录。tar.gz 需要额外的 `make product-bundles` target。Bundles.gmk 的 `CreateBundle` 宏控制最终文件名格式：`jdk-$(VERSION)_$(OS)-$(ARCH)_bin.tar.gz` |
| JRE 是 JDK 的子集 | Images.gmk:85 的 `JLINK_JRE_EXTRA_OPTS := --no-man-pages --no-header-files --strip-debug` 明确展示了 JRE 额外去除的 3 类内容。JRE 的模块列表 (`JRE_MODULES_LIST`) 也从 `ALL_MODULES` 过滤了 `BOOT_MODULES + PLATFORM_MODULES + JRE_TOOL_MODULES` |
| jlink 可以二次裁切 | 如果 Images.gmk:87-89 设置了 `--keep-packaged-modules $(JDK_IMAGE_DIR)/jmods`，则 images/jdk/jmods/ 目录保留——用户可用 `jlink --module-path jmods/ --add-modules java.base` 从已安装 JDK 生成更小的 runtime |
| debug image 有符号表 | `--with-debug-level=slowdebug` 编译时 CFLAGS 为 `-O0 -g`，link 时不 strip。产物 libjvm.so ~200MB（embedded DWARF）。`readelf -S libjvm.so \| grep debug` 展示 .debug_info / .debug_line / .debug_abbrev 等 sections |
| tar.gz 命名规则 | 文件名三部分：版本号（`jdk-11.0.24`）、平台（`linux`）、架构（`x64`）→ `jdk-11.0.24_linux-x64_bin.tar.gz`。Bundles.gmk 通过 `$(JAVA_VERSION)` 和 `$(OPENJDK_TARGET_OS)-$(OPENJDK_TARGET_CPU)` 自动拼接 |

---

## §七 Output Format

文档使用书籍章节格式（非 probe_md 格式）：
- 标题 `# 3.3 — 副标题`
- 源码引用 `Images.gmk:91` 格式
- Mermaid 图用 ` ```mermaid ` 块

---

## §八 Prohibited（≥8 条）

1. 不要写成 jlink 完整文档——只写 Images.gmk 调用它的方式
2. 不要忽略 exploded image 和 images/jdk 的关键差异
3. 不要漏掉 JRE 和 JDK 镜像的区别（JLINK_JRE_EXTRA_OPTS）
4. 不要忽略 --strip-debug / --no-man-pages 的具体效果
5. 不要漏掉 release-file target 生成的 release 文件内容
6. 不要忽略 jmod 的 5 类内容结构
7. 不要跳过 tar.gz 生成（Bundles.gmk 而非手动 tar）
8. 不要忽略 `--keep-packaged-modules` 对用户二次 jlink 的影响
9. 不要漏掉验证步骤（exploded → image → tar.gz 三阶段）
10. 不要跳过 Images.gmk 的 `$(TOUCH)` 标记机制—它防止 jlink 重复执行

---

## §九 Required（≥8 条）

1. 必须有 exploded image 目录结构（bin/lib/modules 树）
2. 必须有 jmod create 命令示例及内部结构
3. 必须有 Images.gmk:76-99 的 JLINK_TOOL 逐参数解释
4. 必须有 JRE vs JDK 镜像的 `JLINK_JRE_EXTRA_OPTS` 差异表
5. 必须有 images/jdk 目录结构全文
6. 必须有 tar.gz 生成流程（Bundles.gmk）
7. 必须有 debug symbol 处理机制（Dwarf sections + strip）
8. 必须有验证命令（java -version / diff 对比 / du 体积）
9. 必须有 Mermaid 流程图：编译产物 → jmod → jlink → images/jdk → tar.gz

---

## §十 Verification（≥7 assertions）

1. `build/*/jdk/bin/java -version` — 验证 exploded image 可运行
2. `build/*/images/jdk/bin/java -version` — 验证 JDK image 可运行
3. `build/*/images/jdk/bin/java --list-modules` — 验证模块列表正确
4. `du -sh build/*/jdk build/*/images/jdk` — 对比大小（~300MB vs ~180MB）
5. `ls build/*/support/jmods/*.jmod | wc -l` — jmod 文件计数
6. `jmod list build/*/support/jmods/java.base.jmod | head -20` — 查看 java.base 模块内容
7. `file build/*/images/jdk/lib/server/libjvm.so` — 验证 strip 状态（"not stripped" vs "stripped"）
8. `diff -rq build/*/jdk/bin build/*/images/jdk/bin` — 验证 bin/ 目录一致性
9. `cat build/*/images/jdk/release` — 验证 release 文件内容

---

## §十一 与 README 和同组 prompt 的连续性

- **前接 prompt-02**（HotSpot 编译）：02 产出了 libjvm.so；03 展示它如何进入 jmod → jlink → images/jdk
- **后接 prompt-04**（裁剪实战）：03 解释了 jlink 裁切机制；04 展示如何用 --disable-module 和 jlink 二次裁切
- **与 README 一致性**：Phase 29 的文档顺序是 configure → Main.gmk → HotSpot 编译 → 镜像组装 → 裁剪
