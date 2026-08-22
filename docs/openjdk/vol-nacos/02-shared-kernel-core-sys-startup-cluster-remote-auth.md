# Nacos：shared kernel——core / sys / startup / cluster / remote / auth

> 基于 Nacos 3.0.3

## 一、困惑开场：`core` 为什么不是杂物间

第 01 篇已经把一个总图立起来了：Nacos 3.0.3 不是简单的 `naming + config + server`，而是一个组合式运行时平台。

但有了总图之后，马上会遇到第二个更难的问题：**`core` 到底为什么不是“很多公共类放一起”的杂物间？**

因为只要这个问题没讲清，后面所有篇章都会出现两个后果：

1. 读者会把真正的共享运行时能力误以为是某个业务模块的私有逻辑
2. 读者会把 `sys`、`core`、`server` 三层彻底揉成一团

更具体地说，Nacos 3.0.3 里这些东西都落在或穿过 `core`：

- startup phase
- cluster membership
- consistency protocol wiring
- shared RPC server
- request handler registry
- connection manager
- auth web filter / remote auth filter
- namespace / server state 等公共控制面能力

如果 `core` 只是 leftovers bucket，这种系统性聚集不会出现。

所以这篇真正要回答的问题是：**`core` 和 `sys` 各自负责什么，shared kernel 到底长什么样，naming/config 又是怎么站在它上面的。**

先给一句结论：`sys` 更像 support floor，`core` 才是 shared server kernel。`sys` 负责环境、文件监听、扫描过滤、基础支撑；`core` 负责真正 server-wide 的共享运行时：启动 phase、cluster、protocol manager、shared RPC、shared auth、公共控制面。naming/config 不是平行地各玩各的，而是站在这套 kernel 上。

## 二、先走四条失败的路

### 失败方案一：`core` 就是个杂物间

这是很多人第一眼看源码时最自然的结论：只要一个模块里既有 startup、又有 cluster、又有 auth、又有 remote，直觉上就会觉得它像个大杂烩。

但真正的问题不是“类很多”，而是这些类有没有共享职责的内在统一性。

在 `core` 里，真正聚集的是“整个 server 进程级别都要共享”的东西：

- 整个进程怎么启动
- 节点怎么识别彼此
- 一致性协议怎么挂进来
- 远程请求怎么进入统一 request handler 体系
- 连接怎么统一管理
- web / remote 鉴权怎么统一切入

这不是 leftovers bucket 的典型特征，反而是 shared kernel 的典型特征。

### 失败方案二：`sys` 和 `core` 差不多，就是名字不同

这也是非常容易出现的误解。

但 `sys` 和 `core` 实际不在同一层。

`sys` 更偏向底层 support floor，它负责的是：

- `EnvUtil` 这类环境与配置支持
- 文件监听
- type exclude / package exclude
- 一些 module state / 通用工具类

而 `core` 则更像真正的 server runtime substrate，它负责的是：

- startup 编排
- cluster member 管理
- protocol manager
- shared RPC server
- shared auth pipeline
- 公共 server 控制面

换句话说：`sys` 让系统“有地基可用”，`core` 让 server“真正开始运转”。

### 失败方案三：naming/config 是两个独立服务器，只是共享一些 util

如果你只看 `naming` 和 `config` 目录，很容易产生这个错觉：它们像两个相对独立的业务系统，只是碰巧复用一些基础类。

但 standalone app 已经直接否定了这个想法：

- `NamingApp` 会扫描 `com.alibaba.nacos.naming` 和 `com.alibaba.nacos.core`  
  `naming/NamingApp.java:29`
- `Config` 会扫描 `com.alibaba.nacos.config.server` 和 `com.alibaba.nacos.core`  
  `config/server/Config.java:29`

这说明它们不是“共享少量 util”，而是**显式站在同一块 shared kernel 上**。

### 失败方案四：Nacos 启动就是普通 Spring Boot 启动

这条误解最隐蔽，因为表面上你确实能看到 `SpringBootApplication`。

但真正顺着启动看下去，会发现 Nacos 在 Spring Boot 生命周期外又叠了一层自己的编排：

- `spring.factories`
- `SpringApplicationRunListener`
- `NacosApplicationListener`
- `NacosStartUp` phase SPI
- `NacosStartUpManager`

