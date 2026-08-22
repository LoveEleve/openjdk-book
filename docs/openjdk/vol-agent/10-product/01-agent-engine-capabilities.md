# Agent 引擎能力全景 — 5 项目 414 域合并(去重后)

> 输入:5 项目域发现全量(Pi 127 / Reasonix 102 / Hermes 81 / OpenCode 53+9 共享包 / dsh 51 = 414 域)+ 闭环笔记 137 份(设计点:Pi 87+/Reasonix 107+/Hermes 262/OpenCode 278/dsh 126)
> 生成:2026-08-15
> 用途:这是**通用 Agent 引擎**的功能需求全集(第一层)——不是 JD 映射,JD 映射是面试附带的最后一步
> 方法:D18 程序化对账——每个项目的每个域逐项归入,末尾对账表核对(不能漏)
> 下一层:在此引擎之上叠加"源码学习领域层"(vol-agent/10-product/04-*,待写)
> **D10 Linux 唯一基准**:产品实现只做 Linux(平台分支/Windows 适配/跨平台特性全部排除;Linux 系统编程面保留:进程/文件锁/信号)。分析素材(476 条)≠ 产品代码——产品按 02 里程碑实现核心机制,其余为面试分析资产

---

## 能力域框架(31 个一级域,6 组)

```
A. 执行核心              B. 能力系统             C. 安全与边界
   01 执行引擎/Agent Loop   06 LLM 适配/Provider   12 权限与审批
   02 会话生命周期与状态机   07 工具系统            13 沙箱与执行环境
   03 事件系统与事件溯源     08 技能系统            14 认证与凭证
   04 上下文管理            09 记忆与知识           15 供应链安全/自保护
   05 上下文压缩            10 规划与任务契约
                            11 验收与完成判定
D. 可靠性与正确性        E. 可观测与评测         F. 扩展与集成
   16 检查点与回滚          21 可观测与遥测         24 插件系统与扩展
   17 错误处理与恢复        22 评测体系            25 多 Agent/子代理
   18 并发与协调            23 审计与证据          26 外部协议(MCP/ACP/LSP/SDK)
   19 存储与持久化                                27 消息网关与平台适配
   20 检索与搜索
G. 形态与工程
   28 交互形态与用户交互  29 配置/启动/Profile  30 后台任务/调度/生命周期  31 基础工具与共享包
```
A. 执行核心              B. 能力系统             C. 安全与边界
   01 执行引擎/Agent Loop   07 LLM 适配/Provider   13 权限与审批
   02 会话生命周期与状态机   08 工具系统            14 沙箱与执行环境
   03 事件系统与事件溯源     09 技能系统            15 认证与凭证
   04 上下文管理            10 记忆与知识           16 供应链安全/自保护
   05 上下文压缩            11 规划与任务契约
   06 (并入 05 压缩域)      12 验收与完成判定
D. 可靠性与正确性        E. 可观测与评测         F. 扩展与集成
   17 检查点与回滚          22 可观测与遥测         25 插件系统与扩展
   18 错误处理与恢复        23 评测体系            26 多 Agent/子代理
   19 并发与协调            24 审计与证据          27 外部协议(MCP/ACP/LSP/SDK)
   20 存储与持久化                                28 消息网关与平台适配
   21 检索与搜索
G. 形态与工程
   29 交互形态与用户交互  30 配置/启动/Profile  31 后台任务/调度/生命周期  32 基础工具与共享包
```
A. 执行核心        B. 能力系统        C. 安全与边界
   03 执行引擎/Agent Loop  06 工具系统    11 权限与审批
   04 会话生命周期与状态机  07 技能系统    12 沙箱与执行环境
   05 事件系统与事件溯源    08 记忆与知识   13 认证与凭证
   06 上下文管理           09 规划与任务契约 14 供应链安全/自保护
   07 上下文压缩           10 验收与完成判定
D. 可靠性与正确性     E. 可观测与评测      F. 扩展与集成
   17 检查点与回滚      20 可观测与遥测     23 插件系统与扩展
   18 错误处理与恢复     21 评测体系        24 多 Agent/子代理
   19 并发与协调        22 审计与证据      25 外部协议(MCP/ACP/LSP/SDK)
   20 存储与持久化                         26 消息网关与平台适配
   21 检索与搜索
G. 形态与工程
   29 交互形态与用户交互  28 配置/启动/Profile  29 后台任务/调度/生命周期  30 基础工具与共享包
```

---

# A. 执行核心

