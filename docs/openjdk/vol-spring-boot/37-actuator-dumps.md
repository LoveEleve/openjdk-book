# 为什么 `/actuator/threaddump` 和 `/actuator/heapdump` 不是边缘工具：它们如何成为事故排查的证据入口

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇 `startup` 端点，进入 Actuator 事故排查端点组：`threaddump` 与 `heapdump`。重点放在 `ThreadDumpEndpoint`、`HeapDumpEndpoint`、`HeapDumpWebEndpoint` 各自的能力边界，以及它们为什么不应该被归类为“边缘工具位”。本文也将说明，在事故排查场景里，这些端点承担的角色是把前面日志、metrics、线程和资源问题重新串起来的关键证据。这是 Actuator 详细规划里事故排查核心的最后一篇。

## 为什么应用出问题时，只看日志和指标往往不够，还需要线程栈和堆快照

很多团队在生产排障时，习惯先看：

- 日志
- 健康状态
- 指标

但这三样东西合起来，在部分场景下仍然不够。

例如：

- 应用响应变慢，日志没有报错，指标正常，但线程池满了
- 应用 OOM 重启，日志没有明显异常，堆信息已丢失
- 应用死锁，没有任何异常日志，只是请求卡住

这些场景里，日志和指标只能告诉你“有问题”，但不能告诉你“问题在哪里”。

而线程栈和堆快照恰恰能回答：

- 线程在做什么、为什么卡住
- 哪些对象占用了最多内存
- 死锁或线程争抢发生在哪里

**第一层问题是：日志回答“发生了什么”，指标回答“变化的趋势是什么”，而线程栈和堆快照回答“当前状态是什么”。**

**第二层问题是：`threaddump` 和 `heapdump` 不是“低频工具”，而是“排查关键证据”。**

**第三层问题是：它们应该和前面写过的日志、metrics、线程池、DataSource 等基础设施正文形成回链，而不是被当成孤立端点。**

## 一、`threaddump`：回答“当前线程正在做什么”

从源码实现看，`ThreadDumpEndpoint` 的核心逻辑非常直接：

```java
@Endpoint(id = "threaddump")
public class ThreadDumpEndpoint {

    @ReadOperation
    public ThreadDumpDescriptor threadDump() {
        return getFormattedThreadDump(ThreadDumpDescriptor::new);
    }

    private <T> T getFormattedThreadDump(Function<ThreadInfo[], T> formatter) {
        return formatter.apply(ManagementFactory.getThreadMXBean().dumpAllThreads(true, true));
    }
}
```

来源：`spring-boot-actuator/src/main/java/org/springframework/boot/actuate/management/ThreadDumpEndpoint.java:36-53`。

`dumpAllThreads(true, true)` 的两个参数分别表示包含锁监视器和同步器信息，因此返回的线程信息包含线程名、状态、堆栈、锁信息等。

它回答的是：

- 当前有哪些线程
- 每个线程处于什么状态
- 线程堆栈是什么
- 是否存在死锁

它和前面日志系统篇、metrics 篇、线程池篇的关系：

- 如果 metrics 显示线程池活跃连接数持续上升，则 threaddump 可以提供“线程具体在做什么”的证据
- 如果日志没有异常，但请求卡住，则 threaddump 可以提供“线程是否在等待锁”的证据

## 二、`heapdump`：回答“内存中哪些对象占用了最多空间”

从源码实现看，`HeapDumpWebEndpoint` 是 `@WebEndpoint` 而非 `@Endpoint`，默认访问级别为 `defaultAccess = Access.NONE`：

```java
@WebEndpoint(id = "heapdump", defaultAccess = Access.NONE)
public class HeapDumpWebEndpoint {

    @ReadOperation
    public WebEndpointResponse<Resource> heapDump(@Nullable Boolean live) {
        // lock + timeout + heap dumper
    }

    protected HeapDumper createHeapDumper() throws HeapDumperUnavailableException {
        if (isRunningOnOpenJ9()) {
            return new OpenJ9DiagnosticsMXBeanHeapDumper();
        }
        return new HotSpotDiagnosticMXBeanHeapDumper();
    }
}
```

来源：`spring-boot-actuator/src/main/java/org/springframework/boot/actuate/management/HeapDumpWebEndpoint.java:62-121`。

它通过 `HeapDumper` 接口触发堆转储，输出为可下载的 `.hprof` 文件，并通过 `defaultAccess = Access.NONE` 默认不暴露，与 `info`/`health` 的默认暴露策略明显不同。

它回答的是：

