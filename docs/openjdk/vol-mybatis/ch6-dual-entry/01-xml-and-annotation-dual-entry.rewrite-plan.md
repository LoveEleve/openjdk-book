# 篇：01 XML 与注解 Mapper 双入口

- 域：`M-9 XML 与注解 Mapper 双入口`
- 卷：`vol-mybatis`
- 目标：回答 XML mapper、注解 mapper 与 provider mapper 如何作为三种输入，并回同一套 `MappedStatement/Configuration` 主线，而不是被误读成三套并列系统。

## 前置依赖

- HARD：已读 `M-1`、`M-2`、`M-6`。

## 读者问题

为什么 MyBatis 明明支持 XML mapper、注解 mapper、`@SelectProvider` 这三种表面差异很大的写法，但运行时却没有三套平行执行系统？以及：

1. 为什么 mapper 注册入口只有一个
2. 为什么注解 mapper 会先尝试加载同名 XML
3. 为什么 provider 只是注解入口里的 SQL 生成分支
4. 为什么冲突和重复定义会在同一套 `MappedStatement` 主线里 fail-fast

## 主结论

`Configuration.addMapper(type)`
  -> `MapperRegistry.addMapper(type)`
    -> `knownMappers.put(type, new MapperProxyFactory<>(type))`
    -> `MapperAnnotationBuilder.parse()`
      -> `loadXmlResource()`
        -> `XMLMapperBuilder.parse()`  (如果找到同名 XML)
      -> `parseCache()` / `parseCacheRef()` / `parseResultMap()` / `parseStatement()`
        -> `buildSqlSource(...)`
          -> 直接注解 SQL 或 `ProviderSqlSource`
        -> `assistant.addMappedStatement(...)`

也就是说：

- mapper 只有一套注册协议
- XML 是注解入口里的前置输入
- provider 是注解入口里的 SQL 生成后端
- 这三路输入最终都并回 `MappedStatement/Configuration`

## 结构设计

1. 困惑开场：为什么 XML 派 / 注解派 的二分法会读歪源码
2. 最小总图：`addMapper()` -> `MapperAnnotationBuilder.parse()` -> `loadXmlResource()` -> `parseStatement()`
3. `MapperRegistry.addMapper()`：统一注册入口
4. `MapperAnnotationBuilder.parse()`：双入口并流编排器
5. `loadXmlResource()`：同名 XML 为何只是前置输入
6. `parseStatement()`：注解 SQL 最终如何并回 `addMappedStatement(...)`
7. `ProviderSqlSource`：provider 为什么只是注解入口里的 SQL 生成分支
8. 失败路径：重复注册、重复 statement、default method、provider method 冲突、泛型参数推断
9. 收网：这篇立住的是“一套元数据协议的双入口”
10. 下篇桥接：进入 S-1 Spring 会话/事务桥

## 必须回填的源码锚点

- `binding/MapperRegistry.java:60` `addMapper(Class<T> type)`
- `builder/annotation/MapperAnnotationBuilder.java:114` `parse()`
- `builder/annotation/MapperAnnotationBuilder.java:145` `loadXmlResource()`
- `builder/annotation/MapperAnnotationBuilder.java:169` `parseCache()`
- `builder/annotation/MapperAnnotationBuilder.java:191` `parseCacheRef()`
- `builder/annotation/MapperAnnotationBuilder.java:282` `parseStatement(Method method)`
- `builder/annotation/MapperAnnotationBuilder.java:573` `buildSqlSource(...)`
- `builder/xml/XMLMapperBuilder.java:96` `parse()`
- `builder/annotation/ProviderSqlSource.java:36` 类声明
- `builder/annotation/ProviderSqlSource.java:100` 构造逻辑
- `builder/annotation/ProviderSqlSource.java:163` `getBoundSql(Object parameterObject)`
- `builder/annotation/ProviderSqlSource.java:169` `createSqlSource(Object parameterObject)`
- `builder/annotation/ProviderSqlSource.java:243` `invokeProviderMethod(...)`
- `builder/annotation/ProviderSqlSource.java:252` `getProviderType(...)`

## 必须引用的测试/证据

- `duplicate_statements`
- `default_method`
- `mapper_type_parameter`
- `ProviderMethodResolutionTest` / `SqlProviderTest`

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。