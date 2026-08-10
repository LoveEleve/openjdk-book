# 03 - 对象模型 (OOP & Object Model)

> 源码索引：`source_index/01-oops.md`（87文件，已索引87/87）
> 插桩覆盖：`-Xlog:probe_oop=debug`（6cpp）
> 前置专题：[01-jvm-startup](../01-jvm-startup/) + [02-class-loading](../02-class-loading/)
> 交叉引用：02 专题已分析 InstanceKlass/Method/ConstantPool/vtable/itable 的字段级结构

---

## 〇、上手指南 ⭐（新手必读）

### 0.1 本文档适合谁？

| 水平 | 特征 | 建议路径 |
|------|------|---------|
| 🟢 初级 | 知道 `new Object()` 分配对象，不知道对象在内存里长什么样 | 先读本节 → 入门路径 |
| 🟡 中级 | 理解对象头有 Mark Word 和 Klass 指针，想搞清楚 bit 级别编码 | 入门路径速览 → 进阶路径 |
| 🔴 高级 | 读过 markOop.hpp 源码，需要 hash/锁/GC 标记的完整参考 | 直接按需查阅 |

### 0.2 你需要什么基础？

| 必须 | 可选但更好 |
|------|-----------|
| 理解 `java.lang.Object` 是所有类的父类 | 读过 01-jvm-startup 入门路径（至少知道 InstanceKlass 是什么） |
| 知道对象可以 `synchronized` 加锁 | 读过 02-class-loading 的 05-FieldInfo-Method-Creation（Method 结构） |
| 知道 `hashCode()` 是 Object 的方法 | 了解 GC 基本概念（什么是垃圾回收） |

### 0.3 对象模型的本质（三句话）

> `new Object()` 在堆上分配了什么？`obj.hashCode()` 的值存哪儿？`synchronized(obj)` 怎么知道锁被谁持有了？

```
Java 对象 = 对象头(8+4=12B 压缩) + 实例字段
对象头 = Mark Word(8B) + Klass*(压缩4B)
Mark Word = hash:25|age:4|biased:1|lock:2 联合编码（见 §二）
```

**一个 8 字节的 Mark Word 同时存 hash、GC 年龄、锁状态——用不同 bit 段编码三种并发安全信息。这是 JVM 最重要的 bit-level 数据结构。**

### 0.4 核心术语速查表

| 术语 | 一句话解释 | 对应源码 |
|------|----------|---------|
| **oop / oopDesc** | Java 对象的 C++ 表示——堆上分配的"实例" | `oops/oop.hpp:55` |
| **markOop / markOopDesc** | 对象头的 Mark Word——8 字节存 hash/锁/GC 标记 | `oops/markOop.hpp:104` |
| **Klass** | Java 类的 C++ 元数据——所有同类型对象共享 | `oops/klass.hpp:78` |
| **prototype_header** | Klass 的"原形对象头"——创建新对象时 copy 到 markWord | `oops/klass.hpp:633` |
| **TLAB** | 线程局部分配缓冲——每个线程在 Eden 的专属区域，无锁分配 | `gc/shared/threadLocalAllocBuffer.hpp:46` |
| **CompressedOops** | 压缩指针——64 位堆上用 32 位存对象引用（8 字节对齐时省 50%） | `oops/compressedOops.hpp` |
| **bump-pointer** | 指针碰撞分配——`top += size`，最简单 O(1) 分配 | 各 GC 实现 |
| **biased_lock / lightweight_lock / inflated_lock** | 偏向锁/轻量锁/重量锁——synchronized 的三种升级路径 | `markOop.hpp:150` |
| **get_next_hash** | 6 种 hashCode 生成策略（随机数/地址/MarsagliaXOR/...） | `runtime/synchronizer.cpp:678` |

### 0.5 如何阅读本文档？三条路径

**🟢 入门路径**（预计 1-2 小时，得"骨架"）：

```
1. 先看本节（0.1-0.6）                                  ← 你现在在这里
2. 看 §一 核心继承体系 + §二 markOop 编码（概要）         ← 理解对象头和二分模型
3. 看 §三 数据结构表（扫一眼知道有哪些结构）               ← 10 个核心结构
4. [待写] 03-oop-klass-model.md（oop/Klass 二分模型）     ← 理解对象如何"找到"自己的类
```

