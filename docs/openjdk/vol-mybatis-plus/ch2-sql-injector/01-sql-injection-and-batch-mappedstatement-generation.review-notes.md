# MP-2 SQL 自动注入与 MappedStatement 批量生成 — review notes

## 事实审

- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractSqlInjector.java:43`、`:92`，注入入口与方法清单入口成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/DefaultSqlInjector.java:38`，默认 CRUD 方法清单与主键分支成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/injector/AbstractMethod.java:82`、`:421`、`:446`，方法模板如何落到 `MappedStatement` 主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/GlobalConfigUtils.java:88`、`:106`、`:126`，全局注入器与 mapperRegistryCache 边界成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:163`、`:369`、`:558`，`BaseMapper` 只是能力目录而非生成逻辑主体这一判断成立。
- 已补测试证据：`MybatisMapperAnnotationBuilderTest`、`MybatisConfigurationTest`、`MybatisParameterHandlerTest`、`TableInfoHelperTest`。

## 因果审

- SQL 自动注入是挂在 `MP-1` 注册桥之后执行的，这个因果关系成立。
- `inspectInject()` 先拿表元数据再决定方法清单，说明 CRUD 不是固定模板，而是受实体条件约束，正文成立。
- `AbstractMethod` 真正承担 statement 生成职责，而 `BaseMapper` 只是对外能力目录，正文成立。
- `GlobalConfig` 是注入器与缓存边界的总开关，正文成立。

## 结构审

- 从“CRUD 不是接口自带实现”切入，再落到注入时机、方法清单、方法模板、全局状态与失败路径，主线集中。
- 没有把 CRUD 清单罗列成文档主体，符合方法论。

## 读者审

- 读完应能回答：为什么没有 XML 也能直接拥有一批 CRUD statement。
- 读完应能回答：为什么无主键实体不会拥有完整 `xxById` 系列方法。
- 读完后能自然进入 `MP-3`，而不会把注入决策和表元数据混成一层。

## 边界审

- 本篇没有提前透支表元数据细节、分页插件或逻辑删除等专题。
- `BaseMapper` 只作为能力目录出场，边界成立。

## 依赖审

- 前置依赖：MP-1 核心桥替换协议。
- 后续桥接：MP-3 表元数据、MP-6 具体增强家族都成立。

## 结论

MP-2 已完成单域四件套的事实回填与六层审查，可进入下一核心主干域。