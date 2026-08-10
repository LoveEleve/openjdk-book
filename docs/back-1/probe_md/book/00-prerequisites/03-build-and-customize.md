# 第 3 章：构建与自定义裁剪 — 从源码到 jdk.tar.gz

> **阅读前提**：本章假定你已读过第 2 章，了解 `src/hotspot/` 四层目录结构和 23 个子目录的职责。如果还不清楚 `opto/`、`gc/g1/`、`runtime/` 分别做什么，建议先回顾第 2 章的源码地图。

> **核心问题**：你面前有 50 万行 C++ 源码。怎么把 `.cpp` 变成 `libjvm.so`？怎么通过 `configure` 精确控制哪些 `.cpp` 参与编译？从 `make jdk-image` 到解压 `jdk.tar.gz`，中间发生了什么？本章回答两个问题：**"怎么编"** 和 **"怎么裁"**——前者让你跑起来，后者让你读得动。

---

## 3.1 构建管道全景

OpenJDK 的构建系统不是 Makefile 的简单平铺——它是一个由 `configure`（Autoconf）生成、由 GNU Make 驱动的**7 阶段管线**。每阶段有明确的输入/输出和依赖关系。

```
                    ┌──────────────────────────────────────────────┐
                    │          ① ./configure                       │
                    │   hotspot.m4:539 → JVM_FEATURES_server       │
                    │   jdk-options.m4  → --disable-module         │
                    │   输出: spec.gmk, build/*/Makefile            │
                    └──────────────────┬───────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        make jdk-image                                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐        │
│  │ ② gensrc        │ →  │ ③ java           │ →  │ ④ hotspot        │        │
│  │ 生成源代码        │    │ 编译 Java 模块    │    │ 编译 C++ → .so   │        │
│  │ Gensrc.gmk       │    │ CompileJavaMod-   │    │ CompileJvm.gmk   │        │
│  │ 字符映射/时区/货币 │    │ ules.gmk          │    │ :153 BUILD_LIBJVM│        │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘        │
│           │                       │                       │                  │
│           ▼                       ▼                       ▼                  │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐        │
│  │ ⑤ libs          │ →  │ ⑥ exploded-image │ →  │ ⑦ jlink          │        │
│  │ 编译原生库 .so    │    │ 中间组装           │    │ 最终打包           │        │
│  │ CompileLibraries │    │ Main.gmk:1071     │    │ Images.gmk:96     │        │
│  │ libjava,libnio.. │    │ build/*/jdk/      │    │ → images/jdk/     │        │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘        │
│                                       │                       │              │
│                                       ▼                       ▼              │
│                               用于开发调试               tar -czf jdk.tar.gz  │
│                               run-test/验证              (你下载的安装包)      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**7 个阶段不是串行的**——实际上 `hotspot`（C++ 编译）和 `java`（Java 编译）是并行的，libs 和 launcher 也是并行的。上图展示的是依赖关系而非执行顺序。

**关键文件一览**：

| 文件 | 路径 | 职责 |
|------|------|------|
| `Main.gmk` | `make/Main.gmk` | 顶层 target 定义，声明所有阶段依赖 |
| `hotspot.m4` | `make/autoconf/hotspot.m4` | configure 阶段决定 JVM 特性集合 |
| `JvmFeatures.gmk` | `make/hotspot/lib/JvmFeatures.gmk` | 条件编译：特性 → `#ifdef` 宏 + 排除文件 |
| `CompileJvm.gmk` | `make/hotspot/lib/CompileJvm.gmk` | `BUILD_LIBJVM` 编译规则（`SetupNativeCompilation`） |
| `Images.gmk` | `make/Images.gmk` | jlink 命令生成 JDK 镜像 |
| `CompileJavaModules.gmk` | `make/CompileJavaModules.gmk` | Java 类库编译 |
| `spec.gmk` | `build/*/spec.gmk` | configure 产出，包含所有变量值 |

**产物位置**（以 `slowdebug` 为例）：

```
build/linux-x86_64-normal-server-slowdebug/
├── hotspot/variant-server/libjvm/    ← libjvm.so 编译产物（.o + .so）
├── support/modules_libs/             ← 其他原生库（libjava.so 等）
├── jdk/                              ← exploded image（中间产物，可直接运行）
│   ├── bin/java                      ← 脚本包装器（非真实 binary）
│   ├── lib/server/libjvm.so          ← 编译产物硬链接/复制
│   └── modules/                      ← Java 模块 class 文件
├── images/
│   ├── jdk/                          ← ★ 最终产物（等同你下载的安装包）
│   │   ├── bin/java                  ← 真实的 ELF 可执行文件
│   │   ├── lib/server/libjvm.so      ← jlink 打包版本
│   │   ├── modules                   ← 压缩的模块镜像文件
│   │   └── release                   ← 版本信息
│   └── jmods/                        ← Java 模块归档（jlink 输入）
│       ├── java.base.jmod
│       └── ...
└── spec.gmk                          ← configure 产生的所有变量
```

> **关键区分**：`build/*/jdk/`（exploded image）可用于快速验证——改完 HotSpot 源码后只需 `make hotspot` 然后直接在 `build/*/jdk/bin/java` 运行。但最终分发给用户的永远是 `build/*/images/jdk/`（经过 jlink 打包）。

**关键要点**：

- 7 阶段管线由 `Main.gmk` 的 target 依赖图驱动，不是线性脚本
- `spec.gmk` 是 configure 和 make 之间的关键桥梁——所有变量在此统一
- exploded image 是开发者的"热重载"；images 是发给用户的"最终打包"

---

## 3.2 configure — 开始之前的选择

`configure` 不是简单的"选 debug 还是 release"。它的输出 `spec.gmk` 决定了：
- **哪些 C++ 文件参与编译**（通过 JVM 特性集合）
- **编译用的 GCC 标志**（`-O3` vs `-O0`、`-DASSERT`）
- **哪些 Java 模块被包含**（通过 `--disable-module`）
- **最终 .so 的大小和功能**（标准 libjvm.so ≈ 180MB slowdebug vs 最小 ≈ 8MB release）

### 3.2.1 JVM 变体（--with-jvm-variants）

变体是一个**预定义的特性组合**，对应不同的使用场景。选变体就等于选了一套默认的特性列表。

```
                         --with-jvm-variants=
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
      server              minimal             custom
   (生产默认)           (嵌入式极简)       (自定义特性列表)
```

**6 种变体定义**（`make/autoconf/hotspot.m4:535-545`）：

