# Nacos：源码总图、模块分层与运行时装配

> 基于 Nacos 3.0.3

## 一、困惑开场：为什么 Nacos 不能只看成 naming + config

第一次打开 Nacos 源码，很多人脑子里的模型都很朴素：Nacos 不就是“注册中心 + 配置中心”吗？那源码自然也应该差不多就是两个业务模块：`naming` 和 `config`，最多外面再套一层 `server`。

这个模型适合做产品介绍，但不适合做源码阅读入口。

因为一旦你真的看 `3.0.3` 本地源码根目录，就会发现它根本不是一个“两个业务模块 + 一个启动壳”的仓库，而是一个明显带有平台味道的多模块运行时：

- 有 `core`
- 有 `consistency`
- 有 `persistence`
- 有 `auth`
- 有 `console`
- 有 `plugin`
- 有 `plugin-default-impl`
- 有 `prometheus`
- 有 `bootstrap`
- 还有 `client`、`client-basic`、`maintainer-client`、`lock`、`k8s-sync`、`istio`、`ai`、`mcp-registry-adaptor`

这时候真正的问题就不再是“模块为什么有点多”，而是：

- 哪些模块是真正的运行时 seam？
- 哪些模块主要是 assembly / packaging / support？
- `server` 到底是不是核心？
- `core` 到底在提供什么？
- 最终那个可运行的 Nacos，又是怎样被装起来的？

这篇要解决的，不是 naming 和 config 的细节，而是一个更靠前的问题：**Nacos 3.0.3 的真实运行时骨架到底是什么。**

先把结论放前面：Nacos 3.0.3 不是“两个业务模块外面套一个 server”，而是**以 `core` 为共享内核、以 `naming` / `config` 为两大业务平面、再通过 `server` / `console` / `bootstrap` / `plugin` / `prometheus` 等模块做多上下文装配的组合式运行时平台。**

## 二、先走三条失败的路

### 失败方案一：Nacos 就是 naming + config 两个模块

这个理解最容易出现，因为从产品功能看它几乎没错。

但从源码看，这个理解只能描述“它对外卖什么能力”，不能描述“它在运行时怎么活起来”。

root reactor 里明确存在大量会真实参与运行时的模块，而不是只有 `naming` 和 `config`。从顶层 `pom.xml` 的模块列表就能看出来：`config`、`core`、`naming`、`address`、`api`、`client`、`common`、`console`、`consistency`、`auth`、`sys`、`plugin`、`plugin-default-impl`、`prometheus`、`persistence`、`k8s-sync`、`bootstrap`、`server`、`lock`、`maintainer-client`、`client-basic`、`ai`、`mcp-registry-adaptor` 都在 reactor 里。  
`nacos/pom.xml:655`

这说明：

- `naming` / `config` 是两大业务平面
- 但它们并不是全部 runtime
- shared kernel、auth、storage、consistency、console、plugin、metrics 这些横切层也是一等公民

所以“Nacos = naming + config”只适合作产品口号，不适合作源码总图。

### 失败方案二：`server` 就是 Nacos 的核心模块

这也是一种很自然的误解，因为目录名就叫 `server`。

但真正看它的 `pom.xml` 和启动类，你会发现 `server` 更像一个**依赖聚合壳 + 扫描边界控制壳**，而不是 naming/config 的主体业务核心。

`server` 主要依赖的是：`nacos-naming`、`nacos-config`、`nacos-istio`、`nacos-prometheus`、`nacos-default-plugin-all`。  
`server/pom.xml:32`

这说明 `server` 的核心动作是“把若干真正的业务或扩展模块绑成一份可启动的 server 侧依赖集合”，而不是自己持有主要业务逻辑。

再看它的两个启动类：

- `NacosServerBasicApplication`：主要负责 non-web 容器扫描和排除 console / MCP / plugin-auth-impl / web bean 这类不该进这个上下文的东西  
  `server/NacosServerBasicApplication.java:34`
