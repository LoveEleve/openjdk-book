# 域 38 PerfData — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. `jstat -gc <pid> 1000ms` — 为什么比 JMX `ManagementFactory.getGarbageCollectorMXBeans()` 快 100x？PerfData 怎么绕过 JMX 序列化？
2. JVM 重启后 `/tmp/hsperfdata_<user>/<pid>` 文件还在吗？旧 pid 会不会冲突？

## 2. SRE/运维 (2问)

3. 多个 jstat 同时连接同一个 JVM——共享文件允许多 reader 并发读吗？Producer 写入时会不会 block readers？
4. `/tmp/hsperfdata_<user>/` 目录权限是 0700——如果两个不同的 Unix user 能看到彼此的 perf counters 吗？

## 3. 框架/工具开发者 (2问)

5. 我要开发一个替代 jstat 的 monitoring tool——我能直接用 mmap `/tmp/hsperfdata_<user>/<pid>` 吗？格式是 forward-compatible 的吗？
6. VisualVM 和 JConsole 读 PerfData 是用 .hsperf 文件还是走 JMX/Attach API？两种方式的 trade-off？

## 4. 安全研究者 (1问)

7. PerfData 暴露 `sun.rt.javaCommand` (JVM command line)——如果有 JVM 用 `-Dpassword=secret` 启动——这个 password 会暴露在 PerfData 中吗？

## 5. 性能工程师 (1问)

8. StatSampler 每 50ms 采样——如果改成 5ms 会有什么后果？mmap write 的开销 vs CPU cache invalidation？
