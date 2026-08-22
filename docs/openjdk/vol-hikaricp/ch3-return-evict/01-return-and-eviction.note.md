# HikariCP Ch3-01 连接归还与连接驱逐 — note

## 本篇主张

- close() 不是关闭连接，而是连接命运判断入口。归还前必须 rollback/reset/清状态的正确性保证，与 dirtyBits 性能优化，是后半链的两条腿。
- 异常驱逐是后半链的核心判断点——checkException() 会把异常上升成连接命运判断，recycle()/requite() 代表继续活的分支，驱逐代表退出分支。

## 本篇边界

- 不展开 ConcurrentBag 完整并发设计
- 不展开 HouseKeeper/maxLifetime/keepalive 后台维护

## 下篇桥接

- Ch4 将展开 ConcurrentBag 无锁并发设计——借出链和归还链都讲完后，下一步自然是池内存储层如何工作。