# 02. 堆外内存与 DirectBuffer — 分配、回收、OOM 排查

> 🔴 Deep | 域 32 Unsafe 与本地内存第 2 篇 | Layer 2
> 读者处境: 生产"Direct buffer memory"OOM、Netty 为什么用堆外——堆外内存的完整生命周期一次讲透。

### 1. "堆外内存怎么申请？" — allocateMemory 语义

场景: `ByteBuffer.allocateDirect(1MB)` — 这块内存从哪来、归谁管?

- `ByteBuffer.allocateDirect`(模板 `X-Buffer.java.template:316` → `new DirectByteBuffer(capacity)`)→ `DirectByteBuffer`(模板 `Direct-X-Buffer.java.template`,**构建期生成,不在 src 树**)→ `Unsafe.allocateMemory`(`jdk/internal/misc/Unsafe.java:607`)
- 构造细节(模板): `UNSAFE.setMemory` 清零(127 附近)+ **地址按页对齐**(`base + ps - (base & (ps-1))`,pageSize 语义)→ `cleaner = Cleaner.create(this, new Deallocator(base, size, cap))`(134)
- 堆外 = **malloc 语义的内存**(不受 GC 管理,不参与堆压缩/移动)
- 与堆内对比: 堆内 ByteBuffer = byte[] 包装(GC 移动安全);堆外 = 固定地址
- 关键设计 (斜体): *"堆外"的价值: ① 不受 GC 停顿影响(大缓冲区避免长停顿)② 零拷贝 IO(系统调用直接读写该地址,免一次拷贝)③ 共享/持久化;代价: 手动生命周期 + 地址风险*
- 面试: "为什么 Netty 用堆外"——GC 停顿 + 零拷贝(域 21 关联);"堆外是 GC 管理的吗?"——不是(关键考点)
- [C++: 内部卷 09-memory-core(堆 vs 堆外);内核: mmap/malloc 路径]

### 2. "DirectBuffer 接口" — address 与 cleaner

场景: `DirectBuffer` 接口为什么存在?谁实现它?

- `sun/nio/ch/DirectBuffer.java:33` — `long address()` — 暴露堆外地址(供 native 直接读写)
- `DirectBuffer.java:37` — `Cleaner cleaner()` — 暴露关联的清理器
- 实现: DirectByteBuffer 等模板生成类 implements DirectBuffer
- 关键设计 (斜体): *DirectBuffer 是"JDK 内部接口"(sun.nio.ch,非导出包)——供 IO 层(native)与工具(如堆外统计)使用;address() 的存在说明"地址暴露"是堆外设计的必要条件*
- 面试: "怎么判断一个 Buffer 是堆外?"——`buffer instanceof DirectBuffer`(内部)或 isDirect()

### 3. "堆外内存怎么回收？" — Cleaner 链路

场景: DirectByteBuffer 被 GC 回收后,堆外内存谁释放?

- DirectByteBuffer 持有 `Cleaner`(jdk.internal.ref.Cleaner,域 03 已讲虚引用机制),注册 `Deallocator(base, size, cap)` 回调(`Direct-X-Buffer.java.template:134`)
- 回收链: 对象不可达 → GC 标记 → **虚引用入队 → Cleaner 线程执行 Deallocator → `Unsafe.freeMemory(address)`**
- 比 finalize 优点: 时机由 Cleaner 线程控制、异常不吞、不复活(域 03)
- 关键设计 (斜体): *"GC 回收对象"与"释放堆外内存"是两件事——Cleaner 把两者桥接(虚引用跟踪死亡);**不能依赖**: 不确定时机 + Cleaner 线程可能忙;显式 `((DirectBuffer)buf).cleaner().clean()` 或复用池(Netty 的池化直接内存)才是生产方案*
- 生产: "Direct buffer memory" OOM = 堆外泄漏(分配多释放少,`-XX:MaxDirectMemorySize` 默认=堆大小)——排查: 谁还持有 DirectByteBuffer 引用/Cleaner 未触发
- [关联: 域 03 Cleaner 机制;JVM flag: -XX:MaxDirectMemorySize]

### 4. "堆外内存上限" — MaxDirectMemorySize

场景: 堆外 OOM 与堆 OOM 的区别——配置与统计

- `-XX:MaxDirectMemorySize` 默认 0(= 堆最大值)— 超限抛 OutOfMemoryError("Direct buffer memory")
- 统计: `BufferPoolMXBean`(JMX,域 34 关联)/`jcmd VM.native_memory`(内部卷工具)
- 与堆 OOM 对比: 堆 OOM 可调 -Xmx;堆外 OOM 查谁泄漏(无法 GC 兜底)
- 关键设计 (斜体): *堆外 OOM 是"纯泄漏"信号(GC 无法回收它)——生产规范: ① 池化/复用 DirectByteBuffer ② 显式 cleaner() ③ 监控 BufferPoolMXBean;面试"Direct memory 怎么排查"——jcmd NMT 看 native 内存*
- [关联: 内部卷 34-nmt(本地内存跟踪);域 34 JMX(BufferPoolMXBean)]

---

### 核心悬念

Unsafe 的内存能力之外,还有**原子能力**——`compareAndSetInt` 怎么实现"读-改-写"的原子性?`getAndAddInt` 的循环重试是什么?`park/unpark` 怎么让 AQS 工作?——下一篇: CAS 原语与线程控制。

> → [03-cas-park.md](03-cas-park.md)
