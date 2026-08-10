# HotSpot JVM 深度解析 — 书籍规划

## 目标读者

Java 进阶开发者，有 C/C++ 阅读能力，想理解 JVM 内部原理而非仅使用 -XX 参数。

## 内容来源

基于 `probe_md/` 下 ~215K 行深度源码分析文档，重组为教学型书籍结构。

## 策略

1. **前置知识先行**：C++ 惯用法 + Linux 系统编程 → 铺平阅读障碍
2. **从启动到运行**：按 JVM 实际生命周期组织章节
3. **原理 > 源码**：正文以原理驱动，源码引用（file:line）作为证据
4. **去掉 AI 脚手架**：去掉 GDB 验证、Prohibited/Required、对照表等 prompt 脚手架

## Part 划分

```
Part 0 — 前置知识 (3 章)
Part 1 — JVM 启动 (启动器 + libjvm.so 初始化)
Part 2 — 类加载 (ClassFileParser → InstanceKlass)
Part 3 — 对象模型 (OOP/Klass + TLAB + HashCode)
Part 4 — 执行引擎 (解释器 + 编译管道)
Part 5 — 内存与 GC (G1 + Metaspace)
Part 6 — 并发 (线程/锁/Safepoint/ThreadSMR)
Part 7 — 诊断 (Xlog/JFR/JMX/SA/hs_err)
```

## 目录

```
book/
├── README.md                    # 本文件
├── 00-prerequisites/
│   ├── README.md                # Part 0 规划
│   ├── 00-cpp-in-hotspot.md
│   ├── 01-linux-system-programming.md
│   └── 02-hotspot-source-guide.md
├── 01-jvm-startup/
│   └── README.md
├── 02-class-loading/
│   └── README.md
└── ...
```
