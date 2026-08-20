# 01-build-attach 重写规划

> 状态：正文已重写，deep review 修订中
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“CLI 入口 + attach 说明”重写成一篇围绕“采样器如何在不重启目标 JVM 的前提下完成进门、交付请求和进入后续内核”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成 `main.cpp`、`run_jattach()`、`fdtransfer` 和 C API 的节点说明。它需要围绕一个完整问题闭环：外部命令如何把一个尚未运行在目标 JVM 里的 native 采样器变成目标进程可执行的 agent，并且为什么“attach 成功”仍然不等于“采样结果已经产生”。

本篇聚焦外部进门链，不提前展开 `Agent_OnAttach` 内部的 JVMTI 能力注册、事件引擎和栈采集；那些由 AP-3、AP-2 负责。`fdtransfer` 只讲它作为 Linux 权限桥解决什么问题，不把所有系统权限问题泛化成 attach 的必然步骤。

## 2. 读者困惑

线上 JVM 已经运行，不能为了诊断重启服务。用户执行一条 `asprof` 命令后，profiler 为什么能进入目标进程？

更具体地说：

- CLI 是直接调用采样器，还是先通过某种 JVM attach 协议交付请求？
- `start`、`stop`、`dump`、`status` 为什么可以复用同一条 `load` 通道？
- 参数是在外部 CLI 解释，还是进入目标 agent 后才由 native 解析？
- Linux perf 资源为什么可能需要一个额外的 `fdtransfer` 权限桥？
- attach/load 成功后，为什么还不能直接断言 CPU、alloc 或 flamegraph 已经可用？
- C API 与 CLI 是两套不同内核，还是同一个 profiler 的不同入口？

## 3. 一句话顿悟

**async-profiler 的外部入口不是“直接开始采样”，而是先把动作和参数封装成一次 agent load 请求，通过 `jattach` 送入目标 JVM；agent 在目标进程内接管请求后，才进入 JVMTI、事件引擎和记录后端。Linux `fdtransfer` 则只在需要时把目标进程缺少的 perf 权限和文件描述符能力桥接过来。**

总图：

```text
用户命令
  → main.cpp：识别目标、动作和少量 CLI 选项
    → 参数/格式串：拼成 agent 请求
      → run_jattach()
        → jattach：向目标 JVM 发起 load
          → profiler agent 在目标 JVM 内接收请求
            → Arguments::parse()
              → Profiler::run / 后续事件引擎

Linux perf 特殊分支：
目标 agent → fdtransfer 请求 → 特权辅助进程
  → perf_event_open / mmap / 文件描述符
    → 通过 Unix socket 回传能力
```

## 4. 版本与范围边界

正文开头必须明确：

- 基于 `/data/workspace/source-code/code/spring/async-profiler/` 当前源码讨论，行号写作时以当前工作树重新核对结果为准。
- 重点是 CLI 到 agent load 的外部启动链，聚焦 Linux attach 与 perf 权限桥。
- `src/main/main.cpp` 是 CLI 入口；`src/main` 目录本身不是入口文件。
- `run_jattach()` 是外部请求交付点，但它不等于目标 JVM 内部的 `Agent_OnAttach()`；后者留给 JVM 集成篇。
- `arguments.cpp` 是 native 参数语义中心，但本篇只说明请求如何交付到解析器，不展开全部字段、枚举和单位规则；详见 `02-arguments-struct.md`。
- `fdtransfer` 是 Linux 实现路径，不能外推为所有平台 attach 都需要权限辅助进程。
- `asprof_execute()` 是同一 native 内核的 C API 入口，不等于 CLI attach 路径，也不需要经过目标 JVM attach。
- 本篇不把“请求已交付”写成“采样已成功”，必须区分进门、解析、引擎启动、记录和输出几个成功条件。

## 5. 现稿方法论差距审计

> 首轮重写已完成。以下问题清单保留为审计记录；本轮 deep review 已修复其中的 attach 返回码、profiler 动作范围、fdtransfer 生命周期、HotSpot 接收链和多入口证据问题。

