# 02. 异常类型体系与设计哲学 — checked/unchecked、Error 家族、生产规范

> 基于 JDK 11 `java.base` 中 `Exception`、`RuntimeException`、`Error` 及其代表性子类实现，并结合 JLS/JVM Spec 的编译期与运行时规则。本文讨论的是 JDK 11 当前类层次、javadoc 约定和生产框架常见包装策略，不把这些具体家族划分或工程取舍外推成所有语言、所有框架或未来 JDK 的统一规范。
> **前置依赖**: [06-exceptions/01 — Throwable 内部结构](01-throwable-structure.md)(cause 链与构造器)
> → **后续**:域 02 数字与数学(02-number-math 系列,下一篇)
> 关联: [JLS §11.2 Compile-Time Checking of Exceptions];[JVM Spec: §4.7.3 异常表];内部卷 21-shared-runtime 03-exception-handling(编译代码抛异常后 JVM 找 handler)、08-interpreter 03-interpreter-runtime

## 同一个 throw,不同的命运

"受检异常 vs 非受检异常"是面试第一梯队的问题——标准答案背得出"受检必须处理,非受检可以不管"。但被追问三个细节时,大多数人就露馅了:这个分界到底在哪一行代码?`catch (Exception e)` 为什么抓不到 OOM?Spring 为什么把一切基础设施异常都包成 RuntimeException?

这篇从三个类的声明开始,把分界点讲精确: `RuntimeException` 的 javadoc 是 unchecked 的"法律条文",`Error` 家族是另一条独立分支,而"生产该怎么抛异常"的答案藏在第 1 篇的 cause 链里。

## 1. 异常金字塔 — 三条分支

### 1.1 三根主干,两处声明

整个异常体系就是三行类声明:

```java
// Exception.java:45 / RuntimeException.java:43 / Error.java:49(截取核心,逐字)
public class Exception extends Throwable {

public class RuntimeException extends Exception {

public class Error extends Throwable {
```

树状关系:

```
Throwable
├── Exception                    ← 受检异常之根
│   └── RuntimeException         ← unchecked 分界点(编译期不强制处理)
│       ├── NullPointerException
│       ├── IllegalArgumentException
│       └── ...(java.lang 下直接子类共 15 个)
└── Error                        ← 致命错误之根(独立分支,不经过 Exception)
    ├── VirtualMachineError
    ├── LinkageError
    ├── ThreadDeath
    └── AssertionError
```

注意 **`Error` 是独立分支**:它直接继承 Throwable,和 `Exception` 没有任何继承关系——这条"断路"正是"catch (Exception) 抓不到 OOM"的机制根源:处理器只匹配类型兼容的异常分支。

### 1.2 unchecked 的"法律条文"在 javadoc 里

checked/unchecked 的分界不是语言关键字,而是 `RuntimeException` 的 javadoc 约定(`RuntimeException.java:28-42`):

```java
// RuntimeException.java:28-42(截取核心,逐字,省略 @author/@since 两行)
/**
 * {@code RuntimeException} is the superclass of those
 * exceptions that can be thrown during the normal operation of the
 * Java Virtual Machine.
 *
 * <p>{@code RuntimeException} and its subclasses are <em>unchecked
 * exceptions</em>.  Unchecked exceptions do <em>not</em> need to be
 * declared in a method or constructor's {@code throws} clause if they
 * can be thrown by the execution of the method or constructor and
 * propagate outside the method or constructor boundary.
 *
 * @jls 11.2 Compile-Time Checking of Exceptions
 */
```

而 `Error` 的 javadoc 里有同样的声明(`Error.java:41`):

```java
// Error.java:36-42(截取核心,逐字)
 * A method is not required to declare in its {@code throws}
 * clause any subclasses of {@code Error} that might be thrown
 * during the execution of the method but not caught, since these
 * errors are abnormal conditions that should never occur.
 *
 * That is, {@code Error} and its subclasses are regarded as unchecked
 * exceptions for the purposes of compile-time checking of exceptions.
```

所以精确的定义是:**受检异常 = 继承 Exception 但不继承 RuntimeException 的类**;`RuntimeException` 分支和 `Error` 分支都是 unchecked。javac 依据 JLS §11.2 的规则做编译期检查: 方法签名 `throws` 里声明了受检异常,调用方要么 catch 要么继续声明,否则编译不过——这就是"编译器强迫处理"的机制。

