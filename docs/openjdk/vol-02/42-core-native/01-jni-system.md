# 01. JNI 工具层与系统属性 — libjava 的骨架

> **前置依赖**:[41-zip-jimage/02 — JIMAGE 模块镜像](openjdk/vol-02/41-zip-jimage/02-jimage.md):类从镜像读出后,进入 Java 层之前的第一站是 libjava;vol-tools 已演示 java -version 与系统属性
> → **后续**:[02 — 进程管理](02-process.md)(fork/exec/ProcessHandle)
> 关联域: 30-jvm-entry(launcher 与 JVM 接口)、03-arguments-flags(启动参数与属性)、27-jni(JNI 规范的实现)

## 一次 System.getProperties 的旅程

`System.getProperties()` 返回 `os.name=Linux`、`user.home=/root` 等几十个属性——这些值**不是 Java 层拍脑袋的**,而是 JVM 启动时由 C 层从操作系统采集(内核版本、用户目录、locale 编码)再填进 Java 的 Properties 对象。采集和填充都发生在 `libjava`(JDK 自己的原生库): 一边是 JNI 工具函数(异常管道、字符串/字段读写),一边是系统属性管线。这篇拆 libjava 的骨架: JNI 工具层、属性采集链路、以及两个容易被误读的"路径/编码"机制。

## 1. JNI 工具层: 异常管道与编码快速路径

### 异常: 一个入口,一打封装

libjava 的每个 native 方法出错时都要向 Java 层抛异常。底层入口只有一个(`JNU_ThrowByName`,jni_util.c:51-57,逐字):

```cpp
// jni_util.c:51-57(逐字)
JNU_ThrowByName(JNIEnv *env, const char *name, const char *msg)
{
    jclass cls = (*env)->FindClass(env, name);

    if (cls != 0) /* Otherwise an exception has already been thrown */
        (*env)->ThrowNew(env, cls, msg);
}
```

`FindClass` + `ThrowNew`——先按类名找到异常类,再创建并抛出。如果 `FindClass` 失败(类加载都出问题了),说明已有异常在途,不再覆盖。上面这一层是 `JNU_ThrowNullPointerException`(:62-64)、`JNU_ThrowOutOfMemoryError`(:74-76)、`JNU_ThrowNoSuchMethodException`(:110-112)、`JNU_ThrowClassNotFoundException`(:116-118)、`JNU_ThrowIOException`(:128-130)等一打封装——每个只是把类名字符串换成常量,语义上没有魔法,好处是**调用点不用拼类名**、错误集中在一个文件里。

**关键设计 (斜体)**: *异常管道是"薄封装 + 单一入口"——所有 native 方法抛异常都走 JNU_ThrowXxx,行为统一(FindClass 失败不覆盖已有异常);带 errno 的变体还会拼接系统错误信息、用 defaultDetail 兜底(`JNU_ThrowByNameWithLastError`,jni_util.c:164-180)。这层是 JNI 错误处理的约定俗成层,不是 JNI 规范的一部分。*

### 字符串: 按"快速编码"分派

`JNU_NewStringPlatform`(jni_util.c:860-876)把 C 字符串转成 Java String——但**不是**简单的 `NewStringUTF`。它按一个全局变量 `fastEncoding` 分派(截取核心,逐字):

```cpp
// jni_util.c:860-876(截取核心,逐字)
JNIEXPORT jstring JNICALL
JNU_NewStringPlatform(JNIEnv *env, const char *str)
{
    if (fastEncoding == FAST_UTF_8)
        return newStringUTF8(env, str);
    if (fastEncoding == FAST_8859_1)
        return newString8859_1(env, str);
    if (fastEncoding == FAST_646_US)
        return newString646_US(env, str);
    if (fastEncoding == FAST_CP1252)
        return newStringCp1252(env, str);
    if (fastEncoding == NO_ENCODING_YET) {
        JNU_ThrowInternalError(env, "platform encoding not initialized");
        return NULL;
    }
    return newStringJava(env, str);
}
```

- **快速路径**: 当平台编码恰好是 UTF-8/ISO-8859-1/ISO646-US/Cp1252 时,用专门的快速构造器——注意 `newStringUTF8`(jni_util.c:765-780,注释原文 "Optimized for charset UTF-8")其实是"先扫一遍字节、全 ASCII 就按字节直接构造"的优化器,不是严格的 UTF-8 解码;
- **慢路径**: 其他编码走 `newStringJava`(带编码转换);
- **未初始化**: 抛 `InternalError`——这个编码是启动早期由 `InitializeEncoding`(jni_util.c:793-836)按编码名设置的,在那之前调用会直接报错。

**关键设计 (斜体)**: *"平台编码"是 libjava 的全局前提——`InitializeEncoding` 在系统属性管线里用 `sun.jnu.encoding` 一次性设置(jni_util.c:793-836),之后所有 C 字符串 ↔ Java String 的转换都按这个前提分派。UTF-8 是当今主流,快速路径覆盖最常见的场景。*

## 2. 系统属性: C 层采集一次,Java 层填充一次

### 入口: Java_java_lang_System_initProperties

