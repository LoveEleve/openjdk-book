# 为什么 MyBatis-Plus 不把分页、租户、权限、安全各写成一堆散插件，而是先做一个插件总线

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲 `MybatisPlusInterceptor`、`InnerInterceptor`、`PluginUtils` 与 SQL 改写入口，解释分页、乐观锁、租户、权限、安全这些增强为什么都要先挂到一条统一总线上。不展开每个内置插件的全部细节。

## 为什么“MP 就是多几个 MyBatis Interceptor”这个理解会越看越乱

很多人第一次看 MP 插件体系，会很自然地想：

- 分页是一个插件
- 乐观锁是一个插件
- 租户是一个插件
- 数据权限是一个插件

于是顺手得出一个结论：

- MP 只是把几个 MyBatis Interceptor 打包在一起

这个结论看上去很顺，但一回到源码就会越来越乱。

因为如果每个增强都只是独立外层 Interceptor，很多问题就说不通：

- 为什么还要专门再造一个 `MybatisPlusInterceptor`
- 为什么 `InnerInterceptor` 会定义 6 个统一回调位点
- 为什么 MP 还要提供 `PluginUtils.MPBoundSql / MPStatementHandler`
- 为什么分页、租户、权限、动态表名、安全等增强都能在统一的位置动 `BoundSql`
- 为什么还需要 `InterceptorIgnoreHelper` 这种跳过总线的机制

这说明 MP 的插件系统真正要解决的，不是“再多几个插件”，而是：

**先建立一条统一的运行时增强总线，再让具体增强在统一位点上接入。**

## 插件总线的最小总图

```text
MybatisPlusInterceptor.intercept(invocation)
  -> target 是 Executor ?
       -> `willDoQuery / beforeQuery`
       -> `willDoUpdate / beforeUpdate`
     : target 是 StatementHandler ?
       -> `beforePrepare / beforeGetBoundSql`
  -> PluginUtils.mpBoundSql / mpStatementHandler
  -> invocation.proceed()
```

这张图里最关键的地方有三个：

1. 外层只保留一个真正挂进 MyBatis 插件链的总线：`MybatisPlusInterceptor`
2. 内层把增强抽成统一接口：`InnerInterceptor`
3. 真正的 SQL 读写与对象穿透交给 `PluginUtils`

## 一、`MybatisPlusInterceptor`：MP 的插件世界为什么一定先经过一个总线

关键点在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:40` 类声明
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:55` `intercept(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:109` `plugin(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/MybatisPlusInterceptor.java:117` `addInnerInterceptor(...)`

这个类最重要的不是它实现了 `Interceptor`，而是它把 MyBatis 原生插件链和 MP 自己的增强家族之间，插了一个统一总线层。

`plugin(...)` 很明确：

- 只包装 `Executor` 和 `StatementHandler`

而 `intercept(...)` 则进一步把这两个目标再拆成两条主线：

### 1. `Executor` 路径

- 查询：`willDoQuery -> beforeQuery`
- 更新：`willDoUpdate -> beforeUpdate`

### 2. `StatementHandler` 路径

- `beforePrepare`
- `beforeGetBoundSql`

这说明 MP 并不是让每个插件自己去猜“我应该挂在哪个 MyBatis 接口上”，而是先统一定义了总线切入点。

所以 `MybatisPlusInterceptor` 的价值不在“它也是个 Interceptor”，而在：

**它把原本分散的插件挂载决策，统一收束成一套标准总线。**

## 二、`InnerInterceptor`：为什么 MP 要把增强点再抽成 6 个统一回调位点

