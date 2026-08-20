# 02 Redis Strategy：为什么这套 Redis 不是“配个缓存”这么简单

从 MySQL 分库分表转到 Redis，读者最容易犯的一个错觉是：既然前面已经把订单主库、ShardingSphere、旁路表这些大结构讲清了，那 Redis 大概只是一些辅助缓存和分布式锁，单独写一篇会不会太小题大做。

恰恰相反。对 `my-xhs` 这种交易链 + 内容链 + 通知链混在一起的系统来说，Redis 根本不是“一个缓存组件”，而是至少同时承担了四类完全不同的角色：一类是用户态 / 业务态缓存，一类是幂等、黑名单、会话、Ticket、路由之类的短状态存储，一类是 Lua 原子脚本执行环境，另一类则是 Sentinel 高可用入口本身。如果把这些角色混成“都存在 Redis 里”，你会在后续所有篇章里不断把缓存语义、业务语义和高可用语义写错。

`my-xhs` 的实现尤其值得单独展开，因为它同时暴露了两层容易被误读的复杂度。第一层是逻辑层：代码里经常出现 `RedisOperator`、`StringRedisTemplate.execute()`、`DefaultRedisScript`、`USER_TOKEN_BLACKLIST`、`USER_HMAC_SECRET`、热搜窗口、通知聚合、未读数、库存脚本、优惠券脚本，这些看起来都在“用 Redis”，但它们对数据丢失、TTL、淘汰策略、原子性和故障降级的要求根本不是一回事。第二层是部署层：交接材料又反复强调 `16379 / 16380 / 16381` 这三组对外端口，以及 `6379 / 6380 / 26379` 这组 compose host 端口，很多正文如果不专门收束这一层，就会把“Sentinel 主从拓扑”“业务库 / 缓存库角色分工”“代码里的默认 RedisConnectionFactory”写成一锅粥。

所以本篇真正要回答的，不是“Redis 在项目里做了什么”，而是：**这套系统为什么非得把 Redis 拆成不同角色；为什么大量关键逻辑不是普通 GET/SET，而是要落到 Lua 和 Sentinel；以及为什么当前代码语义、部署现实和历史运行态材料之间还存在一层必须说清的端口 / 库角色映射。** 只有把这一层讲清，前面交易链、Gateway、通知、搜索和内容里反复出现的 Redis 细节，才不会继续像散点一样飘在空中。

## 先给结论：`my-xhs` 的 Redis 不是一个“缓存库”，而是一组带角色分工的状态平面

先别急着看配置，先把本篇最重要的人话答案钉住：`my-xhs` 的 Redis 不是一个单一“缓存中心”，而是一组被赋予不同风险等级和不同语义职责的状态平面。

第一层是高频业务状态平面。它存放的是订单幂等键、登录失败计数、会话黑名单、HMAC secret、通知 Ticket、未读数、SSE 路由、热搜窗口、推荐曝光集、Feed 收件箱等这些“丢了会有业务影响，但又不值得用 MySQL 同步事务扛住”的中短期状态。第二层是原子脚本平面。很多核心动作不是简单 KV，而是 Redis + Lua 组合形成的微型状态机，比如库存预扣 / 确认 / 回退、优惠券领用 / 回退、通知聚合与安全减计数、网关 nonce 去重。第三层是高可用访问平面。应用侧并不直接把某个 host:port 当成永恒真相，而是优先经 `sentinel.nodes -> master name` 这条路径去找当前主节点。第四层才是大家最熟悉的缓存平面，即产品详情、用户信息、计数、搜索建议、热搜榜、推荐池这些读优化数据。

把这四层压在一起看，Redis 在 `my-xhs` 里的定位就很清楚了：它更像“系统里的第二状态平面”，而不只是“给数据库挡读压力的缓存”。这也是为什么同样是 Redis，不同模块会对它提出完全不同的要求——有的宁可 fail-closed，有的可以 fail-open，有的必须保证 Lua 原子性，有的接受 TTL 过期自然失效，有的必须走 noeviction，有的又更像可丢失型缓存。

这里还要再补一个非常容易被讲平的点：**即使都叫“Redis 权威态”，不同业务链里的权威语义也不一样。**

