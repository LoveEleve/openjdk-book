# PROMPT: 请撰写 01-Attach-Mechanism.md

## 〇、背景与使用场景

### 你在生产环境中每天都在经历的

你敲了这一行：
```bash
$ jcmd 12463 help
12463:
The following commands are available:
JFR.stop
JFR.start
JFR.dump
JFR.check
VM.native_memory
VM.check_commercial_features
VM.unlock_commercial_features
ManagementAgent.stop
ManagementAgent.start_local
ManagementAgent.start
GC.rotate_log
Thread.print       <-- 线上排查死锁
GC.class_stats
GC.class_histogram <-- 排查内存泄漏第一步
GC.heap_dump
GC.run_finalization
GC.run             <-- ★ 生产慎用！
VM.uptime
VM.flags
VM.system_properties
VM.command_line
VM.version
help
```
→ JVM 内部发生了什么？`jcmd` 进程创建了一个 Unix 域套接字客户端，连接到 `/tmp/.java_pid12463`。JVM 的 `AttachListener` 线程从 `accept()` 唤醒，`read_request()` 读取 `"1\0jcmd\0help\0"` → `funcs[]` 调度表的 `jcmd()` 被调用 → `DCmd::parse_and_execute("help")` → 遍历 40+ 注册命令并格式化输出 → `write_fully()` 把结果发回给 jcmd。整个过程**不走 TCP 端口**——没有 HTTP、没有 Network I/O，纯本地套接字。

你敲了这一行：
```bash
$ jstack 12463
"http-nio-8080-exec-3" #39 daemon prio=5 os_prio=0 cpu=324.51ms elapsed=24417.14s tid=0x00007f8b24111800 nid=0x5cee waiting on condition  [0x00007f8b1f5fb000]
   java.lang.Thread.State: WAITING (parking)
        at jdk.internal.misc.Unsafe.park(java.base@11.0.22/Native Method)
        - parking to wait for  <0x0000000714d8adb8> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
        at java.util.concurrent.locks.LockSupport.park(java.base@11.0.22/LockSupport.java:194)
        ...
"VM Thread" os_prio=0 cpu=879.80ms elapsed=24417.14s tid=0x00007f8b2809d000 nid=0x5cc6 runnable

"G1 Conc#0" os_prio=0 cpu=2140.83ms elapsed=24417.14s tid=0x00007f8b280b1000 nid=0x5cc8 runnable

"Attach Listener" #124 daemon prio=9 os_prio=0 cpu=12.40ms elapsed=349.48s tid=0x00007f8b0c01e000 nid=0x6026 runnable  [0x0000000000000000]
   java.lang.Thread.State: RUNNABLE

"Service Thread" #14 daemon prio=9 os_prio=0 cpu=280.60ms elapsed=24417.16s tid=0x00007f8b280b7800 nid=0x5cd2 runnable  [0x0000000000000000]
   java.lang.Thread.State: RUNNABLE
```
→ JVM 内部发生了什么？`jstack` 也是通过 Attach 管道——它和 `jcmd` 走的是同一套 `attach_listener_thread_entry()`，区别是 `funcs[]` 中匹配到的是 `threaddump` 而不是 `jcmd`。输出中你看到了 `Attach Listener` 线程本身——说明 AttachListener 也是 JVM 管理的 JavaThread（只不过永远在 `_thread_in_native` 状态）。`TID=0x00007f8b0c01e000` 是 HotSpot 内部的 `Thread*` 指针，`NID=0x6026` 是 OS 层面的 LWP ID（`/proc/PID/task/` 中的线程号）。

你敲了这一行：
```bash
$ jmap -dump:format=b,file=heap.bin 12463
Dumping heap to /tmp/heap.bin ...
WARNING: 这个操作会触发 Full GC，STW 时间可达 30 秒以上
Heap dump file created [476284933 bytes in 3.844 secs]
```
→ JVM 内部发生了什么？`jmap -dump` 同样通过 Attach 管道 → `funcs[]` 中 `dumpheap` 被调用 → `HeapDumper::dump()` 被触发 → **先触发一次 Full GC**（`-dump:live` 时必然触发，非 live 模式也可能触发 Cleanup）→ 然后在 safepoint 中遍历整个堆 → 通过 `write_fully()` 把堆数据写入套接字 → `jmap` 进程接收并写入文件。这就是为什么**线上的 jmap 要慎重**——它通过 Attach 机制触发 GC，而 GC 的时间取决于堆大小和对象数量。

