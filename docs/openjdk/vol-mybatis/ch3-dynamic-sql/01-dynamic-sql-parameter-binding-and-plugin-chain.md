# 为什么 MyBatis 的动态 SQL 不是“拼字符串”，插件也不是“全局 AOP”

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲动态 SQL、参数绑定与插件链：`XMLScriptBuilder` 如何把 XML 标签变成 `SqlNode` 树，`DynamicSqlSource` 如何在运行时生成 `BoundSql`，`DefaultParameterHandler` 如何把参数写入 JDBC，以及插件如何精准切进四类核心接口。不展开类型系统和结果装配细节。

## 为什么“动态 SQL 就是 XML 模板字符串替换”会把理解带偏

很多人第一次看 MyBatis 的动态 SQL，会得到一个非常顺滑的印象：

- XML 里写 `<if>`、`<foreach>`
- 运行时按条件拼成一段 SQL
- 然后把参数设置进去

这个印象比完全错误要强很多，但它还是把真正的协议读扁了。

因为如果它只是字符串替换，就很难解释：

- 为什么 `<foreach>` 需要生成额外参数，而不是直接改原始参数对象
- 为什么 `<bind>` 可以引入临时变量并在后续参数绑定阶段被访问
- 为什么 `DynamicSqlSource` 不是直接返回 SQL 字符串，而是返回 `BoundSql`
- 为什么插件不是拦所有调用，而是只拦 `Executor` / `StatementHandler` / `ParameterHandler` / `ResultSetHandler` 中被声明的方法

更准确的说法应该是：

**MyBatis 的动态 SQL 是“运行时 SQL 生成协议”，插件链是“精确接口拦截协议”。**

## 动态 SQL 与插件链的最小总图

```text
XMLScriptBuilder.parseScriptNode()
  -> SqlNode tree
    -> DynamicSqlSource.getBoundSql(parameterObject)
      -> DynamicContext
      -> rootSqlNode.apply(context)
      -> SqlSourceBuilder.parse(...)
      -> BoundSql (+ additional parameters)
        -> DefaultParameterHandler.setParameters(ps)

Configuration.interceptors
  -> InterceptorChain.pluginAll(target)
    -> Plugin.wrap(target, interceptor)
      -> 只代理声明签名的方法
```

这里真正需要立住的，不是几个类名，而是两件事：

1. 动态 SQL 生成和参数绑定是两个阶段
2. 插件不是“全局任意拦截”，而是只对声明接口方法生效

## 一、`XMLScriptBuilder`：XML 标签先被编译成 `SqlNode` 树，而不是立刻输出 SQL

主入口是：

- `scripting/xmltags/XMLScriptBuilder.java:53` `initNodeHandlerMap()`
- `scripting/xmltags/XMLScriptBuilder.java:65` `parseScriptNode()`
- `scripting/xmltags/XMLScriptBuilder.java:76` `parseDynamicTags(XNode node)`

`initNodeHandlerMap()` 把标签名映射为具体处理器：

- `trim`
- `where`
- `set`
- `foreach`
- `if`
- `choose`
- `when`
- `otherwise`
- `bind`

这一步已经说明，MyBatis 并没有把 XML 当成字符串模板，而是当成一棵结构化语法树。

`parseScriptNode()` 先调用 `parseDynamicTags(context)` 拿到 `MixedSqlNode rootSqlNode`，然后分两路：

- 有动态内容：`new DynamicSqlSource(configuration, rootSqlNode)`
- 没有动态内容：`new RawSqlSource(configuration, rootSqlNode, parameterType)`

也就是说，是否“动态”不是配置层面说了算，而是 SQL 树实际分析之后才决定。

## 二、`parseDynamicTags()`：为什么 `<if>/<foreach>/<choose>` 不是简单的文本替换

在：

- `scripting/xmltags/XMLScriptBuilder.java:76` `parseDynamicTags(XNode node)`

它按子节点类型分三路：

