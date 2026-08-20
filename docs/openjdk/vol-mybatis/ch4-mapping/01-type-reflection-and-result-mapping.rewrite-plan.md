# 篇：01 类型处理、反射映射与结果装配

- 域：`M-7 类型处理、反射映射与结果装配`
- 卷：`vol-mybatis`
- 目标：回答 Java 值如何进入 JDBC、ResultSet 如何变成对象，以及 MyBatis 为什么需要 `TypeHandlerRegistry`、`MetaObject`、`Reflector` 和 `DefaultResultSetHandler` 这四类协作机制。

## 前置依赖

- HARD：已读 `M-4`、`M-6`，知道执行链、`BoundSql` 与 `DefaultParameterHandler`。

## 读者问题

为什么 MyBatis 的“对象映射”不是简单反射赋值，而要同时处理：

1. Java 类型与 JDBC 类型的匹配
2. 自定义 TypeHandler 与 Enum/继承类型查找
3. getter/setter/字段/record 的反射发现
4. 自动映射、构造器映射、嵌套 association/collection
5. 多结果集、discriminator、懒加载和 deferred relation

## 主结论

MyBatis 的映射不是单向“ResultSet -> POJO”，而是两条共享基础设施：

参数侧：

`ParameterMapping`
  -> `TypeHandlerRegistry`
    -> `TypeHandler`
      -> `PreparedStatement`

结果侧：

`ResultSet`
  -> `DefaultResultSetHandler`
    -> `ResultMap / ResultMapping`
      -> `MetaObject`
        -> `Reflector / ObjectWrapper / ObjectFactory`
          -> POJO / Map / Collection / record

其中：

- `TypeHandlerRegistry` 决定“值用什么 JDBC 语义读写”
- `Reflector` 决定“对象有哪些可读写属性和构造能力”
- `MetaObject` 把属性路径、Map、Collection、Bean 统一成访问协议
- `DefaultResultSetHandler` 编排结果集到对象图的完整过程

## 结构设计

1. 困惑开场：为什么对象映射不是反射 set 一下
2. 最小总图：TypeHandlerRegistry + MetaObject + Reflector + ResultSetHandler
3. `TypeHandlerRegistry`：Java type/JDBC type/handler 三张表如何选择
4. `Reflector`：getter/setter/field/record/泛型类型如何变成可调用元数据
5. `MetaObject`：Bean/Map/Collection 的统一属性访问层
6. `DefaultResultSetHandler.handleResultSets()`：多个 ResultSet 与 ResultMap 的编排
7. 自动映射、构造器映射、association/collection/discriminator
8. 懒加载与 nested query：结果装配如何把查询依赖交回 Executor
9. 失败路径：缺 handler、缺 setter、歧义 getter、结果映射不一致
10. 收网：这篇立住的是“对象图装配协议”，不是反射工具清单
11. 下篇桥接：进入 Cursor 与增量结果消费

## 必须回填的源码锚点

- `type/TypeHandlerRegistry.java:55` 类声明与 registry 状态
- `type/TypeHandlerRegistry.java:213` `getMappingTypeHandler(...)`
- `type/TypeHandlerRegistry.java:229` `getTypeHandler(...)`
- `type/TypeHandlerRegistry.java:255` `getJdbcHandlerMap(...)`
- `type/TypeHandlerRegistry.java:380` `register(...)`
- `type/TypeHandlerRegistry.java:452` `getInstance(...)`
- `reflection/MetaObject.java:33` 类声明与 wrapper 选择
- `reflection/MetaObject.java:45` `forObject(...)`
- `reflection/MetaObject.java:89` `getValue(...)`
- `reflection/MetaObject.java:93` `setValue(...)`
- `reflection/Reflector.java:54` 类声明
- `reflection/Reflector.java:64` 构造函数元数据发现
- `reflection/Reflector.java:363` `getDefaultConstructor()`
- `reflection/Reflector.java:394` `getSetInvoker(...)`
- `reflection/Reflector.java:406` `getSetterType(...)`
- `executor/resultset/DefaultResultSetHandler.java:93` `nestedResultObjects`
- `executor/resultset/DefaultResultSetHandler.java:127` 构造函数
- `executor/resultset/DefaultResultSetHandler.java:188` `handleResultSets(...)`
- `executor/resultset/DefaultResultSetHandler.java:330` `handleRowValues(...)`
- `executor/resultset/DefaultResultSetHandler.java:580` `applyAutomaticMappings(...)`
- `executor/resultset/DefaultResultSetHandler.java:798` `applyArgNameBasedConstructorAutoMapping(...)`
- `executor/resultset/DefaultResultSetHandler.java:888` `getNestedQueryMappingValue(...)`
- `mapping/ResultMap.java:229` `getConstructorResultMappings()`
- `mapping/ResultMapping.java:130` `lazy(...)`

## 必须引用的测试/证据

- `TypeHandlerRegistryTest`：注册、继承、Enum、多线程自动注册
- `MetaObject` / `Reflector` 相关 reflection 测试
- `DefaultResultSetHandlerTest`：结果集、列名与结果映射错误
- `AutoConstructorTest`：构造器映射
- `ResultMappingTest`：nested select/resultMap 冲突
- `lazy_properties`：懒加载触发方法与 setter 边界

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。