### 5.1 已有优点

- 已经确认真实 CLI 文件为 `src/main/main.cpp`。
- 已经抓到 `run_jattach()` 将外部动作归约到 `load` 请求的关键事实。
- 已经建立了 `arguments.cpp` 作为 native 语义中心的边界。
- 已经指出 `fdtransfer` 涉及 Linux 低层资源和权限边界。
- 已经保留了 CLI、Java/C API 与 native 内核之间的层次关系。

### 5.2 必须修复的问题

- 现稿从源码节点开篇，读者尚未遇到“不能重启但必须进 JVM”的具体困惑。
- 失败方案推演不足：直接把 CLI 当采样器、为每个动作各写一条 attach 链、让目标进程自行创建特权 perf 资源、把 attach 成功当成采样成功，都需要展开并否定。
- `run_jattach()` 当前被描述为“统一 attach/load 通道”，但需要进一步解释它为什么把动作折叠成 load，以及请求真正在哪里被接收；不能把外部 `run_jattach()` 与 agent 内部入口混为一个函数。
- `fdtransfer` 当前写法偏抽象，必须以真实代码说明：服务端校验 TID 归属后调用 `perf_event_open`，映射 perf buffer，并通过 `sendFd` 返回 fd；同时说明 mmap 失败在该处被保留给后续 profiler 路径报告。
- C API 当前只作为“也能被调用”的附录，应该放进“同一内核、多种入口”的边界中，并明确它不经过 CLI attach。
- 现稿没有把“请求交付完成”和“采样链启动完成”拆成可诊断的阶段。
- 篇幅和叙事密度明显低于重大启动主链篇要求，需要按理解路径扩展，而不是继续增加源码清单。

## 6. 重写策略

不按 `main.cpp → fdtransfer → asprof.cpp` 的源码顺序平铺，而按读者理解路径推进：

1. 用线上不能重启的采样事故开场，建立“先进去，再采样”的问题。
2. 推演并否定“CLI 直接调用采样器”“每个动作一套 attach”“目标进程自己申请所有 perf 资源”三个朴素方案。
3. 给出完整总图，明确外部控制面、目标 JVM 内 agent、Linux 权限桥和统一记录后端四个角色。
4. 分层解释：
   - `main()` 如何识别动作、事件和输出选项；
   - `run_jattach()` 如何把动作归约成一次 load；
   - 请求进入 agent 后为什么才轮到 `Arguments::parse()`；
   - `fdtransfer` 如何以最小权限桥交付 perf 能力；
   - C API 为什么是绕过 attach 的另一种入口。
5. 用阶段化故障模型收网：命令识别、load 交付、agent 初始化、引擎启动、样本记录、结果输出不是同一个成功条件。

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——JVM 不能重启，但 profiler 必须先进入它

目标：让读者先理解“采样之前还有进门问题”。

要回答：

- 为什么线上诊断不能从 CPU 火焰图直接开讲。
- `asprof start ...` 表面是一条命令，实际包含外部控制、目标 JVM 接收和后续引擎启动。
- 本篇只追“怎么进门”，不提前讲栈行走。

预估字数：800-1000

### 第二节：先排除三个直觉方案——直接调用、重复 attach、目标进程全权申请

目标：完成至少三个失败方案推演。

要回答：

- 为什么 CLI 不能像普通库调用一样直接在外部进程里访问目标 JVM 的线程和栈。
- 为什么为 `start/stop/dump/status` 分别实现 attach 会导致连接、错误处理和权限路径重复。
- 为什么目标进程在受限权限下不一定能直接完成 `perf_event_open` 和 perf buffer 映射。
- 设计者为什么必须把“请求交付”和“低层资源代办”分别抽象出来。

预估字数：1400-1800

### 第三节：第一层——`main()` 只是控制面，把人话命令变成请求片段

目标：讲清 CLI 的角色，不把它夸写成采样引擎。

要回答：

