# Tomcat Ch17-01 StandardContext 启停主线 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch17 StandardContext
- 篇：01 一个 Web 应用为什么在 Tomcat 里不是一个 Servlet 集合，而是一整套组件编排系统
- 对应主题：Tomcat 完整卷的 **机制补深层**
- 文章类型：应用级生命周期编排篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch1 启动与装配闭环，知道容器树 `Engine -> Host -> Context -> Wrapper` 的层级关系。
- 读者应已读过 Ch3 容器执行闭环，知道请求最终会落到 `Wrapper` 和 Filter/Servlet 执行链。
- 读者应已读过 Ch9 `StandardWrapper` 深挖，知道单个 Servlet 实例在 Tomcat 内部是如何被管理的。

### SOFT

- Servlet 规范篇已解释“生命周期契约 vs Tomcat 实现取舍”，本篇不再重讲规范，而是聚焦 `Context` 作为“整应用控制中心”是怎样落地的。
- Spring Boot 集成篇已说明应用怎么被装进 Tomcat，本篇只在需要时回提 Boot 如何把应用注册进 `Context`。

### NAV

- Ch17-02：Servlet / Filter / Listener 注册体系纵深
- Ch18：线程池 / Executor 专题

## 一句话困惑

为什么在 Tomcat 里，一个 Web 应用不是“几个 Servlet 和 Filter 拼在一起”就够了，而要由 `StandardContext` 这样一个巨大对象统一编排启动、停止、销毁、类加载、Session、资源、监听器和子组件？

## 一句话顿悟

Tomcat 里的 `Context` 不是“应用配置节点”，而是 **Web 应用的生命周期编排中心**：它把 Servlet、Filter、Listener、Loader、Manager、Resources、Valve、ClassLoader 等所有应用级部件组织成一个可启动、可停止、可重载、可清理的完整运行单元。

## 读者理解路径

1. 从“为什么 Web 应用不是几个组件的松散拼装，而是一整套编排系统”切入。
2. 建立最小总图：`Context -> Loader / Manager / Resources / Wrapper / Listeners / Filters / Pipeline`。
3. 解释 `StandardContext` 为什么不是单纯配置节点，而是应用级生命周期控制中心。
4. 解释启动顺序为什么重要：哪些子组件必须先起来，哪些必须后起来。
5. 解释停止/销毁为什么同样重要：一旦顺序错误，为什么就会留下老实例、老状态、老类空间。
6. 最后收束：Tomcat 管理的不是“一个 Servlet 集合”，而是一整个 Web 应用运行单元。

## 失败方案推演

### 失败方案一：一个 Web 应用就是若干 Servlet、Filter、Listener 的集合

这是最符合业务开发者直觉的理解。

因为平时接触应用时，最显眼的往往就是：
- Servlet
- Filter
- Listener

于是很容易觉得：
- Web 应用不过就是这些组件的集合
- Tomcat 只要把它们注册起来，请求来了能调起来就够了

这个理解的问题在于，它只看到了“组件存在”，却没看到“组件之间必须被按顺序编排、统一管理、统一退场”。

一个真正运行中的 Web 应用，不只是这些组件的清单，它还必须具备：
- 类加载边界
- Session 管理
- 资源视图
- 生命周期监听
- 停止与销毁收束

所以 `Context` 不是“组件列表”，而是“应用级运行单元”。

### 失败方案二：容器树里 `Context` 只是 `Host` 和 `Wrapper` 之间的中间层

从容器树结构看，`Context` 的位置确实像中间层：
- `Host -> Context -> Wrapper`

如果只从树形结构去看，很容易把它理解成一个路由层级节点：
- 负责把请求继续往下交给 Wrapper

这个理解抓住了它在执行链里的位置，却完全漏掉了它在生命周期里的重量。

因为 `Context` 不只是“请求经过的地方”，它还是：
- Loader 的持有者
- Manager 的宿主
- 资源系统的入口
- Listener / Filter / Wrapper 的总编排者
- 停止、重载、销毁的组织者

所以它不是轻量中间层，而是应用级控制中心。

### 失败方案三：应用只要能启动，停止和销毁顺序没那么重要

这是很多源码阅读里常见的盲区：
- 启动主线很容易被重视
- 停止和销毁则容易被看成“收尾细节”

但对 Tomcat 来说，停止/销毁一点也不轻。

因为：
- Servlet 实例可能还在
- Session 状态可能还活着
- 类加载器可能还没退场
- 监听器和线程可能还挂着

只要这些东西没有被按顺序正确收束，应用虽然“逻辑上停了”，但运行时包袱仍然可能继续留在 JVM 里。

所以 `Context` 的真正重量，不只在于“怎么启动一堆东西”，更在于“怎么把一整个应用正确收起来”。

## 必须澄清的误解

1. `Context` 不是配置节点，而是应用级生命周期编排中心。
2. Web 应用不是 Servlet/Filter/Listener 的清单，而是一个完整运行单元。
3. 启动顺序和停止顺序一样重要。
4. `Context` 的存在意义不只是请求路由层级，而是统一托管应用级子系统。
5. 本篇讲的是应用级编排，不是某个单一子组件的内部细节。

## 文章结构与字数预算

1. 困惑开场：为什么 Web 应用不是几个组件拼一起（800-1000 字）
2. 最小总图：Context 统一托管哪些应用级部件（1200-1500 字）
3. `StandardContext` 为什么是应用级控制中心（1600-2200 字）
4. 启动顺序：为什么组件必须按编排顺序起来（1800-2400 字）
5. 停止/销毁顺序：为什么应用退场也必须成体系（1800-2400 字）
6. 这一层为什么会牵连 Session、类加载、Listener、资源边界（1400-2000 字）
7. 收网总结：Tomcat 管理的是“应用运行单元”而不是“组件列表”（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `org/apache/catalina/core/StandardContext.java`
- 与其启动/停止/销毁相关的关键方法锚点
- 若需要补子系统关系，再补：
  - `WebappLoader`
  - `Manager`
  - `Wrapper` / `Filter` / `Listener` 注册链

## 版本边界

- 当前分析对象：Tomcat `10.1.34`
- 本篇聚焦当前 `StandardContext` 作为应用级生命周期中心的主线
- 不混入过时部署模式或不走的历史路径

## 与其他篇的边界

### 本篇要讲清

- `StandardContext` 为什么是应用级编排中心
- 为什么 Web 应用必须被当成完整运行单元管理
- 启停顺序为什么和请求主线、Session、类加载紧密相连

### 本篇不深讲

- 单个 Servlet 生命周期细节（已在 Ch9）
- ClassLoader 隔离细节（已在 Ch10/Ch11）
- 生产故障命令（已转入生产层）

## 写作后检查

- [ ] 开篇不是类名介绍，而是“为什么应用不是组件清单”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“停止不重要”的误解
- [ ] 总图明确区分：Loader / Manager / Resources / Wrapper / Listeners / Filters / Pipeline
- [ ] 不把本篇写成 `StandardContext` 属性大全
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
