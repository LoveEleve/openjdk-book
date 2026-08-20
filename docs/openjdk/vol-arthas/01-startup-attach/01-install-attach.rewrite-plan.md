# 01-install-attach 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“安装命令 + attach 流程说明”重写成一篇围绕“服务不能重启时，Arthas 如何动态进门”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成“命令清单 + 参数介绍 + attach 说明”的组合文。

更好的统一问题是：

**当线上 JVM 已经在跑、又不能重启时，Arthas 凭什么还能动态进入目标进程，并且把“进门”和“连门”拆成两条可独立诊断的链？**

这样本篇就不再是：

- `as.sh` 怎么写
- `--attach-only` 是什么
- tunnel 是什么
- `stop/reset/exit` 有什么区别

而会被收束成同一条主线的几个边界：

- 外部控制面如何发起 attach
- 目标 JVM 如何真正承载 Arthas
- 为什么 attach 成功不等于会话可用
- 为什么网络/认证/隧道属于第二阶段问题

## 2. 读者困惑

线上服务不能重启时，为什么一条：

```bash
./as.sh <pid>
```

就能把 Arthas 挂进去？

更具体地说：

- Arthas 是不是像 SSH 一样直接“连上 JVM”了？
- 为什么 `--attach-only` 只挂不连？
- 为什么有时 attach 成功了，终端还是连不上？
- 为什么 tunnel 模式看起来像远程接入，但又不等于另一种 attach？
- 为什么 `exit`、`reset`、`stop` 不是一回事？

## 3. 一句话顿悟

**Arthas 的第一步不是“打开交互终端”，而是先借 JDK Attach API 把自己动态装进目标 JVM；只有 agent 已经在目标 JVM 内落地之后，外部调用方才去连 telnet/http/tunnel 这套会话层。**

也就是：

```text
attach = 进门
connect = 连门
```

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 Linux / JDK Attach API / 外部 `as.sh` 路径
- 不把 Spring Boot starter 自 attach 与本篇混成同一路径；starter 留给 `03-attach-paths.md`
- 不把 bind / destroy / SpyAPI 注入细节提前写成本篇主线；这些分别留给后续两篇
- 这里讲的是 Arthas 当前工程实现，不等于所有 Java agent / attach 工具的统一模型

## 5. 旧稿/现稿主要问题

### 5.1 已有优点

- 已经开始建立“attach 不等于 connect”的边界
- 已经有生产场景开头，不再只是命令说明书
- 已经引入 tunnel、`--attach-only`、`exit/reset/stop` 的层级差异
- 关键脚本与 Java 侧锚点基本具备

### 5.2 必须修复的问题

- 还没有独立的 rewrite plan 作为前置工件
- 虽然比旧稿更像文章，但仍偏解释型，缺少更严格的证据密度
- `as.sh -> java -jar arthas-core.jar -> VirtualMachine.attach -> loadAgent -> agentmain` 这条链还可以更像“证据链”，而不只是口头总结
- `tunnel` 一节目前更像功能介绍，尚未完全纳入“进门/连门分离”的主线
- `stop/reset/exit` 虽然被提到，但失败方案推演还不够厚
- “为什么不能把 attach 和 connect 混成一步”这一失败方案还需要更强的事故感

## 6. 重写策略

本篇不改题目，但要改骨架。

不按源码顺序写，也不按命令帮助顺序写，而按读者理解路径推进：

1. 先用线上事故和“服务不能重启”建立危机感
2. 先推翻“Arthas 只是连上一个 shell”的错误直觉
3. 再给出总图：外部脚本 / Attach API / 目标 JVM / bind / 会话连接
4. 然后分层拆：
   - `as.sh` 是什么角色
   - Attach API 负责什么
   - `--attach-only` 为什么存在
   - tunnel 为什么只是连接层改写
   - 安全与 stop 为什么属于同一条启动边界
5. 最后收束成“寄生系统先落地，再会话层接上来”

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——服务不能重启，但你必须进 JVM

目标：建立真实困惑，而不是从命令帮助开篇。

要回答：

- 为什么线上最先卡住的不是“命令怎么用”，而是“怎么先进去”
- `./as.sh <pid>` 看起来像一条命令，实则要拆成两层问题
- 本篇不讲 watch/thread/profiler，而只讲“怎么进门”

预估字数：800-1000

### 第二节：先排除一个错误直觉——Arthas 不是直接“远程控制 JVM”

目标：做失败方案推演。

要回答：

- 为什么用户会自然把 Arthas 想成“远程 shell”
- 这个模型解释不了哪些现象：`--attach-only`、attach 成功但连不上、tunnel、`stop`
- 真正的问题不是“怎么发命令”，而是“怎么把 Arthas 寄生进去”

预估字数：1000-1300

### 第三节：第一层——`as.sh` 只是外部发令器，不是驻留本体

目标：讲清脚本的角色边界。

要回答：

- `as.sh` 负责参数门面与用户入口
- 为什么脚本最后要起一个独立 JVM 执行 `arthas-core.jar`
- 为什么 shell 不适合直接承担 Attach API 逻辑

