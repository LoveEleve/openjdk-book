# 02-bootstrap-spyapi 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“AgentBootstrap / ArthasClassloader / SpyAPI 注入”重构成一篇围绕“Arthas 进门后如何在目标 JVM 内住下来，并让所有增强代码都能找到统一入口”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `AgentBootstrap` 做什么
- `ArthasClassloader` 做什么
- `ArthasBootstrap` 做什么
- `SpyAPI` 做什么

这种四块并列的说明文。

更好的统一问题是：

**Arthas 被动态装进目标 JVM 之后，为什么不会和业务依赖打架？增强后的业务代码又凭什么无论由哪个 ClassLoader 加载，都能稳定找到同一个观测入口？**

这样本篇就不再是“注入后多了哪些类”的枚举，而会被收束成一条寄生系统落地链：

- 谁先接住 `loadAgent`
- 为什么不能直接在 agent 里跑完整逻辑
- 为什么必须隔离 `arthas-core.jar`
- 为什么真正必须全局可见的只有一个极薄的 `SpyAPI`
- 为什么遇到破坏双亲委派的类加载器时，还要补兜底重写

## 2. 读者困惑

上一章已经知道 Arthas 能进 JVM，但更深的困惑是：

- attach 成功之后，目标 JVM 里到底新增了什么结构？
- 为什么 Arthas 不直接在 `agentmain` 里把所有逻辑跑完？
- 为什么一定要再套一层 `ArthasClassloader`？
- 业务方法被增强后，为什么不管类由谁加载，都能找到 `java.arthas.SpyAPI`？
- 如果某个自定义 ClassLoader 根本不走标准双亲委派，Arthas 又怎么兜底？

## 3. 一句话顿悟

**Arthas 真正注入目标 JVM 的不是“一整个可见于所有类加载器的系统”，而是一套分层寄生结构：AgentBootstrap 负责接住 attach，ArthasClassloader 负责把 core 与业务依赖隔离，ArthasBootstrap 负责在隔离空间里装配完整系统，而 SpyAPI 则作为一个被提升到 Bootstrap 搜索路径的极薄全局门面，给所有增强代码提供共同入口。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦外部 attach 进入后在目标 JVM 内部的落地链
- 不把 bind/tunnel/销毁链提前展开成本篇主线；这些留给下一篇
- 不把 Spring Boot starter 的自 attach 路径写成本篇重点；本篇只在必要时点名它共享同一套 `ArthasBootstrap`
- 这里讲的是 Arthas 当前类加载与 Spy 注入设计，不等于所有 Java agent 的统一设计

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经识别出本篇真正关键不是“core 跑起来”，而是 `SpyAPI` 全局可见性
- 已经有 `agentmain -> ArthasClassloader -> ArthasBootstrap -> appendToBootstrapClassLoaderSearch` 的关键锚点
- 已经区分了常规路径和 `enhanceClassLoader` 兜底路径
- 对类加载隔离与最小注入面有一定设计感

### 5.2 必须修复的问题

- 当前骨架仍偏“结构说明文”，还没完全收成一个读者困惑驱动的问题
- 失败方案推演不够厚：为什么不能把 arthas-core 直接混入应用类路径、为什么不能让整个 Arthas 都全局可见，还没有被打得足够透
- `ArthasBootstrap` 构造器主链虽然列得很全，但对本篇主线来说有“事实多、张力散”的风险
- `SpyAPI` 虽然是关键，但还可以更像“冲突解法”，而不是“实现细节之一”
- `enhanceClassLoader` 当前像附加功能，需要被收进“标准委派失效时如何兜底”的主线

## 6. 重写策略

本篇不按源码文件顺序推进，而按一个更强的问题链组织：

