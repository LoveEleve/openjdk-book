# 篇：01 动态 SQL、参数绑定与插件拦截

- 域：`M-6 动态 SQL、参数绑定与插件拦截`
- 卷：`vol-mybatis`
- 目标：回答 XML 动态标签如何变成最终 `BoundSql`，参数如何被绑定到 JDBC，以及插件如何精准切进四类核心接口，而不是把这一切写成零散技巧合集。

## 前置依赖

- HARD：已读 `M-4`、`M-5`，知道执行链和缓存边界。

## 读者问题

为什么 MyBatis 不是直接把 `<if>/<foreach>/<trim>` 拼成 SQL 字符串，而是：

1. 先构造 `SqlNode` 树
2. 再在运行时根据参数生成 `DynamicContext`
3. 再把结果收束成 `BoundSql`
4. 再由 `DefaultParameterHandler` 把参数写进 JDBC
5. 最后还允许插件精准拦截 `Executor`、`StatementHandler`、`ParameterHandler`、`ResultSetHandler`

## 主结论

MyBatis 的动态 SQL 不是模板替换，而是一条运行时 SQL 生成与参数收束协议：

`XMLScriptBuilder.parseScriptNode()`
  -> `SqlNode` 树（`If/ForEach/Trim/Choose/Bind/...`）
    -> `DynamicSqlSource.getBoundSql(parameterObject)`
      -> `DynamicContext`
      -> `rootSqlNode.apply(context)`
      -> `SqlSourceBuilder.parse(...)`
      -> `BoundSql`
        -> `DefaultParameterHandler.setParameters(ps)`

而插件不是“全局 AOP”，而是：

`Configuration.interceptorChain`
  -> `pluginAll(target)`
    -> `Plugin.wrap(target, interceptor)`
      -> 只代理声明在 `@Intercepts/@Signature` 里的接口方法

## 结构设计

1. 困惑开场：为什么动态 SQL 不是“拼字符串”这么简单
2. 最小总图：`XMLScriptBuilder` -> `DynamicSqlSource` -> `BoundSql` -> `DefaultParameterHandler`
3. `XMLScriptBuilder`：标签到 `SqlNode` 树
4. `DynamicSqlSource`：运行时参数如何收束成 `BoundSql`
5. `BoundSql` 与 additional parameters：为什么 `foreach` / `bind` 生成的值不直接写回原参数对象
6. `DefaultParameterHandler`：参数绑定如何真正落到 JDBC
7. `InterceptorChain` / `Plugin.wrap()`：插件如何精准切入四类目标接口
8. 失败路径：未知动态标签、多个 `otherwise`、无 `@Intercepts`、错误 method 签名、参数缺失
9. 收网：这篇立住的是“运行时 SQL 生成协议 + 精确拦截协议”
10. 下篇桥接：进入类型处理、反射映射与结果装配

## 必须回填的源码锚点

- `scripting/xmltags/XMLScriptBuilder.java:53` `initNodeHandlerMap()`
- `scripting/xmltags/XMLScriptBuilder.java:65` `parseScriptNode()`
- `scripting/xmltags/XMLScriptBuilder.java:76` `parseDynamicTags(XNode node)`
- `scripting/xmltags/XMLScriptBuilder.java:170` `ForEachHandler.handleNode(...)`
- `scripting/xmltags/XMLScriptBuilder.java:186` `IfHandler.handleNode(...)`
- `scripting/xmltags/XMLScriptBuilder.java:217` `ChooseHandler.handleNode(...)`
- `scripting/xmltags/DynamicSqlSource.java:36` `getBoundSql(Object parameterObject)`
- `scripting/xmltags/DynamicContext.java:45` 构造函数
- `scripting/xmltags/DynamicContext.java:61` `bind(...)`
- `scripting/xmltags/DynamicContext.java:69` `getSql()`
- `mapping/BoundSql.java:43` 构造函数
- `mapping/BoundSql.java:64` `hasAdditionalParameter(...)`
- `mapping/BoundSql.java:69` `setAdditionalParameter(...)`
- `scripting/defaults/DefaultParameterHandler.java:61` `setParameters(PreparedStatement ps)`
- `plugin/InterceptorChain.java:29` `pluginAll(Object target)`
- `plugin/Plugin.java:44` `wrap(Object target, Interceptor interceptor)`
- `plugin/Plugin.java:54` `invoke(...)`
- `plugin/Plugin.java:67` `getSignatureMap(...)`
- `plugin/Invocation.java:60` `proceed()`

## 必须引用的测试/证据

- `DynamicSqlSourceTest`：`if/choose/trim/set` 等动态标签行为
- `OgnlCacheTest`：OGNL 解析与并发访问证据
- `PluginTest`：插件不会误拦截任意方法，只拦截声明签名
- `DynSqlTest` / `ForEachTest`：`bind` / `foreach` 的运行时语义

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。