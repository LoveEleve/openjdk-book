# 01. 为什么 `System.getProperties()` 背后要有一层 native 骨架？— libjava 的 JNI 工具层与系统属性

> **版本边界**：本文基于 `OpenJDK 11u / Linux / x86_64 / libjava + HotSpot`。这里讨论的是 JDK 原生库 `libjava` 里两类最基础的通用能力：JNI 工具层（异常、字符串、字段/对象辅助）和启动早期系统属性采集链。本文不展开完整 JNI 规范，也不把 HotSpot 运行时实现和 libjava 原生库职责混成一层。
>
> **前置依赖**：[41-zip-jimage/02 — 为什么 JDK 自己不用 ZIP？— `jimage` 模块镜像](../41-zip-jimage/02-jimage.md)
> → **后续**：[02 — 进程管理](02-process.md)

Java 层看起来很普通的一些 API，其实背后都有一层很稳定、很“老派”的 native 骨架撑着。

比如：

- `System.getProperties()` 给你一张带 `os.name`、`os.version`、`user.home`、`file.encoding`、`user.dir` 的属性表；
- 某个 native 方法出错时，会抛出 `IOException`、`NullPointerException` 或 `InternalError`；
- Java 侧拿到的很多平台字符串，本来只是 C 世界里的 `char*`。

如果只盯着 Java API，很容易把这些事情想成“JVM 自己就知道”或者“JNI 方法自己顺手做一下”。但一旦顺着源码往下看，就会发现它们并不是散落在每个 native 文件里的零碎逻辑，而是集中经过一层专门的 JDK 原生工具层：`libjava`。

这就逼出本篇最该回答的问题：**为什么 Java 层一个看起来很普通的 `System.getProperties()`、一个 native 抛异常、一次路径转换，背后需要专门一层 libjava 工具骨架？这些逻辑为什么不直接散落在各个 native 方法里，或者全交给 HotSpot？libjava 到底承担的是“系统调用采集器”、还是“JNI 辅助库”、还是“Java 世界前的一层翻译器”？**

先把答案压成一句话：**libjava 的价值不是“替 JVM 再写一遍 JNI 封装”，而是把‘操作系统世界的原始数据和错误语义’翻译成‘Java 世界能消费的对象、字符串、异常和属性表’。`JNU_ThrowXxx` 把 native 错误统一翻成 Java 异常，`JNU_NewStringPlatform` 把平台字节串按 `sun.jnu.encoding` 翻成 Java `String`，`System.initProperties` 则在启动早期一次性把 OS/用户/locale/路径信息采进 Java Properties。它既不是 HotSpot 的一部分，也不是普通业务 native 方法，而是一层 Java 世界前的共用翻译器。**

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：每个 native 方法自己直接做异常、字符串和属性翻译就够了

这是最自然的第一反应。

native 方法本来就已经拿到了 `JNIEnv*`，那出错时自己 `FindClass + ThrowNew`，需要字符串时自己 `NewStringUTF`，要拿系统属性就各自去调 `uname/getcwd/getpwuid`，看起来也不是做不到。

这个办法的问题，不是“写不出来”，而是**一旦这样做，错误语义、编码策略和平台细节就会碎成一地。**

你很快会遇到这些问题：

- 有的 native 方法出错时直接覆盖掉已有异常，有的不会；
- 有的把 errno 拼进消息，有的只丢默认文案；
- 有的平台字符串按 UTF-8 解释，有的按本地编码，有的直接假设 Latin-1；
- 同一个 `user.home`、`user.dir`、路径规范化逻辑会在不同模块各写一份近似实现。

这对 JDK 原生库来说代价太高。因为 libjava 不是一个小业务库，而是一层被大量原生入口复用的基础设施。只要这些共性翻译逻辑不收敛，久而久之就会出现：行为不一致、平台分支散落、调错异常类型、编码前提各自为政。

所以第一种朴素方案失败，不是因为每个 native 方法没有能力自己做，而是因为**共用的翻译规则必须集中维护，不能碎片化。**

### 朴素方案二：这些事情都应该由 HotSpot 统一负责，不需要 libjava

第二个也很自然的想法是：既然这些翻译逻辑这么基础，那不如干脆放进 HotSpot。毕竟 JVM 是整个系统的底座，系统属性、路径、编码、异常抛出这些事情听起来都够“底层”。

