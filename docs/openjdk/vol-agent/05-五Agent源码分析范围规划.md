# 五个 Agent 项目源码分析范围规划

> 目标：按照 `issue/` 目录既有的“先规划范围、再逐域深读”方式，分析 Pi / Reasonix / Hermes / OpenCode / dsh。
> 升级点：不再只列类名和模块，而是以“机制闭环 + 真实困惑 + 工程问题 + 可迁移思想”为最小分析单元。
> 产出位置：`vol-agent/pi/`、`vol-agent/reasonix/`、`vol-agent/hermes/`、`vol-agent/opencode/`、`vol-agent/dsh/`

---

## 一、统一分析原则

### 1. 先规划范围，再读正文

每个项目必须先产出一份：

- 项目根问题
- 主线机制列表
- 横切专题列表
- 认知风险列表
- 分析边界
- 读者前置认知桥
- 章节/知识域顺序
- 排除清单与排除理由

不能直接从文件开始写长文。

### 2. 最小分析单元不是“类”，而是“机制闭环”

一个知识域至少回答：

1. 读者真正困惑是什么？
2. 入口在哪里？
3. 出口在哪里？
4. 中间状态如何变化？
5. 谁持有资源？
6. 谁处理异常？
7. 跨线程/跨进程边界是什么？
8. 测试如何证明设计不变量？
9. 与其他知识域如何交叉？
10. 能否独立写成完整正文？

只有列出类名而没有闭环，不能算已覆盖。

### 3. 目录只是扫描起点，不是知识边界

必须特别检查跨目录机制：
- loop + session + state
- context + compression + resume
- tool + permission + sandbox
- evaluator + regression + report
- storage + event + replay
- skill + memory + learning

### 4. 证据优先

每个关键结论必须绑定：
- 主源码 `file:line`
- 辅助测试 / benchmark 证据
- 必要时补 git 演进证据

第三方依赖、平台差异、demo、测试只能按证据层级进入正文，不能无理由抢主线。

---

## 二、统一知识域模板

每个项目的范围规划和后续正文都按以下结构：

```text
知识域编号 / 名称
级别：核心 / 重要 / 外围
类型：主线 / 横切 / 风险 / 演进 / 应用

核心问题：
读者痛点：
Agent 失真风险：
前置知识：
入口：
主调用链：
状态 / 生命周期：
线程 / 并发边界：
错误 / 恢复路径：
测试证据：
关键源码位置：
跨域关系：
可迁移思想：
排除内容与理由：
```

---

## 三、统一质量门

### 范围规划质量门

- 不能只有类名清单。
- 每个核心域必须有机制闭环问题。
- 必须区分主线机制、横切机制、外围应用。
- 必须显式说明 UI、demo、test、benchmark、第三方依赖、平台分支和兼容层的边界。
- 必须记录排除理由和待复核边界。
- 必须统计机制覆盖，而不是只统计文件覆盖。

### 正文质量门

每个知识域正文至少满足：

- 项目根问题关联
- 至少两个主源码证据
- 至少一个真实运行/状态/生命周期路径
- 至少一个失败或误用边界
- 至少一个认知错觉拆解
- 至少一个可迁移思想
- 读者能用自己的话复述

---

# 四、Pi 分析范围

## P-1 Agent Loop 与 Turn 生命周期（核心主线）

重点：
- `agent-loop`
- turn / step 边界
- 工具执行模式
- follow-up / steer / abort
- 回合结束和下一回合准备

核心问题：
- 为什么要双层循环？
- 工具调用如何回到模型上下文？
- 中断发生在哪些边界？

## P-2 AgentSessionRuntime 与会话状态

重点：
- session 创建
- cwd / runtime 绑定
- reload / resume
- 运行时诊断

## P-3 Context 与 Compaction

重点：
- 消息历史如何管理
- 压缩触发与提交
- 压缩后如何保留指令和工具协议
- 缓存稳定性与上下文前缀

## P-4 工具系统与执行模式

