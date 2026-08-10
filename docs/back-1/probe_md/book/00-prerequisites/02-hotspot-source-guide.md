# 第 2 章：HotSpot 源码导读——目录、构建、全局状态

> **阅读前提**：本章假定你已经了解第 1 章的 Linux 系统编程基础（mmap、pthread、signal）。如果还不熟悉 `mmap(2)` 的 `MAP_NORESERVE` 标志或 `sigaction(2)` 的 `SA_SIGINFO`，建议先读完第 1 章再回来。

> **核心问题**：`src/hotspot/` 下面有 1,500+ 个 C++ 文件、50 万行代码，散布在 4 层 33 个子目录中。这些代码最终编译成哪些 .so？每个目录负责什么？从哪里开始读？本章提供一份"源码地图"——不是教你每个函数怎么工作，而是让你知道**去哪里找**。

---

## 2.0 源码获取与版本选择

在开始阅读源码之前，第一步是获取正确的 JDK 发行版。本节说明从哪里下载、选择哪个版本、以及构建环境的最低要求。

### 从哪里获取源码

JDK 11 有三种获取途径：

1. **Mercurial（官方）**：
   ```bash
   hg clone https://hg.openjdk.java.net/jdk-updates/jdk11u-dev/
   ```
   官方版本控制系统（JDK 11 仍使用 Mercurial）。适合参与 OpenJDK 开发、提交补丁。`jdk-updates/jdk11u-dev` 是活跃的更新分支，包含安全修复和 backport。

2. **GitHub mirror（社区）**：
   ```bash
   git clone https://github.com/openjdk/jdk11u-dev.git
   ```
   社区维护的 Git 镜像。速度更快，Git 用户无需额外安装 Mercurial。内容与官方仓库实时同步。

3. **Release tarball**：
   ```
   https://jdk.java.net/java-se-ri/11 → JDK 11.0.x Reference Implementation
   ```
   预打包的源码归档，适合只读学习。下载后解压即可，不包含版本历史。

**版本选择**：
- 本书基于 **OpenJDK 11.0.17+0**（TAG: `jdk-11.0.17-ga`）
- JDK 11 是 Long-Term Support (LTS) 版本，`jdk-updates/jdk11u-dev` 是活跃维护分支
- 检出命令：`git checkout jdk-11.0.17-ga` 或 `hg update jdk-11.0.17-ga`

### 项目目录第一眼

克隆后看到的顶层目录结构：

```
jdk11u-dev/
├── src/        — 所有源码（HotSpot VM C++ + JDK 类库 Java）
├── make/       — 构建系统（autoconf .m4 + GNU make .gmk，~220 文件，~124K 行）
├── test/       — 回归测试（jtreg + gtest）
├── doc/        — 开发文档（building.md, testing.md, ide.md）
├── .hg/        — Mercurial 元数据（git clone 则是 .git/）
└── configure   — 构建配置入口 shell 脚本
```

**本书聚焦范围**：
- `src/hotspot/` — HotSpot JVM 核心，约 60 万行 C++/汇编
- `make/` — 构建系统，用于理解 .so 产物和编译选项

**明确不覆盖**：
- `src/java.base/`、`src/java.xml/`、`src/jdk.compiler/` 等是 JDK 类库（Java 源码 + JNI native 实现），不是本书分析目标

### 构建一次需要什么

**硬件要求**：

| 资源 | 最低 | 推荐 |
|------|:---:|:---:|
| 磁盘 | 4 GB | 8 GB（含构建输出 + 中间 .o 文件） |
| 内存 | 2 GB | 4 GB（gcc -O2 编译大文件时 OOM 风险高） |
| CPU | 2 核 | 8+ 核（编译时间线性扩展） |

**编译耗时估算**（16 核机器）：

| 命令 | 产物 | 全量构建 | 增量构建 |
|------|------|:------:|:------:|
| `make hotspot` | libjvm.so 仅 | ~5 分钟 | ~30 秒 |
| `make jdk-image` | 完整 JDK | ~15 分钟 | ~2 分钟 |

**构建配置命名约定**：

构建输出路径遵循固定命名模式，在 `make/autoconf/basics.m4:907` 自动生成：

```
build/{os}-{cpu}-{jdk_variant}-{jvm_variant}-{debug_level}/
```

示例：`build/linux-x86_64-normal-server-slowdebug/`

| 组件 | 取值 | 含义 |
|------|------|------|
| `linux` | linux/solaris/windows/macosx | Target OS |
| `x86_64` | x86_64/aarch64/sparcv9 等 | Target CPU |
| `normal` | normal/static | JDK variant（static 生成静态链接版本） |
| `server` | server/client/minimal | JVM variant（见 2.3 节 `JVM_FEATURES`） |
| `slowdebug` | release/fastdebug/slowdebug/optimized | Debug level（`-O0 -g` vs `-O2`，见下表） |

Debug level 对应的编译选项：

| Level | CFLAGS | 断言 | 适用场景 |
|-------|--------|:---:|---------|
| `release` | `-O2 -DNDEBUG` | 关闭 | 生产构建 |
| `fastdebug` | `-O2 -g` | 启用 | 调试构建（部分优化保留） |
| `slowdebug` | `-O0 -g` | 启用 | 深度调试（无优化，变量可观察） |
| `optimized` | `-O2 -g` | 关闭 | 带符号的生产构建 |

> **关键认知**：构建路径名称不是手动指定的——`basics.m4:907` 用四个参数拼接而成。`configure` 脚本根据 `--with-debug-level`、检测到的 OS/CPU 自动完成命名。这解释了为什么所有 `make/` 构建文档都引用 `$(OUTPUTDIR)` 这个变量。

---

## 2.1 目录结构全景——四层分工

`src/hotspot/` 的第一层组织不是按功能模块，而是按**平台抽象层次**划分的。这是所有 JVM 黑客必须理解的第一课。

