# 权限模型与调用边界

> 对应目录：`vol-xhs/01-user-account-auth/`
> 目标问题：用户通过 JWT 鉴权之后，系统如何继续区分普通用户、管理员、内部服务和高敏感写操作？`X-User-Role`、`X-Admin-Call`、`X-Internal-Call`、JWT 白名单和 HMAC 白名单到底分别负责什么？

## 一句话困惑

上一章讲清了 JWT 如何签发、刷新、吊销，以及 Gateway 如何把用户身份注入下游。但“身份认证通过”只回答了一个问题：

```text
你是谁
```

它还没有回答：

- 你能不能创建商品？
- 你能不能初始化库存？
- 你是不是允许调用支付内部接口？
- 这个请求虽然登录了，是否还必须带 HMAC 签名？
- 一个内部回调为什么不能只靠 JWT，而还要额外检查 `X-Internal-Call`？

如果把这些问题都简单归成“有 JWT 就有权限”，系统的边界会迅速失控。

这篇要讲清楚的不是某个注解或某个 Header，而是：**`my-xhs` 如何把“身份认证”“角色授权”“管理调用”“内部服务调用”“请求完整性”拆成不同层次，并把它们组合起来。**

## 一句话答案

当前 `my-xhs` 的权限模型不是一把统一的 RBAC 锁，而是多层门禁叠加：JWT 负责证明身份，`role` claim 负责传播角色，`X-Admin-Call` 负责管理端二次校验，`X-Internal-Call` 负责服务间调用边界，HMAC 负责请求完整性并尝试防重放，Gateway 的两套白名单则分别控制“是否需要登录”和“是否需要签名”。这里的“尝试防重放”必须保留实现边界：当前 HMAC nonce 去重依赖 Redis，Redis 异常时过滤器会 fail-open 放行，见 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:144` 到 `:159`。认证通过只是拿到入场资格，真正能不能做某件事，还要看它属于哪一层门禁。

## 先建立最小心智模型

把当前权限链压成五层：

```text
JWT
  证明：请求来自哪个用户

X-User-Role
  传播：这个用户在 JWT 中携带的角色

X-Admin-Call
  授权：是否允许执行管理端操作

X-Internal-Call
  边界：是否允许服务间内部接口调用

HMAC
  完整性：请求参数/body 是否被篡改、是否重放
```

再加 Gateway 的两套白名单：

```text
JWT white-list
  决定：这个路径是否需要登录

HMAC white-list
  决定：这个路径是否需要签名
```

这套模型的第一个关键结论是：**登录、角色、管理、内部调用、签名不是同一个问题，因此也不应该共用同一个开关。**

## 先推演第一个最直觉的失败方案：只要 JWT 有效，就允许所有操作

这是最常见的权限简化方案。

### 为什么它很诱人

因为 Gateway 已经做了很多事：

- 校验 JWT 签名
- 校验过期时间
- 校验黑名单
- 注入 `X-User-Id`

于是有人会自然地认为：Token 有效就说明用户可信，后面的商品创建、库存初始化、订单操作都可以继续放行。

### 它会先坏在哪里

它会把“身份可信”错误地等同于“操作授权”。

一个普通登录用户即使身份完全合法，也不应该因此获得：

- 创建 SPU 的能力
- 初始化库存的能力
- 手动触发索引重建的能力
- 调用内部支付/库存接口的能力

`ProductController` 的创建 SPU 接口就明确要求 `X-Admin-Call`，见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:58` 到 `:71`；`InventoryController.initStock()` 也要求管理令牌，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:57` 到 `:64`。

所以 JWT 只能证明“这个请求带了合法身份”，不能自动证明“这个身份可以执行所有管理动作”。

## 再推演第二个失败方案：所有内部调用都复用用户 JWT

另一种常见想法是：既然所有请求都经过 Gateway，服务之间也可以带着用户的 JWT 调用彼此，没必要再搞 `X-Internal-Call`。

### 为什么这也很诱人

因为它看起来减少了一类凭据：

- 用户请求有 JWT
- Feign 调用继续传 JWT
- 下游服务只验一套东西

### 它真正会先坏在哪里

用户身份和服务身份不是同一种身份。

支付服务通知订单支付成功时，调用方不是用户，而是支付服务；订单服务调用库存预扣时，调用方也不是用户，而是订单服务。如果内部回调只看用户 JWT，就无法回答：

```text
这是用户在调用，还是一个被伪造的内部回调
```

当前 `OrderController.notifyPaySuccess()` 明确检查 `X-Internal-Call`，见 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188` 到 `:203`；库存预扣接口也做同样校验，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:67` 到 `:76`。

因此 `X-Internal-Call` 不是 JWT 的重复实现，而是另一条身份边界：**它证明调用者属于内部服务调用路径。**

## 第一步：JWT 只负责认证，不负责完整授权

GatewayAuthFilter 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:88` 到 `:124` 中完成：