- `main()` 如何识别 `start/resume/stop/dump/status/metrics/list/collect`。
- `-e`、`-d`、`-f`、`-o`、`-i` 如何进入动作、参数和格式串。
- PMU event 与 tracepoint 为什么在 CLI 层做有限预处理。
- CLI 的输出是什么：请求载荷，而不是已经完成的采样结果。

证据锚点：

- `src/main/main.cpp:415-470`
- `src/main/main.cpp:445-458`
- 写作时重新核对当前 `main.cpp` 后续参数拼接位置

预估字数：1400-1700

### 第四节：第二层——`run_jattach()` 为什么把不同动作都压成一次 `load`

目标：解释 attach 归约的设计动机与边界。

要回答：

- `run_jattach()` 为什么 fork 子进程并等待结果。
- `jattach(pid, 4, argv, 0)` 的四个参数如何构成 `load` 请求。
- `libpath`、绝对路径标志和 `cmd` 如何作为 agent load 的载荷。
- 为什么统一 load 通道能让 start/stop/dump/status 共用目标进程连接和错误处理。
- 为什么这仍然只是“请求送到 JVM”，不能直接等同于 native agent 已经完成初始化。

证据锚点：

- `src/main/main.cpp:365-383`
- `src/main/main.cpp` 中 `cmd`、`params`、`format` 的组装位置，写作时重新核对

预估字数：1600-1900

### 第五节：第三层——参数的最终语义在目标 agent 内，而不是 CLI

目标：建立外部协议与 native 语义中心的边界。

要回答：

- 外部 CLI 负责把动作、事件、格式和选项拼进命令载荷。
- 目标 agent 接收后，才由 `Arguments::parse()` 把逗号协议解释成运行时配置。
- 为什么多种入口可以共享同一语义中心。
- 为什么本篇只建立交付边界，把枚举、默认值、单位和 timeout 留给下一篇。

证据锚点：

- `src/arguments.cpp:41-60`
- `src/arguments.cpp:62-285`
- `src/asprof.cpp:26-52`（对照 C API 的直接解析路径）

预估字数：1300-1600

### 第六节：第四层——`fdtransfer` 不是“第二次 attach”，而是 Linux 权限桥

目标：把高风险的 fdtransfer 事实讲准确。

要回答：

- 为什么目标应用未必拥有创建 perf fd 和映射 perf buffer 所需的权限。
- 服务端如何检查请求线程属于目标进程：`peer_pid == 0` 或 `tgkill(peer_pid, tid, 0) == 0`。
- 服务端如何调用 `perf_event_open`、`mmap` perf buffer，并通过 `sendFd` 回传描述符。
- 为什么 `/proc/kallsyms` 还需要复制到临时文件再传 fd 的特殊处理。
- 为什么该路径是 Linux 特定能力桥，不是所有 attach 场景必经步骤。

证据锚点：

- `src/main/fdtransferServer_linux.cpp:113-159`
- `src/main/fdtransferServer_linux.cpp:162-179`
- 写作时补读请求结构、客户端发起点和 Unix socket 连接位置，避免只凭服务端文件推断完整协议

预估字数：1800-2200

### 第七节：第五层——CLI、C API 与 Java API 是不同入口，不是不同 profiler 内核

目标：完成多入口边界与消费方式解释。

要回答：

- CLI 需要 attach 到目标 JVM，适合对外部目标进程发命令。
- `asprof_execute()` 直接构造 `Arguments` 并调用 `Profiler::instance()->runInternal()`，不经过 `jattach`。
- Java API 通过 native bridge 进入同一内核，但其参数协议仍受 native 解析器约束。
- “入口不同”不等于“采样实现不同”，真正共享的是 profiler、storage 和输出后端。

证据锚点：

- `src/asprof.cpp:26-52`
- `src/asprof.cpp:55-61`
- Java API 仅做与后文的边界桥接，不提前展开 AP-6 细节

预估字数：1200-1500

### 第八节：收网——进门、启动、记录、输出是四个不同成功条件

目标：建立可用于排障的总图并桥接下一篇。

必须点名：