所以它不是“run 一个 app 然后看 Spring 自己怎么做”，而是**Nacos 借 Spring Boot 生命周期又组织出一套自己的 phase orchestration**。

## 三、shared kernel 的最小总图：`sys -> core -> naming/config`

先把这篇最核心的总图压出来：

```text
bootstrap / server
    ↓
sys
    - environment
    - file watch
    - type/package exclude
    - module support
    ↓
core
    - startup phases
    - cluster membership
    - protocol manager
    - shared rpc / connection manager
    - shared auth
    - common admin surface
    ↓
naming / config
    - business plane 1
    - business plane 2
```

这张图的重点不是画层，而是说明：

- `sys` 是更低层支撑
- `core` 是 server runtime 内核
- naming/config 不是和 `core` 并列的共享层，而是建立在 `core` 上的业务平面

所以从阅读顺序上也必须先把 `sys` 和 `core` 分开，再谈 naming/config。

## 四、先从启动链看：shared kernel 是怎么被拉起来的

### 4.1 不是直接 `SpringApplication.run`

第 01 篇已经说过，`bootstrap` 会按 deployment type 分发不同启动链。  
`bootstrap/NacosBootstrap.java:48`

但这里真正重要的不是三种 deployment type 本身，而是 shared kernel 是先于业务上下文被拉起来的。

在 `startWithoutConsole()` 和 `startWithConsole()` 里，第一步都不是直接起 web，而是：

- 先 `startCoreContext(args)`  
  `bootstrap/NacosBootstrap.java:74`、`bootstrap/NacosBootstrap.java:83`
- 在 `startCoreContext()` 里先调用 `NacosStartUpManager.start(CORE_START_UP_PHASE)`  
  `bootstrap/NacosBootstrap.java:93`、`bootstrap/NacosBootstrap.java:94`
- 然后才用 `NacosServerBasicApplication` 起 core/basic context  
  `bootstrap/NacosBootstrap.java:95`

之后才是：

- web context  
  `bootstrap/NacosBootstrap.java:99`、`:101`
- console context  
  `bootstrap/NacosBootstrap.java:106`、`:108`
- optional MCP context  
  `bootstrap/NacosBootstrap.java:113`、`:115`

这说明 shared kernel 不是业务跑起来后再补的公共层，而是**最先启动、后续上下文都要挂在上面的 parent substrate**。

### 4.2 `spring.factories` 只是第一层桥

Nacos 并不满足于普通 Spring listener。

`core` 在 `spring.factories` 里注册了：

- `ApplicationListener=StandaloneProfileApplicationListener`
- `SpringApplicationRunListener=SpringApplicationRunListener`

`core/resources/META-INF/spring.factories:2`  
`core/resources/META-INF/spring.factories:5`

这一步说明：shared kernel 的启动编排入口已经先从 Spring Boot 生命周期上接管了一部分时机。

### 4.3 `SpringApplicationRunListener` 不是装饰器，而是第二层桥

`SpringApplicationRunListener` 的真正意义在于：它把 Spring Boot 原生的 run lifecycle，再转发给 Nacos 自己的 `NacosApplicationListener` SPI。

`core/code/SpringApplicationRunListener.java:37`

这里要抓住两件事：

1. 它本身是通过 `spring.factories` 挂进去的
2. 它不是自己干业务，而是再 fan-out 到 Nacos 自己的 listener SPI

这等于告诉你：Nacos 并没有把“启动定制”压在一个 listener 类上，而是刻意又抽了一层自己的扩展面。

### 4.4 `NacosApplicationListener` 又把 Spring 生命周期接到 startup phase 上

最关键的桥在 `StartingApplicationListener`。

它做的事情不是“记几条日志”，而是把 Spring lifecycle 的关键阶段接到 `currentStartUp` 上：

- `starting()` → `currentStartUp.starting()`  
  `core/listener/StartingApplicationListener.java:40`
- `environmentPrepared()` → workdir / env / pre-properties / system props  
  `core/listener/StartingApplicationListener.java:45`
- `contextLoaded()` → `customEnvironment()`  
  `core/listener/StartingApplicationListener.java:58`
- `started()` → 标记 phase 完成并打印启动信息  
  `core/listener/StartingApplicationListener.java:64`
- `failed()` → 逆序清理已启动 phase 并关闭 context  
  `core/listener/StartingApplicationListener.java:71`

也就是说，真正 shared kernel 的启动，不是靠一个静态 main 硬编码写完，而是：

