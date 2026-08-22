# Nacos：shared kernel——core / sys / startup / cluster / remote / auth — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch01-orientation`
- 篇：`02 Nacos：shared kernel——core / sys / startup / cluster / remote / auth`
- 对应主题：`N-02 shared kernel`
- 文章类型：基础内核篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3`

## 文章定位

- 核心困惑：第 01 篇已经说明 Nacos 不是简单的 `naming + config + server`，而是一个组合式运行时平台。但这还留了一个更硬的问题：`core` 到底为什么不是“杂物间”？`sys` 和 `core` 又到底怎么分？启动 phase、cluster 成员管理、consistency 协议接线、RPC server、连接管理、auth filter 这些共享能力，究竟为什么都落在 `core`，而不是分别散在 naming/config/server 里？
- 一句话顿悟：Nacos 3.0.3 的 `shared kernel` 不是一个抽象概念，而是一套很具体的 server-side substrate：**`sys` 负责更底层的环境、文件监听、扫描过滤和公共支撑；`core` 负责真正的共享运行时——启动 phase、cluster membership、protocol wiring、shared RPC、shared auth、shared admin surface；naming/config 则站在这块内核上，而不是重复造自己的地板。**
- 文章边界：本篇重点讲 shared kernel 的职责边界和主骨架，不深入 naming/config 的业务语义，不把 remote、cluster、auth、consistency 的每个细节全部展开；这些会在后续篇章单独深挖。

## 前置依赖

### HARD

- `01-nacos-source-map-modules-runtime-assembly.md`

### SOFT

- 对 Spring Boot 启动阶段有直觉会有帮助，但不是前提。
- 对服务端集群、远程调用、鉴权这些中间件常见能力有直觉会有帮助，但不是前提。

### NAV

- 后续可接：remote/gRPC、cluster、auth/plugin、naming、config、consistency 各自深篇。

## 一句话困惑

`core` 为什么不是杂物模块，而是 Nacos 的 shared kernel？`sys` 又到底只负责什么、不负责什么？

## 一句话顿悟

`sys` 负责更靠下层的环境、文件、过滤、支撑设施；`core` 负责真正 server-wide 的共享内核：启动 phase、cluster membership、protocol manager、shared RPC server、shared auth filter 与公共控制面。naming/config 不是平行地各玩各的，而是站在这套 kernel 上。

## 读者理解路径

1. 先否定“core 是 leftovers bucket”“sys 和 core 差不多”两种直觉。
2. 先从启动链看：`bootstrap -> spring.factories -> SpringApplicationRunListener -> NacosApplicationListener -> NacosStartUpManager`。
3. 再切分 `sys` 和 `core` 的职责边界。
4. 再用五个 shared kernel 支柱压实 `core`：startup、cluster、consistency wiring、remote、auth。
5. 最后解释 naming/config 如何显式站在 kernel 上，而不是复刻一套 substrate。
6. 收束到：shared kernel 是后续所有业务平面的地板。

## 失败方案推演

### 失败方案一：`core` 就是很多公共类的杂物间

- 如果 `core` 只是 leftovers bucket，那么 startup SPI、cluster member manager、protocol manager、shared RPC server、auth filters 不会系统性地都落在这里。
- 但现在这些真正 server-wide 的公共能力都集中在 `core`。
- 所以 `core` 在 3.0.3 里是共享内核，不是垃圾回收站。

### 失败方案二：`sys` 和 `core` 基本是一回事

- `sys` 更像更底层的 support floor：环境、watcher、type exclude、module state、文件和工具。
- `core` 更像 server runtime substrate：cluster、protocol、remote、auth、startup、shared controllers。
- 两者不在同一层。

### 失败方案三：naming/config 是两个独立服务器，只是共享少量工具类

- naming/config 的 standalone app 都直接扫描 `com.alibaba.nacos.core`。
- merged 模式也是先起 core/basic context，再挂 web/console child context。
- 这说明它们不是“共享一点 util”，而是共享同一块内核地板。

### 失败方案四：Nacos 启动就是普通 Spring Boot 启动

- 实际上它叠了 `spring.factories`、`SpringApplicationRunListener`、`NacosApplicationListener`、`NacosStartUp` phase SPI 多层机制。
- 所以它不是“直接 run 一个 app”，而是 Nacos 自己再套了一层启动编排系统。

## 必须澄清的误解

1. `core` 不是杂物间，而是 shared server kernel。
2. `sys` 不是 `core` 的别名，而是更低一层的 support floor。
3. naming/config 不是各自独立 server，只是共享 util；它们显式站在 `core` 上。
4. startup phase 不是普通 Spring listener 够了，而是 Nacos 自己又做了一层 phase 编排。
5. remote / cluster / auth 这些能力虽然以后会单独写，但 shared kernel 入口已经在 `core` 里定型。

## 文章结构与字数预算

1. 困惑开场：为什么 `core` 不是杂物间（800-1000 字）
2. shared kernel 总图：`sys -> core -> naming/config`（1000-1400 字）
3. 启动编排链：`spring.factories -> run listener -> application listener -> startup manager`（1600-2200 字）
4. `sys` vs `core`：support floor 与 server kernel 的边界（1400-2000 字）
5. `core` 的五根支柱：cluster / consistency / remote / auth / common admin surface（2200-3000 字）
6. naming/config 如何站在 kernel 上（1000-1600 字）
7. 与后续 remote/cluster/auth/consistency 篇的边界（800-1200 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `bootstrap/NacosBootstrap.java:48` — deployment type / 多上下文入口
- `bootstrap/NacosBootstrap.java:94` — core startup phase
- `core/resources/META-INF/spring.factories:2` — ApplicationListener
- `core/resources/META-INF/spring.factories:5` — SpringApplicationRunListener
- `core/listener/startup/NacosStartUp.java:28` — startup phase SPI
- `core/listener/startup/NacosStartUpManager.java:43` — startup manager / phase registry
- `core/resources/META-INF/services/com.alibaba.nacos.core.listener.startup.NacosStartUp:17` — startup implementations SPI
- `core/code/SpringApplicationRunListener.java:37` — Spring 生命周期桥
- `core/listener/StartingApplicationListener.java:40` — Nacos startup 回调桥
- `core/listener/startup/NacosCoreStartUp.java:84` — core boot work
- `sys/env/EnvUtil.java:57` — env support floor
- `sys/filter/NacosTypeExcludeFilter.java:37` — type exclude floor
- `core/cluster/ServerMemberManager.java:91` — cluster kernel
- `core/cluster/lookup/LookupFactory.java:64` — lookup strategy
- `core/distributed/ProtocolManager.java:46` — protocol manager
- `core/distributed/ConsistencyConfiguration.java:38` — CP protocol wiring
- `core/remote/BaseRpcServer.java:43` — shared RPC server base
- `core/remote/grpc/BaseGrpcServer.java:91` — gRPC shared substrate
- `core/remote/RequestHandlerRegistry.java:75` — request dispatch registry
- `core/remote/ConnectionManager.java:102` — connection lifecycle
- `core/auth/AuthConfig.java:35` — shared auth filters
- `core/auth/RemoteRequestAuthFilter.java:67` — remote auth filter
- `config/server/Config.java:29` — config stands on core
- `naming/NamingApp.java:29` — naming stands on core
- `config/filter/ConfigEnabledFilter.java:41` — function-mode package filter
- `naming/config/NamingEnabledFilter.java:41` — function-mode package filter

## 测试与辅助证据

- `core/listener/StandaloneProfileApplicationListenerTest.java:41`
- `sys/filter/NacosTypeExcludeFilterTest.java:39`
- `core/cluster/ServerMemberManagerTest.java:62`
- `core/distributed/raft/JRaftProtocolTest.java:47`
- `core/CoreUtApplication.java:22`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3`。
- 不深挖 remote/gRPC 帧与双向流细节。
- 不深挖 cluster member lookup 策略细节。
- 不深挖 auth plugin 和 permission model。
- 不深挖 AP/CP 算法细节。

## 与后续篇章的边界

### 本篇要讲清

- `core` 与 `sys` 的职责边界。
- startup phase 机制如何搭起来。
- cluster / consistency / remote / auth 为什么都先落在 `core`。
- naming/config 如何站在 kernel 上。

### 本篇不深讲

- 远程协议细节（后续 remote 篇）
- 成员发现与 server-to-server 细节（后续 cluster 篇）
- auth plugin 与资源模型（后续 auth 篇）
- AP/CP 语义与 jraft/distro 细节（后续 consistency 篇）

## 写作后检查

- [ ] 开篇先抓“为什么 `core` 不是杂物间”，而不是直接罗列包名。
- [ ] 至少展开 4 个失败方案，且包含“`sys` 和 `core` 差不多”“启动就是普通 Spring Boot”。
- [ ] 明确给出 `sys -> core -> naming/config` 的 shared kernel 总图。
- [ ] 明确给出 startup 编排链。
- [ ] 每个 shared kernel 支柱都落到 file:line。
- [ ] 删除代码块后，读者仍能复述 `sys` 和 `core` 的边界以及 naming/config 站在 kernel 上的关系。
- [ ] 通过一次性深审收口。