- 对 `cart` 来说，Redis 更接近“当前待购集合的主真相”，MySQL 是异步持久化和恢复来源；
- 对 `coupon` 来说，Redis 更接近“高并发实时裁决层”，而 MySQL 模板/用户券/`remain_count` 是账本与收敛层；
- 对 `notification` 的未读数来说，Redis 是高频投影视图，数据库未读行数才是最终对账基准；
- 对 `gateway` 黑名单、HMAC Secret、IM/SSE 路由这些状态来说，Redis 又更像会话/路由控制面，一旦丢失会直接改变安全语义或在线路由语义。

也就是说，不能因为多个模块都把数据先放 Redis，就把它们统一理解成“都是 Redis 权威”。当前系统真正复杂的地方，恰恰在于：**同样把状态先放进 Redis，背后依赖的真相判定、失败语义和恢复路径并不相同。**

如果读者只带着“Redis=缓存”的旧直觉来读，几乎一定会误解后面的设计取舍。

## 直觉方案为什么不够：一个 Redis、一个 DB、统一 GET/SET 的思路在这里会马上崩掉

### 失败方案一：把所有 Redis 数据都当普通缓存处理

这是最常见也最危险的直觉。既然 Redis 很快，那用户信息、订单幂等键、登录态、通知未读数、优惠券库存、库存预扣状态、热搜榜、推荐集合、Ticket、SSE 路由都往里放，顶多按 key 前缀区分一下。

问题在于，这些数据的语义差异太大，不能用同一种“缓存心态”对待。用户信息缓存 miss 了，最多回源 DB；`USER_TOKEN_BLACKLIST` 丢了，会让已注销 Token 复活；`USER_HMAC_SECRET` 丢了，会让网关签名链失效；库存预扣与优惠券库存状态如果没了，结果就不是“慢一点”，而是会直接影响交易正确性。把它们都看成统一缓存，最后你就会在 TTL、淘汰策略、故障降级和是否允许覆盖上做出一堆错误决策。

`my-xhs` 实际上已经在代码和交接材料里反复表达了一种更细的态度：Redis 里既有缓存，也有业务真相的一部分影子状态。`RedisKeyConstants` 光在用户域就区分出了 Access Token、Refresh Token、黑名单、HMAC secret、验证码、登录失败计数、IP 失败计数、收货地址默认值等一整组不同语义的 key。它们都住在 Redis，但绝对不是“统一缓存”。`my-xhs-common/src/main/java/com/myxhs/common/constants/RedisKeyConstants.java:24`

### 失败方案二：所有操作都用普通模板 API，原子性靠调用顺序保证

第二个直觉方案是：有了 `RedisTemplate` / `StringRedisTemplate`，大部分需求都可以靠 `get`、`set`、`increment`、`hset` 组合出来。即使有两步操作，也可以按顺序写，只要业务量不大，问题应该不大。

这个思路在 `my-xhs` 这里也立刻不成立。原因很简单：这里的大量关键状态不是“单点写入”，而是多个字段、多个 key、多个约束必须一起变化。库存预扣要同时看总库存、预扣标记、桶状态；优惠券返还要同时回退库存和领取计数；网关 nonce 去重要 `SET NX EX` 一步完成；通知未读安全递减要保证不会减成负数。只要把这些动作拆成多条普通命令，竞态窗口就会非常明显。

这也是为什么项目里到处都能搜到 `DefaultRedisScript`、`StringRedisTemplate.execute()` 与各种 Lua 文件。不是作者偏爱脚本，而是很多分布式状态本来就需要 Redis 在单线程执行模型里替应用把一段“小事务”跑完。`grep` 结果也非常典型：Gateway、inventory、coupon、notification、counter、search、im 等模块全都有脚本型 Redis 逻辑。换句话说，Redis 在这里不是“放值的地方”，而是“执行一部分原子状态转移的地方”。

### 失败方案三：应用都直接盯住一个 Redis 主节点地址，不走 Sentinel

第三个直觉方案则更偏部署层：既然中间件机上的 Redis 主节点就是一个地址，应用直接配 host + port 连它，挂了再人工切或重启也行。

这在单机 demo 里可能问题不大，但在 `my-xhs` 当前的跨机部署场景里，已经被历史事故证明会出事。交接和 review 材料反复强调过：应用侧 `StringRedisTemplate` 应该优先经 Sentinel 去路由 master；而如果 Sentinel 广播出来的是 `127.0.0.1` 之类的错误地址，远程微服务会把“Redis 主节点”误认为自己本机，结果所有服务 Redisson 循环重连失败，日志刷爆。也就是说，Redis 高可用这里不是“将来可以加”的优化，而是现有部署认知的一部分。`docs/HANDOFF.md:184` `docs/test-2/review-fresh/review-production-config.md:314`

