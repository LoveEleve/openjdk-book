# Tomcat Ch1-01 启动与装配闭环 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch1 Startup
- 篇：01 从配置树到运行时容器
- 对应主题：`T-1 启动与装配闭环`
- 文章类型：总入口 / 主机制篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者需要知道 Tomcat 是 Servlet 容器，最外层目标是“接收 HTTP 请求并调用 Servlet”。
- 读者需要知道 `Server / Service / Engine / Host / Context / Wrapper` 这些名字至少是 Tomcat 容器层次中的角色名，但不要求事先会背定义。

### SOFT

- T-2 请求进入与协议处理闭环：本篇只把 `Connector -> ProtocolHandler -> Adapter` 作为桥接角色点到，不深入协议处理细节。
- T-3 容器执行闭环：本篇只说明容器树最终会走到 `Mapper / Pipeline / FilterChain / Servlet`，不展开完整请求执行主线。
- Spring Boot 嵌入式集成：本篇可以导航式提到 `TomcatServletWebServerFactory`，但不把 Spring Boot 当主叙事依赖。

### NAV

- Ch1-02：请求是怎么进入 Tomcat 的（T-2）
- Ch1-03：请求在 Catalina 内部如何完成路由与执行（T-3）
- Ch2：异步、超时和错误为什么会牵扯到 Processor、HostValve 和 ErrorReportValve（T-4）

## 一句话困惑

为什么一套看起来只是“Server/Service/Engine/Host/Context/Wrapper”配置对象树的东西，在调用 `Tomcat.start()` 之后，就突然变成了一个真正能监听端口、接收连接、路由请求并执行 Servlet 的运行时系统？

## 一句话顿悟

Tomcat 启动不是“把几个对象 new 出来”这么简单，而是把**容器树、请求入口、协议适配器和路由监听器**焊接成一个闭环：从这一刻起，配置对象开始承担真实请求流转的职责。

## 读者理解路径

1. 先从直觉困惑切入：为什么“配置树”不等于“运行时系统”。
2. 建立最小总图：`Tomcat -> Server -> Service -> Connector + Engine -> Host -> Context -> Wrapper`。
3. 解释为什么只有容器树还不够：没有端口监听、没有协议入口、没有请求桥接、没有路由同步。
4. 引出 `Connector`、`CoyoteAdapter`、`MapperListener` 这三个最关键的桥接角色。
5. 顺着 `Tomcat.start()` / `StandardService` / `Connector.initInternal()` 解释“配置对象如何被焊成可运行系统”。
6. 最后回收：为什么下一篇必须继续讲请求如何从 Socket 进入这个系统。

## 失败方案推演

### 失败方案 1：只有容器树，没有请求入口

直觉上似乎只要把：
- `Server`
- `Service`
- `Engine`
- `Host`
- `Context`
- `Wrapper`

这些对象挂起来，Tomcat 就“算启动了”。

但这个方案缺了至少三件事：
- 没有端口监听，外部请求根本进不来
- 没有协议处理器，请求字节流没人解析
- 没有适配桥，协议层请求无法转换为 Catalina 容器世界的 `Request/Response`

所以“容器树完整”不等于“Tomcat 可运行”。

### 失败方案 2：只有 Connector，没有容器装配

另一个直觉方案是：只要有 `Connector + ProtocolHandler + Endpoint`，系统就能接收请求。

但这个方案也不成立，因为即使连接进来了，系统仍然回答不了：
- 请求要路由到哪个 Host/Context/Wrapper？
- 容器树什么时候和 Connector 绑定？
- Context/Wrapper 动态变化时谁负责把变化同步到路由结构？

这就是 `Mapper` / `MapperListener` 和 `Service` 的装配职责所在。

### 失败方案 3：把启动理解成一次性静态组装

如果把启动只理解成“启动前把所有对象连好”，会忽略运行态装配问题：
- `StandardService` 切换 `Engine` 时为什么要重启 `MapperListener`？
- `Connector.initInternal()` 为什么要延迟创建 `CoyoteAdapter` 并挂到 `ProtocolHandler`？

