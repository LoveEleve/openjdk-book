# Tomcat Ch16-01 对象复用 / 对象生命周期复用 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch16 Object Reuse
- 篇：01 Tomcat 为什么不是显式讲对象池，却处处在做对象生命史复用
- 对应主题：Tomcat 完整卷的 **机制补深层**
- 文章类型：对象复用纵深篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch15-01，知道 HTTP/1.1 处理不是一句“Processor 解析协议”，而是一条由 `InputBuffer / Request / Response / OutputBuffer / keep-alive / recycle` 组成的对象生命史。
- 读者应已读过 Ch9-01，知道 `StandardWrapper` 把 Servlet 生命周期压成了完整实例管理链。
- 读者应已读过 Ch11-01，知道类空间退场失败的核心问题是残留引用链没有断干净。

### SOFT

- 性能篇已经说明“参数只是旋钮，结构才是根因”，本篇会回头把对象复用放进这个性能视角里，但不重复性能篇结构。
- 生产排障篇会继续使用本篇结论，但本篇先立机制，不讲排障命令。

### NAV

- Ch16-02：线程池 / Executor 专题
- Ch16-03：若需要，可拆“Coyote Request/Response recycle 补篇”

## 一句话困惑

Tomcat 并不像某些中间件那样高调谈“对象池”，但前面一路看下来，`Request/Response`、输入输出缓冲、Servlet 实例、类加载后半段清理都在围绕“不要重复创建、要安全复用、要能正确退场”打转——这到底是不是一条独立主线？

## 一句话顿悟

Tomcat 里的对象复用，不一定都以显式池化 API 出现，但它到处都在处理同一个问题：**对象如何被重复使用、状态如何被清干净、生命周期如何重新开始，而不把上一轮请求或上一代应用的历史包袱带进来。**

## 读者理解路径

1. 从“为什么 Tomcat 没有高调谈对象池，但又处处在 recycle/复用”切入。
2. 建立最小总图：`创建 -> 使用 -> 重置/recycle -> 再次使用`。
3. 解释对象复用不只出现在协议层，也出现在 Servlet 实例管理与类空间退场里。
4. 解释为什么 Tomcat 关心的不是“有没有池”，而是“复用后的状态是否干净、退场时引用是否断开”。
5. 最后收束：Tomcat 的对象复用主线，本质上是“对象生命史管理”，不是单纯性能技巧。

## 失败方案推演

### 失败方案一：Tomcat 没有明显对象池，所以没有独立的对象复用主线

这是最容易产生的直觉。因为 Tomcat 不像 Netty 那样一上来就摆出一整套高辨识度对象池体系。

但如果就因为“没有高调池化 API”而判定“没有对象复用主线”，会立刻看漏前面整卷里已经反复出现的事实：
- `Request.recycle()`
- `Response.recycle()`
- `InputBuffer.nextRequest()`
- `OutputBuffer.nextRequest()`
- `StandardWrapper.allocate()/deallocate()/unload()`
- `WebappClassLoaderBase.clearReferences()`

所以 Tomcat 不是没有对象复用，而是把它埋在一条条运行时生命史里了。

### 失败方案二：对象复用就是性能优化小技巧

另一个常见误解是把复用只看成性能层面的事：
- 少 new 几个对象
- 少 GC 一点
- 仅此而已

问题在于，对容器来说，复用从来不是“省一次分配”这么简单，它还要回答：
- 状态有没有清干净
- 下一轮请求会不会看到上一轮残留
- 卸载时旧对象会不会拖住整套类空间

所以对象复用同时也是正确性和生命周期管理问题。

### 失败方案三：recycle 和卸载是两条互不相干的线

从名字看，`recycle()` 很像协议层或请求层的小操作，`clearReferences()` / unload 又像退场问题。

但实际上它们在回答同一件事：
- 对象如何在“继续使用”和“彻底退出”之间被正确管理

如果把这两条线完全切开，读者会知道有复用，也知道有清理，却看不见它们其实都属于“对象生命史管理”。

## 必须澄清的误解

1. Tomcat 没有高调对象池，不等于没有对象复用主线。
2. recycle 不是单纯性能技巧，它首先是状态重置与下一轮正确性的保障。
3. Servlet 实例管理也是对象生命史的一部分，不只是协议层对象才有复用问题。
4. 退场清理与运行时复用属于同一条对象生命史的前后两半。
5. 本篇讲的是“对象生命史管理”，不是单一池化 API 盘点。

## 文章结构与字数预算

1. 困惑开场：为什么 Tomcat 没讲对象池，却处处在做复用（800-1000 字）
2. 最小总图：创建 -> 使用 -> recycle -> 再用 / 退场（1200-1500 字）
3. 协议层对象复用：Request/Response/InputBuffer/OutputBuffer（1800-2400 字）
4. Servlet 实例生命史也是一种复用管理（1600-2200 字）
5. 类空间退场链为什么是对象复用主线的后半段（1600-2200 字）
6. 为什么 Tomcat 关心的是“复用后是否干净”而不只是“池没池化”（1200-1800 字）
7. 收网总结：Tomcat 的对象复用，本质上是对象生命史管理（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `org/apache/coyote/Request.java` (`recycle()`)
- `org/apache/coyote/Response.java` (`recycle()`)
- `org/apache/coyote/http11/Http11InputBuffer.java` (`nextRequest()` / `recycle()`)
- `org/apache/coyote/http11/Http11OutputBuffer.java` (`nextRequest()` / `recycle()`)
- `org/apache/catalina/core/StandardWrapper.java` (`allocate()` / `deallocate()` / `unload()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java` (`stop()` / `clearReferences()`)

## 版本边界

- 当前分析对象：Tomcat `10.1.34`
- 本篇聚焦当前嵌入式主线相关对象复用
- 不混入 AJP / JSP / 过时模块

## 与其他篇的边界

### 本篇要讲清

- Tomcat 的对象复用主线为什么真实存在
- recycle、实例管理、退场清理为什么属于同一条生命史
- 为什么复用问题不只是性能，而是正确性与退场问题

### 本篇不深讲

- 通用对象池设计模式
- JVM GC 基础教程
- 具体线上排障命令

这些放到其他专题。

## 写作后检查

- [ ] 开篇不是池化术语介绍，而是“为什么没有高调对象池却处处在复用”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“复用只是性能技巧”的误解
- [ ] 总图明确区分：继续复用 vs 正确退场
- [ ] 不把本篇写成 API 列表
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
