# Druid D-5 连接池维护体系 — review notes

## 一次性深审收口（六类合一）

### 第一轮：事实审

#### 已核对的关键锚点
- `shrink()` 三重载：`DruidDataSource.java:3061/3065/3069`
- `shrink(boolean, boolean)` 方法体约 201 行（比原规划文档写的 ~120 行长，已在规划文档中修正为 ~200）
- `DestroyTask.run()`：`DruidDataSource.java:2887`
  - 直接 `shrink(true, keepAlive)`
  - 仅当 `isRemoveAbandoned()` 为 true 时才调用 `removeAbandoned()`：`DruidDataSource.java:2895`
- `CreateConnectionTask`：`DruidDataSource.java:2560`
- `removeAbandoned()`：`DruidDataSource.java:2925`
- `timeBetweenEvictionRunsMillis`：`DruidDataSource.java:987`
- `keepAliveAndKeepAliveThread` 相关：`DruidDataSource.java:738`

#### 本轮修正
- 正文把 `removeAbandoned()` 从“shrink 的固定后续”修正为“仅当 isRemoveAbandoned() 为 true 时的可选分支”
- 补入了 `DestroyTask.run()` 源码片段作为证据

### 第二轮：因果审

当前因果链成立：
1. shrink() 一个方法管四件事，不是“清偿空闲连接”
2. DestroyTask 和 CreateConnectionTask 是两条独立后台线路
3. removeAbandoned 和 shrink 管的是不同范围的连接
4. timeBetweenEvictionRunsMillis 控制维护频率

### 第三轮：结构审

当前结构按“一个方法四件事 -> 四阶段 -> 两条线路 -> removeAbandoned -> 对比收网”推进，没有按包目录翻译，结构成立。

### 第四轮：读者审

读完后读者应能回答：
- 为什么 Druid 把维护压进一个方法
- 为什么它和后场 HouseKeeper 模型不同
- 为什么 removeAbandoned 不等于 shrink

### 第五轮：边界审

本篇只讲池本体维护，没有提前透支 Filter/StatFilter/解析器。德育与 D-1、D-4 边界清晰。

### 第六轮：依赖审

- 前置依赖：D-1 已立住池本体
- 后续桥接：Filter 拦截链体系 合理

## 当前结论
本篇已通过一次性深审收口，锚点已回填，removeAbandoned 与 shrink 的边界已精确化，可进入终稿。D-5 可正式收口。

## 建议的下一步
1. 以当前稿为准收口 D-5
2. 进入 D-2 Filter 拦截链体系的 rewrite-plan