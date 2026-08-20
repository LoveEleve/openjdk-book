# Tomcat Ch9-01 StandardWrapper 生命周期深挖 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch9 StandardWrapper
- 篇：01 Servlet 生命周期契约在 Tomcat 里是怎么被压成实例管理链的
- 对应主题：Tomcat 完整卷的 **机制补深层**
- 文章类型：生命周期纵深篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch3-01，知道 Catalina 执行闭环里最终会走到 `StandardWrapperValve -> ApplicationFilterChain -> Servlet.service()`。
- 读者应已读过 Ch8-01，知道 Servlet 生命周期哪些是规范要求，哪些是 Tomcat 当前实现取舍。

### SOFT

- Session、async/error、ClassLoader 这些专题会与 Servlet 生命周期产生交叉，但本篇不把它们升格为主叙事。
- Spring Boot 集成篇已说明应用组件如何被挂入容器；本篇只关注一个 Servlet 真正活起来、被调用、再被销毁的完整链条。

### NAV

- Ch9-02：ClassLoader 与实例化隔离（若需要补篇）
- Ch9-03：unavailable / reload / destroy 边界（若需要补篇）

## 一句话困惑

Servlet 规范只要求容器保证初始化、调用 `service()` 和销毁，但 Tomcat 为什么还要围着 `StandardWrapper` 搭出一整套 `allocate() / loadServlet() / initServlet() / unload()` 的实例管理链？

## 一句话顿悟

Tomcat 里的 `StandardWrapper` 不是一个“记录 Servlet 名字的配置节点”，而是**把 Servlet 生命周期契约、单实例语义、并发访问、故障状态和销毁回收全都压到一起的实例管理中心。**

## 读者理解路径

1. 从“为什么规范只讲生命周期语义，而 Tomcat 却搞出一整条实例管理链”切入。
2. 建立最小总图：`Wrapper config -> load / allocate -> init -> service -> deallocate / unload / unavailable`。
3. 解释 `StandardWrapper` 为什么不是单纯配置节点，而是 Servlet 实例的持有与分配中心。
4. 解释 `allocate()` 为什么关键：它回答“请求来了之后，谁把正确的 Servlet 实例交出来”。
5. 解释 `loadServlet()` / `initServlet()` 为什么不能糊成一步。
6. 解释 `deallocate()` / `unload()` / `unavailable` 为什么共同组成生命周期的退出与故障分支。
7. 最后收束：Tomcat 不是在“管理一个类”，而是在管理一条 Servlet 实例生命史。

## 失败方案推演

### 失败方案 1：Servlet 生命周期无非就是 `init -> service -> destroy`

这是从规范文本出发最自然的理解。

它当然没错，但它只描述了外部契约结果，没有解释容器内部必须解决的几个更具体的问题：
- Servlet 实例什么时候创建
- 谁持有这个实例
- 多个请求并发来时，是共享实例还是多实例
- 初始化失败或故障状态怎么处理
- Context 停止、重载时，谁负责真正销毁

所以“`init -> service -> destroy`”是契约结果，不是容器内部实现过程。

### 失败方案 2：`StandardWrapper` 只是容器树里的最后一个配置节点

如果只从 Ch3 看，`Wrapper` 容易被理解成：
- 容器树最底层
- 对应一个 Servlet
- 路由最终落到它

这个理解抓到了“定位”，但漏掉了“控制”。

在 Tomcat 当前实现里，`StandardWrapper` 不只是被找到的目标节点，它还负责：
- 持有/创建 Servlet 实例
- 控制初始化
- 协调并发分配
- 记录 unavailable 状态
- 在容器停止/重载时执行销毁

所以它不是末端标签，而是生命周期控制中心。

### 失败方案 3：`loadServlet()`、`initServlet()`、`allocate()` 只是拆得更细而已

如果只从方法名看，这几个方法很容易被误读成：
- 都是在“把 Servlet 搞出来”
- 拆这么多只是代码风格问题

这个理解不对，因为这几步回答的是不同的问题：
- `loadServlet()`：实例怎么被构造出来
- `initServlet()`：规范要求的初始化何时发生
- `allocate()`：请求真正到来时，如何把正确实例交给执行链

如果把它们糊成一团，后面就解释不了：
- 为什么初始化失败和分配失败不是一回事
- 为什么 unavailable 既能影响请求分配，又能影响后续恢复
- 为什么销毁也不是简单地“把对象置空”

## 必须澄清的误解

1. `StandardWrapper` 不是普通配置节点，而是 Servlet 实例管理中心。
2. 规范要求“容器要保证生命周期”，不等于规范规定了 Tomcat 必须用这套内部方法链。
3. `allocate()`、`loadServlet()`、`initServlet()`、`unload()` 不是同义拆分，而是不同阶段的职责切分。
4. unavailable 不是附属状态，而是 Servlet 生命周期里非常关键的故障分支。
5. 本篇讲的是“Servlet 实例生命史如何被 Tomcat 管起来”，不是重复讲一遍 Filter 或请求主线。

## 文章结构与字数预算

1. 困惑开场：为什么规范只讲结果，而 Tomcat 还要有完整实例管理链（800-1000 字）
2. 最小总图：Wrapper -> load / allocate / init / service / unload（1200-1500 字）
3. `StandardWrapper`：为什么它是生命周期控制中心（1600-2200 字）
4. `allocate()`：请求来到时如何交出实例（1800-2400 字）
5. `loadServlet()` / `initServlet()`：构造与初始化为什么要分开（1800-2400 字）
6. `deallocate()` / `unload()` / unavailable：生命周期退出与故障分支（1800-2400 字）
7. 收网总结：Servlet 契约如何在 Tomcat 里落成实例生命史（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `java/org/apache/catalina/core/StandardWrapper.java`
- `java/org/apache/catalina/core/StandardWrapperValve.java`
- `java/jakarta/servlet/Servlet.java`
- 若需要补门面层，再看：
  - `StandardWrapperFacade`
  - 相关 `Facade` / `ServletConfig` / `ServletContext` 桥接点

> 注意：这一篇不能只停留在 API 名称或旧版 Tomcat 印象，必须用当前 `StandardWrapper` 源码路径重新压实每个生命周期阶段。

## 版本边界

- 当前分析对象：Tomcat `10.1.34`
- 本篇关注当前 `StandardWrapper` / `StandardWrapperValve` 实现
- 不混入旧版 `javax.servlet` 时代差异，除非必须标注
- 不把 Spring Boot 应用注册桥重新当成本篇主线

## 与其他篇的边界

### 本篇要讲清

- 为什么 Servlet 生命周期契约在 Tomcat 内部会展开成完整实例管理链
- `StandardWrapper` 的控制中心地位
- `allocate/load/init/unload/unavailable` 的职责边界

### 本篇不深讲

- Filter 链内部机制
- Mapper 细节
- Session 生命周期
- async/error 反向控制流
- ClassLoader 隔离细节

这些放到前文或后续专题。

## 写作后检查

- [ ] 开篇不是类名介绍，而是“为什么规范只讲结果，而实现要有完整实例管理链”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“StandardWrapper 只是配置节点”的误解
- [ ] 总图明确区分：实例创建、初始化、分配、故障、销毁
- [ ] 不把 `StandardWrapper` 写成单纯属性容器
- [ ] 不把 unavailable 写成附属小状态
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
