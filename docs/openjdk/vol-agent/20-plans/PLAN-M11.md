# 方案:M11 评测(A/B + issue 回归 + 消融)

> 生成:2026-08-18
> 前置:M1-M10 已完成(事件溯源 / 验收门 / 恢复 / 压缩 / 检查点 / 快照归档 / 沙箱策略 / 可观测)
> 定位:把“系统能跑”变成“系统可证明好用”——评测也必须遵守项目四大支柱:真相源、反幻觉、状态机、可恢复

---

## 一、M11 要解决什么

M10 之前,项目回答的是:
- 系统能不能跑?
- 长跑时会不会爆?
- 断了能不能续?
- 发生问题能不能看清?

M11 要回答的是:
- **这些能力到底有没有价值?**
- **哪些改动真的提升了完成率/质量,哪些只是复杂度?**
- **过去修过的大坑,以后会不会再回来?**

所以 M11 不是“再加一个命令”,而是新增一层**评测真相源**:
- 输入:固定任务集(case)
- 执行:隔离运行(agent run)
- 产出:确定性评分(report)
- 复现:同输入 → 同日志结构 → 可回放对比

---

## 二、目标与非目标

### 2.1 目标

M11 第一阶段只做 3 类评测:

1. **A/B 对比**
   - 同模型、同仓库、同 prompt、同预算
   - 对比不同能力开关(如压缩开关 / tiering 开关 / auto vs continue)
   - 证明 M8-M10 的真实收益

2. **issue 回归**
   - 把历史已修问题沉淀成最小可复现评测 case
   - 回归口径以**事件级断言**为主,不是“看起来差不多”

3. **消融实验**
   - 把某个能力关掉,测完成率/阻塞率/checkpoint/compaction 等变化
   - 找出系统真正的价值来源

### 2.2 非目标

第一阶段**不做**:
- 多机/分布式评测调度
- 可视化 dashboard
- LLM-as-a-judge 主评分
- 跨模型排行榜
- 完整容器隔离平台

这些都可以后置。第一阶段重点是:**最小可跑、可复现、可指导工程决策**。

---

## 三、设计原则(和主系统保持一致)

1. **评测也要事件溯源**
   - 每个 case 独立日志目录
   - 评测报告由日志与产物确定性推导,不是手写结论

2. **评测与被测运行必须隔离**
   - case 之间不能共用 `.sca`
   - A/B 两边不能共用日志文件或 book 目录
   - 不能复用脏状态

3. **评分必须确定性**
   - 只读 `chapter.completed / book.completed / chapter.blocked / acceptance.recorded / compaction.* / checkpoint / sandbox.decided`
   - 不引入第二个 LLM judge,避免评测层本身幻觉

4. **失败必须可分类**
   - 优先复用 `acceptance.recorded.failures_classified`
   - 聚合 fabrication / instruction_drift / context_amnesia / missing_evidence / teaching_gap / reader_mismatch(预留)

5. **A/B 必须可复现**
   - 冻结 repo 路径、prompt、运行模式、预算、日志目录
   - 报告必须能指出两边各自的 run_id 与日志位置

6. **fail-closed**
   - case schema 无效、观测损坏、报告写失败、混跑污染 → 直接失败,不生成“看似正常”的结果

---

## 四、目录与模块

```
src/eval/
├── schema.ts    # case/suite/AB 数据契约 + 校验
├── runner.ts    # 隔离运行:单 case / A/B case 执行
├── scorer.ts    # 从事件与产物做确定性评分
├── report.ts    # JSON 报告组装与写出
└── ab.ts        # A/B 汇总与 delta 计算

tests/
├── eval-schema.test.ts
├── eval-runner.test.ts
├── eval-scorer.test.ts
└── eval-ab.test.ts
```

CLI:
- `sca eval <plan.json>`

文档:
- `PLAN-M11.md`（本文件）

---

## 五、case schema 设计

### 5.1 单 case

```json
{
  "version": 1,
  "name": "smoke-tiny",
  "mode": "single",
  "repo": "/abs/path/to/repo",
  "prompt": "帮我分析 tiny.py 的调度实现",
  "workdir": "/abs/path/to/repo",
  "log_path": "/abs/path/to/out/smoke/.sca/events.jsonl",
  "run": {
    "entry": "align",
    "max_turns_per_chapter": 6,
    "context_budget": 2000,
    "checkpoint_enabled": true,
    "recovery_window_ms": 30000
  },
  "expect": {
    "min_completed_chapters": 1,
    "max_blocked": 0,
    "require_book_completed": false,
    "max_checkpoints": 1,
    "max_compaction_rejected": 2,
    "max_sandbox_denied": 0,
    "require_acceptance_pass": true
  }
}
```