`spring.factories -> run listener -> NacosApplicationListener -> currentStartUp`

这已经是一条很完整的启动编排链。

### 4.5 `NacosStartUp` 和 `NacosStartUpManager` 才是 phase 系统本体

`NacosStartUp` 定义了一整套 phase contract：

- `starting`
- `makeWorkDir`
- `injectEnvironment`
- `loadPreProperties`
- `initSystemProperty`
- `customEnvironment`
- `started`
- `failed`

`core/listener/startup/NacosStartUp.java:28`

而 `NacosStartUpManager` 则负责：

- 通过 `NacosServiceLoader` 加载所有 `NacosStartUp` 实现  
  `core/listener/startup/NacosStartUpManager.java:43`、`:45`
- 按 phase 名注册它们  
  `core/listener/startup/NacosStartUpManager.java:60`
- 记录当前启动 phase  
  `core/listener/startup/NacosStartUpManager.java:74`
- 维护已启动列表，供失败时逆序处理  
  `core/listener/startup/NacosStartUpManager.java:85`

这一步是整篇最关键的顿悟之一：**Nacos 并不是只借 Spring Boot 生命周期，而是在其上面再搭了一个自己的 phase runtime。**

## 五、`sys` 到底负责什么：support floor，而不是 kernel 本体

到这里，再回头看 `sys` 的位置就容易多了。

### 5.1 `EnvUtil` 是最典型的 support floor

`EnvUtil` 这种类很能说明 `sys` 的气质。

它做的是：

- 环境对象持有
- standalone / cluster mode 判断
- function mode 判断
- conf 路径、cluster.conf、processor 数量等环境相关解析

`sys/env/EnvUtil.java:127`  
`sys/env/EnvUtil.java:266`  
`sys/env/EnvUtil.java:276`

这类能力对整个系统都重要，但它们本质上还是“让系统能决定自己处于什么环境”，并不直接承担 server runtime 的主循环。

### 5.2 type exclude/filter 也属于 support floor

`NacosTypeExcludeFilter` 是另一块典型 support floor。

它的职责不是持有业务逻辑，而是：

- 通过 `NacosServiceLoader` 装各模块自己的 `NacosPackageExcludeFilter`  
  `sys/filter/NacosTypeExcludeFilter.java:43`、`:45`、`:46`
- 先跳过重复的 `@SpringBootApplication`，避免重复扫描  
  `sys/filter/NacosTypeExcludeFilter.java:59`、`:62`、`:63`
- 再按包前缀把“要不要排除”的判断委托给具体模块 filter  
  `sys/filter/NacosTypeExcludeFilter.java:66`、`:68`、`:70`

这说明 `sys` 的过滤机制是在给更上层的 runtime 做“边界裁剪”，但它本身不是上层 runtime 主体。

### 5.3 `sys` 和 `core` 的关系

如果压成一句最短人话：

- `sys` 像是操作系统风格的 support floor
- `core` 像是 server runtime 的 shared kernel

前者解决“怎么准备环境和边界”，后者解决“server 怎么真的跑起来并共享能力”。

## 六、`core` 的五根支柱：为什么它是 shared kernel

`core` 的地位不能靠一句“很重要”来证明，必须落到几根真正稳定的支柱上。

### 6.1 cluster membership 支柱

`ServerMemberManager` 就在 `core` 里，不在 naming/config。

`core/cluster/ServerMemberManager.java:91`

它不仅持有成员信息，还负责：

- 初始化本机 member
- 设置节点能力
- 处理 `MembersChangeEvent`
- 启动 lookup strategy

比如它在初始化阶段会构造 self 节点、设置能力和版本等信息。  
`core/cluster/ServerMemberManager.java:156`

而 lookup 策略的分发则交给 `LookupFactory`：

- standalone
- file/cluster.conf
- address server

`core/cluster/lookup/LookupFactory.java:64`  
`core/cluster/lookup/LookupFactory.java:126`

这说明“节点怎么看见彼此”这件事，是 shared kernel 的事，不是 naming/config 各自私有的事。

### 6.2 consistency wiring 支柱

`ProtocolManager` 也在 `core`，它不是算法实现本身，而是 shared wiring layer。

`core/distributed/ProtocolManager.java:46`

它的角色非常关键：

