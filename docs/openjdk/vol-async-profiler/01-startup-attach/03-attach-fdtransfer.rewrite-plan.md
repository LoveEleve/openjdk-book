# 03-attach-fdtransfer 重写规划

> 状态：deep review 完成，待修订同步
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“jattach + fdtransfer 说明文”重写成一篇围绕“请求怎样穿过 JVM attach 控制通道，而受限的 perf/kallsyms 资源又怎样通过独立 fd 通道进入目标进程”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成“jattach 是自研 attach 工具，fdtransfer 是权限桥”的平铺说明。真正的统一问题是：**为什么把 agent 送进 JVM，仍然不足以保证采样能启动；控制请求和底层资源为什么必须走两条不同通道；而这两条通道又如何在 CLI 编排中重新汇合。**

本篇既不能把 `run_jattach()`、`jattach_hotspot.c` 和 `fdtransfer` 混成一个 attach 大黑箱，也不能把 `fdtransfer` 写成所有动作必经的第二次 attach。要显式区分：JVM attach listener、Unix domain socket fd 传递、PID/network namespace 迁移、perf/kallsyms 资源准备。

## 2. 读者困惑

- 为什么没有完整 JDK 时，async-profiler 仍能动态 attach 到 JVM？
- 为什么 `start` 和 `collect` 可能需要 `fdtransfer`，而 `status`、`dump` 并不需要？
- 为什么 agent 已经 load 成功，CPU 事件仍可能因为 perf 权限而失败？
- `fdtransfer` 到底传的是采样结果、采样命令，还是内核资源句柄？
- `run_fdtransfer()` 看起来启动就返回，它到底什么时候才算“准备好了”？
- `jattach` 和 `fdtransfer` 的 namespace/身份切换分别解决什么问题？

## 3. 一句话顿悟

**async-profiler 的进门链分成两条并行通道：`jattach` 负责把 load 请求送到 JVM attach listener，让 `Agent_OnAttach` 在目标进程内接管参数；`fdtransfer` 只在需要底层采样资源时启动，把 perf fd 或 kallsyms fd 通过 Unix socket 的 `SCM_RIGHTS` 传进目标进程。两者在 CLI 层被编排到同一次 start/collect 动作里，但它们解决的是不同层次的问题。**

总图：

```text
控制通道
CLI
  → run_jattach()
    → jattach_hotspot/openj9
      → attach listener / .java_pid socket
        → load command
          → Agent_OnAttach / native parser

资源通道（按需）
CLI
  → run_fdtransfer()
    → FdTransferServer::runOnce()
      → namespace 准备 + bind UDS + fork server
        → target-side FdTransferClient::connectToServer()
          → requestPerfFd / requestKallsymsFd
            → SCM_RIGHTS 传递 fd
```

## 4. 版本与范围边界

- 基于当前 async-profiler Linux 实现。`fdtransfer` 章节不能外推到 macOS 或 Windows。
- `jattach` 是自带的 native attach 客户端实现，不等于“不依赖 JVM attach 协议”；它只是没有依赖 JDK Java Attach API。
- `run_jattach()` 统一的是 profiler 自身动作；`jcmd`、`threaddump` 等直接 jattach 动作另走 `main.cpp:567-572`。
- `fdtransfer` 是按需资源桥，不是第二次 attach，也不是所有事件都需要。
- `run_fdtransfer()` 等待的是 `runOnce()` 的启动准备返回，不是长期服务生命周期结束。
- `fdtransfer` 传递的是 fd/内核对象引用，不是样本结果或参数语义。
- `connectToServer()` 发生在目标进程内的 native 运行期，而不是 CLI 进程内。

## 5. 现稿方法论差距审计

- 当前开篇有总图，但仍偏“组件功能说明”，事故感和失败方案不够厚。
- 把 `run_jattach()` 写成“一切动作都折叠成 load”过强，没有明确 profiler 动作范围与直接 jattach 动作的分叉。
- `fdtransfer` 生命周期表述不准：`run_fdtransfer()` 等待的不是整个服务结束，而是 `runOnce()` 完成准备并 fork 子服务。
- `jattach` 目前缺少 `.attach_pid`/`SIGQUIT`/`.java_pid` socket 的 HotSpot attach 细节，读者仍不清楚“没有 JDK 工具也能 attach”的实际机制。
- `fdtransfer` 只从服务端视角讲权限桥，还缺客户端 `connectToServer()`/`requestPerfFd()`/`recvFd()` 闭环。
- “有权限的 profiler 侧”表述过强，应改成“具有所需权限的辅助进程，是否具备权限取决于运行环境”。
- 还缺 `requestKallsymsFd()` 与符号解析的关系，容易让读者误解 fdtransfer 只服务 perf。

## 6. 重写策略

