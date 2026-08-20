# 用户注册流程

> 对应目录：`vol-xhs/01-user-account-auth/`
> 目标问题：用户注册为什么不是一次简单的 `INSERT t_user`？`my-xhs` 为什么要把图形验证码、分布式锁、用户名/手机号唯一性、BCrypt 加密和短事务边界一起放进注册链？

## 一句话困惑

用户注册看起来像整个平台最普通的入口之一：

- 填用户名
- 填密码
- 填手机号
- 点提交

如果只从表结构看，似乎也确实只是往 `t_user` 里插一行：用户名、密码、昵称、手机号、状态、角色。

但一旦把这个动作放回真实系统，会立刻冒出一组不能被“插一行”覆盖的问题：

- 同一个验证码能不能被并发消费两次？
- 同一个用户名被两个并发请求同时提交，会不会插出两条用户？
- 手机号如果重复，系统在哪一层挡住它最合适？
- BCrypt 密码哈希很慢，事务应不应该把这段 CPU 计算一起包住？
- Redis 如果不可用，注册到底该 fail-open 还是 fail-closed？

这篇要讲清楚的不是“注册接口在哪”，而是：**为什么 `my-xhs` 把注册建成了一条“先验证一次性前提，再进入短事务写库”的链，而不是一个普通表单提交。**

## 一句话答案

`my-xhs` 的注册流程本质上是在保护“新身份诞生”的真实性：验证码先确保这是一次当前有效的人类提交，分布式锁和唯一性校验再确保同一用户名/手机号不会被并发注册成两份，BCrypt 负责把密码从一开始就变成不可逆秘密，而事务只包住最后的数据库写入，避免把慢计算和外部依赖拖进长事务。注册看起来是入口动作，实际上已经是一条被精心收窄的安全写入链。

## 先建立最小心智模型

先不要把注册理解成“收一堆字段”。它在系统里真正回答的是：

```text
这个新用户身份
此刻是否可以被正式承认
```

只要站在这个角度看，注册链里的每一步就都变得合理：

- 图形验证码回答：这是不是一个当前有效、一次性的提交。
- 分布式锁回答：同一用户名是否正被别人并发创建。
- 唯一性校验回答：这个身份是不是已经存在。
- BCrypt 回答：这个密码从出生时起就该只剩不可逆哈希。
- 短事务写库回答：真正写入数据库的关键窗口能否尽量短、尽量稳。

也就是说，注册并不是“先把字段收齐再插库”，而是一条**不断缩小‘可以正式创建用户’资格范围**的过滤链。

## 先推演第一个最直觉的失败方案：收到请求后直接插 `t_user`

这是最常见、也最危险的简化路径。

### 为什么这个方案很诱人

因为从持久化角度看，注册似乎确实就是一行用户记录：

- `username`
- `password`
- `phone`
- `status`
- `role`

如果数据库本身还有唯一索引，那么很多人会自然觉得：插库失败再报错就行，何必前面做那么多检查。

### 它会先坏在哪里

它会先坏在“注册并不是单纯数据库唯一性问题”。

只靠最后的 `INSERT` 来承接所有风险，至少会暴露三类问题：

1. **验证码被绕过或被重复消费**：数据库对此毫无感知。
2. **并发注册体验糟糕**：两个并发请求可能都走到最后才在唯一索引处冲突，前面白做了一大堆工作。
3. **密码原文处理过晚**：如果中间链路把密码明文携带得过深，安全边界会变脏。

也就是说，数据库唯一索引当然是最后一道防线，但它绝不是整条注册链唯一应该承担的防线。

## 再推演第二个失败方案：把验证码、加密、Redis、插库全部包进一个长事务

为了避免前一个问题，另一种也很自然的做法是：那就把所有步骤都包进一个大事务里，要么全成功，要么全失败。

### 为什么这个方案也很诱人

因为它听起来很“完整”：

- 验证码检查
- 唯一性检查
- 密码加密
- 插入用户

全都在一个事务里，似乎最安全。