| 变体 | 特性组成 | libjvm.so 大小 | 适用场景 |
|------|---------|:---:|---------|
| **server** | c1 + c2 + 全部 GC（7 种）+ jfr + jvmci + aot + graal | ~180MB | 生产服务器（默认） |
| **client** | c1 + 全部 GC（无 c2） | ~60MB | 桌面 GUI 应用 |
| **minimal** | c1 + serialgc + minimal 宏 + link-time-opt | ~24MB | 嵌入式/IoT |
| **core** | 无编译器（仅解释器）+ 全部 GC | ~30MB | 极简运行时 |
| **zero** | C++ 解释器（无汇编）+ 全部 GC | ~50MB | 新平台移植 |
| **custom** | 用户指定的完整特性列表 | 不定 | 自定义裁剪 |

**定义细节**（`hotspot.m4:520-543`）：

```bash
# ① 首先定义 NON_MINIMAL_FEATURES（server/client 共享的"非极简"特性）
NON_MINIMAL_FEATURES="cmsgc g1gc parallelgc serialgc epsilongc shenandoahgc \
    jni-check jvmti management nmt services vm-structs zgc"  # :520

# ② 然后根据 variant 组合特性
JVM_FEATURES_server="compiler1 compiler2 $NON_MINIMAL_FEATURES \
    $JVM_FEATURES $JVM_FEATURES_jvmci $JVM_FEATURES_aot $JVM_FEATURES_graal"  # :539

JVM_FEATURES_client="compiler1 $NON_MINIMAL_FEATURES $JVM_FEATURES"  # :540

JVM_FEATURES_minimal="compiler1 minimal serialgc $JVM_FEATURES \
    $JVM_FEATURES_link_time_opt"  # :542
```

> **关键差异**：`server` 和 `client` 共享 `NON_MINIMAL_FEATURES`（11 种特性），区别仅在于 server 多了 compiler2 + jvmci + aot + graal。从代码量看，compiler2（129 个 `opto/` 文件）是最大的差异因子。

每个 variant 编译到**独立子目录**，避免变体间的编译产物干扰：

```
build/linux-x86_64-normal-server-slowdebug/hotspot/
├── variant-server/libjvm/obj/      ← server 的 .o 文件
├── variant-minimal/libjvm/obj/     ← minimal 的 .o 文件
└── variant-core/libjvm/obj/        ← core 的 .o 文件
```

### 3.2.2 JVM 特性（--with-jvm-features）

选完变体后，可以用 `--with-jvm-features` 微调特性列表——增加或删除特定特性。

**完整的特性集合**（22 个 ifeq 分支，`JvmFeatures.gmk:32-191`）：

```
┌──────────────────────────────────────────────────────────────────┐
│                    JVM 特性全景（22 个开关）                       │
├──────────────┬──────────────┬──────────────┬─────────────────────┤
│ 编译器       │ GC           │ 诊断/监控     │ 平台/其他           │
├──────────────┼──────────────┼──────────────┼─────────────────────┤
│ compiler1    │ g1gc         │ jfr          │ link-time-opt       │
│ compiler2    │ parallelgc   │ jvmti        │ static-build         │
│ zero         │ serialgc     │ management   │ dtrace               │
│              │ cmsgc        │ services     │ aot                  │
│              │ epsilongc    │ vm-structs   │ jvmci                │
│              │ zgc          │ nmt          │                      │
│              │ shenandoahgc │ cds          │                      │
│              │              │ jni-check    │                      │
│              │              │ minimal      │                      │
└──────────────┴──────────────┴──────────────┴─────────────────────┘
```

**特性开关的三层控制**（`JvmFeatures.gmk` 对每个特性做三件事）：

```makefile
# 以 compiler2 为例（:38-44）
ifeq ($(call check-jvm-feature, compiler2), true)
  JVM_CFLAGS_FEATURES += -DCOMPILER2           # ① 定义 C 宏（开启 #ifdef 代码）
else
  JVM_EXCLUDE_FILES += bcEscapeAnalyzer.cpp ... # ② 排除单个 .cpp 文件
  JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/    # ③ 排除整个子目录（按路径模式）
endif
```

> **从概念到产物**：`--with-jvm-features=compiler1,serialgc` 会穿过三层：① `configure` 将特性字符串写进 `spec.gmk` → ② `JvmFeatures.gmk` 将 `compiler2` 未选中的分支展开成 `EXCLUDE_PATTERNS += opto libadt` → ③ `CompileJvm.gmk:157` 的 `EXCLUDES`/`EXCLUDE_FILES` 过滤掉这些目录和文件。最终 `g++` 的命令行只包含允许编译的文件。

### 3.2.3 调试等级（--with-debug-level）

三级渐变控制编译优化和调试符号：

| 等级 | GCC flags | ASSERT 宏 | libjvm.so 大小 | 适用 |
|------|----------|:---:|:---:|------|
| **release** | `-O3 -g0 -DNDEBUG` | 关闭 | ~20MB | 生产部署 |
| **fastdebug** | `-O0 -g -DASSERT` | 开启 | ~80MB | 开发调试 |
| **slowdebug** | `-O0 -g -DASSERT` | 开启 + 额外检查 | ~180MB | **源码深度分析** |

三者关系不是线性叠加。`fastdebug` 和 `slowdebug` 差异在于 `slowdebug` 额外禁用了内联、开启了更多运行时检查——这使得 GDB 断点能够精确命中每一行源码，而不会被内联优化扰乱。

> **本书的环境**：`build/linux-x86_64-normal-server-slowdebug/`——所有分析基于 slowdebug 构建。这保证：
> 1. 行号精确（`-O0` 无重排）
> 2. assert/guarantee 全活跃（能抓到内部不一致）
> 3. `objdump -S libjvm.so` 可以逐行对照 C++ 和汇编

### 3.2.4 模块排除（--disable-module）

除了 JVM C++ 裁剪，`configure` 还可以排除整个 Java 模块：

```bash
./configure \
  --disable-module=java.desktop \    # AWT/Swing（GUI 应用不需要）
  --disable-module=java.sql \        # JDBC
  --disable-module=java.xml \        # XML 解析
  --disable-module=jdk.jconsole \    # JConsole GUI
  --disable-module=jdk.jdi           # Java Debug Interface
```

排除后这些模块不会被编译，也不出现在最终的 `images/jdk/` 中。

**JDK 11 核心模块依赖链**：

```
java.base ← jdk.hotspot.agent ← jdk.jdwp.agent
    ↑
java.logging ← java.management ← java.instrument
```

