# PROMPT: 请撰写 03-Attach-API.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：使用 `jcmd` 或 `jstack` 无法连接到目标 Java 进程：

```
$ jcmd 12345 VM.version
12345:
com.sun.tools.attach.AttachNotSupportedException:
  Unable to open socket file /proc/12345/root/tmp/.java_pid12345: target process not responding or HotSpot VM not loaded
```

或者：

```
$ jstack -l 12345
12345: Unable to open socket file: target process not responding or HotSpot VM not loaded
  - The VM has not been started with -XX:+StartAttachListener
  - The VM has been started with -XX:+DisableAttachMechanism
  - The VM is running with an incompatible version of HotSpot
```

**根因分析**：Attach 机制经过 6 个阶段：

1. **客户端触发**（`VirtualMachineImpl.java:281`）：`createAttachFile(pid)` 创建 `/proc/<pid>/cwd/.attach_pid<ns_pid>` 触发文件
2. **信号发送**（`VirtualMachineImpl.c:123`）：`kill(pid, SIGQUIT)` 向目标进程发信号
3. **信号处理**（`os.cpp:374`）：`signal_thread_entry` 的 SIGBREAK handler 调用 `AttachListener::is_init_trigger()` 检测触发文件
4. **状态转换**（`os.cpp:368`）：CAS 原子操作 `transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED)` 防止并发
5. **Socket 创建**（`attachListener_linux.cpp:182`）：`LinuxAttachListener::init()` 创建 Unix Domain Socket → `socket(PF_UNIX)` → `bind(.java_pid<pid>.tmp)` → `chmod 0600` → `rename` 为最终路径
6. **主循环**（`attachListener.cpp:348`）：`attach_listener_thread_entry` → `dequeue()` → `accept()` 阻塞等待客户端连接 → `read_request()` 解析协议 → `funcs[]` 分发命令 → `complete()` 写回结果

最常见失败原因：第 5 步未完成（socket 文件未出现），客户端轮询超时。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查目标 JVM 是否支持 Attach
jcmd <pid> VM.flags -all | grep -E "StartAttachListener|DisableAttachMechanism"
# 期望: DisableAttachMechanism=false
# 或: jinfo <pid> | grep DisableAttachMechanism

# 2. 检查 socket 文件是否存在
ls -la /proc/<pid>/root/tmp/.java_pid* 2>/dev/null
# 期望: srwx------ 1 <user> <group> ... .java_pid<ns_pid>
# 不存在 → 发送 SIGQUIT 触发: kill -SIGQUIT <pid>
# 再次检查: sleep 1 && ls -la /proc/<pid>/root/tmp/.java_pid*

# 3. GDB 断点验证 Attach 全链路
gdb -ex "break os.cpp:374" \
    -ex "break attachListener_linux.cpp:182" \
    -ex "break attachListener.cpp:348" \
    -ex "break attachListener.cpp:134" \
    -ex "run" \
    -ex "print AttachListener::get_state()" \
    -ex "print LinuxAttachListener::_listener" \
    --args java -XX:+StartAttachListener com.example.Main
