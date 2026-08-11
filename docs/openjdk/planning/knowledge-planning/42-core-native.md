# 域 42: Core Native (libjava.so) — 知识规划

> 源码: share/native/libjava/ + unix/native/libjava/ | ~77文件/~10733行 | 🟡 普通域(3篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jni_util.c (1512行) | **JNI 工具层**: JNU_ThrowByName/JNU_ThrowNullPointerException/JNU_NewStringNative(JNI 异常+字符串+类型转换)、JNI field lookup cache、JNI_GetCreatedJavaVMs 查找 | High |
| ProcessImpl_md.c (683行) | **进程创建 (fork/exec)**: ProcessBuilder.start()→fork+execvp、redirect stdin/stdout/stderr、waitpid、exit code | High |
| ProcessHandleImpl_unix.c (728行) | **进程句柄**: pid→ProcessHandle、ProcessHandle.Info(command/args/startTime)、kill/destroy、children stream | High |
| childproc.c (400行) | **子进程管理**: 管道重定向、closefrom、child exec 前环境设置 | Medium |
| ClassLoader.c (523行) | **ClassLoader native**: findBootstrapClass→JVM_FindClassFromBootLoader、defineClass1→JVM_DefineClass、native library loading | High |
| Class.c (187行) | **Class native**: getPrimitiveClass/getName/getModifiers/isArray/getDeclaredFields0→JVM_GetClassDeclaredFields | Medium |
| Reflection.c | **Reflection support**: getCallerClass→JVM_GetCallerClass、newInstance | Low |
| System.c (457行) | **System native**: initProperties→java_props_md.c→setProperties、setIn0/setOut0/setErr0→FileDescriptor、identityHashCode→JVM_IHashCode | High |
| java_props_md.c (620行) | **系统属性采集**: os.name/os.arch/os.version/user.home/java.home/file.encoding/sun.jnu.encoding 等 ~30 properties | High |
| TimeZone_md.c (901行) | **时区**: getSystemTimeZoneID(/etc/timezone)、getSystemGMTOffsetID、ZoneInfoFile | Medium |
| Shutdown.c | **Shutdown hooks**: JVM_Halt(exit)、runAllFinalizers→System.runFinalization | Low |
| Object.c | **Object native**: getClass/hashCode/notify/notifyAll/wait/registerNatives | Low |
| String.c | **String native**: intern→JVM_InternString | Low |
| io_util.c (224行) + io_util_md.c (238行) | **I/O 工具**: FD get/set、file descriptor management、setLength | Medium |
| ObjectInputStream.c/ObjectOutputStream.c | **Object Stream**: native read/write primitive arrays、ObjectStreamClass fields | Low |
| AccessController.c/SecurityManager.c | **安全管理**: doPrivileged、getClassContext | Low |
| Signal.c | **Signal 处理**: Signal.handle→sigaction、SIGINT/SIGTERM/SIGHUP | Low |

*17 知识点*

## 02 聚合

### P1 (≥5文件)
| KP | 出现文件 |
|----|---------|
| JNI 工具层 (exception+string+field) | jni_util.c, jni_util_md.c, jni_util.h, jlong.h, io_util.c |
| 系统属性 + System native | System.c, java_props_md.c, jdk_util.c, Runtime.c, Shutdown.c |

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| 进程管理 (fork/exec/wait) | ProcessImpl_md.c, ProcessHandleImpl_unix.c, childproc.c |
| Class + ClassLoader native | ClassLoader.c, Class.c, Reflection.c |
| I/O 工具 + ObjectStream | io_util.c, io_util_md.c, ObjectStream*.c, RandomAccessFile.c |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| TimeZone | TimeZone_md.c |
| Object/String native | Object.c, String.c |
| Security Manager | AccessController.c, SecurityManager.c |
| Signal 处理 | Signal.c |

## 03 深度分类

### 🔴 Deep (3 KP)
| KP | 为什么 🔴 |
|----|---------|
| JNI 工具层 (jni_util.c 1512行) | libjava.so 的 JNI 基础设施——所有其他 native 方法(Class/System/Process)都依赖 jni_util 的 JNU_ThrowXxx/JNU_NewString/JNU_GetField。包含 JNI exception handling 的完整管道(ThrowNew→ExceptionDescribe→ExceptionClear)。jni_util 是整个 JDK Native 层的"runtime support" |
| 进程管理 (fork/exec + ProcessHandle) | ProcessBuilder.start()→fork+execvp(管道重定向+closefrom) + ProcessHandle.live/destroy/children(遍历 /proc) + waitpid→exit code。所有 Java Process API 的 native 实现—— 错误处理(无法 fork→OOM、exec 失败→exit(1) 子进程) |
| 系统属性 + System native | System.initProperties→java_props_md.c(~30 properties 从 /proc、/etc、环境变量采集) + System.setIn0/setOut0→FileDescriptor(standard streams) + System.identityHashCode→JVM_IHashCode。JVM 启动时读取一次→缓存在 system properties HashMap |

### 🟡 Working (3 KP)
| KP | 为什么 🟡 |
|----|---------|
| Class + ClassLoader native | ClassLoader NativeLibrary 加载→JVM_LoadLibrary(dlopen) + JVM_FindClassFromBootLoader; Class.getDeclaredFields→JVM_GetClassDeclaredFields——都是 JVM_* 函数的 thin wrapper |
| I/O + ObjectStream | io_util.c(getFD/setFD) + ObjectStreamClass(serialization field layout)——工具函数层非核心机制 |
| TimeZone | /etc/timezone→getSystemTimeZoneID + GMT offset——ZonedDateTime 的底层但不涉及 JVM 内部 |

### 🟢 Surface (4 KP)
| KP | 为什么 🟢 |
|----|---------|
| Object/String native | getClass/hashCode/intern——都是 JVM_* 的一行 wrapper |
| Security Manager | doPrivileged——JDK 17 已 removed(但 JDK 11 仍存在) |
| Signal 处理 | sigaction wrapper——SIGINT handler |
| Shutdown hooks | JVM_Halt + runAllFinalizers——两行 native calls |

## 04 聚类 — 3篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | JNI 工具 + 系统属性 | "libjava.so 怎么处理 JNI 异常？System.getProperties() 从哪读系统属性？" |
| 2 | 进程管理 | "Runtime.exec() 怎么 fork+exec 子进程？ProcessHandle 怎么读 /proc 获取子进程信息？" |
| 3 | Class/I/O + 时区 | "ClassLoader NativeLibrary 怎么 dlopen？java.io.FileDescriptor 怎么映射到 OS fd？" |

**聚类决策**: 核心三叉——(1)JNI 基础层(jni_util + System)→是最核心的 native 入口 (2)进程管理(fork/exec/wait/ProcessHandle)→相对独立、规模大 (3)Class+I/O+TimeZone→剩徐机制聚合为一篇。第一篇是教学入口(所有其他文章依赖它)、第二篇独立主题、第三篇补充覆盖所有剩余。
