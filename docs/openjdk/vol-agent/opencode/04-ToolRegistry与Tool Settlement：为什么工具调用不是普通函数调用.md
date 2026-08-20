/**
 * 正式正文
 */
# ToolRegistry 与 Tool Settlement：为什么工具调用不是普通函数调用

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 03
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q8-tools.md`

---

## 零、阅读前提示

- 如果还没读 `03-SessionRunner与SessionExecution...`，建议先读，因为这章默认你已经知道工具调用是在执行骨架里怎样被推进和等待的。
- 如果对 tool calling / schema / structured output 不熟，先读：`../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `packages/core/src/tool/tool.ts`
  2. `packages/core/src/tool/registry.ts`
  3. `packages/core/src/tool-output-store.ts`
  4. `packages/core/src/tool/application-tools.ts`
  5. `packages/core/test/application-tools.test.ts` + `packages/core/test/tool-*`

## 一、这一章真正的问题

读 Agent 源码时，一个非常常见的误解是：

> 模型决定调哪个工具，系统把函数执行一下，再把结果回给模型。

如果你这样理解 OpenCode，后面看到：
- schema
- permission
- stale rejection
- settlement
- output store
- application tools / location tools

会觉得“为什么要这么复杂”。

这一章真正要回答的是：

1. 为什么 Agent 里的工具调用不能被理解成普通函数调用？
2. ToolRegistry 到底在保护什么边界？
3. 为什么 OpenCode 要把工具值做成“不透明值”？
4. 为什么执行完工具之后，还需要一整套 settlement / bounded output / stale rejection 机制？

一句话概括：

> **OpenCode 把工具调用当成“模型驱动协议”，而不是“本地函数执行”。**

---

## 二、先给结论：ToolRegistry 不是工具箱，而是协议边界

最容易犯的错，是把 ToolRegistry 理解成：
- 一个 Map
- 根据名字取到工具
- 调一下 execute
- 返回结果

OpenCode 不是这样。

它真正做的是：

- 校验调用的工具身份是不是当前还有效
- 按 schema 解析输入
- 在统一 context 下执行工具
- 检查返回值是否符合输出 schema
- 把结构化结果和模型可见内容重新编码
- 对超大输出做托管和截断
- 保证历史消息里只出现有边界的结果，而不是任意副作用泄漏

所以 ToolRegistry 在这里的角色不是“收纳工具”，而是：

> **Agent 和工具世界之间的结算层。**

这就是为什么这一章必须拉出来单讲。因为如果这层看不懂，后面你会一直把 Agent 的工具能力误判成“LLM + 一点函数绑定”。

---

## 二点五、前置知识

读这一章前，最好先建立这些前提：

1. 工具调用在 Agent 里是模型驱动协议，不是本地函数直调
2. 上一章的 SessionRunner 会持续等待工具结算，而不是 fire-and-forget
3. 权限、上下文、输出边界会共同约束工具执行

如果没有这些前提，这一章会很容易被误读成“TypeScript 技巧和工具封装细节”。

## 三、工具值为什么要做成“不透明值”

OpenCode 的工具不是一个普通对象：
- 不是公开挂着 schema
- 不是公开挂着 execute
- 不是你拿到以后想怎么调用就怎么调用

它真正的做法是：

- 对外暴露一个冻结空对象
- 真正的运行时信息放进 WeakMap
- 只有注册表知道怎么从这个句柄拿到运行时定义

这件事的意义非常大。

### 1. 它在防什么？
它防的是：
- 外部伪造工具值
- 外部直接绕过注册表调用工具
- 运行时定义被任意篡改

### 2. 为什么 Agent 系统必须这样做？
因为在 Agent 里，工具不是静态编译期接口，而是：
- 模型会引用它
- session / permission / location 会约束它
- 注册顺序和作用域会影响它
- 工具实现甚至可能在运行时被替换

如果工具值本身是“裸执行器对象”，整个控制面会很快被绕穿。

所以这里的设计思想不是“奇技淫巧”，而是：

> **工具必须先成为受 runtime 管控的句柄，然后才能成为可执行能力。**

---

## 四、OpenCode 为什么把工具执行做成“结算管线”

OpenCode 不是简单执行工具，而是把一次工具调用做成了严格的 settlement pipeline。

这个 pipeline 至少包含这些阶段：

1. 输入解码
2. 工具执行
3. 输出编码
4. 结构化投影
5. 模型可见输出变换
6. 有界化 / 托管
7. 结果值返回

也就是说，工具执行真正的语义是：

> **decode → execute → encode → project → bound → settle**

### 为什么不能直接 execute？
因为模型提供的输入不是可信函数参数，而是：
- 远程模型给出的结构化意图
- 可能字段缺失
- 可能类型错误
- 可能调用了已经被替换的旧工具名

所以：
- decode 是协议安全
- execute 是能力执行
- encode 是输出契约安全
- project 是模型可见性控制
- bound 是上下文保护

