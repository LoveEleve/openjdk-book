# System 与 Runtime 门面：Java 进程如何管理时间、状态与退出

> 本文基于 JDK 11 `java.base` 的 `System`、`Runtime`、`Shutdown` 实现。涉及时钟底层时以 HotSpot/Linux 为例；涉及 shutdown hook 时同时区分 Java API 契约与 JDK 11 当前实现。`currentTimeMillis` 的返回格式、`nanoTime` 只适合做差值、`System.exit` 的基本语义属于 API 契约；native 入口、属性快照和 shutdown 槽位则是当前实现证据。本文讨论的是 JDK 11 进程门面能力，不把这里的时钟源选择、arraycopy 优化路径和 shutdown 状态机组织方式外推成所有 JVM 进程管理的统一规范。
> **前置依赖**：[Object 的方法契约与对象生命周期](01-object-contract-references.md)、[包装类与缓存](../02-number-math/01-wrapper-cache-boxing.md)
> **后续**：[进程与本地交互](03-process-native.md)

## 先把上一层边界接上：为什么这次轮到 System / Runtime

上一篇讲的是对象边界：哪些能力可以留在普通 Java 对象内部，哪些能力必须借助 JVM 才能成立。`Object.hashCode()`、`clone()`、`Reference`、`Cleaner` 虽然主题不同，但它们都在说明一件事：只要 Java 代码开始触碰运行时状态、GC 状态或对象生命周期，普通业务对象就不再是完整边界。

这一篇再往外走一步。现在要碰的已经不是“某个对象怎样活、怎样死”，而是**整个 JVM 进程此刻处在什么时间、持有哪些全局属性、准备如何退出**。这就是 `System` 和 `Runtime` 的位置：它们不是给业务层凑 API 的工具箱，而是 Java 代码访问进程级能力的门面。

## 两个看似无关的事故，其实在问同一件事

线上接口耗时偶尔出现负数。代码很简单：请求开始时记下 `currentTimeMillis()`，请求结束时再减一次。日志里却出现结束时间小于开始时间。排查后发现，机器在这段时间内发生了 NTP 校时，或者运维手动调整了系统时间。

另一次发布事故更常见：进程收到终止信号，业务线程似乎都停了，容器却迟迟不退出。原因不是 JVM “忘了退出”，而是 shutdown hook 还在等待一个没有超时的网络调用。优雅终止窗口耗尽后，外部系统只能强制杀掉它。

这两个问题分别落在 `System.currentTimeMillis()` 和 `Runtime.addShutdownHook()` 上，但它们共享一个入口：Java 代码正在触碰当前进程之外的状态。

```text
Java 调用者
   │
   ├── System：时间、数组、属性、退出的静态门面
   └── Runtime：当前 JVM 的单例门面
          │
          ├── HotSpot/native：时钟、数组拷贝、堆查询
          ├── VM 启动状态：系统属性与内部快照
          └── Shutdown 状态机：hook、清理、最终 halt
```

因此，这篇文章不按“System 有哪些方法、Runtime 有哪些方法”列清单，而是沿着四次边界穿越来理解它们：时间如何区分“此刻”和“经过多久”，数组为什么把正确性与性能下沉给 JVM，属性为什么同时存在公开集合和启动快照，以及一个 Java 进程怎样从“准备退出”走到“真正终止”。

## 一、时间：两个 API 都叫 time，却不能互换

### 先排除最直觉的方案

如果需求是“记录订单创建时间”，我们需要一个能与 Unix 时间、日志和数据库对齐的时间点；如果需求是“计算一次 RPC 花了多久”，我们只需要两个读数之间的稳定差值。

把这两个需求都交给墙上时钟，看起来最省事，实际上把系统校时也纳入了耗时计算。墙上时钟服务的是日历语义：它可能被同步、修正或人为调整。它适合回答“现在是哪一天”，不适合单独承担“这段代码经过了多久”。

