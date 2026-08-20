# 篇：01 配置启动与元数据构建

- 域：`M-1 配置启动与元数据构建`
- 卷：`vol-mybatis`
- 目标：在同一篇里回答“`mybatis-config.xml` 和 Mapper XML 是怎样被构造成一个可执行 `Configuration` 的”，而不是按 builder 包逐类翻译。

## 前置依赖

- 无。它是 MyBatis 全卷入口。

## 读者问题

为什么一个 `SqlSessionFactoryBuilder.build(reader)`，最后能得到一个装满 `MappedStatement`、`ResultMap`、`Cache`、`TypeHandler`、`MapperRegistry`、插件链和待解析队列的 `Configuration`？如果只说“XML 被解析成对象”，读者并不知道：

1. 配置文件的解析顺序为什么重要；
2. Mapper XML 为什么可以跨文件引用 cache/resultMap/sql fragment；
3. 不完整元素为什么不是立刻报错，而是挂到 pending 队列里；
4. 为什么重复 statement 会在 `Configuration.StrictMap` 里失败，而不是静默覆盖。

## 主结论

MyBatis 的启动不是“读 XML → 生成几个 POJO”，而是：

`SqlSessionFactoryBuilder.build()`
  → `XMLConfigBuilder.parse()`
    → `parseConfiguration()` 按固定顺序装配全局配置
      → `mappersElement()` 把每个 Mapper XML 交给 `XMLMapperBuilder.parse()`
        → 解析 cache/resultMap/sql/statement
          → 写入 `Configuration`
            → unresolved 元素进入 `incomplete*` 队列
              → `parsePending*()` 二次收束

也就是说，`Configuration` 不是解析结果容器，而是 MyBatis 运行时元数据中心。

## 结构设计

1. 困惑开场：为什么启动阶段不是“读配置文件”这么简单
2. 最小总图：`build()` → `parseConfiguration()` → `XMLMapperBuilder.parse()` → `Configuration`
3. `SqlSessionFactoryBuilder.build()`：入口、异常包装、资源关闭
4. `XMLConfigBuilder.parseConfiguration()`：顺序就是协议
5. `XMLMapperBuilder.parse()`：Mapper XML 如何进入 `Configuration`
6. `Configuration`：运行时元数据中心，而不是普通 DTO
7. `incompleteStatements/resultMaps/cacheRefs/methods`：为什么需要 pending 队列
8. `StrictMap`：为什么重复定义必须 fail-fast
9. 收网：这篇立住的是“配置启动协议”，不是 builder 类清单
10. 下篇桥接：进入 `MapperProxy`，解释接口调用如何落到这些元数据上

## 必须回填的源码锚点

- `session/SqlSessionFactoryBuilder.java:47` `build(Reader, String, Properties)`
- `session/SqlSessionFactoryBuilder.java:95` `build(Configuration)`
- `builder/xml/XMLConfigBuilder.java:105` `parse()`
- `builder/xml/XMLConfigBuilder.java:114` `parseConfiguration(XNode root)`
- `builder/xml/XMLConfigBuilder.java:131` `mappersElement(root.evalNode("mappers"))`
- `builder/xml/XMLMapperBuilder.java:96` `parse()`
- `builder/xml/XMLMapperBuilder.java:111` `configurationElement(XNode context)`
- `builder/xml/XMLMapperBuilder.java:123` `buildStatementFromContext(context.evalNodes("select|insert|update|delete"))`
- `session/Configuration.java:153` `mapperRegistry`
- `session/Configuration.java:159` `mappedStatements`
- `session/Configuration.java:168` `loadedResources`
- `session/Configuration.java:170` `incompleteStatements`
- `session/Configuration.java:173` `incompleteMethods`
- `session/Configuration.java:826` `addMappedStatement`
- `session/Configuration.java:964` `buildAllStatements()`
- `session/Configuration.java:973` `parsePendingMethods(boolean)`
- `session/Configuration.java:992` `parsePendingStatements(boolean)`
- `session/Configuration.java:1011` `parsePendingCacheRefs(boolean)`
- `session/Configuration.java:1029` `parsePendingResultMaps(boolean)`
- `session/Configuration.java:1111` `StrictMap.put`
- `session/Configuration.java:1138` `StrictMap.get`

## 必须引用的测试/证据

- `XMLConfigBuilderTest`：配置顺序与 settings 校验
- `duplicate_statements` 用例：重复 statement fail-fast
- `resolution/*` 相关 submitted 用例：pending 队列解决跨 mapper 引用

## note / review 约束

- note 只记录本篇主张、边界和后续桥接，不重写正文。
- review 必须覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。