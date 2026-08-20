# 01. 一次 `getInstance()`，怎么把 `.so` 变活？——Java API 入口、五级找库与字符串协议

> **前置依赖**：[AP-1 —— 启动与参数协议](../01-startup-attach/01-build-attach.md)、[AP-3 —— Java API 的 native 侧](../03-jvm-integration/04-java-api-bridge.md)、[AP-5 —— OTLP/JFR/FlameGraph 输出](../05-output-formats/03-otlp-converter.md)
> → **后续**：AP-6 的 `Recording` / helper / closure 辅助路径
>
> 本篇基于当前 async-profiler 源码，重点讨论 Java API 的上层入口：`AsyncProfiler.getInstance()` 怎样加载 native 库，`execute`/`dumpCollapsed`/`dumpOtlp` 怎样把 native 协议投影成 Java 方法，以及它与 JMX、Recording 辅助类、C API 的边界。JNI 细节锚点和 native 桥接主体已经在 AP-3 `04-java-api-bridge.md` 解释过；本篇不再逐个重走所有 JNI 函数体，而是把必要的 JNI 语义拿来解释“Java 调用者眼中的入口设计”和“这层为什么长这样”。

## 先把真正的困惑摆出来：为什么一次 `getInstance()`，其实是在激活 native profiler

Java 调用者看到的 usually 只是这样一行代码：

```java
AsyncProfiler.getInstance().execute("start,event=cpu")
```

或者：

```java
AsyncProfiler.getInstance().dumpOtlp(Counter.SAMPLES)
```

从 Java 视角看，这像一个非常普通的单例服务：先拿实例，再调实例方法。但 async-profiler 的真实本体不是 Java 对象，而是 native agent。于是 `getInstance()` 这一步根本不是普通工厂方法，它实际上同时要解决三件事：

1. 这个进程里，native `.so` 到底活没活；
2. 如果还没活，该按什么路径把它装进来；
3. 装进来之后，Java 世界到底是应该看到一套完全强类型化的对象接口，还是继续接受 native 那套 `action,key=value` 协议才是真正的语义中心。

最容易想到的方案有两个极端。

第一个极端，是把 Java API 彻底做成一套强类型 façade：每个命令、每个参数、每个输出格式都定义成 Java 方法和 Java DTO，再在 JNI 层逐个映射到 native 字段。这听起来很“Java 化”，但很快就会遇到一个结构性问题：Java 侧会慢慢长成 `Arguments` 的镜像版本。只要 native 参数语义变一次，Java façade 就得跟着维护一遍，而且两边很容易漂移。

第二个极端，则是只暴露一个 `execute(String)`，把一切都扔给调用者自己拼字符串。这固然最贴近 native 协议，但对常用场景来说又太“裸”，不仅 start/stop 这样的高频操作缺少便利方法，JMX 暴露、二进制返回值、线程对象语义之类能力也都不容易自然承载。

当前实现刻意站在这两个极端中间：Java API 负责把“native 库还没活”变成“进程里已经有了一个可调用的 profiler”，同时提供少量高频便利方法；但真正的参数语义中心，仍然放在 native `Arguments::parse()` 和 `Profiler` 内核这一侧。

```text
Java 调用者
  → AsyncProfiler.getInstance()
    → 显式路径 / 预加载探针 / 系统属性 / embedded lib / loadLibrary
      → native RegisterNatives / 已装载 .so
        → execute0 / execute1 / start0 / stop0 / filterThread0
          → Arguments::parse 或 Profiler::start/stop
            → Profiler 内核 / writer / 输出格式

辅助路径
  Recording
    → registerNatives / state / timestamp / emitSpan
      → JFR/Span/clock bridge
```

*关键设计（斜体）：* *Java API 的第一职责不是“设计一套新 profiler”，而是把“native 库还没活”变成“Java 可以进入同一套 native 能力”；它负责激活与投影，不负责夺走参数协议主导权。*[模式: 单例激活点 + 协议投影 + 少量便利包装]