反过来，把 `nanoTime()` 当日期时间也不成立。它的起点是 JVM 实例内部的固定但任意的 origin，同一进程内两次调用的差值有意义，绝对值没有跨进程、跨重启的日历含义。

### native 声明只是边界，真正重要的是契约

这里先给一个路标：这一节不是为了证明“native 就更底层所以更厉害”，而是为了回答两个更具体的问题——谁提供时间值，以及这个时间值到底承诺了什么。只有把这两个问题分开，后面看到 `currentTimeMillis()` 和 `nanoTime()` 的声明才不会误以为“它们只是精度不同”。

带着“两个值到底分别保证什么”的问题看 JDK 11 的声明：

```java
// System.java:396
public static native long currentTimeMillis();
```

```java
// System.java:440
public static native long nanoTime();
```

`currentTimeMillis()` 返回从 1970-01-01 UTC 起算的毫秒数，但源码文档明确提醒：单位是毫秒，不代表底层每毫秒都能变化，实际粒度依赖操作系统。它是记录时间点的入口，不是单调计时器。

`nanoTime()` 返回 JVM 高分辨率时间源的纳秒读数。JDK 文档特意写了三层限制：第一，数值起点任意；第二，只有同一个 JVM 实例中两个读数的差值才有意义；第三，纳秒是单位和精度表达，不保证每纳秒都发生一次变化。做超时比较时还应写成 `nanoTime() - start >= timeout`，而不是先把两个数相加，因为前一种写法能自然处理 long 溢出。

```text
记录发生时间：currentTimeMillis → epoch 时间点 → 日志/数据库
测量经过时间：nanoTime(start) ───── nanoTime(end) → end - start
                         不参与校时，也不解释成日期
```

这也解释了为什么 Java 标准库自己在等待超时时会使用 `nanoTime`：`Process` 的等待逻辑以及 `ReferenceQueue` 的超时计算，都需要的是“剩余时长”，不是会被校时影响的日历时间。

这里要把平台边界说清楚：`System.java` 只承诺 Java 层契约和 native 入口。Linux 下最终使用何种时钟源、是否经过 HotSpot 的平台抽象，是 HotSpot/Linux 实现事实，不是 Java API 对所有 JVM 和操作系统的统一承诺。

**这一层只记住一个选择：时间点用墙上时钟，耗时和超时用单调时钟。**

到这里主线其实只发生了一件事：Java 进程把“现在几点”与“已经过了多久”拆成了两种不同契约。下面再看第二种门面能力，它不像时间那样容易被校时误导，却同样不能被“看起来差不多”的朴素写法替代。

## 二、arraycopy：不是更快的 for 循环，而是 JVM 边界

### 为什么手写循环不够

数组复制表面上只有一个循环，但 API 必须同时处理三组约束：源和目标必须真的是数组；运行时类型必须允许复制；源目标重叠时不能覆盖还没有读取的数据。若复制的是引用数组，写入还会受到引用类型检查和垃圾收集器写屏障的影响。

最直觉的方案是手写 `for`。它能表达“把第 i 个元素赋给第 i 个位置”，却不能自动获得 `arraycopy` 的完整边界语义。尤其是同一数组向后平移时，复制方向必须反过来；引用数组和基本类型数组也不应走同一条底层路径。

### Java 层故意只留一个统一入口

如果前面只记住“`arraycopy` 可能更快”，这一节就还没讲到点上。真正要记住的是：JDK 不想让每个上层库都各自重写一遍数组复制的正确性边界，所以它故意把入口收窄成一个 JVM 能整体接管的调用点。

带着“这些边界由谁保证”的问题看声明：

```java
// System.java:534-537
@HotSpotIntrinsicCandidate
public static native void arraycopy(Object src,  int  srcPos,
                                    Object dest, int destPos,
                                    int length);
```

