# PROMPT: 请撰写 00-Server-Selector-Engine.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

你写了一个 NIO echo server：`ServerSocketChannel.open()` → `bind(8080)` → `register(sel, OP_ACCEPT)` → `sel.select()` → `accept()` → `channel.read(buf)` → `channel.write(buf)`。一切正常——直到某天凌晨 3 点，监控报警：Select 线程 100% CPU。

Selector thread 100% CPU spin: `select()` returns 0 immediately in tight loop, consuming 100% CPU core. No exception, no error log—just infinite CPU burn.

Root cause: Linux < 2.6.27 kernel bug in `fs/eventpoll.c:ep_remove()` — when the last watched fd is removed from the epoll instance, `ep_remove()` unlinks the `struct epitem` from the red-black tree but fails to clear the item's connection in the ready-list (rdllist). A stale `epitem` with an invalid `ffd.file` remains linked in the ready-list. Every subsequent `epoll_wait` call traverses the ready-list, finds this stale item, tries to copy its events to userspace, sees `ffd.file` is NULL, returns 0 events instead of blocking.

Java side impact: `EPollSelectorImpl.doSelect` (EPollSelectorImpl.java:102-138) calls `EPoll.wait()`, gets `numEntries=0`, but since `numEntries != IOStatus.INTERRUPTED(-3)`, the `while` loop exits immediately and `processEvents(0, action)` returns 0 → `doSelect` returns 0 → the caller repeats the cycle.

Trigger: RecycledSelector pattern (frequently unregister+reregister the same Channel with a single Selector—common in application frameworks that create/destroy Selectors per-connection). The `epoll_ctl(EPOLL_CTL_DEL)` call is the moment the stale item gets left behind.

JDK 9+ fix: `EPollArrayWrapper` calls a specialized `epoll_ctl` variant that clears pending events before the DEL operation. Workaround on older JDKs: `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` forces poll()-based Selector, avoiding epoll entirely.

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 JDK 和内核版本边界
java -version  # JDK 6-8: affected; JDK 9+: fixed
uname -r       # Linux < 2.6.27: kernel bug present

# 2. strace 确认 epoll_wait 在 tight loop 中返回 0
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -20
# 输出: epoll_wait(5, [], 1024, -1) = 0  ← 重复出现，间隔 ~1μs
# （不是 timeout=0 的立即返回，是阻塞模式下的异常0返回）

# 3. jcmd 确认线程正在 doSelect 中循环（而非阻塞在 epoll_wait）
jcmd $(pgrep -f java) Thread.print | grep -A10 "doSelect"
# 输出: 线程在 doSelect→processUpdateQueue→epollWait 之间反复切换，频率 >1000次/秒
```

**反事实**: 如果 Java NIO 使用 edge-triggered (`EPOLLET`) → `epoll_wait` 只在 fd 状态从 not-ready→ready 时通知一次。对已删除的 fd 不会有事件进入 ready-list → 虚假唤醒根本不会发生。但 ET 的代价是每次 select 返回后应用必须循环 read/write 直到返回 EAGAIN，否则剩余数据"永远消失" — 对不熟悉 NIO 语义的开发者是巨大陷阱。Java 选择 level-triggered 的简单性，但付出了这个 10 年未修复的内核 bug 代价（Linux 2.6.25-2.6.26 的生产内核时期）。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that starts from a **complete NIO echo server Java code** (~30 lines) and traces every line down through Java NIO → JNI → Linux kernel. This is NOT a "what is epoll" tutorial — it's ENGINEERING documentation with measured file:line references, showing how `EPoll.c` (98 lines) and `EPollSelectorImpl.java` (270 lines) directly call Linux epoll syscalls.

The reader has completed **15-core-native** (JNI patterns, `JNIEXPORT`/`JNICALL` macros, `RegisterNatives` mechanism), **09-native-interface** (JNI parameter marshalling, `jlong` ↔ `void*` conversion via `jlong_to_ptr`), **11-os-layer** (epoll syscall signatures, `struct epoll_event` layout, `EPOLL_CTL_ADD/MOD/DEL` semantics). This doc: **how your `selector.select()` actually works** — from the Java code you wrote to the Linux kernel's red-black tree and ready-list.

### 你写的代码（必须出现在文档开头，作为引子）

```java
// ~30 行的 NIO echo server — 这就是本文要拆解的代码
ServerSocketChannel ss = ServerSocketChannel.open();
ss.bind(new InetSocketAddress(8080));
ss.configureBlocking(false);

Selector sel = Selector.open();
ss.register(sel, SelectionKey.OP_ACCEPT);   // ← 这里发生了什么？