- 对 AP 协议，它会先解析协议对应的 `Config` 类型，再把成员信息注入进去，然后才执行 `protocol.init(config)`  
  `core/distributed/ProtocolManager.java:129`、`:131`、`:133`、`:134`
- 对 CP 协议，也是同一套 shared wiring：先解析 `Config`、再注入成员、再初始化协议  
  `core/distributed/ProtocolManager.java:139`、`:141`、`:143`、`:144`
- 它还明确区分 AP 与 CP 的成员表示：AP 走 address，CP 走 `ip:raftPort` 这类视图  
  `core/distributed/ProtocolManager.java:149`、`:157`
- 在成员变化时，它不会让不同协议彼此阻塞，而是分别把 memberChange 投给 AP/CP 自己的执行通道  
  `core/distributed/ProtocolManager.java:164`、`:173`、`:174`、`:176`、`:177`

而 `ConsistencyConfiguration` 则负责提供 CP protocol bean；如果 SPI 没给出替代实现，就回落到 `JRaftProtocol`。  
`core/distributed/ConsistencyConfiguration.java:38`

所以 shared kernel 在这里承担的不是“具体 Raft 算法”，而是**一致性协议接线与生命周期总控**。

### 6.3 shared RPC / request dispatch 支柱

`BaseRpcServer` 和 `BaseGrpcServer` 都落在 `core`，这意味着远程接入层也是共享地板。

- `BaseRpcServer` 负责通用 server 生命周期与端口/启动控制  
  `core/remote/BaseRpcServer.java:43`
- `BaseGrpcServer` 负责 gRPC 这条共享 substrate，包括 handler registry、请求入口、过滤器与协商器加载  
  `core/remote/grpc/BaseGrpcServer.java:91`

再往里一点，`RequestHandlerRegistry` 会在 context refresh 后把所有 `RequestHandler` bean 收上来，建立：

- request simple name → handler 的映射
- invoke source 限制
- TPS control point

`core/remote/RequestHandlerRegistry.java:75` 是注册入口。  
`core/remote/RequestHandlerRegistry.java:77`、`:78`、`:79` 说明它会先枚举当前上下文中的全部 `RequestHandler` beans。  
`core/remote/RequestHandlerRegistry.java:95`、`:96`、`:97`、`:99` 说明它会读取 `handle()` 方法上的 `@TpsControl` 并注册控制点。  
`core/remote/RequestHandlerRegistry.java:105` 说明它会从泛型参数里解析请求类型。  
`core/remote/RequestHandlerRegistry.java:109`、`:110`、`:113` 说明它会读取类上的 `@InvokeSource`，为请求建立允许来源集合。  
`core/remote/RequestHandlerRegistry.java:120` 说明最终注册的是 `requestSimpleName -> handler` 映射。  

这意味着 config/naming 虽然有自己的 request handler，但**它们接入请求分发体系的方式是共享的**。

### 6.4 connection lifecycle 支柱

连接管理也在 `core`：

`core/remote/ConnectionManager.java:102`

这说明“连接是否存活、何时清理、如何被远程层看到”同样不是 naming/config 各自自己管，而是共享运行时地板负责。

### 6.5 shared auth 支柱

`AuthConfig` 在 `core` 中为 `/*` 注册了 `AuthFilter` 和 `AuthAdminFilter`。  
`core/auth/AuthConfig.java:35`

而 `RemoteRequestAuthFilter` 又对应 remote/gRPC 请求的共享鉴权入口。  
`core/auth/RemoteRequestAuthFilter.java:67`
`core/auth/RemoteRequestAuthFilter.java:72`、`:73`、`:74` 说明它先从 handler 上读取 `@Secured` 元数据。  
`core/auth/RemoteRequestAuthFilter.java:76`、`:80` 说明它会先按 inner API 与 auth 开关做短路判断。  
`core/auth/RemoteRequestAuthFilter.java:86`、`:87`、`:92` 说明它先做 server identity 检查，并允许在 identity 已匹配时直接放行。  
`core/auth/RemoteRequestAuthFilter.java:100`、`:101`、`:102`、`:103`、`:104` 说明进入真正鉴权前，它会补 `X-Real-IP`、解析资源、解析身份并做身份校验。  
`core/auth/RemoteRequestAuthFilter.java:112`、`:113`、`:114` 说明最后还会做 authority 校验，而不是只校验身份。  