如果缺任何一层，系统都可能“能跑”，但会很不稳定。

---

## 五、stale rejection：为什么广告过的工具，后来也不一定还能执行

这是一个非常容易被忽略、但非常成熟的设计。

OpenCode 在 materialize 工具时，不是只记工具名字，而是：
- 把当前广告时的注册身份一并捕获下来

到真正结算时，会再检查：
- 这个名字对应的工具，还是不是原来的那个注册对象？

如果不是，就拒绝执行。

这就是所谓的：
> **stale rejection**

### 为什么它重要？
因为在一个会持续运行的 Agent 里：
- 工具可能被卸载
- 工具可能被替换
- 插件可能关闭
- session scope 可能结束

如果系统只按“名字一样”去执行，结果很可能是：
- 模型想调的是旧工具 A
- 实际执行的是新工具 B

这会直接破坏执行正确性。

所以 stale rejection 实际在保护的是：

> **模型看到的能力集合，和系统最终执行的能力集合，必须是同一代的。**

这和之前我们在 EventV2 里看到的 seq / owner / fencing，本质上是同一种工程意识：
- 不接受“看起来差不多就行”
- 必须确认“这是同一个东西”

---

## 六、输出托管为什么是主线机制，不是附加优化

OpenCode 还有一个很容易被低估的点：

> **ToolOutputStore**

很多人会把它当成：
- 太长了所以截断一下
- 顺手把文件写出去

这太浅了。

它真正解决的是：

### 1. 模型上下文不能无限吞工具输出
如果一个工具输出几十万字符，直接塞进历史：
- 上下文会爆
- 后续 turn 会被噪声淹没
- 会话状态不可持续

### 2. 但完整结果也不能直接丢
因为：
- 用户可能要看完整输出
- 后续需要追溯
- 工具执行必须可审计

### 3. 所以要做“两层结果”
- 历史里只保留 bounded preview
- 完整内容进托管文件
- 中间用 marker 和 file pointer 连接

这意味着 OpenCode 在这里已经明确区分了：

- **模型可见输出**
- **系统完整输出**

这是非常重要的一条 Agent runtime 设计边界。

它说明：
> 工具输出不是“越完整越好地塞给模型”，而是“按上下文经济学和可追溯性分层处理”。

---

## 七、为什么 application tools / location tools 要分层

OpenCode 不是只有一套“全局工具注册表”。

它区分：
- process 级 application tools
- location 级 tools

而且 location 注册可以覆盖 process 注册。

### 这在解决什么问题？
它在解决：
- 同一个名字的工具，在不同工作区 / 不同 scope 下可能有不同能力含义
- 某些工具只应该在当前 Location 内存在
- scope 结束后，注册应该自动撤销，露出上一层

这实际上说明：

> OpenCode 不把工具能力看成“全局静态常量”，而是“有作用域、有生命周期的运行时能力”。

这对后面理解：
- plugin
- project workspace
- permission
- command
都很关键。

---

## 八、这一章真正解决了哪些工程问题？

### 1. 如何把模型调用和工具执行隔离成协议过程
而不是让模型直接碰到本地函数世界。

### 2. 如何保证工具输入输出契约稳定
防止模型乱传、工具乱返。

### 3. 如何保证“模型看到的工具”和“真正执行的工具”是同一代
这就是 stale rejection 的意义。

### 4. 如何防止超大工具输出把上下文炸毁
输出托管不是优化，而是主流程保护。

### 5. 如何让工具能力具有作用域和生命周期
这决定了系统扩展性和安全边界。

所以这一章真正教你的，不是“OpenCode 有哪些工具”，而是：

> **一个产品级 Agent runtime，如何把工具世界变成一个受契约、受作用域、受输出经济约束的系统。**

---

## 九、读者最容易学错的地方

### 误区 1：把工具调用当普通函数调用
错。它是模型驱动协议过程。

### 误区 2：把 ToolRegistry 当工具字典
错。它是结算边界和运行时能力控制面。

### 误区 3：把 bounded output 当 UI 体验优化
错。它直接关系到上下文可持续性和状态可追溯性。

### 误区 4：把 stale rejection 当边角 case
错。它在保护“广告能力”和“执行能力”的一致性。

### 误区 5：把工具作用域当成简单命名空间
错。它实际上是在定义能力生命周期。

---

## 十、分析边界

### 为什么这里不先展开某个 leaf tool 的实现细节
因为这一章关注的是：
- 工具协议
- 结算语义
- 输出边界
- 作用域和生命周期

而不是某个具体 leaf tool 如何读文件或执行 shell。

### 为什么这里不先看 plugin 生态的细节
因为 plugin 只是能力来源之一；如果先不理解 registry / scope / settlement，后面看插件只会变成加载器细节堆砌。

### 为什么测试是关键证据
很多关键语义——例如 stale rejection、bounded output、permission correction——并不只靠注释能看出来，测试就是设计契约。

