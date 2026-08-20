# 06-oops/05-access-api-barrier 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释同一条引用写入为什么可以由调用方声明语义、由 Access API 组合协议、再由当前 GC 插入不同 barrier，而不让每个字段/数组访问点重复知道 GC 细节

## 1. 选题判断

现稿已经覆盖了 Access 装饰器、G1 SATB/card barrier、OopHandle/WeakHandle 三组事实，但结构仍然是三个组件并列说明。

真正的读者困惑是：

**Java 里的 `obj.field = value` 看起来只需要一次 store，为什么 HotSpot 不让每个调用点自己写 barrier？如果调用方只说“这是堆里的数组引用写入”，当前 GC 如何知道要不要记录旧值、标脏哪张卡、是否允许跳过保活？同一套 Access API 到底哪些工作在编译期完成，哪些工作只能等运行时知道？**

## 2. 一句话顿悟

**Access API 把“访问语义”和“GC 实现”拆成两条轴：调用方用编译期 DecoratorSet 声明位置、数组、内存序和保活要求；C++ runtime path 按当前 `BarrierSet` 懒解析到具体 AccessBarrier，G1 再把一次引用写拆成“写前保留旧引用、裸写新引用、写后记录目标卡”三个动作，而 C1/C2 则在编译期把同样的语义降成自己的 barrier IR/机器码。**

## 3. 总图

