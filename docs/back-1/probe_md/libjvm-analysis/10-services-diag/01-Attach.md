# 01-Attach-Mechanism — Unix 域套接字 Attach 全链路：从 jcmd 到 DCmd

> **阶段**：[10-services-diag]
> **前置**：[09-01], [07-thread], [08-safepoint]
> **依赖本文**：[10-02], [10-04]
> **阅读收益**：理解 jcmd/jstack/jmap 的 Unix 域套接字全链路——套接字创建、权限验证、协议解析、命令调度

---

## §〇 源文件清单（跨 services + os/linux + runtime，标注模块归属）

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | services | `attach_listener_thread_entry()`(:348), `funcs[]`(:328-340), `jcmd()`(:202), `AttachListener::dequeue()`(:128), `AttachListener::init()`(:435-487) | ★★★ 中央调度 |
| 2 | `attachListener.hpp` | `src/hotspot/share/services/attachListener.hpp` | services | `AttachOperation`(:136-192), `AttachListener::transit_state()`(:96-99), `is_initialized()`(:101-103) | ★★ 数据结构+状态机 |
| 3 | `attachListener_linux.cpp` | `src/hotspot/os/linux/attachListener_linux.cpp` | os/linux | `LinuxAttachListener::init()`(:182), `::dequeue()`(:347), `read_request()`(:250), `write_fully()`(:387), `listener_cleanup()`(:166), `AttachListener::dequeue()`(:440) | ★★★ 平台实现 |
| 4 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `Threads::create_vm` → `AttachListener::vm_start()`(:4185) | ★★ 启动入口 |
| 5 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | SIGBREAK 信号处理 → `transit_state`(:367-387) | ★★ 信号触发 |
| 6 | `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | runtime | `DisableAttachMechanism`(:2461), `StartAttachListener`(:2464) | ★ 标志控制 |
| 7 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `ThreadBlockInVM`(:297-309), `ThreadStateTransition`(:103-183) | ★★ 线程状态转换 |

---

## §〇 生产场景——你在线上每天都在做的事

### jcmd：一切诊断的第一行

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

### jstack：线程栈和死锁检测

你敲了这一行：

```bash
$ jstack 12463
"http-nio-8080-exec-3" #39 daemon prio=5 os_prio=0 cpu=324.51ms elapsed=24417.14s
   tid=0x00007f8b24111800 nid=0x5cee waiting on condition [0x00007f8b1f5fb000]
   java.lang.Thread.State: WAITING (parking)
        at jdk.internal.misc.Unsafe.park(java.base@11.0.22/Native Method)
        - parking to wait for <0x0000000714d8adb8> (a ConditionObject)
        ...
"VM Thread" os_prio=0 cpu=879.80ms elapsed=24417.14s tid=0x00007f8b2809d000 nid=0x5cc6 runnable

"G1 Conc#0" os_prio=0 cpu=2140.83ms elapsed=24417.14s tid=0x00007f8b280b1000 nid=0x5cc8 runnable

"Attach Listener" #124 daemon prio=9 os_prio=0 cpu=12.40ms elapsed=349.48s
   tid=0x00007f8b0c01e000 nid=0x6026 runnable [0x0000000000000000]
   java.lang.Thread.State: RUNNABLE