先记住这一句总领：`getInstance()` 看起来在拿对象，实际上在激活一个 native profiler。后面所有加载顺序、方法签名和辅助桥接，都是围绕这个总问题服务的。

## 第一层：为什么 `getInstance()` 必须和库装载时机绑在一起，而不是类加载时静态装库

`AsyncProfiler` 本身只是一个普通 Java 类，实现 `AsyncProfilerMXBean`，静态字段 `instance` 保存唯一实例（`src/api/one/profiler/AsyncProfiler.java:19-20`）。但真正的入口不是类初始化，而是 `public static synchronized AsyncProfiler getInstance(String libPath)`（`src/api/one/profiler/AsyncProfiler.java:25-29`）。

这意味着当前实现明确拒绝了一个很常见、也很直觉的方案：不要在类加载时无脑静态装库。为什么？因为 Java 类可能很早就被 classloader 看见，但当时业务未必真要开 profiler，部署参数也未必已经准备好，甚至某些环境只是想让 API 包存在于 classpath 而已。若在 `<clinit>` 阶段就尝试装库，失败会过早炸掉类初始化，成功则又可能在根本不需要 profiler 的进程里过早引入 native 依赖。

把装载动作绑到第一次 `getInstance()`，等于把“Java 侧真正需要 profiler”的时刻显式化了。类可以先存在，但 profiler 不必先活；等真正第一次拿实例时，才触发装载与绑定。

这里的 `synchronized` 也不只是保护单例字段，更是在保护“库加载只做一次”这件事。如果两个线程同时第一次进入 `getInstance()`，它们不能各自来一轮 `System.load()`、embedded lib 解压和 JNI 绑定，否则很容易碰到重复加载、临时文件竞争或初始化时序混乱。

```text
第一次 getInstance()
  → instance == null
  → new AsyncProfiler()
  → 尝试装载/探测 native 库
  → instance = profiler

后续 getInstance()
  → 直接返回已有 instance
```

所以这一步真正解决的，不是“怎样 new 一个单例对象”，而是“怎样把装载时机和 Java 侧第一次真实需求绑在一起”。这正是它被称为“激活点”而不是“普通工厂”的原因。

## 第二层：五级找库顺序不是技巧列表，而是五种部署形态的兼容层

一旦接受 `getInstance()` 是激活点，下一个问题就是：它到底怎样把 `.so` 找出来？当前源码里最终表现为五级顺序，但这五级如果只按实现步骤背下来，就很容易读成“花哨加载技巧清单”。实际上，它们分别在兼容五种不同的部署形态。

### 第一层：显式路径——调用者已经明确知道库在哪

如果调用者传入了 `libPath`，`getInstance(String libPath)` 直接执行 `System.load(libPath)`（`src/api/one/profiler/AsyncProfiler.java:35-36`）。这里用的是 `System.load`，不是 `loadLibrary`，因为它接受完整路径而不是库名。

这一层对应的部署意图最强：调用方明确知道自己要装哪一个文件，也明确不想让 Java API 再猜。这里失败就直接让 JVM 抛 `UnsatisfiedLinkError`，因为 Java API 没必要替调用者再做另一轮猜测。

### 第二层：预加载探针——库也许已经活在进程里了

如果没有显式 `libPath`，代码不会立刻去 `System.loadLibrary()`，而是先调用：

```java
profiler.getVersion();
```

源码注释写得很直白：如果库已经通过 `-agentpath` 预加载，就不需要再 load（`src/api/one/profiler/AsyncProfiler.java:38-41`）。所以 `getVersion()` 在这里的主要意义并不是“要一个版本号字符串”，而是在探测 native 符号是不是已经在当前进程里绑定好了。

这一步解决的是第二种部署形态：库不是 Java API 自己装进来的，而是外部启动器、容器、agent 参数或别的注入机制已经先把它装好了。若此时再无脑 `System.loadLibrary()`，不仅多余，甚至可能触发重复装载错误。

所以这条路径真正要记住的不是“先取版本”，而是“加载策略的第一步不是找库，而是问库是不是已经活着”。