```
src/hotspot/
├── share/                     # ★ 跨平台源码（主工作区，825+ 文件）
│   │                           #   下文详述 23 个子目录
│   ├── runtime/               # 运行时基础设施（线程、锁、Safepoint）
│   ├── gc/                    # GC 子系统（G1、Parallel、ZGC 等）
│   ├── compiler/              # JIT 编译器入口（编译策略、编译代理）
│   ├── interpreter/           # 模板解释器
│   ├── classfile/             # 类加载、字节码验证
│   ├── oops/                  # OOP 对象模型（Klass、Method、ConstantPool）
│   ├── memory/                # 元空间、Arena、VirtualSpace
│   ├── code/                  # CodeCache（nmethod 管理）
│   ├── services/              # JMX、DiagnosticCommand、Attach
│   ├── prims/                 # JNI 入口、JVMTI 导出
│   ├── jfr/                   # JDK Flight Recorder
│   ├── utilities/             # 基础工具（Hashtable、BitMap、并发队列）
│   ├── logging/               # 统一日志框架（-Xlog）
│   ├── c1/                    # C1 编译器（客户端编译器）
│   ├── opto/                  # C2 编译器（服务端编译器，旧名 "opto"）
│   ├── ci/                    # 编译器接口（compiler interface）
│   ├── jvmci/                 # JVM Compiler Interface（Graal 接口）
│   ├── aot/                   # Ahead-of-Time 编译
│   ├── asm/                   # 汇编器抽象
│   ├── adlc/                  # 架构描述语言编译器
│   ├── libadt/                # 抽象数据类型库
│   ├── metaprogramming/       # C++ 模板元编程
│   ├── precompiled/           # 预编译头
│   └── include/               # JNI 头文件模板
│
├── os/                        # OS 抽象层（POSIX + 平台实现）
│   ├── posix/                 # POSIX 共享代码
│   └── linux/                 # Linux 实现（线程、信号、大页）
│
├── os_cpu/                    # OS×CPU 组合实现
│   └── linux_x86/             # Linux x86_64（原子操作、栈帧）
│
└── cpu/                       # CPU 架构相关
    └── x86/                   # x86_64（寄存器、汇编、StackFrame）
```

### 四层分工一览

```
┌──────────────────────────────────────────────────────────────────────┐
│                        四层架构的分工逻辑                              │
├────────────┬─────────────────────────────────────────────────────────┤
│ share/     │ "应该怎样" —— 跨平台逻辑                                  │
│            │ 不关心底层是 Linux 还是 Windows，写抽象接口               │
│            │ 例：os::reserve_memory() → 委托给 OS 层实现              │
├────────────┼─────────────────────────────────────────────────────────┤
│ os/        │ "在某 OS 上怎样" —— POSIX vs Linux 差别                  │
│            │ 例：os::Linux::reserve_memory() → ::mmap(2)              │
├────────────┼─────────────────────────────────────────────────────────┤
│ os_cpu/    │ "在某 OS+CPU 组合上怎样" —— 平台原子操作                  │
│            │ 例：linux_x86/ 的 cmpxchg 实现用 LOCK CMPXCHG 指令       │
├────────────┼─────────────────────────────────────────────────────────┤
│ cpu/       │ "在某 CPU 上怎样" —— 寄存器名、指令编码                   │
│            │ 例：x86/ 定义 RSP/RBP/RAX 寄存器偏移                     │
└────────────┴─────────────────────────────────────────────────────────┘
```

### share/ 23 子目录功能地图（按代码量排序）

| 子目录 | 文件数 | ~行数 | 一句话职责 |
|--------|:-----:|:-----:|-----------|
| `gc/` | 825 | ~188K | 所有 GC 实现（G1 48K、Shared 37K、Parallel 23K、CMS 22K、ZGC 21K、Shenandoah 29K、Serial/Epsilon 各 ~3K） |
| `jfr/` | 215 | ~80K | JDK Flight Recorder 事件采集、写入、元数据 |
| `runtime/` | 173 | ~74K | 线程、锁、Safepoint、信号处理、VM 操作、frame |
| `opto/` | 129 | ~70K | C2 编译器（Sea of Nodes IR、优化 pass） |
| `utilities/` | 101 | ~25K | Hashtable、BitMap、GrowableArray、concurrent queue、OopStorage |
| `oops/` | 87 | ~38K | OOP 对象模型、Klass 继承树、Method、ConstantPool |
| `memory/` | 83 | ~21K | Metaspace、VirtualSpace、Arena、AllocationStats |
| `classfile/` | 75 | ~46K | 类文件解析、SystemDictionary、ClassLoaderData、模块系统 |
| `ci/` | 74 | ~18K | 编译器接口（CI 镜像：ciKlass、ciMethod、ciField） |
| `prims/` | 70 | ~46K | JNI 函数表（~200 个 `JNI_ENTRY`）、JVMTI 事件、Unsafe |
| `services/` | 56 | ~20K | AttachListener、DiagnosticCommand、Management、heap dump |
| `c1/` | 49 | ~35K | C1 编译器（LIR、线性扫描寄存器分配） |
| `code/` | 47 | ~23K | CodeCache 三段堆、nmethod 及其异常表、依赖管理 |
| `interpreter/` | 40 | ~16K | 模板解释器（TemplateTable、InterpreterRuntime） |
| `logging/` | 37 | ~5K | 统一日志框架（LogTag、LogStream、log_is_enabled） |
| `compiler/` | 24 | ~11K | 编译策略、CompileBroker、编译任务队列 |
| `jvmci/` | 22 | ~15K | JVM Compiler Interface（Graal 调用 C++ 端） |
| `adlc/` | 21 | ~10K | 架构描述语言编译器（AD 文件 → C++ 代码） |
| `metaprogramming/` | 16 | ~2K | C++ 编译期类型计算（enable_if、is_same、Decay） |
| `asm/` | 9 | ~3K | 汇编器抽象接口（Assembler、Register、Address） |
| `aot/` | 9 | ~5K | AOT 编译缓存加载 |
| `libadt/` | 6 | ~1K | 基本 ADT（Set、Dict） |
| `precompiled/` | 1 | ~1K | 预编译头（precompiled.hpp） |
| `include/` | 0 | 0 | 仅含 JNI 头文件模板 (.h 模板) |

> **源码总览**：share/ 约 1,500+ 源文件合计 55 万行以上（含 gc/ 内部的 8 个 GC 引擎）。加上 os/、os_cpu/、cpu/ 共计 60 万行左右。

---

## 2.2 .so 映射表——完整源码目录到共享库映射

HotSpot 相关的共享库分为两类：**HotSpot 自身构建**（`make/hotspot/`，4 个目标）和 **JDK 模块库**（`make/lib/`，~31 个目标）。理解 `.so` 对应的源码范围，就能快速定位代码。

### 2.2.1 HotSpot 自身构建的 .so（4 个库）

