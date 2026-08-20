# 为什么 MyBatis-Plus 不是“边看注解边拼 SQL”，而是先建立一套表元数据语义中心

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲 `TableInfoHelper`、`TableInfo`、`TableFieldInfo`、`GlobalConfig.DbConfig` 如何建立 MP 的表元数据中心，并解释这套元数据为什么必须先于 SQL 注入、Wrapper 与插件增强被建立。不展开 Wrapper 与插件细节。

## 为什么“注解直接决定 SQL”这个印象会把 MP 的主线看浅

很多人第一次看 MP，会很自然地以为：

- 注解写在实体类上
- 需要生成 SQL 时现查现用
- 于是 `@TableName/@TableId/@TableField/@TableLogic/@Version` 只是几个配置项

这个印象在使用层还能工作，但一回到源码就会失真。

因为如果真是“现查现用”，MP 根本没必要专门维护：

- `TableInfoHelper`
- `TableInfo`
- `TableFieldInfo`
- `GlobalConfig.DbConfig`
- resultMap 初始化
- Lambda cache 安装

这些结构存在本身就说明：

**MP 不把注解当成临时输入，而是先把它们收束成运行时表元数据中心，再让后续注入、Wrapper、逻辑删除、乐观锁去消费。**

也就是说，注解不是直接驱动 SQL，而是先驱动元数据。

## 表元数据体系的最小总图

```text
TableInfoHelper.initTableInfo(...)
  -> initTableName(...)
  -> initTableFields(...)
    -> initTableIdWithAnnotation() / initTableIdWithoutAnnotation()
  -> tableInfo.initResultMapIfNeed()
  -> LambdaUtils.installCache(tableInfo)

GlobalConfig.DbConfig
  -> 表名前缀 / schema / strategy / logic delete / keyGenerators / 主键策略
```

这张图里最重要的地方有两个：

1. `TableInfo` / `TableFieldInfo` 是运行时语义载体，不是注解镜像
2. `GlobalConfig.DbConfig` 是这套语义中心的默认世界，而不是额外附加配置

## 一、`TableInfoHelper.initTableInfo(...)`：为什么元数据一定发生在注入前

关键入口在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:185` `initTableInfo(...)`

它的主线非常清楚：

1. 先从 `GlobalConfigUtils.getGlobalConfig(configuration)` 取当前全局配置
2. 通过 `PostInitTableInfoHandler` 创建 `TableInfo`
3. 设定当前 namespace
4. 调 `initTableName(...)`
5. 调 `initTableFields(...)`
6. `tableInfo.initResultMapIfNeed()`
7. `postInitTableInfoHandler.postTableInfo(...)`
8. 把 `TableInfo` 缓到 `TABLE_INFO_CACHE` 和 `TABLE_NAME_INFO_CACHE`
9. `LambdaUtils.installCache(tableInfo)`

这说明：

- 表元数据不是给注入器现查一次的临时对象
- 它是要被缓存、被复用、被结果映射和 Lambda 解析共同消费的中心状态

所以在 MP 里，“注入前先建元数据”不是实现顺序巧合，而是架构前提。

## 二、`initTableName(...)`：表名从来不只是 `@TableName.value()` 这么简单

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:221` `initTableName(...)`

这段逻辑同时处理：

- 实体类名默认值
- `@TableName.value()`
- `keepGlobalPrefix`
- `schema`
- `resultMap`
- `autoResultMap`
- `excludeProperty`
- `DbConfig.tablePrefix`
- `DbConfig.tableFormat`

也就是说，一个最终表名和表级行为，不是只看注解，也不是只看全局配置，而是：

**局部注解 + 全局默认 + 格式化规则三者共同决定。**

更重要的是，这里已经把两个后续主线也预埋了：

1. `autoResultMap` 会影响后面的结果映射体系
2. `excludeProperty` 会影响字段列表的构建

所以表名阶段就已经不是“字符串决定”，而是在搭表级运行时语义。