```

**反事实**：如果 Attach 机制没有延迟初始化（on-demand via SIGQUIT）而是 JVM 启动时总是创建 socket → 每个 Java 进程都创建 `/tmp/.java_pid<N>` socket 文件 → 启动时间增加 ~2ms（socket + bind + chmod + rename）→ 对于短生命周期进程（如 `java -version`）这是纯开销 → 浪费一个 fd（系统 fd 限制 ~1024/4096）→ `/tmp/` 目录被数百个 socket 文件污染。延迟初始化确保了只有被显式 attach 的进程才承担这些开销。SIGQUIT 在 HotSpot 中的双重用途（attach 触发 + thread dump）使得这个设计零额外信号成本。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE Attach API execution path from client-side `jcmd <pid> <command>` through Unix Domain Socket communication to server-side command dispatch in the Attach Listener thread. This is NOT a tutorial on "how to use jcmd" — it's ENGINEERING documentation on HOW the JVM implements dynamic attach in source-code-specific detail.

Reader completed **01-Agent-Loading**（JPLISAgent, Agent_OnLoad, VMInit callback）, **02-ClassFileLoadHook**（JVMTI event pipeline, JvmtiClassFileLoadHookPoster）. This doc: **how an external tool (jcmd/jstack/jmap) connects to a running JVM, sends a command over a Unix Domain Socket, and gets the result back** — from `VirtualMachine.attach(pid)` at VirtualMachine.java:194 to `Agent_OnAttach` at jvmtiExport.cpp:2636.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When you run `jcmd 12345 GC.run`, the client first calls `VirtualMachine.attach("12345")` at VirtualMachine.java:194. The Linux implementation at VirtualMachineImpl.java:54 resolves the target process's PID namespace by reading `/proc/12345/status` (:325-354) to handle containerized environments. It then checks for an existing socket file at `/proc/12345/root/tmp/.java_pid<ns_pid>` (:73). If the socket doesn't exist—meaning the Attach Listener hasn't been started—the client creates a trigger file `.attach_pid<ns_pid>` in the target's working directory (:281) and sends `kill(pid, SIGQUIT)` at VirtualMachineImpl.c:123. The target JVM's Signal Dispatcher thread (`signal_thread_entry` at os.cpp:346) receives SIGQUIT (aliased as SIGBREAK in HotSpot). It first tries a CAS state transition from `AL_NOT_INITIALIZED` to `AL_INITIALIZING` at os.cpp:368. If successful, it calls `AttachListener::is_init_trigger()` at attachListener_linux.cpp:531 which checks for the `.attach_pid<ns_pid>` file and calls `AttachListener::init()` at attachListener.cpp:435. This creates the Attach Listener thread, which calls `pd_init()` → `LinuxAttachListener::init()` at attachListener_linux.cpp:182—creating a Unix Domain Socket at `/tmp/.java_pid<ns_pid>`, binding it with 0600 permissions (:233), listening with backlog=5 (:234), and atomically renaming the socket file into place. The Attach Listener thread then enters an infinite loop at attachListener.cpp:348: `dequeue()` blocks on `accept()` (:354 in attachListener_linux.cpp), `read_request()` parses the null-delimited protocol (`1\0GC.run\0\0\0\0`), and a function table (`funcs[]` at attachListener.cpp:328-340) dispatches to the command handler. For `GC.run`, this goes through the `jcmd` handler (:202) → `DCmd::parse_and_execute()` → `VM_Operation` via `VMThread::execute()`. The result is written back via `write_fully()` and the socket is closed. The entire mechanism spans three process boundaries: the external tool (client), the JVM's Signal Dispatcher thread, and the JVM's Attach Listener thread."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **Unix Domain Socket vs TCP**: Attach 使用 `AF_UNIX` (`man 7 unix`) 而非 TCP——socket 文件位于 `/tmp/.java_pid<N>`，权限 `0600` 仅允许同用户连接。Unix Domain Socket 比 TCP loopback 快 ~2x（无 TCP 协议栈开销），内核级 `SO_PEERCRED` (`man 7 socket`) 提供不可伪造的 uid/gid 验证。Source: `attachListener_linux.cpp:233, 362`.

2. **SIGQUIT 的双重用途**: HotSpot 中 SIGQUIT（`kill -3`）有两个功能：(1) 当 `AttachListener` 未初始化时，触发 `AttachListener::init()` 启动 Attach Listener；(2) 当已初始化时，执行标准 thread dump（`VM_PrintThreads` + `VM_PrintJNI` + `VM_FindDeadlocks`）。这个双重用途由 `signal_thread_entry` 中的 CAS 状态转换控制——CAS 成功 = attach 触发，CAS 失败 = thread dump。Source: `os.cpp:362-400`.

3. **CAS 状态机与并发保护**: `AttachListenerState` 三态状态机：`AL_NOT_INITIALIZED(0)` → `AL_INITIALIZING(1)` → `AL_INITIALIZED(2)`。状态转换通过 `Atomic::cmpxchg` (`attachListener.hpp:96`) 保证只有一个线程能启动 Attach Listener。多个客户端同时发送 SIGQUIT 时，只有第一个 CAS 成功的线程执行初始化，其他线程回退到 thread dump 或 wait。Source: `attachListener.hpp:54-101`.

4. **PID Namespace 穿透**: 容器化环境下，进程在不同 PID namespace 中看到不同的 PID。客户端通过 `/proc/<pid>/status` 的 `NSpid` 字段获取目标进程视角的 PID (`VirtualMachineImpl.java:325-354`)，通过 `/proc/<pid>/root/tmp/` 穿透 mount namespace 访问目标进程的文件系统 (`VirtualMachineImpl.java:269`)。Source: `VirtualMachineImpl.java:325, 269`.

5. **Attach 协议格式**: 客户端通过 Unix Domain Socket 发送 null-delimited 请求：`"1\0<cmd>\0<arg0>\0<arg1>\0<arg2>\0"`（固定 5 个字段，版本号 + 命令 + 3 参数）。服务端 `read_request()` (`attachListener_linux.cpp:250`) 逐字节读取直到收集到 5 个 `\0` 终止符，用 `ArgumentIterator` 解析。响应第一行是十进制状态码（0=成功），后续行为命令输出。Source: `VirtualMachineImpl.java:170-183, attachListener_linux.cpp:250-339`.

6. **SO_PEERCRED 内核级安全**: `LinuxAttachListener::dequeue()` (`attachListener_linux.cpp:362`) 在 `accept()` 后调用 `getsockopt(s, SOL_SOCKET, SO_PEERCRED, &cred_info)` 获取对端进程的 uid/gid——这是内核提供的，无法伪造。`matches_effective_uid_and_gid_or_root()` 验证对端 uid/gid 与当前进程一致（root 豁免）。加上 socket 文件权限 `0600`，形成双重安全边界。Source: `attachListener_linux.cpp:362-370`.

7. **EnableDynamicAgentLoading 安全门控**: JDK 9+ 引入的全局 flag，默认 `false`。`attach_listener_thread_entry` 在处理 `load` 命令时检查此 flag (`attachListener.cpp:392`)——如果 `EnableDynamicAgentLoading` 为 false 且未通过 JVMTI 明确允许，`load` 命令被拒绝。这是对运行时动态 agent 注入的安全防护。Source: `attachListener.cpp:390-398`.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/hotspot/share/services/attachListener.hpp` — AttachListener (:62-133), AttachOperation (:136-193), AttachListenerState 枚举 (:54-58)
- `src/hotspot/share/services/attachListener.cpp` — load_agent (:108), data_dump (:155), dump_heap (:224), set_flag (:282), jcmd (:202), attach_listener_thread_entry (:348), init (:435), dequeue (:466)
- `src/hotspot/os/linux/attachListener_linux.cpp` — LinuxAttachListener (:64-109), init (:182), dequeue (:347), read_request (:250), write_fully (:387), pd_init (:479), is_init_trigger (:531)
- `src/hotspot/share/runtime/os.cpp` — signal_thread_entry (:346-409), SIGBREAK handler
- `src/hotspot/os/linux/os_linux.cpp` — SIGQUIT in vm_sigs (:680-684)
- `src/hotspot/share/prims/jvmtiExport.cpp` — load_agent_library (:2636-2724)
- `src/jdk.attach/linux/native/libattach/VirtualMachineImpl.c` — socket (:59), connect (:74), sendQuitTo (:120), write (:241)
- `src/jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java` — 构造函数 (:54), execute (:145), createAttachFile (:281), findSocketFile (:269)
- `src/jdk.attach/share/classes/sun/tools/attach/HotSpotVirtualMachine.java` — loadAgent (:135), loadAgentLibrary (:86), executeJCmd (:290)
- `src/jdk.attach/share/classes/com/sun/tools/attach/VirtualMachine.java` — attach (:194)
- `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` — isAccessUserOnly0 (:56)

Build: `make jdk`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libattach.so` — VirtualMachineImpl.c 编译
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — attachListener.cpp + attachListener_linux.cpp 编译
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libmanagement_agent.so` — FileSystemImpl.c (74 行)

