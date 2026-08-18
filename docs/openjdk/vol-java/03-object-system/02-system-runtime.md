# 02. System 与 Runtime 门面 — 时间、数组拷贝、属性、关闭钩子

> **前置依赖**: [03-object-system/01 — Object 的方法契约与对象生命周期](01-object-contract-references.md)(对象生命周期)、[02-number-math/01 — 包装类缓存](../02-number-math/01-wrapper-cache-boxing.md)(IntegerCache.high 属性的来源,本文第 3 节闭环)
> → **后续**:[03-object-system/03 — ProcessBuilder 与本地进程](03-process-native.md)
> 关联: 内部卷 01-os-abstraction 01-platform-detection(os::javaTimeNanos 与 clock_gettime)、23-stub-routines 02-arraycopy、30-jvm-entry、03-arguments-flags

## 天天在用,没人看过

`System.currentTimeMillis()`、`System.arraycopy`、`System.getProperty`、`Runtime.addShutdownHook`——这四个 API 每个 Java 工程师每天都在用,但被追问"哪个是 native?时间会不会回退?属性是谁塞进去的?优雅停机到底怎么停?"时,大多数人就停在"System 嘛,工具类"了。

这篇把四个机制逐个拆开: 墙上时钟与单调时钟的分野、arraycopy 为什么接近 memcpy、系统属性的启动初始化链(顺便闭环域 02 的 IntegerCache.high)、以及 exit 的完整状态机。

## 1. "时间到底怎么来的" — currentTimeMillis vs nanoTime

### 1.1 两个 native,两种时钟

`System` 的两个时间方法都是 native(`System.java:396`/`440`):

```java
// System.java:396 + 440(截取核心,逐字)
public static native long currentTimeMillis();

public static native long nanoTime();
```

语义完全不同:

- **currentTimeMillis**:墙上时钟(wall clock)——1970-01-01 UTC 至今的毫秒数。它是"日历时间",会被 NTP 校时、手动改时间**拨动**: 时间可能回退、可能跳变。线上"时间回退了"的告警,先查的就是它
- **nanoTime**:单调时钟(monotonic clock)——任意起点、只用于**差值**比较(`t2 - t1` 有意义,绝对值无意义)。底层走 OS 的单调时钟,不受系统时间调整影响: 同一个 JVM 内,`nanoTime` 的差值保证与墙上时间无关

Linux 上两者分别是 `clock_gettime(CLOCK_REALTIME, ...)` 和 `clock_gettime(CLOCK_MONOTONIC, ...)`;JVM 侧实现在 `os::javaTimeMillis()`/`os::javaTimeNanos()`。

关键设计(斜体):*"计算耗时用 nanoTime、记录时间点用 currentTimeMillis"是铁律——用 currentTimeMillis 算耗时,一次 NTP 校时就能得到负值或秒级跳变。注意精度: nanoTime 名义上是纳秒,实际粒度取决于 OS 时钟源(HPET 约 1 微秒、TSC 可到几十纳秒);而 JFR/GC 日志里的时间戳又是一套(JVM 内部的另一路时钟),别混用。面试问"为什么 java 有俩时间方法",答出"墙上 vs 单调"就过关。*

跨层标注: [内部卷: 01-os-abstraction 01-platform-detection——os::javaTimeNanos 与 clock_gettime;内核: man 2 clock_gettime(CLOCK_REALTIME/CLOCK_MONOTONIC)]

## 2. "arraycopy 为什么快" — 系统级数组拷贝

### 2.1 native 声明,三类能力

`System.arraycopy`(`System.java:535`)同样是 native:

```java
// System.java:535-537(截取核心,逐字)
public static native void arraycopy(Object src,  int  srcPos,
                                    Object dest, int destPos,
                                    int length);
```

它的能力分三档:

1. **类型检查 + 引用数组**:先做运行时类型检查(源/目标数组类型兼容、元素类型能放进去),引用数组逐元素复制,`null` 元素照常搬运
2. **重叠安全**:源和目标可以是同一个数组(数组内部挪移)——native 实现按重叠方向决定从前往后还是从后往前,`System.arraycopy(arr, 0, arr, 1, n)` 这类"数组内平移"是安全的
3. **基本类型**:走 CPU 级的连续内存拷贝——接近 `memcpy` 的速度

### 2.2 JIT 与 Stub

