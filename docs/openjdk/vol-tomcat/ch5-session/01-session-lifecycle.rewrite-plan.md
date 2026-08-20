# Tomcat Ch5-01 Session 生命周期闭环 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch5 Session
- 篇：01 Session 不只是一个对象，而是请求生命周期里的状态载体
- 对应主题：`T-5 Session 生命周期闭环`
- 文章类型：生命周期主线篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch3-01，知道请求在 Catalina 内部会经过 `Mapper -> Valve -> FilterChain -> Servlet` 的执行闭环。
- 读者应已读过 Ch4-01，知道请求不只有正向执行链，还有偏离正常路径后的重新收束链。

### SOFT

- T-6 Mapper 动态更新专题：本篇不讨论路由树本体，只在需要时把 Session 与目标 Context 的关系说清。
- 集群复制 / 持久化专题：本篇重点先立住“单机 Session 生命周期”主线，持久化和集群复制只做边界提示。

### NAV

- Ch5-02：Session 持久化与 Store
- Ch5-03：Session 集群复制与 `tribes/ha`

## 一句话困惑

为什么很多人把 Session 理解成“挂在请求上的一个 Map”，但到了 Tomcat 源码里，它却要牵扯 `Manager`、过期扫描、持久化、复制、请求生命周期和异常路径？

## 一句话顿悟

Tomcat 里的 Session 不是一个孤立对象，而是一条由 **`Manager` 管理、由请求访问驱动、由过期与回收机制维护、必要时还能被持久化或复制** 的生命周期链。

## 读者理解路径

1. 从“为什么 Session 不是普通对象”这个困惑切入。
2. 建立最小总图：`Request -> Session -> Manager -> Expire/Persist/Replicate`。
3. 解释 `StandardSession` 为什么只是生命周期中的“实体”，不是全部系统。
4. 解释 `ManagerBase / StandardManager` 为什么是生命周期真正的控制者。
5. 解释过期扫描、失效、持久化、集群复制为什么都属于同一条 Session 主线，而不是零散扩展功能。
6. 最后收束：Session 要理解成“贯穿请求的状态载体”，而不是“某次请求里的临时附属对象”。

## 失败方案推演

### 失败方案 1：Session 就是一个挂属性的对象

这是最普遍的应用侧直觉，因为在业务代码里，Session 常常只表现为：
- `getAttribute()`
- `setAttribute()`
- `invalidate()`

于是很容易误以为：
- Session 就是请求上下文旁边的一个大 Map
- 业务读写它就够了

问题在于，这种视角完全解释不了：
- Session 是谁创建和持有的
- 为什么会过期
- 谁定期扫描它们
- 失效后谁负责清理
- 为什么还会出现持久化和集群复制

也就是说，业务看到的是 Session 的“表面接口”，Tomcat 维护的是 Session 的“完整生命周期”。

### 失败方案 2：只讲 `StandardSession` 就算讲完 Session 机制

另一个常见偷懒方式，是把 Session 主题缩成一个实体类讲解：
- `StandardSession` 有哪些字段
- `getId()/setAttribute()/invalidate()` 做了什么

这当然有帮助，但依旧不够，因为真正决定 Session 一生的，不只是它自己，而是：
- 哪个 `Manager` 管它
- 什么时候被标记失效
- 什么时候被过期扫描回收
- 什么时候被持久化/复制

所以只讲 `StandardSession`，会让读者知道“这个对象长什么样”，却不知道“这个对象为什么活着、什么时候会死、死了之后谁处理”。

### 失败方案 3：过期、持久化、复制只是几个并列扩展功能

从文件结构上看，确实很容易把这些看成并列项：
- 过期扫描
- `FileStore` / `JDBCStore`
- `DeltaManager` / `BackupManager`

但对 Session 来说，它们本质上都在回答同一件事：

**当请求结束之后，这个状态对象如何继续被管理、保留、回收或跨节点传播。**

如果把它们拆成几个互不相关的“高级功能”，读者会看见很多组件，却看不见一条统一的生命周期链。

## 必须澄清的误解

1. Session 不是请求对象的附属字段，而是有独立生命周期的状态对象。
2. `StandardSession` 不是 Session 机制的全部，它只是被管理的实体。
3. `Manager` 不是简单工厂，而是生命周期控制者。
4. 过期、持久化、复制不是零散补充，而是生命周期链在请求结束之后的延伸。
5. 本篇先立单机生命周期主线，不把集群复制提前写成和单机同等重的第一主线。

## 文章结构与字数预算

1. 困惑开场：为什么 Session 不是普通对象（800-1000 字）
2. 最小总图：Request -> Session -> Manager -> Expire/Persist/Replicate（1200-1500 字）
3. `StandardSession`：状态实体本身（1400-1800 字）
4. `ManagerBase / StandardManager`：生命周期控制者（1800-2400 字）
5. 过期与回收：Session 为什么会“死”（1400-1800 字）
6. 持久化/复制：生命周期在请求之外的延伸（1600-2200 字）
7. 收网总结：Session 是贯穿请求生命周期的状态载体（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `java/org/apache/catalina/session/StandardSession.java:80`
- `java/org/apache/catalina/session/StandardManager.java:57`
- `java/org/apache/catalina/session/ManagerBase.java`
- `java/org/apache/catalina/session/FileStore.java`
- `java/org/apache/catalina/session/JDBCStore.java`
- `java/org/apache/catalina/ha/session/DeltaManager.java`
- `java/org/apache/catalina/ha/session/BackupManager.java`
- 如正文需要把请求访问 Session 的入口讲清，再补 `Request` 或 `ApplicationHttpRequest` 侧真实锚点

测试侧至少补：
- `test/org/apache/catalina/session/`
- 如涉及集群复制，再补 `test/org/apache/catalina/ha/`

## 版本边界

- 当前源码基准：Tomcat `10.1.34`
- 本篇主线优先立单机 Session 生命周期
- 持久化和集群复制先作为生命周期延伸，不在本篇里展开所有实现细节
- 不把 Spring Session 替代方案写成 Tomcat 内部实现的一部分

## 与其他篇的边界

### 本篇要讲清

- Session 为什么不是普通对象
- `StandardSession` 与 `Manager` 的角色分工
- 过期、失效、持久化、复制为什么属于同一条生命周期主线

### 本篇不深讲

- 集群复制协议细节
- 持久化具体介质优化
- Spring Session 的外部替代实现

这些放到其他专题。

## 写作后检查

- [ ] 开篇不是 API 介绍，而是“为什么 Session 不是普通对象”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“只讲 StandardSession 就够了”的误解
- [ ] 总图明确区分：状态实体、生命周期控制者、请求外延伸机制
- [ ] 不把 `Manager` 写成简单工厂
- [ ] 不把持久化/复制写成毫无主次的并列堆砌
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