`java.base` 不可排除（它是模块图的根）。其他模块的排除需要遵循依赖关系——排除了 `java.management` 就不能保留 `java.instrument`（它依赖 management）。

**关键要点**：

- 变体 = 预定义配方，特性 = 精确调味，调试等级 = 火候
- `--with-jvm-features` 的三层控制：C 宏 + 排除文件 + 排除目录
- `slowdebug` 是本书标准——行号精确、assert 全开、可反汇编对照
- 模块排除影响 Java 类库裁剪，不能破坏模块依赖图

---

## 3.3 make jdk-image — 7 阶段详解

`make jdk-image` 是顶层 target。`Main.gmk` 展开成 7 个阶段。（`Main.gmk` 总长 1189 行——看起来大，但 70% 是注释和声明。）

### 阶段 ① gensrc：生成源代码

**做什么**：并非所有代码都是手写的。构建系统会在编译前**根据平台和配置动态生成 `.java` 和 `.h`**。

```
┌─────────────────────────────────────────────────────────────┐
│                   gensrc 阶段                                │
├──────────────┬──────────────────────┬───────────────────────┤
│ Gensrc.gmk   │ 字符映射表生成        │ java.lang.Character   │
│              │ 时区数据生成          │ java.time.ZoneId      │
│              │ 货币数据生成          │ java.util.Currency   │
│              │ 模块描述符生成         │ module-info.java     │
│              │ 注解处理器运行         │ 各种 service 声明    │
├──────────────┼──────────────────────┼───────────────────────┤
│ Generate-    │ JVM 版本信息          │ vm_version.cpp        │
│ Sources.gmk  │ 架构描述 (AD) 文件    │ x86.ad → ad_x86.cpp   │
│ (/hotspot)  │ JVMTI 文件生成        │ jvmtiEnter.cpp       │
│              │ 日志标签展开         │ logTag.hpp            │
└──────────────┴──────────────────────┴───────────────────────┘
```

**关键依赖**：`Main.gmk:119` — 每个模块的 `gensrc-src` target 先执行 `Gensrc.gmk` 中的规则。

**输入**：手写 `.java`、`.ad`（架构描述）、模板 `.hpp`、XML 配置
**输出**：`build/*/support/gensrc/` 下的 `.java`、`.hpp`、`.cpp`

### 阶段 ② java：编译 Java 模块

**做什么**：将 `src/java.base/share/classes/` 等目录的 `.java` 编译为 `.class`，每个模块独立编译，最终打包为 `.jmod`。

```
src/java.base/share/classes/java/lang/Object.java
    │
    ├── javac → build/*/support/modules_libs/java.base/_the.java.base_batch
    │              │
    │              └── *.class 文件
    │
    └── jmod → build/*/images/jmods/java.base.jmod
```

**规则**：`CompileJavaModules.gmk` — 每个模块一套 compile target。`Main.gmk:741` 声明 `$m-java: $m-gensrc`（编译 Java 前先完成源码生成）。

**输入**：`src/<module>/share/classes/*.java` + gensrc 产出
**输出**：`build/*/support/modules_libs/<module>/` 下的 `.class` 文件集合

### 阶段 ③ hotspot：编译 libjvm.so ⭐

这是全构建最耗时、也最关键的一步。

```makefile
# CompileJvm.gmk:153 — 单次调用编译全部 JVM 源码
$(eval $(call SetupNativeCompilation, BUILD_LIBJVM, \
    NAME := jvm,                            # 输出: libjvm.so
    TOOLCHAIN := TOOLCHAIN_LINK_CXX,        # 用 g++ 编译 + 链接
    OUTPUT_DIR := $(JVM_LIB_OUTPUTDIR),     # 输出路径
    SRC := $(JVM_SRC_DIRS),                 # ★ 源文件目录列表
    EXCLUDES := $(JVM_EXCLUDES),            # ★ 排除的目录 (由 JvmFeatures 决定)
    EXCLUDE_FILES := $(JVM_EXCLUDE_FILES),  # ★ 排除的具体文件
    EXCLUDE_PATTERNS := $(JVM_EXCLUDE_PATTERNS), # ★ 排除的文件名模式
    CFLAGS := $(JVM_CFLAGS),               # -DCOMPILER1 -DCOMPILER2 ...
    LIBS := $(JVM_LIBS),                   # -lpthread -ldl -lrt ...
    MAPFILE := $(JVM_MAPFILE),             # 符号导出控制
))
```

**`SRC` 解析**（`JvmFlags.gmk:1-10` → `JVM_SRC_ROOTS += $(TOPDIR)/src/hotspot`）：
`JVM_SRC_DIRS` 由 `JvmFlags.gmk` 展开为 `src/hotspot/` 下所有实际存在的子目录，包括：
- `src/hotspot/share/` — 跨平台代码（主体）
- `src/hotspot/os/linux/` — Linux 平台特定
- `src/hotspot/os_cpu/linux_x86/` — Linux+x86_64 特定
- `src/hotspot/cpu/x86/` — x86_64 架构特定

**单个文件的编译命令**（`build.log` 中可见）：

```bash
g++ -MMD -MF .../arguments.o.d \
  -DCOMPILER1 -DCOMPILER2 -DINCLUDE_JFR=1 \  # ← JVM_CFLAGS_FEATURES
  -O0 -g -DASSERT \                          # ← slowdebug
  -I...                                       # ← include 路径
  -c src/hotspot/share/runtime/arguments.cpp \
  -o build/*/hotspot/variant-server/libjvm/objs/arguments.o
```

**链接阶段**：

```bash
g++ -shared -o libjvm.so \
  build/*/hotspot/variant-server/libjvm/objs/*.o \  # ~1800 个 .o 文件
  -lpthread -ldl -lrt -lstdc++                       # 系统库
```

**输入**：`src/hotspot/` 下 ~1800 个 C++ 文件（受 JvmFeatures 过滤）
**输出**：`build/*/hotspot/variant-server/libjvm/libjvm.so`

### 阶段 ④ libs：编译其他原生库

除了 `libjvm.so`，JDK 还有 30+ 个小型原生库：

```bash
# CompileLibraries.gmk → SetupNativeCompilation 每次一个库
BUILD_LIBJAVA     → libjava.so      # Java 核心原生方法
BUILD_LIBNIO      → libnio.so       # NIO 通道（EPoll/IOCP）
BUILD_LIBNET      → libnet.so       # 网络（Socket/SSL）
BUILD_LIBZIP      → libzip.so       # ZIP/JAR 压缩
BUILD_LIBFONTMANAGER → libfontmanager.so  # 字体渲染
# ... ~30 个库
```

