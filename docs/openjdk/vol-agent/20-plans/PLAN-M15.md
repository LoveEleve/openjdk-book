# M15 领域层增强实施计划

> 日期：2026-08-19
> 承接：M14 完成（SQLite/WAL + FTS5 + 租约）
> 目标：实现领域层增强（类比轨/考点地图/多视角/时空溯源）
> 状态：**已完成** ✅

---

## 一、领域层增强概述

根据 `docs/product/04-领域层设计.md`，领域层增强包括：

1. **类比轨**（跨项目知识迁移）- §5.4
2. **考点地图**（JD关键词映射）- §5.2.5
3. **多视角**（同一机制按不同视角重讲）- §5.5
4. **时空溯源**（git演进追踪）- §5.3

这些是产品的**核心差异化**，是5个Agent项目都没有的功能。

---

## 二、类比轨（Analogy Track）

### 2.1 设计目标

```
知识库维护"机制-思想"索引：
  RSet 引用记录 ↔ Netty 内存池引用计数?同一思想 → 跨项目自动关联
触发:章节中出现已入库机制 → 自动附"类比锚点节"参考
延迟:分析完 2+ 项目后,类比轨才有效(知识库积累)
```

### 2.2 数据模型

```typescript
// 机制-思想索引
interface MechanismThoughtIndex {
  thought_id: string;           // 思想唯一标识
  thought_name: string;         // 思想名称（如"引用计数"）
  description: string;          // 思想描述
  mechanism_ids: string[];      // 关联的机制ID列表
  project_ids: string[];        // 关联的项目ID列表
  evidence: string[];           // 证据列表
}

// 类比锚点
interface AnalogyAnchor {
  source_mechanism: string;     // 源机制
  target_mechanism: string;     // 目标机制
  thought_id: string;           // 共同思想
  similarity: number;           // 相似度（0-1）
  explanation: string;          // 类比解释
  evidence: string[];           // 证据
}

// 类比轨
interface AnalogyTrack {
  project_id: string;
  anchors: AnalogyAnchor[];
  thoughts: MechanismThoughtIndex[];
}
```

### 2.3 实现步骤

#### 步骤1：创建机制-思想索引

**文件**：`src/learning/analogy.ts`

```typescript
export class AnalogyStore {
  private thoughts = new Map<string, MechanismThoughtIndex>();
  private anchors: AnalogyAnchor[] = [];

  constructor(private readonly log: EventLog) {}

  async init(): Promise<void> {
    // 从事件日志重建索引
  }

  // 从机制中提取思想
  extractThought(mechanism: MechanismAsset): MechanismThoughtIndex | null {
    // 分析机制的subject和statement，提取共同思想
  }

  // 查找相似机制
  findSimilarMechanisms(mechanism: MechanismAsset): AnalogyAnchor[] {
    // 基于思想索引查找相似机制
  }

  // 生成类比解释
  generateExplanation(source: MechanismAsset, target: MechanismAsset): string {
    // 生成类比解释
  }
}
```

#### 步骤2：添加事件类型

**文件**：`src/types/event.ts`

```typescript
// 添加新事件类型
"analogy.thought.extracted": ["thought_id", "thought_name", "mechanism_ids", "project_ids"];
"analogy.anchor.created": ["source_mechanism", "target_mechanism", "thought_id", "similarity"];
```

#### 步骤3：集成到写作流程

**文件**：`src/learning/writing.ts`

```typescript
// 在SectionPlan中添加类比锚点节
export function buildSectionPlan(path: UnderstandingPath, analogies: AnalogyAnchor[]): SectionPlan[] {
  const sections = path.steps.map((step) => ({
    title: step.title,
    goal: step.focus,
    inputs: [...step.sources],
  }));

  // 如果有类比锚点，添加类比锚点节
  if (analogies.length > 0) {
    sections.push({
      title: "类比锚点",
      goal: "跨项目知识迁移，帮助读者理解相似机制",
      inputs: analogies.map((a) => `${a.source_mechanism} ↔ ${a.target_mechanism}`),
    });
  }

  return sections;
}
```

