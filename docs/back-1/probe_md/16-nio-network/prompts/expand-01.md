# EXPAND PROMPT: 扩容 01-Socket-Data-Close.md（~3500 行缺口）

## 目标

当前文档 1470 行，需要扩容到 ~5000 行。本次只修复以下缺口。

---

## 缺口 1: read(DirectBuffer) 拆分 5 子板块 (+1300 行) — **最重要**

### 4a. DirectBuffer 分配全链路 (~350 行)

**要讲的内容(不只是源码翻译)**:

- `Bits.reserveMemory(size, cap)` 的配额管理: 全局 `maxMemory` 原子计数器 → 如果不足 → `tryPreserve` 调用 `System.gc()` → 仍不足 → `OutOfMemoryError("Direct buffer memory")`
- `UNSAFE.allocateMemory(size)` → jvm.cpp `Unsafe_AllocateMemory` → `os::malloc(size)` → 走 glibc malloc 还是 mmap？取决于 size (默认 >128K 走 mmap)
- `this.address = base` → Java long 存储 native 指针 → 为什么安全？64-bit JVM 的 native pointer 可以完整表示为 64-bit
- `Cleaner.create(this, new Deallocator(base, size, cap))` → Cleaner = PhantomReference + ReferenceQueue + 后台线程的完整链条

**要解释的原理**:
- 为什么不在构造器里直接用 try-finally 管理 native 内存？GC 异步语义 → DirectBuffer 在构造函数返回后可能立即被 GC → 如果用 try-finally，GC 回收时 native 内存还没释放 → 泄漏
- PhantomReference 为什么是最佳方案？WeakReference 在对象不可达后立即被清除 → 但 native 内存释放必须在对象上已经完成后 → PhantomReference 的 "对象已回收但引用还在队列中" 提供了这个保障

### 4b. read0 内核数据路径 (~350 行)

**要讲的内容**:

- `((DirectBuffer)buf).address() + pos` → 为什么加 pos？DirectBuffer 的 capacity 定义是分配时的 size → 但 position 此后移到已读位置 → address+pos 是当前要写入的位置
- `FileDispatcherImpl.read0` → `void *buf = (void *)jlong_to_ptr(address)` → 这不是普通的 `int*` 转换 → 这是 **Java 中唯一的合法 native 指针存储方式** — 在 Java heap 中用 long 字段存储 native 指针，在 JNI 侧用 jlong_to_ptr 恢复
- `read(fd, buf, len)` → kernel `tcp_recvmsg()` → `sock->ops->recvmsg` → 从 socket buffer 移动数据到用户态 → DMA 帮助完成
- `convertReturnVal` 的 errno 映射: EAGAIN→IOS_UNAVAILABLE, EINTR→IOS_INTERRUPTED, 0→IOS_EOF, errno→IOS_THROWN

**要解释的原理**:
- DirectBuffer 和 read() syscall 的配合: DMA 直接写入 native 地址，CPU 不碰数据 — 这就是"零拷贝 I/O"的前提
- Java heap 对象地址不稳定的根本原因: GC 压缩 (compaction) → 拷贝收集 → 对象物理地址改变 → 如果你在 read() 时传入 Java heap 地址，GC 并行移动对象 → 数据写到错误地址

### 4c. HeapBuffer fallback (~150 行)

- 为什么需要 fallback？Java 代码可能用 `ByteBuffer.allocate(8192)` (HeapBuffer) 而非 DirectBuffer
- 临时 DirectBuffer 分配 → memcpy heap→native → read(fd, native) → memcpy native→heap → 释放临时 DirectBuffer
- 不是 bug — 是兼容遗留代码的代价
- 量化: 1MB buffer 的额外开销 ~2ms — 总共 ~2.1ms vs DirectBuffer's ~0.1ms

### 4d. Scatter/Gather (~250 行)

- `IOVecWrapper` 用 `AllocatedNativeObject` 在 native 堆分配 `struct iovec[]` → 每个 iovec 是 {void* iov_base, size_t iov_len} → 16 bytes on x86-64
- `putBase/putLen` → Unsafe.putLong(address, offset, value) → 操作 native 内存
- `readv(fd, iov, cnt)` → 内核按 iovec 顺序填充数据 → 一次 syscall 完成多个 buffer 的读取
- 适用场景: HTTP header + body 分割读取 → header 读到一个 buffer，body 读到另一个 buffer

### 4e. Deallocator 生命周期 (~200 行)

- DirectByteBuffer 不可达 → GC → PhantomReference 被队列 → Cleaner 线程 (不是 GC 线程!) 从队列拉取 → Deallocator.run() → Unsafe.freeMemory
- 陷阱: old gen promotion + no Full GC → native 内存累积到系统 OOM
- `-XX:+DisableExplicitGC` 阻止 System.gc() → 切断强制 Full GC 的最后手段
- Netty 的 PooledByteBufAllocator 为什么不依赖 GC 回收 — 自己管理池避免 Cleaner 的时序不确定性

---

## 缺口 2: connect() 板块 (+500 行)

### 要加的内容

**A. TCP 状态机 (~200 行)**

