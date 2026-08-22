# 搜索附近 500 米的店——ES 的 GEO 查询

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第二十一篇，回答 GEO 地理查询。

## 困惑：`"附近 500 米的咖啡店"` 在 ES 里怎么实现？

店铺有经纬度，存为 `geo_point` 字段。查询时用 `GeoDistanceQueryBuilder` 按圆心+半径匹配，或用 `GeoBoundingBoxQueryBuilder` 按矩形范围匹配。

## 分层拆解

### 1. geo_point 字段：经纬度怎么存

`geo_point` 字段类型在 ES 中存储经纬度。底层用 Lucene 的 `LatLonPoint`(即 GeoPointField) 索引，支持 BKD 树范围查询。

### 2. GeoDistanceQueryBuilder：圆形距离查询

`index/query/GeoDistanceQueryBuilder.java:40`：

```java
public class GeoDistanceQueryBuilder extends AbstractQueryBuilder<GeoDistanceQueryBuilder> {
```

查询 `{ "geo_distance": { "distance": "500m", "location": { "lat": 39.9, "lon": 116.4 } } }`。用 Haversine 公式计算球面距离，匹配圆形范围内文档。

### 3. GeoBoundingBoxQueryBuilder：矩形范围

`index/query/GeoBoundingBoxQueryBuilder.java:45`：

```java
public class GeoBoundingBoxQueryBuilder extends AbstractQueryBuilder<GeoBoundingBoxQueryBuilder> {
```

`{ "geo_bounding_box": { "location": { "top_left": {...}, "bottom_right": {...} } } }`。匹配矩形经纬度范围内的文档。

### 4. GeoShapeQueryBuilder：形状相交

`index/query/GeoShapeQueryBuilder.java:39`：

```java
public class GeoShapeQueryBuilder extends AbstractGeometryQueryBuilder<GeoShapeQueryBuilder> {
```

`geo_shape` 字段存多边形/线/点，`GeoShapeQueryBuilder` 做形状相交/包含/不相交查询。

## 收网

ES 的 GEO 查询通过 `index/query/` 的 4 个 QueryBuilder 实现：`GeoDistanceQueryBuilder`(圆形/Haversine)、`GeoBoundingBoxQueryBuilder`(矩形)、`GeoPolygonQueryBuilder`(多边形)、`GeoShapeQueryBuilder`(形状)。geo_point 用 LatLonPoint 索引支持 BKD 范围查询。

## 下篇桥接

E-22 缓存体系。