这个签名看似宽泛，实际把运行时类型检查、范围检查、重叠复制和底层路径选择集中到 JVM 能理解的位置。`native` 说明 Java 方法本身不实现逐元素逻辑，`@HotSpotIntrinsicCandidate` 则说明 HotSpot 可以把它识别为特殊调用，在编译热点代码时选择专用的数组拷贝实现。至于具体是哪个 stub、是否使用特定 CPU 指令，属于 HotSpot 和平台实现，不是 Java API 的性能保证。

```text
调用者
  → System.arraycopy
      → 类型/范围/重叠语义
      → 基本类型批量复制 或 引用数组复制与写屏障
      → HotSpot intrinsic / stub / 平台指令
```

所以 `Arrays.copyOf`、集合扩容、字符串内部扩容等上层代码，消费的是这条已经集中处理边界的能力。手写循环并非永远错误：小规模、带业务转换的复制当然可以直接写循环；错误的是把循环当成所有数组复制场景的等价替代，然后自行重复实现重叠、类型和性能边界。

**这一层的顿悟是：`arraycopy` 的价值首先是把复杂的正确性集中起来，其次才是让 JVM 有机会把它优化成批量复制。**

这也是一个常见误解分界线：很多人以为 `System` 只是“把几个 native 方法挂出来”，但真正更有价值的动作是它替整个类库统一了边界。时间统一了计时契约，`arraycopy` 统一了复制语义；接下来属性管理会看到同一种思路——公开接口和内部真实状态不能直接混成一份可变字典。

## 三、属性：公开可变集合与启动快照必须分开看

### 先看一个危险的直觉

`System.getProperty(key)` 看起来像是从一个全局字典读值。既然 `System.getProperties()` 能拿到这个字典，那么用户代码似乎可以随意清空、替换或修改它，而 JDK 内部也应该跟着看到同一份结果。

这套想法对“应用自己的配置”可以成立，对 JDK 启动参数却不安全。JDK 在启动阶段需要读取若干由 VM 注入的配置，例如整数缓存上限、直接内存上限和启动器参数。如果这些内部配置始终依赖公开且可变的 `Properties`，应用代码一次 `clear()` 就能让内部行为失去启动时依据。

### 公开读取链路是什么

这一节先别急着抠每个属性 key。主线只需要先记住两个角色：一份是应用代码看得见、也可能改得动的 `props`；另一份是 JDK 启动阶段保存下来的内部视图。后面的源码只是证明这两份状态确实被刻意分开了。

先回答普通应用调用到底读哪里：

```java
// System.java:826-834
public static String getProperty(String key) {
    checkKey(key);
    SecurityManager sm = getSecurityManager();
    if (sm != null) {
        sm.checkPropertyAccess(key);
    }
    return props.getProperty(key);
}
```

`props` 在 `System.initPhase1()` 中先创建，再由 `initProperties(props)` 让 VM 初始化。它不是第一次调用 `getProperty` 时才凭空生成的。属性来源可以是 VM 初始化值、命令行 `-D` 参数或运行时 API 修改；但“公开读取入口读 `props`”与“内部启动配置永远只读 `props`”是两件不同的事。

### JDK 11 的隔离动作：先快照，再移除特定项

真正的启动链路在 `System.initPhase1()`：

```java
// System.java:1964-1965
props = new Properties(84);
initProperties(props);  // initialized by the VM
```

```java
// System.java:1981
VM.saveAndRemoveProperties(props);
```

`VM.saveAndRemoveProperties` 并不是把所有属性都变成不可变内部配置。它先把当时的属性条目复制到 `savedProps`，然后只移除明确属于内部实现的项目。JDK 11 源码列出的例子包括 `sun.nio.MaxDirectMemorySize`、`sun.nio.PageAlignDirectMemory`、`java.lang.Integer.IntegerCache.high`、`sun.java.launcher.diag` 和 `jdk.boot.class.path.append`。