这个想法的问题在于，它把两层本来就应该分开的职责混到了一起。

HotSpot 负责的是：

- 线程、栈、GC、JIT、类加载运行时、同步这些 JVM 内核运转逻辑；
- JVM 导出的少量宿主接口，例如 `JVM_NativePath` 这种平台适配钩子。

libjava 负责的则更偏 JDK 原生库侧：

- 把平台错误翻译成 Java 异常；
- 把本地编码字符串翻成 Java `String`；
- 把启动时的 OS/用户/locale 快照翻进 `Properties`；
- 给大量 JDK native 代码提供统一的 JNI 工具层。

也就是说，HotSpot 更像“让 JVM 本身运转”，libjava 更像“**让 Java 类库和底层 OS 数据顺利接轨**”。

如果把这些事情全塞进 HotSpot，不但会让边界变脏，还会把本该属于 JDK 原生库的翻译责任强行下沉到 VM 内核里。

所以第二种朴素方案失败，不是因为 HotSpot 不能做，而是因为**它不该做这一层“Java 类库前的翻译器”职责。**

这两个失败方案合起来，正好引出本篇主线：**libjava 既不是随便几个 JNI 助手函数，也不是 JVM 内核本体，而是 Java 世界前的一层 native 翻译层。**

## 异常通道：为什么 `JNU_ThrowXxx` 要收敛到单一入口

先看最容易看成“只是小工具”的那一层：异常。

`jni_util.c` 里最底层的抛异常入口其实非常简单：

```cpp
JNU_ThrowByName(JNIEnv *env, const char *name, const char *msg)
{
    jclass cls = (*env)->FindClass(env, name);

    if (cls != 0)
        (*env)->ThrowNew(env, cls, msg);
}
```

`src/java.base/share/native/libjava/jni_util.c:51`

这段代码乍一看甚至朴素得有点平淡：找到类，再抛异常。

但它的重要性恰恰不在“实现复杂”，而在“**从此以后所有 native 错误都能沿同一条管道进 Java 世界**”。

### 为什么要有一堆 `JNU_ThrowXxx` 薄封装

在这个入口之上，libjava 再铺了一整层薄封装：

- `JNU_ThrowNullPointerException`
- `JNU_ThrowOutOfMemoryError`
- `JNU_ThrowNoSuchMethodException`
- `JNU_ThrowClassNotFoundException`
- `JNU_ThrowIOException`
- 等等。`src/java.base/share/native/libjava/jni_util.c:61`

这些函数几乎都只是换一下类名字符串，本身没有什么“高级逻辑”。但它们的价值非常实际：

- 调用点不需要自己拼类名；
- 常见异常类型集中在一个文件里；
- 抛异常的基本行为能保持一致。

这种设计最像一层“语言互通的固定短语表”：native 侧不必每次自己组织完整句子，而是统一走一份共享词典。

### `JNU_ThrowByNameWithLastError`：错误码翻译也要统一

更能体现“翻译层”味道的是 `JNU_ThrowByNameWithLastError()`。它会：

- 先通过 `getLastErrorString` 拿本地错误描述；
- 再用 `JNU_NewStringPlatform` 把这段平台字节串翻成 Java `String`；
- 然后构造异常对象并抛出；
- 如果这些步骤中途失败，最后再退回 `JNU_ThrowByName` 用默认 detail string 兜底。`src/java.base/share/native/libjava/jni_util.c:162`

这就很能说明 libjava 的角色：它不是只做“异常类名路由”，而是顺带把**native 错误信息的呈现方式**也统一成 Java 世界能理解的形式。

所以这一层最该记住的一句话是：**异常管道的核心价值不在复杂逻辑，而在统一翻译。**

## 字符串与编码：为什么 `char*` 进 Java 前必须先过 `InitializeEncoding`

如果说异常翻译解决的是“错误怎么进 Java 世界”，那字符串翻译解决的就是“平台字节串怎么进 Java 世界”。

而这恰好是 JNI 新手最容易想简单的地方。

### 为什么 `JNU_NewStringPlatform` 不是简单的 `NewStringUTF`

`JNU_NewStringPlatform()` 并没有直接无脑调用 `NewStringUTF`。它会先看一个全局的 `fastEncoding`，然后按不同编码走不同路径：