```

→ `jstack` 也是通过 Attach 管道——和 `jcmd` 走同一套 `attach_listener_thread_entry()`，区别是 `funcs[]` 中匹配到的是 `threaddump`。输出中你看到了 `Attach Listener` 线程本身——说明它也是 JVM 管理的 JavaThread（只不过永远在 `_thread_in_native`）。

### jmap：运行时堆 dump

```bash
$ jmap -dump:format=b,file=heap.bin 12463
Dumping heap to /tmp/heap.bin ...
WARNING: 这个操作会触发 Full GC，STW 时间可达 30 秒以上
Heap dump file created [476284933 bytes in 3.844 secs]
```

→ `jmap -dump` 同样通过 Attach 管道 → `funcs[]` 中 `dumpheap` 被调用 → `HeapDumper::dump()` → **先触发一次 Full GC**（`-dump:live` 时必然触发）→ 在 safepoint 中遍历整个堆 → 通过 `write_fully()` 把堆数据写入套接字 → `jmap` 进程接收并写入文件。

### 和 JNI 的"内/外"对称性

| 维度 | JNI 入口（内部管道） | Attach 入口（外部管道） |
|------|---------------------|----------------------|
| **调用方向** | Java → JNI native 方法 | 外部进程 → JVM 线程 |
| **入口点** | `JVM_ENTRY` 宏展开（[09-04]§一） | `funcs[]` 调度表 (:328) |
| **线程状态** | `_thread_in_native` → `_thread_in_vm` | 始终 `_thread_in_native` |
| **safepoint 互动** | poll + block_if_requested（[09-01]§二） | 不参与 poll（不需要） |
| **安全性** | Java SecurityManager | SO_PEERCRED uid/gid |

### 生态工具：同一套管道的"表兄弟"

- **Arthas**：`watch/trace/stack/tt` 通过 `load` 命令加载 `arthas-agent.jar` → `JvmtiExport::load_agent_library()` → agent 的 `agentmain()` 注册 ClassFileTransformer
- **async-profiler**：通过 `load` 命令加载 `libasyncProfiler.so` → `Agent_OnAttach()` → `perf_event_open()` 开始采样
- **Btrace**：通过 `load` 命令加载 `btrace-agent.jar` → 动态插入安全沙箱字节码探针

---

## §一 ★★★ 全景图：jcmd → 套接字 → AttachListener → DCmd/命令的全链路

### 1.1 ASCII 全链路图（节点标注 file:line）

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                           jcmd <PID> Thread.print -l                                │
└───────────────────────────────────────────────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┘
          ▼
  ┌──────────────────┐
  │ jcmd 进程打开      │            socket(PF_UNIX, SOCK_STREAM, 0)
  │ Unix 域套接字      │            connect("/tmp/.java_pid<PID>")
  │ 客户端             │            write("1\0jcmd\0Thread.print -l\0\0\0")
  │                   │            read() ← 等待结果
  └──────────────────┘
          │
          │  write("1\0jcmd\0Thread.print -l\0\0\0")
          ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │ JVM 内部 Attach Listener 线程 (attach_listener_thread_entry)     │
  │ attachListener.cpp:348                                           │
  │                                                                  │
  │  ┌───────────────────────────────────────────────────────────┐   │
  │  │ AttachListener::dequeue()       [attachListener.cpp:365]  │   │
  │  │   └→ AttachListener::dequeue()  [linux.cpp:440]          │   │
  │  │       └→ LinuxAttachListener::dequeue()  [linux.cpp:347] │   │
  │  │           ├─ accept()           [linux.cpp:354] ← 阻塞   │   │
  │  │           ├─ SO_PEERCRED        [linux.cpp:362] ← uid验证 │   │
  │  │           └─ read_request(s)    [linux.cpp:250]          │   │
  │  │               ├─ 读取字节流                                │   │
  │  │               ├─ 检查协议版本                              │   │
  │  │               ├─ \0 分割解析                              │   │
  │  │               └─ new LinuxAttachOperation(name)          │   │
  │  └───────────────────────────────────────────────────────────┘   │
  │                           │                                       │
  │                           ▼                                       │
  │  ┌───────────────────────────────────────────────────────────┐   │
  │  │ funcs[] 调度表查找  [attachListener.cpp:389-397]          │   │
  │  │   for (int i=0; funcs[i].name != NULL; i++) {            │   │
  │  │     if (strcmp(op->name(), funcs[i].name) == 0)           │   │
  │  │       info = &(funcs[i]);  break;                        │   │
  │  │   }                                                       │   │
  │  │   → 匹配到 funcs[9] = {"jcmd", jcmd}                     │   │
  │  └───────────────────────────────────────────────────────────┘   │
  │                           │                                       │
  │                           ▼                                       │
  │  ┌───────────────────────────────────────────────────────────┐   │
  │  │ res = (info->func)(op, &st);  [attachListener.cpp:406]   │   │
  │  │   → jcmd(op, &st)  [attachListener.cpp:202]              │   │
  │  │     → DCmd::parse_and_execute(DCmd_Source_AttachAPI,     │   │
  │  │            out, op->arg(0), ' ', THREAD)  [:208]         │   │
  │  │     → [10-02] DCmd 框架接管                               │   │
  │  └───────────────────────────────────────────────────────────┘   │
  │                           │                                       │
  │                           ▼                                       │
  │  ┌───────────────────────────────────────────────────────────┐   │
  │  │ op->complete(res, &st);  [attachListener.cpp:414]        │   │
  │  │   → LinuxAttachOperation::complete()  [linux.cpp:409]     │   │
  │  │     ├─ ThreadBlockInVM tbivm(thread)  [:411]             │   │
  │  │     ├─ write_fully(socket, msg)      [:420]              │   │
  │  │     ├─ write_fully(socket, st->base(), st->size()) [:424] │   │
  │  │     ├─ shutdown(socket, SHUT_RDWR)   [:425]              │   │
  │  │     ├─ close(socket)                 [:429]              │   │
  │  │     └─ delete this                   [:434]              │   │
  │  └───────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────┐
  │ jcmd 进程          │            read() 收到结果 → stdout 输出
  │ 关闭连接          │            close(socket)
  └──────────────────┘
```

### 1.2 为什么选择 Unix 域套接字而不是 TCP？

**原因一：SO_PEERCRED 权限模型**

TCP 没有内核级身份认证。Unix 域套接字允许通过 `getsockopt(SO_PEERCRED)` 取得连接对端的 pid/uid/gid——**内核保证不可伪造**：

```cpp
// attachListener_linux.cpp:360-372
struct ucred cred_info;
socklen_t optlen = sizeof(cred_info);
::getsockopt(s, SOL_SOCKET, SO_PEERCRED, (void*)&cred_info, &optlen);

if (!os::Posix::matches_effective_uid_and_gid_or_root(cred_info.uid, cred_info.gid)) {
  ::close(s);
  continue;   // ← 拒绝未授权连接，重新 accept
}
```

只有同用户或 root 能 attach。TCP 需要自己实现认证协议，增加攻击面。而且 Unix 域套接字是文件系统命名空间——不需要端口号分配，不需要 listen backlog 的 IP 暴露风险。

**原因二：无需 TCP 协议栈开销**

Unix 域套接字在内核中的实现是 `unix_stream_ops`——数据传输完全在内存缓冲区中进行，没有 TCP 三次握手、SYN 重传、TIME_WAIT。`connect() + write() + read() + close()` 的整体开销约 20-30μs。

**原因三：套接字文件是"能力"凭证**

`/tmp/.java_pid<PID>` 文件的权限是 `0600`（`S_IREAD|S_IWRITE`，`attachListener_linux.cpp:223`），属主强制为 `geteuid()/getegid()`（:227）。能 `connect()` 到这个文件的用户已经通过了文件系统权限——这是第二层安全校验（第一层是 SO_PEERCRED）。

