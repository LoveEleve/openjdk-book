# vol-elasticsearch E-21 GEO — note

## 本篇主张
- `geo_point` 字段用 Lucene LatLonPoint 索引，支持 BKD 范围查询。
- `GeoDistanceQueryBuilder.java:40` 用 Haversine 公式做圆形距离查询。
- `GeoBoundingBoxQueryBuilder.java:45` 做矩形范围查询。
- `GeoShapeQueryBuilder.java:39` 做形状相交查询。

## 下篇桥接
- E-22 缓存体系。
