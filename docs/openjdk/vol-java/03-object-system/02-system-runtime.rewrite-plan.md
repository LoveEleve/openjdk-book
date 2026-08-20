# 03-object-system/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 System、Runtime、Shutdown 与属性初始化实现。
> 目标：把 System/Runtime API 清单改写成一篇解释“进程时间、状态、退出”三类全局能力如何被门面统一管理的文章。

## 1. 读者困惑

- `currentTimeMillis` 和 `nanoTime` 为什么不能互换？
- `arraycopy` 为什么比手写循环快？
- `System.getProperty` 的属性是谁放进去的，为什么 JDK 还要保存私有副本？
- `System.exit`、`Runtime.exit`、shutdown hook、`halt` 谁先谁后？

## 2. 一句话顿悟

**System/Runtime 不是普通工具类，而是当前 JVM 进程的门面：时间、数组拷贝、属性和退出都把 Java API 接到 native/JVM 状态；使用时必须先分清墙上时间/单调时间、公开属性/内部快照、优雅退出/立即终止。**

## 3. 旧稿问题

- 旧稿事实丰富，但按四个 API 模块平铺，缺少“进程级状态门面”的统一主线。
- 时间、arraycopy、属性、退出之间没有共同的“Java API → JVM/OS 边界”解释。
- shutdown hook 细节很多，但缺少 SIGTERM/退出流程事故作为动机。
- 属性保存移除与 IntegerCache 关联虽准确，但没有把“公开可变 Properties vs 内部稳定快照”讲成失败方案。

## 4. 理解路径

### 第一节：进程级事故——时间回退与停机卡死

- 用 currentTimeMillis 算耗时导致负数。
- shutdown hook 卡住导致进程无法在优雅窗口内退出。
- 引出 System/Runtime 是进程门面，不是普通静态工具类。

### 第二节：时间——墙上时钟与单调时钟

- native 入口。
- currentTimeMillis 与 nanoTime 的使用边界、精度与时钟源。
- 失败方案：用墙上时间算耗时、用 nanoTime 当日期时间。

### 第三节：arraycopy——为什么边界能力下沉 native

- 类型检查、重叠复制、基本类型快速路径。
- JIT/Stub 作为性能落点，Arrays.copyOf 消费链。
- 失败方案：手写循环替代所有场景。

### 第四节：属性——公开 Properties 与 VM 私有快照

- `getProperty → props`。
- initPhase1、saveAndRemoveProperties、savedProps。
- 失败方案：用户 clear 公共 Properties 破坏 JDK 内部配置。

### 第五节：退出——exit、hook、halt 状态机

- Runtime 单例、System.exit 委托。
- hook 注册、全部启动、join 等待。
- 失败方案：钩子里无限阻塞、依赖执行顺序、把 halt 当优雅退出。

### 第六节：收网

- 时间/拷贝/属性/退出都是 Java 到进程状态的门面。
- 形成使用规则：耗时 nanoTime、时间点 currentTimeMillis/Clock、属性显式管理、退出钩子快速且可重复。

## 5. 失败方案清单

1. 用 currentTimeMillis 计算耗时。
2. 用 nanoTime 作为可持久化时间戳。
3. 用手写循环替代所有 arraycopy。
4. 直接修改/清空 System.getProperties 还期待 JDK 内部不受影响。
5. shutdown hook 里阻塞等待或假设执行顺序。
6. 用 halt 代替优雅退出。

## 6. 误解清单

1. System 是普通工具类——错误，它连接 JVM/OS 状态。
2. nanoTime 返回可读日期——错误，只适合同一 JVM 内做差值。
3. arraycopy 只是普通 Java 循环——错误，存在 native/JIT/stub 路径。
4. setProperty 的值永远是 JDK 内部唯一真相——错误，内部关键属性可能使用 VM 快照。
5. shutdown hook 按注册顺序执行——错误，用户 hook 执行顺序不保证。
6. System.exit 与 halt 等价——错误，前者走清理/hook，后者直接终止。

## 7. 证据清单

- `System.java:396/440/535`：时间与 arraycopy native 入口。
- `System.java:578/826/1954/1964/1981`：Properties 读写与初始化。
- `VM.java:159/187`：saved property。
- `Runtime.java:70/111/211/618/631/642/660`：Runtime 门面。
- `Shutdown.java`：exit/hook/halt 流程。

## 8. 版本与边界

- 基于 JDK 11 `java.base`。
- 时钟具体实现以 Linux/HotSpot 为例时，必须标注平台边界。
- arraycopy 的 JIT stub 性能不是 Java API 规范保证。
- shutdown hook 行为是 JDK 当前实现与 API 契约的结合，不能承诺执行顺序。

## 9. 验收标准

- 开头用时间回退/停机卡死事故建立主线。
- 至少展开六个失败方案。
- 必须回答四类门面 API 为什么下沉到 JVM/native 或 Shutdown 状态机。
- 删除代码后仍能复述“门面 → 进程状态/OS 边界”的主线。
- 锚点、禁用词、版本边界与跨篇链接全绿。
