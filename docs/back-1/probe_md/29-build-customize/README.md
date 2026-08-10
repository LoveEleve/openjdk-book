# 29 — 构建与裁剪 — libjvm.so + 全部 .so

## §〇 概述

深度分析 OpenJDK 构建系统：configure → make pipeline → HotSpot 编译 → JDK 镜像组装 → 自定义裁剪。

**源码路径**：`make/`

### BUILD_LIBRARY

构建系统的目标就是生成 libjvm.so。入口：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

---

## §一 构建系统规模

```
make/ (220 files, ~124K lines)
├── autoconf/           configure 系统 (autoconf .m4)
│   ├── hotspot.m4      JVM 特性检测
│   ├── platform.m4     平台检测
│   └── toolchain.m4    编译器检测
├── Main.gmk            主构建管线
├── hotspot/
│   ├── lib/CompileJvm.gmk      libjvm.so 编译
│   ├── lib/JvmFeatures.gmk     JVM 特性开关
│   ├── lib/CompileLibraries.gmk 其他 HotSpot .so
│   └── gensrc/GenerateSources.gmk 源码生成
├── Images.gmk          镜像组装
├── common/             通用构建函数
└── jdk/                JDK 类库编译
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件 | 状态 |
|:---:|------|------|:---:|
| 00 | configure 系统 | hotspot.m4 / platform.m4 / toolchain.m4 | 待开始 |
| 01 | Main.gmk 构建管线 | Main.gmk | 待开始 |
| 02 | HotSpot 编译 — libjvm.so 如何诞生 | CompileJvm.gmk / JvmFeatures.gmk | 待开始 |
| 03 | JDK 镜像组装 — jmod/jlink/exploded image | Images.gmk | 待开始 |
| 04 | 自定义裁剪实战 | JVM_FEATURES + JVM_VARIANTS + JDK 模块 | 待开始 |

---

## §三 旧文档重叠

无。构建系统是全新分析领域，之前的 probe_md Phases 关注运行时源码，没有分析 make/。

## §四 待完成

- [x] 确定目录结构
- [ ] 写 prompt（并行 5 篇）
- [ ] 新会话生成文档
- [ ] Review
