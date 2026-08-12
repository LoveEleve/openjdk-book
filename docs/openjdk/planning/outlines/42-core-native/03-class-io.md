# 03. ClassLoader + I/O + TimeZone — 剩馀核心机制

> 🟡 Working | NativeLibrary dlopen + FileDescriptor fd + /etc/timezone
> 读者处境: `ClassLoader.loadLibrary("net")`→JNI→dlopen→dlsym→native method registration。`new FileDescriptor()`→open syscall→fd stored as `int` in Java field。`ZoneId.systemDefault()`→/etc/timezone→"Asia/Shanghai"。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/42-core-native/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 228 行,**42 域完结=第 2 批收官**):
> - **"JVM_LoadLibrary(cname) (line 354) → dlopen" 错**: ClassLoader.c:354 是 `Java_java_lang_ClassLoader_00024NativeLibrary_load0`(:337-406)里的**调用点**;dlopen 在 **hotspot 侧**(jvm.cpp:3448 JVM_LoadLibrary → os::dll_load os_linux.cpp:1872 → dlopen_helper :2106-2125,`::dlopen(filename, RTLD_LAZY)` :2108)
> - **"RTLD_LAZY|RTLD_GLOBAL" 编造**: 实际只有 **RTLD_LAZY**(os_linux.cpp:2108)
> - **"dlsym(handle,'Java_com_xxx') 批量绑定" 编造**: native 方法**首次调用时按需动态链接**(实证: jni+resolve 日志 "Dynamic-linking native method Hello.nativeGreet",materials/commands/42-classio-jnionload.txt);RegisterNatives 才是主动注册(ClassLoader.c:41-50 的 retrieveDirectives 例子)
> - **defineClass1 调 JVM_DefineClass 错**: 实际 `JVM_DefineClassWithSource`(ClassLoader.c:136,带 source 参数);defineClass1 :75-148(malloc+GetByteArrayRegion :106/:113+getUTF :118-123+VerifyFixClassname :123);defineClass2 :150-212 是 ByteBuffer 版(GetDirectBufferAddress :173 不拷贝);findBootstrapClass :217-248(JVM_FindClassFromBootLoader :240 ✓)
> - **load0 真实流程**(大纲大幅简化): isBuiltin?procHandle:JVM_LoadLibrary(:354)→findJniFunction(:290-330,试 JNI_OnLoad+JNI_OnLoad_<库名>,buildJniFunctionName jni_util_md.c:53;基础符号 JNI_ONLOAD_SYMBOLS jvm_md.h:40)→无入口 jniVersion=0x00010001(:365)→JVM_IsSupportedJNIVersion 校验(:378-389,失败 UnsatisfiedLinkError "unsupported JNI version 0x%08X")→handle(:400)/jniVersion(:390) 存回(javadoc 用途 ClassLoader.java:2406-2412);execstack 库在 safepoint/VMThread 加载修栈保护页(os_linux.cpp:1884-1927)
> - **"io_util.c getFD/setFD JNI 字段访问" 函数编造**: io_util.c(224 行)里是 readSingle/readBytes(:38-123,BUF_SIZE 8192 :58)/writeSingle/writeBytes(:125-202)/throwFileNotFoundException(:204-224),**没有 getFD/setFD**;GET_FD/SET_FD 是**宏**在 io_util_md.h:53-59(非 io_util.h!);IO_fd_fdID 全局 jfieldID 由 FileDescriptor.initIDs 一次性缓存(FileDescriptor_md.c:51-57,GetFieldID "fd" "I"——**int 字段非 long**;Windows 版是 GetLongField+IO_handle_fdID)
> - **"IO_Read/IO_Write macros wrapping ::read/::write with EINTR retry" 半错**: IO_Read/IO_Write 只是别名宏(io_util_md.h:70-71);EINTR 重试在 handleRead/handleWrite 函数内(RESTARTABLE 宏,io_util_md.c:166-180);fileOpen 在 io_util_md.c:95-122(剥尾部斜杠 :101-106);handleOpen :73-93(目录→close+EISDIR :82-86)
> - **fileDescriptorClose 关键设计(大纲未提)**: 先置 -1 再关防 fd 复用竞态(:137-143 注释)+**0/1/2 不关闭改重定向 /dev/null**(:147-160)
> - **TimeZone 函数名全错**: getSystemTimeZoneID/getSystemGMTOffsetID 是 **Java_java_util_TimeZone_xxx 的 JNI 函数**(TimeZone.c:40-58/:67-77);TimeZone_md.c 里实际是 findJavaTZ_md(:793-850)/getPlatformTimeZoneID(:251-354)/getGMTOffsetID(:855-901);大纲行号范围(:50-150/:200-350/:400-500)全漂移
> - **"/etc/timezone fscanf(%1024s)" 错**: 实际 fgets 一行(TimeZone_md.c:269-285,去\n+非空才用)
> - **"/etc/localtime readlink 简单化" 错**: 实际 lstat 三态(:288-353): ①lstat 失败→NULL ②符号链接→readlink+getZoneName 提取 zoneinfo/ 后部分(:303-318)③**普通文件→读内容→findZoneinfoFile 递归扫描 /usr/share/zoneinfo 逐文件比对**(isFileIdentical :203-243 先比大小再 memcmp;跳过 .开头/ROC/posixrules/localtime :154-176;UTC/GMT 快速路径 :132-147 "fast path for 1st iteration")
> - **优先级**: TZ 环境变量→getPlatformTimeZoneID→GMT(Java 侧 user.timezone 属性优先,TimeZone.java:660-697,getSystemTimeZoneID :671,zoneID==null→GMT_ID :674);findJavaTZ_md 里忽略前导 ":"(:809-811)+Linux "posix/" 前缀(:814-816)
> - **getGMTOffsetID 机制错**: 非 tm_gmtoff 格式化;实际 localtime_r+gmtime_r 比较小时分钟(:873-880,相等→"GMT")+strftime("%z") 5 字符→"GMT%c%c%c:%c%c"(:893-898);AIX 分支 mktime/difftime(:888-891)
> - 悬念指向 43-nio-net/01 的**大纲文件名是 01-tcp-epoll.md**(非 01.md,标题 "01. TCP Socket — PlainSocketImpl + ServerSocket + epoll");实证: materials/commands/42-classio-tz.txt(容器无 /etc/timezone、/etc/localtime→Asia/Shanghai、ZoneId=Asia/Shanghai)+42-classio-jnionload.txt(JNI_OnLoad 调用+按需动态链接)+jcmd-VM.system_properties.txt:9(user.timezone=Asia/Shanghai)