#### 步骤4：添加测试

**文件**：`tests/learning-analogy.test.ts`

```typescript
describe("AnalogyStore", () => {
  it("should extract thought from mechanism", () => {});
  it("should find similar mechanisms", () => {});
  it("should generate explanation", () => {});
  it("should integrate with writing", () => {});
});
```

### 2.4 验收判据

1. ✅ 能从机制中提取思想
2. ✅ 能查找相似机制
3. ✅ 能生成类比解释
4. ✅ 能集成到写作流程
5. ✅ 测试通过

---

## 三、考点地图（Exam Map）

### 3.1 设计目标

```
goal:  book | interview | self_study
interview 目标时(对齐 C 档选择):
  - 生成考点地图:核心域 × JD 关键词(评测/可观测/Context/…)
    → 章节按考点组织强化(每章标注关联考点)
  - 面试弹药节:每章附"面试官会怎么问 + 怎么答"参考
```

### 3.2 数据模型

```typescript
// JD关键词
interface JDKeyword {
  keyword: string;              // 关键词
  category: string;             // 分类（如"评测"、"可观测"、"Context"）
  frequency: number;            // 出现频率
  projects: string[];           // 关联项目
}

// 考点
interface ExamPoint {
  point_id: string;             // 考点ID
  title: string;                // 考点标题
  description: string;          // 考点描述
  jd_keywords: string[];        // 关联的JD关键词
  mechanism_ids: string[];      // 关联的机制
  difficulty: "basic" | "intermediate" | "advanced";  // 难度
  chapter_id?: string;          // 关联章节
}

// 考点地图
interface ExamMap {
  project_id: string;
  points: ExamPoint[];
  keywords: JDKeyword[];
  chapters: Array<{
    chapter_id: string;
    points: string[];           // 关联的考点ID
    interview_questions: Array<{
      question: string;
      answer: string;
    }>;
  }>;
}
```

### 3.3 实现步骤

#### 步骤1：创建考点地图存储

**文件**：`src/learning/exam-map.ts`

```typescript
export class ExamMapStore {
  private points = new Map<string, ExamPoint>();
  private keywords = new Map<string, JDKeyword>();

  constructor(private readonly log: EventLog) {}

  async init(): Promise<void> {
    // 从事件日志重建考点地图
  }

  // 从JD中提取关键词
  extractKeywords(jdText: string): JDKeyword[] {
    // 解析JD文本，提取关键词
  }

  // 生成考点
  generatePoints(mechanisms: MechanismAsset[], keywords: JDKeyword[]): ExamPoint[] {
    // 基于机制和关键词生成考点
  }

  // 生成面试问题
  generateInterviewQuestions(point: ExamPoint): Array<{question: string; answer: string}> {
    // 基于考点生成面试问题
  }

  // 构建考点地图
  buildExamMap(project_id: string, mechanisms: MechanismAsset[], jdText: string): ExamMap {
    // 构建完整的考点地图
  }
}
```

#### 步骤2：添加事件类型

**文件**：`src/types/event.ts`

```typescript
// 添加新事件类型
"exammap.keyword.extracted": ["keyword", "category", "frequency", "projects"];
"exammap.point.generated": ["point_id", "title", "jd_keywords", "mechanism_ids", "difficulty"];
"exammap.chapter.mapped": ["chapter_id", "points", "interview_questions"];
```

#### 步骤3：集成到规格书

**文件**：`src/spec/`

```typescript
// 在规格书中添加考点地图
interface Spec {
  // ... 现有字段
  exam_map?: ExamMap;           // 考点地图（可选）
  goal: "book" | "interview" | "self_study";  // 学习目标
}
```

#### 步骤4：集成到章节生成

**文件**：`src/engine/context.ts`

```typescript
// 在章节上下文中添加考点信息
interface ChapterContext {
  // ... 现有字段
  exam_points?: ExamPoint[];    // 关联的考点
  interview_questions?: Array<{question: string; answer: string}>;  // 面试问题
}
```

#### 步骤5：添加测试