```text
obj.field = value / objArray[i] = value
  │
  ├─ 调用方声明 DecoratorSet
  │    ├─ IN_HEAP / IN_NATIVE
  │    ├─ IS_ARRAY / IS_DEST_UNINITIALIZED
  │    ├─ AS_NO_KEEPALIVE / AS_RAW
  │    └─ MO_* 内存序
  │
  ├─ Access<decorators>
  │    ├─ 编译期检查互斥装饰器与操作合法性
  │    ├─ 补齐默认装饰器
  │    └─ 选择 raw、runtime dispatch 或编译器后端
  │
  ├─ C++ runtime path（解释器支持代码 / VM 内部）
  │    └─ 首次调用按 UseCompressedOops + BarrierSet 懒解析函数指针
  │         └─ G1 AccessBarrier
  │              ├─ pre(old value) → SATB object queue
  │              ├─ Raw::oop_store(new value)
  │              └─ post(field address) → card table / dirty-card queue
  │
  └─ C1/C2 path
       └─ BarrierSetC1 / BarrierSetC2 在编译期生成 IR、内联 barrier 和必要 slow path
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——`obj.field = value` 为什么不是一条 `mov`

目标约 1000 字。

- 从并发标记与分区回收的两个事故开场：旧引用丢失、新写入位置无人记录
- 说明“引用写入”同时改变对象图内容和堆位置索引
- 先提出两道记录的职责：SATB 记录旧值，card/RSet 记录位置
- 声明 G1 边界：不是所有 GC 都有这两道 barrier，也不是每次写都实际走满路径

### 第二节：三个朴素方案为什么都会失败

目标约 1800 字。

至少推演：

1. 每个字段写入点自己判断当前 GC 并拼 barrier → 调用点与 GC 强耦合
2. 所有引用访问都走固定 pre+post → 无法处理 native、raw、初始化、weak/peek、arraycopy 等不同语义
3. 让运行时每次访问都判断所有装饰器和 GC → 热路径分支爆炸

引出两条正交轴：

- 调用方在编译期声明“我要什么访问语义”
- BarrierSet 在运行时/编译期决定“当前 GC 怎么实现”

### 第三节：DecoratorSet——调用方先声明“这次访问是什么”

目标约 1800 字。

- DecoratorSet 是 `uint64_t` 位集，`HasDecorator` 编译期判断
- 分组：位置、内存序、barrier strength、引用强度、数组/初始化/nullness
- `IN_HEAP` 与 `IN_NATIVE` 的差别
- `AS_RAW` 不是“裸 C++ 指针随便读写”，仍保留编码、原子性、内存序约束
- `AS_NO_KEEPALIVE` 不等于无 barrier
- `IS_DEST_UNINITIALIZED` 是“旧内容没有意义”的声明
- `IS_NOT_NULL` 是调用方承诺，不是 API 自己验证
- `DecoratorFixup` 如何补齐默认语义
- 编译期拒绝互斥装饰器组合

### 第四节：Access API 的分流——同一词汇，三条实际路径

目标约 1800 字。

- `RawAccess` / `HeapAccess` / `NativeAccess` 的包装关系
- C++ runtime path：`AccessInternal` → `RuntimeDispatch` → `resolve_barrier`
- 懒解析不是全局第一次访问，而是每个操作/类型/装饰器实例的函数指针第一次调用
- 运行时依据 `UseCompressedOops` 和全局 `BarrierSet::kind()` 选择具体 AccessBarrier
- 解析后仍可能有间接函数指针调用，不能宣传成零成本
- x86 interpreter assembler path 的区别：`MacroAssembler::access_*` 走 `BarrierSetAssembler`
- C1/C2 的区别：`BarrierSetC1` / `BarrierSetC2` 在编译时生成代码，不执行 C++ runtime resolver

### 第五节：G1 一次堆内引用写入的真实顺序

目标约 2200 字（核心拆解层）。

用 `ModRefBarrierSet::AccessBarrier::oop_store_in_heap` 的顺序做主线：

```text
pre(old field value)
Raw::oop_store(new value)
post(field address, new value)
```

- 为什么必须先读旧值，再写新值，再记录目标位置
- pre 与 post 记录的数据不同：一个是 oop，一个是 card address
- `AS_NO_KEEPALIVE` / `IS_DEST_UNINITIALIZED` 跳过 pre 的条件
- `Raw::oop_store` 负责压缩 oop 编码和实际存储，不负责 GC 记录
- atomic xchg/cmpxchg 的 barrier 顺序与 compare 成功条件

### 第六节：SATB pre-barrier——为什么写前要保存旧引用

目标约 1700 字。

- G1 并发标记的快照场景
- 旧引用如果被覆盖且没有记录，标记线程可能再也找不到它
- `G1BarrierSet::write_ref_field_pre`：装饰器判断 → volatile 读旧值 → null 过滤 → decode → enqueue
- Java 线程本地 SATB 队列，非 Java 线程共享队列
- SATB inactive 时 enqueue 快速返回
- 不能把它描述成“任何引用写都必须入队”：初始化、no-keepalive、SATB inactive、旧值 null 都有边界

### 第七节：card post-barrier——为什么写后记录字段所在卡

目标约 1700 字。

- card 是字段地址对应的 512-byte 粗粒度区域，不是 new value 所在位置
- young card 快速返回
- 非 young 卡进入 slow path：storeload → dirty 检查 → 写 dirty → dirty-card queue
- dirty card queue 与 SATB queue 的数据类型和消费者不同
- card/RSet 让 G1 在 young/mixed collection 中定位相关旧区引用，但不意味着 G1 永不全堆扫描
- Full GC / concurrent marking 的边界

### 第八节：数组、arraycopy、native 和弱引用为什么不能套同一条路径

目标约 2200 字。

- 单个对象数组元素写入：`HeapAccess<IS_ARRAY>::oop_store_at`，同一 pre/store/post 语义
- arraycopy：范围 pre/raw copy/post，不是逐元素调用 store barrier
- `IS_DEST_UNINITIALIZED` 如何取消范围 pre
- non-heap oop store：G1 有 SATB pre，但没有 heap card post
- `OopHandle`：元数据只保存 `oop*` 槽地址，用 `NativeAccess` 读取；强引用生命周期由 owner 管理
- `WeakHandle<T>`：弱 OopStorage、phantom decorator、GC 可清成 NULL；`resolve` 和 `peek` 的 keepalive 差异
- OopStorage 是 block + allocation bitmask，不是连续数组，也不是原子一次更新所有槽位

### 第九节：成本分布与误解澄清

目标约 1300 字。

至少回答：

1. Access API 是否每次访问都动态选择当前 GC
2. C1/C2 是否调用 C++ runtime resolver
3. `AS_RAW` 是否等于任意内存访问
4. `AS_NO_KEEPALIVE` 是否等于没有 barrier
5. pre/post 是否固定各做一次内存操作
6. card barrier 是否意味着 GC 完全不扫描堆
7. `OopHandle` 是否天然由 OopStorage 支撑

### 第十节：收网与下篇钩子

目标约 800 字。

- 总图回收：语义声明 → 访问分流 → G1 pre/store/post → GC 消费
- 三句话总结
- 下篇从“元数据引用如何命名和去重”进入 Symbol，不继续展开 G1 细节

## 5. 失败方案必须写进正文

1. 每个写入点自己实现 G1 barrier
2. 所有访问固定执行完整 pre+post
3. 每次访问动态枚举装饰器和 GC 类型

## 6. 证据清单

- `accessDecorators.hpp:39-44`：DecoratorSet / HasDecorator
- `accessDecorators.hpp:70-194`：内存序、位置、数组、raw、keepalive、nullness
- `accessDecorators.hpp:218-252`：默认装饰器补齐
- `access.hpp:94-124`：操作允许的装饰器集合
- `access.hpp:279-297`：RawAccess / HeapAccess / NativeAccess / ArrayAccess
- `access.hpp:343-374`：编译期装饰器验证
- `accessBackend.hpp:694-759`：raw / runtime dispatch 分流
- `access.inline.hpp:209-271`：BarrierSet 与压缩 oop 运行时选择
- `access.inline.hpp:283-361`：懒解析并缓存函数指针
- `barrierSet.hpp:155-193`：AccessBarrier 扩展点
- `modRefBarrierSet.inline.hpp:57-89`：pre/raw store/post 与 atomic 路径
- `modRefBarrierSet.inline.hpp:93-108`：arraycopy 范围 barrier
- `g1BarrierSet.inline.hpp:35-46`：SATB pre
- `g1BarrierSet.cpp:61-73`：SATB enqueue
- `g1BarrierSet.inline.hpp:48-55`：card post 快路径
- `g1BarrierSet.cpp:99-114`：dirty card slow path
- `cardTable.hpp:152-161,229-234`：card 映射与 512-byte 粒度
- `g1BarrierSet.inline.hpp:97-106`：non-heap oop store 只有 pre
- `objArrayOop.inline.hpp:47-56`：对象数组单元素访问
- `oopHandle.hpp:30-55`、`oopHandle.inline.hpp:31-37`：OopHandle
- `weakHandle.hpp:34-40`、`weakHandle.inline.hpp:31-41`：WeakHandle 语义
- `weakHandle.cpp:35-64`：弱 storage 与生命周期
- `oopStorage.hpp:37-46,61-66,129-142`：OopStorage 契约
- `oopStorage.inline.hpp:324-399`：block 遍历、强/弱处理
- `handles.hpp:35-43,64-70,218-224`：Handle 对比
- `klass.cpp:50-62`、`klass.hpp:139`：`_java_mirror`
- `macroAssembler_x86.cpp:5466-5487`：x86 assembler 路径
- `g1BarrierSetAssembler_x86.cpp:119-142,349-399`：G1 机器码 barrier
- `c1_LIRGenerator.cpp:1625-1634`：C1 后端
- `opto/graphKit.cpp:1612-1628`：C2 后端

## 7. 必须明确的边界

- 版本边界为 OpenJDK 11u；Access API、DecoratorSet 和 `AccessBarrier` 布局不能外推到所有 JVM
- G1 的 SATB/card 语义只作为 G1 具体实现讲，不写成 GC 通用规律
- x86 assembler、C1、C2 是三条不同的 barrier 消费路径
- C++ runtime dispatch 的函数指针懒解析不等于 JIT 代码的调用路径
- `AS_RAW`、`AS_NO_KEEPALIVE`、`IS_NOT_NULL` 都是调用方提供的语义/前提，不是 Access API 自动推断
- OopHandle 不等于 OopStorage；强 OopHandle 也可能由 ClassLoaderData 的 chunked handle list 支撑
- OopStorage 的并行遍历不等于所有槽位原子同时更新
- 不展开 G1 完整 remembered-set 实现、并发标记状态机和 C2 barrier 消除算法

## 8. 完成后 review

- 删除代码后能否复述“语义声明 → Access 分流 → G1 pre/store/post → GC 消费”的完整链条
- 是否明确区分旧值队列（SATB）与卡地址队列（dirty card）
- 是否避免“每次写固定两道 barrier”“GC 不再扫描全堆”“JIT 零函数调用”等过度结论
- 是否解释 C++ runtime、x86 assembler、C1/C2 三条路径的边界
- 是否修正 OopStorage 连续数组、OopHandle 天然弱/强等误解
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
