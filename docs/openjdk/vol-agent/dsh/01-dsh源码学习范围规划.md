# dsh 源码学习范围规划

> 项目：deepseek-ai/deepseek-harness（dsh-root v0.1.0-rc.5）
> 分析目标：作为最后一个项目，重点学习“一切皆插件”的 Cordis 插件框架如何组织 Agent 能力，以及“模型可见即已记录”的会话日志设计哲学。
> 依据：
> - `vol-agent/02-源码分析方法论.md`
> - `vol-agent/03-Agent源码前置认知桥.md`
> - `vol-agent/04-统一源码分析模板.md`
> - `Agent/analysis/deepseek-harness/00-域发现/00-deepseek-harness-域发现.md`

---

## 一、项目基本信息

- 项目名：dsh / deepseek-harness
- 版本基线：`dsh-root v0.1.0-rc.5`
- 技术栈：TypeScript + Cordis 插件框架 + 能力缝三角色 + 双后端持久化
- 核心形态：一切皆插件的 Agent 框架，无特权核心，产品行为全部由可替换插件组成

---

## 二、项目根问题（Project Thesis）

### 1. root problems

1. **如何把 Agent 系统做成“框架即产品”——没有特权核心，所有能力都由可替换插件定义。**
2. **如何让“模型可见 ⟺ 已记录”成为运行时不变量，而不是事后审计。**
3. **如何通过能力缝设计让工具、沙箱、子进程、存储、子代理等能力可互换而不破坏系统边界。**

### 2. design theses

- 一切皆插件：没有特权核心，产品行为由插件组合定义。
- 模型可见即已记录：新模型可见输入必须等于新 session 事件。
- 能力缝三角色：Service Definition / Provider / Consumer 换 provider 换产品。
- 共享执行世界：fs/subprocess 指向同一沙箱实例，迁移时一起迁移。

### 2.5 sharpened thesis

更锋利的一句话：

> **dsh 的本质不是“又一个 Agent 系统”，而是一个基于 Cordis 插件的 Agent 框架：产品行为由可替换插件定义，没有特权核心，一切皆能力缝。**

---

## 三、主线机制（Mainline Mechanisms）

## D-1 Cordis 插件框架（vendored）

### 为什么是主线
- dsh 的核心不是执行引擎，而是 Cordis 插件运行时。
- 不理解它，就看不懂 dsh 为什么能“一切皆插件”。

### 重点源码域
- `vendor/@deepseek-ai/cordis`
- `docs/cordis-primer`

### 关键问题
- 插件、上下文、inject、事件、可逆效果这五想法是什么？
- 四种分派模式（waterfall / serial / parallel / 自定义）在解决什么？
- 为什么 waterfall 必须 next()？

---

## D-2 Session 日志（事件源）

### 为什么是主线
- 会话日志是上下文之源。
- 模型可见 ⟺ 已记录是运行时不变量。

### 重点源码域
- `core/session/src`
- `docs/subsystems/session`

### 关键问题
- SessionEventMap 声明合并如何工作？
- deriveMessages() 如何投影模型历史？
- 为什么持久化是插件关注的边界？

---

## D-3 Agent + AgentLoop

### 为什么是主线
- dsh 的 Agent 循环不是唯一的，而是 ReactLoopAgent 状态机的一种实现。

### 重点源码域
- `core/agent`
- `core/agent-loop`
- `docs/agent-lifecycle`

### 关键问题
- turn/step 双层如何组织？
- Phase 状态机如何工作？
- InboxTarget 双队列（next-turn / next-step）的语义是什么？

---

## D-4 Tools 注册表与执行管线

### 为什么是主线
- 工具不是函数，而是五事件管线。

### 重点源码域
- `core/tools`
- `docs/subsystems/tools`

### 关键问题
- 五事件管线（pre/post/execute/code-dispatch-log/result）在解决什么？
- 守卫管线（取消重查 + ask + guardReason）如何工作？
- ToolDefinition 的角色是什么？

---

## D-5 能力缝机制

### 为什么是主线
- dsh 的核心设计模式。
- 理解它，才能理解 dsh 为什么能换 provider 换产品。

