# Volume 0 — OpenJDK 构建系统：从源码到 libjvm.so

## §〇 现有资产清单

4 个 explore agent 并行探索后，发现构建系统内容已在 3 处出现：

### 1. book/00-prerequisites/03-build-and-customize.md — 1087 行书章 ✅

| 节 | 内容 | 状态 |
|---|------|:---:|
| 3.1 构建管道全景 | configure → make 7 阶段管线 ASCII 图 | ✅ |
| 3.2 configure | `--with-jvm-variants`, `--with-debug-level`, `--with-jvm-features` | ✅ |
| 3.3 make jdk-image | 7 阶段详解（gensrc/java/hotspot/libs/exploded/jlink） | ✅ |
| 3.4 JVM 特性条件编译 | JvmFeatures.gmk 的 EXCLUDE_PATTERNS/EXCLUDE_FILES 双机制 | ✅ |
| 3.5 Images.gmk 与 jlink | JDK/JRE 镜像组装、模块裁剪 | ✅ |
| 3.6 实战：构建最小化 JDK | `--with-jvm-variants=minimal` + `--disable-module` | ✅ |
| 3.7 slowdebug 的秘密 | ASSERT/DebugNonSafepoints/NMT 内部调试开关 | ✅ |
| 3.8 自定义开发工作流 | `make hotspot-only`、增量编译、compile_commands.json | ✅ |
| 3.9 小结 | 关键命令速查 + 推荐构建配置 | ✅ |

### 2. book/00-prerequisites/02-hotspot-source-guide.md — 527 行源码导读 ⚠️

| 覆盖 | 深度 |
|------|------|
| src/hotspot/ 四层目录结构 (share/os/cpu/os_cpu) | ✅ 全 |
| 23 个子目录职责表 | ✅ 全 |
| .so 映射（libjvm/libjava/libnio/...） | ⚠️ 仅列出 6 个，缺失 25+ 个 |
| 构建系统速览（configure → make） | ⚠️ 仅概述，深度在 03 章 |

### 3. Phase 29-build-customize — 5 篇 prompt 待生成 📝

| # | Prompt | 行数 | 质量 |
|:---:|--------|:---:|:---:|
| 00 | configure 系统 (hotspot.m4/platform.m4/toolchain.m4) | 252 | ⚠️ 低于 ≥450 标准 |
| 01 | Main.gmk 构建管线 | 283 | ⚠️ 低于标准 |
| 02 | HotSpot 编译 — libjvm.so 如何诞生 | 279 | ⚠️ 低于标准 |
| 03 | JDK 镜像组装 — jmod/jlink/exploded image | 236 | ⚠️ 低于标准 |
| 04 | 自定义裁剪实战 (JVM_FEATURES + JVM_VARIANTS) | 230 | ⚠️ 低于标准 |
| **合计** | | **1280** | **5 篇均需升级** |

---

## §一 定位：第 0 卷 vs Phase 29

```
┌─────────────────────────────────────────────────────────────┐
│                    Volume 0 — 构建系统                       │
│                                                             │
│  目标读者：拿到源码后不知道怎么编译的 Java 工程师              │
│  定位：    入门 + 速查 + 动手实战                             │
│  载体：    probe_md/book/00-prerequisites/                   │
│           ├── 02-hotspot-source-guide.md  （源码地图）         │
│           └── 03-build-and-customize.md    （构建全链路）       │
│                                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                             │
│                    Phase 29 — 构建深度参考                    │
│                                                             │
│  目标读者：需要自定义构建、调试构建系统本身的 JVM 开发者         │
│  定位：    工程级源码分析（对标 probe_md 其他 Phase）            │
│  载体：    probe_md/29-build-customize/docs/                  │
│           ├── 00-configure-system.md                        │
│           ├── 01-main-pipeline.md                           │
│           ├── 02-hotspot-compile.md                         │
│           ├── 03-image-assembly.md                          │
│           └── 04-trim-customize.md                          │
└─────────────────────────────────────────────────────────────┘
```

**关系**：Volume 0 是入门读物，引用 Phase 29 做深度延伸。读者读完 Volume 0 能"编译、运行、读懂构建输出"；需要定制构建或理解 make 系统内部才深入 Phase 29。

---

## §二 Volume 0 现有待办清单

### 待补：02-hotspot-source-guide.md 的 BUILD_LIBRARY 映射表

当前 02 章缺失 29 个 .so 的完整映射。Explore-1 已检索出全部 BUILD_LIBRARY 目标：

**HotSpot 核心**（4 个 .so）：