**输入**：`src/java.desktop/share/native/` 等目录的 `.c`/`.cpp` 文件
**输出**：`build/*/support/modules_libs/<module>/lib*.so`

### 阶段 ⑤ launcher：编译启动器

`bin/java` 不是 `libjvm.so` 的符号链接。它是一个独立的二进制文件——核心代码在 `src/java.base/share/native/libjli/java.c`。

```c
// java.c — JLI_Launch() 是 Java 启动的入口
int JLI_Launch(int argc, char ** argv, ...) {
    // 1. 解析 VM 参数
    // 2. 加载 libjvm.so → dlsym("JNI_CreateJavaVM")
    // 3. 调用 JNI_CreateJavaVM → 初始化 JVM
    // 4. 加载主类 → 调用 main()
}
```

**关键**：`CompileLaunchers.gmk` 编译这个启动器。launcher 本身约 50KB——它只是一个加载 `libjvm.so` 的简单壳。所有的 JVM 逻辑都在 `libjvm.so` 内部。

**输入**：`src/java.base/share/native/libjli/*.c`
**输出**：`build/*/jdk/bin/java`（exploded）→ `images/jdk/bin/java`（jlink 后）

### 阶段 ⑥ exploded-image：中间组装

```makefile
# Main.gmk:1071 — exploded-image-base 依赖 $(ALL_MODULES)
exploded-image-base: $(ALL_MODULES)   # 所有模块的 java+libs 阶段完成后
```

这一步把各模块的编译产物"拼"到一起，形成一个**可以直接运行**的中间产物。`build/*/jdk/bin/java` 是一个脚本包装器——它设置正确的 `LD_LIBRARY_PATH` 指向 `build/*/jdk/lib/server/`，然后执行真实的启动器。

> **开发者的最佳实践**：改完 HotSpot 源码后，`make hotspot` 只重编 `libjvm.so`，然后在 exploded image 中直接运行验证。跳过 jlink 阶段节省 5-10 秒。

**输入**：阶段 ②③④⑤ 的全部产物
**输出**：`build/*/jdk/`（完整可运行的 JDK，未经 jlink 压缩）

### 阶段 ⑦ jlink：最终打包

```makefile
# Images.gmk:91-98 — jlink 命令
$(JDK_IMAGE_DIR)/$(JIMAGE_TARGET_FILE): $(JMODS) \
    $(call DependOnVariable, JDK_MODULES_LIST) $(BASE_RELEASE_FILE)
	$(RM) -r $(JDK_IMAGE_DIR)
	$(JLINK_TOOL) --add-modules $(JDK_MODULES_LIST) \
	    --module-path $(IMAGES_OUTPUTDIR)/jmods \
	    --output $(JDK_IMAGE_DIR) \
	    --keep-packaged-modules $(JDK_IMAGE_DIR)/jmods
```

jlink 不是简单的 `cp`——它：
1. 读取所有 `.jmod` 文件
2. 解析模块依赖图（`module-info.class`）
3. 去掉未使用的类和资源
4. 压缩输出为 `modules` 文件（类似 `classes.jsa`）
5. 生成 `release` 文件（版本、构建时间、模块列表）

**最终产物结构**（`images/jdk/`）：

```
images/jdk/
├── bin/
│   ├── java               ← ELF 可执行文件（launcher）
│   ├── javac              ← Java 编译器
│   └── ... (30+ 工具)
├── lib/
│   ├── server/libjvm.so   ← HotSpot JVM
│   ├── jrt-fs.jar         ← JRT 文件系统实现
│   ├── rt.jar、charsets.jar 等
│   └── security/          ← CA 证书、安全策略
├── conf/
│   ├── logging.properties  ← JUL 配置
│   └── net.properties      ← 网络配置
├── modules                ← ★ jlink 压缩的模块镜像
├── release                ← ★ 版本信息（模块列表 + 构建时间）
├── jmods/                 ← ★ 归档的 jmod（`--keep-packaged-modules`）
└── legal/                 ← 第三方许可证
```

**关键要点**：

- 7 阶段由 `Main.gmk:32-1189` 的 target DAG 驱动，不是线性脚本
- hotspot 阶段是瓶颈——~1800 个 C++ 文件用单作业 `g++` 编译（支持 `-jN` 并行）
- exploded image 是开发加速器：跳过 jlink 省 5-10 秒
- jlink 做三件事：解析模块依赖、去未用类、压缩输出

---

## 3.4 JVM 特性条件编译 — 裁剪刀核心

`JvmFeatures.gmk`（`make/hotspot/lib/JvmFeatures.gmk`）是整个构建系统中**最直接影响 HotSpot 二进制大小的文件**。它的 22 个 `ifeq` 分支（:32-191）构成了"裁剪刀"——每关一个特性，对应删除一组源码文件。

### 3.4.1 22 个 ifeq 分支全景

```
JvmFeatures.gmk 的 22 个 ifeq：
    │
    ├── :32  compiler1       → -DCOMPILER1 或排除 c1_/c1/
    ├── :38  compiler2       → -DCOMPILER2 或排除 opto/ + libadt/ + 135 文件
    ├── :47  zero            → -DZERO -DCC_INTERP (C++ 解释器)
    ├── :55  minimal         → -DMINIMAL_JVM -DVMTYPE="Minimal"
    ├── :63  dtrace          → -DDTRACE_ENABLED
    ├── :67  static-build    → -DSTATIC_BUILD=1
    ├── :70  jvmti           → -DINCLUDE_JVMTI=1/0 + 16 个文件
    ├── :79  jvmci           → -DINCLUDE_JVMCI=1/0 + CodeInstaller
    ├── :85  vm-structs      → -DINCLUDE_VM_STRUCTS + vmStructs.cpp
    ├── :90  jni-check       → -DINCLUDE_JNI_CHECK + jniCheck.cpp
    ├── :95  services        → -DINCLUDE_SERVICES + heapDumper 等 6 文件
    ├── :101 management      → -DINCLUDE_MANAGEMENT
    ├── :105 cds             → -DINCLUDE_CDS + 11 个文件
    ├── :121 nmt             → -DINCLUDE_NMT + 5 个文件
    ├── :128 aot             → -DINCLUDE_AOT + 5 个 aot*.cpp
    ├── :136 cmsgc           → 排除 gc/cms
    ├── :141 g1gc            → 排除 gc/g1 (193 文件)
    ├── :146 parallelgc     → 排除 gc/parallel
    ├── :151 serialgc        → 排除 gc/serial
    ├── :158 epsilongc       → 排除 gc/epsilon
    ├── :163 zgc             → 排除 gc/z
    ├── :168 shenandoahgc    → 排除 gc/shenandoah
    └── :173 jfr             → -DINCLUDE_JFR=0 + 排除 jfr/ (215 文件)
```

