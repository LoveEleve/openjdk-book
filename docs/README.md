<div class="home-mug">
<span class="home-rain">0 1 1 0 1 0 1 1<br>1 0 0 1 0 1 0 0<br>1 1 0 0 1 0 1 1<br>0 0 1 1 0 1 0 0<br>1 0 1 0 1 1 0 1</span>
<svg viewBox="0 0 140 160" width="96" height="110">
  <defs><style>.s{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;}</style></defs>
  <path class="s" d="M60 35Q50 15 60 0" stroke-width="2"/>
  <path class="s" d="M70 30Q80 10 70-5" stroke-width="2"/>
  <path class="s" d="M80 35Q90 18 80 2" stroke-width="2"/>
  <path class="s" d="M108 55Q135 55 135 80Q135 108 105 105" stroke-width="2.5"/>
  <path class="s" d="M30 45L38 110Q40 115 70 115Q100 115 102 110L110 45" stroke-width="2.5"/>
  <ellipse class="s" cx="70" cy="45" rx="40" ry="10" stroke-width="2.5"/>
  <path class="s" d="M32 55Q70 65 108 55" stroke-width="1.2" opacity=".5"/>
</svg>
<sub>java是世界上最好的语言.py</sub>
</div>

# 格物致知：OpenJDK 源码分析

## 卷 0 · 地基

* [第一章 — java 命令到底是什么](openjdk/vol-00/ch01.md) — 一个 C 编译出来的可执行文件
* [第二章 — 编译你自己的 JDK](openjdk/vol-00/ch02.md) — configure → make → 你的第一个 JDK
* [第三章 — make 到底做了什么](openjdk/vol-00/ch03.md) — 8 阶段流水线拆解 make 的 1 分 31 秒
* [第四章 — jdk11u-copy：裁剪、CMake 与 IDE](openjdk/vol-00/ch04.md) — 从 Make 到 CMake，秒级增量编译

## 卷 T · 工具观测（先读：怎么"看见"一个活着的 JVM）

* [第一章 — 先录一次 JFR，看见整个 JVM](openjdk/vol-tools/ch01.md) — JFR 录制 + JMC 29 页签 + jfr CLI
* [第二章 — jcmd 万能诊断命令](openjdk/vol-tools/ch02.md) — 49 个子命令 + 六个典型输出精读
* [第三章 — 堆里到底有什么](openjdk/vol-tools/ch03.md) — jmap 三路导出 + MAT 四板斧 + GCViewer/VisualVM 对照
* [第四章 — 代码怎么被加工](openjdk/vol-tools/ch04.md) — javap 字节码 + 编译日志/内联决策
* [第五章 — 钻到 JVM 肚子里](openjdk/vol-tools/ch05.md) — jhsdb/clhsdb 白盒读内存 + jsnap
* [第六章 — JMX 与火焰图](openjdk/vol-tools/ch06.md) — jconsole MBean 树 + perf 内核采样 + 栈折叠
* [第七章 — 翻开 JDK 的箱子](openjdk/vol-tools/ch07.md) — jimage 镜像 + jlink 最小运行时 + jdeps 依赖图

## 卷 2 · 运行时深处（已完成，152/152）

> 组织方式: 按 `planning/outlines/` 的 48 域目录、152 篇正文大纲逐域写作
> 写作顺序: 48 域依赖拓扑 7 层（见 [00-domain-writing-order.md](openjdk/planning/knowledge-planning/00-domain-writing-order.md)）
> 收官总表: [卷 2 README](openjdk/vol-02/README.md) · [SESSION-HANDOFF](openjdk/SESSION-HANDOFF.md)

