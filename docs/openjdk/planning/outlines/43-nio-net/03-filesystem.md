# 03. NIO FileSystem — stat/readdir/inotify

> 🟡 Working | POSIX syscall JNI + inotify 文件监视
> 读者处境: `Files.readAttributes(path, "*")`→UnixNativeDispatcher.stat→struct stat→BasicFileAttributes。`Files.list(dir)`→openat+fdopendir+readdir→Stream<Path>。`WatchService`→inotify_init→inotify_add_watch(IN_CREATE|IN_DELETE|IN_MODIFY)→poll events→StandardWatchEventKinds。

> ⚠️ 写作期修正(2026-08-16,43-nio-net/03 完成,43 域收官,第 6 批收官):
> - **"stat0 收 String + JNU_GetPlatformString" 错(重要)**: 路径统一走 **jlong 地址**——Java 侧 copyToNativeBuffer(UnixNativeDispatcher.java:39,NativeBuffer=NativeBuffers.java:35)→stat0(buffer.address(), attrs)(:298-311);C 侧 `jlong_to_ptr(pathAddress)`(UnixNativeDispatcher.c:548);**stat64 非 stat**(:546)
> - **"openat0 的 dfd==AT_FDCWD 分支" 编造**: 真实=**my_openat64_func 运行时函数指针**(init 时 dlsym(RTLD_DEFAULT, "openat64"),:262-267)+RESTARTABLE(:458);openat(dfd 相对路径)减少 TOCTOU 竞态 ✓
> - **"fdopendir(env, this, dfd, path)" 签名错**: 真实 fdopendir(:748)只收 dfd(jlong 地址);opendir0(:733)收 pathAddress;readdir(:774)收 DIR* 的 jlong
> - **"readdir 返回 d_type(DT_REG/DT_DIR)省 stat" 编造(重要)**: JDK11 readdir 只把 **d_name 拷成字节数组**返回(:774-793,readdir64),d_type 不看;strace 里 getdents64=glibc readdir 内部实现
> - **inotify 行号 ✓**(eventSize :49/eventOffsets :55 布局五元组/inotifyInit :72=**inotify_init() 旧 API**(悬念段 inotify_init1 误记)/inotifyAddWatch :83/inotifyRmWatch :97/configureBlocking :106/socketpair :118/poll :133)
> - **"Java 层在 WatchKey 注册时递归子目录(Files.walk)" 编造**: implRegister(LinuxWatchService.java:208-262)只对传入目录一次 inotifyAddWatch(:260),**不递归**;子目录由使用方逐个注册
> - **Poller 消费链(大纲漏,重要)**: run(:310)→poll(ifd, socketpair[0])(:316)阻塞→read(ifd, address, BUFFER_SIZE)(:320)→unsafe 按 eventOffsets 解析变长事件(wd/mask/len+name 去尾部 null 对齐,:323-352)→maskToEventKind(:384-390): IN_CREATE/MOVED_TO→ENTRY_CREATE、IN_DELETE/MOVED_FROM→ENTRY_DELETE、IN_MODIFY/IN_ATTRIB→ENTRY_MODIFY——**inotify 无"移动"事件,JDK 合成 CREATE/DELETE**;register/close 写 socketpair(:201)自唤醒
> - **悬念指向错**: "域44 Class Verification"过期(44 域第 4 批已完结)——正确 **22-deoptimization/01**(第 7 批开篇,"编译代码什么时候回退？— Deopt 决策表")
> - 素材: 33-nio-fs-strace.txt(stat("/tmp/fsdemo/a.txt",S_IFREG|0644,size=5)/openat+getdents64 3 entries/inotify_init+add_watch(IN_MODIFY|IN_ATTRIB|IN_MOVED_FROM|IN_MOVED_TO|IN_CREATE|IN_DELETE)+rm_watch)

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