while (true) {
    sel.select();                            // ← 这一行浪费了 100% CPU
    Iterator<SelectionKey> it = sel.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        it.remove();
        if (key.isAcceptable()) {
            SocketChannel sc = ss.accept();  // ← 这一行触发了什么 syscall？
            sc.configureBlocking(false);
            sc.register(sel, OP_READ);
        } else if (key.isReadable()) {
            SocketChannel sc = (SocketChannel) key.channel();
            ByteBuffer buf = ByteBuffer.allocateDirect(8192);
            sc.read(buf);                    // ← 数据从哪来？（暂不深入，留给 01 文档）
            buf.flip();
            sc.write(buf);
        }
    }
}
```

### 文档按代码执行顺序逐行展开（共 9 个板块）：

| # | 板块 | 对应代码行 | 目标行数 | 核心揭秘 |
|---|------|-----------|:---:|---------|
| 1 | `ServerSocketChannel.open()` | `open()` | ~400 | `socket(AF_INET6)` + `IPV6_V6ONLY=0` 双栈 + `SO_REUSEADDR` 自动设置 → 与 `PlainSocketImpl.c` BIO 路径对比 → Linux `::ffff:a.b.c.d` mapped 地址 |
| 2 | `server.bind(8080)` | `bind(8080)` | ~300 | `Net.bind0` → `NET_Bind` → POSIX `bind()` → `EADDRINUSE` 错误全景 → `SO_REUSEADDR` 与 TIME_WAIT 交互 → 内核端口分配机制 |
| 3 | `server.listen(50)` | `listen(50)` | ~200 | `Net.listen` → POSIX `listen(fd, backlog)` → `min(backlog, somaxconn)` 内核静默截断 → TCP SYN 队列 vs accept 队列 → `ss -lnt` 诊断 |
| 4 | `Selector.open()` | `Selector.open()` | ~1300 | 核心: `epoll_create(256)` size hint 真相 (Linux 2.6.8+ 忽略) → 内核 `struct eventpoll` — 红黑树 + ready-list 双向链表 → `allocatePollArray` + `sizeof(epoll_event)`/`offsetof` 动态 struct layout 查询 → `IOUtil.makePipe(false)` — `pipe(fd)` + `fcntl(O_NONBLOCK)` 双端 → `((jlong)fd0 << 32) | fd1` 打包 → `epoll_ctl(ADD, fd0, EPOLLIN)` 注册 wakeup pipe |
| 5 | `ss.register(sel, ACCEPT)` | `register()` | ~600 | `AbstractSelectableChannel.register()` → `SelectorImpl.register()` → `fdToKey.putIfAbsent(fd, ski)` → `setEventOps(ski)` → `updateKeys` Deque 延迟队列 → 为什么延迟：epoll_ctl 是昂贵 syscall → `processUpdateQueue()` 批量 epoll_ctl ADD/MOD/DEL → `EPoll.ctl()` 进入 native → `epoll_ctl(epfd, opcode, fd, &event)` → `event.data.fd = fd` → 内核 `ep_insert()` 插入红黑树 O(logN) 在 `ep->mtx` 下 |
| 6 | `sel.select()` | `select()` | ~1300 | 核心: `lockAndDoSelect()` 获取 Selector 内部锁 → `processUpdateQueue()` 先处理延迟注册 → `processDeregisterQueue()` → `doSelect()` 核心循环 → `begin(blocking)` → `EPoll.wait()` → `jlong_to_ptr(address)` 转换 → `epoll_wait(epfd, events, 1024, timeout)` 阻塞 → EINTR 中断处理: SIGPROF @100Hz → `to -= elapsed` 精确超时调整 → `processEvents(numEntries, action)` → `EPoll.getEvent(address+12*i)` → `EPoll.getDescriptor(event)` = `Unsafe.getInt(addr+4)` → `fdToKey.get(fd)` HashMap O(1) → level-triggered 证明: `EPoll.java` 只有 `EPOLLIN=0x1, EPOLLOUT=0x4` — 无 `EPOLLET` → `translateInterestOps()` 只返回这三者 → NUM_EPOLLEVENTS=1024 设计: 旧栈安全 + LT 保证不丢事件 → IOStatus: INTERRUPTED=-3, THROWN=-5 → `end(blocking)` |
| 7 | `sel.wakeup()` | `wakeup()` | ~500 | pipe write1 + drain + interruptTriggered 去重 + 为什么不是信号 (signal handler: async-signal-unsafe + SIGUSR1 coalescing + synchronized 死锁) |
| 8 | epoll bug 史记 | 诊断 | ~1000 | Linux <2.6.27 `ep_remove()` bug 源码级分析 → `struct epitem` 从红黑树移除但 ready-list 连接未清除 → stale epitem → `ffd.file == NULL` → `epoll_wait` 返回 0 而非阻塞 → 100% CPU → RecycledSelector 触发 → JDK 9+ 修复 → poll 降级 → **这是本文档独有的深层分析，02 文档只从诊断视角引用此内容** |
| 9 | Mermaid + 诊断 | — | ~400 | 4-lane 全链路序列图: Java → NIO → JNI → Kernel → GDB 6 断言 → strace 完整 trace → `/proc/{pid}/fd/` + `/proc/{pid}/fdinfo/` → jstack |

### Interview Story Format Answer（必须出现在 §一 末尾，~350 字）

"Your `Selector.open()` creates an epoll file descriptor via `epoll_create(256)` (EPoll.c:61) — the 256 is a legacy size hint ignored since Linux 2.6.8, confirmed by the EPoll.c:60 comment `/* size hint not used in modern kernels */`. The kernel allocates a `struct eventpoll` with a red-black tree (all monitored fds, O(log N) insert/delete) and a ready-list (fds with pending events, O(1) retrieval). A wakeup pipe is created via `IOUtil.makePipe(false)` (IOUtil.c:86-105): `pipe(fd)` + `fcntl(O_NONBLOCK)` — the read-end (fd0) is registered with `epoll_ctl(ADD, fd0, EPOLLIN)`. When your code calls `channel.register(sel, OP_READ)`, `setEventOps(ski)` pushes the interest change to an `updateKeys` Deque — NOT immediately epoll_ctl — because epoll_ctl is an expensive syscall (context switch + kernel mutex + rbtree insertion). At `sel.select()`, `doSelect()` (EPollSelectorImpl.java:102-138) first calls `processUpdateQueue()` to batch-apply all pending ADD/MOD/DEL via `epoll_ctl(epfd, opcode, fd, &event)` (EPoll.c:69-80), then `EPoll.wait()` converts the Java long `pollArrayAddress` to a C pointer via `jlong_to_ptr`, and calls `epoll_wait(epfd, events, 1024, timeout)` which blocks until events arrive or timeout expires. On return, `processEvents()` (EPollSelectorImpl.java:181-207) iterates the C-level `epoll_event` array at offset `address + 12*i`: reads the `events` field (offset 0) and `data.fd` (offset 4) via `Unsafe.getInt`, looks up `fdToKey.get(fd)` (HashMap O(1)), and translates native events to Java ready ops. Java NIO uses level-triggered epoll — proven by `EPoll.java:63-64` only defining `EPOLLIN=0x1` and `EPOLLOUT=0x4`, with no `EPOLLET` constant anywhere. The wakeup mechanism uses a pipe rather than POSIX signals because signal handlers can't safely access `fdToKey` HashMap or hold `synchronized` locks (non-reentrant deadlock risk). The Linux <2.6.27 `ep_remove()` bug is the most infamous production issue: stale epitems survive in the ready-list after fd removal, causing `epoll_wait` to return 0 instead of blocking, producing 100% CPU spin on legacy kernels."

### Beginner Callout Boxes（文档中必须出现的 6 个 callout 框）

1. **epoll vs select/poll — O(1) vs O(n)**: `select()` scans ALL fds every call → O(n). `poll()` same but no `FD_SETSIZE` (1024) limit. `epoll` registers fds once via `epoll_ctl` (inserts into red-black tree, O(log N)), then `epoll_wait` only returns fds from the ready-list (a doubly-linked list of epitems with pending events) → O(1) per ready fd. For 10K connections: select = 10ms/scan (1μs per fd check × 10K), epoll = 0.01ms (10 ready fds × 1μs copy). Source: `man 7 epoll`, kernel `fs/eventpoll.c`.

2. **Level-triggered vs Edge-triggered — Java's choice**: Level-triggered (Java NIO default): `epoll_wait` returns an fd as long as its I/O buffer has data. If you read 4KB of 8KB → the fd is still ready → next `select()` returns it again. Edge-triggered (`EPOLLET`, value `1U << 31`): fd returned ONCE when buffer transitions from empty→non-empty → must read until `EAGAIN` in a loop. **Proof**: `EPoll.java:63-64` defines only `EPOLLIN=0x1`, `EPOLLOUT=0x4` — no `EPOLLET` constant. `SocketChannelImpl.translateInterestOps()` only returns `EPOLLIN|EPOLLOUT|0`. Java chose LT for simplicity — legacy code that assumes "select returns same fd until data exhausted" works correctly.

3. **epoll_create(256) — ignored size hint**: `man 2 epoll_create`: "Since Linux 2.6.8, the size argument is ignored, but must be greater than zero." The kernel (`fs/eventpoll.c:SYSCALL_DEFINE1(epoll_create, int, size)`) checks `size <= 0 → -EINVAL`, then ignores size and allocates an empty `struct eventpoll` with `RB_ROOT` (empty red-black tree) and `INIT_LIST_HEAD(&ep->rdllist)`. The value 256 in `EPoll.c:61` is a legacy from Linux 2.4/2.5 era where size pre-allocated a fixed-size hash table. EPoll.c:60 comment: `/* size hint not used in modern kernels */`.

4. **fdToKey — int fd → SelectionKey HashMap**: `EPollSelectorImpl.java:66`: `private final Map<Integer, SelectionKeyImpl> fdToKey = new HashMap<>()`. When `epoll_wait` returns ready fds, each `epoll_event.data.fd` (a 32-bit int in the `epoll_data_t` union) is extracted via `EPoll.getDescriptor(event)` (`Unsafe.getInt(addr + 4)`), then `fdToKey.get(fd)` does O(1) HashMap lookup. Why not `array[fd]`? Linux fd numbers are NOT contiguous — `[0,1,2,5,200,5432]` — HashMap handles sparse fd space efficiently at ~2KB overhead vs array waste of 512KB.

5. **Wakeup pipe — pipe()'s 1-byte side-effect**: `IOUtil.makePipe(false)` (IOUtil.c:86-105): `pipe(fd)` + `configureBlocking(fd[0], JNI_FALSE)` + `configureBlocking(fd[1], JNI_FALSE)` sets O_NONBLOCK on both ends → packed return: `((jlong)fd[0] << 32) | fd[1]`. Constructor registers read-end (fd0) via `epoll_ctl(ADD, fd0, EPOLLIN)`. `selector.wakeup()` (EPollSelectorImpl.java:250-262): `synchronized(interruptLock)` → if `!interruptTriggered` → `IOUtil.write1(fd1, (byte)0)` → native `write(fd, &c, 1)` (IOUtil.c:107-112). The kernel detects 1 byte in pipe read-end buffer → marks fd0 as EPOLLIN ready → next `epoll_wait` returns fd0 → `processEvents` detects `fd == fd0` → `clearInterrupt()` (EPollSelectorImpl.java:264-268): `synchronized(interruptLock)` → `IOUtil.drain(fd0)` loops `read()` in 16-byte chunks until `EAGAIN`. The `interruptTriggered` flag prevents multiple wakeup calls from writing duplicate bytes.

6. **NUM_EPOLLEVENTS=1024 — 栈安全 + LT 保证**: `EPollSelectorImpl.java:53`: `private static final int NUM_EPOLLEVENTS = Math.min(IOUtil.fdLimit(), 1024);`. `IOUtil.fdLimit()` (`IOUtil.c:151-165`) = `getrlimit(RLIMIT_NOFILE)` → ulimit -n (default 1024 or 65536). 1024 × 12 bytes = 12,288 bytes ≈ 12KB. Historical: older JDK (EPollArrayWrapper.c) allocated `epoll_event[1024]` on stack → with ~8KB default stack → overflow → SIGSEGV. JDK 11 fix: uses `Unsafe.allocateMemory` (native heap). Level-triggered ensures no event loss: if ready fds > 1024 → epoll_wait fills first 1024 → remaining stay in ready-list → next select returns them. Netty's EpollEventLoop: typically 10-100 ready fds per cycle → 1024 is more than sufficient.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/linux/native/libnio/ch/EPoll.c` — 98 lines, all epoll syscalls (create/ctl/wait) + struct layout queries
- `src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java` — 270 lines, Java-level Selector engine
- `src/java.base/linux/classes/sun/nio/ch/EPoll.java` — 122 lines, native declarations + epoll_event struct layout + Unsafe memory ops
- `src/java.base/unix/native/libnio/ch/IOUtil.c` — 230 lines, makePipe/write1/drain/fdLimit/configureBlocking
- `src/java.base/linux/classes/sun/nio/ch/EPollSelectorProvider.java` — SPI: openSelector()
- `src/java.base/share/classes/sun/nio/ch/SelectorImpl.java` — lockAndDoSelect, register, implCloseSelector
- `src/java.base/share/classes/sun/nio/ch/IOStatus.java` — INTERRUPTED=-3, THROWN=-5, UNAVAILABLE=-2

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libnio.so` — EPoll.c + IOUtil.c compiled into this

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **EPoll.c** | `src/java.base/linux/native/libnio/ch/EPoll.c` | 98 | `Java_sun_nio_ch_EPoll_create`(:58-66, `epoll_create(256)`), `Java_sun_nio_ch_EPoll_ctl`(:68-80, ADD/MOD/DEL, `epoll_ctl`), `Java_sun_nio_ch_EPoll_wait`(:82-97, `epoll_wait` + EINTR→IOS_INTERRUPTED), `Java_sun_nio_ch_EPoll_eventSize/eventsOffset/dataOffset`(:40-56, `sizeof`/`offsetof` queries) | 🔥 Hot path native — every epoll syscall enters here |
| 2 | **EPollSelectorImpl.java** | `src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java` | 270 | Constructor(:76-94, epfd + wakeup pipe + pollArrayAddress), `doSelect`(:102-138, EINTR loop + timeout adjustment), `processUpdateQueue`(:143-175, batch epoll_ctl ADD/MOD/DEL), `processEvents`(:181-207, fdToKey mapping), `wakeup`(:250-262, pipe write), `clearInterrupt`(:264-268, pipe drain) | 🔥 Java-level Selector — bridges NIO API to EPoll.c |
| 3 | **EPoll.java** | `src/java.base/linux/classes/sun/nio/ch/EPoll.java` | 122 | Native method declarations, `SIZEOF_EPOLLEVENT`/`OFFSETOF_EVENTS`/`OFFSETOF_FD` (populated via JNI queries to EPoll.c), `allocatePollArray`(Unsafe.allocateMemory), `getEvent/getDescriptor/getEvents`(direct native memory read/write), `EPOLLIN`/`EPOLLOUT`/`EPOLLONESHOT` constants | Java side of epoll_event struct |
| 4 | **IOUtil.c** | `src/java.base/unix/native/libnio/ch/IOUtil.c` | 230 | `makePipe`(:86-105, pipe + fcntl O_NONBLOCK), `write1`(:107-112, wakeup 写), `drain`(:114-129, pipe 读空), `fdLimit`(:151-165, getrlimit), `configureBlocking`(:70-76, fcntl F_GETFL/F_SETFL) | Wakeup pipe utilities |
| 5 | **EPollSelectorProvider.java** | `src/java.base/linux/classes/sun/nio/ch/EPollSelectorProvider.java` | ~40 | `openSelector()` → `new EPollSelectorImpl(this)` | SPI factory |

---

## §四 Deep Dive Question Groups（≥8，EXACT questions + answer directions）

### 4.1 ★★★ epoll_create(256) — size hint ignored since Linux 2.6.8

```
问题：
  ① EPoll.c:58-66 的 epoll_create(256) — 256 在内核中是什么意思？为什么源码写 256？
      答案方向: 源码: EPoll.c:58-66:
          JNIEXPORT jint JNICALL
          Java_sun_nio_ch_EPoll_create(JNIEnv *env, jclass clazz) {
              /* size hint not used in modern kernels */       // ← EPoll.c:60 注释
              int epfd = epoll_create(256);                    // ← 256 is the "size" hint
              if (epfd < 0) JNU_ThrowIOExceptionWithLastError(env, ...);
              return epfd;
          }
        `man 2 epoll_create`: "size is a hint about the number of file descriptors
         to be added. Since Linux 2.6.8, size is ignored but must be >0."
        内核 `fs/eventpoll.c:SYSCALL_DEFINE1(epoll_create, int, size)`:
          if (size <= 0) return -EINVAL;
          然后忽略 size，分配空 `struct eventpoll` (empty red-black tree + empty ready-list)。

        追问: 为什么不是 0 或 1？
        → 如果传 0 → 内核返回 EINVAL → EPoll.c:62 检查 epfd<0 → throw IOException。
          JDK 选择 256 是 Linux 2.4/2.5 era 的兼容值——那时 size 用于预分配哈希表，
          256 是 "预期管理 256 个 fd" 的合理默认。

        追问: epoll_create1(EPOLL_CLOEXEC) vs epoll_create(256) — JDK 为什么不用前者？
        → epoll_create1 是 Linux 2.6.27+ 引入的，JDK 11 需要兼容 2.6.18+ (RHEL 5)。
          EPOLL_CLOEXEC 可以避免 fork()+exec() 中 fd 泄漏，但 JDK 用额外的 close-on-exec 设置。
          这是兼容性优先的务实选型。

  ② Counterfactual: 如果 size 仍然被使用（pre-2.6.8 行为）？
      答案方向: 内核用 size 预分配 `struct eventpoll` 的内部哈希表。
        256 → ~256×12 bytes = 3KB 固定分配。如果应用实际管理 10K fd →
        哈希表过度增长（rehash 每次加倍）→ 额外内存碎片。
        现代内核 auto-size → 初始空红黑树 + 就绪链表, 按需增长 → 初始 0 额外内存。
        决策点: EPoll.c:61 `epoll_create(256)` — 256 is pure legacy, zero functional impact.