---

## 十一、读者分层路由

### beginner
先抓住三个点：
1. 工具不是函数，是协议能力
2. 注册表不是字典，是运行时边界
3. 输出托管不是优化，是主流程保护

### intermediate
重点看：
- settlement pipeline
- stale rejection
- output store
- scope 覆盖

### advanced
重点看：
- runtime opaque value 设计
- definition cache
- application vs location 两级能力系统
- 为什么这套设计适合与 permission / plugin / session runtime 组合

---

## 十二、迁移清单

### 可迁移思想 1：工具 = 受 runtime 管控的句柄
- 可迁移到：任何需要动态注册、动态作用域、动态权限的 Agent 系统
- 前提：工具执行必须统一经过 registry / settlement
- 不能照搬的点：静态单进程、无插件、无权限系统的 toy agent 不一定需要不透明值设计

### 可迁移思想 2：settlement pipeline
- 可迁移到：所有需要 tool schema / structured output / context binding 的 Agent 系统
- 前提：输入输出都要可验证
- 不能照搬的点：如果模型和工具之间没有结构化协议，pipeline 不会有这么大价值

### 可迁移思想 3：stale rejection
- 可迁移到：支持工具热替换、插件卸载、作用域覆盖的系统
- 前提：必须存在“广告工具”和“真正执行工具”之间的时间差
- 不能照搬的点：完全静态工具集合的系统不一定需要这层防护

### 可迁移思想 4：bounded preview + full output store
- 可迁移到：所有会把工具结果回喂上下文的大模型 Agent
- 前提：完整结果和模型可见结果允许分层
- 不能照搬的点：如果工具结果不需要进入上下文，这层可以弱化

---

## 十三、关键源码位置

- `packages/core/src/tool/tool.ts`
  - 工具值、不透明 runtime、decode/execute/encode/project 管线
- `packages/core/src/tool/registry.ts`
  - stale rejection、scope 覆盖、settleWith 七步
- `packages/core/src/tool-output-store.ts`
  - bounded preview、完整输出托管、保头保尾截断
- `packages/core/src/tool/application-tools.ts`
  - process 级 application tools
- `packages/core/src/tool/tools.ts`
  - location 级 tools
- `packages/core/test/application-tools.test.ts`
  - 全局工具注册行为契约
- `packages/core/test/tool-*`
  - leaf tool 输入输出边界、settlement、bounded output 契约

## 十四、工程问题学习点

### 工程问题 1：如何把工具能力从“本地函数”提升成“受 runtime 控制的协议能力”
- OpenCode 的解法：不透明工具值 + ToolRegistry
- 代价：调试成本更高，理解门槛更高
- 可迁移性：适合需要权限、插件、作用域管理的 Agent runtime

### 工程问题 2：如何让工具输出既不炸上下文，又不丢失完整结果
- OpenCode 的解法：bounded preview + full output store
- 代价：系统里要多一层托管和 file pointer 语义
- 可迁移性：适合所有会把工具结果喂回模型的系统

### 工程问题 3：如何保证“模型看到的工具”和“真正执行的工具”是同一代能力
- OpenCode 的解法：stale rejection
- 代价：注册系统需要维护身份一致性
- 可迁移性：适合插件、热替换、作用域覆盖明显的系统

## 十五、自测问题

1. 为什么 OpenCode 不把工具直接暴露成可执行对象？
2. 为什么工具执行要走 decode → execute → encode → bound 这条结算管线？
3. stale rejection 在保护什么一致性？
4. output store 为什么不是附属优化，而是主流程保护？
5. application tools 和 location tools 的分层在保护什么边界？

## 十六、OpenCode 项目级边界说明（适用于前几章）

对 OpenCode 的第一轮分析，统一采用以下边界：

- **主线优先**：先看 core session runtime（event / input / runner / context / tool / permission）
- **协议后置**：MCP / ACP / server / client / sdk 先作为后段横切能力，不抢前几章主线
- **UI 降级**：CLI / web / tui / desktop 等视觉层不进主线
- **测试入主证据层**：因为很多运行语义只在测试里写得最清楚
- **leaf tool 降级**：具体 read/write/bash/webfetch 等实现不先展开，先理解 registry/settlement 边界

这条总边界的目的是：
> 先学“系统怎么成立”，再学“系统怎么被外化成产品”。

## 十七、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 的工具调用不是普通函数调用。
2. 说清 ToolRegistry 为什么是协议结算边界。
3. 理解 stale rejection 在保护什么一致性。
4. 理解 output store 为什么不是附属优化，而是主流程保护。
5. 说明 application tools / location tools 的分层为什么对 Agent runtime 很重要。
6. 用自己的话复述：一个产品级 Agent 系统为什么不能把工具执行做成“模型一喊就直接调函数”。

如果还做不到这些，就说明这章还没真正学懂。