- `NacosServerWebApplication`：主要负责 web 容器那部分扫描边界  
  `server/NacosServerWebApplication.java:34`

也就是说，`server` 更像“装配壳”，不是“业务内核”。

### 失败方案三：`console` 只是个静态 UI，和 runtime 无关

如果按传统中间件直觉，很多人会把 `console` 想成“前端页面 + 几个控制器”。

但在 3.0.3 里，`console` 不是个纯资源目录，而是一个独立的 Spring Boot 上下文，它自己依赖了：`nacos-config`、`nacos-naming`、`nacos-ai`、`nacos-lock`、`nacos-maintainer-client`、`nacos-default-plugin-all`、`nacos-istio`、`nacos-prometheus`、`nacos-k8s-sync`。  
`console/pom.xml:31`

这意味着 console 的定位不是“静态前端”，而是一个**operator shell / 管理与运维操作面**。它必须被纳入运行时总图，而不能被当成边角料。

## 三、先看 root 模块图：Nacos 3.0.3 到底由什么组成

从 `3.0.3` 的根 `pom.xml` 看，Nacos 更像一台分层搭起来的平台，而不是一堆并列业务模块。

如果按阅读价值和运行时角色划分，大致可以先分成四类：

### 3.1 业务平面

- `naming`
- `config`

这两块仍然是 Nacos 的两大 headline business：注册发现和平面配置。

### 3.2 共享内核与基础设施平面

- `core`
- `consistency`
- `persistence`
- `auth`
- `api`
- `common`
- `sys`

这些模块虽然不像 naming/config 那样直观，但它们决定了：

- 启动生命周期
- 集群成员管理
- RPC 接入与连接管理
- 一致性协议接入
- 持久化模式
- 鉴权
- 公共过滤与参数校验

### 3.3 装配与操作平面

- `server`
- `console`
- `bootstrap`
- `prometheus`

这里最重要的不是“谁是业务”，而是谁负责把多个上下文和扩展拼起来。

### 3.4 扩展与生态平面

- `plugin`
- `plugin-default-impl`
- `istio`
- `k8s-sync`
- `client`
- `client-basic`
- `maintainer-client`
- `lock`
- `ai`
- `mcp-registry-adaptor`

这些模块里，有的属于真实扩展 seam，有的是生态附加能力，有的是客户端侧能力，不应该一股脑压进“server 主干”。

所以第一层最重要的结论是：**Nacos 的 root reactor 不是“两个业务模块 + 一圈配件”，而是天然分层的多平面结构。**

## 四、runtime seam 和 assembly/support 要先切开

如果不先把“真正的 runtime seam”和“主要负责 assembly/support 的模块”切开，后面每一篇都会写混。

### 4.1 一等 runtime seam

这些模块应该被视为后续卷里必须单独成篇或成组的对象：

- `core`
- `naming`
- `config`
- `consistency`
- `persistence`
- `auth`
- `console`
- `plugin` / `plugin-default-impl`

为什么说它们是一等 seam？因为它们各自承担的是不可互相吞并的运行时职责：

- `core` 提供共享地板
- `naming` / `config` 提供两大业务平面
- `consistency` 提供 AP/CP 相关抽象
- `persistence` 决定存储模式与数据源接入
- `auth` 与 plugin 决定横切安全与扩展边界
- `console` 是 operator shell，不是 UI 装饰

### 4.2 assembly / packaging shell

- `server`
- `bootstrap`
- `distribution`

这几个模块也重要，但重要性不在“业务算法”，而在“可运行产品是怎么装起来的”。

其中：

- `server` 更像“server 侧功能组合壳”
- `bootstrap` 更像“最终 merged 启动壳”
- `distribution` 更像“发布打包壳”

### 4.3 support / adjacent / optional extension

- `prometheus`
- `istio`
- `k8s-sync`
- `maintainer-client`
- `lock`
- `ai`
- `mcp-registry-adaptor`

