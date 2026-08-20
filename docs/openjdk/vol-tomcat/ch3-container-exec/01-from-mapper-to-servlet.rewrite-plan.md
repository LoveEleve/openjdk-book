# Tomcat Ch3-01 容器执行闭环 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch3 Container Execution
- 篇：01 从 Mapper 到 Servlet
- 对应主题：`T-3 容器执行闭环`
- 文章类型：主运行时链路篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch1-01，知道 Tomcat 启动期已经把 `Connector / CoyoteAdapter / MapperListener / 容器树` 接成运行时系统。
- 读者应已读过 Ch2-01，知道请求已经通过 `CoyoteAdapter` 从 Coyote 世界切进 Catalina 世界。

### SOFT

- T-4 异步、超时与错误处理闭环：本篇会碰到 `request.isAsyncDispatching()`、异常出口和 `StandardHostValve.throwable(...)`，但不展开完整 async/error 状态机。
- T-6 Mapper 路由与动态更新专题：本篇只讲 Mapper 在主线里的入口作用，不展开路由树维护与动态更新算法。

### NAV

- Ch3-02：Valve 体系与容器责任链的逐层细化
- Ch4：Async / timeout / error 如何反向切回 HostValve 和 ErrorReportValve
- Ch5：Session 在请求执行主线里是如何被访问与回收的

## 一句话困惑

请求已经进入 Catalina 了，但它为什么不是直接调用 Servlet，而还要经过 Mapper、Engine/Host/Context/Wrapper 这一串 Valve，再经过 FilterChain，最后才走到 `Servlet.service()`？

## 一句话顿悟

Catalina 的执行主线不是“找到 Servlet 就调用”，而是先由 **Mapper 选目标**，再由 **容器四层 Valve 链逐层收束执行上下文**，最后由 **ApplicationFilterChain** 把 Filter 和 Servlet 串成真正的执行末端。

## 读者理解路径

1. 从“为什么不能 `Adapter -> Servlet` 直接跳过去”这个困惑切入。
2. 建立最小总图：`Mapper -> EngineValve -> HostValve -> ContextValve -> WrapperValve -> ApplicationFilterChain -> Servlet.service()`。
3. 解释 Mapper 为什么不是“路由工具类”，而是请求进入容器执行链的第一道入口。
4. 解释四层 Valve 链为什么不能被压成一个“责任链大章”。
5. 解释 `StandardWrapperValve` 为什么是容器链与 Filter/Servlet 世界的交界点。
6. 解释 `ApplicationFilterFactory.createFilterChain(...)` / `ApplicationFilterChain.doFilter()` 为什么是容器执行主线真正的末端桥。
7. 最后把边界收在：async/error 为什么会反向把问题拉回 HostValve/WrapperValve。

## 失败方案推演

### 失败方案 1：请求进入 Catalina 之后，直接找到 Servlet 调 `service()`

这是最容易产生的直觉，因为从结果看，Tomcat 最终确实是把请求交给某个 Servlet。

但如果把中间过程压掉，就无法解释：
- 虚拟主机是怎么选的
- Web 应用边界是怎么落的
- URL 是怎么映射到具体 Wrapper 的
- Filter 为什么能先于 Servlet 执行
- 异常、async dispatch、错误页是在哪一层被重新接住的

也就是说，Servlet 不是入口，它只是这条链的末端。

### 失败方案 2：Mapper 负责路由，Valve 负责执行，两者互不相干

这个切法表面上清楚，但会带来另一个误解：
- 仿佛 Mapper 只是“前面找一下目标”
- 然后真正重要的是后面的 Valve 链

问题在于，请求主线里 Mapper 不是附属预处理，而是容器执行闭环的起点。没有它，后面根本不知道请求该进入哪个 Host/Context/Wrapper。

所以 Mapper 和容器责任链不是两个平行主题，而是前后相接的一条执行主线。

### 失败方案 3：Valve 链讲完就等于请求执行讲完