### 重点源码域
- 跨包模式（每能力三包）
- `docs/capability-seams`

### 关键问题
- Service Definition / Provider / Consumer 三角色如何分工？
- 共享执行世界解决什么问题？
- 为什么换 provider 可以换整个产品？

---

## D-6 Profile / Bundle 组合

### 为什么是主线
- dsh 的产品形态由 profile/bundle 定义。

### 重点源码域
- `boot/app-boot`
- `bundle/`

### 关键问题
- 六层层序如何工作？
- profile 和 bundle 的关系是什么？
- patch 覆盖行配置的语义是什么？

---

## D-7 持久化与投影

### 为什么是主线
- dsh 的双后端持久化和投影系统是它的一个重要特征。

### 重点源码域
- `session/persistence-jsonl`
- `session/persistence-sqlite`
- `session/projection`

### 关键问题
- 双后端（JSONL / SQLite）各自在解决什么问题？
- 投影五元契约是什么？
- 快照水印和检查点非权威的语义是什么？

---

## D-8 Sandbox / Subprocess / Shell 能力缝

### 为什么是主线
- 这些能力缝展示了 dsh 的“共享执行世界”设计。

### 重点源码域
- `sandbox/`
- `subprocess/`
- `shell/`
- `fs/`

### 关键问题
- 三模式 + 每调用政策如何工作？
- 共享执行世界如何保证一致性？
- Landlock + Windows ACL 的双平台沙箱怎么设计？

---

## 四、横切专题（Crosscutting Tracks）

## D-X1 一切皆插件
- 没有特权核心，扩展 = 在旁边挂插件。

## D-X2 能力缝三角色
- Service Definition / Provider / Consumer 换 provider 换产品。

## D-X3 模型可见 ⟺ 已记录
- 运行时不变量，不是事后审计。

## D-X4 共享执行世界
- fs/subprocess 指向同一沙箱实例。

---

## 五、认知风险点（Cognitive Risks）

### 1. 错觉：dsh 只是一个“插件多的 Agent”
- 实际风险：看不到它是“一切皆插件”的框架设计。
- 应纠正为：dsh 是框架即产品，不是功能列表。

### 2. 错觉：Cordis 只是 ioc 容器
- 实际风险：低估 waterfall/serial/parallel 分派模式的设计语义。
- 应纠正为：Cordis 是插件运行时，不是 DI 容器。

### 3. 错觉：能力缝只是接口抽象
- 实际风险：看不到换 provider 换整个产品的哲学。
- 应纠正为：能力缝是 dsh 的核心设计模式。

### 4. 错觉：模型可见即已记录，只是日志
- 实际风险：看不到它是运行时不变量，不是事后审计。
- 应纠正为：这是 dsh 的第一性原理。

---

## 六、分析边界

### UI 要不要进主线？
- **不要。**
- 客户端视觉组件不进第一轮分析。

### 具体插件实现要不要全扫？
- **不要。**
- 先看能力缝抽象，再看代表性 provider 实现，不把所有 provider 平铺展开。

### 测试代码要不要关心？
- **要。**
- dsh 的测试契约密度极高，是理解设计边界的关键。

---

## 七、前置认知桥

读 dsh 前，建议先具备：
- Agent loop / turn / step 基本理解
- 插件系统 / ioc / 事件框架基本理解
- 工具调用 / 沙箱 / 持久化基本理解
- 能力缝 / provider / consumer 概念

如果没有，先读：
- `vol-agent/03-Agent源码前置认知桥.md`

---

## 八、第一轮学习顺序建议

1. Cordis 插件框架
2. Session 日志
3. Agent / AgentLoop
4. Tools 注册表
5. 能力缝机制
6. Profile / Bundle
7. 持久化 / 投影
8. Sandbox / Subprocess / Shell

---

## 九、第一轮完成标准

dsh 只有同时满足以下条件，才算完成第一轮源码分析：

- 有项目根问题
- 有主线机制清单
- 有横切专题
- 有认知风险点
- 有分析边界
- 有前置认知桥
- 每个核心域有机制闭环
- 有测试证据支撑关键判断
- 有工程问题学习点
- 有书级结构建议