*关键设计（斜体）：* *加载顺序的第一问不是“库在哪”，而是“库是不是已经在进程里了”；预加载探针的目的，是避免把 Java API 误写成总要重新装一遍库的入口。*[模式: 预加载探测 + 避免重复装载]

### 第三层：系统属性——把库位置交给部署系统注入

如果预加载探针抛出 `UnsatisfiedLinkError`，代码下一步才会查看 `one.profiler.libraryPath` 系统属性；如果存在，就转成绝对路径后 `System.load`（`src/api/one/profiler/AsyncProfiler.java:42-45`）。

这一层对应的是第三种部署形态：应用代码不想写死库路径，但部署系统、容器或启动脚本可以在运行时注入库位置。相比显式传 `libPath`，它更适合平台化接入：业务代码只写 `getInstance()`，库路径由外部环境决定。

### 第四层：embedded lib——jar 自带 `.so`，运行时解压临时装载

如果没有系统属性，Java API 才尝试 `extractEmbeddedLib()`；只有这一步返回非空文件时，才会从临时文件路径 `System.load`，否则才继续往下回退（`src/api/one/profiler/AsyncProfiler.java:46-55、65-92`）。

这条路径对应的是第四种部署形态：Java 包本身随身带着 native 库，用户不想另外部署 `.so`。代码会：

1. 根据平台标签构造资源路径，如 `/<platform>/libasyncProfiler.so`；
2. 从 classpath resource 打开输入流；
3. 写到临时文件；
4. `System.load(file.getAbsolutePath())`；
5. 在 `finally` 里删掉临时文件（`src/api/one/profiler/AsyncProfiler.java:65-92`）。

这里还有两个边界必须守住。

第一，embedded lib 不是无条件普适。平台标签由 `getPlatformTag()` 根据 `os.name` 和 `os.arch` 推断，当前只显式支持 Linux x64/arm64/arm32/x86/ppc64le 和 macOS；不在列表中就直接抛 `UnsupportedOperationException`（`src/api/one/profiler/AsyncProfiler.java:94-113`）。所以这条路依赖 jar 里本来就打包了对应平台的资源。

第二，解压位置也不是完全写死。`one.profiler.extractPath` 系统属性允许调用者覆盖临时目录位置（`src/api/one/profiler/AsyncProfiler.java:73-76`），这对只读文件系统、受限临时目录或安全策略受控环境都很有意义。

### 第五层：`System.loadLibrary("asyncProfiler")`——系统库搜索路径兜底

如果 embedded resource 也不存在，最后才落到最传统的 `System.loadLibrary("asyncProfiler")`（`src/api/one/profiler/AsyncProfiler.java:53-55`）。这一层对应第五种部署形态：库已经被放进 JVM 能找到的标准动态库搜索路径里，Java API 只需要按库名装载。

于是完整顺序其实不是“几种随机回退”，而是五种部署意图从强到弱的兼容链：

```text
1. 显式 libPath → System.load(libPath)
2. 预加载探针 → profiler.getVersion()
3. one.profiler.libraryPath → System.load(absPath)
4. extractEmbeddedLib() → System.load(tempFile)
5. System.loadLibrary("asyncProfiler")
```

所以这五级真正表达的不是“AsyncProfiler 很会找库”，而是“它要同时兼容显式控制、启动期预注入、外部配置、自包含 jar、系统库兜底这五种部署形态”。如果没有这层部署语义，文章就会退化成加载技巧列表。

## 第三层：为什么 Java API 不能彻底强类型化，而必须把 `execute(String)` 保留为权威入口

装载解决之后，第二个大问题就是：Java 侧到底该怎样把 profiler 能力暴露给调用者？最容易产生的直觉，是既然已经有一个对象化入口，干脆把所有能力都改成强类型 Java 方法，不再让调用者碰字符串协议。

当前实现没有这么做，原因不是懒，而是参数语义中心根本不在 Java。`AsyncProfiler.execute(String command)` 的 JavaDoc 直接写明，这个 command 就是 `arguments.cpp` 定义的逗号分隔参数（`src/api/one/profiler/AsyncProfiler.java:178-186`）。Java 侧只是检查空值，然后把字符串直接交给 native `execute0(command)`（`src/api/one/profiler/AsyncProfiler.java:188-193`）。而 native 侧第一件事，就是 `Arguments args; args.parse(command_str);`（`src/javaApi.cpp:56-60`）。