**🟡 进阶路径**（预计 5-8 小时，得"血肉"）：

```
在入门基础上：
5. [待写] 01-markOop-Deep-Dive.md（markOop 5 种锁状态）  ← ★ 核心
6. [待写] 04-hashCode-Mechanism.md（6 种策略 + CAS 安装） ← ★ 核心
7. [待写] 02-Object-Allocation.md（TLAB→堆→Humongous）    ← 分配全路径
8. [待写] 05-CompressedOops.md（压缩指针原理）             ← ★ 核心
```

**🔴 专家路径**（按需查阅）：

| 你想了解 | 待看文档 |
|---------|---------|
| synchronized 三种锁怎么在 markWord 里编码 | [待写] 01-markOop-Deep-Dive |
| obj.hashCode() 的值到底怎么生成的 | [待写] 04-hashCode-Mechanism |
| TLAB 怎么做到无锁分配的 | [待写] 06-TLAB-Detail |
| -XX:+UseCompressedOops 能省多少内存 | [待写] 05-CompressedOops |
| 32 位堆怎么存下 32GB 堆地址 | [待写] 05-CompressedOops |
| new Object() 从 TLAB 到堆分配的完整路径 | [待写] 02-Object-Allocation |

### 0.6 环境准备

```bash
# 用 slowdebug 版 JVM
JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java

# 观察对象分配
$JAVA -Xlog:gc+alloc=debug -Xms8g -Xmx8g -XX:+UseG1GC -cp /data/workspace/demo/src com.wjcoder.Main 2>&1 | head -10

# 验证压缩指针
$JAVA -Xlog:gc+heap+coops=info -version 2>&1 | grep -i "compressed"

# 关闭压缩指针对比
$JAVA -XX:-UseCompressedOops -version 2>&1 | grep -i "compressed"

# GDB 调试对象布局
gdb --args $JAVA -Xint -XX:+UseG1GC -cp /data/workspace/demo/src com.wjcoder.Main
(gdb) break InstanceKlass::allocate_instance
(gdb) break memAllocate
(gdb) run
```

---

## 一、核心继承体系

```
MetaspaceObj（Metaspace 分配）
  └── Metadata
        └── Klass (208B)                    ← 所有 Java 类的 C++ 表示
              ├── InstanceKlass (~500B+)    ← Java 普通类
              │     ├── InstanceRefKlass     ← Reference 子类（Soft/Weak/Phantom）
              │     └── InstanceMirrorKlass  ← Class 镜像（Class<MyClass>）
              └── ArrayKlass
                    ├── ObjArrayKlass       ← 引用数组（Object[]/String[]）
                    └── TypeArrayKlass      ← 基本类型数组（int[]/byte[]）

CHeapObj（C heap 分配，此处不展开）

oop（堆上分配）—— 二分模型的"实例端":
  ┌────────────────────┐
  │ markOopDesc (8B)   │ ← Mark Word: hash+锁+GC+年龄
  ├────────────────────┤
  │ Klass* (8B→压缩4B)  │ ← 指向 InstanceKlass
  ├────────────────────┤
  │ 实例字段...         │ ← FieldInfo 布局
  └────────────────────┘
```

**二分模型核心**：每个 Java 对象在堆上有 oop（存数据 + Klass 指针），在 Metaspace 有对应的 Klass（存类元数据 + vtable/itable）。`oop.klass()` 通过 Klass 指针**从实例找到类元数据**——这是反射、instanceof、方法调用的根基。

---

## 二、markOop 64 位编码（概要）

### 2.1 完整 bit 布局

> `oops/markOop.hpp:35-98` 注释 + 源码验证

```
64 位 Big Endian 布局:
┌───────────────┬───┬──────┬───────┬────┐
│ hash:25       │␣1│ age:4│ bias:1│lock│
│               │   │      │       │ :2 │
└───────────────┴───┴──────┴───────┴────┘
 63............39 38  37..34    33     32 31..0

低 32 位在 32-bit VM 有单独含义（此处省略）
```

### 2.2 5 种锁状态（lock=bits[1:0]）

