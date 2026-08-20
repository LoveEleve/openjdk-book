# Tomcat Ch2-01 请求进入闭环 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch2 Request Entry
- 篇：01 从 Socket 到 Catalina
- 对应主题：`T-2 请求进入与协议处理闭环`
- 文章类型：主运行时链路篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch1-01，知道 Tomcat 启动不是单纯的容器树组装，而是把 `Connector / CoyoteAdapter / MapperListener / 容器树` 接成运行时系统。
- 读者应知道 Coyote 与 Catalina 是两个层次：前者更靠近协议与连接，后者更靠近容器执行与 Servlet 调度。

### SOFT

- T-3 容器执行闭环：本篇只把 `Mapper -> Pipeline -> FilterChain -> Servlet` 当作下游去处，不展开其内部细节。
- T-4 异步、超时与错误处理闭环：本篇会碰到 `Processor` 和请求生命周期状态，但不深讲 async/error 状态机。

### NAV

- Ch2-02：Mapper + Valve + FilterChain + Servlet 如何把请求真正执行下去（T-3）
- Ch3：Async / timeout / error 为什么深入到 Processor 与 HostValve（T-4）

## 一句话困惑

一个 HTTP 请求从网卡进入 Tomcat 之后，究竟是在什么地方被接住、被解析、被包装，又是在什么地方从 Coyote 世界切进 Catalina 世界？

## 一句话顿悟

Tomcat 的请求进入链不是“直接调 Servlet”，而是一条明确分层的运行时流水线：**Endpoint 接连接，Processor 解协议，Adapter 负责跨层切换，Catalina 再接手后续容器执行。**

## 读者理解路径

1. 从“为什么不能把请求进入理解成一个函数调用”开始。
2. 先建立 `Socket -> Endpoint -> Processor -> Adapter -> Catalina` 的最小总图。
3. 解释 `Connector` 为什么只是外层门面，而不是实际干活的全部。
4. 解释 `NioEndpoint`、`Http11Processor`、`CoyoteAdapter` 三类角色的职责分工。
5. 说明“协议已经解析完成”和“容器执行真正开始”之间的边界在哪里。
6. 最后把请求主线桥接到下一篇的 `Mapper + Pipeline + FilterChain + Servlet`。

## 失败方案推演

### 失败方案 1：把请求进入理解成“Connector 直接调 Servlet”

这个直觉最常见，因为从外层看：
- 配了一个 `Connector`
- 请求进来
- 最后到了 Servlet

但这个视角跳过了三层关键工作：
- 连接接收与事件分发
- HTTP 协议解析与请求对象构建
- Coyote 请求到 Catalina 请求的跨层切换

如果把这几层都压扁成“Connector 处理请求”，读者后面一定会在超时、keep-alive、请求复用、async、error 边界上不断迷路。

### 失败方案 2：把线程模型和协议处理揉成一个黑箱

另一个常见偷懒方法是：
- `NioEndpoint` 负责 NIO
- `Http11Processor` 负责 HTTP
- 细节先不管

问题在于，如果不把“谁接收连接”“谁拿到可读事件”“谁推进协议解析”分开，后面就会把：
- IO 事件
- 请求生命周期
- Processor 复用
- 超时/错误出口

全部混成一个“线程模型大章”。

本篇必须先把运行时主线拆开，避免后面整卷结构塌成一个黑箱。

### 失败方案 3：把 `CoyoteAdapter` 只当成普通适配器类

如果只从名字理解，`Adapter` 很容易被看成“面向对象模式里的小工具类”。

但在 Tomcat 请求主线里，它不是可有可无的胶水，而是：
- 协议层请求进入 Catalina 的边界点
- 请求对象从 Coyote 世界切向 Catalina 世界的桥
- 后续 `Mapper -> Pipeline -> FilterChain -> Servlet` 主线的真正入口

如果低估它，整条请求主线就会断在“HTTP 已经解析完了，然后呢？”这个位置上。

## 必须澄清的误解

1. `Connector` 不是实际运行时主线的全部，它只是外层门面和配置载体。
2. `NioEndpoint` 不等于整个请求处理链，它只负责更靠前的连接/事件侧。
3. `Http11Processor` 不等于 Servlet 执行器，它负责的是协议处理与请求推进。
4. `CoyoteAdapter` 不是普通模式层面的“适配器示例”，而是请求跨层切换边界。
5. 本篇讲的是“请求如何进入 Catalina”，不是“请求在 Catalina 内部如何完整执行”。

## 文章结构与字数预算

1. 困惑开场：为什么“请求进来”不是一句空话（800-1000 字）
2. 最小总图：Socket -> Endpoint -> Processor -> Adapter -> Catalina（1200-1500 字）
3. `Connector` 只是门面，不能代替整条主线（1000-1400 字）
4. `NioEndpoint`：连接接收与事件入口（1400-1800 字）
5. `Http11Processor`：协议解析与请求推进（1800-2200 字）
6. `CoyoteAdapter`：跨层切换边界（1800-2200 字）
7. 收网总结与对 `Mapper + Pipeline + FilterChain + Servlet` 的桥接（800-1000 字）

目标叙述性正文：9000-12000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `java/org/apache/catalina/connector/Connector.java:999`
- `java/org/apache/catalina/connector/Connector.java:1000`
- `java/org/apache/tomcat/util/net/NioEndpoint.java:71`
- `java/org/apache/coyote/http11/Http11Processor.java:70`
- `java/org/apache/catalina/connector/CoyoteAdapter.java:64`
- `java/org/apache/catalina/core/StandardWrapperValve.java:141`
- `java/org/apache/catalina/core/ApplicationFilterFactory.java:57`
- 如正文进入更深实现，再补 `ProtocolHandler`、`AbstractProtocol`、`AbstractProcessor`、`Request/Response` 的真实锚点
- 测试侧至少补：
  - `test/org/apache/coyote/TestIoTimeouts.java`
  - `test/org/apache/coyote/http11/`
  - 若涉及 async 预告，可引用 `test/org/apache/coyote/http2/TestAsync.java` 但不展开

## 版本边界

- 当前源码基准：Tomcat `10.1.34`
- 本篇以当前 Java 主码中的 NIO + HTTP/1.1 主线为准
- 不把 AJP/HTTP2 写进本篇主叙事
- 不把后续 async/error 细节提前透支到本篇

## 与其他篇的边界

### 本篇要讲清

- 请求进入链为什么必须分层理解
- `Connector / Endpoint / Processor / Adapter` 各自回答什么问题
- Coyote 到 Catalina 的边界在哪里
- 为什么 `CoyoteAdapter` 是请求主线里不可跳过的桥

### 本篇不深讲

- `Mapper` 四级匹配细节
- `Pipeline-Valve` 逐层传播
- `FilterChain` 内部实现
- `Servlet.service()` 之后的应用执行
- async / timeout / error 的完整状态机

这些留给后续专题。

## 写作后检查

- [ ] 开篇不是类名介绍，而是“请求进入为什么不能压扁成一句话”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对 `CoyoteAdapter` 误解
- [ ] 总图明确区分：连接入口、协议处理、跨层切换、容器执行
- [ ] 不把 `Connector` 直接写成“请求处理器”
- [ ] 不把 `NioEndpoint`、`Processor`、`Adapter` 混成黑箱
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口，而不是只做表面 review