所以本篇后面要讲的，不只是 key 设计和 Lua，而是 Redis 作为**高可用状态平面**的那一层现实。

## 先画总图：Redis 在 `my-xhs` 里到底扮演哪几种角色

先把这套状态平面用文字图立住：

```text
应用侧
  -> RedisConfig.defaultRedisConnectionFactory
       sentinel.nodes 有值 -> Sentinel 模式 -> master=mymaster
       否则 -> 单节点直连

Redis 角色层：
  1. 会话 / 安全状态
     - USER_TOKEN_ACCESS / REFRESH
     - USER_TOKEN_BLACKLIST
     - USER_HMAC_SECRET
     - 登录失败计数 / IP 锁定

  2. 业务缓存 / 读优化
     - USER_INFO / PRODUCT_SPU / PRODUCT_SKU
     - NOTE_DETAIL / COMMENT_LIST / SEARCH_SUGGEST
     - RECOMMEND_HOT_GLOBAL / FEED_INBOX / FEED_OUTBOX

  3. 原子脚本状态机
     - Gateway nonce SET NX EX
     - inventory prededuct / confirm / release
     - coupon claim / return
     - notification aggregate / safe decr

  4. 路由 / 触达状态
     - SSE Ticket / route / unread
     - IM 在线路由 / conversations / unread-count

部署侧（当前拓扑）
  Redis master 6379
  Redis slave 6380
  Sentinel 26379
  对外交付端口材料：16379 / 16380 / 16381（历史手册口径）
```

这张图里最关键的不是“Redis 里有很多 key”，而是应用层逻辑其实在同时依赖三种不同东西：连接模式、键空间分工、脚本原子性。只理解其中一层都不够。

- 只理解 key 前缀，不理解 Sentinel，就会把“为什么远程服务连不上 Redis”写成代码 bug。
- 只理解 Sentinel，不理解脚本，就会把库存、优惠券、通知这些状态操作误写成普通缓存读写。
- 只理解脚本，不理解业务库 / 缓存库角色差异，就会把所有 Redis 数据都当成同风险等级对待。

所以可读的正文必须同时覆盖这三层。

## 连接模式这一层：代码里默认是 Sentinel-first，而不是盯死单节点

`RedisConfig` 的核心判断，其实不在序列化，而在连接工厂怎么选。`defaultRedisConnectionFactory()` 先看 `spring.data.redis.sentinel.nodes` 有没有值；有值，就创建 `RedisSentinelConfiguration`，把 `master` 名和一组 sentinel 节点都灌进去；没有值，才退回单节点模式。也就是说，当前代码语义本身就是 **Sentinel-first，单节点 fallback**。`my-xhs-common/src/main/java/com/myxhs/common/config/RedisConfig.java:58`

这条判断非常重要，因为它说明应用层并不是把某个 Redis host 当作永恒真相，而是把“谁是 master”委托给 Sentinel。只要 Sentinel 广播正确、哨兵节点可达，应用就不需要把主从切换逻辑写进业务代码。

这里还得特别注意一个容易忽略的细节：`RedisConfig` 里的默认端口注释仍把默认业务端口写成 `16381`、host 也还是一个旧默认值；但真正各服务当前 `application.yml` 里往往又配置了 `sentinel.master=mymaster` 与 `sentinel.nodes=21.130.247.89:26379`，把运行主路径拉回 Sentinel 模式。也就是说，阅读 Redis 配置不能只看一个类里的默认值，而要把 Spring 配置覆盖层一起看。`my-xhs-common/src/main/java/com/myxhs/common/config/RedisConfig.java:49` `my-xhs-order/src/main/resources/application.yml:38`

这也正是为什么交接材料不断提醒：应用层 `StringRedisTemplate` 是通过 Sentinel 路由到 master 的，不要拿 compose 里的 `6379/6380/26379`、历史对外口径里的 `16379/16380/16381`、以及代码默认值里的 `16381` 三层端口混成一层。它们各自对应的，是不同观察视角。`docs/HANDOFF.md:184`

## 端口与角色为什么最容易写混：`6379/6380/26379`、`16379/16380/16381`、`business/cache` 不是一层东西

