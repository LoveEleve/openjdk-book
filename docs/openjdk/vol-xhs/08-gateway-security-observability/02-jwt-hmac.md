# 02 JWT + HMAC：为什么网关要先认人，再确认这次提交没被改

上一篇把 Gateway Routing 的入口总图立住之后，接下来最自然的问题就不再是“请求会被路由到哪里”，而是更贴近真实门禁语义的一句：一个请求即使已经打到了 `19000`，Gateway 到底凭什么相信它？

很多系统在这里会混淆两件事。第一件事是身份认证：这是谁发来的请求，Ta 现在还有没有资格继续调用系统。第二件事是请求完整性：这次提交的参数是不是中途被篡改过，或者是不是把一笔原本有效的写请求原样重放了一遍。JWT 擅长解决第一件事，HMAC 擅长解决第二件事。但在不少项目里，这两层门禁要么只做了 JWT，默认“有 Token 就可信”；要么把 HMAC 也做成一个全局共享密钥的装饰性签名，最后既挡不住重放，也挡不住客户端之间互相伪造。

`my-xhs` 这里的设计比这种直觉方案更靠近生产现实：Gateway 先用 JWT 判定“这是谁、有没有被注销、拿的是不是 Access Token”，再用 HMAC 判定“这次提交是不是这个会话自己签出来的、是不是在有效时间窗内、是不是已经被重放过”。也就是说，JWT 和 HMAC 在这里不是并列堆两层，而是前后串成一条双门禁链：**先认人，再认这次提交本身**。

如果这一层不专门拆开讲，读者很容易在几个问题上同时卡住：为什么已经有 JWT 了还要再做 HMAC；为什么 HMAC 校验依赖 `X-User-Id`；为什么 JWT 黑名单查 Redis 要 fail-closed，而 HMAC 的 nonce 去重异常却可以放行；为什么 HMAC 白名单和 JWT 白名单不能偷懒合成一份；以及为什么 `my-xhs-user` 在登录时不仅返回 Access Token 和 Refresh Token，还额外返回一个 `hmacSecret`。本篇就是把这条双门禁链单独剖开：先讲朴素方案为什么不够，再讲 JWT 与 HMAC 各自承担的边界，最后把两者如何在 Gateway 上串起来收成一张图。

## 一句话先钉住：JWT 回答“你是谁”，HMAC 回答“这次请求还是不是你那次签的”

先给本篇最重要的人话答案：`my-xhs` 里的 JWT 和 HMAC 不是一主一次，也不是谁替代谁，而是两个不同层级的问题。

JWT 解决的是身份和登录态。它证明的是：这个请求带来的凭证由系统签发过、当前还没过期、类型是 `access` 而不是 `refresh`，并且对应的会话没有被注销或踢下线。换句话说，JWT 的核心对象是“用户会话”。Gateway 用它识别 `userId`、`role`、`jti` 和 `type`，再决定这次请求有没有资格进入业务系统。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:103`

HMAC 解决的是提交完整性和防重放。它证明的是：这次请求的方法、路径、查询串、时间戳、nonce 和请求体摘要，是由当前用户会话持有的那把 per-session secret 真正签出来的，而不是别人替你拼出来、篡改过，或者把历史请求原样复制后重放。换句话说，HMAC 的核心对象不是“登录态”本身，而是“这一次提交动作”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:188`