### 1.3 初始化两条路径

**路径一：VM 启动时（`-XX:+StartAttachListener`）**

```cpp
// thread.cpp:4184-4189
if (!DisableAttachMechanism) {
  AttachListener::vm_start();   // → 清理残留套接字文件
  if (StartAttachListener || AttachListener::init_at_startup()) {
    AttachListener::init();     // → 创建套接字 + 创建线程
  }
}
```

- `vm_start()`（`attachListener_linux.cpp:461-477`）：`unlink` 残留的 `.java_pid<PID>` 文件
- `init()`（`attachListener.cpp:435-487`）：创建 `new JavaThread(&attach_listener_thread_entry)`（:472）→ `Thread::start()`（:485）

**路径二：SIGBREAK 信号触发 lazy init**

```cpp
// os.cpp:367-388 (signal_thread_entry 中的 SIGBREAK 处理)
AttachListener::transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED);
// CAS 成功 → 调用 is_init_trigger()
// CAS 失败 + cur_state == AL_INITIALIZING → 忽略（别人在初始化）
// CAS 失败 + cur_state != AL_NOT_INITIALIZED → 已初始化
```

`is_init_trigger()`（`attachListener_linux.cpp:531-561`）检查触发文件 `.attach_pid<PID>`（先在 CWD 查，再在 `/tmp` 查），验证文件属主 uid → 调用 `init()`。

### 1.4 DisableAttachMechanism 的全局控制

`globals.hpp:2461`：

```cpp
product(bool, DisableAttachMechanism, false,
        "Disable mechanism that allows tools to attach to this VM")
```

效果：
- `AttachListener::is_attach_supported()` 返回 `false`（`:110`）→ `vm_start()` 整个块被跳过（`thread.cpp:4184`）
- 套接字文件不存在 → `jcmd <PID>` 报 `"Can't attach to the process"`
- **注意**：JMX 的 `DiagnosticCommandMBean` 仍然可用（[10-02]§六有详细说明）

同样，`EnableDynamicAgentLoading`（`globals.hpp:2467`）控制 `load` 命令：

```cpp
// attachListener.cpp:383-386
if (!EnableDynamicAgentLoading && strcmp(op->name(), "load") == 0) {
  st.print("Dynamic agent loading is not enabled. ...");
  res = JNI_ERR;
}
```

### 1.5 套接字文件生命周期

```
socket(PF_UNIX, SOCK_STREAM, 0)          [linux.cpp:203]  创建套接字fd
  → bind(listener, &addr)                [:214]            绑定到 .tmp 名称
  → listen(listener, 5)                  [:221]            监听（backlog=5）
  → chmod(path, 0600)                    [:223]            设置权限
  → chown(path, geteuid(), getegid())    [:227]            强制属主
  → rename(.tmp → .java_pid<PID>)        [:229]            原子重命名 ★
  → atexit(listener_cleanup) 注册        [:190]            退出时清理
```

`rename()` 是原子的——不存在"半创建的套接字文件被 jcmd 看到"的竞态窗口。`listener_cleanup()` 在进程退出时（`atexit` 注册）执行 `shutdown(fd, SHUT_RDWR)` + `close(fd)` + `unlink(path)`。

---

## §二 ★★★ attach_listener_thread_entry() 逐行走读

### ❓ 这个线程是 JavaThread 还是 os::thread？为什么？

是 JavaThread。创建点在 `attachListener.cpp:472`：

```cpp
JavaThread* listener_thread = new JavaThread(&attach_listener_thread_entry);
```

**为什么必须是 JavaThread？**

1. **ThreadBlockInVM 需要 JavaThread**：`_thread_in_vm → _thread_blocked` 的状态转换是 JavaThread 的能力——它需要 `JavaThread::set_thread_state()` 和 safepoint 协议支持
2. **Java 层可见性**：`jstack` 的输出显示 "Attach Listener" 线程——它对应一个 `java.lang.Thread` 对象，JVM 可以通过 `JavaThread::threadObj()` 拿到该对象的 oop
3. **和 VMThread 的协调**：VMThread 的 safepoint 扫描遍历 `ThreadsList`，所有 JavaThread 都在其中；非 JavaThread 的 `os::thread` 不在 safepoint 管控范围内

**但它永远不执行 Java 字节码**——`_thread_state` 始终为 `_thread_in_native`（值=4），线程栈上无任何 Java 解释器帧或编译帧。

### 2.1 线程的完整生命周期

```
Threads::create_vm()                                [thread.cpp:3886]
  └─ AttachListener::vm_start()                     [:4185]  清理残留文件
  └─ AttachListener::init()                         [:4188]  条件触发
       └─ new JavaThread(&attach_listener_thread_entry) [:472]
            ├─ set_threadObj(java.lang.Thread obj)  [:446-455]  Java Thread 对象
            ├─ Threads::add(listener_thread)        [:484]      加入线程列表
            └─ Thread::start(listener_thread)       [:485]      创建 OS 线程
                 └─ os::create_thread() → pthread_create()
                      └─ thread_native_entry()
                           └─ JavaThread::run()     [thread.cpp:1927]
                                └─ transition_and_fence(_thread_new, _thread_in_vm)
                                └─ thread_main_inner()
                                     └─ attach_listener_thread_entry(thread, TRAPS)
                                          ├─ pd_init()                          [:358]
                                          │    └─ LinuxAttachListener::init()    [linux:182]
                                          │         └─ socket() + bind() + listen() + rename()
                                          ├─ set_initialized()                   [:362]
                                          └─ for(;;) {                          [:364]
                                               op = dequeue()                     [:365]
                                               if (op == NULL) return;            [:366] ← shutdown
                                               funcs[] dispatch                  [:389-406]
                                               op->complete(res, &st)             [:414]
                                             }
```

