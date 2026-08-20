# 06-oops/01-markoop-oopdesc 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 重点实现：`oopDesc`、`markOopDesc`、压缩类指针、对象头状态切换

## 1. 选题判断

本篇值得独立成篇，但题目不能停留在“对象头有哪些字段”。真正可闭环的困惑是：

**一个对象只有一个 mark word，为什么它既能保存 identity hash 和分代年龄，又能表示偏向锁、栈锁、重量锁和 GC 转发？当多个角色同时想使用它时，谁保存原值、谁让位、谁把信息搬到别处？**

`oopDesc` 只作为对象内存布局的入口讲解；`Klass` 的完整层次和虚调用放到下一篇。

## 2. 一句话顿悟

**mark word 不是一组固定字段，而是一块由低位 tag 解释的可变状态槽：普通态存 hash/age，锁竞争时把原值搬到栈或 ObjectMonitor，GC 搬移时把旧地址改写成 forwarding 指针；第二个 header 槽则通过压缩类指针在常规配置下缩短为 4 字节。**

## 3. 总图

```text
Java 对象
  ├─ mark word
  │    ├─ neutral：hash + age + lock bits
  │    ├─ biased：JavaThread* + epoch + age + bias bits
  │    ├─ stack locked：BasicLock*（原 mark 放栈上）
  │    ├─ inflated：ObjectMonitor*（锁/必要元数据移到 C 堆）
  │    ├─ marked/forwarded：GC 协议下的指针编码
  │    └─ 0：inflate-in-progress 临时 BUSY 状态
  └─ klass metadata
       ├─ 8-byte Klass*，或
       └─ 4-byte narrowKlass + klass gap（压缩类指针）
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 `new Object()` 不是“只有一个引用”

目标约 900 字。

- 观察空对象大小与对象头的关系
- 先建立 `oopDesc` 的两个槽位
- 版本边界：JDK 11u、64 位、压缩类指针、8 字节对象对齐
- 预告：第一槽是状态槽，不是固定字段表

### 第二节：先拆掉三个朴素方案

目标约 1500 字。

- 每种功能增加一个 header 字段：空间成本和对象膨胀
- 锁信息永远放对象外：无锁快路径与定位成本问题
- GC 另分配 forwarding table：搬移期间的查询和内存成本
- 引出低位 tag + 状态复用的核心设计

### 第三节：`oopDesc` 的内存入口——两个槽位如何成为对象头

目标约 1500 字。

- `oop`/`markOop` 是指针 typedef，不是包装对象
- `_mark`、`_metadata` union
- 压缩类指针下的 4-byte `narrowKlass`、klass gap 与对齐
- `header_size()` 与“逻辑头部 12 字节 / 空对象 16 字节”的边界
- 不把 C++ `sizeof(union)` 和 Java 对象字段起始偏移混为一谈

### 第四节：低 3 位建立状态机——一个 word 的五种主要解释

目标约 1800 字。

- 8 字节对齐使低位可作为 tag
- `000/001/010/011/101` 的状态表
- neutral、biased、stack locked、inflated、marked/forwarded
- 0 的 inflating 临时状态单独说明
- GC marked 与 forwarding 共用 `11` 编码的协议边界

### 第五节：普通态为什么能同时保存 hash 和 age

目标约 1700 字。

- `hash_bits=31`、`age_bits=4`、`no_hash=0`
- identity hash 惰性生成和 CAS 安装
- CAS 失败时为什么不能简单重试：对象头可能已进入锁协议，转为 monitor
- hash 与偏向状态的冲突边界
- 年龄递增与 header 保留的 GC 相关语义

### 第六节：锁竞争如何把 mark word 搬到别处

目标约 1900 字。

- 偏向锁：线程指针、epoch、age，撤销后回到普通锁流程
- 栈锁：BasicLock 保存 displaced mark，header 只存栈指针
- 重量锁：ObjectMonitor 指针，说明它位于 C heap
- inflating 的 0/BUSY 临时态
- CAS、原值保存和锁协议之间的关系

### 第七节：GC 为什么把旧对象头改成 forwarding 指针

目标约 1600 字。

- 搬移后旧地址仍被引用，必须留下新地址
- `encode_pointer_as_mark` + marked bits
- `is_forwarded` / `forwardee` / 并行 scavenger CAS
- forwarding 与 lock/hash/age 的互斥边界
- 不把所有 GC 的 mark/forwarding 细节泛化为同一算法

### 第八节：第二个槽位——压缩类指针不是普通引用压缩

目标约 1500 字。

- `_klass` 与 `_compressed_klass` 的运行时选择
- `base + (narrowKlass << shift)` 的解码
- `UseCompressedClassPointers` 与 `UseCompressedOops` 依赖
- 常规堆大小下的 ergo 开启边界
- 只讲对象头访问，Klass 层次放后篇

### 第九节：误解澄清与收网

目标约 1200 字。

至少回答：

- `markOop` 是不是一个真正的 Java oop/class
- 偏向锁是不是 lock bits 等于 1
- 重量锁是不是在 Java 堆
- `is_oop` 是否会做完整 Klass/Metaspace 校验
- hash 是否等于覆写后的 `Object.hashCode()`
- 低位 tag 是否意味着所有状态都能同时存在

## 5. 失败方案必须形成正文段落

至少详细推演：

1. 为 hash、年龄、锁、转发各加一个字段
2. 让锁信息始终放在 Java 对象外部并统一查表
3. GC 搬移时只更新引用、不在旧对象头留下 forwarding

## 6. 证据清单

- `oopsHierarchy.hpp:37-47`：`oop` / `markOop` 指针 typedef
- `oop.hpp:55-63`：对象头字段
- `oop.hpp:102-103, 326-330`：头大小与偏移
- `oop.inline.hpp:45-79, 90-115`：mark 访问、CAS、Klass 解码
- `markOop.hpp:35-98`：位布局与主要状态说明
- `markOop.hpp:111-160`：位数、掩码、状态值
- `markOop.hpp:205-227`：锁判断与 inflating 状态
- `markOop.hpp:263-319`：栈锁、monitor、偏向编码、hash 写入
- `markOop.hpp:324-359`：age/hash/forwarding 编码
- `synchronizer.cpp:669-706, 732-799`：hash 生成、CAS 安装、膨胀边界
- `oop.inline.hpp:341-409`：forwarding 与并发转发
- `arguments.cpp:1609-1676`：压缩指针 ergonomics
- `compressedOops.inline.hpp:46-71`：地址编码/解码
- `instanceOop.hpp:33-45`：压缩类指针下字段起始偏移
- `oop.cpp:168-185`：klass gap 与原始 Klass 访问

## 7. 必须明确的边界

- 本篇基于 JDK 11u 的 `markOop` 命名；不能外推到已改用 `markWord` 的新版本
- 偏向锁、CMS 字段和 CMS free/promoted 编码属于该实现的历史/兼容边界
- 低位 `11` 的具体解释依赖当前 GC 阶段和调用协议，不能说成对象永久的“GC 状态”
- 空对象 16 字节是 64 位、8 字节对齐、压缩类指针等前提下的常见结果，不是所有 JVM 配置的常数
- 压缩 Klass 指针的 base/shift 是运行时配置结果，不把所有机器都写成同一数值
- `is_oop` 只讲 DEBUG/ASSERT 校验边界，不扩展成生产运行时类型安全机制

## 8. 完成后 review

- 删除代码后能否复述“状态槽 → 低位 tag → 信息搬移 → GC forwarding → 压缩 Klass”的完整链路
- 是否解释了 hash、锁、GC 之间的冲突和让位关系
- 是否区分 Java 堆、C heap、栈和对象头本身
- 是否没有把 JDK 11u 的 `markOop` 术语写成新版本 `markWord`
- 是否完成至少三轮源码边界 review、禁用词扫描和 `file:line` 核对