重点：
- tool schema
- before/after hook
- read/write/run 边界
- concurrent / sequential / segmented
- 取消和失败结算

## P-5 Skills 与自进化

重点：
- skill 生命周期
- skill 注入上下文的位置
- 后台审查 / fork / 合并
- 如何防止错误技能污染后续会话

## P-6 Queue / Steer / Follow-up

重点：
- next-turn / next-step
- steer 与 follow-up 的语义区别
- busy 状态下输入如何处理

## P-7 并发、租约和代际

重点：
- session / workspace / data-level fencing
- stale result 防护
- 取消与迟到结果

## P-8 Pi 的产品形态

重点：
- interactive / print / RPC
- 同一内核如何支持多种交互形态
- 传输层与执行内核如何分离

### Pi 暂不作为主线
- UI 外壳细节
- 平台特定适配
- 示例项目
- 与核心 loop 无关的外围工具

---

# 五、Reasonix 分析范围

## R-1 Controller 与传输无关控制面（核心主线）

重点：
- Controller 命令面
- typed event stream
- 会话状态和前端驱动
- Send / Cancel / Approve / Compact / NewSession

核心问题：
- 为什么控制面必须独立于传输？
- 命令和事件如何保持一致？

## R-2 Durable Execution 与 Run Loop

重点：
- run loop
- streamed turn
- 异常恢复
- 中断前状态
- 失败是否持久化

## R-3 Inbox / Event Sourcing / Replay

重点：
- 状态如何落盘
- 收件箱 / 双游标
- 重放如何恢复状态
- 损坏如何拒绝

## R-4 Plan / Task Contract

重点：
- 任务契约
- plan mode
- approval 扩张
- planner / executor 分离

## R-5 工具门控链

重点：
- parse
- intercept
- policy
- contextual gate
- mutation barrier
- permission
- prepare / finish

## R-6 Workspace Lease 与 Fencing

重点：
- 工作区写时获取
- lease / token
- stale worker
- 迟到结果

## R-7 Context / Compaction / Handover

重点：
- 7 段摘要
- 压缩后指令保留
- resume 语义
- 交接是否无损

## R-8 Reasonix 的失败模式

重点：
- 失败分类
- streamed response 畸形恢复
- 工具变异屏障
- 持久化失败

### Reasonix 暂不作为主线
- UI / transport 外壳
- 与 Controller 无关的外围适配
- 平台特定实现

---

# 六、Hermes 分析范围

## H-1 Agent 主循环与 Conversation Loop

重点：
- synchronous loop
- turn / step
- 预算 consume / refund / grace call
- 中断与取消占位

## H-2 TurnRunner 与 Turn Finalizer

重点：
- 工具进度
- 回合收尾契约
- 持久化、记忆、压缩、后台任务取消
- god-file 如何拆职责

## H-3 工具批处理与协作

重点：
- concurrent
- sequential
- segmented
- 工具间依赖
- 批内失败屏障

## H-4 GatewayRunner 与会话并发治理

重点：
- session slot
- 并发 session
- fallback
- drain / restart recovery

## H-5 Steer / Redirect / ESTOP

重点：
- 运行中纠偏
- 重定向
- 可恢复暂停
- 用户控制和执行状态边界

## H-6 Memory / Skills / Background Review

重点：
- 回合后记忆审查
- skill 生成
- 后台 fork
- 观察与状态修改的边界

## H-7 预算、超时与失败恢复

重点：
- token / turn 预算
- grace call
- timeout
- auth / transport / context failure 分类

### Hermes 暂不作为主线
- 平台消息网关的具体 UI 渲染
- 与 agent loop 无关的渠道适配

---

# 七、OpenCode 分析范围

## O-1 SessionRunner / SessionExecution（第一入口）

重点：
- session runner
- run coordinator
- shouldRun / continuation
- interrupt / wake / drain

## O-2 双层循环与 TurnTransition

重点：
- provider turn
- tool execution
- compaction 作为控制流转移
- unsettled tools
- max steps