| BUILD_LIBRARY | .so 名称 | 源码路径 | 构建定义 | 说明 |
|--------------|---------|---------|---------|------|
| `BUILD_LIBJVM` | `libjvm.so` | `src/hotspot/{share,os/linux,os/posix,cpu/x86,os_cpu/linux_x86}` + `gensrc/adfiles` | `CompileJvm.gmk:153` | 全部 HotSpot 代码编译进这一个 .so（slowdebug ~294MB） |
| `BUILD_GTEST_LIBJVM` | `libjvm.so` (gtest) | `test/hotspot/gtest` | `CompileGtest.gmk:62` | GTest 单元测试版 libjvm，链接原始 libjvm 的 `.o` 文件 |
| `BUILD_LIBJVM_DTRACE` | `libjvm_dtrace.so` | `src/java.base/solaris/native/libjvm_dtrace` | `CompileDtraceLibraries.gmk:33` | Solaris 专用 DTrace 探针库 |
| `BUILD_LIBJVM_DB` | `libjvm_db.so` | `src/java.base/solaris/native/libjvm_db` | `CompileDtraceLibraries.gmk:47` | Solaris 专用 DTrace 调试库 |

> **JVM_FEATURES 控制 libjvm.so 内部编译**：虽然 `libjvm.so` 是唯一的 `src/hotspot/` 产物，但它的内部结构由 `JVM_FEATURES` 特性集控制——启用 `compiler2` 时 `opto/` 和 `libadt/` 参与编译，禁用 `jvmti` 时 27 个 jvmti 文件被排除，禁用 `cds` 时 11 个 CDS 文件被排除。所有特性开关只影响这 **一个** .so。详见 §2.3 和 §2.2.6。

### 2.2.2 JDK java.base 模块 .so（9 个库）

| BUILD_LIBRARY | .so | 源码路径 | 构建文件 | 职责 | 本书覆盖 |
|--------------|-----|---------|---------|------|---------|
| `BUILD_LIBJLI` | `libjli.so` | `src/java.base/{share,unix}/native/libjli` | `CoreLibraries.gmk:236` | JVM 启动器：解析命令行，`dlopen(2)` 加载 `libjvm.so` | Vol 1 (Phase 13) |
| `BUILD_LIBJAVA` | `libjava.so` | `src/java.base/{share,unix}/native/libjava` | `CoreLibraries.gmk:99` | Java 核心 native 方法：`System`、`ClassLoader`、`String`、`Runtime` | Vol 1 (Phase 15) |
| `BUILD_LIBNET` | `libnet.so` | `src/java.base/unix/native/libnet` | `Lib-java.base.gmk:42` | 网络 native 实现：`PlainSocketImpl`、`SocketInputStream` | Phase 16 |
| `BUILD_LIBNIO` | `libnio.so` | `src/java.base/{unix,share}/native/libnio` | `Lib-java.base.gmk:69` | NIO native：`EPoll`、`FileChannel`、`MappedByteBuffer` | Phase 16 |
| `BUILD_LIBZIP` | `libzip.so` | `src/java.base/share/native/libzip` | `CoreLibraries.gmk:144` | ZIP/JAR 处理：zlib 绑定 + `mmap(2)` 文件映射 | Phase 14 |
| `BUILD_LIBJIMAGE` | `libjimage.so` | `src/java.base/share/native/libjimage` | `CoreLibraries.gmk:165` | JIMAGE 模块镜像格式（JDK 9+ 模块系统核心） | Phase 14 |
| `BUILD_LIBVERIFY` | `libverify.so` | `src/java.base/share/native/verify` | `CoreLibraries.gmk:76` | 字节码验证器 | Phase 32 |
| `BUILD_LIBJSIG` | `libjsig.so` | `src/java.base/unix/native/libjsig` | `Lib-java.base.gmk:139` | 信号链：`LD_PRELOAD` interpose `sigaction(2)` / `signal(2)` | Phase 19 |
| `BUILD_LIBFDLIBM` | `libfdlibm.a` | `src/java.base/share/native/libfdlibm` | `CoreLibraries.gmk:52` | FDLIBM 跨平台精确浮点静态库（静态链接到 `libjava.so`） | N/A（静态库） |

> **源码路径约定**：`SetupJdkLibrary` 宏自动从 `src/<module>/{share,<platform>}/native/lib<name>`（小写 .so 名）中收集源文件。部分库（如 `libjimage`）仅 share 目录。

### 2.2.3 其他 JDK 模块 .so（18 个库）

