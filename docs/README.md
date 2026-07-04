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

* [总览 — 按出现顺序的语法索引](openjdk/vol-cxx/README.md)

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
  * [3.6 第一个 JavaThread：主线程登记](openjdk/vol-01/ch03/06-main-thread-create.md)
  * [前置概念：三套 Handle 体系](openjdk/vol-01/ch03/background/handles-all.md)
  * [前置概念：Thread-SMR](openjdk/vol-01/ch03/background/smr.md)
* [第四章 — init.cpp 全局初始化](openjdk/vol-01/ch04/01-overview.md) - init_globals() 30 项核心子系统初始化
  * [4.1 init_globals() 总览](openjdk/vol-01/ch04/01-overview.md)
  * [4.2 management_init — JMX 子系统的 C++ 侧地基](openjdk/vol-01/ch04/02-management.md)
  * [4.3 bytecodes_init — JVM 字节码表的初始化](openjdk/vol-01/ch04/03-bytecodes.md)

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