1. 白名单判断
2. 提取 Bearer Token
3. 解析 JWT
4. 校验 `type=access`
5. 检查黑名单

通过之后，它在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126` 到 `:149` 中注入：

- `X-User-Id`
- `X-User-Role`
- `X-Trace-Id`

这一步只说明：

```text
请求来自一个合法、未吊销的用户会话
```

它没有替下游服务做所有业务授权决策。真正的管理权限和内部接口权限，仍然要由目标服务自己再次检查。

## 第二步：role claim 是传播信息，不是独立权限引擎

登录时，`TokenService.generateTokenPair()` 会把角色写入 JWT claim，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:67` 到 `:76`。

Gateway 再读取这个 claim 并注入 `X-User-Role`，见 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126` 到 `:142`。

这条链的意义是：

- user 服务知道角色真相
- token 携带角色快照
- gateway 负责传播角色
- 下游可以使用 `X-User-Role`

但当前代码不能被过度解读成“已经有完整 RBAC 引擎”。目前看到的是角色 claim 的传播和部分管理端点令牌校验，而不是一套细粒度的资源/动作/角色矩阵。

这也是一个必须守住的事实边界：**角色被传播了，不等于所有接口都已经按角色细粒度授权。**

## 第三步：管理接口使用 `X-Admin-Call` 做第二道门

商品创建接口是一个典型例子。

`ProductController` 注入了管理令牌和内部令牌，见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:42` 到 `:51`。

创建 SPU 时：

- 请求必须已经有 `X-User-Id`
- 还必须带正确的 `X-Admin-Call`
- 否则返回 403

实现见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:61` 到 `:71`。

库存初始化也是同一种模式：

- 只有管理调用才能初始化库存
- 普通用户即使 JWT 有效，也不能执行

见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:57` 到 `:64`。

这说明当前系统的管理授权更接近：

```text
JWT 认证
  + X-Admin-Call 管理令牌
  = 管理接口准入
```

`X-Admin-Call` 在这里不是角色本身，而是管理操作的第二道共享凭据。`X-Internal-Call` 也是同类设计：它能有效隔开“用户路径”和“服务路径”，但当前实现上本质仍是共享配置令牌，而不是更强的服务身份认证协议。
## 第四步：内部服务接口使用 `X-Internal-Call` 隔离用户调用路径

内部接口和管理接口不能混为一谈。

### 库存接口

库存的预扣、确认和释放只允许内部调用：

- `preDeduct`：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:67` 到 `:76`
- `confirm`：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:79` 到 `:88`
- `release`：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:91` 到 `:100`

它们都通过 `isInternalCall()` 校验 `X-Internal-Call`。

### 订单回调接口

支付服务通知订单支付成功、支付失败、退款成功时，订单接口也会检查 `X-Internal-Call`，见：

- 支付成功：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188` 到 `:203`
- 支付失败：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:213` 到 `:227`
- 退款成功：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:239` 到 `:253`

这条边界保护的是：

```text
只有服务间的受信调用链
才能触发库存状态机、订单回调和支付结果收敛
```

## 第五步：JWT 白名单和 HMAC 白名单解决两个不同问题

Gateway 配置在 `my-xhs-gateway/src/main/resources/application.yml:290` 到 `:340` 中维护了两套列表。

