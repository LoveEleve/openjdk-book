# 04-jvm-memory-practice 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Dashboard / memory / jvm / heapdump / logger / vmoption 命令清单”重构成一篇围绕“线上 JVM 内存或 GC 异常时，为什么必须按风险和证据逐级升级观测，而不是第一反应就 heapdump 或修改配置”的生产排查文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- 先 dashboard
- 再 memory
- 再 jvm
- 再 heapdump
- 再 logger / vmoption

这种“命令顺序口诀”式实战文章。

更好的统一问题是：

**线上 OOM 前兆、GC 频繁、接口变慢同时出现时，为什么不能一上来就 heapdump、开 DEBUG 或改 vmoption，而要先用低风险趋势观察确认问题类型，再逐步升级到内存池、JVM 全景、运行配置和最终堆转储？**

这样本篇就不再是“生产命令列表”，而会被收束成一条有风险分级的证据链：

- Dashboard 先看持续趋势
- `memory` 拆内存结构
- `jvm` 补齐管理面背景
- logger / sysprop / sysenv / vmoption 核对运行配置
- heapdump 作为高成本、强侵入的最后升级

## 2. 读者困惑

- GC 频繁和 OOM 前兆出现时，第一条命令为什么不是 `heapdump`？
- Dashboard、`memory`、`jvm` 到底分别回答什么问题？
- `used`、`committed`、`max` 之间为什么不能只看一个？
- 为什么 DEBUG 日志和 vmoption 修改也属于有风险的诊断动作？
- `--live` heapdump 为什么仍然可能暂停和产生 IO/磁盘压力？

## 3. 一句话顿悟

**线上内存排查不是“命令越重越快得到答案”，而是按风险和证据逐级升级：先用 Dashboard 观察趋势，再用 `memory` 拆 pool/non-heap/BufferPool，再用 `jvm` 补齐 GC、类加载、线程和文件句柄背景，必要时核对 logger/sysprop/sysenv/vmoption，最后在确认问题类型并选好窗口后才执行 heapdump。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前命令实现与前面 AR-3 / AR-4 机制篇讨论
- 聚焦线上 JVM / 内存 / GC 异常的排查决策路径
- 不重复展开 Dashboard、`jvm`、`memory` 的完整源码机制；这里只引用它们的消费边界
- 不把 heapdump 工具内部 hprof 格式实现扩写成本篇主线
- “低风险/高风险”是生产排查策略判断，不等于每个环境的绝对开销保证

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经有 OOM/GC 频繁的真实生产场景
- 命令路径大体合理：Dashboard → memory → jvm → heapdump → 配置核对
- 已经提醒了 heapdump、DEBUG、vmoption 的风险
- 能把 AR-3 / AR-4 / AR-5 / 类字节码实践连接起来

### 5.2 必须修复的问题

- 当前骨架仍偏“命令顺序说明”，为什么必须这样排序的冲突不够强
- heapdump 为什么不能第一反应执行，还可以更充分推演暂停、IO、磁盘和错误类型误判风险
- Dashboard / `memory` / `jvm` 的证据升级关系还可以更明确
- logger / vmoption 被当成命令补充，应该改成“运行时配置核对/临时改变观测条件”的高风险分支
- 结尾决策树需要从口诀升级成风险递进的诊断闭环

## 6. 重写策略

本篇不按命令列表推进，而按真实故障决策链组织：

1. 先建立事故：OOM 前兆和 GC 频繁，但服务还活着，最危险的是误操作
2. 先排除几个错误直觉：
   - 一上来 heapdump
   - 只看 Dashboard heap 总量
   - 直接开 DEBUG / 改 vmoption
   - 把 `--live` 当成无暂停保证
3. 再给总图：趋势观察 → 内存结构拆解 → JVM 背景盘点 → 配置核对 → 低峰期堆转储
4. 然后分层拆：
   - Dashboard 如何确认趋势与异常类型
   - `memory` 如何拆 used/committed/max 与 pool/buffer
   - `jvm` 如何补全管理背景
   - logger/sysprop/sysenv/vmoption 如何核对或改变观测条件
   - heapdump 为什么是最后升级
5. 最后收束成“先低风险证据，后高成本动作”的生产排查哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——OOM 前兆出现时，为什么第一反应不该是 heapdump

目标：建立风险与证据冲突。

要回答：

- 服务还活着但 GC 频繁、响应变慢、内存持续上涨的现场
- heapdump 不是不能用，而是不该在问题类型未确认时第一时间用
- 本篇建立的是一条风险递进路径

预估字数：900-1100

### 第二节：第一层——先用 Dashboard 看趋势和全貌

目标：把 Dashboard 写成低风险趋势入口。