**文件**：`tests/learning-exam-map.test.ts`

```typescript
describe("ExamMapStore", () => {
  it("should extract keywords from JD", () => {});
  it("should generate points", () => {});
  it("should generate interview questions", () => {});
  it("should build exam map", () => {});
});
```

### 3.4 验收判据

1. ✅ 能从JD中提取关键词
2. ✅ 能生成考点
3. ✅ 能生成面试问题
4. ✅ 能集成到规格书和章节生成
5. ✅ 测试通过

---

## 四、多视角（Multi-Perspective）

### 4.1 设计目标

```
view:  single(default) | performance | concurrency | security | extensibility
多视角章节:同一机制按所选视角重讲(性能:热点/分配;并发:锁/竞争…)
```

### 4.2 数据模型

```typescript
// 视角类型
type PerspectiveType = "single" | "performance" | "concurrency" | "security" | "extensibility";

// 视角配置
interface PerspectiveConfig {
  type: PerspectiveType;
  name: string;
  description: string;
  focus_areas: string[];        // 关注领域
  questions: string[];          // 关注问题
}

// 多视角章节
interface MultiPerspectiveChapter {
  chapter_id: string;
  base_content: string;         // 基础内容
  perspectives: Array<{
    type: PerspectiveType;
    content: string;            // 视角内容
    focus: string;              // 视角焦点
    evidence: string[];         // 证据
  }>;
}
```

### 4.3 实现步骤

#### 步骤1：创建视角配置

**文件**：`src/learning/perspective.ts`

```typescript
export const PERSPECTIVES: Record<PerspectiveType, PerspectiveConfig> = {
  single: {
    type: "single",
    name: "单一视角",
    description: "默认视角，全面介绍机制",
    focus_areas: ["mechanism", "implementation", "usage"],
    questions: ["这个机制是什么？", "如何实现？", "如何使用？"],
  },
  performance: {
    type: "performance",
    name: "性能视角",
    description: "关注性能优化和热点",
    focus_areas: ["hotspot", "allocation", "cache", "optimization"],
    questions: ["性能热点在哪？", "内存分配如何？", "如何优化？"],
  },
  concurrency: {
    type: "concurrency",
    name: "并发视角",
    description: "关注并发和锁",
    focus_areas: ["lock", "competition", "deadlock", "thread-safety"],
    questions: ["有哪些锁？", "竞争点在哪？", "如何避免死锁？"],
  },
  security: {
    type: "security",
    name: "安全视角",
    description: "关注安全和权限",
    focus_areas: ["permission", "vulnerability", "authentication", "authorization"],
    questions: ["权限如何控制？", "有哪些漏洞？", "如何防护？"],
  },
  extensibility: {
    type: "extensibility",
    name: "扩展性视角",
    description: "关注扩展和插件",
    focus_areas: ["plugin", "hook", "extension", "customization"],
    questions: ["如何扩展？", "有哪些钩子？", "如何自定义？"],
  },
};
```

#### 步骤2：创建多视角生成器

**文件**：`src/learning/perspective.ts`

```typescript
export class PerspectiveGenerator {
  // 生成视角内容
  async generatePerspective(
    mechanism: MechanismAsset,
    perspective: PerspectiveConfig,
    evidence: string[]
  ): Promise<{
    type: PerspectiveType;
    content: string;
    focus: string;
    evidence: string[];
  }> {
    // 基于视角配置生成内容
  }

  // 生成多视角章节
  async generateMultiPerspectiveChapter(
    chapter_id: string,
    base_content: string,
    mechanisms: MechanismAsset[],
    perspectives: PerspectiveType[]
  ): Promise<MultiPerspectiveChapter> {
    // 生成多视角章节
  }
}
```

#### 步骤3：集成到规格书

**文件**：`src/spec/`

```typescript
// 在规格书中添加视角配置
interface Spec {
  // ... 现有字段
  perspectives: PerspectiveType[];  // 选择的视角
}
```

#### 步骤4：集成到章节生成

**文件**：`src/engine/context.ts`