这背后的结构性约束很重要：如果 Java 侧把所有命令都“重新发明”为强类型 DTO、builder 和镜像字段，那么它就等于在 Java 世界重建了一份 `Arguments`。只要 native 参数集、默认值、冲突规则、组合边界一变，Java 就得跟着同步一套逻辑。时间一久，Java façade 和 native 真实语义很容易出现漂移。

所以 `execute(String)` 之所以必须保留，不是因为“还没来得及设计更好的 API”，而是因为它是当前最接近 native 真相、最不容易复制语义中心的一条入口。

常用方法其实都只是这条协议的投影：

- `getVersion()` -> `execute0("version")`（`src/api/one/profiler/AsyncProfiler.java:169-175`）；
- `dumpCollapsed(counter)` -> `execute0("collapsed,...")`（`src/api/one/profiler/AsyncProfiler.java:196-208`）；
- `dumpTraces(maxTraces)` -> `execute0("traces" | "traces=N")`（`src/api/one/profiler/AsyncProfiler.java:210-223`）；
- `dumpFlat(maxMethods)` -> `execute0("flat" | "flat=N")`（`src/api/one/profiler/AsyncProfiler.java:225-238`）；
- `dumpOtlp(counter)` -> `execute1("otlp,...")`（`src/api/one/profiler/AsyncProfiler.java:240-255`）。

也就是说，Java API 上那些看似独立的方法名，本质上是在帮调用者少拼几段字符串，但它们并没有取代字符串协议本身成为新的参数拥有者。

### `start/resume/stop` 为什么只是少量高频直通，而不是完整强类型 API

这里最容易造成错觉的，是 `start(String event, long interval)`、`resume(String event, long interval)` 和 `stop()` 这些方法。它们不像 `execute(String)` 那样显式拼命令字符串，看上去更像“Java API 正在迈向完整强类型化”。

但 native 侧的实现很能说明问题。`start0` 并不会先走 `Arguments::parse()`，而是只针对最常见场景构造一个轻量 `Arguments`：对 `alloc` 和 `lock` 做特判，其余事件把 `event` 和 `interval` 直接塞字段里，然后调用 `Profiler::start(args, reset)`（`src/javaApi.cpp:25-44`）。

这说明什么？说明 Java API 只是对“最常用、参数最少、语义最稳定”的启动路径开了直通便利门。它并没有也不打算覆盖复杂组合，比如 begin/end、filter、file、output、threads、jfrsync、chunk size 之类配置。一旦场景复杂，调用者仍然得回到 `execute(String)`。

所以 `start/resume/stop` 的存在，并不推翻“字符串协议才是权威入口”这个结论。更准确地说法是：Java API 允许少量高频路径不必每次都手拼协议，但它拒绝把整套 native 参数世界在 Java 侧完整复制一遍。

*关键设计（斜体）：* *Java API 的目标不是消灭字符串协议，而是把它包上一层足够薄的便利壳：高频基本场景给直通方法，复杂场景仍回到 `execute(String)`。*[模式: 协议为本 + 少量高频直通]

## 第四层：为什么有的结果返回 `String`，有的返回 `byte[]`，而 MXBean 又只是包装层

一旦接受 Java API 是“同一 native 协议的多种投影层”，下一个问题就是：这些投影到底怎样在 Java 方法签名里体现出来？这里最清楚的一对边界，就是 `execute0` 和 `execute1`。

native 侧的分工非常明确：`execute0` 返回 `String`，`execute1` 返回 `byte[]`，并且 `execute1` 还会拒绝指定 output file（`src/javaApi.cpp:55-125`）。Java 侧 그대로 保留了这条契约：

