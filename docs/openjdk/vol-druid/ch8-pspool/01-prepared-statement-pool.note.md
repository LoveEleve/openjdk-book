# Druid D-8 PreparedStatement 池 — note

## 本篇主张

- PreparedStatement 绑定 Connection，不能跨连接复用
- 缓存必须 per-connection，挂在 `DruidConnectionHolder` 下
- LRUCache 控制复用与淘汰

## 本篇边界

- 不展开连接验证
- 不展开 Boot 装配

## 下篇桥接

- D-9 将展开 Spring Boot 3 Starter