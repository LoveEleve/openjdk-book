# 04-bind-destroy 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“端口、隧道、安全、销毁”重构成一篇围绕“Arthas 住下来之后怎样真正开门营业，并在失败或 stop 时可逆撤走”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- 端口怎么选
- tunnel 怎么起
- 认证怎么配
- `disabledCommands` 怎么处理
- `destroy()` 怎么清理

这种“服务配置 + 生命周期说明”的并列文章。

更好的统一问题是：

**Arthas 已经进到目标 JVM 并完成类加载隔离之后，怎样把自己安全地变成一个可连接、可认证、可失败回滚、可最终撤走的寄生服务？**

这样本篇就不再是“配置流水账”，而会被收束成一条完整的生命周期：

- bind 如何把一堆分散能力装配成真正可连接的服务面
- 为什么 attach 成功不等于服务可用
- 为什么安全和命令边界在开门时就要确定
- 为什么 SpyAPI 要最后激活
- 为什么失败要整体回滚
- 为什么 destroy 必须与 bind 形成对称生命周期

## 2. 读者困惑

上一章已经知道 Arthas 住进 JVM 了，但更现实的问题是：

- 为什么 attach 成功后，用户还可能连不上 telnet/http？
- 为什么 bind 不是几个 setter，而是一条严格有顺序的服务装配链？
- 为什么绑定到 `0.0.0.0` 时密码不能缺省？
- 为什么 `disabledCommands` 要在命令注册阶段就生效？
- 为什么 `stop` 不是“关掉终端”，而是一次完整的撤离链？
- 如果 bind 半途失败，Arthas 为什么不能留下半套服务等下次覆盖？

## 3. 一句话顿悟

**Arthas 住进 JVM 之后，并不会自动变成“可用的诊断服务”；`bind()` 必须把端口、终端、认证、命令、隧道和 Spy 激活按顺序装配起来，而 `destroy()` 则必须按相反方向把这些东西完整撤走。也就是说，Arthas 的服务生命周期不是“启动/停止两个动作”，而是一条必须可逆的寄生装配链。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 `ArthasBootstrap.bind()` 与 `destroy()` 的服务生命周期
- 不把 `SpyAPI` 为什么全局可见、`AgentBootstrap` 如何接住 attach 这些上游问题重复展开；它们属于上一章
- 不把 Watch/Trace 的 Transformer 细节提前写成本篇主线；这里只在 stop/reset/destroy 交界处点到为止
- 这里讲的是 Arthas 当前服务端装配与销毁模型，不等于所有 Java agent 服务框架的统一模式

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经意识到 bind 是“服务组装流水线”，不是若干零散配置
- 已经抓到 attach 成功与服务可用之间隔着 `isBind()` 确认
- 已经把随机密码、`disabledCommands`、tunnel、Spy 延迟激活与 destroy 都串到了生命周期里
- 已经明确了 destroy 的顺序和 `StopCommand -> reset() -> destroy()` 边界

### 5.2 必须修复的问题

- 当前骨架仍然偏“流水线说明文”，冲突场景还不够强
- 失败方案推演不够厚：为什么不能“端口先开、命令以后补”“Spy 先激活、服务慢慢起”“bind 失败留半套服务”等，都还不够硬
- tunnel、安全、命令注册、Spy 激活虽然都在文里，但还不够像同一条“开门边界”的不同切面
- destroy 虽然步骤列得清楚，但还可以更像“为什么必须反向回滚”的答案，而不是清理清单
- `stop` 与 `destroy()` 的边界要更主动地讲成“命令层恢复 + 服务层撤离”的分工，而不是只在结尾补一句

## 6. 重写策略

本篇不按 `bind()` 源码顺序做逐段注释，而按一个更强的问题链推进：