```java
// VM.java:191-196
Map<String, String> sp =
    Map.ofEntries(props.entrySet().toArray(new Map.Entry[0]));
savedProps = sp;
```

```java
// VM.java:220-228
props.remove("java.lang.Integer.IntegerCache.high");

// used by sun.launcher.LauncherHelper
props.remove("sun.java.launcher.diag");

// used by jdk.internal.loader.ClassLoaders
props.remove("jdk.boot.class.path.append");
```

这里的“快照”是启动时的内部视图，`Map.ofEntries` 也使这份视图不再跟着公开 `Properties` 的后续修改变化；“移除”则是避免某些仅供内部使用的 key 继续出现在公开集合中。内部组件通过 `VM.getSavedProperty` 读取这份启动快照，并且该方法的文档明确限定：只应读取不会在运行时改变的系统属性。

域 02 的 `IntegerCache` 正好把这条链闭合：

```text
VM 注入 java.lang.Integer.IntegerCache.high
   → System.initPhase1 创建 props
   → VM.saveAndRemoveProperties 建立 savedProps
   → 从公开 props 移除该 key
   → IntegerCache 通过 VM.getSavedProperty 读取启动值
```

因此，用户可以改变公开属性视图，却不能用后续的 `clear()` 抹掉已经保存的启动参数。这个隔离并不意味着所有系统属性都可以随意修改：`System` 的文档反而提醒，修改标准属性可能产生不可预测结果。正确做法是把公开属性当作进程级 API 状态，把 JDK 私有快照当作启动时形成的内部状态，两者不要混为一个配置中心。

**这一层只记住两个动作：启动时复制，随后移除特定内部项；公开集合和内部快照拥有不同的使用者与生命周期。**

到这里为止，前三层门面已经能收成一张小图：时间负责给进程读时钟，`arraycopy` 负责给类库借运行时能力，属性负责在“公开可变”和“内部稳定”之间切开边界。最后一层最容易出事故，因为它直接决定进程能不能体面地离场。

## 四、退出：System.exit 只是入口，Shutdown 才是流程

### 先区分三种结束方式

一个 Java 进程可能因为最后一个非守护线程结束而进入关闭，也可能响应用户中断或系统终止事件，还可能由代码调用 `System.exit`。这些情况都会进入 shutdown 语义，但外部强制终止，例如 Unix 的 `SIGKILL`，属于 abort，不能保证 hook 被执行。

代码里还存在一个容易混淆的出口：`halt`。如果业务只是想“做完清理后退出”，使用 `halt` 会绕过 hook；如果进程已经卡在无法结束的清理阶段，`halt` 才是强制终止的逃生门。

### 入口委托与状态机

如果把 `System.exit` 理解成“Java 版 kill -9”，后面所有现象都会看反。它的真实角色更像是提出一个退出请求：有人做安全检查，有人组织 hook，有人等待清理，最后才有人真正把进程停掉。

`Runtime` 不允许外部直接创建，`getRuntime()` 返回当前应用唯一的 `Runtime` 对象。`System.exit` 的实现只是把请求转给它，随后由 `Runtime.exit` 做安全检查并进入 `Shutdown.exit`：

```java
// Runtime.java:70-72
public static Runtime getRuntime() {
    return currentRuntime;
}
```

```java
// Runtime.java:111-117
public void exit(int status) {
    SecurityManager security = System.getSecurityManager();
    if (security != null) {
        security.checkExit(status);
    }
    Shutdown.exit(status);
}
```

JDK 11 的 `Shutdown` 维护一个固定槽位数组。源码注释列出了其中的系统 hook：控制台恢复、应用 shutdown hook 聚合器、delete-on-exit hook。`Shutdown.runHooks()` 按槽位推进 `currentRunningHook`，调用每个槽位的 `Runnable`；所有系统槽位处理完后标记 VM shutdown，`Shutdown.exit` 最终调用 `halt(status)`。