把这两个问题混成一个，会带来非常典型的误判。只做 JWT 的人常常默认：既然你有 Access Token，就说明你是合法用户，那你的写请求参数也可信。这在 read-only 查询上问题不大，在下单、支付、发帖、地址修改、删除、互动等写操作上就不够了。因为 JWT 只能证明“你拿着合法会话”，不能证明“这次请求体没被改、没被重放”。反过来，只做 HMAC 而弱化 JWT，也不行，因为会签名不代表你现在仍然是有效登录态，更不代表你拿的是 Access Token 而不是 Refresh Token。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/AuthProperties.java:27`

所以这个系统最后落下来的不是“二选一”，而是职责分离：JWT 是入口第一道身份门，HMAC 是入口第二道提交门。前者不负责参数完整性，后者不负责登录态真伪。两者都在 Gateway 做，才形成完整的北向门禁。

## 直觉方案为什么不够：只靠 JWT 或只靠全局 HMAC 都会留下大洞

要真正理解这条双门禁链，必须先推演几个直觉上会想到、但在这套系统里都不够的方案。

### 失败方案一：只做 JWT，不做 HMAC

这是最常见也最容易“看起来没问题”的方案。用户登录成功后拿到 Access Token，之后所有请求都带 `Authorization: Bearer ...`，Gateway 或下游服务验过 Token 就放行。这样系统已经具备了身份认证、过期控制、角色 claim 和注销黑名单，看起来门禁很完整。

问题在于，这个方案只解决了“谁在请求”，没有解决“请求内容是不是可信的”。一笔订单创建请求、一笔支付回调、一条内容发布请求，哪怕请求者是合法用户，也仍然可能在传输链路里被篡改参数，或者被他自己／脚本／中间人原样重放。对于库存、订单、支付、地址写操作这类强写场景，单靠 JWT 并不能证明这次提交体是客户端刚刚签出的那一版。

在 `my-xhs` 这样的系统里，这个缺口会直接传导成两个下游代价。第一个代价是所有业务服务都必须单独加强幂等和防重放，因为入口层没有先做一道统一筛洗。第二个代价是参数篡改与重放请求要先打进业务服务，再靠订单、库存、支付、优惠券这些域内逻辑兜底，而不是在网关北向边界被提前拦掉。Gateway 于是丧失了“第一道请求完整性门”的价值。

### 失败方案二：JWT + 全局共享 HMAC 密钥

知道只做 JWT 不够之后，第二个直觉方案通常是：那就在客户端和 Gateway 之间再加 HMAC 签名，用一个项目级的固定 `hmacSecret`，客户端按 `method + path + timestamp + nonce` 算签名，Gateway 用同一把密钥验。

这个方案比只做 JWT 前进了一步，但仍然不够，尤其是在多用户、多端和较长登录周期场景下。

最大的问题在于，它把“所有客户端的请求完整性”绑在一把共享密钥上。只要前端或某个客户端能拿到这把固定密钥，理论上它就能替任何会话构造一份看起来签名正确的请求。Gateway 只能确认“有人掌握项目级密钥”，却很难确认“这次签名一定来自当前这个用户会话”。这时 HMAC 退化成了一个较弱的防篡改外壳，而不是严格绑定会话的提交认证。

`my-xhs` 明显意识到了这个问题，所以 `HmacSignatureFilter` 虽然仍然保留了从配置读取 `hmacSecretKey` 的字段，但真正验签时已经明确不再使用它，而是去 Redis 中取 `myxhs:user:hmac:secret:{userId}` 这个 per-session secret。源码注释写得非常直白：继续使用全局 `hmacSecretKey` 的结果就是“前端知道 = 签名失效”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:161`

### 失败方案三：把 JWT 白名单和 HMAC 白名单合并成一份

再进一步，很多系统还会图省事，把“无需 JWT 的路径”和“无需 HMAC 的路径”写成同一份白名单，理由通常是：既然是公开接口，干脆两种校验都跳过。

这在语义上其实已经把两层门禁混成了一层。`my-xhs` 刻意没有这么做，而是在 `AuthProperties` 里保留了 `whiteList` 和 `hmacWhiteList` 两份列表。原因很简单：JWT 白名单回答的是“这条路径是不是不需要识别用户身份”，HMAC 白名单回答的是“这条路径是不是不需要防篡改与防重放”。它们会有交集，但不会完全重合。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/AuthProperties.java:35`

例如，登录、注册、验证码这些入口天然不能要求先带合法 Access Token，所以它们必须在 JWT 白名单里；而 HMAC 白名单的判定口径则更细，它既可能覆盖公开读接口，也可能覆盖一部分已经由其他入口条件或内部约束保护、但不值得再支付签名成本的接口。反过来，那些真正改变业务状态的写接口，即使用户已经通过 JWT 认证，也仍然应该继续要求 HMAC 验签。把两类白名单合成一份，会让“是否公开访问”和“是否需要完整性保护”失去区分。

这三种失败方案合起来，正好逼出 `my-xhs` 的最终设计：JWT 和 HMAC 必须分工，且都要和 Redis 状态绑定，而不是只靠一个静态 Token 或一把共享密钥吃遍全场。

## 先画总图：JWT 与 HMAC 在 Gateway 里到底怎么串起来

先别着急掉进实现细节，先把整条双门禁链用一张文字图立住：

```text
客户端登录
  -> user-service /api/user/auth/login
      -> TokenService 生成 accessToken + refreshToken + hmacSecret
      -> Redis 持久化
           myxhs:user:token:access:{userId}
           myxhs:user:token:refresh:{userId}
           myxhs:user:hmac:secret:{userId}
      -> 响应客户端 TokenResponse

