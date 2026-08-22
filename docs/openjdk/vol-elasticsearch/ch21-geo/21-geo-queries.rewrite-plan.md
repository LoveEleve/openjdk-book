# 篇：21 GEO 地理查询：GeoDistance/GeoBoundingBox/GeoShape

- 域：`E-21 GEO 地理查询`
- 卷：`vol-elasticsearch`
- 目标：回答 ES 怎么处理地理位置、距离和形状查询。

## 前置依赖
- HARD：已读 `E-7 Mapping`（geo_point/geo_shape 字段类型）、`E-17 Query DSL`（QueryBuilder 体系）。

## 读者问题
1. `geo_point` 字段怎么存储经纬度？
2. `GeoDistanceQueryBuilder` 怎么计算距离？
3. 圆形（GeoDistance）、矩形（GeoBoundingBox）、多边形（GeoPolygon）、形状（GeoShape）怎么匹配？
4. 距离计算用什么算法（Haversine）？

## 主结论
`index/query/` 包含 5 个 GEO QueryBuilder：`GeoDistanceQueryBuilder`(圆形)、`GeoBoundingBoxQueryBuilder`(矩形)、`GeoPolygonQueryBuilder`(多边形)、`GeoShapeQueryBuilder`(形状)、`GeoValidationMethod`(验证)。geo_point 字段用 GeoPointField（Lucene LatLonPoint）索引。

## 结构设计
1. 困惑开场：搜索附近 500m 的店怎么实现
2. geo_point 字段的索引方式
3. GeoDistance 圆形距离查询（Haversine）
4. GeoBoundingBox 矩形
5. GeoShape 形状

## 必须回填的源码锚点
- `index/query/GeoDistanceQueryBuilder.java:40` 类声明
- `index/query/GeoBoundingBoxQueryBuilder.java:45` 类声明
- `index/query/GeoShapeQueryBuilder.java:39` 类声明
- `index/query/GeoPolygonQueryBuilder.java` 多边形

## note / review 约束
- 四件套标准格式。
