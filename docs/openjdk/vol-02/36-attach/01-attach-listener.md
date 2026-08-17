# 01. jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC

> **前置依赖**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):Signal Dispatcher 线程在后台线程族里;[34-nmt/02 — jcmd VM.native_memory summary 怎么生成?— NMT 报告](openjdk/vol-02/34-nmt/02-nmt-report.md):jcmd 命令最终落进 DCmd 框架,这条通道的入口在本篇;[17-threads/01 — JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):Attach Listener 是 JavaThread
> → **后续**:[36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](02-jdk-attach.md)
> 关联域: 35-dcmd(DCmd 框架)、28-jvmti(loadAgent)

## jcmd 的命令是怎么进到 JVM 里的

`jcmd <pid> VM.native_memory summary`(34-nmt 域整条报告链路)的第一步,是把 "VM.native_memory" 这串字符**从本地 jcmd 进程送进目标 JVM**。JDK 的答案是 attach 机制: JVM 侧有一个 **Attach Listener** 线程,通过 Unix domain socket 与本地工具通信——不是 TCP 端口(避免端口冲突与远程攻击),socket 文件带权限保护。但这篇的第一个反直觉事实是:**JVM 启动时通常并不创建 socket**——attach 是"按需"的:工具先用一个文件加一个信号把 listener"叫醒",它才建立 socket。这篇拆四层: 触发握手(文件+信号)、listener 线程与操作循环、socket 与协议、安全与约束。

## 1. 触发: 一个文件 + 一个信号,把 listener 叫醒

JDK9+ 的 attach 是 **attach-on-demand**: `init_at_startup()`(attachListener_linux.cpp:520-526)默认返回 false(唯一例外是 `-XX:+ReduceSignalUsage`,信号功能被精简时只能启动时建好),而 `-XX:+StartAttachListener`(globals.hpp:2467)可强制启动。默认形态下,启动序列(thread.cpp:3936-3943)只做两件事: `AttachListener::vm_start()` **清理残留的 socket 文件**(stat+unlink 掉上次崩溃留下的 `.java_pid<pid>`,attachListener_linux.cpp:460-476)——防止工具误连上一个死进程的 socket;然后**不启动 listener**。

叫醒动作由客户端发起(jdk.attach 的 Linux 实现,`VirtualMachineImpl.java`): ①`findSocketFile` 找不到 socket → ②`createAttachFile` 在**目标进程的 cwd**(`/proc/<pid>/cwd/`)或 `/tmp` 写一个 `.attach_pid<pid>` 空文件(:76,:282-302)→ ③`sendQuitTo(pid)` 发 **SIGQUIT**(:78,:120-126)→ ④轮询等待 socket 文件出现,超时 `attachTimeout`(默认 10000ms,HotSpotVirtualMachine.java:367)→ ⑤删掉 `.attach_pid` 文件。

服务端这边,SIGQUIT 的处理在 **Signal Dispatcher** 线程的 `signal_thread_entry`(os.cpp:341-389)——**同一个信号有两个含义**:

```cpp
// os.cpp:353-389(截取核心,逐字)
        // Check if the signal is a trigger to start the Attach Listener - in that
        // case don't print stack traces.
        if (!DisableAttachMechanism) {
          // Attempt to transit state to AL_INITIALIZING.
          AttachListenerState cur_state = AttachListener::transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED);
          if (cur_state == AL_INITIALIZING) {
            // Attach Listener has been started to initialize. Ignore this signal.
            continue;
          } else if (cur_state == AL_NOT_INITIALIZED) {
            // Start to initialize.
            if (AttachListener::is_init_trigger()) {
              // Attach Listener has been initialized.
              // Accept subsequent request.
              continue;
            } else {
              // Attach Listener could not be started.
              // So we need to transit the state to AL_NOT_INITIALIZED.
              AttachListener::set_state(AL_NOT_INITIALIZED);
            }
          } else if (AttachListener::check_socket_file()) {
            // Attach Listener has been started, but unix domain socket file
            // does not exist. So restart Attach Listener.
            continue;
          }
        }
        // Print stack traces
```