- `FAST_UTF_8`
- `FAST_8859_1`
- `FAST_646_US`
- `FAST_CP1252`
- 否则走通用 `newStringJava`；
- 如果编码还没初始化，直接抛 `InternalError`。`src/java.base/share/native/libjava/jni_util.c:860`

这说明 libjava 从一开始就不接受“所有平台字节串都当 Modified UTF-8 进 Java”的偷懒方案，而是明确承认：**平台字符串的语义取决于平台编码前提。**

### `newStringUTF8` 甚至不是“完整 UTF-8 解码器”

这件事更有意思的一点是，`newStringUTF8()` 自己的注释虽然写着 “Optimized for charset UTF-8”，但它内部先做的其实是一件很务实的优化：扫一遍字节，只要全部都是 ASCII，就直接走 8859-1 sized string 的快路径；否则才退回通用 Java 构造路径。`src/java.base/share/native/libjava/jni_util.c:765`

这很值得专门提醒读者，因为它能打掉一个很常见的错觉：**libjava 这里关心的不是“实现一个教科书 UTF-8 解码器”，而是“在既定平台编码前提下，把最常见的输入尽量便宜地翻成 Java String”。**

所以它是“编码前提 + 快路径分派”的工程实现，不是某种通用字符库。

### `InitializeEncoding`：平台编码必须先于字符串翻译就位

真正的关键在 `InitializeEncoding()`。它会根据编码名一次性设置：

- `fastEncoding` 应该走哪条快路径；
- `jnuEncoding` 是否要保留为全局引用；
- 以及后续 `String.getBytes` / `<init>([B, String)` 等 method/field ID 缓存。`src/java.base/share/native/libjava/jni_util.c:787`

这说明平台编码不是“每个调用点自己临时判断”的事，而是 libjava 的一个全局前提。一旦它设置好了，后面所有 `JNU_NewStringPlatform` / `GetStringPlatformChars` 这类转换都可以沿同一前提分派。

所以这一层最该记住的一句话是：**平台字节串进 Java 前，不是先选 JNI API，而是先确认平台编码前提。**

## 系统属性：为什么是“一次性采集 + 一次性填充”

异常和字符串这两层铺好之后，就能回到本篇一开始的主角：`System.getProperties()`。

这里最容易被想简单的地方在于：看到几十个属性名，很自然就会把它理解成“一次次 `put()` 的枚举”。

这当然没错，但真正的结构更值得看的是：**属性采集只做一次，填充 Java 层只做一次，之后两边各走各的。**

### `System.initProperties`：C 结构先准备好，再填 Java `Properties`

`Java_java_lang_System_initProperties()` 是整条管线的入口。它先调用 `GetJavaProperties(env)` 拿到一份 `java_props_t*`，然后再用 `PUTPROP` 一类宏把这些 C 侧字段逐条塞进 Java 的 `Properties` 对象。`src/java.base/share/native/libjava/System.c:166`

这里的主线不是“有哪些属性”，而是：**Java 层并不是边请求边现场去调 `uname/getcwd/getpwuid`，而是先拿一份 native 世界的快照结构，再统一翻译进 Java 容器。**

### `InitializeEncoding` 为什么卡在中间那个位置

`System.c` 里有一段非常关键的注释：

```cpp
/* !!! DO NOT call PUTPROP_ForPlatformNString before this line !!!
 * !!! The platform native encoding for strings has not been set up yet !!!
 */
InitializeEncoding(env, sprops->sun_jnu_encoding);
```

`src/java.base/share/native/libjava/System.c:291`

这段顺序约束几乎是整篇的缩影。

它说明：系统属性管线不是“随便把 C 字符串丢进 Properties”，而是必须先确保平台编码翻译器已经就位，然后那些需要按平台编码解释的 native 字符串属性才有资格进 Java 世界。

也就是说，**属性填充本身依赖前面那条字符串翻译通道。**

这让 `jni_util.c` 和 `System.c` 这两块不再是并列主题，而是同一条翻译链的上下游。

### `GetJavaProperties`：为什么用 `static java_props_t sprops`

`GetJavaProperties()` 开头最重要的一句其实很简单：

```cpp
static java_props_t sprops;
if (sprops.user_dir) {
    return &sprops;
}
```

`src/java.base/unix/native/libjava/java_props_md.c:407`

这说明整套采集逻辑默认只完整执行一次。之后再有人来问，直接把同一个 `sprops` 指针还回去。