关键设计(斜体):*三个分支的意图分层: 受检 = 预期内、可恢复的失败(文件不存在、网络超时),调用方应该处理;运行时 = 程序 bug(空指针、数组越界),修复代码而非捕获;Error = JVM 级灾难(OOM、栈溢出),恢复无意义。面试背"受检 vs 非受检"是入门,能说出"分界点在 RuntimeException.java:43 这一行"才见功力。*

### 1.3 运行时异常族与受检代表

java.lang 下**直接**继承 `RuntimeException` 的类正好 15 个:NullPointerException、IllegalArgumentException、IllegalStateException、IndexOutOfBoundsException(及其子类 ArrayIndexOutOfBoundsException/StringIndexOutOfBoundsException)、ClassCastException、UnsupportedOperationException、ArithmeticException、SecurityException 等。它们的内容几乎全是构造器转发(比如 `ArithmeticException.java:48` 的 `public ArithmeticException() { super(); }`),机制都在 Throwable 里,逐个看没有价值——分类记忆才是正解:

- **参数/状态错误**:IllegalArgumentException(含 NumberFormatException)、IllegalStateException、UnsupportedOperationException
- **容器/索引错误**:IndexOutOfBoundsException、ArrayStoreException、NegativeArraySizeException、ClassCastException
- **环境错误**:NullPointerException、SecurityException、TypeNotPresentException

受检异常的代表不在 java.lang 核心族:`IOException`(`java/io/IOException.java:39` 的 `class IOException extends Exception`)、`InterruptedException`(`InterruptedException.java:50`)、`ClassNotFoundException`。最后一个有意思——它继承的不是 Exception,而是 `ReflectiveOperationException`(`ReflectiveOperationException.java:35` 的 `extends Exception`,JDK7 引入的反射受检异常基类): 受检树的中间节点也可以有分支,CNFE 是"按字符串名加载类"(forName/loadClass)失败时的受检信号,与第 2 节的 NoClassDefFoundError 必须区分。

## 2. "哪些异常不能捕获" — Error 家族

### 2.1 家族盘点:23 个类文件

java.lang 下 `Error` 家族共 23 个类文件(Error 基类 + 22 个子类),直接子类只有 4 个:`AssertionError`、`LinkageError`、`ThreadDeath`、`VirtualMachineError`——其余都是后两者的后代:

- **VirtualMachineError 族**(JVM 自身故障):`OutOfMemoryError`、`StackOverflowError`、`InternalError`、`UnknownError`
- **LinkageError 族**(类加载/链接故障):`NoClassDefFoundError`、`ClassFormatError`、`UnsupportedClassVersionError`、`ExceptionInInitializerError` 等
- **特例 `ThreadDeath`**:`Error.java:32-34` 的注释专门说明——它虽然是"正常"情况(线程被主动终止),仍归入 Error,因为"大多数应用不应该尝试捕获它"

### 2.2 catch (Exception) 为什么抓不到 OOM

机制就是 1.1 节那条"断路":异常抛出后,JVM 按异常表逐个匹配 handler(`JVM Spec: §4.7.3`),匹配规则是**类型兼容**——`catch (Exception e)` 匹配 `e instanceof Exception` 的类。`OutOfMemoryError` 的继承链是 Error → Throwable,**从不经过 Exception**,所以类型检查失败,Exception 处理器接不住;而 `catch (Throwable)` 能接住一切——这正是生产代码禁止 catch Throwable 的理由: 连 OOM、StackOverflow 都吞进了你的兜底逻辑,线程/进程状态已经不可信,却还在继续跑。

跨层标注: [内部卷: 21-shared-runtime 03-exception-handling——编译代码抛异常后 handler 查找与栈展开;08-interpreter 03-interpreter-runtime——解释器异常表匹配]

关键设计(斜体):*"catch (Exception) 抓不到 Error"不是魔法,是类型树的直接推论;而"生产禁止 catch Throwable"是这个推论的另一面。面试问"哪些异常不能捕获",标准回答结构: Error 不继承 Exception → catch(Exception) 接不住 → catch(Throwable) 能接住但绝不该用。*

