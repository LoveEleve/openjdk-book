# HikariCP Ch1-01 连接池核心架构 — note

## 本篇主张

- HikariCP 不是"存连接的池子"，而是一条连接生命史管理链。HikariConfig → HikariDataSource → HikariPool → PoolEntry 三层骨架各负责不同角色。
- 连接池关心的不是"容器里有多少对象"，而是"连接这一生如何被管理"——HouseKeeper、maxLifetime、keepalive、fail-fast、sealing 都是同一条连接生命史上的控制节点。

## 本篇边界

- 不展开 ConcurrentBag 内部并发设计
- 不展开 getConnection 完整借出流程、close()/归还/驱逐细节、metrics/JMX/leak detection 细节

## 下篇桥接

- Ch2 将展开连接获取完整流程——主骨架立住后，下一步自然沿生命史进入借出链。