## 01 执行引擎 / Agent Loop

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | SessionRunner 执行引擎 | core/src/session/runner/ | run 双层循环(shouldRun/needsContinuation);单 provider turn 7 步;压缩=异常转移(TurnTransitionError);unsettled tools 兜底矩阵;崩溃前失败化 running 工具;max-steps 禁工具 |
| OpenCode | SessionExecution + RunCoordinator | core/src/session/execution.ts + run-coordinator.ts | process-global Session-ID 索引;wake 合并(sliding-capacity-1);interrupt 幂等;drain 无持久身份;Location 路由;noopLayer 只记录不执行 |
| OpenCode | V1 Legacy SessionPrompt | opencode/src/session/prompt.ts(1631) | V1 while(true) 单体循环;处理器三态(compact/stop/continue);结构化输出=强制工具;V2 shadow bridge(产品从零开始,直接 V2,不抄 V1) |
| Pi | Agent Loop | agent/src/agent-loop.ts | 循环主体 + agentLoopContinue 续跑;**双层循环**(内层工具/外层 follow-up);截断即全失败;prepareNextTurn 钩子;工具执行模式决策 |
| Pi | Agent 门面契约 | agent/src/agent.ts(592)+types.ts(443) | StreamFn/ToolExecutionMode/QueueMode/BeforeToolCall/AfterToolCall/ShouldStopAfterTurn/PrepareNextTurn 钩子;默认 convertToLlm |
| Pi | InteractiveMode | modes/interactive/interactive-mode.ts(6,436) | 交互形态 + 会话业务代理;流式/工具跟踪/thinking 可见性;agent 订阅解耦 |
| Pi | Print Mode / RPC Mode | modes/print-mode.ts + modes/rpc/ | 非交互输出模式;RPC 交互协议——同一内核多形态(interactive/print/rpc 共享 AgentSessionRuntime) |
| Pi | 会话运行时创建 | core/agent-session-runtime.ts(441) | session 创建 + cwd 绑定服务 + 运行时诊断(非致命问题收集) |
| Pi | 代理流函数 | agent/src/proxy.ts | 经 server 路由 LLM 调用(客户端模式) |
| Pi | Output Guard | core/output-guard.ts | 输出合法性检查;取走 stdout + ENOBUFS/EAGAIN 重试 + flushRawStdout |
| Reasonix | Controller 单控制器 | internal/control/(150+ 文件,controller.go 6,276) | **传输无关会话驱动内核**:命令(Send/Cancel/Approve/SetPlanMode/Compact/NewSession)+ 单一 typed 事件流;每个前端驱动同一 Controller——执行引擎内核定论 |
| Reasonix | 运行循环 RunLoop | internal/agent/run_loop.go(754) | streamedTurn:缺失推理恢复显式(首个畸形完成永不先提交;失败回退完整首响应不重跑) |
| Reasonix | 回合编排器 TurnOrchestrator | internal/control/turn_orchestrator.go(654) | 前台回合执行(goalContinuationSnapshot 完整字段) |
| Reasonix | 变异屏障 | agent/execute_batch.go | 工具批中第一个持久写失败 → 后续变异全跳,验证不执行 |
| Reasonix | execute_one 门控链 | 契约深化 v43-v50 | 单工具执行 9 阶段:parse→interceptToolBefore(扩展先于策略)→resolveToolPolicy→contextualToolGate→mutationDependencyBarrier→planModeAndProxy→deliveryPolicyGates→recoveryAndPermission→prepare/finish——执行正确性门控链完整形态 |
| Hermes | Agent 主循环 | run_agent.py + agent/conversation_loop.py | 同步 while 主循环;迭代预算 consume/refund + grace call;中断处理每工具前检查 + 取消占位;工具批三模式(concurrent/sequential/segmented);回合收尾契约(持久化→记忆→后台取消→压缩重置);steer/redirect 运行中纠偏;ESTOP 可恢复暂停 |
| Hermes | TurnRunner 协作器 | gateway/run.py:3834 | 工具进度回调协作器;live status 行/log 队列/首次长工具提示;TurnContext 共享字段 |
| Hermes | 回合终结器 | agent/turn_finalizer.py + turn_retry_state.py | 预算耗尽总结/轨迹保存/会话持久化/响应转换/记忆审查触发,god-file 分解 seam |
| Hermes | 网关并发会话治理 | gateway/run.py GatewayRunner | 并发 session 槽位(_claim_active_session_slot);fallback 链应用;重启恢复 drain 超时 |
| dsh | Agent + AgentLoop | core/agent + core/agent-loop | turn(0+ steps)/step(1 request + tools);事件瀑布(agent/pre-step、agent/request、llm/stream、tools/*);turn-stopping 串行;ReactLoopAgent 状态机(Phase = idle/maintenance/running{turn,step,abort,wakeRequested}) |
| dsh | InboxTarget 双队列 | core/agent/types.ts | next-turn / next-step 双队列;wake 在 idle 时开新 turn 边界;steer = next-step,新任务 = next-turn |
| dsh | 融合分派三模式 | core/agent/dispatch.ts(28-148) | emit/serial/waterfall;subject 与 scope 不分歧;waterfall 短路即设计 |
| dsh | Todo | todo/ | todo_write 工具(任务跟踪) |
| dsh | Plan | plan/ | plan mode = 日志状态(非独立状态机) |
| dsh | 收敛检测 | guard/repeat-tool-reminder | 连续重复工具调用(3/5/8 阈值)advisory 提醒——循环卡死检测 |
| dsh | 超时结构化 | guard/timeout-policy | 工具超时 = TOOL_TIMEOUT 结构化结果(非 abort),模型看到结构化失败可重试 |

**跨项目定论**:执行引擎 = 传输无关内核 + 命令/事件面 + 守卫/预算/评估器(OpenCode Runner / Pi AgentSessionRuntime / Reasonix Controller / Hermes TurnRunner 四项目同构)。**循环状态在 DB(收件箱,可重放)**——产品主干取 OpenCode DB 收件箱双层 + Hermes 预算/中断/工具批 + dsh 收敛检测。

## 02 会话生命周期与状态机

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | SessionV2 Facade | core/src/session.ts(486) | 全部 V2 操作唯一入口:create/list/messages/context/events/history/prompt/revert/switchAgent/switchModel;18 操作 |
| OpenCode | 状态机不变量 | system-context + event.ts | reconcile 四态代数 + 事件 seq 连续性校验;State 可重放转换(transform/reload 从 initial 重放) |
| Pi | AgentSession 状态机 | coding-agent/src/core/agent-session.ts(3,344) | 会话级状态机:steering/follow-up/pending/compaction/retry 全生命周期;steer/followUp 双队列;自主续跑 while(_handlePostAgentRun);reload 热重载;abort 异步等待完全停止;溢出恢复失败上限(compact+retry 仅一次) |
| Pi | SessionManager | core/session-manager.ts(1,714) | 会话创建/恢复/管理;分支三操作;延迟落盘(无效会话不写);恢复三态(0 空闲/1 挂起/2 损坏);continueRecent 静态工厂 |
| Pi | Modes 三模式 | coding-agent/src/modes/ | interactive/print/rpc 共享内核(单状态机多 I/O 壳) |
| Pi | Session CWD | core/session-cwd.ts | 会话工作目录管理 |
| Pi | 会话资源清理注册表 | ai/src/session-resources.ts | 会话结束统一清理(错误聚合 AggregateError) |
| Reasonix | Agent 会话与循环 | internal/agent/(200+ 文件) | Session+Run 循环;agent.go(2,857)组件注入面(SetGate/SetExtensions/SetRecoveryGate/SetSandboxEscapeApprover/SetConfigWriteApprover/SetMutationObserver) |
| Reasonix | 会话存储 | internal/sessioncatalog/ + agent/session* | JSONL 会话 + 目录 + lease;目录签名跳过扫描(会话搜索加速) |
| Reasonix | 会话临时目录 | internal/sessiontemp/manager.go(465) | 逻辑会话私有 tmp;/new//clear/resume/branch 轮换代 |
| Reasonix | 中断回合恢复 | provider/provider.go:137-158 | Completed/InterruptedTools + 局部推理 LocalOnly 绝不进恢复 prompt(结构性事实才是恢复输入) |
| Hermes | SessionStore | gateway/session.py(1,444) | routing 代际(generation 全序)/快照+增量双轨持久化/legacy 镜像/AsyncSessionStore 门面 |
| Hermes | 会话停滞通知 | gateway/session_stall.py | 停滞策略门(pending inbound + stale progress)消费共享活动观察契约(observation-only) |
| Hermes | 缩放至零 + 唤醒 | gateway/scale_to_zero.py + wake.py | 空闲判定三条件 + 自挂起(own the suspend call)+ 唤醒双策略(push 注入 synthetic 事件 / stateless self-POST) |
| dsh | Agent 生命周期 | core/agent 生命周期 | 加载时身份冲突预校验;create-resume 工厂 + abort 竞速;FactoryOwnership 有序 teardown |
| dsh | Session 日志生命周期 | core/session | session/created(sync veto 回滚)/session/disposed/event/flush 四类;SessionEventMap 声明合并 |

## 03 事件系统与事件溯源

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | EventV2 事件溯源 | core/src/event.ts(638)+schema/session-event.ts(521) | 事件=版本化契约;投影器+commit+落库同事务;重放四级校验(seq 连续/分叉检测 deepStrictEqual/ID 唯一/失败不提交);owner 三级栅栏;durable/live-only 边界(28+4);Started→Delta→Ended 事件族;44 契约测试 |
| OpenCode | 事件发布管线 | core/session/runner/publish-llm-event.ts | LLMEvent → SessionEvent 12 映射;工具 5 状态机(inputEnded/called/settled)确定性终态 |
| OpenCode | EventV2Bridge | opencode/src/event-v2-bridge.ts | V1 bus 兼容(产品从零开始不需要,保留思想:双通道) |
| OpenCode | GlobalBus | opencode/src/bus/global.ts | EventEmitter 包装;无 id 事件自动补 id |
| Pi | 事件溯源 Records/Lanes | storage/records.ts + lanes.ts | (lane, run_id, op_kind, timestamp, payload) + 恢复语义三态 |
| Pi | 事件归约器 RecordLog | agent/src/harness/reducer.ts(667) | **12 种损坏原因**(multiple_open_operations/non_consecutive_attempt/tool_call_mismatch/duplicate_tool_invocation…);restore 拒绝损坏态而非修复;**重放 ≠ 真相,重放+验证才是**;归约器契约 20+ 不变量(abort 杀 steer 队列保写入/孤儿 result 忽略/溢出守卫仅新对话输入后重置) |
| Pi | 事件总线 | core/event-bus.ts + harness/events.ts | emit/on/clear + **handler 错误隔离**(async safeHandler) |
| Pi | 会话状态变更协议 | harness/session/state.ts | SessionMutation 4 种(entry/record/lane/fact)+ JSONL 编解码 |
| Pi | seq 全序 | sqlite/storage/session-sequences.ts(29) | createSequence/getNext/advance 单调 seq |
| Pi | 类型白名单解码 | harness/session/jsonl/codec.ts | ENTRY_TYPES 7/RECORD_TYPES 9/OPERATION_KINDS 3,未知类型拒绝 |
| Pi | 事件流水线持久化 | agent-session.ts:610-670 | message_end 自动落库 |
| Reasonix | 事件 Event | internal/event/ + eventwire/ | 事件分发;externalizable 事件卸载;event Kind 全集 30+(渲染语义文档化);KindCount 哨兵(新事件自动被完备性测试覆盖);aborted 压缩也发 Done(占位符不悬挂);用户取消不是错误 |
| dsh | Session 日志(事件源) | core/session | 追加写 SessionEvent 日志;模型可见 ⟺ 已记录(运行时不变量);deriveMessages() 投影;raw assistant/chunk 保留回放保真 |
| dsh | 事件三类 | session/agent/capability | Session events(durable)/Agent events(live)/Capability events(fs/*、tools/*);waterfall(必须 next)vs serial |
| dsh | 事件版本 | core/session/types.ts | SessionEventMap 声明合并(插件扩展事件,构建期强制);writer 决定 bump(结构级 + ignorable 词汇级) |
| dsh | Surface 双视图 | core/session/surface.ts | 3 事件 → LLM 消息 + append/replace 阴影;**人类转写不被替换抹掉**(模型视图 vs 人类转写分离) |
| Hermes | 流式事件分发 | gateway/stream_dispatch.py + stream_events.py | agent 发 typed 事件(Commentary/GatewayNotice/MessageChunk),adapter 决定交付;adapter 可 eat 事件 |
| OpenCode | Sync(legacy) | opencode/src/sync/ | 事件溯源同步设计文档(单写者+投影器);已迁移到 EventV2(产品不抄 legacy) |

**跨项目定论**:事件溯源三支柱(OpenCode)= 收件箱双游标 + 单调 seq 全序唯一索引 + 投影器同事务;损坏检测(Pi)= 重放+验证;不变量(dsh)= 模型可见⟺已记录。产品④知识库的真相源 = 这些全部合并。

## 04 上下文管理(Context Engineering)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Context Epoch | core/src/session/context-epoch.ts(174) | **每 epoch 一个不可变 Baseline**(session_context_epoch 表);变化 = 时间序系统消息(不重写基线);快照模型隐藏;ContextUpdated 事件带 commit 回调原子推进;压缩/搬家 = epoch 终点;切换模型不重建 |
| OpenCode | SystemContext 代数 | core/src/system-context/(320)+instruction-context.ts | 六字段源+类型隐藏;initialize/reconcile/replace 三操作;Unchanged/Updated/ReplacementReady/Blocked 四态;Unavailable=stale-while-revalidate;空渲染拒绝(requireText);指令源聚合(AGENTS.md 全文件一个值);稳定 key 序 |
| OpenCode | 历史过滤规则 | core/src/session/history.ts | compaction 后 + baseline 后更新——重放不重算 |
| OpenCode | 消息翻译 | core/src/session/message-translation | 七类型翻译表;模型一致性控制元数据(reasoning 降级);compaction checkpoint 模板 |
| Pi | Harness 上下文管理 | agent/src/harness/agent-harness.ts + session/ | 上下文组装/注入/会话状态;上下文构建管线(entries→messages 转换、compaction 后只保留摘要、entryProjectors 投影);状态推导管线(deriveSessionContextState) |
| Pi | ResourceLoader | core/resource-loader.ts(1,096) | 资源加载/上下文注入;上下文分层加载(全局→祖先→项目)+ 遮蔽检测(最内层优先) |
| Pi | 参数约束 | ai/src/api/simple-options.ts | maxTokens 按上下文裁剪(clampMaxTokensToContext) |
| Pi | 缓存统计 CacheStats | core/cache-stats.ts + timings.ts | 缓存命中/计时统计(补充文档 v 系列深挖) |
| Pi | retainedTail 内嵌 | harness/context.ts:75-80 | 摘要自带最近结论尾巴 |
| Pi | deferred 消息过滤 | harness/context.ts:72 | 中间推理不污染上下文 |
| Reasonix | ContextManager | internal/agent/context_manager.go | **缓存优先(低于阈值零操作)**;单次摘要事务;一代一票(失败阻塞本代);stale 保护 + stuck 标记;CAS 安装检查点(5 条件+持久化回滚);摘要接受判定(严格小于源+低于触发线);压缩作为工具(模型主动调+anchor 校验) |
| Reasonix | 固定前缀 | compact.go:292-301 | system prompt + 首用户 turn 字节稳定(缓存命中区) |
| Reasonix | 多层阈值 | compact.go:91-153 | 触发 0.85/接受 50%/硬上限/经济性——量化预算 |
| Reasonix | 7 标题摘要模板 | compact.go:60-85 | Standing facts/Goal/Decisions/Files/Commands/Errors/Pending |
| Hermes | 提示词构建/缓存 | agent/prompt_builder.py + prompt_caching.py | 缓存前缀稳定规划;prompt_cache_boundary(缓存边界);**宪法#1:per-conversation prompt caching is sacred(缓存神圣)**——一切注入设计围绕缓存前缀稳定:技能进 user 消息、记忆冻结快照 |
| Hermes | coding_context 姿态单一判定 | 域发现 v27 | RuntimeMode 冻结 + ContextProfile 注册表——"是否在编码"永不重推导,快照一次性进稳定 system-prompt 层 |
| Hermes | agent_context 写保护 | agent/memory_provider.py | "谁在写"第一道闸:cron/subagent 跳过写 |
| dsh | SystemPrompt 组装 | core/system-prompt | prompt-section + tool-schema 组装(插件注册 section) |
| dsh | 指令投影 | context/agent-instructions | 两提交边界后才改 inbox(执行谱系 + 封闭步骤) |

## 05 上下文压缩(Compaction)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Compaction | core/src/session/compaction.ts(247) | 双触发(预估 context-buffer / 溢出 provider 拒绝);7 段摘要模板+合并规则;head/recent 切割(keep 8000);Started=attempt/Ended=生效;溢出压缩只一次绝不循环(二次=终止失败) |
| Pi | 压缩 Compaction(两层) | harness/compaction/ + core/compaction/ | branch-summarization 分支摘要;压缩判定 5 重保护(模型一致性/边界/污染/失败上限);压缩三段式(摘要+尾巴+新增);增量摘要更新(SUMMARIZATION/UPDATE);摘要专用 system prompt(防跑偏);摘要请求缓存隔离;序列化契约(长工具结果截断) |
| Pi | 压缩切点 findCutPoint | 契约深化 v20-v28 | 合法切点+token 反向扫描+边界回退(不切 tool 组=证据链) |
| Pi | Compaction 提示词协议 | harness/messages.ts(168) | COMPACTION_SUMMARY_PREFIX/SUFFIX 约定 |
| Pi | 压缩扩展协议 | 测试契约 | before_compact 可取消;扩展抛错回退默认;多扩展按序 |
| Reasonix | 压缩实现 | internal/agent/compact_* | 折叠经济学(≥400 token 才折);CJK 感知 token 估算(字节/字符取大);保留策略仅最新摘要后生效;技能钉 sentinel(<skill-pin> 压缩保原文) |
| Hermes | 上下文压缩 | agent/context_compressor.py(6,423+)+conversation_compression.py | **压缩决策状态机**(阈值+冷却+防 thrash+恢复试探);ineffective≥2 阻塞+恢复窗口一次试探+重启不得解除;压缩五阶段(裁剪/边界/摘要/知识保留/提交);**技能幽灵重注入**(代码检查标准串缺失追加,LLM 改写不可信);**提交栅栏**(取消 vs 后台提交确定性边界);摘要预算缩放(content×20%,cap=min(context×5%,10K));micro-compaction 成本摊销;native_compaction 服务端窄路由+阈值钳制防双压;hygiene 压缩冷却族 |
| dsh | Compaction | compaction/(compaction + compaction-basic + tool-result-pruner + command-compact) | 压缩能力 + basic provider;**工具结果修剪**(验收证据大小控制);压缩 agent 上下文 |

**跨项目定论**:"压缩不能丢指令"三项目共证(Reasonix 技能钉 / Hermes 幽灵重注入 / Pi compaction 标记)。防死循环:一代一票 + 防 thrash 状态机 + 溢出只一次。

---

# B. 能力系统

## 06 LLM 适配与 Provider 层(LLM 层缝)

> 这是上次起草时遗漏的能力域——Pi/OpenCode/Hermes/dsh 四项目都有独立的 LLM 适配层,是产品的"LLM 层缝"(主循环/独立审查器/摘要各可换模型)。

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Pi | LLM 统一抽象 | ai/src/(provider/api/auth/models 四层) | 多供应商 provider + API 适配层 + OAuth + 模型目录;宽松 content(null→空数组)/工具调用 id 规范化/思考交错/缓存亲缘 e2e(provider 兼容契约) |
| Pi | Provider Composer | core/provider-composer.ts(572) | **多模型编排/组合**:composeModelProvider 组装工厂/登录后可改模型(modifyModels)——对应 Reasonix 双模型设计 |
| Pi | Model 管理 | core/model-registry/model-resolver/model-runtime/model-config | 模型解析/选择/运行时;可用性快照代际检查;凭证操作串行化 |
| Pi | API 适配族 | ai/src/api/(codex-responses 1,647/bedrock 1,188/mistral 931/vertex 596) | 各 provider API 适配;transform-messages(223)非视觉模型图片降级占位符(防重复);api/compat 兼容层/别名 |
| Pi | provider 归因 | core/provider-attribution.ts | 模型→provider 识别(主机匹配) |
| Pi | 模型商店 | core/models-store.ts + model-config.ts | 模型配置/商店访问;远程模型目录(remote-catalog-provider.ts 4h 刷新 mergeModels 动态覆盖基线) |
| Pi | 默认流函数 | agent/src/stream-fn.ts | setDefaultStreamFn 注入(host 提供默认 runtime) |
| Pi | 测试 provider | ai/src/providers/faux.ts(708) | 确定性 mock provider(测试基础设施) |
| OpenCode | LLM 包 | packages/llm/src/(llm.ts 186/route/client.ts 436/executor 385) | **纯协议层**(不依赖 Core);单 llm.stream 入口;Route 四轴;promptCacheKey;isContextOverflowFailure;recorded golden 测试;generateObject 强制工具(验收器结构化输出) |
| OpenCode | Catalog/Model | core/src/catalog.ts(301)+model.ts+models-dev.ts(266)+aisdk.ts(235) | Generation Controls vs Model Request Options 分区;models.dev 适配;AI SDK 兼容;Schema 降级(OpenAI 兼容);Provider 双 API(AISDK/Native) |
| OpenCode | Provider 认证族 | opencode/src/provider/(provider/auth/transform/model-status/error) | 供应商适配;错误转换;模型状态 |
| Hermes | Provider 适配 | agent/transports/ + plugins/model-providers/(40+ 目录) | 40+ provider 实现(产品留 2-3 个,抄机制不抄实现);凭证池恢复/fallback 恢复/消息序列修复 |
| Hermes | 辅助客户端路由 | agent/auxiliary_client.py(10,432) | **任务级 provider 解析**(auxiliary.<task>.{provider,model});resolve_provider_client 中央路由(chat_completions/codex/anthropic/bedrock 适配 shim);中断保护;温度契约(_fixed_temperature_for_model) |
| Hermes | NeMo Relay 适配 | agent/relay_llm.py + relay_runtime.py + relay_tools.py | 物理 provider 尝试的会话级代理:session 隔离/凭证 scope 旋转/subagent 注册 |
| Hermes | relay 协议族 | 域发现 v27 | RelayTransport 4 关注点(生命周期/握手能力描述/入站/出站)+ send_interrupt 按 session_key 路由 + HMAC 双签名(TTL token + 投递签名) |
| Hermes | 推理摘要边界修复 | agent/reasoning_summaries.py(67) | 推理摘要流式边界(无 summary_index → 从 "delta 开 bold 标题" 信号重推导) |
| Reasonix | provider 规范化 | provider/(provider.go/openai/responses/anthropic) | 凭证决策收据;中断回合恢复;anthropic 原生缓存断点(ephemeral 标记 tools/system/消息末尾)+ DeepSeek 例外;streamWithPrefixContinuation;ProviderEntryConfigSnapshot 剥离进程态 |
| dsh | LLM 能力缝 | llm/(llm + llm-deepseek + llm-pi-ai + llm-retry + token-meter) | 消息/流词汇 + 适配器缝(ctx.llm);DeepSeek + Pi-AI 双 provider;重试;llm/stream 瀑布(独立审查器调用可拦截);冻结请求(纯函数);LlmError 分类;DeepSeek 预算常量;HTTP→稳定错误码 |

**跨项目定论**:LLM 层缝 = 主循环/独立审查器/摘要各可换模型(Reasonix coordinator 双模型独立会话保缓存 + OpenCode generateObject + dsh 适配器缝 + Hermes auxiliary 任务级路由)。产品保留 2-3 provider + 审查器独立模型通道。

## 07 工具系统

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | ToolRegistry V2 | core/src/tool/(registry.ts 147/tool.ts 162) | 不透明 Definition 单 executor;结算七步;stale rejection(身份校验);作用域注册覆盖+关闭即移除;leaf 自断言权限;whole-tool 定义过滤 |
| OpenCode | ToolOutputStore | core/src/tool-output-store.ts(211) | **超大输出→托管文件**(全局唯一名/扁平目录);bounded preview 保头保尾+指针留历史;保留失败=结算失败(不发布 lossy success) |
| OpenCode | 内置工具族 | core/src/tool/(leaves) | read/write/grep/glob/bash/apply-patch/edit/webfetch/websearch/skill/todowrite/question;统一四步权限序列;bash 超时=结构化结果;apply_patch 三阶段+CAS+部分失败报告;read 类型分派+图像;写 BOM 保留 |
| OpenCode | 输出托管 + 权限资源模式 | tool-output-store + q26 | 三类权限资源模式(文件系/搜索系/会话系);edit 精确替换+CRLF+CAS 错误;URL 即资源;会话内工具 |
| OpenCode | patch-parser | core/src/tool/apply-patch + patch.ts | 标记式格式(Add/Delete/Update);严格解析;四级宽容匹配(exact→Unicode 规范化);derive(BOM+倒序应用) |
| Pi | 工具系统(两套) | agent/src/harness/tools/ + coding-agent/src/core/tools/ | harness(通用:bash/read/write/edit/image)+ core(编码:+grep/find/ls);同一 AgentTool 契约;core = harness 超集 |
| Pi | 工具预设分级 | tools/index.ts:138-166 | 学习模式(只读)/写书模式(可写) |
| Pi | Tools Manager | coding-agent/src/utils/tools-manager.ts(374) | 工具生命周期管理 |
| Pi | 动态工具注册 | agent-loop.ts:787 | addedToolNames 自进化 |
| Pi | 输出累加器 | core/tools/output-accumulator.ts(222) | 流式输出有界内存(maxLines/maxBytes/临时文件溢出) |
| Pi | 文件变异队列 | core/tools/file-mutation-queue.ts | **同文件变异串行化**(realpath key+promise 链),不同文件并行 |
| Pi | 工具定义包装 | core/tools/tool-definition-wrapper.ts | ToolDefinition → AgentTool 桥(extensions↔core) |
| Pi | 工具延迟加载 | ai/src/utils/deferred-tools.ts | 从 transcript 按使用拆分 immediate/deferred 工具 |
| Pi | 工具结果配对 | 测试契约 | 按 id 配对(重排序回按调用序);空/重复 id 按位置配对(防 map 合并) |
| Pi | 截断全失败安全 | agent-loop.ts:374-406 | 防残缺参数(length → 所有工具失败 + "Re-issue with complete arguments") |
| Reasonix | 工具系统 | internal/tool/ + tool/builtin/ | Tool 接口 + 注册表 + 内置工具;工具变体(foregroundOnlyBash/readOnlyBash 同一 bash 多形态);深度感知注册表 SubagentToolRegistryForDepth |
| Reasonix | 工具结果配对 | 契约深化 | 配对语义同 Pi |
| Hermes | 工具编排 | model_tools.py + toolsets.py + agent/tool_executor.py | discover_builtin_tools/handle_function_call;TOOLSETS + _HERMES_CORE_TOOLS;**核心永不延迟 + 三档渐进披露**(tool_search 预算降级);桥接 unwrap(钩子看真实名);工具批参数错误不阻塞批 |
| Hermes | 工具结果持久化 | tools/tool_result_storage.py | **三层防溢出**:per-tool cap/per-result 持久化(超阈值全量写盘,上下文替换预览+路径)/per-turn 聚合预算(200K chars) |
| Hermes | 工具输出上限 | tools/tool_output_limits.py + ansi_strip.py | 工具输出字节/行/行长三上限 + ANSI 剥离 |
| Hermes | 工具搜索桥 | tools/tool_search.py | 工具目录分类(核心/可延迟)+ token 预算 → 延迟加载 |
| Hermes | 工具 UI 渲染意图 | tools 呈现层 | generic/terminal/diff + locations |
| dsh | Tools 注册表 + 执行管线 | core/tools | scoped registry + guarded execution;五事件管线(tool/call* → pre-execute → execute → post-execute → result);守卫管线(取消重查+ask+guardReason);code-dispatch-log 只改日志副本;工具 UI 渲染意图是设计一部分 |
| dsh | 工具结果修剪 | compaction/tool-result-pruner | 验收证据大小控制 |
| dsh | 工具即 MCP / MCP 即工具 | Hermes 双桥/OpenCode 桥 | 双向桥模式(产品 MVP 可延后) |
| dsh | 能力缝机制 | 跨包模式(每能力三包) | **Service Definition/Provider/Consumer 三角色**;换 provider 换整个产品(fs/subprocess 共享执行世界);缝事件(fs/write-intent)——产品工具/沙箱/LLM 可做能力缝 |
**跨项目定论(工具延迟加载三形态)**:Pi deferred-tools(按使用拆分 immediate/deferred)/ Hermes tool_search(核心可延迟分类+token 预算)/ Reasonix 深度感知注册表——"按需加载工具"是上下文节省通用模式。

## 08 技能系统(Skills)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Skills V2 | core/src/skill.ts + skill/(discovery 213/guidance 76) | 目录扫描 + isSafeSegment/isSafeRelativePath 安全校验;guidance Context Source(权限过滤只列名称+描述,正文走 skill 工具);版本化原子更新 |
| OpenCode | Agent 与技能过滤 | core/src/agent.ts + opencode/src/agent/ | agent 选择/权限继承;skill-guidance 按 agent 过滤;Agent Info 15 字段;默认权限集(.env ask 保护);子 agent 继承 deny+禁 task |
| Pi | Skills 系统(两层) | harness/skills.ts(375)+ core/skills.ts(487) | 技能定义/加载/调用;SKILL.md 格式;清单注入+双调用路径(/skill: + 模型自动);条件注入 |
| Reasonix | 技能 Skill | internal/skill/ | 技能系统 |
| Hermes | 技能系统 | tools/skills_tool.py + skill_commands.py | 技能清单注入 user 消息(非 system prompt,缓存稳定);技能内容按需读取(skill_view 工具);/learn 标准引导(learn_prompt.py 237 行,含 author 隐私) |
| Hermes | 技能生命周期 | agent/curator.py + tools/skill_usage.py | **三态状态机(active/stale/archived)**;来源分级(agent/builtin/hub/external/protected);**LLM 伞形合并审查**(独立 fork,合并看内容不看用量);干跑模式(REPORT ONLY);运行前快照+每次报告;安装安全扫描(威胁模式+信任矩阵+路径校验,--force 不能覆盖) |
| Hermes | 技能分发 | tools/skills_hub.py + skills_guard.py | 外来知识准入三关 |
| dsh | Skill | skill/(skill + skill-badge + skill-filesystem + tool-skill) | 技能 provider 注册表 + 本地实现 + catalog/loader 工具;skill 政策 + 排序 |

## 09 记忆与知识管理

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | SessionFiles/State | core/src/session + q52 | Info 映射/Todo 全量替换事务/Reference 命名引用/State 完整 |
| OpenCode | 快照 | core/src/snapshot.ts(266) | git 树内容寻址(复用 git 对象库);六操作;Step 快照对(开始/结束 files diff) |
| Pi | Session Facts | session-backends facts 表 + session/types.ts | (session_id, seq, kind, key, value) 模型 + setName/setLabel/getLabel;**书级知识库直接蓝图**(结论=facts/证据=label 引用/章节=lane/恢复=findOpenOperations) |
| Pi | 全局事实存储 | facts 表 | 同 Pi Facts |
| Pi | 分支缓存 | sqlite/branch-cache.ts(101) | branch 状态缓存 |
| Pi | 会话搜索 | agent/src/search/scanning.ts | 流式全扫描:投影器/分页/中止;SessionSearchHit(sessionId/seq/snippet) |
| Reasonix | 记忆系统 Memory | internal/memory/(15+ 文件) | 自动记忆:activation/auto_recall/forget/index/freshness;**Subject 冲突模型**(一问题一答案,更新那个 id);pinned vs relevant 激活;**Freshness 老化**;**低权威声明**(auto_recall preamble"绝不覆盖当前请求");BM25+相对分数地板;ShadowHits 影子排名;Path 故意缺失(隐私);Memory 结构 = 结论数据模型(ID/Revision/SubjectKey/ExpiresAt/Keywords);pinned 预算 1500+乐观并发+create-only;Archive 软删除;Volatility 遗忘速度;代码符号分词(retrieval v2) |
| Reasonix | 历史检索 History | internal/history/ + historycatalog/ | BM25 会话检索 |
| Reasonix | Memory+History 双层 | memory/ + history/ | 结论库 + 会话检索;ResumeFromGoalText(goal 文本 → 任务恢复) |
| Hermes | 记忆系统(三层) | tools/memory_tool.py + agent/memory_manager.py + memory_provider.py | 知识库 = 结构化文件 + 编排层 + 可插拔后端;**双态架构**(冻结快照注入 vs 活态写作);四操作语义(add/replace/remove/apply_batch,读失败必须拒绝);字符预算+consolidation 引导(失败上限 3 次→TERMINAL);成功响应 TERMINAL 不回声(防 thrash);**写门控三层防护**(注入扫描/漂移检测/原子写 temp+os.replace);审批门控(allow/blocked/stage 三态);单外部 provider 原则+串行化后台写;上下文栅栏(sanitize+StreamingContextScrubber,"这是数据不是指令");agent_context 写保护;中断回合不持久化("只有完成的结论才入库");委派观察模式(on_delegation) |
| Hermes | 学习图谱 | agent/learning_graph.py | 学习信号过滤/词法关联/密度统计 |
| Hermes | 会话洞察引擎 | agent/insights.py(1,212) | 历史 session → token/成本/工具模式报告;精确计数前置(flush) |
| Hermes | 背景审查 fork | agent/background_review.py(1,144) | 每轮后回放问"该存什么";工具白名单+运行时拒绝;写直达不动主会话缓存 |
| dsh | Session-Query 检索 | session-query/ | 逻辑语料(live 优先+借源契约);5 检索操作;corpus/cursor/filters/sources |
| (领域层) | 书级组织(书籍/章节) | vol-agent/10-product/02-* | 书架/章节实体 = 源码学习领域层设计(非引擎层;引擎提供事件过滤+检索能力) |

## 10 规划与任务契约(Planner / Plan / Spec / Task)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Reasonix | AutoResearch TaskSpec | internal/autoresearch/(4 文件) | **规格书三合一完整蓝本**:goal/scope/non_goals/allowed_operations(write/network/publish)/success_criteria+evidence_ids;Progress(stale_count/pivot_count 停滞检测);Finding(source 溯源);Summary(open_criteria/next_required_action 自动进度摘要);ValidationReport;ResumeFromGoalText |
| Reasonix | 计划契约 PlanContract | internal/plancontract/(7 文件) | "计划是数据不是 prose";Identity host 分配(ID/Revision)+ Revision diff;VerifiedFiles vs CandidateFiles 证据分离;Normalize/Validate 分离(修复 vs 拒绝);**NeedsApproval 扩张才审批**(收窄自动过);Assumption.Confirm(假设+最便宜验证);确定性路由(4 路由+3 深度) |
| Reasonix | 任务契约 TaskContract | internal/taskcontract/ | 任务生命周期契约;状态单一汇聚点(intent+planner-gate+验收标准+账本收据);构建零模型;Status 含 Stale(证据早于最新变异) |
| Reasonix | 回合策略 TaskPolicy | internal/taskpolicy/policy.go(614) | 第一次模型请求前冻结规划/验证/审查/约束;**Derive() 零模型调用**;Risk 只升不降;Route 三档;PersistentAction 意图抬 risk;ForbidMutation/ForbidTests/AllowedChecks/RequireFullVerification |
| Reasonix | 交付意图分类 TaskIntent | internal/taskintent/intent.go(604) | NL 任务文本 → 5 类意图;NeedsEvidence();纯启发式零模型;不门控权限 |
| Reasonix | 计划门 PlannerGate | internal/control/planner_gate.go(708) | 26 种计划模式原因(explicit/synthetic/slash/high_risk/goal_active/ambiguous) |
| Reasonix | 双模型协作 Coordinator | internal/agent/coordinator.go | planner+executor 独立会话保缓存;planner_route 决策;Runner 抽象(单/双模型无感);分场景降级(普通 vs 边界 fail-closed);交接防注入(7 条 executor 指令);planMode 保缓存(规划模式切换不换 system prompt/工具列表) |
| Reasonix | agentpreset 三预设矩阵 | agentpreset | PolicyOf(Light 目标验证/Delivery 全验证+原子契约/Balanced 中间档);ReviewLevel(ReviewNone/Conditional/Forced/ForcedSecurity)——"画像→契约"确定性映射 |
| Reasonix | 能力清单 Capability | internal/capability/(5 文件) | 5 Kind(skill/mcp-server/mcp-tool/tool/source)+6 Status+AutoUse;Entry 18 字段(触发词/负触发词/依赖/画像/成本/AutoUse 四档) |
| Reasonix | SerialTodo 确定性推进 | 契约深化 | 仅 in_progress 可推进/子步骤未完不推进/Level 1 完成晋升下一个 pending |
| OpenCode | 规划相关(无独立规划器) | specs/v2 | OpenCode 无 planner——run 双层循环即规划(runner 决策);产品对照美团F"Planner/Executor/Evaluator":OpenCode 把 planner 折叠进 loop,Reasonix 独立 planner |
| Hermes | GoalContract | hermes_cli/goals.py:332 | 结构化完成契约:Verification 判 DONE/Constraint 拒绝;draft_contract 失败回退裸 goal |
| Hermes | MoA 多层聚合 | agent/moa_loop.py(2,453)+moa_trace.py | 并行引用槽(slot)+聚合器;参考消息裁剪/工具结果预算/隐私模式(redact reference outputs);preset 温度;moa_trace 侧通道 JSONL(永不进历史/重放) |
| Hermes | 任务/规划域 | tools/todowrite(OpenCode)/SerialTodo(Reasonix) | todo 确定性推进 |

## 11 验收与完成判定(Evaluator / GoalGate / 独立审查器)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Reasonix | Goal 评估器 Goaleval | internal/goaleval/ | **独立无工具/无历史/无压缩的完成评估器**;输出 JSON(outcome: complete/continue/blocked/uncertain);缓存隔离;严格 complete 定义(完成+验证尝试过);证据不可信+防注入;多层预算(字段/请求/输出/时间);fail-closed(错误=暂停);双层输出防线(MaxTokens+流级中止);温度 0+固定 prompt;兜底触发(模型没报告才评估) |
| Reasonix | 有界 LLM BoundedLLM | internal/boundedllm/ | **独立审查者的共享基础设施**:temperature-0 单请求+硬时间/输出预算(DefaultMaxOutputBytes 防 provider 忽略 MaxTokens);usage 归审查者源不污染主缓存;渐进收缩(丢体积保身份);多审查器共享 boundedllm |
| Reasonix | 守卫 Guardian | internal/guardian/ | 长期存活守卫 sub-agent;跨轮审查工具调用审批;每 50 次审查压缩(compactEvery);策略编译期嵌入 |
| Reasonix | 完成报告 CompletionReport | internal/completion/report.go(336) | **Verdict 四态(Partial 终端态)**;Criterion(Required/Proofs);Change(Reviewed);Verification(Stale);**GapKind 8 分类**(UnbackedClaim 最重/UnprovenCriterion/MissingCheck/FailedVerification/StaleVerification/UnverifiedChange/UnreviewedChange/DeclaredUnverified);Claimed 永不清除主机 gap |
| Reasonix | 完成声明分离 Claim | internal/completion/claim.go(150) | 模型叙述(Verified/Unverified/Risks);Verified 对照账本,Unverified/Risks 无理由压制;LatestCompleteClaim 只取最新成功账 |
| Reasonix | 评审档位 | agentpreset ReviewLevel | ReviewNone/Conditional/Forced/ForcedSecurity;ForbidMutation 时降 None |
| Hermes | **GoalGate(门先于判定)** | hermes_cli/goals.py(2,156):427 | **确定性 shell 门在 LLM 判定前**;失败门短路判定(有界输出→续跑 prompt);**未变工作区跳过**(git status+HEAD sha256 指纹,stuck agent 不能重跑);尝试超限自动暂停;超时杀进程 |
| Hermes | goal-judge 独立审查器 | hermes_cli/goals.py:1006 | 四态 verdict(done/continue/wait/skipped);**wait 停泊**(等待外部进程是合法状态,pid 退出/期限过自动恢复);失败两轴(parse vs transport 独立计数);可用性探测+异常放行双保险(fail-open 不卡死 worker) |
| Hermes | 守卫族(叙述不是完成) | kanban_stop.py + verification_stop.py + delivery | kanban_stop(任务必须以终端工具结束,有界 nudge,防伪完成转死循环);verification_stop(编辑后无新鲜证据→提示,非代码文件不提示);delivery 静默叙述检测 |
| Hermes | 验证系统 | agent/verify/(runner/recipes)+verify_cmd | verify recipe 静态检测(检测顺序 Node/Python/Go/Rust/Java/Makefile);分层事实合并(manifest 真相源);验证执行+就绪轮询;partial(--phase 子集)→scope 降级 targeted |
| Hermes | 证据账本 | agent/verification_evidence.py(483) | record_verify_run ok/scope full|targeted;有界(2000 字符/30 天/100 事件);fail-silent(账本问题绝不改 CLI 退出码);verify_hooks 扩展点 |
| OpenCode | 事件发布管线(验收审计) | publish-llm-event.ts | 每步过程全事件化;Step 快照对(files diff)——"这步改了哪些文件"可审计 |
| OpenCode | 强制结构化输出 | llm.ts:80-144 generateObject | 验收器结构化输出(全协议统一,不用 provider JSON mode) |
| OpenCode | 错误契约 | CONTEXT.md:150-153 | 验收失败 = tagged 域错误(可判别),非 Error 类身份;操作化错误(operation 字段) |
| Pi | 章节 conformance(契约检查) | session/testing/conformance.ts(1,016) | **多后端共享行为规范**("rejects duplicate ids without changing state"/"rejects invalid queries before empty reads");conformance 工厂(跨后端一致性测试工厂=测试即契约终极形态);章节验收 = 规格书契约检查(覆盖 KP/深度/读者对象/证据链 file:line) |
| Pi | shouldStopAfterTurn 钩子 | types.ts:222 | 章节完成判定点 |
| Pi | 错误消息=反馈 | edit-diff.ts:257-293 | 验收失败信息指导 LLM 怎么改 |
| dsh | repeat 收敛检测 | guard/repeat-tool-reminder | 连续重复调用(3/5/8)→ advisory → 结构化日志 → 验收器消费 |
| dsh | llm/stream 瀑布拦截 | llm/llm/src/index.ts:56-70 | 独立审查器调用挂 llm/stream(路由/录制/重试) |
| dsh | 恢复指导语义 | repair/q16 | 双恢复码+模型可见指导(只读/幂等才重试) |
| dsh | Goal(目标) | goal/ | 同 session 目标(ctx.goals);goal/change 事件(目标变更可重放);continue 通过 agent/* |

**跨项目定论(验收器架构)**:三门串行 = 确定性门(Hermes GoalGate)→ LLM 独立审查器(Reasonix Goaleval 四隔离 + Hermes goal-judge 四态)→ 证据留痕(证据账本/CompletionReport GapKind 8)。"叙述不是完成"守卫族 + "连续 N 轮无新增"收敛判定(Pi)。

---

# C. 安全与边界

## 12 权限与审批

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | PermissionV2 | core/src/permission.ts(310) | action+resource+effect 规则;evaluate findLast 后写覆盖;三来源管线(agent 配置>saved 批准,**deny 优先**);ask(预检)/assert(强制等待)双 API;Deferred 异步等待;reject 级联/always 级联+持久化批准表;**无沙箱决策**(授权层而非隔离层) |
| OpenCode | Policy | core/src/policy.ts(49) | action/resource/effect 声明式策略;load/evaluate/hasStatements;与 PermissionV2 同族(定义可见性过滤) |
| OpenCode | LocationMutation | core/src/location-mutation.ts(162) | 路径解析:相对路径必须留在 Location 内;绝对路径在外需 external_directory 审批;不接收 project references |
| OpenCode | Agent 权限继承 | q44 | 子 agent 继承 deny+禁 task;.env ask 保护+外部目录白名单 |
| Pi | 权限/信任 | core/project-trust.ts + trust-manager.ts | 目录信任机制(架构决策:只有目录级信任,无工具级权限) |
| Pi | 细粒度权限(架构决策:不支持) | core 无 permission 文件 | 只有目录级信任,无工具级权限——与 OpenCode 权限系统对比(产品取 OpenCode) |
| Reasonix | 权限 Permission | internal/permission/ | per-call Policy:allow/ask/deny;三列表 Decide(toolName/readOnly/args)+ bash 分段判定 + RuleCoversString;权限规则记忆(rememberPermissionRule → config,coveredBy+剪枝);计划只读信任覆盖检查;决策收据(权限决策可审计 ID/Kind/Outcome);approvalManager 严格叶子(只动自己状态绝不回调 Controller) |
| Reasonix | 风险边界 | 契约深化 | 调用者高险无主机证明语义 → 不授可复用任务授权 |
| Reasonix | 写逃逸检测 | agent/plan_contract.go:102-135 | **写入限计划范围**:越界写保护(写书模式只能写规格书声明文件) |
| Reasonix | 路径穿越防护 | sessioninbox(#6932) | validatePathSegment:parentSession/kind 含路径分隔符/控制字符 → 拒绝(防 `../../etc` 逃逸 temp root) |
| Hermes | 工具守卫/审批 | tools/approval.py(2,500+)+write_approval.py+path_security.py | **hardline 无条件地板**(rm -rf / 等任何设置不能绕过);命令位置锚定;反混淆规整链+智能审批(auxiliary LLM+连续拒绝熔断);sudo stdin 保护;执行标志扫描($()/backtick);shell 分段解析;SSRF/站点策略;url_safety |
| Hermes | 智能审批拒绝后限制 | approval.py | 智能拒绝后 owner 覆盖受限(只能 allow_once/deny,不能 always——防绕过智能审查) |
| Hermes | 写审批子系统 | tools/write_approval.py | 通用写门控(MEMORY/SKILLS 两子系统);stage/list/discard/evaluate;GateDecision 三态(allow/blocked/stage);写来源 ContextVar(write_origin) |
| Hermes | 网关授权 | gateway/authz_mixin.py | DM/group 策略、发送者 allowlist、配对存储、upstream 授权 vs 本地策略 |
| dsh | Interaction 审批 | interaction/(user-approval + permission-presets) | approval/request 瀑布+四结局;ApprovalPolicy(ask\|never+fail-closed);durable 审计事件;政策切换 LAST=override;权限预设 |
| dsh | Settings owner scope | settings/ | 权限作用域 |

## 13 沙箱与执行环境

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Reasonix | 沙箱 Sandbox | internal/sandbox/ | Linux 隔离(prepare_linux.go);Seatbelt/bwrap;**无后端 fail closed**(缺隔离≠命令失败);Windows off(D10) |
| Pi | Sandbox(最小) | bun/restore-sandbox-env.ts(36) | 沙箱环境恢复(最小实现,产品参考) |
| Pi | 执行环境抽象 | harness/env/nodejs.ts(695) | NodeExecutionEnv 执行环境接口 |
| OpenCode | 无沙箱(架构决策) | specs/v2/session.md | 授权层而非隔离层(产品参考决策:与 MiniMax JD 对比) |
| Hermes | 终端后端 | tools/environments/(7 种) | local/docker/ssh/modal/daytona/singularity/vercel_sandbox |
| Hermes | 浏览器监督器 | tools/browser_supervisor.py | 持久 CDP 监督(每 task_id 一个);dialog/框架树检测;不在工具 schema 中,双通道到达 |
| dsh | Sandbox 能力缝 | sandbox/(sandbox + sandbox-local + sandbox-policy + sandbox-windows-acl) | **每调用沙箱政策**(read-only/workspace-write/danger-full-access);严格升级阶梯;ConfinedArgv 方言签名(EROFS/EACCES/EPERM 按后端);fail-closed;Landlock+Windows ACL;spawn 前包装 argv |
| dsh | Code-Runtime/E2B | code-runtime/ + e2b/ | 代码运行时(worker-thread)+ E2B 远程沙箱 POC(run_code 语言感知 schema+run-scoped abort) |
| dsh | 沙箱拒绝语义 | q10 | denial 方言签名——模型看到准确拒绝 |

## 14 认证与凭证

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Provider/Auth/Credential | core/src/provider.ts + credential.ts + oauth/page.ts | 凭证存储(credential 表,每集成一凭证,事务替换);Auth JSON 0600+环境注入;OAuth 授权页+刷新持久化;解码容错 |
| Pi | Auth Storage | core/auth-storage.ts(507) | 认证信息持久化 |
| Pi | 凭证存储 | ai/src/auth/(credential-store/context/resolve) | InMemoryCredentialStore:每 provider 一凭证,写按 provider 串行化(promise 链);AuthContext 抽象(env/文件存在,浏览器安全) |
| Pi | OAuth 设备码/PKCE | ai/src/auth/oauth/(device-code/pkce) | RFC 8628:slow_down +5s/默认 5s/min 1s/WSL 时钟提示;PKCE Web Crypto;OAuth 流族(anthropic/copilot/codex/radius/kimi/xai) |
| Pi | Runtime Credentials | core/runtime-credentials.ts | 运行时凭证 |
| Reasonix | 凭证 Secrets | internal/secrets/ | 密钥管理;密钥环境过滤(FilterSubprocessEnv+凭证脱敏+敏感文件保护) |
| Reasonix | MCP OAuth | 契约深化 | 受保护资源发现(RFC 8414)/动态客户端注册/令牌刷新 |
| Hermes | 凭证管理 | agent/credential_pool.py + secret_scope.py | credential_pool(耗尽 TTL/sole 例外/从错误提取重试延迟);**secret_scope 秘密作用域**(profile 隔离的密钥解析 + 双模式 + 豁免名单 + round-trip 解析器;contextvar 隔离);外部密码管理器源(bitwarden/1password/command) |
| dsh | Credentials | credentials/(credentials + env/.env provider) | 4 操作+**空值即缺席**(空白永不当配置的秘密) |

## 15 供应链安全 / 自保护

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Hermes | tirith 供应链安全 | tools/tirith_security.py | cosign 签名校验(证书/签名/身份正则)才允许自动安装 |
| Hermes | 自仓库保护 | tools/self_repo_guard.py(722) | 检测会重写本进程支撑 checkout 的 git 操作(checkout/switch/rebase/merge/pull/clean/bisect);变异分类+反混淆+别名递归+非绕过 |
| Hermes | 启动安全姿态 | security_audit_startup | 4 项警告不阻塞(root/SSH 密码/容器无持久卷/无认证监听器);fail-safe |
| dsh | Self-Modification | self-modification/ | agent 检查/挂载自己的插件 |
| Pi | 资源冲突诊断 | core/diagnostics.ts | ResourceCollision:extension/skill/prompt/theme 资源名冲突,winner/loser+来源 |
| Reasonix | 资源优先级仲裁 | core/package-manager.ts:178-215 | resourcePrecedenceRank:package 4 > project-local 0 > project-remote 1 > user-local 2 > user-remote 3 |

---

# D. 可靠性与正确性

## 16 检查点与回滚

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Reasonix | 检查点 Checkpoint | internal/checkpoint/ | 每轮 checkpoint+原子写+barrier+观察者;每轮快照(编辑前状态+MsgIndex 边界);**意图先持久化**(发布前写意图,崩溃可补偿);逐文件发布+每步持久化;**InjectFail 故障注入**(事务正确性被测试);Prepare/Commit 双阶段(预检+重验证+代,防过期提交);**MutationBarrier 代号**(不靠墙钟,generation 代际检测);事务状态机+双态目标(Restore/Forward);**BlobStore 内容寻址**(SHA-256+GC);Undo 撤销 |
| Reasonix | Checkpoint 恢复 Recovery | internal/recovery/ | 崩溃恢复;recovery Gate(代际观察隔离 StaleObservationsIgnored+成功验证清除 no-progress 预算+诊断证据摘录+失败指纹计数) |
| Hermes | 文件系统检查点 | tools/checkpoint_manager.py(1,976) | **git-backed 自动快照**(每回合每目录最多一个;工具写前 ensure_checkpoint;restore/rollback;容量上限 500MB/20 快照防爆炸;大小门槛 10MB 跳过) |
| OpenCode | Snapshot/PTY/Revert | core/src/snapshot.ts + session/revert.ts | git 树内容寻址;会话回滚(stage/clear/commit 事件驱动) |
| OpenCode | CAS 写入 | file-mutation.ts:144-157 | writeIfUnchanged 防覆盖 |
| Pi | 分支三操作 | session-manager.ts:1360-1505 | 走错路回退+单线导出(createBranchedSession) |
| dsh | checkpoint-policy | session/checkpoint-policy | 会话检查点策略(投影+检查点,快照水印非权威) |

## 17 错误处理与失败恢复

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Hermes | 失败分类学 23 类 | agent/error_classifier.py(1,905) | **FailoverReason 枚举(23 类)**:auth/billing/rate_limit/overloaded/timeout/context_overflow/payload_too_large/thinking_signature…;每个失败→恢复策略(auth 永久→abort、context_overflow→compress 非 failover、ssl→fail fast 不烧重试)——失败→策略确定性映射 |
| Hermes | fallback 链重装饰 | conversation_loop.py:2508-2760 | provider 降级不是换 URL:重装饰+载荷 sanitize+响应形状验证在链内消化 |
| Hermes | 智能审批熔断 | approval.py | 连续拒绝熔断 |
| Hermes | 错误两轴 | goals.py:1787-1804 | parse vs transport 独立计数互不干扰(弱模型 parse 3 次暂停 vs 配置错 transport 5 次) |
| OpenCode | 错误契约 | CONTEXT.md:150-153 | 域错误 vs 基础设施错误;操作化错误(operation 字段) |
| OpenCode | unsettled 兜底矩阵 | runner/llm.ts:295-345 | 7 场景:任何失败路径工具都有终态(成功/失败),不悬挂 |
| OpenCode | 崩溃恢复 | runner/llm.ts:119-139 | 重跑前失败化 running 工具——副作用不静默重放 |
| OpenCode | CorrectedError | permission.ts | 权限纠正带反馈进上下文,模型修正再试;DeclinedError 中断执行 |
| Pi | 错误三层分层 | agent-session.ts:2645 | overflow→压缩/可恢复→重试/致命→放弃 |
| Pi | immediate 错误结果模式 | agent-loop.ts:600-668 | 失败进上下文,LLM 自纠正 |
| Pi | 重试语义契约 | test/agent-session-retry | 瞬态重试成功/耗尽发失败/prompt 等待重试完成(重试期间的并发语义有契约) |
| Pi | 溢出恢复失败上限 | agent-session.ts:2001-2012 | compact+retry 仅一次(防死循环) |
| Pi | 恢复三态 | session/types.ts | 0 空闲/1 挂起/2 损坏 |
| Pi | 管理 HTTP | utils/management-http.ts | fetchWithRetry(408/425/429/500/502/503/504);仅限幂等管理请求 |
| Reasonix | 失败分类 | 契约深化 | QualifyingFailure 排除清单(执行可靠性≠权限边界)+ ClassifyFailure 四分类(transient/verification/mutation/execution) |
| 产品层 | 失败模式识别(JD GLM #4 要求) | 验收器输入 | 指令偏移(跑题)/上下文遗忘(前后矛盾)/测试投机(伪验证)——agent 自身失败模式的三类检测,由验收器(11)消费;引擎提供检测所需的证据(事件流/Step 快照对/收敛计数) |
| Reasonix | closeTruncatedJSON | 契约深化 | 截断 JSON 自动补全(栈追踪/字符串状态机/验证失败回退 "{}")+fast path 零分配 |
| Reasonix | streamWithPrefixContinuation | 契约深化 | Beta 失败在无续接字节时安全回退(首响应保持可见) |
| Reasonix | 自修复引擎 Repair | internal/repair/(26 文件) | 修复事务+配置快照+UndoLastRepair+跨平台路径处理;修复算法(扫描→错误结果→合成边界) |
| Reasonix | 崩溃报告 | sessiontemp/ + crashreport/ | 会话临时/崩溃报告 |
| dsh | LlmError 分类 | llm/llm | 消息词汇+重试;HTTP→稳定错误码(翻译序列化) |
| dsh | 写失败后台报告 | WriteBehind | 不阻塞 agent |

## 18 并发与协调(锁 / 租约 / 栅栏)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Flock 文件锁 | core/src/util/flock.ts(358)+effect-flock.ts | 多进程写共享资源(global/models-dev/npm/repository-cache/mcp-auth/plugin-install);breaker+心跳+token |
| OpenCode | KeyedMutex | core/src/effect/keyed-mutex.ts(45) | 同 key 排队/不同 key 并行(file-mutation/git/plugin) |
| OpenCode | Sync Fence | opencode/src/server/shared/fence.ts | x-opencode-sync header + event seq 状态同步栅栏(workspace-routing) |
| OpenCode | owner 三级栅栏 | event.ts:525-532 | 多节点预留扩展点 |
| Pi | Fencing Token 实现 | sqlite/storage/writer-leases.ts(58) | **分布式栅栏的 SQLite 实现**:owner_id+fence 单调递增+expires_at;续租 WHERE owner_id=? AND fence=?(防 stale);acquire/renew 原子;Fencing 行为测试("接管后旧 owner 被栅栏隔离") |
| Pi | 并发回合契约 | test/agent-session-concurrent.test.ts | prompt() 流式时抛错但 steer/followUp 允许;agent 事件先于 tool_call 发出 |
| Pi | 分布式理论层(q7) | 闭环笔记 q7 | 理论发现:栅栏令牌(Fencing)/租约(Lease)/事件溯源(Event Sourcing)/两阶段提交(2PC 恢复)/状态机不变量——D15 理论层检查的产物,实现见 writer-leases/reducer/session-sequences |
| Reasonix | 工作区租约 WorkspaceLease | internal/workspacelease/ | **写者租约持续到任务完成;读者不租约**(防 review 时工作区被改);写时获取+RetainUntil;canonical 规范化(符号链接/worktree) |
| Reasonix | 文件锁 FileLock | internal/filelock/ | 文件级锁;save.go 侧车锁(会话持久化正确性) |
| Reasonix | 会话路径租约 | agent/session_lease.go | 跨进程 session 租约(WriterID/PID);pending vs active 分离;CompareAndDelete 防旧代驱逐 |
| Hermes | 回合租约 turn_lease | gateway/turn_lease.py(97) | 每 session 回合租约;多 routing key→同一 session 串行化 [load→run→flush];**generation-scoped + identity-checked release**;超时 fail-closed——Fencing 家族第三变体 |
| Hermes | 压缩锁=租约 | hermes_state.py:5619-5750 | TTL+pid 死检;跨进程互斥(正确性边界非忙信号) |
| Hermes | 文件协调 file_state | tools/file_state.py(59) | 并发子代理写同文件防损坏:read 戳/全局最后写者/每路径锁;stale 写拦截(三分类) |
| Hermes | 回合互斥 | turn_lease fail-closed | 代际+身份校验;stale unwind 不能释放新回合 |
| dsh | Scope 作用域 | core/scope | per-agent scoped-registration 原语(isolate realm);agent-scoped 监听器只收该 agent 的 session |
| dsh | 协调器 | core/session/协调器 | 投影五元契约(纯折叠+stateVersion);快照水印+检查点非权威;协调器 seq 校验 |
**跨项目定论(代际模式四项目共证)**:Pi availabilityRefreshSeq / Hermes routing_generation / Reasonix uihub 代际隔离 + MutationBarrier / OpenCode ContextUpdated 提交回调——"迟到结果不覆盖新代"是并发正确性的通用机制。
**跨项目定论(租约三变体)**:Pi 数据级 fence(writer-leases 续租条件)/ Hermes 会话级 TTL+pid(turn_lease/compression_lock)/ Reasonix 工作区级写时获取(WorkspaceLease 读者不租约)——产品④ = 三组合(按资源粒度选型)。

## 19 存储与持久化

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Database/Storage | core/src/database/(schema.gen 274/sqlite.bun 183/sqlite.node 178) | SQLite bun+node 双实现;WAL+外键+Semaphore;自管迁移日志+旧日志播种;非空拒绝初始化;Drizzle schema |
| OpenCode | 会话投影 | core/src/session/projector.ts(458) | 事件→消息投影(seq=事件 seq);SessionMessageUpdater.Adapter;usage 增量累加;唯一 seq 索引(顺序=事件顺序) |
| OpenCode | 收件箱 | core/src/session/input.ts(288) | 双游标(admitted_seq/promoted_seq);admit 幂等+冲突检测(LifecycleConflict);投影同事务原子提升 |
| Pi | SQLite 持久化 | session-backends/sqlite-node/ | repo(953)+branch/entries/facts/lanes/records 存储模型;writer lease 集成(activeWriterError vs lostWriterError 语义区分);存储迁移(001_initial.sql);坏行/孤儿容错(库文件损坏恢复) |
| Pi | JSONL 追加写+版本迁移 | session-manager.ts | 知识库存储基础;**原子发布**(完整临时文件+原子 rename,崩溃只留 .tmp) |
| Pi | 延迟落盘 | session-manager.ts:1015 | 无效会话不写库 |
| Hermes | SessionDB 大库工程 | hermes_state.py(11,605)+hermes_state_common.py | **WAL+时间预算写**(20s/60s/0.5s+jitter 破 convoy);PASSIVE checkpoint 取代 TRUNCATE(#45383 损坏 B-tree);**有界读池+permit 信号量**(EMFILE 教训 #69678);**FTS5 降级链**(fts5→CJK→trigram→LIKE);**增量 FTS merge 取代 optimize**(毫秒级可交错);**自愈链+fail-open 分级**(连接重开→FTS 重建→fail-open 分离);SCHEMA_SQL 单一真相源+启动 reconcile(Beets/sqlite-utils 模式);messages active/compacted 双标记;AsyncSessionDB 门面 |
| Hermes | 会话搜索 | hermes_state_search.py(2,492) | 锚定视图(窗口+章首+章尾三切片);压缩归档行默认包含(压缩≠删除);慢查询日志(>1000ms 记录 routing path) |
| dsh | Session 持久化 | session/(persistence-jsonl + persistence-sqlite) | **WriteBehind 批量+耐久屏障**(200ms+flush 显式屏障);双后端(JSONL+zstd vs SQLite);TornMarker 损坏显式错误;SCHEMA_VERSION 单调 |
| dsh | Storage/Spill | storage/ + spill/ | 存储后端注册表+KV;溢出 |
| dsh | Attachment | attachment/ | 附件能力 |
| Reasonix | 事务收件箱 SessionInbox | internal/sessioninbox/(1,000) | 事务性持久收件箱:manifest/blobs/quarantine/transaction.lock;磁盘 I/O 只在 store.mu 下;孤儿 blob 抢救(恢复为条目非删除);blob 校验和验证读 |
| Reasonix | 可丢弃投影 ProjectionDB | internal/projectiondb/(500) | 业务数据必须留在库外,SQLite 投影可丢弃重建;SubgraphKind 7 类增量重建+PublishGate 代际排空 |
| Reasonix | 目录签名跳过扫描 | sessioncatalog | 会话目录加速 |
| Reasonix | 回收分支 GC | agent/recovery_gc.go | 原 session 已含 fork 全部内容才可回收;24h 宽限 |

## 20 检索与搜索

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | 事件检索 | readAggregate | after+limit 按聚合 seq 分页;不透明游标(base64url)翻页稳定;公开事件面(ServerDefinitions)+有限 history(limit≤100) |
| Pi | SQLite 搜索后端 | search-backend.ts(194) | SessionSearch 接口实现(FTS/中止信号) |
| Pi | 扫描式会话搜索 | agent/src/search/scanning.ts | 流式全扫描:投影器/分页/中止(非 FTS 形态) |
| Reasonix | BM25 检索 | retrieval/bm25.go+v2 | CJK 感知/相对分数截断/多字节安全摘要 |
| Hermes | FTS5 降级链 | hermes_state_search.py:1704-1790 | fts5→CJK→trigram→LIKE 三级降级;锚定视图(命中带章首目标+章尾结论) |
| dsh | Session-Query | session-query/ | 逻辑语料(corpus/cursor/filters/sources);5 检索操作 |

**跨项目定论(搜索三形态)**:Pi 扫描式 / Hermes FTS5 降级链 / Reasonix BM25——产品④检索可组合三种(先线性→BM25→FTS5 随库增长升级)。

---

# E. 可观测与评测

## 21 可观测与遥测

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Observability | core/src/observability/(otlp 79/logging 71)+packages/stats/+http-recorder | OTLP logs+traces 双通道(懒加载+AI SDK span 打通);结构化日志 key=value 扁平化;**runID 关联键**(8 位随机贯穿日志/OTLP 资源属性/事件);HTTP 录制(cassette 回放+密钥检测) |
| Pi | Telemetry | telemetry/ + core/telemetry.ts | 遥测;遥测抽象(Span 抽象+**敏感属性元数据** sensitive/cardinality);**声明式遥测 schema**(TelemetrySchemaDefinition:version/spans 定义/父约束/required 必填/sensitive/cardinality/values 枚举);遥测适配器一致性(TelemetryAdapterConformanceCase 测试即契约) |
| Pi | 遥测 Schema | harness/telemetry.ts(615) | AI_TELEMETRY_SCHEMA 结构化遥测 |
| Pi | Usage Totals | core/usage-totals.ts | token 用量统计;usage 优先/估算兜底双轨(精确计量不重复统计) |
| Reasonix | 遥测 Telemetry | internal/telemetry/ + stats/ | 统计;telemetry sink 包装器(不改变事件流只计数) |
| Reasonix | 轨迹 Trajectory | internal/trajectory/ | 运行轨迹记录 |
| Hermes | 监控平面 | agent/monitoring/(emitter/events/otlp_exporter) | **Content-free 事件**(只有 gateway_health/gateway_diagnostic,无 prompt/消息/工具参数);OTLP 导出可选依赖;dispatcher 线程 fail-isolated;无条件脱敏+匿名身份 |
| Hermes | moa_trace 侧通道追踪 | agent/moa_trace.py | 完整 MoA 回合 JSONL(端到端离线审计);**不是 messages 表,永不进历史/重放**(会破坏角色交替);默认零开销 |
| dsh | 遥测 | session/(telemetry + telemetry-otel + stats) | 遥测(含 OTel) |
**跨项目定论(遥测契约化)**:Pi 声明式 schema 最完整(span 定义+敏感+必填+枚举)+ 遥测适配器一致性测试;Hermes content-free 事件(无条件脱敏);Reasonix sink 包装器不改变事件流;OpenCode runID 贯穿——遥测必须声明敏感属性(sensitive 元数据),观测不干预执行(fail-isolated/fail-silent)。

## 22 评测体系

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Pi | eval harness | evals/src/pi-harness.ts(257)+vitest-evals/ | 真实 agent 评测:createAgentSessionServices+Harness+transcript 事件+会话快照 artifact;promptAgent 断言 stopReason==="stop";resolveModelSelection |
| Pi | 评测 A/B 汇总 | evals/src/vitest-evals/ | **HarnessObservation 5 态**(scored/unscored/skipped/pending/errored);baseline/candidates/repetition |
| Hermes | 评测 harness | evals/readtool/(runner/tasks/fixtures/report) | **真实 agent A/B 评测**:真实 AIAgent 跑确定性 hostile 工作区(9 种 fixture);指标 accuracy/api_turns/tool_calls/total_tokens/wall_s(per-task 均值绝不求和)——**不信任任何人的能力表** |
| Hermes | SWE 评测 runner | mini_swe_runner.py(28K) | Hermes 轨迹格式 SWE runner;local/docker/modal 环境;batch JSONL;严格采样契约模型温度处理 |
| Hermes | issue 编号回归测试族 | tests/gateway 20+ 个 #XXXXX 测试 | 每个 bug 修复 = 契约锁定(回归测试命名即声明) |
| Hermes | 契约测试命名族 | `*_contract.py`/`*_invariants.py` | 契约测试的命名即声明(三项目共证) |
| Reasonix | e2e 评测 | cmd/e2ebench/(2,204) | 真实 provider e2e:accuracy/cache-hit/token/cost;类级边际效用 |
| Reasonix | 基准套件 | benchmarks/ | 定向评测(e2e/verification-stress/compaction/memorybench/swebench) |
| Reasonix | 消融基准 | internal/ablation/ | **6 模块消融**(子系统边际效用对比) |
| OpenCode | 录制测试 | http-recorder/cassette.ts | 黄金测试基建(回放+密钥检测) |
| dsh | 测试契约密度 | 734 测试文件 23 万行(per-file 100%) | 追加不变性/JSON 严格性/HMR/continuation 70+/压力决策/时间精确/定界符中和——**测试即行为契约的黄金证据**(行为契约全在测试里) |

## 23 审计与证据

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Step 快照对 | runner/llm.ts:217,318-336 | "这步改了哪些文件"可审计(章节覆盖证据) |
| OpenCode | runID 贯穿 | q31 | 全书分析过程可关联:验收时重放事件流=完整审计轨迹 |
| Pi | 事件溯源审计 | records/lanes | 追加写日志 = 天然审计轨(内存移除+历史保留双态:失败结论可审计) |
| Reasonix | 证据 Evidence | internal/evidence/(高 fan-in 236) | 证据收集;**证据账本收据语义**(failed 收据保留但绝不匹配成功;BackgroundLeases 幂等;进度摘要排除失败与读);**evidence Receipt 17 字段**(OutputBytes 非零才算读/OutputDigest 有界指纹/ExitCode 指针——工具报告≠真相) |
| Reasonix | 日志/审计 | internal/sessiontemp/ + crashreport/ | 会话临时/崩溃报告 |
| Hermes | 生命周期账本 | gateway/lifecycle_ledger.py + shutdown_forensics.py + shutdown_watchdog.py | 脏死检测状态机(gateway.lifecycle.json 哨兵 phase=running/exited;SIGKILL/OOM 后下次启动发现;内存采样 <1ms /proc 作临终遥测;心跳采样/OOM 启发/所有权守卫) |
| Hermes | 交付义务账本 | gateway/delivery_ledger.py | **at-least-once 投递状态机**(pending/attempting/delivered/failed)+ 崩溃恢复 sweep + 可见 recovered-reply 标记(诚实 at-least-once 绝不静默重复);三检查点/死主认领/attempts 预算只花在真发送上 |
| Hermes | 背景审查 fork 审计 | background_review.py | 知识沉淀硬通道(白名单+运行时拒绝) |
| Hermes | 平台一致性契约 | tests/conformance/vectors/ + generate_conformance_vectors.py | 原生渲染器即 oracle(可执行规范):生成器产出 slack/discord/telegram/whatsapp 向量,connector 一致性 runner 消费——测试即契约正式化 |
| dsh | durable 审计事件 | interaction/user-approval | approval/asked + decided(durable 非 surface)——谁批了啥有日志 |
| dsh | goal/change 事件 | goal/ | 章节目标变更可重放 |

---

# F. 扩展与集成

## 24 插件系统与扩展

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Plugin V1+V2 | opencode/src/plugin/(loader/install/index/meta)+packages/plugin/src/v2/ | 插件加载生命周期;V2 窄能力(Tools 注册);插件 Zod 兼容边界(产品统一 Tool.make 方式) |
| OpenCode | move-plugin(q24) | opencode/src/move-plugin | 搬家=变更集:git 变更集搬运(capture-apply-discard);同项目强制;Moved 事件联动;插件 plan-resolve-load |
| OpenCode | LayerNode | q47 | Node 三 kind+类型级依赖检查;双 tag(global/location 方向强制);hoist 裁剪;compile+replacement 校验;service-use 惰性 Proxy |
| Pi | 扩展系统 Extensions | core/extensions/ + extensions/llama | agent 自扩展(self-extensible);**ExtensionRunner 完整事件钩子契约**(BeforeAgentStart/BeforeProviderRequest/ContextEvent/CompactOptions/InputEvent)+生命周期(1,236 行);扩展钩子默认回退;promptSnippet 缺失→保留但不可见(注册≠可见分离) |
| Reasonix | 扩展协议 | internal/extension/ + extensioncontract/ | Extension Protocol v1(JSON-RPC NDJSON+握手屏障+32 并发回调);侧车生命周期(握手 30s/通知队列 256 满则断连/拦截超时 60s);UI 中枢(代际隔离+凭证脱敏+崩溃客户端拒绝);RPC 线协议;扩展分发/构建/发布管线 |
| Reasonix | 编译期双扩展层 | SPEC §1 | 编译期内置(init 自注册)+运行时插件(MCP) |
| Reasonix | hook 系统 | internal/hook 族(1,592) | **15 事件仅 2 种阻塞**(PreToolUse/UserPromptSubmit;PreCompact 只贡献指导);超时分级(门事件 5s/其余 30s);项目钩子先于全局;PostLLMCall 钩子 stdout 可替换推理内容——阻塞影响面显式化 |
| Hermes | 插件系统 | hermes_cli/plugins.py + agent_plugins.py + plugins/ | 插件加载(四源发现/钩子面/行为契约);依赖拓扑排序(graphlib);缺失依赖不硬失败(ctx.has_plugin 运行时探测);插件契约实例(plugin.yaml+事件订阅+PluginState 配额) |
| dsh | Cordis 插件框架 | vendor/(@deepseek-ai/cordis) | 插件=服务+类型化事件+可逆效果;registrations 是 effect(卸载自动回滚,HMR 安全);waterfall 监听必须 next();Loader 配置(!!js);归属规则——**抄模式不抄框架** |
| dsh | Extensions | extensions/ | 扩展(自省/挂载) |

## 25 多 Agent / 子代理

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Hermes | 委派/子代理 | tools/delegate_tool.py + async_delegation.py + agent/subagent_lifecycle.py | **委派工具块清单(五禁)**(子代理不能递归/交互/共享写);**委派角色树**(leaf/orchestrator+深度上限 1);**委派摘要预算**(head+tail+溢出文件,父 headroom÷batch);**心跳+stale 分级检测**(in-tool 阈值高于 idle,慢工具不误杀);**SubagentLifecycleService**(launch/status/wait/cancel/reconnect);后台委派+异步完成队列(批作为单异步单元) |
| Reasonix | Subagent | agent/(subagent_* 15+ 文件) | **五概念分离**(profile/TaskSpec/CapabilityGrant/ContextRequest/SchedulerPolicy);写声明(write claims)强制而非建议;子代理模型解析(subagentModelRef/EffortRef) |
| Reasonix | Fleet | agent/fleet.go + parallel_tasks | 子代理依赖图;并行写任务必须预声明非重叠 write_paths;preflight 失败不启动;2-64 并发 |
| Reasonix | 能力使用运行时 usecapability | usecapability(1,621) | MCPCapabilityRuntime(共享 Host 每 agent 独立前端,ledger/audit 不跨 agent 边界)+ dispatchMu 线性化 |
| dsh | Subagent | subagent/(subagent + 8 providers) | 子 agent 能力缝;7 档光谱(spawn 94 行→codex 705 行);capabilities 声明契约(CO 全开 vs 外部 NO_START);共享驱动(造 id+戳迹);从全新子 agent 到另一产品委托 turn |
| OpenCode | Agent V2 | core/src/agent.ts + opencode/src/agent/ | agent 选择/权限继承(子 agent 继承 deny+禁 task) |
| Hermes | Kanban 多代理 | plugins/kanban/ + tools/kanban_tools.py + hermes_cli/kanban.py | 看板式多代理编排;kanban_stop 叙述检测(任务必须以终端工具结束);kanban_db 崩溃宽限 30s + 限流退出码 75(EX_TEMPFAIL 不计数失败) |

## 26 外部协议(MCP / ACP / LSP / SDK / Server)

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | MCP | opencode/src/mcp/(index 1,004) | 19 方法能力面;5 态状态机;三传输(stdio/StreamableHTTP/SSE);OAuth 设备流;V2 注册表桥接为 follow-up |
| OpenCode | ACP | opencode/src/acp/(service 1,105) | Agent Client Protocol 服务端(Zed/编辑器集成) |
| OpenCode | Server/Protocol/Client/SDK | packages/server/ + protocol/ + client/ + sdk-next/ | 权威 HttpApi(18 组);SSE;SDK Contract IR;Promise/Effect 双发射器;Embedded OpenCode(进程内 host) |
| OpenCode | codegen-server(q45) | opencode/src/codegen-server | compile→IR(portable+requiredForClient);SessionLocation 按会话路由;Basic 认证+query token+PTY 票据豁免;handler 错误映射+游标构造 |
| OpenCode | LSP | opencode/src/lsp/ | 语言服务集成(12 方法+工具集成) |
| Pi | Server/Client | server/ + client/ + protocol/ | headless 运行+进程间通信;Protocol CBOR 编解码(encoder 216/decoder 168);协议 schema 契约(TypeBox 严格对象 schema 族=单一真相源+PROTOCOL_VERSION);Unix socket 传输;字节连接抽象(ConnectionStage 状态机 awaitingHello→handshaking→ready→closing→closed);服务端快照(revision 递增+广播队列串行);服务端活会话管理(LiveSessionManager);客户端状态(ClientState 快照监听) |
| Pi | SDK | core/sdk.ts(401) | 对外编程接口;SDK 装配契约(会话恢复优先于配置/模型回退链/思维级别按模型钳制) |
| Pi | client disposal 契约 | test 契约深化 | 断开 → 子句柄失效 + 挂起请求拒绝 |
| Pi | 协议严格性 | 契约深化 | 拒绝有损转换/外来 tool id(协议 schema 单一真相源的强制面) |
| Pi | stdout 背压防护 | core/output-guard.ts | takeOverStdout + ENOBUFS/EAGAIN 重试 + flushRawStdout(协议输出不损坏) |
| Reasonix | MCP 插件 | internal/plugin/ + mcpregistry/ + mcplaunch/ + mcpdiag/ | stdio JSON-RPC 插件;strictDecode 未知字段拒绝;插件宿主(信号量并发启动+每插件超时+后台表面加载+启动前授权) |
| Reasonix | LSP | internal/lsp/ | 语言服务器协议 |
| Reasonix | ACP | internal/acp/ | 编辑器协议;acp 会话生命周期(begin TryLock 非阻塞准入+待决配置阻塞新回合) |
| Reasonix | 服务器 | internal/serve/ | HTTP/SSE |
| Reasonix | 扩展 SDK | sdk/go/(1,167+734) | Extension Protocol v2 |
| Hermes | MCP 服务器 | mcp_serve.py(37K) | OpenClaw 9 工具 MCP 通道桥面(conversations_list/messages_send/permissions_respond);**双向桥**(Hermes 工具自动暴露为 MCP 服务器 hermes_tools_mcp_server) |
| Hermes | MCP 工具父死看门狗 | mcp_tool | --ppid getppid 检测父死退出;描述威胁扫描(供应链面) |
| Hermes | ACP 适配器 | acp_adapter/ | ACP 服务器(VS Code/Zed/JetBrains);ACP 权限桥(allow_once/session/always/deny 映射) |
| Hermes | 浏览器 CDP | tools/browser_supervisor.py | 持久 CDP 监督 |
| dsh | MCP | mcp/ | MCP 集成 |
| dsh | ACP | acp/ | automation-only Agent Client Protocol 服务器 |
| dsh | SDK | sdk/ | JSON-RPC 协议/服务器/TS 客户端 |
| dsh | API(BFF+Typert) | api/(gateway+remotes)+typert/ | 远程 BFF 组装+Typert RPC 网关;类型图生成器(类型即真相,6245) |
| dsh | Hooks(Claude/Codex 桥) | hooks/ | Claude Code/Codex hook 桥+wire-protocol 库 |

## 27 消息网关与平台适配

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| Hermes | 网关会话 | gateway/session.py + run.py | 消息→agent 管线(_run_agent_inner:代理模式先行/线程池不阻塞事件循环/run_generation 当前会话检查) |
| Hermes | 平台适配器抽象 | gateway/platforms/base.py(4,400+) | **平台能力抽象**:send/edit/delete/draft streaming/审批/clarify/私信/媒体/平台锁(acquire_scoped_lock 防跨 profile 凭证冲突)/markdown 转平台格式 |
| Hermes | 富消息回显索引 | gateway/rich_sent_store.py | Telegram rich message 不回显 content → 本地 message_id→text 索引 |
| Hermes | 渠道目录 | gateway/channel_directory.py | 每平台可达渠道缓存(5 分钟刷新)→ send_message 名称解析 |
| Hermes | 排空控制标记 | gateway/drain_control.py | dashboard→gateway 外部排空标记契约(marker 文件+epoch 防跨实例误判) |
| Hermes | 消息渲染 | bot/render.py(Reasonix 同族) | 事件流→平台消息;messageEditor 原地编辑流式 |
| Reasonix | 消息网关 | bot/gateway.go(2,972) | 队列 4 模式(steer/followup/collect/interrupt)+3 丢弃策略;审批超时防卡死;配对;控制通道;消息渲染(事件流→平台消息);会话队列策略(QueueMode 4 种+QueueDrop 3 种+QueueCap);设备配对(配对流 TTL/上限);平台适配器族(weixin/feishu/qq) |
| Reasonix | 平台通知 | notify/ | 平台通知+异步 sink |
| dsh | Client(Web) | client/(connection/runtime/schema-form) | Web 客户端语义(排除视觉) |

---

# G. 形态与工程

## 28 交互形态与用户交互

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Question | core/src/question.ts + opencode/src/question/ | 用户提问机制;**Question 批量提问+Deferred**(ask/Deferred/reject);批量一次问完;Question 批量+Deferred+Location 归属 |
| OpenCode | Command | core/src/command.ts(64) | 斜杠命令/init 命令;命令模板+$ARGUMENTS 展开;Command State 化(State 可重放转换 transform-reload-batch) |
| OpenCode | CLI | opencode/src/cli/(bootstrap/upgrade/cmd/run.ts 1,011) | CLI 入口/运行/升级 |
| Pi | CLI 会话管理 | cli/session-picker.ts + remote-session.ts + transcript.ts | 会话选择/远程会话/对话记录;session-selector(1,031)完整会话选择/搜索/重命名/删除 |
| Pi | CLI 启动流程 | cli/initial-message.ts + file-processor.ts + startup-ui.ts | 初始消息注入/文件参数处理 |
| Pi | Slash Commands | core/slash-commands.ts | 斜杠命令系统 |
| Pi | 键位系统 | core/keybindings.ts(370) | app.* 键位定义(interrupt/clear/exit/suspend);键盘输入解析(Kitty 协议);分片序列缓冲(stdin 分片到达缓冲——任何流式协议输入通用);撤销栈(clone-on-push 语义);kill-ring(环形缓冲) |
| Pi | Experimental CLI | cli/experimental/ | 新 CLI 命令实验区 |
| Pi | CLI 子命令族 | coding-agent/src/cli/(args/auth-check/auth-command/list-models) | CLI 启动/认证/模型列表 |
| OpenCode | Share/Installation/Flag | opencode/src/share/ + installation/ + core/src/flag | 会话分享;安装;功能开关(Flag 访问时求值) |
| Pi | 提示词模板系统 | harness/prompt-templates.ts(262) | 模板参数替换/命令解析——**对齐模块直接可抄** |
| Pi | 结构化约束采样 | ai/src/api/constrained-sampling.ts(277) | JSON Schema strict 模式/grammar 采样——**让 agent 输出结构化规格书的关键** |
| Hermes | CLI 编排 | cli.py(19,269)HermesCLI | **Mixin 架构**(CLIAgentSetupMixin/CLICommandsMixin/CLIBillingMixin);process_command 斜杠分发;ChatConsole/_SkinAwareAnsi;**busy_input_mode 三模式**(interrupt/queue/steer);/steer 与 /redirect 运行中纠偏;prompt_stash 不写盘(草稿含凭据仅内存) |
| dsh | Interaction | interaction/(commands + tool-ask-user + user-questions) | 人工审批/交互能力;ask-user |
| dsh | 命令系统 | interaction/commands | 命令解析/检查/斜杠工具桥 |

## 29 配置 / 启动 / Profile

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Config | opencode/src/config/ + core/src/config/(20+ 子域) | 三来源合并(global<project<.opencode);config schema 自导出模式;fromConfig 权限规则转换;V1 自动迁移;Policy 反向顺序;打开缓存+宽松解析 |
| OpenCode | Global | core/src/global.ts(87) | config 路径/版本/安装元数据 |
| Pi | Config | config.ts + core/resolve-config-value.ts | 配置解析;**配置迁移**(migrations.ts 315);模型商店(models-store+远程目录 4h 刷新 mergeModels 动态覆盖基线) |
| Pi | 源码信息/清单 | core/source-info.ts + pi-manifest.ts | 版本/来源信息(补充文档深挖) |
| Pi | Settings | core/settings-manager.ts(1,290) | 设置持久化/更新/默认值;修改追踪(只写改过的字段);双作用域合并(全局+项目,项目不可信不加载);版本迁移 4+ |
| Reasonix | 配置 | internal/config/ | TOML 加载(flag>project>user>defaults);乐观编辑日志回放(ProviderEntryConfigSnapshot 剥离进程态;ProviderEntriesConfigEqual 乐观冲突检测);provider 设置冲突检测(文件快照前后比较) |
| Reasonix | 启动 boot | internal/boot/boot.go(2,893) | 6 迁移族先于 Load;凭证保护先于一切 subprocess;同步 sink;成本报价链;RuntimeOwner 生命周期(RuntimeOwner 血缘;RebuildFrom 只排空旧代) |
| Hermes | 配置默认 | config_defaults | agent 缓存 LRU 权衡文档化;WAL 平台降级 |
| Hermes | inventory 单一化 | 域发现 v39 | provider/model 清单三调用点合并(消除 2 个隐藏 bug)——"每个域一处解析,全库消费" |
| dsh | Profile/Bundle | boot/app-boot + bundle/(base/headless/web-app) | 插件树从有序层组合;**六层层序+patch 整行替换**(最后写赢);Patch 失败策略(文件缺失硬错/行缺失警告);profile=命名组合;bundle=分发格式;dump-config |
| dsh | Settings | settings/ | 用户设置能力+file provider;**Settings 命名空间+事件**(prev/next/source 源可追溯);Settings owner scope |
| 产品层 | prompt 版本管理(JD 美团F #6 要求) | 29 配置 | 提示词/规格书模板的版本化发布(prompt 模板系统 Pi 已提供机制,产品加版本化+回滚) |
| dsh | Boot/Cmdline | boot/(app-boot + cmdline) | 共享 app-bin 胶水;命令行解析 |
| dsh | Identity | identity/ | 匿名身份 |
| dsh | Preset | preset/ | per-session agent 组合(cordis.yml 预设) |

## 30 后台任务 / 调度 / 生命周期

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | Background/Control-Plane | core/src/background-job.ts + opencode/src/background/ | 后台任务;BackgroundJob 输出分片 |
| Pi | Package Manager | core/package-manager.ts(2,677) | 依赖管理工具执行 |
| Reasonix | 任务调度 Task | internal/task/ + taskcatalog/ + taskintent/ + taskmonitor/ + taskpolicy/ | 任务状态机/策略/监控;taskmonitor 纯观察层(TaskState 7 态+RuntimeState 独立,"不实现第二状态机,以 jobs.Manager 为唯一真相源");**jobs 崩溃恢复所有权证明**(只有持 session 租约的运行时能修复废弃 Running 记录为 Interrupted;无证明的观察者 defer;修复失败绝不发布内存 tombstone);startInvalid(验证失败→注册 Failed 观察对象不启动 goroutine) |
| Reasonix | 后台任务注册表 | internal/jobs/jobs.go(2,071) | session 级后台任务注册表;Manager 生命周期=session 非 turn;跨 turn 持续;完成摘要注入下一轮(DrainCompletedNote) |
| Hermes | Cron 调度 | cron/(jobs.py + scheduler.py + scheduler_provider.py) | **CronScheduler ABC**(触发/执行/交付共享,provider 不重实现);运行中 job 注册/中断;**lifecycle_guard 防网关自杀循环**(拒绝含 gateway restart 命令的 job,command-shaped 锚定);cron 蓝图(参数化 slot schema 单一真相源);cron/executions 执行审计账本(非重试队列;中断 attempt 只在 owner 进程证明消失后变 unknown;终端态不可变) |
| Hermes | 批量 runner | batch_runner.py(28K) | 并行 batch;**checkpoint 断点续跑**(completed_prompts 索引+按内容匹配恢复,索引对不上按 prompt 文本扫描,失败条目跳过重试) |
| Hermes | 轨迹生成 | batch_runner.py + trajectory_compressor.py + agent/trajectory.py | 训练轨迹管线;**轨迹压缩边界保护**(不切分 gpt tool_call/tool 响应对 + 保护首轮/尾 N 轮)——与上下文压缩边界对齐同构 |
| Hermes | 进程注册表 | tools/process_registry.py + daemon_pool.py | 进程会话管理(systemd scope/输出监听/模式匹配)+守护线程池(解释器退出不阻塞) |
| Hermes | 排空/关闭冲刷 | drain_control + shutdown_flush | **关闭冲刷协议**(flush_pending_to_file/spool_dropped_transcript_message/**fsync_directory 目录 fsync**/recover_pending_to_db——关闭/崩溃时在途数据不丢) |
| dsh | Jobs | jobs/ | 后台工作(ctx.jobs);job_* 工具收集/停止;Jobs 注册表(owner 授权+快照只读) |
| dsh | Schedule | schedule/ | 调度;**Schedule 严格时间域+双错误分类**;事务化 |
| dsh | Workflow | workflow/(workflow + worker-thread) | 工作流能力+worker-thread provider;跨线程生命周期 |

