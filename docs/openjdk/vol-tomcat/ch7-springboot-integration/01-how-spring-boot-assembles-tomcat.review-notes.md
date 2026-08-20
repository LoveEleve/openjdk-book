# Tomcat Ch7-01 Spring Boot 集成 — review notes

## 第一轮：事实审

### 目标
核对：
- 类名、路径、角色归属是否准确
- `file:line` 引用是否真实存在
- 代码块是否来自真实源码，而不是凭记忆改写

### 当前需核对的关键锚点
- `spring-boot` 侧：
  - `ServletWebServerApplicationContext`
  - `TomcatServletWebServerFactory`
  - `TomcatWebServer`
  - `TomcatStarter`
  - 与 customizer / configuration 映射相关的关键类
- `tomcat` 侧：
  - 与 `Tomcat`、`Context`、`Connector` 重新接上的关键锚点

### 初步判断
- 当前主线与 Ch7 规划一致：`Spring 触发者 -> Tomcat 组装者 -> 应用注册桥 -> 生命周期托管者`
- 没有把 Spring Boot 集成写成“简单代劳 new Tomcat()”
- 已经把 Tomcat 主干与集成桥区分开，没有混成一篇大杂烩

## 第二轮：因果审

### 目标
检查正文中所有“所以/说明/意味着”是否由源码支撑，而不是靠对 Spring Boot 常识的想当然补完。

### 当前因果链
1. `ServletWebServerApplicationContext` 是 Spring 侧触发嵌入式容器创建的角色
2. `TomcatServletWebServerFactory` 不是普通工厂，而是配置映射与结构组装的核心入口
3. `TomcatStarter` 不是小工具，而是应用组件注册桥
4. `TomcatWebServer` 不只是薄包装器，而是把 Tomcat 生命周期接入 Spring 生命周期的关键角色

### 当前风险
- 这篇当前最大的事实风险不是结构，而是“还没补 Spring Boot 侧精确源码锚点”，所以这些判断目前都只能算“结构上正确、证据还需补齐”
- 特别是 `TomcatStarter` 和 `TomcatWebServer`，若不补具体源码锚点，很容易滑向经验性总结

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 分层拆解 -> 收网”的方法论，而不是变成 Spring Boot 类名索引。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `ServletWebServerApplicationContext`
5. `TomcatServletWebServerFactory`
6. `TomcatStarter`
7. `TomcatWebServer`
8. 收网总结
9. 下篇桥接

### 当前结构优点
- 先回答“为什么真实项目里不手写 new Tomcat()”，而不是先扔 Spring Boot 类名
- 先拆“谁触发 / 谁组装 / 谁注册 / 谁托管”四层职责，再讲类
- 没有重新讲一遍 Tomcat 主干，而是专注集成桥

### 当前结构风险
- 如果后续补 `Customizer`、配置映射和两阶段启动细节太多，`TomcatServletWebServerFactory` 一节会膨胀过大
- 若不控制篇幅，`TomcatStarter` 与 `TomcatWebServer` 容易被压成次要角色

## 第四轮：读者审

### 目标
检查第一次从“Tomcat 本体”转向“Spring Boot 集成桥”的读者是否能跟住，而不是觉得突然跳到另一套框架。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么 Tomcat 本体已经讲清楚了，仍然还要补集成层
- 为什么 Spring Boot 不是简单替你 `new Tomcat()`
- 为什么 `Factory / Starter / WebServer` 不能互相替代
- 为什么真实项目里必须把 Boot 与 Tomcat 两边源码一起看

### 当前读者风险
- 对没读过 Spring Boot 源码的读者来说，`ServletWebServerApplicationContext` 这一层仍可能显得抽象
- 如果后续补源码时没有控制好信息密度，Factory / Starter / WebServer 三者容易又重新糊成一层“Spring Boot 帮你搞定”

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续专题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- Servlet 规范细节
- Tomcat 本体主干细节
- 生产参数调优
- 安全与运维治理

### 当前边界风险
- 如果为了解释集成桥而重讲太多 Tomcat 主干，会让本篇失焦
- 如果为了展示配置映射而展开太多 `server.tomcat.*` 细节，会提前吞掉生产层或 customizer 补篇

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Tomcat 主干 6 篇已立住本体机制
- 当前这篇作为完整卷的“集成层”切入是合理的

### 后续桥接
- 当前桥接到“Servlet 规范与 Tomcat 实现边界”是合理的：因为一旦看懂集成桥，读者也更容易回头理解哪些行为是规范要求，哪些是 Boot/Tomcat 的实现取舍
- 但如果后续排期想优先把“Spring Boot 配置映射 / Customizer”写透，也可以先在 Ch7 内部补专题

## 机械检查

### 禁用词
当前首稿主线中未明显使用以下禁用词：
- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

### 代码块角色检查
- 当前正文代码块还很少，后续事实审时必须逐字补足 Spring Boot 侧真实源码片段
- 要特别防止“把旧版 microsphere 文档行号直接抄过来”的问题

## 当前结论

这篇原先最大的缺口——**Spring Boot 侧硬锚点不足**——已经被补上，当前已经进入可收口状态。

本轮补强后，关键主线都有了方法级证据支撑：
- `ServletWebServerApplicationContext.onRefresh()/createWebServer()`
- `TomcatServletWebServerFactory.getWebServer()/prepareContext()/configureContext()`
- `TomcatStarter.onStartup(...)`
- `TomcatWebServer.initialize()/start()`

### 本轮收口修订记录
- 已把 Spring 侧“触发者”落到 `onRefresh()` / `createWebServer()` 真正锚点
- 已补强 `selfInitialize(ServletContext)` 与 `getServletContextInitializerBeans()`，说明 Spring Boot 不只触发容器创建，还会收集并回放 `ServletContextInitializer` 体系
- 已把 Factory 的“总装配车间”定位压实到 `getWebServer(...) -> prepareContext(...) -> mergeInitializers(...) -> configureContext(...)` 这条具体方法链
- 已把 `TomcatStarter` 的“应用注册桥”压实到 `ServletContainerInitializer` + `onStartup(...)` 遍历 `ServletContextInitializer`
- 已把 `TomcatWebServer` 的“生命周期托管者”压实到 `initialize()` 里的 `removeServiceConnectors()/disableBindOnInit()/tomcat.start()`，以及 `start()` 里的 `addPreviouslyRemovedConnectors()`
- 结尾也已保持正文收网口吻，不再像项目总结

## 建议的下一步

1. 以当前稿为准收口 Ch7-01
2. 进入 Servlet 规范专题
3. 继续延续一次性深审方式
