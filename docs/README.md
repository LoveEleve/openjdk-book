<!-- Hero 区域 -->
<div class="hero-section">
  <div class="hero-content">
    <h1 class="hero-title">格物致知：OpenJDK 源码分析</h1>
    <p class="hero-slogan">14 卷 · ~230 章</p>
    <div class="hero-social">
      <a href="https://github.com/LoveEleve" target="_blank" rel="noopener" class="social-link" title="GitHub">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
      </a>
    </div>
  </div>
</div>

<!-- 首页专栏列表：可折叠 -->
<div class="home-sections">

<details class="home-section" open>
  <summary>
    <span class="section-title">C++ 语法速查</span>
  </summary>
  <div class="section-content">

* [总览 — 按出现顺序的语法索引](openjdk/vol-00/cxx/README.md)

  </div>
</details>

<details class="home-section" open>
  <summary>
    <span class="section-title">卷 0 · 地基</span>
  </summary>
  <div class="section-content">

* [第一章 — java 命令到底是什么](openjdk/vol-00/ch01.md) - 一个 C 编译出来的可执行文件
* [第二章 — 编译你自己的 JDK](openjdk/vol-00/ch02.md) - configure -> make -> 你的第一个 JDK
* [第三章 — make 到底做了什么](openjdk/vol-00/ch03.md) - 8 阶段流水线拆解 make 的 1 分 31 秒
* [第四章 — jdk11u-copy：裁剪、CMake 与 IDE](openjdk/vol-00/ch04.md) - 从 Make 到 CMake，秒级增量编译

  </div>
</details>

<details class="home-section" open>
  <summary>
    <span class="section-title">卷 1 · 启动</span>
  </summary>
  <div class="section-content">

* [第一章 — Launcher Chain](openjdk/vol-01/ch01) - main.c -> JLI_Launch -> dlopen -> dlsym
* [第二章 — JavaMain → InitializeJVM](openjdk/vol-01/ch02.md) - JavaMainArgs 解包 → CreateJavaVM 调用
* [第三章 — JNI_CreateJavaVM](openjdk/vol-01/ch03/01-overview.md) - Atomic::xchg 守卫 → Threads::create_vm
  * [3.1 概览：进程线程模型 + _inner 全貌](openjdk/vol-01/ch03/01-overview.md)
  * [3.2 Threads::create_vm 总览](openjdk/vol-01/ch03/02-threads-create-vm.md)
  * [3.3 前置初始化](openjdk/vol-01/ch03/03-preamble-init.md)
  * [3.4 参数解析](openjdk/vol-01/ch03/04-args-parse.md)
  * [3.5 OS 后初始化](openjdk/vol-01/ch03/05-os-init2.md)
  * [3.6 Stage 4 主线程创建](openjdk/vol-01/ch03/06-main-thread-create.md)
* [第四章 — vm_init_globals](openjdk/vol-01/ch04.md) - 7 项全局基础设施 + 主线程绑定
* [第五章 — mutex_init](openjdk/vol-01/ch05.md) - ~90 锁 + 10 级 ranking 系统
* [第六章 — CodeCache](openjdk/vol-01/ch06.md) - 三段 JIT 代码内存
* [第七章 — VM_Version_init](openjdk/vol-01/ch07.md) - CPU 特性探测与 Intrinsic 级联
* [第八章 — stubRoutines_init1](openjdk/vol-01/ch08.md) - 16 个早期桩代码
* [第九章 — classLoader_init1](openjdk/vol-01/ch09.md) - Bootstrap Classpath 与 Zip 库
* [第十章 — universe_init 总览](openjdk/vol-01/ch10.md) - init_globals 的转折点
* [第十一章 — G1CollectedHeap：18步堆创建](openjdk/vol-01/ch11-heap/01-overview.md)
  * [11.2 HeapRegion——堆的原子单位](openjdk/vol-01/ch11-heap/02-region.md)
  * [11.3 Card Table——跨 Region 写跟踪](openjdk/vol-01/ch11-heap/03-card-table.md)
  * [11.4 BOT——Block Offset Table](openjdk/vol-01/ch11-heap/04-bot.md)
  * [11.5 HeapRegionManager](openjdk/vol-01/ch11-heap/05-manager.md)
  * [11.6 mmap 预留与辅助内存](openjdk/vol-01/ch11-heap/06-mmap.md)
* [第十二章 — Metaspace](openjdk/vol-01/ch12.md) - 类元数据的内存管理
* [第十三章 — SymbolTable + StringTable](openjdk/vol-01/ch13.md) - 并发安全的符号存储
* [第十四章 — G1Policy + ConcurrentMark](openjdk/vol-01/ch14.md) - GC 调度基础设施
* [第十五章 — GC 屏障桩](openjdk/vol-01/ch15.md) - G1 SATB 写屏障
* [第十六章 — TemplateInterpreter：286 Codelet](openjdk/vol-01/ch16-interpreter/01-overview.md)
  * [16.2 CodeletMark——RAII 提交](openjdk/vol-01/ch16-interpreter/02-codelet.md)
  * [16.3 TosState——11 种栈顶类型](openjdk/vol-01/ch16-interpreter/03-tosstate.md)
  * [16.4 generate_all()——分类生成](openjdk/vol-01/ch16-interpreter/04-generate-all.md)