## 31 基础工具与共享包

| 来源 | 域 | 位置 | 设计点 |
|------|----|------|--------|
| OpenCode | 共享包 S1-S9 | core/src/(location.ts/database/fs-util/wildcard/snapshot/token/flock/keyed-mutex/fence) | Location(路径域)/Database(双实现)/FSUtil(274)/Wildcard(匹配引擎尾随星号可选)/Snapshot(266)/Token 估算(4 字符)/Flock(358)/KeyedMutex(45)/SyncFence——全域依赖的深挖优先级最高 |
| OpenCode | Repository | core/src/repository.ts(214)+repository-cache.ts | 代码仓库服务+缓存;project 发现/克隆/检测;项目 ID 三源(remote>cached>root) |
| OpenCode | Shell/Process | core/src/shell.ts + process.ts + cross-spawn-spawner.ts(507) | shell 选择/preferred;子进程管理;spawner 抽象;输出捕获限制 |
| OpenCode | Git/Worktree | opencode/src/git/ + worktree/ | git 封装/worktree;git 七组操作+仓库级锁 |
| OpenCode | filesystem-ripgrep(q40) | core/src/fs + ripgrep | 平台保护清单(隐私目录)/Ripgrep 进程原语(不掺权限)/Watcher 平台绑定+降级/FFF 双实现/fs-util 纯函数 |
| OpenCode | opencode 运行时基建 | opencode/src/effect/(instance-state/instance-ref/registry/run-service/bridge/bootstrap) | InstanceState(ScopedCache 按目录隔离实例);makeRuntime(memoMap 去重);EffectBridge(原生回调重入);Runner 四态(Idle-Running-Shell-ShellThenRun) |
| OpenCode | Project V2 | core/src/project/ | 目录发现/复制策略/项目行 |
| Pi | Git 封装 | utils/git.ts(226) | git 操作封装 |
| Pi | FS Watch | utils/fs-watch.ts | 文件监控 |
| Pi | Clippy 工具集 | coding-agent/src/utils/(child-process/shell/mime/paths) | 编码 agent 通用工具库 |
| Pi | HTTP 分发器 | core/http-dispatcher.ts | 全局 fetch 安装/HTTP 空闲超时(30s-5min/禁用) |
| Pi | 导出 HTML | core/export-html/(316+258+172) | 会话导出 HTML(ANSI 转换) |
| Pi | harness 工具辅助 | agent/src/harness/utils/(shell-output/truncate) | ShellCaptureProgress + truncateTail |
| Pi | ai 兼容层 | ai/src/compat.ts(298)+legacy-api-aliases.ts | API 兼容/别名(产品从零开始仅参考) |
| Pi | 图像体系 | ai/src/images*.ts(116) | 图像生成 API 抽象(注册表/模型);图片 MIME 检测(魔数) |
| Pi | 消息变换 | ai/src/api/transform-messages.ts(223) | 非视觉模型图片降级(placeholder 防重复) |
| Pi | 内存移除+历史保留双态 | agent-session.ts:2015-2020 | 失败结论可审计 |
| Reasonix | 进程管理 Proc | internal/proc/(13 文件) | 命令运行/进程树 kill/优先级/隐藏窗口 |
| Reasonix | Shell 安全 | internal/shellparse/ + shellrun/ + shellsafe/ | 命令解析/执行/安全;**shellsafe 静态效果分类**(Certainty 无法证明→fail closed;WriteDomain 4 类位掩码) |
| Reasonix | 系统代理 SysProxy | internal/sysproxy/ | 系统代理配置 |
| Reasonix | 远程 Remote | internal/remote/ | SSH 传输(sftpfs/forward/bootstrap);knownhosts/jump |
| Reasonix | 医生 Doctor | internal/doctor/ | 诊断;capdiag 只读诊断(永不写 config/cache/state/log) |
| Reasonix | 计费 Billing | internal/billing/ | 计费 |
| Hermes | 计费/用量 | agent/usage_pricing.py + billing_* + nous_rate_guard | 计费;**nous_rate_guard 跨会话限流守卫**(共享文件防 429 重试放大,9 次调用/回合全计 RPH) |
| Hermes | 消息规整/脱敏 | agent/message_sanitization.py + redact.py + think_scrubber.py | 消息脱敏;**think_scrubber 跨 delta 状态机**(MiniMax 流式 <think> 分片,部分标签跨边界保持,端流冲洗) |
| Hermes | bounded_response 有界读 | 域发现 v27 | 字节上限+硬墙钟截止(防恶意服务器悬挂) |
| Hermes | browser_route 引用失效协议 | 域发现 v27 | driver 会话 id 由适配器注入,变异使 refs 失效需重读 |
| Hermes | agent_cache_pressure | 域发现 v46 | cgroup 感知缓存边界 |
| Hermes | 运行时支撑共享包 | agent/agent_runtime_helpers.py(4,199) | API 客户端创建/凭证池恢复/fallback 恢复/消息序列修复(prompt 缓存断点规划)/轨迹转换 |
| Hermes | API 调用共享包 | agent/chat_completion_helpers.py(4,724) | 非流式/流式 API 调用/fallback 激活/超时管理/stale-kill |
| dsh | Util/Support/Examples | util/ + support/ + examples/ | 零依赖工具;开发测试基建;演示 |
| dsh | Subprocess/Shell/FS/Terminal | subprocess/ + shell/ + fs/ + terminal/ | 能力缝实现:bash/pwsh 双后端×本地/沙箱双模式;request/spec 分离模板;持久终端会话;fs 政策(fs/* 事件) |
| dsh | Runtime Diagnostics | runtime-diagnostics/ | 运行时诊断 |
| dsh | Host/Workspace | host/ + workspace/ | 宿主;工作区实体 |
| dsh | Feedback | feedback/ | 消息反馈 |
| dsh | Web | web/(web-search-* + web-fetch-*) | 搜索/fetch providers+工具 Consumer;Web Fetch 政策(URL/同源) |

---

## 对账表(程序化核对——每个项目域必须全部归入)

| 项目 | 声明域数 | 归入能力域覆盖数 | 差额 |
|------|:--:|:--:|:--:|
| Pi | 127(123 编号 + 4 扫描:CLI/evals/Bash Executor/TUI 原生层) | 123 编号域全部归入 + 扫描域:CLI(28)/evals(22)/Bash Executor(01/31)/TUI 原生层(28) | 0 |
| Reasonix | 102 | 核心 18 + 支撑 15 + v2 8 + v6 12 + v7 14 + v8 6 + v9-v14 28 + v30-v54 深挖域 1 = 102 | 0 |
| Hermes | 81 | 1-80 全部归入 + GoalGate(11) | 0 |
| OpenCode | 53 + 9 共享包 | 核心 12 + v2 10 + 支撑 22 + 扫描 4 + S1-S9 9 | 0 |
| dsh | 51 | 核心 10 + 支撑 41 | 0 |

> 覆盖方法:D18 程序化核对——每项目域清单(从域发现文档逐行提取)与本文 31 个能力域表格逐项比对;命名差异(括号/星号/别称)人工确认同一域;真缺失 25 项已补入(见 Review 记录)。
> 架构决策型域(非能力域)单独标注:Pi MCP 不支持(26)、Pi 细粒度权限不支持(12)、OpenCode 无沙箱(13)、OpenCode 无独立 evals(22)、dsh 预发布无兼容承诺(19)。

### 排除面对账(5 项目排除清单全量,按 D10/D18 复核)

> D18 教训:排除清单也要复核(Pi tui 原生层曾排除,stdin-buffer 分片缓冲实为通用设计)。下表为复核后的最终边界:

| 项目 | 排除面 | 排除理由 | 复核结论 |
|------|--------|---------|---------|
| Pi | tui 视觉组件/终端原生层 | 前端视觉 | **部分保留**:原生层 stdin 分片缓冲/undo 栈实为通用设计(已入 28) |
| Pi | providers 生成元数据(50 个 .models.ts)/lazy 包装 | 生成物/同构 | 保留 deepseek/openai/anthropic 作样本(06) |
| Pi | agent/harness/env vendor | vendor | 确认 |
| Reasonix | desktop(Wails 前端)/_windows.go 等非 Linux 分支 | 前端 + D10 | 确认(Windows 分支按 Linux 唯一基准排除) |
| Reasonix | benchmarks/npm/site/scripts | 评测/分发 | **部分保留**:benchmarks 入 22(评测体系) |
| Reasonix | 工具 _test.go | 测试基础设施 | 契约测试要读(测试即行为契约,已入 22) |
| Hermes | apps/desktop + ui-tui + web TSX 组件 | 前端视觉 | 确认 |
| Hermes | gateway/platforms 20+ 适配器 | 同构重复 | 保留 base.py/session.py 抽象(27) |
| Hermes | plugins/model-providers 40+ | 同构重复 | 保留 transports 抽象(06) |
| Hermes | 语音/TTS/图像/视频工具 | 产品无关边缘 | 确认 |
| Hermes | tests/ | 行为契约证据 | 作为契约证据使用(22),不列为域 |
| OpenCode | app/console/desktop/web/ui/session-ui 视觉 | 前端 UI 视觉 | 保留 server 语义 |
| OpenCode | TUI 组件渲染 | 终端视觉 | 保留 keymap/input/runtime(28) |
| OpenCode | llm/providers 同构实现 | 供应商同构 | 保留 route/executor 抽象(06) |
| OpenCode | recorded-* 黄金测试 | 测试数据 | 保留录制回放机制(22) |
| OpenCode | sdks/vscode/script/infra/perf/patches | IDE/构建/补丁 | 确认 |
| dsh | client/ui-*(25 包)+ web/website | 前端视觉 | 保留 connection/runtime/schema-form 语义 |
| dsh | python/ SDK | Python 捆绑运行时 | 确认(产品 TS) |
| dsh | vendor/ 内部实现 | 上游 Cordis 源码 | 抄模式不抄框架(24) |
| dsh | scripts/ | 仓库门禁/生成器 | 确认 |

**排除原则总结**:①前端视觉层排除(TUI 组件/桌面/Web UI),但保留其运行时语义(输入/协议/连接);②同构实现排除(40+ provider/20+ 平台适配器),但保留抽象契约;③生成物/数据面排除(模型元数据/i18n/脚本),但保留机制(生成器/门禁);④测试不列为域,但作为行为契约证据全量使用;⑤非 Linux 平台分支按 D10 排除。

### Review 记录(2026-08-15)

| 轮次 | 发现 | 处理 |
|:--:|------|------|
| v1 | 首次合并,30 个能力域,缺失 **LLM 适配/Provider 层**整域(Pi LLM 统一抽象/OpenCode LLM 包/Hermes Provider 适配/dsh LLM 能力缝) | 新增能力域 06(31 域),四项目 LLM 域全部归入 |
| v2 | 脚本对账(提取 414 域名逐项 grep)发现 25 个真缺失域 | 全部补入:Pi(Output Guard/细粒度权限决策/导出 HTML/CLI 子命令族/stdout 背压/harness 工具辅助/ai 兼容层/Experimental CLI)、Reasonix(日志审计/回收分支 GC)、Hermes(Kanban/MoA/轨迹生成/轨迹压缩边界/共享包/平台一致性契约)、OpenCode(运行时基建/Sync legacy/Share-Installation-Flag)、dsh(能力缝机制/Goal/Todo/Plan/Preset/Extensions/Host-Workspace) |
| v3 | 标题编号被脚本打乱(重复/缺号/三位数) | 精确重排为 01-31 连续,框架表同步 |
| v4 | 最终核对:31 个能力域 × 5 项目全部闭合 | 对账表差额 = 0 |
| v5 | **深度 review:补充文档全量纳入**(Pi v7-v32/Reasonix v7-v54/Hermes v12-v46 等 100+ 份,提取 431 个唯一域) | 发现 3 个真新域:Pi cache-stats/timings(缓存统计)、Pi source-info/pi-manifest(源码信息)、Hermes inventory 单一化(三调用点合并)——全部补入;其余为命名差异/位置列误提取(已逐个确认) |
| v6 | 重复条目扫描(431 对项目×域):7 个重复 | 5 个真重复删除(辅助客户端路由/推理摘要边界/证据账本/生命周期账本/执行环境抽象/管理 HTTP 各保留一处,生命周期账本独特内容并入审计行);2 个合理跨域保留(OpenCode 错误契约:验收语义 vs 错误处理语义,内容不同) |
| v7 | **深度 review 第 2 轮:参考架构决策清单对账**(5 份参考架构 126 条决策关键词逐一核对) | 真缺失 2 个已补(Reasonix 写逃逸检测→12、dsh Surface 双视图→03);关键词补强 4 处(循环状态在 DB→01/缓存神圣→04/章节 conformance→11/书级组织标注→领域层);跨项目定论补 2 处(工具延迟加载三形态→07、遥测契约化→21);其余 30 项确认措辞差异内容已在 |
| v8 | **深度 review 第 3 轮:契约深化层核对**(补充文档 66 个行为契约设计点) | 13 个高价值补入(execute_one 门控链→01/hook 15 事件 2 阻塞→24/路径穿越防护→12/重试语义→17/findCutPoint→05/client disposal+协议严格性→26/relay HMAC→06/issue 回归测试族+契约测试命名族→22/usecapability→25/智能审批拒绝后限制→12/MCP 父死看门狗→26);8 个误报确认已有;8 个低价值/Windows 平台细节按 D10 Linux 基准省略;另补跨项目定论 2 处(租约三变体→18、代际模式四项目→18) |
| v9 | **深度 review 第 4 轮:内容准确性抽查**(关键修正值/位置引用/核心域归属) | 修正值全对(失败分类 23 类/委派深度 1/摘要 ×20%/GoalGate 427/reducer 12 种);位置引用 10/12 命中,补 2 处(dsh 734 测试文件 23 万行→22、头部设计数);核心域归属 5 项目 61 个核心域全部语义正确归组(外围项均在存储/配置/插件/多Agent 组,无错位) |
| v10 | **深度 review 第 5 轮:闭环笔记 137 份全量对账 + 排除面对账 + JD 预检** | 137 份笔记逐份核对:4 份补入(Pi q7 分布式理论→18、OpenCode move-plugin→24、filesystem-ripgrep→31、codegen-server→26),其余 133 份内容已覆盖(脚本英文分词失效,人工逐份确认);排除面对账 20 项全表(每项目排除面+理由+复核结论);JD Tier 0/1 关键词 31 项预检:2 项补入(失败模式识别→17、prompt 版本管理→29),8 项措辞差异确认已覆盖 |

---

## 下一步

- [x] 用户 review(已深度 review 2 轮:主文档对账→补充文档全量→参考架构决策对账→跨项目定论→重复清理→格式检查)
- [ ] 用户确认后:在 31 个能力域上做 **MVP 取舍决策**(vol-agent/10-product/02-mvp-scope.md)
- [ ] 然后:源码学习领域层设计(vol-agent/10-product/03-*)
- [ ] 最后:JD 映射(面试附带层)