### 3.4.2 特性控制的三重机制

每个特性开关精确控制编译器看到的内容：

| 机制 | 语法 | 效果 | 示例 |
|------|------|------|------|
| **编译宏** | `JVM_CFLAGS_FEATURES += -DXXX` | 传递给 `g++ -D`，影响 `#ifdef` 分支 | `-DCOMPILER2` → `#ifdef COMPILER2` 生效 |
| **排除文件** | `JVM_EXCLUDE_FILES += x.cpp` | 该 `.cpp` 不出现在 `g++` 命令行 | `bcEscapeAnalyzer.cpp` 不被编译（虽然用了 C2 的类） |
| **排除目录** | `JVM_EXCLUDE_PATTERNS += dir/` | 整个子目录不参与编译 | `opto/`, `gc/g1/`, `jfr/` |

这三层是**独立的**——一个文件可能同时被排除文件和排除目录命中。Make 会去重，最终传递一个精确的文件列表给 `g++`。

### 3.4.3 完整链路：关掉 compiler2 砍掉 135 文件

这是一个"从命令行到 .o 消失"的端到端验证。

**第 1 步：configure**

```bash
./configure --with-jvm-features=compiler1,jvmti,services   # 不加 compiler2
```

**第 2 步：spec.gmk 中的变量**

```makefile
# spec.gmk 中 JVM_FEATURES="compiler1;serialgc;jvmti;services;..."
# 注意：compiler2 不在列表中
```

**第 3 步：JvmFeatures.gmk:38-44 展开**

```makefile
# check-jvm-feature(compiler2) → false → 进入 else 分支
JVM_EXCLUDES += opto libadt                    # 排除 2 个目录
JVM_EXCLUDE_FILES += bcEscapeAnalyzer.cpp \    # 排除 6 个单文件
                     ciTypeFlow.cpp \
                     ...
JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/     # 排除命名模式
```

**第 4 步：CompileJvm.gmk:153 收到过滤后的源文件列表**

```makefile
$(eval $(call SetupNativeCompilation, BUILD_LIBJVM, \
    ...
    EXCLUDES := $(JVM_EXCLUDES),            # opto libadt
    EXCLUDE_FILES := $(JVM_EXCLUDE_FILES),   # bcEscapeAnalyzer.cpp ...
    EXCLUDE_PATTERNS := $(JVM_EXCLUDE_PATTERNS), # c2_ runtime_ /c2/
    ...
))
```

`SetupNativeCompilation` 内部做：`源文件列表 -= (EXCLUDES 匹配) ∪ (EXCLUDE_FILES 匹配) ∪ (EXCLUDE_PATTERNS 匹配)`

**第 5 步：验证——检查 .o 文件**

```bash
# standard build (含 compiler2)
$ ls build/*/hotspot/variant-server/libjvm/objs/ | grep -c ""   # 约 1800 个 .o

# 关掉 compiler2 后
$ ls build/*/hotspot/variant-server/libjvm/objs/ | grep -c ""   # 约 1665 个 .o
# 少掉的 135 个：
$ ls build/*/hotspot/variant-server/libjvm/objs/ | grep "opto\|libadt"  # 空！
```

### 3.4.4 典型裁剪场景的精确影响

| 关掉的特性 | 从 .o 中消失 | 文件数 | libjvm.so 减小 |
|-----------|-------------|:---:|:---:|
| compiler2 | opto/ libadt/ c2 模式文件 | ~135 | ~25MB |
| jfr | jfr/（全部 215 文件） | ~215 | ~35MB |
| g1gc | gc/g1/ | ~193 | ~22MB |
| zgc | gc/z/ | ~45 | ~8MB |
| shenandoahgc | gc/shenandoah/ | ~55 | ~10MB |
| cds | filemap/heapShared/metaspaceShared 等 | ~11 | ~3MB |
| jvmci | jvmci/ + CodeInstaller | ~22 | ~5MB |
| aot | aot*.cpp | ~5 | ~1MB |

**关键要点**：

- `JvmFeatures.gmk` 的 22 个 ifeq 是"编译前的最后一关"——configure 只决定特性集合，这里决定文件过滤
- 三重机制（宏、文件、目录）独立运作，Make 去重后给出精确文件列表
- 关掉 compiler2 不是只去掉 `#ifdef COMPILER2` 内的代码——而是整个 `opto/` 目录都不编译
- 文件数精确可验证：`ls build/*/hotspot/variant-*/libjvm/objs/ | wc -l`

---

## 3.5 Images.gmk 与 jlink — 从零件到成品

`make jdk-image` 的前 6 个阶段产生"零件"——libjvm.so、.class 文件、原生库。第 7 阶段 jlink 负责"装配"——将 `.jmod` 零件组装成一个可运行、可分发的 JDK。

### 3.5.1 .jmod：装配前的零件盒

`.jmod` 是 JDK 9+ 引入的模块归档格式，类似 `.jar` 但支持原生代码。

```
java.base.jmod
├── classes/                 ← 编译后的 .class 文件
│   └── java/lang/Object.class
├── lib/                     ← 该模块的原生库
│   ├── libjava.so
│   └── libjimage.so
├── bin/                     ← 原生可执行文件
│   └── java                (launcher)
├── conf/                    ← 配置文件
│   └── net.properties
├── legal/                   ← 许可证
└── module-info.class        ← ★ 模块描述符
```

**关键模块列表**（`Images.gmk:41-51`）：

```
JDK_MODULES = java.base java.logging java.management java.instrument \
              jdk.hotspot.agent jdk.jdwp.agent jdk.management ...
```

`java.base` 必须存在于所有 JDK 镜像中——它是模块图的根（所有其他模块都依赖它）。

### 3.5.2 jlink 做什么

```bash
# Images.gmk:96-98 — jlink 命令
$(JLINK_TOOL) --add-modules $(JDK_MODULES_LIST) \
    --module-path $(IMAGES_OUTPUTDIR)/jmods \
    --output $(JDK_IMAGE_DIR) \
    --keep-packaged-modules $(JDK_IMAGE_DIR)/jmods
```

