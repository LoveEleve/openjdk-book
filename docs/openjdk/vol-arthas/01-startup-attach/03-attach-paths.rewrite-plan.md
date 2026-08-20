# 03-attach-paths 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“外部 attach vs 自 attach”重构成一篇围绕“Arthas 为什么允许不同入口，但最终必须汇合到同一套寄生系统”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- 外部 attach 是什么
- starter 自 attach 是什么
- 两条路径都调用 `ArthasBootstrap`
- 最后给一个场景对照表

这种左右对照式说明文。

更好的统一问题是：

**Arthas 明明已经有了 `as.sh <pid>` 这条外部 attach 路径，为什么还需要 Spring Boot starter 的进程内自 attach？而两条入口不同，为什么最后又必须强行汇合到同一个 `ArthasBootstrap` 单例？**

这样本篇就不再是“两种启动方式简介”，而会被收束成一条更硬的主线：

- 谁发起 attach，决定控制面在外部还是内部
- 获取 `Instrumentation` 的方式会变
- 但目标 JVM 内最终承载的诊断系统不能变成两套
- 所以入口可以不同，寄生系统必须统一

## 2. 读者困惑

- 既然 `as.sh <pid>` 已经能动态挂进运行中的 JVM，为什么还需要 starter 自 attach？
- starter 明明没有外部 JVM，它凭什么拿到 `Instrumentation`？
- 两条路径入口差这么多，为什么最后却都调到同一个 `ArthasBootstrap.getInstance(...)`？
- 如果两条路径各自维护一套服务端，会出什么问题？
- 什么时候该选外部 attach，什么时候该选启动期自 attach？

## 3. 一句话顿悟

**Arthas 允许两种入口，不是因为它需要两套诊断系统，而是因为“谁来发起 attach”在不同场景下不一样：外部 attach 适合临时、低耦合地进入已运行 JVM；starter 自 attach 适合在应用启动期就把诊断能力带进来。但无论入口如何变化，目标 JVM 内都必须只承载同一套 `ArthasBootstrap`、同一组 Spy、Transformer 和服务面。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦外部 attach 与 Spring Boot starter 自 attach 两条入口
- 不重复展开 `AgentBootstrap`、`ArthasClassloader`、`SpyAPI` 的内部细节；这些属于前两篇
- 不把 bind/tunnel/destroy 细节写成本篇主线；这里只把它们作为“最终汇合同一个服务生命周期”的下游
- 这里讲的是 Arthas 当前入口设计，不等于所有 Java agent 工具都必须提供这两条路径

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经把“差异核心问题 = 谁发起 attach”点出来
- 外部 attach 与 starter 自 attach 的关键锚点都在
- 已经意识到两条路径最终都汇合到同一个 `ArthasBootstrap`
- 有实用的场景对照表

### 5.2 必须修复的问题

- 当前标题编号异常（`# 22.`），目录风格不一致
- 现稿更像左右对照的说明文，缺少一个更强的冲突式主问题
- 失败方案推演不够厚：为什么不能只保留一种入口、为什么不能让两条路径各自维护一套系统，都还没打透
- `ArthasClassloader` 在本篇重复较多，容易和上一章边界混淆
- 最后的场景对照表有用，但还没收回到“统一单例为什么必须”这个核心问题上

## 6. 重写策略

本篇不按“外部 attach 一节 / 自 attach 一节 / 汇合一节”的素材结构推进，而按更强的问题链组织：

1. 先建立冲突：有了 `as.sh` 为什么还不够，为什么又要 starter
2. 先排除两个错误直觉：
   - 既然外部 attach 能用，就没必要自 attach
   - 两条入口不同，就让它们各自跑一套系统也没关系
3. 再给总图：外部控制面 vs 内部控制面，最终都要进入同一目标 JVM 内单例
4. 然后分层拆：
   - 外部 attach 解决什么问题
   - 自 attach 解决什么问题
   - `Instrumentation` 获取方式为什么不同
   - 为什么入口可以不同，但寄生系统不能分叉
5. 最后收束成“多入口，单系统”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——为什么有时候你不能依赖外部 `as.sh <pid>`

目标：建立真实困惑，而不是直接讲两条入口。

要回答：

- 已运行 JVM 与启动期内嵌诊断面对的是不同现场
- 有些场景外部 attach 很合适，有些场景启动期就要拿到诊断能力
- 本篇真正要追的不是“还有哪条命令”，而是“入口为什么要分叉”

预估字数：900-1100

### 第二节：先排除两个错误直觉——只保留一种入口，或让两条入口各跑一套系统

目标：做失败方案推演。

要回答：

- 为什么“只有外部 attach”不足以覆盖常驻诊断场景
- 为什么“既然两条入口不同，就各自维护一套 Arthas”会制造重复端口、重复 Spy、重复 Transformer、重复生命周期问题
- 真正需要的是“入口多样化，寄生系统单一化”

预估字数：1200-1500

### 第三节：第一层——外部 attach 解决的是“低耦合进入已运行 JVM”

