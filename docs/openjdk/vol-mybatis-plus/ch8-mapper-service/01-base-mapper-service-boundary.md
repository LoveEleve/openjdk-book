# 为什么继承 BaseMapper 就能拥有完整 CRUD，extends ServiceImpl 就能拥有批量操作

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲 `BaseMapper`、`IService`、`ServiceImpl` 三层接口如何把 `MP-1` 到 `MP-7` 建立的所有增强机制收束到用户代码可直接调用的 CRUD 边界。不重讲增强机制内部实现。

## 为什么"继承 BaseMapper 就能 CRUD"这个理解会把应用边界读浅

很多人第一次用 MP，会觉得发生的事情很简单：

- 继承 `BaseMapper` 就能省掉 XML

这当然不是错，但它会把真正关键的变化读扁。

因为如果你只看"省 XML"，就很难解释：

- 为什么 3.5.7 的 `deleteById(Serializable id)` 要改成 `deleteById(Object obj, boolean useFill)`
- 为什么 `BaseMapper` 的批量方法要直接返回 `List<BatchResult>` 而不是 `int`
- 为什么 `IService` 的 `save()` 返回 `boolean` 而不是 `int`
- 为什么 `ServiceImpl` 要注入 `SqlSessionFactory` 而不是 `SqlSession`

也就是说，`BaseMapper` / `IService` / `ServiceImpl` 不是"帮你省代码"，而是：

**把 `MP-1` 到 `MP-7` 建立的所有增强机制收束到用户代码可直接调用的三层边界。**

## 三层的最小总图

```text
BaseMapper<T>            (mybatis-plus-core)
  -> insert / deleteById / updateById / selectById / selectList / selectPage
  -> insert(Collection) / updateById(Collection) / insertOrUpdate(Collection)  [3.5.7 batch]
  -> deleteById(Object, boolean useFill)  [3.5.7 logic-delete fill]

IService<T>              (mybatis-plus-extension)
  -> save / remove / update / getOne / list / page
  -> saveBatch / saveOrUpdateBatch / updateBatchById  [batch]
  -> lambdaQuery / lambdaUpdate  [chain]

ServiceImpl<M, T>        (mybatis-plus-extension)
  -> @Autowired protected M baseMapper
  -> getSqlSessionFactory()
  -> executeBatch(Collection, int, BiConsumer)
  -> saveBatch / saveOrUpdateBatch / updateBatchById
```

## 一、`BaseMapper<T>`：增强版 Mapper 层接口