jlink 不是"复制文件"——它是一个分析器 + 打包器：

```
jlink 内部管线：
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  1. 读取 module-path 下所有 .jmod                                        │
│       │                                                                  │
│       ▼                                                                  │
│  2. 从 module-info.class 解析模块依赖图                                   │
│     java.base ← java.logging ← java.management                          │
│       │                                                                  │
│       ▼                                                                  │
│  3. 传递性闭包：从指定 root 模块出发，只保留可达的模块                       │
│     --add-modules java.base → 只打包 java.base（4MB vs 完整 200MB）        │
│       │                                                                  │
│       ▼                                                                  │
│  4. 去除未使用的资源（Dead resource elimination）                          │
│     未引用的 .class 文件、未调用的原生库 → 不进入 image                    │
│       │                                                                  │
│       ▼                                                                  │
│  5. 生成 modules 压缩文件（JIMAGE 格式）                                   │
│     所有模块数据打包为单文件 → 快速的运行时 class 查找                       │
│       │                                                                  │
│       ▼                                                                  │
│  6. 输出 images/jdk/                                                     │
│     bin/ + lib/ + conf/ + modules + release                              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.5.3 explode image vs jlink image

exploded image 是开发用的中间产物，jlink image 是最终分发物。它们不是"两个版本"而是"两个阶段"：

| 维度 | exploded image (`build/*/jdk/`) | jlink image (`build/*/images/jdk/`) |
|------|-------------------------------|-------------------------------------|
| bin/java | 脚本包装器（设置 LD_LIBRARY_PATH） | 真实 ELF 二进制 |
| modules | 展开的 class 文件目录树 | 压缩的 JIMAGE 文件 |
| 大小 | ~800MB（slowdebug） | ~300MB（无 .o 文件） |
| 用途 | 开发调试（改 libjvm.so 后直接生效） | 分发（tar.gz 给用户） |
| 构建时间 | 快（仅 assembly） | 慢（需 jlink 分析 + 打包 + 压缩） |

> **记忆公式**：exploded = 你的工作台，jlink image = 你发给客户的成品。

**关键要点**：

- `.jmod` 是 jlink 的输入格式——一个模块 = 一个归档（含 .class + .so + 元信息）
- jlink 做传递性闭包——只打包 `--add-modules` 可达的模块
- exploded image 用于开发，jlink image 用于分发——二进制内容相同，格式不同

---

## 3.6 实战：构建一个最小化 JDK

本节给出一个端到端的完整示例——从干净的 `configure` 到一个可运行的最简 JDK。

### 目标

构建一个只含 `java.base` + 解释执行 + SerialGC 的最小 JDK。最小体积、最快编译时间、最适合源码阅读。

### 第 1 步：configure

```bash
cd /path/to/jdk11

# 最小化 configure
./configure \
  --with-jvm-variants=minimal \
  --with-jvm-features=compiler1,serialgc,jvmti,services \
  --with-debug-level=slowdebug \
  --disable-module=java.desktop \
  --disable-module=java.sql \
  --disable-module=java.xml \
  --disable-module=java.rmi \
  --disable-module=java.management \
  --disable-module=java.instrument \
  --disable-module=java.prefs \
  --disable-module=jdk.attach \
  --disable-module=jdk.jdi \
  --disable-module=jdk.jdwp.agent \
  --disable-module=jdk.jconsole \
  --disable-module=jdk.management \
  --disable-module=jdk.unsupported \
  --disable-module=jdk.net \
  --disable-module=jdk.sctp \
  --disable-module=jdk.security.auth \
  --disable-module=jdk.security.jgss \
  --disable-module=jdk.xml.dom \
  --disable-module=jdk.zipfs

# 输出（关键行）：
#   OpenJDK target: linux-x86_64-normal-minimal-slowdebug
#   JVM Variants:   minimal
#   JVM Features:   compiler1, serialgc, jvmti, services, ...
#   JDK Modules:    java.base, java.logging
```

**参数解释**：
- `--with-jvm-variants=minimal` — 最小化变体（只有 c1 + serialgc）
- `--with-jvm-features=compiler1,serialgc,jvmti,services` — 明确指定特性（minimal 默认有 serialgc，这里为了可读性显式列出）
- `--with-debug-level=slowdebug` — 本书标准（assert 全开、行号精确）
- `--disable-module=...` — 排除所有非 java.base 的模块

### 第 2 步：make

```bash
make jdk-image

# 输出（简化）：
# Building target 'jdk-image' in configuration 'linux-x86_64-normal-minimal-slowdebug'
# Compiling 1 files for BUILD_TOOLS_LANGTOOLS
# Compiling 380 files for BUILD_LIBJVM
# ...
# Creating jdk image
```

**编译时间（单线程，-j1）**：

| 步骤 | 时间 |
|------|:---:|
| java.base 编译 | ~30s |
| hotspot 编译（380 文件） | ~2min |
| jlink 打包 | ~5s |
| **总计** | ~3min |

对比标准 server slowdebug：~1800 文件，需要 ~12min。裁剪后编译时间缩减 **4 倍**。

### 第 3 步：产物验证

```bash
# ① 确认结构
$ ls build/linux-x86_64-normal-minimal-slowdebug/images/jdk/
bin/  conf/  legal/  lib/  modules  release

# ② 检查 bin/java 是真实 ELF
$ file build/linux-x86_64-normal-minimal-slowdebug/images/jdk/bin/java
bin/java: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked

# ③ 检查 libjvm.so 大小
$ ls -lh build/*/images/jdk/lib/server/libjvm.so
-rwxr-xr-x 1 root root 24M Jun 20 10:00 libjvm.so
# 对比标准 server slowdebug: ~180MB

# ④ 验证功能——运行一个 Hello World
$ echo 'public class Hello { public static void main(String[] a) { System.out.println("Hello!"); } }' > Hello.java

$ build/*/images/jdk/bin/javac Hello.java
$ build/*/images/jdk/bin/java Hello
Hello!

# ⑤ 确认只用了 interpreter 和 SerialGC
$ build/*/images/jdk/bin/java -Xlog:gc -XX:+UseSerialGC -version 2>&1 | head -3
[0.003s][info][gc] Using Serial
```

### 第 4 步：看编译了哪些 .o 文件

```bash
$ ls build/*/hotspot/variant-minimal/libjvm/objs/ | wc -l
380
# 标准 server: ~1800

$ ls build/*/hotspot/variant-minimal/libjvm/objs/ | grep "opto"
# 空输出 — compiler2 被正确地排除了

