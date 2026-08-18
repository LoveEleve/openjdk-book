# 06. JMX 生产实践 — 平台指标、DiagnosticCommand、自定义暴露

> **前置依赖**: [34-jmx/03 — MBean 类型与 MXBean](03-mbean-types-mxbean.md)(MXBean 定义)、[34-jmx/05 — JMX 远程与工具](05-remote-tools.md)(远程连接)
> → **后续**: 域 39 JFR(39-jfr 系列,按写作顺序)
> 关联: 内部卷 33-jmx(平台 MBean 数据源);内部卷 36-attach(jcmd 的 attach 连接)

## 线上怎么监控 JVM

前五篇把 JMX 的机制讲完了——这一篇看生产怎么用: 内存/GC 指标从哪读、jcmd 命令怎么通过 JMX 远程执行、业务指标怎么暴露、以及远程开启的安全配置。

## 1. "内存与 GC 监控" — 平台指标

### 1.1 指标来源

内存与 GC 的平台 MBean 分两级:

| MBean | 实现 | 关键方法 |
|-------|------|---------|
| `MemoryMXBean` | `sun/management/MemoryImpl.java:46`(java.management) | 堆/非堆使用 |
| `GarbageCollectorMXBean` | `sun/management/GarbageCollectorImpl.java:38`(extends MemoryManagerImpl) | `getCollectionCount`(`:46`,native)/`getCollectionTime`(`:49`,native) |
| `GarbageCollectorExtMXBean` | `jdk.management` 的 `GarbageCollectorExtImpl.java:49` | `getLastGcInfo`(`:68`)——单次 GC 明细 |

### 1.2 两种采集方式

- **轮询**(拉): 定期 `getAttribute` 读 GC 次数/堆使用率——监控系统告警的基础
- **GC 通知**(推): `GarbageCollectionNotificationInfo`(`jdk.management` 的 `GarbageCollectionNotificationInfo.java`,type 常量 `:100` `GARBAGE_COLLECTION_NOTIFICATION`)——每次 GC 结束发通知,带 gcName/gcAction/gcCause(`:146/:155/:164`)与 `GcInfo`(`:174`,内存变化明细)

面试"线上怎么监控 JVM": JMX 平台 MBean + 外部采集(轮询指标 + GC 通知);生产: 监控系统(Prometheus jmx_exporter)采集堆使用率/GC 次数告警。

关键设计(斜体):*"JMX 是 JVM 运维的统一视图"——内存/GC/线程/类加载全暴露。面试"线上怎么监控 JVM": JMX 平台 MBean + 外部采集;生产: jmx_exporter 等采集 GC 次数/堆使用率告警。*

## 2. "DiagnosticCommand" — jcmd 的 JMX 通道

### 2.1 MBean 结构

`DiagnosticCommandImpl`(`jdk.management/share/classes/com/sun/management/internal/DiagnosticCommandImpl.java:60`,extends NotificationEmitterSupport)把 jcmd 命令暴露成 **MBean 操作**:

- `getMBeanInfo`(`:188` 起): `String[] command = getDiagnosticCommands()`(`:195`,native 枚举所有命令)→ 每个命令生成一个 `MBeanOperationInfo`
- `execute(String[] args)`(`:151`): 权限检查 + 把命令和参数拼成命令行(`:164-167`)→ `executeDiagnosticCommand(...)`(native 执行,`:170`)

```java
// DiagnosticCommandImpl.java:151-170(截取,逐字,核心)
        public String execute(String[] args) {
            if (permission != null) {
                SecurityManager sm = System.getSecurityManager();
                if (sm != null) {
                    sm.checkPermission(permission);
                }
            }
            if(args == null) {
                return executeDiagnosticCommand(cmd);
            } else {
                StringBuilder sb = new StringBuilder();
                sb.append(cmd);
                for(int i=0; i<args.length; i++) {
                    ...
                    sb.append(" ");
                    sb.append(args[i]);
                }
                return executeDiagnosticCommand(sb.toString());
            }
        }
```

