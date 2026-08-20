# 42-core-native/03-class-io 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libjava + HotSpot`
> 目标：把 `ClassLoader.defineClass`、native 库加载、`FileDescriptor` 与默认时区探测这几条看似无关的路径，统一解释成 libjava 对“外部字节 / 外部句柄 / 外部系统配置”的翻译协议

## 1. 选题判断

现稿已有很强事实基础：
- `defineClass1/2`
- `NativeLibrary.load0` / `JVM_LoadLibrary` / `dlopen_helper`
- `JNI_OnLoad` 查找与版本校验
- `GET_FD/SET_FD`、`fileOpen`、`fileDescriptorClose`
- `findJavaTZ_md` / `getPlatformTimeZoneID` / `getGMTOffsetID`

但当前正文更像“三件剩余杂活”的拼盘。真正该打穿的读者困惑更集中：

**为什么“类的字节进 JVM”“native 库进进程”“FileDescriptor 里的 fd 进系统调用”“默认时区进 Java TimeZone”这几条路径虽然看起来毫不相干，却都落在 libjava 这层？它们到底共享了什么样的翻译职责，为什么有的工作停在 libjava，有的却必须交给 HotSpot 或操作系统去做？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**这三条线表面上是 defineClass、dlopen、文件描述符和时区探测，底层其实都在做同一件事：把‘外部世界的原始字节、句柄和配置’翻成 Java 世界能稳定消费的对象语义。类字节先被整理成 JVM 能接受的内部名字和内存块，再交给 HotSpot 真正定义；native 库加载则由 VM 持有句柄和栈保护修复能力，libjava 只组织 `JNI_OnLoad` 握手；FileDescriptor 把一个裸 fd 嵌进 Java 对象并在关闭时补上竞态防御；TimeZone 则把 `TZ`、`/etc/localtime`、GMT 偏移这条系统配置链翻成 Java 侧时区 ID。**

## 3. 总图