后续业务请求 -> Gateway :19000
  -> RequestLogFilter
       注入 X-Trace-Id
  -> GatewayAuthFilter
       白名单? 是 -> 直接过
       否 -> Bearer Token -> 解析 JWT -> 检查 type=access -> 查 jti 黑名单
       通过后注入 X-User-Id / X-User-Role
  -> TrafficColoringFilter
       补齐 X-Gray-Tag / X-Api-Version / X-AB-Group / X-Pressure-Test
  -> HmacSignatureFilter
       HMAC 白名单? 是 -> 直接过
       否 -> 校验 X-Timestamp / X-Nonce / X-Signature
            -> Redis nonce 去重
            -> 用 X-User-Id 取 per-session secret
            -> 计算 method|path|query|ts|nonce|bodyHash 签名比对
  -> 通过后进入具体业务服务
```

这张图里最关键的不是流程长，而是依赖关系非常严格。

- HMAC 不能跑在 JWT 前面，因为它需要 JWT 先注入 `X-User-Id`，才能去 Redis 拿到当前用户的 per-session secret。
- JWT 自己不看 HMAC，因为身份认证不依赖请求体签名；否则登录态校验就会和每个请求的 body 语义纠缠在一起。
- JWT 白名单和 HMAC 白名单各自独立判定，因为“公开访问”和“无需签名”不是一回事。
- 登录服务之所以要返回 `hmacSecret`，并不是把网关密钥暴露给前端，而是在把“本会话的请求完整性证明材料”同步给当前登录终端。

所以这条链真正的骨架可以浓缩成一句：**Gateway 先根据 JWT 建立“你是谁”的会话上下文，再根据这个上下文验证 HMAC，确认“这次写请求确实是你这个会话刚签出来的那次提交”。**

## JWT 这一层：Gateway 认的是当前会话，不是数据库里的当前用户对象

### 登录阶段：Token 对是如何生成的

JWT 这套链路的起点不在 Gateway，而在 `my-xhs-user` 的登录流程。`AuthController` 把登录请求交给 `UserService.login()`，而 `UserService` 在密码校验通过后并不直接手写 JWT，而是调用 `TokenService.generateTokenPair(userId, role)` 统一生成 Token 对。`my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:52` `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:218`

`TokenService` 这里同时生成两类 JWT：`access` 和 `refresh`。它们都基于同一个 `jwt.secret` 做 HMAC-SHA256 签名，但 `type` claim 不同，过期时间也不同：Access Token 30 分钟，Refresh Token 7 天。工具类 `JwtUtil.generateToken()` 会给每个 Token 写入 `jti`、`subject`、`type`、`iat`、`exp`，并在有角色信息时额外挂上 `role` claim。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:71` `my-xhs-user/src/main/java/com/myxhs/common/util/JwtUtil.java:53`

这里有两个特别关键的设计点。

第一，JWT 在 `my-xhs` 里并不是绝对无状态。虽然 Token 本身是自包含的，Gateway 也不需要查数据库就能解析出 `subject` 和 `type`，但登录服务仍然会把当前活跃的 access token 和 refresh token 以 `userId` 为 key 存进 Redis，用来支持单设备登录踢出、刷新一致性校验和后续注销。也就是说，这套系统使用的是“自包含凭证 + Redis 会话控制”的折中模式，而不是纯粹只靠 Token 自带过期时间放任其自然失效。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:84`

第二，角色 `role` 也被写进了 JWT claim，而不是要求 Gateway 自己去查库。原因非常直接：Gateway 是 WebFlux 入口，不适合也没必要为每次北向请求再做一次数据库用户查询。让 `role` 随 JWT 下发，再由 Gateway 注入 `X-User-Role`，换来的是入口层无状态和下游服务免查用户主表。代价则是：角色变更不会立刻体现在存量 access token 上，需要重新登录或等旧 Token 过期。这是一个明确的工程取舍，不是缺陷。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:57`

