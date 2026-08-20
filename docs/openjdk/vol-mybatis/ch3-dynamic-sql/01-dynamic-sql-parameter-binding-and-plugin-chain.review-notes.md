# M-6 动态 SQL、参数绑定与插件拦截 — review notes

## 事实审

- 已核对 `scripting/xmltags/XMLScriptBuilder.java:53`、`:65`、`:76`、`:170`、`:186`、`:217`，动态标签编译为 `SqlNode` 树的主线成立。
- 已核对 `scripting/xmltags/DynamicSqlSource.java:36`，运行时生成 `BoundSql` 的主入口成立。
- 已核对 `scripting/xmltags/DynamicContext.java:45`、`:61`、`:69` 与 `mapping/BoundSql.java:43`、`:64`、`:69`，临时绑定与 additional parameter 语义成立。
- 已核对 `scripting/defaults/DefaultParameterHandler.java:61`，参数绑定真正落到 JDBC 的位置成立。
- 已核对 `plugin/InterceptorChain.java:29`、`plugin/Plugin.java:44`、`:54`、`:67`、`plugin/Invocation.java:60`，插件链精确拦截主线成立。
- 已补测试证据：`DynamicSqlSourceTest`、`OgnlCacheTest`、`PluginTest`、`DynSqlTest`、`ForEachTest` 对应本篇结论。

## 因果审

- XML 标签先编译成 `SqlNode` 树，再在运行时基于参数 apply 成 `BoundSql`，正文成立。
- additional parameters 先写入 `DynamicContext` 再灌进 `BoundSql`，正文成立。
- `DefaultParameterHandler` 先查 additional parameters，再查原参数对象，正文成立。
- 插件不是无差别代理，而是由 `@Intercepts/@Signature` 和目标接口共同决定是否生效，正文成立。

## 结构审

- 从“不是拼字符串 / 不是全局 AOP”切入，再落到 `SqlNode` 树、`BoundSql`、参数绑定、插件链与失败路径，主线集中。
- 没有把 XML 标签用法表和平铺 API 文档写成正文主线，符合方法论。

## 读者审

- 读完应能回答：为什么 `foreach` / `bind` 的中间变量不会直接写回原参数对象。
- 读完应能回答：为什么插件不会误拦任意方法。
- 读完后能自然进入类型系统与结果装配，而不会把参数绑定和类型系统完全混成一层。

## 边界审

- 本篇没有提前透支结果装配与类型处理的完整专题。
- 没有把插件链写成 Spring AOP 式通用切面，边界成立。

## 依赖审

- 前置依赖：M-4 执行链、M-5 缓存边界。
- 后续桥接：M-7 类型系统与结果装配、M-9 注解入口都成立。

## 结论

M-6 已完成单域四件套的事实回填与六层审查，可进入下一补深域。