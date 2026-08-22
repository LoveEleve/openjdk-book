# HikariCP Ch4-01 ConcurrentBag 无锁并发设计 — note

## 本篇主张

- ConcurrentBag 不是普通容器，而是借还协作协议。ThreadLocal（本地命中快路径）→ sharedList（共享可见性）→ handoffQueue（等待线程与归还线程的移交层）三层结构共同实现高并发借还。
- 状态机（NOT_IN_USE/IN_USE/RESERVED/REMOVED）比容器本身更重要，它决定对象在借/还/保留/移除中的安全性。

## 本篇边界

- 不展开 HouseKeeper 维护逻辑
- 不展开驱逐策略细节

## 下篇桥接

- Ch5 将展开 HouseKeeper 如何与 ConcurrentBag 协作管理连接余生——借还与并发结构立住后，下一步自然就是后台维护如何推动连接生老病死。