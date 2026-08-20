# 01. Throwable 内部结构 — 堆栈快照、cause 链、suppressed 异常

> 基于 JDK 11 `java.base` 的 `Throwable` 实现。本文讨论的是 JDK 11 当前的哨兵字段、堆栈快照生成、异常打印和 suppressed 处理路径，不把这些内部协议或性能取舍外推成所有 JDK 版本、所有 JVM 或所有日志实现的统一规范。
> **前置依赖**: [01-string/03 — 字符串构建与拼接](../01-string/03-build-concat.md)(toString 的 `类名: message` 输出本质是字符串拼接)
> → **后续**:[06-exceptions/02 — 异常类型体系与设计哲学](02-exception-hierarchy.md)
> 关联: 内部卷 24-frame-stack(栈帧遍历与 StackTraceElement 生成);[JVM Spec: §6.5 athrow]

## 日志里天天见,内部没人看过

`Caused by:` 和 `Suppressed:` 是每个 Java 工程师在日志里都见过的两行字——前者追溯"谁引发了谁",后者记录"谁被吞了"。但如果你被问到:异常对象里到底存了什么?为什么 catch 之后堆栈偶尔是空的?为什么 JDK7 之后 try-with-resources 能同时保留两个异常?大多数人就停在"Throwable 嘛,存了 message 和堆栈"了。

这篇把 `Throwable.java` 的字段逐个拆开:三个核心字段(消息、cause、堆栈)、两个哨兵值(空堆栈、空 suppressed 列表)、构造器里那一次注定昂贵的 native 调用、以及打印时 `Caused by`/`Suppressed`/`... n more` 三个段落的生成机制。

## 1. 异常对象里到底存了什么

### 1.1 字段总览:四个字段 + 两个哨兵

`Throwable.java` 的实例字段(`Throwable.java:122-232` 区间):

```java
// Throwable.java:131 + 198 + 211 + 232(截取核心,逐字)
private String detailMessage;

private Throwable cause = this;

private StackTraceElement[] stackTrace = UNASSIGNED_STACK;

private List<Throwable> suppressedExceptions = SUPPRESSED_SENTINEL;
```

逐个看:

- **detailMessage**(`Throwable.java:131`):异常信息,`getMessage()`(`Throwable.java:381-383`)直接返回
- **cause**(`Throwable.java:198`):"谁导致了我"。注意初值不是 null,而是 **`this` 自己**——自引用哨兵表示"尚未设置"(`Throwable.java:188-193` 的注释解释了这个约定)。之所以不能直接用 null 当"未设置": null 还要留给"没有 cause"这个真实语义(比如根因异常本身)。哨兵让三种状态可区分: 未设置(=this)、无 cause(null)、有 cause(其他对象)
- **stackTrace**(`Throwable.java:211`):栈帧快照数组,初值是 `UNASSIGNED_STACK`——`Throwable.java:160` 的一个**共享空数组常量**
- **suppressedExceptions**(`Throwable.java:232`):被抑制异常列表,初值是 `SUPPRESSED_SENTINEL`——`Throwable.java:220` 的共享空列表

为什么用共享哨兵而不是 null?`Throwable.java:162-186` 的协议注释给了答案: 哨兵表示"逻辑上未设置"(还可以写),null 表示"禁止再写"(不可变)——两种状态必须能区分,否则无法判断一个异常对象还能不能改。这个协议的实际消费者是 HotSpot 预分配的 `OutOfMemoryError` 对象: 低内存时 JVM 直接复用预置对象、不调构造器,把 cause/stackTrace/suppressedExceptions 三个字段**置为 null**(注释 `Throwable.java:177-181`),于是这些异常不可被用户代码改写,既能安全复用又可诊断。

关键设计(斜体):*`cause = this` 这个"自引用即未设置"的设计是整个异常链机制的地基——getCause 用一行 `cause == this ? null : cause`(`Throwable.java:420`)区分"没有 cause"和"有 cause",不需要额外的布尔标志。空数组/空列表的共享哨兵则是省内存的惯例: 99% 的异常没有 suppressed,没必要给每个异常分配一个空集合对象。*

