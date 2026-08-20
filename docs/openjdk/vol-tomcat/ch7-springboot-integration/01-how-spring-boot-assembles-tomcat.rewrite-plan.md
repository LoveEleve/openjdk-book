# Tomcat Ch7-01 Spring Boot 集成 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch7 Spring Boot Integration
- 篇：01 Spring Boot 是怎么把嵌入式 Tomcat 装起来的
- 对应主题：Tomcat 完整卷的 **集成层**
- 文章类型：上层装配桥篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Tomcat 主干 6 篇，至少知道：
  - Tomcat 自己如何启动
  - 请求如何进入 Catalina
  - 容器执行闭环是什么
- 读者应知道 Spring Boot 的目标不是重新实现 Servlet 容器，而是把 Tomcat 作为嵌入式运行时装起来并受自己生命周期驱动。

### SOFT

- Servlet 规范篇：本篇会提到 Servlet 容器和 `ServletWebServerApplicationContext` 的关系，但不展开 Servlet 规范细节。
- 生产专题：本篇会碰到配置映射与 customizer，但不展开生产参数调优细节。

### NAV

- Ch7-02：Customizer / 配置映射专题（若需要拆补篇）
- Ch7-03：TomcatWebServer 生命周期专题（若需要拆补篇）

## 一句话困惑

Tomcat 自己的启动主线已经讲清楚了，但在真实 Spring Boot 应用里，我们几乎不会手写 `new Tomcat()`、`addContext()`、`addServlet()`；那 Spring Boot 到底是怎么把这套容器结构、Connector、Context 和应用对象真正装起来的？

## 一句话顿悟

Spring Boot 并没有“替代” Tomcat，它做的是一条上层装配桥：**`TomcatServletWebServerFactory` 负责造车，`TomcatStarter` 负责把应用注册进容器，`TomcatWebServer` 负责把这辆车纳入 Spring 自己的生命周期。**

## 读者理解路径

1. 从“为什么源码里 Tomcat 已经会启动了，但真实项目里我们却几乎不手写它”切入。
2. 建立最小总图：`SpringApplication.run()` -> `ServletWebServerApplicationContext` -> `TomcatServletWebServerFactory.getWebServer()` -> `TomcatStarter` -> `TomcatWebServer.start()`。
3. 解释 Spring Boot 为什么要多出一层 `Factory`，而不是直接 new 完 Tomcat 就用。
4. 解释 `TomcatStarter` 为什么是关键桥：它把 Spring 管理的 Servlet/Filter/Listener 体系挂回 Tomcat。
5. 解释 `TomcatWebServer` 为什么不只是简单包装器，而是把 Tomcat 生命周期纳入 Spring 容器刷新/关闭节奏的关键角色。
6. 最后收束：Tomcat 主干讲的是“Tomcat 本体怎么跑”，而本篇讲的是“Spring Boot 怎么把它装成现实项目里真正那台车”。

## 失败方案推演

### 失败方案 1：Spring Boot 只是替你 `new Tomcat()`

这是最表面的理解，因为很多人看到嵌入式容器，第一反应就是：
- Spring Boot 不过是帮你少写几行初始化代码

这个说法的问题在于，它低估了 Spring Boot 额外承担的三件事：
- 应用组件注册
- 生命周期托管
- 外部配置映射

如果只是“帮你 new 一下”，那它解释不了：
- 为什么 `ServletWebServerApplicationContext` 要参与
- 为什么 `TomcatStarter` 要存在
- 为什么 `TomcatWebServer` 和 `SmartLifecycle` 之类角色会进入链路

### 失败方案 2：Factory 只是构造器模式包装，不是主线

另一个常见误解是把 `TomcatServletWebServerFactory` 看成普通工厂类：
- 提供一个 `getWebServer()`
- 内部把对象拼一拼
- 返回 Tomcat