### 2.2 pd_init() — 平台初始化

```cpp
// attachListener_linux.cpp:479-493
bool AttachListener::pd_init() {
  JavaThread* thread = JavaThread::current();
  ThreadBlockInVM tbivm(thread);     // ★ _thread_in_vm → _thread_blocked
  thread->set_suspend_equivalent();
  int ret_code = LinuxAttachListener::init();  // socket() + bind() + listen()
  thread->check_and_wait_while_suspended();
  return (ret_code == 0);
}
```

**为什么需要 ThreadBlockInVM？** `init()` 中的 `socket()/bind()/listen()` 是系统调用——如果 JVM 正在进入 safepoint，AttachListener 线程应在 `_thread_blocked` 中等 safepoint 结束再执行 I/O 操作。在 `_thread_in_vm` 中调用 `socket()` 是安全的（栈已 walkable），但改用 `_thread_blocked` 让 VMThread 的 SPIN 可以放行。

### 2.3 dequeue 循环 → 命令调度 → 结果返回

```cpp
// attachListener.cpp:364-414
for (;;) {
  AttachOperation* op = AttachListener::dequeue();  // ← 阻塞等待客户端连接
  if (op == NULL) {
    AttachListener::set_state(AL_NOT_INITIALIZED);
    return;   // shutdown 路径
  }

  bin_spv:
  if (strcmp(op->name(), "detachall") == 0) {
    AttachListener::detachall();                    // ← 特殊：清理所有客户端
  } else if (!EnableDynamicAgentLoading && strcmp(op->name(), "load") == 0) {
    st.print("Dynamic agent loading is not enabled...");
    res = JNI_ERR;
  } else {
    AttachOperationFunctionInfo* info = NULL;
    for (int i=0; funcs[i].name != NULL; i++) {    // ← 线性搜索调度表
      if (strcmp(op->name(), funcs[i].name) == 0) {
        info = &(funcs[i]); break;
      }
    }
    if (info != NULL) {
      res = (info->func)(op, &st);                 // ← 调用命令函数
    } else {
      st.print("Operation %s not recognized!", op->name());
      res = JNI_ERR;
    }
  }

  op->complete(res, &st);                           // ← 发送结果回客户端
}
```

**dequeue() 返回 NULL 的唯一情况**：`listener_cleanup()` → `shutdown(fd, SHUT_RDWR)` → `accept()` 返回 -1 → `LinuxAttachListener::dequeue()` 返回 NULL → `AttachListener::dequeue()` 的包装返回 NULL → 线程退出。

### 2.4 ★ 线程状态：永远在 _thread_in_native

```cpp
// attachListener.cpp:365 — dequeue 调用点
AttachOperation* op = AttachListener::dequeue();

// 此时线程经过 ThreadBlockInVM 的 dtor 已回到 _thread_in_vm
// 但 dequeue 调用只在 AttachListener::dequeue() [linux.cpp:440] 中
// 又通过 ThreadBlockInVM tbivm(thread) 转为 _thread_blocked
// → accept() 阻塞在 _thread_blocked 中
// → accept() 返回后 dtor 回到 _thread_in_vm
// → funcs[] dispatch 执行在 _thread_in_vm 中
// → op->complete() 中的 ThreadBlockInVM 又转为 _thread_blocked 写数据
// → 最终 dequeue 外部线程回到 _thread_in_vm
```

关键设计：**所有可能长时间阻塞的操作（accept, write_fully）都在 `_thread_blocked` 中进行**——这样 VMThread 在 safepoint 检查时看到 `_thread_blocked` → `safepoint_safe()=true` → 放行。

---

## §三 ★★ LinuxAttachListener::dequeue() — 套接字 I/O 全貌

### 3.1 为什么有两个 dequeue？

| 函数 | 位置 | 角色 |
|------|------|------|
| `AttachListener::dequeue()` | `attachListener_linux.cpp:440-454` | **包装层**：ThreadBlockInVM + suspend 处理 + 转发 |
| `LinuxAttachListener::dequeue()` | `attachListener_linux.cpp:347-384` | **实现层**：accept() + SO_PEERCRED + read_request() |

调用关系：

```
attach_listener_thread_entry           [attachListener.cpp:348]
  └─ AttachListener::dequeue()        [attachListener.cpp:365  ← 跨平台接口]
       └─ AttachListener::dequeue()   [linux.cpp:440           ← 平台实现 start]
            └─ ThreadBlockInVM tbivm  [:442]                    ← ★ 转 _thread_blocked
            └─ LinuxAttachListener::dequeue() [:448]            ← 真正的 I/O 阻塞
                 └─ accept()          [:354]
                 └─ SO_PEERCRED       [:362]
                 └─ read_request(s)   [:376]
```

### 3.2 accept() 阻塞期间 JVM shutdown 怎么唤醒？

```cpp
// attachListener_linux.cpp:165-178 — atexit handler
static void listener_cleanup() {
  int s = LinuxAttachListener::listener();
  if (s != -1) {
    LinuxAttachListener::set_listener(-1);
    ::shutdown(s, SHUT_RDWR);   // ← ★ 中断 accept() 阻塞！
    ::close(s);
  }
  if (LinuxAttachListener::has_path()) {
    ::unlink(LinuxAttachListener::path());   // 删除套接字文件
  }
}
```