- `execute()`、`getVersion()`、`dumpCollapsed()`、`dumpTraces()`、`dumpFlat()` 都走 `execute0`，结果是文本；
- `dumpOtlp()` 走 `execute1`，结果是二进制数组（`src/api/one/profiler/AsyncProfiler.java:169-255`）。

这不是一个随便的 API 美观选择，而是在把“输出到底是什么载荷”直接提升为 Java 可见契约。前面 AP-5 已经说明，OTLP 不是给终端看的文本，而是机器消费的 protobuf。强行把它塞成 `String`，不仅违反载荷语义，也会引入编码与中间转换问题。`test/test/api/DumpOtlp.java:24` 正是在直接使用这条契约：`dumpOtlp(Counter.TOTAL)` 回来就是 `byte[]`，调用方只关心长度，不期待可打印文本。

所以 Java API 没有把所有输出统一塞回一个 `Object` 或一个 `byte[]` 再让调用者猜，而是把“文本结果”和“二进制结果”在方法层就显式分开。

### MXBean 为什么不是另一套 profiler 实现

`AsyncProfiler` 还实现了 `AsyncProfilerMXBean`（`src/api/one/profiler/AsyncProfiler.java:19`、`src/api/one/profiler/AsyncProfilerMXBean.java:19-35`）。但这里也很容易产生误解：既然又多了一层接口，是不是 JMX 世界有自己另一套 profiler 逻辑？

答案是否定的。`AsyncProfilerMXBean` 只是把当前 Java API 这组能力——`start`、`resume`、`stop`、`getSamples`、`getVersion`、`execute`、`dumpCollapsed`、`dumpTraces`、`dumpFlat`、`dumpOtlp`——按 MBean 规范再暴露一遍。它解决的是“JMX server 怎么调用同一个 Java API”，不是“重新定义一套 native 协议”。

`test/test/api/JavaAgent.java:17` 到 `test/test/api/JavaAgent.java:35` 就是最直接的证据：代码拿到平台 `MBeanServer`，通过对象名 `one.profiler:type=AsyncProfiler` 读取 `Version`，再调用 `dumpCollapsed`，最后拿到的仍然是同一套 Java API 语义，只是入口换成了 JMX 调用。

所以 MXBean 不应该被写成“Java API 的另一套能力集合”，而应被理解成“同一入口形态的 JMX 包装层”。

### `filterThread0` 为什么是少量强类型辅助的例子

还有一类很典型的“不是字符串、却也不是完整强类型 API”的能力，就是线程过滤。`addThread`/`removeThread` 并不通过 `execute(String)` 表达，而是走 `filterThread0(Thread thread, boolean enable)`（`src/api/one/profiler/AsyncProfiler.java:257-299`）。

这是因为这里的 Java 对象语义确实比字符串更强：调用者手里拿着 `Thread` 对象，本来就不应该再去手动查 thread id、再把它编码回命令字符串。Java 侧甚至还专门在非当前线程情况下对 `thread` 做 `synchronized`，并检查状态不是 `NEW` 或 `TERMINATED`，避免和线程状态变化竞争（`src/api/one/profiler/AsyncProfiler.java:277-287`）。

这恰好说明当前 API 的一条经验法则：当 Java 对象语义显著强于字符串时，它愿意提供少量强类型辅助；但这类方法始终是例外，不是 Java 完整接管参数世界的开始。

## 第五层：为什么 `Recording` 不是主入口，而只是 state / clock / span 辅助桥

`Recording.java` 也在 `one.profiler` 包里，而且名字看起来非常像“另一套更高阶的 Java API”。这恰恰是最容易被误判的地方。当前实现里，`Recording` 不是主入口，而是一座辅助桥。

它最关键的证据就藏在静态初始化里：`Recording` 会尝试 `registerNatives()`；如果此时 async-profiler native 还没装载好，它不会像 `getInstance()` 那样继续多级找库，而是直接吞掉 `UnsatisfiedLinkError`，把状态落到 `UNAVAILABLE`（`src/api/one/profiler/Recording.java:32-38`）。

这个行为本身已经足够说明两件事：

第一，`Recording` 并不负责“把库装起来”；
第二，它接受“当前还没法用，只先声明自己不可用”这种状态。