| BUILD_LIBRARY | .so | 模块 | 构建文件 | 职责 | 覆盖 |
|--------------|-----|------|---------|------|------|
| `BUILD_LIBINSTRUMENT` | `libinstrument.so` | `java.instrument` | `Lib-java.instrument.gmk:39` | `java.lang.instrument` 代理 API | Phase 18 |
| `BUILD_LIBMANAGEMENT` | `libmanagement.so` | `java.management` | `Lib-java.management.gmk:40` | JMX MBean 本地支持 | Phase 17 |
| `BUILD_LIBMANAGEMENT_EXT` | `libmanagement_ext.so` | `jdk.management` | `Lib-jdk.management.gmk:47` | JMX 扩展：OS MBean（CPU/内存/文件描述符） | Phase 17 |
| `BUILD_LIBMANAGEMENT_AGENT` | `libmanagement_agent.so` | `jdk.management.agent` | `Lib-jdk.management.agent.gmk:30` | 管理代理：JMX 端口 1099 监听 | Phase 17 |
| `BUILD_LIBRMI` | `librmi.so` | `java.rmi` | `Lib-java.rmi.gmk:30` | RMI native 层：`ObjID`、`DGC` | — |
| `BUILD_LIBSUNEC` | `libsunec.so` | `jdk.crypto.ec` | `Lib-jdk.crypto.ec.gmk:41` | SunEC 椭圆曲线加密（secp256r1、X25519 等） | — |
| `BUILD_LIBJ2PKCS11` | `libj2pkcs11.so` | `jdk.crypto.cryptoki` | `Lib-jdk.crypto.cryptoki.gmk:30` | PKCS#11 加密令牌接口（HSM/智能卡） | — |
| `BUILD_LIBJ2UCRYPTO` | `libj2ucrypto.so` | `jdk.crypto.ucrypto` | `Lib-jdk.crypto.ucrypto.gmk:32` | Solaris Ucrypto 硬件加速（仅 Solaris） | — |
| `BUILD_LIBJAAS` | `libjaas.so` | `jdk.security.auth` | `Lib-jdk.security.auth.gmk:30` | JAAS 认证模块：NT/Unix 登录 | — |
| `BUILD_LIBJ2GSS` | `libj2gss.so` | `java.security.jgss` | `Lib-java.security.jgss.gmk:30` | Kerberos GSS-API 绑定 | — |
| `BUILD_LIBATTACH` | `libattach.so` | `jdk.attach` | `Lib-jdk.attach.gmk:37` | Attach API：`.attach_pid` 文件 + SIGQUIT 协议 | Phase 20 |
| `BUILD_LIBDT_SOCKET` | `libdt_socket.so` | `jdk.jdwp.agent` | `Lib-jdk.jdwp.agent.gmk:30` | JDWP socket 传输层（调试器→JVM） | — |
| `BUILD_LIBJDWP` | `libjdwp.so` | `jdk.jdwp.agent` | `Lib-jdk.jdwp.agent.gmk:53` | JDWP 调试协议实现（Java 端代理） | — |
| `BUILD_LIBDT_SHMEM` | `libdt_shmem.so` | `jdk.jdi` | `Lib-jdk.jdi.gmk:32` | JDWP 共享内存传输（仅 Windows） | — |
| `BUILD_LIBSA` | `libsa.so` | `jdk.hotspot.agent` | `Lib-jdk.hotspot.agent.gmk:58` | Serviceability Agent：post-mortem 核心分析 | Phase 20 |
| `BUILD_LIBSCTP` | `libsctp.so` | `jdk.sctp` | `Lib-jdk.sctp.gmk:33` | SCTP 协议（Stream Control Transmission） | — |
| `BUILD_LIBEXTNET` | `libextnet.so` | `jdk.net` | `Lib-jdk.net.gmk:32` | `jdk.net` 扩展网络选项（SO_FLOW_SLA） | — |
| `BUILD_LIBLE` | `lible.so` | `jdk.internal.le` | `Lib-jdk.internal.le.gmk:32` | Windows 行编辑器（仅 Windows，WinNT 终端） | — |

> **额外平台特定库**（未在上表列出）：`libw2k_lsa_auth`/`libsspi_bridge`（Windows GSS）、`libosxkrb5`（macOS Kerberos）、`libsunmscapi`（Windows MSCAPI）、`libj2pcsc`（智能卡）、`libunpack`（pack200）、`libosxsecurity`（macOS Keychain）、`libprefs`（Preferences API）。完整列表见 `make/lib/Lib-*.gmk`。

### 2.2.4 AWT/图形子系统 .so（10 个库）

> 这些库的源码和头文件主要来自 `src/java.desktop/` 模块，构建定义在 `Awt2dLibraries.gmk`。

| BUILD_LIBRARY | .so | 行号 | 职责 |
|--------------|-----|------|------|
| `BUILD_LIBMLIB_IMAGE` | `libmlib_image.so` | `:50` | MediaLib 图像处理库（缩放、旋转、滤镜） |
| `BUILD_LIBAWT` | `libawt.so` | `:219` | AWT 核心：窗口、事件、绘制（X11/GDI） |
| `BUILD_LIBAWT_XAWT` | `libawt_xawt.so` | `:325` | X11 AWT 后端（Xlib 绑定，仅 Linux/Solaris） |
| `BUILD_LIBLCMS` | `liblcms.so` | `:380` | Little CMS 颜色管理引擎 |
| `BUILD_LIBJAVAJPEG` | `libjavajpeg.so` | `:430` | IJG JPEG 编解码库（JPEG 读写） |
| `BUILD_LIBAWT_HEADLESS` | `libawt_headless.so` | `:471` | Headless AWT（无 GUI 服务器的图形操作） |
| `BUILD_LIBFREETYPE` | `libfreetype.so` | `:519` | FreeType 字体光栅化引擎 |
| `BUILD_LIBFONTMANAGER` | `libfontmanager.so` | `:631` | 字体管理器：HarfBuzz 文本整形 + TrueType 处理 |
| `BUILD_LIBJAWT` | `libjawt.so` | `:694` | JAWT（AWT Native Interface）导出 API |
| `BUILD_LIBSPLASHSCREEN` | `libsplashscreen.so` | `:865` | 启动画面（SplashScreen PNG/GIF/JPEG 显示） |

> **macOS 平台额外库**：`libawt_lwawt.so`（Lightweight AWT，`:925`）、`libosxui.so`（macOS UI，`:970`）、`libosxapp.so`（macOS AppKit 绑定，`Lib-java.desktop.gmk:90`）、`libosx.so`（OS X 系统调用接口，`:119`）、`libjsound.so`（音频，`:62`）。这些库仅在 `OPENJDK_TARGET_OS=macosx` 时编译。

### 2.2.5 依赖关系图（三层架构）