这些不代表它们不重要，而是它们不应该在第一篇里和 naming/config/core 抢同一个叙事中心。

## 五、为什么 `server` 不是核心，而 `core` 才是共享内核

这篇最容易被误读的地方，就是把 `server` 和 `core` 的角色弄反。

### 5.1 `server` 主要做的是装配边界

`server` 的 pom 只有一小段依赖列表，但正是这段列表暴露了它的真实身份：它把 naming、config、istio、prometheus、default plugins 收进来，形成一份“非 console 的 server 侧能力包”。  
`server/pom.xml:32`

再看启动类，`NacosServerBasicApplication` 和 `NacosServerWebApplication` 的核心价值不在业务逻辑，而在：

- 扫描哪些包
- 排除哪些包
- 哪些 bean 进 non-web context
- 哪些 bean 进 web context

这就是典型的 assembly shell，而不是 business core。

### 5.2 `core` 提供的才是真正共享底座

和 `server` 相比，`core` 里塞的东西才是后面 naming/config 都反复依赖的 shared substrate。

它的 pom 直接依赖：

- `consistency`
- `persistence`
- `auth`
- trace plugin
- control plugin

`core/pom.xml:36`

这已经说明 `core` 不是“杂物间”，而是 Nacos 服务端共享基础设施的真正落点。

具体再看类：

#### 启动生命周期地板

- `NacosStartUp` 定义 startup phase SPI  
  `core/listener/startup/NacosStartUp.java:28`
- `NacosStartUpManager` 负责 startup phases 的组织和执行  
  `core/listener/startup/NacosStartUpManager.java:33`
- `NacosCoreStartUp` 负责环境、工作目录、配置加载、存储模式等基础启动逻辑  
  `core/listener/startup/NacosCoreStartUp.java:100`
- `NacosCoreStartUp.java:101`、`:106`、`:108`、`:111` 说明它会把环境注入到 `EnvUtil`、加载 `application.properties`、塞进 `PropertySource`，并注册 watcher。
- `NacosCoreStartUp.java:118`、`:119`、`:124`、`:132` 说明它会初始化 standalone/cluster、function mode、本机 IP 这些系统级属性。
- `NacosCoreStartUp.java:158`、`:161`、`:162` 说明它在启动完成时还会按 storage mode 打日志，这进一步说明 storage mode 也是 shared kernel 的启动职责，而不是 config 模块私事。

#### 集群与成员管理地板

- `ServerMemberManager` 在 `core` 中，而不是 naming/config 中  
  `core/cluster/ServerMemberManager.java:91`

这说明节点成员、server-to-server 协作不是某个业务模块的私事，而是共享地板能力。

#### 一致性协议接线地板

- `ConsistencyConfiguration` 在 `core` 中负责 `CPProtocol` / `JRaftProtocol` 相关装配  
  `core/distributed/ConsistencyConfiguration.java:35`

这意味着 AP/CP 并不是 naming 自己在某个角落里偷偷做的，而是 shared runtime 要先把协议 substrate 接好。

#### RPC 与连接地板

- `BaseRpcServer` 也在 `core` 里  
  `core/remote/BaseRpcServer.java:34`

这说明 server 端的 remote / gRPC 基础能力属于 shared kernel，而不是某个业务模块重复造轮子。

#### 鉴权过滤地板

- `AuthConfig` 在 `core` 中注册全局鉴权 filter  
  `core/auth/AuthConfig.java:31`

这又说明 auth 虽然有自己模块，但真正切入 server runtime 的公共边界，仍然要经过 `core`。

所以真正稳定的结论是：**`server` 决定“怎么装起来”，`core` 决定“装起来之后共同站在什么地板上”。**

## 六、真正的运行时装配故事：`bootstrap` 才是最后的总装配壳

如果 `server` 不是终点，那最终 runnable runtime 是谁在真正总装？答案是 `bootstrap`。

