# 48 域写作依赖序(拓扑排序)— 域写作顺序方法论

> 2026-08-11 | 依据: WRITING-GUIDELINES.md §2 依赖驱动排序("A 依赖 B,就先写 B")+ 00-domain-discovery-v3.md 域定义 + planning/outlines 各域大纲读者处境
> 目的: 替换 HANDOFF-JVM-WRITING 阶段 A-D(该顺序按"工具素材关联深度"排序,与依赖驱动方法论冲突——32-jfr 依赖 17/18/24/06 等基础域,不能最先写)
> 定义: **写作依赖** = 读者理解域 X 的文章,需要先具备域 Y 的概念。不是代码调用关系,是知识前置关系。

## 一、方法

1. 每个域列出"前置域"(读者理解它前必须已有的概念)
2. 去环: 06↔07、17↔19 等概念循环按教学惯例指定先后(注明)
3. 拓扑排序 → 分层(同层内按域号),层间严格依赖,层内可自由排
4. 产出写作顺序: 从层 0 开始,一层层推进

## 二、48 域依赖表

| 域 | 名称 | 前置域 | 依赖理由 |
|---|---|---|---|
| 01 | OS 抽象层 | — | 平台系统调用层,一切的地基 |
| 05 | CPU Primitives | — | 原子/内存屏障硬件原语,无前置 |
| 45 | Math Library | — | 独立数学库(libfdlibm) |
| 48 | Utilities | — | 基础设施工具类(vmError/ELF 解析等) |
| 02 | Assembler | 05 | 汇编生成基于指令级原语概念 |
| 03 | Arguments & Flags | 01 | 参数解析依赖 OS 启动环境 |
| 04 | Logging | 01 | ULF 日志框架,OS 时间/输出基础 |
| 06 | OOPs | 01, 05 | 对象头 mark word 含原子/锁位;内存分配依赖 OS |
| 16 | Code Cache | 01 | 可执行内存映射区,OS 虚拟内存概念 |
| 38 | PerfData | 01 | mmap 内存计数器 |
| 41 | ZIP & JIMAGE | 01 | 镜像文件 mmap 映射 |
| 42 | Core Native | 01 | libjava.so 原生实现 |
| 07 | ClassFile & ClassLoader | 06 | 类加载产物是 oop/klass,klass 结构在 06 |
| 09 | Memory Core | 06 | 堆里装的是 oop,先懂对象再懂堆 |
| 17 | Threads | 01, 05 | 线程对象/生命周期,OS 线程+同步原语 |
| 08 | Interpreter | 06, 07, 02, 24 | 解释执行读字节码(07)、操作 oop(06)、生成/维护帧(24) |
| 10 | Metaspace | 07, 09 | 存类元数据(07 产物),内存管理(09 概念) |
| 19 | Synchronization | 06, 17 | 锁状态位在对象头 mark word(06),锁由线程持有(17) |
| 23 | Stub Routines | 02, 16 | 手写汇编桩(02),blob 存代码缓存(16) |
| 24 | Frame & Stack | 06, 17 | 栈帧引用 oop(06),帧挂在线程栈(17) — **枢纽域** |
| 31 | Unsafe & WhiteBox | 06, 09 | 直接操作 oop/内存 |
| 44 | Class Verification | 07 | 验证对象是字节码(07 产物) |
| 11 | CDS | 07, 10 | 归档类(07)与元数据(10) |
| 12 | Compiler Interface (ci) | 06, 07, 24 | 编译需要读类(07)、造 oop(06)、表示帧(24) |
| 13 | JIT Framework | 08, 16 | 分层编译从解释器出发(08),产物进代码缓存(16) |
| 18 | Safepoint | 17, 24 | 停线程(17)、扫栈(24) |
| 20 | VM Operations | 17, 18 | VM 操作依赖线程暂停(18) |
| 27 | JNI | 17, 24 | JNI 帧与句柄(24),线程绑定(17) |
| 30 | JVM Entry Points | 08, 02 | 各模块入口桩,解释器/汇编概念 |
| 32 | JFR | 06, 17, 18, 24 | 事件写对象(06)、thread-local(17)、安全点采样(18)、栈采样(24) |
| 34 | NMT | 01, 09 | 内存跟踪,虚拟内存(01)+堆内存(09) |
| 36 | Attach | 01, 17 | attach socket(01)+ listener 线程(17) |
| 37 | Heap Dumper | 06, 09, 18 | 遍历 oop(06)、堆(09)、STW dump(18) |
| 39 | Runtime Monitoring | 17, 38 | 监控线程(17)读 PerfData(38) |
| 46 | SA Postmortem | 06, 09, 24 | 读 oop/klass(06)、堆(09)、栈(24) |
| 14 | C1 编译器 | 13, 16, 24 | C1 是 JIT 层(13),产物进缓存(16),帧(24) |
| 15 | C2 编译器 | 12, 13, 16, 24 | C2 用 ci(12),是 JIT 层(13),帧(24) |
| 21 | Shared Runtime | 06, 13, 24 | 编译代码调用的运行时辅助,依赖帧(24)/JIT(13) |
| 25 | GC Framework | 06, 09, 17, 18, 24 | 扫 oop(06)、堆(09)、线程(17)、安全点(18)、栈(24) |
| 28 | JVMTI | 17, 24, 36 | 事件回调(线程/帧),agent 加载(36) |
| 29 | Method Handles | 06, 07, 13 | 签名多态调用,类(07)/JIT(13) |
| 33 | JMX & Management | 09, 39 | 内存池(09)监控(39)暴露 MBean |
| 43 | NIO & Net | 42 | 网络原生实现在 core native 之上 |
| 22 | Deoptimization | 15, 24 | 撤销 C2 优化假设(15),重建帧(24) |
| 26 | G1 GC | 09, 18, 25 | G1 是 GC 框架(25)的实现 |
| 35 | Diagnostic Commands | 33, 36 | dcmd 走 JMX(33)+ attach(36) |
| 40 | Launcher | 27, 41 | java 命令调 JNI(27)、读模块镜像(41) |
| 47 | Instrumentation | 07, 28 | 类重定义(07),实现走 JVMTI(28) |