```
┌─────────────────────────────────────────────────────────────────────┐
│                        第 0 层：启动器                                │
│                                                                      │
│  ┌──────────────┐                                                    │
│  │  libjli.so   │  ← java 命令启动器（命令行解析、JRE 定位）            │
│  └──────┬───────┘                                                    │
│         │ dlopen("libjvm.so")    man 3 dlopen                        │
└─────────┼────────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────────────┐
│                     第 1 层：JVM 内核                                 │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  libjvm.so  ← 全部 src/hotspot/ 代码（JVM_FEATURES 控制）     │    │
│  │    GC|JIT|Runtime|OOPS|Classfile|Interpreter|JFR|Services   │    │
│  └──────────────────────────────────────────────────────────────┘    │
└────┬─────────────────────────────────────────────┬───────────────────┘
     │ JNI_CreateJavaVM 导出                        │ JNI 调用
     │ JVM_* / jmm_* / AsyncGetCallTrace 导出        │
     │                                              │
┌────▼──────────────────────────────────────────▼───────────────────────┐
│                    第 2 层：JDK 库（JNI 调用者）                        │
│                                                                       │
│  ┌──────────────────┐ ┌───────────────────┐ ┌───────────────────────┐ │
│  │ java.base 核心    │ │ 诊断/工具          │ │ 加密/安全              │ │
│  │                  │ │                   │ │                       │ │
│  │ libjava.so       │ │ libinstrument.so  │ │ libsunec.so           │ │
│  │ libzip.so        │ │ libattach.so      │ │ libj2pkcs11.so        │ │
│  │ libjimage.so     │ │ libmanagement.so  │ │ libjaas.so            │ │
│  │ libverify.so     │ │ libmanagement_ext │ │ libj2gss.so           │ │
│  │ libnet.so        │ │ libmanagement_agent│ │ libj2ucrypto.so       │ │
│  │ libnio.so        │ │ libsa.so          │ │ lible.so (Win)        │ │
│  │ libjsig.so       │ │ libjdwp.so        │ │                       │ │
│  │                  │ │ libdt_socket.so   │ │ ───────────────        │ │
│  │                  │ │ libdt_shmem.so(Win)│ │ libawt.so + 9 个子库  │ │
│  │                  │ │ librmi.so          │ │ (AWT/图形系统)         │ │
│  │                  │ │ libsctp.so         │ │                       │ │
│  │                  │ │ libextnet.so       │ │                       │ │
│  └──────────────────┘ └───────────────────┘ └───────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

> **核心认知**：`libjvm.so` 是唯一从 `src/hotspot/` 编译的产物。其余 ~31 个 .so 的源码在 JDK 模块目录下，通过 JNI 调用 `libjvm.so` 的导出符号。`JVM_FEATURES` 控制 `libjvm.so` 内部哪些子目录参与编译——所有特性开关只影响这一个 .so。

### 2.2.6 libjvm.so 内部源码组织——JVM_FEATURES 五层过滤

`libjvm.so` 虽然是一个整体，但内部通过 `JvmFeatures.gmk` 的五层过滤机制决定哪些源文件参与编译：

```
make/hotspot/lib/CompileJvm.gmk:28-30 (include chain)
  ├─ include lib/JvmFeatures.gmk   → CFLAGS 宏 + 排除规则
  ├─ include lib/JvmOverrideFiles.gmk → 特殊编译选项
  └─ include lib/JvmFlags.gmk      → 通用编译选项 + JVM_SRC_DIRS
```

**第 1 层：CFLAGS 宏**（编译期开关）

```
特性启用时定义的预处理宏：
  compiler1 → -DCOMPILER1
  compiler2 → -DCOMPILER2
  zero      → -DZERO -DCC_INTERP
  minimal   → -DMINIMAL_JVM -DVMTYPE=\"Minimal\"
  dtrace    → -DDTRACE_ENABLED

特性禁用时定义的排除宏：
  !jvmti   → -DINCLUDE_JVMTI=0
  !jvmci   → -DINCLUDE_JVMCI=0
  !services → -DINCLUDE_SERVICES=0
  !management → -DINCLUDE_MANAGEMENT=0
  !cds     → -DINCLUDE_CDS=0
  !vm-structs → -DINCLUDE_VM_STRUCTS=0
  !jni-check → -DINCLUDE_JNI_CHECK=0
  !static-build → -DSTATIC_BUILD=1
```

**JvmFeatures.gmk:32-68**

**第 2 层：源码目录**（`JVM_SRC_DIRS`）

```
JvmFlags.gmk:34-41
  JVM_SRC_DIRS += 
    src/hotspot/share           ← 跨平台核心
    src/hotspot/os/linux        ← OS 具体实现
    src/hotspot/os/posix        ← POSIX 共享
    src/hotspot/cpu/x86         ← CPU 架构
    src/hotspot/os_cpu/linux_x86 ← OS×CPU 组合
    gensrc/adfiles              ← 架构描述文件生成（ADLC 输出）

启用 compiler2 时追加：
    JVM_SRC_DIRS += gensrc/adfiles  (JvmFeatures.gmk:40)
```

**第 3 层：目录排除**（`JVM_EXCLUDES`）

```
JvmFeatures.gmk:42,82
  !compiler2 → JVM_EXCLUDES += opto libadt
  !jvmci     → JVM_EXCLUDES += jvmci
```

**第 4 层：文件排除**（`JVM_EXCLUDE_FILES`）

```
JvmFeatures.gmk:43,73-77,83,88,93,98-99,108-119
  !compiler2 → bcEscapeAnalyzer.cpp ciTypeFlow.cpp
  !jvmti     → 27 个文件（jvmtiExport.cpp, jvmtiEnv.cpp, jvmtiRedefineClasses.cpp ...）
  !jvmci     → jvmciCodeInstaller_x86.cpp
  !services  → heapDumper.cpp heapInspection.cpp attachListener.cpp ...（6 个）
  !vm-structs → vmStructs.cpp
  !jni-check → jniCheck.cpp
  !cds       → 11 个 CDS 文件（filemap.cpp, metaspaceShared.cpp, heapShared.cpp ...）
```

**第 5 层：模式排除**（`JVM_EXCLUDE_PATTERNS`）

```
JvmFeatures.gmk:35,44
  !compiler1 → JVM_EXCLUDE_PATTERNS += c1_ c1/
  !compiler2 → JVM_EXCLUDE_PATTERNS += c2_ runtime_ /c2/
```

> **这五层是叠加的**：先确定 `JVM_SRC_DIRS`（加入源目录），然后依次应用 `JVM_EXCLUDES`（排除子目录）、`JVM_EXCLUDE_FILES`（排除具体文件）、`JVM_EXCLUDE_PATTERNS`（排除匹配模式的文件）。结果就是 `BUILD_LIBJVM_ALL_OBJS`，即最终 `libjvm.so` 的全部对象文件。

```
Server VM（默认）编译结果：
  源目录 5 个（share, os/linux, os/posix, cpu/x86, os_cpu/linux_x86）
  排除目录 0 个（所有特性全开）
  排除文件 0 个
  排除模式 0 个
  → ~1,500+ 文件，~60 万行 C++ → libjvm.so（slowdebug ~294MB）

Minimal VM 编译结果：
  源目录同上 5 个
  排除目录 opto, libadt, jvmci（!compiler2, !jvmci）
  排除文件 27(jvmti) + 2(compiler2残余) + 1(jvmci) + 6(services) 
             + 1(vm-structs) + 1(jni-check) + 11(cds) + (management)
  → ~200 文件 → libjvm.so（~20MB 级）
