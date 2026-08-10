# 第 3 章：构建与自定义裁剪 — 深度分析

不只是一个 md。OpenJDK 构建系统 220 文件 124K 行，拆成 5 篇深度文档。

## 文档拆分

| 编号 | 标题 | 核心分析对象 | 预计行数 |
|:---:|------|------|:---:|
| 00 | configure 系统 | autoconf/hotspot.m4 + platform 检测 + JVM_FEATURES | ~2,000 |
| 01 | Main.gmk 构建管线 | target 依赖图 + 分阶段编译 + build 产物目录 | ~2,000 |
| 02 | HotSpot 编译 | CompileJvm.gmk + JVM_FEATURES 条件编译 + libjvm.so | ~2,500 |
| 03 | JDK 镜像组装 | Images.gmk + exploded image + jmod/jlink → tar.gz | ~2,000 |
| 04 | 自定义裁剪实战 | 三把刀实战：最小化 JDK 的完整参数 + 验证方法 | ~2,000 |

## 每篇文档格式

按书籍章节格式（非 probe_md prompt 格式）：
- `# 标题 — 副标题`
- 原理驱动，源码引用（file:line）作证据
- Mermaid 流程图
- 对照表
- 每节末尾有小结或关键要点