```

### 4.2 ★★★ epollCtl — ADD/MOD/DEL 三种操作码

```
问题：
  ① EPoll.c:68-80 的 epollCtl 如何实现 ADD/MOD/DEL？为什么 events 字段无 EPOLLET？
      答案方向: 源码: EPoll.c:68-80:
          JNIEXPORT jint JNICALL
          Java_sun_nio_ch_EPoll_ctl(JNIEnv *env, jclass clazz,
              jint epfd, jint opcode, jint fd, jint events) {
              struct epoll_event event;
              event.events = events;    // ← Java 侧传入, 值来自 translateInterestOps()
              event.data.fd = fd;       // ← 在 union epoll_data 中存 int fd
              int res = epoll_ctl(epfd, (int)opcode, (int)fd, &event);
              return (res == 0) ? 0 : errno;  // ← 返回 errno 而非 -1
          }
        opcode 值: EPoll.java:58-60: EPOLL_CTL_ADD=1, EPOLL_CTL_MOD=2, EPOLL_CTL_DEL=3。
        调用来源: EPollSelectorImpl.processUpdateQueue (EPollSelectorImpl.java:143-175):
        - newEvents==0 → epollCtl(DEL, fd, 0) — channel 不再有兴趣
        - registeredEvents==0 → epollCtl(ADD, fd, newEvents) — 新注册
        - 否则 → epollCtl(MOD, fd, newEvents) — 修改已有 fd 的事件
        注意 `return (res == 0) ? 0 : errno;` —— 不抛异常，让 Java 侧决定如何处理 errno。

        追问: ADD 后立即 DEL 有竞态吗？
        → 内核 `fs/eventpoll.c:ep_insert()` 在对 epoll instance 内部锁
          `ep->mtx` (mutex) 下执行。如果 DEL 在 ADD 完成前到达 → DEL 等待 mutex →
          ADD 完成释放 mutex → DEL 获取锁并删除刚插入的 epitem → 最终 epitem 被正确删除。
          但: 如果在 ADD 和 DEL 之间 fd 产生事件 → 事件被插入 ready-list →
          DEL 的 ep_remove() 会正确从 ready-list 中删除该 epitem → 无泄露。
          唯一的 bug: Linux <2.6.27 ep_remove() （即 §〇 描述的 bug）——与 ADD/DEL 时序无关。

  ② Counterfactual: 如果 Java 添加了 EPOLLET 支持 → translateInterestOps() 在返回
      EPOLLIN|EPOLLOUT 基础上 OR 上 EPOLLET (0x80000000) → epoll_wait 变为 edge-triggered。
      代价: SocketChannel.read() 必须改为 non-blocking + loop until EAGAIN —
      单次 read 如果不彻底消费所有数据, 剩余数据永远不会触发下次事件通知。
      决策点: EPoll.java:63-64 只有 EPOLLIN=0x1, EPOLLOUT=0x4 — 无 EPOLLET 常量。
