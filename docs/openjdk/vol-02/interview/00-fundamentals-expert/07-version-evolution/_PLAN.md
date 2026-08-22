# 07-version-evolution · 版本演进与参数体系

## 覆盖域（vol-02）

`03-arguments-flags`（Flag 系统）、`40-launcher`（启动流程）、`20-vm-operations`（VM 操作）、`39-runtime-monitoring`（ServiceThread/PeriodicTask）

## 题目清单

1. JDK 8 / 11 / 17 / 21 的关键差异？——默认 GC、Metaspace、偏向锁、`--illegal-access`、虚拟线程
2. `-XX` 参数怎么分类？——product/manageable/diagnostic/experimental；`define_pd_global` 平台覆盖
3. 什么是 `-Xms` 和 `-Xmx`？它们实际控制什么？——堆的最小/最大边界；`ReservedCodeCacheSize` 等是独立参数
4. JDK 8 的应用在 JDK 17 上能跑吗？——常见坑：PermGen 参数被忽略、偏向锁默认关闭、`--illegal-access` 行为改变
5. 什么是 `-XX:+PrintFlagsFinal`？——列出所有 flag 的当前值；`pd` 标志显示平台相关默认值

## 回答框架提示

本组尽量不写七张表式的版本对比。每道题用"某个参数/行为在哪个版本变了、为什么变、迁移时怎么办"的叙事。OS 视角：`-Xmx` 最终影响 `mmap` 的最大保留范围；`-XX:MetaspaceSize` 最终影响 `Metaspace::_capacity_until_GC` 的初始值。