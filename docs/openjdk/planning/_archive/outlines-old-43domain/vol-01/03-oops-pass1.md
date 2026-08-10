# OOPs（对象模型）— Pass 0+1 探索笔记

> vol-01 · 域 03 · 🔴 A | 2026-08-07
> 拓扑排序 #3（叶子域 — 只依赖 OS）

## Pass 0: 设计上下文

**关键 git 提交**：
- `12312a3906` 8230841: 删除 `oopDesc::equals()` —— JVM 内部不用 Java 语义的 equals
- `d424c0ced4` 8267396: 避免在 unhandled oops detector 中记录 pc —— 性能优化
- `d5753afd23` 8208658: CDS 归档堆区域在不匹配 compressed oop 编码时也能用 —— 压缩指针稳定性
- `be7343dfc9` 8277342: `InstanceKlass::jni_id_for` 中 SIGSEGV —— Klass 生命周期管理 bug

**演进趋势**：对象模型是 JDK 中最稳定的层——oopDesc 两字段结构（_mark + _metadata）自 JDK7 就没变过。主要改动在压缩指针策略（JDK8 后稳定）和 CDS 兼容性。

## Pass 1: 结构扫描

### 包结构
```
oops/
  oop.hpp            — oopDesc（对象头：markOop + Klass 指针）
  markOop.hpp        — markOopDesc（mark word 位打包：hash/age/lock/bias/GC）
  klass.hpp          — Klass 基类
  instanceKlass.hpp  — InstanceKlass（Java 类的 C++ 表示，4025行 .cpp）
  arrayKlass.hpp     — ArrayKlass（数组基类）
  objArrayKlass.hpp  — ObjArrayKlass（Object[] 数组）
  typeArrayKlass.hpp — TypeArrayKlass（int[]/byte[] 基本类型数组）
  instanceOop.hpp    — instanceOopDesc（Java 对象实例）
  objArrayOop.hpp    — objArrayOopDesc（引用数组实例）
  method.hpp         — Method（方法元数据，3733行）
  constMethod.hpp    — ConstMethod（编译时常量方法信息）
  constantPool.hpp   — ConstantPool（运行时常量池，3716行）[归入 ClassFile 域]
  methodData.hpp     — MethodData（JIT 性能剖析数据，4338行）[归入 JIT 域]
  access.hpp         — Access API（GC 屏障的装饰器框架）
  fieldInfo.hpp      — 字段描述符
  klassVtable.hpp    — 虚方法表
```

### Klass 继承树
```
Metadata
  └─ Klass (klass.hpp:78)
      ├─ InstanceKlass (instanceKlass.hpp:114)
      │   ├─ InstanceMirrorKlass (Class 对象的 Klass)
      │   ├─ InstanceRefKlass (Weak/Soft/Phantom 引用)
      │   └─ InstanceClassLoaderKlass (ClassLoader 的 Klass)
      └─ ArrayKlass (arrayKlass.hpp:36)
          ├─ ObjArrayKlass (Object[][]/String[] 等引用数组)
          └─ TypeArrayKlass (int[]/byte[]/boolean[] 基本类型数组)
```

### 对象内存布局
```
oopDesc (对象头，12/16 字节):
  ┌──────────────────────┐
  │ _mark  (8 bytes)     │ ← markOop: hash + age + lock + biased_lock + GC bits
  ├──────────────────────┤
  │ _klass (4 or 8 bytes)│ ← Klass* 或 narrowKlass (取决 UseCompressedClassPointers)
  └──────────────────────┘
  │ instance fields ...  │
```

### 基本元素分解

1. **对象头**：`oopDesc`（`oop.hpp:54-63`）——每个 Java 对象 12/16 字节的头。`_mark`（markOop，8 字节）存 hash/age/锁状态/GC 标记，`_metadata`（union：Klass* 或 narrowKlass）指向类的元数据。

2. **Mark Word 位打包**：`markOopDesc`（`markOop.hpp`）——一个 8 字节字内打包了 `hash(31bit) + age(4bit) + biased_lock(1bit) + lock(2bit) + GC_bits + epoch(2bit)`。根据 `lock` 字段的 2 位编码 5 种状态：00=无锁、01=偏向锁、10=轻量锁、11=重量锁、特殊的 GC 标记。

3. **Klass 层级**：`Klass → InstanceKlass → InstanceMirrorKlass/InstanceRefKlass/InstanceClassLoaderKlass` + `Klass → ArrayKlass → ObjArrayKlass/TypeArrayKlass`。每个 Java 类在 JVM 中对应一个 InstanceKlass 实例——包含 `_constants`（常量池）、`_methods`（方法数组）、`_fields`（字段信息）、`_annotations`、`_inner_classes`。

4. **压缩指针**：`narrowOop`（`oop.hpp:334`）把 64 位对象指针压缩到 32 位。编码：`real_addr = narrow_oop_base + (narrow_oop << narrow_oop_shift)`（`universe.hpp:416/433`）。堆 < 32GB 时 shift=3（8 字节对齐），base=堆起始地址。类指针同理（`narrow_klass`）。

5. **Access API**：`access.hpp/accessDecorators.hpp/accessBackend.hpp`——统一的 GC 屏障装饰器框架。`Access<>::load(p)` 根据装饰器（强/弱引用、屏障类型）选择不同的加载路径——通过编译期模板展开注入不同 GC 的屏障策略。

6. **Method**：`method.hpp/cpp`（3733 行）——方法的 C++ 表示。`ConstMethod` 存字节码/行号表/异常表（不可变部分），`Method` 存入口地址/解释器入口/i2c 适配器（可变部分）。两者分离使得 CDS 归档能共享 ConstMethod。

7. **字段布局**：`fieldInfo.hpp` + `fieldStreams.hpp`——`InstanceKlass::_fields` 存类声明的所有字段（含继承的），每个字段通过 6 个 u2（12 字节）压缩编码：`access_flags + name_index + signature_index + low_packed + high_packed + initval_index`。

### 标记问题（≥5）

1. **为什么 oopDesc 只有两个字段？** _mark 和 _klass——为什么 hash 和 GC 标记挤在 mark word 里而不是单独字段？为什么 klass 用 union（指针 vs 压缩偏移）而不是总是用指针？

2. **mark word 的 5 种锁状态怎么编码在 2 个 bit 里？** `lock_bits=2` 只有 4 个值（00/01/10/11），但偏向锁有额外 1 bit——`biased_lock_bits=1` 怎么和 lock_bits 组合出 5 种状态？

3. **压缩 oop 的 shift 为什么是 3？** `narrow_oop_shift = 3`（8 字节对齐）意味着压缩指针在 <32GB 堆上零开销——为什么不直接用 4 字节偏移？base 指针怎么选？

4. **InstanceKlass 为什么有 InstanceMirrorKlass 这种"一个实例"的子类？** `java.lang.Class` 对象有自己的 Klass——为什么？这个层级是怎么影响对象创建的？

5. **Access API 的装饰器框架是什么设计模式？** `Access<IN_HEAP | MO_UNORDERED>::load(p)`——装饰器是模板参数，编译期展开。为什么不用运行时虚函数？和 GC 屏障集成的性能要求是什么？

6. **Method 和 ConstMethod 为什么分离？** ConstMethod 存字节码/行号表（不可变），Method 存入口地址/适配器（可变——JIT 编译后更新）。这个切分的边界是什么？哪些信息被放在不可变一侧？

7. **constantPool 物理上在 oops/ 但概念上属于 ClassFile 域——域边界怎么划？** 3716 行的 constantPool.cpp 是对象模型的一部分还是类加载的一部分？
