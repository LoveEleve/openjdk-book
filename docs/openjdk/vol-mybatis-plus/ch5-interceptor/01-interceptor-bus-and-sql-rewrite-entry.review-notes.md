# MP-5 插件总线与 SQL 改写入口 — review notes

## 事实审

- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:40`、`:55`、`:109`、`:117`，总线入口与挂载主线成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:53`、`:69`、`:82`、`:95`、`:108`、`:119`，六个回调位点的增强时机切片成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:56`、`:87`、`:91`、`:140`，底层对象访问协议成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:115`、`:148`，分页作为总线样板成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:93`、`:131`，总线跳过机制成立。
- 已补测试证据：`PaginationInnerInterceptorTest`、`InterceptorIgnoreHelperTest`、`TenantTest`、`VersionTest`、`StrategyTest`。

## 因果审

- 外层总线先统一接管 `Executor` / `StatementHandler`，再由 `InnerInterceptor` 切成 6 个位点，这条分层成立。
- `PluginUtils` 不是边缘工具，而是总线统一操作 `BoundSql` / `StatementHandler` 的访问协议，正文成立。
- 分页插件作为 `willDoQuery + beforeQuery` 双阶段样板，足以说明总线设计哲学，正文成立。
- ignore 机制说明 MP 不是把增强强推给所有 SQL，而是在总线之上再叠加选择性退场协议，正文成立。

## 结构审

- 从“不是一堆散插件”切入，再落到总线、位点、访问器、分页样板与失败边界，主线集中。
- 没把各个增强插件平铺写成功能清单，符合方法论。

## 读者审

- 读完应能回答：为什么 MP 需要 `MybatisPlusInterceptor` 而不只是多个普通 Interceptor。
- 读完应能回答：为什么 `PluginUtils` 和 `InterceptorIgnoreHelper` 都属于总线体系的一部分。
- 读完后能自然进入 MP-6，而不会把插件总线和具体增强家族混成一层。

## 边界审

- 本篇没有提前透支分页、租户、权限、安全等增强家族的全部细节。
- 只把分页作为样板，不让其吞掉总线主线，边界成立。

## 依赖审

- 前置依赖：MP-4 Wrapper / Lambda 条件构造器。
- 后续桥接：MP-6 内置运行时增强专题组成立。

## 结论

MP-5 已完成单域四件套的事实回填与六层审查，可进入下一补深域。