`shutdown(fd, SHUT_RDWR)` 使监听 socket fd 不可读写 → 内核向在 `accept()` 上阻塞的线程返回 `EINVAL`（或 `ECONNABORTED`）→ `s == -1` → `dequeue()` 返回 NULL → `attach_listener_thread_entry` 中的 `if (op == NULL) return` → 线程退出。

这里有一个微妙细节：`set_listener(-1)` 在 `shutdown()` 之前——先设为 -1 避免 `accept()` 中的 `RESTARTABLE` 宏在被信号中断后重试时用到已失效的 fd。

### 3.3 SO_PEERCRED 身份验证的详细流程

```cpp
// attachListener_linux.cpp:359-373
struct ucred cred_info;
socklen_t optlen = sizeof(cred_info);
if (::getsockopt(s, SOL_SOCKET, SO_PEERCRED, (void*)&cred_info, &optlen) == -1) {
  ::close(s);
  continue;    // ← getsockopt 失败：关闭连接，等待下一个
}

if (!os::Posix::matches_effective_uid_and_gid_or_root(cred_info.uid, cred_info.gid)) {
  ::close(s);
  continue;    // ← uid/gid 不匹配：关闭连接，等待下一个
}
```

**SO_PEERCRED 的数据来源**：`struct ucred` 包含 `pid`、`uid`、`gid`——这些值由内核在 `connect()` 时从发起方进程的 `current->pid`、`current->euid`、`current->egid` 中填入。内核保证不可伪造——用户态无法直接修改这些值。

**matches_effective_uid_and_gid_or_root()** 的语义：如果 `cred_info.uid == 0`（root）→ 通过。如果 `cred_info.uid == geteuid() && cred_info.gid == getegid()` → 通过。其余 → 拒绝。

这意味着：root 可以 attach 到任何用户的 JVM；同用户进程可以 attach 到自己的 JVM；不同用户进程（非 root）被拒绝。

---

## §四 ★★ 协议格式：read_request() 与 write_fully()

### 4.1 协议字符串格式

```cpp
// attachListener_linux.cpp:254-262 — 注释中的协议格式说明
// The request is:
//   <ver>0<cmd>0<arg>0<arg>0<arg>0
// where <ver> is the protocol version (1), <cmd> is the command
// name ("load", "datadump", ...), and <arg> is an argument
```

实际例子：
- `jcmd help` → `"1\0jcmd\0help\0\0\0"`（6 个 NUL）
- `threaddump` → `"1\0threaddump\0\0\0\0"`（5 个 NUL）
- `load instrument false "agent.jar=arg1=abc,arg2=def"` → `"1\0load\0instrument\0false\0agent.jar=arg1=abc,arg2=def\0"`

### 4.2 为什么用 \0 分隔而不是 HTTP 风格？

| 维度 | `\0` 分隔 | HTTP `\r\n` 分隔 |
|------|----------|-----------------|
| **解析复杂度** | 逐字节扫描 `buf[i] == 0`，计数即可 | 需要处理 `\r\n` 转义、Content-Length |
| **参数中可否含分隔符** | `\0` 不出现在合法参数值中（C 字符串惯例） | 参数可能含 `\r\n` → 需要 URL 编码 |
| **代码量** | ~50 行（`:265-338`） | 至少 200+ 行（header 解析 + body 分隔） |
| **信号安全性** | 纯内存操作，不依赖 malloc | 可能依赖动态分配 |

`\0` 分隔让解析极简——`ArgumentIterator` 类（`:135-160`）就是包装了 `buf[off+i] == 0` 检测 + 指针后移。

### 4.3 read_request() 的逐字节解析

```cpp
// attachListener_linux.cpp:273-304 — 核心读取循环
do {
  int n;
  RESTARTABLE(read(s, buf+off, left), n);    // ← EINTR 自动重试
  buf[max_len - 1] = '\0';                   // ← 防止越界
  if (n == -1) return NULL;                   // ← 对端重置
  if (n == 0) break;                          // ← EOF
  for (int i=0; i<n; i++) {
    if (buf[off+i] == 0) {                    // ← ★ \0 检测
      str_count++;
      if (str_count == 1) {                   // ← 第一个 string 是版本号
        if (atoi(buf) != ATTACH_PROTOCOL_VER) { // ← 版本不匹配
          char msg[32];
          sprintf(msg, "%d\n", ATTACH_ERROR_BADVERSION);  // 发送 "101\n"
          write_fully(s, msg, strlen(msg));
          return NULL;
        }
      }
    }
  }
  off += n;
  left -= n;
} while (left > 0 && str_count < expected_str_count);  // expected = 5
```

**为什么版本号必须是第一个 string？** 协议版本检查必须在解析任何参数之前完成——如果版本不匹配，后续所有字段的偏移都会错位。先读版本号 8 bytes 做版本检查，再做完整的 `\0` 计数。

**参数长度限制 1024 是硬限制吗？** 是的。`:329-331`：

```cpp
if (strlen(arg) > AttachOperation::arg_length_max) {
  delete op;
  return NULL;     // ← 显式拒绝，不产生缓冲区溢出
}
```

### 4.4 write_fully() 的 EINTR 重试循环

```cpp
// attachListener_linux.cpp:387-399
int LinuxAttachListener::write_fully(int s, char* buf, int len) {
  do {
    int n = ::write(s, buf, len);
    if (n == -1) {
      if (errno != EINTR) return -1;    // ← ★ 非 EINTR 错误直接失败
    } else {
      buf += n;                          // ← 短写处理：移动指针继续写
      len -= n;
    }
  } while (len > 0);
  return 0;
}
```