| BUILD_LIB* | .so | 源文件 |
|-----------|-----|--------|
| BUILD_LIBJVM | `libjvm.so` | `src/hotspot/{share,os/linux,os/posix,cpu/x86,os_cpu/linux_x86}` + gensrc |
| BUILD_LIBJVM_DTRACE | `libjvm_dtrace.so` | `src/java.base/solaris/native/libjvm_dtrace` (Solaris only) |
| BUILD_LIBJVM_DB | `libjvm_db.so` | `src/java.base/solaris/native/libjvm_db` (Solaris only) |
| BUILD_GTEST_LIBJVM | `libjvm.so` (gtest) | `test/hotspot/gtest` |

**JDK java.base 模块**（9 个 .so）：

| BUILD_LIB* | .so | 定义位置 |
|-----------|-----|---------|
| BUILD_LIBJAVA | `libjava.so` | `CoreLibraries.gmk:99` |
| BUILD_LIBVERIFY | `libverify.so` | `CoreLibraries.gmk:76` |
| BUILD_LIBZIP | `libzip.so` | `CoreLibraries.gmk:144` |
| BUILD_LIBJIMAGE | `libjimage.so` | `CoreLibraries.gmk:165` |
| BUILD_LIBJLI | `libjli.so` | `CoreLibraries.gmk:236` |
| BUILD_LIBNET | `libnet.so` | `Lib-java.base.gmk:42` |
| BUILD_LIBNIO | `libnio.so` | `Lib-java.base.gmk:69` |
| BUILD_LIBJSIG | `libjsig.so` | `Lib-java.base.gmk:139` |
| BUILD_LIBFDIBM | `libfdlibm.a` (静态) | `CoreLibraries.gmk:52` |

**其他 JDK 模块**（16 个 .so）：

| .so | 模块 | 定义位置 |
|-----|------|---------|
| libinstrument.so | java.instrument | Lib-java.instrument.gmk |
| libmanagement.so | java.management | Lib-java.management.gmk |
| libmanagement_ext.so | jdk.management | Lib-jdk.management.gmk |
| libmanagement_agent.so | jdk.management.agent | Lib-jdk.management.agent.gmk |
| librmi.so | java.rmi | Lib-java.rmi.gmk |
| libsunec.so | jdk.crypto.ec | Lib-jdk.crypto.ec.gmk |
| libj2pkcs11.so | jdk.crypto.cryptoki | Lib-jdk.crypto.cryptoki.gmk |
| libjaas.so | jdk.security.auth | Lib-jdk.security.auth.gmk |
| libj2gss.so | java.security.jgss | Lib-java.security.jgss.gmk |
| libattach.so | jdk.attach | Lib-jdk.attach.gmk |
| libdt_socket.so | jdk.jdwp.agent | Lib-jdk.jdwp.agent.gmk |
| libjdwp.so | jdk.jdwp.agent | Lib-jdk.jdwp.agent.gmk |
| libdt_shmem.so | jdk.jdi | Lib-jdk.jdi.gmk |
| libsa.so | jdk.hotspot.agent | Lib-jdk.hotspot.agent.gmk |
| libsctp.so | jdk.sctp | Lib-jdk.sctp.gmk |
| libextnet.so | jdk.net | Lib-jdk.net.gmk |

**AWT/图形**（10+ 个 .so）：

| .so | 定义位置 |
|-----|---------|
| libmlib_image.so, libawt.so, libawt_xawt.so, liblcms.so, libjavajpeg.so, libawt_headless.so, libfreetype.so, libfontmanager.so, libjawt.so, libsplashscreen.so | Awt2dLibraries.gmk |

### 可选新增：00-source-acquisition.md

当前书章没有讲怎么获取和选择 OpenJDK 版本。如果补充一小节：

```
§1. 从哪获取源码
  - hg clone https://hg.openjdk.java.net/jdk-updates/jdk11u-dev/
  - git mirror: github.com/openjdk/jdk11u-dev
  - 版本选择：JDK 11.0.17 的 TAG 对应关系
§2. 项目目录第一眼
  - src/hotspot/ vs src/java.base/ vs make/ 的关系
  - 构建一次需要多少磁盘空间 (~8GB)
  - 编译时间预估 (server variant: ~15min on 16-core)
```

内容量约 150 行，可以追加到 `02-hotspot-source-guide.md` 第 1 节，或独立为 `00-source-acquisition.md`。

---

## §三 Phase 29 升级计划

5 篇 prompt 均需升级至质量标准（≥450 行），然后在新会话中生成文档。

