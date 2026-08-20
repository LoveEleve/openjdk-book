# MCP 与协议外化：OpenCode 如何把内部控制面扩展成生态接口

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 07
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q20-mcp.md`

---

## 零、阅读前提示

- 建议先读：
  1. `00-OpenCode主线总图.md`
  2. `02-EventV2与SessionInput...`
  3. `03-SessionRunner与SessionExecution...`
  4. `04-ToolRegistry与Tool Settlement...`
  5. `05-SystemContext与Compaction...`
  6. `06-Permission与Approval...`
  7. `07-SessionProjector与History...`
- 推荐源码阅读路径：
  1. `packages/opencode/src/mcp/index.ts`
  2. `packages/opencode/src/mcp/oauth-provider.ts`
  3. `packages/opencode/src/mcp/auth.ts`
  4. `packages/opencode/src/mcp/oauth-callback.ts`
  5. `packages/opencode/src/mcp/catalog.ts`

## 一、这一章真正的问题

前面几章一直在讲 OpenCode 的内核：
- 真相源
- 执行骨架
- 工具协议
- 上下文工程
- 权限控制
- 用户可见会话视图

但一个成熟的 Agent 产品，不可能永远只活在本地 CLI 内部。它终究要回答：

> **这套内部控制面，如何向外部系统暴露出去，并且仍然保持协议、认证、生命周期和安全边界的完整性？**

对于 OpenCode，这个问题最核心的回答之一就是：
- MCP
- 以及围绕它展开的 OAuth、凭证绑定、目录发现、连接状态机

所以这一章不是在讲“又接了一个协议”，而是在讲：

> **OpenCode 如何把内部能力系统外化成生态接口，而不把运行时边界搞乱。**

---

## 二、先给结论：MCP 不是附加集成功能，而是控制面外化层

最容易犯的错，是把 MCP 看成：
- 一个多出来的工具协议
- 或者“支持一下外部工具”

这会严重低估它的系统地位。

对于 OpenCode 来说，MCP 的真正意义是：

1. **把内部的工具 / prompt / resource / instruction 能力，标准化地向外暴露**
2. **把连接状态、认证状态、客户端注册状态纳入统一生命周期管理**
3. **让 OpenCode 不只是一个本地 Agent，而是一个可被外部生态接入的 Agent 平台节点**

也就是说：
> MCP 在这里不是“插件功能”，而是“控制面的对外协议化”。

---

## 三、为什么 MCP 的能力面要做成 19 个方法 + 5 态状态机

从外表看，这像是一个功能列表：
- status
- clients
- tools
- prompts
- resources
- connect / disconnect
- auth 系列

但真正重要的不是“方法多”，而是：

> **OpenCode 明确把“能力面”和“生命周期状态”一起纳入了 MCP 层。**

### 1. 只读能力面
例如：
- tools
- prompts
- resources
- resourceTemplates
- instructions

这些说明：
OpenCode 希望外部系统能够看到它的能力目录，而不是把接入写死在内部。

### 2. 生命周期面
例如：
- add
- connect
- disconnect

这些说明：
连接不是静态存在的，而是有建立、失败、恢复、关闭这些状态。

### 3. 认证面
例如：
- startAuth
- authenticate
- finishAuth
- supportsOAuth
- hasStoredTokens
- getAuthStatus

这说明：
OpenCode 认为“外部协议接入”不是只看 transport，还必须把 auth 做成显式控制面。

### 4. 5 态状态机
- connected
- disabled
- failed
- needsAuth
- needsClientRegistration

这比一个 boolean `connected` 成熟得多，因为它区分了：
- 物理连接状态
- 认证状态
- 客户端注册状态
- 不可用状态

所以这一层的本质不是“方法清单”，而是：
> **MCP server/client 生命周期的状态建模。**

---

## 四、三种传输为什么值得单独讲

OpenCode 的 MCP 不是只支持一种 transport。

它支持：
- stdio
- StreamableHTTP
- SSE

这不是“多做几个适配器”这么简单。

它在回答的是：

> **Agent 的对外控制面，必须能够根据不同宿主环境切换传输形态。**

### stdio
更像本地进程协作。

### StreamableHTTP
更适合服务化 / 长连接式控制面。

### SSE
适合事件流式外送。

所以这里应该学到的不是“有三种 transport”，而是：
- OpenCode 把 transport 视为控制面的外化手段
- 而不是控制面本身

这和前面我们讲：
- session 内核
- tool protocol
- permission
- context

是同一条设计路线：
> **先把语义内核站稳，再做外化适配。**

---

## 五、OAuth 授权码流为什么是 MCP 的主线部分，而不是认证附录

如果只是临时接一下第三方服务，OAuth 当然像附录。

但 OpenCode 不是这样，它把 OAuth 设计成了 MCP 生命周期里的主线一环。

这里最重要的点有几个：

### 1. client metadata / client information 被显式建模
说明它不是“拿个 token 用一下”，而是在认真对待客户端身份。

### 2. 动态客户端注册（DCR）
当没有现成 `clientId` 时，OpenCode 不是放弃，而是：
- 动态注册
- 拿到 client 信息
- 继续走授权链路

这说明它要支持的是：
> **现实世界里不一定一开始就把客户端全部预配置好。**

### 3. client secret 过期重注册
这说明 OpenCode 不把 client identity 当静态死配置，而是把它放进真实生命周期里。

### 4. code verifier / oauthState 持久化
这说明 OAuth 不是“一次函数回调”，而是会话/流程状态的一部分。

所以 OAuth 在这里不是“认证功能”，而是：
> **控制面外化以后，身份如何被持续管理。**

---

## 六、为什么凭证必须按服务器 URL 绑定

这是 MCP 这层最值得学的安全判断之一。

OpenCode 不是只存：
- 某个 MCP 名称
- 某个 token

它还会绑定：
- **server URL**

这意味着：
- 同名服务器，URL 变了，凭证不算同一个对象
- 避免把原来对 A 服务器的 token，错配到 B 服务器上

这是非常重要的，因为外部控制面最危险的情况之一就是：
> **凭证错绑到错误目标。**

所以这里的思想是：
- 凭证不只是用户的
- 凭证还是“面向某个明确远端目标”的

这其实是一种很成熟的“身份 + 目标绑定”设计。

---

## 七、Pending 暂存为什么不是实现细节，而是失败安全设计

MCP OAuth 里有一个特别值钱的点：
- pending client info
- pending tokens
- commit 之前只暂存在内存

这件事很容易被看成实现小技巧，实际上它解决的是：

> **认证中途失败时，不要污染已有凭证状态。**

如果没有这层：
- 新 token 写了一半
- client info 写了一半
- callback 或后续步骤失败
- 系统就会留下半更新状态

OpenCode 在这里用 pending + commit 的方式，把 OAuth 流程做成了：
- 先收集
- 再一次性确认
- 中途失败不污染旧值

这和前面 EventV2 / projector / settlement 的思想是一致的：
> **不允许半成品状态悄悄进入系统真相。**

---

## 八、这一章真正解决了哪些工程问题？

### 1. 如何把内部 Agent 能力系统安全地外化为对外协议
OpenCode 的解法：MCP 能力面 + 生命周期状态机

### 2. 如何让 transport 多样化而不破坏控制面语义
OpenCode 的解法：stdio / HTTP / SSE 三传输，但统一放在 MCP 控制层

### 3. 如何让 OAuth 不只是“认证一下”，而是纳入系统生命周期
OpenCode 的解法：DCR + state + verifier + pending + commit

### 4. 如何防止凭证错配与中途污染
OpenCode 的解法：URL 绑定 + pending 暂存 + commit 后持久化

### 5. 如何把 CLI Agent 推向生态节点
OpenCode 的解法：协议外化，而不是把所有接入逻辑塞进本地 runtime

所以这一章最值得学的，不是“MCP 是什么”，而是：

> **一个成熟 Agent 系统，如何把内部控制面外化，而不把安全边界和状态一致性打烂。**

---

## 九、读者最容易学错的地方

### 误区 1：把 MCP 看成工具协议插件
错。它更像控制面的对外协议化。

### 误区 2：把 OAuth 当登录流程
错。这里的重点不是登录，而是“外部控制面的身份生命周期管理”。

### 误区 3：把 transport 当成系统本体
错。transport 只是控制面外化手段，核心仍然是内部 runtime 语义。

### 误区 4：把 pending 暂存当实现细节
错。它在保护凭证状态一致性。

### 误区 5：把 URL 绑定看成存储细节
错。它在保护凭证与远端目标的安全绑定关系。

---

## 十、分析边界

### 为什么这里不先展开 MCP 协议全文细节
因为第一轮分析目标不是重写 MCP 规范，而是理解 OpenCode 如何把 MCP 纳入自己的控制面。

### 为什么这里不先看前端 callback 页面
因为真正关键的是 OAuth 状态、token、client info 如何进入系统状态，而不是页面怎么渲染。

### 为什么这里不先深入每个 transport 的底层细节
因为这一章先关注“为什么会有三种 transport”和“它们如何统一于控制面语义”，而不是 transport 内部实现本身。

---

## 十一、读者分层路由

### beginner
先抓住：
1. MCP 是控制面外化，不只是一个插件接口
2. OAuth 在这里是生命周期问题，不只是认证一次
3. URL 绑定和 pending commit 是安全边界设计

### intermediate
重点看：
- 19 方法能力面
- 5 态状态机
- OAuth provider
- auth storage
- callback 语义

### advanced
重点看：
- 为什么把对外协议能力做成状态机
- 动态客户端注册与客户端过期重注册的系统含义
- transport / auth / runtime 三层是如何解耦的

---

## 十二、迁移清单

### 可迁移思想 1：把能力面、生命周期面、认证面统一纳入协议层
- 可迁移到：任何准备从 CLI 走向平台化 / 集成生态的 Agent
- 前提：内部 runtime 语义已经稳定
- 不能照搬的点：如果内核本身不稳定，先做协议外化只会暴露更多混乱

### 可迁移思想 2：凭证必须与目标 URL 绑定
- 可迁移到：所有多远端连接的工具 / server / MCP / plugin 生态
- 前提：存在多个可能同名但不同目标的服务
- 不能照搬的点：单一静态服务场景下收益较小

### 可迁移思想 3：OAuth 采用 pending 暂存后 commit
- 可迁移到：任何多步认证流程
- 前提：中途失败不能污染旧状态
- 不能照搬的点：一次性无状态 token 获取流程不一定需要这么重

---

## 十三、自测问题

1. 为什么 MCP 在 OpenCode 里不是附加协议，而是控制面外化层？
2. 为什么 transport 多样化不会改变控制面主语义？
3. 为什么 OAuth 在这里的重点是生命周期管理，而不是“能登录就行”？
4. 为什么凭证必须和服务器 URL 绑定？
5. 为什么 pending 暂存 + commit 对 OAuth 状态一致性很关键？

---

## 十四、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 需要把内部控制面外化成 MCP / 协议生态。
2. 说清三种 transport 为什么是外化手段，而不是系统本体。
3. 理解 OAuth 在这里为什么是协议生命周期问题。
4. 理解 URL 绑定与 pending commit 的安全意义。
5. 用自己的话说明：一个成熟 Agent 产品要从“本地 runtime”变成“生态节点”，需要补哪些系统层。

如果还做不到这些，就说明这章还没真正学懂。