```

### 4.3 ★★★ epollWait — jlong_to_ptr + EINTR retry

```
问题：
  ① EPoll.c:82-97 的 epollWait 如何处理 Java long addr → C pointer？如何响应 EINTR？
      答案方向: 源码: EPoll.c:82-97:
          JNIEXPORT jint JNICALL
          Java_sun_nio_ch_EPoll_wait(JNIEnv *env, jclass clazz,
              jint epfd, jlong address, jint numfds, jint timeout) {
              struct epoll_event *events = jlong_to_ptr(address);  // ← Java long→C pointer
              int res = epoll_wait(epfd, events, numfds, timeout);
              if (res < 0) {
                  if (errno == EINTR) { return IOS_INTERRUPTED; }  // -3
                  JNU_ThrowIOExceptionWithLastError(env, ...);
                  return IOS_THROWN;                                // -5
              }
              return res;  // 就绪 fd 数量, ≥0
          }
        `jlong_to_ptr(address)`: 本质是 `(void*)(uintptr_t)jlong_val` — 强制类型转换。
        Java 的 `long` 可以安全存储 64-bit 地址 (x86-64 address space)。
        address 来自 `EPoll.allocatePollArray(1024)` = `Unsafe.allocateMemory(12288)`。

        EINTR 恢复: EPollSelectorImpl.java:118-130:
          do {
              long startTime = timedPoll ? System.nanoTime() : 0;
              numEntries = EPoll.wait(epfd, pollArrayAddress, NUM_EPOLLEVENTS, to);
              if (numEntries == IOStatus.INTERRUPTED && timedPoll) {
                  long adjust = System.nanoTime() - startTime;
                  to -= TimeUnit.MILLISECONDS.convert(adjust, TimeUnit.NANOSECONDS);
                  if (to <= 0) { numEntries = 0; }
              }
          } while (numEntries == IOStatus.INTERRUPTED);

        追问: 什么信号产生 EINTR？
        → JVM Profiling (SIGPROF @ 100Hz) — HotSpot 用此信号做 sampling profiler。
          JVM 内部的 safepoint polling。没有外部信号 → EINTR 只在这些 JVM 内部场景出现。

        追问: `begin(blocking)` / `end(blocking)` 在 doSelect 中做什么？
        → SelectorImpl 跟踪方法 — 用于虚拟线程 (Loom) 支持。begin 将 Selector 标记为阻塞 →
          虚拟线程调度器可以释放 carrier thread。end 在 epoll_wait 返回后恢复。
          try/finally 确保 end 永远被调用。

        追问: `processDeregisterQueue` 为什么在 epoll_wait 前后各调一次？
        → 前: 处理之前 cancel() 的 key → 确保本次 select 不返回已取消的 key。
          后: 处理 select 期间被 cancel() 的 key → 确保后续操作看到最新状态。

  ② Counterfactual: 不调整剩余超时 → 每次 SIGPROF 中断重置计时 →
      100Hz profiler 下 select(5000ms) 可能阻塞 ∞。
      决策点: EPollSelectorImpl.java:121-128 — precise timeout adjustment is essential。
