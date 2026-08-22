# LLM 与 ProviderComposer：Pi 如何把多模型与多供应商能力接入运行时

> 项目：Pi（main 基线）
> 角色：主线机制正文 07
> 对应范围规划：`01-Pi源码学习范围规划.md`
> 依据材料：`Agent/analysis/pi/00-域发现/00-pi-域发现.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AgentLoop：Pi 的执行骨架如何组织 turn、tools 与 continuation.md`
  2. `04-AgentSessionRuntime与Modes：Pi 如何让多种前端共用一个运行时内核.md`
  3. `05-双层工具与技能系统：Pi 为什么把能力抽象拆成 harness 层和 core 层.md`
- 推荐源码阅读路径：
  1. `ai/src/provider/`
  2. `ai/src/api/`
  3. `ai/src/auth/oauth/`
  4. `coding-agent/src/core/provider-composer.ts`
  5. `core/model-registry/` + `core/models-store.ts`

## 一、这一章真正的问题

当一个 Agent 真的要运行在现实世界里，它不可能只支持：
- 一个模型
- 一个 API 形态
- 一套认证方式

所以 Pi 在模型层要回答的问题，不是“能不能接几个 provider”，而是：

> **如何把多供应商、多模型、多认证形态和结构化输出约束统一收进一套可被 runtime 消费的模型能力层。**

这一章真正要回答的是：

1. 为什么 Pi 要把 LLM 层拆成 provider / api / auth / models 四层？
2. ProviderComposer 为什么值得被单独提出来？
3. constrained sampling 和 context clamp 为什么不是 provider 细节，而是运行时稳定性的组成部分？
4. 为什么 OAuth / API key / runtime credentials 都应该进入同一层理解？

---

## 二、先给结论：Pi 不是“接很多模型”，而是试图把模型能力做成一套统一运行时抽象

最容易犯的错，是把 `ai/` 目录理解成：
- 各家 provider 的适配堆在一起
- 只是为了支持更多模型

这会看得太浅。

更准确的理解是：

> **Pi 把 LLM 侧的复杂度拆成 provider / api / auth / models 四层，是为了让 Agent runtime 能稳定消费“模型能力”，而不是被某一家 API 绑死。**

所以 Pi 真正在做的不是“多接几家大模型”，而是：
- 统一 provider 抽象
- API 适配层隔离差异
- auth 统一处理认证形态
- models 层统一描述模型能力、限制与选择

这和前面我们看到的：
- AgentSessionRuntime 统一多模式
- ToolDefinition 统一多工具
- Skills 统一能力输入
是同一种分层哲学。

---

## 三、为什么 provider / api / auth / models 四层拆分很重要

### 1. provider 层
这一层回答的是：
- 系统最终在“和谁打交道”

### 2. api 层
这一层回答的是：
- 不同 provider 的调用协议差异如何被消化
- 消息如何被转换
- 图片、流式、结构化输出如何被适配

### 3. auth 层
这一层回答的是：
- API key / OAuth / 设备码 / PKCE 这些认证方式如何进入系统

### 4. models 层
这一层回答的是：
- 当前有哪些模型
- 这些模型支持什么能力
- 它们的限制、特征和默认值是什么

这四层拆开之后，Pi 得到的不是“更多 provider”，而是：
> **一个可组合的模型能力平面。**

如果不拆：
- provider 差异会一路泄漏到 Agent loop
- auth 复杂度会污染 session/runtime
- 结构化输出和 token 限制会散落在各调用点

所以这层分离，实际上是运行时稳定性的前提。

---

## 四、为什么 `ProviderComposer` 值得单独拿出来看

`provider-composer.ts` 在既有域发现里被专门抬高，不是偶然。

原因是它在回答一个很关键的问题：

> **多模型能力不是简单地“换个 model id”，而是要在系统层面被组合和路由。**

也就是说，Pi 已经意识到：
- 模型不是一层静态配置
- 而可能是：
  - 不同能力的组合
  - 登录后模型集合变化
  - 不同场景下的选择策略

所以 ProviderComposer 的意义，不是“提供另一个 helper”，而是：
> **把多模型决策正式提升成运行时能力。**

这和我们在 Reasonix 看到 Coordinator 对 planner/executor 的抽象是同类问题，只不过 Pi 在这里更偏向 provider 能力组合。

---

## 五、为什么 constrained sampling 很值钱

既有域发现里已经明确指出：
- `ai/src/api/constrained-sampling.ts`
- 这是让 Agent 输出结构化规格书的关键能力之一

这个点非常重要，因为它说明 Pi 不满足于：
- 模型“差不多”给个 JSON

它更进一步要解决：
> **模型输出如何被强约束成结构化对象。**

这意味着：
- 结构化输出不是 prompt 小技巧
- 而是 provider/api 层正式支持的能力

这件事对 Agent 来说太关键了，因为：
- plan
- spec
- tool args
- eval result
- structured messages
很多都依赖“结构化输出是否稳定”

所以 constrained sampling 的真正价值，不是技术新鲜，而是：
> **把“模型给结构化对象”这件事从偶然成功，提升成 runtime 能力。**

---

## 六、为什么 `clampMaxTokensToContext` 不是小工具，而是控制边界

Pi 在 `simple-options.ts` 里有：
- `clampMaxTokensToContext`

这类能力很容易被忽略，因为看起来像参数修修补补。

但它解决的是：

> **调用模型之前，系统必须主动约束请求，使之不越过上下文窗口。**