System calls: `socket` (`man 2 socket`), `bind` (`man 2 bind`), `listen` (`man 2 listen`), `accept` (`man 2 accept`), `connect` (`man 2 connect`), `kill` (`man 2 kill`), `stat` (`man 2 stat`), `chmod` (`man 2 chmod`), `getsockopt(SO_PEERCRED)` (`man 7 socket`), `write` (`man 2 write`), `read` (`man 2 read`), `shutdown` (`man 2 shutdown`), `close` (`man 2 close`), `dlopen` (`man 3 dlopen`), `dlsym` (`man 3 dlsym`)

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **attachListener.hpp** | `src/hotspot/share/services/attachListener.hpp` | 195 | AttachListenerState(:54), AttachListener(:62-133), AttachOperation(:136-193) | 状态机 + 操作抽象 + 命令函数表 |
| 2 | **attachListener.cpp** | `src/hotspot/share/services/attachListener.cpp` | 494 | funcs[](:328), load_agent(:108), data_dump(:155), jcmd(:202), dump_heap(:224), set_flag(:282), thread_entry(:348), init(:435) | 🔥 命令分发 + 线程管理 |
| 3 | **attachListener_linux.cpp** | `src/hotspot/os/linux/attachListener_linux.cpp` | 583 | LinuxAttachListener(:64), init(:182), dequeue(:347), read_request(:250), is_init_trigger(:531), write_fully(:387) | 🔥 Linux 平台 Socket 实现 |
| 4 | **os.cpp** | `src/hotspot/share/runtime/os.cpp` | ~1900 | signal_thread_entry(:346-409), signal_wait, check_pending_signals | SIGBREAK handler → Attach 触发 |
| 5 | **os_linux.cpp** | `src/hotspot/os/linux/os_linux.cpp` | ~6300 | SIGQUIT in vm_sigs(:680-684), signal_notify(:3150) | 信号注册 + 通知 |
| 6 | **jvmtiExport.cpp** | `src/hotspot/share/prims/jvmtiExport.cpp` | ~2999 | load_agent_library(:2636-2724) | Agent_OnAttach 加载（load 命令的后端） |
| 7 | **VirtualMachineImpl.c** | `src/jdk.attach/linux/native/libattach/VirtualMachineImpl.c` | 265 | socket(:59), connect(:74), sendQuitTo(:120), write(:241), read(:211), checkPermissions(:133) | libattach.so — 客户端 JNI |
| 8 | **VirtualMachineImpl.java** | `src/jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java` | 376 | constructor(:54), execute(:145), createAttachFile(:281), findSocketFile(:269), getNamespacePid(:325) | 🔥 Linux 客户端实现 |
| 9 | **HotSpotVirtualMachine.java** | `src/jdk.attach/share/classes/sun/tools/attach/HotSpotVirtualMachine.java` | 395 | loadAgent(:135), loadAgentLibrary(:86), executeJCmd(:290) | 协议层 — 命令构造 + 错误码映射 |
| 10 | **VirtualMachine.java** | `src/jdk.attach/share/classes/com/sun/tools/attach/VirtualMachine.java` | 721 | attach(:194), loadAgent(:535), detach | 公共 API 抽象类 |
| 11 | **FileSystemImpl.c** | `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` | 74 | isAccessUserOnly0(:56) | libmanagement_agent.so (合并到本文) |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ 客户端 Attach 启动 — SIGQUIT 触发机制

```
问题：
  ① VirtualMachineImpl 构造函数 (VirtualMachineImpl.java:54-123) 的完整 attach 流程是什么？
      答案方向:
        1. 解析 PID + PID namespace 穿透 (:61-68):
           Integer.parseInt(vmid) → getNamespacePid(pid) 读 /proc/<pid>/status 的 NSpid 字段
           → 获取最内层 PID namespace 的 pid（容器环境关键）
        
        2. 查找 socket 文件 (:73):
           findSocketFile(pid, ns_pid) → /proc/<pid>/root/tmp/.java_pid<ns_pid>
           → /proc/<pid>/root 穿透 mount namespace
        
        3. socket 不存在时的触发流程 (:75-108):
           createAttachFile(pid, ns_pid) → 创建 /proc/<pid>/cwd/.attach_pid<ns_pid>
           sendQuitTo(pid) → kill(pid, SIGQUIT) (VirtualMachineImpl.c:123)
           指数退避轮询: delay 100ms→200ms→300ms→...直到超时
           超时过半时再发一次 SIGQUIT（"last chance"）
           finally 删除 .attach_pid 文件
        
        4. 权限检查 (:112):
           checkPermissions(socket_path) → stat64 + geteuid/getegid → 验证 owner/group/0600
        
        5. 连通性验证 (:117-122):
           创建临时 socket → connect → close
        
      追问: 为什么需要 PID namespace 穿透？
      → Docker/K8s 容器中，进程在容器内看到 PID=1，但在宿主机看到 PID=12345。
        VirtualMachine.attach("12345") 使用宿主机 PID，但 socket 文件路径
        .java_pid<pid> 中的 pid 是容器内的 ns_pid。读取 /proc/<pid>/status
        的 NSpid 字段获取容器内 PID，确保找到正确的 socket 文件。

  ② Counterfactual: 如果客户端不创建 .attach_pid 触发文件而是直接 kill(pid, SIGQUIT)？
      答案方向: 如果目标 JVM 的 AttachListener 已经初始化（socket 文件存在），
      客户端直接 connect 即可，不需要发送 SIGQUIT。但如果 socket 不存在：
      - 发送 SIGQUIT 但不创建触发文件 → signal_thread_entry 的 is_init_trigger()
        找不到 .attach_pid 文件 → 不调用 init() → 执行 thread dump 而非启动 Attach
        → 客户端永远等不到 socket 文件 → 超时失败
      - 创建触发文件但不发 SIGQUIT → 文件存在但 Signal Dispatcher 线程未收到信号
        → 不执行检查 → Attach Listener 永不启动
      触发文件 + SIGQUIT 是两个必要条件——文件是"请求"，SIGQUIT 是"敲门"。
```

### 4.2 ★★★ SIGQUIT Handler — Signal Dispatcher 线程的 Attach 触发