$ ls build/*/hotspot/variant-minimal/libjvm/objs/ | grep "g1"
# 空输出 — G1 GC 被正确地排除了
```

**关键要点**：

- 最小化 JDK 编译只需 3 分钟（vs 12 分钟全量），380 个源文件（vs 1800）
- `libjvm.so` 只有 24MB（vs 180MB slowdebug），阅读时 grep/ctags 性能显著提升
- 功能完整：解释执行 + SerialGC + JVMTI 全有——足够运行大多数 Java 程序
- 每次改源码后的 `make hotspot` 重编 ~1 分钟内完成

---

## 3.7 调试构建 — slowdebug 的秘密

本书使用的 `--with-debug-level=slowdebug` 不是 `fastdebug` 的同义词。三级调试等级的差异反映在编译标志、运行时行为和 libjvm.so 大小上。

### 3.7.1 三级差异对比

| 维度 | release | fastdebug | slowdebug |
|------|---------|-----------|-----------|
| **优化等级** | `-O3` | `-O0` | `-O0` |
| **调试符号** | `-g0`（无） | `-g`（完整） | `-g`（完整） |
| **assert 宏** | `-DNDEBUG`（关闭） | `-DASSERT`（开启） | `-DASSERT`（开启） |
| **内联** | 激进 | 可选 | **禁止内联** |
| **运行时检查** | 最少 | assert + guarantee | assert + guarantee + 额外检查 |
| **GDB 体验** | 行漂移，变量优化掉 | 基本可用 | **完美：每行一个断点** |
| **libjvm.so** | ~20MB | ~80MB | ~180MB |
| **启动时间** | 快 | 中等 | 慢（大量 assert 初始化） |

### 3.7.2 slowdebug 独有特性

**① 禁止内联**——编译器优化中最影响 GDB 的优化。内联会将一个函数调用展开到调用者体内，导致：
- 断点位置偏移（源码的行号不再对应汇编指令）
- `backtrace` 丢失中间帧
- `print this` 显示错误值

slowdebug 通过 GCC 标志禁用内联后，每个函数调用在汇编层面保持独立——GDB 的 `step`/`next`/`frame`/`print` 100% 精确。

**② assert/guarantee 全开**——HotSpot 内部有数千个断言：

```cpp
// 运行时检查（仅 debug 生效）
assert(size <= _reserved_size, "size too large");     // runtime/arguments.cpp
guarantee(thread != NULL, "thread must be set");      // runtime/thread.cpp
ShouldNotReachHere();                                   // 所有 default 分支
```

这些检查在 release 中被 `-DNDEBUG` 完全移除（运行时零开销）。在 slowdebug 中全活跃——帮助发现内部状态不一致。

**③ `objdump -S` 可对照**——由于没有优化重排，汇编指令顺序严格对应源码行号：

```bash
$ objdump -S build/*/hotspot/variant-server/libjvm/libjvm.so | less
# 定位到任意函数，汇编和 C++ 一行对一行
```

### 3.7.3 三种调试等级的适用场景

```
release    → 性能基准测试、生产部署——不需要 GDB，只要跑得快
fastdebug  → 日常开发——assert 帮你抓到 bug，性能损耗可接受
slowdebug  → 源码深度分析——本书场景：行级 GDB、反汇编对比、assert 兜底
```

**关键要点**：

- slowdebug ≠ fastdebug：禁止内林是本质区别——决定 GDB 体验
- -O0 导致 libjvm.so 膨胀 9 倍（20MB → 180MB），原因是每个函数独立编译、无死代码消除
- slowdebug 的 assert 全开是双刃剑：帮你抓 bug，但启动时间显著增加

---

## 3.8 自定义开发工作流

本书的阅读方式是"边改边看"——改一段源码，编译验证，GDB 跟踪执行。以下是最高效的迭代循环。

### 3.8.1 标准循环：改 → 编 → 测

```
┌─────────────────────────────────────────────────────────────┐
│                    开发者迭代循环                            │
│                                                             │
│  ① 修改源码                                                 │
│     vim src/hotspot/share/runtime/arguments.cpp              │
│        │                                                    │
│        ▼                                                    │
│  ② 增量编译 libjvm.so  ⭐ 最常用                              │
│     make hotspot                                            │
│        │              2 分钟内（只重新编译改动的 .o + 链接）    │
│        ▼                                                    │
│  ③ 在 exploded image 中验证（跳过 jlink）                     │
│     build/*/jdk/bin/java -version                           │
│        │              （直接使用新 libjvm.so）                 │
│        ▼                                                    │
│  ④ GDB 深度跟踪                                              │
│     gdb --args build/*/jdk/bin/java -cp . MyClass            │
│        │                                                    │
│        ▼                                                    │
│  ⑤ 确认无误后，完整构建                                       │
│     make jdk-image                                          │
│        │                                                    │
│        ▼                                                    │
│  ⑥ 最终产物验证                                              │
│     build/*/images/jdk/bin/java -version                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.8.2 ① 修改源码

本书的每个技术分析章节都指向 `src/hotspot/share/` 下的具体文件。修改后可以立即编译验证结论。

```bash
# 示例：给 arguments.cpp 加一行 printf（验证 JVM 参数解析顺序）
vim src/hotspot/share/runtime/arguments.cpp
# 在 Arguments::parse() 开头加：
#   tty->print_cr("=== Arguments::parse() called ===");
```

### 3.8.3 ② make hotspot — 只重编 libjvm.so

```bash
# 最常用的增量构建命令
make hotspot

# 原理：make 检测到 arguments.cpp 的 mtime > arguments.o，触发重编译
# 240 个 .o 中只有 arguments.o 被重新编译
# 然后重新链接 libjvm.so（整合 ~1800 个未改动的 .o + 1 个新的 arguments.o）

# 输出：
# Compiling src/hotspot/share/runtime/arguments.cpp
# Compiling src/hotspot/os/linux/os_linux.cpp (仅当改动了)
# Linking libjvm.so
```

> **时间对比**：
> - `make hotspot --only-changed` → ~30s（1 个 .o 重编译 + 链接）
> - `make hotspot --full` → ~12min（all 1800 files）
> - `make jdk-image --full` → ~15min（含 jlink）
> 
> 因此 `make hotspot` 是日常最高频命令。

### 3.8.4 ③ 在 exploded image 中验证

```bash
# exploded image 中的 java 是一个包装脚本
$ file build/*/jdk/bin/java
build/linux-x86_64-normal-server-slowdebug/jdk/bin/java: POSIX shell script

