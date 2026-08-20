# 篇：01 Wrapper / Lambda 条件构造器

- 域：`MP-4 Wrapper / Lambda 条件构造器`
- 卷：`vol-mybatis-plus`
- 目标：回答 MP 为什么不满足于字符串列名条件拼接，而是要建立 `AbstractWrapper -> AbstractLambdaWrapper -> LambdaUtils/ColumnCache` 这套条件构造协议。

## 前置依赖

- HARD：已读 `MP-3`，知道 `TableInfo` / `TableFieldInfo` 已经建立表元数据中心。

## 读者问题

为什么 MyBatis-Plus 的条件构造不是“拼 WHERE 片段”这么简单，而要同时处理：

1. 条件链的持续生长
2. 参数占位和命名去重
3. Lambda 字段引用到列名的解析
4. 调试代理模式与正常模式的 Lambda 提取差异
5. `setSql` / `setIncrBy` / `groupBy` / `orderBy` 等更新和查询链的统一表达

## 主结论

MyBatis-Plus 的 Wrapper 不是查询语法糖，而是一套运行时条件表达协议：

`AbstractWrapper`
  -> `MergeSegments`
  -> `paramNameSeq / paramNameValuePairs / SharedString`
    -> SQL segment + 参数占位

`AbstractLambdaWrapper`
  -> `LambdaUtils.extract(SFunction)`
    -> `SerializedLambda / IdeaProxyLambdaMeta / ReflectLambdaMeta / ShadowLambdaMeta`
  -> `ColumnCache`
    -> 属性名 -> 列名 / 列选择表达式

也就是说：

- `AbstractWrapper` 负责“条件怎样逐步长出来”
- `AbstractLambdaWrapper` 负责“字段怎样从 Lambda 变成列语义”

## 结构设计

1. 困惑开场：为什么 Wrapper 不是简单字符串 builder
2. 最小总图：`AbstractWrapper` + `AbstractLambdaWrapper` + `LambdaUtils`
3. `AbstractWrapper`：条件链、参数占位与 `MergeSegments`
4. `formatParam()` / `paramNameValuePairs`：为什么参数命名是协议的一部分
5. `AbstractLambdaWrapper`：为什么 Lambda 需要独立一层 wrapper
6. `LambdaUtils.extract()`：IDEA 代理 / 反射 / 序列化三路径
7. `ColumnCache` 与 `LambdaUtils.installCache()`：字段名为什么不应重复解析
8. `LambdaQueryWrapper / LambdaUpdateWrapper`：查询链与更新链的差异点
9. 失败路径：字段缓存缺失、Lambda 解析失败、非法顺序调用、`setSql` 注入边界
10. 收网：这篇立住的是“条件构造协议”，不是链式 API 目录
11. 下篇桥接：进入插件总线与 SQL 改写入口

## 必须回填的源码锚点

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:50` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:58` `paramNameSeq`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:63` `paramNameValuePairs`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:145` `eq(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:205` `between(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:418` `orderBy(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:544` `formatParam(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractWrapper.java:591` `initNeed()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractLambdaWrapper.java:39` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractLambdaWrapper.java:65` `columnToString(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractLambdaWrapper.java:120` `getColumnCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/AbstractLambdaWrapper.java:128` `tryInitCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/LambdaUtils.java:50` `extract(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/LambdaUtils.java:77` `formatKey(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/LambdaUtils.java:86` `installCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/LambdaUtils.java:96` `createColumnCacheMap(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/support/ColumnCache.java:27` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/query/LambdaQueryWrapper.java:109` `select(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/update/LambdaUpdateWrapper.java:78` `set(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/update/LambdaUpdateWrapper.java:86` `setSql(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/conditions/update/LambdaUpdateWrapper.java:111` `setIncrBy(...)`

## 必须引用的测试/证据

- `LambdaUtilsTest`
- `IdeaProxyLambdaMetaTest`
- `LambdaQueryWrapperTest`
- `LambdaUpdateWrapperTest`
- Kotlin `WrapperTest`（只作跨语言侧证）

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。