如果只讲 `StandardEngineValve -> StandardHostValve -> StandardContextValve -> StandardWrapperValve`，很容易误以为“容器责任链已经是最后一层执行结构”。

但 Tomcat 到 `StandardWrapperValve` 还没有结束，因为：
- 它还要构造 `ApplicationFilterChain`
- 还要区分普通请求和 async dispatch
- 真正把 Filter 与 Servlet 串起来的是 FilterChain，而不是 Valve 本身

所以 `StandardWrapperValve` 不是终点，而是“容器链”与“Filter/Servlet 执行链”的边界点。

## 必须澄清的误解

1. `Mapper` 不是普通工具类，而是请求进入容器执行主线的入口。
2. 四层 `Valve` 链不是重复套壳，而是在一层层收束执行上下文。
3. `StandardWrapperValve` 还不是最终执行点，它之后还有 `ApplicationFilterChain`。
4. `ApplicationFilterChain` 不是附属实现，而是 Filter 与 Servlet 世界真正开始的地方。
5. 本篇讲的是“请求如何在 Catalina 中被执行起来”，不是 async/error 的完整反向控制流。

## 文章结构与字数预算

1. 困惑开场：为什么请求进了 Catalina 还不能直接调 Servlet（800-1000 字）
2. 最小总图：Mapper -> Valve -> FilterChain -> Servlet（1200-1500 字）
3. `Mapper`：容器执行闭环的入口（1400-1800 字）
4. 四层 `Valve` 链：Engine / Host / Context / Wrapper 如何逐层收束（2200-2800 字）
5. `StandardWrapperValve`：容器链与 Filter/Servlet 世界的边界（1500-2000 字）
6. `ApplicationFilterFactory` / `ApplicationFilterChain`：执行末端真正成型（1600-2200 字）
7. 收网总结与对 async/error 的桥接（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `java/org/apache/catalina/mapper/Mapper.java:47`
- `java/org/apache/catalina/mapper/MapperListener.java:47`
- `java/org/apache/catalina/core/StandardEngineValve.java:35`
- `java/org/apache/catalina/core/StandardHostValve.java:50`
- `java/org/apache/catalina/core/StandardContextValve.java:40`
- `java/org/apache/catalina/core/StandardWrapperValve.java:50`
- `java/org/apache/catalina/core/StandardWrapperValve.java:141`
- `java/org/apache/catalina/core/ApplicationFilterFactory.java:57`
- `java/org/apache/catalina/core/ApplicationFilterChain.java:46`
- 如涉及异常/async 分支，再补：
  - `java/org/apache/catalina/core/AsyncContextImpl.java:442`
  - `java/org/apache/catalina/core/StandardHostValve.java:231`

测试侧至少补：
- `test/org/apache/catalina/mapper/`
- `test/org/apache/catalina/valves/`
- `test/org/apache/catalina/core/`（若有与 FilterChain/Dispatcher 相关用例）

## 版本边界

- 当前源码基准：Tomcat `10.1.34`
- 本篇以 Catalina 主执行链为主，不把 HTTP/2 / AJP / WebSocket 路径混入主线
- 不把 async/error 完整状态机提前透支到本篇

## 与其他篇的边界

### 本篇要讲清

- 请求进入 Catalina 后，为什么先到 Mapper，再到四层 Valve，再到 FilterChain 和 Servlet
- `StandardWrapperValve` 为什么是容器链与执行链的交界点
- `ApplicationFilterChain` 为什么不能被写成附属实现

### 本篇不深讲

- Mapper 四级匹配算法细节
- MapperListener 动态更新机制
- async / timeout / error 的完整控制流
- Session 生命周期和持久化

这些放到后续专题。

## 写作后检查

- [ ] 开篇不是类名堆砌，而是“为什么不能直接调 Servlet”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对 `StandardWrapperValve != 最终执行点`
- [ ] 总图明确区分：路由入口、容器责任链、执行末端桥接
- [ ] 不把 Valve 链写成抽象设计模式介绍
- [ ] 不把 FilterChain 写成附属细节
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
