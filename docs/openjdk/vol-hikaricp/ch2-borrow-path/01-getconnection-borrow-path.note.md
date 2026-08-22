# HikariCP Ch2-01 连接获取完整流程 — note

## 本篇主张

- getConnection 不是"取对象"，而是"候选连接 → 验证 → 代理交付"的借出链。HikariDataSource.getConnection() 决定快路径或惰性初始化，HikariPool.getConnection() 是编排中心，ConcurrentBag.borrow() 只解决候选获取。
- 借出成功不等于可交付，alive/evict 是借出链里的安全门。代理连接保证控制权在交付后不丢失。

## 本篇边界

- 不展开归还与驱逐完整后半段
- 不展开 ConcurrentBag 全量并发设计

## 下篇桥接

- Ch3 将展开归还与驱逐——借出链立住后，后半段自然就是连接如何归还、如何被驱逐。