```
问题：
  ① signal_thread_entry (os.cpp:346-409) 的 SIGBREAK handler 如何处理 Attach 触发？
      答案方向:
        1. sig = os::signal_wait() — 阻塞等待信号
        2. switch(SIGBREAK):
           a. transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED) (:368)
              → Atomic::cmpxchg CAS 操作 — 只有一个线程成功
           b. CAS 成功 → continue（让 AttachListener::init 处理）
           c. is_init_trigger() (:374) → 检查 .attach_pid 文件 → 调用 init()
           d. check_socket_file() (:383) → socket 文件丢失 → 重启 Listener
           e. 以上都不匹配 → 标准 thread dump:
              VM_PrintThreads + VM_PrintJNI + VM_FindDeadlocks
              + Universe::print_heap_at_SIGBREAK() + JVMTI DataDumpRequest
        
      追问: 为什么需要 CAS 状态转换而不是简单的 if/else？
      → 多个客户端可能同时发送 SIGQUIT → 多个 Signal Dispatcher 唤醒竞争。
        如果没有 CAS → 两个线程可能同时进入 init() → 重复创建 socket
        → 第二个 bind() 失败（地址已被使用）→ Attach Listener 初始化失败。
        CAS 保证只有一个线程执行初始化，其他线程安全回退。

  ② Counterfactual: 如果 SIGQUIT handler 不区分 attach 触发和 thread dump——总是先尝试 init 再 thread dump？
      答案方向: 如果 AttachListener 已经初始化（socket 文件已存在），但客户端
      想获取 thread dump（jstack -F）→ 发送 SIGQUIT → handler 尝试 CAS 转状态
      → CAS 失败（已经是 INITIALIZED）→ 然后执行 thread dump → 正确。
      但如果 init() 失败（如 /tmp 目录无写权限）→ 状态回退到 NOT_INITIALIZED
      → 下一次 SIGQUIT 又尝试 init → 又失败 → thread dump 被延迟
      → 用户看到 jstack 超时。当前设计通过 check_socket_file 检测此情况并自动重试。
```

### 4.3 ★★★ LinuxAttachListener::init — Unix Domain Socket 创建

```
问题：
  ① LinuxAttachListener::init() (attachListener_linux.cpp:182-242) 的 socket 创建流程是什么？
      答案方向:
        1. atexit(listener_cleanup) — 注册进程退出时自动清理 socket 文件
        2. snprintf(path, "/tmp/.java_pid%d", pid) — 构建 socket 路径
        3. snprintf(initial_path, path + ".tmp") — 临时路径（原子 rename 用）
        4. socket(PF_UNIX, SOCK_STREAM, 0) — 创建 Unix domain socket (man 2 socket)
        5. unlink(initial_path) — 清理残留 .tmp 文件
        6. bind(listener, &addr) — 绑定地址 (man 2 bind)
        7. listen(listener, 5) — 开始监听，backlog=5 (man 2 listen)
        8. chmod(initial_path, S_IREAD|S_IWRITE) — 权限 0600 (man 2 chmod)
        9. chown(initial_path, geteuid(), getegid()) — 修复目录 s-bit 导致的 group 继承
        10. rename(initial_path, path) — 原子重命名（man 2 rename）
        
      追问: 为什么需要 .tmp 中间文件 + rename 而非直接 bind 到最终路径？
      → 原子性：bind 成功后 socket 文件立即对客户端可见。但如果 bind 成功但
        chmod/chown 尚未完成 → 客户端可能在权限设置前尝试 connect → 权限错误。
        先 bind 到 .tmp → 设置权限 → rename → 客户端只在 rename 后才看到文件
        → 保证客户端看到的始终是权限正确的 socket 文件。

  ② Counterfactual: 如果不做 chown 修复——只用 chmod 0600？
      答案方向: 目录的 setgid bit 导致新创建的文件继承目录的 group（而非进程的 egid）。
        如果 /tmp 目录有 setgid bit → socket 文件的 group 是 /tmp 的 group（如 wheel）
        → 客户端 checkPermissions 检查 sb.st_gid != getegid() → 权限检查失败
        → 即使同用户也无法 attach。chown 修复了这个 corner case。
```

### 4.4 ★★★ attach_listener_thread_entry — 主循环与命令分发

```
问题：
  ① attach_listener_thread_entry (attachListener.cpp:348-418) 的主循环逻辑是什么？
      答案方向:
        1. os::set_priority(NearMaxPriority) — 提升线程优先级
        2. pd_init() → LinuxAttachListener::init() — 创建 socket
           失败 → transit_state(NOT_INITIALIZED, INITIALIZING) → return
        3. set_initialized() — 标记 AL_INITIALIZED
        4. for(;;):
           a. op = dequeue() — 阻塞在 accept() + read_request()
              返回 NULL → transit_state(NOT_INITIALIZED, INITIALIZED) → return
           b. strcmp(op->name(), "detachall") → 特殊操作，不走 funcs[]
           c. EnableDynamicAgentLoading 检查（"load" 命令门控）
           d. 查 funcs[] 表线性匹配 → func(op, &st)
           e. 匹配不到 → pd_find_operation()（Linux 返回 NULL）
           f. 匹配不到 → "Operation ... not recognized!"
           g. op->complete(res, &st) → 写回结果 + close socket
        
      追问: 为什么 "detachall" 不走 funcs[] 表而是硬编码？
      → detachall 需要特殊处理：关闭 listener socket（不结束线程），
        等待下一个 attach 连接时重新创建 socket。funcs[] 中的函数返回
        结果码给客户端——detachall 的语义是"准备接受新连接"而非"返回结果"。

  ② Counterfactual: 如果 funcs[] 用 hash map 而非线性搜索？
      答案方向: 10 个命令 × O(10) 线性搜索 = 每次请求 ~50ns（字符串比较）。
        Hash map → O(1) = ~20ns（一次 hash + 一次比较）。
        节省 30ns，但 hash map 的内存开销 ~200 bytes（桶 + 节点），
        初始化开销 ~500ns（hash 计算 + 插入）。对于每秒最多数百次的 attach
        请求频率，线性搜索已经足够。过度优化不值得。
```

### 4.5 ★★★ LinuxAttachListener::dequeue — accept + 安全验证

