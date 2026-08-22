# HikariCP Ch9-01 指标监控体系 — note

## 本篇主张

- metrics 是连接生命史的持续观测面。统一观测抽象（IMetricsTracker/MetricsTrackerFactory）先于具体平台实现存在，Dropwizard/Micrometer/Prometheus 实现只是外壳。
- PoolStats 解决的是状态采样成本与精度之间的平衡，而不是每次现算。

## 本篇边界

- 不展开 JMX 控制面
- 不展开泄漏检测

## 下篇桥接

- 本卷主干层与诊断可观测层已闭合。HikariCP 第一阶段已阶段性收口，可进入卷级整理或切换到下一个框架。