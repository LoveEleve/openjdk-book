# PROMPT: 请撰写 06-JDWP-Transport-Init.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：使用 `-agentlib:jdwp=transport=dt_socket,address=8000,server=y,suspend=y` 启动 Java 应用后，调试器无法连接，应用一直挂起在 `Listening for transport dt_socket at address: 8000`。

```
$ java -agentlib:jdwp=transport=dt_socket,address=8000,server=y,suspend=y -jar app.jar
Listening for transport dt_socket at address: 8000
# 应用挂起，等待调试器连接...
```

或者在 client 模式下连接失败：

```
$ java -agentlib:jdwp=transport=dt_socket,address=localhost:8000,server=n -jar app.jar
ERROR: transport error 202: connect failed: Connection refused
ERROR: JDWP Transport dt_socket failed to initialize, TRANSPORT_INIT(510)
JDWP exit error AGENT_ERROR_TRANSPORT_INIT(197): No transports initialized [debugInit.c:1203]
```

**根因分析**：JDWP 启动经过 3 个阶段：

1. **参数解析** (`debugInit.c:869-891`): 解析 `transport=dt_socket,address=8000,server=y,suspend=y` → 提取 key=value 对
2. **Transport 初始化** (`transport.c:382`): `transport_initialize` 加载 transport 库（`dlopen("libdt_socket.so")`）→ 调用 `jdwpTransport_OnLoad` → transport 回调注册
3. **连接建立** (`debugInit.c:200-1300`): server 模式 `socketTransport_startListening` → `bind` + `listen`；client 模式 `socketTransport_attach` → `connect` + JDWP-Handshake

崩溃最常见于第 2/3 步——transport 库找不到或端口被占用。

**三步诊断**：

```bash
# 1. 确认 JDWP agent 是否加载
java -Xlog:jdwp=info -agentlib:jdwp=transport=dt_socket,address=8000,server=y -version 2>&1 | grep -E "jdwp|transport"

# 2. 检查端口是否被占用
ss -tlnp | grep 8000

# 3. GDB 断点验证 JDWP 启动
gdb -ex "break debugInit.c:200" \
    -ex "break transport.c:382" \
    -ex "break socketTransport.c:495" \
    -ex "run" \
    -ex "print options" \
    --args java -agentlib:jdwp=transport=dt_socket,address=8000,server=y app.jar
```

**反事实**：如果 JDWP 没有 suspend=y 选项 → 调试器无法在应用启动前设置断点 → 启动阶段的代码无法调试 → 需要 "启动后暂停等待调试器" 的机制。suspend=y 利用了 JVMTI VMStart 事件——在 VMStart 回调中调用 `debugInit_waitInitComplete`，循环等待直到调试器连接并发送 VM.resume 命令。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the JDWP agent initialization—from `-agentlib:jdwp` parameter parsing through transport library loading and socket creation to the JDWP handshake and main loop entry. This is NOT a tutorial on "how to debug Java" — it's ENGINEERING documentation on HOW the JDWP agent bootstraps itself.

