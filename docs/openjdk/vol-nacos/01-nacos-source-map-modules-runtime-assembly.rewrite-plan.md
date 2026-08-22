# Nacos：源码总图、模块分层与运行时装配 — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch01-orientation`
- 篇：`01 Nacos：源码总图、模块分层与运行时装配`
- 对应主题：`N-01 source map / assembly`
- 文章类型：总图入口篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3`

## 文章定位

- 核心困惑：很多人对 Nacos 的第一印象是“注册中心 + 配置中心”，于是会自然把源码理解成 `naming + config` 两个业务模块，再加一个 server 壳。但真正落到 3.0.3 源码，会发现根模块里还有 `core`、`consistency`、`persistence`、`auth`、`console`、`plugin`、`prometheus`、`bootstrap`、`server` 等一大串模块。问题不是“模块有点多”，而是：**哪些是真正的运行时 seam，哪些只是打包或扩展壳？server 到底是不是核心？core 到底在提供什么？最终的可运行 Nacos 又是怎样装起来的？**
- 一句话顿悟：Nacos 3.0.3 不是“两个业务模块外面套一个 server”，而是**以 `core` 为共享内核、以 `naming` / `config` 为两大业务平面、再通过 `server` / `console` / `bootstrap` / `plugin` / `prometheus` 等模块做多上下文装配的组合式运行时平台**。
- 文章边界：本篇只做源码总图、模块边界、装配关系、启动分层和阅读地图，不深入 naming/config 业务细节，不展开具体注册、长轮询、distro、jraft、鉴权算法实现。

## 前置依赖

### HARD

- 无

### SOFT

- 对 Spring Boot 多上下文启动有基本直觉会有帮助，但不是前提。
- 对注册中心、配置中心的业务使用经验会有帮助，但不是前提。

### NAV

- 后续将接：shared kernel、remote/gRPC、naming、config、persistence、consistency、client SDK 等主线。

## 一句话困惑

Nacos 到底是不是“naming + config + 一个 server 壳”？如果不是，那真正的运行时骨架是什么？

## 一句话顿悟

Nacos 3.0.3 的 runnable runtime 是：`core` 提供共享内核，`naming` / `config` 提供业务平面，`server` / `console` / `bootstrap` 提供多上下文装配壳，`auth` / `plugin` / `consistency` / `persistence` / `prometheus` 等模块作为横切能力或基础设施 seam 插入其中。

## 读者理解路径

1. 先否定“只有 naming + config”这个朴素印象。
2. 从 root `pom.xml` 建立真实模块地图。
3. 解释哪些模块是 runtime seam，哪些模块主要是 assembly/packaging/support。
4. 解释为什么 `server` 不是业务核心，而是装配壳。
5. 解释为什么 `core` 才是真正的共享内核。
6. 解释 merged 模式下 `bootstrap -> basic server context -> web context -> console context -> optional MCP context` 的装配链。
7. 给出后续 `vol-nacos` 的阅读地图。

## 失败方案推演

### 失败方案一：Nacos 就是 naming + config 两个模块

- 这个理解只能描述产品功能，不能描述源码运行时。
- 真实源码里，`core`、`consistency`、`persistence`、`auth`、`console`、`plugin`、`bootstrap` 都在运行期扮演真实角色。
- 所以“Nacos = naming + config”只适合产品介绍，不适合源码阅读入口。

### 失败方案二：`server` 就是 Nacos 的核心模块

- `server` 的主要作用是依赖聚合与扫描边界控制。
- 它自己不承载 naming/config 的主体业务逻辑。
- 真正的共享 server-side substrate 在 `core`。

### 失败方案三：`console` 只是一个静态 UI，和 runtime 无关

- `console` 在 3.0.3 中是独立 Spring Boot 上下文，依赖 naming/config/auth/prometheus/istio/k8s-sync 等模块。
- 它不是“前端资源目录”，而是 operator shell。
- 所以它应当被纳入 runtime assembly 总图，而不是作为边角料。

## 必须澄清的误解

1. `server` 是装配壳，不是业务核心。
2. `core` 是共享运行时地基，不是“杂物间”。
3. `console` 是单独的管理上下文，不是静态前端目录。
4. `plugin` / `plugin-default-impl` 是扩展 seam，不是可忽略的外围模块。
5. Nacos 3.x 的最终可运行态是多上下文装配，不是单 SpringBootApplication 一把梭。

## 文章结构与字数预算

1. 困惑开场：为什么 Nacos 不能用“naming + config”理解（800-1000 字）
2. root 模块地图：从 reactor 看真实运行时（1200-1800 字）
3. runtime seam vs assembly/support（1400-2000 字）
4. 为什么 `server` 不是核心（1200-1800 字）
5. 为什么 `core` 才是共享内核（1600-2200 字）
6. 真正的运行时装配：`bootstrap` 多上下文启动（1600-2200 字）
7. 后续阅读地图：vol-nacos 17 篇如何展开（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `nacos/pom.xml:655` — root reactor modules
- `server/pom.xml:32` — server 依赖聚合
- `bootstrap/pom.xml:32` — bootstrap 依赖 console + server + MCP adaptor
- `console/pom.xml:31` — console 不是纯 UI，而是聚合上下文
- `plugin/pom.xml:32` — plugin SPI families
- `plugin-default-impl/pom.xml:32` — default impl aggregation
- `bootstrap/NacosBootstrap.java:48` — deployment type dispatch
- `bootstrap/NacosBootstrap.java:93` — basic server context startup
- `bootstrap/NacosBootstrap.java:99` — web context startup
- `bootstrap/NacosBootstrap.java:106` — console context startup
- `bootstrap/NacosBootstrap.java:113` — optional MCP context
- `server/NacosServerBasicApplication.java:34` — non-web server starter / excludes
- `server/NacosServerWebApplication.java:34` — web server starter / excludes
- `core/pom.xml:36` — core depends on consistency/persistence/auth/plugins
- `core/listener/startup/NacosStartUp.java:28` — startup phase SPI
- `core/listener/startup/NacosStartUpManager.java:33` — startup phase manager
- `core/listener/startup/NacosCoreStartUp.java:100` — env/workdir/storage mode bootstrap
- `core/cluster/ServerMemberManager.java:91` — cluster substrate in core
- `core/distributed/ConsistencyConfiguration.java:35` — CP protocol wiring in core
- `core/remote/BaseRpcServer.java:34` — RPC substrate in core
- `core/auth/AuthConfig.java:31` — global auth filter registration in core
- `sys/filter/NacosTypeExcludeFilter.java:37` — package filtering / type exclude
- `config/filter/ConfigEnabledFilter.java:33` — function-mode gating
- `naming/config/NamingEnabledFilter.java:33` — function-mode gating
- `naming/NamingApp.java:28` — naming scans naming + core
- `config/server/Config.java:28` — config scans config + core
- `console/NacosConsole.java:30` — console as standalone SpringBootApplication

## 测试与启动证据

- `console/NacosConsoleStartUpTest.java:41` — console startup behavior
- `core/cluster/ServerMemberManagerTest.java:62` — cluster substrate
- `core/distributed/raft/JRaftProtocolTest.java:56` — consistency substrate
- `naming/remote/rpc/handler/InstanceRequestHandlerTest.java:42` — naming runtime path example

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3`。
- 不回退到 1.x / 2.x 的历史形态做主体叙述。
- 不展开 AI / MCP 业务语义，只把它作为可选装配上下文看待。
- 不展开 Spring Cloud Alibaba 接入链，因为那条线由另一套分析承担。

## 与后续篇章的边界

### 本篇要讲清

- Nacos 3.0.3 的真实模块地图。
- runtime seam 和 assembly/support 的分层。
- `server`、`core`、`bootstrap`、`console` 的职责边界。
- 后续 17 篇的阅读地图。

### 本篇不深讲

- naming 注册/订阅细节。
- config publish/query/listen/dump 细节。
- distro / jraft 算法细节。
- auth SPI 内部实现细节。

## 写作后检查

- [ ] 开篇先抓“为什么 Nacos 不是 naming + config”，而不是直接列模块。
- [ ] 至少展开 3 个失败方案，且包含“server 是核心”和“console 只是 UI”。
- [ ] 明确给出 root modules → runtime seam → assembly chain 总图。
- [ ] 明确说明 `core` 为什么是共享内核。
- [ ] 每个结论落到 file:line。
- [ ] 删除代码块后，读者仍能复述 Nacos 的模块分层与运行时装配链。
- [ ] 通过一次性深审收口。