### 5.2 A/B case

```json
{
  "version": 1,
  "name": "ab-tiering",
  "mode": "ab",
  "repo": "/abs/path/to/repo",
  "prompt": "帮我分析 XXX 源码",
  "variants": {
    "a": { "run": { "context_budget": 4000, "checkpoint_enabled": true, "compaction_enabled": true } },
    "b": { "run": { "context_budget": 4000, "checkpoint_enabled": true, "compaction_enabled": false } }
  },
  "expect": {
    "compare": "completed_then_blocked_then_checkpoints"
  }
}
```

### 5.3 regression case

regression 仍然可以复用 `single`,只是 `tags` 包含历史 bug 主题:
- `empty-summary`
- `blocked-no-checkpoint`
- `archive-tail-gap`
- `mixed-runs`
- `tool-call-grouping`
- `warm-empty-no-llm`

重点不在 mode,而在**断言口径固定**。

---

## 六、runner 设计(最关键)

### 6.1 为什么 runner 必须先做

如果没有隔离 runner:
- case 之间会串日志
- A/B 两边会污染同一 `.sca`
- 结果无法复现
- 回归失败无法最小定位

所以 M11 的第一优先级不是报表,而是 runner。

### 6.2 runner 责任

单 case runner 要做 6 件事:

1. 校验 repo/workdir/log_path 都是绝对路径
2. 创建独立输出目录(含 `.sca/` 父目录)
3. 生成独立 `run_id`
4. 用固定 `EventLog(runId)` 执行一次任务
5. 读取观测事件与恢复状态
6. 产出 `EvalRunResult`

### 6.3 被测入口

第一阶段不直接 fork CLI 进程,而是复用已有库级入口:
- `align(...)`
- `runBook(...)`
- `resumeBook(...)`
- `readObservableEvents(...)`
- `diagnostics(...)`

这样更稳定、更可测,也避免 shell 层额外不确定性。

### 6.4 运行模式

`run.entry` 第一阶段只支持:
- `align`:从 prompt 开始完整跑一次
- `continue`:从既有日志恢复继续跑一次
- `auto`:同进程自动续跑,直到一次返回

后续若要做真实 CLI 黑盒评测,再单独加 subprocess runner。

---

## 七、scorer 设计(确定性评分)

### 7.1 评分输入

- observable events(主日志 + archive)
- diagnostics
- loadBook state
- 章节验收事件 `acceptance.recorded`

### 7.2 评分输出

分成 3 层:

1. **结果指标**
   - completedChapters
   - blocked
   - bookCompleted
   - acceptancePass

2. **质量指标**
   - acceptance pass/fail 次数
   - 失败分类分布
   - evidence 缺失比例
   - teaching gap 次数
   - reader mismatch 次数(先预留字段)

3. **过程指标**
   - checkpoints
   - compaction.started/completed/rejected
   - sandbox.allowed/denied/auditFailed
   - mixedRuns
   - lastSeq
   - runIds

### 7.3 判定规则

一个 case `pass` 的最低条件:
- 观测无损坏
- `blocked <= max_blocked`
- `completedChapters >= min_completed_chapters`
- 若要求验收通过,则至少一条 `acceptance.recorded.ok=true`
- 若要求成书,则存在 `book.completed`
- 各过程指标不超过阈值

评分失败要返回**明确 reason 列表**,不能只有布尔值。

---

## 八、A/B 对比设计

### 8.1 第一阶段只做“同模型能力开关对比”

推荐顺序:
1. `compaction_enabled: true/false`
2. `checkpoint_enabled: true/false`
3. `context_budget: 小/大`
4. `entry: continue vs auto`
5. `sandbox policy: read-only vs workspace-write`(主要做 deny 行为统计)

### 8.2 delta 指标

A/B 汇总至少给出:
- `completedDelta`
- `blockedDelta`
- `checkpointDelta`
- `compactionRejectedDelta`
- `sandboxDeniedDelta`
- `acceptancePassDelta`

同时保留双方原始分数,不只给 delta。

### 8.3 比较顺序

第一阶段比较器使用固定排序:
1. 完成章数高者优
2. blocked 少者优
3. acceptance pass 多者优
4. checkpoint 少者优
5. compaction rejected 少者优

这不是“真理”,只是当前工程阶段的实用排序。

---

## 九、回归集(regression pack)

M11 的长期价值很大一部分来自 regression pack。

建议第一批纳入 6 类历史问题:

1. **empty_summary**
   - 空摘要绝不算成功
   - 断言:出现 `compaction.rejected(reason=empty_summary)` 而不是 completed

2. **blocked_checkpoint_signal**
   - blocked + 超预算时必须触发 checkpoint 路径
   - 断言:有 `chapter.checkpoint` 或最终 `chapter.blocked` 超限路径正确

3. **archive_tail_gap**
   - 只归档 `seq <= snapshotSeq`
   - 断言:恢复后无 `seq_gap`

4. **mixed_runs_diagnostics**
   - 混合 run_id 必须被诊断出来
   - 断言:`diagnostics.mixedRuns=true`

5. **tool_call_grouping**
   - tool-call 组不能拆层
   - 断言:压缩后协议合法,结果数匹配

6. **warm_empty_no_llm**
   - warm 空时不能调用 LLM 摘要
   - 断言:无 `compaction.started/completed`,走 hot-only

这些 case 不是替代单元测试,而是把“历史坑”上升成产品级评测资产。

---

## 十、与现有模块的关系

M11 不应该重写已有逻辑,而是复用现有能力:

- 运行入口: `spec/align.ts`, `cli/book-flow.ts`
- 恢复入口: `session/resume.ts`
- 观测入口: `observability.ts`
- 事件契约: `types/event.ts`
- 验收结论: `acceptance/ledger.ts`, `acceptance/gate.ts`

特别注意:
- `reader_mismatch` 目前还是 TODO,所以 M11 第一版要给该指标留空位,不能伪装“完整质量评测已完成”

---

## 十一、测试策略

第一阶段测试重点:

1. **schema test**
   - 缺字段/相对路径/非法 mode 直接拒绝

2. **runner test**
   - 单 case 会写独立日志
   - A/B 两边 run_id 与 logPath 不同
   - 观测损坏时 fail-closed

3. **scorer test**
   - 从固定事件流算出正确分数
   - 阈值失败能返回 reasons
   - mixedRuns 会降为 fail

4. **ab test**
   - 两边结果能正确算 delta 与 winner

---

## 十二、实施顺序

按这个顺序做,不要倒:

1. `PLAN-M11.md`(定口径)
2. `src/eval/schema.ts`
3. `src/eval/runner.ts`
4. `src/eval/scorer.ts`
5. `src/eval/report.ts`
6. `src/eval/ab.ts`
7. `sca eval <plan.json>`
8. `tests/eval*.test.ts`
9. 首批 smoke / regression case 数据

原因:
- 先有 schema 才能防漂移
- 先有 runner 才能谈复现
- 先有 scorer 才能谈 A/B
- 首批 case 数据应该最后写,否则 schema 还会反复改

---

## 十三、第一阶段完成标准

M11 第一阶段算完成,至少要满足:

- 能运行 `sca eval <plan.json>`
- 支持 `single` 与 `ab` 两种模式
- 输出确定性 JSON 报告
- 报告包含结果/质量/过程三层指标
- 失败会给出明确 reasons
- 至少 1 个 smoke case + 2 个 regression case 能跑
- 单测和类型检查全绿

---

## 十四、诚实边界

1. 第一阶段评测仍主要依赖 mock / 小仓库,不能等价于真实超大仓结果
2. 不做 LLM judge 意味着“教学质量”仍以现有 gate 指标为主,不是完整人类主观体验
3. `reader_mismatch` 未落地前,质量评测维度仍缺一角
4. M11 证明的是“这套系统相对自身基线更好/更稳”,不是“已超过所有外部 Agent”

---

## 十五、下一步(本次实现)

- [x] 落 `src/eval/` 最小骨架
- [x] 接 `sca eval <plan.json>`
- [x] 补 `tests/eval*.test.ts`
- [x] 先用 mock provider 跑通 single / ab / fail-closed
- [x] 真实 provider 小仓验证、续跑与观测
- [x] 独立 evaluator 与 learning signal(确定性 evaluator + `evaluation.recorded` / `learning.signal` 事件 + 基础测试)
- [x] Fact / Mechanism / Failure 数据模型与事件回放 store(项目隔离、canonical 去重、完整校验、损坏 fail-closed)
- [x] 通用项目侦察、入口候选与机制 lens 发现(统一递归扫描、生产/测试分层、根目录入口、上下文证据、README 线索、生命周期/事件循环/状态机/数据结构/管线/并发/持久化/扩展点 + `project.detected`/`entrypoint.proposed`/`mechanism.candidate`/`discovery.snapshot` 事件回放、项目隔离与幂等替换)
- [x] 通用机制图谱与候选晋升边界（稳定 mechanism_key、跨项目聚合、双端证据关系、真实 FactAsset 引用、verified 晋升、专用 promoted 事件、重启回放、编排幂等）
- [x] smoke case + 2+ regression case + suite 资产可被 schema/报告/回归测试直接消费
- [x] 产品级回归覆盖事件链、真实小仓、partial report、mixed-runs、compaction rejected、checkpoint signal、archive tail gap、auto/continue 续跑
- [ ] 通用机制图谱与事实/机制/失败分层的完整跨项目投影
- [ ] 技能 candidate/shadow/active 生命周期
- [ ] 素材 → 理解路径 → 分节写作 → 多维审计