你敲了这一行：
```bash
$ jinfo 12463
VM Flags:
-XX:CICompilerCount=4 -XX:ConcGCThreads=2 -XX:G1HeapRegionSize=4194304
-XX:InitialHeapSize=8589934592 -XX:MaxHeapSize=8589934592
-XX:MaxNewSize=5150601216 -XX:MinHeapDeltaBytes=4194304
-XX:+UseCompressedClassPointers -XX:+UseCompressedOops -XX:+UseG1GC
...
```
→ JVM 内部发生了什么？`jinfo` 通过 Attach 管道 → `funcs[]` 中的 `printflag` / `setflag` / `properties` 被调用。`printflag` 直接读 `Flag::flags` 全局链表，`properties` 从 `SystemDictionary` 读系统属性。这些操作**不需要 safepoint**——只是读静态配置，不需要遍历堆或线程栈。

### 相关生态工具（本文分析的源码的"表兄弟"）

你今天用的这些工具，底层走的都是同一套 Attach 管道：

- **Arthas**：当你执行 `watch com.example.Service * '{params,returnObj}' -x 3`，Arthas 客户端通过 Attach 机制加载 `arthas-agent.jar`（`funcs[]` → `load` 命令 → `JvmtiExport::load_agent_library()`）→ agent 的 `agentmain()` 被调用 → 注册 ClassFileTransformer → 在目标类的字节码中插入追踪代码 → 输出采集到的数据。Arthas 的 `watch` / `trace` / `stack` / `tt` 命令，进入 JVM 的第一步都是 Attach 管道的 `load` 命令。
- **async-profiler**：当你执行 `profiler.sh start -e cpu -f /tmp/flame.svg <PID>`，脚本通过 Attach 机制把 `libasyncProfiler.so` 加载到 JVM 中 → `Agent_OnAttach()` 被调用 → 配置 `perf_event_open()` → 开始采样。`profiler.sh stop` 再次 Attach → 通过 `jcmd` 发送停止命令 → agent 输出采样结果。async-profiler 的整个生命周期都依赖 Attach 管道进出 JVM。
- **Btrace**：通过 Attach 加载 `btrace-agent.jar` → 动态插入安全沙箱的字节码探针。同样的 `load` 命令，不同的 agent。
- **JMH perfasm**：JMH 的 `-prof perfasm` 通过 Attach 加载 `linux-perf-map-agent` → 生成 `/tmp/perf-<PID>.map` 供 `perf` 符号化 JIT 编译后的代码。

**即使本文不分析这些工具的源码，但理解了 Attach 管道的全链路——从 `SIGBREAK` 触发到 `funcs[]` 调度——你就理解了一切 JVM 诊断工具"怎么进来"的底层机制。**

### 生产环境的实践要点

**容器化部署的 Attach 痛点**：Docker/K8s 环境中，`/tmp` 目录默认是进程私有的——容器 A 的 `/tmp/.java_pid1` 在宿主机上看是 `/proc/<pid>/root/tmp/.java_pid1`。如果 `HostPID=true`，容器内 `jcmd 1` 会去找 `/tmp/.java_pid1`——但它可能在另一个 PID namespace 中，导致 "Can't attach to the process" 错误。`jcmd` 的 PID 匹配检查（`attachListener_linux.cpp` 中 `::kill(pid, 0)` 验证进程存在）也会因为 PID namespace 映射而失败。解决方式：共享 PID namespace 或通过 `docker exec` 直接在容器内执行。

**`DisableAttachMechanism` 的权限控制**：`-XX:+DisableAttachMechanism` 会让 `AttachListener::vm_start()` 完全不创建 AttachListener 线程，套接字文件 `/tmp/.java_pid<PID>` 也不存在。什么时候该关？a) 生产环境的敏感金融系统——不允许任何运行时诊断访问；b) 安全合规要求——不能有外部进程注入 JVM；c) 长期运行的批处理系统——不需要诊断。什么时候不该关？a) 大部分生产环境需要保留 jstack/jmap/jcmd 的应急入口；b) APM agent（如 Datadog/NewRelic）通过 Attach 加载——关了等于 APM 失效。JDK 9+ 引入了更精细的 `-XX:+EnableDynamicAgentLoading` 控制动态 agent 加载，可以在保留 jcmd 基础诊断能力的前提下禁用 Arthas/async-profiler 的动态注入。

**AttachListener 线程的性能开销**：`attach_listener_thread_entry()` 的主循环是 `accept()` 阻塞等待——在没有任何外部连接时，线程没有任何 CPU 消耗（操作系统层面阻塞在内核 `sk_wait_data` 等待队列中）。频繁的 `jcmd` 调用（如每 10 秒一次的监控脚本）会产生连接建立/关闭的 syscall 开销（socket + connect + write + read + close ≈ 20-30μs），对应用线程的影响微乎其微。只有 `jmap -dump` 这种触发 STW 的操作才会有影响——但影响来自 GC/堆遍历本身，不是 Attach 管道。

### 生产常见陷阱

