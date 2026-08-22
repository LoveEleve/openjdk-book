# Druid D-7 连接验证 — note

## 本篇主张

- Druid 有三种验证时机：`testOnBorrow`（借出前）、`testWhileIdle`（空闲时）、`testOnReturn`（归还后）
- `ValidConnectionChecker` SPI 适配不同数据库

## 本篇边界

- 不展开 shrink 维护体系
- 不展开 Boot 装配

## 下篇桥接

- D-8 将展开 PreparedStatementPool