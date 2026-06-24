<!-- Hero 区域 -->
<div class="hero-section">
  <div class="hero-content">
    <h1 class="hero-title">格物致知：OpenJDK 源码分析</h1>
    <p class="hero-slogan">14 卷 · ~230 章</p>
    <p class="hero-desc">JVM 不是一个黑箱——你可以停住它，读它的内部状态，改它的源码</p>
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
    <span class="section-title">卷 0 · 地基 — 编译你的第一个 HotSpot JVM</span>
    <span class="section-count">L1 · 10 章</span>
  </summary>
  <div class="section-content">

* [第一章 — java 命令到底是什么](openjdk/vol-00/ch01.md) - 一个 C 编译出来的可执行文件
* [第二章 — 第一次 GDB 断点](openjdk/vol-00/ch02.md) - 停住 JVM，看它的调用栈
* [第三章 — OpenJDK 源码全景](openjdk/vol-00/ch03.md) - 39 个模块，22 个 .so
* [第四章 — 搭建编译环境](openjdk/vol-00/ch04.md) - 用 configure + make 编译你的第一个 JDK
* [第五章 — configure 在做什么](openjdk/vol-00/ch05.md) - 检测 GCC/头文件/系统调用
* [第六章 — 编译的 5 个阶段](openjdk/vol-00/ch06.md) - 从 .cpp 到 libjvm.so
* [第七章 — 不运行也能审查二进制](openjdk/vol-00/ch07.md) - file / readelf / ldd / nm / size
* [第八章 — GDB 工具箱](openjdk/vol-00/ch08.md) - break / bt / p / ptype / x / info
* [第九章 — 改一行 JVM 源码](openjdk/vol-00/ch09.md) - 编辑 → 增量编译 → 验证生效
* [第十章 — HotSpot 源码地图](openjdk/vol-00/ch10.md) - 每个目录对应什么，去哪找

  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 1 · 启动 — JVM 从零到一</span>
    <span class="section-count">L1-L2 · 12 章</span>
  </summary>
  <div class="section-content">
    <em>从 java 命令到 Threads::create_vm 的 78 步初始化全景</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 2 · 对象 — Java 的 C++ 真身</span>
    <span class="section-count">L2-L3 · 14 章</span>
  </summary>
  <div class="section-content">
    <em>oop / Klass / markOop / 压缩指针 — 每个 Java 对象在 C++ 里的精确映射</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 3 · 类加载 — .class 到 Klass</span>
    <span class="section-count">L2-L3 · 17 章</span>
  </summary>
  <div class="section-content">
    <em>ClassFileParser / SystemDictionary / CDS — 类是怎么进入 JVM 的</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 4 · 解释器 — 字节码执行</span>
    <span class="section-count">L3-L4 · 20 章</span>
  </summary>
  <div class="section-content">
    <em>TemplateInterpreter / codelet / 256 字节码 — 解释执行的全路径</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 5 · C1 编译器 — 快速执行路径</span>
    <span class="section-count">L3-L4 · 12 章</span>
  </summary>
  <div class="section-content">
    <em>8 Phase 快速编译管线 — HIR 构建 → LinearScan 寄存器分配</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 6 · C2 编译器 — 极致性能</span>
    <span class="section-count">L4-L5 · 19 章</span>
  </summary>
  <div class="section-content">
    <em>Sea-of-Nodes / GVN / 内联 / 逃逸分析 / Chaitin 寄存器分配</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 7 · 代码管理 — CodeCache / nmethod / Deopt</span>
    <span class="section-count">L3-L4 · 12 章</span>
  </summary>
  <div class="section-content">
    <em>编译产物的生老病死 — 从 CodeCache 分配到 Sweeper 回收</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 8 · G1 GC — 内存的生死轮回</span>
    <span class="section-count">L3-L5 · 26 章</span>
  </summary>
  <div class="section-content">
    <em>Region / TAMS / SATB / RSet / Young GC / Mixed GC / Full GC — G1 的全部秘密</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 9 · 多 GC 对比 — 全景视野</span>
    <span class="section-count">L4 · 13 章</span>
  </summary>
  <div class="section-content">
    <em>Serial / Parallel / CMS / G1 / ZGC / Shenandoah — 6 种 GC 的设计哲学对比</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 10 · 线程与锁 — 并发根基</span>
    <span class="section-count">L3-L5 · 18 章</span>
  </summary>
  <div class="section-content">
    <em>ObjectMonitor / 偏向锁 / ParkEvent — synchronized 的完整 C++ 实现</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 11 · Safepoint + 信号处理</span>
    <span class="section-count">L4 · 16 章</span>
  </summary>
  <div class="section-content">
    <em>Polling Page / VM_Operation / libjsig — JVM 如何安全地暂停整个世界</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 12 · 边界 — JNI / JVMTI / Unsafe / JPMS</span>
    <span class="section-count">L2-L4 · 16 章</span>
  </summary>
  <div class="section-content">
    <em>JVM 与外部世界的所有桥梁 — 从 231 个 JNI 函数到模块系统</em>
  </div>
</details>

<details class="home-section">
  <summary>
    <span class="section-title">卷 13 · 诊断与定制 — UL / JMX / JFR / SA / 构建</span>
    <span class="section-count">L2-L3 · 29 章</span>
  </summary>
  <div class="section-content">
    <em>让 JVM 告诉你它在做什么 — 日志 / 监控 / 飞行记录 / 事后调试 / 定制裁剪</em>
  </div>
</details>

</div>

<div class="update-badge">
  <span class="update-icon">🔥</span>
  <span class="update-text">卷 0 写作中 · 14 卷持续更新</span>
</div>