这是 Redis 篇最应该先拆清的一层，因为交接材料已经明确提醒过：很多后续文章会在这里出错。

`docker-compose.yml` 当前直接可见的，是中间件机上的 host 网络端口：Redis master `6379`、slave `6380`、Sentinel `26379`。并且 compose 注释写得很明白：代码里的 `RedisConfig` 检测到 `sentinel.nodes` 后，会自动走 Sentinel 模式。`my-xhs/config/docker-compose.yml:208`

而 `HANDOFF.md` 给出的又是另一套更接近“交付给使用者”的口径：应用层通过 Sentinel 路由到 `16379`，同时还有 `16380 = Cache`、`16381 = Business` 这样的角色标注。`docs/HANDOFF.md:186`

如果不把这两层视角拆开，就会出现正文里最常见的混写错误：一会儿说 Redis master 是 `6379`，一会儿又说业务库是 `16381`，最后读者完全不知道是在谈 compose 容器 host 端口、对外交付端口，还是逻辑角色分工。

更严谨的写法应该是：

- **运行容器 / 中间件机 host 端口层**：当前 compose 直接定义的是 `6379 / 6380 / 26379`
- **交付 / 手册口径层**：历史交接里多次出现 `16379 / 16380 / 16381`
- **逻辑角色层**：Business、Cache、Sentinel 是语义分工，不等于只看某个端口数字就能自动推导

这三层不分清，后面几乎所有 Redis 相关篇章都会把“代码走的是哪条连接链”和“人是怎么连接它验证的”写乱。

## `RedisOperator` 为什么重要：它不是简单工具类，而是在统一 Redis 故障语义

如果只看业务代码，你会觉得很多模块都直接在用 `StringRedisTemplate` 或 `RedisTemplate`。但 `my-xhs-common` 里单独抽出的 `RedisOperator` 其实承担了一个很重要的职责：它不是只在省重复代码，而是在统一 Redis 的异常语义。

`RedisOperator` 的注释已经把策略写得很明确：

- 连接不可用：抛 `RedisUnavailableException`
- 其他异常（比如序列化）：记录日志，按默认值降级
- key 不存在：返回 `null/false/0`，视作正常业务语义

`my-xhs-common/src/main/java/com/myxhs/common/cache/RedisOperator.java:20`

这条分层特别重要，因为 Redis 在 `my-xhs` 里承担的角色并不统一。对于一般缓存 miss，返回 null 很正常；对于连接不可用，很多上层逻辑需要明确知道“不是 key 不存在，而是整个 Redis 平面暂时不可达”；而序列化不兼容则往往属于另一类工程故障。把这三者都吞成“查不到”或者都一股脑抛 RuntimeException，业务层就很难做差异化降级。

`RedisOperator.getString()` 里还有一个非常典型的细节：它会兼容 Jackson 序列化写入后带引号的字符串值，再 strip 一次。这不是代码洁癖，而是项目确实存在“有些值走 `RedisTemplate` JSON 序列化，有些值又用 `StringRedisTemplate` 读取”的混搭现实。`my-xhs-common/src/main/java/com/myxhs/common/cache/RedisOperator.java:118`

这也说明 Redis 在这里不是一层被抽象干净的 KV 存储，而是历史上已经累积出“字符串值 / JSON 值 / Lua 返回值 / 模板差异”这些工程缝隙，`RedisOperator` 正在帮上层业务把这些缝隙先挡一层。

## 为什么这里到处都是 Lua：很多核心状态不是缓存，而是 Redis 上的小事务

如果把 Redis 只看成缓存，本篇就会写得很虚。`grep` 结果已经说明了另一件事：Gateway、inventory、coupon、notification、counter、search、im 等模块，全都在用 `DefaultRedisScript` 或 `StringRedisTemplate.execute()`。这意味着对 `my-xhs` 来说，Redis 更像“单线程执行的小事务环境”。

最典型的几个场景：