Reader completed **01-Agent-Loading**（Agent_OnLoad 入口），**03-Attach-API**（Unix Domain Socket 通信）。This doc: **how JDWP goes from a JVMTI agent to a listening debug server** — from `DEF_Agent_OnLoad` at debugInit.c:200 to `debugLoop_run` at debugLoop.c:80.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When you pass `-agentlib:jdwp=transport=dt_socket,address=8000,server=y,suspend=y`, the JVMTI framework loads `libjdwp.so` and calls `Agent_OnLoad`. Inside `DEF_Agent_OnLoad` at debugInit.c:200, the options string `"transport=dt_socket,address=8000,server=y,suspend=y"` is parsed by `parseOptions` at :1008 into a linked list of key-value pairs. Then `transport_initialize` at transport.c:382 loads the transport library—`os::dll_load("libdt_socket.so")`—and calls `jdwpTransport_OnLoad` at socketTransport.c:1022, which fills in the transport function table (`GetCapabilities`, `StartListening`, `Accept`, `Attach`, `ReadPacket`, `WritePacket`). In server mode, `socketTransport_startListening` at socketTransport.c:495 creates a TCP socket via `socket(AF_INET, SOCK_STREAM, 0)`, `bind()` to port 8000, and `listen()` with backlog=1. In client mode, `socketTransport_attach` at :690 calls `connect()` to the debugger and then both sides exchange the 14-byte ASCII string `\"JDWP-Handshake\"`—a protocol handshake that validates both sides speak JDWP. After the transport is ready, `debugInit_waitInitComplete` at :614 loops until the debugger connects and sends VM.resume, then `debugLoop_run` at debugLoop.c:80 enters the main event loop: `transport_receivePacket()` reads the 11-byte JDWP packet header, `debugDispatch_getHandler()` looks up the command handler via a two-level array (CommandSet → Command → Handler), the handler executes, and `transport_sendPacket()` sends the reply."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **JDWP 包格式**: JDWP 包分为命令包和回复包。包头 11 字节：`length(4) + id(4) + flags(1) + cmdSet(1) + cmd(1)`。回复包在 cmd 位置是 `errorCode(2)`。`flags & 0x80 == 0` 是命令包，`!= 0` 是回复包。`jdwpPacket` union 统一处理两种包。Source: `jdwpTransport.h:99-130`.

2. **JDWP-Handshake 协议**: Transport 层在连接建立后执行 14 字节的 ASCII 字符串握手——双方各发送 `"JDWP-Handshake"` 并验证对方发送相同内容。如果握手失败 → transport 返回错误 → JDWP agent 退出。Source: `socketTransport.c:174, 634, 758`.

3. **Transport 虚函数表**: `jdwpTransportNativeInterface_` (jdwpTransport.h:164) 定义了 transport 的虚函数表——`GetCapabilities`, `Attach`, `StartListening`, `Accept`, `StopListening`, `ReadPacket`, `WritePacket`, `GetLastError`, `SetTransportConfiguration`。每个 transport 实现（dt_socket, dt_shmem）填充此表。Source: `jdwpTransport.h:164-276`.

4. **debugDispatch 两级分发表**: `debugDispatch_initialize` (debugDispatch.c:49) 构建两级查找数组：`l1Array[CommandSet]` → `l2Array[Command]` → Handler 函数指针。17 个 CommandSet 在 `debugDispatch.c:69-86` 注册。查找时 O(1) 索引访问——CommandSet 和 Command 都是小整数。Source: `debugDispatch.c:49-116`.

5. **suspend=y 的实现**: `debugInit_suspendOnInit` (debugInit.c:826) 在 VMStart 事件回调中设置 `debugInit_isInitComplete = JNI_FALSE`，然后 `debugInit_waitInitComplete` (:614) 进入等待循环——每 100ms 检查一次标志。调试器连接后发送 VM.resume 命令 → `VirtualMachineImpl.c` 中的处理函数设置 `debugInit_isInitComplete = JNI_TRUE` → 循环退出 → 应用继续执行。Source: `debugInit.c:604-650`.

6. **transport_initialize 的 dlopen 链**: `transport_initialize` (transport.c:382) 从 options 中提取 `transport=dt_socket` → 拼接 `libdt_socket.so` → `os::dll_load` (dlopen) → `os::dll_lookup` (dlsym) 查找 `jdwpTransport_OnLoad` → 调用 OnLoad 注册回调 → 存储 `jdwpTransportNativeInterface_` 指针。Source: `transport.c:382-500`.

