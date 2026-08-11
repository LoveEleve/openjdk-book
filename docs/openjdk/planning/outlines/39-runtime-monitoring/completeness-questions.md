# 域 39 Runtime Monitoring — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. GC 日志 `[123.4ms]` — 这个时间是用什么 clock 计时的？如果系统时间被 NTP 调整，这个时间会跳变吗？
2. `ManagementFactory.getThreadMXBean().getPeakThreadCount()` — 峰值是在 JVM 启动后所有时刻记录的，还是只是当前 snapshot？

## 2. SRE/运维 (2问)

3. ServiceThread 处理 JVMTI deferred events——如果 JVMTI agent 大量推 events(如 MethodEntry event on all method calls)→ServiceThread 会成为 bottleneck 吗？JVM 会 OOM 吗？
4. OopStorage cleanup 被 delete_unreferenced 后——JNI weak reference 在 Java 层什么时候变为 null？cleanup 和 Java 层的 JNI weak ref nullification 是同步的吗？

## 3. 框架/工具开发者 (2问)

5. 我的 JVMTI agent 推了 10000 个 deferred events→ServiceThread 是单线程处理——批处理顺序是 FIFO 还是 priority？延迟有多大？
6. `ClassLoadingService::loaded_class_count()` — 这个 counter 在 class unloading 后会减少吗？unloaded 和 loaded 是两个独立 counter 并且 unloaded 总 ≤ loaded？

## 4. 性能工程师 (1问)

7. TraceTime RAII 的析构函数 print 到 tty——在高频调用 GC phase 的 loop 中——print 是 syscall write() 吗——会不会阻塞？

## 5. 安全研究者 (1问)

8. ThreadService 暴露 peak thread count——如果 Web server 在 DDoS 中创建大量线程→这个 counter 会记录 attack 痕迹吗？