```
问题：
  ① LinuxAttachListener::dequeue() (attachListener_linux.cpp:347-384) 的 accept 循环逻辑是什么？
      答案方向:
        for(;;):
          1. accept(listener, &addr, &len) — 阻塞等待客户端 connect() (man 2 accept)
             失败 → 返回 NULL
          2. getsockopt(s, SOL_SOCKET, SO_PEERCRED, &cred_info) — 获取对端 uid/gid (man 7 socket)
             失败 → close(s), continue
          3. matches_effective_uid_and_gid_or_root(cred_info.uid, cred_info.gid)
             → 不匹配 → close(s), continue（拒绝连接）
          4. read_request(s) — 解析 "1\0cmd\0arg0\0arg1\0arg2\0"
             失败 → close(s), continue
             成功 → 返回 op
        
      追问: SO_PEERCRED 的 uid/gid 为什么不可伪造？
      → SO_PEERCRED 是 Linux 内核功能——内核在 accept() 时记录对端 socket 的
        credentials（uid, gid, pid）。用户态程序无法修改内核记录的值。
        这与 SO_PASSCRED + SCM_CREDENTIALS 不同——后者允许发送方指定凭证，
        但 SO_PEERCRED 由内核自动填充，无法伪造。

  ② Counterfactual: 如果没有 SO_PEERCRED 检查——只依赖 socket 文件权限 0600？
      答案方向: 文件权限 0600 只阻止其他用户打开 socket 文件。但无法防止：
        - 同一用户在容器内启动恶意进程，attach 到同一用户的其他 JVM
        - setuid 程序以不同 uid 运行但文件 owner 相同
        SO_PEERCRED 提供了第二层防御——即使文件权限被绕过，内核级 uid 验证仍生效。
```

### 4.6 ★★★ read_request — 协议解析

```
问题：
  ① read_request (attachListener_linux.cpp:250-339) 的协议解析逻辑是什么？
      答案方向:
        1. 计算 max_len = len("1") + 1 + 17 + 3×(1024+1) ≈ 3107 字节
        2. 循环 read(s, buf+off, left) 直到收集 5 个 \0 终止的字符串
        3. str_count == 1 时验证协议版本:
           strcmp(buf, "1") != 0 → write_fully(s, "101\n") → 返回 NULL
        4. 读完 5 个字符串 → ArgumentIterator 解析:
           it.next() 跳过版本号 → it.next() 命令名 → it.next()×3 参数
        5. 创建 LinuxAttachOperation → op->set_name + op->set_arg(0/1/2)
        
      追问: 为什么 max_len 限制 3107 字节？
      → 协议固定 5 个字段：版本号(2字节含\0) + 命令名(最多17字节含\0) +
        3×参数(每个最多1025字节含\0) = 2 + 17 + 3×1025 = 3094。
        加上安全余量 ≈ 3107。超过此长度的请求被截断——防止恶意客户端
        发送无限数据耗尽服务端内存。

  ② Counterfactual: 如果不限制 max_len——允许任意长度的请求？
      答案方向: 恶意客户端可以发送无限数据 → read() 循环永远不结束
      → Attach Listener 线程永远阻塞在 read() → 无法接受新连接
      → 后续 jcmd/jstack 全部超时 → DoS 攻击。max_len 限制是安全必需的。
```

### 4.7 ★★★ load_agent → Agent_OnAttach — 运行时 agent 加载

```
问题：
  ① load_agent (attachListener.cpp:108-135) 如何到达 Agent_OnAttach？
      答案方向:
        1. 提取参数: op->arg(0)=agent名, op->arg(1)=isAbsolute, op->arg(2)=options
        2. agent名 == "instrument" → JNI 加载 java.instrument 模块:
           Module::loadModule("java.instrument") (:119)
        3. JvmtiExport::load_agent_library(name, isAbsolute, options, &st) (:134)
           → jvmtiExport.cpp:2636:
           a. os::dll_load(name) — dlopen (man 3 dlopen)
           b. os::find_agent_function("Agent_OnAttach") — dlsym (man 3 dlsym)
           c. (*Agent_OnAttach)(&main_vm, options, NULL) — 调用 agent 入口
           d. Arguments::add_loaded_agent — 记录已加载
        
      追问: 与 Agent_OnLoad (prompt-01) 的区别是什么？
      → Agent_OnLoad 在 JVM 启动时通过 create_vm_init_agents 调用，
        此时 JVMTI phase = ONLOAD → PRIMORDIAL → LIVE。
        Agent_OnAttach 在运行时通过 Attach Listener 调用，
        此时 JVMTI phase = LIVE（Java 完全就绪）。
        因此 OnAttach 不需要 VMInit 回调延迟——可以直接调用 agentmain。

  ② Counterfactual: 如果 load_agent 不做 EnableDynamicAgentLoading 检查？
      答案方向: 任何进程（包括恶意进程）可以 attach 到 JVM 并加载任意 agent
      → agent 可以修改字节码（retransform/redefine）→ 注入恶意代码
      → 窃取敏感数据、修改业务逻辑。JDK 9+ 的 EnableDynamicAgentLoading=false
      默认阻止了这种攻击面，只有通过 -XX:+EnableDynamicAgentLoading 或
      JVMTI SetEventNotificationMode 明确允许的 agent 才能动态加载。
```

### 4.8 ★★★ 客户端协议写入与响应读取

```
问题：
  ① VirtualMachineImpl.execute() (VirtualMachineImpl.java:145-230) 的协议写入格式是什么？
      答案方向:
        1. socket() → connect(s, socket_path)
        2. writeString(s, "1") — 协议版本
        3. writeString(s, cmd) — 命令名
        4. for i=0..2: writeString(s, args[i]) — 3 个参数（不足补空字符串）
        5. readInt(sis) — 读取第一行（直到 \n）解析为状态码
        6. 状态码处理:
           0 → 返回 SocketInputStream（命令输出流）
           101 → ATTACH_ERROR_BADVERSION（协议版本不匹配）
           cmd=="load" → 特化抛 AgentLoadException
           其他 → 抛 AttachOperationFailedException
        
      追问: writeString 为什么要 UTF-8 编码？
      → 服务端 read_request 以 \0 字节作为分隔符。UTF-8 编码保证 \0 只出现在
        字符串终止处（UTF-8 不包含嵌入的 null 字节）。如果使用 UTF-16 或其他
        编码 → null 字节可能出现在字符内部 → 服务端提前截断 → 命令解析错误。

  ② Counterfactual: 如果客户端不检查响应状态码——直接读流？
      答案方向: 服务端处理失败时，socket 上可能没有任何数据（或只有错误描述）。
        客户端尝试 readInt() → 阻塞或读取到无效数据 → NumberFormatException
        → 错误消息是 "For input string: ..." 而非 "Agent failed to load"。
        先读状态码再决定如何解释后续数据——这是健壮的协议设计。
```