7. **inStream/outStream 序列化**: `inStream` (inStream.c) 从 `jdwpPacket` 的 data 字段读取序列化的命令参数——`inStream_readInt/readLong/readObjectID` 等。`outStream` (outStream.c) 将回复数据序列化到 `jdwpPacket` 的 data 字段——`outStream_writeInt/writeLong/writeObjectID` 等。`outStream_sendReply` (:460) 设置 flags 为 REPLY(0x80) 并调用 `transport_sendPacket`。Source: `inStream.c, outStream.c`.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/jdk.jdwp.agent/share/native/libjdwp/debugInit.c` — DEF_Agent_OnLoad (:200), parseOptions (:1008), debugInit_waitInitComplete (:614)
- `src/jdk.jdwp.agent/share/native/libjdwp/debugLoop.c` — debugLoop_run (:80)
- `src/jdk.jdwp.agent/share/native/libjdwp/debugDispatch.c` — debugDispatch_initialize (:49), debugDispatch_getHandler (:94)
- `src/jdk.jdwp.agent/share/native/libjdwp/transport.c` — transport_initialize (:382), transport_sendPacket (:654), transport_receivePacket (:683)
- `src/jdk.jdwp.agent/share/native/libdt_socket/socketTransport.c` — jdwpTransport_OnLoad (:1022), startListening (:495), attach (:690)
- `src/jdk.jdwp.agent/share/native/include/jdwpTransport.h` — jdwpPacket (:111-130), jdwpTransportNativeInterface_ (:164)
- `src/jdk.jdwp.agent/share/native/libjdwp/inStream.c` / `outStream.c` — 包序列化
- `build/.../support/headers/jdk.jdwp.agent/JDWPCommands.h` — CommandSet 宏 (构建产物)

Build: `make jdk`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjdwp.so`
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libdt_socket.so`

System calls: `socket` (`man 2 socket`), `bind` (`man 2 bind`), `listen` (`man 2 listen`), `accept` (`man 2 accept`), `connect` (`man 2 connect`), `setsockopt` (`man 2 setsockopt`), `send`/`recv` (`man 2 send`), `dlopen` (`man 3 dlopen`), `dlsym` (`man 3 dlsym`)

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **debugInit.c** | `src/jdk.jdwp.agent/share/native/libjdwp/debugInit.c` | 1413 | DEF_Agent_OnLoad(:200), parseOptions(:1008), debugInit_waitInitComplete(:614) | 🔥 JDWP 初始化入口 |
| 2 | **debugLoop.c** | `src/jdk.jdwp.agent/share/native/libjdwp/debugLoop.c` | 313 | debugLoop_run(:80) | JDWP 主循环 |
| 3 | **debugDispatch.c** | `src/jdk.jdwp.agent/share/native/libjdwp/debugDispatch.c` | 116 | initialize(:49), getHandler(:94) | 命令分发 |
| 4 | **transport.c** | `src/jdk.jdwp.agent/share/native/libjdwp/transport.c` | 706 | initialize(:382), sendPacket(:654), receivePacket(:683) | Transport 封装 |
| 5 | **socketTransport.c** | `src/jdk.jdwp.agent/share/native/libdt_socket/socketTransport.c` | 1059 | OnLoad(:1022), startListening(:495), attach(:690) | 🔥 dt_socket 实现 |
| 6 | **jdwpTransport.h** | `src/jdk.jdwp.agent/share/native/include/jdwpTransport.h` | 276 | jdwpPacket(:111-130), jdwpTransportNativeInterface_(:164) | Transport 接口 |
| 7 | **inStream.c** | `src/jdk.jdwp.agent/share/native/libjdwp/inStream.c` | 500 | init(:42), readInt(:136), readObjectID(:227) | 包反序列化 |
| 8 | **outStream.c** | `src/jdk.jdwp.agent/share/native/libjdwp/outStream.c` | 514 | initCommand(:57), initReply(:73), sendReply(:460) | 包序列化 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ DEF_Agent_OnLoad — JDWP 初始化入口

```
问题：
  ① DEF_Agent_OnLoad (debugInit.c:200) 的完整初始化序列是什么？
      答案方向: 序列如下：
        1. parseOptions(options) (:869-891) — 解析 transport=,address=,server=,suspend=,launch=,onthrow=,onuncaught=
        2. transport_initialize() — dlopen + OnLoad + 存储虚函数表
        3. eventHandler_initialize() — 注册 JVMTI 事件回调
        4. threadControl_initialize() — 初始化线程控制
        5. 如果是 server 模式 → startListening + Accept（阻塞等待调试器连接）
        6. 如果是 client 模式 → attach（connect + handshake）
        7. 如果是 suspend=y → debugInit_waitInitComplete（等待 VM.resume）
      
      追问: 为什么 transport_initialize 必须在 eventHandler_initialize 之前？
      → eventHandler_initialize 注册的 JVMTI 事件回调（如 VMStart）会立即触发
        （VMStart 在 JVMTI 启动后很快发生）。如果 transport 尚未初始化 →
        事件回调无法通过 transport 发送事件包 → 调试器收不到事件通知。

  ② Counterfactual: 如果 JDWP 使用与 Attach API 相同的 Unix Domain Socket？
      答案方向: JDWP 需要跨机器调试 → 必须 TCP/IP。Attach API 只需要本地通信
        → Unix Domain Socket 更快且内核级 SO_PEERCRED 安全验证。两者选择不同
        transport 是因为使用场景不同：JDWP 是远程调试协议，Attach 是本地管理。