要回答：

- 为什么先执行 `dashboard`
- `-i`、`-n`、Ctrl-C/q 的实践意义
- 哪些迹象会触发下一步 `memory` / `jvm` / `thread`
- 为什么 Dashboard 用完要退出

证据锚点：

- `DashboardCommand.java:76-109`
- DashboardModel / DashboardView 桥接

预估字数：1400-1700

### 第三节：第二层——`memory` 如何把“内存涨了”拆成可行动的问题

目标：把内存池细节写成证据升级。

要回答：

- HEAP / NON-HEAP / BUFFER-POOL 三组视图
- used / committed / max 的区别
- 为什么 pool 级细节比 heap 总量更接近根因
- 什么情况下怀疑 Metaspace、CodeCache、DirectBuffer 等

证据锚点：

- `MemoryCommand.java:30,42-103`

预估字数：1600-2000

### 第四节：第三层——`jvm` 如何补齐 GC、类加载、线程和配置背景

目标：把 `jvm` 写成完整背景盘点。

要回答：

- 九个数据块分别解决什么背景问题
- `DEADLOCK-COUNT` 与 `thread -b` 的边界
- 为什么一次性 `jvm` 不等于 Dashboard 实时刷新
- 哪些异常需要把视野从内存扩展到类加载、文件句柄、编译和线程

证据锚点：

- `JvmCommand.java:24,39-200`

预估字数：1800-2200

### 第五节：第四层——logger / sysprop / sysenv / vmoption 是配置核对与高风险改变分支

目标：把配置相关命令写成“改变观测条件”的谨慎操作。

要回答：

- logger 为什么能在线查看和调整日志上下文
- DEBUG 为什么必须现场采集后立即恢复
- sysprop/sysenv/vmoption 分别核对什么
- vmoption 在线修改为什么必须记录原值、确认参数语义和风险

预估字数：1500-1800

### 第六节：第五层——heapdump 为什么必须是确认问题后的最后升级

目标：把 heapdump 写成高成本动作。

要回答：

- heapdump 会遍历堆并写 hprof
- 可能造成暂停、IO 和磁盘压力
- `--live` 只是对象筛选，不是无暂停保证
- 为什么要先确认 heap/non-heap/BufferPool/GC 类型，再选低峰期执行
- 如何把 hprof 交给离线分析

证据锚点：

- `heapdump` 命令入口（桥接回指）
- 生产实践边界

预估字数：1700-2100

### 第七节：第六层——根据证据分流，而不是机械执行命令清单

目标：建立不同症状到工具的决策树。

要回答：

- CPU 高但内存正常：回 thread/profiler
- BLOCKED/WAITING 多：回 thread -b
- heap used 接近 max 且 GC 后不降：考虑 heapdump
- non-heap/BufferPool 异常：优先 memory 细拆
- DEADLOCK-COUNT 非零：回线程栈与锁图
- 配置不明：sysprop/sysenv/vmoption/logger 核对

预估字数：1200-1500

### 第八节：收网——先低风险证据，后高成本动作

目标：把全文收成一句话并桥接后续实践。

必须点名：

- Dashboard 趋势
- memory 结构
- jvm 背景
- 配置核对
- heapdump 最后升级

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. OOM 前兆一出现就立即 heapdump
2. 只看 Dashboard heap 总量，不拆 pool/non-heap/BufferPool
3. 把 `--live` 当成轻量无暂停操作
4. 直接开 DEBUG 或改 vmoption，不记录原值和恢复动作
5. 把 CPU、锁、内存、死锁异常混成一个诊断问题

## 9. 本篇必须明确澄清的误解

1. heapdump 是高成本升级动作，不是第一反应
2. `--live` 是对象筛选，不是无暂停保证
3. used/committed/max 含义不同，不能只看一个总量
4. Dashboard 是趋势入口，`memory` 是专项细节，`jvm` 是完整背景
5. logger/vmoption 可能改变运行条件，必须有恢复纪律
6. 诊断路径应由证据分流，而不是机械执行所有命令

## 10. 证据清单（正文托底）

- `DashboardCommand.java:76-109`
- `MemoryCommand.java:30,42-103`
- `JvmCommand.java:24,39-200`
- `LoggerCommand` / `vmoption` / `sysprop` / `sysenv` 命令入口（桥接回指）
- `heapdump` 命令入口与实践边界

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么要按风险和证据逐级升级观测”
3. 是否至少展开了 4 个失败方案
4. 是否把 Dashboard、memory、jvm、配置核对、heapdump 统一到同一条生产诊断链上
5. 是否明确保留暂停、IO、磁盘和在线修改风险
6. 是否完成 `file:line` 重核与边界声明
