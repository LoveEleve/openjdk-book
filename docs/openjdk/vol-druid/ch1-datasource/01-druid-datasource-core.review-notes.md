# Druid D-1 DruidDataSource 连接池核心 — review notes

## 一次性深审收口（六类合一）

### 第一轮：事实审

#### 已核对的关键锚点
- `DruidDataSource.java` 存在，3979 行 ✅
- `DruidAbstractDataSource.java` 存在，2388 行 ✅
- `DruidConnectionHolder.java` 存在，476 行 ✅
- `DruidPooledConnection.java` 存在，1298 行 ✅
- `connections = new DruidConnectionHolder[maxActive]`：`DruidDataSource.java:772`
- `init()`：`DruidDataSource.java:659`
- `getConnectionInternal(long)`：`DruidDataSource.java:1543`
- `recycle(DruidPooledConnection)`：`DruidDataSource.java:1894`
- `shrink()` 三重载：`DruidDataSource.java:3061/3065/3069`

#### 当前正文风险
- 正文目前没有把方法级行号直接写进去，后续精修时建议从 `DruidDataSource.java` 的 `init()`、`getConnectionInternal()` 等关键方法补锚点，防止这篇停在概念层
- 正文没有引用规划文档中已修正的 `FilterChainImpl` 行数，因为本篇不涉及 Filter 链，可以暂时不补

### 第二轮：因果审

#### 当前因果链
1. Druid 不是 HikariCP 的增强版，而是池内并发模型不同
2. `init()` 是配置对象到运行池的转折点
3. `connections[maxActive]` 固定数组决定了池存储的并发边界
4. `notEmpty`/`empty` 不是普通 wait/signal，而是受控协议
5. `getConnectionInternal()` 里有多条分支（createDirect / maxWaitThreadCount / onFatalError / discard）

#### 风险
- 这些判断在结构上成立，但正文目前没有用 `init()` 具体行号或 `getConnectionInternal()` 具体行号去压实，后续精修时要补
- “固定数组 + 双 Condition 协议”是这篇最好的主概念，但事实层还要持续加固

### 第三轮：结构审

#### 当前结构
1. 困惑开场
2. 失败方案
3. 最小总图
4. 三层类结构
5. `connections[maxActive]` 固定数组
6. `init()` 转折点
7. `getConnectionInternal()` 借出协议
8. `notEmpty`/`empty` 双 Condition
9. 收网总结
10. 下篇桥接

#### 评价
- 没有按包顺序翻译，而是按“协议骨架”展开
- 后半段 `notEmpty`/`empty` 和 `getConnectionInternal()` 的权重已经压得够重
- `init()` 一节如果后续补源码细节时控制不好，会膨胀到压过借出协议

### 第四轮：读者审

#### 读者收益
- 知道为什么不能拿 HikariCP 模型硬套 Druid
- 知道 `init()` 不是简单校验
- 知道 `notEmpty`/`empty` 是受控协议

#### 风险
- 如果读者没读过 HikariCP，这篇“对比”的力度会减弱
- 如果 `init()` 和 `getConnectionInternal()` 的锚点不够，读者会认可概念但不一定能落回实现

### 第五轮：边界审

#### 控制
- 本篇没有提前透支 Filter/StatFilter/WallFilter/解析器
- 明确把维护体系（shrink / DestroyTask）留给了下一篇

#### 风险
- 如果在后续精修时为了讲借出协议而把 `shrink` 提前带进来，会吃掉 Ch1-02

### 第六轮：依赖审

#### 前置依赖
- 强依赖 `vol-hikaricp` 已建立“连接池不是容器”的认知
- 不依赖 Druid 后续篇目

#### 后续桥接
- 当前桥接到“shrink 维护体系”是合理的

## 当前结论

这篇已通过一次性深审收口，并已完成关键的锚点回填。
- `init()` → `DruidDataSource.java:659`
- `connections[maxActive]` → `DruidDataSource.java:772`
- `getConnectionInternal(long)` → `DruidDataSource.java:1543`
- 同时发现正文中未描述但值得补充的细节：`init()` 中同时建了 `evictConnections` / `keepAliveConnections` / `nullConnections` 四个平行数组

当前正文结构已从概念级提升到有方法级锚点支撑的状态。`D-1` 可以进入收口。

## 建议的下一步

1. 以当前稿为准收口 D-1
2. 进入 D-5 连接池维护体系（shrink / DestroyTask / removeAbandoned）的 rewrite-plan