---

## 十六、M11 之后的真正方向：通用自学习闭环

### 16.1 不做项目专属 Agent

OpenJDK、Redis、Spring、Netty 只是验证样本,不是四套实现目标。核心 Agent 不应硬编码:

- JVM/GC/safepoint
- Redis/AOF/事件循环
- Spring/Bean 生命周期
- Netty/ChannelPipeline/ByteBuf

核心只识别通用机制 lens:

- 生命周期
- 入口与调用链
- 状态机
- 事件循环
- 数据结构
- 管线
- 并发与所有权
- 持久化/恢复
- 扩展点

项目类型只能用于排序和提示,不能决定分析逻辑。

### 16.2 四种学习资产必须分离

```text
Fact       当前项目/版本的可核验事实
Mechanism  跨项目可迁移的机制抽象
Skill      下一次任务可执行的分析程序
Failure    某种分析/写作方式失败的经验
```

Fact 必须绑定 `project/version/evidence`；Mechanism 只能提供类比候选；Skill 必须经过 shadow 评测；Failure 以低权威背景注入,不得覆盖当前任务事实。

### 16.3 五个参考产品如何降低实现难度

5 个参考产品已经分别验证了很多目标能力,因此我们不是从零发明:

| 参考产品 | 可复用的设计证据 | 在 sca 的落点 |
|---|---|---|
| Reasonix | 独立 Goaleval、BoundedLLM、Memory/History、失败分类、技能与 PlanContract | 独立 evaluator、学习信号、记忆写门、计划契约 |
| Hermes | 背景审查 fork、学习图谱、技能三态、记忆双态、写门控 | shadow skill、curator、learning graph、冻结/活态记忆 |
| Pi | session facts、技能加载、可复现 transcript、局部修订 | facts 投影、技能发现、分节修订、回放 |
| OpenCode | skill discovery、上下文注入、session 状态、工具权限 | 能力注册、低权威注入、状态恢复、工具边界 |
| dsh | 能力注册表、工具管线、feedback、provider/consumer seam | capability registry、学习反馈、provider 抽象 |

这会显著降低探索成本,但不等于简单拼装。每个设计都要重新适配事件溯源、源码学习场景、证据门和单书长跑。

### 16.4 自学习生命周期

```text
candidate → shadow → active → stale → archived
```

- `candidate`:单次任务发现的新方法
- `shadow`:后台独立试跑,不影响主流程
- `active`:跨多个任务/机制验证有效
- `stale`:源码版本、证据或适用条件变化
- `archived`:连续失败或被新技能替代

禁止“运行一次就自动改 system prompt”。学习结果必须先形成事件和信号,再经独立 curator 与回归评测晋升。

### 16.5 通用源码学习闭环

```text
项目侦察
→ 入口/机制候选
→ 事实素材提取
→ 实验与证据验证
→ 理解路径/大纲
→ 分节写作
→ 确定性审计 + 独立 evaluator
→ 局部修订
→ Fact/Mechanism/Skill/Failure 沉淀
→ 下一任务召回与 shadow 验证
```

OpenJDK 的 `WRITING-GUIDELINES.md` 是外部 writing contract；没有指南时,使用通用默认规则并从评测反馈中发现候选方法论。两者都不能替代通用内核。

### 16.6 后续里程碑

```text
M11.1 独立 evaluator + learning signal
M11.2 Fact / Mechanism / Failure 数据模型
M11.3 通用项目侦察与机制图谱
M12.1 Memory retrieval/freshness/write-gate
M12.2 Skill candidate/shadow/active/curator
M13.1 素材与 understanding path
M13.2 分节写作与多维审计
M14   OpenJDK/Redis/Spring/Netty 跨项目验证与大仓
```

最终验收不是“某个项目文章像不像”,而是:

- 第二个同类项目能复用机制技能
- 新项目不会继承其他项目的事实
- 版本变化会让旧事实 stale
- 人工反馈能影响下一轮
- 失败经验能降低同类错误
- 删除代码后文章仍然成立
