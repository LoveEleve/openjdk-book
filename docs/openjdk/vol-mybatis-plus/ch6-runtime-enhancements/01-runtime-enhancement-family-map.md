# 为什么 MyBatis-Plus 的分页、乐观锁、租户、填充、安全看起来功能分散，却都建立在同一条增强协议上

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲内置运行时增强的家族地图：`MybatisParameterHandler` 负责的参数侧增强，以及 `MybatisPlusInterceptor + InnerInterceptor` 负责的 SQL 改写侧增强，解释这些增强为什么不是一堆散点功能。不展开每个插件的全部算法细节。

## 为什么“MP 有很多增强功能”这个说法远远不够

很多人说起 MP 的增强，常常会直接列单子：

- 分页
- 乐观锁
- 自动填充
- 逻辑删除
- 多租户
- 数据权限
- 防全表更新删除
- 非法 SQL 检查
- 动态表名

这当然都是真的，但它最大的问题是：把一整套运行时增强协议讲散了。

因为如果它们只是并列功能列表，就很难解释：

- 为什么自动填充和 ID 生成不走插件总线，而是走 `MybatisParameterHandler`
- 为什么分页、租户、权限、安全都要挂在 `InnerInterceptor` 的 6 个统一位点上
- 为什么逻辑删除既依赖注入期 SQL，又依赖元数据，再与运行时增强协同
- 为什么 `InterceptorIgnoreHelper` 能跨这些增强统一起效

这说明 MP 的增强体系真正建立起来的不是“若干功能”，而是：

**一套带有明确分层的运行时增强协议家族。**

## 运行时增强家族的最小总图

```text
参数侧增强
MybatisParameterHandler
  -> populateKeys()
  -> insertFill()/updateFill()

SQL 改写侧增强
MybatisPlusInterceptor
  -> InnerInterceptor
    -> PaginationInnerInterceptor
    -> OptimisticLockerInnerInterceptor
    -> TenantLineInnerInterceptor
    -> DataPermissionInterceptor
    -> BlockAttackInnerInterceptor
    -> IllegalSQLInnerInterceptor
    -> DynamicTableNameInnerInterceptor
```

这张图最重要的不是功能项，而是分层：

1. 参数侧增强解决“实体值在执行前怎么被改写”
2. SQL 改写侧增强解决“语句在执行前怎么被改写或阻断”

这两条线虽然最终都服务于一次执行，但它们的切入时机和责任世界完全不同。

