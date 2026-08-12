# 03. ClassLoader + I/O + TimeZone — libjava 的剩下三件事

> **前置依赖**:[42-core-native/02 — 进程管理](openjdk/vol-02/42-core-native/02-process.md):libjava 的进程面拆完后,剩下 defineClass/dlopen、文件描述符、时区三条线;01 篇的 JNI 异常管道与编码分派全程在场
> → **后续**:[43-nio-net/01 — TCP Socket](openjdk/vol-02/43-nio-net/01-tcp-epoll.md)(网络与 Buffer 的 native 侧)
> 关联域: 07-classfile-classloader(defineClass 的另一半在 VM 里)、27-jni(JNI 规范)、01-os(系统调用)

## libjava 的剩余三件事

libjava 的骨架(异常管道/属性)和进程面(exec/ProcessHandle)拆完后,还有三件日常高频的事: **类的字节怎么进 JVM**、**native 库怎么被 dlopen**、**文件描述符与时区从哪来**。`ClassLoader.defineClass` 每次定义用户类都走一遍,C 代码里的每个 `GET_FD` 都在读 FileDescriptor 的 int 字段,而 `TimeZone.getDefault()` 的第一次调用要把 /etc 翻个底朝天。这一篇把它们串起来。

## 1. ClassLoader: 类的字节进 JVM,native 库进进程

### defineClass1: 拷字节、验名字、交 VM

`ClassLoader.defineClass1`(ClassLoader.c:75-148)是 `ClassLoader.defineClass(byte[], ...)` 的 native 侧。步骤不复杂,但每个都有讲究: 先把 byte[] 拷进 C 堆(malloc + `GetByteArrayRegion`,ClassLoader.c:106,:113),类名用 `getUTF`(:118-123)转成 UTF-8 并过 `VerifyFixClassname`(:123,libverify 的 check_format.c:256——把 `.` 翻译成 `/`,进入 JVM 内部形式 `java/lang/String`),最后调 VM(ClassLoader.c:136,截取核心,逐字):

```cpp
// ClassLoader.c:136-137(截取核心,逐字)
    result = JVM_DefineClassWithSource(env, utfName, loader, body, length, pd, utfSource);
```

注意函数名是 **`JVM_DefineClassWithSource`** 不是 `JVM_DefineClass`——多了 `source` 参数(类的来源描述,如 `file:/path/App.class`),`utfSource` 也是 string 传进来的(ClassLoader.c:128-135)。真正的类定义(字节码解析、验证、常量池构建)在 **VM 侧**——这是 07-classfile-classloader 域的领土,libjava 只做"搬运 + 名字整理"。`defineClass2`(ClassLoader.c:150-212)是 ByteBuffer 版本: 不拷贝,直接 `GetDirectBufferAddress` 拿地址(:173),字节就在 JVM 堆外。

### load0: dlopen 在 VM 里,JDK 只负责牵线

常见资料里的 "JVM_LoadLibrary(cname) → dlopen" 省略了一个关键事实: **JVM_LoadLibrary 是 JVM 接口,实现在 hotspot,不在 libjava**。libjava 的 `Java_java_lang_ClassLoader_00024NativeLibrary_load0`(ClassLoader.c:337-406)是加载的**组织者**,真正的 dlopen 在 VM 里(JVM_LoadLibrary,jvm.cpp:3448 → os::dll_load → os::Linux::dlopen_helper,os_linux.cpp:2106-2125,逐字):

```cpp
// os_linux.cpp:2106-2125(截取核心,逐字)
void * os::Linux::dlopen_helper(const char *filename, char *ebuf,
                                int ebuflen) {
  void * result = ::dlopen(filename, RTLD_LAZY);
  if (result == NULL) {
    const char* error_report = ::dlerror();
    if (error_report == NULL) {
      error_report = "dlerror returned no error description";
    }
    if (ebuf != NULL && ebuflen > 0) {
      ::strncpy(ebuf, error_report, ebuflen-1);
      ebuf[ebuflen-1]='\0';
    }
    ...
  }
  return result;
}
```

标志只有 **`RTLD_LAZY`**——常见资料里的 "RTLD_LAZY|RTLD_GLOBAL" 组合在 jdk11u 里并不存在,这里就是单独一个 RTLD_LAZY。失败时 `dlerror()` 的错误文本通过 ebuf 一路带回,变成 `UnsatisfiedLinkError: <库名>: <dlerror 原文>`(jvm.cpp:3461-3468)。

**关键设计 (斜体)**: *"native 库加载"被切成两层: VM 持有 dlopen 的句柄和错误文本(ebuf 通道),JDK 侧持有加载流程(找 JNI_OnLoad、校验版本、回填 Java 字段)。dlopen 本身还牵扯 VM 的栈保护: 若库带 execstack(或没声明 noexecstack),dlopen 会把栈变成可执行、栈保护页的读保护随之丢失——修复(逐线程重设 guard_memory)必须在 safepoint 里由 VMThread 执行(os_linux.cpp:1883-1927,dll_load_in_vmthread :2126-2152)——这是只有 VM 才能做的活。*

