# JWT 签发、刷新与网关鉴权

> 对应目录：`vol-xhs/01-user-account-auth/`
> 目标问题：用户注册成功之后，一个“新身份”是怎样变成可跨网关、跨服务流动的可用登录态的？`my-xhs` 为什么要同时维护 Access Token、Refresh Token、黑名单、单设备登录和网关 Header 注入？

## 一句话困惑

注册完成只代表数据库里多了一个用户，但系统真正要跑起来，光有用户表远远不够。

用户接下来还会连续经历几件事：

- 登录时拿到一对 Token
- 用 Access Token 走业务请求
- Access Token 过期后，用 Refresh Token 换新 Token
- 注销时让旧 Token 失效
- 网关再把用户身份注入下游服务

如果把这些动作想成“JWT 就是一串字符串，带上就行”，整条认证链会很快失真。因为在 `my-xhs` 里，JWT 并不是一个孤立的签名结果，而是一条跨 `user → Redis → gateway → 下游服务` 的状态传播链。

这篇要讲清楚的，不是 JWT 规范本身，而是：**为什么 `my-xhs` 既用了无状态 Token，又同时保留了 Redis 中的活跃 Token 映射、黑名单、单设备登录和 HMAC 密钥，这些机制到底在一起守什么边界。**

## 一句话答案

在 `my-xhs` 里，JWT 不是“完全无状态”的裸令牌，而是**用户域生成的身份快照 + Redis 持有的会话侧状态 + Gateway 负责的跨服务传播**三者共同构成的登录态：Access Token 负责短期携带身份，Refresh Token 负责续期，Redis 负责单设备登录、黑名单和 HMAC 密钥，Gateway 再把这些结果翻译成下游服务可直接消费的 `X-User-Id / X-User-Role / X-Trace-Id` 头部。

## 先建立最小心智模型

先不要把 JWT 理解成“只要签个名就结束”。在当前实现里，登录态至少有四层：

```text
UserService / TokenService
  负责：签发 Access + Refresh + HMAC Secret

Redis
  负责：活跃 Token 映射、黑名单、刷新锁、HMAC Secret 存储

GatewayAuthFilter
  负责：验签、验黑名单、验类型、注入身份 Header

下游服务
  负责：直接消费 X-User-Id / X-User-Role，不再各自重复验 JWT
```

这四层少任何一层，当前系统的认证体验和安全边界都会变样。

## 先推演第一个最直觉的失败方案：JWT 一旦签出来，系统就再也不需要服务端状态

这是很多人第一次接触 JWT 时最容易接受的宣传版本。

### 为什么这个方案很诱人

因为它非常省事：

- 登录时签一个 Token
- 每次请求网关验签
- 过期就重新登录

服务端几乎不用存任何状态，听起来特别适合微服务。

### 它在 `my-xhs` 上会先坏在哪里

它会先坏在三个现实需求上：

1. **单设备登录**：后登录是否要踢掉前登录？
2. **主动注销**：用户点“退出登录”后，旧 Token 是否还能继续用到自然过期？
3. **Refresh Token 并发刷新**：多个请求同时发现 Access 过期，都拿同一个 Refresh 去换新 Token 时怎么办？

如果系统真的完全不存服务端状态，这三件事都很难优雅处理。JWT 会变成“一旦发出就只能等它自然过期”的纯离线凭证。

### `my-xhs` 为什么不走这条路

`TokenService` 的类注释在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:20` 到 `:26` 已经写得很清楚：

- Access Token 存 Redis
- Refresh Token 也存 Redis
- 注销时把 Token 的 `jti` 加入黑名单
- 黑名单 TTL 等于 Token 剩余有效期

这说明当前实现从一开始就没有把 JWT 当成“完全无状态”方案，而是明确承认：**JWT 负责携带身份，Redis 负责补上会话控制。** Redis 里保存的不只是 Access / Refresh 映射和黑名单，还包括当前会话的 HMAC Secret；这份 Secret 与 Refresh Token 使用同一生命周期，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:98` 到 `:106`，因此它也是会话态的一部分，而不是登录响应里孤立返回的一串字符串。

## 再推演第二个失败方案：既然有 Redis，那就把 Token 本身也当纯服务端 Session，用网关查库或查 Redis 决定用户身份

如果第一个方案太“无状态”，另一个也很自然的极端就是：那就彻底别信 JWT 里的内容了，所有请求都让网关去 Redis 或数据库查当前会话和用户状态。

### 为什么这个方案也很诱人

因为它看起来可控：

- 用户是谁，以服务端记录为准
- 注销、踢出、封号马上生效
- 不担心 JWT 里带旧信息