- 堆中哪些对象占用了最多内存
- 大对象的引用链是什么
- 是否存在内存泄漏的迹象

它和前面 DataSource 篇、Redis 篇、缓存篇的关系：

- 如果 DataSource 连接池配置不当，可能导致大量连接对象占据堆内存
- 如果缓存对象过多，也可能导致堆内存异常
- heapdump 可以提供“到底哪些对象撑爆了堆”的直接证据

## 三、为什么它们不是“边缘工具位”

`threaddump` 和 `heapdump` 虽然不像 `health` 或 `metrics` 一样天天看，但：

- 在事故排查场景里，它们的价值远高于日常监控端点
- 它们提供的是“结果证据”，而不是“趋势数据”
- 它们能把前面日志、metrics、基础设施问题重新串起来并给出最终结论

所以它们属于“事故排查核心端点”，而不是“低频工具”。

## 四、为什么暴露这些端点必须更加谨慎

`threaddump` 包含线程名和堆栈，`heapdump` 包含应用中所有对象数据（包括业务数据、密码、凭据等）。

因此：

- 不应该默认暴露给公网
- 应该在管理端口或受控网络下访问
- 应该记录访问审计日志

这和 `info`、`health` 等只读端点的暴露策略不同。

## 五、最小源码证据：两条链确实是“ThreadMXBean -> ThreadDumpEndpoint”和“HeapDump -> HeapDumpWebEndpoint”

`ThreadDumpEndpoint` 通过 `ManagementFactory.getThreadMXBean().dumpAllThreads(true, true)` 获取线程堆栈，源码位于 `spring-boot-actuator/.../management/ThreadDumpEndpoint.java:36-53`；`ThreadDumpEndpointAutoConfiguration` 位于 `spring-boot-actuator-autoconfigure/.../management/ThreadDumpEndpointAutoConfiguration.java`。

`HeapDumpWebEndpoint` 通过 `HotSpotDiagnosticMXBeanHeapDumper` 或 `OpenJ9DiagnosticsMXBeanHeapDumper` 触发堆转储，源码位于 `spring-boot-actuator/.../management/HeapDumpWebEndpoint.java:62-121`；`HeapDumpWebEndpointAutoConfiguration` 位于 `spring-boot-actuator-autoconfigure/.../management/HeapDumpWebEndpointAutoConfiguration.java`。

它们各自有独立的 Actuator 自动配置入口，`HeapDumpWebEndpoint` 默认访问级别为 `Access.NONE`，与 `info`/`health` 的默认暴露策略明显不同，说明 Boot 在源码层已经明确区分了事故排查端点与日常运行端点的暴露边界。

## 六、为什么这篇应该作为 Actuator 详细规划的最后一篇

在 Actuator 规划里，`threaddump / heapdump` 放在最后一位。

这个顺序是合理的：

- `health / metrics / info / loggers`：日常运行核心
- `conditions / configprops / mappings`：自动配置诊断
- `startup`：启动观测
- `threaddump / heapdump`：事故排查

也就是说，这七组端点覆盖了从“日常运行”到“自动配置诊断”到“启动观测”再到“事故排查”的完整生产运维场景。

## 七、几个最容易错的判断

### 1. `threaddump` 和 `heapdump` 是低频工具，不属于核心端点

不成立。

它们在事故排查场景里的价值远高于日常监控端点，应被归类为“事故排查核心端点”。

### 2. 堆快照太专业，开发人员不需要

不成立。

堆快照是排查 OOM 和内存泄漏最直接的证据，开发人员应该掌握基本分析能力。

### 3. `threaddump` 可以用日志代替

不成立。

日志只能记录“之前发生了什么”，而 threaddump 能记录“当前线程正在做什么”。

### 4. 这些端点暴露出去也没关系

不成立。

heapdump 包含应用所有对象数据，必须严格控制暴露范围。

## 收网：`threaddump / heapdump` 统一的不是“两个偶尔用到的工具”，而是“事故排查场景里从日志和指标推演到最终证据的关键入口”

现在可以回到开头的问题：为什么应用出问题时，只看日志和指标往往不够，还需要线程栈和堆快照？

因为日志和指标只能告诉你“有问题”，而线程栈和堆快照能告诉你“问题在哪里”。

所以这篇真正该带走的结论不是“Boot 有 threaddump 和 heapdump 端点”，而是：

**在事故排查场景里，`threaddump` 提供线程状态的直接证据，`heapdump` 提供内存分配的最终证据；它们不是低频工具，而是把前面日志、metrics、线程池、DataSource 和缓存问题重新串起来的关键证据入口。**