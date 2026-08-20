# 篇：01 表元数据解析与 GlobalConfig 边界

- 域：`MP-3 表元数据解析与 GlobalConfig 边界`
- 卷：`vol-mybatis-plus`
- 目标：回答实体类上的 `@TableName/@TableId/@TableField/@TableLogic/@Version` 等信息，是怎样被解析成 `TableInfo / TableFieldInfo` 与 `GlobalConfig.DbConfig` 主导的运行时元数据，并进一步影响 SQL 注入与运行时行为的。

## 前置依赖

- HARD：已读 `MP-1`、`MP-2`，知道核心桥替换与 SQL 自动注入主线。

## 读者问题

为什么 MyBatis-Plus 在真正注入 CRUD 前，必须先建立一套 `TableInfo` 体系？以及：

1. 实体类表名、字段、主键、逻辑删除、版本号、排序字段怎么被解析
2. 为什么 `GlobalConfig.DbConfig` 会深度影响表名、字段策略和主键行为
3. 自动生成 resultMap 与 Lambda cache 为什么会在元数据解析阶段就发生
4. 为什么“没有主键”“多个主键”“逻辑删除与版本字段”等都是元数据期就要处理的问题

## 主结论

MyBatis-Plus 的表元数据不是注入阶段顺手查几个注解，而是一套先于注入建立的运行时语义中心：

`TableInfoHelper.initTableInfo(...)`
  -> `initTableName(...)`
  -> `initTableFields(...)`
    -> `initTableIdWithAnnotation()` / `initTableIdWithoutAnnotation()`
  -> `tableInfo.initResultMapIfNeed()`
  -> `LambdaUtils.installCache(tableInfo)`

同时：

- `GlobalConfig.DbConfig` 提供全局默认世界
- `TableInfo` 承载表级运行时语义
- `TableFieldInfo` 承载字段级运行时语义

所以 MP 的注入、Wrapper、逻辑删除、自动填充、乐观锁，都会先吃这套元数据，而不是直接吃注解本身。

## 结构设计

1. 困惑开场：为什么 MP 不是边解析注解边临时拼 SQL
2. 最小总图：`TableInfoHelper` -> `TableInfo/TableFieldInfo` -> `GlobalConfig.DbConfig`
3. `initTableInfo(...)`：为什么元数据解析一定发生在注入前
4. `initTableName(...)`：表名、前缀、schema、autoResultMap 的判定
5. `initTableFields(...)`：字段列表、主键、逻辑删除、排序与字段策略
6. `initTableIdWithAnnotation()` / `initTableIdWithoutAnnotation()`：主键识别边界
7. `TableInfo` 与 `TableFieldInfo`：为什么它们是运行时语义载体，而不是注解镜像
8. `GlobalConfig.DbConfig`：默认策略如何影响表与字段世界
9. 失败路径：多个主键、无主键、逻辑删除/版本冲突、排除字段与 autoResultMap 边界
10. 收网：这篇立住的是“元数据语义中心”，不是注解清单
11. 下篇桥接：进入 Wrapper / Lambda 条件构造器

## 必须回填的源码锚点

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:185` `initTableInfo(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:221` `initTableName(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:313` `initTableFields(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:472` `initTableIdWithAnnotation(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:529` `initTableIdWithoutAnnotation(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:607` `getAllFields(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:220` `havePK()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:263` `chooseSelect(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:475` `initResultMapIfNeed()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:406` `initLogicDelete(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:556` `getResultMapping(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:578` `getVersionOli()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:47` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:103` `DbConfig`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:235` `getWhereStrategy()`

## 必须引用的测试/证据

- `TableInfoHelperTest`
- `TableInfoTest`
- `MybatisConfigurationTest`（autoResultMap/短 key 等侧证）
- 逻辑删除、版本、策略相关测试用例

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。