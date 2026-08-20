# 会话管理与凭证生命周期

> 对应目录：`vol-xhs/01-user-account-auth/`
> 目标问题：`my-xhs` 的会话到底怎样创建、续期、吊销和失效？为什么它明明用了 JWT，还要保留 Redis 里的活跃 Token 映射、刷新锁、黑名单和单设备登录语义？

## 一句话困惑

上一章已经把权限模型拆成了 JWT、角色、管理令牌、内部令牌和 HMAC 五层门禁，但这仍然没有回答另一个更贴近真实运行的问题：**一个用户会话从登录成功那一刻起，到自然过期、主动注销、改密失效、被新设备顶掉，中间到底经历了什么生命周期？**

如果把会话理解成“JWT 发出去之后等它自己过期”，很多现实现象都会解释不通：

- 为什么重新登录会把旧设备踢下线？
- 为什么 Refresh Token 刷新要加分布式锁？
- 为什么注销时既要拉黑 Token，又要删 Redis 映射和 HMAC Secret？
- 为什么删用户或改密码之后，旧会话要被整体失效？

这说明 `my-xhs` 的会话并不是一个纯离线 JWT，而是一条受 Redis 控制的会话生命周期。

## 一句话答案

在 `my-xhs` 里，会话不是“签发一个 JWT 就完事”，而是**Access Token + Refresh Token + HMAC Secret + Redis 活跃映射 + 黑名单**共同构成的生命周期状态：登录创建它，刷新替换它，注销与改密吊销它，新登录还能覆盖旧设备。JWT 负责携带身份，Redis 负责把这段身份变成一个可被回收、可被并发收敛、可被单设备约束的真实会话。

## 先建立最小心智模型

把当前会话链压成四层：

```text
Access Token
  短期业务凭证（默认 30 分钟）

Refresh Token
  长期续期凭证（默认 7 天）

HMAC Secret
  当前会话的请求签名密钥（与 Refresh 同生命周期）

Redis 会话态
  当前活跃 Token 映射
  黑名单
  Refresh 并发锁
```

再补一句最重要的判断：

```text
JWT 负责证明“这个身份当时被合法签发”
Redis 负责控制“这个会话现在还应不应该活着”
```

如果没有第二层，后面所有“主动失效”“单设备登录”“并发刷新”都会失去抓手。

## 先推演第一个最直觉的失败方案：会话只靠 JWT 自然过期

这是最常见的简化方案。

### 为什么这个方案很诱人

因为它足够干净：

- 登录时发一个 Access Token
- 过期前一直可用
- 过期后用户重新登录

不需要服务端保留任何状态，也不需要 Redis 去记当前会话。

### 它会先坏在哪里

它会先坏在“主动失效”这件事上。

如果系统只信 JWT 自然过期，那么：

- 用户点了退出登录，旧 Token 直到过期前都还能继续用
- 用户改了密码，旧设备仍能拿旧 Token 跑业务
- 管理员删了用户或冻结账号，旧 Token 也可能继续活到自然过期
- 新设备登录后，旧设备并不会被真正踢下线

也就是说，这个方案最大的问题不是“不优雅”，而是：**系统没有能力主动宣布某个会话现在已经不该活着了。**

## 再推演第二个失败方案：Access / Refresh 只存在于 Redis，不再让 JWT 自带身份

既然纯 JWT 不够，另一个也很自然的极端就是：索性所有请求都去 Redis 查一次当前会话，Token 自身只当随机 sessionId。

### 为什么这个方案也有诱惑力

因为它把所有控制权都收回服务端：

- 谁在线、谁被踢掉、谁过期，全在 Redis 里
- 网关不用再信 JWT claim
- 用户角色、用户状态随时都能实时查

### 它为什么同样不适合当前实现

它会把所有业务请求都拖成“在线会话查询”。

Gateway 当前已经能：

- 本地验 JWT 签名
- 本地读 claim
- 只在关键时刻查 Redis 黑名单

如果把整个会话都改成服务端 session 模式，那么每次请求都要更重地依赖 Redis 或后端状态服务，这会把 JWT 本来“可局部无状态传播”的优势完全吃掉。

所以 `my-xhs` 最终走的不是两个极端，而是中间路线：**JWT 携带身份，Redis 承载会话控制。**

## 第一步：登录真正创建的不只是两个 Token，而是一整段会话材料

