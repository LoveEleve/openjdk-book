# Plugin 与 Skills：OpenCode 如何把能力系统做成可扩展运行时

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 08
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/opencode/01-闭环笔记/q14-skills-agent.md`
> - `Agent/analysis/opencode/01-闭环笔记/q24-move-plugin.md`

---

## 零、阅读前提示

- 建议先读：
  1. `00-OpenCode主线总图.md`
  2. `04-ToolRegistry与Tool Settlement...`
  3. `05-SystemContext与Compaction...`
  4. `06-Permission与Approval...`
  5. `08-MCP与协议外化...`
- 推荐源码阅读路径：
  1. `packages/core/src/skill/discovery.ts`
  2. `packages/core/src/skill/guidance.ts`
  3. `packages/core/src/skill.ts`
  4. `packages/core/src/agent.ts`
  5. `packages/core/src/control-plane/move-session.ts`
  6. `packages/opencode/src/plugin/loader.ts`

## 一、这一章真正的问题

一个成熟的 Agent 系统不可能只靠“内置固定能力”生存。
它必须回答：

- 新能力怎么被发现？
- 新能力怎么被安装、加载、升级、替换？
- 新能力的正文、提示、工具、权限如何进入当前会话？
- 会话在移动位置 / 项目切换时，这些能力边界会不会被打乱？

所以这一章真正讲的不是“插件功能很多”，而是：

> **OpenCode 如何把能力系统做成一个受边界、受权限、受生命周期约束的可扩展运行时。**

---

## 二、先给结论：Skills 和 Plugins 在 OpenCode 里不是附加资源，而是运行时能力输入

如果你把 skills 理解成“知识片段”，
把 plugins 理解成“外部增强包”，
那你会严重低估它们在 OpenCode 里的系统地位。

在 OpenCode 里，这两者真正承担的是：

- **Skills**：把经验、方法和引导注入上下文与工具层
- **Plugins**：把新能力接入 runtime 生命周期

也就是说，它们不是装饰层，而是：
> **系统可扩展性的两个正式入口。**

---

## 三、为什么 Skill Discovery 首先要解决“安全下载”

这一章里最值钱的地方之一，不是 skill prompt 长什么样，而是：

> **远程发现技能，本质上是在从不可信源拉代码/文档进入本地运行环境。**

所以 OpenCode 在 `skill/discovery.ts` 里最先解决的不是“下载效率”，而是：
- 段名是否合法
- 相对路径是否安全
- decode 后是否仍然安全
- 是否跨域
- 是否路径穿越
- 是否只安装完整技能而不是半个技能

这非常重要，因为它说明：

> OpenCode 把 skill 看成“能力输入”，而不是“随便下个文本片段”。

如果这一层不安全，后面无论 context、tool、permission 做得多好，都会被一个恶意 skill 源打穿。

所以 skill discovery 的第一职责不是“发现更多能力”，而是：
> **在不可信输入面前先守住边界。**

---

## 四、为什么 skill 更新要像包管理器，而不是像热加载配置

OpenCode 对技能更新的处理很成熟：
- 先 staging 下载
- 校验完整性
- 写版本文件
- 再 rename 替换
- 失败就回滚

这说明它不是把 skill 看成：
- 改一段配置
- 覆盖一个 markdown

而是把它看成：
> **一个有版本、有完整性约束、需要原子更新的运行时资产。**

这一步很关键，因为技能一旦进入：
- context
- tool
- prompt guidance
- agent selection

它就不再只是静态知识，而会影响真实运行行为。

所以 OpenCode 在这里解决的是一个非常典型的工程问题：

> **如何让动态能力更新不把运行时状态搞成半新半旧。**

---

## 五、为什么 guidance 只注入“名字 + 描述”，而不是直接把技能正文塞进上下文

这一点非常符合前面我们总结的方法论：
- 能力输入要分层
- 上下文不要被过量内容淹没
- 正文和控制面要分开

OpenCode 的选择是：
- guidance source 只注入技能名字和简述
- 真正技能正文要通过 `skill` 工具按需加载
- 并且还要经过权限过滤

这在解决两个问题：

### 1. 上下文膨胀
如果把 skill 正文全部直接塞进 system/user context，系统会迅速膨胀。

### 2. 能力暴露过度
有些技能就算存在，也不意味着当前 agent / 当前 session 就应自动获得它的全部正文。

所以这里的设计核心是：

> **技能可见性 ≠ 技能正文直接进入上下文。**

这和 ToolRegistry 那一章的思想完全一致：
- 先暴露能力索引
- 真正执行/展开正文时再按权限、按需进入

---

## 六、Agent Selection / Subagent Permissions：为什么“哪个 agent 在跑”会影响能力可见性

如果你把 agent 只理解成“模型配置”，那这一层会看浅。

OpenCode 这里真正关心的是：

> **不同 agent 不是只影响模型参数，还影响可见技能、权限继承和执行边界。**

也就是说，agent 在这里已经不是“人格 preset”，而是：
- 能力轮廓
- 权限轮廓
- 上下文可见性轮廓

这一步很重要，因为它让“不同 agent”具备了真正的系统意义。

后面如果再看：
- default build agent
- explicit agent selection
- subagent permissions
你就会知道它们不是附属配置，而是在定义：
> **这个会话里到底允许出现怎样的能力和行为。**

---

## 七、MoveSession 为什么和插件/技能放在一起看很有价值

表面上看：
- move session
- plugin loader
- skill discovery
似乎是三件事。

但从运行时角度看，它们其实在回答同一个问题：

> **当会话位置或能力环境发生变化时，系统如何保持边界与状态一致。**

`MoveSession` 做的是：
- capture 变更
- apply 到目标
- 发 `Moved` 事件
- 源目录 discard

它重要的不是“搬家功能”，而是：
- 会话与项目绑定
- 位置变更必须事件驱动地通知 runtime
- 上下文、runner、epoch 都要响应这件事

也就是说，这里学到的不是“怎么搬文件”，而是：
> **会话的空间位置，本身就是运行时状态的一部分。**

把它和 skills/plugins 放在一起看，会更容易理解 OpenCode 的扩展体系不是无根漂浮的，而是始终绑定在 project / location / runtime 上。

---

## 八、Plugin Lifecycle：为什么要分 plan → resolve → load

OpenCode 对 plugin 的处理，不是：
- 找到 entry
- import
- 运行

而是明确拆成：
1. plan
2. resolve
3. load

这说明它在解决的是：

- 插件到底应该装什么
- 依赖和兼容性先如何被确认
- 加载失败如何分类
- 哪一步可以重试，哪一步必须停止

这非常像我们前面看到的其他主线设计：
- EventV2 不是 append event，而是定义 → 提交 → 重放
- ToolRegistry 不是 execute tool，而是 decode → execute → encode → settle
- Plugin 也不是 load package，而是：
  > **plan → resolve → load**

这其实体现了 OpenCode 的一个统一工程风格：

> **复杂能力不直接执行，而是先阶段化，再治理。**

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何安全地从外部引入技能
OpenCode 的解法：skill discovery 六重校验 + 全有或全无安装

### 2. 如何让技能更新不污染现有运行时
OpenCode 的解法：staging → rename → rollback

### 3. 如何让技能进入上下文但不炸上下文
OpenCode 的解法：guidance 只列名 + 描述，正文走工具按需加载

### 4. 如何让不同 agent 的能力边界不混乱
OpenCode 的解法：agent selection + permission inheritance + filtered guidance

### 5. 如何让插件能力成为 runtime 生命周期的一部分
OpenCode 的解法：plan → resolve → load 三阶段

### 6. 如何在移动 session / 切换位置时保持状态一致
OpenCode 的解法：capture → apply → Moved 事件 → runtime 响应

所以这一章真正讲的不是“扩展功能很多”，而是：

> **OpenCode 如何把能力扩展、安全边界、位置语义和运行时生命周期统一到一套扩展模型里。**

---

## 十、读者最容易学错的地方

### 误区 1：把 skill 看成文档片段
错。它在 OpenCode 里是能力输入。

### 误区 2：把 plugin 看成简单扩展点
错。它有独立生命周期和失败分类。

### 误区 3：把 guidance 当成技能正文
错。guidance 只暴露能力索引，不直接暴露正文。

### 误区 4：把 move session 看成文件移动逻辑
错。它在维护 project / location / runtime 的一致性。

### 误区 5：把 agent selection 看成 UI 选项
错。它决定能力和权限的可见轮廓。

---

## 十一、分析边界

### 为什么这里不先深入 plugin UI / marketplace 体验
因为这一章关注的是运行时扩展机制，不是产品发行/分发体验。

### 为什么这里不先展开每个 skill 正文内容
因为现在要理解的是“技能怎样进入系统”，而不是“某个技能写了什么”。

### 为什么 move session 要纳入这一章
因为它揭示了扩展能力并不是漂浮的，而是和 location / project / runtime 紧密绑定。

---

## 十二、读者分层路由

### beginner
先抓住：
1. skill / plugin 不是附加功能，而是运行时能力输入
2. guidance 不等于技能正文
3. move session 不是简单搬文件，而是状态迁移

### intermediate
重点看：
- discovery 安全模型
- staging / rollback 更新语义
- guidance 权限过滤
- plugin plan/resolve/load

### advanced
重点看：
- 能力系统如何与 permission、tool registry、context source 协同
- 为什么扩展能力必须绑定 location / project / runtime
- 这种设计如何迁移到其他 Agent 平台

---

## 十三、迁移清单

### 可迁移思想 1：能力输入先过安全校验，再进入运行时
- 可迁移到：远程技能、插件、扩展市场类 Agent 系统
- 前提：系统允许外部来源能力输入
- 不能照搬的点：完全内置能力系统没必要做这么重

### 可迁移思想 2：guidance 只暴露索引，正文按需加载
- 可迁移到：所有上下文预算敏感的 Agent
- 前提：技能正文本身足够大、足够多
- 不能照搬的点：如果技能正文极短，直接注入也未必有问题

### 可迁移思想 3：plan → resolve → load 分阶段插件生命周期
- 可迁移到：需要处理兼容性、依赖和失败分类的扩展系统
- 前提：插件不是简单 import 即可运行
- 不能照搬的点：极简本地 hook 系统不一定需要三段式

### 可迁移思想 4：session move 是状态迁移，不是文件移动
- 可迁移到：工作区切换 / 项目切换 / 云工作区类 Agent 系统
- 前提：session 真正绑定 location/project
- 不能照搬的点：纯无状态 chat bot 用不到这层

---

## 十四、自测问题

1. 为什么 OpenCode 要把 skills / plugins 当成运行时能力输入，而不是附加资源？
2. 为什么 skill discovery 的第一优先级是安全校验，而不是“发现更多技能”？
3. guidance 为什么只放名字和描述，不直接塞正文？
4. plugin 为什么要分 plan / resolve / load？
5. move session 为什么会影响整个 runtime，而不是只改文件位置？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 的扩展能力系统不是附属功能，而是 runtime 的组成部分。
2. 说清 skill、plugin、agent selection、move session 之间的关系。
3. 理解 guidance、正文、权限、位置语义之间的边界。
4. 理解为什么扩展系统必须有安全校验、原子更新和生命周期阶段。
5. 用自己的话说明：一个成熟 Agent 平台要做可扩展运行时，至少要守住哪些边界。

如果还做不到这些，就说明这章还没真正学懂。