- `main()` 识别命令，不负责目标 JVM 内采样。
- `run_jattach()` 交付 load 请求，不等于 agent 初始化完成。
- `Arguments::parse()` 建立 native 配置快照。
- `fdtransfer` 在 Linux 特定条件下补齐 perf 资源能力。
- C API 绕过 attach，但仍进入同一 native profiler 内核。
- 下一篇进入参数结构：字符串如何变成类型化配置，以及参数默认值怎样影响后续引擎。

总图：

```text
控制面识别
  → load 请求交付
    → agent 接收与初始化
      → 参数解析
        → 事件引擎启动
          → 样本记录
            → 输出消费
```

预估字数：800-1000

## 8. 必须展开的失败方案

至少展开以下失败方案：

1. 把 `asprof` CLI 当成直接运行在目标 JVM 内的采样器。
2. 为 `start`、`stop`、`dump`、`status` 分别实现不同 attach 通道。
3. 让受限目标进程自行完成所有 `perf_event_open`、perf buffer `mmap` 和 fd 获取。
4. 把 `run_jattach()` 返回成功等同于采样已经启动并产生结果。
5. 把 C API 的直接调用路径误认为也必须经过目标 JVM attach。

## 9. 本篇必须明确澄清的误解

1. `src/main/main.cpp` 是 CLI 入口，不是采样记录入口。
2. `run_jattach()` 的核心动作是把 agent load 请求送入目标 JVM，不是直接调用目标 JVM 内的 `Profiler` C++ 对象。
3. 外部 CLI 参数预处理不等于参数语义最终由 CLI 拥有。
4. `fdtransfer` 是 Linux perf/文件描述符权限桥，不是第二套 attach 实现。
5. `fdtransferServer_linux.cpp` 的 `mmap` 发生在辅助服务端，不能据此说所有平台或所有事件都走这条路径。
6. `asprof_execute()` 是绕过 CLI attach 的 C API 入口，但仍复用 native profiler 内核。
7. attach、agent 初始化、引擎启动、样本记录和输出写入是不同阶段。

## 10. 证据清单

- `src/main/main.cpp:365-383`：fork、jattach load 请求、返回码和日志回传。
- `src/main/main.cpp:415-470`：动作、输出、事件、采样选项识别。
- `src/main/fdtransferServer_linux.cpp:113-159`：perf fd 请求校验、`perf_event_open`、perf buffer 映射和 fd 回传。
- `src/main/fdtransferServer_linux.cpp:162-179`：`/proc/kallsyms` 复制和 fd 准备。
- `src/arguments.cpp:41-60`：native 参数解析入口。
- `src/arguments.cpp:62-285`：协议 key/value 到配置字段的 CASE 表。
- `src/asprof.cpp:26-52`：C API 直接解析并调用 `runInternal()`。
- `src/asprof.cpp:55-61`：线程本地数据和用户 JFR 事件的 C API 扩展入口。
- 写作时必须补核：`jattach()` 接收 load 请求后的目标 JVM 入口，以及 fdtransfer 客户端发起位置。

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`
- 失败方案推演：不少于 `1200` 字。
- 误解澄清与边界：不少于 `800` 字。
- 删除代码块后，主线必须仍然成立。

## 12. 完成后必须通过的检查

1. 删除所有代码块后，读者仍能复述“控制面 → load → agent → 引擎”的主链。
2. 是否至少完整推演 4 个失败方案。
3. 是否清楚区分 CLI、目标 JVM 内 agent、Linux fdtransfer、C API 四种角色。
4. 是否没有把 `run_jattach()` 与 `Agent_OnAttach()` 混为一谈。
5. 是否没有把 fdtransfer 写成所有平台和所有事件的必经路径。
6. 是否完成每个 `file:line` 的当前源码重核。
7. 是否完成“进门成功 ≠ 采样成功”的阶段化故障模型。
8. 是否包含显式 `场景：`、`关键设计（斜体）：`、`[模式: ...]`、跨层标注、篇尾总结和下一篇桥接。
9. 是否通过相对链接、禁用词、结构标记和文章数量检查。
10. 是否在深审完成后再进入正文重写，而不是边审边改。
