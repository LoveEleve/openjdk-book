# 为什么 MyBatis 的结果映射不是“反射 set 一下”

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲类型处理、反射映射与结果装配：`TypeHandlerRegistry`、`MetaObject`、`Reflector`、`DefaultResultSetHandler` 如何协作，把 Java 值和 JDBC 值在两侧收束成同一套对象图协议。不展开 Cursor 与 Spring 集成。

## 为什么“ResultSet -> POJO”这个说法太粗了

很多人讲 MyBatis 映射，喜欢用一句很快的话：

- 它就是把 ResultSet 映射成 Java 对象

这句话当然没错，但它会把真正复杂的部分全部抹平。

因为一旦你进入真实源码，很快就会发现所谓“映射”其实同时在解决至少五类问题：

- Java 类型和 JDBC 类型到底由哪个 `TypeHandler` 处理
- 目标对象是普通 Bean、Map、Collection 还是 record
- 属性名大小写、驼峰、字段直达、getter/setter 冲突怎么处理
- 自动映射、构造器映射、association/collection/discriminator 怎么拼成对象图
- 嵌套查询和懒加载的依赖，为什么不是结果处理器自己当场查完，而要交回执行器

也就是说，MyBatis 的映射从来不是“拿列值用反射塞进去”，而是：

**一套把类型语义、属性语义和对象图装配语义统一起来的运行时协议。**

## 映射体系的最小总图

```text
参数侧
ParameterMapping
  -> TypeHandlerRegistry
    -> TypeHandler
      -> PreparedStatement

结果侧
ResultSet
  -> DefaultResultSetHandler
    -> ResultMap / ResultMapping
      -> MetaObject
        -> Reflector / ObjectWrapper / ObjectFactory
          -> Bean / Map / Collection / record
```

这张图里最关键的不是类名，而是两个共享底座：

1. `TypeHandlerRegistry` 决定值怎样穿过 JDBC 边界
2. `MetaObject + Reflector` 决定对象怎样被安全读写

## 一、`TypeHandlerRegistry`：类型映射不是 if/else，而是三张表共同决策

入口在：

- `type/TypeHandlerRegistry.java:55` 类声明
- `type/TypeHandlerRegistry.java:213` `getMappingTypeHandler(...)`
- `type/TypeHandlerRegistry.java:229` `getTypeHandler(...)`
- `type/TypeHandlerRegistry.java:255` `getJdbcHandlerMap(...)`
- `type/TypeHandlerRegistry.java:380` `register(...)`
- `type/TypeHandlerRegistry.java:452` `getInstance(...)`

`TypeHandlerRegistry` 本质上同时维护：

- `jdbcTypeHandlerMap`
- `typeHandlerMap`
- `allTypeHandlersMap`
- `unknownTypeHandler`

这意味着它不是“给一个 Java 类找一个 handler”这么简单，而是在看：

- 当前 Java 类型是什么
- 当前 JDBC 类型是什么
- 有没有精确匹配
- 没有精确匹配时能不能退到 `null` 键
- 还不行时能不能选 sole handler
- 如果是 Enum，能不能从接口或默认 enum handler 推导
- 如果完全找不到，是否退回 `UnknownTypeHandler`

所以 TypeHandler 的选择不是拍脑袋式分发，而是一套层层退让的查找协议。

`TypeHandlerRegistryTest` 的价值也就在这里：它验证的不是“能不能注册一个 handler”，而是继承链、Enum、多线程自动注册和复杂泛型场景下的查找语义。

## 二、`Reflector`：MyBatis 不是直接反射字段，而是先把类的可访问结构缓存成元数据

关键点在：

- `reflection/Reflector.java:54` 类声明
- `reflection/Reflector.java:64` 构造函数元数据发现
- `reflection/Reflector.java:363` `getDefaultConstructor()`
- `reflection/Reflector.java:394` `getSetInvoker(...)`
- `reflection/Reflector.java:406` `getSetterType(...)`

`Reflector` 在构造期就把一个类能怎么被访问缓存下来：

