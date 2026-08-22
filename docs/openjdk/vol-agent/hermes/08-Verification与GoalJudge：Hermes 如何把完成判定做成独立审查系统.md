# Verification 与 GoalJudge：Hermes 如何把完成判定做成独立审查系统

> 项目：Hermes（main 基线）
> 角色：主线机制正文 07
> 对应范围规划：`01-Hermes源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq7-verification-quality.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq18-goal-judge.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AIAgent主循环：Hermes 如何组织 turn、工具批与长期运行.md`
  2. `05-Memory与Skills：Hermes 为什么把学习闭环做成系统主线.md`
  3. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `agent/verify/`
  2. `agent/verification_evidence.py`
  3. `hermes_cli/goals.py`
  4. `agent/verification_stop.py`
  5. `agent/kanban_stop.py`
  6. `tools/kanban_tools.py`

## 一、这一章真正的问题

Hermes 已经有了执行骨架、学习闭环和边界控制，但它还缺一个关键能力：

> **系统怎么知道自己“完成了”？**

这一章真正要回答的是：

1. 为什么完成判定不能靠模型自己宣布？
2. 为什么 Hermes 需要一套完整的验证系统（verify runner + 证据账本 + GoalJudge + 守卫族）？
3. 为什么独立审查器即使 fail-open 也要有界？

---

## 二、先给结论：Hermes 的验证系统不是“一个 verify 命令”，而是“验证执行 + 证据留痕 + 目标判定 + 守卫族”四层结构

最容易犯的错，是把 Hermes 的验证系统理解成：
- 一个 verify 命令
- 跑几个检查
- 完成

这太浅了。

更准确的理解是：

> **Hermes 把验证、证据留存、完成判定和停止守卫统一成了一套不可绕过、可审计、可扩展的验收系统。**

所以这章的主角不是某个 verify 命令，而是：
- Recipe 检测
- 验证执行与就绪轮询
- 证据账本
- GoalGate
- GoalJudge
- verification_stop
- kanban_stop

---

## 三、为什么 Recipe 检测不是简单“项目检查”

Hermes 的 verify 系统不是随手写的项目检查脚本。

它有一个配方系统（Recipe），能检测：
- Node（lockfile → 包管理器 → 框架）
- Python（Django / FastAPI / uv / poetry / pipenv）
- Go / Rust / Java（Maven / Gradle）
- Makefile / docker-compose

而且它是分层合并的：
- 运行时 recipe 拥有深度检测（框架、启动命令、端口、就绪轮询）
- 代码上下文的 project-facts 拥有验证命令

这说明 Hermes 的验证系统不是在“临时跑一个脚本”，而是在：
> **项目级别的结构化验证。**

---

## 四、为什么证据账本是有边界的

Hermes 的 `verification_evidence.py` 有以下有界特征：
- MAX_OUTPUT_SUMMARY_CHARS = 2000
- MAX_EVIDENCE_AGE_DAYS = 30
- MAX_EVENTS_PER_SESSION_ROOT = 100
- MAX_TOTAL = 10000
- fail-silent：账本问题绝不改变 CLI 退出码

这说明 Hermes 在构建一个“可审计但不可无限膨胀”的验证证据系统。

它不追求“保留所有证据”，而是追求：
> **证据有界、可审计，但账本失败绝不干扰主流程。**

---

## 五、为什么 GoalGate 被设计成“门先于判定”

Hermes 在 `goals.py` 里有一个组件叫 `GoalGate`，核心设计是：

> **确定性 shell 命令在 LLM 完成声明前必须通过。**

如果门失败：
- 输出被截断，回注给 LLM
- LLM 基于具体证据继续迭代
- 如果工作区没有变化（git 指纹匹配），就不重跑，直接重放失败

这说明 GoalGate 在做的是：
> **在模型宣布“完成”之前，先用确定性验证过滤一遍。**

这和 model 自己宣布完成完全不同。

---

## 六、为什么 GoalJudge 是独立审查器，而不是模型自己判

Hermes 的 `judge_goal` 被设计成：
- 由 auxiliary 模型独立调用
- 输入：goal + last_response + 可选 contract / subgoals / background_processes
- 输出：verdict（done / continue / wait / skipped）
- 温度 0，固定 prompt，可复现

这完全符合我们在 Reasonix 里看到的独立审查器模式：

| 维度 | Reasonix Goaleval | Hermes GoalJudge |
|------|-------------------|-------------------|
| 独立性 | 四隔离 | auxiliary 独立调用 |
| 输出 | 四 outcome | 四态 verdict |
| 失败 | fail-closed | fail-open + 自动暂停 |

而且 Hermes 的 GoalJudge 特有：
- contract 严格判定（Verification 判 DONE，Constraint 违反拒绝）
- wait 停泊（pid/seconds）
- 失败两轴分类（parse vs transport）

---

## 七、为什么失败语义要分 parse 和 transport 两轴

Hermes 在 GoalJudge 里明确区分：

### parse_failed
- judge 调用成功，但输出不可用
- 暗示：弱 judge 模型
- 连续 3 次自动暂停

