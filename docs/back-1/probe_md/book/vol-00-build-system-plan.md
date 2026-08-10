# Volume 0 — OpenJDK 构建系统 — make/ + autoconf

## §〇 定位

**全书第 0 卷**，Part 0（前置知识）的扩展卷。每个 Phase 的 prompt §二 反复写：

```
Build: make hotspot
Key binary: build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so
```

但从未解释过这两行的含义。本卷一次性讲透，后续所有文档 §二 直接引用本卷替代重复说明。

**读者**：刚 clone 完 OpenJDK 源码，需要看懂 `make/` 和 `build/` 目录，跑通编译，理解每个 .so 从哪来。

---

## §一 现有资产：Phase 29-build-customize

| 文件 | 行数 | 状态 |
|------|:---:|:---:|
| `prompt-00-configure-system.md` | 252 | 低于 ≥450 标准 |
| `prompt-01-main-pipeline.md` | 283 | 低于 ≥450 标准 |
| `prompt-02-hotspot-compile.md` | 279 | 低于 ≥450 标准 |
| `prompt-03-image-assembly.md` | 236 | 低于 ≥450 标准 |
| `prompt-04-trim-customize.md` | 230 | 低于 ≥450 标准 |

5 个 prompt 总计 1280 行，平均 256 行 — 全低于质量标准（≥450）。文档均未生成。

**策略**：将 Phase 29 升级为第 0 卷内容源——重写 prompt 到质量标准 + 新增 3 篇覆盖缺口。

---

## §二 文档拆分规划（8 章）

| # | 标题 | 核心源文件 | 读者问题 |
|:--:|------|-----------|---------|
| 00 | **源码获取与目录概览** | `README`, `.gitignore`, `src/` 顶层, `doc/building.md` | "代码从哪下？每个目录干嘛的？" |
| 01 | **configure 系统** | `make/autoconf/configure.ac`, `hotspot.m4`, `platform.m4`, `toolchain.m4` | "configure 参数怎么选？平台检测怎么工作？" |
| 02 | **Build Pipeline — 从 make 到镜像** | `make/Main.gmk`, `make/Init.gmk`, `make/common/MakeBase.gmk` | "敲 make hotspot 后发生什么？" |
| 03 | **HotSpot 编译 — libjvm.so 诞生** | `make/hotspot/lib/CompileJvm.gmk`, `JvmFeatures.gmk`, `JvmFlags.gmk` | "2500 个 .cpp 怎么编成一个 .so？特性开关怎么控制？" |
| 04 | **JVM 特性开关体系** | `JvmFeatures.gmk`, `make/autoconf/hotspot.m4:27-29` (25 个 VALID_JVM_FEATURES) | "怎么只编 G1+Serial？怎么禁用 JFR？" |
| 05 | **构建输出目录详解** | `build/linux-x86_64-normal-server-slowdebug/` 实际目录 | "build/ 下那串名字什么意思？images vs support vs hotspot 区别？" |
| 06 | **JDK 镜像组装** | `make/Images.gmk`, `make/jdk/src/Classes.gmk` | "jmod/jlink 是什么？exploded image 怎么拼出来？" |
| 07 | **常见坑与诊断清单** | 编译经验汇总 | "OOM 编译怎么调？X11 缺了怎么办？增量编译失败？" |

---

## §三 与 Phase 29 的映射

| 第 0 卷章 | Phase 29 prompt | 动作 |
|----------|----------------|------|
| 00-源码获取 | — 新建 — | 完全新写 |
| 01-configure | prompt-00-configure-system.md (252行) | 重写到 ≥450 行 |
| 02-Build Pipeline | prompt-01-main-pipeline.md (283行) | 重写到 ≥450 行 |
| 03-HotSpot 编译 | prompt-02-hotspot-compile.md (279行) | 重写到 ≥450 行 |
| 04-特性开关 | prompt-04-trim-customize.md (230行) | 拆分出来，重写 |
| 05-输出目录 | — 新建 — | 完全新写 |
| 06-镜像组装 | prompt-03-image-assembly.md (236行) | 重写到 ≥450 行 |
| 07-常见坑 | prompt-04 后半部分 | 从 trim 拆出，扩充 |

---

## §四 文档生成计划

### 阶段 A：prompt 写作（新会话）

1. 重新读取 5 个现有 prompt → 分析缺陷（缺什么？）
2. 新写 3 个 prompt（00, 05, 07）
3. 重写 5 个现有 prompt 到质量标准
4. 全部 8 个 prompt ≥450 行

### 阶段 B：文档生成（新会话）

- 按 prompt 逐个生成 8 篇文档
- 每篇目标 2000-3000 行
- 总计 ~16K-24K 行

