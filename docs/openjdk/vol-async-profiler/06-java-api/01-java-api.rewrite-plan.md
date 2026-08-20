# 01-java-api 重写规划

> 状态：现稿待回炉；本文件先做理解路径设计，不直接改正文
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Java API 加载流程 + 方法包装说明文”重写成一篇围绕“Java 调用者为什么只看到一个 `AsyncProfiler` 单例，但这一步实际上同时解决了 native 库装载、预加载探测、字符串协议投影、二进制返回值契约以及少量辅助桥接”的机制文章

## 1. 读者困惑

- 为什么一次 `AsyncProfiler.getInstance()` 就足以把 `.so` 变成可调用的 Java 对象？
- Java API 明明看起来像普通对象接口，为什么底层仍然是 native `action,key=value` 协议？
- `getInstance()` 为什么不在类加载时静态装库，而要把单例和装载时机绑在一起？
- 显式路径、预加载探针、系统属性、embedded lib、`System.loadLibrary()` 这几层回退分别服务什么部署形态？
- `execute0/execute1`、`start0/stop0`、`filterThread0`、MXBean、`Recording` 辅助类分别属于哪一层，不应该混成什么？
- Java API、C API 和 CLI 到底是谁在定义参数语义，谁又只是入口外壳？

## 2. 一句话顿悟

**`AsyncProfiler.getInstance()` 并不是普通工厂方法，而是 Java 世界的“激活点”：它先判断 native 库是不是已经活在进程里，再按多级找库策略把 `.so` 装进来；之后 Java API 并不重新发明一套参数体系，而是把同一个 native `Arguments::parse()` / `Profiler` 内核投影成对象方法、二进制返回值和少量便利直通入口。**

## 3. 总图

```text
Java 调用者
  → AsyncProfiler.getInstance()
    → 显式路径 / 预加载探针 / 系统属性 / embedded lib / loadLibrary
      → native RegisterNatives / 已装载 .so
        → execute0 / execute1 / start0 / stop0 / filterThread0
          → Arguments::parse 或 Profiler::start/stop
            → Profiler 内核 / writer / 输出格式

辅助路径
  Recording
    → registerNatives / state / timestamp / emitSpan
      → JFR/Span/clock bridge
```

## 4. 版本与边界

- 本篇聚焦 Java API 的上层入口设计，不重写 AP-3 已经解释过的 JNI 函数体细节；必要时只拿 JNI 代码来解释 Java 侧为什么这样设计。
- `getInstance()` 是第一次真正尝试装载 native 库的时机；类本身可以先被加载但库尚未进入进程。
- `getVersion()` 在 `getInstance()` 里承担预加载探针角色，不只是返回版本号字符串。
- `execute(String)` 仍是最接近 native 真相的权威入口；`start/resume/stop` 只是少量高频场景的便利直通。
- Java API 不拥有参数语义中心；真正的参数解析权威仍在 native `Arguments::parse()`。
- `dumpOtlp()` 走 `execute1` 返回 `byte[]`，不是文本接口的变体。
- `AsyncProfilerMXBean` 只是 JMX 包装层，不是另一套 profiler 实现。
- `Recording` 不是主加载入口，更偏向 JFR/span/clock bridge；它依赖 native 已装载或后续被绑定。
- Java API、C API、CLI 共享同一个 native profiler 内核；差异主要在命令从哪里来、结果到哪里去。

## 5. 现稿方法论差距审计

- 现稿事实覆盖已经不错，但“getInstance 是激活点，而不是普通单例工厂”这个主冲突还可以更强。
- 五级找库顺序写得比较完整，但还可以更明确地把每一级和对应部署形态绑定，避免读者把它读成单纯的加载技巧列表。
- `execute` / `start0` / `dumpOtlp` / `MXBean` / `Recording` 现在更像并列 API 说明块，需要压成“同一 native 协议的不同投影层”这条主线。
- `Recording` 的边界已经写到，但还可以更明确地区分“主入口”与“辅助桥”，尤其是它静态注册失败时只落到 `UNAVAILABLE`，不会像 `getInstance()` 那样继续找库。
- `asprof_execute()` 与 Java `execute0()` 的对照已经有了，但还可以更明显地把“单一语义中心在 native”收束成全篇结论。
- 测试层压力还没完全拉满，例如 `test/test/api/JavaAgent.java`、`test/test/api/DumpOtlp.java`、`test/test/span/SpanApiApp.java` 正在分别证明 MBean、二进制返回值、Recording bridge 的存在意义，可以更主动拉进正文。

## 6. 重写策略

1. 用“看起来只是拿单例，实际上是在激活一个 native profiler”开场。
2. 推演并否定至少四个直觉：
   - 类加载时静态装库就够；
   - Java API 应该完全强类型化，彻底摆脱字符串协议；
   - MXBean/Recording 是另外两套 profiler 入口；
   - Java API 自己定义参数语义，native 只负责执行。
3. 给出总图：装载探测 → 多级找库 → JNI 入口绑定 → 字符串协议/便利直通 → Profiler 内核。
4. 分层讲：
   - `getInstance()` 为什么要和库装载绑在一起；
   - 预加载探针与五级找库分别在兼容什么部署形态；
   - `execute(String)` 为什么仍是权威入口；
   - `start/resume/stop`、`dumpOtlp`、线程过滤怎样构成少量强类型投影；
   - `execute0/execute1` 的文本/二进制契约以及 MXBean 的包装角色；
   - `Recording` 怎样提供 state/clock/span bridge 而不是主 profiler façade；
   - Java API、C API、CLI 怎样共享同一个 native 语义中心。