---

## §五 Article Structure

```
§〇 生产场景 — "Unable to open socket file" 错误诊断
  ★ 真实错误消息: "com.sun.tools.attach.AttachNotSupportedException"
  ★ Root cause: socket 文件不存在 → Attach Listener 未启动
  ★ 三步诊断: jcmd VM.flags → ls /proc/<pid>/root/tmp/ → GDB 断点
  ★ 反事实: 无延迟初始化 → 每个 JVM 进程都创建 socket

§一 ★★★ Attach API 全链路源码走读
  ❓ 这不是 jcmd 使用教程——这是 JVM 如何通过 Unix Domain Socket 接受外部命令
  1.1 VirtualMachineImpl 构造函数 → PID namespace 穿透 → socket 查找 → SIGQUIT 触发
  1.2 VirtualMachineImpl.c:59 socket + :74 connect + :123 kill(SIGQUIT)
  1.3 os.cpp:346 signal_thread_entry → SIGBREAK handler → CAS 状态转换
  1.4 os.cpp:374 is_init_trigger → 检测 .attach_pid 文件 → init()
  1.5 attachListener.cpp:435 init() → JNI 创建 Attach Listener 线程
  1.6 attachListener_linux.cpp:182 LinuxAttachListener::init → socket+bind+listen+chmod+rename
  1.7 attachListener.cpp:348 主循环 → dequeue() → read_request() → funcs[] 分发
  1.8 attachListener_linux.cpp:347 dequeue → accept() + SO_PEERCRED + read_request
  1.9 attachListener_linux.cpp:250 read_request → 解析 "1\0cmd\0arg0\0arg1\0arg2\0"
  1.10 attachListener.cpp:108 load_agent → jvmtiExport.cpp:2636 load_agent_library → dlopen + Agent_OnAttach
  1.11 VirtualMachineImpl.java:145 execute → writeString×5 → readInt → 返回流
  1.12 ★ Mermaid: Attach 全链路时序图 — 5 lanes: Client Tool / libattach / Signal Dispatcher / Attach Listener / JVMTI
       Flow: jcmd <pid> → attach() → createAttachFile → kill(SIGQUIT) → SIGBREAK handler
       → is_init_trigger → init() → socket+bind+listen → rename → accept()
       → read_request → funcs[] dispatch → complete() → close socket
  1.13 ★ 面试 Story Format 答案 — 从 VirtualMachine.attach(pid) 到 Agent_OnAttach 的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 Unix Domain Socket vs TCP
  2.2 SIGQUIT 的双重用途
  2.3 CAS 状态机与并发保护
  2.4 PID Namespace 穿透
  2.5 Attach 协议格式
  2.6 SO_PEERCRED 内核级安全
  2.7 EnableDynamicAgentLoading 安全门控

§三 ★★ Attach 性能剖析
  ❓ 延迟初始化的性能收益
  ❓ 协议处理的开销分解
  3.1 延迟初始化: 0 开销（无 attach 时不创建 socket）
  3.2 Attach 启动延迟: socket+bind+chmod+rename ≈ 2ms + SIGQUIT 传递 ≈ 5ms
  3.3 命令处理延迟: accept ~10µs + 协议解析 ~5µs + 命令执行 ~1-100ms
  3.4 libmanagement_agent.so: 仅 74 行 C（isAccessUserOnly0），管理 agent 入口在 Java 层

§四 ★ GDB 断点验证 — 8 断点完整 Attach trace
  断言 1: VirtualMachineImpl.c:123 kill(pid, SIGQUIT) → verify signal sent
  断言 2: os.cpp:368 transit_state → verify CAS succeeds
  断言 3: os.cpp:374 is_init_trigger → verify .attach_pid exists
  断言 4: attachListener_linux.cpp:182 init → verify socket created
  断言 5: attachListener_linux.cpp:233 chmod 0600 → verify permissions
  断言 6: attachListener_linux.cpp:354 accept → verify blocking on accept
  断言 7: attachListener_linux.cpp:250 read_request → verify protocol parsing
  断言 8: attachListener.cpp:134 load_agent_library → verify Agent_OnAttach called

§五 ★ Cross-Reference
  ❓ 01-Agent-Loading — Agent_OnLoad vs Agent_OnAttach 路径对比
  ❓ 02-ClassFileLoadHook — Agent_OnAttach 后如何注册 CFLH
  ❓ 05-JVMTI-Core — JvmtiExport::load_agent_library 的内部实现
  ❓ 04-Redefine-Classes — load_agent 加载的 agent 如何触发 redefine
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because SIGQUIT in HotSpot has dual purpose (attach trigger + thread dump), the signal_thread_entry uses CAS state transition to determine which path to take..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from attachListener.cpp / attachListener_linux.cpp / os.cpp / VirtualMachineImpl.c, do not describe it.

3. **Mermaid** — Attach 全链路时序图。5 lanes: Client Tool / libattach / Signal Dispatcher / Attach Listener / JVMTI。完整流程: `jcmd <pid> <cmd>` → `VirtualMachine.attach(pid)` → `createAttachFile` → `kill(pid, SIGQUIT)` → `signal_thread_entry` → `CAS transit_state` → `is_init_trigger` → `init()` → `socket+bind+listen+chmod+rename` → `accept()` → `read_request` → `funcs[] dispatch` → `complete()` → `close socket`。Annotate every step with file:line.

4. **GDB session** — 8 breakpoints with exact file:line numbers:
   - `VirtualMachineImpl.c:123` kill(SIGQUIT) — verify signal sent to target PID
   - `os.cpp:368` transit_state — verify CAS from NOT_INITIALIZED to INITIALIZING
   - `os.cpp:374` is_init_trigger — verify .attach_pid file detection
   - `attachListener_linux.cpp:182` init entry — verify socket() call
   - `attachListener_linux.cpp:233` chmod 0600 — verify permissions set
   - `attachListener_linux.cpp:354` accept() — verify blocking on accept
   - `attachListener_linux.cpp:275` read loop — verify protocol bytes received
   - `attachListener.cpp:134` load_agent_library — verify Agent_OnAttach entry
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: Unix Domain Socket vs TCP, SIGQUIT 双重用途, CAS 状态机, PID Namespace 穿透, Attach 协议格式, SO_PEERCRED, EnableDynamicAgentLoading.

6. **Cross-reference at three points**:
   - At `load_agent` → "→ 01-Agent-Loading for Agent_OnLoad vs Agent_OnAttach comparison"
   - At `load_agent_library` → "→ 05-JVMTI-Core for JvmtiExport::load_agent_library internals"
   - At `Agent_OnAttach` → "→ 02-ClassFileLoadHook for how the agent registers CFLH after attach"

7. **Story-format interview answer** — at §一末尾: 从 `jcmd 12345 GC.run` 到 `VM_Operation::execute()` 的叙事。Three parts: "Client trigger (createAttachFile + SIGQUIT)" + "Server-side init (CAS + socket + bind + listen)" + "Command dispatch (accept + read_request + funcs[] + complete)".

8. **"不要写成→应该写成" 对照表** (必须在 §六 中出现):
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "jcmd connects to the JVM via socket" | "VirtualMachineImpl.execute at VirtualMachineImpl.java:145 creates a PF_UNIX socket (:156), connects to /proc/<pid>/root/tmp/.java_pid<ns_pid> (:160), and writes the null-delimited protocol: '1\\0GC.run\\0\\0\\0\\0' (:170-183)" |
   | "SIGQUIT triggers the Attach Listener" | "signal_thread_entry at os.cpp:368 CAS-transitions state from AL_NOT_INITIALIZED to AL_INITIALIZING. If successful, is_init_trigger at attachListener_linux.cpp:531 stat64('.attach_pid<pid>') → init() → pd_init() → LinuxAttachListener::init() at :182 creates the socket" |
   | "The Attach Listener thread accepts connections" | "attach_listener_thread_entry at attachListener.cpp:348 enters infinite loop: dequeue() at :440 → ThreadBlockInVM → LinuxAttachListener::dequeue() at :347 → accept() at :354 blocks → SO_PEERCRED check at :362 → read_request at :372 parses the null-delimited protocol" |
   | "SO_PEERCRED verifies the client" | "getsockopt(s, SOL_SOCKET, SO_PEERCRED, &cred_info) at attachListener_linux.cpp:362 reads kernel-provided uid/gid (man 7 socket). matches_effective_uid_and_gid_or_root at :367 verifies the peer's identity—non-forgeable because the kernel, not the client, populates these fields" |
   | "load_agent loads an agent at runtime" | "load_agent at attachListener.cpp:108 extracts agent name from op->arg(0), loads java.instrument module if needed (:119), then JvmtiExport::load_agent_library at :134 → dlopen(:2636) → dlsym(Agent_OnAttach) → (*Agent_OnAttach)(&main_vm, options, NULL) — the same function signature as Agent_OnLoad but called in JVMTI_PHASE_LIVE" |

---

## §七 Output Format

- Markdown file, named `03-Attach-API.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头:

```
> **阶段**：[18-agent-instrument]
> **前置**：[01-Agent-Loading]（Agent_OnLoad vs Agent_OnAttach 对比）、[02-ClassFileLoadHook]（agent 加载后的 CFLH 注册）、[05-JVMTI-Core]（JvmtiExport::load_agent_library 实现）
> **配套**：[04-Redefine-Classes]（agentmain 触发的 redefine/retransform）、[06-JDWP-Transport]（JDWP 使用相同 Attach 机制）
> **后续依赖本文**：[04-Redefine-Classes]（load_agent 加载的 agent 调用 retransformClasses）、[06-JDWP-Transport]（dt_socket 使用 attach 建立调试连接）
> **阅读收益**：追踪 Attach API 从客户端 jcmd 到服务端命令执行的完整 6 阶段流程——理解 VirtualMachine.attach 的 PID namespace 穿透与延迟初始化机制、SIGQUIT handler 的 CAS 状态机与双重用途设计、LinuxAttachListener 的 Unix Domain Socket 创建（socket+bind+listen+chmod 0600+atomic rename）、SO_PEERCRED 内核级安全验证、null-delimited 协议格式的解析逻辑、funcs[] 函数表的命令分发机制；掌握 "Unable to open socket file" 错误的 5 步诊断路径
```

- 目标行数: 400+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "jcmd connects to JVM via socket" 而不展示 Unix Domain Socket 的创建和协议细节 — 必须从 VirtualMachineImpl.java:54 到 attachListener_linux.cpp:182 完整源码
- ❌ 不解释 SIGQUIT 的双重用途 — 必须展示 signal_thread_entry 中 CAS 状态转换 + is_init_trigger 的完整逻辑
- ❌ 不解释 PID namespace 穿透 — 必须展示 getNamespacePid 读取 /proc/<pid>/status 的 NSpid 字段 + findSocketFile 使用 /proc/<pid>/root
- ❌ 忽略 SO_PEERCRED 安全检查 — 必须展示 getsockopt(SO_PEERCRED) + matches_effective_uid_and_gid_or_root 的完整逻辑
- ❌ 不展示 Attach 协议格式 — 必须展示 "1\0cmd\0arg0\0arg1\0arg2\0" 的 null-delimited 格式 + read_request 的解析代码
- ❌ 忽略 EnableDynamicAgentLoading 安全门控 — 必须展示 attachListener.cpp:390-398 的检查逻辑
- ❌ 不解释 load_agent → Agent_OnAttach 的完整路径 — 必须展示 JvmtiExport::load_agent_library 中的 dlopen + dlsym + Agent_OnAttach 调用
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖客户端 kill → CAS → init → socket → accept → protocol → dispatch
- ❌ 忽略 libmanagement_agent.so — 必须展示 FileSystemImpl.c 的 isAccessUserOnly0 及其与 checkPermissions 的关系
- ❌ 不要写成 jcmd/jstack/jmap 使用教程

