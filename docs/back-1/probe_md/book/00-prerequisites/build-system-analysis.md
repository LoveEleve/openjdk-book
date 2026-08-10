# OpenJDK 构建系统深度分析

> 原始材料：为 book 第 03 章提供技术底稿。每个回答含精确 file:line 引用。

---

## Q1: Main.gmk target 依赖图

`make jdk-image` 的全链路 target 序列（`Main.gmk`）：

```
default → product-images → jdk-image + symbols-image + exploded-image
                                │
              Images.gmk jdk → jlink --add-modules $(JDK_MODULES_LIST)
                                   │
                          $(IMAGES_OUTPUTDIR)/jmods/*.jmod
                                   │
              ┌────────────────────┼──────────────────┐
              │                    │                  │
      hotspot-server-libs   java.base-java   java.base-libs
              │                    │                  │
      CompileLibraries.gmk  CompileJavaModules.gmk  Lib-java.base.gmk
              │
      CompileJvm.gmk:153 BUILD_LIBJVM
              │
      JvmFeatures.gmk: feature → EXCLUDE_PATTERNS / EXCLUDE_FILES
```

**关键行号**：
- `Main.gmk:32` — default target (空，由 :1169 赋值)
- `Main.gmk:389` — jdk-image → Images.gmk jdk
- `Main.gmk:410` — exploded-image-optimize
- `Main.gmk:1071` — exploded-image-base 依赖 `$(ALL_MODULES)`（所有模块的 java+libs 阶段）
- `Main.gmk:1107` — product-images 依赖 jdk-image + symbols-image + exploded-image
- `Images.gmk:41-51` — JDK_MODULES 和 JRE_MODULES 列表
- `Images.gmk:92-96` — jlink 命令：`--add-modules $(JDK_MODULES_LIST) --output $(JDK_IMAGE_DIR)`

**产物位置**：
- exploded image: `build/linux-x86_64-normal-server-slowdebug/jdk/` (bin/, lib/, modules/, conf/)
- final image: `build/linux-x86_64-normal-server-slowdebug/images/jdk/` (jlink assembled)
- jmod archive: `build/linux-x86_64-normal-server-slowdebug/images/jmods/*.jmod`

---

## Q2: BUILD_LIBJVM 如何编译源文件

`CompileJvm.gmk:153` 声明变量集合后调用 `SetupNativeCompilation`：

```
JVM_SRC_DIRS +=
    src/hotspot/share/           # 跨平台代码
    src/hotspot/os/$(OS)/        # OS 特定 (linux/posix)
    src/hotspot/os_cpu/$(OS_CPU)/  # OS+CPU 组合
    src/hotspot/cpu/$(CPU)/      # CPU 架构
```

**JVM_FEATURES 控制编译/排除**（`JvmFeatures.gmk`）：
- **EXCLUDE_PATTERNS**：排除整个子目录匹配 `c1_` / `gc/g1` / `jfr` 等
- **EXCLUDE_FILES**：排除具体 .cpp 文件
- **JVM_CFLAGS_FEATURES**：添加 `-DCOMPILER1` / `-DINCLUDE_JFR=0` 宏

**示例**（关掉 compiler2, `JvmFeatures.gmk:41-45`）：
```makefile
JVM_EXCLUDES += opto libadt
JVM_EXCLUDE_FILES += bcEscapeAnalyzer.cpp ciTypeFlow.cpp
JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/
```

**示例**（关掉 jfr, `JvmFeatures.gmk:174-177`）：
```makefile
JVM_CFLAGS_FEATURES += -DINCLUDE_JFR=0
JVM_EXCLUDE_PATTERNS += jfr    # 整个 jfr/ 目录 215 文件不编译
```

---

## Q3: JVM_VARIANTS 如何生成不同 libjvm.so

**6 种变体**（`hotspot.m4:35`）:
| Variant | 特性列表 | 用途 |
|---------|---------|------|
| server | c1 + c2 + 全部 GC + jfr + jvmci | 生产（默认） |
| client | c1 + 全部 GC（无 c2） | 桌面/GUI |
| minimal | c1 + serialgc + minimal 宏 | 嵌入式 |
| core | 无编译器，仅解释器 | 极简 |
| zero | C++ 解释器（无汇编） | 移植/调试 |
| custom | 用户指定完整特性列表 | 自定义 |