`AuthController.login()` 在 `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:45` 到 `:56` 接收登录请求；真正的会话创建发生在 `TokenService.generateTokenPair()`，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:39` 到 `:114`。

### 会话创建时生成了三样东西

1. `Access Token`
2. `Refresh Token`
3. `per-session HMAC Secret`

这说明当前会话从一开始就不是“双 token 模式”那么简单，而是三件套：

```text
身份凭证
续期凭证
请求完整性凭证
```

### 会话创建时还立刻写了 Redis 活跃映射

`TokenService.generateTokenPair()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:84` 到 `:106` 中，把：

- Access Token
- Refresh Token
- HMAC Secret

都按 `userId` 维度写进 Redis。也就是说，会话刚一诞生，就已经被服务端纳入“当前活跃会话”管理。

这条设计很关键，因为它说明当前实现里的会话不是发出去就任其漂流，而是登录时立刻建立了一个服务端可回收的锚点。

## 第二步：单设备登录不是额外功能，而是 Redis Key 设计直接决定的结果

`TokenService` 在注释里已经写明当前设计是“单设备登录”，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:41` 到 `:47`。

### 为什么当前实现天然是单设备

因为 Redis 活跃映射的 Key 只有：

- `USER_TOKEN_ACCESS + userId`
- `USER_TOKEN_REFRESH + userId`
- `USER_HMAC_SECRET + userId`

对应常量见 `my-xhs-common/src/main/java/com/myxhs/common/constants/RedisKeyConstants.java:27` 到 `:37`。

这意味着，同一个 `userId` 在 Redis 里只有一份当前活跃的：

- Access Token
- Refresh Token
- HMAC Secret

任何新登录都会覆盖旧值。

### 为什么新登录会把旧会话踢下去

`generateTokenPair()` 在写新 Access Token 之前，会先取出旧 Access Token 并加入黑名单，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:78` 到 `:82`。

这里必须把一个细节说得更精确：当前登录时**显式拉黑的是旧 Access Token**；旧 Refresh Token 不一定在登录瞬间立刻进黑名单，而是因为 Redis 中的活跃 Refresh 映射被新值覆盖，后续旧 Refresh 再来刷新时，会在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:166` 到 `:173` 被识别成“已被其他设备覆盖”而拒绝。这说明当前实现里，旧 Access 和旧 Refresh 的失效路径并不完全相同：

- 旧 Access：登录当下即被拉黑
- 旧 Refresh：依赖活跃映射覆盖 + 刷新时校验被拒绝

这意味着新登录不是“多生成一套会话”，而是：

```text
新会话诞生
→ 旧 Access 立即失效
→ 旧 Refresh 失去续期资格
→ Redis 活跃映射改指向新会话
```

单设备语义在这里不是附加业务逻辑，而是会话存储结构直接推出来的行为。

## 第三步：Refresh 不是重新登录的轻量版，而是一条受锁保护的会话替换动作

`TokenService.refreshToken()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:116` 到 `:198` 中，远比一般人想象得更重。

### 刷新前先做四重身份确认

1. 解析 Token 必须成功
2. `type` 必须是 `refresh`
3. `jti` 不能在黑名单中
4. Redis 中当前保存的 Refresh Token 必须和传入值完全一致

其中第 4 步尤其关键，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:166` 到 `:173`。它说明刷新并不是“只要拿着一个没过期的 Refresh 就能换新”，而是：

**它还必须是这个用户当前活跃会话里那一份 Refresh。**

这一步正是单设备登录和旧会话覆盖能成立的基础。

### 为什么刷新必须加分布式锁

刷新时还会按 `jti` 加一把 Redisson 分布式锁，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:150` 到 `:158`。

这是因为当前实现已经承认：

- 多个请求可能同时发现 Access 过期
- 它们会同时拿同一个 Refresh 去换新 Token

如果不加锁，会话就会在并发刷新时分裂出多套新凭证。当前设计明确不允许这种情况出现，所以刷新被建模成了一次**有并发收敛要求的会话替换动作**。

### 刷新成功后，旧 Refresh 也会被拉黑