如果不做这层：
- loop 以为自己还能继续
- provider 直接报错
- 工具结果、上下文压缩和 turn 逻辑都会被突然打断

所以这里的真正价值是：
- provider 层不是被动接受错误
- 而是主动把模型调用裁进可执行边界内

这和 OpenCode 的 output store、Reasonix 的 boundedllm 是同一类成熟设计思想。

---

## 七、为什么 OAuth / 设备码 / PKCE 要放在主线里理解

这不是“认证太细所以可略过”的部分。

对 Pi 来说，OAuth 设备码、PKCE、runtime credentials 被保留下来，说明它明确承认：

> **Agent runtime 的模型能力获取，本身是运行时的一部分。**

如果不把 auth 纳入主线，你会误以为：
- 模型总是可用的
- provider 只是纯调用适配

但现实世界不是这样：
- token 会过期
- provider 认证流会变化
- 模型可见性会随着登录态变化

所以 auth 在这里不是外围，而是：
> **模型能力层的前提条件。**

---

## 八、这一章真正解决了哪些工程问题？

### 1. 如何让 Agent runtime 不被某一家 provider 绑死
Pi 的解法：provider / api / auth / models 四层拆分

### 2. 如何让多模型能力进入系统控制面
Pi 的解法：ProviderComposer

### 3. 如何让结构化输出变成稳定能力
Pi 的解法：constrained sampling

### 4. 如何在模型调用前主动处理上下文窗口边界
Pi 的解法：clampMaxTokensToContext

### 5. 如何让认证形态和模型能力变化进入 runtime
Pi 的解法：runtime credentials + OAuth 设备码 / PKCE

这一章最值得学的，不是“Pi 支持哪些模型”，而是：

> **Pi 如何把“模型能力获取、模型能力描述、模型能力组合、模型输出约束”都做成运行时内的一等对象。**

---

## 九、读者最容易学错的地方

### 错觉 1：provider 层只是 API 封装
错。Pi 在这里做的是模型能力抽象层。

### 错觉 2：多模型就是多个配置项
错。ProviderComposer 说明多模型也是运行时控制问题。

### 错觉 3：constrained sampling 只是生成 JSON 的小技巧
错。它在保护结构化输出契约。

### 错觉 4：maxTokens clamp 是调参小函数
错。它是在保护模型调用边界。

### 错觉 5：auth 只是登录逻辑
错。它决定 runtime 能不能拿到模型能力。

---

## 十、分析边界

### 为什么这里不先深挖每个 provider 的具体实现
因为第一轮重点是统一抽象和分层，不是各家 API 差异细节大全。

### 为什么这里要把 auth 也纳入主线
因为在多模型、多供应商 Agent 系统里，认证不是外围，而是能力层入口。

### 为什么这里不先把 eval / telemetry 一起展开
因为这一章先站稳“模型能力层”，评测和遥测是后续围绕这层展开的系统性能力。

---

## 十一、读者分层路由

### beginner
先抓住：
1. Pi 不是简单对接多个模型，而是在做统一模型能力层
2. provider / api / auth / models 是四个不同层次
3. auth 不只是登录，而是模型能力前提

### intermediate
重点看：
- ProviderComposer
- constrained sampling
- runtime credentials
- clampMaxTokensToContext

### advanced
重点看：
- 多模型组合为什么必须进入运行时层
- constrained sampling 对规格书/计划/工具协议的长期价值
- provider 差异为什么不能一路泄漏到 AgentSession / loop 层

---

## 十二、迁移清单

### 可迁移思想 1：provider / api / auth / models 四层拆分
- 可迁移到：多供应商、多模型 Agent 系统
- 前提：系统确实需要 provider-neutral runtime
- 不适合直接照搬到：只接单一 provider 的极简系统

### 可迁移思想 2：ProviderComposer 进入主线
- 可迁移到：需要模型能力组合、登录后模型变化、按场景切换模型的系统
- 前提：模型不是固定静态配置
- 不适合直接照搬到：只有一个模型且不切换的系统

### 可迁移思想 3：constrained sampling 作为正式能力
- 可迁移到：计划、规格书、工具参数、验收结果都依赖结构化输出的 Agent
- 前提：系统严重依赖 JSON / schema 输出
- 不适合直接照搬到：只做自由文本生成的系统

### 可迁移思想 4：调用前裁剪上下文
- 可迁移到：所有上下文敏感的长跑 Agent
- 前提：调用边界可能被上下文大小打断
- 不适合直接照搬到：上下文极小或 provider 自己保证窗口的简单系统

---

## 十三、自测问题

1. 为什么 Pi 要把 LLM 层拆成 provider / api / auth / models 四层？
2. 为什么 ProviderComposer 不是普通配置器，而是运行时能力组合层？
3. 为什么 constrained sampling 对 Agent 来说是长期核心能力？
4. 为什么 `clampMaxTokensToContext` 是系统边界保护，而不是调参细节？
5. 为什么 auth 也必须被纳入模型能力主线来理解？

---

## 十四、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Pi 为什么要把模型能力做成统一抽象层，而不是把 provider 差异一路泄漏到 Agent 内核。
2. 说清 provider / api / auth / models / composer 各自扮演的角色。
3. 理解 constrained sampling 和 context clamp 在系统稳定性上的位置。
4. 理解为什么 runtime credentials 和 OAuth 不是外围，而是能力前提。
5. 用自己的话说明：Pi 为什么更像一个“模型能力抽象与组合系统”，而不只是“接了很多 provider 的 Agent”。

如果还做不到这些，就说明这章还没真正学懂。