1. 先建立事故：Arthas 明明进 JVM 了，用户却还连不上
2. 先排除一个错误直觉：进 JVM 就等于服务已经可用
3. 再给总图：端口/隧道/认证/命令/监听/Spy 激活/失败回滚/销毁撤离
4. 然后分层拆：
   - bind 为什么是组装流水线
   - 端口与 tunnel 如何解决“怎么被连上”
   - 安全与 `disabledCommands` 如何解决“连上之后能做什么”
   - Spy 为什么最后激活
   - bind 失败为什么必须整体回滚
   - destroy 为什么必须反向撤离
5. 最后收束成“寄生可逆”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——Arthas 已经进 JVM，为什么用户还是连不上

目标：建立真正困惑，而不是直接从端口配置开讲。

要回答：

- attach 成功只说明 Arthas 已经住下来
- 服务可用还要额外满足一整条装配链成立
- 本篇不是讲“怎么进门”，而是讲“住下来之后怎么真正开门营业”

预估字数：900-1100

### 第二节：先排除一个错误直觉——进 JVM 不等于服务已经可用

目标：做失败方案推演。

要回答：

- 为什么用户会自然把 attach 成功当成服务已经就绪
- 这个想法解释不了哪些现象：端口冲突、认证缺失、隧道异常、命令不可用
- 真正的问题是“服务面必须被完整装起来”，不是“类已经在 JVM 里了”

预估字数：1000-1300

### 第三节：第一层——`bind()` 为什么不是 setter 集合，而是一条装配流水线

目标：讲清服务装配的顺序性。

要回答：

- `ArthasBootstrap.java:175` 为什么在构造链里调用 `bind(configure)`
- bind 为什么必须按端口/隧道/认证/命令/监听/Spy 激活的顺序推进
- 如果顺序错了，会出现什么半启动状态

证据锚点：

- `ArthasBootstrap.java:175`
- `ArthasBootstrap.java:366`
- `ArthasBootstrap.java:470-478`
- `ArthasBootstrap.java:506-510`

预估字数：1300-1600

### 第四节：第二层——端口与隧道如何回答“怎么被连上”

目标：把随机端口和 tunnel 收成“连接面”的两种资源策略。

要回答：

- 端口 0 为什么不是端口，而是资源意图
- `SocketUtils.findAvailableTcpPort()` 为什么属于绑定阶段，而不是配置阶段
- tunnel 为什么改写的是连接方向，而不是 attach 方式
- tunnel 异常为什么不会直接让 bind 全盘失败

证据锚点：

- `ArthasBootstrap.java:375-383`
- `ArthasBootstrap.java:385-400`
- `ArthasBootstrap.java:401-403`
- `ArthasBootstrap.java:450-466`

预估字数：1700-2100

### 第五节：第三层——安全、命令边界与 ShellServer 为什么必须一起确定

目标：把安全和命令注册写成“开门边界”的一部分。

要回答：

- 为什么监听到 `0.0.0.0` 时必须强制生成随机密码
- 为什么认证不是 ShellServer 外面的一层补丁
- 为什么 `disabledCommands` 要在命令表建立时就生效，而不是执行时临时拦截
- 为什么外部命令注册也必须纳入 bind 装配链

证据锚点：

- `ArthasBootstrap.java:405-430`
- `ArthasBootstrap.java:432-445`
- `ArthasBootstrap.java:520-524`

预估字数：1800-2200

### 第六节：第四层——为什么 `SpyAPI` 必须最后激活

目标：把延迟激活写成失败安全机制，而不是实现顺序。

要回答：

- 为什么在端口、命令、终端和 API 没完整起来之前，Spy 只能保持 NOP
- 为什么 `UserStatUtil` 与 `SpyAPI.init()` 在 bind 尾部出现
- 为什么这样能避免半启动状态下的业务回调打到真实 Spy 实现

证据锚点：

- `ArthasBootstrap.java:481-510`

预估字数：1400-1700

### 第七节：第五层——bind 失败为什么必须整体回滚