目标：把外部 attach 写成场景解法，而不是命令复述。

要回答：

- `as.sh` + 外部 JVM + `VirtualMachine.attach/loadAgent` 的链路
- 外部控制面与目标 JVM 数据面的分工
- 为什么它适合临时排查和批量挂载

证据锚点：

- `bin/as.sh:893-899`
- `Arthas.java:103-126`
- `agent334/AgentBootstrap.java:67-99`

预估字数：1500-1800

### 第四节：第二层——自 attach 解决的是“在业务启动期就把诊断能力带进来”

目标：把 starter 路径写成另一种场景解法。

要回答：

- 为什么 starter 不需要另一个外部 JVM
- `ByteBuddyAgent.install()` 如何在当前进程内拿到 `Instrumentation`
- 为什么 classpath 解压 arthas-bin.zip、创建 `AttachArthasClassloader` 也是入口层的一部分
- `silentInit=false` 为什么会把失败影响直接推回业务启动链

证据锚点：

- `arthas-agent-attach/ArthasAgent.java:88-134`
- `ArthasAgent.java:90-105`
- `ArthasAgent.java:112-122`
- `ArthasConfiguration.java:66-69`
- `ArthasAgent.java:128-133`

预估字数：1700-2100

### 第五节：第三层——为什么两条入口最终都必须汇合到同一个 `ArthasBootstrap`

目标：把“单例统一”写成主冲突的解法。

要回答：

- 入口不同，最终为什么都指向 `ArthasBootstrap.getInstance(...)`
- 如果没有这个统一单例，会出现什么错：重复端口、重复服务、重复 Spy、重复 Transformer
- 为什么这件事不是实现偏好，而是目标 JVM 一致性的硬约束

证据锚点：

- `AgentBootstrap.java:176-191`
- `ArthasAgent.java:120-122`
- `ArthasBootstrap.java:897-923`

预估字数：1800-2200

### 第六节：第四层——入口不同，哪些边界会变，哪些边界绝不能变

目标：把差异和统一边界都讲清楚。

要回答：

- 变的是：控制面位置、PID 获取方式、`Instrumentation` 获取方式、失败影响面
- 不变的是：目标 JVM 内只允许一套 Arthas 系统、同一条 bind/destroy 生命周期、同一条 Spy/Transformer 边界
- 为什么这才是“多入口，单系统”的真正含义

预估字数：1500-1800

### 第七节：什么时候选哪条路径

目标：保留实战价值，但不能退回成帮助文档。

要回答：

- 临时排查已运行 JVM
- CI / 脚本批量挂载
- Spring Boot 常驻诊断
- 内网 / K8s / tunnel 场景

要求：场景表必须回扣“入口不同，但系统统一”。

预估字数：900-1200

### 第八节：收网——Arthas 不是两套工具，而是“一套寄生系统的两种进门方式”

目标：把全文收成一句话并桥接下一篇。

必须点名：

- 外部 attach
- 自 attach
- `Instrumentation`
- `ArthasBootstrap` 单例
- 统一 bind/destroy 生命周期

预估字数：700-900

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 只保留外部 attach，不支持启动期自 attach
2. 只保留自 attach，不支持临时进入已运行 JVM
3. 两条路径各自维护一套服务端系统
4. 入口不同，就允许各自使用不同的 Spy / Transformer / 生命周期
5. 把 starter 初始化失败当成和外部 attach 一样“无伤大雅”

## 9. 本篇必须明确澄清的误解

1. 外部 attach 和 starter 不是两套 Arthas，只是两种入口
2. `ByteBuddyAgent.install()` 获取的是 `Instrumentation`，不等于直接完成整套 Arthas 装配
3. 外部 attach 的本质不是 shell，而是外部 JVM 控制面
4. 入口不同，不代表目标 JVM 内可以容纳多套 Arthas 系统
5. starter 失败会更靠近业务启动链，影响面和外部 attach 不同
6. tunnel 仍属于外部 attach 的连接面扩展，不是第三种寄生系统

## 10. 证据清单（正文托底）

- `bin/as.sh:893-899`
- `Arthas.java:103-126`
- `agent334/AgentBootstrap.java:67-99`
- `AgentBootstrap.java:176-191`
- `arthas-agent-attach/ArthasAgent.java:88-134`
- `ArthasAgent.java:90-105`
- `ArthasAgent.java:112-122`
- `ArthasAgent.java:128-133`
- `arthas-spring-boot-starter/ArthasConfiguration.java:66-69`
- `ArthasBootstrap.java:897-923`

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么要多入口，但必须单系统”
3. 是否至少展开了 4 个失败方案
4. 是否避免和前两篇过度重复 `SpyAPI` / `ArthasClassloader` 内部细节
5. 是否明确区分了外部 attach 与 starter 失败影响面的不同
6. 是否把最终场景对照表收回到统一单例与统一生命周期主线
7. 是否完成 `file:line` 重核与边界声明
