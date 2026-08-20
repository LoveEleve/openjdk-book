# M16 真实大仓验证与领域层主链收口

> 日期：2026-08-19
> 承接：M15 领域层增强完成
> 状态：规划中

## 一、目标

M16 不再新增领域概念，重点验证并收口已有能力：

1. 在真实大仓上验证完整章节链路。
2. 将类比轨、考点地图、多视角、时空溯源从提示增强升级为可验收的章节产物。
3. 控制领域层计算、git 查询和上下文注入的性能。
4. 建立可重复的 M16 验证报告和失败分类。

## 二、阶段划分

### 阶段 A：大仓验证基线

验证目标：使用 `jdk11u` 或同等规模仓库，完成入口发现、机制发现、章节执行、写作审计和书级收口。

任务：

- 固定仓库 revision、运行配置、模型配置和输出目录。
- 记录仓库规模：文件数、源码行数、项目数、入口数、机制候选数。
- 运行至少 3 个代表章节：核心机制、并发/存储机制、失败路径。
- 运行一次 `--continue` 和一次 `--auto`，确认领域层状态可恢复。
- 记录每章的 turns、tool calls、领域层耗时、git 查询次数、上下文增量和最终审计结果。

验收：

- 大仓运行不因领域层异常中断。
- 每章的 guidance 能追溯到当前章节 KP 或证据。
- 领域层失败时降级，不伪造成功结果。
- 运行结束生成结构化验证报告。

### 阶段 B：主链消费收口

#### B1：类比轨

- 只注入与当前章节机制相关的 anchors。
- 每个 anchor 必须包含 source、target、共同思想、similarity 和 evidence。
- `similarity` 低于阈值时不得进入正文指导。
- 验收中增加 analogy evidence 对账，检查引用机制和证据存在。

#### B2：考点地图

- 从当前章节 mechanisms、KP 和目标 `interview` 生成考点。
- 章节计划保存 point ids，而不是只拼文本。
- 每个考点必须有 mechanism ids、JD keyword、difficulty。
- 面试问题必须与考点绑定，不能生成全局泛问题。
- 非 interview 目标不强制生成面试弹药。

#### B3：多视角

- 仅对规格书选择的 views 生成内容。
- 视角内容必须包含 supporting signals 和 evidence。
- 章节上下文只注入当前章节相关 mechanism 的视角内容。
- 验收检查选择的 view 是否都有对应产物，未选择的 view 不得混入。

#### B4：时空溯源

- 仅对深度 A 章节强制生成。
- 文件必须来自当前章节机制关联的证据。
- 每个 timeline event 必须有 commit hash 或明确降级原因。
- `git show` 变更必须能映射到 commit。
- 非 git 仓库、浅克隆和无历史文件必须可解释降级。

### 阶段 C：性能与缓存

任务：

- 增加章节级领域层缓存，缓存键包含项目 revision、chapter id、KP、views 和目标。
- `git-evolution` 缓存 blame、log、show 结果，限制单文件提交数和总变更量。
- 对 analogy、exam-map 和 perspective 去重，避免同一章重复计算。
- 记录领域层耗时，并设置软预算；超过预算时降级而非阻塞章节。
- 使用大仓 fixture 做基准：冷缓存、热缓存、无 git 三种路径。

验收：

- 热缓存路径明显低于冷缓存路径。
- 领域层超预算不会阻塞主循环。
- 大仓单章领域层不会无限增长上下文。

### 阶段 D：报告与文档

任务：

- 创建 M16 验证报告格式。
- 更新 `HANDOVER.md` 的 M16 状态和测试基线。
- 创建 `HANDOVER-session014.md`，记录真实大仓结果、失败和降级。
- 不把未验证的 jdk11u 结果写成已完成。

## 三、建议新增文件

| 文件 | 用途 |
|------|------|
| `src/learning/domain-guidance.ts` | 统一领域层装配、过滤、计时和降级 |
| `src/learning/domain-cache.ts` | 章节级领域层缓存 |
| `src/eval/large-repo.ts` | 大仓验证入口与指标收集 |
| `tests/learning-domain-guidance.test.ts` | 主链消费和相关性测试 |
| `tests/learning-domain-cache.test.ts` | 缓存键、失效和降级测试 |
| `tests/eval-large-repo.test.ts` | 大仓验证报告测试 |
| `evals/large-repo-plan.json` | 可重复的大仓验证计划 |
| `docs/progress/REPORT-M16.md` | M16 验证结果 |

## 四、关键不变量

1. 领域层只能补充证据和结构，不能覆盖规格书约束。
2. 没有证据的 analogy、exam point、perspective、timeline 不进入强制正文。
3. 所有跨项目关联必须保留 project ids，不能把不同项目的事实混为一谈。
4. Git 历史不可用时必须显式标记降级，不得生成虚假时间线。
5. 领域层失败属于可观测降级，不得静默伪装成成功。
6. 缓存必须按 revision 和章节输入失效，不能复用旧项目结果。
7. `interview` 目标才强制消费考点地图和面试问题。
8. 深度 A 才强制时空溯源，其他深度保持可选。

## 五、实施顺序

1. 先建立 `domain-guidance.ts`，收口 book-flow 中分散的领域层装配逻辑。
2. 添加相关性过滤和证据对账测试。
3. 接入章节级缓存和耗时指标。
4. 建立大仓验证计划与报告。
5. 在真实大仓上运行冷/热缓存和 continue/auto 验证。
6. 根据结果修复性能或降级问题。
7. 最后更新 HANDOVER 文档，不提前宣称 M16 完成。

## 六、完成标准

M16 只有同时满足以下条件才能标记完成：

- `bun test`、`bunx tsc --noEmit`、`git diff --check` 全部通过。
- 至少一次真实大仓完整运行，且结果可复现。
- 至少 3 个章节完成领域层主链消费验证。
- continue/auto 至少各验证一次。
- 冷缓存、热缓存、无 git 降级路径都有测试。
- analogy、exam-map、perspective、git-evolution 都有证据和相关性对账。
- 有明确的失败、降级和性能数据报告。