```

### 4.2 ★★★ socketTransport — dt_socket 实现

```
问题：
  ① socketTransport_startListening (socketTransport.c:495) 的 server 模式逻辑是什么？
      答案方向:
        1. 解析 address（如 "8000" 或 "localhost:8000"）
        2. getaddrinfo → 解析地址
        3. socket(AF_INET, SOCK_STREAM, 0) → 创建 TCP socket
        4. setsockopt(SO_REUSEADDR) → 允许端口重用
        5. bind(fd, &addr) → 绑定端口
        6. listen(fd, 1) → backlog=1（一次只接受一个调试器连接）
        7. 打印 "Listening for transport dt_socket at address: 8000"
        8. socketTransport_accept → accept() → 接收连接
        9. JDWP-Handshake → 发送+验证 14 字节握手字符串
        
      追问: 为什么 backlog=1？
      → JDWP 设计为单调试器连接——不接受多个调试器同时调试同一进程。
        backlog=1 拒绝了多余连接，简化了并发模型。

  ② Counterfactual: 如果没有 JDWP-Handshake？
      答案方向: 任意 TCP 连接可以发送数据到 JDWP agent → agent 将任意数据
        当作 JDWP 命令包解析 → 解析失败 → 但已经消耗了 agent 的 accept 槽位
        → 真正的调试器无法连接。Handshake 验证了对端确实实现了 JDWP 协议。
```

### 4.3 ★★★ debugLoop — 主事件循环

```
问题：
  ① debugLoop_run (debugLoop.c:80) 的主循环逻辑是什么？
      答案方向:
        for(;;):
          1. transport_receivePacket(&packet) — 阻塞读取 11 字节包头 + data
          2. 检查 isSessionAlive() — VM 是否已死亡
          3. 如果是命令包（flags & REPLY == 0）:
             a. debugDispatch_getHandler(cmdSet, cmd) → handler 函数
             b. handler(jni, &packet) → 执行命令
             c. outStream_sendReply → 发送回复包
          4. 如果是回复包 → 由等待的调用者处理（异步回复）
          5. 如果是错误 → 返回错误包
      
      追问: 主循环在哪个线程运行？
      → debugLoop_run 在 Agent_OnLoad 调用线程中运行（通常是 JVM 的
        main 线程或 Attach Listener 线程）。在 server+suspend=y 模式下，
        主循环阻塞在第一个 transport_receivePacket 上，直到调试器发送命令。

  ② Counterfactual: 如果主循环使用独立线程？
      答案方向: Agent_OnLoad 需要在线程中返回——如果主循环阻塞在 Agent_OnLoad
        线程 → Agent_OnLoad 永不返回 → JVM 认为 agent 加载失败。
        suspend=y 模式利用了 JVMTI VMStart 事件——Agent_OnLoad 返回后，
        VMStart 回调中进入等待循环，不会阻塞 Agent_OnLoad 返回。