### 阶段 C：集成到 book/

- 每篇挂到 `book/00-build-system/` 下
- 更新 `book/README.md` 的 Part 0 规划

---

## §五 关键数据速查（供 prompt 写作使用）

### 构建目录规模
- `make/`: 220 files, ~124K lines
- `make/autoconf/`: configure 系统 (.m4)
- `make/hotspot/lib/`: 8 files (核心编译规则)
- `make/common/`: ~15 files (NativeCompilation.gmk = 1227 lines 核心框架)

### BUILD_LIBRARY 目标
```
make/hotspot/lib/CompileJvm.gmk:153 → BUILD_LIBJVM → libjvm.so (294MB)
make/hotspot/lib/CompileJvm.gmk:XX  → BUILD_LIBJSIG → libjsig.so (26KB)
```

JDK 原生库（部分）:
```
libjava.so, libnet.so, libnio.so, libzip.so, libjimage.so
libattach.so, libinstrument.so, libjdwp.so, libsaproc.so
libj2gss.so, libj2pcsc.so, libj2pkcs11.so, libjsound.so
libawt.so, libawt_xawt.so, libfontmanager.so, libfreetype.so
...
```

### 关键 configure 参数
| 参数 | 默认 | 说明 |
|------|------|------|
| `--with-jvm-variants=server` | server | server/client/minimal/core/zero/custom |
| `--with-debug-level=release` | release | release/fastdebug/slowdebug/optimized |
| `--with-native-debug-symbols=external` | external | none/internal/external/zipped |
| `--with-jvm-features=...` | 全部开启 | +/- 25 个特性开关 |
| `--with-boot-jdk` | 自动检测 | JDK 10 或 11 |
| `--with-target-bits=64` | 自动 | 32 或 64 |

### 构建三阶段
```
① autoconf → configure → generated-configure.sh → spec.gmk + Makefile
② make → gensrc → gendata → copy → java → libs (NativeCompilation.gmk) → launchers → jmods
③ images → exploded image → jdk image → jre image
```

### JVM 特性完整列表（25 个）
```
compiler1 compiler2 zero minimal dtrace jvmti jvmci graal vm-structs
jni-check services management cmsgc epsilongc g1gc parallelgc serialgc
shenandoahgc zgc nmt cds static-build link-time-opt aot jfr
```

### 5-layer source filter (libjvm.so)
```
Layer 1: CFLAGS macros → -DCOMPILER1 / -DINCLUDE_JFR=0
Layer 2: Source directories → JVM_SRC_DIRS from JvmFlags.gmk:34-41
Layer 3: Directory excludes → JVM_EXCLUDES (opto, libadt without compiler2)
Layer 4: File excludes → JVM_EXCLUDE_FILES (bcEscapeAnalyzer.cpp without c2)
Layer 5: Pattern excludes → JVM_EXCLUDE_PATTERNS (c2_, runtime_, gc/g1)
```

### 增量编译机制
- `.d` 文件：编译器 `-MMD` 生成 header 依赖
- `.vardeps` 文件：`DependOnVariable` 跟踪 CFLAGS 变化
- `.d.targets` 文件：处理删除的 header
- Object cleanup：删除多余 .o 文件

### 输出目录路径语义
```
build/linux-x86_64-normal-server-slowdebug/
├── hotspot/variant-server/libjvm/     ← 编译中间产物 (.o, .d, mapfile)
├── images/jdk/lib/server/libjvm.so    ← 最终 .so (294MB)
├── support/native/                    ← JDK 原生库编译产物
└── make-support/vardeps/             ← 增量编译状态缓存

命名规则: {os}-{cpu}-{jdk_variant}-{jvm_variant}-{debug_level}
示例: linux-x86_64-normal-server-slowdebug
```

---

## §六 与已有文档的关系

| 本书卷 | Phase | 关系 |
|--------|-------|------|
| **Vol 0 — 构建系统** | 29-build-customize | **本卷即 Phase 29 的全面升级** |
| Vol 1 — JVM 启动 | 01-jvm-startup + 13-launcher | §二 引用 Vol 0 替代 Build/Binary 说明 |
| Vol 2 — GC | 30-g1-runtime-gc + 01/gc 部分 | 同上 |
| Vol 3 — 解释器 | 15-core-native 部分 | 同上 |
| ... | ... | ... |

---

## §七 下一步

- [x] 规划 README 完成
- [ ] 用户确认拆分方案
- [ ] 新会话：重写+新写 8 个 prompt（≥450 行标准）
- [ ] 新会话：生成 8 篇文档
- [ ] 集成到 `book/00-build-system/`
