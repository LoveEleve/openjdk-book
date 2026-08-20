# 域 19: Buffer 与 Channel — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Buffer 四状态/flip/clear/rewind 区别" — 01 篇 §1-2(Buffer.java:198-201/421/449/471)
- [x] "remaining/hasRemaining 循环" — 01 篇 §3(483/495)
- [x] "堆内 vs 堆外(isDirect)" — 01 篇 §4(Buffer.java:580, 模板 271)
- [x] "8 种 Buffer 哪来的(模板生成)" — 02 篇 §1(X-Buffer.java.template)
- [x] "wrap 会复制吗" — 02 篇 §2(模板 389/421)
- [x] "字节序/网络序" — 02 篇 §3(order/默认大端)
- [x] "mmap 是什么/与普通读区别" — 03 篇 §2(map 925, map0 1198)
- [x] "零拷贝(sendfile)几次拷贝" — 03 篇 §4(transferTo 654/678)
- [x] "MapMode 三态" — 03 篇 §2(805/811/817)
- [x] "load/force 干什么" — 03 篇 §3(MappedByteBuffer.java:128/152/204)

## 身份 2: 生产工程师
- [x] 大文件随机访问(mmap)— 03 篇 §2
- [x] 大文件复制性能(transferTo)— 03 篇 §4
- [x] 协议解析(ByteBuffer 状态机)— 01 篇 §3
- [x] 进程间锁(FileLock)— 03 篇 §1

## 身份 3: 框架工程师
- [x] Netty 的 ByteBuffer 理解 — 01-02 篇
- [x] Kafka 零拷贝 — 03 篇 §4
- [x] 大文件排序/日志回放(mmap)— 03 篇 §3

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Buffer.java:198-201/218/274/380/396/421/449/471/483/495/580, X-Buffer.java.template:271/389/421/615/1223/1673, Heap-X-Buffer.java.template:55/188, MappedByteBuffer.java:128/136/152/204/215, FileChannel.java:358/564/629/805/811/817/925/1021, FileChannelImpl.java:208/451/485-566/654/678-682/898/928/1002-1013/1099/1198/1202, Channels.java:119/138/346, DirectBuffer.java:33/37)/关键设计/跨层([内核]/[内部卷])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] Buffer.java 非模板(唯一手写抽象类),8 种具体 Buffer 为模板生成——域发现已注明

## 身份 5: 完整性缺口检查
- [x] 状态机(01)/ByteBuffer 家族(02)/FileChannel mmap(03)三篇覆盖域全部面试主战场
- [x] Channels 桥(🟢)并入 02/03 篇提及(新旧 IO 互转)
- [x] FileLock 并入 03 篇 §1(进程间锁)
- [x] 未覆盖确认: 非阻塞文件通道(FileChannel 不参与 Selector,域 21 只讲网络)——明确边界
- [x] 二次 review 修正: wrap(array,offset,length) 语义(offset 存内部偏移非 position;新 buffer position=0/limit=length/容量=array.length,模板 389-396 实测);字节序初始恒 BIG_ENDIAN 锚定 javadoc(141-142)+order 方法(1651/1665)
- [x] 验证通过: Buffer 构造校验(cap<0/limit/position/mark>position 抛异常,218-235)、flip(449: limit=position,position=0,mark=-1)、clear(421)、rewind(471)
- [ ] 待办: 写作时验证 ByteBuffer.order 实现细节、slice/duplicate 的模板行号
