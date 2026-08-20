# 04-arthas-integration 重写规划

> 状态：本轮按一轮闭环执行；保留该 plan 作为后续二轮 consistency pass 的工件
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Arthas 与 async-profiler 分工说明文”重写成一篇围绕“为什么 Arthas profiler 和 `asprof` 看起来像两套工具，但真正关系是命令层包装 vs native 采样内核；以及线上排查为什么要先全景采样、再交互式下钻”的面向用户机制文章

## 1. 读者困惑

- 为什么 Arthas 的 `profiler` 命令和直接运行 `asprof` 看起来像两套工具，却又经常给出相似结果？
- Arthas 和 async-profiler 到底谁负责采样内核，谁负责交互入口？
- 为什么线上排查通常是“先全景定位，再局部下钻”，而不是一开始就全靠 `watch/trace`？
- 容器、权限、`perf_event_open`、attach 失败这类问题，究竟是 Arthas 的问题还是 async-profiler 的问题？
- 同一类问题在两边的姿势为什么不同：CPU/alloc/lock/wall 到底怎样分工？

## 2. 一句话顿悟

**Arthas profiler 和 `asprof` 不是两套平行采样器，而是上下层关系：Arthas 提供交互式 Java 命令入口，async-profiler 提供真正的 native 采样内核；因此线上最稳的策略通常是先用 async-profiler 做低侵入全景定位，再用 Arthas 的 `watch/trace/thread -b/tt` 等命令解释局部现场。**

## 3. 总图

```text
Arthas profiler 命令
  → Java 命令层包装 / execute 字符串协议
    → async-profiler native 参数解析与采样内核
      → CPU / alloc / lock / wall / JFR / flamegraph

线上排查
  → 先用 async-profiler 做低侵入全景采样
    → 再用 Arthas watch / trace / tt / thread -b 下钻局部
```

## 4. 关键边界

- 本篇讲的是工具分工与使用层工作流，不重讲 async-profiler 或 Arthas 内部实现细节。
- Arthas profiler 不是另一套 native 采样引擎；它最终仍落到 async-profiler 的命令协议和采样内核。
- `asprof` 更接近 native 真实能力面；Arthas 更接近交互式 Java 运维入口。
- “先全景，再下钻”不是教条，而是为了先控制线上观测成本，再逐步提高信息密度。
- 容器、权限、`perf_event_open`、attach、库路径、fdtransfer 等系统边界，最终都属于 async-profiler/native 采样条件，而不是 Arthas 命令层独有问题。
- 同一类问题在两边的最优姿势不同：采样统计适合先定位，方法观察/表达式观察适合再解释。

## 5. 本轮重写主线

1. 用“看起来像两套工具，其实不是两套内核”开场。
2. 否定：Arthas profiler 与 `asprof` 是竞争关系、所有线上问题都该一开始就上 `watch/trace`、容器失败主要是 Arthas 命令问题。
3. 先讲 Arthas vs async-profiler 的上下层边界。
4. 再讲“先全景、再下钻”的线上排查策略。
5. 再用 CPU/内存/锁/阻塞四类问题对照说明两边姿势不同。
6. 最后把容器/权限/attach 边界拉回 native 采样条件，强调集成层能遮蔽命令复杂度，遮不掉系统边界。
