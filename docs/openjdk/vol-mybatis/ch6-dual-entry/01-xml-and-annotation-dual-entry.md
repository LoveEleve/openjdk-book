# 为什么 MyBatis 的 XML mapper 和注解 mapper 不是两套系统，而是双入口并回同一条元数据主线

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲 XML 与注解双入口：`MapperRegistry.addMapper()`、`MapperAnnotationBuilder.parse()`、`loadXmlResource()`、`parseStatement()` 与 `ProviderSqlSource` 如何把注解 mapper、provider mapper 和 XML mapper 收束回同一套 `MappedStatement/Configuration` 协议。不展开 Spring 集成。

## 为什么“XML 派”和“注解派”这个二分法会把源码关系读歪

很多人学 MyBatis 时，会自然形成一种二分印象：

- 要么用 XML mapper
- 要么用注解 mapper

于是很容易进一步推断：

- 这是两套并列实现路线

这个推断对使用层还勉强能忍，但一旦回到源码就会出大偏差。

因为 MyBatis 在内部并没有维护两套平行执行系统。它真正做的是：

- 允许 mapper 接口先作为入口进入注册协议
- 在注册阶段先尝试加载同名 XML 资源
- 再解析注解、provider、`@Results`、`@CacheNamespaceRef` 等结构
- 最终无论来自 XML、注解还是 provider，都要回到同一套 `MappedStatement` / `ResultMap` / `Cache` / `Configuration` 主线

也就是说，XML 和注解不是两条各跑各的流水线，而是：

**两条配置入口，最终并回同一条运行时元数据协议。**

## 双入口收束的最小总图

```text
Configuration.addMapper(type)
  -> MapperRegistry.addMapper(type)
    -> knownMappers.put(type, new MapperProxyFactory<>(type))
    -> MapperAnnotationBuilder.parse()
      -> loadXmlResource()
        -> XMLMapperBuilder.parse()   (如果找到同名 XML)
      -> parseCache() / parseCacheRef()
      -> parseResultMap(method)
      -> parseStatement(method)
        -> buildSqlSource(...)
          -> XML 字符串 SQL or ProviderSqlSource
        -> assistant.addMappedStatement(...)
```

这张图最重要的地方不是“先 XML 还是先注解”，而是：

1. mapper 接口注册只有一次
2. XML 只是注解入口里的一个前置尝试
3. 注解 statement 和 provider statement 最终都落到 `addMappedStatement(...)`

## 一、`MapperRegistry.addMapper()`：双入口真正的总开关在注册时，不在执行时

关键入口在：

- `binding/MapperRegistry.java:60` `addMapper(Class<T> type)`

它的步骤很值得慢一点看：

1. 只处理接口类型
2. 已注册就直接抛 `Type ... is already known to the MapperRegistry.`
3. 先把 `MapperProxyFactory` 放进 `knownMappers`
4. 再 new `MapperAnnotationBuilder(config, type)` 并 `parse()`
5. 如果 parse 没完成，finally 里把这个 type 从 `knownMappers` 撤掉

这说明“XML/注解双入口”真正的总开关不在某个 if/else，而在注册协议本身：

- 一个 mapper 接口只有一个注册入口
- 所有后续 XML/注解解析都挂在这次注册之下

也就是说，MyBatis 没有“一个 XML registry + 一个 annotation registry”，只有一套 `MapperRegistry`。

## 二、`MapperAnnotationBuilder.parse()`：注解入口并不排斥 XML，反而先主动尝试加载 XML

主入口在：

- `builder/annotation/MapperAnnotationBuilder.java:114` `parse()`
- `builder/annotation/MapperAnnotationBuilder.java:145` `loadXmlResource()`
- `builder/annotation/MapperAnnotationBuilder.java:169` `parseCache()`
- `builder/annotation/MapperAnnotationBuilder.java:191` `parseCacheRef()`
- `builder/annotation/MapperAnnotationBuilder.java:282` `parseStatement(Method method)`

`parse()` 的流程非常关键：

1. 看 `configuration.isResourceLoaded(resource)`
2. 如果没加载过，先 `loadXmlResource()`
3. 再 `configuration.addLoadedResource(resource)`
4. 再设置 namespace
5. 再解析 cache / cacheRef
6. 再遍历 mapper 方法，按需 `parseResultMap(method)` 和 `parseStatement(method)`
7. 解析失败的方法进入 `configuration.addIncompleteMethod(...)`
8. 最后 `configuration.parsePendingMethods(false)`

也就是说，注解入口不是“完全绕开 XML”，而是：

**先把同名 XML 当成一个可选前置资源尝试接进来，再继续走注解解析。**

这一下就把“双入口”的真实关系暴露出来了：

- XML 不是注解的对立面
- XML 是注解 mapper 注册流程中的一个前置输入源

## 三、`loadXmlResource()`：为什么说 XML 只是前置输入，而不是另一套平行管线

- `builder/annotation/MapperAnnotationBuilder.java:145` `loadXmlResource()`
- `builder/xml/XMLMapperBuilder.java:96` `parse()`

`loadXmlResource()` 做的事情很克制：

1. 先看 `configuration.isResourceLoaded("namespace:" + type.getName())`
2. 组出同名 XML 资源路径
3. 先尝试 `type.getResourceAsStream("/" + xmlResource)`
4. 再尝试 classpath 里的 `Resources.getResourceAsStream(...)`
5. 如果真找到了，就构造 `XMLMapperBuilder(..., type.getName())` 然后 `parse()`

