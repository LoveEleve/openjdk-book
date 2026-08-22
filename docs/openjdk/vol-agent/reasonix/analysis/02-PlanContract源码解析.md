# Reasonix PlanContract 源码解析：计划如何作为数据契约被执行系统消费

> 解析对象：`internal/plancontract/plan.go`（301 行）
> 定位：Reasonix 第一卷第二份真正源码解析，验证"计划是数据不是 prose"这一哲学在代码层如何落地。
> 关联机制分析：`reasonix/03-Coordinator与PlanContract：Reasonix 如何让规划不再只是 prose.md`

---

## 一、解析对象

- 文件名：`internal/plancontract/plan.go`
- 核心类型：`Plan`、`Step`、`Criterion`、`Assumption`、`Verification`
- 核心函数：`Plan.Normalize()`、`Plan.Validate()`、`normalizeSteps`、`assignStepIDs`、`repairParents`、`repairDependencies`
- 核心不变量：ID/Revision 由 host 分配（`json:"-"`）、计划最多两层、依赖投影成顺序非门控

---

## 二、Plan 数据结构（关键行 17-25）

```go
type Plan struct {
	ID               string       `json:"-"`                     // host 分配，planner 不能提交
	Revision         int          `json:"-"`
	Objective        string       `json:"objective"`
	Assumptions      []Assumption `json:"assumptions,omitempty"`
	NonGoals         []string     `json:"non_goals,omitempty"`
	Steps            []Step       `json:"steps"`
	RequiresApproval bool         `json:"requires_approval,omitempty"`
}
```

关键点：
- **`json:"-"` 是防伪**：ID/Revision 不进入序列化，planner 无法提交一个 host 没盖的身份。
- `RequiresApproval` 是 planner 的请求，不是它的决定——host 的 route 才拥有执行是否 gate 的决策权。

---

## 三、Step / Criterion / Verification（关键行 37-64）

```go
type Step struct {
	ID             string         `json:"id,omitempty"`
	ParentID       string         `json:"parent_id,omitempty"`   // 空 = phase，否则 sub-step
	Title          string         `json:"title"`
	DependsOn      []string       `json:"depends_on,omitempty"`  // advisory；投影成顺序非门控
	VerifiedFiles  []string       `json:"verified_files,omitempty"` // planner 实际读过
	CandidateFiles []string       `json:"candidate_files,omitempty"` // planner 推断
	Acceptance     []Criterion    `json:"acceptance,omitempty"`
	Verification   []Verification `json:"verification,omitempty"`
	Risks          []string       `json:"risks,omitempty"`
}
```

关键点：
- **VerifiedFiles 与 CandidateFiles 分离**：读过的 vs 推断的，猜测不能当事实。
- `DependsOn` 是 advisory：todo 投影是串行的，所以依赖变成顺序，不是门控。
- `Criterion.ID` 也是 `json:"-"`（host 分配），可作证据 key——证据必须能引用判据 ID。

---

## 四、Normalize：可修复的不失败（关键行 69-112）

```
plan.Normalize():
  → 复制 Plan（trim objective / non_goals / assigned ID/Revision≥1）
  → normalizeSteps(steps)
      → 逐 step trim + 丢空 title
      → assignStepIDs()      // 空或重复 id → s<n>
      → assignCriterionIDs() // 空或重复 → c<n>
      → repairParents()      // 把 parent 引用规范化成真正的顶层 phase
      → repairDependencies() // 去自引用/悬空/重复依赖
```

关键点：
- **Normalize 永不失败**：能修的自动修，不能修的留给 Validate 拒绝。
- **assignStepIDs（line 117-142）**：保留 planner 写过的第一个 ID 用法（不破坏 parent/dependency 引用），补空/重复为 `plan_step_%02d`。
- **repairParents（line 178-182）**：normalized 计划必须是字面两层深，`Ordered` 直接读 ParentID 字段，不重新推导。

---

## 五、assignStepIDs 幂等细节（关键行 117-142）

```
assignStepIDs(steps):
  // pass 1: 标记已用 ID
  for each step:
    if id == "" || used[id] → steps[i].ID = ""（标记为待分配）
    else → used[id] = true
  // pass 2: 分配 s<n>
  next = 1
  for each step where ID == "":
    for { id = fmt.Sprintf("plan_step_%02d", next); next++ }
    if !used[id] { steps[i].ID = id; break }
```

关键点：
- 先遍历标记，再分配，避免 `plan_step_01` 与用户已写的 id 冲突。
- 保证"相同标题的步骤保持不同身份"（身份绑 ID 不绑标题）。

---

## 六、repairDependencies 去悬空（关键行 184-204）