这说明 auth 在 Nacos 里不是“每个业务模块自己 if/else 检查一下权限”，而是 shared kernel 先把公共过滤面切进去。

## 七、naming / config 是怎么站在 kernel 上的

这一步是整篇的收束点。

### 7.1 standalone 入口已经把关系写死了

`NamingApp` 与 `Config` 都显式扫描 `com.alibaba.nacos.core`。  
`naming/NamingApp.java:29`  
`config/server/Config.java:29`

这不是“顺手多扫一个包”，而是在声明：**业务平面依赖 shared kernel。**

### 7.2 merged 模式下也是先 kernel 后业务

第 01 篇已经讲过，merged 模式是：

- 先 core/basic context
- 再 web child context
- 再 console child context
- 再 optional context

这条装配链在第 02 篇要读出另一层意义：shared kernel 不是和业务一起被扫出来的，而是先被拉起来，然后后续上下文挂上来。

### 7.3 这对后续篇章意味着什么

所以后面写 naming/config 时，必须始终记住：

- naming 不是“自己实现 cluster / remote / auth”
- config 也不是“自己实现 startup / request dispatch / connection manager”
- 这些都是 shared kernel 已经先搭好的地板

如果忘了这一点，后面每一篇都会不断把共享能力误写成业务模块自己的逻辑。

## 八、和后续篇章的边界

shared kernel 讲到这里就够了，再往里走就会开始侵占后续篇章。

### 8.1 本篇只立 shared remote 的存在，不深讲 remote 协议

这里只需要讲：

- shared RPC base 在 `core`
- request handler registry 在 `core`
- SDK server / cluster server 是这套 substrate 上的具体 sibling

但不需要现在就展开：

- 帧结构
- 双向流
- TLS 协商细节
- request/response payload 细节

这些属于后续 remote 篇。

### 8.2 本篇只立 cluster substrate，不深讲 member lookup 细节

这里只要讲清：

- `ServerMemberManager` 在 `core`
- `LookupFactory` 统一决定 lookup strategy
- cluster membership 是 shared kernel

但不用现在就深讲：

- address server
- file config
- member report
- server-to-server 交互细节

这些属于后续 cluster 篇。

### 8.3 本篇只立 auth 切入点，不深讲 plugin 与权限模型

这里只要讲清：

- web auth filter 在 `core`
- remote auth filter 在 `core`
- auth 是 shared cut-in point

但不用现在就展开 plugin auth 的资源模型与实现细节。

### 8.4 本篇只立 consistency wiring，不深讲 AP / CP 算法

这里只要讲清：

- `ProtocolManager` 在接线
- `ConsistencyConfiguration` 在提供协议 bean
- 这块 shared wiring 在 `core`

但不用现在就把 distro / jraft 全部讲完。

## 九、误解澄清

### 误解一：`core` 是公共杂物间

不是。它持有的恰恰是整个 server 进程都共享的内核职责。

### 误解二：`sys` 和 `core` 差不多

不是。`sys` 更靠下层，`core` 更靠 runtime substrate。

### 误解三：naming/config 只是共享一些 util

不是。它们显式站在 `core` 上，并依赖同一块 shared kernel。

### 误解四：Nacos 启动就是普通 Spring Boot 生命周期

不是。它叠加了自己的一整套 `run listener -> application listener -> startup phase` 编排链。

### 误解五：remote / cluster / auth 以后再讲，所以现在不用提

不是。现在不深讲细节，但必须先把它们作为 shared kernel 支柱立住，否则后文会失去坐标系。

## 十、收网总结：`sys` 负责铺地，`core` 负责让 server 真正跑起来

回到开头的问题：`core` 为什么不是杂物间？

因为在 Nacos 3.0.3 里，`core` 真正承担的是 shared server kernel 的角色：

- 它承接启动编排
- 它持有 cluster membership
- 它接 consistency protocol
- 它提供 shared RPC substrate
- 它接入 shared auth
- 它让 naming/config 站在同一块运行时地板上

而 `sys` 则在更下层负责环境、文件监听、扫描过滤和一些基础支撑。

把整篇压成三句话：

1. `sys` 是 support floor，`core` 是 shared server kernel，它们不在同一层。  
2. shared kernel 的关键支柱在 `core`：startup、cluster、consistency wiring、shared RPC、shared auth。  
3. naming/config 不是各自独立 server，只是共享 util；它们显式站在 `core` 上运行。  