- readablePropertyNames
- writablePropertyNames
- getMethods / setMethods
- getTypes / setTypes
- defaultConstructor
- caseInsensitivePropertyMap

而且它不是只看 getter/setter：

- record 走专门的 `addRecordGetMethods(...)`
- 普通类会同时看 getter/setter 和字段
- getter / setter 冲突会在构造元数据时就判歧义
- 没默认构造器时，后面 `getDefaultConstructor()` 会 fail-fast

这说明 MyBatis 并不想在结果映射时临时到处反射，它更想先建立一个稳定的“对象访问描述”。

所以 `Reflector` 真正承担的是：

**把一个类的可读写规则、构造规则和属性歧义预先固化成缓存元数据。**

## 三、`MetaObject`：Bean、Map、Collection 为什么能被统一看待

关键点在：

- `reflection/MetaObject.java:33` 类声明
- `reflection/MetaObject.java:45` `forObject(...)`
- `reflection/MetaObject.java:89` `getValue(...)`
- `reflection/MetaObject.java:93` `setValue(...)`

`MetaObject` 的构造分流非常重要：

- 如果对象本身就是 `ObjectWrapper`
- 否则如果 `ObjectWrapperFactory` 有自定义 wrapper
- 否则如果对象是 `Map`
- 否则如果对象是 `Collection`
- 否则默认走 `BeanWrapper`

也就是说，MyBatis 不会把所有目标对象都硬压成 JavaBean 处理。

这层设计让它可以统一调用：

- `getValue(name)`
- `setValue(name, value)`
- `add(...)`
- `addAll(...)`

从而把“对象长什么样”和“映射流程怎么写”分离开。

所以 `MetaObject` 的价值不在于“又包了一层反射”，而在于：

**它把 Bean / Map / Collection / 自定义 wrapper 统一成一套属性访问协议。**

## 四、`DefaultResultSetHandler`：真正把 JDBC 结果装成对象图的，不是 Executor，而是它

真正的装配器是：

- `executor/resultset/DefaultResultSetHandler.java:93` `nestedResultObjects`
- `executor/resultset/DefaultResultSetHandler.java:127` 构造函数
- `executor/resultset/DefaultResultSetHandler.java:188` `handleResultSets(...)`
- `executor/resultset/DefaultResultSetHandler.java:330` `handleRowValues(...)`
- `executor/resultset/DefaultResultSetHandler.java:580` `applyAutomaticMappings(...)`
- `executor/resultset/DefaultResultSetHandler.java:798` `applyArgNameBasedConstructorAutoMapping(...)`
- `executor/resultset/DefaultResultSetHandler.java:888` `getNestedQueryMappingValue(...)`

光字段就已经能看出它不是简单的“行转对象”：

- `nestedResultObjects`
- `ancestorObjects`
- `nextResultMaps`
- `pendingRelations`
- `autoMappingsCache`
- `constructorAutoMappingColumns`

这些结构意味着它同时在处理：

- 多结果集
- 嵌套对象图
- 自动映射缓存
- 构造器参数映射
- 延迟关系补全

`handleResultSets(...)` 只是总入口。它会：

1. 取第一个 ResultSet
2. 按 `MappedStatement.getResultMaps()` 一组组处理
3. 如果配置了多结果集别名，再按 `nextResultMaps` 补 parent-child 关联
4. 最后 collapse 成最终返回结构

所以结果处理不是“按行 new 对象”，而是一个对象图编排器。

## 五、自动映射、构造器映射、association/collection：这些不是边角料，而是对象图协议的主体

### 1. 自动映射

- `executor/resultset/DefaultResultSetHandler.java:580` `applyAutomaticMappings(...)`

这一段说明“列名自动对应属性名”并不是白送能力，而是要经过：

- unmapped column 分析
- TypeHandler 可用性检查
- primitive/null 等边界判断
- 自动映射缓存

### 2. 构造器映射

- `executor/resultset/DefaultResultSetHandler.java:798` `applyArgNameBasedConstructorAutoMapping(...)`
- `mapping/ResultMap.java:229` `getConstructorResultMappings()`