```

### 4.4 ★★★ fd→SelectionKey mapping — native fd 到 Java 对象的桥

```
问题：
  ① EPollSelectorImpl.java 如何把 epoll_event.data.fd (int) 映射到 SelectionKey 对象？
      答案方向: 数据结构: EPollSelectorImpl.java:66:
          private final Map<Integer, SelectionKeyImpl> fdToKey = new HashMap<>();
        
        processEvents (EPollSelectorImpl.java:181-207) 处理流程:
          for (int i=0; i<numEntries; i++) {
              long event = EPoll.getEvent(pollArrayAddress, i);   // address + 12*i
              int fd = EPoll.getDescriptor(event);                // Unsafe.getInt(addr+4)
              if (fd == fd0) { interrupted = true; }              // wakeup pipe
              else {
                  SelectionKeyImpl ski = fdToKey.get(fd);         // HashMap O(1)
                  if (ski != null) {
                      int rOps = EPoll.getEvents(event);         // Unsafe.getInt(addr+0)
                      numKeysUpdated += processReadyEvents(rOps, ski, action);
                  }
              }
          }

        struct epoll_event 12 bytes on x86-64:
          offset 0: uint32_t events   (4 bytes, EPOLLIN=0x001 etc.)
          offset 4: epoll_data_t data (8 bytes, union {void*ptr; int fd; uint32_t u32; uint64_t u64})
        Java 存的是 data.fd — 内核在 `ep_insert()` 时从 `epoll_event` 复制到 `struct epitem` 中。

        getEvent/getDescriptor/getEvents (EPoll.java:86-102):
          static long getEvent(long address, int i) { return address + (SIZEOF_EPOLLEVENT * i); }
          static int getDescriptor(long eventAddress) { return unsafe.getInt(eventAddress + OFFSETOF_FD); }
          static int getEvents(long eventAddress) { return unsafe.getInt(eventAddress + OFFSETOF_EVENTS); }

        追问: 为什么用 HashMap 而不是 long[65536] 数组？
        → Linux fd 编号不连续: 0(stdin), 1(stdout), 2(stderr), 3(JAR), 4(listen),
          5(epoll), 6(pipe read), 7(pipe write), 8(client), 200(client), 5432(client)...
          HashMap: 100 个 Channel → 100 个 entry → ~2KB overhead。
          long[65536]: 65536 × 8 bytes = 512KB — 510KB waste for sparse fd space。

        追问: processReadyEvents 做了什么？
        → 在 SelectorImpl 中定义：将 epoll 返回的 rOps 与 ski.readyOps() 合并，
          然后调用 action.accept(ski) 或手动遍历 selectedKeys。

  ② Counterfactual: 如果 epoll_event.data 存 Java 对象指针 (jlong)?
      → 数据路径: Java → JNI → kernel epoll_ctl (copy_from_user) → 存储到内核
        struct epitem → kernel epoll_wait → copy_to_user 回用户态。内核不信任用户态指针 —
        wild pointer 可能导致 kernel OOPS/SIGSEGV。JNI jobject 是 local reference —
        只在当前 JNI 帧有效，不能持久化。决策点: EPoll.c:76 `event.data.fd = fd`。
```

### 4.5 ★★★ NUM_EPOLLEVENTS = min(fdLimit(), 1024) — 设计意图

```
问题：
  ① EPollSelectorImpl.java:53 的 NUM_EPOLLEVENTS 为什么限制为 1024？
      答案方向: `private static final int NUM_EPOLLEVENTS = Math.min(IOUtil.fdLimit(), 1024);`
        IOUtil.fdLimit() (IOUtil.c:151-165): `getrlimit(RLIMIT_NOFILE)` → ulimit -n (1024 or 65536)。
        1024 × sizeof(struct epoll_event) = 1024 × 12 = 12,288 bytes ≈ 12KB。

        历史: 旧版 JDK (EPollArrayWrapper.c) 在栈上分配 epoll_event[1024] →
        如果栈大小 = 8KB (典型 Linux 默认) → 1024 × 12 = 12KB → STACK OVERFLOW → SIGSEGV。
        JDK 11 修复: 改用 native heap (Unsafe.allocateMemory) → pollArrayAddress 是堆地址,
        不再受栈大小限制。但 1024 上限保留为 conservative safety net。

        Level-triggered 保证: 如果就绪 fd > 1024 → epoll_wait 只填充前 1024 个 →
        剩余 fd 仍在 ready-list 中 → 下次 select 会返回它们 → 事件不丢失。

        追问: 1024 够用吗？
        → Netty 的 EpollEventLoop 中: 一般 select cycle 中只有 ~10-100 个就绪 fd。
          1万个 Channel 的服务器, 同时活跃的 I/O 通常 <100 → NUM_EPOLLEVENTS=1024 绰绰有余。

  ② Counterfactual: NUM_EPOLLEVENTS=1 → 每次 select 只返回 1 个事件 →
      10K 就绪 fd → 需要 10K 次 epoll_wait 调用 → 10K × 200ns syscall overhead
      = 2ms 额外开销。1024 → 10 次调用 → 2μs。1000x improvement。
      决策点: EPollSelectorImpl.java:53。
```

### 4.6 ★★★ Level-triggered — Java NIO 的选择

```
问题：
  ① Java NIO 为什么选择 level-triggered？源码如何证明？
      答案方向: 两边源码证明:
        EPoll.java:63-67:
          static final int EPOLLIN   = 0x1;
          static final int EPOLLOUT  = 0x4;
          static final int EPOLLONESHOT = (1 << 30);
          // 无 EPOLLET 常量 (应为 0x80000000 如果存在)

        SocketChannelImpl.translateInterestOps():
          int newOps = 0;
          if ((ops & Net.POLLIN)  != 0) newOps |= EPOLLIN;
          if ((ops & Net.POLLOUT) != 0) newOps |= EPOLLOUT;
          if ((ops & Net.POLLERR) != 0) newOps |= EPOLLERR;
          return newOps;  // ← 只有这三位, 永远不会有 EPOLLET

        EPoll.c:75 event.events = events → 这些值直接传给内核 epoll_ctl。

        LT 行为: TCP socket 收到 8KB → read 4KB → socket buffer 仍有 4KB →
        内核 tcp_recvmsg 中, `copied < target` 且 sock buffer 仍有数据 →
        下一次 epoll_wait 将此 fd 留在 ready-list → 返回它。

        追问: Netty 怎么用 edge-triggered 而不依赖 JDK 的 EpollSelectorImpl？
        → Netty 有自己的 native transport (netty-transport-native-epoll) →
          绕过 JDK 的 Java 层 Selector → 直接调 epoll_create/ctl/wait →
          在 ctl 时设置 EPOLLET 标志 → 自己的 epoll event loop 循环读到 EAGAIN。
          这是框架级别的优化 — 需要程序员约定 "每次 select 后循环处理到读完"。

  ② Counterfactual: edge-triggered 是默认 → 所有 NIO 应用必须在每次 OP_READ ready
      后循环调用 channel.read() 直至返回 0 或 -1+EAGAIN, 否则剩余数据永远等待。
      大部分 NIO tutorial、StackOverflow 答案、框架代码都依赖 LT 语义 →
      改为 ET → 无声的错误: 数据到达但 select 不再返回该 fd → 应用看起来 'hang'。
      决策点: EPoll.java:63-64 无 EPOLLET 常量。
