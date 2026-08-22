# MP-8 BaseMapper / IService 应用边界层 — review notes

## 事实审

- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java:101`（接口声明）、`:108`（`insert`）、`:115`（`deleteById(Serializable)`）、`:126`（`deleteById(Object, boolean)`）、`:147`（`deleteById(T entity)`）、`:163`（`delete(Wrapper)`）、`:224`（`updateById`）、`:232`（`update`）、`:250`（`selectById`）、`:294`（`selectOne`）、`:305`（`selectOne` throwEx）、`:325`（`exists`）、`:335`（`selectCount`）、`:342`（`selectList`）、`:377`（`selectMaps`）、`:413`（`selectObjs`）、`:431`（`selectPage`）、`:442`（`selectMapsPage`）、`:453`（`insertOrUpdate`）、`:470`-`:486`（`insert(Collection)` 批量）、`:494`-`:509`（`updateById(Collection)` 批量）、`:518`-`:539`（`insertOrUpdate(Collection)` 批量）、`:558`-`:563`（`insertOrUpdate(Collection, BiPredicate, int)` 批量），BaseMapper 主线成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/service/IService.java:48`（接口声明）、`:60`（`save`）、`:80`（`saveBatch`）、`:98`（`saveOrUpdateBatch`）、`:105`（`removeById`）、`:117`（`removeById` useFill）、`:146`（`remove(Wrapper)`）、`:155`（`removeByIds`），IService 主线成立。
- 已核对 `mybatis-plus-extension/src/main/java/com/baomidou/mybatisplus/extension/service/impl/ServiceImpl.java:53`（类声明）、`:57`（`@Autowired baseMapper`）、`:61`（`getBaseMapper`）、`:72`（`getEntityClass`）、`:86`（`getSqlSessionFactory`）、`:119`（`getMapperClass`）、`:180`（`saveBatch`）、`:192`（`getSqlStatement`）、`:202`（`saveOrUpdate`）、`:209`（`saveOrUpdateBatch`）、`:227`（`updateBatchById`）、`:278`（`executeBatch`），ServiceImpl 主线成立。

## 因果审

- `BaseMapper` 继承 `Mapper<T>` 是 MP 增强机制收束到 Mapper 层的入口，正文成立。
- 3.5.7 `deleteById(Object, boolean useFill)` 改动是为了逻辑删除 + 自动填充场景下正确工作，正文成立。
- 3.5.7 批量方法通过 `MybatisBatch` / `MybatisBatchUtils` 实现 JDBC 批量提交，正文成立。
- `IService` 的 `save()` 返回 `boolean` 是因为 `SqlHelper.retBool()` 转换，正文成立。
- `ServiceImpl.executeBatch()` 通过 `SqlHelper.executeBatch()` 实现 BATCH 模式 SqlSession，正文成立。

## 结构审

- 从"为什么继承 BaseMapper 就能拥有完整 CRUD"困惑开场，再落到三层总图、BaseMapper、IService、ServiceImpl、三层与 MP-1~MP-7 的关系，主线集中。
- 没有把 `MP-1` 到 `MP-7` 的内容重讲一遍，符合方法论。

## 读者审

- 读完应能回答：为什么 3.5.7 的 `deleteById` 要改成 `deleteById(Object, boolean)`。
- 读完应能回答：`BaseMapper` 的批量方法如何实现 JDBC 批量提交。
- 读完应能回答：`ServiceImpl` 的 `executeBatch` 如何在 BATCH 模式下工作。
- 读完后能自然进入卷级收尾，而不会把应用边界层和增强机制混成一层。

## 边界审

- 本篇没有把每个 `IService` 方法的完整签名全部展开。
- 卷级六层总审、README、导读、总图索引都未提前透支，边界成立。

## 依赖审

- 前置依赖：MP-1 到 MP-7 全部（HARD）。
- 后续桥接：卷级六层总审、README、导读、总图索引。

## 结论

MP-8 已完成单域四件套的事实回填与六层审查，`vol-mybatis-plus` 全部 8 个域已完成，可进入卷级收尾。