```

---

## 2.3 构建系统速览——configure → make jdk

### 两步构建

```
┌────────────────────────────────────────────────────────────────┐
│  $ bash configure --with-debug-level=slowdebug                  │
│      │                                                         │
│      ├─ make/autoconf/configure 入口                            │
│      ├─ hotspot.m4 LINE 520: NON_MINIMAL_FEATURES 定义          │
│      ├─ hotspot.m4 LINE 539: JVM_FEATURES_server 组装           │
│      ├─ 生成 build/<platform>/spec.gmk                          │
│      └─ 生成 build/<platform>/Makefile                          │
│                                                                 │
│  $ make jdk                                                    │
│      │                                                         │
│      ├─ make/hotspot/lib/CompileJvm.gmk:153 BUILD_LIBJVM       │
│      │   ├─ include lib/JvmFeatures.gmk   (特性→宏+排除)        │
│      │   ├─ include lib/JvmOverrideFiles.gmk (特殊编译选项)      │
│      │   └─ include lib/JvmFlags.gmk      (通用编译选项)        │
│      ├─ make/hotspot/lib/CompileDtraceLibraries.gmk             │
│      ├─ make/lib/CoreLibraries.gmk (libjava, libjli, libzip...) │
│      ├─ make/lib/Lib-java.base.gmk (libnet, libnio, libjsig)   │
│      └─ make/lib/Lib-jdk.*.gmk (libattach, libinstrument...)   │
└────────────────────────────────────────────────────────────────┘
```

### JVM_FEATURES——决定哪些代码参与编译

这是理解 `libjvm.so` 内部组成的核心概念。每种 JVM variant 有不同的特性组合。

**Server VM**（默认，`hotspot.m4:539`）：

```
compiler1 compiler2 cmsgc g1gc parallelgc serialgc epsilongc
shenandoahgc zgc jni-check jvmti management nmt services
vm-structs cds jvmci aot graal
```

**Client VM**（`hotspot.m4:540`）：同上但只有 `compiler1`（无 C2）。

**Minimal VM**（`hotspot.m4:542`）：仅 `compiler1 minimal serialgc`。

特性控制代码编译的方式（`JvmFeatures.gmk:32-100`）：

```
特性              │ 启用时                      │ 禁用时
─────────────────┼────────────────────────────┼──────────────────────────
compiler1        │ -DCOMPILER1                │ 排除 c1_ c1/
compiler2        │ -DCOMPILER2                │ 排除 opto/ libadt/ c2_/
jvmti            │ (默认)                      │ -DINCLUDE_JVMTI=0
                                                排除 jvmtiExport.cpp 等 27 文件
services         │ (默认)                      │ -DINCLUDE_SERVICES=0
                                                排除 attachListener.cpp 等
jvmci            │ (默认)                      │ -DINCLUDE_JVMCI=0
                                                排除 jvmci/
vm-structs       │ (默认)                      │ -DINCLUDE_VM_STRUCTS=0
                                                排除 vmStructs.cpp
dtrace           │ -DDTRACE_ENABLED            │ (默认禁用)
minimal          │ -DMINIMAL_JVM               │ (默认禁用)
```

> **原则**：`#if INCLUDE_JVMTI` 这样的预处理宏控制编译期代码裁剪。禁用 JVMTI 时，`jvmtiExport.cpp` 整个文件被排除，不是编译了再链接优化掉。

### 构建产物路径

```bash
# slowdebug 构建（源码目录下）
build/linux-x86_64-normal-server-slowdebug/
├── jdk/
│   ├── bin/java                      # 启动器
│   └── lib/
│       ├── server/libjvm.so          # ★ HotSpot VM
│       ├── libjava.so libjli.so libzip.so ...
│       └── jli/libjli.so             # (某些平台)
├── hotspot/variant-server/libjvm/objs/  # 编译中间对象
└── support/
    └── gensrc/                       # AD 文件生成等
```

---

## 2.4 全局数据结构索引

HotSpot 启动时初始化了大量全局数据结构（C++ 静态变量或单例）。这些是跨子系统共享的"中枢神经"。理解它们的位置就如同拥有了 JVM 源码的索引。

### 核心全局表

| 数据结构 | 全局变量 | 初始化位置 | 角色 |
|---------|---------|-----------|------|
| **Universe** | `Universe::_collectedHeap` | `universe.cpp:682 universe_init()` | Java 堆句柄 + 基础类型 Klass + 预分配异常对象 |
| **SymbolTable** | `SymbolTable::_the_table` | `symbolTable.cpp:~250 create_table()` | 所有 JVM 内部 Symbol（类名、方法名、字段名），~516KB，20011 桶 |
| **StringTable** | `StringTable::_the_table` | `stringTable.cpp:~100 create_table()` | Java 字符串常量池（interned strings），ConcurrentHashTable + OopStorage 后端 |
| **SystemDictionary** | `SystemDictionary::_java_system_loader` | `systemDictionary.cpp:~200 initialize()` | 类加载器的字典（已加载类的 Klass → ClassLoaderData 映射） |
| **CodeCache** | `CodeCache::_heaps[3]` | `codeCache.cpp:1141 codeCache_init()` | 三段 CodeHeap（NonNMethod/Profiled/NonProfiled），~240MB |
| **StubRoutines** | `StubRoutines::_call_stub_entry` | `stubRoutines.cpp:411 stubRoutines_init1()` | 运行时 Stub 入口（call_stub、catch_exception、arraycopy 等） |
| **Interpreter** | `AbstractInterpreter::_code` | `interpreter.cpp:116 interpreter_init()` | 模板解释器字节码表（StubQueue + Codelet） |
| **JvmtiExport** | `JvmtiExport::_should_post_*` | `jvmtiExport.cpp:~300` | 全局 JVMTI 事件开关（~50 个 bool 位域）和回调列表 |
| **JfrRecorder** | `JfrRecorder::_recording` | `jfrRecorder.cpp:~80 start_recording()` | JFR 录制状态机（Chunk 管理、全局缓冲策略） |
| **Arguments** | `Arguments::_jvm_args` | `arguments.cpp:~3700 parse()` | JVM 参数解析结果（-Xmx、-XX:+UseG1GC 等） |
| **PerfMemory** | `PerfMemory::_start` | `perfMemory.cpp:~600 create_memory_region()` | 性能计数器共享内存（mmap 32KB，magic 0xc0c0feca） |
| **LogConfiguration** | （LogTag 集合） | `logConfiguration.cpp:~100` | 统一日志框架配置（-Xlog 解析结果） |
| **CompileBroker** | `CompileBroker::_compilers[2]` | `compileBroker.cpp:236 compileBroker_init()` | 编译线程管理器（C1/C2 CompileTask 双队列） |

### 全局状态初始化顺序

