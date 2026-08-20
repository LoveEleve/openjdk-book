# 域 32: Unsafe 与本地内存 — 知识规划

> 源码路径: jdk.unsupported/share/classes/sun/misc/{Unsafe,Signal,SignalHandler}.java + java.base/share/classes/jdk/internal/misc/Unsafe.java(3,727 行) + sun/nio/ch/DirectBuffer.java + java/nio/{Direct-X-Buffer.java.template 等模板}
> 源码量: ~10 文件 / ~9,000 行 | 非巨型域
> 写作层: Layer 2(前置: 域 03 对象系统、04 反射;底层能力域)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jdk.unsupported sun/misc/Unsafe.java | **公开入口与校验**: theUnsafe(64)、getUnsafe(96-101,VM.isSystemDomainLoader 检查,非引导类加载器抛 SecurityException "Unsafe")、theInternalUnsafe 委托(65)——兼容层 | High |
| jdk.internal.misc/Unsafe.java (3727) | **对象字段访问**: objectFieldOffset(948,字段偏移计算)、getObject/putObject(182/195)、getInt/putInt(152/175)、getLong/putLong——绕过可见性的直读 | High |
| jdk.internal.misc/Unsafe.java | **堆外内存**: allocateMemory(607)/reallocateMemory(660)/freeMemory(899)/setMemory(717)/copyMemory(779)/pageSize(1173)——malloc 语义封装 | High |
| jdk.internal.misc/Unsafe.java | **原子操作**: compareAndSetInt(1361)/compareAndExchangeInt(1366)+ Acquire/Release 变体、getAndAddInt(2334)——JDK11 新命名(替代 compareAndSwapInt) | High |
| jdk.internal.misc/Unsafe.java | **线程控制**: park/unpark(2280 附近)——阻塞/唤醒原语,AQS/LockSupport 基础 | High |
| jdk.internal.misc/Unsafe.java | **对象创建**: allocateInstance(1231,绕过构造器创建对象) | Medium |
| sun/nio/ch/DirectBuffer.java | **直接缓冲区接口**: address()(33)/cleaner()(37)——堆外内存的 Java 视图 | High |
| java/nio/Direct-X-Buffer.java.template | **DirectByteBuffer 生成源**: 模板文件,GensrcBuffer 生成 DirectByteBuffer.java(不在 src 树)——allocateMemory 分配+Cleaner 注册回收 | High |
| jdk.internal.ref.Cleaner | **清理器**: 虚引用+回调(域 03 已讲),DirectByteBuffer 回收链路 | Medium |
| jdk.unsupported Signal/SignalHandler | 信号注册(域 03 已覆盖) | Low |

*10 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 对象字段访问(偏移+直读) | 2 (两个 Unsafe) | 面试重头(反射性能/字段布局);框架(序列化/OR mapper) |
| P1 | 堆外内存与 DirectBuffer | 4 (Unsafe+DirectBuffer+模板+Cleaner) | 面试高频(堆外内存/Netty);生产(大缓冲区/OOM 排查) |
| P1 | CAS 与 park/unpark | 1 (Unsafe) | 面试必考(CAS 原语);域 12/13 的地基 |
| P2 | allocateInstance | 1 | 面试偶尔(绕过构造器) |
| P3 | Signal | 2 | 域 03 已覆盖 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | CAS/park 原语 | 面试必考(CAS 语义/ABA);并发域(12/13)全部基于它 |
| 🔴 Deep | 堆外内存与 DirectBuffer | 面试高频(为什么堆外/谁回收);生产(Netty/大文件/OOM) |
| 🔴 Deep | 字段偏移与直读 | 面试常问(反射与 Unsafe 对比);框架(字节码/序列化) |
| 🟡 Working | getUnsafe 校验 | 面试偶尔(为什么不能随便 new) |
| 🟢 Surface | allocateInstance/Signal | 使用层 |

## 04 聚类

### 依赖图(域内)
```
sun/misc/Unsafe(公开兼容层) ──委托── jdk.internal.misc.Unsafe(内部核心)
Unsafe(字段访问) ──→ 反射性能(域 04)/序列化(域 18)
Unsafe(堆外) ──→ DirectBuffer ←── DirectByteBuffer(模板生成)+ Cleaner 回收
Unsafe(CAS/park) ──→ 域 13 原子类/域 12 AQS/域 10 CHM
```

### 教学顺序与文章拆分(3 篇)

1. **Unsafe 全景与能力边界** — 双入口(sun.misc vs jdk.internal)、getUnsafe 校验、API 四大类(字段/内存/原子/线程)、为什么"不安全"
2. **堆外内存与 DirectBuffer** — allocateMemory/freeMemory、DirectByteBuffer(模板生成)、Cleaner 回收链、堆外 OOM 排查
3. **CAS 原语与线程控制** — compareAndSetInt/getAndAddInt、park/unpark、与域 13/12 的衔接、ABA 问题

> 前置: 域 03(对象模型/Cleaner)、04(反射)。跨层: native 实现(JVM 侧,内部卷);CAS 的 x86 指令(内部卷 05-cpu-primitives);堆外内存与 GC(内部卷 09-memory-core)
