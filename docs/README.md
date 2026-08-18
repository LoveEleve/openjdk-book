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

## 卷 2 · 运行时深处

> 从 JVM 的底层原语、对象模型与类加载，到编译器、GC、诊断和启动器，按依赖关系逐步深入 HotSpot 内部实现。

### 基础层

#### 01-os
* [01. JVM 怎么知道自己跑在容器里？— 平台探测](openjdk/vol-02/01-os/01-platform-detection.md)
* [02. "16G heap 在 8G 机器上？" — 虚拟内存、大页面与栈保护](openjdk/vol-02/01-os/02-virtual-memory.md)
* [03. JVM 内部有 7 种线程 — 它们谁先谁后？](openjdk/vol-02/01-os/03-threads-and-sync.md)
* [04. 一个 SIGSEGV,五件事一起做 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md)

#### 05-cpu-primitives
* [01. 原子操作与内存屏障 — LOCK cmpxchg 为什么这么贵？](openjdk/vol-02/05-cpu-primitives/01-atomic-and-memory-order.md)
* [02. RegisterMap + JavaFrameAnchor — GC 怎么找到栈上的引用？](openjdk/vol-02/05-cpu-primitives/02-safefetch-and-platform.md)

#### 45-math-library
* [01. Math.sin 的 2443 行 — 为什么不用一条 FSIN 指令？](openjdk/vol-02/45-math-library/01-poly-approximation.md)
* [02. StubRoutines 生成管道 — 2443 行汇编是怎么"造"出来的](openjdk/vol-02/45-math-library/02-stubroutine-native.md)

#### 48-utilities
* [01. vmError — hs_err_pid.log 是怎么写出来的](openjdk/vol-02/48-utilities/01-vmerror.md)
* [02. ConcurrentHashTable + BitMap — 无锁哈希表与位图](openjdk/vol-02/48-utilities/02-concurrent-bitmap.md)
* [03. 输出流与异常上报 — tty 到 fdStream,assert 到 gdb](openjdk/vol-02/48-utilities/03-stream-exception.md)
* [04. 三种格式工具 — modified UTF-8、JSON 解析、ELF 符号](openjdk/vol-02/48-utilities/04-utf8-json-decoder.md)

### 原语与底层结构

#### 02-assembler
* [01. CodeBuffer 与 AbstractAssembler — JIT 的"草稿纸"和"笔"](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md)
* [02. ModR/M → REX → VEX — 一个操作数的编码史](openjdk/vol-02/02-assembler/02-x86-register-operand-encoding.md)
* [03. x86 指令集 — JVM 的"常用字表"](openjdk/vol-02/02-assembler/03-x86-assembler-instruction-set.md)
* [04. MacroAssembler — 把指令拼成"运行时"](openjdk/vol-02/02-assembler/04-x86-macroassembler-runtime.md)

#### 03-arguments-flags
* [01. Flag 定义体系 — 一个宏,三次展开](openjdk/vol-02/03-arguments-flags/01-flag-definition-system.md)
* [02. Flag 的完整生命周期 — 从命令行到 jcmd](openjdk/vol-02/03-arguments-flags/02-flag-processing-and-management.md)

#### 04-logging
* [01. 标签与选择 — `-Xlog:gc*=debug` 是怎么工作的](openjdk/vol-02/04-logging/01-tag-and-selection.md)
* [02. 输出与配置 — 从日志消息到 gc.log](openjdk/vol-02/04-logging/02-output-and-configuration.md)

#### 06-oops
* [01. 对象头 — 一个 word,五种身份](openjdk/vol-02/06-oops/01-markoop-oopdesc.md)
* [02. Klass — 对象到类的桥](openjdk/vol-02/06-oops/02-klass-hierarchy.md)
* [03. InstanceKlass 与数组 — 元数据仓库与 GC 的两副面孔](openjdk/vol-02/06-oops/03-instanceklass-arrayklass.md)
* [04. 常量池与解析 — 字节码里的编号怎么变成直接指针](openjdk/vol-02/06-oops/04-constantpool-method.md)
* [05. Access API — 每次引用读写,GC 都在旁听](openjdk/vol-02/06-oops/05-access-api-barrier.md)
* [06. Symbol 与注解 — 让字符串全 JVM 只有一份](openjdk/vol-02/06-oops/06-symbol-annotations-aux.md)