**为什么需要 EINTR 重试？** POSIX 的 `write()` 在信号中断后返回 -1 并设 `errno=EINTR`——已写入的字节数不确定。`do-while` 循环保证即使信号中断也继续写入剩余数据。

**和 VMError 的 `::write()` 对比**：VMError 路径（[04-VMError]）只能用单条 `::write(fd, buf, len)`——信号处理器内不能循环重试（嵌套信号安全问题）。AttachListener 在 `_thread_blocked` 中——可以安全重试。

---

## §五 ★ funcs[] 调度表 + 三态状态机

### 5.1 10 个内置命令全景

```cpp
// attachListener.cpp:328-340
static AttachOperationFunctionInfo funcs[] = {
  { "agentProperties",  get_agent_properties },   // → 读 agent 系统属性
  { "datadump",         data_dump },               // → 触发 JVMTI DataDump
  { "dumpheap",         dump_heap },               // → HeapDumper::dump() ★ STW
  { "load",             load_agent },              // → 加载 JVMTI agent
  { "properties",       get_system_properties },   // → 读 System::getProperties
  { "threaddump",       thread_dump },             // → 线程 dump ★ STW
  { "inspectheap",      heap_inspection },         // → 类直方图 ★ STW
  { "setflag",          set_flag },                // → 动态改 VM flag
  { "printflag",        print_flag },              // → 读 VM flag
  { "jcmd",             jcmd },                    // → ★ 桥接到 DCmd 框架
  { NULL,               NULL }
};
```

按类别分组：

| 类别 | 命令 | 最终走到哪些子系统 |
|------|------|------------------|
| 堆操作 | `dumpheap` | `HeapDumper::dump()` → GC + 堆遍历 |
| 堆操作 | `inspectheap` | `VM_GC_HeapInspection` → VMThread → safepoint |
| 线程 | `threaddump` | `ThreadService::dump_all_threads()` → VMThread → safepoint |
| agent | `load` | `JvmtiExport::load_agent_library()` → agentmain |
| agent | `agentProperties` | `VMSupport::serializeAgentPropertiesToByteArray()` |
| VM 配置 | `setflag` / `printflag` | `JVMFlag::find_flag()` / `WriteableFlags::set_flag()` |
| VM 配置 | `properties` | `VMSupport::serializePropertiesToByteArray()` |
| 诊断 | `datadump` | JVMTI DataDump + JFR checkpoint |
| **桥梁** | **`jcmd`** | **`DCmd::parse_and_execute()`** → 40+ 子命令 |

### 5.2 jcmd() 是到 DCmd 框架的桥梁

```cpp
// attachListener.cpp:202-216
static jint jcmd(AttachOperation* op, outputStream* out) {
  Thread* THREAD = Thread::current();
  DCmd::parse_and_execute(DCmd_Source_AttachAPI, out, op->arg(0), ' ', THREAD);
  if (HAS_PENDING_EXCEPTION) {
    java_lang_Throwable::print(PENDING_EXCEPTION, out);
    out->cr();
    CLEAR_PENDING_EXCEPTION;
    return JNI_ERR;
  }
  return JNI_OK;
}
```

`jcmd` 不自己做任何事——它把 `op->arg(0)`（整个 jcmd 参数串，如 `"Thread.print -l"`）原样传给 `DCmd::parse_and_execute()`。这是 10-services-diag 阶段内部的第一条链（Attach → DCmd），详细展开见 [10-02]§二。

### 5.3 ★★★ transit_state() 三态转换——为什么 AL_INITIALIZING 中间态不能少？

```cpp
// attachListener.hpp:54-58
enum AttachListenerState {
  AL_NOT_INITIALIZED,   // 0 — 从未初始化
  AL_INITIALIZING,      // 1 — 正在初始化（中间态）
  AL_INITIALIZED        // 2 — 已初始化
};

// attachListener.hpp:96-99
static AttachListenerState transit_state(AttachListenerState new_state,
                                         AttachListenerState cmp_state) {
  return Atomic::cmpxchg(new_state, &_state, cmp_state);
}
```

**如果只有两态（未初始化/已初始化）会有什么竞态？**

```
时间线（两态方案——有 bug）：
──────────────────────────────────────────────────────────
Thread A (SIGBREAK 处理)          Thread B (SIGBREAK 处理)
t0: if (_state == NOT_INIT) →
                                   t0': if (_state == NOT_INIT) →
t1:                              ← 两个都判断 NOT_INIT
                                   t1': init() ← 创建线程1
t2: init() ← 创建线程2
                                   t2': set_state(INITIALIZED)
t3: set_state(INITIALIZED)
──────────────────────────────────────────────────────────
结果：两个 attach_listener 线程被创建！重复 socket() → bind() 失败！
```

**三态方案如何解决？**

```
时间线（三态方案——正确）：
──────────────────────────────────────────────────────────
Thread A (SIGBREAK 处理)          Thread B (SIGBREAK 处理)
t0: result = transit_state(        t0': result = transit_state(
        AL_INITIALIZING,                    AL_INITIALIZING,
        AL_NOT_INITIALIZED)                 AL_NOT_INITIALIZED)
     → cmpxchg 成功！                        → cmpxchg 失败！
     → result == AL_NOT_INITIALIZED     → result == AL_INITIALIZING
t1: is_init_trigger()               t1': 检测到 result != NOT_INIT
     → init() → 创建线程                    → 忽略（别人在初始化）
t2: set_initialized()
──────────────────────────────────────────────────────────
结果：只有一个线程被创建 ✓
```

