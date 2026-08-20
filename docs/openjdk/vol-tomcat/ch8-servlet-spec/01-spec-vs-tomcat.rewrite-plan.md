# Tomcat Ch8-01 Servlet 规范与 Tomcat 实现边界 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch8 Servlet Spec
- 篇：01 哪些是 Servlet 规范要求，哪些是 Tomcat 的实现取舍
- 对应主题：Tomcat 完整卷的 **规范层**
- 文章类型：规范—实现边界篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Tomcat 主干与集成层，至少知道：
  - Tomcat 本体如何启动、接请求、执行、处理异常、管理 Session、做路由
  - Spring Boot 如何把嵌入式 Tomcat 装起来
- 读者应知道 Servlet 容器的外部行为并不是 Tomcat 自说自话，而是受 Servlet 规范约束。

### SOFT

- 若后续要拆 Servlet 生命周期补篇，本篇只讲“规范边界”，不承担完整 `StandardWrapper` 深挖。
- Spring Boot 集成篇已说明上层装配桥；本篇不再重复集成流程，只在需要时引用“规范要求如何落到嵌入式模式”。

### NAV

- Ch8-02：Servlet 生命周期深挖（若需要拆补篇）
- Ch8-03：Filter / DispatcherType / Async 契约补篇（若需要拆补篇）

## 一句话困惑

Tomcat 里很多行为看起来都很“自然”：Filter 先于 Servlet、Session 能跨请求、async 能重新 dispatch、Listener 能感知启动关闭……但这些到底是 Servlet 规范硬性要求，还是 Tomcat 自己的实现取舍？

## 一句话顿悟

看懂 Tomcat 不能只看实现链路，还必须同时分清：**哪些行为是 Servlet 规范规定的契约，哪些行为是 Tomcat 为了兑现这些契约而做出的具体实现选择。**

## 读者理解路径

1. 从“为什么要区分规范要求和 Tomcat 实现取舍”切入。
2. 建立最小总图：`Servlet Spec -> Tomcat container behavior -> Spring Boot embedded usage`。
3. 先挑几个最容易混淆的主题：生命周期、Filter/DispatcherType、Session、SCI/Initializer、async。
4. 对每个主题都问两个问题：
   - 规范要求了什么？
   - Tomcat 具体怎么实现？
5. 最后收束：为什么规范层不是附录，而是帮助读者避免把 Tomcat 的当前实现误当成“唯一正确方式”的关键视角。

## 失败方案推演

### 失败方案 1：把 Tomcat 的当前实现直接当成 Servlet 规范本身

这是最常见的误解。因为我们前面几篇都在看 Tomcat 源码，很容易潜移默化地把：
- Tomcat 当前的生命周期组织方式
- Tomcat 的 Filter 链实现方式
- Tomcat 的 Session 管理方式

直接当成“Servlet 容器就是这么规定的”。

问题在于，Tomcat 只是一个实现。它必须兑现规范，但它兑现的具体路径，未必是唯一方式。

### 失败方案 2：只讲规范，不回到实现

另一个极端是把这一篇写成 Servlet 规范摘要：
- 生命周期是什么
- Filter 契约是什么
- Session 契约是什么

这样虽然能让读者知道规范文本，但依然解释不了一个更实际的问题：

- Tomcat 到底是怎么把这些契约压成我们前面看到的启动链、执行链、Session 主线、async/error 主线的？

所以本篇不能只做“规范摘抄”，而必须是“规范要求 vs Tomcat 落地”的对照篇。

### 失败方案 3：把规范层当成附录，放到卷末随便提一下

如果没有这一层，读者读完整个 Tomcat 卷后，很容易留下错误印象：
- Filter 现在这样跑，是因为 Servlet 容器都只能这么跑
- Session 现在这样管理，是因为规范就要求实现一定长这样
- async/error 主线里的某些细节，好像也是 Servlet API 自带的内部组织方式

而规范层的存在，恰恰是为了打掉这种误解：
- 规范规定“要实现什么行为”
- Tomcat 回答“我具体怎么实现这个行为”

## 必须澄清的误解

1. Tomcat 不是规范本身，而是规范的一个实现。
2. 当前源码里的实现路径，不等于 Servlet 规范唯一允许的路径。
3. 规范层不是附录，而是用来给整个 Tomcat 卷建立“契约 vs 实现”视角的关键一篇。
4. 本篇不重讲全部主干，而是专门校准前面几篇的理解边界。

## 文章结构与字数预算

1. 困惑开场：为什么必须分清“规范要求”和“Tomcat 实现”（800-1000 字）
2. 最小总图：规范 -> 实现 -> 嵌入式使用（1000-1400 字）
3. 生命周期：规范定义了什么，Tomcat 怎么落（1500-2200 字）
4. Filter / DispatcherType / async：契约与实现边界（1800-2600 字）
5. Session：规范给边界，Tomcat 给生命史（1400-2000 字）
6. SCI / Initializer / 嵌入式注册：规范与 Boot 集成如何接上（1500-2200 字）
7. 收网总结：为什么读 Tomcat 卷必须有这一层“契约视角”（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `jakarta.servlet` / `jakarta.servlet.http` 下与生命周期、Filter、Session、Async、SCI 相关接口与注释
- Tomcat 侧对应实现类：
  - `StandardWrapper`
  - `ApplicationFilterChain`
  - `ApplicationFilterFactory`
  - `AsyncContextImpl`
  - `StandardSession`
  - `TomcatStarter` / `ServletContextInitializer` 相关桥接

> 注意：本篇不能只引接口名，必须对“规范文本里的约束”与“Tomcat 当前实现路径”做成对照证据。

## 版本边界

- 当前分析对象：Tomcat `10.1.34`
- 规范侧基于当前源码内置的 `jakarta.servlet` 接口/注释
- 本篇不混入旧版 javax.servlet 时代差异，除非确有必要单独标注版本断层

## 与其他篇的边界

### 本篇要讲清

- 哪些行为是 Servlet 规范要求
- 哪些行为是 Tomcat 的当前实现取舍
- 为什么这一层视角能反向校准前面几篇主干文章

### 本篇不深讲

- Tomcat 各主干链的完整运行细节
- 生产参数调优
- 安全与运维治理

这些留给主干篇或生产层专题。

## 写作后检查

- [ ] 开篇不是规范名词扫盲，而是“为什么必须区分契约与实现”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“把 Tomcat 实现误当规范本身”的误解
- [ ] 每个小节都同时回答“规范要求”与“Tomcat 落地”两个问题
- [ ] 不把本篇写成规范摘抄
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