| bias | lock | 状态名 | 枚举值 | 含义 |
|:---:|:---:|------|---------|------|
| 0 | 01 | **unlocked** | `unlocked_value = 1` | 无锁，正常状态 |
| 1 | 01 | **biased** | `biased_lock_pattern = 5` | 偏向锁（指向持有线程） |
| 0 | 00 | **lightweight locked** | `locked_value = 0` | 轻量级锁（指向线程栈上的 BasicLock） |
| — | 10 | **inflated (monitor)** | `monitor_value = 2` | 重量级锁（指向 ObjectMonitor） |
| — | 11 | **GC marked** | `marked_value = 3` | GC 标记（转发指针或标记位） |

**状态转换**：unlocked → biased（首次 synchronized）→ lightweight（竞争）→ inflated（重度竞争）。**只能单向升级**。

### 2.3 hashCode 存储位置

- **unlocked 状态**：hash 存在 markWord 的 hash:25 位中
- **biased 状态**：hash 位被偏向锁占用，**无法再存 hash**——计算 hashCode 会**撤销偏向锁**，转为 unlocked 后存入
- **lightweight/inflated 状态**：hash 在偏向锁撤销时被"挤出"到线程栈或 ObjectMonitor 中

---

## 三、完整文件索引

| # | 文件 | 核心类/函数 | 说明 |
|---|------|-----------|------|
| 1 | `oops/markOop.hpp` | `markOopDesc` | ★ Mark Word 64 位编码 + 锁状态方法 |
| 2 | `oops/oop.hpp` + `oop.inline.hpp` | `oopDesc` | ★ 对象头（_mark + _klass） |
| 3 | `oops/klass.hpp` + `klass.inline.hpp` | `Klass` | ★ 类元数据基类（_prototype_header 等） |
| 4 | `oops/instanceKlass.hpp` | `InstanceKlass` | 普通类的完整元数据 ✅(02) |
| 5 | `oops/arrayOop.hpp` | `arrayOopDesc` | 数组对象（length + data） |
| 6 | `oops/compressedOops.hpp` + `.inline.hpp` | `CompressedOops` | ★ 压缩指针 encode/decode |
| 7 | `gc/shared/memAllocator.cpp` | `MemAllocator::allocate()` | ★ 对象分配全路径（TLAB→堆→Humongous） |
| 8 | `gc/shared/threadLocalAllocBuffer.hpp` + `.cpp` | `ThreadLocalAllocBuffer` | ★ TLAB 管理（_start/_top/_end/_desired_size） |
| 9 | `gc/shared/collectedHeap.hpp` | `CollectedHeap` | 堆内存分配的抽象接口 |
| 10 | `runtime/synchronizer.cpp` | `FastHashCode` / `get_next_hash` | ★ hashCode 生成（6 种策略）+ CAS 安装 |
| 11 | `oops/oopsHierarchy.hpp` | oop/Klass 类型别名 | 类型层次定义 |
| 12 | `oops/klassVtable.cpp` | `klassVtable` / `klassItable` | vtable/itable 构建 ✅(02) |

---

## 四、关键数据结构（补全版）

> 标注 `✅(02)` 的结构已在 02 专题完成完整字段分析，此处不重复。

| 结构 | sizeof | 验证来源 | 作用 |
|------|:---:|------|------|
| **核心（6 个）** ||||
| `markOopDesc` | 8B | GDB | ★ Mark Word：hash(25)+age(4)+biased(1)+lock(2) |
| `oopDesc` | 8B+Klass* = 12B(压缩)/16B | GDB | ★ 对象头：_mark + _klass |
| `Klass` | 208B | README | 类元数据基类（_prototype_header + _java_mirror） |
| `InstanceKlass` | 600-2000B ✅(02) | 02 §1.1 | Java 普通类的完整元数据 |
| `Method` | 104B ✅(02) | 02 05 §1.5 | 方法元数据 |
| `ThreadLocalAllocBuffer` | ~112B | 待GDB | ★ TLAB：_start/_top/_end/_pf_top + 统计 |
| **辅助（8 个）** ||||
| `arrayOopDesc` | 8B+Klass*+length = 16B(压缩) | 源码推算 | 数组对象头（多一个 length 字段） |
| `BasicLock` | 8B | 源码推算 | 轻量级锁——存 displaced markWord |
| `ObjectMonitor` | ~168B | 源码推算 | 重量级锁——_owner/_EntryList/_WaitSet |
| `ConstantPool` | 72B ✅(02) | 02 04 §一 | 运行时常量池 |
| `ConstantPoolCache` | 40B ✅(02) | 02 04 §二 | 解析缓存 |
| `InvocationCounter` | 4B | 源码推算 | JIT 热计数（carry+state+count 编码） |
| `MethodCounters` | 88B | 源码推算 | invocation_counter + backedge_counter |
| `NarrowPtrStruct` | 4B | 源码推算 | 压缩指针的 32 位存储 |

