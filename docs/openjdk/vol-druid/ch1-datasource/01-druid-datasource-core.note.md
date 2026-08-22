# Druid D-1 DruidDataSource 核心 — note

## 本篇主张

- Druid 不是 HikariCP 的增强版，池内并发模型不同
- `init()` 是配置对象到运行池的转折点
- `connections[maxActive]` 固定数组决定了池存储的并发边界

## 本篇边界

- 不展开 Filter 链
- 不展开 SQL 解析

## 下篇桥接

- D-5 将展开 shrink 维护体系