### 1.2 构造时抓栈:一次注定昂贵的 native 调用

四个公开构造器里,最简单的那个(`Throwable.java:254-256`):

```java
// Throwable.java:254-256(截取核心,逐字)
public Throwable() {
    fillInStackTrace();
}
```

带 message 和 cause 的构造器(`Throwable.java:291-295`)也只是在开头多调一次 `fillInStackTrace()`。这个调用干什么(`Throwable.java:784-793`):

```java
// Throwable.java:784-793(截取核心,逐字)
public synchronized Throwable fillInStackTrace() {
    if (stackTrace != null ||
        backtrace != null /* Out of protocol state */ ) {
        fillInStackTrace(0);
        stackTrace = UNASSIGNED_STACK;
    }
    return this;
}

private native Throwable fillInStackTrace(int dummy);
```

关键点:

1. **抓栈发生在构造时,不是 throw 时**——所以堆栈反映的是"创建异常的位置",而不是"抛出异常的位置"。同一个异常对象被抛两次,堆栈还是第一次创建时的那份
2. **真正的抓栈是 native**:`fillInStackTrace(0)`(`Throwable.java:793`)是 native 方法,由 JVM 遍历当前线程的栈帧,把回溯信息存进 `backtrace`(`Throwable.java:122`)和 `depth`(`Throwable.java:216`)两个字段。Java 侧拿到的是原生回溯,不是现成的 StackTraceElement 数组
3. **数组是惰性生成的**:`stackTrace` 字段被重置为 `UNASSIGNED_STACK` 空数组;第一次**访问堆栈**时(调用 `getStackTrace()`、`printStackTrace()`、甚至序列化——都是走 `getOurStackTrace()`,`Throwable.java:820`/`660`/`990`),才从 backtrace 转换出完整的 StackTraceElement[]:

```java
// Throwable.java:823-833(截取核心,逐字)
private synchronized StackTraceElement[] getOurStackTrace() {
    // Initialize stack trace field with information from
    // backtrace if this is the first call to this method
    if (stackTrace == UNASSIGNED_STACK ||
        (stackTrace == null && backtrace != null) /* Out of protocol state */) {
        stackTrace = StackTraceElement.of(this, depth);
    } else if (stackTrace == null) {
        return UNASSIGNED_STACK;
    }
    return stackTrace;
}
```

跨层标注: [内部卷: 24-frame-stack 01-physical-frame/02-virtual-frame——VM 侧的帧遍历与 StackTraceElement 生成路径]

关键设计(斜体):*"构造时抓栈"是异常语义的一部分——`new Exception()` 的那一刻,当前线程的栈就凝固成了这个异常的身份。代价是贵: 一次 native 栈遍历 + 后续一次数组分配。`new Exception()` 比普通对象慢一个数量级以上(取决于栈深度),所以用异常做控制流(比如用 catch 跳出循环、用异常传返回值)是生产反模式——正常路径不该支付这个成本。*

### 1.3 toString:异常的第一行

`printStackTrace` 的第一行就是 `toString()`(`Throwable.java:483-487`):

```java
// Throwable.java:483-487(截取核心,逐字)
public String toString() {
    String s = getClass().getName();
    String message = getLocalizedMessage();
    return (message != null) ? (s + ": " + message) : s;
}
```

格式是 `类名: message`,message 为 null 时只有类名。注意用 `getClass().getName()` 而不是硬编码——所以子类(比如 `NullPointerException`)打印出来的就是自己的类名。

## 2. "Caused by 是怎么来的" — cause 链

### 2.1 构造器传播:直接赋值,不绕弯

包装异常的标配构造(`Throwable.java:291-295`):

```java
// Throwable.java:291-295(截取核心,逐字)
public Throwable(String message, Throwable cause) {
    fillInStackTrace();
    detailMessage = message;
    this.cause = cause;
}
```

`this.cause = cause` 直接赋值(不走 initCause——initCause 是给"先构造后补 cause"的遗留场景用的)。还有一个简写构造 `Throwable(Throwable cause)`(`Throwable.java:314-318`),它把 message 自动设为 `cause.toString()`——适用于"纯包装"型异常。链就这样形成了:每个包装异常持有下一层的引用,`getCause()` 沿引用走就能到根。