`System.initProperties` 的 native 实现(System.c:166 起)是整条管线的入口: 调 `GetJavaProperties` 拿到 C 结构 → 用 `PUTPROP` 宏逐条把值写进 Java 的 Properties 对象。管道末尾有一段关键代码(System.c:291-294,截取核心,逐字):

```cpp
// System.c:291-294(截取核心,逐字)
    /* !!! DO NOT call PUTPROP_ForPlatformNString before this line !!!
     * !!! The platform native encoding for strings has not been set up yet !!!
     */
    InitializeEncoding(env, sprops->sun_jnu_encoding);
```

注释点明顺序: **平台编码必须先于一切字符串属性就位**——`sun.jnu.encoding` 从 C 结构里取出,交给 `InitializeEncoding` 设置 §1 的 fastEncoding;在此之后,凡是把 C 字符串放进属性的 `PUTPROP_ForPlatformNString` 才能用正确的编码转换。`file.encoding` 在 Linux 上与 `sun.jnu.encoding` 同源(System.c:377/384 都用 `sprops->sun_jnu_encoding`),而 Mac 上 `sun.jnu.encoding` 硬编码为 UTF-8(java_props_md.c:542-546)。

### 采集: 一次性,之后不变

`GetJavaProperties`(java_props_md.c:407 起)是采集器,特点在开头(java_props_md.c:407-414,截取核心,逐字):

```cpp
// java_props_md.c:407-414(截取核心,逐字)
GetJavaProperties(JNIEnv *env)
{
    static java_props_t sprops;
    char *v; /* tmp var */

    if (sprops.user_dir) {
        return &sprops;
    }
```

**`static` 结构 + `user_dir` 缓存判断**——整个函数只完整执行一次,之后任何调用直接返回同一个结构。采集的内容(每个都对应一次系统调用):

- **os 三件套**: `uname()` 的 `sysname`(os.name)/`release`(os.version),os.arch 是编译期常量 `ARCHPROPNAME`(java_props_md.c:480-497);
- **用户**: `getpwuid(getuid())` 的 `pw_name`(user.name)与 `pw_dir`(user.home)(:569-574)——注意 user.home **不是** `getenv("HOME")`,而是 passwd 数据库;当前目录 `user.dir` 用 `getcwd`(:601-606);
- **locale 与编码**: `setlocale(LC_ALL, "")` 后按 `LC_CTYPE` 解析语言/国家/变体,编码用 `nl_langinfo(CODESET)`(java_props_md.c:268-279);
- **其他**: `file.separator`/`path.separator`/`line.separator` 直接赋值(:608-610)。

**关键设计 (斜体)**: *"一次性采集"是系统属性的语义基础——JVM 启动后这些值不再变,即使 OS 环境变了(`uname` 不会变、locale 改了也不重采)。Java 层的 System.setProperty 可以覆盖,但覆盖的是 Java 层的 Properties 副本,C 层的 sprops 纹丝不动。*

## 3. 两个容易误读的机制: NativePath 与 canonicalize

### JVM_NativePath: Unix 上是 no-op

"所有文件路径进入 JVM 前先 JVM_NativePath 标准化"是常见的误读。`JVM_NativePath`(hotspot 侧 jvm.cpp:697-701)转调 `os::native_path`,而 Unix 实现是(jdk11u/src/hotspot/os/posix/os_posix.cpp:1486-1488):

```cpp
// os_posix.cpp:1486-1488(逐字)
char * os::native_path(char *path) {
  return path;
}
```

**原样返回**。路径标准化真正的工作在 Windows(把 `/` 换成 `\`)和 `java.io.File` 自己的规范化里——Unix 上 JVM_NativePath 没有可做的事。

### canonicalize: java.io.File 的路径服务

`java.io.File` 的 `getCanonicalPath` 需要"去掉 ./ 和 ../"的规范化——这是 `canonicalize_md.c` 的职责(unix 版,`canonicalize` 函数在 :190 起): 先直接 `realpath()` 整条解析(:202-204),失败(路径里有不存在的段)就从末尾逐段缩回、对子路径重试(:218-240);`collapsible` 检测可折叠的 `.`/`..` 段(:49 起)。它是 **java.io.File 的按需服务**,不是"所有路径进 JVM 前"的统一预处理。

**关键设计 (斜体)**: *"标准化"在不同层各司其职: JVM_NativePath 是平台路径适配(Unix 无事可做)、canonicalize 是 java.io.File 的语义规范化(靠 `realpath()` 解析符号链接与折叠段)、系统属性里的路径(user.dir/java.home)则保持原样——把三样混为一谈是常见的错误。*

## 核心悬念

libjava 的骨架到齐: JNU_ThrowXxx 把异常管道收敛到一个入口;JNU_NewStringPlatform 按 fastEncoding 分派字符串转换;系统属性管线在启动时一次性采集(uname/getpwuid/getcwd/nl_langinfo)、InitializeEncoding 保证编码先于字符串就位。但 JVM 还要跟操作系统打更多交道: 启动子进程(fork/exec)、查询进程状态、读取环境变量——这些都在下一个文件里,而且它们依赖同一个骨架。下一篇: 进程管理——Runtime.exec 与 ProcessHandle 的 native 侧。

> → [02-process.md](02-process.md)
