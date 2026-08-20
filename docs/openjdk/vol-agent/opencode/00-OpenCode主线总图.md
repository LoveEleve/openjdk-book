# OpenCode 主线总图

> 作用：作为 `opencode/` 卷内总图，说明前几篇主线正文分别在解决什么问题、它们之间如何依赖，以及后续应该怎么继续展开。

---

## 一、主线骨架

OpenCode 的核心不是“一个会调模型的 CLI”，而是一套逐层展开的控制面：

1. **EventV2 / SessionInput**
   - 解决：什么算系统真相、什么输入算待处理工作
2. **SessionRunner / SessionExecution / RunCoordinator**
   - 解决：这些工作如何被持续推进、继续运行、恢复和收口
3. **ToolRegistry / Tool Settlement**
   - 解决：模型驱动的工具调用如何被协议化、结算化、托管化
4. **SystemContext / Context Epoch / Compaction**
   - 解决：模型每轮到底看见什么，为什么系统能长跑而不散
5. **Permission / Approval / Sandbox policy**
   - 解决：Agent 的副作用能力如何被控制
6. **SessionProjector / Facade / History**
   - 解决：内部事件真相如何投影成外部可读会话状态
7. **MCP / ACP / protocol / plugin / sdk**
   - 解决：这套内核如何向外扩展成更大的协议与产品生态

---

## 二、前 4 篇正文的依赖关系

### 1. EventV2 / SessionInput
这是地基。

没有它：
- 不知道系统接到了什么工作
- 不知道系统承认了什么状态变化
- 后续 continue / resume / replay 都没有真相源

### 2. SessionRunner / SessionExecution
这是执行骨架。

它依赖 EventV2 / SessionInput，因为：
- 外层循环要看收件箱还有没有 durable 工作
- 每一步 durable 后果都要落回 EventV2

### 3. ToolRegistry / Tool Settlement
这是工具协议边界。

它依赖 SessionRunner，因为：
- tool call 是在 runTurn 中被驱动的
- tool settlement 必须被执行骨架等待并 durable 化

### 4. SystemContext / Context Epoch / Compaction
这是上下文工程。

它依赖前面三者，因为：
- EventV2 决定哪些上下文变化是 durable truth
- SessionRunner 决定 compaction 何时改变控制流
- ToolRegistry 决定哪些工具结果能进入上下文

所以前 4 篇不是并列专题，而是：

```text
Event truth → Execution loop → Tool protocol → Context stability
```

---

## 三、建议阅读顺序

### 第一步：先读认知桥
- `../03-Agent源码前置认知桥.md`

### 第二步：再读范围规划
- `01-OpenCode源码学习范围规划.md`

### 第三步：按主线阅读正文
1. `02-EventV2与SessionInput...`
2. `03-SessionRunner与SessionExecution...`
3. `04-ToolRegistry与Tool Settlement...`
4. `05-SystemContext与Compaction...`

### 第四步：再进入后续控制边界与外化层
5. Permission / Approval
6. SessionProjector / Facade / History
7. MCP / ACP / plugin / sdk

---

## 四、卷内编排协议

后续 OpenCode 正文继续写时，统一遵循以下顺序：

1. **真相层**
   - 什么算 durable truth
2. **执行层**
   - 系统如何持续推进工作
3. **协议层**
   - 模型与工具、上下文、权限之间的协议边界
4. **控制边界层**
   - permission / approval / sandbox / stale rejection / fallback
5. **投影与外化层**
   - facade / history / protocol / plugin / sdk

也就是说，后续篇章不能随意插队；必须尽量遵守：

```text
真相 → 执行 → 协议 → 控制边界 → 外化
```

---

## 五、为什么这张总图重要

如果没有这张总图，读者很容易把 OpenCode 看成：
- 一堆文件
- 一堆模块
- 一堆效果很强的技巧

但有了这张图，就能先建立一个判断：

> OpenCode 的本质不是“工具很多”，而是它把会话真相、执行骨架、工具协议、上下文工程和权限控制编织成了一个长期运行的 Agent 系统。

这张总图的作用，就是保证后面再多写几篇，也不会把主线写散。