### 2.3 两个经典坑:ExceptionInInitializerError 与 NoClassDefFoundError

- **静态初始化抛异常 → ExceptionInInitializerError**:类的静态初始化器(static 块/静态字段初始化)里抛出的异常,会被 JVM 包装成 `ExceptionInInitializerError` 再抛出(`ExceptionInInitializerError.java:28-30` 的 javadoc:"an exception occurred during evaluation of a static initializer")。你写的 `throw new IOException` 进不了静态块——类加载时它会变成 EIIE。更麻烦的是后续: 初始化失败的类被标记为失败状态(JLS §12.4.2),之后每次**主动触发初始化**(new 一个实例、访问静态成员)都会再抛 NoClassDefFoundError。所以静态块里绝不能有"预期会失败"的操作——一旦失败,这个类就废了
- **类缺失 → NoClassDefFoundError 而非 ClassNotFoundException**:运行时发现类文件找不到(依赖缺失、链接失败),抛的是 NoClassDefFoundError(LinkageError 家族,unchecked);ClassNotFoundException 是**主动按名加载**(forName)时抛的受检异常。一个是被动的"链接期灾难",一个是主动的"查询失败"——面试问"CNFE 和 NCDFE 的区别"答这个

## 3. "Spring 为什么全包 RuntimeException" — 设计哲学之争

### 3.1 受检异常的三个现实问题

受检异常的设计初衷是"编译器强迫调用方处理",但这套机制在大型系统里暴露了三个问题:

1. **强制处理传染(接口签名污染)**:底层方法声明 `throws SQLException`,它上面的每一层要么 catch 要么继续声明——一个技术性异常爬满整条调用链的签名。改一次异常类型,所有中间层跟着改
2. **调用方只能兜底**:绝大多数调用方并没有处理能力,最终只是 `catch (Exception e) { throw new RuntimeException(e); }`——受检变成"多写一行包装"的税
3. **lambda/Stream 无法抛受检异常**:`java.util.function` 的函数式接口(Consumer/Function 等)方法签名没有 throws,受检异常在 lambda 体内**编译不过**——`list.stream().map(x -> { throw new IOException(); })` 直接报错。这是受检异常在函数式时代最硬的伤

### 3.2 JDK 自己的趋势:新 API 全面偏向运行时

JDK 自己也在用行动表态。最典型的是 `Objects.requireNonNull`(`Objects.java:220`):

```java
// Objects.java:220(截取核心,逐字)
public static <T> T requireNonNull(T obj) {
    if (obj == null)
        throw new NullPointerException();
    return obj;
}
```

JDK7 引入它时,完全可以用受检异常表达"参数不能为 null",但选择抛 NPE(unchecked)——因为"参数校验失败"是调用方 bug,不该让全链路的调用者处理。JDK9+ 的 API 设计规范也延续这一取向: 模块系统(java.lang.module)的异常清一色 RuntimeException 家族。

### 3.3 Spring 的选择:一切包装成 NestedRuntimeException

Spring 的设计是这一取向的极端体现: 基础设施异常全部继承 `org.springframework.core.NestedRuntimeException`——包括 `DataAccessException`(数据访问异常基类)。JDBC 的 `SQLException`(受检)在 Spring 的 JdbcTemplate 里被转换成语义化的 DataAccessException(unchecked),转换时**保留原始 cause**。效果: 调用方不再被 SQLException 的 throws 传染,同时根因链完整保留。

关键设计(斜体):*"受检 vs 非受检"是 Java 独有的争议(Lisp/Smalltalk 世界根本没有这个概念)。现代共识在往一边倒: 业务可预期的错误(校验失败、资源不存在)用受检或自定义异常,程序缺陷(空指针、非法参数)用运行时异常;而生产框架几乎一律 RuntimeException + 语义化包装,因为"强制处理"在真实工程里更多制造包装税而不是真处理。面试能说出"lambda 抛不了受检异常"和"接口签名污染"两个具体论据,就比只会背定义的强。*

## 4. 生产异常规范 — 包装、转换与吞异常反模式

### 4.1 反模式三连

线上日志只有一行 `Exception caught`、没有堆栈、没有根因——下面三种写法是罪魁:

```java
// 反模式 1:包装不传 cause——根因链断裂
catch (Exception e) {
    log.error("xxx", e);
    throw new BizException("xxx");          // 丢失 e!新异常没有 cause
}

// 反模式 2:空捕获——异常被彻底吞掉
catch (Exception e) {
    // 什么都不做
}

// 反模式 3:catch 后原样重抛——白抓
catch (Exception e) {
    throw e;                                // 不如不抓
}
```

反模式 1 最阴险:日志里打了堆栈,但抛出的是**没有 cause 的新异常**——上层的 `Caused by` 链在这里断裂,根因在日志里永远找不回来。这正是第 1 篇 cause 链机制在生产里被滥用的反面。

### 4.2 正确姿势

```java
// 正确:包装时带上 cause,根因链不断
catch (IOException e) {
    throw new BizException("文件读取失败: " + e.getMessage(), e);
}
```

`new BizException("msg", e)` 走的就是第 1 篇讲过的 `Throwable(String, Throwable)` 构造(`Throwable.java:291-295`)——`this.cause = e`,链延续。记录日志时必须 `log.error("业务 xxx 失败", e)` 把**异常对象**传进去,而不是 `e.getMessage()`——后者只留下消息文本,堆栈帧全部丢失；异常对象和消息文本承担的诊断信息不同。

关键设计(斜体):*异常链的哲学: 每一层包装都保留 cause,让"顶层看到业务语义(文件读取失败)、底层看到技术根因(FileNotFoundException: /xxx/file.txt)"。这是 Throwable.cause 设计的最终目的——第 1 篇的"只设一次""禁止自指""dejaVu 环形保护"三道约束,全是为了这条链可以被安全地遍历和打印。生产规范的本质不是"不许抛异常",而是"抛出去的时候把上下文留全"。*

## 五个最容易混掉的边界：checked 不是必须恢复，unchecked 不是不用管，Error 不是大号 Exception，包装不是吞掉，catch Throwable 也不是兜底美德

第一，checked 不是“必须恢复成功”。它只表示编译器强迫你显式面对这条失败路径；调用方可以转换、包装或继续上抛，但不能假装它不存在。把 checked 等同于“这里一定能补救”，会把异常设计误解成业务承诺。

第二，unchecked 不是“不用管”。`NullPointerException`、`IllegalArgumentException`、`IllegalStateException` 虽然不要求 `throws`，但它们依然要求代码修复、参数校验或边界隔离；不写在签名里，不等于它们对系统无影响。

第三，Error 不是大号 Exception。它在类型树上就是另一条分支，`catch (Exception)` 接不住它；OOM、StackOverflow、LinkageError 这类失败也不是“再包装一下继续跑”的普通业务异常，而是线程或进程状态已不可信的信号。

第四，包装不是吞掉。把底层异常翻译成业务语义时，关键不是“换一个更好懂的类名”，而是保留原始 cause；一旦只抛新异常不带根因，异常链就断了，日志再完整也无法把技术原因传递给上层。

第五，`catch (Throwable)` 也不是兜底美德。它确实能接住一切，但正因为连 Error 都会被你吞进统一逻辑，后续清理、重试、降级和继续执行业务都可能建立在已经失真的运行时状态上；大多数生产代码真正需要的是边界清晰的 catch，而不是覆盖一切的网。

把这五条边界记稳，异常类型体系就不会再塌缩成“受检/非受检”的二分背诵题。它真正想讲的是：类型树决定谁必须在编译期被显式处理，Error 分支决定哪些失败不属于普通恢复语义，包装规则决定根因能否穿透调用链，而工程框架只是在这些语言边界之上做取舍。

## 核心悬念

异常还有一个所有程序员都踩过的坑:**它不能穿越线程边界**——子线程里 `throw` 的异常,主线程的 try/catch 根本接不住;线程池里 `execute` 的任务抛异常直接打到控制台,`submit` 的任务异常却藏在 Future 里。异常在 JVM 里如何与线程栈绑定、线程池如何隔离任务失败——这是域 11(线程与 ThreadLocal)和域 14(线程池)的战场。下一站先离开异常体系: 数字与数学——`BigDecimal` 为什么不能直接 `==`?

> → 下一篇: 域 02 数字与数学(02-number-math 系列)| 关联: 域 11(线程内异常)、域 14(execute/submit 差异)