这个设计意味非常明确：**系统属性在这里被当成启动期快照，而不是持续追踪的动态视图。**

所以你后面就会看到它一次性调用：

- `uname()` 拿 `os.name` / `os.version`；
- `ARCHPROPNAME` 定 `os.arch`；
- `setlocale` + `ParseLocale` + `nl_langinfo(CODESET)` 推导语言和编码；
- `getpwuid(getuid())` 拿 `user.name` / `user.home`；
- `getcwd()` 拿 `user.dir`。`src/java.base/unix/native/libjava/java_props_md.c:474`、`src/java.base/unix/native/libjava/java_props_md.c:518`、`src/java.base/unix/native/libjava/java_props_md.c:567`、`src/java.base/unix/native/libjava/java_props_md.c:594`

它关心的是“启动时当前系统怎么看这台进程”，而不是“之后操作系统环境是不是还会变”。

### `user.home` 为什么不是 `HOME`

这一点特别值得拿出来讲，因为它很能体现“native 快照”并不等于“拿环境变量随便拼一拼”。

Linux/Unix 路径下，`user.home` 取的是 `getpwuid(getuid())` 返回的 `pw_dir`，而不是 `getenv("HOME")`。`src/java.base/unix/native/libjava/java_props_md.c:567`

这说明 libjava 在这里更信任系统账户数据库，而不是用户进程环境变量。它追求的是“这个 uid 在系统里登记的 home”，而不是“当前 shell 恰好给你导出了什么”。

同样，`user.dir` 来自 `getcwd()`，也不是 Java 自己推导出来的逻辑路径。`src/java.base/unix/native/libjava/java_props_md.c:594`

所以系统属性这条线的真正价值不是“把一堆字符串塞进表里”，而是**把 OS 世界的启动期身份信息整理成 Java 世界的一份基础快照。**

## 路径：为什么 `JVM_NativePath` 与 `canonicalize` 不是同一件事

讲完属性，再看一个特别容易被混淆的主题：路径。

很多人第一次看到 JVM 和文件系统打交道，会下意识把所有“路径处理”都想成同一类动作：是不是所有路径进入 JVM 前都会被统一标准化？

源码告诉我们，完全不是。

### `JVM_NativePath`：在 Unix/posix 上几乎没事可做

HotSpot 侧的 `JVM_NativePath` 最终会走到 `os::native_path()`。而 posix/Unix 实现非常直接：

```cpp
char * os::native_path(char *path) {
  return path;
}
```

`src/hotspot/os/posix/os_posix.cpp:1486`

也就是说，在 Unix 上它就是原样返回。

这非常重要，因为它直接打掉一个常见误解：**JVM_NativePath 不是“所有路径统一规范化器”。** 在 Unix 世界里，路径分隔符和本地表示本来就已经是 JVM 所要的样子，HotSpot 这里没有额外工作可做。

### `canonicalize`：这是 `java.io.File` 语义服务，不是 JVM 全局前置步骤

真正负责“去掉 `.` / `..`、解析符号链接、尽量求 canonical path”的，是 `canonicalize_md.c`。

它的流程是：

- 先直接 `realpath(original, resolved)` 试整条路径；
- 如果失败，就从末尾一段段缩回，尝试对子路径做 `realpath()`；
- 再把尚未解析成功的尾部追加回去。`src/java.base/unix/native/libjava/canonicalize_md.c:190`

这是一项**Java 文件语义服务**：是 `java.io.File` 需要 canonical path 时按需做的工作，不是“所有 native 路径在进入 JVM 前统一经过的预处理”。

### 三层边界为什么一定要拆开

到这里，其实已经能把路径相关动作拆成三层了：

- `JVM_NativePath`：平台路径表示适配；在 Unix 上基本是 no-op；
- `canonicalize`：`java.io.File` 语义上的规范化与 `realpath()` 服务；
- 系统属性里的 `user.dir` / `java.home` 等：启动期采到什么就是什么，并不会天然经过同一套 canonicalization 管道。

如果不把这三层拆开，很容易写出一种看似顺口、实际上完全错误的说法：所有路径进入 JVM 前都会被统一标准化。源码清楚表明，这并不是 OpenJDK 11u 在 Unix 上的实际结构。

## 到这里为止，主线其实只发生了四件事

如果前面信息比较多，这里先把整件事压回四步：

