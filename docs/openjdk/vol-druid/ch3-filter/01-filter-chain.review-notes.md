# Druid D-2 Filter 拦截链体系 — review notes

## 一次性深审收口（六类合一）

### 第一轮：事实审

#### 已核对的关键锚点
- `FilterChainImpl.java:36` 类声明
- `FilterChainImpl.java:37` `pos` 字段
- `FilterChainImpl.java:41` `filterSize` 字段
- `FilterChainImpl.java:45` `this.filterSize = getFilters().size()`
- `FilterChainImpl.java:63` `pos = 0`（reset）
- `FilterChainImpl.java:68` `reset()` 返回新 `FilterChainImpl`
- `FilterChainImpl.java:469` `nextFilter()` 方法：`return getFilters()...get(pos++);`
- `DruidConnectionHolder.java:46` 类声明
- `DruidConnectionHolder.java:90` `volatile FilterChainImpl filterChain`
- `DruidConnectionHolder.java:223` `createChain()`
- `DruidConnectionHolder.java:226` `chain = new FilterChainImpl(dataSource);`
- `DruidConnectionHolder.java:234` `recycleFilterChain(FilterChainImpl chain)`
- `DruidPooledConnection.java:236` `close()`
- `DruidPooledConnection.java:274` 有 Filter 路径（调用 `holder.createChain()`）
- `DruidPooledConnection.java:316` 无 Filter 路径（`new FilterChainImpl(dataSource)`）

所有锚点已回填正文，且全部在源码中实存。

#### 正文中的代码块
正文中引用了一段示意递归代码：
```java
if (this.pos < filterSize) {
    return nextFilter().dataSource_connect(this, ...);
}
```
这段与 `FilterChainImpl.java:77-78` 模式一致，但 `dataSource_connect` 方法的真实签名较长。此代码块目前作为“示意”已合规（删码测试后主线仍成立），后续正式发布前建议贴真实方法签名或标注为示意。

### 第二轮：因果审

当前因果链成立：
1. HikariCP 无 Filter 链，Druid 用递归链做扩展点 → 成立
2. `pos`/`filterSize`/`nextFilter()` 构成递归推进 → 成立（第 469 行直接 `get(pos++)`）
3. `createChain()`/`recycleFilterChain()` 是链的池复用 → 成立
4. `close()` 有/无 Filter 两条路径 → 成立（274/316 两处确实是两路径）

### 第三轮：结构审

结构推进：困惑 → 总图 → 递归链模型 → 池复用 → close 路径 → 监控/安全关系 → 收网 → 下篇桥接。

没有按文件目录平移，结构成立。

### 第四轮：读者审

读者读完应能：
- 知道 pos/filterSize/nextFilter 三种角色
- 知道 createChain/recycleFilterChain 是池复用
- 知道 close() 有无 Filter 两条路
- 知道 StatFilter/WallFilter 只是插在链上的实现

### 第五轮：边界审

本篇只讲 Filter 链骨架，没有提前拉 StatFilter/WallFilter。边界清晰。

### 第六轮：依赖审

- 前置依赖：D-1 池本体
- 后续桥接：StatFilter/WallFilter 合理

## 当前结论
本篇已通过一次性深审收口，锚点已回填，所有关键 file:line 均在源码实存。D-2 可正式收口。

## 建议的下一步
1. 以当前稿为准收口 D-2
2. 进入 D-3 StatFilter SQL 监控 的 rewrite-plan