- **`jcmd <PID> GC.run` 在生产触发 Full GC**：`GC.run` 最终调用 `GenCollectedHeap::collect(GCCause::_jcmd)`，如果当前 GC 是 G1，这会触发一次 Full GC（STW）。生产环境不建议用 `GC.run` 来"释放内存"——正在运行的应用使用量可能立刻回升，且 Full GC 的 STW 时间从几秒到几分钟不等。
- **`jmap -dump` 的 STW 警告常被忽视**：当 `-dump:live` 指定时，HeapDumper 会先执行 Full GC 来收集存活对象。如果堆是 32GB，活对象 20GB，遍历所有引用链的时间可能是 30-60 秒——这期间的 STW 会被用户感知为"服务假死"。
- **套接字文件被手动删除**：如果有人 `rm /tmp/.java_pid<PID>`，`jcmd` 会报 "No such file or directory"，但 JVM 内的监听 fd 不受影响——socket inode 只在 fd 关闭后才释放，`unlink()` 只是删除目录项。新 attach 会失败，但已建立的连接不受影响。
- **SIGBREAK 信号被容器重启脚本捕获**：某些容器健康检查脚本在超时时发送 `SIGKILL` 或 `SIGTERM`——如果误发 `SIGQUIT`（和 SIGBREAK 同值），JVM 不会崩溃，但会触发 AttachListener 的 lazy init 而不是 thread dump（thread dump 由 VMThread 在 safepoint 中处理，和 Attach 无关）。

### 背景概念速览

- **Unix 域套接字（AF_UNIX）**：进程间通信的"文件系统管道"，不需要 IP 地址和端口，通过文件 inode 引用。vs TCP：无需协议栈处理开销（无 TCP 三次握手/SYN 重传）、无需 root 权限分配端口、内核自动提供对端身份信息（`SO_PEERCRED`）。
- **SO_PEERCRED**：Unix 域套接字的选项——`getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &ucred, ...)` 获取连接对端的 `pid/uid/gid`，由内核验证（不可伪造）——这就是 Attach 的权限模型：root 能 attach 任何 JVM，同用户只能 attach 自己的。
- **SIGBREAK**：Linux 上 `SIGQUIT` 的别名（signal 3）。JVM 的信号处理器检测到 `SIGBREAK` 时，不一定是做 thread dump——先检查 AttachListener 是否初始化（`transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED)`），如果 AttachListener 从未初始化 → 触发 lazy init → 创建套接字文件→ 以后 `jcmd` 就能用了。如果已经初始化 → 不做任何事（thread dump 是 VMThread 在 safepoint 中处理的，和这个信号处理器无关）。
- **Instrumentation API**：`java.lang.instrument` 包——`premain()`（启动时 agent）和 `agentmain()`（运行时 agent）的进入点。`agentmain()` 通过 Attach 管道的 `load` 命令触发：`load` → `InstrumentationImpl.loadAgent()` → Java 层 agent jar → `agentmain()` 被调起。


## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者刚学完 [09-native-interface]——JNI 作为 JVM 的"内部接口"，Java 调用 native 时线程穿越 `_thread_in_native ↔ _thread_in_vm` 边界。那是"Java 走过来"。本文讲的是反向：**外部工具（jcmd/jstack/jmap）如何突破进程边界，向正在运行的 JVM 发送命令？** 这是"外面敲进来"。

`/tmp/.java_pid<PID>` 这个 Unix 域套接字文件是谁创建的？AttachListener 线程和 JavaThread 有什么本质不同？`SO_PEERCRED` 是怎么阻止非 root 用户 attach 到别人的 JVM 的？`SIGBREAK` 信号怎么触发 lazy init？解答这些问题不是靠翻译 `attachListener_linux.cpp` 的 583 行源码——而是靠回答**为什么选择 Unix 域套接字而不是 TCP**、**为什么需要三态转换 `AL_NOT_INITIALIZED → AL_INITIALIZING → AL_INITIALIZED`**、**为什么 `read_request()` 的 `\0` 分隔协议比 HTTP 更适合信号安全场景**。

**本文不是 jcmd 使用手册**——jcmd 的 40+ 子命令是 [02-DCmd] 的事。本文也不是信号编程教程——我们只关心 `SIGBREAK` 怎么变成 "启动 attach listener" 的触发信号。本文唯一的目标：**追踪外部字节流从 `/tmp/.java_pid<PID>` 套接字到 `funcs[]` 调度表完整全链路**，并和 [07-thread] 的 `JavaThread` 生命周期模型、[09-01] 的 JNI 线程形成"内/外对称"。