```text
System.exit(status)
   → Runtime.exit：安全检查
   → Shutdown.exit：争抢退出流程
   → beforeHalt：通知 VM 准备终止
   → 系统 hook 槽位：按槽位运行
   → ApplicationShutdownHooks：并发启动用户 hook 并等待
   → VM.shutdown
   → halt(status)
```

这里的“顺序”只适用于 JDK 内部的系统槽位，不适用于用户 hook 之间。把两者混成一件事，就会得到“hook 按注册顺序执行”的错误结论。

### 用户 hook 为什么会拖住整个进程

这里再给一个读者最容易踩坑的失败方案：很多业务把 shutdown hook 当成“最后还能慢慢补救的一段后台逻辑”，于是把刷库、补偿、远程通知、无限重试都塞进去。问题在于 JVM 不会把 hook 当后台守护任务；它把 hook 当退出流程本身的一部分，所以任何一个 hook 卡住，整个进程就卡在门口。

`Runtime.addShutdownHook` 接受的是一个已经初始化但尚未启动的 `Thread`。`ApplicationShutdownHooks` 用 `IdentityHashMap` 保存这些线程。退出时，它先把集合取出并置空，阻止新的 hook 加入；然后启动全部线程，再对每个线程执行 `join()`。这些 hook 是并发开始的，但退出流程仍然要等它们全部结束。

```text
用户注册 hook
   → shutdown 开始，注册表封存
   → 启动全部用户 hook，顺序未指定
   → 逐个 join，但等待的是全部完成
   → 应用 hook 聚合器返回
   → Shutdown 继续收尾并 halt
```

这解释了发布时“进程已经收到终止信号却不退出”的现象：只要一个 hook 卡在无限重试、锁等待或没有超时的网络调用，聚合器的 `join` 就不会返回。异常则是另一回事：用户 hook 是普通线程，未捕获异常会按线程规则处理并结束该线程，不会自动替其他 hook 完成它的清理责任。

JDK 的 API 文档因此要求 hook 尽量线程安全、避免死锁、不要盲目依赖其他也在关闭的线程服务，并且尽快完成。生产代码可以在 hook 中做连接关闭、状态落盘和最后的指标刷新，但必须设计超时、幂等和失败降级；不要把一个必须无限等待的业务协议塞进 JVM 最后的退出路径。

### `exit`、`halt` 与并发退出不是同一个承诺

这时再回头看第二个事故，就能把责任分清了：收到终止信号却迟迟不退出，未必是 JVM 失灵，更可能是它还在忠实履行 `exit` 的承诺——等待清理链走完。真正放弃这份承诺的是 `halt`，而不是 `exit`。

`Runtime.exit` 不是“调用后立刻杀掉 OS 进程”。它会等待 shutdown 流程。JDK 11 的 `Shutdown.exit` 还处理了退出竞争：如果非零状态的退出请求到达时 VM 已经处于 shutdown 状态，会直接 halt；随后通过 `Shutdown.class` 的同步锁串行化真正的退出过程，其他试图同时退出或 halt 的线程可能被阻塞。

`Runtime.halt` 则先做安全检查，调用 `Shutdown.beforeHalt()`，再进入同步的 native halt 路径。API 文档明确说明它不启动 hook，也不等待已经运行的 hook。它不是“更快的优雅退出”，而是放弃清理保证后的强制终止。

### Runtime 的其他 native 查询也有边界

`Runtime.freeMemory()`、`totalMemory()` 和 `maxMemory()` 都是 native 查询，但它们回答的是 JVM 堆状态的近似或当前值，不是操作系统进程的全部内存占用。`freeMemory` 是未来对象可用空间的近似值，`totalMemory` 可能随宿主环境变化，`maxMemory` 是 JVM 尝试使用的上限。`Runtime.gc()` 的 API 语义也只是建议 JVM 花力气回收，并非调用线程可以据此证明“一次完整 GC 已经同步结束”。

