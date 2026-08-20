# 篇：01 插件总线与 SQL 改写入口

- 域：`MP-5 插件总线与 SQL 改写入口`
- 卷：`vol-mybatis-plus`
- 目标：回答 MyBatis-Plus 为什么没有把分页、乐观锁、租户、权限这些增强分别做成互不相干的插件，而是先做 `MybatisPlusInterceptor + InnerInterceptor` 总线，再把 SQL 改写能力统一挂进去。

## 前置依赖

- HARD：已读 `MP-4`，知道条件构造协议；已知 MyBatis 原生执行链与插件入口。

## 读者问题

为什么 MyBatis-Plus 的运行时增强不是“每个功能各搞一个 MyBatis Interceptor”，而是：

1. 先做一个 `MybatisPlusInterceptor`
2. 再在里面挂一组 `InnerInterceptor`
3. 再用 `PluginUtils.mpBoundSql()`、`mpStatementHandler()` 去做 SQL 改写
4. 再让分页、乐观锁、租户、权限、安全这些增强统一接入

## 主结论

MyBatis-Plus 的运行时增强不是一堆离散插件，而是一条统一的插件总线协议：

`MybatisPlusInterceptor.intercept(invocation)`
  -> 根据目标对象区分 `Executor` / `StatementHandler`
    -> `InnerInterceptor` 六个回调位点
      - `willDoQuery`
      - `beforeQuery`
      - `willDoUpdate`
      - `beforeUpdate`
      - `beforePrepare`
      - `beforeGetBoundSql`
    -> 借 `PluginUtils.MPBoundSql / MPStatementHandler` 读取和改写 BoundSql / StatementHandler

也就是说：

- `MybatisPlusInterceptor` 是外层总线
- `InnerInterceptor` 是功能插槽
- 具体的分页、乐观锁、租户、权限、安全插件只是挂在这条总线上的实现家族

## 结构设计

1. 困惑开场：为什么 MP 没把每个增强都做成独立外层 Interceptor
2. 最小总图：`MybatisPlusInterceptor` -> `InnerInterceptor` -> `PluginUtils`
3. `MybatisPlusInterceptor.intercept()`：为什么要先统一拦 Executor / StatementHandler
4. 六个回调位点：查询前、更新前、prepare 前、getBoundSql 前分别解决什么问题
5. `PluginUtils`：为什么 MP 需要自己的 `MPBoundSql / MPStatementHandler`
6. `PaginationInnerInterceptor.beforeQuery()`：分页插件为什么是总线上的典型样板
7. `InterceptorIgnoreHelper`：为什么还要给总线加跳过规则
8. 失败路径：跳过执行、多插件顺序、BoundSql 改写副作用、租户/权限/安全插件边界
9. 收网：这篇立住的是“插件总线协议”，不是分页插件说明文
10. 下篇桥接：进入 MP-6 具体运行时增强专题组

## 必须回填的源码锚点

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:40` 类声明
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:55` `intercept(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:109` `plugin(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:117` `addInnerInterceptor(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:53` `willDoQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:69` `beforeQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:82` `willDoUpdate(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:95` `beforeUpdate(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:108` `beforePrepare(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:119` `beforeGetBoundSql(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:56` `realTarget(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:87` `mpBoundSql(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:91` `mpStatementHandler(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:140` `MPBoundSql`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:115` `willDoQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:148` `beforeQuery(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:93` `initSqlParserInfoCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:131` `willIgnore(...)`

## 必须引用的测试/证据

- `PaginationInnerInterceptorTest`
- `InterceptorIgnoreHelperTest`
- `TenantTest`
- `VersionTest`
- `StrategyTest`
- Boot 自动装配中的 metadata / interceptor 相关测试只作后续桥接侧证

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。