#### 16-code-cache
* [01. 机器码的家 — CodeBlob 与 CodeHeap](openjdk/vol-02/16-code-cache/01-codeblob-heap.md)
* [02. nmethod 结构 — 一段编译方法里装了什么](openjdk/vol-02/16-code-cache/02-nmethod-structure.md)
* [03. nmethod 生命周期 — 扫除器怎么判断一段代码不需要了](openjdk/vol-02/16-code-cache/03-nmethod-lifecycle.md)
* [04. Relocation 与 Inline Cache — 机器码怎么认识自己](openjdk/vol-02/16-code-cache/04-relocation-ic.md)
* [05. Dependencies 与 Deopt — JIT 的乐观假设与自救](openjdk/vol-02/16-code-cache/05-dependencies-deopt.md)

#### 38-perfdata
* [01. PerfData 架构 — jstat 的数据从哪来](openjdk/vol-02/38-perfdata/01-perfdata.md)
* [02. StatSampler — 谁在周期性刷新计数器](openjdk/vol-02/38-perfdata/02-stat-sampler.md)

#### 41-zip-jimage
* [01. ZIP 文件读取 — JAR 里的类怎么被找到](openjdk/vol-02/41-zip-jimage/01-zip.md)
* [02. JIMAGE 模块镜像 — 为什么 JDK 不用 ZIP](openjdk/vol-02/41-zip-jimage/02-jimage.md)

#### 42-core-native
* [01. JNI 工具层与系统属性 — libjava 的骨架](openjdk/vol-02/42-core-native/01-jni-system.md)
* [02. 进程管理 — Runtime.exec 的 fork+exec 与进程查询](openjdk/vol-02/42-core-native/02-process.md)
* [03. ClassLoader + I/O + TimeZone — libjava 的剩下三件事](openjdk/vol-02/42-core-native/03-class-io.md)

### 对象与类

#### 07-classfile-classloader
* [01. ClassFile 解析 — .class 字节怎么变成 InstanceKlass](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md)
* [02. Verifier 与 StackMapTable — 字节码验证](openjdk/vol-02/07-classfile-classloader/02-verifier-stackmap.md)
* [03. SymbolTable + StringTable — 两个 intern 表](openjdk/vol-02/07-classfile-classloader/03-symbol-string-table.md)
* [04. SystemDictionary — 类的"全球电话号码本"](openjdk/vol-02/07-classfile-classloader/04-system-dictionary.md)
* [05. ClassLoader — 双亲委派与三层加载](openjdk/vol-02/07-classfile-classloader/05-classloader-hierarchy.md)
* [06. JPMS Modules — Java 9 的模块化革命](openjdk/vol-02/07-classfile-classloader/06-jpms-modules.md)
* [07. javaClasses — 核心类的 JVM 内建镜像](openjdk/vol-02/07-classfile-classloader/07-javaclasses-core-mirrors.md)

#### 09-memory-core
* [01. Universe + CollectedHeap — JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md)
* [02. VirtualSpace — 先占坑,后付费的虚拟地址管理](openjdk/vol-02/09-memory-core/02-virtualspace.md)
* [03. Arena + ResourceArea — VM 自己的 C++ 内存分配器](openjdk/vol-02/09-memory-core/03-arena-resourcearea-allocation.md)

#### 17-threads
* [01. JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md)
* [02. 线程怎么告诉 JVM "我不能 safepoint"？— JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md)
* [03. 线程退出了,别人怎么不 crash?— Thread-SMR 与 Handshake](openjdk/vol-02/17-threads/03-thread-smr-handshake.md)
* [04. 线程从 Java 进入 VM——这一瞬间怎么保证安全?— interfaceSupport](openjdk/vol-02/17-threads/04-interface-support.md)

### 执行与帧

#### 10-metaspace
* [01. Metaspace 全景 — PermGen 的继任者](openjdk/vol-02/10-metaspace/01-metaspace-overview.md)
* [02. Chunk + Metablock — 两级分配器](openjdk/vol-02/10-metaspace/02-chunk-metablock-allocation.md)
* [03. VirtualSpace 与归还 — chunk 从哪来又到哪去](openjdk/vol-02/10-metaspace/03-virtualspace-arena-reclaim.md)