关键类在：

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:101` 接口声明
- `.../BaseMapper.java:108` `insert(T entity)`
- `.../BaseMapper.java:115` `deleteById(Serializable id)` default 方法
- `.../BaseMapper.java:126` `deleteById(Object obj, boolean useFill)` 3.5.7 适配
- `.../BaseMapper.java:147` `deleteById(T entity)` 实体删除
- `.../BaseMapper.java:163` `delete(Wrapper<T>)`
- `.../BaseMapper.java:224` `updateById(T entity)`
- `.../BaseMapper.java:232` `update(T entity, Wrapper<T>)`
- `.../BaseMapper.java:250` `selectById(Serializable id)`
- `.../BaseMapper.java:294` `selectOne(Wrapper<T>)`
- `.../BaseMapper.java:325` `exists(Wrapper<T>)`
- `.../BaseMapper.java:335` `selectCount(Wrapper<T>)`
- `.../BaseMapper.java:342` `selectList(Wrapper<T>)`
- `.../BaseMapper.java:377` `selectMaps(Wrapper<T>)`
- `.../BaseMapper.java:413` `selectObjs(Wrapper<T>)`
- `.../BaseMapper.java:431` `selectPage(IPage<T>, Wrapper<T>)`
- `.../BaseMapper.java:442` `selectMapsPage(IPage<Map>, Wrapper<T>)`

从接口声明就能看出它继承了 MyBatis 的 `Mapper<T>`，这意味着：

- 它保留了 MyBatis Mapper 的所有能力
- 但通过 `default` 方法和抽象方法，把 MP 增强机制注入进来

### 1. 3.5.7 逻辑删除填充适配

3.5.7 对 `deleteById` 做了一个重要改动：

- 旧版：`deleteById(Serializable id)` 只接收 ID
- 新版：`deleteById(Object obj, boolean useFill)` 可以接收实体对象

这是因为逻辑删除 + 自动填充场景下，删除操作需要填充 `delete_user` 等字段，只有传入实体对象才能触发填充。

关键代码在 `.../BaseMapper.java:126`-`139`：

1. 检查传入对象是否是实体类型
2. 如果不是实体且 `useFill=true`，检查是否启用逻辑删除 + 更新填充
3. 如果是，创建实体实例并设置主键值
4. 调用 `this.deleteById(instance)` 走实体删除路径

这说明 `BaseMapper` 的方法签名不是随意设计的，而是：

**为了在逻辑删除 + 自动填充场景下正确工作，3.5.7 把方法签名从"接收 ID"改为"接收 Object + useFill 标志"。**

### 2. 3.5.7 批量方法

3.5.7 在 `BaseMapper` 中新增了大量批量方法：

- `.../BaseMapper.java:470` `insert(Collection<T>)` 默认批次大小
- `.../BaseMapper.java:481` `insert(Collection<T>, int batchSize)` 自定义批次大小
- `.../BaseMapper.java:494` `updateById(Collection<T>)` 默认批次大小
- `.../BaseMapper.java:505` `updateById(Collection<T>, int batchSize)` 自定义批次大小
- `.../BaseMapper.java:518` `insertOrUpdate(Collection<T>)` 默认批次大小
- `.../BaseMapper.java:558` `insertOrUpdate(Collection<T>, BiPredicate, int batchSize)` 自定义批次大小

这些方法的实现路径是：

1. 通过 `MybatisUtils.getMybatisMapperProxy(this)` 获取 Mapper 代理信息
2. 构造 `MybatisBatch.Method<T>` 指定操作类型
3. 通过 `MybatisBatchUtils.execute(...)` 或 `MybatisBatchUtils.saveOrUpdate(...)` 执行批量操作
4. 返回 `List<BatchResult>`

这说明 `BaseMapper` 的批量方法不是"帮你循环调用单条方法"，而是：

**直接通过 `MybatisBatch` 机制实现真正的 JDBC 批量提交。**

### 3. `insertOrUpdate` 的实现

`.../BaseMapper.java:453` 的 `insertOrUpdate(T entity)` 实现是：

1. 解析实体类型，获取 `TableInfo`
2. 获取主键属性和值
3. 如果主键值为空或 `selectById` 返回 null，调用 `insert`
4. 否则调用 `updateById`

这说明 `insertOrUpdate` 不是数据库层面的 upsert，而是：

**应用层的"查后决定插入还是更新"。**

## 二、`IService<T>`：服务层接口

关键类在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/service/IService.java:48` 接口声明
- `.../IService.java:60` `save(T entity)`
- `.../IService.java:80` `saveBatch(Collection<T>, int batchSize)`
- `.../IService.java:98` `saveOrUpdateBatch(Collection<T>, int batchSize)`
- `.../IService.java:105` `removeById(Serializable id)`
- `.../IService.java:117` `removeById(Serializable id, boolean useFill)`
- `.../IService.java:146` `remove(Wrapper<T>)`
- `.../IService.java:155` `removeByIds(Collection<?>)`

### 1. 返回值语义转换

`BaseMapper` 的方法返回 `int`（影响行数），而 `IService` 的方法返回 `boolean`（是否成功）。

例如：

- `BaseMapper.insert(T entity)` 返回 `int`
- `IService.save(T entity)` 返回 `boolean`，内部调用 `SqlHelper.retBool(getBaseMapper().insert(entity))`

