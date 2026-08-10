# 01. jcmd 怎么连接到运行中的 JVM？— AttachListener + Socket IPC

> 🔴 Deep | 1 KP 中的 IPC 机制
> 读者处境: `jcmd <pid> Thread.print` → JDK 需要先连接到正在运行的 JVM 进程。AttachListener 在 JVM 启动时创建 `/tmp/.java_pid<PID>` socket→外部工具连接→发送命令。

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
