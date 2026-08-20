# 03. 进程与本地交互 — ProcessBuilder 启动流程、fork+exec、VM 初始化

> 🟡 Working | 域 03 对象与系统第 3 篇 | Layer 1
> 读者处境: 生产脚本调用外部命令(java -jar、ffmpeg、curl)时卡死/资源泄漏——Process 的输入输出管道是谁在管?

### 1. "ProcessBuilder.start 发生了什么？" — 启动流水线

场景: `Process p = new ProcessBuilder("curl", url).start()` — 这一行背后几步?

- `ProcessBuilder.java:1070` `public Process start()` — 校验/重定向配置 → 调用 `ProcessImpl.start(cmdarray, envp, dir, redirects, pipeBufferSize)`
- `ProcessBuilder.java:1107` — `ProcessImpl.start` 委托(平台实现)
- `unix/classes/java/lang/ProcessImpl.java:187` — `static Process start(...)` — linux 平台实现
- 流程: Java 侧按重定向配置组装 `std_fds`(`ProcessImpl.java:226-244`: RedirectPipeImpl 直接复用文件 fd,普通管道留 -1)→ 传入 native `forkAndExec`(`ProcessImpl.java:322`)— **native 内完成管道创建 + fork + exec** → 返回 pid,Java 侧包装 PipeInputStream/PipeOutputStream 与进程句柄
- 关键设计 (斜体): *ProcessBuilder 是"配置",ProcessImpl 是"执行"——接口与平台实现分离;重定向(start 时 stdin/out/err 可指定文件/管道/继承)减少手工搬运数据的代码*
- 面试/生产: `p.getInputStream().read()` 会阻塞——不消费子进程输出,管道缓冲区满,子进程写阻塞 → 卡死(经典 bug)

### 2. "fork + exec 是什么？" — 子进程的诞生

场景: 面试追问 Process 启动底层——Java 进程怎么"生出"另一个进程?

- `ProcessImpl.java:322` — `private native int forkAndExec(int mode, byte[] helperpath, ...)` — **native 方法**: 一次调用内完成 fork + exec
- POSIX 语义: fork 复制当前进程(写时复制)→ 子进程 exec 替换成新程序;Java 侧做了两步合一的封装,还处理了管道重定向
- `waitFor()` 是 **wait/notify 模型**(`ProcessImpl.java:493-498`): Java 侧只 `wait()` 等 `hasExited` 标志;标志由 `ProcessHandleImpl.completion(pid)` 回调设置(`ProcessImpl.java:388-393`)— native 侧监控子进程退出(waitpid 路径),回调里同时 `notifyAll()` 并唤醒管道流
- 关键设计 (斜体): *为什么不用纯 Java 做?进程创建必须走内核(fork/execve);Java 的 native 层封装把"创建 + 管道 + 等待"打包,避免每步一个系统调用的重复代码;Linux 上默认 `VFORK`(带 FORK/POSIX_SPAWN 备选,`ProcessImpl.java:83-92` LaunchMechanism 枚举,由安全特性选择)*
- [内核: fork(2) 写时复制;execve(2) 替换进程映像;waitpid(2) 回收子进程;man 2 fork / man 2 execve]
- 面试点: "Process 不是线程——它是内核进程,Java 侧通过管道与其通信"

### 3. "JVM 启动时 Java 侧做了什么？" — VM 初始化与属性快照

场景: main 方法执行前,Java 侧的第一段代码是什么?

- `jdk/internal/misc/VM.java` — 静态块触发 native 初始化(`VM.java:413-415` `static { initialize(); }`),`initialize()` 完成 VM 侧准备
- `VM.java:187` `saveAndRemoveProperties(Properties)` — 关键属性快照(见第 2 篇 §3)
- `VM.java:93` `isBooted()` — 启动完成标志
- System 类:`System.java:102` 静态块 `registerNatives()` — 加载 native 方法绑定
- 关键设计 (斜体): *启动顺序的"鸡生蛋"问题: System.getProperties 需要 native 支持 → 静态块先注册 natives → VM 再注入属性;VM.java 是 Java 侧与 VM 的"初始化握手点",完整链路见内部卷*
- [内部卷: 30-jvm-entry(启动序列: main 入口 → System 初始化 → 用户 main)]

### 4. Signal 与进程间信号

场景: `kill -9` vs `kill -15` 对 Java 进程的区别

- `jdk/internal/misc/Signal.java` — Java 侧信号注册(handler dispatch 到注册的回调)
- SIGTERM(15): JVM 收到后触发 shutdown hook 流程(可被捕获,优雅退出);SIGKILL(9): 不可捕获,进程直接终止,钩子不执行
- 关键设计 (斜体): *JVM 把 SIGTERM 转成 Shutdown.exit 路径;SIGKILL 无法拦截——生产"kill -9 丢数据"的本质;SIGINT(ctrl+C)同理走钩子*
- 生产: K8s terminationGracePeriod 内 SIGTERM 跑钩子,超时 SIGKILL
- [man 7 signal;内核: 信号投递与默认行为]

---

### 核心悬念

进程有了,对象也有了——但"类"是怎么从磁盘走进 JVM 的?String 的字节码、Integer 的缓存,这些类是谁加载的?双亲委派模型为什么是那个形状?

> → 下一篇: 域 07 类加载器(07-classloader 系列) | 关联: 域 11 线程(ThreadGroup/uncaughtException)
