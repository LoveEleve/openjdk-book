# Druid D-4 WallFilter SQL 防火墙 — note

## 本篇主张

- WallFilter 不是词表过滤，而是 Filter 链上的安全 Filter
- `WallProvider.check()` 先快速通道（白名单 / 黑名单），再硬检查 AST

## 本篇边界

- 不展开 StatFilter 统计细节
- 不展开 Parser 内部算法

## 下篇桥接

- D-7 将展开连接验证