### JWT white-list

它决定哪些路径可以不登录访问，例如：

- 验证码
- 注册
- 登录
- Token 刷新
- 公开内容查询
- 公开分类/库存查询

### HMAC white-list

它决定哪些路径不需要请求签名。

配置注释已经明确说明：

- JWT 鉴权和 HMAC 是两个独立安全维度
- 写接口通常必须签名
- 公开读接口通常可以免签

这意味着一个接口可能出现以下组合：

```text
不需要 JWT，但也不需要 HMAC
  公开登录/注册接口

需要 JWT，但不需要 HMAC
  某些已登录公开读接口

需要 JWT，也需要 HMAC
  下单、支付、用户写操作等敏感写接口
```

如果把两套白名单合成一套，权限设计就会失去精度：要么公开接口被迫要求签名，要么敏感写接口因为 JWT 已通过而缺少请求完整性保护。

还要补上执行顺序这个运行时前提：HMAC 过滤器的实现依赖前面的 GatewayAuthFilter 已经把 `X-User-Id` 注入请求，`HmacSignatureFilter` 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:161` 到 `:167` 没有用户 Header 就直接拒绝；它的 order 又明确设在鉴权过滤器之后，见 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:213` 到 `:217`。所以这不是两套互不相关的过滤器，而是一条有顺序依赖的门禁链。
## 第六步：当前权限模型的真实缺口在哪里

按方法论，不能只介绍现有设计，也要明确当前边界和缺口。

### 1. role claim 已存在，但细粒度 RBAC 还不完整

用户实体有 `role` 字段，见 `my-xhs-user/src/main/java/com/myxhs/user/entity/User.java:45` 到 `:49`；登录时也把角色写进 JWT。但当前我们看到的主要是角色传播和管理令牌校验，不是覆盖所有资源、动作和角色的统一授权矩阵。

### 2. 管理操作依赖共享 AdminToken

`X-Admin-Call` 是有效的第二道门，但它更像共享凭据，而不是完整的角色权限系统。凭据泄露后的影响面、轮换方式和审计粒度，需要在安全专题中单独评估。

### 3. 内部调用依赖共享 InternalToken

`X-Internal-Call` 能隔开用户路径和服务路径，但它同样不是服务身份认证的完整替代方案。当前实现更接近配置化的内部调用门禁。

### 4. 网关放行不等于下游完全安全

Gateway 的白名单决定入口过滤器是否放行，但目标服务仍需要对管理/内部接口做自己的校验。否则一旦服务端口被绕过网关直接暴露，入口层的白名单就不能替代服务自身的授权检查。

## 远程部署事实如何影响权限模型

当前权限链依赖的关键基础设施都部署在远程中间件机 `21.130.247.89`：

- Nacos `18848`：配置中心保存 Gateway JWT/HMAC 配置的运行时优先来源，但本地 `application.yml` 仍保留 fallback 默认值，见 `docs/FINAL-HANDOFF.md:197` 到 `:205`
- Redis 主从/Sentinel：保存黑名单、活跃 Token、HMAC Secret 等会话态，见 `docs/FINAL-HANDOFF.md:200` 到 `:201`
- 微服务运行端口在服务机侧的 `19000~19016`，见 `docs/FINAL-HANDOFF.md:194` 到 `:195`

这意味着权限模型不是一个纯源码局部：

```text
Nacos 提供运行时密钥配置
Redis 提供会话与吊销状态
Gateway 执行入口认证与身份传播
业务服务执行管理/内部接口二次校验
```

任何一层失配，都可能表现为：

- 所有请求突然 401/403
- 内部 Feign 全部 403
- 管理接口不可用
- 注销后的 Token 仍被放行

## 真实故障案例：为什么“认证通过但权限失败”通常不是 JWT 坏了，而是门禁层级不匹配

权限模型最常见的故障，不是 Token 完全无效，而是请求已经通过了一层，却在下一层被拒绝。

### 现象

典型表现包括：

- 用户带着合法 JWT 调用商品创建，返回 403
- 订单调用库存预扣，返回 403
- 支付服务调用订单回调，返回 403
- 网关公开放行了路径，但下游管理/内部校验仍拒绝