* [第十七章 — InvocationCounter](openjdk/vol-01/ch17.md) - 编译阈值状态机
* [第十八章 — 微小初始化](openjdk/vol-01/ch18.md) - sizeof 断言/GC 种子/寄存器名
* [第十九章 — TemplateTable](openjdk/vol-01/ch19.md) - 256 字节码的设计图纸
* [第二十章 — SharedRuntime 桩](openjdk/vol-01/ch20.md) - 6 个 Resolve Blob
* [第二十一章 — 类型系统](openjdk/vol-01/ch21.md) - TypeArrayKlass 与核心类偏移
* [第二十二章 — vmStructs + PrintFlags](openjdk/vol-01/ch22.md) - SA 调试与配置归档
* [第二十三章 — 引用 + JNI 句柄](openjdk/vol-01/ch23.md) - 软引用时钟与 OopStorage
* [第二十四章 — 编译底座](openjdk/vol-01/ch24.md) - 虚表桩/IC 缓冲/编译指令
* [第二十五章 — CompileBroker](openjdk/vol-01/ch25.md) - C1/C2 调度中枢
* [第二十六章 — Universe 后初始化](openjdk/vol-01/ch26-post/01-overview.md)
  * [26.2 第二次 Interpreter::initialize()](openjdk/vol-01/ch26-post/02-reinit-interpreter.md)
  * [26.3 OOM 错误预分配](openjdk/vol-01/ch26-post/03-oom-prealloc.md)
  * [26.4 initialize_known_methods](openjdk/vol-01/ch26-post/04-known-methods.md)
* [第二十七章 — Intrinsic 桩 Phase 2](openjdk/vol-01/ch27.md) - 50+ 硬件加速入口
* [第二十八章 — MH 适配器](openjdk/vol-01/ch28.md) - invokedynamic 的桥梁
* [第二十九章 — Post-init (上)](openjdk/vol-01/ch29.md) - VMThread + java.lang 类加载
* [第三十章 — Post-init：编译器线程 -> JNI_OK](openjdk/vol-01/ch30-post/01-compiler-threads.md)
  * [30.2 模块系统初始化](openjdk/vol-01/ch30-post/02-modules.md)
  * [30.3 最后一步——return JNI_OK](openjdk/vol-01/ch30-post/03-final-steps.md)

  </div>
</ul>
</details></li>
<li><a href="openjdk/vol-01/ch27.md">第二十七章 — Intrinsic 桩 Phase 2</a> - 50+ 硬件加速入口</li>
<li><a href="openjdk/vol-01/ch28.md">第二十八章 — MH 适配器</a> - invokedynamic 的桥梁</li>
<li><a href="openjdk/vol-01/ch29.md">第二十九章 — Post-init (上)</a> - VMThread + java.lang 类加载</li>
<li><details><summary>第三十章 — Post-init：编译器线程 -> JNI_OK</summary>
<ul>
<li><a href="openjdk/vol-01/ch30-post/01-compiler-threads.md">30.1 编译器线程创建</a></li>
<li><a href="openjdk/vol-01/ch30-post/02-modules.md">30.2 模块系统初始化</a></li>
<li><a href="openjdk/vol-01/ch30-post/03-final-steps.md">30.3 最后一步——return JNI_OK</a></li>
</ul>
</details></li>

</ul>

  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 2 · 对象 — Java 的 C++ 真身</span>
    
  </summary>
  <div class="section-content">
    <em>oop / Klass / markOop / 压缩指针 — 每个 Java 对象在 C++ 里的精确映射</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 3 · 类加载 — .class 到 Klass</span>
    
  </summary>
  <div class="section-content">
    <em>ClassFileParser / SystemDictionary / CDS — 类是怎么进入 JVM 的</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 4 · 解释器 — 字节码执行</span>
    
  </summary>
  <div class="section-content">
    <em>TemplateInterpreter / codelet / 256 字节码 — 解释执行的全路径</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 5 · C1 编译器 — 快速执行路径</span>
    
  </summary>
  <div class="section-content">
    <em>8 Phase 快速编译管线 — HIR 构建 → LinearScan 寄存器分配</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 6 · C2 编译器 — 极致性能</span>
    
  </summary>
  <div class="section-content">
    <em>Sea-of-Nodes / GVN / 内联 / 逃逸分析 / Chaitin 寄存器分配</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 7 · 代码管理 — CodeCache / nmethod / Deopt</span>
    
  </summary>
  <div class="section-content">
    <em>编译产物的生老病死 — 从 CodeCache 分配到 Sweeper 回收</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 8 · G1 GC — 内存的生死轮回</span>
    
  </summary>
  <div class="section-content">
    <em>Region / TAMS / SATB / RSet / Young GC / Mixed GC / Full GC — G1 的全部秘密</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 9 · 多 GC 对比 — 全景视野</span>
    
  </summary>
  <div class="section-content">
    <em>Serial / Parallel / CMS / G1 / ZGC / Shenandoah — 6 种 GC 的设计哲学对比</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 10 · 线程与锁 — 并发根基</span>
    
  </summary>
  <div class="section-content">
    <em>ObjectMonitor / 偏向锁 / ParkEvent — synchronized 的完整 C++ 实现</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 11 · Safepoint + 信号处理</span>
    
  </summary>
  <div class="section-content">
    <em>Polling Page / VM_Operation / libjsig — JVM 如何安全地暂停整个世界</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 12 · 边界 — JNI / JVMTI / Unsafe / JPMS</span>
    
  </summary>
  <div class="section-content">
    <em>JVM 与外部世界的所有桥梁 — 从 231 个 JNI 函数到模块系统</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 13 · 诊断与定制 — UL / JMX / JFR / SA / 构建</span>
    
  </summary>
  <div class="section-content">
    <em>让 JVM 告诉你它在做什么 — 日志 / 监控 / 飞行记录 / 事后调试 / 定制裁剪</em>
  </div>
</details>

</div>

