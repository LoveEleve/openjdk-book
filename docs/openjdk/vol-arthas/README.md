# Arthas 卷总览

> 状态：23/23 篇正式文章已完成，且 23/23 篇均已按 `WRITING-GUIDELINES.md` 完成 plan、深度 REVIEW 与重写；当前进入全卷一致性精修阶段
> 位置：`openjdk-book/docs/openjdk/vol-arthas/`

## 01 启动与 attach

- [01. 服务不能重启时，Arthas 到底是怎么挂进去的？](./01-startup-attach/01-install-attach.md)
- [02. Arthas 进了 JVM，为什么既不和业务依赖打架，又能让所有增强代码找到同一个入口？](./01-startup-attach/02-bootstrap-spyapi.md)
- [03. 既然 `as.sh <pid>` 已经能进 JVM，为什么 Arthas 还要自 attach？](./01-startup-attach/03-attach-paths.md)
- [04. Arthas 明明已经进 JVM 了，为什么你还可能连不上？](./01-startup-attach/04-bind-destroy.md)

## 02 命令与增强

- [05. 为什么一条回车不能直接等于一次方法调用？](./02-command-enhance/01-command-system.md)
- [06. 方法都已经在跑了，Arthas 凭什么还能临时钻进去？](./02-command-enhance/02-bytekit-enhancer.md)
- [07. 业务代码只喊了一声，为什么正确的监听器就能听到？](./02-command-enhance/03-spy-dispatch.md)
- [08. 同一条回调链，为什么会长成四种完全不同的观察模型？](./02-command-enhance/04-watch-trace-tt.md)

## 03 线程与锁

- [09. Arthas 为什么拿不到一张现成的线程总表？](./03-thread-lock/01-thread-enumeration.md)
- [10. `%CPU` 为什么不是直接读出来的？](./03-thread-lock/02-cpu-sampling.md)
- [11. CPU 最忙的线程，为什么未必是真堵点？](./03-thread-lock/03-blocking-deadlock.md)
- [17. CPU 报警时，为什么不能一上来把所有信息都 dump 出来？](./03-thread-lock/04-thread-practice.md)

## 04 Dashboard 与运行时

- [12. Dashboard 为什么不是一个 `while(true)`？](./04-dashboard-runtime/01-dashboard-engine.md)
- [13. 一张面板为什么不等于一套新监控系统？](./04-dashboard-runtime/02-dashboard-data.md)
- [14. 同一批 JVM 数据，为什么 Arthas 要做成三种命令？](./04-dashboard-runtime/03-jvm-memory-commands.md)
- [20. OOM 前兆出现时，为什么不能第一时间 heapdump？](./04-dashboard-runtime/04-jvm-memory-practice.md)

## 05 OGNL 与表达式

- [13. 为什么一个表达式引擎会牵出最深的卸载边界？](./05-ognl-expression/01-express-engine.md)
- [15. 同一套表达式引擎，为什么在不同命令里会做完全不同的事？](./05-ognl-expression/02-express-usage.md)
- [21. 对象状态不对，和 CPU 热点不清，为什么不能用同一把工具？](./05-ognl-expression/03-ognl-profiler-practice.md)

## 06 Profiler

- [15. Arthas 明明有自己的命令系统，为什么 profiler 却不自己采样？](./06-profiler/01-profiler-command.md)
- [16. watch/trace 已经能看现场了，为什么还要 profiler？](./06-profiler/02-profiler-boundary.md)

## 07 类与字节码实战

- [18. 线上代码为什么和本地不一样？](./07-class-bytecode/01-class-bytecode-practice.md)
- [19. 慢接口和偶发异常，为什么不能只靠一个命令？](./07-class-bytecode/02-tracing-practice.md)

## 生产救火路径

`01 attach 进门 → 09/10 线程与 CPU 缩范围 → 11 锁与死锁分流 → 17 thread 实战 → 18/19 类、字节码与方法现场 → 12/13/14/20 Dashboard 与 JVM/内存 → 13/15/21 OGNL → 15/16 Profiler`

编号说明：标题编号保留了全卷历史主题顺序，不按目录局部连续编号阅读；目录分组表达的是主题簇，编号表达的是卷内教学路径。

## 规划映射

- AR-0：生产使用与排查
- AR-1：Agent 注入与 SpyAPI
- AR-2：命令、Watch/Trace 与字节码增强
- AR-3：线程与锁
- AR-4：Dashboard
- AR-5：OGNL
- AR-6：Profiler

所有文章均保留场景、源码锚点、关键设计、模式标注、跨层标注和后续桥接；继续扩展前先更新本 README，再执行全卷 REVIEW。
