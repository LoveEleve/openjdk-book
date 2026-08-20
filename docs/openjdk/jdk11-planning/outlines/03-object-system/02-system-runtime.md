# 02. System 与 Runtime 门面 — 时间、数组拷贝、属性、关闭钩子

> 🔴 Deep | 域 03 对象与系统第 2 篇 | Layer 1
> 读者处境: 生产代码天天用 System.currentTimeMillis/arraycopy/getProperty,但不知道哪个是 native、时间精度几何、shutdownHook 怎么注册的——线上时间跳变排查从这开始。

### 1. "时间到底怎么来的？" — currentTimeMillis vs nanoTime

场景: 生产"时间回退了/变慢了"——先分清墙上时间与单调时间

- `System.java:396` `public static native long currentTimeMillis()` — **墙上时钟**(wall clock): 返回 1970-01-01 UTC 至今毫秒;native 实现读系统时钟
- `System.java:440` `public static native long nanoTime()` — **单调时钟**(monotonic): 任意起点,只用于**差值**比较;不受系统时间调整影响
- 关键设计 (斜体): *currentTimeMillis 会被 NTP 校时/手动改时间"拨动",nanoTime 保证单调(底层 OS 单调钟);面试题"计算耗时用哪个"答案是 nanoTime——但 JFR/GC 日志的时间戳是另一套(内部卷 os::javaTimeNanos)*
- 精度: nanoTime 名义纳秒,实际粒度取决于 OS(hpet/tsc);currentTimeMillis 受系统时钟粒度限制
- [C++: 内部卷 01-os 域 os_linux.cpp 的 javaTimeMillis/javaTimeNanos 实现;内核: clock_gettime(CLOCK_REALTIME/CLOCK_MONOTONIC)]
- [man 2 clock_gettime]

### 2. "arraycopy 为什么快？" — 系统级数组拷贝

场景: 面试"数组拷贝几种方式";生产 System.arraycopy 的性能依据

- `System.java:535` `public static native void arraycopy(...)` — native 实现
- 特性: ① 类型检查+引用数组时逐元素复制(空元素处理)② 重叠区安全(same-array 前后挪移)③ 基本类型用 CPU 级拷贝指令
- 关键设计 (斜体): *JIT 会识别 arraycopy 调用(内联到 VM stub,内部卷 StubRoutines),基本类型拷贝接近 memcpy 速度;Arrays.copyOf/copyOfRange 内部就是 System.arraycopy + 新数组分配*
- 面试点: "List.toArray / 数组扩容底层都是 arraycopy"
- [内部卷: 23-stub-routines(数组拷贝 stub 汇编实现)]

### 3. "系统属性从哪来？" — getProperty 与 VM 启动

场景: `System.getProperty("java.version")` — 这些属性是谁塞进去的?

- `System.java:826` `getProperty(String key)` — 从 `props` 字段(`System.java:578`)读;props 由启动初始化 `initPhase1` 创建(`System.java:1954/1964`,不是懒加载)
- 属性来源: ① JVM 启动时设置的内建属性(java.version/os.name/...)② 命令行的 `-Dkey=value` ③ `System.setProperty` 运行时添加
- `jdk/internal/misc/VM.java:187` `saveAndRemoveProperties` — 启动时把关键属性**另存**到 VM 私有副本,并从系统属性中移除(JDK 内部仍可读,`VM.java:159` getSavedProperty)
- 关键设计 (斜体): *为什么要"保存并移除": 用户代码可通过 System.getProperties().clear() 清掉系统属性——JDK 内部依赖的属性(如 IntegerCache.high,域 02)必须提前快照,否则会被用户清掉;这就是 VM.getSavedProperty 的用途*
- [内部卷: 03-arguments-flags(启动参数解析与属性注入路径)]

### 4. "优雅停机怎么做？" — shutdownHook 与 exit 流程

场景: 生产发布时老进程如何优雅释放资源?K8s SIGTERM 后发生了什么?

- `Runtime.java:70` `getRuntime()` — 单例
- `Runtime.java:211` `addShutdownHook(Thread)` — 注册钩子(依赖 Shutdown 类: 内部 shutdown hook 列表 + 状态机)
- `Runtime.java:111` `exit(int)` → `Shutdown.exit` → 依次执行钩子 → halt
- `Runtime.java:660` `public native void gc()` — 建议性 GC(仅是提示,不保证);`Runtime.java:631` `totalMemory()` / `642` `maxMemory()` / `618` `freeMemory()` — 堆内存查询(注意 freeMemory 语义: 剩余可分配 ≈ free+未提交部分)
- 关键设计 (斜体): *钩子执行顺序不保证、超时会被 halt 打断(SIGTERM → JVM 默认行为: 跑完钩子退出;K8s 优雅终止窗口内钩子必须快速完成);`System.exit` 与 `Runtime.exit` 等价(前者委托后者),`halt` 才是直接终止*
- 生产: 钩子里做连接池关闭/流量摘除/指标上报
- [内部卷: 30-jvm-entry(启动与退出序列)]

---

### 核心悬念

System/Runtime 管"当前进程内部"——但 Java 进程还能**拉起子进程**: `ProcessBuilder("java", "-jar", "xxx.jar")` 底层发生了什么?fork + exec 怎么从 Java 走到内核?

> → [03-process-native.md](03-process-native.md)