`refreshToken()` 最后会把旧 Refresh Token 的 claims 直接加入黑名单，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:183` 到 `:188`。

这说明刷新不是“再多发一套”，而是：

```text
旧会话材料作废
新会话材料接管
```

这也是会话生命周期而不是静态 JWT 的典型特征。

## 第四步：注销、删号、改密都在做同一件事——收回旧会话

会话链真正最难的地方，不是创建，而是回收。

### 注销：当前会话主动终止

`TokenService.logout()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:200` 到 `:234` 中，会：

- 把当前 Access Token 加入黑名单
- 把当前 Refresh Token 也加入黑名单
- 删除 Redis 中当前 userId 对应的 Access / Refresh / HMAC Secret 映射

这说明注销不是“前端把 token 删了”，而是系统明确宣布：**当前这套会话材料**从现在起不应再被 Gateway 接受。

### 删除用户：所有活跃会话整体失效

`UserService.deleteUser()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:242` 到 `:261` 中，不只是逻辑删除用户，还会调用 `tokenService.revokeAllTokens(targetUserId)`。

这说明“用户不存在了”在当前系统里的后果，不只是以后不能登录，而是**该用户当前活跃的整套会话都必须一起被收回**。

### 改密码：当前用户全部凭证失效

`TokenService.invalidateUserCredentials()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:266` 到 `:287` 中，会把当前活跃的 Access / Refresh 全部拉黑并清除 Redis 映射。

这说明改密在当前实现里的语义不是“以后新密码生效”，而是：

```text
该用户当前活跃的旧凭证
从现在起全部不该再被继续使用
```

这三种动作表面不同，本质上都在收回会话，但收回范围并不完全一样：

- 注销：收回当前这套会话
- 删号：收回该用户当前全部活跃会话，并让身份本体消失
- 改密：收回该用户当前全部活跃会话，但用户身份仍然存在，可重新登录

## 第五步：Gateway 为什么是会话生命周期的执行面，而不是会话生命周期的拥有者

会话创建和吊销都发生在 `user` 域，但真正每个请求会不会被放行，还是要看 Gateway。

`GatewayAuthFilter` 在 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:119` 到 `:123` 里检查黑名单，在 `:126` 到 `:149` 里把通过校验的身份传播给下游。

这说明 Gateway 做的是：

- 实时执行会话生命周期的当前结果
- 但并不拥有这套会话状态本身

换句话说：

- 会话由 `TokenService + Redis` 定义
- Gateway 只是把这份定义落实到每一个请求上

这就是为什么前面会话链所有设计，都必须最终能在 Gateway 这一层被看见：否则旧会话就算在 user 域里被吊销了，也只是纸面吊销。

## 第六步：当前实现里的会话过期时间到底意味着什么

`JwtProperties` 在 `my-xhs-user/src/main/java/com/myxhs/user/config/JwtProperties.java:18` 到 `:22` 中给出了默认时长：

- Access Token：30 分钟
- Refresh Token：7 天

这两个数字的意义并不是单纯“长短不同”，而是会话生命周期被分成了两段：

### Access 代表短期业务访问窗口

- 过期快
- 暴露面小
- 常用于频繁业务请求

### Refresh 代表长一点的续期控制窗口

- 不该直接参与业务请求
- 只在会话续期时出现
- 生命周期更长，但受单设备映射、黑名单、并发锁严格约束

这说明当前会话模型并不是“两个 Token 为了好看”，而是主动把“业务访问窗口”和“会话续期窗口”拆开了。

## 远程运行态事实如何影响会话管理

当前部署事实也说明，这条会话链已经不是单机代码逻辑，而是跨组件协同：

- Redis 在远程中间件机 `21.130.247.89`，负责存活跃映射、黑名单和 HMAC Secret，见 `docs/FINAL-HANDOFF.md:197` 到 `:201`
- Nacos 在 `18848`，Gateway 和 user 的认证相关配置会从这里取运行时优先值，见 `docs/FINAL-HANDOFF.md:204`
- Gateway 在服务机入口层负责执行每一次会话校验

这意味着：

```text
会话的创建在 user 域
会话的状态在 Redis
会话的执行在 Gateway
```

任何一层失配，表现出来的都不是抽象认证问题，而是非常具体的运行态症状：

- 旧会话没被真正踢下线
- 刷新失败
- 注销后仍能访问
- HMAC Secret 过期导致敏感写请求 403

## 真实故障案例：为什么单设备登录最危险的失败，不是“不能多端”，而是“你以为旧会话已经失效，其实还活着”

当前会话链最危险的风险，并不是架构是否足够先进，而是边界是否被误判。

### 现象

如果系统只在登录时生成新 Token，但不：

- 拉黑旧 Access Token
- 覆盖 Redis 中的 Refresh / HMAC Secret
- Gateway 每次再查黑名单

那么用户重新登录后，旧设备就可能仍然带着旧 Access Token 继续访问，直到 30 分钟自然过期。