### Gateway 校验阶段：为什么只认 Access Token，不认 Refresh Token

到了 Gateway 侧，`GatewayAuthFilter` 先做白名单判定，再从 `Authorization` 头里截出 `Bearer` Token，接着直接使用和 user-service 相同的 secret 解析 JWT。这里有一个容易被忽略但非常关键的动作：Gateway 不仅校验签名和过期，还强制检查 `type=access`。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:112`

这一步在概念上非常重要，因为 `refresh` token 和 `access` token 都是系统合法签发的 JWT。如果网关只看“签名对不对、有没有过期”，那 refresh token 也会成为有效通行证，等于把“续期凭证”错当成“业务访问凭证”。`my-xhs` 通过显式校验 `type`，把 JWT 内部再分成了不同用途的子类型：Refresh 只允许去 `/api/user/auth/refresh` 续期，Access 才能被 Gateway 当作北向业务流量的入场券。`my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:58`

这就是为什么本篇开头说 JWT 解决的是“会话身份”。Gateway 真正认可的不是“某个被签过名的 JWT”，而是“一个当前仍然有效、用途正确的 Access 会话”。

### 黑名单机制：为什么 JWT 还要查 Redis

既然 JWT 自带过期时间，为什么 Gateway 还要再查一遍 Redis 黑名单？这是 JWT 系统一直绕不开的老问题：自包含 Token 的优点是无状态，缺点也是无状态。只要没过期，它理论上都能继续被解析成功。如果没有额外状态，你就很难实现即时注销、单设备踢下线、删号后凭证立刻失效等能力。

`my-xhs` 的答案是：在保持 JWT 自包含的前提下，把“被撤销的凭证”单独存成黑名单。`TokenService.logout()` 会把 access token 和 refresh token 都尝试加入黑名单，同时清掉 Redis 中当前 `userId` 对应的 access、refresh 和 hmac secret 映射；`revokeAllTokens()` 和 `invalidateUserCredentials()` 则覆盖了删号、改密、冻结等更强制的凭证失效场景。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:203` `my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:242`

加入黑名单时，系统不是简单永久保存 jti，而是按 Token 剩余有效期设置 TTL。也就是说，黑名单只持有“本来还没自然过期、但现在被主动撤销”的那部分凭证，过期后自动清理。这正是 JWT 黑名单的标准实现：保留主动失效能力，但不把全部有效会话都倒回中心化存储。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:305`

Gateway 这一侧则只做一件事：拿解析出的 `jti` 去 Redis 查 `myxhs:user:token:blacklist:{jti}` 是否存在。存在就 401，不存在才继续往下走。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:119`

### Fail-Closed：为什么黑名单 Redis 异常时宁可误拒也不放过

JWT 黑名单这一层最能体现安全取舍的是 Redis 异常策略。`GatewayAuthFilter.isBlacklisted()` 在 Redis 查询抛异常时返回 `true`，也就是把请求当作“在黑名单中”处理。换句话说，Redis 挂了，网关宁可多拒一部分本可通过的请求，也不让本该已经注销的 Token 在短暂故障窗口里复活。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:216`

这不是普世正确答案，而是 `my-xhs` 在“安全优先 vs 可用性优先”之间做出的明确选择。对于账号、下单、支付这些业务来说，已注销 Token 被误放过的风险，通常要大于 Redis 短故障期间部分请求被误拒的代价。并且前端在这种场景下通常还能通过重试或重新登录自愈，所以这里选 fail-closed 是合理的。

需要特别强调的是，这种策略也说明 Gateway 认的不是“数据库里这个用户当前还存在”，而是“这份会话凭证当前有没有被撤销”。删号、改密、单设备踢出这些动作，都是通过刷新 Redis 会话状态与黑名单来影响 Gateway 判断，而不是让网关每次去查一遍用户主表。

## HMAC 这一层：Gateway 认的不是“你会签名”，而是“这是你当前会话签的这次提交”

如果说 JWT 回答的是“这是不是一份仍然有效的会话凭证”，那 HMAC 回答的就是“这次请求体是不是这个会话刚刚签出来的原件”。这一层最容易被误读成“只是多了三个 Header”，但真实复杂度远不止如此。

### 登录为什么还要返回 `hmacSecret`

`TokenService.generateTokenPair()` 除了生成 access token 和 refresh token，还会额外生成一份 32 位无横线 UUID 形式的 `hmacSecret`，把它写入 Redis `myxhs:user:hmac:secret:{userId}`，TTL 与 refresh token 同生命周期，然后通过 `TokenResponse` 一起返回给客户端。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:98` `my-xhs-user/src/main/java/com/myxhs/user/dto/response/TokenResponse.java:19`

