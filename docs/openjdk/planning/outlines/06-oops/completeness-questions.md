# 域 06: OOPs — 全视角提问验证

> 15 KP / 🔴5 + 🟡5 + 🟢5 | 87 文件/38,424行 | 拆 6 篇文章

## 大纲文件对照

| 篇 | 文件 | 覆盖范围 |
|:--:|------|------|
| 1 | `01-markoop-oopdesc.md` | markOop 5-in-1 编码 + oopDesc + compressed oop |
| 2 | `02-klass-hierarchy.md` | Klass 层次 + vtable + InstanceKlass + itable |
| 3 | `03-instanceklass-arrayklass.md` | ArrayKlass + ObjArrayKlass + TypeArrayKlass + ArrayOop |
| 4 | `04-constantpool-method.md` | ConstantPool + cpCache + Method + MethodData profiling |
| 5 | `05-access-api-barrier.md` | Access API (GC Barrier) + OopHandle + WeakHandle |
| 6 | `06-symbol-annotations-aux.md` | Symbol + Annotations + Field + Metadata + CompiledICHolder |

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | markOop 的 5 种状态如何在同一个 64-bit 中编码——低 3 位 tag 怎么区分？ | ✅ 01 §1 |
| D2 | `oopDesc::klass()` 返回 Klass*——怎么保证不是野指针？ | ✅ 01 §2 |
| D3 | vtable 怎么在子类中继承+重写——override 方法怎么替换 vtable entry？ | ✅ 02 §1 |
| D4 | invokevirtual 和 invokeinterface 的物理路径差异？ | ✅ 02 §1 |

## 维度 2: 性能工程师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| P1 | Access API 的 Decorator 模板——编译期确定 barrier 类型——实际开销是多少？ | ✅ 05 §1 |
| P2 | compressed oop 的 encode/decode——shrq/shlq 各 1 cycle——但加 heap_base 的依赖链？ | ✅ 01 §2 |
| P3 | cpCache 把 invoke 从 ~100µs 降到 5ns——首次 call 的 class load 有多贵？ | ✅ 04 §1 |

## 维度 3: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | markOop 为什么选择 5-in-1 编码而不是 5 个独立的 word？ | ✅ 01 §1 |
| A2 | Klass 为什么有 ~20 种子类而不是统一用 InstanceKlass？ | ✅ 02 §2 |
| A3 | Access API 的 Decorator 为什么用模板而不是虚函数？ | ✅ 05 §1 |

## 维度 4: 学生

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| L1 | `new Object()` 创建时发生了什么——mark word 是怎么设置初始值的？ | ✅ 01 §1 |
| L2 | `int[]` 和 `String[]` 在 JVM 内部有什么区别？ | ✅ 03 §1 |
| L3 | Symbol 是什么——为什么省内存？ | ✅ 06 §1 |

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 4 | 4 | ✅ |
| 性能工程师 | 3 | 3 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| 学生 | 3 | 3 | ✅ |
| **合计** | **13** | **13** | ✅ |

> **13/13 全覆盖。** 无待修复项。
