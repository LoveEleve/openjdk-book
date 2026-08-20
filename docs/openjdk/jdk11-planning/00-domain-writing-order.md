# 25 域写作依赖序(拓扑排序)— Java 层面 v2.2

> 2026-08-13 | 依据: 依赖驱动排序(读者知识前置)+ 00-domain-discovery-v2.md 域定义
> v2.2 变更: 恢复域 34(JMX)、域 39(JFR)

## 一、方法

1. 每域列前置域;2. 去环(11↔13 按教学惯例先语言级后 CAS);3. 拓扑排序分层;4. 层内自由排

## 二、22 域依赖表

| 域 | 名称 | 前置域 | 依赖理由 |
|---|---|---|---|
| 01 | 字符串体系 | — | 一切的地基(不可变/equals/hashCode/编码) |
| 06 | 异常体系 | — | 异常语义无前置 |
| 02 | 数字与数学 | 01 | 包装类基于对象概念 |
| 03 | 对象与系统 | 01, 06 | Object/System 程序生命周期入口 |
| 11 | 线程与 ThreadLocal | 01, 06 | 并发域地基(语言级 synchronized/volatile) |
| 04 | 反射与注解 | 03, 07 | Class 元模型来自类加载结果 |
| 07 | 类加载器 | 03 | 双亲委派是类加载核心 |
| 08 | 集合框架 | 01, 02, 06 | 容器基础 |
| 17 | IO 流 | 01, 03 | 流/装饰器模式 |
| 24 | 时间日期与格式化 | 02 | 时间计算依赖数学概念 |
| 32 | Unsafe | 03, 04 | 直接操作对象内存 |
| 09 | Map 与哈希 | 08 | 哈希表是集合特化 |
| 13 | 原子类 | 11, 32 | CAS/volatile 封装 |
| 18 | 序列化 | 17, 04 | 流协议 + 反射构造 |
| 19 | Buffer 与 Channel | 17, 32 | NIO 基于流 + 直接内存 |
| 36 | JDBC | 03, 11 | DriverManager/连接生命周期 |
| 12 | 锁与同步器 | 11, 13 | AQS 基于 volatile+CAS |
| 16 | Stream | 08, 13 | 流水线操作集合 |
| 21 | Selector | 19, 03 | 非阻塞通道基于 Channel 概念 |
| 10 | 并发集合 | 09, 13, 12 | CHM 用 CAS+volatile+同步器 |
| 14 | 线程池 | 11, 12, 13 | Worker 用 AQS |
| 15 | 异步编程 | 12, 13, 14 | CF 基于 FJP/线程池 |
| 25 | Agent 与诊断机制 | 04, 07, 17 | attach/Instrumentation 基于类加载/反射/IO 概念 |
| 34 | JMX | 08, 11, 13 | MBeanServer 并发注册/通知 |
| 39 | JFR | 11, 13 | 事件录制依赖线程/并发安全 |

## 三、分层结果(写作顺序)

```
Layer 0: 01 字符串  06 异常
Layer 1: 02 数字数学  03 对象系统  11 线程ThreadLocal
Layer 2: 04 反射与注解  07 类加载  08 集合框架  17 IO流  24 时间日期  32 Unsafe
Layer 3: 09 Map哈希  13 原子类  18 序列化  19 BufferChannel  36 JDBC
Layer 4: 12 锁同步器  16 Stream  21 Selector  34 JMX  39 JFR
Layer 5: 10 并发集合  14 线程池  25 Agent与诊断
Layer 6: 15 异步编程
```

## 四、备注

- 层内排序按域号;实际写作可微调
- 跨层标注: 11/04/32 承接内部卷(C++ 层)的 Threads/Synchronization/Reflection/Unsafe 概念,引用内部卷篇名
- 域 15 最后写:ForkJoin/CompletableFuture 依赖全部并发基础