#### 19-sync
* [01. synchronized 三步曲 — biased→BasicLock→ObjectMonitor](openjdk/vol-02/19-sync/01-lock-hierarchy.md)
* [02. 一个 Java Monitor 在 C++ 里怎么表示?— ObjectMonitor 结构](openjdk/vol-02/19-sync/02-objectmonitor-structure.md)
* [03. 多线程抢锁——谁先拿到?— Enter/Exit 与 Wait/Notify](openjdk/vol-02/19-sync/03-enter-exit-wait.md)
* [04. JVM 自己怎么锁自己?— VM 内部锁与安全网](openjdk/vol-02/19-sync/04-internal-locks.md)

#### 23-stub
* [01. JVM 启动时预生成哪些汇编例程?— StubRoutines 全局桩](openjdk/vol-02/23-stub/01-stub-entry.md)
* [02. System.arraycopy 为什么能比手写循环快 3 倍?— Arraycopy 向量化](openjdk/vol-02/23-stub/02-arraycopy.md)
* [03. AES、SHA、大数运算 — Crypto + Math Intrinsics](openjdk/vol-02/23-stub/03-crypto-math.md)

#### 24-frame
* [01. JVM 怎么表示一个栈帧？— Physical Frame](openjdk/vol-02/24-frame/01-physical-frame.md)
* [02. 编译代码内联了 3 层——怎么看到源级方法？— Virtual Frame](openjdk/vol-02/24-frame/02-virtual-frame.md)
* [03. deopt 怎么从编译帧重建解释器帧？— Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md)

#### 08-interpreter
* [01. 一条字节码的"档案"在哪？— Bytecode 定义表](openjdk/vol-02/08-interpreter/01-bytecodes-definition.md)
* [02. 一条字节码怎么变成 x86 机器码？— Template Interpreter](openjdk/vol-02/08-interpreter/02-template-interpreter.md)
* [03. 解释器怎么安全地调 C++？— InterpreterRuntime](openjdk/vol-02/08-interpreter/03-interpreter-runtime.md)
* [04. 符号引用怎么变成直接引用？— LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md)

#### 31-unsafe-whitebox
* [01. Java 怎么绕过一切检查摸内存？— Unsafe: JVM 底层 API](openjdk/vol-02/31-unsafe-whitebox/01-unsafe-api.md)
* [02. 测试与工具怎么拿到 JVM 内部？— WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md)

#### 44-class-verification
* [01. 恶意字节码怎么被拦下？— ClassVerifier 类型检查引擎](openjdk/vol-02/44-class-verification/01-verifier.md)
* [02. 验证器的类型宇宙 — VerificationType 类型系统](openjdk/vol-02/44-class-verification/02-verification-type.md)

### VM 核心

#### 11-cds
* [01. 启动时怎么让核心类秒加载？— CDS 全景与 Dump](openjdk/vol-02/11-cds/01-cds-overview-dump.md)
* [02. mmap 之后共享类怎么进 SystemDictionary？— mmap archive → shared spaces → 类就绪](openjdk/vol-02/11-cds/02-cds-load-shared.md)

#### 12-ci
* [01. JIT 怎么看到 Java 类？— ciObject 镜像体系](openjdk/vol-02/12-ci/01-ci-overview-mirror.md)
* [02. 编译器怎么知道"类型"与"逃逸"？— ciTypeFlow + bcEscapeAnalyzer](openjdk/vol-02/12-ci/02-ci-typeflow-escape.md)
* [03. 编译的"一次性生命"怎么收场？— ciObjectFactory + ciReplay](openjdk/vol-02/12-ci/03-ci-factory-runtime.md)

#### 13-jit-framework
* [01. 谁决定编译、怎么排队、谁执行？— CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md)
* [02. 为什么先 C1 再 C2？— TieredThresholdPolicy 5 层编译策略](openjdk/vol-02/13-jit-framework/02-tiered-compilation-policy.md)

#### 18-safepoint
* [01. JVM 怎么让所有线程同时停住？— Safepoint 编排](openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md)
* [02. 线程怎么知道自己该停了？— 轮询机制与 NoSafepointVerifier](openjdk/vol-02/18-safepoint/02-polling-verifiers.md)

