# 为什么 MyBatis 不给 Mapper 生成实现类，却照样能执行 SQL

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲 Mapper 接口代理：`MapperRegistry`、`MapperProxyFactory`、`MapperProxy`、`MapperMethod` 如何把一个没有实现的接口方法变成 `SqlSession` 调用。不展开执行器、结果映射与 Spring 集成。

## 为什么“JDK 动态代理”这个答案还不够

很多人问 MyBatis：

- 接口没有实现，为什么 `getMapper()` 还能返回可调用对象？

最常见的回答是：

- 因为它用了 JDK 动态代理。

这当然没错，但它几乎没有回答真正的问题。

因为动态代理只解释了“方法会被拦截”，并没有解释：

- 拦截之后，怎么知道该执行哪个 `MappedStatement`
- 为什么 `selectList`、`selectMap`、`selectCursor`、`flushStatements` 会走不同分支
- default method 为什么不会被当成 SQL 方法
- 如果 mapper 没注册、statement 不存在、primitive 返回了 null，系统为什么能立刻 fail-fast

所以这篇真正要回答的不是“代理是怎么生成的”，而是：

**一个 Mapper 接口方法，怎样被分解成注册、代理、缓存、签名解析和最终 `SqlSession` 调用这整套协议。**

## Mapper 代理的最小总图

```text
sqlSession.getMapper(UserMapper.class)
  -> Configuration.getMapper(type, sqlSession)
    -> MapperRegistry.getMapper()
      -> MapperProxyFactory.newInstance(sqlSession)
        -> JDK Proxy
          -> MapperProxy.invoke()
            -> cachedInvoker(method)
              -> MapperMethod.execute(sqlSession, args)
                -> SqlSession.insert/update/delete/select*
```

这个总图里最关键的不是“用了 Proxy”，而是：

- `MapperRegistry` 负责确认这个 mapper 是否存在
- `MapperProxyFactory` 负责生成代理并持有 `methodCache`
- `MapperProxy` 负责把一次 `Method` 调用路由到正确 invoker
- `MapperMethod` 负责把 Java 方法语义翻译成 `SqlSession` 调用语义

## 一、`MapperRegistry`：不是“找个接口”，而是确认它已经进入 MyBatis 的责任世界

`Configuration.getMapper(type, sqlSession)` 最终会落到：

- `binding/MapperRegistry.java:41` `getMapper(Class<T>, SqlSession)`
- `binding/MapperRegistry.java:58` `addMapper(Class<T>)`

`getMapper()` 先从 `knownMappers` 里取 `MapperProxyFactory`；如果没有，直接抛：

- `Type ... is not known to the MapperRegistry.`

这说明 MyBatis 并没有“只要是接口就现场代理”这么宽松。一个 mapper 想进入运行时，必须先在注册阶段被纳入 `knownMappers`。

而 `addMapper()` 更关键：

1. 先检查是不是接口
2. 已注册则直接 fail-fast
3. 先把 `MapperProxyFactory` 放进 `knownMappers`
4. 再跑 `MapperAnnotationBuilder.parse()`
5. 如果解析没完成，最后把它从 `knownMappers` 撤掉

这里的顺序不能乱。源码里专门强调：先登记，再解析，否则解析器自己触发绑定时会重复进入。

所以 `MapperRegistry` 干的不是“帮你拿一个代理”，而是：

**保证 mapper 只有在完成注册协议之后，才允许被运行时引用。**

## 二、`MapperProxyFactory`：JDK 代理只是外壳，`methodCache` 才是它的稳定器

生成代理的类是：

- `binding/MapperProxyFactory.java:31` `methodCache`
- `binding/MapperProxyFactory.java:47` `newInstance(MapperProxy<T>)`
- `binding/MapperProxyFactory.java:51` `newInstance(SqlSession)`

它做的事情很少，但非常关键：

- 保存 `mapperInterface`
- 保存 `Map<Method, MapperMethodInvoker> methodCache`
- 用 `Proxy.newProxyInstance(...)` 生成 JDK 代理
- 每个代理都绑定一个 `MapperProxy`

如果没有 `methodCache`，每次方法调用都要重新分析 default method、构造 `MapperMethod`、解析签名，这会把运行时成本抬高很多。

所以 `MapperProxyFactory` 真正提供的，不只是“能 new 一个代理”，而是：

**一个以 Method 为键、可复用调用语义的缓存壳。**

## 三、`MapperProxy.invoke()`：真正的三岔路在这里

所有 mapper 方法最后都会进：

- `binding/MapperProxy.java:80` `invoke(Object proxy, Method method, Object[] args)`
- `binding/MapperProxy.java:92` `cachedInvoker(Method method)`
- `binding/MapperProxy.java:114` `getMethodHandleJava9(Method method)`

`invoke()` 的分流很清楚：

1. 如果是 `Object` 自带方法，直接反射调用当前代理对象本身
2. 否则交给 `cachedInvoker(method)`
3. 任意异常最后都用 `ExceptionUtil.unwrapThrowable(t)` 去壳

真正的关键在 `cachedInvoker(method)`：

- 如果不是 default method，就构造 `PlainMethodInvoker(new MapperMethod(...))`
- 如果是 default method，就走 `MethodHandle` 分支
  - JDK 9+ 用 `privateLookupIn`
  - JDK 8 用 `Lookup(Class, int)`

也就是说，MyBatis 并没有把“接口上的所有方法”都当成 SQL 入口。

它明确区分：

