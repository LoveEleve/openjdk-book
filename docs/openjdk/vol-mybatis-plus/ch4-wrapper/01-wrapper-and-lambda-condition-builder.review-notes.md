# MP-4 Wrapper / Lambda 条件构造器 — review notes

## 事实审

- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:58`、`:63`、`:145`、`:205`、`:418`、`:544`、`:591`，条件链与参数占位主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractLambdaWrapper.java:39`、`:65`、`:120`、`:128`，Lambda 字段到列语义的桥成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/LambdaUtils.java:50`、`:77`、`:86`、`:96`，Lambda 解析与列缓存主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/query/LambdaQueryWrapper.java:109`、`mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/update/LambdaUpdateWrapper.java:78`、`:86`、`:111`，查询链与更新链的分叉成立。
- 已补测试证据：`LambdaUtilsTest`、`IdeaProxyLambdaMetaTest`、`LambdaQueryWrapperTest`、`LambdaUpdateWrapperTest`、Kotlin `WrapperTest`。

## 因果审

- `MP-3` 的表元数据先建立，`MP-4` 再消费 `ColumnCache`，这条因果关系成立。
- `AbstractWrapper` 负责条件链与参数状态，`AbstractLambdaWrapper` 负责字段解析，职责分层成立。
- `LambdaUtils` 三路径解析说明 Lambda 条件构造不是编译期魔法，而是运行时协议，正文成立。

## 结构审

- 从“Wrapper 不是字符串 builder”切入，再落到条件链、参数命名、Lambda 解析、列缓存和查询/更新分叉，主线集中。
- 没有把大量链式方法清单平铺成文档主体，符合方法论。

## 读者审

- 读完应能回答：为什么 Wrapper 需要 `paramNameValuePairs`。
- 读完应能回答：为什么 Lambda Wrapper 不能直接等同于普通 Wrapper。
- 读完后能自然进入插件总线，而不会把 Wrapper 和 SQL 改写混成一层。

## 边界审

- 本篇没有提前透支分页、租户、权限等插件改写。
- `setSql()` 只作为更新链风险边界提示，不扩展成 SQL 注入专题，边界成立。

## 依赖审

- 前置依赖：MP-3 表元数据语义中心。
- 后续桥接：MP-5 插件总线、MP-6 运行时增强专题组都成立。

## 结论

MP-4 已完成单域四件套的事实回填与六层审查，可进入下一核心主干域。