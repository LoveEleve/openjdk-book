# 03. NIO FileSystem — stat/readdir/inotify

> **前置依赖**:[43-nio-net/02 — UDP + DNS + NetworkInterface — Datagram + InetAddress](openjdk/vol-02/43-nio-net/02-udp-dns.md):jlong 地址传参与布局函数模式(EPoll 的 eventSize 家族),本篇的 stat0/inotify 同款;[43-nio-net/01 — TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md):RESTARTABLE 宏与 throwUnixException 的错误模式
> → **后续**:[22-deoptimization/01 — 编译代码什么时候回退？— Deopt 决策表](openjdk/vol-02/22-deoptimization/01-deopt-decision.md):43 域收官,第 6 批收官,回到 VM 内部
> 关联域: 42-core-native(文件 I/O 的 libjava 侧)、43-nio-net/02(jlong 地址传参)

## 文件系统的三件事

[strace 实证](planning/outlines/00-jvm-tools/materials/commands/33-nio-fs-strace.txt)把 `Files.readAttributes`、`Files.list`、`WatchService` 各跑一遍:

```
# readAttributes -> stat(元数据,不读内容)
stat("/tmp/fsdemo/a.txt", {st_mode=S_IFREG|0644, st_size=5, ...}) = 0

# Files.list -> 目录打开 + getdents64(glibc readdir 内部)
openat(AT_FDCWD, "/tmp/fsdemo", O_RDONLY) = 4
getdents64(4, 0x7fef344b58b0 /* 3 entries */, 32768) = 80

# WatchService -> inotify
inotify_init()                   = 4
inotify_add_watch(4, "/tmp/fsdemo/watch", IN_MODIFY|IN_ATTRIB|IN_MOVED_FROM|IN_MOVED_TO|IN_CREATE|IN_DELETE ...) = 1
inotify_rm_watch(4, 1)           = 0
```

程序输出三个事件 `ENTRY_CREATE/ENTRY_MODIFY/ENTRY_DELETE b.txt`。三个 native 文件各管一段: UnixNativeDispatcher.c:1-1244(1244 行,一切 POSIX syscall 的 JNI 包装)、LinuxWatchService.c:1-153(153 行,inotify 监视)、加上 Java 侧的 UnixNativeDispatcher.java:298 封装。这篇拆: syscall 包装怎么传参、属性怎么回填、inotify 事件怎么变成 WatchEvent。

## 1. UnixNativeDispatcher: syscall 的 JNI 包装

`UnixNativeDispatcher.c`(unix/native/libnio/fs/UnixNativeDispatcher.c:1-1244,1244 行)是 **java.nio.file 的全部底层**——stat/open/readdir/mkdir/rename/chmod/unlink……约 50 个函数,模式高度统一。第一个值得记住的设计是**参数传递**: 路径不走 JNI String,而是 **jlong 地址**。Java 侧先 `copyToNativeBuffer(path)`(UnixNativeDispatcher.java:39)把路径拷进 NativeBuffer(NativeBuffers.java:35 起的类),再 `stat0(buffer.address(), attrs)`(UnixNativeDispatcher.java:298-311):

```cpp
// UnixNativeDispatcher.c:543-556(截取核心,逐字)
Java_sun_nio_fs_UnixNativeDispatcher_stat0(JNIEnv* env, jclass this,
    jlong pathAddress, jobject attrs)
{
    int err;
    struct stat64 buf;
    const char* path = (const char*)jlong_to_ptr(pathAddress);

    RESTARTABLE(stat64(path, &buf), err);
    if (err == -1) {
        throwUnixException(env, errno);
    } else {
        prepAttributes(env, &buf, attrs);
    }
}
```

三个细节: ①**pathAddress=jlong_to_ptr**——Java 侧 NativeBuffer 的裸地址(43-01 的 epoll address 同款);②**RESTARTABLE(stat64(...), err)**——EINTR 自动重试的宏(信号打断的 syscall 必须重跑);③**prepAttributes** 把 `struct stat64` 的字段填进 Java 侧 `UnixFileAttributes` 对象(attrs 是回填参数,不是返回值)。另外还有 `stat1`(:559)返回 st_mode 的简化版(Java 侧 `stat(UnixPath)` :315 判断文件类型用)。

