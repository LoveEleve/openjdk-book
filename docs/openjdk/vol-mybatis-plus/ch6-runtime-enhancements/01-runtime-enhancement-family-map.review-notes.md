# MP-6 内置运行时增强专题组总图 — review notes

## 事实审

- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisParameterHandler.java:72`、`:81`、`:111`、`:128`、`:136`，参数侧增强主线成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:115`、`:148`，分页插件作为总线样板成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/OptimisticLockerInnerInterceptor.java:105`、`:116`，乐观锁更新语义成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/TenantLineInnerInterceptor.java:64`、`:73`、`mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/DataPermissionInterceptor.java:66`、`mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/BlockAttackInnerInterceptor.java:51`、`mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/IllegalSQLInnerInterceptor.java:98`、`mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/DynamicTableNameInnerInterceptor.java:60`，SQL 改写/守卫家族主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:93`、`:131`，统一跳过机制成立。
- 已补测试证据：`MybatisParameterHandlerTest`、`FillTest`、`VersionTest`、`TenantTest`、`StrategyTest`、`PaginationInnerInterceptorTest`、`InterceptorIgnoreHelperTest`。

## 因果审

- 自动填充与 ID 生成走参数侧增强，而分页/租户/权限/安全走 SQL 改写侧增强，这个家族分层成立。
- `MybatisPlusInterceptor` 总线先立住后，具体插件家族才能稳定挂上去，正文成立。
- 逻辑删除依赖元数据 + 注入 + 运行时协同，不应被看成单点插件，正文成立。

## 结构审

- 从“不是功能表，而是家族地图”切入，再落到参数侧、SQL 改写侧、守卫家族、ignore 机制与生产候选，主线集中。
- 没把每个增强插件拆成一堆平行介绍，符合方法论。

## 读者审

- 读完应能回答：为什么自动填充不挂在分页那条总线上。
- 读完应能回答：为什么租户、权限、动态表名更像一类，而 BlockAttack/IllegalSQL 更像另一类。
- 读完后能自然进入 Boot 自动装配桥，而不会把插件装配和插件总线混成一层。

## 边界审

- 本篇没有把每个增强家族的细节算法全部展开。
- Boot 自动装配和 IService 应用边界都未提前透支，边界成立。

## 依赖审

- 前置依赖：MP-2 SQL 注入、MP-3 表元数据、MP-5 插件总线。
- 后续桥接：MP-7 Boot 自动装配桥成立。

## 结论

MP-6 已完成单域四件套的事实回填与六层审查，可进入集成装配层。