### JNI_OnLoad: 三件套(找、调、验)

load0 拿到句柄后的流程(ClassLoader.c:354-390,截取核心,逐字):

```cpp
// ClassLoader.c:354-366(截取核心,逐字)
    handle = isBuiltin ? procHandle : JVM_LoadLibrary(cname, throwExceptionIfFail);
    if (handle) {
        JNI_OnLoad_t JNI_OnLoad;
        JNI_OnLoad = (JNI_OnLoad_t)findJniFunction(env, handle,
                                                   isBuiltin ? cname : NULL,
                                                   JNI_TRUE);
        if (JNI_OnLoad) {
            JavaVM *jvm;
            (*env)->GetJavaVM(env, &jvm);
            jniVersion = (*JNI_OnLoad)(jvm, NULL);
        } else {
            jniVersion = 0x00010001;
        }
```

- **找**: `findJniFunction`(ClassLoader.c:290-330)找库的初始化入口——普通库只找 `JNI_OnLoad`;JDK **内建库**(isBuiltin,如 libjava 自己)才支持 `JNI_OnLoad_<库名>` 变体(load0 把 cname 只传给 builtin 路径,ClassLoader.c:357-359;`buildJniFunctionName` 把符号拼成 `JNI_OnLoad_<库名>`,jni_util_md.c:53-59;基础符号表是 jvm_md.h:40 的 `JNI_ONLOAD_SYMBOLS`),对应 unload 侧是 `JNI_OnUnload`;
- **调**: `(*JNI_OnLoad)(jvm, NULL)`——传入 `JavaVM*` 指针,库可以用它拿 JNIEnv、缓存 jclass;
- **没有入口**: 版本按 1.1 处理(jniVersion = 0x00010001,:365);
- **验**: `JVM_IsSupportedJNIVersion(jniVersion)` 校验(ClassLoader.c:378-389),不支持就 `UnsatisfiedLinkError: unsupported JNI version 0x%08X required by <库>` 并 `JVM_UnloadLibrary` 回滚——**版本号是库与 VM 之间的握手协议**;
- 句柄以 `jlong` 存回 `NativeLibrary.handle` 字段(:400),`jniVersion` 存回(:390)——javadoc 说明其用途(ClassLoader.java:2406-2412): "set by the VM when it loads the library, and used by the VM to pass the correct version of JNI to the native methods"。

native 方法本身**不在加载时绑定**。JNI 的机制是**首次调用时按需动态链接**: 方法符号 `Java_<类全名>_<方法名>` 在第一次调用时才用 dlsym 查找(RegisterNatives 是主动注册的例外)。[实证] 里能看到两种形态(materials/commands/42-classio-jnionload.txt):

```
[libdemo] JNI_OnLoad called, returning 0x00010008        ← 我们自己的库,加载即调用
[java] loadLibrary done
[0.024s][debug][jni,resolve] [Dynamic-linking native method Hello.nativeGreet ... JNI]  ← 首次调用时才链接
```

**关键设计 (斜体)**: *"加载时只找 JNI_OnLoad、方法符号按需 dlsym"是 JNI 的性能约定: 一个库几百个方法,真正调用的往往只有几个;把查找推迟到首次调用,库加载永远只需 O(1) 次符号查找。RegisterNatives 则用于"函数名不合规"或"C 侧改名"的库(ClassLoader.c:41-50 的 retrieveDirectives 就是 JDK 自己 RegisterNatives 的例子)。*

## 2. FileDescriptor: 一个 int,一套宏

### GET_FD/SET_FD: 宏,不是函数

`java.io.FileDescriptor` 是包装 fd 的 Java 对象,fd 本体是 **int 字段**(`"fd" "I"`,FileDescriptor_md.c:51-57 初始化字段 ID)。读写的 C 代码长这样(io_util_md.h:53-59,逐字):

```cpp
// io_util_md.h:53-59(逐字)
#define SET_FD(this, fd, fid) \
    if ((*env)->GetObjectField(env, (this), (fid)) != NULL) \
        (*env)->SetIntField(env, (*env)->GetObjectField(env, (this), (fid)),IO_fd_fdID, (fd))

#define GET_FD(this, fid) \
    (*env)->GetObjectField(env, (this), (fid)) == NULL ? \
        -1 : (*env)->GetIntField(env, (*env)->GetObjectField(env, (this), (fid)), IO_fd_fdID)
```

