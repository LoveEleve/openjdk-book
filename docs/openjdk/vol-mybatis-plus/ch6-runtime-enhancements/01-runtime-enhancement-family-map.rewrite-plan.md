# 篇：01 内置运行时增强专题组总图

- 域：`MP-6 内置运行时增强专题组`
- 卷：`vol-mybatis-plus`
- 目标：先收束分页、乐观锁、自动填充、逻辑删除、租户、权限、安全、动态表名这些增强家族之间的共同位点与责任分层，再决定哪些专题值得后续继续拆篇。

## 前置依赖

- HARD：已读 `MP-2`、`MP-3`、`MP-5`，知道 SQL 注入、表元数据中心与插件总线。

## 读者问题

为什么 MP 的这些增强看起来功能差异很大，却都围绕同一条运行时增强链展开？以及：

1. 自动填充与 ID 生成为什么不走插件总线，而走 `MybatisParameterHandler`
2. 分页为什么是 `willDoQuery + beforeQuery` 的样板
3. 乐观锁为什么只拦更新而且依赖 `@Version`
4. 租户、数据权限、动态表名、安全插件为什么大多落在 `beforeQuery/beforePrepare`
5. 逻辑删除为什么既依赖注入期 SQL，又依赖运行时插件/元数据协作

## 主结论

MP 的运行时增强不是平铺功能列表，而是两条增强协议的家族分层：

### A. 参数侧增强

`MybatisParameterHandler`
  -> `populateKeys()`
  -> `insertFill()/updateFill()`

负责：

- ID 生成
- 自动填充
- 与 `TableInfo` / `MetaObjectHandler` / `IdentifierGenerator` 的协作

### B. SQL 改写侧增强

`MybatisPlusInterceptor`
  -> `InnerInterceptor`
    -> `PaginationInnerInterceptor`
    -> `OptimisticLockerInnerInterceptor`
    -> `TenantLineInnerInterceptor`
    -> `DataPermissionInterceptor`
    -> `BlockAttackInnerInterceptor`
    -> `IllegalSQLInnerInterceptor`
    -> `DynamicTableNameInnerInterceptor`

负责：

- 查询/更新前决策
- SQL 条件追加
- 安全检查
- 分页 count 与 limit 重写
- 版本字段校验

也就是说，MP 的增强体系不是并列散点，而是：

- 一条“参数增强家族”
- 一条“SQL 改写家族”

## 结构设计

1. 困惑开场：为什么这些增强看起来无关，却都建立在同一运行时链上
2. 最小总图：参数侧增强 vs SQL 改写侧增强
3. `MybatisParameterHandler`：自动填充与 ID 生成为什么走参数侧
4. `PaginationInnerInterceptor`：为什么它是总线样板
5. `OptimisticLockerInnerInterceptor`：版本字段与 wrapperMode 边界
6. `TenantLine` / `DataPermission` / `DynamicTableName`：SQL 改写家族的共同特征
7. `BlockAttack` / `IllegalSQL`：安全/守卫家族的共同特征
8. 逻辑删除：为什么它是注入期 + 元数据期 + 运行时协同结果，而不是单点插件
9. 失败路径与生产候选：多插件顺序、count 优化、副作用、填充/雪花 ID 边界
10. 收网：这篇立住的是“增强家族地图”，不是每个功能的实现细节
11. 下篇桥接：进入 Spring Boot 自动装配桥

## 必须回填的源码锚点

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:72` `processParameter(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:81` `process(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:111` `populateKeys(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:128` `insertFill(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:136` `updateFill(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:115` `willDoQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:148` `beforeQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/OptimisticLockerInnerInterceptor.java:105` `beforeUpdate(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/OptimisticLockerInnerInterceptor.java:116` `doOptimisticLocker(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/TenantLineInnerInterceptor.java:64` `beforeQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/TenantLineInnerInterceptor.java:73` `beforePrepare(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/DataPermissionInterceptor.java:66` `beforeQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/BlockAttackInnerInterceptor.java:51` `beforePrepare(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/IllegalSQLInnerInterceptor.java:98` `beforePrepare(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/DynamicTableNameInnerInterceptor.java:60` `beforeQuery(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:93` `initSqlParserInfoCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:131` `willIgnore(...)`

## 必须引用的测试/证据

- `MybatisParameterHandlerTest`
- `FillTest`
- `VersionTest`
- `TenantTest`
- `StrategyTest`
- `PaginationInnerInterceptorTest`
- `InterceptorIgnoreHelperTest`

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。