---

## 五、探针覆盖

### 5.1 OOP 分配与元数据（probe_oop = 26 个）

| 文件 | 数量 | 关键探针 |
|------|:--:|------|
| instanceKlass.cpp | 7 | allocate_instance, initialize, link_class, link_methods |
| constantPool.cpp | 7 | klass_at_put, klass_at_impl, resolve_string_constants, CREATED |
| klassVtable.cpp | 7 | VTableInit, ITableInit, vtable/itable 分配信息 |
| methodCounters.cpp | 4 | build/allocate, CAS SUCCESS/FAIL |
| method.cpp | 1 | 方法分配调试 |

### 5.2 哈希与锁（probe_runtime 相关）

| 文件 | 关键探针 |
|------|---------|
| synchronizer.cpp | FastHashCode INSTALL（obj地址/hash值/markBefore） |
| synchronizer.cpp | FastHashCode INFLATE（obj地址/mark状态） |

---

## 六、计划文档（7 篇）

### 总览
- [x] **00-OOP-Overview.md** — 对象模型总览（本章入口文档 + 端到端追踪 `new Object()`） ✅ DONE

### P0：对象头与分配（3 篇）
- [x] **01-markOop-Deep-Dive.md** — ★★★ markOop 对象头深度解析（64bit 编码 × 5 种锁状态 × hashCode 存储位置 × 状态转换）
- [x] **02-Object-Allocation.md** — ★ Java 对象分配完整路径（`new` → TLAB fast → TLAB refill → 堆分配 → Humongous）
- [x] **03-OOP-Klass-Model.md** — ★ oop/Klass 二分模型（对象头结构 × Klass 指针 × 类型层次 × 反射/instanceof 原理）

### P1：优化技术（3 篇）
- [x] **04-HashCode-Mechanism.md** — ★ hashCode 生成机制（6 种策略 × CAS 安装 × 偏向锁撤销）
- [x] **05-CompressedOops.md** — 压缩指针原理（encode/decode × Shift=3 对齐 × 32GB 限制 × 性能影响）
- [x] **06-TLAB-Detail.md** — TLAB 机制详解（allocate/refill/waste/dynamic_sizing × 统计信息）

### 产出优先级

```
P0（第一批）:
  01-markOop-Deep-Dive.md       ← 最核心：对象头编码 + 锁状态机
  02-Object-Allocation.md       ← 最核心：new 的全路径
  03-OOP-Klass-Model.md         ← 理论根基：二分模型

P1（第二批）:
  04-HashCode-Mechanism.md      ← 实用：hash 怎么生成的
  05-CompressedOops.md           ← 优化：为什么能省 50% 内存
  06-TLAB-Detail.md             ← 性能：无锁分配的原理
```

---

```
01-jvm-startup          ← 前置：InstanceKlass/Method/ConstantPool 的结构
    ↓
02-class-loading         ← 前置：类加载如何进行？
    ↓
03-object-model          ← 你在这里：对象如何在内存中表示和分配？
    ↓
04-interpreter           ← 后续：字节码如何操作这些对象？
    ↓
05-jit-compiler          ← 后续：热点方法如何编译优化？
```

---

## 七、面试高频问题 × 文档直接对应

