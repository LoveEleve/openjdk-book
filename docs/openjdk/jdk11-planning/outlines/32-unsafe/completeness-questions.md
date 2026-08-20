# 域 32: Unsafe 与本地内存 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "为什么 new 不了 Unsafe/getUnsafe 抛 SecurityException" — 01 篇 §1(sun/misc/Unsafe.java:64/96-101)
- [x] "Unsafe 四大能力域" — 01 篇 §2(948/607/1361/2294)
- [x] "Unsafe 与反射谁快" — 01 篇 §3
- [x] "堆外内存/为什么 Netty 用" — 02 篇 §1(allocateMemory 607)
- [x] "DirectBuffer address/cleaner" — 02 篇 §2(DirectBuffer.java:33/37)
- [x] "堆外内存谁回收(Cleaner 链)" — 02 篇 §3
- [x] "Direct memory OOM 排查" — 02 篇 §4(MaxDirectMemorySize)
- [x] "CAS 是什么/乐观锁" — 03 篇 §1(compareAndSetInt 1361)
- [x] "getAndAddInt 循环(手写 CAS)" — 03 篇 §2(2334-2341)
- [x] "ABA 问题/解决" — 03 篇 §3(AtomicStampedReference)
- [x] "park/unpark vs wait/notify" — 03 篇 §4(2294/2280)

## 身份 2: 生产工程师
- [x] 堆外内存泄漏排查(BufferPoolMXBean/NMT)— 02 篇 §3-4
- [x] MaxDirectMemorySize 配置 — 02 篇 §4
- [x] 大缓冲区 GC 停顿优化(堆外)— 02 篇 §1

## 身份 3: 框架工程师
- [x] Netty 堆外池化思想 — 02 篇 §3
- [x] 序列化绕过构造器(allocateInstance)— 01 篇 §2
- [x] 并发框架底层(CAS+park)— 01 篇 §2/03 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 sun/misc/Unsafe.java:56/64/65/96-101, jdk/internal/misc/Unsafe.java:152/175/182/195/607/660/717/779/899/948/1173/1231/1361/1366/2280/2294/2334-2341, sun/nio/ch/DirectBuffer.java:31/33/37, Direct-X-Buffer.java.template 生成源确认)/关键设计/跨层([内部卷]/[x86]/[内核])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 二次 review 修正: jdk.unsupported 实际 exports+opens sun.misc(module-info.java 实测),01 篇"legacy 包反射可访问"改为准确表述;DirectByteBuffer 构造细节补 Deallocator 注册(模板 134)+ 页对齐(base+ps-(base&(ps-1)))+ setMemory 清零;allocateDirect 锚定模板(316)
- [x] 验证通过: ByteBuffer/DirectByteBuffer 均模板生成(X-Buffer.java.template/Direct-X-Buffer.java.template,GensrcBuffer);内部卷 05-cpu-primitives(01-atomic-and-memory-order)/09-memory-core/34-nmt/17-threads 篇目核实
- [ ] 待办: 写作时验证 DirectByteBuffer 模板的 cleaner 注册具体位置(模板文件内)、MaxDirectMemorySize 默认值语义(0=堆上限,在 VM 侧)

## 身份 5: 完整性缺口检查
- [x] 全景(01)/堆外(02)/CAS(03)三篇覆盖域全部面试主战场
- [x] Signal 已在域 03 覆盖(🟢),不重复
- [x] Cleaner 机制已在域 03 详讲,本域只讲回收链路(不重复展开)
- [x] 未覆盖确认: Unsafe 数组操作(arrayBaseOffset/arrayIndexScale)并入 01 篇 §2 提及;内存屏障相关(MemoryOrder)归内部卷 05
- [ ] 待办: 写作时验证 DirectByteBuffer 模板的 cleaner 注册具体位置(模板文件内)、MaxDirectMemorySize 默认值语义(0=堆上限,在 VM 侧)