### transport_failed
- judge 根本够不到 API
- 暗示：永久配置问题
- 连续 5 次自动暂停

而且这两个计数互不干扰：
- 网络抖动不会误触弱模型暂停
- 弱模型不会误触配置问题暂停

这个设计非常成熟，因为它提供了：
> **可诊断的失败分类。**

---

## 八、为什么 fail-open 有界比 fail-closed 更适合验收场景

Hermes 的 GoalJudge 选择 fail-open，而不是 fail-closed。

这意味着：
- judge 不可用时，默认 continue
- 有界：连续 N 次自动暂停

这不同于 Reasonix 的 fail-closed（不可用时默认暂停）。

为什么 Hermes 选择 fail-open？
因为验收场景中：
- 如果 judge 不可用就卡死所有任务，代价太高
- 更合理的做法是：暂时继续，但自动暂停防止无限循环

所以不是 fail-open 和 fail-closed 哪个更好，而是：
> **验收场景更适合有界 fail-open，执行场景更适合 fail-closed。**

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何让项目验证进入系统主线
Hermes 的解法：Recipe 检测 + 分层合并 + 就绪轮询

### 2. 如何让验证结果可审计但不无限膨胀
Hermes 的解法：验证证据账本 + 有界策略 + fail-silent

### 3. 如何让“完成声明”先经过确定性验证关卡
Hermes 的解法：GoalGate（门先于判定）

### 4. 如何让完成判定独立于执行器
Hermes 的解法：GoalJudge（auxiliary 模型独立审查器）

### 5. 如何让验收失败不卡死系统
Hermes 的解法：fail-open + 两轴自动暂停

所以这章真正要学的，不是“验证命令很多”，而是：

> **Hermes 如何把验证、证据、判定和守卫统一成一个不可绕过的验收系统。**

---

## 十、读者最容易学错的地方

### 错觉 1：verify 就是跑几个检查脚本
错。它是 Recipe 驱动的分层验证系统。

### 错觉 2：证据账本应该保留所有证据
错。Hermes 明确有界。

### 错觉 3：GoalGate 只是验证门
错。它是“门先于判定”的核心组件。

### 错觉 4：GoalJudge 可以用主模型代替
错。它是独立审查器，必须和执行器隔离。

### 错觉 5：fail-open 就是无限继续
错。Hermes 有界——连续 N 次自动暂停。

---

## 十一、分析边界

### 为什么这里不先展开所有 Recipe 实现
因为第一轮先看验证系统的整体结构，而不是每个 Recipe 的具体检测逻辑。

### 为什么这里要同时讲 GoalGate 和 GoalJudge
因为它们共同构成“验证门 + 独立审查器”的验收主线。

### 为什么守卫族（verification_stop / kanban_stop）要进主线
因为它们不是辅助功能，而是“完成声明”的强制约束条件。

---

## 十二、读者分层路由

### beginner
先抓住：
1. 完成判定不能靠模型自己宣布
2. GoalGate 门先于判定
3. GoalJudge 是独立审查器

### intermediate
重点看：
- Recipe 检测和分层合并
- 证据账本有界策略
- GoalGate 指纹逻辑
- GoalJudge 四态 verdict

### advanced
重点看：
- 失败两轴分类（parse vs transport）
- fail-open vs fail-closed 的适用场景
- GoalContract 严格判定
- 守卫族的三层结构

---

## 十三、迁移清单

### 可迁移思想 1：验证 Recipe 分层
- 可迁移到：任何需要结构化项目验证的 Agent
- 前提：系统能做静态项目分析
- 不适合直接照搬到：无项目的纯工具 Agent

### 可迁移思想 2：门先于判定
- 可迁移到：任何需要“先验证、再宣布完成”的场景
- 前提：验证是可执行的确定性命令
- 不适合直接照搬到：纯主观创作任务

### 可迁移思想 3：独立审查器
- 可迁移到：任何需要客观完成判定的系统
- 前提：能承受 auxiliary 调用成本
- 不适合直接照搬到：成本敏感、评判简易的系统

### 可迁移思想 4：有界 fail-open
- 可迁移到：验收场景
- 前提：继续比暂停的代价低
- 不适合直接照搬到：执行场景（应该用 fail-closed）

---

## 十四、自测问题

1. 为什么 Hermes 的验证系统不是“一个 verify 命令”，而是四层结构？
2. 为什么 GoalGate 被设计成“门先于判定”？
3. 为什么 GoalJudge 是独立审查器，而不是主模型自己判？
4. 为什么失败语义要分 parse 和 transport 两轴？
5. 为什么验收场景更适合 fail-open 有界，而不是 fail-closed？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Hermes 为什么需要验证系统，而不是让模型自己宣布完成。
2. 说清 Recipe 检测、证据账本、GoalGate、GoalJudge 各自的角色。
3. 理解为什么独立审查器必须独立于执行器。
4. 理解为什么验收场景更适合 fail-open 有界。
5. 用自己的话说明：Hermes 为什么比很多 Agent 项目更接近“可验收、可审计、可判定”的代理系统。

如果还做不到这些，就说明这章还没真正学懂。