| 面试问题 | 直接看这篇 | 为什么 |
|----------|-----------|--------|
| "Java 对象在内存中长什么样？markOop 64 位每一位的含义？" | [01](01-markOop-Deep-Dive.md) | §1.2 完整 64 位 bit 布局：hash(25)\|unused(1)\|age(4)\|biased(1)\|lock(2) + 低 32 位。§1.3 5 种锁状态对照表逐位解释 |
| "Object header 多大？为什么 12/16 bytes？（32/64-bit）" | [01](01-markOop-Deep-Dive.md) + [03](03-OOP-Klass-Model.md) | 01 §1.2 解释 8B markWord；03 §1.1 解释压缩 4B Klass* vs 非压缩 8B Klass* → 12B vs 16B。§3.1 PrintFieldLayout 输出验证 |
| "compressedOops 怎么用 32 位存 64 位指针？" | [05](05-CompressedOops.md) | §一 encode/decode 源码：`addr >> 3`（右移 3 位去掉对齐尾 0 存入 32 位）→ 读取时 `v << 3` 还原。零基址优化省去一次加法 |
| "为什么 heap < 32GB 零基压缩可用，>32GB 不可用？" | [05](05-CompressedOops.md) | §2.1 推导：32-bit narrowOop × 8B 对齐 = 32GB。§一方案 A（基址偏移）可支持 >32GB 但性能差，需 `-XX:ObjectAlignmentInBytes=16` |
| "Java 对象对齐为什么是 8 bytes？能改吗？" | [05](05-CompressedOops.md) | §2.2 对齐与碎片权衡：8B 对齐平均浪费 4B/对象 → 用 `-XX:ObjectAlignmentInBytes=16` 可改但碎片加倍。对齐影响压缩指针 shift |
| "synchronized 的偏向锁怎么存储在 markOop 中？" | [01](01-markOop-Deep-Dive.md) | §1.2 biased_lock:1 位 (bit[33]) + lock:2 位 = 101 组成 biased_lock_pattern。§2.2 `has_bias_pattern()` 源码判定。§2.3 hash vs bias 冲突详解 |
| "对象怎么计算 identity hash code？存哪？" | [01](01-markOop-Deep-Dive.md) §1.5 + [04](04-HashCode-Mechanism.md) | 04 §一 FastHashCode() 主流程：3 分支（neutral/inflated/lightweight）各自读取/生成 hash。04 §二 6 种策略（默认 Marsaglia XOR-shift）。存于 markWord hash:25 位 |
| "Klass 和 oop 什么关系？怎么互相查找？" | [03](03-OOP-Klass-Model.md) | §零 二分模型：100 个 String 对象在堆有 100 个 oop，共享 1 个 Metaspace 的 InstanceKlass。§1.1 `oop.klass()` decode 压缩指针。§1.2 `Klass::_java_mirror` 反向指 Class 镜像 |
| "instanceof 在 JVM 内部怎么实现的？" | [03](03-OOP-Klass-Model.md) | §1.3 `is_subtype_of()` 4 级加速：直接相等(O1) → primary_supers[offset](O1) → secondary_supers 遍历(On) → super 链递归(On)。§2.1 Mermaid 流程图 |

---

## 八、生产故障 × 文档诊断指引

| 生产场景 | 症状 | 看这篇 | 诊断 |
|---------|------|--------|------|
| compressedOops 导致 >32GB 堆时 NullPointerException | 堆 33GB，NPE 随机出现，-Xms33g -Xmx33g 后出现 | [05](05-CompressedOops.md) | §2.1：>32GB 自动禁用压缩，NPE 非压缩所致。检查 `-XX:+PrintFlagsFinal \| grep UseCompressedOops` → false。验证零基址 `_narrow_oop._base` 是否为 NULL（GDB） |
| GC 标记时间异常长（偏向锁撤销风暴） | `-XX:+UseBiasedLocking` STW 数秒，大量 RevokeBias 日志 | [01](01-markOop-Deep-Dive.md) §2.3 | 偏向锁撤销需要 SafePoint 同步（~100-200 cycles/对象 × 千万对象 = 数秒）。检查 `-Xlog:biasedlocking=debug` 日志。关闭：`-XX:-UseBiasedLocking`。或提前计算 hashCode 避免 bias→hash 冲突 |
| identity hash code 和锁冲突（偏向锁无法安装） | `synchronized` 性能退化，轻量锁代替偏向锁 | [01](01-markOop-Deep-Dive.md) §2.3 + [04](04-HashCode-Mechanism.md) §三 | 01 §2.3 场景 1：先 hashCode → 再 synced → markWord 已有 hash 占用偏向锁位 → 无法偏向 → 直接升级 lightweight。04 §三 冲突表：检查代码中是否 hashCode 在 synchronized 之前被调用 |
| TLAB 频繁 refill 导致 Eden 碎片化 | Eden 空间足够但分配性能下降，refill 次数异常高 | [06](06-TLAB-Detail.md) + [02](02-Object-Allocation.md) | 06 §2.3 EMA 动态调整失效：`_desired_size` 与线程分配率不匹配。检查 `-Xlog:gc+tlab=trace` → refill 频率。06 §2.4 waste 管理：`_refill_waste_limit` 过低导致 TLAB 过小。调大 `-XX:TLABSize=2m` |
| 大对象 (≥2MB) 分配导致 GC 压力 | Full GC 频繁，堆中有大量连续 Region 组 | [02](02-Object-Allocation.md) §2.4 | 大对象直接走 Humongous 分配（绕过 TLAB），老年代收集代价高。02 §2.4：Humongous 阈值 = Region/2。用 `-XX:G1HeapRegionSize=8m` 提高阈值 |
| 对象大小随 JDK 升级变化 | 升级 JDK 后对象大小变化，内存用量增加 | [03](03-OOP-Klass-Model.md) §3.1 + [05](05-CompressedOops.md) §三 | 03 §3.1 PrintFieldLayout 输出对照新旧 JDK。05 §三 非压缩 vs 压缩效果表：确认不存在压缩开关意外关闭。检查 `UseCompressedClassPointers` 是否启用 |
| identity hash code 不一致（主备切换后） | 主备环境 hashCode 不同导致分布式路由错误 | [04](04-HashCode-Mechanism.md) §二 | 默认 Marsaglia XOR-shift 每线程独立状态 → 同一对象在不同 JVM 实例的 hashCode 不同。策略 4（对象地址）由内存布局决定。用 `-XX:hashCode=3`（自增）解决可重现需求（测试/调试） |