```

### 4.7 ★★★ wakeup pipe — pipe() vs 信号方案

```
问题：
  ① EPollSelectorImpl 为什么用 pipe 而非 POSIX 信号实现 cross-thread wakeup？
      答案方向: 源码: EPollSelectorImpl.java 构造函数:83-93:
          long fds = IOUtil.makePipe(false);  // 创建非阻塞 pipe
          this.fd0 = (int) (fds >>> 32);      // 读端 — 注册到 epoll 以便检测 wakeup
          this.fd1 = (int) fds;               // 写端 — wakeup() 写入 1 字节
          EPoll.ctl(epfd, EPOLL_CTL_ADD, fd0, EPOLLIN); // 注册到 epoll

        wakeup() EPollSelectorImpl.java:250-262:
          synchronized (interruptLock) {
              if (!interruptTriggered) {
                  IOUtil.write1(fd1, (byte)0);   // → IOUtil.c:107-112: write(fd, &c, 1)
                  interruptTriggered = true;     // 多 wakeup 去重
              }
          }

        clearInterrupt() EPollSelectorImpl.java:264-268:
          synchronized (interruptLock) {
              IOUtil.drain(fd0);   // → IOUtil.c:114-129: 循环 read 直到 EAGAIN, 16 字节块
              interruptTriggered = false;
          }

        IOUtil.makePipe (IOUtil.c:86-105):
          pipe(fd); configureBlocking(fd[0], JNI_FALSE); configureBlocking(fd[1], JNI_FALSE);
          return ((jlong) fd[0] << 32) | (jlong) fd[1];

        信号方案的致命问题:
        - 信号处理器运行在任意线程上下文 → 不能安全操作 Selector 共享状态
        - synchronized(interruptLock) 在信号处理器中 → Selector 线程已持锁 → 重入 → deadlock
        - POSIX async-signal-safe 函数限制: write() 是安全的; JNI functions 不是
        - 信号可能丢失: SIGUSR1 不排队 (Linux 上会合并多个 pending instance)

        追问: interruptTriggered 为什么需要？多 wakeup 会怎样？
        → 没它: 每次 wakeup 都 write() 1 字节 → pipe 累积 N 字节 → drain 一次性清空。
          问题: 每次 write 都是 syscall (~200ns) → 高频场景浪费大量 syscall。
          interruptTriggered 去重: 第一次 write，后续线程看到 flag=true 直接返回。

        追问: IOUtil.drain 为什么用 16 字节块而不是 1 字节？
        → 每个 read(fd, buf, 16) 一次 syscall。如果用 1 字节: 最多 16 次 syscall。
          16 字节块: 一次 syscall 清空 pipe → 高效。循环条件是 n == sizeof(buf) →
          只有 16+ wakeup 调用才需要第二次 read。

  ② Counterfactual: 只用信号 → pthread_kill + sig_wakeup → deadlock + 信号丢失。
      决策点: IOUtil.c:86-105 makePipe 的设计。
```

### 4.8 ★★★ eventSize/eventsOffset/dataOffset — struct layout 动态查询

```
问题：
  ① EPoll.c:40-56 的三 JNI 函数 eventSize/eventsOffset/dataOffset 在 Java 侧如何被使用？
      答案方向: 这三个函数不是 epoll 系统调用——是 struct epoll_event 的 C 布局查询。
        EPoll.c:40-44: Java_sun_nio_ch_EPoll_eventSize → sizeof(struct epoll_event) → 12
        EPoll.c:46-50: Java_sun_nio_ch_EPoll_eventsOffset → offsetof(struct epoll_event, events) → 0
        EPoll.c:52-56: Java_sun_nio_ch_EPoll_dataOffset → offsetof(struct epoll_event, data) → 4

        Java 侧 (EPoll.java:53-55):
          private static final int SIZEOF_EPOLLEVENT  = eventSize();   // JNI 查询 → 12
          private static final int OFFSETOF_EVENTS    = eventsOffset(); // JNI 查询 → 0
          private static final int OFFSETOF_FD        = dataOffset();   // JNI 查询 → 4

        allocatePollArray(count) = UNSAFE.allocateMemory(count × SIZEOF_EPOLLEVENT)
        在 native heap 分配 count × 12 bytes → 零 Java 对象开销。

        processEvents 中的读取:
          long event = address + SIZEOF_EPOLLEVENT × i;          // 计算第 i 个元素地址
          int fd = unsafe.getInt(event + OFFSETOF_FD);           // offset 4 → data.fd
          int events = unsafe.getInt(event + OFFSETOF_EVENTS);   // offset 0 → events

        为什么需要 JNI 查询而非 Java 侧 hardcode?
        → sizeof/offsetof 是 C 编译器在编译时确定的值。不同平台 (x86-64, ARM64, PPC64)
          可能有不同的 alignment 要求和结构体填充 → hardcode 12/0/4 会在非 x86-64 平台
          上产生字节级错误 (读取错误的字节偏移)。JNI 查询保证每次编译都获取当前平台
          的正确值 → 跨平台兼容。

        追问: 如果内核升级改变了 struct epoll_event 的布局？
        → unlikely but JDK only needs to recompile EPoll.c → JNI 查询返回新 layout → Java 侧无改动。
          Same benefit as cross-platform portability — decouples Java from C struct internals.

  ② Counterfactual: 不在 EPoll.c 中定义这三函数 → Java 侧 hardcode SIZEOF_EPOLLEVENT=12
      → ARM64 可能因为 alignment 需要 16 bytes padding → Java 按 12 byte stride
      读取 native 内存 → 从第 2 个元素开始所有的 fd/events 都错位 → 读到的 fd 是无意义
      的垃圾值 → fdToKey.get(garbage) → null → 静默丢失所有 I/O 事件。
      决策点: EPoll.c:40-56。
```

---

## §五 Article Structure

```
§〇 生产场景 — Selector 100% CPU spin (Linux<2.6.27 ep_remove bug)
    三步诊断 + 反事实 (EPOLLET 可避免但代价巨大)

§一 ★★★ NIO Echo Server 全链路源码走读
  1.1 ServerSocketChannel.open() — socket(AF_INET6) + IPV6_V6ONLY=0 dual-stack
  1.2 server.bind(8080) — bind0 + SO_REUSEADDR + EADDRINUSE
  1.3 server.listen(50) — min(backlog, somaxconn) 内核截断
  1.4 Selector.open() — epoll_create + allocatePollArray + wakeup pipe
  1.5 server.register(sel, OP_ACCEPT) — updateKeys Deque → processUpdateQueue batch epoll_ctl
  1.6 sel.select() — doSelect → epoll_wait + EINTR → processEvents → fdToKey
  1.7 wakeup pipe 完整故事 — IOUtil.c makePipe/write1/drain
  1.8 epoll bug 史记 — 内核源码分析 + RecycledSelector + JDK 9+ 修复（本文档独有深层分析）
  1.9 ★ Mermaid 4-lane sequence diagram — Java/NIO/JNI/Kernel
  1.10 ★ Interview Story Format Answer (~350 words)

