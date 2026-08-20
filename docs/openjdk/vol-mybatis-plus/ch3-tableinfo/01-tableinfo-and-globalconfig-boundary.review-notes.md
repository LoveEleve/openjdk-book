# MP-3 表元数据解析与 GlobalConfig 边界 — review notes

## 事实审

- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:185`、`:221`、`:313`、`:472`、`:529`、`:607`，元数据初始化主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:220`、`:263`、`:475`，表级运行时语义成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:406`、`:556`、`:578`，字段级逻辑删除/结果映射/版本语义成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:47`、`:103`、`:235`，全局前缀、schema、strategy、逻辑删除、主键与 keyGenerators 等默认世界成立。
- 已补测试证据：`TableInfoHelperTest`、`TableInfoTest`、以及策略/版本/逻辑删除相关测试。

## 因果审

- 注入前先建 `TableInfo/TableFieldInfo`，再决定 CRUD 方法和 SQL 模板，正文成立。
- `GlobalConfig.DbConfig` 是元数据默认世界，而不是附属配置，正文成立。
- 主键、逻辑删除、版本字段等边界在元数据期前移暴露，这个判断成立。

## 结构审

- 从“不是边看注解边拼 SQL”切入，再落到 `TableInfoHelper`、`TableInfo/TableFieldInfo`、`DbConfig` 与失败路径，主线集中。
- 没有把注解列表平铺成手册，符合方法论。

## 读者审

- 读完应能回答：为什么 MP 需要单独维护 `TableInfo/TableFieldInfo`。
- 读完应能回答：为什么无主键、多个主键、逻辑删除/版本等问题必须在元数据期就处理。
- 读完后能自然进入 Wrapper / Lambda 专题，而不会把元数据和条件构造器混成一层。

## 边界审

- 本篇没有提前透支 Wrapper、自动填充、逻辑删除 SQL 改写细节。
- resultMap 与 key generator 只保留为元数据后果，不扩展成独立主线，边界成立。

## 依赖审

- 前置依赖：MP-1 核心桥替换、MP-2 SQL 自动注入。
- 后续桥接：MP-4 Wrapper / Lambda 条件构造器、MP-6 运行时增强专题组都成立。

## 结论

MP-3 已完成单域四件套的事实回填与六层审查，可进入下一核心主干域。