命令示例: `GC.class_histogram`/`Thread.print`/`VM.flags`——与 jcmd 命令行**同一套 native 实现**: `executeDiagnosticCommand` 的 C 实现调用 `jmm_interface->ExecuteDiagnosticCommand`(`jdk.management/share/native/libmanagement_ext/DiagnosticCommandImpl.c:248-251`),即 JVM 的诊断命令框架入口。

### 2.2 意义

远程诊断: 非交互环境(容器/无 shell)也能通过 JMX 执行诊断命令。jcmd 工具本身走 attach 连接(内部卷 36-attach)。

面试"远程怎么执行 jcmd": DiagnosticCommand MBean——`getMBeanInfo` 枚举命令为操作,`execute` 转发到 native;生产: 自动化诊断脚本通过 JMX 触发。

关键设计(斜体):*"诊断命令 = JVM 管理操作的统一入口"——jcmd 与 JMX 的 DiagnosticCommand 同源(native 实现)。面试"远程怎么执行 jcmd": DiagnosticCommand MBean(枚举命令 + execute 转发);生产: 自动化诊断脚本通过 JMX 触发。*

## 3. "自定义业务指标" — MXBean 实践

### 3.1 三步暴露

```java
// 用法示意(API 形式,非源码片段)
public interface OrderMetricsMXBean {
    long getBacklog();      // 属性: 实时计算的积压量
    void reset();           // 操作: 重置计数
}
public class OrderMetrics implements OrderMetricsMXBean { ... }

ManagementFactory.getPlatformMBeanServer().registerMBean(
    new OrderMetrics(),
    new ObjectName("com.app:type=Order,name=Metrics"));
```

三步: 定义 MXBean 接口 → 实现 → 注册到平台 MBeanServer(`ManagementFactory.getPlatformMBeanServer()`,`ManagementFactory.java:475`,第 5 篇 §4)。外部监控轮询属性,或 MBean 主动发通知。

### 3.2 注意点

- 属性方法尽量轻量(轮询频率高,getter 里做重计算会拖慢采集线程)
- 生产: 与 Prometheus 集成(或直接用 Metrics 库,jmx_exporter 自动发现 MXBean)

面试"怎么暴露业务指标": MXBean 接口 + 实现 + registerMBean 到平台 MBeanServer。

关键设计(斜体):*"自定义 MXBean = 业务可观测性"——三步: 接口/实现/注册。面试"怎么暴露业务指标": MXBean 注册到平台 MBeanServer;生产: 与 Prometheus 等集成;注意属性方法开销(轮询频率)。*

## 4. "安全与配置" — 生产开关

### 4.1 开关

| 场景 | 配置 |
|------|------|
| 本地 attach | `-Dcom.sun.management.jmxremote`(默认可用) |
| 远程开启 | `-Dcom.sun.management.jmxremote.port=9010` |
| 认证 | `-Dcom.sun.management.jmxremote.authenticate=true`(密码文件) |
| SSL | `-Dcom.sun.management.jmxremote.ssl=true`(证书) |
| 访问控制 | `.access.file`(只读/读写分权) |

### 4.2 风险

**未认证的远程 JMX 是 RCE 面**——能执行 DiagnosticCommand(改 flags/触发 GC)、读写任意 MBean。生产必须: 认证 + SSL + 内网隔离/防火墙白名单三件套。

面试"JMX 安全": 认证/SSL/防火墙三件套——管理通道同时也是攻击面。

关键设计(斜体):*"JMX 是管理通道也是攻击面"——生产必须认证 + SSL + 网络隔离。面试"JMX 安全": 认证/SSL/防火墙三件套;生产: 内网单独端口 + 防火墙白名单。*

跨层标注: [内部卷 33-jmx——平台 MBean 的 JVM 侧数据源;内部卷 36-attach——jcmd 与远程诊断的 attach 连接机制;域 18 序列化——远程调用的传输约束]

## 核心悬念

JMX 收官——**JFR** 来了: 事件录制怎么不卡业务?`jdk.jfr` 的 Event/Recording API、飞行记录的分析——下一篇: 域 39 JFR(生产可观测性收官)。

> → 域 39 JFR(39-jfr 系列)| 关联: 内部卷 32-jfr(native 录制引擎)