**os.cpp:367-377 中的完整逻辑**：

```cpp
// os.cpp:367-377
AttachListenerState cur_state = AttachListener::transit_state(
    AL_INITIALIZING, AL_NOT_INITIALIZED);

if (cur_state == AL_INITIALIZED) {
  // 已初始化 → 走后续的 check_socket_file()
} else if (cur_state == AL_NOT_INITIALIZED) {
  // CAS 成功 → 我们是唯一的初始化者
  if (AttachListener::is_init_trigger()) {
    // 触发文件存在 → init() 已经在此函数内调用
  } else {
    AttachListener::set_state(AL_NOT_INITIALIZED);  // rollback
  }
} else if (cur_state == AL_INITIALIZING) {
  // 别的线程正在初始化 → 忽略此信号
}
```

### 5.4 detachall 和 shutdown 的清理路径

`detachall` 是特殊操作——不是通过 `funcs[]` 匹配，而是在主循环中最高优先级检查（`:381`）：

```cpp
if (strcmp(op->name(), AttachOperation::detachall_operation_name()) == 0) {
  AttachListener::detachall();  // → pd_detachall() (Linux 上为 no-op)
}
```

shutdown 路径：
```
JVM 退出 → atexit → listener_cleanup()
  → shutdown(fd, SHUT_RDWR)           ← 中断 accept()
  → accept() 返回 -1                   ← LinuxAttachListener::dequeue()
  → dequeue() 返回 NULL                ← AttachListener::dequeue()
  → if (op == NULL) return             ← attach_listener_thread_entry
  → 线程退出
```

---

## §六 ★★★ 和 [09-JNI] 的"内/外"对称性

### 6.1 两条接口管道的对照表

| 维度 | JNI 入口（内部管道） | Attach 入口（外部管道） |
|------|---------------------|----------------------|
| **调用方向** | Java → native 方法（下行）/ native → JNI 函数（上行） | 外部进程 → JVM 线程（外部敲进来） |
| **入口点** | `JVM_ENTRY` 宏展开（[09-04]§一） | `funcs[]` 调度表（`:328-340`） |
| **线程创建** | 常规 Java 线程 | `new JavaThread(&attach_listener_thread_entry)` (:472) |
| **常态线程状态** | `_thread_in_Java`(8) 或随调用改变 | 始终 `_thread_in_native`(4) |
| **safepoint 互动** | poll + block_if_requested（[09-01]§二） | 不参与 poll（永远被 VMThread roll_forward） |
| **阻塞操作保护** | `ThreadBlockInVM` 在 JNI 关键路径 | `ThreadBlockInVM` 三个点（dequeue, pd_init, complete） |
| **安全性** | SecurityManager + 类加载权限 | SO_PEERCRED uid/gid 验证 |
| **代表函数** | `JVM_StartThread`, `JVM_GC`, `JVM_MonitorWait` | `jcmd()`, `dump_heap()`, `thread_dump()` |

### 6.2 两条管道在哪儿汇合？

```
内部管道（JNI）:                   外部管道（Attach）:
Java code calls JVM_GC()          jcmd <PID> GC.run
  → JVM_ENTRY_NO_ENV                 → attach pipe
  → ThreadInVMfromNative             → jcmd()  [attachListener.cpp:202]
  → Universe::heap()->collect()      → DCmd::parse_and_execute()
                                         → SystemGCDCmd::execute()
                                           → Universe::heap()->collect()
                                                ← ★ 汇合点！
```

三条关键汇合点：
1. **jcmd → DCmd**：`jcmd()` (:202) → `DCmd::parse_and_execute()` ——外部命令进入诊断框架
2. **load → JVMTI**：`load_agent()` (:108) → `JvmtiExport::load_agent_library()` ——外部 agent 进入 JVMTI
3. **dumpheap → HeapDumper**：`dump_heap()` (:224) → `HeapDumper::dump()` ——外部工具获取堆快照

### 6.3 和 safepoint 的不同互动方式

JNI 线程在从 native 返回 VM 时主动 poll（[09-01]§二 `transition_from_native()`），有可能被 safepoint 截停进入 `_thread_blocked`。AttachListener 线程**永远在 `_thread_in_native` 或 `_thread_blocked`**——VMThread 的 `examine_state_of_thread()` 对这两种状态都走 `safepoint_safe()=true` → `roll_forward(_at_safepoint)` → 直接放行。

这是合理的：AttachListener 只在阻塞 I/O 期间（`accept`, `write_fully`）切到 `_thread_blocked`，此时不访问 Java 堆——GC 不需要等待它。当它回到 `_thread_in_vm` 执行命令 dispatch 时，如果有 safepoint 正在进行——线程自已在 `_thread_in_vm` 中，走 `_call_back` 路径，在下次 `block_if_requested` 时入 blocked。

---

## §七 GDB 验证 + 可证伪断言

### 断言 1：套接字文件存在且可访问

```bash
$ ls -la /tmp/.java_pid<PID>
# 预期：srwx------ 1 <user> <group> 0 ... /tmp/.java_pid<PID>
```
**可证伪**：类型为 `s`（Unix 域套接字），权限 0600。

### 断言 2：accept() 返回客户端 fd

```bash
(gdb) br attachListener_linux.cpp:354
(gdb) p s
# 预期：s >= 3（client fd）
(gdb) bt
# 预期：#0 LinuxAttachListener::dequeue at attachListener_linux.cpp:354
```

### 断言 3：SO_PEERCRED 读取的 uid 和 geteuid() 一致

