# 域 07: ClassFile & ClassLoader — 知识规划

> 源码路径: hotspot/share/classfile/ + runtime/handles.* + runtime/signature.* + runtime/fieldDescriptor.* + runtime/fieldType.* | 源码量: ~82 文件 / ~48,000 行 | 🔴 巨型域
> 拆 6-8 篇独立知识规划

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| classFileParser.hpp.cpp (6463行) | **ClassFileParser — .class 二进制解析器**: 魔数校验/版本号/magic/常量池/字段/方法/属性/注解——完整的 ClassFile 结构解析→填充 InstanceKlass | High |
| classLoader.hpp.inline.hpp.cpp | **ClassLoader — 类加载入口**: load_classfile/load_class/loadZipJar——Bootstrap/Platform/App ClassLoader 层次——双亲委派——类路径扫描 | High |
| classLoaderData.hpp.inline.hpp.cpp | **ClassLoaderData — 每个 ClassLoader 的元数据**: Klass/Method/Symbol 的 GC 管理, CLD 链表, metaspace 绑定 | High |
| systemDictionary.hpp.cpp | **SystemDictionary — 全局类字典**: 已加载类的 hashtable, 类解析(define_class+load), ClassLoader 约束 | High |
| dictionary.hpp.inline.hpp.cpp | **Dictionary — per-ClassLoader 的类字典**: 每个 ClassLoader 加载的类, protection domain cache, 解析多态 | High |
| klassFactory.hpp.cpp | **KlassFactory — Klass 工厂**: 从 ClassFileStream 创建 InstanceKlass/ArrayKlass, 调用 ClassFileParser | High |
| verifier.hpp.cpp | **Verifier — 字节码验证**: StackMapTable 验证/类型安全/分支目标/异常处理器——ClassFile 语法+语义验证 | High |
| stackMapTable.hpp.cpp + stackMapFrame.hpp.cpp | **StackMapTable — 类型状态验证**: Java 6+ 类型检查, verification type 推断, 前后一致性 | High |
| symbolTable.hpp.cpp | **SymbolTable — 全局符号 intern**: 线程安全 hashtable, refcount, rehash——被常量池解析/类名/方法名引用 | High |
| stringTable.hpp.cpp | **StringTable — 全局字符串 intern**: `String.intern()` 实现, GC 安全, hashtable + oop storage | High |
| javaClasses.hpp.cpp (4586行) | **javaClasses — Java 核心类镜像**: java.lang.String/Class/Thread/ClassLoader/System 等核心类的 JVM 内部表示 | High |
| moduleEntry.hpp.cpp + modules.hpp.cpp + packageEntry.hpp.cpp | **Modules — JPMS 模块系统**: ModuleEntry/PackageEntry, 模块图, 可读性, 导出包, 服务——Java 9+ | High |
| classLoaderExt.hpp.cpp | **ClassLoaderExt — 扩展类加载**: AppClassLoader 扩展, 自定义路径, JAR 索引 | Medium |
| classLoaderStats.hpp.cpp + classLoaderHierarchyDCmd.hpp.cpp | **ClassLoaderStats — 诊断**: ClassLoader 层次统计, jcmd 支持, 类加载计数 | Medium |
| defaultMethods.hpp.cpp | **DefaultMethods — 接口默认方法**: Java 8+ 默认方法的 vtable/itable 冲突解决和分配 | Medium |

*15 个知识点*

## 02 聚合

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| ClassFileParser 解析→Klass 创建 | classFileParser.*, klassFactory.*, instanceKlass.*, constantPool.*, javaClasses.* |
| Symbol intern + SystemDictionary | symbolTable.*, systemDictionary.*, dictionary.*, classLoader.*, javaClasses.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| Verifier 验证 | verifier.*, stackMapTable.*, stackMapFrame.*, classFileParser.* |
| ClassLoader 层次 | classLoader.*, classLoaderData.*, classLoaderExt.* |
| Modules (JPMS) | moduleEntry.*, modules.*, packageEntry.*, classFileParser.* |
| StringTable intern | stringTable.*, javaClasses.* |