- **是宏不是函数**: 平台相关的宏(Windows 版读的是 `handle` 指针,不是 int),`IO_fd_fdID` 是全局 jfieldID,由 `FileDescriptor.initIDs` 一次性缓存(FileDescriptor_md.c:51-57),此后所有 I/O 操作免去重复 `GetFieldID`;
- **空对象保护**: `GetObjectField` 为 null 时 GET_FD 返回 -1、SET_FD 静默跳过(io_util_md.h:49-51 注释),避免空指针;
- 读写的实现分两层: `readSingle`/`readBytes`(io_util.c:38-123)负责 JNI 数组搬运(栈上 8KB `BUF_SIZE` 缓冲,超长才 malloc,:58,:92-102),真正的系统调用是 `handleRead`/`handleWrite`(io_util_md.c:166-180)——`IO_Read`/`IO_Write` 只是别名宏(io_util_md.h:70-71),**EINTR 重试在 handleRead/handleWrite 内部**(`RESTARTABLE(read(...))`,io_util_md.c:170): 信号打断的 read/write 自动重试,对 Java 层完全透明。

### 打开与关闭: 两个容易被忽视的细节

`fileOpen`(io_util_md.c:95-122)负责打开: 路径先过平台编码转换(`WITH_PLATFORM_STRING`),Linux 上还**先剥掉尾部的 `/`**(:101-106,注释原文 "Remove trailing slashes, since the kernel won't"),`handleOpen`(:73-93)打开后用 fstat 验证,若是目录直接 `close` + `EISDIR`(:82-86)。关闭侧 `fileDescriptorClose`(io_util_md.c:125-164)有两个关键设计(:137-163,截取核心,逐字):

```cpp
// io_util_md.c:137-163(截取核心,逐字)
    /* Set the fd to -1 before closing it so that the timing window
     * of other threads using the wrong fd (closed but recycled fd,
     * that gets re-opened with some other filename) is reduced.
     * Practically the chance of its occurance is low, however, we are
     * taking extra precaution over here.
     */
    (*env)->SetIntField(env, this, IO_fd_fdID, -1);
    ...
    if (fd >= STDIN_FILENO && fd <= STDERR_FILENO) {
        int devnull = open("/dev/null", O_WRONLY);
        ...
            dup2(devnull, fd);
            close(devnull);
    } else if (close(fd) == -1) {
        JNU_ThrowIOExceptionWithLastError(env, "close failed");
    }
```

- **先置 -1 再关**: 缩短"别的线程拿旧 fd 去用"的竞态窗口(注释原文)——文件关了 fd 就被内核回收,再被别的 open 复用,旧引用就可能写进错误文件;
- **0/1/2 不关闭**: 关掉标准流再打开文件/套接字时,内核会把新 fd 分配成 0/1/2——stdout 悄悄被劫持。所以对 0/1/2 的 close 是**重定向到 /dev/null** 而不是真关(:147-160 注释与代码)。

**关键设计 (斜体)**: *fd 是进程内唯一的"凭证",JDK 在两端都做了防御: 打开侧用 fstat 拒绝目录(EISDIR)、关闭侧先置 -1 再关并把 0/1/2 重定向到 /dev/null——防的不是"正常路径",而是"竞态窗口"和"fd 复用的串号"。ObjectStreamClass 的 native 更简单,只有两个函数(ObjectStreamClass.c:40-97): 缓存 `NoSuchMethodError` 的全局引用与 `hasStaticInitializer`——序列化的其余工作全在 Java 层。*

## 3. TimeZone: 从 /etc 到 "Asia/Shanghai"

### 入口: findJavaTZ_md,三路优先

`TimeZone.getDefault()` 的第一次调用(TimeZone.java:644-697)先查 `user.timezone` 系统属性,没有才调 native `getSystemTimeZoneID`(Java 侧方法名,TimeZone.java:671)→ C 侧 `Java_java_util_TimeZone_getSystemTimeZoneID`(TimeZone.c:40-58)→ 平台函数 `findJavaTZ_md`(TimeZone_md.c:793-850,截取核心,逐字):

```cpp
// TimeZone_md.c:800-817(截取核心,逐字)
    tz = getenv("TZ");

    if (tz == NULL || *tz == '\0') {
        tz = getPlatformTimeZoneID();
        freetz = tz;
    }

    if (tz != NULL) {
        /* Ignore preceding ':' */
        if (*tz == ':') {
            tz++;
        }
#if defined(__linux__)
        /* Ignore "posix/" prefix on Linux. */
        if (strncmp(tz, "posix/", 6) == 0) {
            tz += 6;
        }
#endif
```

优先级是 **TZ 环境变量 → getPlatformTimeZoneID(读 /etc)→ GMT 兜底**: 显式 TZ 最高(容器里 `-Duser.timezone` 与 TZ 都能覆盖),文件读取只在 TZ 缺席时发生。返回前还有两个"洗白": 忽略前导 `:`(POSIX 允许 `TZ=:Asia/Shanghai`)、忽略 Linux 的 `posix/` 前缀。