1. 先建立冲突：Arthas 已经进 JVM，但它既不能污染业务依赖，又要让增强后的业务代码都能找到统一入口
2. 先排除一个直觉方案：把 Arthas 全部代码直接混进应用类路径 / 让所有类都直接依赖 arthas-core
3. 再给总图：AgentBootstrap 接住 attach、ArthasClassloader 隔离 core、ArthasBootstrap 装配系统、SpyAPI 升到 Bootstrap
4. 然后分层拆：
   - `agentmain` 为什么只是引导器
   - 类加载隔离为什么是必须的
   - 单例装配为什么要“构造即完成”
   - `SpyAPI` 为什么必须极薄且全局可见
   - `enhanceClassLoader` 为什么是破坏委派时的例外补丁
5. 最后收束成“最小注入面 + 隔离核心逻辑 + 全局薄门面”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——Arthas 已经进 JVM，但它凭什么既不打架又能全局可见

目标：建立真正困惑，而不是直接列三层结构。

要回答：

- attach 成功后，问题已经从“怎么进门”变成“怎么住下来”
- Arthas 面临两种相互拉扯的要求：
  - 不能和业务依赖打架
  - 增强后的业务代码又必须都能找到同一个入口
- 本篇真正要追的不是“新增了哪些类”，而是“这两个要求怎么同时成立”

预估字数：900-1100

### 第二节：先排除一个错误直觉——把 Arthas 整个混进应用类路径

目标：做失败方案推演。

要回答：

- 为什么直觉上会想：既然已经进 JVM，就直接在 agent 里把全部逻辑跑起来
- 这种做法会产生哪些冲突：依赖版本碰撞、类加载污染、重复 attach 生命周期混乱
- 真正需要的是“最小公共面 + 隔离核心逻辑”

预估字数：1200-1500

### 第三节：第一层——`AgentBootstrap` 只负责接住 attach，不负责变成完整 Arthas

目标：讲清 `agentmain` 的角色边界。

要回答：

- `loadAgent` 到达目标 JVM 后，谁先接住这次注入
- 为什么 `loadAgent` 只能带一个字符串，于是 Arthas 要自带一套“coreJar 路径 + 配置串”的编码协议
- 为什么 `AgentBootstrap` 只做幂等检查、解析参数、搭桥，不承担后续复杂逻辑

证据锚点：

- `Arthas.java:125-126`
- `AgentBootstrap.java:67`
- `AgentBootstrap.java:90-119`

预估字数：1400-1700

### 第四节：第二层——为什么必须有 `ArthasClassloader`

目标：把类加载隔离写成冲突解决方案，而不是实现清单。

要回答：

- 为什么不能直接让 `arthas-core.jar` 混进应用类路径
- `ArthasClassloader` 的 parent 为什么选 `SystemClassLoader.getParent()`
- 为什么它不是简单 child-first，而是“系统类 parent-first、arthas 依赖 child-first、业务类尽量不碰”的混合策略
- stop 后为什么还要显式清空这个类加载器引用

证据锚点：

- `AgentBootstrap.java:61`
- `AgentBootstrap.java:74-88`
- `agent/ArthasClassloader.java:11-30`

预估字数：1700-2100

### 第五节：第三层——`ArthasBootstrap` 为什么要“构造即装配”

目标：讲清同 JVM 只寄生一套 Arthas 的原因。

要回答：

- 为什么要静态单例
- 为什么字符串配置最终要还原成 `Map`
- 为什么成功必须得到完整系统，失败必须走回滚，而不能留下半成品
- `initSpy()` 为什么排得这么靠前
- 本篇只保留对 bind 的桥接，不提前展开服务端细节

证据锚点：

- `ArthasBootstrap.java:897-923`
- `ArthasBootstrap.java:149-196`
- `ArthasBootstrap.java:198-295`

预估字数：1600-1900

### 第六节：第四层——为什么真正必须全局可见的只有 `SpyAPI`

目标：把本篇的核心顿悟打透。

要回答：