这几个方法再次说明 `Runtime` 是进程门面：Java 层只提供稳定调用形式，真正的内存管理和终止动作由 JVM 状态决定。

## 五、五个最容易混掉的边界：currentTimeMillis 不是耗时器，nanoTime 不是日历值，arraycopy 不是手写循环提速，getProperties 不是 JDK 全真相，exit 也不是立即终止

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`currentTimeMillis` 不是做耗时测量的工具。它返回的是墙上时钟时间，可能被校时或手动调整；用它做差值计算，得到的结果可能为负或剧烈跳变。耗时测量应当用 `nanoTime`，它只适合同 JVM 内做差值，不解释成日历时间。

第二，`nanoTime` 反过来也不是日历时间。它返回的是 JVM 实例内某个固定但任意起点后的纳秒数，跨进程、跨重启后的绝对值没有任何语义。只有同一进程内两次调用之间的差值才有意义。

第三，`arraycopy` 的优势也不是“比手写循环更快”这么简单。它更重要的价值是统一了类型检查、范围检查、重叠复制和写屏障处理，让这些复杂边界不再散落到每个调用方手里。把正确性集中起来，然后才谈得上让 JVM 优化成全量复制。

第四，`System.getProperties()` 返回的也不是 JDK 所有内部状态的唯一真相。JDK 11 在启动时通过 `VM.saveAndRemoveProperties` 把内部配置复制到 `savedProps`，再从公开集合中移除。因此公开 `Properties` 的修改并不总是影响 JDK 内部行为。

第五，`System.exit` 更不是“调用后 OS 进程立刻终止”。它会先走 shutdown 流程：安全检查、系统 hook 槽位、用户 hook 并发执行并等待完成，最后才 `halt`。用户 hook 一旦卡住，整个进程就会停在门口。`halt` 才是真正放弃清理承诺的强制终止。

把这五条边界记稳，`System` 和 `Runtime` 这一篇就不会重新塌回“几个静态工具方法”的表面印象。它真正想讲的是：进程级时间、复制、属性和退出，都是 Java 到 OS 和 VM 状态之间的门面，边界一旦选错，事故就会从最常见的 API 用法里冒出来。

## 收网：四条使用规则背后的同一张图

回到开头的两个事故，答案已经不再是“记住几个 API”：

```text
时间点 ───── currentTimeMillis ───── epoch / 日历语义
耗时超时 ──── nanoTime ───────────── JVM 内单调差值
数组边界 ──── arraycopy ─────────── JVM 检查与批量复制
启动配置 ──── savedProps ────────── 内部快照，不依赖公开可变集合
优雅退出 ──── exit + hooks ───────── 等待清理后 halt
强制退出 ──── halt ───────────────── 不跑 hook，直接终止
```

第一，记录“发生在什么时候”与测量“经过了多久”必须分开；第二，数组复制优先使用标准库，让 JVM 统一承担边界和优化；第三，不要把 `System.getProperties()` 当作 JDK 所有内部状态的唯一真相；第四，shutdown hook 是有限退出窗口中的并发清理，不是一个可以无限阻塞的后台任务；第五，`halt` 是强制终止，不是优雅退出的别名。

如果把这五条规则再压成一句话，就是：`System` 和 `Runtime` 处理的从来不是“几个零散 API”，而是 Java 代码访问进程级状态时必须经过的四道门——读时钟、借运行时能力、读取启动状态、组织退出流程。门外是 OS、VM 和 shutdown 状态机；门内才是业务代码看到的 Java 方法。

`System` 和 `Runtime` 的共同价值，正是把这些进程级能力压缩成 Java API，同时把无法由普通 Java 方法独立保证的部分交给 HotSpot、操作系统和 Shutdown 状态机。下一篇继续沿着这道边界向外走：当 Java 不再只查询当前 JVM，而是要启动另一个操作系统进程时，`ProcessBuilder` 如何把参数、标准输入输出和退出码接起来。
