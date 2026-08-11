# 域 42 Core Native — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. `System.getProperty("os.name")` — 返回值是 `uname -s` 的结果吗？为什么有些 Docker 容器中返回 "Linux" 但实际上是 Alpine 内核？
2. `Runtime.getRuntime().exec("ls")` — 子进程创建后 Java 层的 Process InputStream 怎么从子进程 stdout 读数据？pipe 的 read-end 在 Java→child write-end 在子进程？

## 2. SRE/运维 (2问)

3. `ProcessHandle.allProcesses()` — 遍历 /proc 时子进程已经退出但 /proc/<pid> 仍存在(zombie)—getProcessPids0 会返回 zombie PID 吗？
4. `process.destroy()` vs `destroyForcibly()` — SIGTERM + wait vs SIGKILL + no-wait——如果子进程捕获了 SIGTERM 并忽略，destroy() 会永久阻塞吗？

## 3. 框架/安全研究者 (2问)

5. Native library loading 用 `RTLD_GLOBAL` — 这意味着所有后续 dlopen 的 libraries 都能看到它的 symbols——这是一个安全风险(恶意 library 可劫持另一个 library 的 function)吗？
6. `FileDescriptor` 的 int fd 在多个 Java 对象间共享——如果两个 FileInputStream 指向同一个 fd，close 一个后另一个还能读吗？

## 4. 性能工程师 (1问)

7. `System.getProperties()` 每次调用都返回相同的 Properties 对象——但有人 `System.setProperty("foo", "bar")` 修改了它——这是线程安全的吗？JVM 内部读取 properties 时加锁吗？

## 5. 架构师 (1问)

8. libjava.so 和 libjvm.so 的关系——libjava.so 中的 JVM_* 函数(JVM_DefineClass/JVM_LoadLibrary)是怎么找到 libjvm.so 中的实现的？dlopen + dlsym？还是编译期链接？