**openat0**(:452): 没有大纲想象的 "dfd==AT_FDCWD 分支"——真实实现是**运行时函数指针**:

```cpp
// UnixNativeDispatcher.c:452-468(截取核心,逐字)
Java_sun_nio_fs_UnixNativeDispatcher_openat0(JNIEnv* env, jclass this, jint dfd,
    jlong pathAddress, jint oflags, jint mode)
{
    jint fd;
    const char* path = (const char*)jlong_to_ptr(pathAddress);

    if (my_openat64_func == NULL) {
        JNU_ThrowInternalError(env, "should not reach here");
        return -1;
    }

    RESTARTABLE((*my_openat64_func)(dfd, path, (int)oflags, (mode_t)mode), fd);
    if (fd == -1) {
        throwUnixException(env, errno);
    }
    return fd;
}
```

`my_openat64_func` 是 init 时 dlsym 解析的 `openat64` 函数指针(UnixNativeDispatcher.c:262-267)——**用 openat(dfd 相对路径)而非 open** 的意义: 路径相对目录 fd 解析,减少 TOCTOU 竞态(大纲这点对)。

**目录流**: `opendir0`(:733,path→`DIR*`)、`fdopendir`(:748,my_fdopendir_func)、`readdir`(:774):

```cpp
// UnixNativeDispatcher.c:774-793(截取核心,逐字)
Java_sun_nio_fs_UnixNativeDispatcher_readdir(JNIEnv* env, jclass this, jlong value) {
    DIR* dirp = jlong_to_ptr(value);
    struct dirent64* ptr;

    errno = 0;
    ptr = readdir64(dirp);
    if (ptr == NULL) {
        if (errno != 0) {
            throwUnixException(env, errno);
        }
        return NULL;
    } else {
        jsize len = strlen(ptr->d_name);
        jbyteArray bytes = (*env)->NewByteArray(env, len);
        if (bytes != NULL) {
            (*env)->SetByteArrayRegion(env, bytes, 0, len, (jbyte*)(ptr->d_name));
        }
        return bytes;
    }
}
```

**readdir64 + 只返回 d_name**——大纲的"readdir 返回 d_type(DT_REG/DT_DIR)省 stat"是错的: JDK11 的 readdir 只把 `d_name` 拷成字节数组返回,`d_type` 根本不看(Java 侧 `UnixDirectoryStream` 拿到名字后,类型判断另有其路)。strace 里 `getdents64(4, /* 3 entries */, 32768) = 80` 就是 readdir64 的 glibc 内部实现(. 和 .. 也被内核返回,Java 侧过滤)。

## 2. Files.readAttributes 链路

`Files.readAttributes` → `UnixFileSystemProvider.readAttributes`(UnixFileSystemProvider.java:135,按类型选 BasicFileAttributeView/PosixFileAttributeView)→ view 的 `readAttributes()` → `UnixNativeDispatcher.stat(UnixPath, attrs)`(Java 侧 :298)→ `stat0(buffer.address(), attrs)`。实证里就是那行 `stat("/tmp/fsdemo/a.txt", {st_mode=S_IFREG|0644, st_size=5})`——**stat 只取元数据,不读文件内容**(大纲的注释对)。`Files.list` 同理: 打开目录(`openat(O_RDONLY)`)→ 每读一个条目一次 readdir64(内部 getdents64 批量取)。

## 3. LinuxWatchService: inotify 事件监视

`LinuxWatchService.c`(linux/native/libnio/fs/LinuxWatchService.c:1-153,153 行)与 EPoll.c:41 一样是"薄 JNI + 布局函数":

- `eventSize`(:49)/`eventOffsets`(:55)——**布局五元组**(wd/mask/cookie/len/name 的 offsetof),Java 侧按它直接 unsafe 读 `struct inotify_event`(43-01 的 EPoll 模式);
- `inotifyInit`(:72)= **`inotify_init()`(旧 API**,大纲悬念段写的 inotify_init1 是误记;fd 的 CLOEXEC 由 Java 侧 configureBlocking 外的 fcntl 或 init 时设置);
- `inotifyAddWatch`(:83,path 经 jlong_to_ptr 的 NativeBuffer 地址 + mask)/`inotifyRmWatch`(:97);
- `configureBlocking`(:106,fcntl O_NONBLOCK)/`socketpair`(:118,**自唤醒管道**,同 EPoll 的 fd0/fd1);
- `poll`(:133-153): `poll(ufds[2], 2, -1)` 同时等 inotify fd 与 socketpair,EINTR→0(Java 层重试)。