# 脚本内容：
$ cat build/*/jdk/bin/java | head -5
#!/bin/bash
LD_LIBRARY_PATH=.../lib/server:$LD_LIBRARY_PATH
exec .../bin/java "$@"

# 直接运行
$ build/*/jdk/bin/java -version
openjdk version "11.0.24-internal" 2024-08-20
# ★ 使用了刚编译的 libjvm.so
```

不需要 `make jdk-image`——exploded image 直接使用 `build/*/jdk/lib/server/libjvm.so` (硬链接到编译产物)。

### 3.8.5 ④ GDB 深度跟踪

```bash
# 启动 GDB
gdb --args build/*/jdk/bin/java -cp . MyClass

# 设置断点
(gdb) b arguments.cpp:220
(gdb) r

# 检查新加代码的执行
(gdb) n   # 逐行执行

# 检查宏展开
(gdb) info macro USE_COMPRESSED_OOPS
Expands to: 1

# 检查内存
(gdb) p _heap_alignment
$1 = 65536
```

**slowdebug 的 GDB 优势**：由于无内联 + 完整符号表，`backtrace` 能看到完整的调用链（包括 JVM 内部所有层），`print` 能直接访问私有成员变量。

### 3.8.6 其他增量构建技巧

```bash
# 只重编某个模块的 Java 类——用于验证 class library 修改
make java.base

# 只重编所有原生库（不含 hotspot）
make hotspot-libs    # libjvm.so
make libs            # 其他 .so（libjava, libnio 等）

# 只重新组装 exploded image
make exploded-image

# 只重新打包 jlink image（不改代码，只重新打包）
make jdk-image

# 清除某个模块的编译产物
make clean-hotspot   # 清除所有 .o，强制全量重编

# 完全清理（保留 configure）
make clean           # 删除 build/ 下所有产物（保留 spec.gmk）

# 重新 configure（参数有变化时）
make dist-clean
./configure ...      # 新的 spec.gmk
```

### 3.8.7 完整工作流示例

```bash
# 场景：验证 "Arguments::parse() 在 JVM 初始化中的调用顺序"

# 1. 加日志
echo 'void Arguments::parse(const JavaVMInitArgs* args) {' >> /tmp/patch
echo '  tty->print_cr("TRACE: Arguments::parse() called, nOptions=%d", args->nOptions);' >> /tmp/patch

# 2. 编辑源码
vim src/hotspot/share/runtime/arguments.cpp

# 3. 增量编译
make hotspot
# Compiling 1 files...
# Linking libjvm.so

# 4. 运行验证
build/*/jdk/bin/java -Xmx128m -XX:+PrintGCDetails -version
# TRACE: Arguments::parse() called, nOptions=3
# openjdk version "11.0.24-internal"

# 5. GDB 验证调用链
gdb --args build/*/jdk/bin/java -version
(gdb) b arguments.cpp:220
(gdb) r
(gdb) bt
# #0  Arguments::parse (this=0x..., args=0x...)
# #1  Arguments::parse_each_vm_init_arg (args=0x..., ...)
# #2  Threads::create_vm (args=0x..., ...)
# #3  JNI_CreateJavaVM (...)
# #4  JLI_Launch (...)
# #5  main (...)

# 6. 确认无误后回退
git checkout src/hotspot/share/runtime/arguments.cpp
make hotspot
```

**关键要点**：

- `make hotspot` 是增量编译的核心命令——通过 mtime 检测，只重编改动的文件
- exploded image 跳过 jlink——每次验证节省 5-10 秒
- slowdebug + GDB 组合：无内联保证断点精确，完整符号表保证 `print`/`backtrace` 可用
- 完整工作流：编辑 → `make hotspot` (30s) → 运行验证 (1s) → GDB 跟踪 → 回退

---

## 3.9 小结

本章从 `./configure` 到 `jdk.tar.gz` 走完了完整管线。以下是核心知识地图：

```
                 ./configure 的三大选择
                        │
        ┌───────────────┼─────────────────┐
        │               │                 │
   JVM 变体 →    JVM 特性 →          调试等级 →
   决定"哪种 JVM"  精确控制"编译哪些文件"  决定"怎么编译"
   server/client/   22个ifeq 三层控制  release/fastdebug/
   minimal/...     宏+排除文件+排除目录 slowdebug
                        │
                        ▼
              make jdk-image
                        │
    ┌───────────────────┼───────────────────┐
    │                   │                   │
  gensrc → java    →   hotspot   →   libs → launcher
  (生成源码)        (编译.class)   (libjvm.so)  (其他.so)  (bin/java)
    │                   │                   │
    └───────────────────┼───────────────────┘
                        │
                        ▼
                exploded image              jlink image
                (开发工作台)                (最终成品)
                build/*/jdk/            build/*/images/jdk/
```

**贯穿全书的关键操作**：

| 操作 | 命令 | 耗时 |
|------|------|:---:|
| 首次构建（最小化） | `configure ... && make jdk-image` | ~3min |
| 增量编译 JVM | `make hotspot` | ~30s |
| 快速验证 | `build/*/jdk/bin/java -version` | ~1s |
| GDB 深度跟踪 | `gdb --args build/*/jdk/bin/java -cp . MyClass` | 实时 |
| 最终打包 | `make jdk-image` | ~1min |

**三条铁律**：

1. **exploded image 是日常工具**：改完 HotSpot 源码，`make hotspot` → 在 `build/*/jdk/bin/java` 直接验证。不要每次都跑 jlink。
2. **slowdebug 是阅读前提**：`-O0` + 完整符号表 + assert 全开 → GDB 断点 100% 精确。不要用 release 或 fastdebug 做源码分析。
3. **JvmFeatures.gmk 是裁剪刀**：读不懂某段代码？先确认当前构建有没有编译它——`ls build/*/hotspot/variant-*/libjvm/objs/ | grep <关键词>` 一分钟验证。

现在你已经掌握了"编"和"裁"两个核心技能。接下来的每一章，你都可以：
- 改一段源码来验证结论（`make hotspot` 30 秒内生效）
- 用 GDB 在精确行号设置断点跟踪执行
- 通过 `ls *.o` 确认特定功能是否被编译进当前的 `libjvm.so`

---

**下一章**（附录）：`make/` 目录结构——构建系统本身的地图，包括 `autoconf/`、`Main.gmk`、`hotspot/lib/` 的详细文件清单。对于本章的每条规则，下一章告诉你"在哪个文件的哪一行定义的"。
