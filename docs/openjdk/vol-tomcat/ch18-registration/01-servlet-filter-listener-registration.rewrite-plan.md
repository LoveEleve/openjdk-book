# Tomcat Ch18-01 Servlet / Filter / Listener 注册体系纵深 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch18 Registration
- 篇：01 这些组件不是自然存在的，而是被系统性挂进 Context 的
- 对应主题：Tomcat 完整卷的 **机制补深层**
- 文章类型：应用组件注册纵深篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch17-01，知道 `StandardContext` 不是普通节点，而是应用级编排中心。
- 读者应已读过 Ch7-01，知道 Spring Boot 侧会通过 `ServletContextInitializerBeans -> TomcatStarter` 把应用对象挂回容器。
- 读者应已读过 Ch8-01，知道 SCI / Initializer 先是规范层扩展点，再被 Tomcat 和 Spring Boot 各自利用。

### SOFT

- `StandardWrapper` 深挖已经讲过单个 Servlet 实例如何被管理，本篇不重复讲实例生命周期，而聚焦“这些对象最初是怎么系统性进容器的”。
- Session、类加载、生产层只在需要时作为注册结果的后续影响出现，不升格为主叙事。

### NAV

- Ch18-02：线程池 / Executor 专题
- 若需要，还可拆补篇：动态注册、SCI / HandlesTypes 深挖

## 一句话困惑

Servlet、Filter、Listener 在应用代码里看起来只是写几个类、加几个注解或注册 Bean，但在 Tomcat 运行时里，它们为什么会被有顺序地放进 `Context`，并在启动时一起生效？

## 一句话顿悟

这些组件不是“本来就在容器里”，而是通过一整条注册体系被系统性挂进 `Context`：**规范层给扩展点，Tomcat 给容器落点，Spring Boot 再把应用对象批量装进去。**

## 读者理解路径

1. 从“为什么组件不会自己出现在容器里”切入。
2. 建立最小总图：`Servlet spec extension points -> Context registration model -> Boot initializers -> runtime component set`。
3. 解释 `Context` 为什么必须持有和组织这套注册体系。
4. 解释 Servlet / Filter / Listener 为什么虽然类型不同，但都要被统一纳入应用级编排。
5. 解释 SCI / Initializer 为什么不是外围附属，而是注册主线的起点之一。
6. 最后收束：注册体系不是实现枝节，而是应用运行单元如何被装配成型的关键链。

## 失败方案推演

### 失败方案一：组件写在应用里，容器自然就能看到

这是最自然的业务开发者直觉：
- 写一个 Servlet
- 写一个 Filter
- 写一个 Listener
- 启动后容器自然就知道有这些东西

问题在于，源码视角里，“自然就知道”从来不是解释。容器必须回答：
- 它是在什么时候发现这些组件的
- 它把这些组件挂到哪
- 按什么顺序注册
- 什么时候这些组件才算真正进入运行态

所以组件不会自己出现，它们必须被注册链条系统性地挂进 `Context`。

### 失败方案二：Servlet、Filter、Listener 三套体系彼此独立

从 API 表面看，这三类组件确实不同：
- Servlet 处理请求
- Filter 包装请求链
- Listener 感知生命周期事件

但在 Tomcat 里，它们最终都要进入同一个应用运行单元。

如果把它们完全拆成三条互不相干的线，会看不到一个更重要的问题：
- 它们最终都得被 `Context` 统一托管和一起启动

所以差异存在，但注册入口和应用级编排视角必须先统一。

### 失败方案三：Spring Boot 注册只是额外封装，和容器注册主线关系不大

这个误解也很常见。因为看起来 Boot 只是在上层多做了些 Bean 扫描和回调。

但真实情况是：
- 规范先给了 SCI / Initializer 扩展点
- Tomcat 去兑现这个扩展入口
- Spring Boot 正是借这个入口，把自己容器里的 Servlet/Filter/Listener/Initializer 体系系统性挂回 Tomcat

所以 Boot 注册不是旁路封装，而是注册主线在嵌入式模式下的现实入口。

## 必须澄清的误解

1. 组件不会“自然出现”在容器里，它们一定是被注册进去的。
2. Servlet / Filter / Listener 虽然职责不同，但都必须回到同一个应用级编排中心里被统一托管。
3. SCI / Initializer 不是附属能力，而是注册体系的重要起点。
4. Spring Boot 不是绕开容器注册主线，而是在复用并扩展它。
5. 本篇讲的是注册体系如何成型，不是单个组件内部怎么执行。

## 文章结构与字数预算

1. 困惑开场：为什么组件不会自己出现在容器里（800-1000 字）
2. 最小总图：规范扩展点 -> Context 托管 -> Boot 回放（1200-1500 字）
3. `StandardContext` 为什么必须持有这套注册体系（1600-2200 字）
4. Servlet / Filter / Listener 为什么要被统一看作应用级部件（1600-2200 字）
5. SCI / Initializer 为什么是注册主线的重要起点（1800-2400 字）
6. Spring Boot 如何借这条链回放应用对象（1600-2200 字）
7. 收网总结：注册体系如何把“组件清单”变成“运行单元”（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `StandardContext` 里与 listener / filter / wrapper / initializers 相关的字段和启动链方法
- `jakarta.servlet.ServletContainerInitializer`
- Spring Boot 侧：
  - `ServletContextInitializerBeans`
  - `TomcatStarter`
  - 相关注册 Bean / Initializer 回放链

## 版本边界

- 当前分析对象：Tomcat `10.1.34` + Spring Boot `3.5.16`
- 本篇聚焦嵌入式主线相关注册体系
- 不混入 JSP / AJP / 过时部署模式

## 与其他篇的边界

### 本篇要讲清

- 组件如何被系统性挂进 `Context`
- 规范、Tomcat、Spring Boot 三层如何共同完成注册链
- 注册体系为什么是应用运行单元成型的关键步骤

### 本篇不深讲

- 单个组件内部执行细节
- Session / 类加载深层机制
- 生产层排障和治理

## 写作后检查

- [ ] 开篇不是 API 列表，而是“为什么组件不会自己出现在容器里”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Boot 注册只是额外封装”的误解
- [ ] 总图明确区分：规范扩展点、容器托管、Boot 回放
- [ ] 不把本篇写成注解/配置扫描手册
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