### 6.1 `bootstrap` 依赖谁

`bootstrap` 明确依赖：

- `nacos-console`
- `nacos-server`
- `nacos-mcp-registry-adaptor`

`bootstrap/pom.xml:32`

这已经说明最终启动形态不是一个扁平 server，而是至少包含：

- server 侧业务上下文
- console 管理上下文
- optional 的额外上下文（比如 MCP）

### 6.2 `NacosBootstrap` 怎么分 deployment type

`NacosBootstrap` 会根据 `nacos.deployment.type` 决定启动模式，至少支持：

- `merged`
- `server`
- `console`

`bootstrap/NacosBootstrap.java:48` 说明入口先读 deployment type。  
`bootstrap/NacosBootstrap.java:52`、`bootstrap/NacosBootstrap.java:53`、`bootstrap/NacosBootstrap.java:56`、`bootstrap/NacosBootstrap.java:59` 说明它按 `MERGED` / `SERVER` / `CONSOLE` 三种分支切启动路径。  

这一步很关键，因为它说明 Nacos 官方自己就承认：**最终可运行态不是单一形态，而是可按部署类型组合的。**

### 6.3 merged 模式下的多上下文启动链

在 merged 模式下，`NacosBootstrap` 会依次拉起：

1. basic server context  
   `bootstrap/NacosBootstrap.java:83`、`bootstrap/NacosBootstrap.java:84`、`bootstrap/NacosBootstrap.java:93`
2. web server context  
   `bootstrap/NacosBootstrap.java:86`、`bootstrap/NacosBootstrap.java:99`
3. console context  
   `bootstrap/NacosBootstrap.java:87`、`bootstrap/NacosBootstrap.java:106`
4. optional MCP context  
   `bootstrap/NacosBootstrap.java:88`、`bootstrap/NacosBootstrap.java:113`

这几行放在一起看，能更准确地说明 merged 模式不是“顺便多扫一个 console 包”，而是先建 core/basic context，再挂 web 和 console 子上下文，最后按开关决定要不要再挂 MCP 上下文。

所以 merged 模式不是“一个 Spring Boot 应用扫描全仓库”，而是**多个上下文分层拼起来的装配链**。

这也是为什么：

- `server` 需要 basic/web 两个 starter
- `console` 要单独成为一个 SpringBootApplication
- `sys` 里的 type exclude filter 必须参与扫描控制

### 6.4 package scan 过滤为什么这么关键

Nacos 不是每个上下文都扫描全部包，而是通过排除和 filter 机制精细控制。

- `NacosTypeExcludeFilter` 负责统一 type exclude 机制  
  `sys/filter/NacosTypeExcludeFilter.java:37`
- `NacosTypeExcludeFilter.java:43`、`:45`、`:46` 说明它会先通过 `NacosServiceLoader` 装载各模块自己的 package exclude filter。
- `NacosTypeExcludeFilter.java:59`、`:62`、`:63` 说明它会先跳过重复的 `@SpringBootApplication`，避免多个启动类被重复扫描。
- `NacosTypeExcludeFilter.java:66`、`:68`、`:70` 说明真正的是否排除，是按包前缀命中后再委托给具体模块 filter 判断。
- `ConfigEnabledFilter` 控制 config 功能是否启用  
  `config/filter/ConfigEnabledFilter.java:33`
- `NamingEnabledFilter` 控制 naming 功能是否启用  
  `naming/config/NamingEnabledFilter.java:33`

这说明 Nacos 运行时是**功能模式驱动的组合系统**，而不是固定不变的 monolith。

## 七、business-on-substrate：naming 和 config 都是站在 `core` 上的业务平面

到这里再回头看 naming 和 config，会比一开始清楚得多。

### 7.1 naming 不是从 server 里长出来的

`NamingApp` 自己是一个 SpringBootApplication，但它扫描的不是 `server`，而是：