这和 `AsyncProfiler.getInstance()` 的角色完全不同。后者是激活点，必须真的把库找出来并装进来；前者更像辅助桥，若此时 native 还没就绪，就先报告 `UNAVAILABLE`，等将来 native 侧通过 `RecordingAPI::bind()` 或后续流程把桥搭好。

### `Recording` 真正提供的是什么

它的职责主要围绕 JFR/Span/clock 辅助：

- `state()` 暴露当前 recording 状态：`UNAVAILABLE`、`STOPPED`、`RUNNING`；
- `clockFrequency()` 告诉 Java 侧当前 profiler 时钟频率；
- `timestamp()` 通过可替换 `MethodHandle` 返回与 profiler 同一时钟下的当前时间；
- `getThreadLocalBuffer()` 和 `emitSpan()` 暴露 span/JFR 相关的 native 辅助通道（`src/api/one/profiler/Recording.java:17-99`）。

native 侧对应的 `RecordingAPI::registerNatives()` 会绑定 `Recording` 的 native 方法，缓存 `state` 字段与 `updateClock` 方法；`RecordingAPI::start/stop()` 再去更新 Java 侧静态状态（`src/javaApi.cpp:149-302`）。

这一层真正的价值，是把“Java 侧看到的时钟”和“native profiler 事件使用的时钟”对齐起来，并在 JFR/span 相关场景下暴露一个很薄的 bridge。`test/test/span/SpanApiApp.java:36` 到 `test/test/span/SpanApiApp.java:52` 就在直接证明这个价值：通过 `profiler.execute("start,...")` 启动 session 后，`Recording.state()` 变成 `RUNNING`，`Recording.clockFrequency()` 和 `Recording.timestamp()` 能用来校验 span 时间和 profiler 时钟是否一致；session stop 后，状态又回到 `STOPPED`。

所以 `Recording` 的正确定位不是“Java 侧另一个 profiler façade”，而是“在 profiler 已经活起来之后，给 JFR/span/clock 辅助路径提供状态和时钟桥”。

这里必须把一个失败方案打透：不能因为 `Recording` 也有 native 方法、也在 API 包里，就把它误写成主入口。它在静态初始化失败时选择 `UNAVAILABLE` 而不是继续找库，这已经把“主入口”和“辅助桥”的角色差异写死了。

## 第六层：Java API、C API 和 CLI 为什么共享同一个 native 语义中心

到这里，最后一个必须收拢的问题是：Java API 到底有没有拥有一套自己的 profiler 语义？答案仍然是否定的。真正的语义中心始终在 native。

最直接的对照就是 C API。`asprof_execute(const char* command, asprof_writer_t output_callback)` 做的事情几乎和 Java `execute0` 一样：

1. `Arguments args;`
2. `args.parse(command);`
3. `Log::open(args);`
4. 选择 `CallbackWriter` 或 `FileWriter`；
5. 调用 `Profiler::instance()->runInternal(args, out)`（`src/asprof.cpp:26-53`）。

Java `execute0` 的骨架只是把 `jstring` 变成 `const char*`，再做异常映射和 `String`/file 的 Java 结果承载（`src/javaApi.cpp:55-93`）。于是三条入口可以压成：

```text
Java execute0: jstring → Arguments::parse → runInternal → String/file
C API:         const char* → Arguments::parse → runInternal → callback/file
CLI/main:      argv/attach → Arguments::parse → runInternal → writer/file
```

这说明什么？说明 Java API、C API、CLI 的真正差异只停留在“命令从哪里来、结果到哪里去”；参数语义、默认值、冲突关系、执行内核都共享同一个 native 中心。

所以如果文章把 Java API 写成“另一份参数体系”或“Java 世界自己的 profiler 实现”，就会从根上偏掉。更准确的说法是：Java API 的价值在于对象化入口、加载激活、少量便利投影和辅助桥接；它不应该也没有必要复制 native 的语义中心。

