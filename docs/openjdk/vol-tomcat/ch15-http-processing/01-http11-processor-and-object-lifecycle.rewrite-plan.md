# Tomcat Ch15-01 HTTP 处理纵深 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch15 HTTP Processing
- 篇：01 Http11Processor、Input/OutputBuffer 与 Coyote 请求对象生命史
- 对应主题：Tomcat 完整卷的 **机制补深层**
- 文章类型：协议处理纵深篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch2-01，知道请求是如何从 `Connector / Endpoint / Processor / Adapter` 进入 Catalina 的。
- 读者应已读过 Ch12-01，知道性能问题最终会回到入口链和执行链结构本身。

### SOFT

- async / timeout / error 专题已建立偏离主线，但本篇重点先放在 HTTP/1.1 正常处理主线内部对象如何流动、复用和写回。

### NAV

- Ch15-02：对象复用 / 对象生命周期复用专题

## 一句话困惑

前面我们已经知道请求会经过 `Http11Processor`，但这个“协议处理”到底在内部处理了哪些对象、怎么解析、怎么写回、又是如何复用这些对象的？

## 一句话顿悟

`Http11Processor` 不是一个抽象名字，而是一条具体的对象生命史：**输入缓冲、输出缓冲、Coyote Request/Response、keep-alive 与 recycle 共同组成了 HTTP/1.1 在 Tomcat 里的真实运行态。**

## 读者理解路径

1. 从“请求进入了 Processor，内部到底发生了什么”切入。
2. 建立最小总图：`Socket bytes -> InputBuffer -> Request -> Processor decisions -> OutputBuffer -> Response bytes`。
3. 解释 `Http11Processor` 为什么不仅仅是“解析 HTTP”，而是在管理一组会反复复用的协议对象。
4. 解释输入、输出、请求对象、响应对象各自的角色。
5. 解释 keep-alive / recycle 为什么让这一条线不只是一次性解析，而是一条对象生命史。
6. 最后把它挂回性能篇和对象复用篇。

## 失败方案推演

### 失败方案一：HTTP 处理就是把字节解析成请求，再把结果写回去

这个说法在表面上没错，但它把最关键的运行时问题都压扁了：
- 谁持有输入状态
- 谁持有输出状态
- Request/Response 生命周期怎么走
- keep-alive 下对象怎么继续被复用

### 失败方案二：`Http11Processor` 只是协议语义入口，不用深挖对象层

如果只停在接口级理解，读者会知道“请求经过 Processor”，但不知道：
- 为什么性能问题会回到这一层
- 为什么复用、recycle、buffer 状态会影响后续请求

### 失败方案三：对象复用可以以后讲，先不和 HTTP 主线放一起

问题在于，对 Tomcat 来说，HTTP 处理本身就和对象生命史、keep-alive、recycle 强耦合。如果把复用完全拆开，这条主线会被讲扁。

## 必须澄清的误解

1. `Http11Processor` 不只是“协议解析器”，还是协议对象生命史的组织者。
2. Input/OutputBuffer 不是附属实现，而是请求收发状态的核心承载体。
3. keep-alive 不是连接优化小开关，而会直接改变对象生命史与复用节奏。
4. 本篇讲的是 HTTP/1.1 处理纵深，不是重讲整条请求主线。

## 文章结构与字数预算

1. 困惑开场：请求进了 Processor 之后到底发生什么（800-1000 字）
2. 最小总图：输入、处理、输出、复用（1200-1500 字）
3. `Http11Processor` 的位置与角色（1600-2200 字）
4. `InputBuffer / Request`：请求是如何被接住和推进的（1800-2400 字）
5. `OutputBuffer / Response`：响应是如何被写回的（1600-2200 字）
6. keep-alive / recycle：为什么这是一条对象生命史（1600-2200 字）
7. 收网总结：HTTP 处理为什么会回到对象和状态本身（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `org/apache/coyote/http11/Http11Processor.java`
- `org/apache/coyote/InputBuffer.java`
- `org/apache/coyote/OutputBuffer.java`
- `org/apache/coyote/Request.java`
- `org/apache/coyote/Response.java`
- 如涉及复用，再补 recycle / keep-alive 相关关键方法锚点

## 版本边界

- 当前分析对象：Tomcat `10.1.34`
- 本篇只讲 HTTP/1.1 主线
- 不把 AJP、HTTP/2 混入主叙事

## 与其他篇的边界

### 本篇要讲清

- Processor 内部到底在组织哪些对象
- HTTP 处理为什么和对象生命史、复用、性能高度相关

### 本篇不深讲

- AJP/HTTP2
- 完整生产排障案例
- JVM/网络通识

## 写作后检查

- [ ] 开篇不是类名介绍，而是“Processor 里到底发生什么”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Processor 只是解析器”的误解
- [ ] 总图明确区分：输入、处理、输出、复用
- [ ] 不把本篇写成协议字段手册
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
