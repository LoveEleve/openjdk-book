# 产品开发路线 — 全量架构 + 里程碑实现(面试级亮点零削减)

> 前置:docs/product/01-agent-engine-capabilities.md(31 域 476 条,产品能力**全量**)
> 生成:2026-08-15(v2 重写——修正 v1 错误:把"MVP 取舍"做成了"砍功能",沙箱/子代理/评测/检索等亮点被后置)
> 定位:**产品能力 = 全量(一个设计不砍);开发 = 里程碑推进;MVP = 第一个能跑的里程碑,不是能力子集**
> 面试级别:DS / Kimi / GLM / MiniMax / 字节 / 腾讯×2 / 美团×3——每个岗位考点都在全量架构里有对应设计
> **实现边界**:①全量架构(476 条)是分析资产+面试素材,产品实现按里程碑每域取核心机制(约 60-80 个),其余为接口预留或后置;②**D10 Linux 唯一基准**:只实现 Linux(平台分支/Windows/跨平台特性排除);③任何"复刻"冲动先对照此边界——抄机制,不抄实现

---

## 一、定位修正(v1 → v2)

**v1 错误**:把 31 域切成 🔴16/🟡11/⚪4,亮点(沙箱/子代理/评测/检索/MCP)被后置——等于把 5 项目抄来的精华又丢了,产品看起来没亮点。

**v2 修正**:
```
产品能力全景 = 31 域 476 条设计,全部保留(01 文档)
面试讲法     = 全量架构,每个 JD 考点有对应设计
开发顺序     = 里程碑(先闭环,后扩展),但所有机制进架构
MVP          = 里程碑 M1-M7 跑通真实闭环,不是能力砍半
```

**铁律**:任何设计点不得以"MVP 简化"为由从产品中删除——只能调整**实现顺序**。

---

## 二、全量能力清单(31 域,面试级亮点显式标注 ★)

### A. 执行核心(01-05)

| 能力域 | 亮点设计(★ = 面试必讲) | JD 考点 |
|--------|------------------------|---------|
| 01 执行引擎/Agent Loop | ★**循环状态在 DB(收件箱)**:崩溃恢复 = 重放收件箱;★失败进上下文 LLM 自纠;★崩溃前失败化 running 工具(副作用不静默重放);unsettled 兜底矩阵 7 场景;★execute_one 9 阶段门控链;截断全失败;turn 0-step 也记录 | Durable Execution(腾讯A/美团T)、运行时(字节)、Harness(美团F) |
| 02 会话生命周期 | ★分析状态机(对齐→执行→验收→完成,非法迁移不可达);steer/followUp 双队列;中断不持久化(半截结论不入库);reload 热重载;恢复三态(0 空闲/1 挂起/2 损坏);缩放至零+唤醒;AgentLane 18+ 操作 | 超长程任务(DS)、长程恢复(美团T) |
| 03 事件溯源 | ★**三支柱**:收件箱双游标 + seq 全序唯一索引 + 投影器同事务;★归约 12 种损坏检测(重放+验证才是真相);★版本化事件(writer 决定 bump + ignorable 词汇级);★模型可见⟺已记录(运行时不变量);重放分叉检测(同 seq 不同内容报错);durable/live-only 边界;KindCount 哨兵(新事件自动被测试覆盖) | 可控可查可复现(Kimi)、正确性(DS) |
| 04 上下文管理 | ★**KV Cache 前缀字节稳定**(缓存神圣宪法:技能进 user 消息/记忆冻结快照/system prompt 永不重建);★Epoch 基线不可变+时间序更新;SystemContext 四态代数;Unavailable=stale-while-revalidate;空渲染拒绝;指令源聚合 | **KV Cache(DS 独点)**、Context Engineering(8/10) |
| 05 上下文压缩 | ★压缩决策状态机(防 thrash:ineffective≥2 阻塞+恢复窗口一次试探+重启不得解除);★技能幽灵重注入(压缩不丢指令,LLM 改写不可信);★提交栅栏(取消 vs 后台提交确定性边界);7 段摘要模板+合并规则;一代一票;溢出压缩只一次;摘要预算缩放 ×20%;CJK 感知 token 估算;折叠经济学 ≥400 token;native 服务端压缩窄路由;micro-compaction 显式取舍 | Context Engineering(DS/Kimi)、压缩压力决策(dsh) |
| 05 上下文压缩 | ★缓存优先唯一阈值 0.85(低于阈值零操作——Reasonix 极简设计);head/recent 切割 keep 8000;| Context Engineering(DS/Kimi) |