- Gateway：nonce 去重必须 `SET NX EX` 一步完成，否则 HMAC 防重放有竞态窗口。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:84`
- inventory：预扣、确认、回退三态全靠 Lua 保证总库存、预扣键、桶状态一起变化，否则交易主链根本立不住。
- coupon：领券与返券都不是简单计数，而是库存、领取次数、用户态一起变化的原子动作。
- notification：聚合窗口、未读安全减计数都要防并发下出现负数或重复聚合。

这几类操作最重要的共同点是：它们都不是“缓存命中更快”问题，而是“没有 Redis 脚本原子性就会直接把业务语义做错”。所以正文必须把它们写成 Redis strategy 的核心组成部分，而不是留到各模块单独提一句“用了 Lua 优化”。

## 业务库与缓存库为什么不能一概而论：`noeviction` 背后的风险分层

`docker-compose.yml` 里 Redis master 和 slave 的当前启动参数都用了 `--maxmemory 512mb --maxmemory-policy noeviction`。这条配置看似普通，实际上暴露了这套系统在 Redis 角色分层上的核心倾向：**当前这组 Redis 节点更偏业务状态保护，而不是激进淘汰型缓存。** `my-xhs/config/docker-compose.yml:220`

为什么这么说？因为一旦 Redis 里混有 Token 黑名单、HMAC secret、库存预扣状态、未读数、SSE 路由、聚合窗口这些业务态，简单用 `allkeys-lru` 一类淘汰策略就会很危险。缓存被淘汰最多是回源变慢，黑名单 / 会话 secret / 预扣状态被淘汰则会改变业务正确性。

这也能解释为什么 `HANDOFF.md` 会把 `16380 = Cache`、`16381 = Business` 这样的话单独写出来。即使当前代码与 compose 视角里不一定处处都完全对齐，这份手册仍然在表达一种非常重要的架构意图：**缓存态和业务态应该被区别对待。** `docs/HANDOFF.md:189`

这里要特别注意边界：从当前 compose 直接可见的配置看，master / slave 都是 `noeviction`；而手册里的 `16380/16381` 角色分工更像历史或对外交付口径。因此正文可以稳妥地写成“系统架构意图是在区分 Cache 与 Business 角色，且当前可见运行配置明显偏向保护业务态”；但不能随口写成“当前线上就是两套完全隔离的 Redis 业务库 / 缓存库实例并按手册口径稳定运行”。后面边界清单会专门收这点。

## 真实故障案例：Sentinel 广播错 IP，Redis 高可用入口从“自动切主”变成“全服务刷错”

按照本卷方法论，这篇必须落一个真实故障案例。对 Redis 策略这一篇来说，最合适的不是某条缓存 miss，而是更能逼出部署 / 连接模式复杂度的那次真实事故：**Sentinel 下发了错误地址，导致所有服务把 Redis master 认成了自己本机。**

`docs/test-2/review-fresh/review-production-config.md` 对这次事故的总结非常到位：微服务机与中间件机是分机部署；当时微服务 Redis 配置残留旧端口，同时 Sentinel 又广播 `127.0.0.1:6379` 这一类地址，结果所有服务 Redisson 循环重连失败，错误日志成片刷屏。后来修复的关键不是业务代码，而是把 Sentinel 的 `announce-ip` 和相关广播地址修回中间件机真实 IP。`docs/test-2/review-fresh/review-production-config.md:314`

用方法论要求的五段式把这次故障收起来：

- 现象：跨机部署后，所有服务持续 Redis 重连失败，日志风暴级刷屏
- 根因：Sentinel 向客户端广播了 `127.0.0.1` 这类对远程微服务无意义的主节点地址
- 修复：修正 `announce-ip`、`replica-announce-ip`、必要时 `SENTINEL RESET mymaster`
- 验证：交接材料已明确记录“公网 IP 正确，跨机可达”，并保留修复后配置核对项
- 余波：以后任何 Redis 高可用排障，都必须先区分“Redis 本身可用”与“Sentinel 对远程客户端广播的地址是否可达”

这类案例特别适合 Redis strategy 篇，因为它说明 Redis 这里真正难的地方不只是 key 设计，而是**高可用入口认知**。Redis 主从和 Sentinel 都在跑，不代表应用就一定能连到“正确的主”。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `RedisConfig` 明确采用 Sentinel-first 连接模式：有 `sentinel.nodes` 就走 `RedisSentinelConfiguration`，否则才退回单节点。`my-xhs-common/src/main/java/com/myxhs/common/config/RedisConfig.java:58`
- `RedisOperator` 把连接失败、普通异常、key miss 三种语义分开处理，并保留底层模板给高级 Lua 场景使用。`my-xhs-common/src/main/java/com/myxhs/common/cache/RedisOperator.java:20`
- 项目中广泛存在 `DefaultRedisScript` / `execute()`，说明 Redis 脚本是系统级策略，而不是个别模块技巧；仅这轮核到的就覆盖了 gateway、inventory、coupon、notification、counter、search、im 等多个模块。
- compose 直接可见 Redis 拓扑为 `6379` master、`6380` slave、`26379` Sentinel，且节点都启用了密码、AOF 与 `noeviction`。`my-xhs/config/docker-compose.yml:208`

L1 框架 / 语义证据：

- Sentinel 模式意味着客户端认的是“master name + sentinel set”，而不是某个永恒 host:port；这与单节点直连的故障模型完全不同。`my-xhs-common/src/main/java/com/myxhs/common/config/RedisConfig.java:70`
- Lua / `SET NX EX` 在这里不是性能技巧，而是用 Redis 单线程模型提供原子状态转移，弥补多命令竞态。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:84`
- `noeviction` 暗示当前可见运行配置更偏业务态保护，而不是“缓存满了随便淘汰”。`my-xhs/config/docker-compose.yml:226`