### 它为什么同样不适合当前实现

它会把网关从“验签与传播层”变成“在线会话查询中心”。

在 `my-xhs` 这种所有请求都经 Gateway 进入的系统里，这意味着：

- 网关每个请求都要额外查 Redis 或 DB 再决定用户是谁
- 每个服务的高频读请求都要附带一层中心化会话依赖
- `X-User-Role` 这类本来可由 JWT claim 直接携带的值，会被迫变成实时查询逻辑

而当前系统的 Gateway 选择了另一条路：**先验 JWT 本身的正确性，再只在关键边界点（如黑名单）查 Redis。** 这样既保留了 Token 的快读优势，又补上了必要的会话控制能力。

## 第一步：登录时签发的不是一个 Token，而是一整组会话材料

当前登录成功后，`UserService.login()` 最终会调用 `TokenService.generateTokenPair()`，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:218` 到 `:222`。

`TokenService.generateTokenPair()` 从 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:56` 开始，真正生成的不是一个值，而是三样东西：

1. `Access Token`
2. `Refresh Token`
3. `per-session HMAC Secret`

### Access / Refresh 分工非常明确

- `Access Token`：短期、给业务请求用
- `Refresh Token`：长期、只给续期用

从代码看，两个 token 都是通过 `JwtUtil.generateToken(...)` 生成，但 `type` claim 不同，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:73` 到 `:76`。

### role claim 也在登录时被写进 JWT

`TokenService.generateTokenPair()` 还会把 `role` 写进额外 claim，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:57` 到 `:72`。

这点很关键，因为它说明当前系统不打算让 Gateway 为了知道用户角色再去查一次用户库。角色真相在登录时先拍进 JWT，后面 Gateway 只负责安全传播：`TokenService.generateTokenPair()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:67` 到 `:76` 把 `role` 写入 claim，`GatewayAuthFilter` 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126` 到 `:142` 读取同一个 claim，再用 `set()` 注入 `X-User-Role`。

### HMAC Secret 说明 JWT 在当前系统里不是唯一安全层

`TokenService` 还会生成一份 per-session `hmacSecret` 并存入 Redis，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:98` 到 `:106`。

这意味着：

- JWT 负责证明“你是谁”
- HMAC 负责证明“这个请求没被篡改”

这已经说明当前认证链不是单一 JWT 层，而是 JWT + HMAC 双层。

## 第二步：Redis 里保存的不是“JWT 副本”，而是会话控制状态

签发完 Token 后，系统还要把当前活跃的 Access / Refresh 映射存进 Redis，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:84` 到 `:96`。

### 单设备登录是这里决定的

`TokenService` 在注释里已经写透：当前设计是“单设备登录”。当用户再次登录时，会取出旧 Access Token 并加入黑名单，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:78` 到 `:82`。

这说明 Redis 这里承担的不是“把 JWT 再存一份”，而是：

- 决定谁是当前活跃会话
- 决定旧设备会不会被踢下线

### 黑名单让“主动失效”成为可能

仅靠 JWT 过期时间，系统无法在注销后立刻让旧 Token 失效。

当前实现通过 `blacklistByClaims()` 把 Token 的 `jti` 写入 Redis 黑名单，并把 TTL 设成剩余有效期，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:305` 到 `:317`。

这说明当前系统真正相信的不是“JWT 签出来就不管了”，而是：

```text
JWT 仍然有效
但只要 jti 在黑名单里
Gateway 就要把它视为已失效
```

### Refresh 并发刷新也靠 Redis / Redisson 守住

`refreshToken()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:150` 到 `:197` 里，用 `jti` 维度的分布式锁防止多个请求并发刷新同一 Refresh Token。

这说明续期在当前实现里不是一个“纯函数”动作，而是一个需要服务端状态帮助收束并发窗口的动作。

## 第三步：Gateway 负责把身份从 JWT 翻译成下游可直接消费的头部

`GatewayAuthFilter` 是整条身份传播链的另一半核心。

它在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:31` 到 `:39` 的注释里，把逻辑写得很明白：

1. 白名单放行
2. 提取 Bearer Token
3. 解析 JWT
4. 检查黑名单
5. 鉴权通过后注入 `X-User-Id`

### 为什么白名单既存在于 JWT 层，也存在于 HMAC 层

`gateway` 的配置文件在 `my-xhs-gateway/src/main/resources/application.yml:290` 到 `:340` 里分别维护了：

- JWT 鉴权白名单
- HMAC 签名白名单

这说明当前系统已经明确区分：

- “这个接口要不要登录”
- “这个接口要不要签名防篡改”