- 为什么增强后的业务代码直接调用 `java.arthas.SpyAPI.atEnter(...)`
- 为什么这些业务类彼此不共享 `ArthasClassloader`
- 为什么 `appendToBootstrapClassLoaderSearch` 可以把 `SpyAPI` 提升成公共祖先可见入口
- 为什么 `spy.jar` 只放一个极薄门面，而不把整个 Arthas 都抬到 Bootstrap
- `NOPSPY`、`INITED`、`spyInstance` 分别解决什么边界问题

证据锚点：

- `ArthasBootstrap.java:209-232`
- `spy/src/main/java/java/arthas/SpyAPI.java:24-27`

预估字数：2200-2600

### 第七节：第五层——如果双亲委派被破坏，为什么还要补 `enhanceClassLoader`

目标：把兜底路径纳入主线。

要回答：

- 为什么“把 SpyAPI 放进 Bootstrap”仍然不保证所有自定义类加载器都能看到它
- `enhanceClassLoader` 解决的是哪类极端场景
- 为什么它默认关闭，只按需开启
- 模板字节码改写 `loadClass` 的代价与边界是什么

证据锚点：

- `ArthasBootstrap.java:234-262`
- `server/instrument/ClassLoader_Instrument.java:13-23`

预估字数：1500-1800

### 第八节：收网——Arthas 不是把整套系统抬成全局，而是把入口缩成最小门面

目标：把全文收成一句话并桥接下一篇。

必须点名：

- `AgentBootstrap` 接住 attach
- `ArthasClassloader` 隔离 core
- `ArthasBootstrap` 负责完整装配
- `SpyAPI` 是被提升到 Bootstrap 的极薄全局入口
- 下一篇才进入“住下来之后怎样开门营业”

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 让 `AgentBootstrap` 直接承担全部 Arthas 逻辑
2. 把 `arthas-core.jar` 直接混进应用类路径
3. 把整个 Arthas 都抬到 Bootstrap 可见范围
4. 假设所有 ClassLoader 都老老实实遵守双亲委派
5. 允许同一个 JVM 里同时寄生多套 Arthas 实例

## 9. 本篇必须明确澄清的误解

1. attach 成功后，真正驻留在 JVM 里的不是脚本，而是一套分层结构
2. `AgentBootstrap` 不是完整服务端，只是引导器
3. `ArthasClassloader` 的目标不是抢业务类，而是隔离 Arthas 自己的依赖
4. 真正需要全局可见的不是整个 Arthas，而只是 `SpyAPI` 这个极薄门面
5. `appendToBootstrapClassLoaderSearch` 不是“把 Arthas 全量塞进 Bootstrap”
6. `enhanceClassLoader` 是兜底例外，不是常规主路径

## 10. 证据清单（正文托底）

- `as.sh:893-899`：外部 JVM 入口（只做桥接回指）
- `Arthas.java:103`
- `Arthas.java:125-126`
- `AgentBootstrap.java:61`
- `AgentBootstrap.java:67`
- `AgentBootstrap.java:74-88`
- `AgentBootstrap.java:90-119`
- `AgentBootstrap.java:176-191`
- `agent/ArthasClassloader.java:11-30`
- `ArthasBootstrap.java:149-196`
- `ArthasBootstrap.java:198-295`
- `ArthasBootstrap.java:897-923`
- `ArthasBootstrap.java:209-232`
- `spy/src/main/java/java/arthas/SpyAPI.java:24-27`
- `ArthasBootstrap.java:234-262`
- `server/instrument/ClassLoader_Instrument.java:13-23`

## 11. 字数预算

- 目标正文总字数：`9000-12000`
- 叙述性正文目标：`6000+`

## 12. 完成后必须通过的检查

1. 删除代码块后，主线是否仍然成立
2. 是否清楚回答了“为什么既不打架，又能全局可见”
3. 是否至少展开了 4 个失败方案
4. 是否把 `SpyAPI` 写成了主冲突的解法，而不是附属实现细节
5. 是否避免把 bind/tunnel/销毁链提前展开成下一篇内容
6. 是否显式区分了引导层、隔离层、装配层、全局入口层、兜底补丁层
7. 是否完成 `file:line` 重核与边界声明