1. 文本 / CDATA
   - 先变成 `TextSqlNode`
   - 如果 `textSqlNode.isDynamic()` 为真，就进动态树
   - 否则落成 `StaticTextSqlNode`
2. 元素节点
   - 查 `nodeHandlerMap`
   - 未知标签直接抛 `BuilderException("Unknown element <...>")`
3. 每个合法标签都由对应 handler 递归生成新的 `SqlNode`

例如：

- `scripting/xmltags/XMLScriptBuilder.java:170` `ForEachHandler.handleNode(...)`
- `scripting/xmltags/XMLScriptBuilder.java:186` `IfHandler.handleNode(...)`
- `scripting/xmltags/XMLScriptBuilder.java:217` `ChooseHandler.handleNode(...)`

这说明 `<foreach>`、`<if>`、`<choose>` 不是现场字符串替换，而是先变成拥有自己运行语义的节点对象，等真正有参数对象时再执行 `apply(context)`。

## 三、`DynamicSqlSource`：运行时真正发生的是“树 apply 到上下文，再收束成 BoundSql”

核心在：

- `scripting/xmltags/DynamicSqlSource.java:36` `getBoundSql(Object parameterObject)`

它的步骤非常紧：

1. `new DynamicContext(configuration, parameterObject)`
2. `rootSqlNode.apply(context)`
3. `new SqlSourceBuilder(configuration).parse(context.getSql(), parameterType, context.getBindings())`
4. `sqlSource.getBoundSql(parameterObject)`
5. `context.getBindings().forEach(boundSql::setAdditionalParameter)`

这条链说明两个事实：

### 1. 动态 SQL 的输出不是最终结果对象，而是 `BoundSql`

`BoundSql` 才是执行链真正消费的产物。

### 2. 运行时绑定并不只来自原参数对象

`context.getBindings()` 里的内容也会被灌进 `BoundSql` 的 additional parameters。

这正是 `<bind>` 和 `<foreach>` 能工作的根本原因。

## 四、`DynamicContext` 与 `BoundSql`：为什么 `foreach` / `bind` 的参数不会直接写回原对象

关键点在：

- `scripting/xmltags/DynamicContext.java:45` 构造函数
- `scripting/xmltags/DynamicContext.java:61` `bind(...)`
- `scripting/xmltags/DynamicContext.java:69` `getSql()`
- `mapping/BoundSql.java:43` 构造函数
- `mapping/BoundSql.java:64` `hasAdditionalParameter(...)`
- `mapping/BoundSql.java:69` `setAdditionalParameter(...)`

`DynamicContext` 维护的是“这次 SQL 生成过程中的临时上下文”：

- 当前参数对象
- 绑定变量
- 生成中的 SQL 文本
- 运行时唯一编号

而 `BoundSql` 维护的是“这次执行最终消费的 SQL + 参数映射 + additional parameters”。

所以 `<bind>` 或 `<foreach item=...>` 之类的中间变量，不应该污染原始参数对象；它们应该活在 `DynamicContext` 和 `BoundSql.additionalParameters` 这条单独通道里。

这也是为什么 `DefaultParameterHandler` 会先问：

- `boundSql.hasAdditionalParameter(propertyName)`

而不是直接只去原参数对象里找。

## 五、`DefaultParameterHandler`：参数绑定真正落地的地方不是动态 SQL，而是这里

- `scripting/defaults/DefaultParameterHandler.java:61` `setParameters(PreparedStatement ps)`

这一层最值得注意的是参数解析顺序：

1. 遍历 `boundSql.getParameterMappings()`
2. 跳过 OUT 参数
3. 如果 `boundSql.hasAdditionalParameter(propertyName)`，优先用 additional parameter
4. 否则再看 `parameterObject == null`
5. 如果参数对象本身有直达 type handler，就直接把整个对象当值
6. 否则通过 `MetaObject.getValue(propertyName)` 取值
7. 找到 `TypeHandler` 后真正 `setParameter(ps, i + 1, value, jdbcType)`

