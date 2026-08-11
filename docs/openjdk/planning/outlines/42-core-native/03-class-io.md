# 03. ClassLoader + I/O + TimeZone — 剩馀核心机制

> 🟡 Working | NativeLibrary dlopen + FileDescriptor fd + /etc/timezone
> 读者处境: `ClassLoader.loadLibrary("net")`→JNI→dlopen→dlsym→native method registration。`new FileDescriptor()`→open syscall→fd stored as `int` in Java field。`ZoneId.systemDefault()`→/etc/timezone→"Asia/Shanghai"。

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
