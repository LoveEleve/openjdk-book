# 篇：01 BaseMapper / IService / ServiceImpl 应用边界层

- 域：`MP-8 BaseMapper / IService 应用边界层`
- 卷：`vol-mybatis-plus`
- 目标：回答 `BaseMapper`、`IService`、`ServiceImpl` 三层接口如何把 `MP-1` 到 `MP-7` 的所有增强机制收束到用户代码可直接调用的 CRUD 边界。

## 前置依赖

- HARD：已读 `MP-1` 到 `MP-7`，知道增强版 Configuration、SQL 注入、表元数据、Wrapper、插件总线、增强家族、Boot 装配桥。

## 读者问题

用户代码只写 `extends BaseMapper<T>` 或 `extends ServiceImpl<...>` 就能拥有完整 CRUD + 批量操作 + 分页 + Wrapper。以及：

1. `BaseMapper` 的方法签名为什么在 3.5.7 大量从"接收 ID"改为"接收 Object"以支持逻辑删除填充
2. `BaseMapper` 的批量方法（`insert(Collection)`、`updateById(Collection)`、`insertOrUpdate(Collection)`）如何通过 `MybatisBatch` / `MybatisBatchUtils` 实现
3. `IService` 的 `save` / `remove` / `update` / `getOne` / `list` / `page` 方法如何把返回值从 `int` 转为 `boolean` 并加上事务和批量支持
4. `ServiceImpl` 的 `@Autowired protected M baseMapper` 如何自动注入到正确的 Mapper 代理
5. `ServiceImpl.executeBatch(...)` 如何在事务 + 批量提交之间切换

## 主结论

`BaseMapper` / `IService` / `ServiceImpl` 不是简单的"省代码"封装，而是：

- `BaseMapper`：把 `MP-1` 到 `MP-6` 建立的所有增强机制收束到 Mapper 层接口，用户继承即可使用
- `IService`：把 `int` 返回值转为 `boolean`，并叠加 `@Transactional`、批量提交、链式查询
- `ServiceImpl`：把 `IService` 的 default 方法与 `@Autowired baseMapper` + `SqlSessionFactory` + `executeBatch` 连接起来

## 结构设计

1. 困惑开场：为什么继承 `BaseMapper` 就能拥有完整 CRUD
2. `BaseMapper<T>`：接口签名、3.5.7 逻辑删除填充适配、批量方法
3. `IService<T>`：接口签名、返回值语义转换、链式查询
4. `ServiceImpl<M, T>`：自动注入、`getSqlSessionFactory`、`executeBatch`、`saveOrUpdateBatch`
5. 三层与 `MP-1` 到 `MP-7` 的关系：所有增强机制最终都收束到这三个接口
6. 收网：这篇立住的是"应用边界层"

## 必须回填的源码锚点

- `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:101` 接口声明
- `.../BaseMapper.java:108` `insert(T entity)`
- `.../BaseMapper.java:115` `deleteById(Serializable id)` default 方法
- `.../BaseMapper.java:126` `deleteById(Object obj, boolean useFill)` 3.5.7 适配
- `.../BaseMapper.java:147` `deleteById(T entity)` 实体删除
- `.../BaseMapper.java:163` `delete(Wrapper<T>)`
- `.../BaseMapper.java:184` `deleteByIds(Collection<?>)` 3.5.7 替代 deleteBatchIds
- `.../BaseMapper.java:205` `deleteByIds(Collection<?>, boolean useFill)` 3.5.7 逻辑删除填充
- `.../BaseMapper.java:224` `updateById(T entity)`
- `.../BaseMapper.java:232` `update(T entity, Wrapper<T>)`
- `.../BaseMapper.java:250` `selectById(Serializable id)`
- `.../BaseMapper.java:294` `selectOne(Wrapper<T>)`
- `.../BaseMapper.java:305` `selectOne(Wrapper<T>, boolean throwEx)`
- `.../BaseMapper.java:325` `exists(Wrapper<T>)`
- `.../BaseMapper.java:335` `selectCount(Wrapper<T>)`
- `.../BaseMapper.java:342` `selectList(Wrapper<T>)`
- `.../BaseMapper.java:377` `selectMaps(Wrapper<T>)`
- `.../BaseMapper.java:413` `selectObjs(Wrapper<T>)`
- `.../BaseMapper.java:431` `selectPage(IPage<T>, Wrapper<T>)`
- `.../BaseMapper.java:442` `selectMapsPage(IPage<Map>, Wrapper<T>)`
- `.../BaseMapper.java:453` `insertOrUpdate(T entity)` 3.5.7
- `.../BaseMapper.java:470` `insert(Collection<T>)` 3.5.7 批量
- `.../BaseMapper.java:481` `insert(Collection<T>, int batchSize)` 3.5.7 批量
- `.../BaseMapper.java:494` `updateById(Collection<T>)` 3.5.7 批量
- `.../BaseMapper.java:505` `updateById(Collection<T>, int batchSize)` 3.5.7 批量
- `.../BaseMapper.java:518` `insertOrUpdate(Collection<T>)` 3.5.7 批量
- `.../BaseMapper.java:558` `insertOrUpdate(Collection<T>, BiPredicate, int batchSize)` 3.5.7 批量
- `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/service/IService.java:48` 接口声明
- `.../IService.java:60` `save(T entity)`
- `.../IService.java:80` `saveBatch(Collection<T>, int batchSize)`
- `.../IService.java:98` `saveOrUpdateBatch(Collection<T>, int batchSize)`
- `.../IService.java:105` `removeById(Serializable id)`
- `.../IService.java:117` `removeById(Serializable id, boolean useFill)`
- `.../IService.java:146` `remove(Wrapper<T>)`
- `.../IService.java:155` `removeByIds(Collection<?>)`
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

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。