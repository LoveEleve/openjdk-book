# Druid Ch3-01 Filter 拦截链体系 — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch3 Filter
- 篇：01 为什么 Druid 要让所有 JDBC 操作都穿过 Filter 链
- 对应主题：`D-2 Filter 拦截链体系`
- 文章类型：扩展点主线篇
- 正文状态：未开始

## 前置依赖
- HARD：读者应已读过 D-1，知道 pool 本体结构和 `DruidPooledConnection`、`DruidConnectionHolder`
- SOFT：后续 StatFilter / WallFilter 会用到 Filter 链，但本篇先立住链本身

## 一句话困惑
为什么 HikariCP 只靠代理类 + 直接代理就能完成所有 JDBC 拦截，而 Druid 却要额外建一条 `FilterChainImpl` 递归链，还要在 `DruidConnectionHolder` 里专门缓存它？

## 一句话顿悟
Druid 没有“代理类 + 内联逻辑”模式，它把每个 JDBC 操作拆成一条递归链：`pos` 指针推进驱动，`filterSize` 控制链尾，`nextFilter()` 每次取出下一个 Filter 执行——这样第三方可以像插拔一样嵌入自己的 Filter。

## 读者理解路径
1. 从“HikariCP 无 Filter 链，Druid 有”这个差异切入
2. 最小总图：`DruidPooledConnection.close() -> holder.createChain() -> FilterChainImpl -> pos/filterSize/nextFilter()`
3. 解释 `FilterChainImpl` 的递归链模型
4. 解释 `createChain()` / `recycleFilterChain()` 为什么是池复用的一部分
5. 解释 `DruidPooledConnection.close()` 在有/无 Filter 时的两条路径
6. 收束：Filter 链是 Druid 的扩展点骨架，StatFilter/WallFilter 只是插上去的实现

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：连接 -> FilterChain -> 递归（1200-1500 字）
3. `FilterChainImpl` 递归链模型（2200-3000 字）
4. `createChain()` / `recycleFilterChain()` 对象复用（1800-2400 字）
5. `DruidPooledConnection.close()` 路径（1600-2200 字）
6. Filter 链与 Druid 监控/安全的关系（1200-1800 字）
7. 收网总结（800-1000 字）

## 证据清单
写时须重新 grep：
- `FilterChainImpl.java:36` 类声明
- `FilterChainImpl.java:37` `pos` 字段
- `FilterChainImpl.java:41` `filterSize` 字段
- `FilterChainImpl.java:469` `nextFilter()` 方法
- `DruidConnectionHolder.java:46` 类声明
- `DruidConnectionHolder.java:223` `createChain()`
- `DruidConnectionHolder.java:234` `recycleFilterChain()`
- `DruidPooledConnection.java:236` `close()`
- `DruidPooledConnection.java:274` 有 Filter 路径
- `DruidPooledConnection.java:316` 无 Filter 路径

## 写作后检查
- [ ] 开篇不是类名清单，而是“为什么有 Filter 链”的困惑
- [ ] 至少 2 个失败方案，且有一个关于“Filter 链只是装饰器”的误解
- [ ] 总图明确区分：链模型、对象池复用、连接 close 路径
- [ ] 不把本篇写成 Filter 接口手册
- [ ] 所有 file:line 写作时重新 grep 验证