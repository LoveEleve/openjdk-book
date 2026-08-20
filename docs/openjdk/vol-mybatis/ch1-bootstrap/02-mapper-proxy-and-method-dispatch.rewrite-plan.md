# 篇：02 MapperProxy 动态代理与方法分发

- 域：`M-2 Mapper 接口代理与调用语义`
- 卷：`vol-mybatis`
- 目标：回答“为什么接口没有实现，却能在运行时变成 SQL 调用”，并把 default method、method cache、返回类型分发和异常边界说清。

## 前置依赖

- HARD：已读 `M-1`，知道 `Configuration` 里已经有 `MappedStatement`、`MapperRegistry` 等元数据。

## 读者问题

为什么 `sqlSession.getMapper(UserMapper.class)` 返回的不是某个具体实现类，却依然能：

1. 根据方法名找到对应 statement；
2. 区分 `selectOne`、`selectList`、`selectMap`、`selectCursor`、`flushStatements`；
3. 兼容接口 default method；
4. 在方法签名和 SQL 结果不匹配时 fail-fast。

## 主结论

MyBatis 并不是“给每个 Mapper 生成一个完整实现类”，而是：

`Configuration.getMapper(type, sqlSession)`
  → `MapperRegistry.getMapper()`
    → `MapperProxyFactory.newInstance(sqlSession)`
      → JDK Proxy + `MapperProxy.invoke()`
        → `methodCache`
          → `MapperMethod`
            → `SqlCommand` + `MethodSignature`
              → `SqlSession.insert/update/delete/select*`

也就是说，Mapper 调用语义不是写在接口实现类里，而是被拆成：

- `MapperRegistry`：这个接口是否已知
- `MapperProxyFactory`：如何生成代理
- `MapperProxy`：如何拦截方法并缓存调用器
- `MapperMethod`：如何把方法签名映射成真正的 `SqlSession` 调用

## 结构设计

1. 困惑开场：为什么一个接口没有实现也能执行 SQL
2. 最小总图：`getMapper()` → `MapperProxy` → `MapperMethod`
3. `MapperRegistry`：已知 mapper、注册时机与 fail-fast
4. `MapperProxyFactory`：JDK 代理与 methodCache
5. `MapperProxy.invoke()`：Object 方法、default method、缓存 invoker 三岔路
6. `MapperMethod.execute()`：按 `SqlCommandType` 和返回类型分发
7. `SqlCommand` / `MethodSignature`：statement 解析、参数签名、RowBounds/ResultHandler/Optional/Map/Cursor
8. 失败路径：未注册 mapper、statement 不存在、primitive 返回 null、重复 ResultHandler/RowBounds
9. 收网：这篇立住的是“接口调用协议”，不是代理语法
10. 下篇桥接：进入 `SqlSession` / `Executor` 生命周期

## 必须回填的源码锚点

- `binding/MapperRegistry.java:41` `getMapper(Class<T>, SqlSession)`
- `binding/MapperRegistry.java:58` `addMapper(Class<T>)`
- `binding/MapperProxyFactory.java:31` `methodCache`
- `binding/MapperProxyFactory.java:47` `newInstance(MapperProxy<T>)`
- `binding/MapperProxyFactory.java:51` `newInstance(SqlSession)`
- `binding/MapperProxy.java:80` `invoke(Object proxy, Method method, Object[] args)`
- `binding/MapperProxy.java:92` `cachedInvoker(Method method)`
- `binding/MapperProxy.java:114` `getMethodHandleJava9(Method method)`
- `binding/MapperMethod.java:52` 构造函数
- `binding/MapperMethod.java:57` `execute(SqlSession, Object[] args)`
- `binding/MapperMethod.java:87` `executeWithResultHandler(...)`
- `binding/MapperMethod.java:101` `executeForMany(...)`
- `binding/MapperMethod.java:120` `executeForCursor(...)`
- `binding/MapperMethod.java:146` `executeForMap(...)`
- `binding/MapperMethod.java:181` `SqlCommand` 构造与 `resolveMappedStatement(...)`
- `binding/MapperMethod.java:269` `MethodSignature` 构造
- `binding/MapperMethod.java:316` `returnsOptional()`
- `binding/MapperMethod.java:323` `getUniqueParamIndex(...)`

## 必须引用的测试/证据

- default method submitted 用例：证明 default method 分支真实存在
- `TooManyResultsException` / primitive 返回 null 相关测试：证明返回值边界
- mapper 注册与 statement 缺失异常：证明 fail-fast 语义

## note / review 约束

- note 只记录本篇主张、边界和下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 全部 `file:line` 在写作时重新核对。