§二 ★★★ 6 Beginner Callout 框

§三 ★★★ JVM-level diagnostics
  strace (正常+异常), /proc/{pid}/fd + fdinfo, GDB 6 assertions, jstack 线程栈对比

§四 Cross-Reference
```

---

## §六 Writing Requirements

### 核心规则：源码是证据，原理是正文

```
文档不是"源码翻译机"——是"原理讲解课"。
贴源码的目的是证明你说的原理是对的，不是用源码填满篇幅。
每 100 行文档的分配比例:
  源码引用: ~20 行（完整函数贴入，作为证据块）
  逐行解释: ~30 行（只解释关键行，不是逐行翻译）
  原理展开: ~30 行（为什么这么设计？知识性内容）
  反事实+诊断+Linux内核: ~20 行
```

### 每个板块的"原理"具体指什么

| 板块 | 不要写成 | 应该写成 |
|------|---------|---------|
| 1. open() | `socket(AF_INET6)` 返回了 int fd | **为什么是 AF_INET6 而不是 AF_INET？** 因为 Linux 内核有一个 IPv4-mapped IPv6 地址机制 (`::ffff:a.b.c.d`)，单个 AF_INET6 socket 可以同时接受两种协议——减少一半的 fd 消耗和一个 Selector 注册。这就是 `IPV6_V6ONLY=0` 的用途——如果不设这个选项，IPv4 流量直接到达不了。讲 `struct sockaddr_in6` 的结构布局，讲内核如何转换 IPv4 地址到 IPv6 格式。 |
| 4. Selector.open() | EPollSelectorImpl 构造函数调了 3 个方法 | **epoll 的架构设计本质：分离关注点 vs 一体两用。** select/poll 是"一次性"的——每次调用你必须重新传入所有 fd，内核每次都要重建内部状态。epoll 是"持久化"的——epoll_create 创建一个持久的内核对象（`struct eventpoll`），epoll_ctl 在其上增量管理 fd，epoll_wait 只从 ready-list 拉取事件。这就是为什么 epoll 是 O(1) 而 select 是 O(n)——不是因为实现"优化了"，而是因为**架构不同**。你的 select() 每次调用是"告诉我这 10000 个 fd 中有哪些就绪了"（O(n) 扫描），epoll_wait 是"给我就绪 fd 列表"（O(1) 取出就绪链表头部）。 |
| 5. register() | fdToKey.putIfAbsent + updateKeys.addLast | **为什么延迟注册？** epoll_ctl 不是免费调用——它涉及 context switch（用户态→内核态）+ 内核 mutex (`ep->mtx`) 获取 + 红黑树 O(log N) 插入。如果 channel.register() 立即调 epoll_ctl，高频注册场景（比如 NIO proxy 频繁 accept→register→deregister）每次都是一个完整 syscall。延迟到 select() 线程内批量处理：10 次 register → 1 次 processUpdateQueue → 10 次 epoll_ctl 在同一个 kernel entry 下执行，减少 context switch。**代价：register 不在调用后立即生效，需要等到 next select。** |
| 6. select() | doSelect 循环调 epoll_wait | **EINTR 为什么能中断 epoll_wait？** Linux 信号机制——JVM 的 profiling 线程使用 SIGPROF (100Hz) 做 CPU sampling profiler。每次 SIGPROF 到达 → epoll_wait 立即返回 -1 + EINTR。如果不精确调整剩余超时：select(5000ms) 在 100Hz SIGPROF 下 → 每 10ms 中断一次 → 每次用原始 timeout 重试 → 需要 N 次 EINTR 才到真实 deadline → 实际阻塞时间远大于 5000ms。`to -= elapsed` 的精确调整**保留了总超时预算**——这是为什么 HotSpot 的 SIGPROF 采样不会影响 Selector 超时语义。**更深一层：`begin(blocking)` / `end(blocking)` 是虚拟线程 (Loom) 支持的基础设施——begin 通知调度器当前线程可被挂起，end 通知恢复。如果 `end(blocking)` 没被调用（异常路径），虚拟线程调度器会永久挂起 carrier thread。** |
| 7. wakeup() | write1(pipe, 1 字节) | **为什么 pipe 而不是 eventfd？** eventfd 是 Linux 2.6.22+ 引入的——EPollSelectorImpl 需要兼容 2.6.18+ (RHEL 5)。但更深层的原因：pipe 的 buffer 容量是 64KB (Linux 默认)——这意味着即使 wakeup() 被调用 10000 次，pipe 也只累积 10000 字节，drain 用 16 字节块读取只需 ~625 次 read。eventfd 的计数器是 64-bit 的——不会有溢出问题——但**内核版本兼容性**是第一优先级。再深一层：`interruptTriggered` 为什么需要？不是为了防止 pipe 溢出——是为了减少 syscall。如果 5 个线程同时调 wakeup()，没有去重 → 5 次 write()。有去重 → 1 次 write() + 4 次快速返回。 |
| 8. epoll bug | 内核代码有 bug | **为什么这个 bug 在生产中如此常见？** 因为 RecycledSelector 是框架（如 Netty、Tomcat NIO）的常见模式——每个请求周期：accept→register→process→deregister→下一个请求又 register→...→当 fd 计数恰好到 0 且 ready-list 清空时，`ep_remove` 的 bug 被触发。但是：**如果你用 edge-triggered (EPOLLET)，这个 bug 根本不会触发**——因为 ET 下 epoll_wait 只在 fd 状态从 not-ready→ready 时通知一次，被删除的 fd 不会有新事件进入 ready-list。这就是为什么 Netty 的 native transport 自己设置 EPOLLET——既是为了性能，也是为了规避这个内核 bug。Java Level-triggered 的简单性是付出了代价的。 |

### 每板块原理密度要求
1. Every paragraph opens with WHY — "Because ..."
2. 3-5 lines source code per claim — 作为证据，不是主要内容
3. 每个 300 行以上的板块必须包含至少 1 个反事实分析 + 1 个 Linux 内核知识引用
4. Mermaid 4-lane (Java/NIO/JNI/Kernel) 全链路序列图
5. GDB 6 assertions
6. strace + jstack 对比
7. 6 Beginner callout boxes
8. Interview answer at §一 end (~350 words)
9. epoll bug 深度分析**本文档独占**——02 只从诊断视角引用 ~400 行

---

## §七 Output Format

- File: `00-Server-Selector-Engine.md`
- Path: `/data/workspace/openjdk-cut-new/probe_md/16-nio-network/`
- Header:
```
> **阶段**：[16-nio-network]
> **前置**：[15-core-native]（JNI patterns）、[09-native-interface]（JNI marshalling）、[11-os-layer]（epoll syscalls）
> **配套**：[01-Socket-Data-Close]（connect/DirectBuffer/close）、[02-ZeroCopy-Threads-Diag]（sendfile + Reactor 线程）
> **阅读收益**：从你写的 `selector.select()` 出发，追踪 EPoll.c(98行) → EPollSelectorImpl.java(270行) 的完整 Java→JNI→Kernel 调用链
```
- Target: ~5000 lines

---

## §八 Prohibited（≥8）

- ❌ 说 epoll_wait 是"轮询" — 是事件通知，从内核 ready-list O(1) 取出
- ❌ 不说 level-triggered — EPoll.java:63-64 无 EPOLLET, translateInterestOps 证明
- ❌ 忽略 epoll_create(256) size hint — man 2 epoll_create + EPoll.c:60 注释
- ❌ 不展示 fdToKey HashMap — Map<Integer,SelectionKey> + O(1) lookup
- ❌ 不解释 NUM_EPOLLEVENTS=1024 — 栈安全历史 + level-triggered 不丢事件
- ❌ 不提 JDK epoll bug — Linux<2.6.27, RecycledSelector, 100% CPU spin, JDK 9+ fix.（本文完整深度分析，02 只做诊断引用）
- ❌ 不展示 eventSize/eventsOffset/dataOffset — struct layout 动态查询的跨平台必要性
- ❌ 忘记 wakeup pipe — pipe() + write/read 跨线程唤醒 vs 信号方案
- ❌ Server-side only（忘记 open/bind/listen 也是这个服务器的代码行）— 需要覆盖
- ❌ 不说为什么 delay register（updateKeys queue）— epoll_ctl 是昂贵 syscall

---

## §九 Required（≥8）

- ✅ Your NIO echo server Java code as document opener
- ✅ Mermaid 4-lane sequence diagram (Java / EPollSelectorImpl / EPoll.c JNI / Kernel)
- ✅ EPoll.c 完整源码: epollCreate(:58-66), epollCtl(:68-80), epollWait(:82-97), eventSize/Offset(:40-56)
- ✅ Level-triggered proof: EPoll.java:63-64 constants + translateInterestOps 源码
- ✅ fdToKey HashMap: EPollSelectorImpl.java:66 + processEvents(:181-207) 源码
- ✅ EINTR timeout adjustment: doSelect(:118-130) 源码 (startTime + to -= elapsed)
- ✅ wakeup pipe full story: makePipe(IOUtil.c:86-105) + write1(:107-112) + drain(:114-129) 源码
- ✅ 6 Beginner Callout 框
- ✅ Interview Story Format Answer: §一末尾, ~350 words
- ✅ GDB 6 assertions: EPoll.c:61,78,87 + processEvents + IOUtil.c:110,120
- ✅ jstack 正常 vs 异常线程栈对比
- ✅ epoll bug 完整深度分析（本文档独占，02 只做诊断引用 ~400 行）

---

## §十 GDB + strace Verification（≥6 assertions）

```
断言 1: epoll_create returns valid epfd (EPoll.c:61)
  (gdb) break Java_sun_nio_ch_EPoll_create
  (gdb) run
  (gdb) print epfd → expect: >0, usually =5

