# vol-agent 文档迁移清单

> 目标：把“源码学习 Agent 的产品资产 / 方法论 / 总规划”从 `Source-Code-Agent` 项目内抽离，沉淀到 `vol-agent/` 下，避免产品知识与单仓实现强耦合。

---

## 一、迁移原则

### 1. 应迁
满足以下任一条件的文档，优先迁入 `vol-agent/`：
- 描述的是**源码学习 Agent 产品本身**，不是当前实现仓库的细节。
- 来自对 5 个 Agent 项目的综合分析与对账。
- 定义了产品级方法论、路线图、能力域、痛点模型、领域层设计。
- 后续会被多个实现项目复用，而不仅仅是 `Source-Code-Agent`。

### 2. 可选迁
- 既包含产品思想，也包含当前实现细节。
- 可先在 `vol-agent/` 保留副本，原仓库继续保留实现导向版本。

### 3. 不建议迁
- 明显属于 `Source-Code-Agent` 这个仓库自己的实现过程记录。
- 施工日志、交接日志、分 milestone 的细碎实现记录。

---

## 二、第一批建议迁移（核心 7 份）

### 1. `docs/product/01-agent-engine-capabilities.md`
- **定位**：5 个 Agent 项目能力全景总表
- **判断**：强烈建议迁
- **原因**：它是 `vol-agent/` 的上层知识基座，而不是当前实现说明
- **建议迁移目标**：
  - `vol-agent/10-product/01-agent-engine-capabilities.md`

### 2. `docs/product/02-mvp-scope.md`
- **定位**：总路线图、能力域→里程碑映射
- **判断**：强烈建议迁
- **原因**：这是整个源码学习 Agent 产品的路线图，不应只附着在一个实现仓库里
- **建议迁移目标**：
  - `vol-agent/10-product/02-mvp-scope.md`

### 3. `docs/product/03-需求覆盖矩阵.md`
- **定位**：需求 → 规划映射
- **判断**：强烈建议迁
- **原因**：它解释了产品为什么这样设计，是产品总知识的一部分
- **建议迁移目标**：
  - `vol-agent/10-product/03-需求覆盖矩阵.md`

### 4. `docs/product/04-领域层设计.md`
- **定位**：源码学习领域层产品灵魂
- **判断**：强烈建议迁
- **原因**：这是整个产品的差异化核心，必须从实现仓库抽出来
- **建议迁移目标**：
  - `vol-agent/10-product/04-领域层设计.md`

### 5. `docs/product/05-数据契约.md`
- **定位**：产品级数据契约 / Schema
- **判断**：建议迁
- **原因**：后续若有多个实现/子系统，会共享这层契约
- **建议迁移目标**：
  - `vol-agent/10-product/05-数据契约.md`

### 6. `docs/product/06-系统技术设计.md`
- **定位**：系统蓝图
- **判断**：建议迁
- **原因**：虽然更偏实现，但已经是上层产品架构，不只是当前工程 README
- **建议迁移目标**：
  - `vol-agent/10-product/06-系统技术设计.md`

### 7. `docs/progress/PLAN-M16.0-双层痛点求解器.md`
- **定位**：最新的产品级总规划
- **判断**：强烈建议迁
- **原因**：已经超出当前仓库内部规划，适合作为 `vol-agent` 总规划主文档
- **建议迁移目标**：
  - `vol-agent/20-plans/PLAN-M16.0-双层痛点求解器.md`

---

## 三、第二批可选迁移

### 1. `docs/architecture/ARCHITECTURE.md`
- **判断**：可选迁
- **原因**：如果 `vol-agent/` 要承载“产品总架构”，则应迁；如果只想保留当前实现解释，则可留在原仓库
- **建议目标**：
  - `vol-agent/30-architecture/ARCHITECTURE.md`

### 2. `docs/progress/PLAN-M11.md`
- **判断**：可选迁
- **原因**：评测体系是产品重要组成，但也与当前实现深度绑定
- **建议目标**：
  - `vol-agent/20-plans/PLAN-M11.md`

### 3. `docs/progress/PLAN-M14.md`
- **判断**：可选迁
- **原因**：大仓/存储/检索/租约规划，对上层也有价值
- **建议目标**：
  - `vol-agent/20-plans/PLAN-M14.md`

### 4. `docs/progress/PLAN-M15.md`
- **判断**：可选迁
- **原因**：领域层增强过程对后续 5 Agent 反向分析有参考价值
- **建议目标**：
  - `vol-agent/20-plans/PLAN-M15.md`

### 5. `docs/progress/PLAN-M16.md`
- **判断**：可选迁
- **原因**：真实大仓验证与主链收口规划，适合作为产品验证层文档
- **建议目标**：
  - `vol-agent/20-plans/PLAN-M16.md`

### 6. `docs/progress/REVIEW-M14.md`
- **判断**：可选迁
- **原因**：它是一次系统性复盘，既可留原仓，也可迁副本到 `vol-agent/`
- **建议目标**：
  - `vol-agent/40-review/REVIEW-M14.md`

---

## 四、不建议迁移（留在 Source-Code-Agent 更合理）

### 1. `docs/architecture/SOURCE-CODE-WALKTHROUGH.md`
- **原因**：逐文件逐函数讲当前仓库实现，属于实现仓库自身文档

### 2. `docs/progress/HANDOVER.md`
- **原因**：当前实现项目的权威进度文档

### 3. `docs/progress/HANDOVER-session004.md` ~ `HANDOVER-session013.md`
- **原因**：属于施工日志 / 会话交接记录，不适合作为产品总资产

### 4. `docs/progress/PLAN-M8.6-M8.7.md`
- **原因**：历史实现细节较强，价值更多在当前仓库内部

---

## 五、建议的 vol-agent 目录结构

```text
vol-agent/
├── 00-源码学习痛点.md
├── 01-docs-迁移清单.md
├── 10-product/
│   ├── 01-agent-engine-capabilities.md
│   ├── 02-mvp-scope.md
│   ├── 03-需求覆盖矩阵.md
│   ├── 04-领域层设计.md
│   ├── 05-数据契约.md
│   └── 06-系统技术设计.md
├── 20-plans/
│   ├── PLAN-M11.md
│   ├── PLAN-M14.md
│   ├── PLAN-M15.md
│   ├── PLAN-M16.md
│   └── PLAN-M16.0-双层痛点求解器.md
├── 30-architecture/
│   └── ARCHITECTURE.md
├── 40-review/
│   └── REVIEW-M14.md
├── pi/
├── reasonix/
├── hermes/
├── opencode/
└── dsh/
```

---

## 六、建议迁移顺序

### 第一步（强烈建议立即做）
迁 7 个核心文档：
1. 01-agent-engine-capabilities
2. 02-mvp-scope
3. 03-需求覆盖矩阵
4. 04-领域层设计
5. 05-数据契约
6. 06-系统技术设计
7. PLAN-M16.0-双层痛点求解器

### 第二步（可选）
迁 architecture / plan / review 的副本。

### 第三步
在 `vol-agent/pi` / `reasonix` / `hermes` / `opencode` / `dsh` 下建立统一分析模板，并开始第二轮问题导向反向分析。

---

## 七、结论

结论很清楚：
- `Source-Code-Agent` 应该逐步回到“具体实现仓库”的定位。
- `vol-agent` 应该逐步承接“产品总知识库 / 5 Agent 分析底座”的定位。

所以，文档迁移不是整理文件，而是在**重新划定知识边界**。