这说明当对象不适合先 new 再 set 时，MyBatis 还要走另一条协议：

- 先找构造器参数
- 再按列名 / 参数名 / 类型去匹配
- 最后整体实例化

`AutoConstructorTest` 的意义就在于它证明：构造器映射不是附加小功能，而是结果装配主线的一种合法形态。

### 3. association / collection / discriminator

- `mapping/ResultMapping.java:130` `lazy(...)`

association、collection、discriminator 并不是“ResultMap 语法糖”，而是在告诉装配器：

- 这是单对象嵌套还是集合嵌套
- 这是立即装配还是延迟查询
- 这是按条件分支选择哪个子 ResultMap

也就是说，ResultMap 里的这些结构共同定义了对象图的装配协议，而不是额外配置项。

## 六、懒加载与 nested query：为什么结果处理器没有自己把所有依赖查完

- `executor/resultset/DefaultResultSetHandler.java:888` `getNestedQueryMappingValue(...)`

这一段很关键，因为它回答了另一个常见误解：

- 既然结果处理器知道还缺一个嵌套对象，为什么不自己直接查完？

原因在于它必须和执行器缓存、延迟加载、事务边界协同。

结果处理器真正做的是：

- 识别 nested query 需要的 key
- 根据 `ResultMapping.isLazy()` 决定是立刻查，还是挂成后续 lazy load
- 把依赖交回执行器 / loader 体系去完成

所以懒加载不是结果处理器自己偷偷再查一次数据库，而是：

**结果装配阶段发现依赖，再把依赖交回执行器体系按正确时机完成。**

这也解释了为什么 `lazy_properties` 测试关注的是：

- `equals` / `hashCode` / `toString` 是否触发 lazy loading
- setter 是否会使原 lazy 状态失效

这些都不是“Java Bean 小技巧”，而是在验证对象图延迟装配的边界条件。

## 七、失败路径：为什么映射专题真正值钱的是歧义和缺失边界

### 1. 缺 handler 或 handler 冲突

`TypeHandlerRegistry` 会在选择链路里暴露问题，而不是静默降级成错误类型。

### 2. getter / setter 歧义

`Reflector` 在构造期就把歧义 getter/setter 标出来，避免运行时结果不可预测。

### 3. 缺默认构造器

`Reflector.getDefaultConstructor()` 直接 fail-fast。

### 4. nested result / nested select 冲突

`ResultMappingTest` 专门在验证这种组合非法边界。

### 5. 结果列名或 ResultMap 不一致

`DefaultResultSetHandlerTest` 对列名保留和错误消息做了直接验证。

所以这一篇真正重要的不是“能映射成功”，而是：

**MyBatis 怎样在对象图装配之前就把歧义、缺失和不一致尽量前移暴露。**

## 到这里，M-7 真正立住的不是反射工具类，而是“对象图装配协议”

如果只看类名，这篇很容易被读成：

- `TypeHandlerRegistry` 管类型
- `MetaObject` 管反射
- `Reflector` 管 getter/setter
- `DefaultResultSetHandler` 管结果集

这当然都对，但还是散的。

更稳的理解方式应该是：

1. `TypeHandlerRegistry` 决定值怎样过 JDBC 边界
2. `Reflector` 决定对象有哪些稳定可访问属性和构造能力
3. `MetaObject` 把 Bean / Map / Collection 统一成属性访问协议
4. `DefaultResultSetHandler` 用 `ResultMap/ResultMapping` 把这些基础设施编排成对象图装配过程
5. 懒加载和 nested query 不是额外魔法，而是结果装配协议的一部分

所以这篇真正立住的是：

**MyBatis 的结果映射是一套对象图装配协议，而不是一次反射赋值。**

## 这篇之后，最自然的继续方向

到这里，主干与补深层里还剩一条已经在多处出现、但需要单独收束的主题：

- Cursor 为什么不能随便多次迭代
- 增量结果消费为什么会和 Session 生命周期绑在一起

也就是说，下一篇应该进入 `M-8 Cursor、ResultHandler 与增量结果消费`。