### 1. "ClassLoader — native library loading (dlopen)"

场景: `System.loadLibrary("net")`→ClassLoader.loadLibrary→JVM_LoadLibrary("net")→dlopen("libnet.so")→dlsym→register native methods→throw UnsatisfiedLinkError if fail。

**ClassLoader.c** (`ClassLoader.c:76-400`):
```
Java_java_lang_ClassLoader_defineClass1(env, loader, name, buf, off, len, pd, source) (line 76):
  → JVM_DefineClass(env, name, loader, buf+off, len, pd) — 调用 JVM(域07 ClassFile)
  → return class

Java_java_lang_ClassLoader_findBootstrapClass(env, name) (line 240):
  → JVM_FindClassFromBootLoader(env, clname) — 查 bootstrap class path

JVM_LoadLibrary(cname): (line 354)
  → dlopen("libnet.so", RTLD_LAZY|RTLD_GLOBAL) — 加载 native library
  → dlsym(handle, "JNI_OnLoad") → JNI_OnLoad(JavaVM*, void*) — library 初始化
  → dlsym(handle, "Java_com_example_MyClass_myMethod") — 绑定 native methods
[C++: ClassLoader.c:523行——native library loading 使用 dlopen(与 launcher 域40 相同)]
```
- 源码: `ClassLoader.c:76-150` (defineClass1→JVM_DefineClass) + `ClassLoader.c:240-260` (findBootstrapClass) + `ClassLoader.c:350-400` (JVM_LoadLibrary→dlopen/dlsym)

- 关键设计: **RTLD_LAZY|RTLD_GLOBAL** — LAZY 延迟符号解析(只在函数调用时解析)→加快 library load；GLOBAL 使 library 的 symbols 对所有后续 dlopen 可见——允许 library A 依赖 library B 的 symbols。**JNI_OnLoad** — native library 的初始化入口——可在此注册 native methods(RegisterNatives) 或读取 JavaVM* 指针。

### 2. "FileDescriptor + ObjectStream"