| # | 现有行数 | 需要扩容 | 新增内容 |
|:---:|:---:|:---:|---------|
| 00 | 252 → 450+ | **+200 行** | configure.ac 三层架构、spec.gmk 变量表、交叉编译、JVM_FEATURES 依赖图 |
| 01 | 283 → 450+ | **+170 行** | Main.gmk target 依赖 DAG、并行构建调度、增量逻辑 |
| 02 | 279 → 450+ | **+170 行** | 5 层过滤源码展示、JvmOverrideFiles 逐平台对照、mapfile 符号导出 |
| 03 | 236 → 450+ | **+210 行** | jlink 插件机制、模块裁剪清单、跨平台差异 |
| 04 | 230 → 450+ | **+220 行** | JVM_VARIANTS 5 种对比表、26 JVM_FEATURES 依赖矩阵、最小化验证 |

**工作流**（遵循项目约定）：
1. **会话 A**：3 子代理管线 (scout→reader→tracer) → 写出升级版 prompt
2. **会话 B**：读 prompt → 生成 5 篇文档
3. **Review**：12 项完整性 Checklist

---

## §四 执行顺序

```
Step 1 ─ 补 book/00-prerequisites/02-hotspot-source-guide.md
         ├── 追加完整 BUILD_LIBRARY .so 映射表（29 个 .so）
         └── 可选：追加 00-source-acquisition.md（源码获取 + 版本选择）

Step 2 ─ 升级 Phase 29 的 5 篇 prompt 到 ≥450 行
         └── 3 子代理管线，每篇单独 scout→reader→tracer

Step 3 ─ 新会话生成 Phase 29 的 5 篇文档
         └── 并行 4-agent 分段生成后合并

Step 4 ─ Review + 质量检查
```

**优先级**：Step 1（book 补全）> Step 2（prompt 升级）> Step 3（文档生成）

---

## §五 与全书的关系

```
全书结构：

  Volume 0 — 构建系统 (book/00-prerequisites/)
  ├── 00-cpp-in-hotspot.md         ← C++ 惯用法
  ├── 01-linux-system-programming.md ← Linux 系统编程
  ├── 02-hotspot-source-guide.md   ← 源码地图 + BUILD_LIBRARY 映射表
  └── 03-build-and-customize.md    ← 构建全链路（1087 行 ✅）

  Volume 1 — JVM 启动 (Phase 13 + Phase 01)
  Volume 2 — GC (Phase 30 + libjvm-analysis 06)
  Volume 3 — 解释器
  Volume 4 — 编译器 (Phase 31 + 22)
  Volume 5 — 内存 (Phase 27)
  Volume 6 — 运行时 (Phase 26)
  Volume 7 — 类加载 (Phase 32)
  Volume 8 — 基础设施

  Phase 29 — 构建深度参考（对应 Volume 0 的扩展阅读）
```

**关键原则**：后续所有 Phase 的 prompt §二 可以引用 "Volume 0 §3.X" 替代重复的 Build/Binary 说明，减少冗余。

---

## §六 关键文件索引

| 文件 | 用途 |
|------|------|
| `make/autoconf/hotspot.m4:27-29` | 26 JVM_FEATURES 定义 |
| `make/autoconf/hotspot.m4:35` | 5 JVM_VARIANTS 定义 |
| `make/autoconf/configure.ac:33` | `AC_PREREQ([2.69])` |
| `make/autoconf/jdk-options.m4:68` | `--with-debug-level` (4 levels) |
| `make/autoconf/jdk-options.m4:290` | `--with-native-debug-symbols` |
| `make/autoconf/platform.m4:29-232` | 18 架构 CPU 映射 + OS 检测 |
| `make/autoconf/toolchain.m4:37-58` | 5 工具链 + 最低版本要求 |
| `make/Main.gmk:1025` | hotspot 顶层 target |
| `make/hotspot/lib/JvmFlags.gmk:34-41` | JVM_SRC_DIRS 5 层源码目录 |
| `make/hotspot/lib/JvmFeatures.gmk:32-177` | 26 feature 条件编译 |
| `make/hotspot/lib/CompileJvm.gmk:153` | BUILD_LIBJVM 定义 |
| `make/hotspot/lib/JvmOverrideFiles.gmk:32-83` | 平台特定 CFLAGS 覆写 |
| `make/hotspot/lib/JvmMapfile.gmk:140-143` | 符号导出控制 |
| `make/common/NativeCompilation.gmk:396-439` | .d 依赖 + vardeps 增量跟踪 |
| `make/common/MakeBase.gmk:1003-1055` | DependOnVariable 实现 |
| `build/linux-x86_64-*-server-*/images/jdk/lib/server/libjvm.so` | 最终产物（294MB） |
