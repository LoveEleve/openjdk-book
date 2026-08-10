# 域 06: OOPs — 知识规划

> 源码路径: hotspot/share/oops/ | 源码量: 87 文件 / 38,424 行 | 🔴 巨型域
> 拆 6-8 篇独立知识规划

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| oop.hpp.inline.hpp + oop.cpp + oopsHierarchy.hpp | **oopDesc — Java 对象 C++ 表示**: 2-word header (markOop + Klass*), oop 指针语义, is_oop 验证, 零开销类型转换 | High |
| markOop.hpp.inline.hpp.cpp | **markOop — 对象头压缩编码**: 32/64-bit 多用途字段 — hash/age/biasedLock/lockState/GC — 5 种状态共享同一 word | High |
| klass.hpp.inline.hpp.cpp + klassVtable.hpp.cpp | **Klass — 类元数据**: Klass 层次, vtable/itable layout, KlassID, klassVtable (虚方法表) | High |
| instanceKlass.hpp.inline.hpp.cpp | **InstanceKlass — 普通类元数据**: 方法表/字段表/常量池指针/注解/内部类/嵌套成员, ClassFileParser 填充 | High |
| instanceMirrorKlass.hpp.inline.hpp.cpp | **InstanceMirrorKlass — Class 对象元数据**: java.lang.Class 实例对应的 Klass, static field 存储 | High |
| instanceRefKlass.hpp.inline.hpp.cpp | **InstanceRefKlass — 引用对象元数据**: Soft/Weak/Phantom Reference, ReferenceQueue 入队逻辑, GC discover 机制 | High |
| instanceClassLoaderKlass.hpp.inline.hpp | **InstanceClassLoaderKlass**: ClassLoader 的 oop 类型, GC root 扫描 | Medium |
| arrayKlass.hpp.inline.hpp.cpp + objArrayKlass.hpp.inline.hpp.cpp + typeArrayKlass.hpp.inline.hpp.cpp | **数组 klass 层次**: ArrayKlass→ObjArrayKlass(对象数组)/TypeArrayKlass(基本类型数组), 数组分配/组件类型 | High |
| arrayOop.hpp.inline.hpp + objArrayOop.hpp.inline.hpp.cpp + typeArrayOop.hpp.inline.hpp | **数组 oop**: 数组对象的内存布局, array length 存储, 元素访问 | High |
| constantPool.hpp.inline.hpp.cpp + cpCache.hpp.inline.hpp.cpp | **ConstantPool + ConstantPoolCache**: 类常量池, cpCache (解析缓存), 符号引用→直接引用转换, invokedynamic 适配 | High |
| method.hpp.inline.hpp.cpp + constMethod.hpp.cpp + methodCounters.hpp.cpp | **Method + ConstMethod**: 方法的 C++ 元数据, bytecode/exception table/line number table, invocation counter, methodData profiling | High |
| methodData.hpp.inline.hpp.cpp | **MethodData — JIT profiling 数据**: branch/jump/call/invoke 的 runtime profiling counters, JIT 预热判断 | High |
| symbol.hpp.cpp | **Symbol — 全局唯一字符串**: interned symbol table, UTF-8 internal, #前缀引用计数 | High |
| access.hpp.inline.hpp + accessDecorators.hpp + accessBackend.hpp.inline.hpp.cpp | **Access API — GC Barrier 抽象**: Access<> 模板, load/store/atomic/arraycopy, GC barrier 装饰器, BarrieSet 后端 | High |
| oopHandle.hpp.inline.hpp + weakHandle.hpp.inline.hpp.cpp | **OopHandle + WeakHandle — 安全 OOP 引用**: GC 安全引用包装, JNIHandle 替代, WeakHandle 自动 null, JVMTI/JFR 使用 | High |
| instanceOop.hpp.cpp | **InstanceOop**: 普通对象, field 访问, GC 遍历 | Medium |
| metadata.hpp.cpp + compiledICHolder.hpp.cpp | **Metadata + CompiledICHolder**: Method/Klass 的基类, JIT inline cache holder | Medium |
| annotations.hpp.cpp + fieldInfo.hpp + fieldStreams.hpp | **Annotations + Field: 注解元数据**, field 信息, field iteration | Medium |
| verifyOopClosure.hpp | **OopVerifyClosure**: DEBUG only OOP 验证 | Low |