场景: Java `FileDescriptor` 是一个包装 int fd 的 Java 对象→native 层 `io_util.c:getFD(env, this)` 读取 `FileDescriptor.fd` int field→return raw fd to C。

**io_util** (`io_util.h:29-56 + io_util_md.h:53-57`):
```
GET_FD(this, fid) (io_util_md.h:57):
  → (*env)->GetObjectField(env, this, fid) → extract java.io.FileDescriptor object
  → (*env)->GetIntField(env, fdObj, IO_fd_fdID) (io_util.h:29) → return (FD)fd

SET_FD(this, fd, fid) (io_util_md.h:53):
  → create FileDescriptor object → SetIntField(fdObj, IO_fd_fdID, fd) → SetObjectField(this, fid, fdObj)

fileOpen(env, this, path, fid, flags) (io_util.h:56):
  → JNU_GetStringPlatformChars→path → open(path, flags, 0666) → return fd
  → SET_FD(this, fd, fid)

IO_Read/IO_Write: macros wrapping ::read/::write syscalls with EINTR retry
[C++: io_util.h——FD 类型在 Linux=下是 int(32-bit)——用 jint 存储在 Java 层 long field 中]
```
- 源码: `io_util.c:60-100` (getFD/setFD JNI 字段访问) + `io_util_md.c:50-150` (fileOpen/fileClose via open/close syscalls)

- 关键设计: **GET_FD/SET_FD 是宏不是函数** — 定义在 `io_util_md.h:53-57`(平台相关)——因为 Unix 的 fd 是 int(从 Java `jint` field 读取)但 Windows 的 handle 是 `HANDLE`(64-bit pointer→需要 `GetLongField` 不是 `GetIntField`)。**IO_fd_fdID** (`io_util.h:29`) 是一个全局 `jfieldID`——在 JNI_OnLoad 中一次性 lookup(`GetFieldID(cls, "fd", "I")` → 保存→之后所有 I/O 操作都用缓存值→避免每次 GetFieldID 的 JNI overhead。**EINTR retry** — `IO_Read` 宏检测 errno==EINTR→自动 retry——因为 fd 在 signal handler 可能触发 EINTR→必须在 Java 层透明处理。

### 3. "TimeZone"

场景: `ZoneId.systemDefault()`→TimeZone.getDefault()→getSystemTimeZoneID()→read /etc/timezone("Asia/Shanghai")→if empty→read /etc/localtime symlink target。

**TimeZone_md.c** (`TimeZone_md.c:50-400`):
```
getSystemTimeZoneID():
  → fopen("/etc/timezone") → fscanf("%1024s", tz) → "Asia/Shanghai"
  → if empty: readlink("/etc/localtime") → parse path="/usr/share/zoneinfo/Asia/Shanghai"→extract"Asia/Shanghai"
  → return tz

getSystemGMTOffsetID():
  → time_t now = time(NULL)
  → localtime_r(&now, &local_time) → tm_gmtoff(seconds offset from UTC)
  → format "GMT+08:00" or "GMT-08:00"
[C++: TimeZone_md.c:901行——/etc/timezone 是 Debian/Ubuntu 格式; /etc/localtime symlink 是 POSIX 标准]
```
- 源码: `TimeZone_md.c:50-150` (getSystemTimeZoneID→read /etc/timezone) + `TimeZone_md.c:200-350` (read /etc/localtime fallback) + `TimeZone_md.c:400-500` (getSystemGMTOffsetID→gmtime)

- 关键设计: **双路径 fallback** — `/etc/timezone`(Debian/Ubuntu)→`/etc/localtime` symlink(POSIX)——先试 Debian 格式再 fallback 到 POSIX。容器中 `/etc/timezone` 可能不存在→TZ 环境变量优先→if TZ set→直接使用→skip file reads。

---

### 核心悬念

**"ClassLoader: defineClass1→JVM_DefineClass + findBootstrapClass→JVM_FindClassFromBootLoader + JVM_LoadLibrary→dlopen/dlsym/JNI_OnLoad。FileDescriptor: fd stored as int in Java field→io_util getFD/setFD JNI 读写。TimeZone: /etc/timezone→/etc/localtime fallback→Asia/Shanghai。"** — 下一篇: 域43 NIO & Net。

> → 域43 NIO & Net