- 普通 mapper 方法：进入 `MapperMethod`
- Java default method：保持 Java 自己的默认实现语义

这就是为什么 default method submitted 用例能成立：MyBatis 不会粗暴地把它们都压成 statement 执行。

## 四、`MapperMethod.execute()`：真正把 Java 方法翻译成数据库调用语义的是它

最核心的翻译器是：

- `binding/MapperMethod.java:52` 构造函数
- `binding/MapperMethod.java:57` `execute(SqlSession, Object[] args)`

`execute()` 不是简单 switch，而是在同时读取两组信息：

1. `SqlCommand`：这到底是哪条 statement、什么 SQL 命令类型
2. `MethodSignature`：这个 Java 方法返回什么、有哪些特殊参数、需要怎么封装参数

然后分流：

- `INSERT` / `UPDATE` / `DELETE` → `rowCountResult(...)`
- `SELECT`
  - `returnsVoid() && hasResultHandler()` → `executeWithResultHandler(...)`
  - `returnsMany()` → `executeForMany(...)`
  - `returnsMap()` → `executeForMap(...)`
  - `returnsCursor()` → `executeForCursor(...)`
  - 否则 → `selectOne(...)`
- `FLUSH` → `sqlSession.flushStatements()`

这里最重要的认识是：

**MyBatis 不是按方法名决定行为，而是按 `SqlCommandType + MethodSignature` 决定行为。**

所以同样是 `select`，返回 `List`、`Map`、`Cursor`、`Optional`，路径都不一样。

## 五、`SqlCommand` / `MethodSignature`：一个负责找 statement，一个负责解释方法签名

### 1. `SqlCommand`

- `binding/MapperMethod.java:181` `SqlCommand` 构造与 `resolveMappedStatement(...)`

它要解决的问题是：

- `mapperInterface.getName() + "." + methodName` 这条 statement 是否存在
- 如果当前接口没找到，父接口里有没有
- 如果找不到，但方法上有 `@Flush`，那它不是普通 SQL 方法
- 如果找到了但 `SqlCommandType` 是 `UNKNOWN`，立即 fail-fast

这让 MyBatis 能支持接口继承链上的 statement 解析，而不是只盯着当前接口本身。

### 2. `MethodSignature`

- `binding/MapperMethod.java:269` `MethodSignature` 构造
- `binding/MapperMethod.java:316` `returnsOptional()`
- `binding/MapperMethod.java:323` `getUniqueParamIndex(...)`

它要解决的是：

- 返回值是不是集合、数组、Map、Cursor、Optional、void
- 有没有 `RowBounds`
- 有没有 `ResultHandler`
- 是否有多个同类特殊参数（有就直接抛异常）
- 参数应该如何交给 `ParamNameResolver` 变成 SQL 命令参数

也就是说，`MethodSignature` 承担的是：

**把 Java 方法签名翻译成 MyBatis 调用协议的静态部分。**

没有它，`MapperMethod.execute()` 根本不知道该走 `selectOne` 还是 `selectList`，更不知道怎么从 `args` 里抽 `RowBounds` 和 `ResultHandler`。

## 六、失败路径：Mapper 代理这层为什么值得单独成篇

如果只看 happy path，会觉得这一层只是代理拼装。

但它真正值得单独成篇，恰恰因为失败路径很集中：

- mapper 没注册：`MapperRegistry.getMapper()` 直接抛 `BindingException`
- statement 不存在：`SqlCommand.resolveMappedStatement()` 失败直接抛 `Invalid bound statement`
- 返回 primitive 却得到 null：`execute()` 末尾直接抛异常
- 一个方法里出现多个 `RowBounds` 或多个 `ResultHandler`：`MethodSignature.getUniqueParamIndex()` 直接抛异常
- `ResultHandler` 方式但 statement 没有明确 result type / resultMap：`executeWithResultHandler()` 直接拒绝
- `selectOne()` 返回多条：底层会抛 `TooManyResultsException`

这说明 Mapper 代理层不是“轻薄转发层”，而是：

**MyBatis 把接口调用语义做早期校验和早期失败的第一道运行时边界。**

## 到这里，M-2 真正立住的不是代理技术，而是“接口调用协议”

如果只看类名，这篇很容易被读成：

- `MapperRegistry` 做注册
- `MapperProxyFactory` 做代理
- `MapperProxy` 做拦截
- `MapperMethod` 做执行

这当然都对，但还是太散。

更稳的理解方式应该是：

1. `MapperRegistry` 决定这个接口是否已进入 MyBatis 的责任边界
2. `MapperProxyFactory` 负责生成代理和维护 `methodCache`
3. `MapperProxy.invoke()` 决定 Object 方法、default method 和 SQL 方法的分流
4. `MapperMethod` 用 `SqlCommand + MethodSignature` 把 Java 方法翻译成 `SqlSession` 行为
5. 整层在运行时主动做 fail-fast，而不是把错误拖到更深的 JDBC 才暴露

所以这篇真正立住的，不是“JDK 动态代理”这五个字，而是：

**MyBatis 用一整套接口调用协议，把 Mapper 方法稳定地翻译成 `SqlSession` 调用。**

## 这篇之后，最自然的继续方向

到这里，Mapper 方法已经能进入 `SqlSession` 了。接下来最自然的问题就是：

- 一个 `SqlSession` 是怎么持有 Executor、事务、Cursor，并在 commit/rollback/close 时收束资源的？

也就是说，下一篇应该进入 `M-3 SqlSession、事务与资源生命周期`。