```bash
(gdb) br attachListener_linux.cpp:362
# 在断点命中后：
(gdb) p cred_info.uid
(gdb) p geteuid()
# 预期：两者相等（或 cred_info.uid == 0 表示 root）
(gdb) p cred_info.gid
(gdb) p getegid()
# 预期：两者相等（或 root）
```

### 断言 4：协议版本号是 "1"

```bash
(gdb) br attachListener_linux.cpp:291
(gdb) p buf
# 预期：前几个字节是 "1\0jcmd\0..."（第一个 NUL 前的字符串是 "1"）
(gdb) p strcmp(buf, "1")
# 预期：0（等于 ATTACH_PROTOCOL_VER）
```

### 断言 5：write_fully() 的 EINTR 重试

```bash
(gdb) br attachListener_linux.cpp:389
# 持续运行，向 JVM 发送 SIGUSR1
# 观察 n == -1 且 errno == EINTR → 循环继续（不返回 -1）
(gdb) p errno
# 预期在信号到达时：errno == EINTR (4)
```

### 断言 6：transit_state() CAS 只成功一次

```bash
# 两个终端同时执行 kill -SIGBREAK <PID>
(gdb) br attachListener.hpp:98
# 第一次命中：result == AL_NOT_INITIALIZED (0) → CAS 成功
# 第二次命中：result != AL_NOT_INITIALIZED → 跳过（别人在初始化）
```

### 断言 7：AttachListener 线程状态为 _thread_in_native (4)

```bash
(gdb) br attachListener.cpp:365
(gdb) p JavaThread::current()->_thread_state
# 预期值：_thread_in_native = 4
# 注意：枚举值 _thread_in_native=4（globalDefinitions.hpp:894）
```

### 断言 8：DisableAttachMechanism=true 跳过了 vm_start

```bash
$ java -XX:+DisableAttachMechanism ...
(gdb) br thread.cpp:4185
# 预期：断点不命中（被 if (!DisableAttachMechanism) 跳过）
# 验证：ls /tmp/.java_pid<PID> → No such file
```

### 断言 9：jcmd() 调用 DCmd::parse_and_execute 时 source = DCmd_Source_AttachAPI

```bash
(gdb) br attachListener.cpp:208
(gdb) p source
# 预期：source = DCmd_Source_AttachAPI (0x2)
```

### 断言 10：listener_cleanup() 的 shutdown 使 accept() 返回 -1

```bash
(gdb) br attachListener_linux.cpp:170
# JVM shutdown → 命中此断点
(gdb) n  # 执行 shutdown(s, SHUT_RDWR)
# AttachListener 线程中 accept() 返回 -1
(gdb) p s
# 预期：-1（LinuxAttachListener::dequeue() 返回 NULL）
```

### 断言 11：attach_listener_thread_entry 调用栈无 Java 方法帧

```bash
(gdb) br attachListener.cpp:349
(gdb) bt
# 预期：栈上只有 native C++ 帧
# #0  attach_listener_thread_entry at attachListener.cpp:349
# #1  JavaThread::thread_main_inner at thread.cpp:1927
# #2  JavaThread::run at ...
# #3  thread_native_entry at os_linux.cpp:885
# 不含任何 J=compiled 或 j=interpreted 帧
```

### 断言 12：funcs[] 中 jcmd 的位置正确

```bash
(gdb) br attachListener.cpp:338
(gdb) p funcs[9].name
# 预期："jcmd"
(gdb) p funcs[9].func == jcmd
# 预期：true
```

---

## 生产陷阱速查

| 陷阱 | 原因 | 影响 |
|------|------|------|
| `GC.run` 在线上触发 Full GC | `GenCollectedHeap::collect(GCCause::_jcmd)` → STW | 几秒到几分钟不等的服务不可用 |
| `jmap -dump:live` 的 STW | `HeapDumper` 先 Full GC 再遍历堆 | 32GB 堆可能 30-60s STW |
| 容器 PID namespace 导致 attach 失败 | `/tmp/.java_pid<PID>` 在宿主 namespace 不可见 | `docker exec` 替代方案 |
| `rm /tmp/.java_pid<PID>` 只影响新连接 | inode 只在 fd 关闭后释放 | 已连接的不受影响 |
| `DisableAttachMechanism` 不阻止 JMX | JMX 走 `MBeanServer.invoke()` → DCmd | 需要额外禁用 JMX |

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | Unix 域套接字 + SO_PEERCRED | 内核级身份验证（不可伪造），优于 TCP 的 self-auth |
| 2 | 三态转换 CAS 保护 | `AL_INITIALIZING` 中间态用 `Atomic::cmpxchg` 保证唯一初始化者 |
| 3 | 两层 dequeue 设计 | `AttachListener::dequeue()` 包装 `ThreadBlockInVM` → 转发 `LinuxAttachListener::dequeue()` 的 `accept()` |
| 4 | `\0` 分隔协议 | 极简解析——逐字节扫描 `buf[i]==0`，无需 URL 编码或 HTTP header |
| 5 | JavaThread 但不执行 Java | AttachListener 是 JavaThread 但永远在 `_thread_in_native`——stacks 无 Java 帧 |
| 6 | shutdown(fd, SHUT_RDWR) 中断 accept | atexit handler → shutdown → accept 返回 -1 → dequeue 返回 NULL → 线程退出 |
| 7 | ThreadBlockInVM 三个注入点 | dequeue（accept 前）、pd_init（socket 创建）、complete（write 数据）|
| 8 | jcmd 是 DCmd 的桥梁 | `funcs[]` 中唯一把整个参数串转发到另一个框架的命令 |