#### 20-vm-operations
* [01. "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md)
* [02. 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md)

#### 27-jni
* [01. jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md)
* [02. JNI GetIntField 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](openjdk/vol-02/27-jni/02-jni-fast-path.md)
* [03. JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](openjdk/vol-02/27-jni/03-jni-check-platform.md)

#### 30-jvm-entry
* [01. System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md)
* [02. C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](openjdk/vol-02/30-jvm-entry/02-java-calls.md)
* [03. Method.invoke() 在 JVM 里怎么实现?— Reflection + StackWalk](openjdk/vol-02/30-jvm-entry/03-reflection-stackwalk.md)

#### 32-jfr
* [01. JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md)
* [02. JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md)
* [03. JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](openjdk/vol-02/32-jfr/03-periodic-sampling.md)
* [04. .jfr 文件是什么格式?— Binary Writer + Chunk Format](openjdk/vol-02/32-jfr/04-binary-writer.md)
* [05. JFR 怎么找到内存泄漏的 GC Root?— Old Object Sampling](openjdk/vol-02/32-jfr/05-leak-profiler.md)
* [06. Java 代码怎么控制 JFR?— JNI Interface + Instrumentation + DCmd](openjdk/vol-02/32-jfr/06-jni-instrumentation.md)

#### 34-nmt
* [01. 每次 malloc 怎么被追踪到 call-site?— NMT 追踪系统](openjdk/vol-02/34-nmt/01-tracking.md)
* [02. jcmd VM.native_memory summary 怎么生成?— NMT 报告](openjdk/vol-02/34-nmt/02-nmt-report.md)

#### 36-attach
* [01. jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md)
* [02. 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](openjdk/vol-02/36-attach/02-jdk-attach.md)

#### 37-heap-dumper
* [01. jmap -dump 怎么工作?— HeapDumper + hprof 格式](openjdk/vol-02/37-heap-dumper/01-heap-dumper.md)
* [02. 流式压缩 + 多触发入口 — jcmd/JMX/JFR/OOM](openjdk/vol-02/37-heap-dumper/02-compression-triggers.md)

#### 39-runtime-monitoring
* [01. JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md)
* [02. Timer + Monitoring Services — 高精度计时 + JMX 统计](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md)

#### 46-sa-postmortem
* [01. SA Postmortem — core dump + ptrace + ELF symbols](openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md)

### 编译器与 GC

#### 14-c1-compiler
* [01. C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md)
* [02. C1 优化 — Canonicalizer + ValueMap + Optimizer](openjdk/vol-02/14-c1-compiler/02-c1-optimizations.md)
* [03. LinearScan + LIR → x86 码](openjdk/vol-02/14-c1-compiler/03-c1-register-codegen.md)
* [04. Runtime1 + FrameMap — C1 runtime 与栈帧](openjdk/vol-02/14-c1-compiler/04-c1-runtime-frame.md)

#### 15-c2-compiler
* [01. C2 Ideal Graph: Node + Type + IGVN — C2 的节点海](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md)
* [02. Parse + GraphKit — 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md)
* [03. IGVN + CCP + Escape Analysis — C2 优化三引擎](openjdk/vol-02/15-c2-compiler/03-c2-optimizations.md)
* [04. Loop Optimization + SuperWord — 循环变换与向量化](openjdk/vol-02/15-c2-compiler/04-c2-loops.md)
* [05. Chaitin — 图着色寄存器分配 O(n²)](openjdk/vol-02/15-c2-compiler/05-c2-register-alloc.md)
* [06. Matcher + Code Generation — DFA 指令选择 → x86 机码](openjdk/vol-02/15-c2-compiler/06-c2-codegen.md)
* [07. PhaseMacroExpand — 高层抽象→低层 MachNode 展开](openjdk/vol-02/15-c2-compiler/07-c2-macro-intrinsics.md)
* [08. library_call.cpp — 6991 行的 intrinsic 世界](openjdk/vol-02/15-c2-compiler/08-c2-library-calls.md)

#### 21-shared-runtime
* [01. 编译代码遇到问题——向谁求助?— Runtime Stubs](openjdk/vol-02/21-shared-runtime/01-runtime-stubs.md)
* [02. 从编译跳到解释——c2i/i2c Adapter](openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md)
* [03. 编译代码里抛了异常——JVM 怎么找 handler?— 异常处理](openjdk/vol-02/21-shared-runtime/03-exception-handling.md)

#### 25-gc-framework
* [01. GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md)
* [02. new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md)
* [03. SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md)
* [04. 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue](openjdk/vol-02/25-gc-framework/04-workgang-taskqueue.md)
* [05. 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue](openjdk/vol-02/25-gc-framework/05-cardtable-dirtycardq.md)
* [06. 字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats](openjdk/vol-02/25-gc-framework/06-oopstorage-stringdedup-stats.md)

#### 28-jvmti
* [01. JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md)
* [02. 怎么不重启 JVM 替换一个类的字节码？— RedefineClasses](openjdk/vol-02/28-jvmti/02-redefine-classes.md)
* [03. 为每个对象打 tag — TagMap + 事件分派细节](openjdk/vol-02/28-jvmti/03-auxiliary.md)

#### 29-mh
* [01. invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路](openjdk/vol-02/29-mh/01-invoke-chain.md)
* [02. ricochet frame 怎么传参数？— x86 Adapter Stubs](openjdk/vol-02/29-mh/02-x86-adapter.md)

#### 33-jmx
* [33. JConsole 怎么知道 Eden 用了多少?— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md)
* [02. JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management](openjdk/vol-02/33-jmx/02-jmm-interface.md)
* [03. 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags](openjdk/vol-02/33-jmx/03-gc-notifier-flags.md)

#### 43-nio-net
* [01. TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md)
* [02. UDP + DNS + NetworkInterface — Datagram + InetAddress](openjdk/vol-02/43-nio-net/02-udp-dns.md)
* [03. NIO FileSystem — stat/readdir/inotify](openjdk/vol-02/43-nio-net/03-filesystem.md)

### 诊断、启动与 Instrumentation

#### 22-deoptimization
* [01. 编译代码什么时候回退？— Deopt 决策表](openjdk/vol-02/22-deoptimization/01-deopt-decision.md)
* [02. 从编译帧回到解释器——unpack 帧重建](openjdk/vol-02/22-deoptimization/02-unpack-frames.md)

#### 26-g1-gc
* [01. 堆被切成 2048 块 — HeapRegion + G1CollectedHeap](openjdk/vol-02/26-g1-gc/01-heapregion.md)
* [02. 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](openjdk/vol-02/26-g1-gc/02-concurrent-marking.md)
* [03. Region A 里谁引用了 Region B？— RSet + CardTable 并发细化](openjdk/vol-02/26-g1-gc/03-rem-set.md)
* [04. new Object() 在 G1 里走到哪？— 分配与晋升](openjdk/vol-02/26-g1-gc/04-allocation.md)
* [05. 什么时候做 Young？什么时候做 Mixed？— 策略与集合选择](openjdk/vol-02/26-g1-gc/05-mixed-gc-policy.md)
* [06. G1 的写屏障为什么最重？— G1BarrierSet Pre/Post Barrier](openjdk/vol-02/26-g1-gc/06-g1-barrier.md)
* [07. G1 的最后手段 — Full GC + 根处理 + 辅助](openjdk/vol-02/26-g1-gc/07-full-gc-roots.md)

#### 35-dcmd
* [01. jcmd Thread.print 怎么走到 DCmd 执行？— DCmd Framework](openjdk/vol-02/35-dcmd/01-dcmd-framework.md)
* [02. jcmd 可以做什么？— 内置命令详解](openjdk/vol-02/35-dcmd/02-builtin-commands.md)

#### 40-launcher
* [01. java MyApp 在命令行后发生了什么事？— 启动流程](openjdk/vol-02/40-launcher/01-launch-flow.md)
* [02. 参数解析 + 平台 JVM 加载](openjdk/vol-02/40-launcher/02-args-platform.md)

#### 47-instrumentation
* [01. JPLIS Agent → JVMTI ClassFileLoadHook — bytecode 转换管道](openjdk/vol-02/47-instrumentation/01-jplis-agent.md)
* [02. redefine + retransform + 重入保护 — 运行时字节码修改](openjdk/vol-02/47-instrumentation/02-agent-entry.md)


## 卷 Java · JDK 11 Java 层源码

* [Java 层源码正文入口](openjdk/vol-java/README.md) — 并发集合、线程池、异步编程、IO、时间日期、JMX、JFR、Unsafe 与诊断工具

## 卷 1-bak · 启动（已归档）

* [启动链旧版 14 章](openjdk/vol-01-bak/ch01) — Launcher→JavaMain→JNI_CreateJavaVM→init_globals→G1 初始化；按启动链叙事组织，新写作不再沿用此结构，归档备查