```typescript
// 在章节上下文中添加视角信息
interface ChapterContext {
  // ... 现有字段
  perspective?: PerspectiveType;  // 当前视角
  multi_perspective?: MultiPerspectiveChapter;  // 多视角章节
}
```

#### 步骤5：添加测试

**文件**：`tests/learning-perspective.test.ts`

```typescript
describe("PerspectiveGenerator", () => {
  it("should generate perspective content", () => {});
  it("should generate multi-perspective chapter", () => {});
  it("should integrate with spec", () => {});
  it("should integrate with chapter generation", () => {});
});
```

### 4.4 验收判据

1. ✅ 能生成视角内容
2. ✅ 能生成多视角章节
3. ✅ 能集成到规格书
4. ✅ 能集成到章节生成
5. ✅ 测试通过

---

## 五、时空溯源（Git Evolution）

### 5.1 设计目标

```
时空溯源节(可选,🔴A 深度强制):演进轨迹(git 溯源),
展示机制的时间维度
```

### 5.2 数据模型

```typescript
// 代码演进记录
interface CodeEvolution {
  file: string;                 // 文件路径
  commits: Array<{
    hash: string;               // 提交哈希
    author: string;             // 作者
    date: string;               // 日期
    message: string;            // 提交信息
    changes: Array<{
      line: number;
      type: "add" | "modify" | "delete";
      content: string;
    }>;
  }>;
  blame: Array<{
    line: number;
    author: string;
    date: string;
    hash: string;
  }>;
}

// 时空溯源
interface GitEvolution {
  mechanism_id: string;
  file: string;
  evolution: CodeEvolution;
  timeline: Array<{
    date: string;
    event: string;
    significance: "major" | "minor" | "patch";
  }>;
}
```

### 5.3 实现步骤

#### 步骤1：创建Git工具

**文件**：`src/tools/git.ts`

```typescript
export const gitBlameTool: ToolProvider = {
  name: "git_blame",
  permission: "read",
  schema: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件路径" },
      lines: { type: "string", description: "行号范围，如 100-200" },
    },
    required: ["file"],
    description: "获取文件的git blame信息",
  },
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    // 执行git blame命令
  },
};

export const gitLogTool: ToolProvider = {
  name: "git_log",
  permission: "read",
  schema: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件路径" },
      limit: { type: "number", description: "限制数量" },
    },
    required: ["file"],
    description: "获取文件的git log信息",
  },
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    // 执行git log命令
  },
};
```

#### 步骤2：创建时空溯源生成器

**文件**：`src/learning/git-evolution.ts`

```typescript
export class GitEvolutionGenerator {
  // 获取文件演进
  async getFileEvolution(file: string, cwd: string): Promise<CodeEvolution> {
    // 使用git blame和git log获取文件演进
  }

  // 生成时间线
  generateTimeline(evolution: CodeEvolution): Array<{
    date: string;
    event: string;
    significance: "major" | "minor" | "patch";
  }> {
    // 基于提交历史生成时间线
  }

  // 生成时空溯源
  async generateGitEvolution(
    mechanism_id: string,
    file: string,
    cwd: string
  ): Promise<GitEvolution> {
    // 生成完整的时空溯源
  }
}
```

#### 步骤3：集成到章节生成

**文件**：`src/engine/context.ts`

```typescript
// 在章节上下文中添加时空溯源
interface ChapterContext {
  // ... 现有字段
  git_evolution?: GitEvolution;  // 时空溯源
}
```

#### 步骤4：集成到验收

**文件**：`src/acceptance/`

```typescript
// 在验收中添加时空溯源检查
// 对于🔴A深度的章节，时空溯源节是强制的
```

#### 步骤5：添加测试

**文件**：`tests/learning-git-evolution.test.ts`

```typescript
describe("GitEvolutionGenerator", () => {
  it("should get file evolution", () => {});
  it("should generate timeline", () => {});
  it("should generate git evolution", () => {});
  it("should integrate with chapter generation", () => {});
});
```

### 5.4 验收判据