**定义**（`hotspot.m4:539-542`）：
```bash
JVM_FEATURES_server="compiler1 compiler2 $NON_MINIMAL_FEATURES $JVM_FEATURES $JVM_FEATURES_jvmci $JVM_FEATURES_aot $JVM_FEATURES_graal"
JVM_FEATURES_client="compiler1 $NON_MINIMAL_FEATURES $JVM_FEATURES"
JVM_FEATURES_minimal="compiler1 minimal serialgc $JVM_FEATURES $JVM_FEATURES_link_time_opt"
```

每个 variant 编译到独立子目录：
```
build/linux-x86_64-normal-server-slowdebug/hotspot/variant-server/libjvm/
build/linux-x86_64-normal-server-slowdebug/hotspot/variant-minimal/libjvm/
```

---

## Q4: Images.gmk 如何组装 JDK 目录

**核心工具：jlink** (`Images.gmk:92-96`)

jlink 是 JDK 9+ 引入的模块化链接器。它将 jmod 文件组装成一个可运行的 JDK 运行时镜像。

**管道**:
```
1. 各模块编译完成 → $(IMAGES_OUTPUTDIR)/jmods/java.base.jmod
                                            .../java.logging.jmod
                                            .../jdk.hotspot.agent.jmod

2. jlink --add-modules $(JDK_MODULES_LIST) \
         --module-path $(IMAGES_OUTPUTDIR)/jmods \
         --output $(JDK_IMAGE_DIR)
         → $(JDK_IMAGE_DIR)/bin/java
         → $(JDK_IMAGE_DIR)/lib/server/libjvm.so
         → $(JDK_IMAGE_DIR)/modules (压缩镜像文件)
         → $(JDK_IMAGE_DIR)/release (版本信息)
```

**exploded-image** (`Main.gmk:1070-1072`)：
- 中间产物，不经过 jlink
- `jdk/bin/java` 是运行的编译脚本包装器（不是真实 binary）
- 用于开发调试，重新编译单模块后可见

---

## Q5: JDK 模块系统 jmod

**jmod 文件结构**：
```
java.base.jmod
├── classes/          ← 编译后的 .class 文件
├── lib/              ← .so 原生库
├── bin/              ← 原生可执行文件
├── conf/             ← 配置文件
├── legal/            ← 许可证
└── module-info.class ← 模块描述符
```

**JDK 11 重要模块**：
- `java.base` — 必须存在（核心类库）
- `java.logging` — java.util.logging
- `java.desktop` — AWT/Swing（可排除）
- `jdk.hotspot.agent` — Serviceability Agent
- `jdk.jdwp.agent` — JDWP 调试协议
- `jdk.management` — JMX 管理扩展

---

## Q6: --with-jvm-features 关掉 feature 后的精确影响

以 `--with-jvm-features=compiler1,serialgc,jvmti,services` 为例：

| 关掉的 feature | 影响（JvmFeatures.gmk） |
|---------------|------------------------|
| compiler2 | 排除 opto/ libadt/ — ~129+6=135 文件 |
| g1gc | 排除 gc/g1 — ~193 文件 |
| parallelgc | 排除 gc/parallel |
| zgc | 排除 gc/z |
| shenandoahgc | 排除 gc/shenandoah |
| cds | 排除 11 个 .cpp (filemap/heapShared/metaspaceShared...) |
| jfr | 排除 jfr/ — 215 文件 |
| jvmci | 排除 jvmci/ — 22 文件 |
| aot | 排除 5 个 aot*.cpp |

**最小化后的 libjvm.so**：只保留 share/ 核心 + serialgc + c1 编译器 ≈ ~400 源文件 vs 标准 ~1800 文件。

---

## Q7: --with-debug-level 的影响

| Level | GCC flags | libjvm.so 大小 | 符号表 | 适用 |
|-------|----------|:---:|:---:|------|
| release | -O3 -g0 -DNDEBUG | ~20MB | strip | 生产 |
| fastdebug | -O0 -g -DASSERT | ~80MB | full | 快速调试 |
| slowdebug | -O0 -g -DASSERT | ~180MB | full | **深度调试** |

**probe_md 的 build 目录使用 slowdebug**：`build/linux-x86_64-normal-server-slowdebug/`