关键点在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:53` `willDoQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:69` `beforeQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:82` `willDoUpdate(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:95` `beforeUpdate(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:108` `beforePrepare(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/InnerInterceptor.java:119` `beforeGetBoundSql(...)`

这 6 个位点不是为了“接口看起来完整”，而是在把不同增强真正需要的切点显式分类：

### 1. `willDoQuery` / `willDoUpdate`

这是“要不要继续执行”的前置闸门。

- 返回 `false`，查询直接回空 List，更新直接回 `-1`

### 2. `beforeQuery` / `beforeUpdate`

这是最典型的 SQL 改写时机。

- 分页 count、租户条件、权限条件、乐观锁 version 条件都更适合挂这里

### 3. `beforePrepare`

这是 JDBC Statement 真正准备之前的统一入口。

- 更适合 BlockAttack / IllegalSQL / 动态表名这类贴近最终 SQL 形态的增强

### 4. `beforeGetBoundSql`

这是更靠前的 BoundSql 获取前钩子，适合更早阶段的包装与修正

也就是说，`InnerInterceptor` 把原本“插件自己决定拦什么、怎么拦”的混乱世界，切成了统一的 6 个位点。

所以它不是一个普通接口，而是：

**MP 对“运行时增强时机”这件事给出的标准切片模型。**

## 三、`PluginUtils`：为什么 MP 还要额外造自己的 `MPBoundSql` / `MPStatementHandler`

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:56` `realTarget(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:87` `mpBoundSql(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:91` `mpStatementHandler(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/toolkit/PluginUtils.java:140` `MPBoundSql`

这层工具的存在，其实已经说明一个事实：

- 原生 MyBatis 的 `BoundSql` / `StatementHandler` 访问方式不够适合 MP 的统一改写需求

于是 MP 专门做了两件事：

### 1. 真实目标对象穿透

`realTarget(...)` 递归剥代理，确保拿到真正的 StatementHandler / Executor。

### 2. 统一包装访问器

- `MPStatementHandler`：统一读 `mappedStatement`、`executor`、`boundSql` 等内部结构
- `MPBoundSql`：统一读/改 `sql`、`parameterMappings`、`additionalParameters`

这就说明 MP 插件总线不是只负责“调一下回调”，而是连增强家族操作底层对象的方式都标准化了。

所以 `PluginUtils` 的价值不在工具本身，而在：

**它把原生对象的反射访问协议统一成了可复用的增强操作面。**

## 四、为什么分页插件最适合作为总线样板来看

关键点在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:115` `willDoQuery(...)`
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/plugins/inner/PaginationInnerInterceptor.java:148` `beforeQuery(...)`

分页插件几乎把总线思路演示得最完整：

### 1. `willDoQuery(...)`

先决定这次查询是否要继续：

- 找 page 参数
- 必要时先执行 count
- total 为 0 时直接返回，不再执行 list 查询

### 2. `beforeQuery(...)`

真正改写 SQL：

- 拼接 order by
- 处理 limit
- 找方言
- 借 `PluginUtils.MPBoundSql` 改写 SQL 与参数映射

这说明分页插件本质上不是“某个功能插件”，而是：

**MP 插件总线设计哲学的标准样板：先决定是否执行，再决定如何改 SQL。**

## 五、`InterceptorIgnoreHelper`：为什么总线成熟之后，还必须有一套“跳过总线”的规则

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:93` `initSqlParserInfoCache(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/plugins/InterceptorIgnoreHelper.java:131` `willIgnore(...)`

一旦所有增强都上总线，新的问题就会出现：

- 某些 mapper / 方法 / 场景，我就是不想让某个增强生效，怎么办？

这就是 `InterceptorIgnoreHelper` 的位置。

它说明 MP 不是盲目把所有增强强推给所有 SQL，而是在总线之上再加了一层“选择性退场协议”。

这也是为什么插件体系不能只讲 `MybatisPlusInterceptor`，还必须讲 ignore 机制：

- 没有 ignore，总线只有集中管理
- 有了 ignore，总线才有真正可控性

## 六、失败路径：为什么 `MP-5` 的价值不在“插件很多”，而在“总线边界清楚”

### 1. `willDoQuery` / `willDoUpdate` 直接短路

这意味着插件家族不仅能改 SQL，还能中止执行。

### 2. 多插件顺序

`MybatisPlusInterceptor` 按 `interceptors` 列表顺序迭代，顺序本身就是行为的一部分。

### 3. `BoundSql` 改写副作用

一旦多个插件都改 `MPBoundSql.sql()` 或 `parameterMappings()`，顺序和兼容性就成了边界。

### 4. `beforePrepare` 与 `beforeQuery` 的职责重叠风险

如果不先立 6 个位点，很容易出现“一个插件到底挂哪儿都行”的混乱。

所以 `MP-5` 真正值钱的不是“插件多”，而是：

**它先把增强总线和位点边界立清，后面的增强家族才不会互相踩。**

## 到这里，MP-5 真正立住的不是分页插件，而是“运行时增强总线协议”

如果只看表面，这篇很容易被读成：

- MP 有个分页插件
- 有个乐观锁插件
- 还有租户、权限、安全插件

这都对，但还是太散。

更稳的理解方式应该是：

1. `MybatisPlusInterceptor` 先统一接管 `Executor` / `StatementHandler` 两个大入口
2. `InnerInterceptor` 再把增强时机切成 6 个稳定槽位
3. `PluginUtils` 统一底层对象访问方式
4. 分页、乐观锁、租户、权限、安全这些插件家族都只是总线上的实现，而不是各自独立体系

所以这篇真正立住的是：

**MyBatis-Plus 的运行时增强不是一堆散插件，而是一条统一的插件总线协议。**

## 这篇之后，最自然的继续方向

到这里，核心主干层已经基本立住。下一步最自然的方向就是：

- 进入 `MP-6`，把分页、乐观锁、自动填充、逻辑删除、租户、权限、安全这些增强家族分别拉开

也就是说，下一篇应进入 `MP-6 内置运行时增强专题组`。