**循环处理说明**: 06↔07(klass 由类文件创建、类加载器又是 oop)、17↔19(锁在线程上、线程用锁)——教学惯例: 06 先于 07(先对象模型再类加载),17 先于 19(先线程再同步)。

## 三、拓扑排序结果(7 层,从基础到上层)

```
层 0(地基,4):   01-os, 05-cpu, 45-math, 48-utils
层 1(原语,8):   02-assembler, 03-flags, 04-logging, 06-oops, 16-codecache, 38-perfdata, 41-zipjimage, 42-core-native
层 2(对象/类/线程,3):  07-classfile-classloader, 09-memory-core, 17-threads
层 3(执行/帧/锁,7):   08-interpreter, 10-metaspace, 19-sync, 23-stub, 24-frame-stack, 31-unsafe, 44-verification
层 4(VM 核心,13):     11-cds, 12-ci, 13-jit, 18-safepoint, 20-vmops, 27-jni, 30-jvm-entry, 32-jfr, 34-nmt, 36-attach, 37-heapdump, 39-runtime-mon, 46-sa
层 5(JIT/GC 主体,8):  14-c1, 15-c2, 21-shared-runtime, 25-gc-framework, 28-jvmti, 29-method-handles, 33-jmx, 43-nio-net
层 6(上层应用,5):    22-deopt, 26-g1, 35-dcmd, 40-launcher, 47-instrumentation
```

## 四、写作顺序(建议推进序)

```
第 1 批(地基):     01 → 05 → 45 → 48
第 2 批(原语):     02 → 03 → 04 → 06 → 16 → 38 → 41 → 42
第 3 批(对象/类):  07 → 09 → 17
第 4 批(执行/帧):  08 → 10 → 19 → 23 → 24 → 31 → 44
第 5 批(VM 核心):  11 → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46
第 6 批(JIT/GC):   14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层):     22 → 26 → 35 → 40 → 47
```

## 五、关键调整说明(相对旧规划)

1. **32-jfr 从"第 1 优先"移到第 5 批**: 它依赖 06/17/18/24——写 JFR 栈采样前必须先有 18-safepoint 与 24-frame 的概念(domain-discovery v3 已声明"JFR 栈采样依赖 frame 域")。工具素材策略不变: 每篇文章内引用实测实证(rec-demo.jfr、SafepointBegin 2710 等),不影响顺序。
2. **18-safepoint 在第 5 批**: 依赖 17(线程)/24(帧),先于 20-vmops/25-gc/32-jfr——安全点是大量域的枢纽前置。
3. **24-frame 在第 4 批**: 枢纽域,被 08/12/13/18/22/25/27/28/32/37/46 依赖,必须早写。
4. **25-gc 在第 6 批**: 依赖 18/24 齐备后,GC 主体才可写;26-g1 在其后。
5. **13-jit 在第 5 批**: 先有 08 解释器与 16 代码缓存。

## 六、与工具卷的关系

工具卷(卷 T)是"观测前置",已按工具篇教学顺序(01 JFR→07 镜像)写完。域文章写作时,工具卷素材作为**文内实证引用**(每篇文章的"看见了什么"部分),不改变域依赖序。

## 七、待办

- [ ] 按此顺序推进写作;每域完成后在 README 卷 2 区块勾选
- [ ] 层内顺序(如 08 vs 24)写作时按实际大纲微调,微调需注明理由