流程: `transit_state` 用 **CAS** 把状态从 AL_NOT_INITIALIZED 转到 AL_INITIALIZING(防两个信号并发初始化),然后 `is_init_trigger()` 去查 `.attach_pid<pid>`——**先查 cwd,再查 `/tmp`**(`os::get_temp_directory()` 在 Linux 上写死 "/tmp",os_linux.cpp:1707),找到且文件属主是 euid 或 root 才 `AttachListener::init()` 启动 listener(attachListener_linux.cpp:528-560,uid 检查防伪造文件);**若没找到文件,信号原样落到下面的线程转储**(`VM_PrintThreads`/`VM_PrintJNI`/`VM_FindDeadlocks`)。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-trigger-demo.txt): 无文件时 `kill -3` 得到 "Full thread dump";`touch /tmp/.attach_pid<pid>` 后再 `kill -3`,得到 `[trace][attach] Attach triggered by .attach_pid...` 且**不打印转储**,随后 `/tmp/.java_pid<pid>` 出现——权限 `srw-------`(0600 + socket 标记)。

*关键设计: 信号是"敲门",文件是"口令"*——只发信号(没写文件)就是普通的线程转储,写了文件再发信号才是 attach 请求。这样**不用信号做状态区分**(信号没有参数),文件系统充当握手信道。启动零开销: 不 attach 就没有 socket、没有监听线程。

## 2. listener 线程: 一个操作队列

`AttachListener::init()`(attachListener.cpp:423-475)创建一个 **JavaThread,名字就叫 "Attach Listener"**(daemon、system thread group、NearMaxPriority)。线程入口 `attach_listener_thread_entry`(:344-406):

```cpp
// attachListener.cpp:351-362(截取核心,逐字)
  if (AttachListener::pd_init() != 0) {
    AttachListener::set_state(AL_NOT_INITIALIZED);
    return;
  }
  AttachListener::set_initialized();

  for (;;) {
    AttachOperation* op = AttachListener::dequeue();
    if (op == NULL) {
      AttachListener::set_state(AL_NOT_INITIALIZED);
      return;   // dequeue failed or shutdown
    }
```

`pd_init()` 建 socket(§3);成功后状态转 AL_INITIALIZED,进入 **dequeue → 分派 → complete 的循环**。分派按操作名查函数表(funcs[],:324-336)——**10 个内置操作**: `agentProperties`/`datadump`/`dumpheap`/`load`/`properties`/`threaddump`/`inspectheap`/`setflag`/`printflag`/`jcmd`;两个特例: `detachall`(类注释 "Performs clean-up tasks on platforms where we can detect that the last client has detached",:477-482;Linux 的 `pd_detachall` 是空实现,:580-582)与 **`load` 受 `EnableDynamicAgentLoading` 门控**(:371-374,JDK11u 默认 true,globals.hpp:2470;后续 JDK 版本该默认值已收紧)。没查到的操作名走平台钩子 `pd_find_operation`(Linux 返回 NULL)或报 "Operation %s not recognized!"。

**与 34-nmt 域接上的关键点**: `jcmd` 操作(attachListener.cpp:200-212)把**所有命令参数当成 arg(0) 一个字符串**,调 `DCmd::parse_and_execute(DCmd_Source_AttachAPI, out, op->arg(0), ' ', THREAD)`——"VM.native_memory summary" 整串由 **DCmd 框架**按空格解析。所以 attach 通道是 DCmd 的入口之一(34-nmt/02 里 NMTDCmd 注册的三源 AttachAPI/MBean/Internal 的 **AttachAPI 就是这条通道**)。操作完成后 `op->complete(res, &st)`(Linux 实现见 §3)把结果码和输出流写回客户端。

**AttachOperation 本身是固定大小的**(attachListener.hpp:136-192): 名字 ≤16 字节、**最多 3 个参数、每个 ≤1024 字节**——协议上限在结构定义处就定死了。

## 3. socket 与协议: .tmp 中转 + NUL 分隔

Linux 的 socket 建立在 `LinuxAttachListener::init`(attachListener_linux.cpp:181-241): `socket(PF_UNIX, SOCK_STREAM, 0)` → **bind 到 `<路径>.tmp`**(:195,:213)——不是直接 bind 正式路径!→ `listen(5)` → `chmod(S_IREAD|S_IWRITE)`(0600,:222)→ `chown(geteuid, getegid)`(:226)→ **`rename` 到 `/tmp/.java_pid<pid>`**(:228)。*关键设计: 先 bind 临时名再改名*——socket 文件以完整可连接状态"原子"出现,半初始化的 `.tmp` 文件不会被人连上;`atexit(listener_cleanup)`(:164-177)在进程正常退出时 shutdown+close+unlink。