---

## §九 Required（≥8）

- ✅ **★ Mermaid 时序图** — 5 lanes: Client Tool / libattach / Signal Dispatcher / Attach Listener / JVMTI — 完整 Attach 流程
- ✅ **★ VirtualMachineImpl 构造函数源码** — VirtualMachineImpl.java:54-123 从 PID 解析到连通性验证
- ✅ **★ signal_thread_entry SIGBREAK handler** — os.cpp:346-409 完整 CAS 状态转换 + is_init_trigger + thread dump
- ✅ **★ LinuxAttachListener::init 源码** — attachListener_linux.cpp:182-242 从 socket() 到 rename()
- ✅ **★ attach_listener_thread_entry 主循环** — attachListener.cpp:348-418 完整 dequeue + funcs[] + complete
- ✅ **★ read_request 协议解析** — attachListener_linux.cpp:250-339 完整 null-delimited 解析
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：客户端触发 → 信号处理 → socket 创建 → 命令分发
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成" 对照表** — §六 中 ≥5 行
- ✅ **★ 交叉引用** — 01-Agent-Loading, 02-ClassFileLoadHook, 05-JVMTI-Core, 04-Redefine-Classes
- ✅ **★ libmanagement_agent.so 附属节** — FileSystemImpl.c isAccessUserOnly0 与客户端 checkPermissions 的关系

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: 客户端 kill(SIGQUIT) (VirtualMachineImpl.c:123)
  (gdb) break Java_sun_tools_attach_VirtualMachineImpl_sendQuitTo
  (gdb) print pid → 期望: 目标 JVM PID
  (gdb) continue → kill(pid, SIGQUIT) 执行
  (gdb) print errno → 期望: 0 (成功)

断言 2: SIGBREAK handler CAS 转换 (os.cpp:368)
  (gdb) break os.cpp:368
  在另一个终端: jcmd <pid> VM.version
  (gdb) print cur_state → 期望: AL_NOT_INITIALIZED (0)
  (gdb) print new_state → 期望: AL_INITIALIZING (1)
  (gdb) continue → CAS 成功

断言 3: is_init_trigger 检测 (os.cpp:374)
  (gdb) break os.cpp:374
  (gdb) continue → 进入 is_init_trigger
  (gdb) print path → 期望: ".attach_pid<ns_pid>" 或 "/tmp/.attach_pid<ns_pid>"
  (gdb) print stat64 result → 期望: 0 (文件存在)

断言 4: LinuxAttachListener::init (attachListener_linux.cpp:182)
  (gdb) break attachListener_linux.cpp:182
  (gdb) continue → 进入 init
  (gdb) break attachListener_linux.cpp:211 (socket 创建后)
  (gdb) print listener → 期望: fd ≥ 0
  (gdb) break attachListener_linux.cpp:233 (chmod 后)
  (gdb) print path → 期望: "/tmp/.java_pid<ns_pid>.tmp"
  (gdb) continue → rename 后 socket 文件出现

断言 5: accept 阻塞 (attachListener_linux.cpp:354)
  (gdb) break attachListener_linux.cpp:354
  (gdb) continue → 应在 accept() 处停止
  (gdb) print _listener → 期望: fd ≥ 0
  (gdb) continue → 客户端 connect → accept 返回
  (gdb) print s → 期望: 新连接 fd ≥ 0

断言 6: SO_PEERCRED 检查 (attachListener_linux.cpp:362)
  (gdb) break attachListener_linux.cpp:362
  (gdb) continue → getsockopt 执行后
  (gdb) print cred_info.uid → 期望: 当前用户 uid
  (gdb) print cred_info.gid → 期望: 当前用户 gid
  (gdb) continue → matches_effective_uid_and_gid_or_root 应返回 true

断言 7: read_request 协议解析 (attachListener_linux.cpp:275)
  (gdb) break attachListener_linux.cpp:275
  (gdb) continue → 读取协议字节
  (gdb) print buf[0..10] → 期望: "1\0load\0inst" (版本+命令+参数开头)
  (gdb) print str_count → 期望: 逐步增加到 5
  (gdb) continue → ArgumentIterator 解析
  (gdb) print op->name() → 期望: "load" 或其他命令名

断言 8: load_agent → Agent_OnAttach (attachListener.cpp:134)
  (gdb) break attachListener.cpp:134
  (gdb) print op->arg(0) → 期望: "instrument" (Java agent) 或 "jdwp" (debug agent)
  (gdb) break jvmtiExport.cpp:2636 (load_agent_library)
  (gdb) continue → dlopen + dlsym 执行
  (gdb) print agent_name → 期望: agent 库名
  (gdb) continue → Agent_OnAttach 被调用
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §一 承接**：本文展开 README 中 "03 — Attach API: Socket → SIGQUIT → loadAgent → Agent_OnAttach → agentmain"——从客户端 jcmd 到服务端命令执行的完整代码级解答。

2. **同组边界**: 本文覆盖 Attach API 的运行时动态连接（延迟初始化 + Unix Domain Socket + 协议解析 + 命令分发）；01 覆盖 Agent 加载的启动路径（Agent_OnLoad）；02 覆盖 agent 加载后的 ClassFileLoadHook 字节码转换；04 覆盖 Redefine/Retransform（Attach 加载的 agent 可通过 agentmain 调用 retransformClasses）。

3. **全部文档共享 §一 开头语**: "Reader completed 01-Agent-Loading (JPLISAgent, Agent_OnLoad, VMInit callback), 02-ClassFileLoadHook (JVMTI event pipeline, JvmtiClassFileLoadHookPoster). This doc: how an external tool (jcmd/jstack/jmap) connects to a running JVM, sends a command over a Unix Domain Socket, and gets the result back."