5. 收网时强调：Java API 的价值不是重写 profiler，而是把 native 能力变成 Java 调用者可接受的入口形态，同时尽量不复制参数语义。

## 7. 结构大纲

### 第一节：事故开场——为什么一次 `getInstance()` 不只是拿单例，而是在激活 native profiler

回答：Java 对象外表下，真正要先解决的是 `.so` 是否已装载、怎样装载、装载后如何把 JNI 能力暴露成对象接口。

预估字数：900-1200

### 第二节：先排除四个错误直觉——类加载即装库、Java 完全强类型化、MXBean/Recording 是独立实现、Java 自己定义参数语义

预估字数：1800-2400

### 第三节：第一层——`getInstance()` 为什么要和库装载时机绑在一起

证据：`src/api/one/profiler/AsyncProfiler.java:19-63`。

回答：单例 + synchronized + 第一次调用触发装载，而不是类初始化即装载。

### 第四节：第二层——预加载探针与五级找库分别在兼容什么部署形态

证据：`src/api/one/profiler/AsyncProfiler.java:35-113`。

回答：显式路径、`getVersion()` 探针、`one.profiler.libraryPath`、embedded lib、`System.loadLibrary()` 五级顺序与部署意图。

### 第五节：第三层——为什么 `execute(String)` 仍然是 Java API 的权威入口

证据：`src/api/one/profiler/AsyncProfiler.java:178-255`、`src/javaApi.cpp:55-125`。

回答：字符串协议投影、`execute0/execute1` 文本/二进制分工、`dumpCollapsed`/`dumpOtlp` 只是投影。

### 第六节：第四层——`start/resume/stop`、线程过滤为什么只是少量高频直通，而不是完整强类型 API

证据：`src/api/one/profiler/AsyncProfiler.java:115-154`、`src/api/one/profiler/AsyncProfiler.java:257-299`、`src/javaApi.cpp:25-53,132-147`。

回答：`start0` 对 alloc/lock 的特判、线程过滤的 Java 对象语义优势，以及为什么复杂场景仍要回到 `execute(String)`。

### 第七节：第五层——`execute0/execute1`、MXBean 和 `dumpOtlp()` 分别在暴露什么契约

证据：`src/api/one/profiler/AsyncProfilerMXBean.java:19-35`、`src/api/one/profiler/AsyncProfiler.java:169-255`、`test/test/api/JavaAgent.java:17-35`、`test/test/api/DumpOtlp.java:14-25`。

回答：文本结果 vs 二进制结果，JMX 只是入口再包装，不是另一套能力。

### 第八节：第六层——`Recording` 为什么是 state/clock/span bridge，而不是主入口

证据：`src/api/one/profiler/Recording.java:17-99`、`src/javaApi.cpp:149-302`、`test/test/span/SpanApiApp.java:31-55`。

回答：registerNatives 的时机、`UNAVAILABLE/STOPPED/RUNNING`、timestamp clock 切换、span/helper 语义边界。

### 第九节：第七层——Java API、C API、CLI 为什么共享同一个 native 语义中心

证据：`src/asprof.cpp:26-53`、`src/javaApi.cpp:55-125`。

回答：三条入口都汇入 `Arguments::parse` / `Profiler::runInternal` 或 `Profiler::start/stop`，差异只在输入载体与输出载体。

### 第十节：收网——Java API 真正提供的是“对象化入口”，不是“另一份 profiler”

桥接下一篇 helper/closure/Span 路径。

## 8. 必须展开的失败方案

1. `AsyncProfiler` 类加载时静态装库就够，不必把装载和 `getInstance()` 绑在一起。
2. Java API 应该彻底强类型化，完全取代字符串命令协议。
3. `MXBean` 或 `Recording` 代表另一套 Java 侧 profiler 实现。
4. Java API 自己定义参数语义，native 只是执行层。
5. `dumpOtlp()` 既然是一个方法，返回 `String` 或统一 `Object` 更简单。
6. embedded lib / property / loadLibrary 只是几种等价技巧，没有部署语义差别。

## 9. 证据清单

- `src/api/one/profiler/AsyncProfiler.java:19-300`
- `src/api/one/profiler/AsyncProfilerMXBean.java:19-35`
- `src/api/one/profiler/Recording.java:17-99`
- `src/javaApi.cpp:25-302`
- `src/asprof.cpp:26-53`
- `test/test/api/JavaAgent.java:17-35`
- `test/test/api/DumpOtlp.java:14-25`
- `test/test/span/SpanApiApp.java:31-55`

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“装载探测 → 多级找库 → JNI 桥 → 字符串协议/便利直通 → native 内核”。
2. 至少展开 4 个失败方案，而不是把 API 方法和加载分支平铺成清单。
3. 明确区分主入口 `AsyncProfiler`、JMX 包装、`Recording` 辅助桥三层角色。
4. 明确区分 `execute(String)` 权威协议路径与 `start/resume/stop` 少量直通路径。
5. 明确区分 Java API、C API、CLI 谁共享语义中心、谁只是外壳。
6. 不把 `Recording` 写成主加载入口，也不把 MXBean 写成独立实现。
7. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
