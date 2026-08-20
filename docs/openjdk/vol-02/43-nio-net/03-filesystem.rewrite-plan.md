# 43-nio-net/03-filesystem 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libnio/fs`
> 目标：解释 `java.nio.file` 为什么虽然都看起来像“文件系统 API”，底层却被拆成元数据查询、目录枚举、事件通知三种完全不同的 native 输入面；并讲清 UnixNativeDispatcher 与 LinuxWatchService 如何分别承担 syscall 包装与 inotify 事件翻译

## 1. 选题判断

现稿已有很强事实基础：
- `UnixNativeDispatcher.stat0/openat0/readdir`
- `prepAttributes`
- `NativeBuffer` / `jlong address`
- `LinuxWatchService.c` 与 `LinuxWatchService.java`
- `inotify` 事件解析和 `maskToEventKind`

但当前正文仍偏“syscall 包装 + readAttributes + inotify”按源码顺序罗列。真正该打穿的读者困惑更集中：

**`Files.readAttributes`、`Files.list`、`WatchService` 都属于文件系统 API，为什么底层却完全不像一套机制？有的只是 `stat` 一次元数据快照，有的是 `readdir/getdents64` 目录流，有的又是 inotify 的持续事件流。JDK 在这里统一的到底是什么，又为什么要把 `UnixNativeDispatcher` 和 `LinuxWatchService` 分成两层？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**文件系统在 Java 世界里看起来像一组连续 API，但 native 侧其实面对三种不同输入面：`stat/lstat/fstat` 这样的元数据快照、`opendir/readdir` 这样的目录枚举流、以及 inotify 这样的持续事件流。`UnixNativeDispatcher` 的职责是把路径地址、fd 和属性对象翻译成一组可重用的 POSIX syscall 包装，而 `LinuxWatchService` 则另外起一条“事件通知翻译”通道，把 inotify 的变长事件缓冲翻成 Java `WatchEvent`。**

## 3. 总图

```text
元数据面
  Files.readAttributes
    └─ UnixNativeDispatcher.stat0/lstat0/fstat...
         └─ prepAttributes -> UnixFileAttributes

目录枚举面
  Files.list / DirectoryStream
    └─ opendir/fdopendir/readdir
         └─ 只回 d_name，后续再按需判类型

事件通知面
  WatchService
    └─ inotify_init/add_watch/rm_watch
         + poll(ifd, socketpair)
         + Java Poller 解析 struct inotify_event
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么都是文件系统 API，底层却像三套系统

目标约 1200 字。

- 从 `readAttributes`、`Files.list`、`WatchService` 并列切入
- 点出：一个要快照、一个要目录流、一个要持续事件流
- 埋主线：JDK 统一的是翻译接口，不统一输入面形态

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. `java.nio.file` 底层就是几层 syscall 包装，差别不大
2. WatchService 只是把 `readdir/stat` 轮询起来

结论：
- 元数据、枚举、事件通知根本不是同一种输入面
- inotify 是内核主动事件流，不是目录遍历的变种

### 第三节：UnixNativeDispatcher——为什么路径统一先变成 native buffer 地址

目标约 2100 字。

- `copyToNativeBuffer`
- `jlong address -> const char*`
- `open0/openat0/stat0`
- `RESTARTABLE`
- `throwUnixException`
- 路标：这是 syscall 翻译层，不是文件系统语义层

### 第四节：元数据快照——为什么 `prepAttributes` 才是 `readAttributes` 真正的回填点

目标约 1800 字。

- `stat0/lstat0/fstat/fstatat0`
- `prepAttributes`
- `stat1` 只取 mode 的捷径
- 说明 `Files.readAttributes` 本质是一次快照，不碰文件内容

### 第五节：目录枚举——为什么 `readdir` 只回名字，不顺手回类型

目标约 1800 字。

- `opendir0/fdopendir/readdir`
- `readdir64` 只取 `d_name`
- Java 侧后续再按需判类型
- 强调目录流是“名字序列”，不是“完整属性对象流”

### 第六节：WatchService——为什么事件通知必须单开 inotify 通道

目标约 2300 字。

- `eventSize/eventOffsets`
- `inotifyInit/addWatch/rmWatch`
- `socketpair` 自唤醒
- `poll(ifd, socketpair)`
- Java Poller 读变长事件缓冲
- `maskToEventKind` 把 inotify 事件翻成 CREATE/DELETE/MODIFY

### 第七节：为什么 inotify 不是递归监视，也不是目录轮询

目标约 1600 字。

- `implRegister` 只注册传入目录
- `ENTRY_CREATE/DELETE` 与 `IN_MOVED_TO/FROM` 的合成语义
- `IN_Q_OVERFLOW` 的 OVERFLOW 广播
- 收回“持续事件流”主线

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. `Files.readAttributes` 是否会读文件正文
2. `readdir` 是否直接返回类型信息给 Java
3. WatchService 是否靠用户态轮询目录差异实现
4. inotify 是否默认递归监视子目录
5. jlong 地址传参是否只是 JNI 小技巧

## 5. 失败方案必须写进正文

1. 把所有文件系统 API 看成同一种 syscall 包装
2. 把 WatchService 看成目录轮询的变种
3. 把 `readdir` 返回值误解成“已经带完整属性信息”

## 6. 证据清单

- `src/java.base/unix/classes/sun/nio/fs/UnixNativeDispatcher.java:39`：`copyToNativeBuffer`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:147`：`my_openat64_func`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:182`：`throwUnixException`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:452`：`openat0`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:514`：`prepAttributes`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:543`：`stat0`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:559`：`stat1`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:733`：`opendir0`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:748`：`fdopendir`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:774`：`readdir`
- `src/java.base/linux/native/libnio/fs/LinuxWatchService.c:49`：`eventSize/eventOffsets`
- `src/java.base/linux/native/libnio/fs/LinuxWatchService.c:72`：`inotifyInit`
- `src/java.base/linux/native/libnio/fs/LinuxWatchService.c:83`：`inotifyAddWatch`
- `src/java.base/linux/native/libnio/fs/LinuxWatchService.c:118`：`socketpair`
- `src/java.base/linux/native/libnio/fs/LinuxWatchService.c:132`：`poll`
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:155`：offset 常量与 inotify mask
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:208`：`implRegister`
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:310`：Poller 主循环
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:384`：`maskToEventKind`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / Linux / x86_64 / libnio/fs`
- 本篇聚焦 NIO filesystem，`java.io.File` 旧路径不展开
- 只讲 Linux inotify，不扩 Windows/macOS watch 实现
- 目录类型判断和后续 provider 逻辑只点必要边界，不扩展到整个 Files API
- 若下一篇切回 VM 内部，要让本篇自然收束在“文件系统输入面”主题

## 8. 完成后 review

- 删除代码后，能否复述“元数据快照、目录枚举、事件通知是三种不同输入面”
- 是否清楚说明 `UnixNativeDispatcher` 和 `LinuxWatchService` 的职责分层
- 是否讲清 `readdir` 只回名字、后续类型判断另做
- 是否讲清 inotify 不是递归监视、不是轮询
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
