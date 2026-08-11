# 03. NIO FileSystem — stat/readdir/inotify

> 🟡 Working | POSIX syscall JNI + inotify 文件监视
> 读者处境: `Files.readAttributes(path, "*")`→UnixNativeDispatcher.stat→struct stat→BasicFileAttributes。`Files.list(dir)`→openat+fdopendir+readdir→Stream<Path>。`WatchService`→inotify_init→inotify_add_watch(IN_CREATE|IN_DELETE|IN_MODIFY)→poll events→StandardWatchEventKinds。

### 1. "UnixNativeDispatcher — stat/open/readdir"

场景: `Files.readAttributes(path, BasicFileAttributes.class)`→UnixFileSystemProvider.readAttributes→UnixNativeDispatcher.stat→struct stat→FileAttribute→Java BasicFileAttributes。

**UnixNativeDispatcher** (`UnixNativeDispatcher.c:200-600`):
```
Java_sun_nio_fs_UnixNativeDispatcher_stat0(env, this, path):
  → JNU_GetPlatformString(path)→POSIX path string
  → stat(path, &buf)→struct stat(st_mode/st_size/st_mtime/st_uid/st_gid...)
  → return UnixFileAttributes object→Java layer converts to BasicFileAttributes

Java_sun_nio_fs_UnixNativeDispatcher_openat0(env, this, dfd, path, flags, mode):
  → if dfd==AT_FDCWD: openat(AT_FDCWD, path, flags, mode)→return fd

Java_sun_nio_fs_UnixNativeDispatcher_fdopendir(env, this, dfd, path):
  → openat(dfd, path, O_RDONLY|O_DIRECTORY)→fd
  → fdopendir(fd)→DIR*→return dir stream

Java_sun_nio_fs_UnixNativeDispatcher_readdir(env, this, dir_stream_ptr):
  → readdir64((DIR*)ptr)→struct dirent64→d_name/d_type
  → return entry name as Java String(filter out "." "..")
[C++: UnixNativeDispatcher.c:1244行——所有 POSIX I/O syscall 的 JNI 包装器]
[内核: stat(2)→VFS inode→返回 inode 元数据——不是 open/read(不读文件内容)]
```
- 源码: `UnixNativeDispatcher.c:200-400` (stat/lstat/open/close) + `UnixNativeDispatcher.c:400-600` (readdir/fdopendir)

- 关键设计: **openat vs open** — NIO FileSystem 优先用 `openat`(dfd-based)——路径相对目录 fd→更安全(TOCTOU race 减少)。**readdir 返回 d_type**(DT_REG=普通文件, DT_DIR=目录, DT_LNK=符号链接)——省去对每个 entry 做额外 stat 调用——NIO Files.list 只返回文件名——不需要 stat 开销。

### 2. "LinuxWatchService — inotify 文件变更监视"

场景: `FileSystems.getDefault().newWatchService()`→LinuxWatchService→inotify_init→register(path, ENTRY_CREATE, ENTRY_DELETE, ENTRY_MODIFY)→inotify_add_watch→poll events queue→StandardWatchEventKinds。

**LinuxWatchService** (`LinuxWatchService.c:72-153`):
```
Java_sun_nio_fs_LinuxWatchService_inotifyInit(env, this) (line 72):
  → inotify_init() → return int fd

Java_sun_nio_fs_LinuxWatchService_inotifyAddWatch(env, fd, address, mask) (line 83):
  → path = jlong_to_ptr(address) → inotify_add_watch(fd, path, mask) → return wd
  → mask: IN_CREATE|IN_DELETE|IN_MODIFY|IN_MOVED_FROM|IN_MOVED_TO

Java_sun_nio_fs_LinuxWatchService_poll(env, fd1, fd2) (line 133):
  → struct pollfd ufds[2] = {{fd1, POLLIN}, {fd2, POLLIN}}
  → poll(ufds, 2, -1) — 阻塞直到 inotify fd 有事件可读
  → if EINTR: return 0 (Java 层重试)
  → return n (就绪 fd 数量)
[C++: LinuxWatchService.c——poll(2) 同时监视 inotify fd + socketpair(用于 Java 层通知)——返回后 Java 层 read(2) 消费事件]
[内核: inotify_add_watch→VFS inotify subsystem→文件 inode 被修改→kernel push event to watch queue→poll(2) returns readable]
```
- 源码: `LinuxWatchService.c:50-100` (inotifyInit) + `LinuxWatchService.c:100-200` (inotifyAddWatch + poll events)

- 关键设计: **inotify 是 kernel subsystem** — events 在 kernel 中排队→用户态通过 `poll(2)` 等待(`LinuxWatchService.c:144`→`poll(ufds, 2, -1)`)→返回后 Java 层 `read(2)` 消费 event bytes。`inotify_init()` 创建非阻塞 inotify fd——较旧的 kernel API(非 `inotify_init1`)——需要后续显式 `fcntl(F_SETFD, FD_CLOEXEC)` 或 exec 前手动 close。**inotify 的递归限制** — 对每个 sub-directory 必须显式 `inotify_add_watch`→不能递归监视——Java 层在 WatchKey 注册时递归 all sub-dirs(用 Files.walk)。

---

### 核心悬念

**"UnixNativeDispatcher: stat→BasicFileAttributes, openat→fd, fdopendir→DIR*, readdir→d_type(DT_REG/DT_DIR)。LinuxWatchService: inotify_init1(IN_CLOEXEC)→inotify_add_watch(IN_CREATE|IN_DELETE|IN_MODIFY)→read(fd, events)→poll。FileSystem NIO = POSIX syscall JNI + Linux inotify。"** — 下一篇: 域44 Class Verification。

> → 域44 Class Verification