这些全局结构不是在 `main()` 前由 C++ 静态初始化完成的——它们由 `Threads::create_vm()` 统一调度，分为三个阶段：

```
Threads::create_vm()          thread.cpp:3886
│
├─ vm_init_globals()          init.cpp:95   ← VM 线程阶段（Stage 4）
│   │  os_init_globals, stubRoutines_init1, universe_init,
│   │  gc_barrier_stubs_init, interpreter_init, templateTable_init
│   │
├─ init_globals()             init.cpp:109  ← 31 次子调用（Stage 4 后半）
│   │  management_init, bytecodes_init, classLoader_init1,
│   │  codeCache_init, compilerOracle_init, jni_handles_init ...
│   │
└─ universe_post_init()       universe.cpp:1230  ← 预分配异常对象 + 缓存
```

> **关键认知**：`init_globals()` 的 31 次调用顺序不是随意的——它们严格遵守依赖关系。例如 `universe_init()`（#9）必须在 `codeCache_init()`（#5）之后调用，因为 Universe 初始化需要分配 GC barrier stubs 到 CodeCache。详见第 4 章 JVM 启动详解。

### 查找技巧

```bash
# 找某个全局变量的初始化位置
grep -rn "::_the_table" src/hotspot/share/classfile/symbolTable.cpp

# 找某个模块的初始化入口（统一模式：xxx_init 或 xxx::initialize）
grep -rn "^void.*_init\b" src/hotspot/share/

# 找单例实例（通常命名为 _the_xxx 或 _xxx_singleton）
grep -rn "_the_" src/hotspot/share/ --include='*.hpp' | head -30
```

---

## 2.5 核心抽象链——OOP、线程、Handle 三大体系

HotSpot 的代码量主要来自三个相互交织的"横向抽象"——理解这些抽象链，就拿到了阅读源码的钥匙。

### 2.5.1 OOP 体系——从堆对象到类元数据

Java 世界里的一切都是对象。HotSpot 用 C++ 的指针多态来建模这个层级：

```
Java 堆（GC 管理）                │  Metaspace（非 GC）
                                  │
oop ─────── 顶层抽象（OOPDesc*）   │
├─ instanceOop  普通对象实例        │
├─ objArrayOop  对象数组            │
├─ typeArrayOop 基本类型数组        │
└─ markOop      对象头（Mark Word） │
                                  │
Klass ───── 类元数据（Metaspace）   │  src/hotspot/share/oops/
├─ InstanceKlass               ←   │  instanceKlass.hpp
│   └─ InstanceMirrorKlass          │
├─ ArrayKlass                       │
│   ├─ ObjArrayKlass                │
│   └─ TypeArrayKlass               │
└─ InstanceRefKlass                 │
                                  │
Method ─── 方法元数据              │  src/hotspot/share/oops/method.hpp
├─ ConstMethod (字节码+异常表)      │
└─ MethodData  (性能计数器)         │
                                  │
ConstantPool ─ 常量池              │  src/hotspot/share/oops/constantPool.hpp
├─ 符号引用→类/方法/字段            │
└─ 解析缓存（_resolved_references） │
```

**关键文件**：
- `oops/oop.hpp` — oop 基础定义（`class oop { OOPDesc* _o; }`）
- `oops/klass.hpp` — Klass 继承树顶层
- `oops/instanceKlass.hpp` — 最常用的 Klass（对应 Java 类）
- `oops/method.hpp` — 方法元数据（含 `ConstMethod*`）

**记忆技巧**：每个 Java 对象在堆上有一个 `instanceOop`（含 markOop 头），指向 Metaspace 中的 `InstanceKlass`。`InstanceKlass` 又持有 `Method*` 数组和 `ConstantPool*`。访问路径：`myObj._klass->_methods[3]->_constMethod`。

### 2.5.2 线程体系——从 Java 到 OS

HotSpot 的线程模型是三层嵌套：

```
JavaThread              src/hotspot/share/runtime/thread.hpp
  │                     _osthread → OSThread (平台无关抽象)
  │                     _threadObj → java.lang.Thread 镜像
  │
  ├─ CompilerThread     编译线程（C1/C2 执行载体）
  └─ ServiceThread      后台服务线程
  │
Thread                  src/hotspot/share/runtime/thread.hpp
  │                     Thread 基类（JavaThread + NonJavaThread）
  │
  ├─ NonJavaThread      所有非 Java 线程的基类
  │   ├─ VMThread       单例 VM 操作执行线程
  │   ├─ WatcherThread  定时任务线程
  │   └─ ...            其他内部线程
  │
os::thread              src/hotspot/os/posix/os_posix.hpp
  │                     POSIX pthread 封装
  │
pthread_t               <pthread.h>
  内核 task_struct       Linux 内核
```

**关键文件**：
- `runtime/thread.hpp` — `JavaThread` 和 `Thread` 定义（含 C++ 字段布局）
- `runtime/osThread.hpp` — `OSThread`（线程状态、platform_id）
- `os/posix/os_posix.hpp` — POSIX 线程封装（`create_thread`、`pd_start_thread`）

**创建路径**：
```
new JavaThread(thread_entry, stack_size)    thread.cpp:1851 构造函数
  → os::create_thread(this, ...)            os_linux.cpp:~5200
    → pthread_create(...)                   man 3 pthread_create
      → clone(CLONE_VM | CLONE_FS | ...)    man 2 clone
```

### 2.5.3 Handle 体系——GC 安全的 oop 指针

这是 HotSpot 最独特的设计之一。Java 对象可以被 GC 移动（G1 的 Evacuation、Serial/Parallel 的 Copy），所以直接用裸 `oop` 指针是危险的——GC 可能在任何 Safepoint 期间搬走对象。

```
Handle            → 轻量级 GC 安全包装    jniHandles.hpp
  │                构造函数将 oop 缓存到当前线程的 HandleArea
  │                析构函数清理缓存
  │
HandleMark        → 作用域标记            handles.hpp
  │                构造时记录当前水位
  │                析构时回退 HandleArea（LIFO 释放）
  │
HandleArea        → 线程本地 Handle 链表   handles.hpp
  │                每次 new Handle() 分配一个 slot
  │                由 HandleMark 析构打包释放
  │
JNIHandleBlock    → JNI 本地引用块        jniHandles.hpp
  │                全局引用 / 弱全局引用
  │                OopStorage 后端（JDK 11+）
  │
OopStorage        → GC 可达的无锁存储池   oopStorage.hpp
                   支持并行分配和迭代
```