slowdebug 开启：
- `ASSERT` 宏（所有 assert/guarantee 检查活跃）
- `-O0` 禁止优化（GDB 断点行号精确）
- full debug symbols（可以用 `objdump -S libjvm.so` 查看汇编+源码对应）

---

## Q8: images/jdk/bin/java 和 tar.gz 的关系

**最终产物链**：
```
images/jdk/                         ← jlink 产出
    │
    ├── tar -czf jdk.tar.gz jdk/     ← Linux 分发包
    ├── zip -r jdk.zip jdk/          ← Windows 分发包
    └── .dmg                         ← macOS 分发包
```

你从 Oracle/Adoptium/Eclipse 下载的 `jdk-11.0.24_linux-x64_bin.tar.gz` 解压后就是这个 `jdk/` 目录。

**关键差异**：
- 自己编译的：包含 debug symbols + assert 代码（slowdebug）
- 下载的发行版：strip 过的 release 版本，不含调试符号

---

## Q9: configure 裁剪参数大全

```bash
# JVM 特性（最重要）
--with-jvm-features=compiler1,compiler2,g1gc,serialgc,jfr,jvmti,cds,services,management,nmt

# JVM 变体
--with-jvm-variants=server

# 调试等级
--with-debug-level=slowdebug    # 或 release/fastdebug

# JDK 模块排除
--disable-module=java.desktop,java.sql,java.xml,java.rmi

# 原生库排除
--disable-jvm-feature-management  # 排除 management 特性

# 构建目标精简
make jdk-image    # 只构建 JDK 镜像（不含 docs/test/demos）
make images       # 完整构建（JDK + JRE + symbols）
```

---

## Q10: 最小化 JDK 构建参数

**目标**：java.base + 1 个 GC + 解释器（无编译器）

```bash
# configure
./configure \
  --with-jvm-variants=minimal \
  --with-jvm-features=compiler1,serialgc,jvmti,services \
  --with-debug-level=release \
  --disable-module=java.desktop,java.sql,java.xml,java.rmi,java.management,java.instrument,java.prefs \
  --disable-module=jdk.attach,jdk.jdi,jdk.jdwp.agent,jdk.jconsole,jdk.management,jdk.unsupported \
  --disable-module=jdk.net,jdk.sctp,jdk.security.auth,jdk.security.jgss \
  --disable-module=jdk.xml.dom,jdk.zipfs

# 构建
make jdk-image

# 产物大小
images/jdk/
├── bin/java           # JVM 启动器（≈5KB 脚本包装器）
├── lib/server/libjvm.so  # 最小 libjvm ≈ 8MB (vs 标准 180MB slowdebug)
└── modules             # java.base only ≈ 20MB
```

这个产物就一个功能：启动任意 Java class，用解释执行和 SerialGC。

---

## 汇总：从源码到 jdk.tar.gz 的完整管线

```
① ./configure
   hotspot.m4:539     → JVM_FEATURES_server 决定编译哪些
   jdk-options.m4     → --disable-module 决定排除哪些 JDK 模块

② make jdk-image
   │
   ├── Phase 1: 生成源代码 (gensrc)
   │   Gensrc.gmk → 字符映射表、货币数据、时区数据
   │
   ├── Phase 2: 编译 Java 模块
   │   CompileJavaModules.gmk → 每个模块编译 .java → .class → .jmod
   │
   ├── Phase 3: 编译 HotSpot C++
   │   CompileJvm.gmk:153 BUILD_LIBJVM
   │   JvmFeatures.gmk → 控制 EXCLUDE_PATTERNS/EXCLUDE_FILES
   │   源文件 → g++ → libjvm.so
   │
   ├── Phase 4: 编译原生库 (libs)
   │   CompileLibraries.gmk → libjava.so, libnio.so, libnet.so...
   │
   ├── Phase 5: 编译启动器 (launcher)
   │   CompileLaunchers.gmk → bin/java (JavaMain + JLI_Launch)
   │
   ├── Phase 6: 组装 exploded image
   │   各模块产物 → build/*/jdk/
   │
   └── Phase 7: jlink 打包
       Images.gmk jdk → jlink → images/jdk/
                            │
                       tar -czf jdk.tar.gz jdk/   ← 你下载的安装包
```