这一步如果不专门解释，很容易让读者误以为系统在“把网关密钥下发给前端”。其实这里下发的不是全局网关密钥，而是**当前登录会话的专属 HMAC secret**。它的语义更接近“这台当前已登录终端接下来给写请求做签名时要用的会话级签名材料”，而不是“整个项目共享的一把签名总钥匙”。

这也解释了为什么每次登录都会重新生成 HMAC secret，为什么注销、删号、改密、踢线时不仅要删 access/refresh token 映射，还要删掉 `USER_HMAC_SECRET`。因为一旦会话失效，这把 secret 也必须跟着失效；否则客户端理论上还能继续构造看起来签名正确的写请求。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:224`

### HMAC 白名单：不是不带签名头就默认放过

`HmacSignatureFilter` 最容易出安全洞的地方其实在“白名单判定”的写法上。很多系统会写成：如果请求没带 `X-Timestamp`，那就当作不走 HMAC；只对带了时间戳的请求做验签。这样表面上兼容了旧客户端，实际上给了攻击者一个最简单的绕过方式：你不传签名头不就完了。

`my-xhs` 专门避免了这个坑。`AuthProperties` 里明确写着：不携带 `X-Timestamp` 的请求，必须先走 HMAC 白名单判断，而不是直接放行；不在 HMAC 白名单里的请求，必须完整携带 `X-Timestamp`、`X-Nonce`、`X-Signature`。也就是说，“缺签名头”本身不是豁免理由，只有“命中 HMAC 白名单”才是。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/AuthProperties.java:47` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:122`

这正是为什么 HMAC 白名单必须独立存在：登录、注册、验证码、公开读接口、部分已由其他内部门禁保护的管理端点，可以按策略免签；但所有不在名单里的写接口，默认就是必须签。系统不能用“客户端暂时没实现签名”去替换掉这个入口边界。

### 时间窗与 nonce：HMAC 不只是验参数，也要验“是不是旧请求”

很多人提到 HMAC，会只想到“对参数做摘要，防止被改”。但如果只做签名比对，不做时间窗和 nonce 去重，攻击者完全可以把一份历史上曾经合法的签名请求整包重放。签名仍然是对的，但业务语义已经被重复执行了。

`my-xhs` 在这一步做了两道补强。第一道是 `X-Timestamp` 必须能解析成 long，且与当前时间差不能超过五分钟；超过时间窗直接 403。第二道是 `X-Nonce` 会被拼成 `myxhs:gateway:nonce:{nonce}`，通过 Lua 脚本执行 `SET NX EX` 原子写入，只要这个 nonce 在五分钟窗口里见过一次，再来就判定为重复请求。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:128` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:144`

这里最值得记住的不是 Lua 本身，而是它解决的是一个典型的分布式入口问题：Gateway 未来如果有多实例，nonce 去重绝不能靠某台实例本地内存完成，否则只要请求打到另一台入口，重放检查就失效。把 nonce 状态放 Redis，再用原子脚本做写入判定，才让“这份请求五分钟内是否已经出现过”成为整个入口层共享的事实。

### 为什么 HMAC 必须依赖 JWT 注入的 `X-User-Id`

HMAC 在 `my-xhs` 里不是独立门禁，而是 JWT 之后的第二道门。最硬的证据就是 `HmacSignatureFilter` 根本不尝试自己识别用户，而是直接从请求头里取 `X-User-Id`。而这个头的真源正是上一个过滤器 `GatewayAuthFilter`。没有通过 JWT 的请求，原则上就拿不到可信 `X-User-Id`，也就无法进一步去 Redis 取到 `myxhs:user:hmac:secret:{userId}`。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:161`

这层依赖关系非常关键，因为它把“会话身份”和“请求完整性”严密地串了起来。Gateway 不是在问“这份请求会不会签名”，而是在问“**这个已经被 JWT 识别出的会话**，是不是拿它自己那把会话 secret 签了当前这次提交”。