```
repairDependencies(steps):
  index = { all step IDs }
  for each step:
    kept = steps[i].DependsOn[:0]        // 复用底层数组
    seen = {}
    for dep in steps[i].DependsOn:
      if dep == s.ID || !index[dep] || seen[dep]:
        continue                          // 去自引用 / 悬空 / 重复
      seen[dep] = true; kept = append(kept, dep)
    if len(kept) == 0 → kept = nil
```

关键点：
- **悬空依赖被清除**：`!index[dep]` → 目标不存在则丢弃。
- 复用底层数组（`[:0]`），无额外分配。

---

## 七、Validate：一次性收集所有缺陷（关键行 208-240）

```
plan.Validate():
  errs = []
  if objective 空 → err
  if steps 空 → err
  if len(steps) > MaxSteps(50) → err     // malformed 而非 merely long
  for each step:
     if title 空 → err
     if id 空 → err
     if id 重复 → err
  for each sibling group:
     if sortSiblings 检测到 cycle → err
  return errors.Join(errs...)             // 一次给全，planner 一轮修完
```

关键点：
- **errors.Join 一次返回全部**：planner 一轮修完，不用每轮修一个。
- **>50 step 是 malformed**：拒绝胜过投影一个静默截断的列表。
- 依赖环检测在 sibling group 内做。

---

## 八、调用链

```
planner（LLM 输出 JSON）
  → Plan（反序列化）
  → Plan.Normalize()             // 修复可修复项
  → Plan.Validate()              // 拒绝剩余缺陷
  → Ordered() / Render() / ProjectTodos() / Diff()（其他文件消费 normalized plan）
```

---

## 九、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 原始计划 | planner 输出 JSON | Normalize | line 17-25 |
| normalized | Normalize | Validate | line 69-112 |
| validated | Validate 无错误 | 可被消费 | line 208-240 |
| 拒绝 | Validate 有错误 | planner 一轮修完重提交 | line 239 |

---

## 十、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 空 title | `title == ""` | 91-93 | 丢弃该 step |
| 空/重复 step ID | `id == "" or used[id]` | 121-123 | 标记待分配 |
| parent 归属 | repairParents 遍历 phaseIDs | 178-182 | 重写 ParentID |
| 悬空依赖 | `!index[dep]` | 192-198 | 丢弃 |
| objective 空 | Validate 检查 | 210-212 | err |
| step 超限 | `len > MaxSteps` | 216-218 | err |
| id 重复 | `seen[id]` | 229-231 | err |

---

## 十一、数据流

```
planner JSON
  → Plan（ID/Revision 是 json:"-" 不序列化）
  → Normalize（trim / 去空 / 分配 ID / 修 parent / 去悬空依赖）
  → Validate（objective / steps / id 唯一 / 环）
  → normalized plan → Ordered / Render / ProjectTodos / Diff 消费
```

- 输入来源：planner（LLM）输出
- 传递路径：反序列化 → Normalize → Validate → 多种消费端
- 输出去向：Ordered（排序）/ Render（用户视图）/ ProjectTodos（执行器任务列表）/ Diff（审批门）

---

## 十二、测试契约

| 测试文件 | 覆盖 |
|----------|------|
| `internal/plancontract/plan_test.go` | Normalize 幂等、Validate 拒绝重复 ID、MaxSteps |
| `internal/plancontract/order_test.go` | 依赖环中步骤不丢失、Ordered 全程（跳过 Normalize 也不丢步骤）|
| `internal/plancontract/project_test.go` | ProjectTodos 稳定 StepIdentity（相同标题不同身份）|
| `internal/plancontract/diff_test.go` | Diff 按身份不按位置 |

---

## 十三、总结

### 核心结论
1. "计划是数据不是 prose"在 PlanContract 里落地为：
   - host 分配 ID/Revision（`json:"-"` 防 planner 伪造）
   - Verified / Candidate 证据分离
   - Normalize（可修复）与 Validate（可拒绝）分离
2. Normalize 永不失败 + Validate 一次收集所有错误，是"能修的自动修，不能修的明确拒绝"的工程化表达。
3. 身份绑定 ID 不绑定标题，保证重计划时不丢完成状态。

### 可迁移点
- "host 分配身份"：任何用户/外部提交的契约对象都应由系统盖章身份，而不是信任提交者。
- "Normalize/Validate 分离（Reasonix 思想）"：先修能修的，再拒绝不能修的，错误一次给全。
- "证据分离（读过的 vs 推断的）"：猜测不能当事实。

### 易错点
- 以为 `json:"-"` 只是序列化细节（其实是 host 身份防伪）。
- 以为 DependsOn 是门控（其实是 advisory，投影成顺序非门控）。
- 以为 50 step 上限只是 soft limit（其实是 malformed 判定）。