目标：讲清失败不是“报错退出”，而是“撤销已创建资源”。

要回答：

- 为什么不能留下半套服务等下次覆盖
- `try/catch -> destroy() -> rethrow` 到底在保护什么边界
- 为什么 `AgentBootstrap.isBind()` 成为了 attach 成功与否的下游保证

证据锚点：

- `ArthasBootstrap.java:513-517`
- `AgentBootstrap.java:184-190`（桥接回指）

预估字数：1300-1600

### 第八节：第六层——`destroy()` 为什么必须按反方向撤离

目标：把 destroy 写成对称生命周期，而不是清理清单。

要回答：

- 为什么先关服务面，再摘增强面，最后清理 Spy 与类加载器引用
- 为什么 `cleanUpSpyReference()` 的意义是让遗留调用落到 NOP，而不是继续指向已卸载实例
- 为什么 `StopCommand` 先 `reset()` 再 `destroy()`，而不是让 destroy 一把梭
- shutdown hook 直接进 destroy 链意味着什么

证据锚点：

- `ArthasBootstrap.java:838-888`
- `ArthasBootstrap.java:942-957`
- `AgentBootstrap.java:951-953`
- `StopCommand.java:29-39`

预估字数：1800-2200

### 第九节：收网——Arthas 不是“能启动一个服务”，而是“能可逆地寄生一套服务”

目标：把全文收成一句话并桥接下一篇。

必须点名：

- bind 装的是服务面
- 隧道、认证、命令、Spy 激活都属于同一条开门边界
- destroy 是 bind 的反向撤离
- stop 还多了一层增强恢复的命令语义
- 下一篇进入 Watch/Trace 的命令与 Transformer 链

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. attach 成功就等于服务可用
2. 端口先开着，命令和认证以后慢慢补
3. SpyAPI 先激活，其他服务再陆续起来
4. bind 失败留下半套服务，等下次 attach 覆盖
5. destroy 只关终端，不撤增强和 Spy 引用
6. `stop` 和 `destroy()` 当成同义词

## 9. 本篇必须明确澄清的误解

1. Arthas 进入 JVM 不等于已经“开门营业”
2. bind 不是参数收集，而是服务装配链
3. tunnel 不等于 attach，仍属于服务连接面
4. 认证和 `disabledCommands` 不是运维补丁，而是服务边界的一部分
5. `SpyAPI.init()` 越早越好是错误直觉
6. destroy 不是“尽力清理”，而是 bind 的反向生命周期
7. `stop` 不是 destroy 的同义词，它还包含增强恢复语义

## 10. 证据清单（正文托底）

- `ArthasBootstrap.java:175`
- `ArthasBootstrap.java:366`
- `ArthasBootstrap.java:375-383`
- `ArthasBootstrap.java:385-400`
- `ArthasBootstrap.java:401-403`
- `ArthasBootstrap.java:405-430`
- `ArthasBootstrap.java:432-445`
- `ArthasBootstrap.java:450-478`
- `ArthasBootstrap.java:481-510`
- `ArthasBootstrap.java:513-517`
- `ArthasBootstrap.java:520-524`
- `ArthasBootstrap.java:838-888`
- `ArthasBootstrap.java:942-957`
- `AgentBootstrap.java:184-190`（bind 成功回指）
- `AgentBootstrap.java:951-953`（resetArthasClassLoader 反射回指）
- `StopCommand.java:29-39`

## 11. 字数预算

- 目标正文总字数：`9000-12000`
- 叙述性正文目标：`6000+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么进 JVM 还不等于服务可用”
3. 是否至少展开了 4 个失败方案
4. 是否把 tunnel、安全、命令、Spy 激活写成了同一条开门边界
5. 是否把 destroy 写成了 bind 的反向生命周期
6. 是否明确区分了 stop 的命令语义与 destroy 的服务语义
7. 是否完成 `file:line` 重核与边界声明