### 2.2 getCause:一行代码的双重语义

`getCause()`(`Throwable.java:419-421`):

```java
// Throwable.java:419-421(截取核心,逐字)
public synchronized Throwable getCause() {
    return (cause==this ? null : cause);
}
```

自引用哨兵在这里兑现:`cause == this` 意味着"未设置",对外返回 null;否则返回真实 cause。这是 1.1 节那个哨兵设计的完整闭环。

### 2.3 initCause:只许设置一次

`initCause`(`Throwable.java:459-467`)补充了"先创建后补 cause"的路径,但有两个硬约束:

```java
// Throwable.java:459-467(截取核心,逐字)
public synchronized Throwable initCause(Throwable cause) {
    if (this.cause != this)
        throw new IllegalStateException("Can't overwrite cause with " +
                                        Objects.toString(cause, "a null"), this);
    if (cause == this)
        throw new IllegalArgumentException("Self-causation not permitted", this);
    this.cause = cause;
    return this;
}
```

- **只能设置一次**:第二次调用抛 `IllegalStateException`(`Throwable.java:460-462`)——防止同一个异常对象被多线程各设一个 cause,链被撕裂
- **不能自指**:`cause == this` 抛 `IllegalArgumentException`(`Throwable.java:463-464`)——"异常不能是自己的原因"是语义上的病态状态(虽然 getCause 的哨兵检查会让它返回 null,但构造器直接赋值路径不校验,靠 initCause 兜住)

关键设计(斜体):*"只设一次"和"禁止自指"是两个防滥用约束,背后是同一件事: cause 链被当作不可变结构来遍历(打印、日志分析)。如果允许重复设置,共享同一个异常对象的两条执行路径就会互相污染。真正的死循环风险不在"直接自指"(getCause 的哨兵检查会让遍历终止),而在**间接环**——A 的 cause 是 B、B 的 cause 又是 A,构造器和 initCause 都不检查这种结构。所以打印侧还有第三道防线: `printStackTrace` 的 dejaVu 集合(`Throwable.java:654`)在递归时记录已打印过的异常,遇到环只输出 `[CIRCULAR REFERENCE: ...]`(`Throwable.java:685-686`),不会真的死循环。*

### 2.4 打印侧:Caused by 与 ... n more

`printStackTrace` 的核心(`Throwable.java:651-673`):

```java
// Throwable.java:665-671(截取核心,逐字)
// Print suppressed exceptions, if any
for (Throwable se : getSuppressed())
    se.printEnclosedStackTrace(s, trace, SUPPRESSED_CAPTION, "\t", dejaVu);

// Print cause, if any
Throwable ourCause = getCause();
if (ourCause != null)
    ourCause.printEnclosedStackTrace(s, trace, CAUSE_CAPTION, "", dejaVu);
```

`CAUSE_CAPTION`(`Throwable.java:241`)就是字符串 `"Caused by: "`。递归打印在 `printEnclosedStackTrace`(`Throwable.java:679-715`),其中有个值得注意的优化——**帧去重**:

```java
// Throwable.java:690-703(截取核心,逐字)
StackTraceElement[] trace = getOurStackTrace();
int m = trace.length - 1;
int n = enclosingTrace.length - 1;
while (m >= 0 && n >=0 && trace[m].equals(enclosingTrace[n])) {
    m--; n--;
}
int framesInCommon = trace.length - 1 - m;
...
if (framesInCommon != 0)
    s.println(prefix + "\t... " + framesInCommon + " more");
```

从栈底向上比较当前异常与包裹异常的公共帧——包装异常通常在同一个方法里 catch 再抛,底层几十帧必然重合。重合部分不重复打印,只输出 `... n more`。这就是日志里常见尾巴的机制来源,也是"日志分析从下往上读 Caused by"的格式依据: 每个 `Caused by` 段都只显示"新增"的帧。

关键设计(斜体):*"包装异常与根因异常共享同一段栈"是常态(在同一个方法里 catch → new → throw),`... n more` 把这段公共部分折叠成一个数字,日志体积大幅下降。面试能说出"n 是两段栈从底部匹配的公共帧数",比"就是省略号"高一个段位。*