如果没有这层依赖，HMAC 仍然可能退化成“知道一把密钥就能签任何请求”的弱门禁。有了 `X-User-Id -> Redis per-session secret` 这条链，签名就和当前会话绑定了。

### 真正的签名串：不是只看 path，而是看 method + path + query + ts + nonce + bodyHash

`HmacSignatureFilter` 的真正签名串是：

```text
method|path|query|timestamp|nonce|bodyHash
```

也就是说，它不仅把请求方法和路径拉进签名，还把查询串、时间戳、nonce 和请求体摘要都串了进来。请求体摘要本身由 `BodyCacheFilter` 先缓存 body，再用 `sha256Hex(cachedBody)` 生成。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:188`

这套拼法解决的是一个非常现实的问题：如果只签 path 和 timestamp，那修改 query 参数、替换 body 内容、把 POST 变 GET，都可能让业务语义变掉而签名表面上仍可重放。把这些关键维度都并入签名串，才能让“这次提交有没有被改”落到请求语义全量上，而不是只落到一小部分字段。

这里还要补一个边界：multipart 请求在 `BodyCacheFilter` 里会被直接跳过缓存，因此 HMAC 对这类请求统一按 `bodyHash=""` 处理。现有实现这样做是为了避免大文件上传在网关入口读 body 造成内存和 EOF 问题，但它也意味着 multipart 这类场景的完整性保护比普通 JSON body 更弱，后续如果要强化上传链路安全，这会是一个值得单独展开的边界。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:45`

### HMAC 的两种 Redis 失败策略为什么不一样

HMAC 这一层最有意思的地方，是它对 Redis 故障没有采用单一策略，而是按风险等级拆成了两种。

第一种是 nonce 去重失败。如果 Redis 在 `SET NX EX` 这里抛异常，代码只是记录错误，然后继续放行请求。也就是说，系统承认在短故障窗口里“防重放增强”会暂时失效，但不会因此把所有写请求都堵死。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:156`

第二种是 per-session secret 读取失败。如果 Redis 取 `myxhs:user:hmac:secret:{userId}` 抛异常，代码直接 403，提示“签名校验暂不可用，请稍后重试”；如果取到 null，也会明确报“HMAC 密钥已过期，请重新登录”。也就是说，这里走的是 fail-closed。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:169`

这两种策略看起来不对称，但正说明作者在区分两类风险。nonce 去重失败，丢的是“额外防重放层”；per-session secret 读取失败，丢的是“签名真伪的根本依据”。前者短时放行还有下游幂等与业务防线兜着，后者如果继续放行，就等于把 HMAC 主门本身掀开了。所以 HMAC 这里不是简单套一条“Redis 出错统一放行／统一拒绝”的模板，而是在按安全边界分层处理。

## JWT 与 HMAC 如何一起定义会话生命周期

理解完两层门禁各自做什么之后，还要再往前一步：它们并不是两套孤立校验，而是通过同一组 Redis 状态共同定义了会话生命周期。

### 登录时：三件东西同时生成

登录成功后，系统不是只生成 access token 和 refresh token，而是三件东西一起生成：

- Access Token：30 分钟，有 `type=access`
- Refresh Token：7 天，有 `type=refresh`
- per-session HMAC secret：7 天，和 refresh token 同生命周期

同时，旧 access token 会被加入黑名单，新 access/refresh token 会覆盖掉当前 `userId` 的 Redis 映射。这意味着 `my-xhs` 的“单设备登录”并不是靠某个前端状态位保证的，而是靠 Redis 中“当前活跃会话材料”的替换来实现。新设备登录时，旧设备不只是 access token 可能被拉黑，连对应的 HMAC secret 也会被覆盖。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:78`

### 刷新时：不仅续 JWT，也顺带换 HMAC secret

`TokenService.refreshToken()` 的逻辑很值得单独点出来，因为它说明 HMAC 生命周期并不是独立于 JWT 刷新流程存在的。

刷新请求先解析 refresh token，强制检查 `type=refresh`，查黑名单，再通过 Redisson 分布式锁按 `jti` 串行化，避免多个并发刷新请求同时成功。之后系统会校验 Redis 中当前保存的 refresh token 是否仍与传入值一致，确保单设备约束不被绕开；通过后，旧 refresh token 加黑，再调用 `generateTokenPair()` 生成一整套新的 access/refresh/hmacSecret。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:125`