- `com.alibaba.nacos.naming`
- `com.alibaba.nacos.core`

`naming/NamingApp.java:28`

这等于在告诉你：naming 是一个业务平面，但它天然站在 `core` 地板上。

### 7.2 config 也一样

`Config` 这个启动类扫描的是：

- `com.alibaba.nacos.config.server`
- `com.alibaba.nacos.core`

`config/server/Config.java:28`

所以 config 也不是“server 的子模块”，而是另一块站在 core substrate 上的业务平面。

### 7.3 这就是 Nacos 真正稳定的骨架

到这里可以把骨架压成一句人话：

- `core` 先铺地板
- `naming` 和 `config` 站上去
- `server` / `console` / `bootstrap` 再把这些平面和扩展能力装成不同部署形态

这比“注册中心 + 配置中心 + server”稳定得多，因为它能解释源码里所有看起来“多出来”的模块为什么存在。

## 八、这张总图决定了后面 `vol-nacos` 的阅读地图

第一篇如果只讲“模块很多”，其实没用。真正有用的是把后面的阅读路径也一起定下来。

按这张总图，后续 `vol-nacos` 的阅读地图应该分六组：

### 8.1 共享内核层

- `core`
- `sys`
- `common`
- `api`
- `auth`
- `consistency`
- `persistence`
- `plugin`

这些模块回答的是：这块地板怎么搭起来。

### 8.2 remote / cluster / auth 横切层

- remote/gRPC
- 节点协作
- 鉴权与插件 SPI

这些模块回答的是：节点怎么连、请求怎么进、权限怎么切。

### 8.3 naming 业务平面

- service / instance 模型
- ephemeral path
- persistent path
- subscribe / push / failover / redo

### 8.4 config 业务平面

- publish/write path
- query/read path
- long polling / notify
- dump / reconcile

### 8.5 一致性与存储平面

- persistence mode
- AP / CP 双轨

### 8.6 运维与操作面

- console
- client SDK reality
- prometheus / optional extensions

也就是说：**第一篇不是 naming/config 的前置闲聊，而是后面 17 篇的坐标系。**

## 九、误解澄清

### 误解一：Nacos 就是 naming + config

不是。那只是产品功能口号，不是源码运行时总图。

### 误解二：`server` 是核心

不是。`server` 更像 assembly shell；`core` 才是共享内核。

### 误解三：`console` 只是 UI

不是。它是独立 Spring 上下文的 operator shell。

### 误解四：`plugin` / `plugin-default-impl` 是边角模块

不是。它们是扩展 seam，尤其对 auth/control/encryption/datasource 等横切能力很关键。

### 误解五：Nacos 最终是单应用一把启动

不是。merged 模式下是 basic server context、web context、console context、optional context 的分层装配。

## 十、收网总结：Nacos 是组合式运行时平台，不是两个业务模块外面套一个壳

回到开头的问题：Nacos 到底是不是“naming + config + 一个 server 壳”？

答案不是。

从 3.0.3 的本地源码看，Nacos 更接近一个组合式运行时平台：

- `core` 提供共享内核
- `naming` / `config` 提供两大业务平面
- `auth` / `consistency` / `persistence` / `plugin` 提供横切基础设施 seam
- `server` / `console` / `bootstrap` 提供多上下文装配壳
- `prometheus` / `istio` / `MCP` 等作为扩展能力按条件接入

把整篇压成三句话：

1. Nacos 3.0.3 不能只用“naming + config”来理解；真正 runnable 的系统至少还包含 `core`、`auth`、`consistency`、`persistence`、`console`、`plugin`、`bootstrap` 等关键平面。  
2. `server` 负责装配边界，`core` 负责共享地板；业务真正站在 `core` 上的是 `naming` 和 `config`。  
3. Nacos 的最终运行形态是多上下文组合装配，而不是单个 SpringBootApplication 扫全仓库。  