性能的关键在 JIT: **HotSpot 认识 arraycopy 这个调用**——编译热点代码时把它内联成 VM 的数组拷贝 stub(针对不同元素类型的专用汇编例程),基本类型数组的拷贝就是一条条 `rep movsb`/`rep movsq` 级别的指令序列,没有逐元素的方法调用开销。

跨层标注: [内部卷: 23-stub-routines 02-arraycopy——数组拷贝 stub 的汇编实现]

这也解释了 `Arrays.copyOf`/`copyOfRange` 的构成: 它们就是"分配新数组 + `System.arraycopy`"(域 01 的 String 双路径、域 08 的 ArrayList 扩容全都在消费这条链)。

关键设计(斜体):*arraycopy 是"标准库把底层能力暴露给用户"的典型——拷贝的正确性(重叠、类型、空元素)在 native 里一次解决,性能由 JIT 通过 stub 内联逼近 memcpy。面试点: "List.toArray / 数组扩容底层都是 arraycopy"——能说出 JIT 内联成 stub 这一层,就不只是背 API 了。*

## 3. "系统属性从哪来" — getProperty 与 VM 启动

### 3.1 读的是 props 字段

`System.getProperty(key)`(`System.java:826-835`):

```java
// System.java:826-835(截取核心,逐字)
public static String getProperty(String key) {
    checkKey(key);
    SecurityManager sm = getSecurityManager();
    if (sm != null) {
        sm.checkPropertyAccess(key);
    }

    return props.getProperty(key);
}
```

核心就一行: `props.getProperty(key)`——`props`(`System.java:578`)是一个 `Properties` 对象。**它不是懒加载的**: 由 `initPhase1`(`System.java:1954`)在类初始化早期创建并填充(`System.java:1964` 的 `props = new Properties(84)` 后跟 `initProperties(props)`——"initialized by the VM",即 native 侧把内建属性塞进来)。

属性有三个来源,对应三种生命周期:

1. **JVM 内建**:`java.version`、`os.name`、`user.home` 等,VM 初始化时写入
2. **命令行 `-Dkey=value`**:JVM 启动参数,VM 解析后写入
3. **`System.setProperty`**:运行时修改,进程内生效

### 3.2 为什么"保存并移除"

`initPhase1` 里有一行容易被忽略的调用(`System.java:1981`):

```java
// System.java:1978-1981(截取核心,逐字)
// Save a private copy of the system properties object that
// can only be accessed by the internal implementation.  Remove
// certain system properties that are not intended for public access.
VM.saveAndRemoveProperties(props);
```

`VM.saveAndRemoveProperties`(`jdk/internal/misc/VM.java:187`)做两件事: **① 快照**——把当前全部属性拷贝进 VM 私有副本 `savedProps`; **② 移除**——从公开属性里删掉几个仅供 JDK 内部使用的 key(`VM.java:203-228`):

- `sun.nio.MaxDirectMemorySize`(顺带解析成 VM 的 directMemory 字段)
- `sun.nio.PageAlignDirectMemory`
- `java.lang.IntegerCache.high`——**域 02 的 IntegerCache 读的就是这个**(`Integer.java:1007` 的 `VM.getSavedProperty(...)`)
- `sun.java.launcher.diag`、`jdk.boot.class.path.append`

为什么?注释(`System.java:1969-1973`)说得很明白: 这些属性"for internal implementation use only"。公开的 `System.getProperties()` 返回可变集合——用户代码可以 `System.getProperties().clear()` **清空所有属性**。如果 JDK 内部依赖的属性留在公开集合里,被清掉后 IntegerCache 的配置、直接内存上限就全丢了。快照保证:**用户清得掉公开属性,清不掉 VM 私有副本**;内部实现一律走 `VM.getSavedProperty`(`VM.java:159`)取回。

关键设计(斜体):*"保存并移除"是 JDK 防御用户行为的典型设计——公开 API 给你可变性(Properties 集合),内部实现用快照隔离风险。这条链在域 02 已经出现过: IntegerCache 静态块读 `VM.getSavedProperty("java.lang.Integer.IntegerCache.high")`,当时没说这属性为什么"被保存"——现在闭环了: 它先被 `saveAndRemoveProperties` 从公开属性里拿走,再从快照里取回。*

## 4. "优雅停机怎么做" — shutdownHook 与 exit 流程

### 4.1 单例与入口

`Runtime.getRuntime()`(`Runtime.java:70`)返回单例;`System.exit` 委托 `Runtime.exit`(`Runtime.java:111-117`):