这意味着 refresh 不只是“续一张新的 access token”，而是“刷新整套会话材料”。HMAC secret 与 refresh token 同寿命、同轮换，正是为了让“会话级签名能力”跟着刷新链一起更新，而不是长期不变。

### 注销、删号、改密时：不只是拉黑 Token，也要删 HMAC secret

如果只看 JWT 黑名单，很容易遗漏 HMAC secret 的清理。但 `TokenService.logout()`、`revokeAllTokens()`、`invalidateUserCredentials()` 都在做同一件补动作：删掉 `USER_HMAC_SECRET + userId`。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:224`

这一步非常关键，因为它说明系统理解到：会话失效不只意味着“以后不能再拿旧 access token 继续访问”，还意味着“以后也不能再拿旧会话那把签名材料继续生成看似合法的写请求”。所以 JWT 与 HMAC 在这里共享的是同一条会话生死线：一旦会话无效，这两套材料都必须一起失效。

## 真实故障与失败模式：JWT 合法不等于凭证体系已经收口

按照本卷方法论，这一篇不能只讲机制，还必须落一个能逼出设计边界的真实故障或高风险失败模式。

### 真实修复背景：删号后旧 Token 仍可在短窗口内继续调用

`UserService.deleteUser()` 上的注释直接保留了一段非常关键的修复背景：在修复前，删除用户后旧 token 仍然可能在 30 分钟窗口内继续调用 API，因为 Gateway 的 JWT 校验是无状态的，它只验签、验类型和查黑名单，不会每次再查用户是否还存在。后来修复方式不是让 Gateway 额外查数据库，而是删除用户时调用 `tokenService.revokeAllTokens(targetUserId)`，把当前活跃 access/refresh token 全部拉黑，并清 Redis token 映射和 hmac secret。`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:243`

这个案例非常适合放在 JWT + HMAC 篇，因为它恰好揭示了“JWT 合法”和“凭证体系已经收口”不是一回事。无状态 JWT 的优点是入口轻，缺点就是需要一套主动撤销机制去补生命周期边界。`my-xhs` 不是用数据库反查来弥补这一点，而是用黑名单 + 会话映射清理 + HMAC secret 删除三件套来收口。

### 高风险失败模式：只黑名单 Token，不删 HMAC secret

虽然这个失败模式未必一定在线上爆过，但它是当前实现最值得点明的一类真实危险边界：如果系统只把 access/refresh token 拉黑，却忘记删除 per-session HMAC secret，那么已经失效的会话仍然保有生成合法签名请求的材料。一旦别的链路又意外放过了身份判断，这把 secret 就会成为残余风险。

`my-xhs` 当前之所以相对稳，是因为登录、刷新、注销、删号、改密这些关键路径都已经显式把 `USER_HMAC_SECRET` 纳入生命周期管理。但这也正说明 HMAC 不能被理解成“多送一个 Header 的小增强”，而是必须和 Token 生命周期一起管理的会话材料。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `TokenService` 生成 access token、refresh token 和 per-session `hmacSecret`，并把三者与 Redis 映射绑定。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:67`
- `TokenResponse` 登录响应里显式包含 `hmacSecret`。`my-xhs-user/src/main/java/com/myxhs/user/dto/response/TokenResponse.java:11`
- `GatewayAuthFilter` 只接受 Bearer Token，强制 `type=access`，并对 `jti` 做黑名单检查。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:94`
- `HmacSignatureFilter` 读取 `X-User-Id` 对应的 per-session secret，按 `method|path|query|timestamp|nonce|bodyHash` 验签，并用 Redis Lua 做 nonce 去重。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:144`
- `AuthProperties` 同时维护 `whiteList` 和 `hmacWhiteList` 两份独立白名单。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/AuthProperties.java:35`

L1 框架/语义证据：

- JWT 使用 JJWT 的 HMAC-SHA256 实现，Gateway 与 user-service 共用同一 secret，因此 Gateway 能无数据库解析会话 claim。`my-xhs-user/src/main/java/com/myxhs/common/util/JwtUtil.java:94`
- `BodyCacheFilter` 的存在说明 HMAC 验签依赖 WebFlux 下对 request body 的预缓存与重建，否则 body 只能消费一次。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:19`
- Redisson 分布式锁按 refresh token 的 `jti` 串行化刷新请求，防止并发刷新同时成功。`my-xhs-user/src/main/java/com/myxhs/user/service/TokenService.java:150`

