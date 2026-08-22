# MP-8 BaseMapper / IService 应用边界层 — note

## 本篇主张

- `BaseMapper` / `IService` / `ServiceImpl` 不是简单的"省代码"封装，而是 `MP-1` 到 `MP-7` 建立的所有增强机制的最终收束点。
- 3.5.7 对 `BaseMapper` 做了两个重要改动：逻辑删除填充适配（`deleteById(Object, boolean)`）和批量方法（`insert(Collection)`、`updateById(Collection)`、`insertOrUpdate(Collection)`）。
- `IService` 把 `int` 返回值转为 `boolean`，并叠加 `@Transactional`、批量提交、链式查询。
- `ServiceImpl` 通过 `@Autowired baseMapper` + `getSqlSessionFactory()` + `executeBatch()` 把 `IService` 的 default 方法与增强机制连接起来。

## 本篇边界

- 不重讲 `MP-1` 到 `MP-7` 的内部实现。
- 不展开每个 IService 方法的完整签名。
- 只在需要时点到 3.5.7 批量方法和逻辑删除填充适配。

## 下篇桥接

- MP-8 是 `vol-mybatis-plus` 的最后一个域。
- 下一步是卷级六层总审、README、导读、总图索引。