**Java 侧 LinuxWatchService.java:310** 的 Poller 线程是消费端(`run` :310 起):

```java
// LinuxWatchService.java:312-347(截取核心,逐字)
                for (;;) {
                    int nReady, bytesRead;

                    // wait for close or inotify event
                    nReady = poll(ifd, socketpair[0]);

                    // read from inotify
                    try {
                        bytesRead = read(ifd, address, BUFFER_SIZE);
                    } catch (UnixException x) {
                        if (x.errno() != EAGAIN && x.errno() != EWOULDBLOCK)
                            throw x;
                        bytesRead = 0;
                    }

                    // iterate over buffer to decode events
                    int offset = 0;
                    while (offset < bytesRead) {
                        long event = address + offset;
                        int wd = unsafe.getInt(event + OFFSETOF_WD);
                        int mask = unsafe.getInt(event + OFFSETOF_MASK);
                        int len = unsafe.getInt(event + OFFSETOF_LEN);

                        // file name
                        UnixPath name = null;
                        if (len > 0) {
                            int actual = len;
                            // null-terminated and maybe additional null bytes to
                            // align the next event
                            while (actual > 0) {
                                long last = event + OFFSETOF_NAME + actual - 1;
                                if (unsafe.getByte(last) != 0)
                                    break;
                                actual--;
                            }
```

阻塞在 `poll`(inotify fd 或唤醒管道就绪)→ `read(ifd, address, BUFFER_SIZE)` 一次读出**多个事件**(事件是变长的: `SIZEOF_INOTIFY_EVENT + len`,`offset += ...` 前进)→ 用 eventOffsets 给的偏移 unsafe 读 wd/mask/len → 名字区去掉尾部 null 对齐字节 → `processEvent`。事件→WatchEvent.Kind 的映射在 `maskToEventKind`(:384-390): IN_CREATE/IN_MOVED_TO→ENTRY_CREATE、IN_DELETE/IN_MOVED_FROM→ENTRY_DELETE、IN_MODIFY/IN_ATTRIB→ENTRY_MODIFY。注册时的 mask 映射在 `implRegister`(:208-262): `ENTRY_CREATE → IN_CREATE|IN_MOVED_TO`(:217)等——**inotify 没有"移动"事件,JDK 用 MOVED_FROM/MOVED_TO 合成 CREATE/DELETE 语义**。

*关键设计: inotify 只能监视"注册过的目录本身",不递归*——大纲"Java 层递归注册子目录"是错的: `implRegister` 只对传入目录做一次 `inotifyAddWatch`(:260),子目录监视由使用方(应用自己或 Files.walk 手动遍历)逐个注册。唤醒机制与 EPoll 的 Selector 完全同构: register/close 时 `write(socketpair[1], address, 1)`(:201)写一字节,poll 立即返回,Poller 处理请求队列。

## 核心悬念

43 域收官,第 6 批收官。NIO FileSystem 拆完: 一切 syscall 经 UnixNativeDispatcher 的 JNI 包装(jlong 地址传路径、RESTARTABLE 防 EINTR、prepAttributes 回填属性);readdir64 只取名字;inotify 监视=inotify_init/inotify_add_watch(JDK 侧合成 CREATE/DELETE 语义)+Poller 线程 poll→read→unsafe 解析变长事件(布局函数模式第二次出现: EPoll(43-01 的 eventSize 家族)与 inotify(eventOffsets 五元组))。至此 JDK native 世界的地图完成: 网络(43-01/02)、文件(43-03)、管理(33 域)、JNI 基础(42 域)。下一个域回到 VM 内部——**编译代码在什么情况下放弃机器码、回退到解释器**?热替换、虚方法去优化、异常逃逸,这些决策与 unpack 帧重建。下一篇: Deopt 决策表。

> → [22-deoptimization/01 — 编译代码什么时候回退？— Deopt 决策表](openjdk/vol-02/22-deoptimization/01-deopt-decision.md)