dequeue(accept 循环,:346-383)在 accept 之后做**第二道安全校验**: `getsockopt(SO_PEERCRED)` 取客户端 euid/egid,必须匹配本进程的 effective uid/gid(或 root)——与文件权限 0600 构成双保险(即使文件权限被绕过,连接的进程身份也对不上)。然后 `read_request`(:249-338)读请求: **协议版本 1,格式是 NUL 分隔的字符串序列 `<ver>0<cmd>0<arg>0<arg>0<arg>0`**(注释 :253-258);版本不符回写错误码 `101`(ATTACH_ERROR_BADVERSION,:290-298);名字/参数超长直接拒绝。客户端侧(jdk.attach,`VirtualMachineImpl.execute`)按同一格式 `writeString`(UTF-8 字节 + NUL,:145-231/:308-321),读回 `completionStatus`(int)与错误消息;`complete`(attachListener_linux.cpp:408-434)则写 `"<result>\n"` + 结果数据后 shutdown+close。**每个操作独占一次连接**(Linux 上无队列,dequeue 注释 "only a single operation and clients cannot queue commands")。

## 4. 约束与"按需"的边界

几个开关决定整个机制是否可用: **`-XX:-DisableAttachMechanism`**(globals.hpp:2464,默认允许)把 attach 全部关闭(信号处理、启动逻辑、`is_attach_supported` 全部短路);`-XX:+StartAttachListener` 让 listener 启动时就在(thread.cpp:3941);`ReduceSignalUsage` 则同时影响信号与懒启动。`check_socket_file`(:494-516)处理一种异常: **socket 文件被外部删除**(比如工具误删或 /tmp 被清)→ 下次信号来时重启 listener。`abort()` 在 VM 崩溃路径清理 socket。

*关键设计: 整套机制零常驻开销,但依赖 cwd 或 /tmp 可写*——[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-trigger-demo.txt)里有一个环境陷阱: 本容器**常驻 JMC 与 VisualVM**,它们通过 hsperfdata 自动发现新 JVM 并自动 attach(实测新 JVM 启动约 1.6 秒即被触发)——表现为"没发信号 attach 也发生了",也解释了本机 /tmp 堆积的大量 `.java_pid*` 残留。而 34-nmt 会话里 `jcmd` attach 报 "Unable to open socket file /proc/<pid>/root/tmp/.java_pid<pid> ... doesn't respond within 10500ms"(attachTimeout 默认 10000ms + 递增轮询)曾让人误判"容器不支持 attach"——**触发链本身是可用的**(本篇实证),那次失败更可能是目标进程早已退出(NMTDemo 3 秒即结束)或 jcmd 对 /proc/<pid>/root 的路径解析问题。线程转储里可看到成果: `"Attach Listener" #23 daemon prio=9 ... runnable`(阻塞在 accept)与 `"Signal Dispatcher" #4 daemon ... waiting on condition` 并存。

## 核心悬念

服务端拆完: 触发是"`.attach_pid` 文件 + SIGQUIT"双条件(同一信号二义: 无文件=线程转储,有文件=启动 listener),启动零开销按需创建;"Attach Listener" JavaThread 跑 dequeue→分派→complete 循环,10 个内置操作(含把整串命令交给 DCmd 框架的 `jcmd`);Linux socket 用 `.tmp` bind 后 rename 原子出现,0600 权限 + SO_PEERCRED 双保险,NUL 分隔协议、每操作独占连接。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-trigger-demo.txt)里文件+信号触发、转储二义、listener 线程全部对上。但"工具侧"还没讲: `jcmd`/`jconsole` 背后的 **jdk.attach** 模块怎么封装握手、`load` 操作怎么把 JVMTI agent 加载进运行中的 JVM(动态 agent,28-jvmti 域的主角之一)?下一篇: JDK Attach API 与动态 agent。

> → [36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](02-jdk-attach.md)
