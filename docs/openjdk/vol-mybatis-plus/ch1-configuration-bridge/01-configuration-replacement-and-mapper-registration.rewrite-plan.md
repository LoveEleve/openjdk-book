# 篇：01 Configuration 替换与 Mapper 注册桥

- 域：`MP-1 Configuration 替换与 Mapper 注册桥`
- 卷：`vol-mybatis-plus`
- 目标：回答 MyBatis-Plus 是怎样在不推翻 MyBatis 核心的前提下，替换掉 `Configuration / MapperRegistry / MapperAnnotationBuilder / SqlSessionFactoryBuilder` 四个关键桥，并把增强能力挂到已有主线上。

## 前置依赖

- 无。它是 `vol-mybatis-plus` 的卷入口。

## 读者问题

为什么 MyBatis-Plus 明明是“增强工具”，却可以直接影响：

1. `SqlSessionFactory` 的构造
2. mapper 接口的注册与移除
3. `MappedStatement` 的覆盖优先级
4. 默认驼峰、默认 enum handler、默认 language driver
5. 后续 SQL 注入、表元数据解析和插件装配的入口

## 主结论

MyBatis-Plus 不是在 MyBatis 外面再包一层 DSL，而是先替换掉核心桥节点：

`MybatisSqlSessionFactoryBuilder.build(configuration)`
  -> `MybatisConfiguration`
    -> `MybatisMapperRegistry`
      -> `MybatisMapperAnnotationBuilder.parse()`
        -> `parserInjector()`

也就是说，MyBatis-Plus 的第一层增强，不在 `BaseMapper` API，也不在分页插件，而在：

- 改造 `Configuration` 默认值与 `StrictMap`
- 改造 mapper 注册协议
- 改造 annotation builder，在注册流程中插入 SQL 注入与拦截忽略缓存
- 在工厂构造时灌入 `GlobalConfig`、`IdentifierGenerator`、`SqlRunnerInjector`

## 结构设计

1. 困惑开场：为什么 MP 不是“加几个插件”而是先替换核心桥
2. 最小总图：`MybatisSqlSessionFactoryBuilder` -> `MybatisConfiguration` -> `MybatisMapperRegistry` -> `MybatisMapperAnnotationBuilder`
3. `MybatisSqlSessionFactoryBuilder.build(configuration)`：全局配置、ID 生成器、SqlRunner 注入
4. `MybatisConfiguration`：默认驼峰、枚举 handler、language driver、StrictMap 与 mapper 变更入口
5. `MybatisMapperRegistry.addMapper()`：为什么 MP 要自己控制 mapper 注册与 remove
6. `MybatisMapperAnnotationBuilder.parse()`：为什么 mapper 解析时就会预埋后续注入入口
7. `parserInjector()`：MP 核心增强怎样挂到注册流程上
8. 失败路径：重复 mapper、重复 statement、动态替换 mapper、与原生配置冲突
9. 收网：这篇立住的是“核心桥替换协议”，不是功能清单
10. 下篇桥接：进入 SQL 自动注入与 `MappedStatement` 批量生成

## 必须回填的源码锚点

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisSqlSessionFactoryBuilder.java:80` `build(Configuration configuration)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:58` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:90` 构造函数
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:104` `addMappedStatement(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:127` `addMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:149` `removeMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:444` `StrictMap.put(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:472` `StrictMap.get(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperRegistry.java:46` `getMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperRegistry.java:76` `addMapper(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:87` `parse()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:125` `parserInjector()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:135` `loadXmlResource()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:271` `parseStatement(Method method)`

## 必须引用的测试/证据

- `MybatisConfigurationTest`
- `MybatisMapperAnnotationBuilderTest`
- `MybatisParameterHandlerTest`（只作为后续桥的外部证据）
- `TableInfoHelperTest`（只作为后续桥的外部证据）

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。