L2 运行态证据：

- `HANDOFF.md` 已明确记录应用层 `StringRedisTemplate` 通过 Sentinel 路由到 master，并给出历史手册口径下的 `16379/16380/16381` 角色说明。`docs/HANDOFF.md:184`
- `docs/test-2/review-fresh/review-production-config.md` 已记录 Sentinel `announce-ip` 踩坑与修复后核对结果，说明这不是理论边界，而是历史上真实发生过的运行态事故。`docs/test-2/review-fresh/review-production-config.md:708`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出应用代码采用 Sentinel-first 连接策略，也能明确写出 compose 里的 host 端口是 `6379/6380/26379`；但不能把这直接写成“当前线上对外 Redis 端口就等于这三个数字”。交接手册里还存在 `16379/16380/16381` 这层对外交付口径，正文必须把两层区分开。

第二，当前可以明确写出手册里存在 Cache / Business 角色分工，也能明确写出当前可见 compose 配置偏 `noeviction` 保护业务态；但不能仅凭这两份材料就写成“当前运行中的 Redis 已严格按 16380=Cache、16381=Business 双实例隔离落地”。

第三，当前可以明确写出项目广泛依赖 Lua / 原子脚本，但不能把它写成“所有关键 Redis 写操作都已脚本化”。更准确的口径是：交易、通知、网关、防重放、优惠券等关键场景已经大量脚本化，但普通缓存读写、部分 KV 状态仍走模板 API。

第四，当前可以明确写出 Redis 在 `my-xhs` 里承担会话、缓存、路由、原子状态机等多重角色，但不能把这句话扩写成“Redis 已经成为唯一真相存储”。很多关键业务事实最终仍要回落 MySQL、ES 或 MQ，Redis 更多承担的是高速状态平面与原子协同层。

## 收网：这篇 Redis Strategy 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的 Redis 不是“给数据库减压的缓存层”这么单薄，而是一组带角色分工的状态平面：一边托管会话黑名单、HMAC secret、登录失败计数、Ticket、未读数和推荐曝光，一边又充当 Lua 原子脚本的执行环境，还要通过 Sentinel 把高可用入口交给客户端自动识别。真正决定它复杂度的，也不是 key 多不多，而是这些 key 的语义风险等级、TTL 期待、淘汰容忍度、Lua 原子性需求和 Sentinel 广播现实全都不一样。

从业务逻辑视角看，它守住的是很多“放进 MySQL 太重、丢了又不只是慢一点”的中短期状态；从工程视角看，它把连接模式、序列化、异常语义、AOF 与 noeviction 全部卷进了同一个状态平面；从分布式视角看，它既依赖 Sentinel 做主从定位，又依赖 Lua 维持关键状态转移原子性；从微服务视角看，它不是一个公共缓存盒子，而是交易链、Gateway、通知链、搜索推荐链共同依赖的第二状态层。

更重要的是，本篇也把一个特别容易被讲错的事实钉住了：**在 `my-xhs` 里，Redis 的真正难点从来不是“怎么 set/get”，而是“哪些状态能丢、哪些状态不能丢，哪些动作必须原子，哪些地址才是远程服务真正能连到的主节点”。**

下一篇如果继续沿 `09-data-model-storage/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/09-data-model-storage/03-es-index.md`，把前面搜索、Canal、日志链和可观测性里反复出现的 Elasticsearch 索引设计统一收束。