*关键设计（斜体）：* *Java、C、CLI 这些入口外壳共享同一套 native 参数解析和 profiler 内核，目的不是让每一层都长出自己的语义中心，而是让不同语言和调用方式都汇入同一份真相。*[模式: 单一语义中心 + 多入口外壳]

## 常见误解与实现边界

**误解一：`AsyncProfiler` 类一被加载，就一定已经装载了 native 库。** 当前是第一次 `getInstance()` 才真正尝试装载；类本身可以先存在而库尚未进入进程。

**误解二：Java API 应该彻底强类型化，字符串协议只是历史包袱。** 当前 `execute(String)` 仍是权威入口；少量便利方法只是高频场景的投影，不是新的语义中心。

**误解三：五级找库只是几种等价技巧。** 它们分别在兼容显式控制、预加载注入、外部配置、自包含 jar、系统库搜索这五种部署形态。

**误解四：`getVersion()` 只是取版本号。** 在 `getInstance()` 里，它更重要的角色是预加载探针。

**误解五：MXBean 是另一套 profiler 实现。** 它只是把同一个 Java API 再包装成 JMX 可调用形态。

**误解六：`Recording` 是 Java 侧的主入口。** 它更偏向 recording state / clock / span bridge；静态初始化失败时只会落到 `UNAVAILABLE`，不会继续像 `getInstance()` 那样找库。

**误解七：Java API、C API、CLI 各自定义了一套参数语义。** 三者共享同一 native `Arguments::parse()` / `Profiler` 内核；差别主要在输入输出载体。

## 收网：Java API 真正提供的，不是“另一份 profiler”，而是对象化激活点

如果把整条链压成一句话，`AsyncProfiler.getInstance()` 真正做的不是“拿到一个单例对象”，而是把 native profiler 激活成 Java 世界可进入的能力入口；后续的 `execute0/execute1/start0/stop0/filterThread0`，再把同一个 native 协议和输出契约投影成 Java 调用者更熟悉的方法形态。

```text
AsyncProfiler.getInstance()
  → 显式路径 / 预加载探针 / 系统属性 / 内嵌解压 / loadLibrary
    → native 库进入进程
      → execute0 / execute1 / start0 / stop0 / filterThread0
        → Arguments::parse 或 Profiler::start/stop
          → Profiler 内核 / writer / 输出格式

Recording
  → registerNatives / state / timestamp / emitSpan
    → 为 JFR/Span/clock 辅助路径服务
```

到这里，主线只发生了三件事。

第一，`getInstance()` 把库装载时机和实例获取绑在一起，因此它是 Java 世界的激活点，而不是普通工厂。

第二，`execute(String)` 仍是最接近 native 真相的权威入口；`start/resume/stop`、`dumpCollapsed`、`dumpOtlp`、线程过滤、MXBean 只是围绕它展开的便利投影或包装层。

第三，Java API、C API、CLI 都围绕同一个 native 参数解析与 profiler 内核展开，避免各自长出一份语义中心；`Recording` 则补上 state/clock/span 辅助桥，而不是变成另一份主入口。

*关键设计（斜体）：* *Java API 的真正价值不在于重写 profiler，而在于让 Java 调用者以熟悉的对象方式激活并进入同一套 native 能力，同时尽量不复制 native 协议语义。*[模式: 对象化激活点 + 协议最小复制]

**本篇的一句话困惑**：一次 `AsyncProfiler.getInstance()`，为什么就足以把 native profiler 变成可调用的 Java 对象？

**本篇的一句话顿悟**：因为这一步既完成了预加载探测与五级找库，也把后续调用统一接到 `execute0/execute1/start0/stop0` 等 JNI 桥；Java 方法只是同一 native 协议和输出契约的对象化外壳。

下一篇继续看 AP-6 的 helper / closure 路径：`Recording`、thread-local buffer、`emitSpan()` 与时钟同步怎样继续为上层 span/JFR 辅助能力服务。

[跨层标注：Java 单例/类加载；JNI `System.load/loadLibrary`；native `Arguments::parse`/`Profiler::runInternal`；JMX MXBean；Recording state/clock bridge；C API `asprof_execute`；embedded lib 自包含部署]