1. 用“load 成功但 CPU 事件仍失败”的真实排障场景开场。
2. 推演并否定：attach 成功就等于采样成功、fdtransfer 是第二次 attach、它传的是采样数据、所有动作都需要它。
3. 给出双通道总图：控制通道负责 JVM 接收请求，资源通道负责底层 fd 能力。
4. 分层讲：
   - `run_jattach()` 与 `jattach_action` 分流；
   - HotSpot attach listener 如何被唤醒并接收 load；
   - `run_fdtransfer()`/`runOnce()` 怎样完成 namespace 和 server 准备；
   - 目标进程内客户端怎样请求 perf/kallsyms fd；
   - 为什么 start/collect 需要，status/dump 通常不需要。
5. 收网时明确：控制通道解决“谁接管命令”，资源通道解决“谁能打开底层资源”。

## 7. 结构大纲

### 第一节：事故开场——agent 已经 load 了，CPU 采样却还可能起不来

回答：attach 成功不等于 perf 资源就绪；本篇不是继续讲参数，而是讲两条并行通道。

预估字数：900-1100

### 第二节：先排除四个错误直觉——attach 成功即采样成功、fdtransfer 是第二次 attach、它传的是样本数据、所有动作都需要它

预估字数：1500-1900

### 第三节：第一层——`run_jattach()` 只统一 profiler 动作的控制通道

证据：`main.cpp:365-383`、`main.cpp:567-572`、`main.cpp:580-606`。

回答：profiler 动作与直接 jattach 动作分叉；collect 是 start/stop 编排，不是新引擎。

预估字数：1500-1800

### 第四节：第二层——没有 JDK 也能 attach，因为客户端自己实现了 HotSpot attach 协议

证据：`jattach_hotspot.c:36-69`、`:72-123`、`:141-214`。

回答：`.attach_pid`、`SIGQUIT`、`.java_pid` socket、命令写入、load 返回码解析；不依赖 JDK Java API ≠ 不依赖 attach 协议。

预估字数：1800-2200

### 第五节：第三层——`run_fdtransfer()` 等的是启动准备，不是服务结束

证据：`main.cpp:347-363`、`fdtransferServer_linux.cpp:258-300`。

回答：为什么先 bind 再进 PID namespace 再 fork；父侧为何立刻返回；为什么 CLI 能继续 start。

预估字数：1400-1700

### 第六节：第四层——fdtransfer 真正传的是 perf/kallsyms 的 fd 句柄

证据：`fdtransferClient_linux.cpp:23-138`、`fdtransferServer_linux.cpp:124-185`、`symbols_linux.cpp:700-701`、`perfEvents_linux.cpp:627-628`。

回答：connect/request/recvFd 闭环；`SCM_RIGHTS` 传递的是内核对象引用；perf 与 kallsyms 两类请求分别服务什么消费方。

预估字数：1900-2300

### 第七节：第五层——权限和 namespace 各在哪一侧解决

证据：`jattach.c:21-55`、`fdtransferServer_linux.cpp:277-299`。

回答：jattach 的 network/ipc/mnt namespace 与身份切换；fdtransfer 的 net/pid namespace；二者不要混成一个“高权限 attach”。

预估字数：1500-1900

### 第八节：收网——控制通道让 JVM 接住命令，资源通道让内核接住采样

桥接下一篇采样核心或事件引擎。

预估字数：800-1000

## 8. 必须展开的失败方案

1. attach 成功就等于 CPU 采样一定成功。
2. `fdtransfer` 是第二次 attach 到 JVM。
3. Unix socket 上传的是采样结果或参数字符串。
4. 所有 profiler 动作都需要 `fdtransfer`。
5. `run_fdtransfer()` 返回等于整个服务生命周期结束。

## 9. 证据清单

- `src/main/main.cpp:347-383`
- `src/main/main.cpp:567-606`
- `src/jattach/jattach_hotspot.c:36-69`
- `src/jattach/jattach_hotspot.c:72-123`
- `src/jattach/jattach_hotspot.c:141-214`
- `src/main/fdtransferServer_linux.cpp:258-300`
- `src/fdtransferClient_linux.cpp:23-138`
- `src/main/fdtransferServer_linux.cpp:124-185`
- `src/profiler.cpp:897-901`
- `src/perfEvents_linux.cpp:627-628`
- `src/symbols_linux.cpp:700-701`

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“双通道：控制请求 vs 资源句柄”。
2. 至少展开 4 个失败方案。
3. 不把 profiler 动作范围扩大成所有 jattach 动作。
4. 不把 `fdtransfer` 写成第二次 attach 或采样数据通道。
5. 明确 `run_fdtransfer()` 的 fork 生命周期。
6. 明确 `jattach` 的 HotSpot attach 细节与返回码解析。
7. 每个 `file:line` 重新核对，链接与禁用词通过。