## 3. "Suppressed 是什么" — try-with-resources 的关闭失败

### 3.1 历史问题:finally 里的异常会吞掉主异常

JDK6 及以前,资源关闭是这样写的:

```java
Resource r = new Resource();
try {
    r.doWork();          // 主逻辑抛异常 A
} finally {
    r.close();           // close() 又抛异常 B → B 直接覆盖 A 抛出
}
```

`finally` 里 close() 抛出的异常会**覆盖** try 块里的原始异常——线上排查时看到的是无关紧要的关闭失败,真正的原因丢了。JDK7 的 try-with-resources 解决这个问题: 主异常保留,关闭异常**附加**到主异常的 suppressed 列表。

### 3.2 addSuppressed:懒初始化 + 三道检查

`addSuppressed`(`Throwable.java:1052-1066`):

```java
// Throwable.java:1052-1066(截取核心,逐字)
public final synchronized void addSuppressed(Throwable exception) {
    if (exception == this)
        throw new IllegalArgumentException(SELF_SUPPRESSION_MESSAGE, exception);

    if (exception == null)
        throw new NullPointerException(NULL_CAUSE_MESSAGE);

    if (suppressedExceptions == null) // Suppressed exceptions not recorded
        return;

    if (suppressedExceptions == SUPPRESSED_SENTINEL)
        suppressedExceptions = new ArrayList<>(1);

    suppressedExceptions.add(exception);
}
```

- **自抑制拒绝**:`exception == this` 抛 IAE(`Throwable.java:1053-1054`,JDK9 新增的检查)
- **null 拒绝**:NPE(`Throwable.java:1056-1057`)
- **禁用的直接返回**:四参构造传 `enableSuppression=false` 时字段为 null,这里 no-op(`Throwable.java:1059-1060`)
- **懒初始化**:第一次 add 才 `new ArrayList<>(1)`(`Throwable.java:1062-1063`)替换共享哨兵——1.1 节那个哨兵协议的回声: 99% 的异常没有 suppressed,不为它们分配集合

读取侧 `getSuppressed`(`Throwable.java:1085-1091`)对哨兵和 null 都返回共享空数组 `EMPTY_THROWABLE_ARRAY`(`Throwable.java:1068`),调用方永远拿不到 null。

### 3.3 打印侧:Suppressed 段

1.2 节看过的 `printStackTrace` 主循环里,`getSuppressed()` 的结果用 `SUPPRESSED_CAPTION`(`Throwable.java:244`,字符串 `"Suppressed: "`)逐个打印,缩进比 Caused by 多一个 tab。日志长这样(示例出自 Throwable 自己的 javadoc,`Throwable.java:600-606`):

```
Exception in thread "main" java.lang.Exception: Something happened
	at Foo.bar(Foo.java:10)
	at Foo.main(Foo.java:5)
	Suppressed: Resource$CloseFailException: Resource ID = 0
		at Resource.close(Resource.java:26)
		at Foo.bar(Foo.java:9)
		... 1 more
```

关键设计(斜体):*suppressed 与 cause 是两种不同的"附加异常": cause 是因果链(先有因,后有果),suppressed 是并存的失败(主逻辑失败 + 清理失败,两个都真实发生)。try-with-resources 的编译产物是 try/finally,但编译器把 finally 里的关闭异常**捕获后 addSuppressed**,而不是直接抛出——语义从"覆盖"变成"共存"。JDK7 加机制、JDK9 补自抑制检查,是一步步把边界补全的过程。*

## 4. "堆栈怎么没打出来" — 无栈异常的制造与代价

### 4.1 三种来源

生产日志里偶见堆栈只有一行(甚至为空)的异常,机制上来自三个方向:

1. **四参构造关闭**:`Throwable(String, cause, enableSuppression, writableStackTrace)`(`Throwable.java:361-373`)是 protected——传 `writableStackTrace=false` 时**不调 fillInStackTrace**,且 `stackTrace = null`(`Throwable.java:367`);后续 fillInStackTrace/setStackTrace 全部 no-op(`Throwable.java:785` 与 `Throwable.java:872-874` 的判空)

