# Tomcat Ch6-01 Mapper 路由与动态更新 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch6 Mapper
- 篇：01 Mapper 不是工具类，而是请求选路与动态更新的核心结构
- 对应主题：`T-6 Mapper 路由与动态更新专题`
- 文章类型：专题主线篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch2-01，知道请求从 `CoyoteAdapter` 进入 Catalina 之后，还没有自动知道目标 Host/Context/Wrapper。
- 读者应已读过 Ch3-01，知道 `Mapper -> Valve -> FilterChain -> Servlet` 是 Catalina 执行闭环的主线起点。

### SOFT

- Ch1-01 启动与装配闭环：本篇会回提 `StandardService` 持有 `Mapper` 与 `MapperListener`，但不重讲启动装配主线。
- Session/async 专题：本篇不承担生命周期与异常控制流，只讲请求目标如何被选出来、路由树如何更新。

### NAV

- 若后续要拆补篇，可继续细化：
  - Ch6-02：四级匹配规则（exact / prefix / extension / default）
  - Ch6-03：MapperListener 与容器变更事件

## 一句话困惑

请求进入 Catalina 之后，为什么不是简单 `Context.findChild()` 找一下 Servlet，而要搞出一个单独的 `Mapper` / `MapperListener` 体系？

## 一句话顿悟

Tomcat 的 `Mapper` 不是普通工具类，而是一棵运行时路由树：**它负责把 Host / Context / Wrapper 的多层结构压成高频请求可用的匹配入口，而 `MapperListener` 负责在容器结构变化时持续把这棵树更新到最新状态。**

## 读者理解路径

1. 从“为什么不能直接在容器树里现找目标”切入。
2. 建立最小总图：`MapperListener` 监听容器变化 -> 更新 `Mapper` 路由树 -> 请求到达时 `Mapper.map(...)` 选目标。
3. 解释 `Mapper` 为什么不是附属工具，而是高频请求主线的入口结构。
4. 解释四级匹配规则为什么存在，而不是只靠一种 URL 匹配模式。
5. 解释 `MapperListener` 为什么必须和容器生命周期联动，才能保证路由树不是静态快照。
6. 最后收束：`Mapper` 的意义不在于“能不能找目标”，而在于“能不能在运行态高频、正确、持续地找目标”。

## 失败方案推演

### 失败方案 1：每次请求都直接沿容器树查找目标

这是最自然的直觉：
- 反正已经有 `Engine -> Host -> Context -> Wrapper` 这棵容器树
- 请求来了以后，从树上现找不就行了？

问题在于，这种理解会低估两个核心代价：
- 请求是高频路径，不能每次都把容器结构当成临时遍历对象
- 路由匹配不只是“找孩子节点”，还要处理多种 URL 规则和优先级

所以，`Mapper` 的出现不是为了多造一个类，而是为了把“容器结构”压成“请求主线里的高频匹配结构”。

### 失败方案 2：Mapper 只是 URL 匹配工具，和运行时更新关系不大

如果只看 `map()`，很容易把 `Mapper` 理解成一个静态工具：
- 给 host 和 uri
- 返回结果

这个理解的问题在于，它忽略了 Tomcat 是运行中的系统：
- Context 会启动/停止
- Wrapper 映射会变化
- 容器树本身不是永远不动的静态配置

如果没有 `MapperListener` 之类的运行态同步机制，`Mapper` 就只能是一张过期快照，而不是真正可依赖的路由结构。

### 失败方案 3：四级匹配只是一些实现细节，没必要单独讲

很多人第一次看到 exact / prefix / extension / default 这几类匹配，会觉得这只是规则枚举，没什么可讲。

问题在于，请求最终会落到哪个 Wrapper，恰恰就取决于这套匹配规则的层级优先顺序。

如果把这块压掉，读者就很难真正理解：
- 为什么某个 URL 最终打到这个 Servlet
- 为什么不是另一个看起来也能匹配的 Servlet
- 为什么 Tomcat 必须维护一套专门的路由结构，而不是简单靠容器孩子查找

## 必须澄清的误解

1. `Mapper` 不是普通工具类，而是高频请求路径上的核心路由结构。
2. `MapperListener` 不是旁路监听器，而是让路由树保持最新状态的运行态同步者。
3. `Mapper` 不是“比容器树多余的一层”，它是把容器树压缩成高频匹配结构的关键桥。
4. 四级匹配不是实现细节堆砌，而是目标选择正确性的来源。
5. 本篇讲的是“选目标与更新目标结构”，不是重新讲一遍整个容器执行链。

## 文章结构与字数预算

1. 困惑开场：为什么不能直接在容器树上找目标（800-1000 字）
2. 最小总图：容器变更 -> MapperListener -> Mapper -> map(host, uri)（1200-1500 字）
3. `Mapper`：为什么它是请求主线入口结构（1600-2200 字）
4. 四级匹配：exact / prefix / extension / default 为什么要分层（1800-2400 字）
5. `MapperListener`：为什么路由树必须跟运行态容器变化同步（1600-2200 字）
6. 收网总结：高频请求的目标选择为什么不能靠“现找”（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `java/org/apache/catalina/mapper/Mapper.java:47`
- `java/org/apache/catalina/mapper/MapperListener.java:47`
- `java/org/apache/catalina/core/StandardService.java:97`
- `java/org/apache/catalina/core/StandardService.java:103`
- `java/org/apache/catalina/core/StandardService.java:151`
- 如正文进入匹配细节，再补 `Mapper.map(...)`、相关内部数据结构与匹配流程的精确锚点

测试侧至少补：
- `test/org/apache/catalina/mapper/`
- 如有容器启动/停止后映射变化的测试，也应纳入

## 版本边界

- 当前源码基准：Tomcat `10.1.34`
- 本篇以当前 Java 主码中的 `Mapper` / `MapperListener` 路由体系为准
- 不把 Spring MVC 自己的 HandlerMapping 混入 Tomcat 路由主线
- 不把后续容器执行/Session/async 的细节重新压回本篇

## 与其他篇的边界

### 本篇要讲清

- 为什么 `Mapper` 存在
- 为什么 `MapperListener` 也必须存在
- 为什么请求目标选择不能靠运行时“现找容器孩子”
- 为什么四级匹配是路由结构的一部分，而不是零散规则

### 本篇不深讲

- Valve 链与 FilterChain 执行细节
- Session 生命周期
- async / timeout / error 控制流

这些已经在前文或后续专题中承担。

## 写作后检查

- [ ] 开篇不是类名介绍，而是“为什么不能直接在容器树上找目标”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Mapper 只是工具类”的误解
- [ ] 总图明确区分：容器结构、路由树、运行态更新、请求匹配入口
- [ ] 不把 `MapperListener` 写成旁路细节
- [ ] 不把四级匹配写成纯规则清单
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