## O-3 Context Engineering

重点：
- system / user / tool 消息边界
- compaction
- prefix stability
- cache-aware 注入
- ghost / summary / continuation

## O-4 Tool Registry 与协议结算

重点：
- tool schema
- tool call / result 配对
- stale rejection
- 输出托管
- cancel / failure settlement

## O-5 Permission / Approval / Sandbox

重点：
- approval manager
- deny 优先
- sandbox policy
- grant
- 写逃逸

## O-6 Storage / Inbox / Event Stream

重点：
- 会话持久化
- 状态恢复
- 事件流
- 运行时与持久状态一致性

## O-7 Evaluator / Debugging / Observability

重点：
- completion 判定
- trace
- structured event
- debugging
- content-free telemetry

## O-8 Extension / MCP / 外部协议

重点：
- provider / consumer / service definition
- MCP bridge
- 扩展钩子
- 协议边界

### OpenCode 暂不作为主线
- UI 视觉层
- 具体平台消息渲染
- 与 session/runtime 无关的外围集成

---

# 八、dsh 分析范围

## D-1 ReactLoopAgent 状态机

重点：
- idle / running / maintenance
- turn / step / abort / wakeRequested
- 状态迁移不变量

## D-2 InboxTarget 双队列

重点：
- next-turn
- next-step
- steer 与新任务边界
- idle wake

## D-3 事件瀑布与融合分派

重点：
- emit / serial / waterfall
- agent/pre-step/request/tools 事件
- waterfall 短路

## D-4 Todo / Plan / 守卫

重点：
- todo_write
- plan mode
- repeat-tool-reminder
- timeout policy

## D-5 极简设计原则

重点：
- 哪些状态被刻意合并
- 哪些概念没有做成独立状态机
- 简单性如何降低运行时错误

## D-6 工具超时与结构化失败

重点：
- TOOL_TIMEOUT
- 模型可见失败
- retry / stop / continue

### dsh 暂不作为主线
- 纯 CLI 表现层
- 非控制面外围适配

---

## 九、五项目横向对比维度

每完成一个项目，必须补充横向对账：

| 对比维度 | Pi | Reasonix | Hermes | OpenCode | dsh |
|----------|----|----------|--------|----------|-----|
| Agent Loop | | | | | |
| Session 状态 | | | | | |
| Context / Compaction | | | | | |
| Tool Protocol | | | | | |
| Permission / Sandbox | | | | | |
| Memory / Skills | | | | | |
| Eval / Observability | | | | | |
| Durable Recovery | | | | | |
| Concurrency / Lease | | | | | |
| 最小化设计 | | | | | |

横向对比必须回答：
1. 每个项目解决了什么工程问题？
2. 它选择了什么 trade-off？
3. 哪些机制是多项目共同出现的？
4. 哪些机制是项目独有的？
5. 哪些思想值得迁移？
6. 哪些做法不应照搬？

---

## 十、第一阶段执行顺序

1. 先读 `03-Agent源码前置认知桥.md`
2. 按 `04-统一源码分析模板.md` 建立 OpenCode 范围规划
3. 先分析 OpenCode 的 SessionRunner / SessionExecution
4. 再分析 Tool Protocol 与 Context Engineering
5. 再分析 Permission / Sandbox / Storage / Evaluator
6. 最后形成 OpenCode 横向总结与读者学习路径
7. 复用同一模板进入 Reasonix / Pi / Hermes / dsh

---

## 十一、完成标准

一个项目只有同时满足以下条件，才算完成第一轮源码分析：

- 有项目根问题
- 有主线机制
- 有横切专题
- 有认知风险
- 有分析边界
- 有前置认知桥
- 每个核心知识域有机制闭环
- 有至少两个主源码证据
- 有测试/失败路径证据
- 有工程权衡
- 有可迁移思想
- 有书级学习顺序
- 有读者最终能力判据

不允许以“文件扫过了”“类名列过了”“目录看起来完整”作为完成标准。