### getPlatformTimeZoneID: Debian 一行,其余全目录比对

Linux 版的 `getPlatformTimeZoneID`(TimeZone_md.c:251-354)分两步:

1. **Debian 的 /etc/timezone**: `fopen` + `fgets` 读第一行(TimeZone_md.c:269-285,去 `\n`、非空才用)。注释自嘲"没有格式规范,只能假设一行 Olson tzid 加换行"(:264-267);
2. **/etc/localtime 三态**(:288-353,截取核心,逐字):

```cpp
// TimeZone_md.c:291-318(截取核心,逐字)
    RESTARTABLE(lstat(DEFAULT_ZONEINFO_FILE, &statbuf), res);
    if (res == -1) {
        return NULL;
    }
    ...
    if (S_ISLNK(statbuf.st_mode)) {
        char linkbuf[PATH_MAX+1];
        int len;

        if ((len = readlink(DEFAULT_ZONEINFO_FILE, linkbuf, sizeof(linkbuf)-1)) == -1) {
            ...
            return NULL;
        }
        linkbuf[len] = '\0';
        tz = getZoneName(linkbuf);
        if (tz != NULL) {
            tz = strdup(tz);
            return tz;
        }
    }
```

- **符号链接**(Red Hat 系): readlink 后从路径里抠出 `zoneinfo/` 之后的部分(`getZoneName`,TimeZone_md.c:88-98);
- **普通文件**(1999 年后的 timeconfig 直接拷文件,注释 :296-302): 只能**读整个文件内容,然后在 /usr/share/zoneinfo 里递归找一模一样的文件**——`findZoneinfoFile`(:123-195)跳过隐藏文件和 `ROC`/`posixrules`/`localtime`(:154-176),`isFileIdentical`(:203-243)先比文件大小再 `memcmp` 字节;扫描前先试 `UTC`/`GMT` 两个热门项(:132-147,"fast path for 1st iteration");
- **两态都失败**: 返回 NULL → Java 侧退到 `GMT`。

[实证](materials/commands/42-classio-tz.txt)恰好演示了这条链: 容器是 TencentOS,`/etc/timezone` 不存在、`/etc/localtime -> /usr/share/zoneinfo/Asia/Shanghai`(符号链接路径),于是 JDK 走 readlink 分支,`ZoneId.systemDefault()` 与 `user.timezone` 都是 Asia/Shanghai;而素材里 jcmd 的 `user.timezone=Asia/Shanghai`(materials/commands/jcmd-VM.system_properties.txt:9)则是 Java 侧缓存下来的结果。

### 最后的兜底: getGMTOffsetID

文件全失败还有最后一招: `getGMTOffsetID`(TimeZone_md.c:855-901)用 `localtime_r` + `gmtime_r` 比较本地时间与 UTC(:873-880,小时分钟都相同就是 GMT),再 `strftime("%z")` 拿到 ±hhmm 格式化(:893-898,逐字):

```cpp
// TimeZone_md.c:893-898(截取核心,逐字)
    if (strftime(offset, 6, "%z", &localtm) != 5) {
        return strdup("GMT");
    }

    sprintf(buf, (const char *)"GMT%c%c%c:%c%c", offset[0], offset[1], offset[2],
        offset[3], offset[4]);
```

产出 "GMT+08:00" 这样的 ID——Java 侧 `TimeZone.getTimeZone(zoneID, false)` 认不出文件系统里的 ID 时(TimeZone.java:678-686)就用它建自定义时区。

**关键设计 (斜体)**: *时区探测是"越省力越靠后"的阶梯: 环境变量(零成本)→ 现成 ID(一行文本)→ 符号链接名(一次 readlink)→ 内容比对(读文件+全目录扫描,最贵)→ GMT 偏移(纯计算)。绝大多数系统在前两步就命中,全目录比对是为"拷贝型 localtime"准备的保险丝。*

## 核心悬念

libjava 的三件事到齐: defineClass1 把字节交给 VM(DefineClassWithSource)、load0 牵线 dlopen 与 JNI_OnLoad(方法符号按需动态链接)、FileDescriptor 的 fd 用 GET_FD/SET_FD 宏读写(先置 -1 再关、0/1/2 重定向 /dev/null)、时区从 TZ 一路退到 GMT 偏移。这三条线都用到了 01 篇的异常管道与编码分派——libjava 到这就是一个完整的"Java 与操作系统的翻译层"。但 I/O 的故事还没完: 阻塞式 read/write 是这里唯一的形态,而真正高吞吐的路径是 NIO 的 Selector、通道与堆外 Buffer——那是域 43 的领土。

> → [43-nio-net/01 — TCP Socket](openjdk/vol-02/43-nio-net/01-tcp-epoll.md)(NIO 与 Net)