```

### 4.4 ★★★ transport 封装层

```
问题：
  ① transport_initialize (transport.c:382) 如何加载 transport 库？
      答案方向:
        1. 从 options 提取 transport=dt_socket → name="dt_socket"
        2. 拼接 "libdt_socket.so" → os::dll_load(path) → dlopen
        3. os::dll_lookup(lib, "jdwpTransport_OnLoad") → dlsym
        4. 调用 jdwpTransport_OnLoad(&callback) → transport 填充虚函数表
        5. 验证虚函数表中所有必须的函数指针非 NULL
        6. 保存 jdwpTransportNativeInterface_ 指针
      
      追问: 为什么 transport 是可插拔的（dlopen 而非静态链接）？
      → JDWP 规范定义 transport 为可替换组件——支持 dt_socket (TCP)、
        dt_shmem (Windows 共享内存)、以及自定义 transport（如 SSL）。
        dlopen 机制允许在不重新编译 JDWP agent 的情况下替换 transport。

  ② Counterfactual: 如果 transport 静态链接——不支持自定义 transport？
      答案方向: 每个自定义 transport 需要重新编译 libjdwp.so → 无法使用
        标准 JDK 发行版中的 libjdwp.so → 需要维护自定义 JDK 构建。
        dlopen 的可插拔设计让第三方可以独立开发和分发 transport 库。
```

### 4.5 ★★★ inStream/outStream — 包序列化

```
问题：
  ① inStream (inStream.c) 如何从 jdwpPacket 读取命令参数？
      答案方向:
        1. inStream_init(packet, stream) — 设置 data 指针 + 长度
        2. inStream_readInt(stream) — 大端序读取 4 字节 → int
        3. inStream_readLong(stream) — 大端序读取 8 字节 → jlong
        4. inStream_readObjectID(stream) — 根据 sizeof(jobject) 读取
        5. inStream_readString(stream) — 先读 length(4字节) → 再读 UTF-8 字符
        6. 每个 read 函数检查边界（不超过 data 长度）— 防止越界读取
        
      追问: 为什么是大端序（network byte order）？
      → JDWP 是网络协议——网络字节序统一为大端序（RFC 1700）。
        这保证了 x86（小端序）和 SPARC（大端序）之间的互操作性。

  ② Counterfactual: 如果使用小端序（host byte order）？
      答案方向: x86 调试器连接 SPARC JVM → 所有 int/long 字段解析错误
        → 命令参数错位 → 命令失败或未定义行为。
        大端序作为网络协议标准消除了字节序问题。
```

### 4.6 ★★★ suspend=y 的实现机制

```
问题：
  ① debugInit_waitInitComplete (debugInit.c:614) 如何实现应用挂起？
      答案方向:
        1. debugInit_isInitComplete = JNI_FALSE
        2. while (!debugInit_isInitComplete):
             a. sleep(100ms)
             b. 检查 debugInit_isInitComplete 标志
        3. 调试器连接后发送 VM.resume 命令
        4. VirtualMachineImpl.c 的 handler 设置 debugInit_isInitComplete = JNI_TRUE
        5. 循环退出 → 应用继续
        
      追问: 为什么用 polling 而非 condition variable？
      → JVMTI 回调在 JVM 线程中执行——不能使用 pthread_cond_wait（可能阻塞
        JVM 线程 → 死锁）。Polling 虽然浪费 CPU（100ms 间隔），但不会阻塞
        JVM 线程，且 100ms 延迟对调试场景可接受。

  ② Counterfactual: 如果使用 JVMTI 事件通知替代 polling？
      答案方向: 调试器连接后 → JVMTI 没有 "debugger connected" 事件。
        JVMTI 是通用工具接口——不知道 JDWP 的存在。JDWP agent 必须在
        JVMTI 之上实现自己的同步机制。Polling 是最简单的实现——正确且足够。