1. ✅ 能获取文件演进
2. ✅ 能生成时间线
3. ✅ 能生成时空溯源
4. ✅ 能集成到章节生成
5. ✅ 测试通过

---

## 六、实施顺序

### 阶段1：类比轨（3-5天）

1. 创建 `src/learning/analogy.ts`
2. 添加事件类型
3. 集成到写作流程
4. 添加测试
5. 验证

### 阶段2：考点地图（3-5天）

1. 创建 `src/learning/exam-map.ts`
2. 添加事件类型
3. 集成到规格书
4. 集成到章节生成
5. 添加测试
6. 验证

### 阶段3：多视角（2-3天）

1. 创建 `src/learning/perspective.ts`
2. 集成到规格书
3. 集成到章节生成
4. 添加测试
5. 验证

### 阶段4：时空溯源（3-5天）

1. 创建 `src/tools/git.ts`
2. 创建 `src/learning/git-evolution.ts`
3. 集成到章节生成
4. 集成到验收
5. 添加测试
6. 验证

**总计**：11-18天

---

## 七、关键文件清单

### 需要新增的文件

| 文件 | 内容 | 阶段 |
|------|------|------|
| `src/learning/analogy.ts` | 类比轨存储 | 阶段1 |
| `src/learning/exam-map.ts` | 考点地图存储 | 阶段2 |
| `src/learning/perspective.ts` | 多视角生成器 | 阶段3 |
| `src/learning/git-evolution.ts` | 时空溯源生成器 | 阶段4 |
| `src/tools/git.ts` | Git工具 | 阶段4 |
| `tests/learning-analogy.test.ts` | 类比轨测试 | 阶段1 |
| `tests/learning-exam-map.test.ts` | 考点地图测试 | 阶段2 |
| `tests/learning-perspective.test.ts` | 多视角测试 | 阶段3 |
| `tests/learning-git-evolution.test.ts` | 时空溯源测试 | 阶段4 |

### 需要修改的文件

| 文件 | 修改内容 | 阶段 |
|------|----------|------|
| `src/types/event.ts` | 添加新事件类型 | 阶段1-2 |
| `src/learning/writing.ts` | 集成类比轨 | 阶段1 |
| `src/spec/` | 集成考点地图和多视角 | 阶段2-3 |
| `src/engine/context.ts` | 集成所有增强 | 阶段1-4 |
| `src/acceptance/` | 集成时空溯源验收 | 阶段4 |

---

## 八、面试叙事

### 产品怎么讲

**主线故事**：
> "我分析了5个Agent项目，发现它们都没有领域层增强。我实现了类比轨、考点地图、多视角、时空溯源，让技术不再难学。"

**差异化**：
- 类比轨：跨项目知识迁移（5个项目都没有）
- 考点地图：JD关键词映射（5个项目都没有）
- 多视角：同一机制按不同视角重讲（5个项目都没有）
- 时空溯源：git演进追踪（5个项目都没有）

**面试考点**：
- 类比轨：知识图谱、语义相似度
- 考点地图：NLP、关键词提取
- 多视角：多维度分析、视角切换
- 时空溯源：版本控制、代码演进

---

## 九、风险与缓解

### 风险1：类比轨准确性

- **风险**：提取的思想可能不准确
- **缓解**：使用LLM辅助提取，人工审核

### 风险2：考点地图覆盖度

- **风险**：JD关键词可能不全
- **缓解**：使用多个JD源，持续更新

### 风险3：多视角一致性

- **风险**：不同视角可能矛盾
- **缓解**：使用统一的视角配置，确保一致性

### 风险4：时空溯源性能

- **风险**：git blame可能很慢
- **缓解**：使用缓存，限制文件大小

---

## 十、总结

领域层增强是产品的**核心差异化**，实现了5个Agent项目都没有的功能：

1. **类比轨**：跨项目知识迁移
2. **考点地图**：JD关键词映射
3. **多视角**：同一机制按不同视角重讲
4. **时空溯源**：git演进追踪

**实施周期**：11-18天

**验收标准**：
- 所有测试通过
- TypeScript编译通过
- 集成到现有流程
- 面试可讲