这说明它不是在说：

- 现在切换到另一套 XML 世界

而是在说：

- 如果这个 mapper 对应的 XML 存在，就把它也纳入当前 mapper 注册上下文

所以这里的 XML 不是独立平行管线，而是同一 mapper 注册协议中的一段前置装配。

## 四、`parseStatement()`：无论注解 SQL 还是 provider SQL，最后都并回 `assistant.addMappedStatement(...)`

- `builder/annotation/MapperAnnotationBuilder.java:282` `parseStatement(Method method)`
- `builder/annotation/MapperAnnotationBuilder.java:573` `buildSqlSource(...)`

`parseStatement()` 真正让双入口并流的地方就在这里。

它不关心“你最初是 XML 用户还是注解用户”，它只关心：

- 当前方法最后能不能产出一个 `SqlSource`
- 当前语义是什么 `SqlCommandType`
- `Options`、`ResultMap`、`KeyGenerator`、`statementType`、`fetchSize`、`timeout`、`flushCache`、`useCache` 等参数怎么落下去

一旦这些信息齐了，最终都会走：

- `assistant.addMappedStatement(...)`

这说明从运行时元数据角度看，注解 SQL 不是另一种 statement 体系，而是：

**另一种生成 `SqlSource + MappedStatement` 的入口。**

## 五、`ProviderSqlSource`：provider 不是动态 SQL 的旁门，而是注解入口的一种 SQL 生成后端

关键点在：

- `builder/annotation/ProviderSqlSource.java:36` 类声明
- `builder/annotation/ProviderSqlSource.java:100` 构造逻辑
- `builder/annotation/ProviderSqlSource.java:163` `getBoundSql(Object parameterObject)`
- `builder/annotation/ProviderSqlSource.java:169` `createSqlSource(Object parameterObject)`
- `builder/annotation/ProviderSqlSource.java:243` `invokeProviderMethod(...)`
- `builder/annotation/ProviderSqlSource.java:252` `getProviderType(...)`

它要做的事情不是“再造一套执行器”，而是：

1. 找 provider type/value
2. 决定 provider method 名称
3. 如果实现了 `ProviderMethodResolver`，允许运行时解析目标方法
4. 校验 provider method 是否存在、是否重载冲突、参数组合是否合法
5. 调 provider method 生成 SQL 字符串
6. 再交给 `languageDriver.createSqlSource(...)`

这就说明 provider SQL 的位置其实很明确：

- 它不是注解 mapper 之外的第三套入口
- 它是注解入口里“如何生成 SqlSource”的一种后端

换句话说：

**provider 是注解入口的 SQL 生成分支，不是与 XML/注解平级的第三世界。**

## 六、失败路径：为什么双入口专题真正值钱的是“冲突怎么暴露”，而不是“都能用”

这一篇真正重要的地方，不在 happy path，而在冲突边界。

### 1. mapper 重复注册

`MapperRegistry.addMapper()` 直接 fail-fast。

### 2. XML 与注解重复定义

`duplicate_statements` 相关测试说明，最终冲突会在同一套 `MappedStatement` 主线里暴露，而不是各自偷偷覆盖。

### 3. default method

`MapperAnnotationBuilder.canHaveStatement(method)` 直接排除 default method，这和 `M-2` 的 `MapperProxy` default method 分支是对齐的。

### 4. provider method 不存在 / 重载冲突 / 参数组合非法

`ProviderSqlSource` 全部会抛 `BuilderException`，不会静默退化。

### 5. 泛型 mapper 的参数/返回值推断

`mapper_type_parameter` 测试说明注解入口在泛型场景下并不是拍脑袋解析参数与返回值。

所以双入口真正值钱的不是“XML 和注解都支持”，而是：

**它们如何在并流点之前保留各自语义，又如何在并流点之后统一按同一套元数据协议 fail-fast。**

## 到这里，M-9 真正立住的不是两种写法，而是“一套元数据协议的双入口”

如果只从表面看，这篇很容易被读成：

- XML mapper 是一种写法
- 注解 mapper 是另一种写法
- provider 又是另一种写法

这种读法会把真正的架构关系全部打散。

更稳的理解方式应该是：

1. mapper 接口先进入 `MapperRegistry` 的统一注册协议
2. `MapperAnnotationBuilder.parse()` 先尝试吸收同名 XML
3. XML、注解、provider 最后都要生成 `SqlSource` 并落到 `assistant.addMappedStatement(...)`
4. 冲突、缺失、重复定义也都在这一套统一元数据协议上 fail-fast

所以这篇真正立住的是：

**MyBatis 并不是同时维护 XML 系统和注解系统，而是允许两条入口并回同一条元数据主线。**

## 这篇之后，最自然的继续方向

到这里，MyBatis 核心与机制补深层已经基本闭合。接下来最自然的继续方向就是：

- `S-1`：MyBatis 进入 Spring 之后，`SqlSessionTemplate`、`SqlSessionUtils`、`SpringManagedTransaction` 如何接管会话责任
- `S-2`：在 Spring Boot 下，`MybatisAutoConfiguration` 如何把这一切自动装起来

也就是说，下一步应进入 `S-1 MyBatis 与 Spring 的会话/事务桥`。