### 它为什么站不住

它会把本来不该进事务的动作硬拖进数据库连接占用窗口。

`UserService` 里已经明确把这个边界写出来了。注释在 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:54` 到 `:55` 说明：事务只包 DB 写入，BCrypt、Redis、锁都放在事务外。

这是因为：

- BCrypt 是 CPU 重活，不该长时间占着数据库事务。
- 验证码校验依赖 Redis，也不该把数据库事务和 Redis 依赖绑在一起。
- 分布式锁是流程守门，不是数据库事务的一部分。

所以第二个失败方案的问题不是“事务太大不好看”，而是：**你把不同性质的动作塞进了同一个数据库事务窗口，放大了连接占用和失败传播。**

## 第一步：验证码先决定“这次注册请求有没有资格继续往下走”

注册链的最前面不是数据库，而是验证码。

`AuthController.register()` 在 `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:36` 到 `:43` 只是入口，真正的关键动作在 `UserService.doRegister()` 的第一步：

- `captchaService.verifyCaptcha(...)`，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:86` 到 `:87`

而 `CaptchaService.verifyCaptcha()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/CaptchaService.java:71` 到 `:92` 中做了一个非常关键的实现选择：

- 用 Redis `GETDEL` 原子读取并删除验证码，见 `my-xhs-user/src/main/java/com/myxhs/user/service/CaptchaService.java:78` 到 `:80`

这说明验证码在当前实现里不是“比对一下字符串”，而是一个**一次性消费凭证**。

### 为什么一定要一次性消费

如果验证码只是 `GET` 然后再 `DEL`，两个并发请求完全可能在同一时刻都读到同一个验证码，然后都通过校验。这会让验证码从“当前一次提交的前置资格”退化成“一个短时间内可复用的通行证”。

而 `GETDEL` 则明确把这层语义钉死：**验证码一旦被一个请求消费成功，其他请求就不再有资格继续注册。**

## 第二步：分布式锁先保护用户名维度的并发创建窗口

验证码通过之后，还不能直接检查数据库并插入。

`UserService.doRegister()` 接下来会按用户名拿一把分布式锁，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:89` 到 `:95`。

这一步的语义不是“数据库一定会错”，而是：

```text
同一用户名的并发注册尝试
应该先在业务层被串行化
```

也就是说，系统不想让两个并发请求都一路跑到数据库唯一索引那里再撞墙，而是更早就在业务流程层把同用户名创建窗口收窄成一个。

### 为什么锁粒度选用户名而不是全局锁

如果上全局锁，所有注册请求都会互相阻塞，吞吐会很差。

如果完全不上锁，只靠 DB 唯一索引，则并发体验和前置计算浪费都会变差。

按用户名加锁正好说明系统的取舍：**只串行化真正会相互竞争的同名注册请求，而不是把所有注册都排成一队。**

## 第三步：唯一性校验先挡住明显冲突，再把数据库唯一索引留作最后兜底

拿到锁之后，系统才开始查：

- 用户名是否已存在，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:97` 到 `:103`
- 手机号是否已存在，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:105` 到 `:113`

这说明当前注册链并不是“只依赖数据库报重复键异常”，而是先在业务层把最常见的冲突挡掉。

但它又没有只信业务层，因为下面还专门捕了 `DuplicateKeyException`，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:129` 到 `:137`。

这反映的是一个很稳的双层设计：

- 业务层提前给出更清晰的错误语义
- 数据库唯一约束仍是最终兜底防线

也就是说，系统承认业务检查和数据库落地之间永远存在竞态窗口，所以最后一道门还是得交给数据库来守。

## 第四步：密码在进入数据库之前，就必须完成 BCrypt 哈希

用户真正被创建出来之前，另一个关键动作是密码处理。

`UserService.doRegister()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:115` 到 `:123` 构建 `User` 实体时，会直接把：

- `request.getPassword()`
- 交给 `passwordEncoder.encode(...)`