* 第 1 批（地基，12/12）: [01-os](openjdk/vol-02/01-os/) → [05-cpu-primitives](openjdk/vol-02/05-cpu-primitives/) → [45-math-library](openjdk/vol-02/45-math-library/) → [48-utilities](openjdk/vol-02/48-utilities/)
* 第 2 批（原语，26/26）: [02-assembler](openjdk/vol-02/02-assembler/) → [03-arguments-flags](openjdk/vol-02/03-arguments-flags/) → [04-logging](openjdk/vol-02/04-logging/) → [06-oops](openjdk/vol-02/06-oops/) → [16-code-cache](openjdk/vol-02/16-code-cache/) → [38-perfdata](openjdk/vol-02/38-perfdata/) → [41-zip-jimage](openjdk/vol-02/41-zip-jimage/) → [42-core-native](openjdk/vol-02/42-core-native/)
* 第 3 批（对象/类，14/14）: [07-classfile-classloader](openjdk/vol-02/07-classfile-classloader/) → [09-memory-core](openjdk/vol-02/09-memory-core/) → [17-threads](openjdk/vol-02/17-threads/)
* 第 4 批（执行/帧，21/21）: [10-metaspace](openjdk/vol-02/10-metaspace/) → [19-sync](openjdk/vol-02/19-sync/) → [23-stub](openjdk/vol-02/23-stub/) → [24-frame](openjdk/vol-02/24-frame/) → [08-interpreter](openjdk/vol-02/08-interpreter/) → [31-unsafe-whitebox](openjdk/vol-02/31-unsafe-whitebox/) → [44-class-verification](openjdk/vol-02/44-class-verification/)
* 第 5 批（VM 核心，32/32）: [11-cds](openjdk/vol-02/11-cds/) → [12-ci](openjdk/vol-02/12-ci/) → [13-jit-framework](openjdk/vol-02/13-jit-framework/) → [18-safepoint](openjdk/vol-02/18-safepoint/) → [20-vm-operations](openjdk/vol-02/20-vm-operations/) → [27-jni](openjdk/vol-02/27-jni/) → [30-jvm-entry](openjdk/vol-02/30-jvm-entry/) → [32-jfr](openjdk/vol-02/32-jfr/) → [34-nmt](openjdk/vol-02/34-nmt/) → [36-attach](openjdk/vol-02/36-attach/) → [37-heap-dumper](openjdk/vol-02/37-heap-dumper/) → [39-runtime-monitoring](openjdk/vol-02/39-runtime-monitoring/) → [46-sa-postmortem](openjdk/vol-02/46-sa-postmortem/)
* 第 6 批（JIT/GC，32/32）: [14-c1-compiler](openjdk/vol-02/14-c1-compiler/) → [15-c2-compiler](openjdk/vol-02/15-c2-compiler/) → [21-shared-runtime](openjdk/vol-02/21-shared-runtime/) → [25-gc-framework](openjdk/vol-02/25-gc-framework/) → [28-jvmti](openjdk/vol-02/28-jvmti/) → [29-mh](openjdk/vol-02/29-mh/) → [33-jmx](openjdk/vol-02/33-jmx/) → [43-nio-net](openjdk/vol-02/43-nio-net/)
* 第 7 批（上层，15/15）: [22-deoptimization](openjdk/vol-02/22-deoptimization/) → [26-g1-gc](openjdk/vol-02/26-g1-gc/) → [35-dcmd](openjdk/vol-02/35-dcmd/) → [40-launcher](openjdk/vol-02/40-launcher/) → [47-instrumentation](openjdk/vol-02/47-instrumentation/)

## 卷 1-bak · 启动（已归档）

* [启动链旧版 14 章](openjdk/vol-01-bak/ch01) — Launcher→JavaMain→JNI_CreateJavaVM→init_globals→G1 初始化；按启动链叙事组织，新写作不再沿用此结构，归档备查

## 卷 2 · 对象 — Java 的 C++ 真身

oop / Klass / markOop / 压缩指针 — 每个 Java 对象在 C++ 里的精确映射

## 卷 3 · 类加载 — .class 到 Klass

ClassFileParser / SystemDictionary / CDS — 类是怎么进入 JVM 的

## 卷 4 · 解释器 — 字节码执行

TemplateInterpreter / codelet / 256 字节码 — 解释执行的全路径

## 卷 5 · C1 编译器 — 快速执行路径

8 Phase 快速编译管线 — HIR 构建 → LinearScan 寄存器分配

## 卷 6 · C2 编译器 — 极致性能

Sea-of-Nodes / GVN / 内联 / 逃逸分析 / Chaitin 寄存器分配

## 卷 7 · 代码管理 — CodeCache / nmethod / Deopt

编译产物的生老病死 — 从 CodeCache 分配到 Sweeper 回收

## 卷 8 · G1 GC — 内存的生死轮回

Region / TAMS / SATB / RSet / Young GC / Mixed GC / Full GC — G1 的全部秘密

## 卷 9 · 多 GC 对比 — 全景视野

Serial / Parallel / CMS / G1 / ZGC / Shenandoah — 6 种 GC 的设计哲学对比

## 卷 10 · 线程与锁 — 并发根基

ObjectMonitor / 偏向锁 / ParkEvent — synchronized 的完整 C++ 实现

## 卷 11 · Safepoint + 信号处理

Polling Page / VM_Operation / libjsig — JVM 如何安全地暂停整个世界

## 卷 12 · 边界 — JNI / JVMTI / Unsafe / JPMS

JVM 与外部世界的所有桥梁 — 从 231 个 JNI 函数到模块系统

## 卷 13 · 诊断与定制 — UL / JMX / JFR / SA / 构建

让 JVM 告诉你它在做什么 — 日志 / 监控 / 飞行记录 / 事后调试 / 定制裁剪