```

---

## §五 Article Structure

```
§〇 生产场景 — "JDWP Transport dt_socket failed to initialize" 错误诊断
  ★ 真实错误消息 + 三步诊断
  ★ 反事实: 无 suspend=y → 启动阶段无法调试

§一 ★★★ JDWP 初始化全链路源码走读
  1.1 debugInit.c:200 DEF_Agent_OnLoad → parseOptions
  1.2 transport.c:382 transport_initialize → dlopen + OnLoad
  1.3 socketTransport.c:1022 jdwpTransport_OnLoad → 注册虚函数表
  1.4 socketTransport.c:495 startListening → socket+bind+listen
  1.5 socketTransport.c:690 attach → connect+handshake
  1.6 debugInit.c:614 waitInitComplete → suspend=y 实现
  1.7 debugLoop.c:80 debugLoop_run → 主循环
  1.8 debugDispatch.c:49 initialize → 两级分发表
  1.9 inStream.c / outStream.c → 包序列化/反序列化
  1.10 ★ Mermaid: JDWP 启动时序图 — 5 lanes: JVM / libjdwp / libdt_socket / Transport / Debugger
  1.11 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框
  2.1 JDWP 包格式
  2.2 JDWP-Handshake
  2.3 Transport 虚函数表
  2.4 debugDispatch 两级分发表
  2.5 suspend=y 实现
  2.6 transport_initialize dlopen 链
  2.7 inStream/outStream 序列化

§三 ★★ 性能剖析
  3.1 Handshake: 14 字节 + round-trip ~100µs
  3.2 包解析: 11 字节包头 + inStream ~5µs
  3.3 命令分发: 两级数组 O(1) ~50ns
  3.4 suspend=y: 100ms polling 间隔

§四 ★ GDB 断点验证 — 7 断点
  断言 1: debugInit.c:200 DEF_Agent_OnLoad → verify options
  断言 2: transport.c:382 transport_initialize → verify dlopen
  断言 3: socketTransport.c:1022 OnLoad → verify callbacks
  断言 4: socketTransport.c:495 startListening → verify socket
  断言 5: socketTransport.c:174 handshake → verify "JDWP-Handshake"
  断言 6: debugInit.c:614 waitInitComplete → verify polling
  断言 7: debugLoop.c:80 debugLoop_run → verify main loop

§五 ★ Cross-Reference
  ❓ 01-Agent-Loading — Agent_OnLoad 机制
  ❓ 03-Attach-API — Socket 通信机制对比
  ❓ 07-JDWP-Commands — 命令处理
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY**.

2. **3-5 lines source code per claim**.

3. **Mermaid** — JDWP 启动时序图。5 lanes: JVM / libjdwp / libdt_socket / Transport / Debugger。

4. **GDB session** — 7 breakpoints.

5. **7 Beginner callout boxes**.

6. **Cross-reference at three points**.

7. **Story-format interview answer**.

8. **"不要写成→应该写成" 对照表**:
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "JDWP loads transport library" | "transport_initialize at transport.c:382 calls os::dll_load('libdt_socket.so') → dlsym('jdwpTransport_OnLoad') → calls OnLoad which fills the jdwpTransportNativeInterface_ function table with GetCapabilities/StartListening/Accept/Attach/ReadPacket/WritePacket" |
   | "JDWP handshake validates the connection" | "socketTransport_startListening at socketTransport.c:495 creates TCP socket → accept() → then both sides send and verify the 14-byte ASCII string 'JDWP-Handshake' at :634/:758 — protocol version validation before any JDWP commands" |
   | "suspend=y pauses the application" | "debugInit_suspendOnInit at debugInit.c:826 sets debugInit_isInitComplete=JNI_FALSE, then debugInit_waitInitComplete at :614 loops every 100ms until the debugger sends VM.resume and the handler sets the flag to JNI_TRUE" |
   | "debugLoop reads and dispatches commands" | "debugLoop_run at debugLoop.c:80 calls transport_receivePacket → debugDispatch_getHandler(cmdSet, cmd) at debugDispatch.c:94 performs O(1) two-level array lookup → handler executes → outStream_sendReply at outStream.c:460" |
   | "inStream reads command parameters" | "inStream_init at inStream.c:42 sets data pointer from jdwpPacket, then inStream_readInt at :136 reads 4 bytes big-endian, inStream_readObjectID at :227 reads sizeof(jobject) bytes, and inStream_readString reads length prefix + UTF-8 data" |

