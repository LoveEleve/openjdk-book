# HikariCP Ch8-01 JMX 与运行时管理 — note

## 本篇主张

- JMX 是运行时控制面，不只是简单状态接口。HikariPoolMXBean 与 HikariConfigMXBean 分别承担状态视角（观察池运行时状态）和配置视角（在 sealing 边界内修改配置）。
- sealing 不是在反对运行时管理，而是在定义运行时管理边界——哪些配置可热改，哪些在启动后不可变。

## 本篇边界

- 不展开连接验证与泄漏检测细节
- 不展开 metrics/Micrometer/Prometheus 指标体系

## 下篇桥接

- Ch9 将展开指标监控体系——JMX 讲完控制面，下一篇自然是持续量化与外部采集的观测面。