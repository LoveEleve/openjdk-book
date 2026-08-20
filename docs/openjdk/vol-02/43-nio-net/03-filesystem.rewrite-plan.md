# 43-nio-net/03-filesystem 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libnio/fs`
> 目标：解释为什么 `java.nio.file` 看起来像一组连续 API，native 侧却分成元数据快照、目录枚举流、事件通知流三种完全不同的输入面；以及 `UnixNativeDispatcher` 与 `LinuxWatchService` 分别承担什么职责

## 1. 选题判断

现稿事实基础已经很强：
- `UnixNativeDispatcher.copyToNativeBuffer/stat0/lstat0/fstat/openat0/readdir`
- `prepAttributes`
- `LinuxWatchService.c` 的 inotify / poll / socketpair
- `LinuxWatchService.java` 的 Poller / maskToEventKind / implRegister

但当前正文仍偏“元数据一节 + 目录枚举一节 + WatchService 一节”的并列机制说明。真正该打穿的困惑更集中：

**`Files.readAttributes`、`Files.list`、`WatchService` 都属于文件系统 API，为什么底层却完全不像一套机制？有的只是 `stat` 一次元数据快照，有的是 `readdir` 目录流，有的又是 inotify 的持续事件流。JDK 在这里统一的到底是什么，又为什么要把 `UnixNativeDispatcher` 和 `LinuxWatchService` 分成两层？**

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
    └─ opendir/readdir
         └─ 只回 d_name，后续再按需判类型

事件通知面
  WatchService
    └─ inotify_init/add_watch/rm_watch
         + poll(ifd, socketpair)
         + Java Poller 解析 struct inotify_event
```

## 4. 结构大纲

### 第一节：开场困惑——同属文件系统 API，为什么完全不像一套机制

目标约 1200 字。

- 从 `Files.readAttributes` / `Files.list` / `WatchService` 表面同属文件系统 API 切入
- 点出：native 侧面对的是快照、流、事件三种不同输入面
- 埋主线：统一的是翻译接口，不是内核输入模型

### 第二节：两个朴素方案为什么都不对

必须推演：
1. `java.nio.file` 底层就是几层 syscall 包装，差别不大
2. `WatchService` 只是目录轮询的 JNI 版

### 第三节：`UnixNativeDispatcher`——路径统一先变成 native buffer 地址

- `copyToNativeBuffer`
- 统一 errno 翻译 `throwUnixException`
- `openat0` 的运行时符号适配

### 第四节：元数据快照——为什么 `prepAttributes` 才是回填点

- `stat0/lstat0/fstat`
- `prepAttributes`
- `stat1` 只回 `st_mode`
- 这是一份静态属性快照，不碰正文

### 第五节：目录枚举——为什么 `readdir` 只回名字，不顺手回类型

- `opendir0/fdopendir/readdir`
- 目录流里只回 `d_name`
- 类型/属性由后续按需查询

### 第六节：事件通知——为什么 `WatchService` 必须单开 inotify 通道

- `LinuxWatchService.c` 的 eventSize/eventsOffset/dataOffset + create/add/rm/poll
- socketpair 的自唤醒控制通道
- Java Poller 解析变长事件缓冲
- `maskToEventKind` 语义折叠
- `implRegister` 不是递归监视

### 第七节：误解澄清与收网

## 5. 失败方案必须写进正文

1. `java.nio.file` 底层就是几层 syscall 包装，差别不大
2. `WatchService` 只是目录轮询的 JNI 版

## 6. 证据清单

- `src/java.base/unix/classes/sun/nio/fs/UnixNativeDispatcher.java:39`
- `src/java.base/unix/classes/sun/nio/fs/UnixNativeDispatcher.java:298`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:182`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:452`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:514`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:543`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:559`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:733`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:748`
- `src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:774`
- `src/java.base/linux/native/libnio/fs/LinuxWatchService.c:49-130`
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:208`
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:310`
- `src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:384`

## 7. 完成后 review

- 删除代码后，能否复述“快照 / 名字流 / 事件流”三种输入面
- 是否讲清 `UnixNativeDispatcher` vs `LinuxWatchService` 的职责边界
- 是否讲清 `WatchService` 不是轮询差分
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验