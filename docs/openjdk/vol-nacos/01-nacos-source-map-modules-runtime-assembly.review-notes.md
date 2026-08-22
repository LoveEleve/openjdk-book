# Nacos：源码总图、模块分层与运行时装配 — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 `NacosBootstrap`、`NacosCoreStartUp`、`NacosTypeExcludeFilter` 的更细 `file:line` 锚点补回正文，用来把“deployment type 如何分叉启动链”“shared kernel 启动时到底初始化了什么”“type exclude filter 如何避免重复扫描并委托模块级过滤”这三条因果链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. Nacos 3.0.3 的 root reactor 并不只有 `naming` 和 `config`，而是同时包含 `core`、`console`、`consistency`、`auth`、`persistence`、`plugin`、`plugin-default-impl`、`prometheus`、`bootstrap`、`server` 等多个真实模块，证据：`nacos/pom.xml:655`。
2. `server` 主要是依赖聚合壳，依赖 `nacos-naming`、`nacos-config`、`nacos-istio`、`nacos-prometheus`、`nacos-default-plugin-all`，证据：`server/pom.xml:32`。
3. `bootstrap` 才是最终 merged 启动壳，依赖 `nacos-console`、`nacos-server`、`nacos-mcp-registry-adaptor`，证据：`bootstrap/pom.xml:32`。
4. `console` 是独立的 Spring Boot 管理上下文，不是静态前端目录，证据：`console/pom.xml:31`、`console/NacosConsole.java:30`。
5. `plugin` 与 `plugin-default-impl` 分别承担 SPI family 聚合与默认实现聚合，证据：`plugin/pom.xml:32`、`plugin-default-impl/pom.xml:32`。
6. `NacosBootstrap` 按 deployment type 分发启动模式，并在 merged 模式下依次拉起 basic server context、web context、console context、optional MCP context，证据：`bootstrap/NacosBootstrap.java:48`、`:93`、`:99`、`:106`、`:113`。
7. `NacosServerBasicApplication` 与 `NacosServerWebApplication` 的主要职责是扫描边界控制与上下文分层，而不是持有 naming/config 主体业务逻辑，证据：`server/NacosServerBasicApplication.java:34`、`server/NacosServerWebApplication.java:34`。
8. `core` 的 pom 明确依赖 `consistency`、`persistence`、`auth`、trace/control plugin，说明它是共享内核而不是杂物间，证据：`core/pom.xml:36`。
9. `core` 中存在 startup phase SPI 与 manager，证据：`core/listener/startup/NacosStartUp.java:28`、`core/listener/startup/NacosStartUpManager.java:33`。
10. `NacosCoreStartUp` 负责环境、工作目录、配置加载、存储模式等基础启动逻辑，证据：`core/listener/startup/NacosCoreStartUp.java:100`；正文现在还补了 `:101`、`:106`、`:108`、`:111`、`:118`、`:119`、`:124`、`:132`、`:158`、`:161`、`:162` 来压实环境注入、配置加载、系统属性初始化与 storage mode 日志。
11. `ServerMemberManager`、`ConsistencyConfiguration`、`BaseRpcServer`、`AuthConfig` 都落在 `core`，说明 cluster / consistency / remote / auth 的共享地板在 `core`，证据：`core/cluster/ServerMemberManager.java:91`、`core/distributed/ConsistencyConfiguration.java:35`、`core/remote/BaseRpcServer.java:34`、`core/auth/AuthConfig.java:31`。
12. naming 和 config 的 standalone app 都直接扫描 `core`，说明它们站在 shared kernel 上，而不是从 `server` 长出来，证据：`naming/NamingApp.java:28`、`config/server/Config.java:28`。
13. function-mode 与 package filtering 通过 `NacosTypeExcludeFilter`、`ConfigEnabledFilter`、`NamingEnabledFilter` 控制，说明 Nacos 运行时是组合式而非固定单体，证据：`sys/filter/NacosTypeExcludeFilter.java:37`、`config/filter/ConfigEnabledFilter.java:33`、`naming/config/NamingEnabledFilter.java:33`；正文现在还补了 `NacosTypeExcludeFilter.java:43`、`:45`、`:46`、`:59`、`:62`、`:63`、`:66`、`:68`、`:70` 来压实 SPI 装载、跳过重复 `@SpringBootApplication` 与按包前缀委托过滤的路径。
14. `NacosBootstrap` 不只是“有三种模式”，正文现在还补了 `bootstrap/NacosBootstrap.java:52`、`:53`、`:56`、`:59`、`:83`、`:84`、`:86`、`:87`、`:88`，把 deployment type 分支和 merged 启动链压得更细。

