# vol-elasticsearch E-21 GEO — review notes

## 事实审
- `index/query/GeoDistanceQueryBuilder.java:40` class GeoDistanceQueryBuilder ✅
- `index/query/GeoBoundingBoxQueryBuilder.java:45` class GeoBoundingBoxQueryBuilder ✅
- `index/query/GeoShapeQueryBuilder.java:39` class GeoShapeQueryBuilder ✅
- `index/query/GeoPolygonQueryBuilder.java` 存在 ✅

## 因果审
- geo_point 用 LatLonPoint 索引支持 BKD 范围查询 ✅
- GeoDistance 用 Haversine 计算球面距离 ✅
- 圆形/矩形/多边形/形状四种地理查询 ✅

## 结构审
- 从"附近 500 米咖啡店"困惑开场到 geo_point/四种 QueryBuilder 主线集中 ✅

## 读者审
- 读完能回答：ES 怎么实现附近搜索 ✅

## 依赖审
- 前置 E-7/E-17，后续 E-22 ✅

## 结论
E-21 通过六层审查。