```java
// Runtime.java:111-117(截取核心,逐字)
public void exit(int status) {
    SecurityManager security = System.getSecurityManager();
    if (security != null) {
        security.checkExit(status);
    }
    Shutdown.exit(status);
}
```

真正干活的是 `Shutdown`(`java.lang.Shutdown`,包私有)。`Shutdown.exit`(`Shutdown.java:162`)的状态机:

```java
// Shutdown.java:162-176(截取核心,逐字)
static void exit(int status) {
    synchronized (lock) {
        if (status != 0 && VM.isShutdown()) {
            /* Halt immediately on nonzero status */
            halt(status);
        }
    }
    synchronized (Shutdown.class) {
        ...
        beforeHalt();
        runHooks();
        halt(status);
    }
}
```

**顺序固定: `beforeHalt()`(native,通知 VM 准备终止,`Shutdown.java:143-144` 注释 "Notify the VM that it's time to halt")→ `runHooks()`(执行所有钩子,含系统槽位钩子如 DeleteOnExit——hooks 数组注释 `Shutdown.java:45-52` 列出槽位 0/1/2)→ `halt(status)`(真正终止)**。注意 `halt`(`Runtime.java:274`)才是直接终止——`exit` 是"先清理再终止",`halt` 是"立刻终止"。

### 4.2 钩子的注册与执行

`Runtime.addShutdownHook`(`Runtime.java:211-220`)把钩子交给 `ApplicationShutdownHooks.add`;执行时(`ApplicationShutdownHooks.java:94` 起)的流程值得细看:

```java
// ApplicationShutdownHooks.java:94-108(截取核心,逐字)
static void runHooks() {
    Collection<Thread> threads;
    synchronized(ApplicationShutdownHooks.class) {
        threads = hooks.keySet();
        hooks = null;
    }

    for (Thread hook : threads) {
        hook.start();
    }
    for (Thread hook : threads) {
        while (true) {
            try {
                hook.join();
                ...
```

**先全部 start,再逐个无限 join**——每个钩子线程 start 后,shutdown 流程在主线程逐个 `join()` 等待。机制推论:

- **钩子不结束,exit 就卡住**:某个钩子线程死循环或阻塞,`join` 永远不返回,进程停在 runHooks 阶段——这就是 K8s 优雅终止窗口(SIGTERM 后默认约 30 秒)超时被强杀的场景: 钩子太慢,进程没退成,被 SIGKILL
- **执行顺序不保证**:用户钩子存在 `IdentityHashMap<Thread, Thread>`(`ApplicationShutdownHooks.java:39`)里,遍历顺序与注册顺序无关
- **异常不拖垮流程**:系统槽位钩子由 `Shutdown.runHooks`(`Shutdown.java:113`)执行,包着 `catch (Throwable t)`(`Shutdown.java:130-134`,只重抛 ThreadDeath)——单个钩子异常不影响其他钩子与后续 halt;用户钩子跑在各自线程里,异常只终止该线程

生产实践: 钩子里做连接池关闭、流量摘除、指标上报,但**必须快速完成**——发布系统的优雅窗口是算在钩子时间里的。

### 4.3 gc 与内存查询:全是 native

`Runtime.gc()`(`Runtime.java:660`)是 native——javadoc 明确它是**建议性**的: JVM 自动 GC 该跑还是跑,`gc()` 只是"hint"("The virtual machine performs this recycling process automatically as needed")。`freeMemory`(`Runtime.java:618`)/`totalMemory`(`Runtime.java:631`)/`maxMemory`(`Runtime.java:642`)也都是 native——直接问 JVM 的堆状态。

关键设计(斜体):*exit 的三段式(清理→钩子→终止)是"优雅停机"的机制骨架,`halt` 是它的逃生门(直接终止,不跑任何东西)。面试答"System.exit 与 Runtime.exit 等价(委托关系)、halt 才是直接终止"是基础层;能说出"钩子无限 join,慢钩子会拖死整个退出流程"才到机制层。*

跨层标注: [内部卷: 30-jvm-entry(启动与退出序列)]

## 核心悬念

System/Runtime 管"当前进程内部"——但 Java 进程还能**拉起子进程**: `new ProcessBuilder("java", "-jar", "xxx.jar").start()` 底层发生了什么?从 Java 代码到 fork/exec 系统调用,中间隔了几层?子进程的输入输出流怎么桥接到父进程?进程退出码怎么拿回来?下一篇把 ProcessBuilder 的完整链条拆开。

> → [03-object-system/03 — ProcessBuilder 与本地进程](03-process-native.md)