```java
// Throwable.java:361-373(截取核心,逐字)
protected Throwable(String message, Throwable cause,
                    boolean enableSuppression,
                    boolean writableStackTrace) {
    if (writableStackTrace) {
        fillInStackTrace();
    } else {
        stackTrace = null;
    }
    detailMessage = message;
    this.cause = cause;
    if (!enableSuppression)
        suppressedExceptions = null;
}
```

2. **子类覆盖**:匿名类覆盖 `fillInStackTrace()` 返回 this 而不调 super——JDK8 时代的轻量异常惯用法
3. **VM 预分配对象**:1.1 节说过的 HotSpot 预分配 OOM——JVM 低内存时复用预置的 `OutOfMemoryError` 对象,靠哨兵协议保证状态合法(注释 `Throwable.java:162-186`)

### 4.2 效果与代价

关闭堆栈后 `getStackTrace()`(`Throwable.java:819-821`)返回空数组,异常创建**不再有 native 栈遍历**——创建成本从"随栈深增长的 O(n) 遍历 + 数组转换"降为普通对象分配。这就是"无栈异常快"的机制原因: 热路径上高频抛出无栈异常,能省掉每次的栈遍历。代价是问题不可定位: 日志里 `NullPointerException` 没有 `at` 行,无从排查。

关键设计(斜体):*"禁用堆栈"是有状态系统(如 JVM 内部、超高频异常通道)的刻意取舍——用可定位性换吞吐。对业务代码,无栈异常是反模式: 你省下的微秒会在生产事故排查时以小时计地还回来。知道它存在,是为了在日志里认出"这是故意为之"而非"日志框架 bug"。*

跨层标注: [内部卷: 24-frame-stack 01-physical-frame(物理帧遍历);JVM Spec: §6.5 athrow(异常抛出指令)]

## 五个最容易混掉的边界：构造不等于抛出，cause 不是 suppressed，无栈不等于无异常，异常对象不是日志文本，Cleaner 也不是异常资源管理

第一，异常构造不等于异常抛出。JDK 11 的 `Throwable` 通常在构造时抓取当前线程的回溯，`throw` 只是把已经存在的异常对象交给运行时处理；同一个对象再次抛出，不会自动获得第二份创建位置的堆栈。

第二，cause 不是 suppressed。cause 表示“谁导致了当前异常”的因果链，suppressed 表示主异常之外并存的失败，典型场景是 try-with-resources 的关闭异常；把两者混成一条链，会丢掉异常发生的时序和责任关系。

第三，无栈不等于无异常。关闭 writable stack trace 只是不再记录或生成可见堆栈，异常仍然可以携带 message、cause 和其他状态；它换来的是创建成本下降，却同时牺牲了定位能力。

第四，异常对象不是日志文本。`printStackTrace` 会根据 cause、suppressed、公共栈帧和循环引用重新组织输出，日志中的 `Caused by`、`Suppressed`、`... n more` 都是打印协议，不是 Throwable 内部的三个字符串字段。

第五，异常机制也不是资源所有权管理。Throwable 能记录关闭失败，但不能替代显式 close、try-with-resources 或业务层的资源生命周期；suppressed 负责保留信息，真正的清理动作仍由资源管理代码执行。

把这五条边界记稳，Throwable 就不会再被简化成“message 加 stackTrace 的数据对象”。它真正连接了四条路径：创建时记录现场，cause 表达因果，suppressed 保留并存失败，打印器再把这些状态组织成可诊断的文本；类型体系则在下一篇继续回答哪些失败必须进入编译期检查。

## 核心悬念

Throwable 是"错误通道"——但同样的 `throw` 语句,有的异常编译器强迫你处理,有的可以无视: 这就是 checked/unchecked 的分界。`Exception` 和 `Error` 两条继承线、49 个具体异常/错误类的归类(外加两个基类,共 51 个类文件)、以及"Spring 为什么把一切包成 RuntimeException"背后的设计哲学——下一篇把类型体系讲清楚。

> → [06-exceptions/02 — 异常类型体系与设计哲学](02-exception-hierarchy.md)