也就是说，动态 SQL 阶段负责“决定该有哪些占位与额外绑定”，参数处理阶段负责“把这些绑定真正落到 JDBC”。

这两步不能混成一个概念。

## 六、插件链：为什么它不是“全局 AOP”

插件入口在：

- `plugin/InterceptorChain.java:29` `pluginAll(Object target)`
- `plugin/Plugin.java:44` `wrap(Object target, Interceptor interceptor)`
- `plugin/Plugin.java:54` `invoke(...)`
- `plugin/Plugin.java:67` `getSignatureMap(...)`
- `plugin/Invocation.java:60` `proceed()`

### 1. `pluginAll(target)`

就是把当前已注册的 `Interceptor` 顺序套到目标对象上。

### 2. `Plugin.wrap(...)`

并不会无脑代理任何对象，而是：

- 先读 interceptor 上的 `@Intercepts`
- 构造 `signatureMap`
- 只收集那些“目标类实际实现了的接口”
- 如果没有匹配接口，直接返回原对象

### 3. `Plugin.invoke(...)`

调用时也不是全拦，而是：

- 先按 `method.getDeclaringClass()` 找有没有登记过的方法集合
- 只有在集合里，才 `interceptor.intercept(new Invocation(...))`
- 否则直接 `method.invoke(target, args)`

也就是说，MyBatis 插件不是“你写了一个 interceptor，它就像 Spring AOP 一样全局兜住所有调用”，而是：

**只有你在 `@Signature` 里声明了的方法，且目标对象实现了对应接口，插件才会真正生效。**

`PluginTest` 的价值就在这里：它证明插件不会误伤任意方法，只会拦声明过的签名。

## 七、失败路径：为什么这一篇的核心不是语法糖，而是运行时协议边界

### 1. 未知动态标签

`parseDynamicTags()` 找不到 handler 就直接抛异常。

### 2. `choose` 里多个 `otherwise`

`ChooseHandler.getDefaultSqlNode(...)` 直接抛 `Too many default (otherwise) elements in choose statement.`

### 3. 插件没写 `@Intercepts`

`Plugin.getSignatureMap(...)` 直接抛 `PluginException`。

### 4. `@Signature` 写错 method 名或参数

同样在 `getSignatureMap(...)` 里会 fail-fast。

### 5. 参数缺失

等到 `DefaultParameterHandler` 真正绑定时，就会通过 `MetaObject` / additional parameter 检测暴露出来。

这说明动态 SQL 和插件链都不是“开发体验糖层”，而是 MyBatis 在运行前后两个关键时刻主动建立约束的协议层。

## 到这里，M-6 真正立住的不是 XML 标签和插件注解，而是“两条运行时协议”

如果只看表面，这篇很容易被读成：

- `<if>`、`<foreach>`、`<trim>` 的用法说明
- 插件怎么写一个 `Interceptor`

这两种读法都太浅。

更稳的理解方式应该是：

1. `XMLScriptBuilder` 先把 XML 标签编译成 `SqlNode` 树
2. `DynamicSqlSource` 在运行时把树 apply 成 `DynamicContext`，再收束成 `BoundSql`
3. `BoundSql.additionalParameters` 承载运行时临时绑定，而不是污染原参数对象
4. `DefaultParameterHandler` 才是 JDBC 参数真正落地的位置
5. `InterceptorChain` / `Plugin.wrap()` 让插件只对声明目标接口和方法生效

所以这篇真正立住的是：

**MyBatis 的动态 SQL 是运行时 SQL 生成协议，插件链是精确接口拦截协议。**

## 这篇之后，最自然的继续方向

到这里，执行链里还剩一层关键问题没有单独拉出来：

- Java 类型、JDBC 类型、反射取值和结果对象写回，到底是怎样协同的？

也就是说，下一篇应该进入 `M-7 类型处理、反射映射与结果装配`。