登录和签名是两条不同安全维度，不是一个白名单就能统一解决的。

### Gateway 真正传播到下游的是什么

`GatewayAuthFilter` 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126` 到 `:149` 中，会把：

- `X-User-Id`
- `X-User-Role`
- `X-Trace-Id`

统一注入到下游请求里。

这意味着下游服务在大多数情况下并不自己重复解析 JWT，而是把网关已经验证过的身份结果当作可信入口条件。这也是为什么用户服务登录时要提前把 `role` 写进 JWT claim：Gateway 才能无状态地把角色传播下去。

## 第四步：为什么 Gateway 还要查 Redis 黑名单，而不是只验 JWT 签名

这是当前实现里最容易被忽略的一步。

如果 Gateway 只做 JWT 验签，那么只要：

- Token 没过期
- 签名没问题

它就会被放行。

但当前实现并不满足于此。`GatewayAuthFilter.isBlacklisted()` 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:203` 到 `:227` 中，会额外查 Redis 黑名单。

也就是说，Gateway 采用的是：

```text
JWT 签名正确
+ Token 类型正确
+ jti 不在黑名单
= 才算真正有效
```

这说明当前系统并没有把 JWT 验签当成全部，而是把 Redis 里的会话控制状态再叠了一层。这样注销、踢人、旧设备失效、部分封禁场景才真正成立。

## 第五步：刷新和注销不是 Access Token 的附属功能，而是会话链的第二条状态机

到这里，已经能看出登录态不是“签一个 access token 就完事”。

### Refresh 解决的是“身份连续性”

`TokenService.refreshToken()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:125` 到 `:197` 中，至少做了五层保护：

1. 解析 Refresh Token 并检查 type=refresh
2. 查黑名单
3. 对同一个 `jti` 上锁防并发刷新
4. 再校验 Redis 中存储的活跃 Refresh 是否与传入值一致
5. 检查用户当前状态是否仍然正常，再生成新 Token 对

这说明刷新在当前实现里不是“过期了重新签一张”，而是**对会话连续性重新做一次确认。**

### Logout 解决的是“会话主动终止”

`TokenService.logout()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:200` 到 `:234` 中，会：

- 把 Access Token 加入黑名单
- 如果有 Refresh Token，也一并加入黑名单
- 删除 Redis 里的活跃 Token 映射和 HMAC Secret

这说明注销并不是“前端把 token 丢掉”，而是服务端主动宣布：这对会话材料从现在起不应再被 Gateway 认可。

## 为什么 Redis 不可用时，Gateway 黑名单查询也要 fail-closed

注册一章里我们已经看到 Redis 不可用时注册会 fail-closed。JWT 链这里同样有一个非常关键的保守策略。

`GatewayAuthFilter.isBlacklisted()` 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:210` 到 `:226` 里明确写了：Redis 黑名单查询异常时，拒绝请求。

这说明当前系统的选择是：

```text
黑名单查不到
→ 宁可误拒
→ 也不冒“已注销 Token 复活”的风险
```

也就是说，Gateway 这一层同样是 fail-closed，不把“认证基础设施异常”当成放松会话边界的理由。

## 远程运行态事实如何支撑这条认证链

从部署和交接材料看，这条认证链不仅存在于源码里，也已经被放进了真实运行态环境。

- 中间件机是 `21.130.247.89`，见 `docs/FINAL-HANDOFF.md:197` 到 `:213`
- Redis 对外有独立入口，见 `docs/FINAL-HANDOFF.md:200` 到 `:201`
- Nacos 在 `18848`，Gateway 与 user 服务都依赖它做配置和发现，见 `docs/FINAL-HANDOFF.md:204`

这意味着当前 JWT 链路不是“单体应用里的一段内存逻辑”，而是真实依赖：

- 用户服务签发 Token
- Redis 存活跃映射、黑名单、HMAC Secret
- Gateway 通过本地 fallback + Nacos 配置拿到 JWT/HMAC 密钥
- 下游服务通过 Gateway 注入的头部消费身份

也就是说，这条认证链本身就是一条跨进程、跨组件的运行时事实链。

## 真实故障案例：为什么“旧 Token 还有效”比“登录失败”更危险

认证链里最危险的问题，通常不是系统报 401，而是系统看起来一切正常，但不该活着的凭证还在活。

### 现象

如果当前实现没有：

- 单设备登录时把旧 Access Token 拉黑
- 注销时把 Access / Refresh 一起拉黑
- Gateway 再查 Redis 黑名单

那么用户重新登录、主动注销、账号禁用之后，旧 Token 都可能在过期前继续可用。

这类问题最糟糕的地方是，用户和业务方往往都以为“我已经退出/踢下线了”，但旧会话其实还活着。

### 根因

根因不在 JWT 签名，而在会话控制状态没有被重新收回来。JWT 本身只会证明“这个 token 当时是合法签出来的”，不会自己知道“现在它还应不应该继续被信任”。

### 修复

当前实现围绕这个问题布了三层防线：

1. 生成新 Token 对时，把旧 Access Token 加入黑名单，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:78` 到 `:82`
2. 注销时，把 Access 和 Refresh 一起拉黑并清 Redis 映射，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:203` 到 `:228`
3. Gateway 每次放行前再查黑名单，见 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:119` 到 `:123`