### 根因

根因不在 JWT 签名，而在“单设备登录”只做了一半：

- 新会话被创建了
- 旧会话却没有被服务端主动宣布失效

### 修复

当前实现围绕这个问题做了三层收口：

1. 登录时把旧 Access Token 拉黑，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:78` 到 `:82`
2. Redis 活跃映射改指向新 Access / Refresh / HMAC Secret，见 `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:84` 到 `:106`
3. Gateway 再按黑名单实时拒绝旧 Token，见 `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:119` 到 `:123`

### 验证

验证这类问题，不能只看登录是否成功，而要看：

- 新登录后旧设备 Token 是否立刻被拒绝
- Refresh Token 是否只接受当前 Redis 映射里的那一份
- HMAC Secret 是否随着会话替换一起被覆盖
- 删除用户 / 改密码后旧会话是否整体失效

### 余波

这个案例说明，**会话管理的真正难点从来不是生成更多 Token，而是让旧会话在你认为它该失效的时候，真的失效。**

## 这一篇先收束成一张总图

```text
登录成功
  → 生成 Access + Refresh + HMAC Secret
  → Redis 写入当前活跃映射
  → 若存在旧会话，旧 Access 拉黑

业务访问
  → Gateway 验 Access Token
  → 查黑名单
  → 注入身份 Header

Access 过期
  → Refresh 走分布式锁刷新
  → 校验当前活跃映射
  → 旧 Refresh 拉黑
  → 新会话材料覆盖旧映射

注销 / 改密 / 删号
  → Access / Refresh 拉黑
  → Redis 映射删除
  → Gateway 后续拒绝放行
```

这里最重要的不是背 Key 名，而是三条判断：

1. 当前会话不是一个 JWT，而是一组由 Token、Redis 映射、黑名单和 HMAC Secret 共同组成的活跃状态。
2. Access 负责短期访问，Refresh 负责续期，Redis 负责把两者变成可回收、可覆盖、可并发收敛的真实会话。
3. 单设备登录真正成立的关键，不是新会话能创建出来，而是旧会话能被系统及时、明确地收走。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 单设备登录设计说明：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:39`
- Access / Refresh / HMAC Secret 一起生成并写 Redis：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:67`、`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:84`
- Refresh 并发锁与当前活跃映射校验：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:150`、`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:166`
- 注销时黑名单 + 清 Redis：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:200`
- 删号时吊销全部活跃会话：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:242`
- 改密后全部凭证失效：`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:266`
- 会话相关 Redis Key：`my-xhs-common/src/main/java/com/myxhs/common/constants/RedisKeyConstants.java:27`
- 默认 Access/Refresh 生命周期：`my-xhs-user/src/main/java/com/myxhs/user/config/JwtProperties.java:18`
- 登录 / 刷新 / 注销入口：`my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:45`

## 边界清单

- 本篇讨论的是会话生命周期，不再重复展开 JWT 验签细节、角色传播和管理/内部权限门禁，这些已经在上一章建立。
- 当前实现是“单设备登录”模型，不支持多端并存；这一点来自 Redis Key 设计和旧 Token 拉黑逻辑，不是推测。
- HMAC Secret 在本文中被视为会话材料的一部分，但 HMAC 签名链本身的 nonce、防重放和 fail-open/fail-closed 边界已在权限模型一章讨论，这里不重复展开。
- 远程运行态事实只用于说明 Redis/Nacos/Gateway 的协同依赖，本文不把这些部署事实写成已完成的全链路实测结论。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么当前系统明明用了 JWT，却仍然需要 Redis 中的活跃映射、黑名单和 HMAC Secret 才能把会话真正管起来。
- 为什么刷新不是“再签一张票”，而是一场受锁保护的会话替换动作。
- 为什么单设备登录真正成立的关键，是旧会话能否被系统在正确时刻收回来。

到这里，`01-user-account-auth` 目录的四篇已经把用户入口的主骨架立住了：

- 注册怎样把新身份安全写进系统
- JWT 怎样把身份变成可流动登录态
- 权限模型怎样把认证、授权、内部调用和请求完整性拆层
- 会话生命周期怎样创建、续期、吊销并约束单设备登录

下一步如果继续沿用户可见入口往前推，最自然的就是回到 `06-search-recommendation-home`，或者进入 `02-content-feed-interaction`，把“用户已经有身份之后，如何看内容、发内容、收到反馈”接上。