也就是说，数据库里从出生时起就不应该出现明文密码。

`User` 实体本身也把这一点写进注释了，见 `my-xhs-user/src/main/java/com/myxhs/user/entity/User.java:21`，明确说明密码字段存的是 BCrypt 加密值。

### 为什么这一步不放在更后面

如果先把明文密码沿着更多层传下去，再某个更晚的位置才哈希，系统里的明文暴露窗口会被不必要地拉长。

而当前实现选择尽早在服务层完成哈希，再把哈希值写入用户对象，这说明它把“密码不可逆化”视为用户身份写入前的必要步骤，而不是后处理动作。

## 第五步：真正放进数据库事务里的，只剩最后那一下写库

走到这里，前面所有“是不是这次、是不是唯一、是不是安全”的问题都已经被缩到很小了。数据库事务真正做的事情，反而非常克制。

`UserService` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:125` 到 `:127` 明确写了：

- 事务只覆盖 DB 写入
- 通过 `transactionTemplate.executeWithoutResult(...)` 调 `userMapper.insert(user)`

这说明注册链真正的数据库提交窗口，被刻意压缩到了最小：**只负责把已经准备好的用户事实写进去，不再顺带执行 Redis、验证码、密码计算这些别的动作。**

这条边界非常重要，因为它让“数据库事务失败”与“前置资格校验失败”在语义上彻底分开了：

- 验证码错，是前置资格不成立
- 唯一键冲突，是身份已存在
- 插库失败，是最后写事实时出问题

## 为什么 Redis 不可用时，注册要 fail-closed

当前实现对 Redis 的依赖很强：

- 验证码在 Redis
- 分布式锁依赖 Redis

所以自然会出现一个问题：如果 Redis 挂了，系统要不要退化成“跳过验证码和锁，先把用户建出来再说”？

`UserService.register()` 在 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:76` 到 `:82` 已经给出答案：Redis 不可用时，会转成明确的 `SERVICE_UNAVAILABLE`，而不是继续注册。

而且这里的 fail-closed 不是只因为验证码放在 Redis。当前注册链里至少有两层前置安全依赖都建立在 Redis/Redisson 之上：

- 验证码一次性消费依赖 Redis，见 `my-xhs-user/src/main/java/com/myxhs/user/service/CaptchaService.java:76` 到 `:80`
- 用户名粒度分布式锁依赖 Redisson，而底层同样建立在 Redis 之上，见 `my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:89` 到 `:95`

这说明当前实现明确选择了：

```text
认证基础设施挂了
→ 宁可暂时不能注册
→ 也不放宽前置资格校验和并发安全边界
```

也就是说，注册在这里是 fail-closed，而不是 fail-open。

## 当前注册链真正隐含的四条设计取舍

走到这里，可以把整条链压缩成四个判断。

### 1. 验证码是一次性前置资格，不是装饰性表单字段

因为它被 `GETDEL` 原子消费，一次成功就不再可重复使用。

### 2. 分布式锁负责收窄并发窗口，数据库唯一索引负责兜底收口

两者不是替代关系，而是前后两层防线。

### 3. 密码安全在身份诞生之前完成，而不是事后补救

BCrypt 不是数据库附加处理，而是注册动作的一部分。

### 4. 事务窗口越短越好，外部依赖和慢计算不要拖进去

这就是为什么当前实现把 BCrypt、Redis、锁都放在事务外，只让最终写库进事务。

## 真实故障案例：为什么“验证码不是一次性消费”会让同一次注册意图在并发下分裂成两次身份创建尝试

当前注册链里最值得抓住的真实风险，并不在插库本身，而在前置资格的消费语义。

### 现象

如果验证码只是普通读取，不是原子 `GETDEL`，那么同一个验证码在短时间内就可能被两个并发请求同时消费：

- 两个请求都拿着同一组 `captchaKey + captchaCode`
- 两个请求都在验证码过期前同时发出
- 两个请求都通过了校验