这说明 `IService` 不是简单的"帮你调 Mapper"，而是：

**把 `int` 返回值转换为 `boolean` 语义，并叠加 `@Transactional`、批量提交等能力。**

### 2. 链式查询

`IService` 还提供了链式查询能力：

- `lambdaQuery()` 返回 `LambdaQueryChainWrapper`
- `lambdaUpdate()` 返回 `LambdaUpdateChainWrapper`

这说明 `IService` 不是简单的"帮你调 Mapper"，而是：

**提供链式查询 API，让用户代码更简洁。**

## 三、`ServiceImpl<M, T>`：服务层实现

关键类在：

- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/service/impl/ServiceImpl.java:53` 类声明
- `.../ServiceImpl.java:57` `@Autowired protected M baseMapper`
- `.../ServiceImpl.java:61` `getBaseMapper()`
- `.../ServiceImpl.java:72` `getEntityClass()`
- `.../ServiceImpl.java:86` `getSqlSessionFactory()`
- `.../ServiceImpl.java:119` `getMapperClass()`
- `.../ServiceImpl.java:180` `saveBatch(Collection<T>, int batchSize)`
- `.../ServiceImpl.java:192` `getSqlStatement(SqlMethod)`
- `.../ServiceImpl.java:202` `saveOrUpdate(T entity)`
- `.../ServiceImpl.java:209` `saveOrUpdateBatch(Collection<T>, int batchSize)`
- `.../ServiceImpl.java:227` `updateBatchById(Collection<T>, int batchSize)`
- `.../ServiceImpl.java:278` `executeBatch(Collection<E>, int batchSize, BiConsumer<SqlSession, E>)`

### 1. 自动注入 `baseMapper`

`ServiceImpl` 通过 `@Autowired protected M baseMapper` 自动注入 Mapper。

这说明 `ServiceImpl` 的自动注入不是"帮你省一行 `@Autowired`"，而是：

**通过 Spring 的泛型自动装配机制，把正确的 Mapper 代理注入到 Service 中。**

### 2. `getSqlSessionFactory()`

`ServiceImpl` 通过 `getSqlSessionFactory()` 获取 `SqlSessionFactory`，实现路径是：

1. 通过 `MybatisUtils.getMybatisMapperProxy(this.getBaseMapper())` 获取 Mapper 代理信息
2. 通过 `MybatisUtils.getSqlSessionFactory(mybatisMapperProxy)` 获取 `SqlSessionFactory`

这说明 `ServiceImpl` 不是直接注入 `SqlSessionFactory`，而是：

**通过 Mapper 代理间接获取 `SqlSessionFactory`，确保使用的是正确的会话工厂。**

### 3. `executeBatch(...)`

`ServiceImpl` 的批量操作通过 `executeBatch(...)` 实现，关键代码在 `.../ServiceImpl.java:278`：

它调用 `SqlHelper.executeBatch(getSqlSessionFactory(), this.log, list, batchSize, consumer)`。

`SqlHelper.executeBatch(...)` 的实现是：

1. 打开一个 `BATCH` 模式的 `SqlSession`
2. 遍历集合，对每个元素调用 `consumer`
3. 每隔 `batchSize` 条执行一次 `flushStatements`
4. 最后提交事务

这说明 `ServiceImpl` 的批量操作不是"帮你循环调用单条方法"，而是：

**通过 `BATCH` 模式的 `SqlSession` 实现真正的 JDBC 批量提交。**

### 4. `saveOrUpdateBatch(...)`

`ServiceImpl` 的 `saveOrUpdateBatch(...)` 实现是：

1. 获取 `TableInfo` 和主键属性
2. 调用 `SqlHelper.saveOrUpdateBatch(...)` 传入两个 lambda：
   - 判断是否需要插入：检查主键值是否为空或 `selectById` 是否返回空
   - 执行更新：调用 `sqlSession.update(getSqlStatement(SqlMethod.UPDATE_BY_ID), param)`

这说明 `saveOrUpdateBatch` 不是"帮你循环调用 insertOrUpdate"，而是：

**在批量模式下，先查后决定插入还是更新，并通过 JDBC 批量提交提高性能。**

## 四、三层与 `MP-1` 到 `MP-7` 的关系

`BaseMapper` / `IService` / `ServiceImpl` 是 `MP-1` 到 `MP-7` 建立的所有增强机制的最终收束点：

- MP-1（Configuration 替换与 Mapper 注册桥）-> `BaseMapper` 继承 `Mapper<T>`，通过 `MybatisConfiguration` 注入增强 MappedStatement
- MP-2（SQL 自动注入与 MappedStatement 批量生成）-> `BaseMapper` 的 `insert`/`deleteById`/`updateById`/`selectById` 等方法由 `SqlInjector` 自动生成
- MP-3（表元数据解析与 GlobalConfig 边界）-> `BaseMapper` 的 `insertOrUpdate` 和 `deleteById(Object, boolean)` 依赖 `TableInfo`
- MP-4（Wrapper / Lambda 条件构造器）-> `BaseMapper` 的 `delete(Wrapper)`/`update(T, Wrapper)`/`selectList(Wrapper)` 接收 Wrapper
- MP-5（插件总线与 SQL 改写入口）-> `ServiceImpl` 的 `executeBatch` 通过 `SqlSessionFactory` 间接受插件影响
- MP-6（内置运行时增强专题组）-> `BaseMapper` 的 `insert`/`updateById`/`selectList` 等方法在运行时被插件改写
- MP-7（Spring Boot 自动装配桥）-> `ServiceImpl` 的 `@Autowired baseMapper` 依赖 Boot 自动装配的 Mapper 扫描

这说明 `BaseMapper` / `IService` / `ServiceImpl` 不是独立存在的，而是：

**`MP-1` 到 `MP-7` 建立的所有增强机制的最终收束点。**

## 到这里，MP-8 真正立住的不是 CRUD 便利性，而是"应用边界层"

如果只看表面，这篇很容易被读成：

- `BaseMapper` 提供了 CRUD 方法
- `IService` 提供了事务和批量支持
- `ServiceImpl` 提供了实现

这些都对，但还不够。

更稳的理解方式应该是：

1. `BaseMapper` 把 `MP-1` 到 `MP-6` 的增强机制收束到 Mapper 层接口
2. `IService` 把 `int` 返回值转为 `boolean`，并叠加 `@Transactional`、批量提交、链式查询
3. `ServiceImpl` 通过 `@Autowired baseMapper` + `getSqlSessionFactory()` + `executeBatch()` 把 `IService` 的 default 方法与增强机制连接起来
4. 3.5.7 的批量方法和逻辑删除填充适配说明这个边界层还在持续演进

所以这篇真正立住的是：

**`BaseMapper` / `IService` / `ServiceImpl` 是 `MP-1` 到 `MP-7` 建立的所有增强机制的最终收束点。**

## 到这里，`vol-mybatis-plus` 的全部域已经闭合

到这里，`vol-mybatis-plus` 的所有域都已经立住：

- `MP-1` Configuration 替换与 Mapper 注册桥
- `MP-2` SQL 自动注入与 MappedStatement 批量生成
- `MP-3` 表元数据解析与 GlobalConfig 边界
- `MP-4` Wrapper / Lambda 条件构造器
- `MP-5` 插件总线与 SQL 改写入口
- `MP-6` 内置运行时增强专题组
- `MP-7` Spring Boot 自动装配桥
- `MP-8` BaseMapper / IService 应用边界层

下一步是卷级收尾：

- 统一做一轮卷级六层复审
- 再补 README、导读、总图索引