**关键文件**：
- `runtime/handles.hpp` — Handle/HandleMark 定义
- `runtime/jniHandles.hpp` — JNIHandleBlock 和全局引用

**用法示例**：
```cpp
void some_vm_function(oop java_obj) {
  // GC 危险：java_obj 是裸 oop，Safepoint 期间可能被移动
  HandleMark hm;                      // 记录水位
  Handle h_obj(Thread::current(), java_obj);  // 创建 GC 安全句柄
  // ... 这里可以安全 Safepoint ...
}  // hm 析构 → HandleArea 回退到记录水位
```

---

## 2.6 阅读顺序建议——从入口到子系统

面对 60 万行 C++ 代码，从哪开始？建议按以下顺序逐步深入。

### 阶段 0：建立全局地图（本章已完成）

- 理解四层架构（share/os/os_cpu/cpu）
- 知道 `.so` 映射关系
- 记住三大抽象链

### 阶段 1：跟随 JVM 启动（Part 1，2-4 章）

```
JNI_CreateJavaVM()                 jni.cpp:4143  ← JNI 公开入口
  → JNI_CreateJavaVM_inner()       jni.cpp:3984  ← 原子性保证 (vm_created CAS)
    → Threads::create_vm()         thread.cpp:3886  ← 全部初始化逻辑 (~460行)
      ├─ os::init()                os_linux.cpp    ← 信号集、页大小、处理器数
      ├─ Arguments::parse()        arguments.cpp   ← -Xmx -XX: 解析
      ├─ init_globals()            init.cpp:109    ← ★ 31 个模块初始化
      │   ├─ universe_init()       universe.cpp:682  ← 堆、元空间
      │   ├─ codeCache_init()      codeCache.cpp:1141  ← 编译代码缓存
      │   ├─ interpreter_init()    interpreter.cpp:116  ← 字节码处理器
      │   └─ ... 其余 28 个初始化
      └─ VMThread::create()        ← VM 操作线程
```

**为什么从这里开始**？因为 JVM 启动过程串联了所有子系统——你会在一个函数中看到 `CodeCache`、`Universe`、`SymbolTable`、`Metaspace` 的初始化顺序和依赖关系。读懂了 `create_vm()`，就拿到了 JVM 源码的"地铁线路图"。

### 阶段 2：按子系统深入

遵循"基础设施先行"原则——先理解底层机制，再读上层使用：

```
阅读顺序           │ 子系统          │ 为什么这个顺序
──────────────────┼────────────────┼──────────────────────────
① 类加载          │ Class Loading   │ 所有 Java 对象的入口——
                  │ (Part 2)        │   没有 Klass，就没有一切
② 对象模型        │ OOP/Klass       │ 理解 Java 对象在 C++ 中的表示
                  │ (Part 3)        │
③ 执行引擎        │ 解释器 + JIT    │ 字节码如何变为机器指令
                  │ (Part 4)        │
④ 内存与 GC       │ G1 + Metaspace  │ 对象如何分配和回收
                  │ (Part 5)        │   （依赖 ②③ 的对象模型知识）
⑤ 并发模型        │ 线程/锁/Safepoint│ 多线程协调机制
                  │ (Part 6)        │   （贯穿 ①-④ 全流程）
⑥ 诊断工具        │ Xlog/JFR/JMX/SA │ 理解上面 5 层后才有诊断需求
                  │ (Part 7)        │
```

### 阶段 3：按问题驱动深入

掌握了主线后，用问题驱动深入到特定领域：

| 问题 | 从哪里找 |
|------|---------|
| "synchronized 到底锁了什么？" | `runtime/objectMonitor.cpp` → `ObjectMonitor::enter()` |
| "G1 怎么决定什么时候 GC？" | `gc/g1/g1Policy.cpp` → `G1Policy::need_to_start_conc_mark()` |
| "JFR 事件怎么从 JVM 写入磁盘？" | `jfr/jfrRecorder.cpp` + `jfr/recorder/storage/` |
| "-XX:+PrintAssembly 如何工作？" | `compiler/disassembler.cpp` → `Disassembler::decode()` |
| "Signal Chaining 如何拦截 sigaction？" | `os/linux/sigaction.c` → `dlsym(RTLD_NEXT, "sigaction")` |

### 日常工作流

```bash
# 1. 搜符号定位
grep -rn "class ObjectMonitor" src/hotspot/share/runtime/

# 2. 读头文件了解接口
vim src/hotspot/share/runtime/objectMonitor.hpp

# 3. 读实现理解细节
vim src/hotspot/share/runtime/objectMonitor.cpp

# 4. 跟踪调用链
grep -rn "ObjectMonitor::enter" src/hotspot/share/

# 5. 用 GDB 验证运行时行为
gdb --args java -XX:+UseG1GC MyClass
(gdb) b ObjectMonitor::enter
(gdb) run
```

---

## 小结

本章建立了一张 HotSpot 源码的"地图"——不是具体位置的地图，而是一张告诉你"什么在哪、怎么连在一起"的关系图。

核心要点：

1. **四层架构**：share（跨平台） → os（OS 实现） → os_cpu（OS×CPU 组合） → cpu（CPU 指令）。读代码时先确定在哪个层。
2. **一个 .so**：`libjvm.so` 承载所有 `src/hotspot/` 代码；其余 .so 是 JDK 库层，通过 JNI 调用 libjvm。
3. **特性开关**：`JVM_FEATURES` 决定哪些代码参与编译——`#if INCLUDE_JVMTI` 等宏控制编译期裁剪。
4. **全局中枢**：`Universe`、`SymbolTable`、`CodeCache`、`JvmtiExport` 等全局结构在 `init_globals()` 中按依赖顺序初始化。
5. **三大抽象链**：OOP→Klass→Method→ConstantPool（对象到元数据）、JavaThread→Thread→os::thread（线程三层嵌套）、Handle→HandleMark→JNIHandleBlock（GC 安全指针）。
6. **阅读路径**：`JNI_CreateJavaVM` → `Threads::create_vm()` → `init_globals()` → 按子系统深入（类加载→对象→执行→GC→并发→诊断）。

从下一章开始，我们将进入 Part 1——JVM 启动过程，一步步跟随 `Threads::create_vm()` 的 462 行代码，理解一个 Java 程序是如何从 `java MyClass` 变成运行中的 JVM 实例的。