*15 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| Access API (GC Barrier 抽象) | access.*, accessBackend.*, accessDecorators.hpp, + gc/shared/barrierSet*, + 所有 GC 消费者 |
| oopDesc + markOop 对象头 | oop.*, markOop.*, oopsHierarchy.*, klass.*, instanceKlass.*, arrayOop.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| Klass 层次 + vtable | klass.*, klassVtable.*, instanceKlass.*, arrayKlass.* |
| ConstantPool + cpCache | constantPool.*, cpCache.*, method.* |
| Method + MethodData (JIT profiling) | method.*, constMethod.*, methodCounters.*, methodData.* |
| InstanceKlass 体系 | instanceKlass.*, instanceMirrorKlass.*, instanceRefKlass.* |
| Array 体系 | arrayKlass.*, objArrayKlass.*, typeArrayKlass.*, arrayOop.* |

### P3 — 孤立 (1-2 文件)
| KP | 文件 |
|----|------|
| OopHandle + WeakHandle | oopHandle.*, weakHandle.* |
| Symbol | symbol.* |
| Annotations + Field | annotations.*, fieldInfo.hpp, fieldStreams.hpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (5 KP)
| KP | 为什么 🔴 |
|----|---------|
| markOop 5-in-1 编码 | 32/64-bit 中同时存 hash/age/biasedLock/lockState/GCbits — 5 种状态共享同一 word。这是对象头空间极致压缩——每个 Java 对象第一 word 都是 mark word |
| Klass + vtable 层次 | 虚方法分发的 C++ 表示——vtable 是方法地址表, itable 是接口方法表。一虚方法调用: oop→klass→vtable[offset]→方法地址 |
| Access API (GC Barrier) | JDK11 引入——模板元编程实现 Barrier 装饰器——load/store 时自动插入 GC barrier。barrier 类型 (G1/Z/Shenandoah) 编译期确定——零运行时开销 |
| ConstantPool + cpCache | 符号引用→直接引用的解析缓存——同一个常量池条目多次解析后只做一次 klass loading+link |
| Method + MethodData (JIT profiler) | methodData 是 JIT 的"训练数据"——branch/jump/call 的热度计数决定 C1/C2 编译阈值 |

### 🟡 Working — 有设计但非核心 (5 KP)
| KP | 说明 |
|----|------|
| instanceKlass 字段/方法表 | 类加载后的运行时元数据结构 |
| InstanceRefKlass Reference 入队 | GC 的 Soft/Weak/Phantom Reference 特殊处理逻辑 |
| OopHandle + WeakHandle | JNIHandle 的替代——GC 安全引用 |
| Array 对象布局 | 数组的内存布局和访问 |
| Symbol intern | 全局唯一符号表 |

### 🟢 Surface — 了解即可 (5 KP)
| KP | 说明 |
|----|------|
| instanceMirrorKlass (Class 对象) | java.lang.Class 的 Klass |
| instanceClassLoaderKlass | ClassLoader oop |
| Annotations + Field | 注解和字段元数据 |
| Metadata | Method/Klass 基类 |
| verifyOopClosure | DEBUG only |

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: markOop + oopDesc — 无前置(对象物理表示)
  ├─ B: Klass 层次 + vtable — 依赖 A (知道对象头后才能理解 Klass*)
  │    ├─ C: InstanceKlass + 子类型 — 依赖 B
  │    └─ D: ArrayKlass + Array — 依赖 B
  ├─ E: ConstantPool + cpCache — 依赖 B (常量池属于 Klass)
  │    └─ F: Method + MethodData — 依赖 E (方法引用需常量池解析)
  ├─ G: Access API (GC Barrier) — 依赖 A (Barrier 操作对象)
  └─ H: 辅助 (Symbol/OopHandle/Annotations)
```

### 教学顺序

```
1. 对象是什么 — markOop + oopDesc (物理头)
2. 类是什么 — Klass + vtable + InstanceKlass 层次
3. 数组是什么 — ArrayKlass + ArrayOop
4. 常量池 + 方法 — ConstantPool + cpCache + Method + profiling
5. GC 怎么看到对象 — Access API (Barrier) + OopHandle/WeakHandle
6. 辅助 — Symbol/Annotations/Field
```

### 文章拆分建议

6 篇（巨型域 38,424 行）:

- **01-markoop-oopdesc.md** — markOop 5-in-1 编码 + oopDesc 物理头
- **02-klass-hierarchy.md** — Klass 层次 + vtable/itable
- **03-instanceklass-arrayklass.md** — InstanceKlass 体系 + ArrayKlass 体系
- **04-constantpool-method.md** — ConstantPool+cpCache + Method+MethodData+profiling
- **05-access-api-barrier.md** — Access API (GC Barrier) + OopHandle/WeakHandle
- **06-symbol-annotations-aux.md** — Symbol + Annotations + Field + 辅助
