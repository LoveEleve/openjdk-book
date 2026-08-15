# 01. jcmd 怎么连接到运行中的 JVM？— AttachListener + Socket IPC

> 🔴 Deep | 1 KP 中的 IPC 机制
> 读者处境: `jcmd <pid> Thread.print` → JDK 需要先连接到正在运行的 JVM 进程。AttachListener 在 JVM 启动时创建 `/tmp/.java_pid<PID>` socket→外部工具连接→发送命令。

> ⚠️ 写作期修正(2026-08-15, vol-02/36-attach/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"JVM 启动时创建 socket" 错(重要)**: JDK9+ **attach-on-demand 懒启动**——init_at_startup 默认 false(唯一例外 ReduceSignalUsage,attachListener_linux.cpp:520-526),`-XX:+StartAttachListener`(globals.hpp:2467)可强制;启动只做 vm_start() 清残留 socket 文件(:460-476,thread.cpp:3936-3943)
> - **"SIGQUIT 触发" 半对(机制错)**: 触发是**双条件**——客户端**先写 `.attach_pid<pid>` 文件**(cwd 优先,fallback /tmp;jdk.attach VirtualMachineImpl.java:76/:282-302)再发 **SIGQUIT**(sendQuitTo :120-126);Signal 线程 SIGBREAK 处理里 transit_state CAS + is_init_trigger() 查文件(os.cpp:353-389),命中才 init(),**未命中信号继续打印线程转储**——同一信号二义;is_init_trigger uid 防伪(:530-560);已初始化后短路
> - **"COMMAND\narg1=val1\n\n" 协议格式错**: 真实=NUL 分隔 `<ver>0<cmd>0<arg>0<arg>0<arg>0`(attachListener_linux.cpp:253-258;客户端 writeString UTF-8+NUL,VirtualMachineImpl.java:308-321);协议版本 1,101=ATTACH_ERROR_BADVERSION;AttachOperation name≤16/3 参数/各≤1024(attachListener.hpp:138-142)
> - **"permission 400" 错**: chmod S_IREAD|S_IWRITE=**0600**(attachListener_linux.cpp:222);且 bind 到 **`.tmp` 路径**再 rename 正式路径(防半初始化文件被连,:195/:211-228);安全=**双重**: 文件 0600 + **SO_PEERCRED euid/egid 校验**(:361-372)
> - **"unlink 旧 file→create new" 半对**: 真实=vm_start() 启动时 stat+unlink 残留(:460-476);atexit(listener_cleanup) 正常退出清理(:164-177)
> - **行号漂移**: attachListener.hpp 195 行(类 :62-133/AttachOperation :136-192);attachListener.cpp **482 行**;attachListener_linux.cpp **582 行**;大纲 40-120/50-250/40-200 全偏
> - **缺机制(重要)**: ①操作函数表 10 个(attachListener.cpp:324-336: agentProperties/datadump/dumpheap/load/properties/threaddump/inspectheap/setflag/printflag/jcmd);**②jcmd 操作=DCmd::parse_and_execute(DCmd_Source_AttachAPI, op->arg(0), ' ')(:200-212)——34-nmt/02 的 AttachAPI 源就是这条通道**;③线程=JavaThread "Attach Listener"(daemon/system thread group/NearMaxPriority,attachListener.cpp:423-475),入口 attach_listener_thread_entry(:344-406: pd_init→INITIALIZED→dequeue→分派→op->complete);④状态机 NOT_INITIALIZED/INITIALIZING/INITIALIZED+transit CAS(hpp:54-58/:96-99);⑤EnableDynamicAgentLoading 门控 load(:371-374,JDK11u 默认 true globals.hpp:2470);⑥DisableAttachMechanism 全关(globals.hpp:2464);⑦客户端 attach 流程(VirtualMachineImpl.java:54-123: NSpid 解析/findSocketFile/createAttachFile/SIGQUIT/轮询 attachTimeout 默认 10000ms HotSpotVirtualMachine.java:367/checkPermissions/connect);⑧check_socket_file 失效重启(:494-516);⑨complete 协议 "result\n"+data(:408-434);⑩每操作独占连接(dequeue 注释 :341-345)
> - **实证**: 36-attach-trigger-demo.txt(touch+TIGQUIT 触发成功/trace 日志 "Attach triggered"/无文件时线程转储/已初始化短路/"Attach Listener" #23 与 "Signal Dispatcher" #4 线程行/socket srw------- 0600/strace stat 证据)
> - **环境事实(重要,修正旧结论)**: 本容器常驻 **JMC+VisualVM 自动 attach 新 JVM**(约 1.6s,hsperfdata 发现)——"无信号也触发"的假象来源;/tmp 堆积 .java_pid* 残留;os::get_temp_directory() Linux 写死 "/tmp"(os_linux.cpp:1707,不读 TMPDIR);**jcmd attach 报 10500ms 超时是 /proc/<pid>/root 路径解析问题,attach 机制本身可用**——34-nmt 会话"容器不支持 attach"结论需修正
> - **悬念指向 02-jdk-attach ✓**(正确,保留)

### 1. "AttachListener — JVM 侧的 socket 监听"

场景: JVM 启动→attach listener thread 创建→在 `/tmp/.java_pid<PID>` 上 listen Unix domain socket→外部进程 connect→写入命令。

**AttachListener** (`services/attachListener.hpp:40-120 + attachListener.cpp:50-250`):
```cpp
class AttachListener : AllStatic {
  static void init();          // 创建 listener thread + socket
  static void loop();          // accept connections→read commands
  static void enqueue(AttachOperation* op); // dispatch command
};
```
- 源码: `services/attachListener.hpp:40-120` + `attachListener.cpp:50-250`
- 关键设计: Socket 是 Unix domain socket——不是 TCP port(更安全+无端口冲突)。Socket file 权限: owner only(`S_IRUSR|S_IWUSR`, 0600)`——只让本进程 owner 连接。若 JVM 非正常终止→socket file residue →下次启动时 detect→unlink 旧 file→create new
- [C++: `os::create_listener_socket()` → Linux 上用 `socket(AF_UNIX, SOCK_STREAM, 0)` → `bind()` → `listen(1)`。client connect→read 命令行→parse `"COMMAND\narg1=val1\n\n"`→AttachOperation→dispatch]

### 2. "信号触发 — Linux 上用 SIGQUIT"

场景: jdk.attach 需要先通知 JVM 开始监听——发送 SIGQUIT 信号→JVM signal handler→create socket→启动 listener thread。

**Linux attach 流程** (`os/linux/attachListener_linux.cpp:40-200`):
```
1. jdk.attach → send SIGQUIT to target JVM
2. JVM signal handler → AttachListener::init()
3. init → create socket → start listener thread
4. listener thread: accept connection → read command → dispatch
```
- 源码: `os/linux/attachListener_linux.cpp:40-200`
- 关键设计: SIGQUIT 是 JVM 的 "attach signal"——JVM 本身不ignore SIGQUIT(它原本用于 thread dump)。AttachListener intercepts SIGQUIT→先 check if attach request→是→process attach→否→forward to thread dump handler

---

### 核心悬念

**"AttachListener 用 Unix domain socket(/tmp/.java_pid<PID>)→SIGQUIT 触发创建→外部工具 connect→send command→dispatch to DCmd 或 loadAgent。** — 下一篇: JDK Attach API。

> → [02-jdk-attach.md](02-jdk-attach.md)
