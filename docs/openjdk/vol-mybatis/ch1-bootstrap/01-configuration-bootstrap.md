# 为什么 MyBatis 的启动不是“读 XML”，而是在搭一座运行时元数据中心

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲配置启动：`SqlSessionFactoryBuilder`、`XMLConfigBuilder`、`XMLMapperBuilder` 如何把 XML、注解入口和未完成引用收束成一个可执行的 `Configuration`。不展开 `MapperProxy`、执行器与 Spring 集成。

## 为什么“把 XML 解析成对象”这个说法太轻了

很多人第一次看 MyBatis 启动时，会把它理解成一件很轻的事：

- 读取 `mybatis-config.xml`
- 读取若干 `Mapper.xml`
- 把它们转成一些 Java 对象
- 然后运行时按需查表

这当然不算错，但它会把真正关键的东西读扁。

因为启动阶段真正建立起来的，不是几个对象，而是一整套运行时元数据协议：

- 哪些 mapper 已经加载过
- 哪些 `MappedStatement` 已经可用
- 哪些 `resultMap` / `cache-ref` / 注解方法现在还不能立刻解析
- 如果两个 namespace 里出现同名短 key，为什么会变成歧义
- 为什么某些 XML 可以跨文件引用，而不是要求“先声明后使用”

如果你只把这一步叫“读 XML”，后面看到 `Configuration` 里那一大堆 registry、map、`incomplete*` 队列和 `StrictMap` 时，就很容易误以为那只是实现细节。

更准确的说法应该是：

**MyBatis 启动阶段在做的，是把离散的配置片段收束成一个可执行的运行时元数据中心。**

## 启动阶段的最小总图

```text
SqlSessionFactoryBuilder.build(reader)
  -> XMLConfigBuilder.parse()
    -> parseConfiguration(root)
      -> settings / aliases / plugins / env / typeHandlers / mappers
        -> XMLMapperBuilder.parse()
          -> cache / resultMap / sql / statements
            -> Configuration
              -> mappedStatements / resultMaps / caches / mapperRegistry
              -> incompleteStatements / incompleteResultMaps / incompleteCacheRefs / incompleteMethods
```

这张图最重要的地方，不是类名，而是两个动作：

1. 已经能解析的内容立刻入 `Configuration`
2. 还不能解析的内容先挂起，等后续 `parsePending*()` 二次收束

## 一、`SqlSessionFactoryBuilder.build()`：入口看起来很薄，但它定义了启动的收束方式

入口就是 `SqlSessionFactoryBuilder`：

- `session/SqlSessionFactoryBuilder.java:47` `build(Reader, String, Properties)`
- `session/SqlSessionFactoryBuilder.java:95` `build(Configuration)`

这里最容易被忽略的，不是“调用了 `XMLConfigBuilder`”，而是它同时做了三件事：

1. 构造 `XMLConfigBuilder`
2. 把任何启动期异常统一包装成 `Error building SqlSession.`
3. 在 `finally` 里重置 `ErrorContext` 并关闭 `Reader` / `InputStream`

也就是说，`SqlSessionFactoryBuilder` 自己不负责解析配置细节，但它负责把启动入口的资源边界和异常收束立住。

如果这一步只写成“创建 `DefaultSqlSessionFactory`”，读者就会漏掉一个事实：**MyBatis 从入口开始就在控制错误上下文和资源关闭，而不是把这些责任散落到调用方。**

## 二、`XMLConfigBuilder.parseConfiguration()`：顺序不是实现偏好，而是启动协议

真正的全局配置装配发生在：

- `builder/xml/XMLConfigBuilder.java:105` `parse()`
- `builder/xml/XMLConfigBuilder.java:114` `parseConfiguration(XNode root)`

`parseConfiguration()` 里面的顺序非常关键：

- `properties`
- `settings`
- `typeAliases`
- `plugins`
- `objectFactory` / `objectWrapperFactory` / `reflectorFactory`
- `environments`
- `databaseIdProvider`
- `typeHandlers`
- `mappers`

证据：`builder/xml/XMLConfigBuilder.java:114`

这不是“想到什么读什么”。例如：

- `properties` 必须先读，因为后面的很多节点都可能依赖占位符替换
- `settings` 要在 objectFactory 等组件准备好之后真正落到 `Configuration`
- `databaseIdProvider` 要在 mapper 解析前确定，否则 statement 的数据库方言筛选没有基准
- `mappers` 放在最后，因为它们会消耗前面已经装好的 aliases、plugins、typeHandlers、environment 等全局状态

所以这里真正要记住的不是几个方法名，而是：

**MyBatis 的配置加载顺序本身就是运行时语义的一部分。**

## 三、`XMLMapperBuilder.parse()`：Mapper XML 不是孤立解析，而是往 `Configuration` 里增量建图

每个 mapper 文件都由 `XMLMapperBuilder` 负责：

- `builder/xml/XMLMapperBuilder.java:96` `parse()`
- `builder/xml/XMLMapperBuilder.java:111` `configurationElement(XNode context)`
- `builder/xml/XMLMapperBuilder.java:123` `buildStatementFromContext(context.evalNodes("select|insert|update|delete"))`

它的主线是：

