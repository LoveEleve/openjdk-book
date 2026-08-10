# 域 07: ClassFile & ClassLoader — 全视角提问验证

> 15 KP / 🔴5 + 🟡5 + 🟢5 | ~82 文件/~48,000行 | 拆 7 篇文章

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | ClassFileParser 的 parseClassFile 怎么从 4B magic 走到 InstanceKlass？ | ✅ 01 §1 |
| D2 | StackMapTable 的 frame_type 编码——same_frame vs full_frame 的区别？ | ✅ 02 §2 |
| D3 | SystemDictionary::resolve 的完整路径——lookup→load→define→return？ | ✅ 04 §1 |

## 维度 2: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | 双亲委派——为什么先问父 loader 而不是自己直接加载？ | ✅ 05 §1 |
| A2 | Java 9 模块系统和 ClassLoader 有什么不同？模块如何在 ClassLoader 之上加访问控制？ | ✅ 06 §1-2 |
| A3 | String.intern() 和 Symbol intern 的区别——为什么需要两个独立的表？ | ✅ 03 §1-2 |

## 维度 3: 学生

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| L1 | javac 生成的 .class 文件和 JVM 加载的 Class 对象有什么关系？ | ✅ 01 §1 |
| L2 | 为什么同一个 String 存两次——分别在哪？ | ✅ 03 §2 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| 学生 | 2 | 2 | ✅ |
| **合计** | **8** | **8** | ✅ |