### 根因

根因通常是把不同门禁当成了同一件事：

- 只有 JWT，没有 `X-Admin-Call`
- 只有 JWT，没有 `X-Internal-Call`
- JWT 白名单放行了，但 HMAC 仍要求签名
- Nacos/Gateway/业务服务中的 token 配置不一致

### 修复

当前代码通过分层校验解决：

1. Gateway 先做 JWT 类型、签名、黑名单检查
2. 敏感写接口再经过 HMAC 完整性检查
3. 管理端点再检查 `X-Admin-Call`
4. 内部接口再检查 `X-Internal-Call`

### 验证

验证权限模型不能只测“带 Token 能不能访问”，而要形成矩阵：

- 无 JWT → 401
- JWT 正确但无 AdminToken → 403
- JWT 正确但无 InternalToken → 403
- JWT + AdminToken/内部令牌都正确 → 才进入业务逻辑
- 敏感写接口缺 HMAC → 403

### 余波

这个案例说明，**权限问题最难排查的地方，是请求可能已经通过了认证层，却死在授权、内部调用或完整性层。** 不把门禁拆层，日志里的 401/403 就很难还原真正的责任边界。

## 这一篇先收束成一张总图

```text
外部请求
  → Gateway JWT 认证
  → 黑名单检查
  → 注入 X-User-Id / X-User-Role
  → HMAC 完整性检查（敏感路径）
  → 下游服务
      ├─ 普通业务：用户身份 + 业务归属校验
      ├─ 管理接口：X-Admin-Call
      └─ 内部接口：X-Internal-Call
```

这里最重要的不是记住 Header 名，而是三条判断：

1. 认证通过只代表“你是谁”，不代表“你能做什么”。
2. 管理调用、内部服务调用、请求完整性是三类不同问题，不能用 JWT 一把解决。
3. Gateway 是第一道入口门禁，但业务服务仍必须对高敏感接口做自己的第二道校验。

## 证据清单

这篇的关键判断主要由以下证据托底：

- Gateway JWT 验证和身份传播：`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:88`
- JWT role claim 到 `X-User-Role`：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:67`、`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126`
- HMAC 完整性校验、nonce 去重与 per-session secret：`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:109`、`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:144`、`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:161`
- JWT/HMAC 双白名单：`my-xhs-gateway/src/main/resources/application.yml:290`、`my-xhs-gateway/src/main/resources/application.yml:329`
- 管理接口 `X-Admin-Call`：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:42`、`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:61`
- 库存内部接口 `X-Internal-Call`：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:67`
- 订单内部回调 `X-Internal-Call`：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188`
- 逻辑删除用户并吊销凭证：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:242`
- 远程部署/运行态基础设施：`docs/FINAL-HANDOFF.md:197`

## 边界清单

- 本篇讨论的是当前实现的权限门禁分层，不等于声明系统已经具备完整的细粒度 RBAC/ABAC 权限平台。
- `X-Admin-Call` 和 `X-Internal-Call` 是当前实现里的配置化门禁，不等于完整的服务身份认证协议。
- JWT 白名单和 HMAC 白名单是两套独立配置，本文不展开 HMAC 签名算法和 nonce 防重放过程。
- Gateway 端口与业务服务端口存在部署边界，本文只讲权限责任分层；服务端口是否已在运行态被网络层彻底隔离，当前未在本文完成实测验证，因此不把“无法绕过网关直连”写成既成事实。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么 JWT 有效不等于业务操作已经授权。
- 为什么管理令牌、内部令牌、HMAC 签名和角色 claim 必须分层处理。
- 为什么 Gateway 第一层放行之后，目标业务服务仍然必须保留自己的高敏感接口校验。

但它还没进入用户会话生命周期的最后一层：Token 什么时候过期、刷新如何并发收敛、注销和改密如何吊销全部凭证、单设备登录如何影响旧会话？

所以下一篇应该进入 `04-session-management.md`，去回答**会话如何创建、续期、吊销和在分布式环境里保持一致**。
