# Tomcat Ch4-01 异步、超时与错误处理闭环 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch4 Async / Timeout / Error
- 篇：01 请求偏离正常路径时，Tomcat 如何重新接住它
- 对应主题：`T-4 异步、超时与错误处理闭环`
- 文章类型：主运行时边界篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch2-01，知道请求如何从 `Connector / Endpoint / Processor / Adapter` 进入 Catalina。
- 读者应已读过 Ch3-01，知道请求在 Catalina 内部会经过 `Mapper -> Valve -> FilterChain -> Servlet` 的正常执行主线。

### SOFT

- T-5 Session 生命周期闭环：本篇可能碰到请求超时/错误后与 Session 生命周期的边界，但不展开 Session 主体。
- T-6 Mapper 专题：本篇只在需要时回提 Host/Context/Wrapper 目标，不展开路由树本体。

### NAV

- Ch4-02：若需要，可继续拆“async dispatch/complete/onError 状态机”和“错误页/ErrorReportValve”两个后续补篇
- Ch5：Session、持久化与过期清理如何受请求生命周期影响

## 一句话困惑

一个请求并不是每次都沿着 `Mapper -> Valve -> FilterChain -> Servlet` 正常走到底；一旦它开始 async、发生 timeout、抛出异常，Tomcat 是怎么把这条已经偏离正常路径的请求重新接住的？

## 一句话顿悟

Tomcat 的 async / timeout / error 不是零散补丁，而是一条反向控制流：**Processor 侧的状态机负责感知与推进，Catalina 侧的 HostValve / WrapperValve / ErrorReportValve 负责重新兜底和收束。**

## 读者理解路径

1. 从“为什么正常主线讲完了还不够”切入。
2. 建立最小总图：`AbstractProcessor / AsyncStateMachine -> AsyncContextImpl -> StandardWrapperValve / StandardHostValve -> ErrorReportValve`。
3. 解释 async 为什么不是 Servlet API 的薄封装，而会深入协议层状态机。
4. 解释 timeout / dispatch / complete / onError 为什么不能拆成几个独立小技巧。
5. 解释 `StandardHostValve.throwable(...)` 和 `ErrorReportValve` 为什么会重新成为执行主线的一部分。
6. 最后回收：Tomcat 的请求主线不仅有正向执行链，还有偏离路径时的重新收束链。

## 失败方案推演

### 失败方案 1：把 async 只理解成 `startAsync()` 之后换线程继续跑

这是最常见误解，因为从 Servlet API 表面看，async 似乎只是：
- 请求暂时不在当前线程里完成
- 后面某个时候再 dispatch 或 complete

问题在于，这种理解完全忽略了：
- Processor 端为什么需要 `AsyncStateMachine`
- 每次 async cycle 为什么要维护状态转换
- 容器线程与非容器线程写回为什么会牵涉不同边界

如果把 async 讲成“线程切换小技巧”，后面 timeout / error / dispatch 的语义都会散掉。

### 失败方案 2：异常出口只是 `try/catch` + 错误页

另一种常见偷懒方式，是把错误处理理解成：
- 某处抛异常
- 某处 catch
- 转发到错误页

这个描述在结果上没错，但对 Tomcat 来说太薄了。它没有回答：
- 异常是在哪一层被重新接住的
- 为什么 `StandardHostValve.throwable(...)` 会重新变得关键
- `ErrorReportValve` 是何时、为什么进入主线的
- async dispatching 下的异常出口和普通请求是否完全一样

### 失败方案 3：timeout / complete / onError 可以分开理解

直觉上看，它们像是三个不同事件：
- timeout
- complete
- onError

但在 Tomcat 运行时里，它们不是三件无关小事，而是同一条请求状态机在偏离正常路径时的不同出口。如果把它们拆开看，读者会知道几个名词，却拼不出“请求偏离后是如何重新被收束”的整体图。

## 必须澄清的误解

1. async 不是 Servlet API 层的小技巧，而是会深入 `Processor` 状态机的运行时机制。
2. timeout / complete / dispatch / onError 不是互不相关的回调名词，而是同一条状态流上的不同出口。
3. `StandardHostValve` 不只参与正常路径，它在错误出口里也承担关键兜底职责。
4. `ErrorReportValve` 不是外围装饰物，而是在某些失败路径下重新接手输出的执行角色。
5. 本篇讲的是“偏离正常路径后如何重新收束”，不是把 Ch2/Ch3 正常主线再讲一遍。

## 文章结构与字数预算

1. 困惑开场：为什么正常主线讲完还不够（800-1000 字）
2. 最小总图：Processor 状态机 -> AsyncContextImpl -> HostValve/ErrorReportValve（1200-1500 字）
3. `AsyncStateMachine`：偏离正常路径的状态核心（1800-2200 字）
4. `AsyncContextImpl`：容器侧 async 协调与重新分派（1600-2200 字）
5. `StandardWrapperValve` / `StandardHostValve.throwable(...)`：异常和 async 分支如何重新接回主线（1800-2400 字）
6. `ErrorReportValve`：失败路径的末端输出（1200-1600 字）
7. 收网总结：Tomcat 不只有正向执行主线，还有偏离后的重新收束链（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `java/org/apache/coyote/AbstractProcessor.java:85`
- `java/org/apache/coyote/AsyncStateMachine.java:129`
- `java/org/apache/catalina/core/AsyncContextImpl.java:442`
- `java/org/apache/catalina/core/StandardWrapperValve.java:152`
- `java/org/apache/catalina/core/StandardWrapperValve.java:164`
- `java/org/apache/catalina/core/StandardHostValve.java:231`
- `java/org/apache/catalina/valves/ErrorReportValve.java:61`
- 若需要更细化，再补 `AsyncStateMachine` 状态迁移关键方法的真实锚点

测试侧至少补：
- `test/org/apache/coyote/http2/TestAsync.java`
- `test/org/apache/coyote/TestIoTimeouts.java`
- `test/org/apache/catalina/valves/`
- 若有与 async dispatch/error page 直接相关的 core/connector 测试，也应纳入

## 版本边界

- 当前源码基准：Tomcat `10.1.34`
- 本篇以当前 Java 主码中的 async/timeout/error 主线为准
- 不把 WebSocket / HTTP2 细节写成通用 async 主叙事
- 不把容器执行正常主线重新完整复述一遍

## 与其他篇的边界

### 本篇要讲清

- 请求为什么会偏离正常主线
- Processor 状态机为什么是 async/timeout/error 的根
- HostValve / ErrorReportValve 为什么会重新进入主线
- 偏离路径最后是如何重新收束的

### 本篇不深讲

- Session 生命周期
- Mapper 路由树算法
- Valve 链正常路径细节
- WebSocket / HTTP2 特定异步模型

这些放到其他专题。

## 写作后检查

- [ ] 开篇不是 API 介绍，而是“为什么正常主线讲完还不够”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对 async 误解
- [ ] 总图明确区分：状态机核心、容器协调层、错误出口兜底层
- [ ] 不把 async 写成线程切换小技巧
- [ ] 不把 `ErrorReportValve` 写成外围附属对象
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