问题在于，这样会低估它在集成层里的真正地位。它不只是“造对象”，而是在承担：
- Spring Boot 配置向 Tomcat 结构的映射
- Context / Connector / ProtocolHandler 定制点的汇总入口
- 应用级初始化器注入的组装点

也就是说，它不是可有可无的包一层，而是集成桥的上半段。

### 失败方案 3：Tomcat 启动和 Spring 刷新是两条互不相干的生命周期

如果只分别看 Tomcat 与 Spring 的源码，很容易觉得：
- Tomcat 自己会启动
- Spring 自己也有刷新流程
- 两边大概只是碰巧接到一起

但真实情况不是这样。对于嵌入式模式，Tomcat 的启动、应用对象注册、端口真正开始可用，都被编排进了 Spring 的刷新/启动节奏里。

如果不把这层编排关系讲清楚，读者就会知道两边各自的源码，却不知道它们在真实应用里是怎么接成一条完整链的。

## 必须澄清的误解

1. Spring Boot 不是替代 Tomcat，而是装配和托管 Tomcat。
2. `TomcatServletWebServerFactory` 不是普通工厂类，而是配置映射与结构组装的核心入口。
3. `TomcatStarter` 不是小工具，而是 Spring 应用对象进入 Tomcat 容器的桥。
4. `TomcatWebServer` 不只是薄包装器，而是容器生命周期接入 Spring 生命周期的关键角色。
5. 本篇讲的是“集成桥”，不是重讲一遍 Tomcat 本体主干。

## 文章结构与字数预算

1. 困惑开场：为什么真实项目里几乎不手写 `new Tomcat()`（800-1000 字）
2. 最小总图：Spring Boot -> Factory -> Starter -> WebServer -> Tomcat（1200-1500 字）
3. `ServletWebServerApplicationContext`：为什么是它来触发嵌入式容器创建（1200-1800 字）
4. `TomcatServletWebServerFactory`：为什么它是集成桥的上半段（1800-2400 字）
5. `TomcatStarter`：Spring 应用组件如何挂回 Tomcat（1600-2200 字）
6. `TomcatWebServer`：Tomcat 生命周期如何被纳入 Spring 刷新节奏（1600-2200 字）
7. 收网总结：Tomcat 本体主干 + Boot 集成桥 = 真实项目里的嵌入式容器（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `spring-boot` 侧：
  - `ServletWebServerApplicationContext`
  - `TomcatServletWebServerFactory`
  - `TomcatWebServer`
  - `TomcatStarter`
  - 与 customizer/configuration 映射相关的关键类
- `tomcat` 侧：
  - 与 `Tomcat`、`Context`、`Connector` 装配重新接上的关键锚点

> 注意：本篇证据会跨两个仓库，写作时必须逐条重新 grep，不能直接沿用旧版 microsphere 文档里的行号。

## 版本边界

- 当前分析对象：Tomcat `10.1.34` + Spring Boot `3.5.16`
- 本篇以当前嵌入式 Tomcat 路径为准，不混入独立部署 Catalina 模式
- 不把生产参数调优和安全治理细节提前透支到本篇

## 与其他篇的边界

### 本篇要讲清

- Spring Boot 为什么需要一套嵌入式容器装配桥
- `Factory / Starter / WebServer` 三类角色如何分工
- Tomcat 本体主干是如何被 Spring 生命周期接住的

### 本篇不深讲

- Servlet 规范细节
- Tomcat 本体主干细节
- 生产参数调优
- 安全与运维治理

这些放到规范层或生产层专题。

## 写作后检查

- [ ] 开篇不是 Spring Boot 类名介绍，而是“为什么真实项目里不手写 new Tomcat()”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Factory 只是普通工厂类”的误解
- [ ] 总图明确区分：Spring 触发者、Tomcat 组装者、应用注册桥、生命周期托管者
- [ ] 不把 Boot 集成写成“对 Tomcat 主干的简单重复”
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