```text
外部输入
  ├─ class bytes / direct buffer
  ├─ shared library handle / JNI_OnLoad
  ├─ int fd / path string
  └─ TZ env / /etc/localtime / GMT offset

libjava 翻译层
  ├─ defineClass1/2        : 字节与类名整理后交 JVM
  ├─ NativeLibrary.load0   : 组织库加载握手
  ├─ GET_FD/SET_FD + io    : fd 与 Java FileDescriptor 对接
  └─ findJavaTZ_md         : 系统时区探测与 Java tzid 映射

HotSpot / OS 真正执行者
  ├─ JVM_DefineClassWithSource
  ├─ JVM_LoadLibrary / dlopen
  ├─ read/write/open/close
  └─ readlink/realpath/strftime/TZ files
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么这三件杂事会落在同一层 libjava 里

目标约 1200 字。

- 从 defineClass、loadLibrary、FileDescriptor、TimeZone 看似无关切入
- 点出共同点：都是把外部世界输入翻成 Java 语义
- 埋主线：libjava 在这里不是“做功能”，而是在做翻译与握手

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 这些都只是零散 native 杂活，放哪都行
2. 既然最终都会进 VM 或系统调用，那干脆全交 HotSpot

结论：
- 第一种会让翻译边界碎掉
- 第二种混淆 libjava 的组织职责与 HotSpot/OS 的执行职责

### 第三节：defineClass——为什么 libjava 只搬运和整理，不真正定义类

目标约 2000 字。

- `defineClass1/2`
- byte[] 复制 vs direct buffer 零拷贝
- `VerifyFixClassname`
- `JVM_DefineClassWithSource`
- 强调类定义真正发生在 VM 侧，libjava 只做前置翻译

### 第四节：native 库加载——为什么 dlopen 在 VM 里，流程组织在 libjava

目标约 2300 字。

- `NativeLibrary.load0`
- `JVM_LoadLibrary` / `os::Linux::dlopen_helper`
- execstack/guard page 修复为什么只能由 VM 做
- `JNI_OnLoad` 查找/调用/版本校验/回滚
- 说明“方法符号按需动态链接”与“加载时只握手”边界

### 第五节：FileDescriptor——为什么一个 int 字段还要配一套宏和关闭协议

目标约 2100 字。

- `FileDescriptor_initIDs`
- `GET_FD/SET_FD`
- `readSingle/readBytes` 与 `handleRead`
- `fileOpen` 的 trailing slash 与目录拒绝
- `fileDescriptorClose` 先置 -1、0/1/2 重定向 `/dev/null`
- 收回“裸 fd 到 Java 句柄”的翻译主线

### 第六节：TimeZone——为什么默认时区探测是一条阶梯式回退链

目标约 2200 字。

- `TimeZone.getSystemTimeZoneID` -> `findJavaTZ_md`
- `TZ` 优先
- `/etc/timezone`、`/etc/localtime` symlink / 文件内容比对
- `getGMTOffsetID`
- 强调“系统配置翻译成 Java tzid”而不是“随手读个环境变量”

### 第七节：误解澄清与收网

目标约 1300 字。

至少回答：
1. `defineClass1` 是否真的定义了类
2. `JVM_LoadLibrary` 是否等于 libjava 自己 dlopen
3. `JNI_OnLoad` 是否等于 native 方法符号全部预绑定
4. `GET_FD/SET_FD` 是否只是语法糖
5. 默认时区是否永远只看 `TZ`

## 5. 失败方案必须写进正文

1. 把 defineClass、dlopen、fd、timezone 当成四块互不相干的 native 杂务
2. 把 libjava 和 HotSpot 的职责边界混成一层
3. 把默认时区探测理解成“只看环境变量”或“只看 /etc/localtime”

## 6. 证据清单

- `src/java.base/share/native/libjava/ClassLoader.c:75`：`defineClass1`
- `src/java.base/share/native/libjava/ClassLoader.c:123`：`VerifyFixClassname`
- `src/java.base/share/native/libjava/ClassLoader.c:136`：`JVM_DefineClassWithSource`
- `src/java.base/share/native/libjava/ClassLoader.c:150`：`defineClass2`
- `src/java.base/share/native/libjava/ClassLoader.c:337`：`NativeLibrary.load0`
- `src/java.base/share/native/libjava/ClassLoader.c:357`：`findJniFunction` / `JNI_OnLoad`
- `src/hotspot/share/prims/jvm.cpp:3448`：`JVM_LoadLibrary`
- `src/hotspot/os/linux/os_linux.cpp:1883`：execstack/stack guard 修复路径
- `src/hotspot/os/linux/os_linux.cpp:2106`：`dlopen_helper`
- `src/java.base/unix/native/libjava/FileDescriptor_md.c:50`：`FileDescriptor_initIDs`
- `src/java.base/unix/native/libjava/io_util_md.h:53`：`SET_FD/GET_FD`
- `src/java.base/share/native/libjava/io_util.c:38`：`readSingle/readBytes`
- `src/java.base/unix/native/libjava/io_util_md.c:73`：`handleOpen`
- `src/java.base/unix/native/libjava/io_util_md.c:95`：`fileOpen`
- `src/java.base/unix/native/libjava/io_util_md.c:124`：`fileDescriptorClose`
- `src/java.base/unix/native/libjava/io_util_md.c:166`：`handleRead/handleWrite`
- `src/java.base/share/native/libjava/TimeZone.c:40`：`getSystemTimeZoneID`
- `src/java.base/unix/native/libjava/TimeZone_md.c:251`：`getPlatformTimeZoneID`
- `src/java.base/unix/native/libjava/TimeZone_md.c:793`：`findJavaTZ_md`
- `src/java.base/unix/native/libjava/TimeZone_md.c:855`：`getGMTOffsetID`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / Linux / x86_64 / libjava + HotSpot`
- 本篇聚焦“翻译层职责”，不扩成完整类加载、JNI、I/O、时区专题
- Windows/Mac 差异只在必要处点边界
- `ObjectStreamClass` 等边缘小节若提及，只能用来强调“其余工作仍在 Java 层”
- 后续篇章若继续 core-native 域，应自然切进更具体的子系统接口

## 8. 完成后 review

- 删除代码后，能否复述“这三条线都在做外部输入到 Java 语义的翻译”
- 是否清楚区分 libjava、HotSpot、OS 的分工边界
- 是否说明 `JNI_OnLoad` 只握手，不等于方法全部绑定
- 是否把时区探测的阶梯回退链讲清楚
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