## 一、`MybatisParameterHandler`：为什么自动填充与 ID 生成不走插件，而走参数侧增强

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:72` `processParameter(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:81` `process(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:111` `populateKeys(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:128` `insertFill(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:136` `updateFill(...)`

这条线的语义非常清晰：

1. 只有 INSERT/UPDATE 才处理
2. 先从参数里提取真正的实体对象
3. 再基于 `TableInfo`、`MetaObject` 做：
   - 主键生成
   - `insertFill()`
   - `updateFill()`

也就是说，自动填充和 ID 生成不是在 SQL 字符串层改写，而是在 SQL 进入 JDBC 之前，直接改实体参数状态。

这就是为什么它不适合挂在 `InnerInterceptor.beforeQuery/beforePrepare`：

- 它关心的是“参数对象怎么补完”
- 不是“SQL 文本怎么改写”

所以参数侧增强真正立住的是：

**在执行前先把实体状态补全，再让后续 SQL 注入和插件总线消费这个更完整的参数对象。**

## 二、分页插件为什么是 SQL 改写家族最标准的样板

关键点在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:115` `willDoQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:148` `beforeQuery(...)`

分页插件几乎把 SQL 改写家族的设计哲学演示得最完整：

### 1. `willDoQuery(...)`

先决定这次查询是否还需要继续：

- 有 page 吗
- 要 count 吗
- total 为 0 时是否直接短路

### 2. `beforeQuery(...)`

真正改 SQL：

- 处理 order by
- 处理 limit
- 计算 dialect
- 借 `PluginUtils.MPBoundSql` 改写 SQL 和参数映射

这说明分页不是“一个功能点”，而是：

**MP 插件总线如何拆成‘执行前决策’与‘执行前改写’两阶段的标准样板。**

## 三、`OptimisticLockerInnerInterceptor`：为什么乐观锁是更新语义，而不是一般 SQL 改写语义

关键点在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/OptimisticLockerInnerInterceptor.java:105` `beforeUpdate(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/OptimisticLockerInnerInterceptor.java:116` `doOptimisticLocker(...)`

乐观锁和分页的一个根本区别是：

- 分页在 query 上工作
- 乐观锁只在 update 上工作

而且它依赖的是：

- `@Version` 字段
- `TableInfo.isWithVersion()`
- wrapperMode 时对 wrapper 参数里的 version 条件补写

也就是说，乐观锁不是通用 SQL 文本改写，而是：

**一种深度绑定实体元数据与更新语义的专项增强。**

所以它和租户、权限一样都挂在插件总线上，但其真实依赖比“改 SQL 文本”更深。

## 四、租户、权限、动态表名：它们为什么更像“SQL 结构改写家族”

关键点在：

- `TenantLineInnerInterceptor.beforeQuery(...)` / `beforePrepare(...)`
- `DataPermissionInterceptor.beforeQuery(...)`
- `DynamicTableNameInnerInterceptor.beforeQuery(...)`

这几类增强有一个共同特点：

- 都不是改参数值
- 都是在改 SQL 结构本身

例如：

- 租户：追加 tenant 条件、改 insert/update/delete/select 语义
- 权限：追加 where 表达式
- 动态表名：替换逻辑表名为运行时表名

所以它们真正相似的地方不在“业务用途”，而在：

**都属于在统一位点上操作 SQL AST 或 `BoundSql` 的结构改写家族。**

## 五、BlockAttack / IllegalSQL：为什么它们不是“功能增强”，而是守卫家族

关键点在：

- `BlockAttackInnerInterceptor.beforePrepare(...)`
- `IllegalSQLInnerInterceptor.beforePrepare(...)`

这两类增强和分页、租户的最大不同，是它们的目标不是“让 SQL 更有能力”，而是：

- 直接阻断危险 SQL
- 检查 where 是否全表
- 检查索引与 join 风险

也就是说，它们更接近守卫协议，而不是业务能力增强协议。

所以把这些插件全都平铺成“功能列表”会看不出家族差异。更合理的理解是：

- 分页 / 租户 / 权限 / 动态表名：SQL 改写家族
- BlockAttack / IllegalSQL：安全守卫家族

## 六、为什么逻辑删除不适合单纯看成一个插件

逻辑删除很容易被误读成：

- 又一个拦截器功能

但从 MP 整体结构看，它其实是三层协作的结果：

1. 元数据层：`TableInfo/TableFieldInfo` 知道哪个字段是逻辑删除字段
2. 注入层：SQL 自动注入生成逻辑删除相关 statement
3. 运行时层：安全/条件增强可能继续和逻辑删除语义发生叠加

所以逻辑删除不是单点插件，而是：

**建立在元数据 + 注入 + 运行时增强三层共同协作上的增强能力。**

这也是为什么 `MP-6` 不能只写插件列表，而要先把家族关系立住。

## 七、`InterceptorIgnoreHelper`：为什么增强家族越多，越需要统一跳过协议

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:93` `initSqlParserInfoCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:131` `willIgnore(...)`

一旦增强家族变多，问题就不再是“能不能挂进去”，而是：

- 某个 mapper / method / statement，到底该让哪些增强生效，哪些不生效？

这就是 `InterceptorIgnoreHelper` 的位置。

它说明 MP 插件总线不是盲目全开，而是：

**总线之上再叠一层统一的选择性退场协议。**

所以它不是边缘小工具，而是总线成熟度的重要组成部分。

## 八、失败路径与生产候选：为什么 `MP-6` 的价值在于先认清家族边界

这一篇不是每个增强的实现细拆，而是先认清边界：

### 1. 多插件顺序

总线按顺序执行，顺序本身就是行为的一部分。

### 2. 参数侧增强与 SQL 改写侧增强的交叉副作用

填充/ID 生成先改实体，分页/租户/权限后改 SQL；这两层如果混读，很容易误判责任来源。

### 3. count 优化、副作用与复杂 join

分页的优化逻辑会直接影响统计语义。

### 4. 逻辑删除、版本号、租户条件叠加

这会形成非常典型的生产排障主题，而不能被当成“都在插件里”一句话带过。

所以 `MP-6` 真正值钱的不是“收了很多功能”，而是：

**先把运行时增强家族的地图立出来，后续细拆才不会写散。**

## 到这里，MP-6 真正立住的不是功能表，而是“运行时增强家族地图”

如果只看表面，这篇很容易被读成：

- MP 有分页
- 有乐观锁
- 有填充
- 有租户和权限
- 有安全插件

这些当然都对，但还是列表式理解。

更稳的理解方式应该是：

1. 参数侧增强负责“执行前把实体状态补全”
2. SQL 改写侧增强负责“执行前决定是否继续、以及如何改写 SQL”
3. 各个具体增强只是这两条协议家族上的成员
4. `InterceptorIgnoreHelper` 决定哪些成员在当前 statement 上应该退场

所以这篇真正立住的是：

**MyBatis-Plus 的内置增强不是一堆散功能，而是一套分层清晰的运行时增强家族。**

## 这篇之后，最自然的继续方向

到这里，MP 核心主干与增强家族都已经立住。下一步最自然的方向就是：

- `MP-7`：在 Spring Boot 下，这些增强与增强版 `Configuration` / `SqlSessionFactory` / 插件家族是怎样自动装起来的

也就是说，下一篇应进入 `MP-7 Spring Boot 自动装配桥`。