---

## 九、深度评审检查点（自检 7 篇文档）

> 含本次审计前的诚实评级。标志含义同 01-readme §十二。

| # | 文档 | 生产故障可直接参考？ | 面试题可直接回答？ | 解释了"为什么这样设计"？ | sizeof 是 GDB 实测？ | 审计前评级 |
|:---|------|:---:|:---:|:---:|:---:|:---:|
| 00 | 00-OOP-Overview.md | ❌ (缺故障场景) | ✅ (三类核心问题 + `new Object()` 端到端) | ⚠️ (概览为主，缺"为什么三步走"等设计分析) | ❌ (无 GDB session 输出) | 🔴 |
| 01 | 01-markOop-Deep-Dive.md | ⚠️ (hash/lock 冲突已解释，缺偏向锁撤销风向标诊断) | ✅ (64 位 bit 布局 + 5 种锁状态 + hashCode 存储) | ✅ (职责分离、hash/bias 冲突、不可逆升级、prototype_header 设计) | ❌ (缺 `p sizeof(markOopDesc)=8` 的 GDB 会话输出) | 🟡 |
| 02 | 02-Object-Allocation.md | ⚠️ (TLAB→堆→Humongous 路径清楚，缺"为什么三步走"和 refill 频率诊断) | ✅ (三步分配策略 + Humongous 阈值) | ⚠️ (有三步走但缺"为什么不让所有对象直接堆分配""为什么 TLAB 是 ~1-2MB") | ❌ (几乎无 GDB 会话输出) | 🔴 |
| 03 | 03-OOP-Klass-Model.md | ⚠️ (二分模型清楚，缺生产故障诊断案例) | ✅ (二分模型 + instanceof 4 级加速 + 字段重排序) | ✅ (4 级加速设计 why、字段重排序 why、职责分离) | ❌ (PrintFieldLayout 有但缺 `p sizeof(Klass)=208` GDB 输出) | 🔴 |
| 04 | 04-HashCode-Mechanism.md | ✅ (偏向锁撤销 + 策略选择诊断) | ✅ (6 种策略、为什么默认 Marsaglia、惰性生成 + CAS) | ✅ (策略 5 vs 0 选择、惰性生成 why、CAS 安装 why、hash/bias 冲突) | ❌ (有 GDB `break` 命令但缺实际会话输出) | 🟡 |
| 05 | 05-CompressedOops.md | ✅ (>32GB NPE、压缩失效) | ✅ (encode/decode 源码、32GB 推导、对齐权衡) | ✅ (零基址优化 why、对齐为什么 8 非 16、32-bit 取舍) | ❌ (有 `PrintFlagsFinal` 输出但缺 GDB `_narrow_oop._base` 验证输出) | 🟡 |
| 06 | 06-TLAB-Detail.md | ⚠️ (EMA 自适应解释好，缺 refill 风暴/对象大小 > TLAB 的场景诊断) | ✅ (bump-pointer、refill、EMA、waste 管理) | ✅ (EMA 自适应 why、waste 管理 why) | ❌ (几乎无 GDB 会话输出) | 🔴 |