### B. 能力系统(06-11)

| 能力域 | 亮点设计 | JD 考点 |
|--------|---------|---------|
| 06 LLM 适配 | ★LLM 层缝(主循环/独立审查器/摘要各可换模型,四项目共证);generateObject 强制结构化输出;promptCacheKey;llm/stream 瀑布(审查器调用可拦截);冻结请求纯函数;温度契约;任务级 provider 路由(auxiliary.<task>.{provider,model});anthropic 原生缓存断点+DeepSeek 例外;双模型独立会话保缓存(planner/executor 不混会话) | 模型侧深度(DS/腾讯A)、推理链路(美团F) |
| 06 LLM 适配 | ★reasoning 模型适配(思考链/推理可见性,Pi thinking 流式;DS #7 Prompt Engineering/Harness 考点);prompt 模板版本管理(美团F #6 生产级工程实践) | 模型侧深度(DS)、Prompt Engineering(DS/腾讯B/美团) |
| 07 工具系统 | ★工具 5 状态机确定性终态;★结算七步+stale rejection;★输出托管(保头保尾+文件指针);工具批三模式(concurrent/sequential/segmented);中断预检+取消占位;同文件变异串行化;三层防溢出(per-tool/per-result/per-turn 200K);apply_patch 三阶段+CAS+部分失败报告;工具延迟加载三形态;深度感知注册表 | Tool Use(Kimi/DS)、工具生态 |
| 08 技能系统 | ★技能三态生命周期(active/stale/archived)+ 来源分级 + LLM 伞形合并审查(独立 fork 干跑);★背景审查 fork(每轮后回放问"该存什么",白名单+运行时拒绝)——**自进化核心**;技能清单注入 user 消息(缓存稳定);安装安全扫描(威胁模式+信任矩阵,--force 不能覆盖) | **自进化(DS 使命/美团T 亮点)**、Skills(5/10) |
| 09 记忆与知识 | ★Subject 冲突模型(一问题一答案,更新那个 id);★双态快照(冻结注入/活态写作);写门控三层防护(注入扫描/漂移检测/原子写 temp+rename);★pinned 预算+relevant 检索;Freshness 老化;低权威声明("绝不覆盖当前请求");BM25+相对分数地板+影子排名;记忆恰好一次进前缀;中断回合不持久化;委派观察模式;学习图谱 | Memory(DS/腾讯A/美团P)、RAG(腾讯A/美团F) |
| 10 规划与任务契约 | ★**规格书三合一**(执行契约+验收基准+知识库首条日志);★TaskSpec(goal/scope/non_goals/allowed_operations/success_criteria+evidence_ids);PlanContract 数据不是 prose;★NeedsApproval 扩张才审批;★TaskPolicy 零模型推导(第一次模型请求前冻结);agentpreset 三预设矩阵(画像→契约确定性映射);Capability 18 字段清单;SerialTodo 确定性推进;planner 只产计划不执行 | **Planner/Executor/Evaluator(美团F 显式点名)**、Planning(6/10) |
| 10 规划与任务契约 | ★意图识别 TaskIntent(NL 任务文本→5 类意图:Conversation/Advisory/ObservableRead/Mutation/PersistentAction,纯启发式零模型);| 意图识别(腾讯A) |
| 11 验收与完成判定 | ★**三门串行**:确定性门(GoalGate 门先于判定+未变工作区指纹跳过)→ LLM 独立审查器(四隔离:无工具/无历史/无压缩/缓存隔离,温度 0,四态 verdict,wait 停泊,失败两轴)→ 证据留痕(CompletionReport GapKind 8 分类+Claim 分离+Verdict 四态 Partial 终端态);★守卫族(kanban_stop 叙述不是完成/verification_stop 编辑后新鲜验证/GoalGate 未变不重跑);★连续 N 轮无新增收敛判定;失败模式识别(指令偏移/上下文遗忘/测试投机);readtool 真实 agent 评测 | **Evaluator(美团F)**、失败模式(GLM/腾讯B)、收敛性(#24) |
| 11 验收与完成判定 | ★GoalGate 源码位置 goals.py:427(门先于判定,指纹跳过);| Evaluator(美团F) |
| 11 验收与完成判定 | ★repeat 收敛检测 3/5/8 阈值(连续重复调用 advisory 提醒,不 veto);| 收敛性(#24) |

### C. 安全与边界(12-15)

| 能力域 | 亮点设计 | JD 考点 |
|--------|---------|---------|
| 12 权限与审批 | ★deny 永远赢+级联;★写逃逸检测(只能写规格书声明文件);★hardline 无条件地板(rm -rf / 任何设置不能绕过)+反混淆规整链+智能审批熔断;approval 瀑布(ask\|never+fail-closed);DecisionReceipt 权限决策可审计;approvalManager 严格叶子(不回调 Controller);智能拒绝后 owner 覆盖受限 | 权限/安全(MiniMax/美团P) |
| 13 沙箱与执行环境 | ★每调用沙箱政策(read-only/workspace-write/danger-full-access,政策跟调用走);★严格升级阶梯;ConfinedArgv 方言签名(EROFS/EACCES/EPERM 按后端——模型看到准确拒绝);★无后端 fail-closed(缺隔离≠命令失败);Landlock+bwrap OS 强制层;浏览器 CDP 监督 | **Sandbox(MiniMax/Kimi 显式点名)**、隔离(6/10) |
| 14 认证与凭证 | ★凭证隔离 contextvar 作用域+双模式+豁免名单;OAuth 设备码(RFC 8628 slow_down)+PKCE+动态客户端注册(RFC 8414);凭证空值即缺席;每 provider 一凭证写串行化;Auth JSON 0600;secret_scope profile 隔离+外部密码管理器 | 凭证(MiniMax)、OAuth 设备流(OpenCode/dsh) |
| 15 供应链安全 | tirith cosign 签名校验;自仓库保护(git 变异拦截+别名递归+非绕过);资源冲突仲裁(5 级优先级);启动安全姿态 4 项警告;安装威胁扫描 | 供应链(MiniMax)、自保护(Hermes) |

### D. 可靠性与正确性(16-20)

| 能力域 | 亮点设计 | JD 考点 |
|--------|---------|---------|
| 16 检查点与回滚 | ★意图先持久化(崩溃可补偿);★Prepare/Commit 双阶段(预检+重验证+代验证防过期);★InjectFail 故障注入(事务正确性被测试);MutationBarrier 代际检测;BlobStore 内容寻址(SHA-256+GC);git-backed 每回合快照+容量上限;Undo 撤销;recovery Gate(StaleObservationsIgnored+失败指纹计数) | Durable Execution(腾讯A)、长跑恢复(美团T) |
| 16 检查点与回滚 | ★快照容量上限(500MB/20 快照防爆炸,10MB 大文件跳过);| Durable Execution(腾讯A) |
| 16 检查点与回滚 | ★状态快照/确定性回放(每轮快照 + 回放 diff 分析,审计追踪,执行轨迹——MiniMax 显式要求) | 状态快照/回放/审计(MiniMax) |
| 17 错误处理 | ★失败分类学 23 类→恢复策略确定性映射(auth 永久→abort/context_overflow→压缩非 failover/ssl→fail fast);★失败两轴独立计数(parse vs transport);fallback 链重装饰(降级不是换 URL);closeTruncatedJSON 截断自动补全;错误三层(overflow/可恢复/致命);失败=tagged 域错误(可判别) | 失败模式(GLM/腾讯B 体感)、错误处理(Kimi) |
| 18 并发与协调 | ★租约三变体(Pi 数据级 fence/Hermes 会话级 TTL+pid/Reasonix 工作区级写时获取);★代际模式四项目共证(迟到结果不覆盖新代);★Fencing Token(SQLite 实现+接管测试);回合租约 generation-scoped+identity-checked;KeyedMutex+Flock;文件协调(读戳+最后写者+每路径锁);压缩锁=租约 TTL+pid 死检;写者租约持续到任务完成读者不租约 | 分布式理论(DS)、并发(MiniMax) |
| 19 存储与持久化 | ★JSONL 真相源+原子发布(临时文件+rename,崩溃只留 .tmp);★损坏显式错误(TornMarker);SCHEMA_SQL 单一真相源+启动 reconcile;WAL+时间预算写+jitter 破 convoy;PASSIVE checkpoint 取代 TRUNCATE;有界读池+permit 信号量;增量 merge 取代 optimize;自愈链+fail-open 分级;双后端(JSONL+SQLite);WriteBehind 批量+耐久屏障;可丢弃投影(业务数据留在库外);孤儿 blob 抢救 | 存储(Kimi 显式:PostgreSQL/MySQL/Redis/ES)、大库(Hermes) |
| 19 存储与持久化 | ★时间预算写(20s/60s/0.5s 分级 + jitter 破 convoy 队头阻塞);| 存储(Kimi) |
| 20 检索与搜索 | ★搜索三形态组合(扫描式/BM25/FTS5 降级链随库增长升级);FTS5→CJK→trigram→LIKE;锚定视图(命中带章首目标+章尾结论);压缩≠删除(归档可搜);增量 FTS merge;影子排名 | RAG(腾讯A/美团F)、检索(6/10) |
| 20 检索与搜索 | ★向量检索(RAG 扩展点:结论向量化跨章节语义召回,腾讯A/美团F 显式要求向量检索) | RAG(腾讯A/美团F) |

### E. 可观测与评测(21-23)

| 能力域 | 亮点设计 | JD 考点 |
|--------|---------|---------|
| 21 可观测 | ★runID 贯穿(日志/OTLP/事件,一次运行全流程关联);OTLP logs+traces 双通道;★content-free 事件(无 prompt/消息/工具参数)+无条件脱敏;声明式遥测 schema(required/sensitive/cardinality/values 枚举);结构化日志扁平化;span 抽象+敏感属性元数据;遥测适配器一致性测试;moa_trace 侧通道(不进历史) | **可观测(7/10,腾讯B 岗位)** |
| 21 可观测 | ★遥测契约化(声明式 schema:required/sensitive/cardinality/values 枚举——四项目共证);★agent debugging(事件流重放 = 调试工具,评审时逐帧回放,腾讯B 显式要求 debugging 工具) | 可观测(7/10,腾讯B 岗位) |
| 22 评测体系 | ★**真实 agent A/B 评测**(readtool 9 种 hostile fixture,指标 accuracy/api_turns/tool_calls/tokens/wall_s,per-task 均值绝不求和——不信能力表);★收敛判定(连续 N 轮无新增,程序化对账非 agent 声明);★元验收(验收器自身测试,检查器被检查);HarnessObservation 5 态;e2e 评测(accuracy/cache-hit/token/cost);6 模块消融(子系统边际效用);SWE runner;issue 回归测试族;消融基准 | **评测(8/10,GLM 岗位)**、A/B+regression(腾讯B) |
| 23 审计与证据 | ★证据账本(ok/scope full\|targeted,partial 绝不当全绿,有界+30 天+fail-silent);★evidence Receipt 17 字段(OutputBytes 非零才算读/ExitCode 指针——工具报告≠真相);Step 快照对(这步改了哪些文件);交付账本 at-least-once(诚实标记,绝不静默重复);生命周期账本(脏死检测:哨兵+SIGKILL/OOM 发现+内存采样);诚实 at-least-once | 审计(MiniMax)、trace(腾讯B/美团T) |

### F. 扩展与集成(24-27)

| 能力域 | 亮点设计 | JD 考点 |
|--------|---------|---------|
| 24 插件系统 | ★能力缝三角色(Service Definition/Provider/Consumer——换 provider 换产品);可逆效果(卸载自动回滚);waterfall 短路即设计;hook 15 事件仅 2 阻塞(影响面显式化);Cordis 抄模式不抄框架;ExtensionRunner 完整钩子契约 | 范式创新(字节)、扩展性(美团F) |
| 25 多 Agent | ★委派摘要预算(head+tail+溢出文件,父 headroom÷batch——#9126 教训 N 个全量摘要炸父上下文);★委派角色树+深度上限;★心跳+stale 分级(in-tool 阈值高于 idle,慢工具不误杀);SubagentLifecycleService(launch/status/wait/cancel/reconnect);写声明强制+预声明 write_paths;五概念分离(profile/TaskSpec/CapabilityGrant/ContextRequest/SchedulerPolicy);Kanban 多代理+叙述检测 | 多 Agent(DS/腾讯A/美团P/F) |
| 26 外部协议 | ★MCP 19 方法+5 态+三传输+OAuth 设备流;ACP 权限桥(allow_once/session/always 映射);SDK Contract IR+双发射器;Typert 类型图(类型即真相);双向桥(Hermes 工具自动暴露为 MCP);JSON-RPC NDJSON+握手屏障 | MCP(6/10,DS/Kimi 显式点名) |
| 27 消息网关 | BasePlatformAdapter 能力抽象(发送/审批/锁/媒体);平台一致性契约(原生渲染器即 oracle);队列 4 模式+3 丢弃策略;渠道目录+回显索引;drain 排空标记(epoch 防跨实例误判) | 平台化(字节)、DevOps(Kimi) |

### G. 形态与工程(28-31)

| 能力域 | 亮点设计 | JD 考点 |
|--------|---------|---------|
| 28 交互形态 | ★三档提问(A 自答/B 推荐/C 决策——D12-D14 工程化);Question 批量提问+Deferred;busy_input_mode 三模式(interrupt/queue/steer);约束采样(JSON Schema strict——规格书强制结构化);prompt_stash 不写盘;tui_gateway 会话槽位;分片序列缓冲(任何流式协议通用) | 开发者体验(Kimi)、交互(GLM 多轮) |
| 29 配置/启动 | ★prompt 版本管理(生产级工程实践);三来源合并(global<project<local);profile 六层层序+patch 整行替换(最后写赢);settings 命名空间事件(prev/next/source 可追溯);乐观冲突检测;凭证保护先于一切 subprocess;6 迁移族先于 Load;config schema 自导出 | Prompt 版本管理(美团F #6)、配置(字节) |
| 30 后台任务/调度 | ★jobs 崩溃恢复所有权证明(只有持 session 租约的运行时能修复废弃 Running 记录);完成摘要注入下一轮(DrainCompletedNote);taskmonitor 纯观察层(不实现第二状态机);CronScheduler ABC+防网关自杀;cron 蓝图(slot schema 单一真相源);执行审计账本(终端态不可变);进程注册表+守护线程池;缩放至零(own the suspend call) | 后台任务(Kimi)、调度(美团) |
| 31 基础工具 | Location 路径域(相对路径不逃逸+外部目录审批);Wildcard 匹配引擎;Token 4 字符估算;Flock/KeyedMutex;shellsafe 静态效果分类(无法证明→fail closed);think_scrubber 跨 delta 状态机;nous_rate_guard 跨会话限流(防 429 放大) | 基建(Kimi/MiniMax) |

---

## 三、面试岗位对答表(10 岗位 × 产品对应)

| 岗位 | 画像 | 面试官会问 | 产品对应(全量架构) |
|------|------|-----------|-------------------|
| DS | 懂模型的 Agent 研究员 | KV Cache 怎么用?自进化?长程任务? | 04 缓存神圣/08 技能自进化/02 长程状态机 |
| Kimi | 懂工程的 Agent 工程师 | 架构?存储?可观测?DevOps? | 03 事件溯源/19 存储族/21 runID/30 后台 |
| GLM | 懂数据的 Agent 评测专家 | 评测体系?失败模式算法? | 22 评测全栈/11 失败模式识别/17 分类学 |
| MiniMax | 懂安全的 Agent 基建专家 | 沙箱?隔离?审计?资源编排? | 13 每调用政策/15 供应链/23 证据账本/18 租约 |
| 字节 | 懂平台的 Agent 运行时专家 | 运行时可靠性?范式? | 01 收件箱 DB/24 能力缝/02 状态机 |
| 腾讯A | 懂业务的 Agent 系统专家 | Durable Execution?记忆+RAG? | 01+16 持久执行/09 记忆/20 检索 |
| 腾讯B | 懂质量的 Agent 可观测专家 | tracing?eval pipeline?A/B? | 21 全链路/22 A/B/23 审计 |
| 美团T | 懂效果的 Agent Harness 工程师 | trace 驱动?自迭代? | 21+22/08 自进化/11 收敛 |
| 美团P | 懂落地的 Agent 平台工程师 | 编排?RAG?安全? | 25 多Agent/20 检索/12 权限 |
| 美团F | 懂范式的 Agent 框架工程师 | Planner/Executor/Evaluator?ReAct? | 10 Planner/01 Executor/11 Evaluator 显式对应 |

---

## 四、开发里程碑(全量架构,分阶段实现)

> 里程碑是**实现顺序**,不是能力砍半。每阶段结束 = 可运行可演示。

| 里程碑 | 内容 | 验收判据 | 面试可讲新增 |
|--------|------|---------|-------------|
| M1 骨架 | TS 工程+事件日志(03 三支柱基础)+收件箱(01)+CLI 空壳(28) | 日志追加/重放/损坏检测测试通过 | 事件溯源三支柱+损坏检测 |
| M2 对齐 | 6 维盘问(28)+规格书 schema(10)+三合一+冻结注入(04) | 规格书→日志 spec.admitted;缓存前缀稳定可测 | 规格书三合一+KV Cache 前缀 |
| M3 执行 | 双层循环(01)+只读工具集(07)+LLM 层缝(06)+权限 deny(12)+写逃逸(12) | jdk11u 自主跑 5 轮事件全落盘 | Durable 循环+权限+写逃逸 |
| M4 验收 | 章节 conformance(11)+收敛判定+状态机门(02)+失败模式 | 抓 1 类真实错误;门禁不可绕过 | 验收器+收敛性(#24 代码级答案) |
| M5 知识库 | 结论入库(09 subject 冲突+pinned)+章节文件+7 段摘要(05) | 第 1 章产出(结论+file:line) | 记忆模型+冲突检测 |
| M6 闭环 | 跨 session 重放恢复(03/19)+第 2 章 | 新 session 无人工交接续跑 | #21 自动化答案 |
| M7 成书 | 完整书级产出+证据链 | 每结论可核验 | 书级知识库 |
| M8 压缩 | 压缩决策状态机(05)+幽灵重注入+提交栅栏 | 长分析不丢指令 | Context Engineering 深度 |
| M9 沙箱 | 每调用政策(13)+升级阶梯+fail-closed | 写书模式隔离可测 | MiniMax/Kimi 考点 |
| M10 可观测 | runID+结构化日志+OTLP(21)+证据账本(23) | 全流程可追踪 | 腾讯B/Kimi 考点 |
| M11 评测 | 真实 agent A/B(22)+消融 | 验收器自身被评测 | GLM/腾讯B 考点 |
| M12 子代理 | 委派树+摘要预算+心跳(25) | 多章并行 | DS/腾讯A/美团 考点 |
| M13 扩展 | 能力缝插件化(24)+MCP(26) | 第三方集成 | 字节/美团F 考点 |
| M14 大库 | FTS5 降级链+WAL+租约(19/20) | 50 章全书检索 | 腾讯A/美团F 考点 |

### 能力域 → 里程碑归属(31 域全映射,无遗漏)

| 能力域 | 里程碑 | 说明 |
|--------|:--:|------|
| 01 执行引擎/Agent Loop | M1/M3 | M1 收件箱基础,M3 双层循环完整 |
| 02 会话生命周期与状态机 | M3/M4 | M3 会话状态,M4 验收状态机门 |
| 03 事件系统与事件溯源 | M1 | 三支柱基础先行(一切依赖它) |
| 04 上下文管理 | M2 | 规格书冻结注入(缓存稳定) |
| 05 上下文压缩 | M8 | 长分析需要时(章节变长) |
| 06 LLM 适配/Provider | M3 | 层缝接口 + 双 provider + generateObject |
| 07 工具系统 | M3 | 只读工具集 + 结算 + 输出托管 |
| 08 技能系统 | M2/M8 | M2 骨架清单注入,M8 幽灵重注入 |
| 09 记忆与知识 | M5 | 结论库 + subject 冲突 + pinned |
| 10 规划与任务契约 | M2 | 规格书 schema + 三合一 |
| 11 验收与完成判定 | M4 | conformance + 收敛 + 状态机门 |
| 12 权限与审批 | M3 | deny 优先 + 写逃逸 + 模式切换 |
| 13 沙箱与执行环境 | M9 | 每调用政策(授权层先行于 M3) |
| 14 认证与凭证 | M3 | API key 文件 0600 + 环境注入 |
| 15 供应链安全/自保护 | M3 | 只读工具集天然保护 + 拒绝 git 变异 |
| 16 检查点与回滚 | M3/M12 | M3 git 快照,M12 事务级(子代理后) |
| 17 错误处理与恢复 | M3/M4 | 错误三层 + 失败进上下文 + 崩溃失败化 |
| 18 并发与协调 | M14 | 单进程先行,M14 租约/Fencing |
| 19 存储与持久化 | M1/M14 | M1 JSONL 真相源,M14 SQLite/WAL |
| 20 检索与搜索 | M5/M14 | M5 线性扫描,M14 FTS5 降级链 |
| 21 可观测与遥测 | M10 | runID + 结构化日志 + OTLP |
| 22 评测体系 | M4/M11 | M4 元验收,M11 真实 agent A/B |
| 23 审计与证据 | M4/M10 | 验收留痕 + 证据账本 + 交付账本 |
| 24 插件系统与扩展 | M13 | 能力缝插件化 |
| 25 多 Agent/子代理 | M12 | 委派树 + 摘要预算 + 心跳 |
| 26 外部协议(MCP) | M13 | MCP 19 方法(ACP/LSP 后置) |
| 27 消息网关与平台适配 | (后置) | CLI 优先,平台适配器扩展(无专属里程碑) |
| 28 交互形态与用户交互 | M2 | 三档提问 + 6 维盘问 + CLI |
| 29 配置/启动/Profile | M2 | 三来源配置 + 规格书持久化 |
| 30 后台任务/调度/生命周期 | M1/M3 | 崩溃恢复基础(无 cron,后置) |
| 31 基础工具与共享包 | M1 | 路径安全/fs-util/wildcard/token 估算子集 |


---

## 五、面试叙事(产品怎么讲)

**主线故事**:"我做了 4 个 agent 项目的深度分析(127+102+81+53+51 域),提炼出 31 个能力域的完整架构,然后从零写了一个自己的 Agent。它解决的核心问题是——**让 agent 替用户学会,而不是替用户做完**(源码学习产品哲学)。"

**三层叙事**:
1. **工程深度**:事件溯源三支柱/收件箱 DB/归约损坏检测/失败分类学/租约三变体——"我抄了 XXX 的 XX 设计,因为 XX"
2. **产品思考**:23 个真实问题清单(#21 交接/#24 收敛/#25 门禁失效)——"我亲历的失败案例"
3. **范式理解**:Planner/Executor/Evaluator 三组件 vs ReAct 的对照——"我分析过 5 个 agent 项目的循环结构差异"

**差异化**:市面上 agent 替用户做事;产品让用户会做事(费曼测试/留白/渐进代劳)——这是 5 项目都没有的领域层(04 文档)。

---

---

## Review 记录(2026-08-15)

| 轮次 | 发现 | 处理 |
|:--:|------|------|
| r1 | v1 错误定位:31 域切成 🔴16/🟡11/⚪4,亮点(沙箱/子代理/评测/检索/MCP)被后置——"砍功能"违背"5 项目亮点不能丢"铁律 | v2 重写:全量架构零削减 + 里程碑实现顺序 + 岗位对答表 |
| r2 | 与 01 文档交叉核对:跨项目定论 8/10(2 内容在字面缺)、JD 关键词 33/41 | 补强 6 处:Agent Loop 标题/reasoning+Prompt Engineering(06)/意图识别 TaskIntent(10)/向量检索扩展点(20)/遥测契约化+debugging(21)/状态快照确定性回放(16) |
| r3 | 里程碑 14 个 vs 31 能力域:26/26 提及覆盖 | 确认(里程碑是聚合粒度,能力域细节在亮点表) |
| r4 | 数字级亮点核对(29 个关键数字/术语) | 补 8 个:0.85 唯一阈值+keep 8000(05)/3-5-8 收敛阈值(11)/500MB 快照上限(16)/时间预算写 20s-60s-0.5s(19)/goals.py:427(11);1 误报(四隔离已在);2 细节省略(write_origin/RPH 非亮点表粒度) |
| r5 | 里程碑×能力域映射核对(31 域无遗漏) | 新增"能力域→里程碑归属"全映射表:30 域有显式里程碑;1 域(27 消息网关)标注后置无里程碑;里程碑区关键词匹配改为映射表(消除匹配歧义) |

---
## 下一步

- [ ] 用户 review:亮点清单是否完整?里程碑顺序是否合理?
- [ ] 确认后:MVP 技术设计(模块划分/数据模型/接口缝)→ docs/product/03-*
- [ ] 然后:源码学习领域层设计(04-*:域发现方法论工程化/教学叙事/章节组织)
- [ ] 最后:JD 映射文档(05-*:面试附带层)