---

## §七 Output Format

- Markdown file, named `06-JDWP-Transport-Init.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头: 包含阶段、前置、配套、后续依赖、阅读收益
- 目标行数: 400+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "JDWP starts a debug server" 而不展示 socket 创建和 handshake
- ❌ 不解释 transport 可插拔设计 — 必须展示 dlopen + 虚函数表
- ❌ 忽略 JDWP 包格式 — 必须展示 11 字节包头 + command/reply 区分
- ❌ 不解释 suspend=y 的实现 — 必须展示 polling 循环
- ❌ 不展示 debugDispatch 两级分发表
- ❌ 忽略 JDWP-Handshake — 必须展示 14 字节握手
- ❌ 不做 GDB 断点 trace — 至少 7 个断点
- ❌ 不要写成 IDE 调试配置教程

---

## §九 Required（≥8）

- ✅ **★ Mermaid 启动时序图** — 5 lanes
- ✅ **★ DEF_Agent_OnLoad 完整初始化序列**
- ✅ **★ socketTransport startListening + attach 源码**
- ✅ **★ debugLoop_run 主循环源码**
- ✅ **★ transport_initialize dlopen 链**
- ✅ **★ debugDispatch 两级分发表**
- ✅ **★ 7 Beginner Callout 框**
- ✅ **★ 面试 Story Format 答案**
- ✅ **★ GDB 断点 ≥7 条**
- ✅ **★ "不要写成→应该写成" 对照表** — ≥5 行
- ✅ **★ 交叉引用** — 01, 03, 07

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: DEF_Agent_OnLoad (debugInit.c:200)
  (gdb) break debugInit.c:200
  (gdb) print options → 期望: "transport=dt_socket,address=8000,server=y"

断言 2: transport_initialize (transport.c:382)
  (gdb) break transport.c:382
  (gdb) print transportName → 期望: "dt_socket"
  (gdb) continue → dlopen + dlsym 执行

断言 3: startListening (socketTransport.c:495)
  (gdb) break socketTransport.c:495
  (gdb) print address → 期望: "8000"
  (gdb) continue → socket+bind+listen 完成
  (gdb) print fd → 期望: ≥ 0

断言 4: JDWP-Handshake (socketTransport.c:634/758)
  (gdb) break socketTransport.c:634
  (gdb) print handshakeBytes → 期望: "JDWP-Handshake"

断言 5: waitInitComplete (debugInit.c:614)
  (gdb) break debugInit.c:614
  (gdb) print debugInit_isInitComplete → 期望: JNI_FALSE (suspend=y)

断言 6: debugLoop_run (debugLoop.c:80)
  (gdb) break debugLoop.c:80
  (gdb) continue → 进入主循环
  (gdb) print packet.type.cmd.cmdSet → 期望: 命令包 cmdSet

断言 7: debugDispatch_getHandler (debugDispatch.c:94)
  (gdb) break debugDispatch.c:94
  (gdb) print cmdSet → 期望: 1 (VirtualMachine)
  (gdb) print cmd → 期望: 具体命令编号
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §一 承接**：本文展开 "06 — JDWP Transport+Init: dt_socket → debugInit → debugLoop 主循环 → 命令分发"——JDWP 启动和 transport 层的完整代码级解答。

2. **同组边界**: 06 覆盖 JDWP 启动和 transport；07 覆盖 JDWP 命令处理（17 CommandSet + 事件系统）。