**审计前统计**：🔴 4 篇（00/02/03/06）| 🟡 3 篇（01/04/05）| ✅ 0 篇

> 主要缺口：
> - **生产故障 opener**：7/7 篇缺失（无一以生产场景开头）
> - **GDB session 输出**：7/7 篇缺失（有断点命令但无实际终端输出截图/文本）
> - **设计 rationale**：2/7 篇不足（00 概览缺分析、02 缺"三步走"设计理由）

---

## 十、深度审计问题（用于审计现有文档质量）

### Tier 1：markOop 编码（覆盖 01/04）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q1 | ❓ markOop 的 hash:25 位为什么是 25 位而非 32 位？25 位 hash 冲突概率是多少？设计者如何权衡 hash 宽度 vs 锁信息宽度？ | 01 §1.2 §1.5 |
| Q2 | ❓ 偏向锁撤销为什么需要 SafePoint？能不能不在 SafePoint 撤销？BiasedLockingBulkRebias 和 BiasedLockingBulkRevoke 的区别是什么？ | 01 §2.1 §2.3 |
| Q3 | ❓ 6 种 hashCode 策略中，Marsaglia XOR-shift 为什么比 Park-Miller 快 2-3x？每线程独立状态（`_hashStateX/Y/Z/W`）的初始化种子从哪来？ | 04 §二 |

### Tier 2：oop/Klass 层次与分配（覆盖 02/03/06）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q4 | ❓ TLAB 为什么要动态调整大小（EMA）而不是固定大小？如果所有线程都固定分 1MB，128 个线程需要 128MB——这个开销合理吗？ | 06 §2.3 + 02 §2.1 |
| Q5 | ❓ MemAllocator 设计为 StackObj（栈对象）——分配完即析构。为什么不设计为可复用的堆对象？每次 new Object() 构造一次 MemAllocator 的开销是多少？ | 02 §1.3 |
| Q6 | ❓ `oop.klass()` 在 `UseCompressedClassPointers=true` 时每次调用都要 decode——为什么不直接把 decode 后的结果 cache 在 oop 中？ | 03 §1.1 |
| Q7 | ❓ InstanceKlass 的 `_secondary_super_cache` 只有一个 slot，如果多个接口交替做 instanceof，cache 命中率如何？为什么不扩成多 slot？ | 03 §1.2 §2.1 |

### Tier 3：压缩指针（覆盖 05）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q8 | ❓ compressedOops 的 `_narrow_oop._base` 和 `_narrow_klass._base` 为什么是两个独立参数？什么场景下对象堆和 Metaspace 需要不同的基址？ | 05 §一 |
| Q9 | ❓ 堆 33GB 时 compressedOops 静默禁用——为什么不抛警告？为什么不能"部分压缩"（前 32GB 压缩，超出的不压缩）？ | 05 §2.1 |
| Q10 | ❓ `ObjectAlignmentInBytes=16` 让最大堆翻倍到 64GB，但每个对象平均多浪费 4B——对齐字节的增多如何影响 compressedOops 的 shift？shift=4 比 shift=3 有什么区别？ | 05 §2.2 |

### Tier 4：锁与 GC（覆盖 01/06）

| # | 问题 | 应出现于 |
|---|------|---------|
| Q11 | ❓ lightweight lock 的 displaced markWord 存在线程栈 BasicLock 上——如果 GC 发生时对象正好是 lightweight locked，GC 如何找到并更新 displaced markWord 中的引用？ | 01 §1.3 |
| Q12 | ❓ GC 移动对象时 markWord 设为 marked_value(3) 存入转发指针——转发指针的格式是什么？为什么选用低 2 位 = 11 编码而非独立字段？ | 01 §1.2 §1.3 |

---

## 十一、和前后阶段的连接