### P3 — 孤立 (1-2 文件)
| KP | 文件 |
|----|------|
| DefaultMethods | defaultMethods.* |
| ClassLoader diagnostics | classLoaderStats.*, classLoaderHierarchyDCmd.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (5 KP)
| KP | 为什么 🔴 |
|----|---------|
| ClassFileParser 解析 | 6463 行——JVM 最大的单个文件之一。解析 ClassFile 的每个 section (magic/version/cp/fields/methods/attributes)→填充 InstanceKlass。性能关键: 启动时解析数百个核心类 |
| SystemDictionary | 全局类解析——同一个全限定名在不同 ClassLoader 中可以是不同类。ClassLoader 约束 + dictionary per loader = Java 的类型安全基础 |
| Verifier + StackMapTable | 字节码验证——类型安全/分支目标/异常handler。StackMapTable 是 Java 6+ 的类型状态验证——将验证从 inference 改为 checking |
| SymbolTable + StringTable | 两个独立的 intern 表——Symbol (UTF-8, Metaspace) vs String (OOP, Heap)。String.intern() 是 JVM 层面操作, 非 Java 实现 |
| Modules (JPMS) | 模块图/可读性/导出包——Java 9 的访问控制扩展到模块级。ClassLoader 的传统可见性被模块层覆盖 |

### 🟡 Working — 有设计但非核心 (5 KP)
| KP | 说明 |
|----|------|
| ClassLoader 层次 + 双亲委派 | Bootstrap→Platform→App 三层。双亲委派——先问父类——加载隔离和保护 |
| ClassLoaderData GC 管理 | CLD 控制加载的 Klass/Method 的 GC 生命周期 |
| javaClasses — 核心类镜像 | String/Class/Thread 的 JVM 内部表示——字段 offset、方法访问优化 |
| DefaultMethods | Java 8+ 接口默认方法——冲突解决 (class 优先/最具体接口) |
| ClassLoader diagnostics | jcmd 类加载统计/层次——诊断工具 |

### 🟢 Surface — 了解即可 (5 KP)
| KP | 说明 |
|----|------|
| KlassFactory | 薄包装——调用 ClassFileParser |
| Dictionary per-loader | StandardDictionary 实现 |
| classLoaderExt | AppClassLoader 的扩展入口 |
| packageEntry | 包级别的访问控制 |

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: ClassFileParser — 无前置(.class 数据→解析开始)
  ├─ B: Verifier + StackMapTable — 依赖 A(解析后验证)
  ├─ C: SymbolTable + StringTable — 依赖 A(常量池产生符号)
  └─ D: SystemDictionary + Dictionary — 依赖 A+C(类名 symbol→字典查找)
       ├─ E: ClassLoader + CLD — 依赖 D(loader 是 dictionary 的 key)
       │    └─ F: Modules (JPMS) — 依赖 E(模块在 ClassLoader 之上)
       └─ G: javaClasses — 依赖 D+E(核心类已加载后建镜像)
```

### 教学顺序

```
1. ClassFile 解析 — 二进制→InstanceKlass (A)
2. 字节码验证 — Verifier + StackMapTable (B)
3. Symbol + String intern (C)
4. 类字典 + 解析 — SystemDictionary + Dictionary (D)
5. ClassLoader + 双亲委派 (E)
6. Modules 模块系统 (F)
7. javaClasses 核心类镜像 (G)
```

### 文章拆分建议

7 篇（巨型域 46,169 行）:

- **01-classfile-parser.md** — ClassFileParser 解析全流程
- **02-verifier-stackmap.md** — Verifier + StackMapTable 类型验证
- **03-symbol-string-table.md** — SymbolTable + StringTable intern
- **04-system-dictionary.md** — SystemDictionary + Dictionary + 类解析
- **05-classloader-hierarchy.md** — ClassLoader 双亲委派 + ClassLoaderData
- **06-jpms-modules.md** — Modules 模块系统 (JPMS)
- **07-javaclasses-core-mirrors.md** — javaClasses 核心类镜像