1. libjava 用 `JNU_ThrowXxx` 把 native 错误统一翻进 Java 异常世界；
2. 它用 `InitializeEncoding + JNU_NewStringPlatform` 把平台字节串统一翻进 Java `String` 世界；
3. 它用 `GetJavaProperties + System.initProperties` 把启动期 OS 快照统一翻进 Java `Properties` 世界；
4. 它再把平台路径适配、canonical path 语义和属性值采集这些不同层次的路径逻辑分开处理。

只要这四步还在脑子里，`libjava` 就不会再像“几个 JNI 助手函数 + 一堆属性采样代码”的松散拼接。

## 常见误解澄清

### 误解一：`JNU_ThrowXxx` 属于 JNI 规范本体

不是。

JNI 规范给你的是 `JNIEnv*` 上那套基础调用；`JNU_ThrowXxx` 是 JDK/libjava 自己加在其上的约定俗成工具层，用来统一 native 错误翻译。

### 误解二：`newStringUTF8` 就是通用 UTF-8 解码器

不对。

它是基于平台编码初始化前提的一条优化路径，内部先做 ASCII 快速判断，非纯 ASCII 再退回通用 Java 构造路径。它不是某个独立字符库。`src/java.base/share/native/libjava/jni_util.c:765`

### 误解三：`user.home` 来自 `HOME` 环境变量

不是。

Unix 路径下它来自 `getpwuid(getuid())` 的 `pw_dir`，优先级高于用户环境变量想给你什么。`src/java.base/unix/native/libjava/java_props_md.c:567`

### 误解四：`JVM_NativePath` 在 Unix 上也负责路径规范化

不对。

在 posix 实现里它就是原样返回。真正做 canonical path 语义的是 `canonicalize_md.c` 那套 `realpath()` 逻辑。`src/hotspot/os/posix/os_posix.cpp:1486`、`src/java.base/unix/native/libjava/canonicalize_md.c:202`

### 误解五：`System.setProperty` 会改动 C 层 `sprops`

不会。

`GetJavaProperties()` 的 `static java_props_t sprops` 是启动期采集快照；Java 层后续改的是自己的 `Properties` 对象，不会回写这份 native 结构。`src/java.base/unix/native/libjava/java_props_md.c:407`

## 收网：libjava 的本质，是 Java 世界前的一层 native 翻译器

现在再回头看开头那个问题，答案已经能收成一张总图了。

```text
OS / C 侧原始世界
  ├─ errno / last error string
  ├─ char* 路径 / 编码串
  ├─ uname / getpwuid / getcwd / locale
  └─ 平台路径差异 / realpath 结果

libjava 工具层
  ├─ JNU_ThrowXxx           -> Java 异常
  ├─ JNU_NewStringPlatform  -> Java String
  ├─ InitializeEncoding     -> fastEncoding / jnuEncoding
  └─ GetJavaProperties      -> java_props_t 快照

Java 世界
  ├─ System.initProperties(Properties)
  ├─ java.io.File canonical path
  └─ 其他 native 方法复用同一套 JNU 辅助能力
```

把它再压成三句话：

- libjava 不负责让 JVM 核心跑起来，它负责把底层平台语义翻成 Java 类库能消费的异常、字符串和属性。
- `JNU_ThrowXxx`、`JNU_NewStringPlatform`、`GetJavaProperties` 看似分散，其实都是这层翻译器的不同出口。
- 路径、编码、系统属性这些东西之所以容易讲乱，恰恰是因为它们跨越了 OS 世界、libjava 翻译层和 Java 对象层三个不同边界。

所以 `System.getProperties()` 背后真正值得记住的，不是“用了哪些系统调用”。

真正该记住的是：**Java 世界并不是直接面对操作系统原始数据，而是先经过 libjava 这一层有统一约定的 native 翻译器。** 这层翻译器把错误、路径、编码、用户环境都整理成 Java 类库可以稳定消费的形状，后面的原生库和 Java API 才能站在同一套地板上工作。

下一篇就顺着这条地板继续走。异常、字符串、属性这些都是“进入 Java 世界前的翻译”；而进程管理则是相反方向：Java 世界要主动向 OS 发起 `fork/exec`、查询子进程状态、拿环境变量。这时同一层工具骨架会再次出场，只是流向反过来了。

> → [02-process.md](02-process.md)
