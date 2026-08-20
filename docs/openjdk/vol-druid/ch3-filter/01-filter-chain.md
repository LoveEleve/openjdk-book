# 为什么 Druid 要让所有 JDBC 操作都穿过 Filter 链

> 本文基于 Druid 1.2.27 当前源码。本文只讲 Filter 链本身：`FilterChainImpl` 的递归链模型、`pos`/`filterSize` 控制机制、`createChain()`/`recycleFilterChain()` 的池复用、以及 `DruidPooledConnection.close()` 的两条路径。不展开 StatFilter/WallFilter 的具体实现。

## 为什么 HikariCP 没有 Filter 链，Druid 却有

如果你已经读过 HikariCP，你可能会注意到一件事：HikariCP 靠代理类直接处理所有 JDBC 拦截，不需要额外的 Filter 链。

但 Druid 不同。它没有“代理类 + 内联逻辑”的模式，而是把每个 JDBC 操作拆成一条递归链：

- `pos` 指针推进驱动
- `filterSize` 控制链尾
- `nextFilter()` 每次取出下一个 Filter 执行

这个模型看起来比 HikariCP 的代理类重，但它的设计意图不在“高效拦截”，而在“可插拔扩展”。

## Filter 链的最小总图

```text
DruidPooledConnection.close()
  -> holder.createChain()
    -> FilterChainImpl
      -> pos / filterSize / nextFilter()
        -> 递归调用链上每个 Filter
  -> 或 new FilterChainImpl(dataSource)（无 Filter 时）
```

## 一、`FilterChainImpl` 递归链模型

`FilterChainImpl` 是 Druid Filter 链的核心执行者。它在 `filter/FilterChainImpl.java` 中定义：

- `pos`：当前执行到的 Filter 位置（`FilterChainImpl.java:37`）
- `filterSize`：链上 Filter 总数（`FilterChainImpl.java:41`）
- `nextFilter()`：取出下一个 Filter 并推进 `pos`（`FilterChainImpl.java:469`）

它的工作方式是递归的：

```java
if (this.pos < filterSize) {
    return nextFilter().dataSource_connect(this, ...);
}
```

每调用一次 `nextFilter()`，`pos` 前进一步，直到 `pos >= filterSize` 时到达链尾，执行真正的底层操作。

这个模型和 Servlet 的 `FilterChain.doFilter()` 非常相似，但 Druid 的 Filter 链拦截的是所有 JDBC 操作，而不是 HTTP 请求。

## 二、`createChain()` / `recycleFilterChain()`：为什么链要池复用

`FilterChainImpl` 的创建和回收不是随意的，而是由 `DruidConnectionHolder` 统一管理：

- `DruidConnectionHolder.java:46` 类声明
- `DruidConnectionHolder.java:223` `createChain()`：如果 holder 上已有缓存的 `filterChain`，直接复用；否则新建。其内部逻辑为：`chain = new FilterChainImpl(dataSource)`
- `DruidConnectionHolder.java:234` `recycleFilterChain(FilterChainImpl chain)`：在连接归还时，把链放回 holder 缓存

这意味着，Filter 链本身也是一个池内复用对象，而不是每次操作都 new 一个。

这也解释了为什么 `DruidConnectionHolder` 要持有一个 `volatile FilterChainImpl filterChain` 字段（`DruidConnectionHolder.java:90`）：它不只是在持有连接，还在持有连接对应的 Filter 链缓存。

## 三、`DruidPooledConnection.close()` 有/无 Filter 两条路径

`DruidPooledConnection.close()` 的实现（`DruidPooledConnection.java:236`）会根据是否有 Filter 而走两条不同路径：

- 有 Filter 路径（`DruidPooledConnection.java:274`）：调用 `holder.createChain()` 获取缓存的 FilterChainImpl，然后执行链
- 无 Filter 路径（`DruidPooledConnection.java:316`）：直接 `new FilterChainImpl(dataSource)`，不经过缓存

这两条路径的存在，说明 Druid 的 Filter 链不是“从头到尾必须走”，而是“有 Filter 就走链，没有就走直接路径”。

## 四、Filter 链和 Druid 监控/安全的关系

建立了 Filter 链骨架之后，Druid 上层的监控和安全能力自然就落在它上面：

- `StatFilter`：拦截 SQL 执行，统计耗时、行数、参数化
- `WallFilter`：拦截 SQL 执行，解析 AST，检查注入规则
- 第三方 Filter：通过 SPI 机制，可以实现自己的 Filter 插到链上

所以 Filter 链不是 Druid 的“副产品”，而是 Druid 整条扩展线的骨架。

## 这篇真正立住的，不是 Filter 接口，而是“递归链骨架”这个概念

更稳的理解方式应该是：

1. `FilterChainImpl` 是 Druid 扩展点的核心执行者
2. `pos` / `filterSize` / `nextFilter()` 构成递归链模型
3. `createChain()` / `recycleFilterChain()` 是链的池复用机制
4. `DruidPooledConnection.close()` 有/无 Filter 两条路径说明链不是必须的，是可选的

## 这篇之后，最自然的继续方向

Filter 链骨架立住后，最自然的是进入 StatFilter 和 WallFilter——它们就是插在这个骨架上的具体实现。