这说明启动不是单次静态建树，而是**进入运行态前的最后一轮接线过程**。

## 必须澄清的误解

1. `Tomcat.start()` 不是“容器树方法调用终点”，而是配置对象向运行时系统转变的起点。
2. `Server -> Service -> Engine -> Host -> Context -> Wrapper` 不是完整启动主线，只是容器层次主骨架。
3. `Connector` 不是附属细节，而是请求入口的一半；另一半是 `Adapter` 和 `MapperListener`。
4. `MapperListener` 不是旁路监听器，而是运行态路由同步的重要桥接角色。
5. 嵌入式 Tomcat 的“启动”不能只按 XML 配置时代的静态认知去讲，必须结合 `Tomcat.java` 当前代码路径。

## 文章结构与字数预算

1. 困惑开场：为什么配置树不等于运行时系统（900-1200 字）
2. Tomcat 的最小装配总图（1200-1500 字）
3. 只有容器树为什么不够（1200-1600 字）
4. Connector / Adapter / MapperListener 三个桥接角色（1800-2200 字）
5. `Tomcat.start()` 到 `StandardService` / `Connector.initInternal()` 的接线过程（2200-2800 字）
6. 运行态边界与误解澄清（1200-1600 字）
7. 收网总结与对 T-2/T-3 的桥接（800-1000 字）

目标叙述性正文：9000-12000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证，不直接相信当前规划文档：

- `java/org/apache/catalina/startup/Tomcat.java:137`
- `java/org/apache/catalina/startup/Tomcat.java:435`
- `java/org/apache/catalina/core/StandardService.java:97`
- `java/org/apache/catalina/core/StandardService.java:103`
- `java/org/apache/catalina/core/StandardService.java:151`
- `java/org/apache/catalina/connector/Connector.java:999`
- `java/org/apache/catalina/connector/Connector.java:1000`
- `java/org/apache/catalina/core/StandardEngine.java:62`
- `java/org/apache/catalina/core/StandardHost.java:69`
- `java/org/apache/catalina/core/StandardContext.java:160`
- `java/org/apache/catalina/core/StandardWrapper.java:87`
- 如涉及 Spring Boot 桥接，再补实际 `spring-boot` 对 Tomcat 的装配证据，不可凭记忆写

## 版本边界

- 当前源码基准：Tomcat `10.1.34`
- 本篇以嵌入式 Tomcat 当前 Java 代码路径为准
- 不把旧版 XML 配置时代或更早版本的启动路径当作当前实现主线
- 不把 Spring Boot 的外层封装误写成 Tomcat 自身启动逻辑

## 与其他篇的边界

### 本篇要讲清

- 启动时哪些角色必须接线
- 容器树与请求入口为什么必须同时存在
- `Connector / CoyoteAdapter / MapperListener` 为什么是桥接角色
- 配置对象如何变成运行时系统

### 本篇不深讲

- `NioEndpoint` 内部线程模型
- `Http11Processor` 如何解析 HTTP
- `Mapper.map()` 的四级匹配细节
- `Pipeline-Valve` / `FilterChain` 的逐层执行细节
- async / timeout / error 的完整状态机

这些放到后续主题。

## 写作后检查

- [ ] 开篇不是类名介绍，而是“配置树为何不等于运行时系统”的困惑
- [ ] 至少 2 个失败方案，不少于 1 个桥接角色专题段
- [ ] 明确区分容器树、请求入口、协议桥接、路由同步四类职责
- [ ] 不把 `Connector` 写成附属对象
- [ ] 不把 Spring Boot 封装逻辑误当成 Tomcat 核心实现
- [ ] 删除代码后主线仍然成立
- [ ] 所有 `file:line` 在写正文时重新 grep 验证
- [ ] 通过事实、因果、结构、读者、边界、依赖六轮 review