### 验证报告
- `sverklo_investigate(AttachListener dequeue LinuxAttachListener SO_PEERCRED)` → 发现：两层 dequeue（AttachListener::dequeue 桥接层 + LinuxAttachListener::dequeue 平台层）
- `codegraph query "attach_listener_thread_entry"` → 确认在 attachListener.cpp:348
- `codegraph query "LinuxAttachListener::dequeue"` → 确认在 attachListener_linux.cpp:347，accept() + SO_PEERCRED + read_request
- `grep -n "transit_state" attachListener.hpp` → 行 96-98，Atomic::cmpxchg 三态转换
- `grep -n "vm_start" thread.cpp` → 行 4185，Threads::create_vm 调用点
- `grep -n "SIGBREAK" os.cpp` → 行 362，信号处理中 is_init_trigger 触发路径

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | services | `attach_listener_thread_entry()`(:348), `funcs[]`(:328-340), `jcmd()`(:202), `AttachListener::dequeue()`, `AttachListener::detachall()`(:491) | ★★★ 中央调度——线程入口 + 命令分发 |
| 2 | `attachListener.hpp` | `src/hotspot/share/services/attachListener.hpp` | services | `AttachOperation(:136)`, `AttachListener::transit_state()`(:96-98), `is_initialized()`(:101), `set_state()`(:88) | ★★ 数据结构 + 状态机 |
| 3 | `attachListener_linux.cpp` | `src/hotspot/os/linux/attachListener_linux.cpp` | os/linux | `LinuxAttachListener::init()`(:182), `::dequeue()`(:347), `read_request()`(:250), `write_fully()`(:387), `listener_cleanup()`(:166) | ★★★ 平台实现——套接字 I/O + 权限验证 |
| 4 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `Threads::create_vm` → `AttachListener::vm_start()`(:4185) | ★★ 启动入口 |
| 5 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | SIGBREAK 信号处理 → `AttachListener::is_init_trigger()`(:362-387) | ★★ 信号触发——lazy init 路径 |
| 6 | `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | runtime | `DisableAttachMechanism`(:2461), `StartAttachListener`(:2464) | ★ 标志控制 |

**跨模块说明**：Attach 链路跨越 3 模块——`services/`（命令调度）、`os/linux/`（套接字 I/O）、`runtime/`（线程创建 + 信号触发）。关键函数需给出跨模块行号，GDB 验证需要跨模块断点。

## 四、必须深度走读的核心概念

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ 为什么选择 Unix 域套接字 + SO_PEERCRED？权限模型

```
问题：
  ① 为什么 Attach 不选 TCP 而是 Unix 域套接字？
     线索: attachListener_linux.cpp:362-373
     答案方向: TCP 没有 SO_PEERCRED——Unix 域套接字允许内核验证对端进程的
     euid/egid。只有同用户或 root 才能 attach。TCP 需要自己实现认证协议，
     增加攻击面。而且 Unix 域套接字是文件系统命名空间——不需要端口号分配。

  ② SO_PEERCRED 是怎么验证调用方身份的？
     线索: attachListener_linux.cpp:359-373
     代码引证:
       struct ucred cred_info;
       socklen_t optlen = sizeof(cred_info);
       ::getsockopt(s, SOL_SOCKET, SO_PEERCRED, (void*)&cred_info, &optlen);
       if (!os::Posix::matches_effective_uid_and_gid_or_root(cred_info.uid, cred_info.gid)) {
         ::close(s); continue;

  ③ 套接字文件 `/tmp/.java_pid<PID>` 是在什么时间创建的？
     线索: attachListener_linux.cpp:193-194, thread.cpp:4185-4189
     答案方向: 两种情况——(a) -XX:+StartAttachListener → VM 启动时 init()
     → socket() + bind() + listen() + rename；(b) SIGBREAK 触发 → is_init_trigger()
     → init()。
```

### 4.2 ★★★ `transit_state()` 三态转换——为什么需要 AL_INITIALIZING 中间态？

```
问题：
  ① 如果只有两个状态（未初始化/已初始化）会有什么竞态？
     线索: attachListener.hpp:96-98
     答案方向: SIGBREAK 可能并发到达（多个信号）。如果只有两态，两个信号处理器
     同时检测到 AL_NOT_INITIALIZED → 都要初始化 → 两个 init() 可能创建重复线程。
     AL_INITIALIZING 中间态用 Atomic::cmpxchg 保证只有一个线程成功进入初始化。
     代码引证:
       AttachListenerState transit_state(AttachListenerState new_state, AttachListenerState cmp_state) {
         return Atomic::cmpxchg(new_state, &_state, cmp_state);
       }

  ② os.cpp SIGBREAK 处理器中 transit_state 的完整逻辑是什么？
     线索: os.cpp:374-387
     答案方向: transit(AL_INITIALIZING, AL_NOT_INITIALIZED) → 成功 → 调用 is_init_trigger()；
     失败但 cur_state == AL_INITIALIZING → 忽略（别人在初始化）；失败且 cur_state 不是
     AL_NOT_INITIALIZED → 说明已初始化 → 忽略。

  ③ AttachListener 线程 shutdown 时 accept() 怎么被唤醒？
     线索: attachListener_linux.cpp:166-177 (listener_cleanup), :170 (shutdown(fd, SHUT_RDWR))
     答案方向: at exit 注册 listener_cleanup() → ::shutdown(listener_fd, SHUT_RDWR)
     → 使监听 fd 不可读写 → accept() 返回 EINVAL → dequeue 的 for(;;) 循环中
     accept 返回 -1 → dequeue 返回 NULL → attach_listener_thread_entry 检测到
     op == NULL → 退出线程。
```

### 4.3 ★★ 两层 dequeue——为什么 AttachListener 和 LinuxAttachListener 各有一个？

```
问题：
  ① AttachListener::dequeue() 做了什么？为什么只实现了一层？
     线索: 搜索 attachListener.cpp 中的 dequeue 实现
     答案方向: AttachListener::dequeue() 在 "平台操作" 中声明（attachListener.hpp:128）
     但实现在平台文件中。实际上，真正的阻塞 I/O 都在 LinuxAttachListener::dequeue()
     中——accept() + SO_PEERCRED + read_request()。AttachListener 层只是提供
     平台无关的封装。

  ② 如果 AttachListener::dequeue() 不是真正的阻塞点，那 ThreadBlockInVM 在哪里？
     线索: attachListener_linux.cpp:347（LinuxAttachListener::dequeue 没有 ThreadBlockInVM）
     答案方向: 在 LinuxAttachOperation::complete()（attachListener_linux.cpp:409-411）中
     有 ThreadBlockInVM tbivm(thread)——这是向客户端发送结果时阻塞。AttachListener::
     dequeue() 在 attach_listener_thread_entry 中被调用时，线程已经在
     _thread_in_native 状态。
```

### 4.4 ★★ 协议解析——`read_request()` 与 `write_fully()` 的细节

```
问题：
  ① 协议格式为什么用 `\0` 分隔？和 HTTP 的 `\r\n` 比优劣在哪？
     线索: attachListener_linux.cpp:257-258
     代码引证:
       // <ver>0<cmd>0<arg>0<arg>0<arg>0
       int expected_str_count = 2 + AttachOperation::arg_count_max;
     答案方向: `\0` 不出现在合法参数值中——不需要转义。HTTP `\r\n` 分隔需要处理
     参数值包含 `\r\n` 的情况。`\0` 分隔让解析极简——逐字节扫描 `buf[off+i] == 0`
     计数字符串数（attachListener_linux.cpp:285-301）。

  ② 如果参数长度超过 arg_length_max (1024) 会怎样？
     线索: attachListener_linux.cpp:329-331
     代码引证:
       if (strlen(arg) > AttachOperation::arg_length_max) {
         delete op; return NULL;
       }
     答案方向: read_request() 显式拒绝——delete op 返回 NULL → 连接关闭。
     不会发生缓冲区溢出。max_len 计算时已经包含了 arg_length_max * arg_count_max。

  ③ write_fully() 的 EINTR 重试循环——为什么需要，和 VMError 的 write() 有什么不同？
     线索: attachListener_linux.cpp:387-399
     代码引证:
       do { int n = ::write(s, buf, len);
         if (n == -1) { if (errno != EINTR) return -1; }
         else { buf += n; len -= n; } } while (len > 0);
     答案方向: write_fully() 用 do-while 循环处理 EINTR（信号中断自动重试）和
     短写（POSIX write 不保证一次写完）。VMError 路径（04）只用 ::write() 不加
     循环——因为信号安全限制更严。
```

### 4.5 ★★ `funcs[]` 调度表——10 个内置命令的全景

```
问题：
  ① 10 个内置命令分别做什么？
     线索: attachListener.cpp:328-340
     代码引证:
       static AttachOperationFunctionInfo funcs[] = {
         { "agentProperties",  get_agent_properties },
         { "datadump",         data_dump },
         { "dumpheap",         dump_heap },
         { "load",             load_agent },
         { "properties",       get_system_properties },
         { "threaddump",       thread_dump },
         { "inspectheap",      heap_inspection },
         { "setflag",          set_flag },
         { "printflag",        print_flag },
         { "jcmd",             jcmd },
       };
     答案方向: 按类别分组——(1) 诊断命令类：jcmd（最重要——桥接到 40+ 诊断命令）、
     datadump、inspectheap；(2) 堆操作类：dumpheap；(3) 线程类：threaddump；
     (4) agent 类：load（动态加载 JVMTI agent）、agentProperties；
     (5) VM 配置类：properties、setflag、printflag。

  ② jcmd 为什么是"最复杂的"？
     线索: attachListener.cpp:202-216
     代码引证:
       DCmd::parse_and_execute(DCmd_Source_AttachAPI, out, op->arg(0), ' ', THREAD);
     答案方向: jcmd 不自己做任何事——它把 op->arg(0) 原样传给 DCmd::parse_and_execute()
     → 40+ 子命令由 DCmd 框架再解析一层。jcmd 只是协议转换器。
```

### 4.6 ★★ 和 [09-JNI] 的"内/外"对称——两条接口管道的对照

```
问题：
  ① AttachListener 线程和 JNI 线程的异同？
     相同: 都是 JavaThread，都在 _thread_in_native 中运行，都不执行 Java 字节码
     不同: AttachListener 受外部驱动（accept() 阻塞等待），JNI 线程从 Java 调用进入
     更深层: 两者都是 JVM 的"接口线程"——内部(09) vs 外部(10)

  ② 和 safepoint 的互动有什么区别？
     答案方向: JNI 线程通过 transition_from_native → block_if_vm_exited_not 参与
     safepoint poll；AttachListener 永远在 _thread_in_native 状态——不执行 safepoint
     poll。这是合理的：AttachListener 不访问 Java heap——不需要 STW。

  ③ 两条管道在哪儿汇合？
     答案方向: (1) jcmd → DCmd::parse_and_execute()——外部命令进入诊断框架；
     (2) load → JvmtiExport::load_agent_library()——外部 agent 进入 JVMTI；
     (3) dumpheap → HeapDumper::dump()——外部工具获取 heap dump。
     和 09 的 JVM_* 入口形成对称：JVM_* 从 Java 调用 C++，funcs[] 从套接字调用 C++。
```

## 五、文章结构

```
§〇 源文件清单（跨 services + os/linux + runtime，标注模块归属）

§一 ★★★ 全景图：jcmd → 套接字 → AttachListener → DCmd/命令的全链路
  ❓ 为什么 Attach 选择 Unix 域套接字而不是 TCP？
  ❓ SO_PEERCRED 验证了什么？如果攻击者伪造 uid 会发生什么？
  1.1 初始化两条路径：启动参数 vs SIGBREAK 信号
  1.2 DisableAttachMechanism 的全局控制
  1.3 套接字文件生命周期：socket() → bind() → listen() → rename → unlink at exit

§二 ★★★ attach_listener_thread_entry() 逐行走读
  ❓ 这个线程是 JavaThread 还是 os::thread？为什么？
  ❓ 它怎么被创建？thread.cpp:4185 → new JavaThread(&attach_listener_thread_entry)
  2.1 线程创建的 6 步流程（Threads_lock → new → set_threadObj → add → start）
  2.2 pd_init() 平台初始化 → set_initialized()
  2.3 dequeue 循环 → 命令调度 → 结果返回

§三 ★★ LinuxAttachListener::dequeue() — 套接字 I/O 全貌
  ❓ accept() 阻塞期间 JVM shutdown 怎么唤醒这个线程？
  3.1 accept() 拿到 client fd
  3.2 SO_PEERCRED uid/egid 验证行 362-373
  3.3 read_request() 协议解析行 250-339
  3.4 和 AttachListener::dequeue() 的层次关系

§四 ★★ 协议格式：read_request() 与 write_fully()
  ❓ 为什么用 \0 分隔而不是 HTTP？
  ❓ 参数长度限制 1024 是硬限制吗？（是的，行 329 显式检查）
  4.1 协议字符串格式 ver\0cmd\0arg0\0arg1\0arg2\0
  4.2 read_request() 的逐字节行 273-304
  4.3 write_fully() 的 EINTR 循环行 387-399

§五 ★ funcs[] 调度表 + 三态状态机
  ❓ transit_state() 为什么需要 AL_INITIALIZING 中间态？
  ❓ 两态方案的竞态风险是什么？
  5.1 10 个内置命令分类：诊断、堆、线程、agent、VM 配置
  5.2 三态转换的 Atomic::cmpxchg 保证只有一个初始化者
  5.3 detachall 和 shutdown 的清理路径

§六 ★★★ 和 [09-JNI] 的"内/外"对称性
  ❓ JNI 入口 vs Attach 入口——两条管道在 JVM 的哪里汇合？
  ❓ 和 [07-thread] 的 JavaThread 生命周期模型如何对接？
  6.1 AttachListener vs JNI 线程——线程模型对照表
  6.2 两条接口管道的调用方向对比
  6.3 和 safepoint 的不同互动方式

§七 GDB 验证 + 可证伪断言
  - 套接字文件验证 + SO_PEERCRED 值读取
  - transit_state 的 cmpxchg 结果验证
  - 线程状态的 ThreadBlockInVM 转换验证
```

## 六、写作要求

1. **★ 全景图是第一交付物**：一张 ASCII 图展示 jcmd → `/tmp/.java_pid<PID>` → `accept()` → `SO_PEERCRED` → `read_request()` → `funcs[]` → 命令执行 → `write_fully()` 回应的全链路。每个节点标注文件:行号。

2. **★ `attach_listener_thread_entry()` 的线程身份必须精确**：是 JavaThread（thread.cpp:472 `new JavaThread(&attach_listener_thread_entry)`），但永远在 `_thread_in_native`。这和 [07-thread] 学到的 JavaThread 模型不同——它是第一个"永不执行 Java 代码"的 JavaThread。

3. **★ 两层 dequeue 必须分清**：`AttachListener::dequeue()` 是服务层封装，`LinuxAttachListener::dequeue()` 是平台实现。两者在调用栈上是同一层还是嵌套层？需要从源码区分。

4. **★ `funcs[]` 的 jcmd 入口是到 DCmd 的桥梁**：行 202-216 调 `DCmd::parse_and_execute()`——这是 10-services-diag 阶段内部的第一条链（Attach → DCmd）。标注清楚但不展开 DCmd 细节（留给 [02]）。

5. **★ `transit_state()` 的 Atomic::cmpxchg 是关键设计决策**：从 race condition 的视角解释为什么两态不够。这和 [08-safepoint] 中 `_state` 字段的 Atomic 操作形成对照。

6. **★ GDB 验证必须跨模块**：在 `LinuxAttachListener::dequeue()` (:347)、`read_request()` (:250)、`AttachListener::transit_state()` (:.hpp:98) 三个位置设断点。单断点不足以覆盖全链路。

7. **★ 和 [09-JNI] 的对称性必须显式对比**：如果 [09-01] 教会读者 JavaThread 通过 `ThreadInVMfromNative` 进入 JVMTI 调用——那本文就回答：AttachListener 怎么从"外部"进来，两者在哪汇合。

## 七、输出格式

- Markdown 文件，命名为 `01-Attach-Mechanism.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/10-services-diag/`
- 元信息头：
  ```
  > **阶段**：[10-services-diag]
  > **前置**：[09-01], [07-thread], [08-safepoint]
  > **依赖本文**：[10-02], [10-04]
  > **阅读收益**：理解 jcmd/jstack/jmap 的 Unix 域套接字全链路——套接字创建、权限验证、协议解析、命令调度
  ```

## 禁止行为

- ❌ 把 `attachListener_linux.cpp` 的 583 行当"源码注释翻译"——只聚焦 `init() → dequeue() → read_request() → write_fully()` 四条核心路径
- ❌ 解释 jcmd 子命令（`Thread.print`、`GC.class_histogram` 等）——那是 [02-DCmd] 的职责，本文只讲到 `jcmd()` 调用 `DCmd::parse_and_execute()` 为止
- ❌ 解释 Unix 域套接字的 kernel 实现（`unix_stream_connect`、`sock_create`）——这属于 Linux 内核的范畴，和本文主线无关
- ❌ 解释 JVMTI agent 的加载过程（Agent_OnLoad/Agent_OnAttach）——`load` 命令只提到 `JvmtiExport::load_agent_library()` 调用点，不展开 JVMTI agent 生命周期
- ❌ 忘记 [09-JNI] 的对称性——每做一个 Attach 特性描述，必须引用 [09] 的对应特性（线程状态、进入点、safepoint 互动）
- ❌ 把 `write_fully()` 的 EINTR 循环当成信号安全讨论的重点——那是 [04-VMError] 的重点，本文只需指出"write_fully() 处理 EINTR，但 VMError 不用这个"
- ❌ 忽略"为什么 Attach 不选 TCP"这个根本问题——只用一行"Unix 域套接字更快"算未完成。必须在 §一 把 SO_PEERCRED 的权限模型解释清楚
- ❌ 不做 `transit_state()` 的 cmpxchg 竞态分析——只列出三态枚举算未完成。必须解释为什么两态不够，用竞态时序图说明 AL_INITIALIZING 解决了什么
- ❌ 忽略 shutdown 路径——`listener_cleanup()` (attachListener_linux.cpp:166) 的 `::shutdown(fd, SHUT_RDWR)` 怎么中断 `accept()` 阻塞是"dequeue 怎么退出"的唯一答案
- ❌ 不做 GDB 验证——至少 3 个断点（dequeue, read_request, transit_state）缺一不可

## 要求行为

- ✅ **★ 一张 ASCII 全链路图**：从 `jcmd <PID> <command>` 到 `write_fully()` 回应的完整路径，每个节点标注 `file:line`
- ✅ **★ SO_PEERCRED 的 GDB 值验证**：`br attachListener_linux.cpp:362` → `p cred_info.uid`、`p cred_info.gid`、`p geteuid()` 验证身份匹配
- ✅ **★ `attach_listener_thread_entry()` 的线程类型确认**：展示 `new JavaThread(&attach_listener_thread_entry)`（thread.cpp:472）——这是 JavaThread，和 os::thread 不同
- ✅ **★ `transit_state()` 的 Atomic::cmpxchg 竞态分析**：时序图展示两个 SIGBREAK 信号并发进入 → 只有一个拿到 AL_INITIALIZING 权限
- ✅ **★ 协议格式的逐字节解析**：从 `read_request()` 的行 284-301 逐字节展示 `buf[off+i] == 0` 检测逻辑
- ✅ **★ `funcs[]` 的完整显式表**：10 个命令名 → 函数指针，加一列注明"该命令最终走到哪个子系统"
- ✅ **★ 和 [09-01] 的对照表**：调用方向、入口点、线程状态、safepoint 互动、安全性机制——5 列 × 2 行
- ✅ **★ `listener_cleanup()` 的 shutdown 机制解释**：`::shutdown(fd, SHUT_RDWR)` 如何使 `accept()` 返回 -1 → `dequeue()` 返回 NULL → 线程退出
- ✅ **★ 两个 dequeue 的调用栈展示**：GDB `bt` 在 `attach_listener_thread_entry → dequeue → LinuxAttachListener::dequeue → accept` 展示完整调用栈
- ✅ **★ 和 [02-DCmd] 的桥梁标注**：`jcmd()` → `DCmd::parse_and_execute(DCmd_Source_AttachAPI, ...)`，标注"详细见 [10-02]§一"

## GDB 可证伪断言

1. **断言：`/tmp/.java_pid<PID>` 套接字文件存在且可访问**
   验证：`ls -la /tmp/.java_pid<PID>` → 文件类型为 `srwxr-xr-x`（Unix 域套接字）
   断点：无（静态验证）

2. **断言：`LinuxAttachListener::dequeue()` 中 `accept()` 返回的是新的 client fd**
   验证：`br attachListener_linux.cpp:354` → `n` → `bt` → 确认调用方是 `LinuxAttachListener::dequeue()`
   预期：`s >= 3`，`RESTARTABLE(::accept(listener(), &addr, &len), s)` 返回 client fd

3. **断言：SO_PEERCRED 读取的 uid/gid 和当前进程的 euid/egid 一致**
   验证：`br attachListener_linux.cpp:362` → `p cred_info.uid` → `p geteuid()` → 值相同（或 root 为 0）
   预期：`os::Posix::matches_effective_uid_and_gid_or_root(cred_info.uid, cred_info.gid)` 返回 true

4. **断言：`read_request()` 的第 1 个 \0 终止处是协议版本号**
   验证：`br attachListener_linux.cpp:291` → `p buf` → 显示 `"1"`
   预期：`buf` 的第一个 \0 前是 `"1"`（ATTACH_PROTOCOL_VER）

5. **断言：`write_fully()` 的 EINTR 循环确实会被信号触发**
   验证：`br attachListener_linux.cpp:389` → 等待写入 → 发送 SIGUSR1 给 JVM → 观察 `errno == EINTR` → `write_fully` 重试
   预期：`n == -1` 时 `errno` 可能为 EINTR，loop 不退出

6. **断言：`AttachListener::transit_state()` 的 cmpxchg 在并发 SIGBREAK 下只成功一次**
   验证：两个 shell 窗口 `kill -SIGBREAK <PID>` 几乎同时 → `br attachListener.hpp:98` → 第一次命中 `result == AL_NOT_INITIALIZED`，第二次命中 `result != AL_NOT_INITIALIZED`（要么是第二次拿到了 AL_INITIALIZING 判断）
   预期：只有一个 `is_init_trigger()` 被调用（第二次 detect 到 AL_INITIALIZING 则跳过）

7. **断言：AttachListener 线程在 `_thread_in_native` 状态执行**
   验证：`br attachListener.cpp:365` → `p JavaThread::current()->_thread_state`
   预期：值 = `_thread_in_native` (8)

8. **断言：`DisableAttachMechanism=true` 时 `AttachListener::vm_start()` 不被调用**
   验证：启动 JVM `-XX:+DisableAttachMechanism` → `br thread.cpp:4185` → 断点不命中
   预期：breakpoint never hit

9. **断言：`jcmd()` 调用 `DCmd::parse_and_execute()` 时 source = DCmd_Source_AttachAPI**
   验证：`br attachListener.cpp:208` → `p source` → 值 = `DCmd_Source_AttachAPI`
   预期：source = DCmd_Source_AttachAPI (0x2)

10. **断言：`listener_cleanup()` 的 `::shutdown(fd, SHUT_RDWR)` 使 `accept()` 返回 -1**
    验证：JVM shutdown 时 → `br attachListener_linux.cpp:170` → 单步执行 `::shutdown(fd, SHUT_RDWR)` → AttachListener 线程的 `accept()` 返回 -1 → dequeue 返回 NULL → 线程退出
    预期：`s` 原本在 accept 阻塞，shutdown 后返回 -1

11. **断言：`attach_listener_thread_entry()` 调用栈无 Java 方法帧**
    验证：`br attachListener.cpp:348` → `bt` → 确认栈上只有 native 帧（os::thread_start → attach_listener_thread_entry → ...）
    预期：不含任何 Java 解释器/编译帧（J=compiled, j=interpreted 均无）

12. **断言：`funcs[]` 中 jcmd 的位置正确**
    验证：`br attachListener.cpp:328` → `p funcs[9].name` → 显示 `"jcmd"` → `p funcs[9].func == &jcmd`
    预期：第 10 个元素（索引 9）是 `{"jcmd", jcmd}`