后面即使数据库唯一索引能兜底，系统也已经让一次注册意图分裂成了两次正式身份创建尝试。

### 根因

根因不是数据库唯一索引不够强，而是验证码这层资格判断没有被原子消费，导致它没有真正承担“只允许一个请求继续往下走”的职责。

### 修复

当前实现用 `GETDEL` 修掉了这个窗口，见 `my-xhs-user/src/main/java/com/myxhs/user/service/CaptchaService.java:78` 到 `:80`。这样一来，验证码就从“一个短时间可复用的值”变成了“一张一次性门票”。

### 验证

验证这条修复，不是看验证码图片能不能生成，而要看：

- Redis 里同一个验证码键在成功校验后是否立刻消失
- 同一组 `captchaKey + captchaCode` 第二次提交是否必然失败
- 并发请求时，是否只有一个请求能进入后续注册链

### 余波

这个案例说明，**注册真正难的地方，不是把用户信息写进 `t_user`，而是把“这次身份创建尝试是否仍然有效”这件事锁死在前置入口。** 一旦前置资格能被并发重放，后面所有数据库防线都只是在补残局。

## 这一篇先收束成一张总图

```text
注册请求
  → 图形验证码校验（一次性消费）
  → 用户名粒度分布式锁
  → 用户名/手机号唯一性校验
  → BCrypt 哈希密码
  → 短事务写入 t_user
  → DuplicateKeyException 最后兜底
```

这里最重要的不是“步骤多”，而是三条判断：

1. 注册链真正保护的是“新身份诞生”的真实性，而不是一条简单表单提交。
2. Redis、锁、唯一性校验、BCrypt 和短事务分别守的是不同风险面，谁都不能被一句“数据库有唯一索引就够了”替代。
3. 真正稳的注册流程，不是把所有动作都塞进一个事务，而是把事务窗口尽量缩到只剩最后那一下写库。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 注册入口：`my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:36`
- 注册请求字段与约束：`my-xhs-user/src/main/java/com/myxhs/user/dto/request/RegisterRequest.java:13`
- 注册链总流程：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:66`
- 验证码生成与一次性消费：`my-xhs-user/src/main/java/com/myxhs/user/service/CaptchaService.java:45`、`my-xhs-user/src/main/java/com/myxhs/user/service/CaptchaService.java:71`
- 用户名粒度分布式锁：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:89`
- 用户名/手机号唯一性校验：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:97`、`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:105`
- BCrypt 哈希写入用户实体：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:115`、`my-xhs-user/src/main/java/com/myxhs/user/entity/User.java:21`
- 事务只包 DB 写入（短事务边界）：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:54`、`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:125`
- Redis 不可用时 fail-closed：`my-xhs-user/src/main/java/com/myxhs/user/service/UserService.java:76`

## 边界清单

- 本篇只讨论用户名+密码+图形验证码注册，不展开第三方登录、短信验证码注册和账号找回。
- 当前实现中的注册链依赖 Redis 存验证码和分布式锁，因此 Redis 故障时选择 fail-closed；这属于当前实现边界，不是所有系统唯一选法。
- `t_user` 的唯一性兜底虽然重要，但本文重点不在数据库表设计，而在“前置资格怎样被逐层收窄”。
- 本篇不展开登录、Token 签发、刷新、黑名单和会话吊销，这些属于后续认证篇章。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么注册不是一次简单 `INSERT`，而是一条被验证码、锁、唯一性校验和哈希逐层收窄的安全写入链。
- 为什么验证码必须一次性消费、分布式锁必须尽量细粒度、事务必须尽量短。
- 为什么 Redis 挂掉时注册宁可失败，也不能放宽身份创建边界。

但它还没进入下一个更关键的问题：用户一旦注册成功，系统又怎样把这个身份变成可以跨网关、跨服务流动的登录态、Token 和会话状态？

所以下一篇应该进入 `02-jwt-auth.md`，去回答**JWT 签发、刷新、注销、黑名单和网关传播到底怎样把“新身份”变成“可用身份”**。