## 三、`initTableFields(...)`：字段解析不是遍历字段那么轻，而是在决定运行时能力边界

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:313` `initTableFields(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:472` `initTableIdWithAnnotation(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:529` `initTableIdWithoutAnnotation(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:607` `getAllFields(...)`

`initTableFields(...)` 真正做的是：

1. 拿到所有字段
2. 先判断是否存在 `@TableId`
3. 再判断是否存在 `@TableLogic`
4. 逐字段处理：
   - 是否被 `excludeProperty` 排除
   - 是否是主键
   - 是否有 `@OrderBy`
   - 是否有 `@TableField`
   - 没有 `@TableField` 时也要构造默认 `TableFieldInfo`
5. 最后 `tableInfo.setFieldList(fieldList)`
6. 如果始终没找到主键，发警告

这说明字段解析不是“记录一下列名”，而是在决定：

- 哪些 `ById` 方法可合法存在
- 逻辑删除字段是谁
- 排序字段是谁
- 某个字段是否能进入插入/更新/查询策略判断

也就是说，`TableFieldInfo` 才是后续 SQL 生成真正依赖的字段级语义中心。

## 四、主键识别为什么是元数据期就必须解决的问题

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:472` `initTableIdWithAnnotation(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfoHelper.java:529` `initTableIdWithoutAnnotation(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:220` `havePK()`

这里最值得注意的是两条边界：

### 1. 多个 `@TableId` 直接报错

这不是生成 SQL 时再说，而是在元数据期就 fail-fast。

### 2. 没有 `@TableId`

MP 不会直接崩，而是尝试走无注解推断；仍然找不到时给出 warning，并影响后续 `ById` 系列方法注入。

这说明主键不是一个“字段属性”，而是后续注入、更新、逻辑删除、乐观锁都要依赖的结构性前提。

所以主键识别被放在元数据期，是合理且必须的。

## 五、`TableInfo` / `TableFieldInfo`：为什么它们不是注解 DTO，而是运行时语义载体

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:263` `chooseSelect(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableInfo.java:475` `initResultMapIfNeed()`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:406` `initLogicDelete(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:556` `getResultMapping(...)`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/metadata/TableFieldInfo.java:578` `getVersionOli()`

如果它们只是注解镜像，就不需要承载这些运行时能力：

- 选择哪些列参与 select
- 是否需要自动构造 resultMap
- 当前字段是不是逻辑删除字段
- 当前字段是不是版本字段
- 当前字段的 ResultMapping 怎样构造

这说明 `TableInfo` / `TableFieldInfo` 本质上不是“解析结果表”，而是：

**后续 SQL 注入、Wrapper、自动填充、逻辑删除、结果映射共同消费的运行时表语义对象。**

## 六、`GlobalConfig.DbConfig`：为什么 MP 的“默认世界”必须单独看，而不是散落到注解逻辑里

关键点在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:47` 类声明
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:103` `DbConfig`
- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/config/GlobalConfig.java:235` `getWhereStrategy()`

`DbConfig` 里真正定义的是一整套全局默认世界：

- `idType`
- `tablePrefix`
- `schema`
- `columnFormat` / `tableFormat` / `propertyFormat`
- `tableUnderline`
- `capitalMode`
- `keyGenerators`
- `logicDeleteField` / `logicDeleteValue` / `logicNotDeleteValue`
- `insertStrategy` / `updateStrategy` / `whereStrategy`
- `insertIgnoreAutoIncrementColumn`

这说明 MP 的注解解析并不是“纯局部优先”，而是始终站在一个全局默认世界上运行。

所以 `GlobalConfig.DbConfig` 不应该被理解成“配置文件附录”，而应该被理解成：

**表元数据解析的全局背景常量表。**

## 七、失败路径：为什么 MP-3 真正重要的不是“能解析成功”，而是“元数据边界何时提前爆炸”

### 1. 多个主键

`@TableId can't more than one` 直接在元数据期 fail-fast。

### 2. 没主键

不会立即崩，但会影响 `ById` 家族能力，并给出 warning。

### 3. 逻辑删除 / 版本字段边界

如果字段定义冲突，问题会在 `TableFieldInfo` 层暴露，而不是等 SQL 执行期才模糊出错。

### 4. `excludeProperty` 与 `autoResultMap`

表级排除和自动结果映射在表名/字段阶段就已经被确定，不能等结果映射阶段再去补救。

也就是说：

**MP 把很多“以后可能生成错误 SQL”的问题，尽量前移到元数据构建期。**

## 到这里，MP-3 真正立住的不是注解解释，而是“表元数据语义中心”

如果只看表面，这篇很容易被读成：

- `@TableName` 决定表名
- `@TableId` 决定主键
- `@TableField` 决定字段映射

这些都对，但远远不够。

更稳的理解方式应该是：

1. `TableInfoHelper` 把实体注解和全局配置一起收束成 `TableInfo/TableFieldInfo`
2. `GlobalConfig.DbConfig` 提供默认世界
3. `TableInfo` / `TableFieldInfo` 再把这些语义暴露给 SQL 注入、Wrapper、逻辑删除、自动填充和结果映射
4. 元数据边界问题必须在这一层提前暴露，而不能拖到执行期

所以这篇真正立住的是：

**MyBatis-Plus 不是直接消费注解，而是先把注解和全局配置收束成一套运行时表元数据中心。**

## 这篇之后，最自然的继续方向

到这里，已经知道了：

- 桥怎么接管
- CRUD statement 怎样注入
- 注入依赖的表元数据怎样建立

下一步最自然的问题就是：

- Lambda Wrapper 为什么能避免字段名硬编码，而且还能持续生长出完整条件链？

也就是说，下一篇应该进入 `MP-4 Wrapper / Lambda 条件构造器`。