证据锚点：

- `as.sh:100-105`
- `as.sh:559-820`
- `as.sh:751-819`
- `as.sh:893-899`

预估字数：1200-1500

### 第四节：第二层——真正的“进门”发生在 Attach API

目标：把外部控制面和目标 JVM 数据面拆开。

要回答：

- `VirtualMachine.attach(pid)` 与 `loadAgent(...)` 各自做什么
- 为什么是“外部发起，目标 JVM 内执行”
- 为什么 attach 成功不等于用户已经进入 Arthas 会话
- attach 失败与 bind/network 失败为什么必须分层排查

证据锚点：

- `core/Arthas.java:103`
- `core/Arthas.java:125`
- 与后续 `agentmain` 的桥接只点名，不提前展开内部注入细节

预估字数：1500-1800

### 第五节：第三层——`--attach-only` 暴露了两阶段模型

目标：把“进门/连门”彻底讲透。

要回答：

- 为什么 `--attach-only` 不是边角参数，而是整条链路的证据
- 为什么自动化/CI/预挂载场景必须只做第一阶段
- 为什么把 attach 和 connect 混成一步，会让故障定位失真
- `exit` / `reset` / `stop` 分别结束哪一层

预估字数：1300-1700

### 第六节：第四层——tunnel 改写的是会话连通方式，不是 attach 方式

目标：把 tunnel 收进主线，而不是写成功能附录。

要回答：

- 为什么 tunnel 不是“另一种 attach”
- 为什么它只改写连接方向：入站 → 出站注册 + 会话中转
- 为什么它特别适合 K8s / 内网 / 审计场景
- 代价是什么：链路增加、合规边界、自建 tunnel-server 的必要性

证据锚点：

- `as.sh:838-891`

预估字数：1200-1500

### 第七节：第五层——安全和销毁为什么从第一步就属于主线

目标：把安全与撤离纳入“进门边界”。

要回答：

- 为什么诊断工具的安全边界必须前置
- 绑定到 `0.0.0.0` 为什么必须配密码或生成随机密码
- 为什么 `stop` 不是“退出终端”，而是停止寄生系统
- 为什么安全、认证、命令禁用、stop/reset 不应被看成运维补丁

证据锚点：

- `ArthasBootstrap.java:415-426`
- `basic1000/StopCommand.java:18`（或后续正文实际核对行号）
- `basic1000/ResetCommand.java:25`（或后续正文实际核对行号）
- `ArthasBootstrap.java:868-874`
- `ArthasBootstrap.java:944-945`

预估字数：1200-1600

### 第八节：收网——Arthas 不是“连上一个 shell”，而是“先寄生，再会话”

目标：把全文收成一句话并桥接下一篇。

必须点名：

- `as.sh` 是外部发令器
- Attach API 负责进门
- 目标 JVM 承载 Arthas
- telnet/http/tunnel 是第二阶段会话层
- 下一篇才进入“进门之后 JVM 里多了什么”

预估字数：700-900

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 把 Arthas 当成直接“远程 shell”
2. 把 attach 成功和会话可用当成同一个成功条件
3. 让 shell 直接承担全部 attach 逻辑
4. 把 tunnel 当成另一种 attach，而不是另一种连接方式
5. 把 `exit` / `reset` / `stop` 当同义词

## 9. 本篇必须明确澄清的误解

1. Arthas 不是预置在 JVM 里的常驻服务
2. `as.sh` 不是驻留本体，只是外部发令器
3. Attach API 解决的是“动态进入目标 JVM”，不是“直接打开终端”
4. `--attach-only` 证明了 attach 与 connect 是两阶段
5. tunnel 不改写 attach 本体，只改写会话方向
6. 退出终端不等于 Arthas 已经从 JVM 里撤走

## 10. 证据清单（正文托底）

- `as.sh:100-105`：默认端口
- `as.sh:559-820`：参数解析
- `as.sh:751-819`：无参数选择 JVM
- `as.sh:838-891`：tunnel 参数组装
- `as.sh:893-899`：启动 `arthas-core.jar`
- `core/Arthas.java:103`：`VirtualMachine.attach(pid)`
- `core/Arthas.java:125`：`loadAgent(arthas-agent.jar)`
- `ArthasBootstrap.java:415-426`：0.0.0.0 随机密码
- `basic1000/StopCommand.java`：`stop` 命令语义
- `basic1000/ResetCommand.java`：`reset` 命令语义
- `ArthasBootstrap.java:868-874`：destroy 主链
- `ArthasBootstrap.java:944-945`：Spy 清理

## 11. 字数预算

- 目标正文总字数：`8000-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除所有代码块后，主线是否仍然成立
2. 是否清楚回答了“为什么 attach 与 connect 必须分开”
3. 是否至少展开了 4 个失败方案
4. 是否把 tunnel 和 stop 收进了主线，而不是写成附录功能点
5. 是否显式区分了脚本层、Attach API 层、目标 JVM 层、会话层
6. 是否避免提前展开下一篇的 AgentBootstrap / SpyAPI 细节
7. 是否完成 `file:line` 重核与边界声明