- CLOSED → connect() → SYN_SENT → receive SYN+ACK → ESTABLISHED (成功)
- CLOSED → connect() → SYN_SENT → receive RST → CLOSED (拒绝)
- connect() 返回 EINPROGRESS → 进入 SYN_SENT → 内核继续握手 → 应用通过 epoll 等待
- getsockopt(SO_ERROR) 返回的错误: ECONNREFUSED (port closed), EHOSTUNREACH (no route), ENETUNREACH (network down)

**B. tcp_syn_retries 控制 (~150 行)**

- 内核 `/proc/sys/net/ipv4/tcp_syn_retries` (default 6) → 1+2+4+8+16+32 = 63s → 加上最后超时 ~127s
- Java 的 `Socket.connect(addr, timeout)` → timeout 控制 Java 层面的等待 → 但内核仍然以自己的重试逻辑进行
- 如果你 select(5000ms) 然后 assumed timeout → connect 实际可能在 5001ms 时成功 → 需要额外的 SO_ERROR 检查或 shutdown(fd, 2)

**C. EPOLLOUT vs SO_ERROR 双重验证的必要性 (~150 行)**

- epoll 通知 fd 可写 → 可写 ≠ 连接已建立 — RST 也使 socket 可写
- getsockopt(SO_ERROR) 是唯一的可靠状态检查 → 读取后内核自动清除
- checkConnect 的 POLLHUP 额外检查: 对端在握手时发 FIN/RST

---

## 缺口 3: close() dup2 (+700 行)

### BLOCKING_IO_RETURN_INT 的完整解释 (~200 行)

- `startOp(fdEntry, &self)` → 将当前线程注册到 fdEntry->threads 链表
- `ret = FUNC` → 执行实际 I/O (read/write/accept/connect)
- `endOp(fdEntry, &self)` → 从链表移除 + 检查 fdEntry->intr → 如果被 closefd 标记则覆写 errno=EBADF
- 为什么 NIO 的 epoll_wait 不需要 BLOCKING_IO_RETURN_INT？epoll instance 持有 fd 的 struct file 引用 → dup2 替换 fd 号后 epoll 仍能通过 struct file 检测关闭
- BIO 直接操作 fd 号 → dup2 后 fd 号指向 marker → read() 在 marker 上返回 EBADF → 但这个"返回"可能已经在 syscall 内部发生 — BLOCKING_IO_RETURN_INT 是最后一道防线

### signal handler 的详细拆解 (~200 行)

- `sig_wakeup()` 为什么是空函数？它只需要"中断 syscall"这个副作用 → signal 处理流程: kernel 中断当前 syscall → kernel 调用 signal handler → handler return → kernel 使 syscall 返回 EINTR
- 为什么需要 dup2 和 signal 双层保证？dup2 使 fd 指向 marker (返回 EBADF) → 但某些内核 edge case 下 dup2 不打断正在进行的 syscall → signal 的 EINTR 作为 fallback
- 为什么用 SIGRTMAX-2？实时信号不合并—多个并发 wakeup 都会触发—vs SIGUSR1 会合并

### close 后 fd 号复用的 race 保护 (~150 行)

- dup2 后 close 前: 另一个线程的 open() 可能分配到原始 fd 号
- marker_fd 占用 + fdEntry->lock 持有 → 双重保护 → 如果竟态真的发生: dup2 后 fd 号指向 marker → 新的 socket() 不能分配到被占用的 fd 号
- closefd 最后才释放锁 — 保证 sequence: lock → dup2 → signal (全部线程唤醒) → unlock → return → 现在 fd 号安全可用

### BIO vs NIO 关闭流程对比 (~150 行)

- BIO: socketClose0 → check SO_LINGER → closefd(-1, fd) → close(fd) after dup2 prep
- NIO: implCloseSelectableChannel → implDereg (epoll_ctl DEL from Selector) → close0() → closefd
- Shared: 两者都最终进入 closefd 的 dup2 trick
- 差异: NIO 多了 epoll_ctl DEL — 必须先从 epoll instance 中注销 fd

---

## 缺口 4: Socket Options (+500 行)

### 每个 option 的场景化解释

- SO_LINGER (~200): 短连接服务器 (30K TIME_WAIT 耗尽 ephemeral ports) → SO_LINGER with l_linger=0 → RST → 跳过 TIME_WAIT → 代价: 数据完整性
- TCP_NODELAY (~100): Nagle 算法会合并小包 → 游戏服务器/实时应用 → 禁用 → 立即发送
- SO_KEEPALIVE (~100): 空闲连接检测 → 内核 2小时超时 → 应用层保活更可靠
- SO_RCVBUF/SO_SNDBUF (~100): 内核 buffer 大小调整 → 高速网络: 增大 → BDP (bandwidth-delay product) 匹配

---

## 执行命令

```
/jvm @probe_md/16-nio-network/prompts/expand-01.md
```

## 输出要求

- 在对应板块插入新内容（不替换已有）
- 每个 300+ 行的板块必须包含至少 1 个反事实 + 1 个 Linux 内核引用
- 贴源码 10-20 行 — 正文原理 80-200 行
- DirectBuffer 5 子板 (4a-4e) 必须用清晰标题分隔