| 阶段 | 依赖 03 的 | 具体依赖内容 |
|------|-----------|-------------|
| 01-jvm-startup | 01 Phase 13/14 创建的基础 Klass(Object/Class/String) → 03 解释这些 Klass 如何转化为具体的对象布局 | 01 的 Universe::genesis() 创建的 `InstanceKlass` 带完整 vtable/itable；03 基于这些结构分析 `new Object()` 时 markWord 初始化(`_prototype_header=0x01`) 和 Klass* 设置 |
| 02-class-loading | 02 加载的任何类最终都要产出一份 `InstanceKlass` + `_prototype_header` → 03 解释这些产物如何用于对象分配 | 02 的 ClassFileParser::fill_instance_klass() 填充 `_nonstatic_field_size`/`_static_field_size`/`_layout_helper`；03 的 `MemAllocator` 用 `_layout_helper` 确定对象大小 |
| **03-object-model** | ★ **你在这里** — oop/Klass 二分模型、markOop 编码、压缩指针、TLAB 分配路径 | 7 篇文档覆盖：对象头编码 → 分配路径 → 二分模型 → hashCode → 压缩指针 → TLAB |
| 04-interpreter | TemplateTable::_new() 用 `InstanceKlass::allocate_instance()` → 03 已分析完整的 allocate 调用链。字节码执行时所有 oop 引用通过 `oop.klass()` 做类型检查 | 04 的 `TemplateTable::_new` 直接调用 03 的 `MemAllocator::allocate()` 流程；`instanceof`/`checkcast` 字节码用 `Klass::is_subtype_of()` (03 §2.1) 做类型判定 |
| 05-jit-compiler | JIT 生成的机器码中所有 oop 引用使用 03 的压缩指针 encode/decode；逃逸分析（标量替换/栈上分配）跳过 03 的 TLAB 分配 | 05 的 C2 编译器在生成 mov 指令时，用 `CompressedOops::encode(decode)` 保证偏移正确；逃逸分析后 `_new` 直接写栈帧（绕过 MemAllocator） |
| 06-gc-memory | GC 标记阶段读取 markOop 的 lock:2 位判断对象状态（forwarded/not marked）；GC 移动对象后写 markOop = marked_value(3) + 转发指针 | 06 的 G1ParScanThreadState::copy_to_survivor_space() 读 markWord → `is_marked()` 判断 → `cas_set_mark(old, new_forwarding)` 原子安装转发指针；Young GC 后 TLAB 退休（06 §四） |
| 07-thread-lock | synchronized 的三种锁状态（偏向/轻量/重量）编译在 markOop 3 个 bit 中 → 03 提供完整的位编码表和状态机 | 07 的 `ObjectSynchronizer::fast_enter()` 读 markWord → `has_bias_pattern()` 判定 → CAS 安装偏向锁；`slow_enter()` 升级 lightweight→inflated；03 §二 状态转捪图是所有锁操作的"地图" |
| 08-safepoint | 偏向锁批量撤销（BulkRevoke）在 SafePoint 执行 → 03 解释为什么撤销需要 SafePoint（读/写 displaced header 涉及栈遍历） | 08 的 `SafepointSynchronize::begin()` 保证所有线程停下 → `BiasedLocking::revoke_at_safepoint()` 遍历所有 JavaThread 栈帧上的 BasicLock → 移除偏向锁 |
| 12-cpu-layer | compressedOops 的 encode/decode 编译成 CPU 指令 → `shl $3`（零基址）或 `add + shl`（基址偏移）的指令选择来自 03 的 `_narrow_oop._base` 是否为 NULL | 12 的 `movabs` + `shl` 指令在模板解释器中对应 `oop.klass()` 的 decode 过程；03 §一 两种方案决定了生成什么指令序列 |

> **所有后续阶段共享的 03 基线**：
> - `_mark` (8B) — offset=0 的对象头，04/06/07/08 都以 markWord 的 bit 布局为前提
> - `_klass` (4B/8B 压缩/非压缩) — offset=8(压缩)/12(非压缩)，04-interpreter/12-cpu 通过 `oop.klass()` decode 获取 Klass*
> - `prototype_header = 0x01` — 03 验证的出厂值，02/05/07 的对象创建/编译假定此值
> - `ObjectAlignmentInBytes = 8` — 压缩指针 shift=3 的数学依据，06 GC 的 Region 大小和对象对齐计算依赖此值