断言 2: epollCtl ADD wakeup pipe with EPOLLIN only, NO EPOLLET (EPoll.c:78)
  (gdb) break Java_sun_nio_ch_EPoll_ctl
  condition: opcode == 1 (EPOLL_CTL_ADD)
  (gdb) print fd → expect: 6 (wakeup pipe read-end)
  (gdb) print events → expect: 0x001 (EPOLLIN), NOT 0x80000001 (EPOLLIN|EPOLLET)

断言 3: epollWait blocks with correct timeout (EPoll.c:87)
  (gdb) break Java_sun_nio_ch_EPoll_wait
  (gdb) print timeout → expect: 1000 (select(1000)) or -1 (select())
  (gdb) print numfds → expect: 1024 (NUM_EPOLLEVENTS)

断言 4: wakeup writes 1 byte to pipe (IOUtil.c:110)
  (gdb) break Java_sun_nio_ch_IOUtil_write1
  (gdb) print fd → expect: 7 (wakeup pipe fd1)
  (gdb) print b → expect: 0 (1 byte value = 0)
  (gdb) continue → epoll_wait returns 1

断言 5: fdToKey mapping verified (EPollSelectorImpl processEvents)
  (gdb) break EPollSelectorImpl.processEvents
  (gdb) print numEntries → expect: >0
  (gdb) print fdToKey.size() → expect: >0

断言 6: drain reads from wakeup pipe correctly (IOUtil.c:120)
  (gdb) break Java_sun_nio_ch_IOUtil_drain
  (gdb) print fd → expect: 6 (fd0, wakeup pipe read-end)
  (gdb) next → read() returns 1 → 16-byte loop → returns EAGAIN

strace complete trace:
  strace -e trace=epoll_create,epoll_ctl,epoll_wait,pipe2,fcntl,write,read \
         java EchoServer 2>&1 | head -30
  expect:
    epoll_create(256)                       = 5
    pipe2([6, 7], O_NONBLOCK)              = 0
    epoll_ctl(5, EPOLL_CTL_ADD, 6, {EPOLLIN, {u32=6}}) = 0
    epoll_ctl(5, EPOLL_CTL_ADD, 8, {EPOLLIN, {u32=8}}) = 0
    epoll_wait(5, [{EPOLLIN, {u32=8}}], 1024, 1000) = 1

  abnormal (the §〇 CPU spin bug):
    epoll_wait(5, [], 1024, -1) = 0   # ← repeats every ~1μs!
    epoll_wait(5, [], 1024, -1) = 0

jstack thread stack (正常 vs 异常):
  # 正常 (BLOCKED in epoll_wait):
  jstack $(pgrep -f java) | grep -A5 "EPoll.wait"
  #   at sun.nio.ch.EPoll.wait(Native Method)            ← 阻塞在 syscall
  #   at sun.nio.ch.EPollSelectorImpl.doSelect(~:120)

  # 异常 (§〇 CPU spin — RUNNABLE in compute loop):
  jstack $(pgrep -f java) | grep -A10 "doSelect"
  #   at sun.nio.ch.EPollSelectorImpl.processUpdateQueue(~:143)  ← 从不进入 EPoll.wait!
  #   at sun.nio.ch.EPollSelectorImpl.doSelect(~:113)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. 从 README §一.1 承接：Selector.open() → epoll_create — 本文用 EPoll.c:58-66 源码验证 size hint + 内核结构
2. 从 README §一.3 承接：select() → doSelect 循环 — 本文用 EPollSelectorImpl.java:102-138 源码验证完整事件循环
3. 从 README §一.4-1.6 承接：事件数据结构 + fd→key 映射 + wakeup pipe — 本文完整覆盖
4. 从 README §二.1/2/5/7/8 承接：epoll 选择, LT/ET, dup2 trick, Reactor, wakeup pipe — 本文验证前三项
5. **epoll bug 深度分析仅在本文档中** — 02 文档从诊断视角引用，用 ~400 行而非重复 1000 行
6. 同组边界：本文覆盖 Selector 引擎（epoll + 事件循环）；01 覆盖 Socket 生命周期 + DirectBuffer I/O + dup2 close；02 覆盖 sendfile + Reactor 多线程 + 诊断工具箱