L2 运行态证据：

- `FINAL-HANDOFF.md` 明确记录了“Gateway + HMAC per-session”重测全通过，并给出 147/147 的总体验证结果。`docs/FINAL-HANDOFF.md:235`
- 同一份交接材料也明确写出 `01-user` 的重测覆盖“登录/注册/HMAC 异常”，说明 JWT 与 HMAC 双门禁并非纸面设计，而是经过端到端验证。`docs/FINAL-HANDOFF.md:241`

## 边界清单：现在能写到哪，哪些话还不能说满

第一，当前可以明确写出 JWT 与 HMAC 已共享一条会话生命周期，但不能写成“凭证体系已经完全无洞”。multipart 请求的 `bodyHash` 目前仍按空串处理，这是一条已知边界；它不是 HMAC 失效，但确实意味着上传场景的完整性保护弱于普通 JSON 请求。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:45`

第二，当前可以确认 per-session secret 已经替代全局配置密钥成为主路径验签材料，但不能把配置里的 `hmacSecret` 直接写成“已经删除”或“绝对无效”。更准确的口径应该是：`gateway.auth.hmac-secret` 这个配置项及其字段仍然存在，并且本地 `application.yml` 也保留了 Nacos fallback 值；只是当前 `HmacSignatureFilter.filter()` 的实际验签主路径，已经明确改为按 `X-User-Id` 去 Redis 读取 per-session secret，而不是继续使用这个静态配置值。也就是说，**静态 HMAC 配置仍被保留在配置面上，但运行中的主验签路径已迁移到 Redis 会话密钥。** `my-xhs-gateway/src/main/resources/application.yml:278` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:95`

第三，当前可以确认 Gateway 黑名单查询采取 fail-closed，但不能把这句话扩写成“Redis 故障时所有请求都会被统一拒绝”。更准确地说，是**非白名单且需要 JWT 的请求**在黑名单检查异常时会被拒；JWT 白名单路径本来就不走这一层。

第四，当前可以确认 HMAC 的 nonce 去重是多实例友好的共享状态，但不能把它写成“系统已经彻底解决所有重复提交问题”。Gateway 入口挡掉的是短时间重放与提交篡改，下游订单、库存、支付、优惠券等服务仍然必须保有各自的幂等与一致性防线。

## 收网：这条双门禁链真正守住了什么

到这里，可以把开头的问题收回来了。Gateway 之所以既做 JWT 又做 HMAC，不是因为作者想把安全机制堆得更复杂，而是因为这两层门禁本来就在回答不同的问题：JWT 解决“这是不是一个当前有效的 Access 会话”，HMAC 解决“这次请求是不是这个会话在有效时间窗内签出来、且没被重放和篡改的那次提交”。

从业务逻辑视角看，它守住的是用户会话与关键写请求之间的入口边界；从工程视角看，它把登录、刷新、注销、删号、改密这些生命周期动作都落到了 Redis 黑名单、活跃 Token 映射和 per-session HMAC secret 这三类状态上；从分布式视角看，它把 nonce 去重和会话级签名材料做成了跨实例共享状态，而不是绑在某一台网关内存里；从微服务视角看，它把“身份认证”和“请求完整性”统一收束在北向入口，而没有把这两类复杂度散落到每个业务服务内部。

更重要的是，本篇也把一个特别容易被讲虚的点钉实了：**JWT 合法，不等于这次提交可信；HMAC 正确，也不等于这个会话仍然有效。** `my-xhs` 的 Gateway 只有把这两个判断串起来，才形成真正可用的北向门禁。

下一篇最自然的桥接，是把本篇已经提到但尚未展开的治理问题单独拆出来：既然入口层已经完成身份与提交双门禁，那么后面就该回答“当合法请求量本身过大时，Gateway 如何按路由做 Sentinel 限流、为什么规则要跟 route metadata 绑定、以及单机限流的边界在哪里”。也就是说，接下来应进入 `08-gateway-security-observability/03-sentinel-limit.md`。