1. 先检查 `configuration.isResourceLoaded(resource)`，避免重复装载
2. 进入 `configurationElement()`，按 namespace 解析 `cache-ref`、`cache`、`parameterMap`、`resultMap`、`sql`、`statement`
3. 成功后 `configuration.addLoadedResource(resource)`
4. 调用 `bindMapperForNamespace()` 把 namespace 和 mapper 接口绑定起来
5. 最后执行 `parsePendingResultMaps(false)`、`parsePendingCacheRefs(false)`、`parsePendingStatements(false)`

最重要的是第 5 步。

它说明 MyBatis 对 mapper 的理解不是“一个文件必须一次性完全解析完”，而是“允许先落一部分，再回头补 unresolved 元素”。

这就是为什么跨 mapper 的 `cache-ref`、复杂 `resultMap` 依赖和某些 XML 先后顺序问题没有直接把系统变成“严格单通道顺序编译器”。

## 四、`Configuration`：它不是配置对象，而是 MyBatis 的运行时元数据中心

真正的状态中心在 `Configuration`：

- `session/Configuration.java:153` `mapperRegistry`
- `session/Configuration.java:159` `mappedStatements`
- `session/Configuration.java:168` `loadedResources`
- `session/Configuration.java:170` `incompleteStatements`
- `session/Configuration.java:173` `incompleteMethods`

这几个字段放在一起看，就会明白它不是普通 DTO：

- `mapperRegistry`：接口入口在哪里
- `mappedStatements`：真正执行 SQL 的主索引
- `resultMaps` / `parameterMaps` / `caches` / `keyGenerators`：执行时要查的元数据配套
- `loadedResources`：哪些配置片段已经消化过
- `sqlFragments`：可复用 SQL 片段库
- `incompleteStatements` / `incompleteCacheRefs` / `incompleteResultMaps` / `incompleteMethods`：未完成解析队列

也就是说，启动阶段的终点不是“建完工厂”，而是：

**把所有运行时会被查询、补解析、去重、判歧义的元数据，统一压进 `Configuration`。**

## 五、为什么需要 `incomplete*` 队列：因为 MyBatis 面对的是分散声明，不是单文件脚本

`Configuration` 里有四类 pending 队列：

- `session/Configuration.java:170` `incompleteStatements`
- `session/Configuration.java:171` `incompleteCacheRefs`
- `session/Configuration.java:172` `incompleteResultMaps`
- `session/Configuration.java:173` `incompleteMethods`

它们后面对应的二次收束方法是：

- `session/Configuration.java:973` `parsePendingMethods(boolean)`
- `session/Configuration.java:992` `parsePendingStatements(boolean)`
- `session/Configuration.java:1011` `parsePendingCacheRefs(boolean)`
- `session/Configuration.java:1029` `parsePendingResultMaps(boolean)`

这套设计回答的是一个非常实际的问题：

**如果某个 mapper 在当前时刻还缺依赖，系统是立刻死掉，还是先记账，等依赖具备后再补？**

MyBatis 的答案是后者。

例如：

- 注解 mapper 的 `parseStatement()` 失败时，会 `addIncompleteMethod(...)`
- XML mapper 的 statement 失败时，会 `addIncompleteStatement(...)`
- `cache-ref` 和复杂 `resultMap` 也都允许暂缓

这使得 MyBatis 可以处理“定义分散在不同文件、不同入口、不同阶段才逐步就绪”的配置现实，而不是强迫用户把所有东西塞进一个严格排序的单文件里。

## 六、`StrictMap`：为什么 MyBatis 要在启动期就 fail-fast

另一个容易被忽略、但对读者非常关键的点，是 `Configuration.StrictMap`：

- `session/Configuration.java:1111` `StrictMap.put`
- `session/Configuration.java:1138` `StrictMap.get`

它的语义非常强：

1. 完整 key 已存在时，直接抛异常，不允许静默覆盖
2. 如果 key 带 namespace，就同时登记 short key
3. 一旦 short key 重名，就写入 `Ambiguity`
4. 之后通过 short key 读取时，直接报“ambiguous”错误

这说明 MyBatis 启动期不是宽松合并配置，而是尽量早地把歧义和重复定义炸出来。

所以像 `duplicate_statements` 这类测试并不是边角料，它们在证明一件事：

**启动阶段不仅负责“装配”，还负责“拒绝不可靠的装配”。**

## 到这里，M-1 真正立住的不是三个 builder，而是“配置启动协议”

如果只从类名看，这一篇很容易被误读成：

- `SqlSessionFactoryBuilder` 做什么
- `XMLConfigBuilder` 做什么
- `XMLMapperBuilder` 做什么
- `Configuration` 有哪些字段

这种读法会把核心骨架拆散。

更稳的理解方式应该是：

1. `SqlSessionFactoryBuilder` 负责启动入口的异常和资源收束
2. `XMLConfigBuilder.parseConfiguration()` 用固定顺序组装全局能力
3. `XMLMapperBuilder.parse()` 把每个 mapper 作为增量输入写入 `Configuration`
4. `Configuration` 同时保存已完成元数据与未完成依赖
5. `StrictMap` 和 `parsePending*()` 共同保证“既能延迟收束，又能 fail-fast”

所以这篇真正立住的不是 builder 包，而是：

**MyBatis 的启动是一套把分散配置收束成运行时元数据中心的协议。**

## 这篇之后，最自然的继续方向

启动协议立住后，下一步最自然的问题就是：

- `Mapper` 接口没有实现，为什么一调用就能找到对应的 `MappedStatement`？

也就是说，下一篇应该进入 `M-2 MapperProxy 动态代理与调用语义`。