### 测试与启动证据复核

1. `console/NacosConsoleStartUpTest.java:41` — console startup 行为。
2. `core/cluster/ServerMemberManagerTest.java:62` — cluster substrate。
3. `core/distributed/raft/JRaftProtocolTest.java:56` — consistency substrate。
4. `naming/remote/rpc/handler/InstanceRequestHandlerTest.java:42` — naming runtime path 示例。

## 第二轮：因果审

- 如果没有 root module 总图，读者会把产品功能图错当成源码分层图：当前正文已把这一步放到开篇，成立。✅
- 如果不先切开 `server` 与 `core`，后面 naming/config 的所有篇都会把 assembly 与 shared kernel 混写：当前正文已切开，成立。✅
- 如果不说明 `bootstrap` 的多上下文启动链，读者会自然滑向“单 SpringBootApplication 扫全仓库”的错误模型：当前正文已纠正，成立。✅
- 如果不把 `console` 提前纳入总图，后续 operator shell 和业务 runtime 的关系就会丢失：当前正文已纳入，成立。✅
- 如果不强调 function-mode / type-exclude filter，Nacos 的组合式 runtime 就会被误写成固定单体：当前正文已说明，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 Nacos 不能只看成 naming + config”  
2. 再用三个失败方案打掉最常见的朴素模型  
3. 再建立 root modules -> seam 分层 -> `server` vs `core` -> `bootstrap` 装配链  
4. 最后再给后续 17 篇的阅读地图  

这保证了正文没有退化成根 `pom.xml` 的模块罗列，也没有退化成 naming/config 的预告片。✅

### 失败方案是否有效

有效，而且正好命中这一篇最需要先打掉的三种错觉：
- Nacos 就是 naming + config  
- `server` 是核心模块  
- `console` 只是静态 UI  

这三条刚好对应产品图、模块图、运行态图三个层面的常见错位。✅

## 第四轮：删码测试

删除所有代码块后，正文仍然能复述：

- Nacos 3.0.3 是多平面组合式运行时，而不是 naming + config 二元结构  
- `server` 是装配壳，`core` 是共享内核  
- merged 启动是 basic/web/console/optional context 的分层装配  
- naming/config 都是站在 `core` 上的业务平面  
- 后续 `vol-nacos` 应按共享内核、remote/cluster、naming、config、persistence/consistency、运维面展开  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没提前深入 naming 注册细节  
- 没提前深入 config publish/query/listen/dump 细节  
- 没展开 distro / jraft 算法实现  
- 没抢 Spring Cloud Alibaba 接入线  
- 只讲源码总图、模块分层、运行时装配三件事  

### 与后续篇章的边界

- 第 02 篇可自然接 `shared kernel` 深拆。✅
- 第 03/04/05 可自然接 remote / cluster / auth。✅
- 第 06 以后再切 naming/config 业务平面。✅
- 本篇自身位置：`vol-nacos` 的总图入口与坐标系建立篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把产品功能图误写成源码总图。  
2. 正文没有把 `server` 写成业务核心。  
3. 正文没有把 `console` 写成纯 UI。  
4. 正文没有把 `core` 降格成杂物模块。  
5. 正文没有把最终运行态写成单上下文全量扫描。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键上游锚点，但如果后续做整卷统一抛光，仍可继续把 `ServerMemberManager`、`ConsistencyConfiguration`、`BaseRpcServer` 的局部路径压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：466。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到总图篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `NacosBootstrap` / `NacosCoreStartUp` / `NacosTypeExcludeFilter` 锚点。当前版本不改也可以过关。 