### 验证

验证这类问题，不能只看登录成功，而要看：

- 同一用户新登录后，旧设备 Token 是否被 Gateway 拒绝
- 注销后原 Access Token 是否立刻失效
- Refresh Token 是否也同步失效
- Gateway 注入的 `X-User-Id / X-User-Role` 是否只出现在有效会话请求里

### 余波

这个案例说明，**JWT 链真正难的不是签发，而是回收。** 签得出来不稀奇，签出去之后还能在正确时刻把旧会话收回来，才是这条链真正的安全边界。

## 这一篇先收束成一张总图

```text
登录成功
  → user/TokenService 生成 Access + Refresh + HMAC Secret
  → Redis 保存活跃 Token 映射与 HMAC Secret

业务请求
  → Gateway 解析 Access Token
  → 校验 type=access
  → 查 Redis 黑名单
  → 注入 X-User-Id / X-User-Role / X-Trace-Id
  → 下游服务直接消费身份头

Access 过期
  → Refresh Token 走分布式锁刷新
  → 旧 Refresh 拉黑
  → 生成新 Token 对

注销 / 踢出 / 凭证失效
  → Access / Refresh 拉黑
  → Redis 活跃映射与 HMAC Secret 删除
  → Gateway 后续请求拒绝放行
```

这里最重要的不是背接口名，而是三条判断：

1. 当前系统的登录态不是裸 JWT，而是 JWT + Redis 会话控制 + Gateway 身份传播三层叠加。
2. Gateway 的职责不是“顺手验个签”，而是把身份从 token 世界翻译成下游服务直接可消费的 Header 世界。
3. JWT 链最关键的边界不是签发成功，而是旧会话能否被及时、可靠地收回来。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 登录成功后生成 Access / Refresh / HMAC Secret：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:56`
- 单设备登录与旧 Access Token 拉黑：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:78`
- Refresh 并发锁与单设备校验：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:150`
- 注销时黑名单 + 清 Redis 映射：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:200`
- Gateway 白名单、验签、黑名单与 Header 注入：`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:31`、`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:119`、`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126`
- Gateway 黑名单查询异常时 fail-closed：`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:203`
- Gateway 的 JWT/HMAC 白名单配置：`my-xhs-gateway/src/main/resources/application.yml:290`、`my-xhs-gateway/src/main/resources/application.yml:329`
- 远程运行态中 Redis / Nacos / SkyWalking 等部署事实：`docs/FINAL-HANDOFF.md:197`

## 边界清单

- 本篇讨论的是用户名密码登录之后的 JWT 会话链，不展开第三方登录、短信验证码登录和细粒度权限模型。
- 当前实现是“单设备登录”，而不是多端会话共存；这一点来自 `TokenService` 的 Redis key 设计和旧 Token 拉黑逻辑。
- Gateway 当前使用 JWT + HMAC 双层保护；本文重点讲身份和会话，不深挖 HMAC 具体签名过程，这会放到网关安全篇进一步展开。
- 远程运行态事实在本文中主要用于说明这条链确实依赖 Redis/Nacos/Gateway 协同，不等于已在本文完成全部线上验签实测。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么注册成功之后，用户身份还要继续经过 TokenService、Redis 和 Gateway 才能变成真正可用的登录态。
- 为什么当前系统明明用了 JWT，却仍然大量保留服务端会话控制状态。
- 为什么旧会话的回收（黑名单、单设备登录、注销、凭证失效）比签发本身更决定这条链的安全边界。

但它还没回答更细的一层：当前用户一旦登录成功，角色、权限、内部调用令牌、网关白名单和下游 Header 之间，到底怎样组成完整的权限模型？

所以下一篇应该进入 `03-permission-model.md`，去回答**当前实现下，角色、JWT claim、X-Admin-Call、X-Internal-Call 和 Gateway 鉴权边界到底怎样协同**。
