# 04. SystemDictionary — 类的"全球电话号码本"

> 🔴 Deep | 15 KP 中的 1 个核心机制
> 读者处境: `new String()`——JVM 去哪找 String 类？不是 classpath 扫描——是 SystemDictionary 的 hashtable O(1) lookup。

### 1. SystemDictionary — 全局类解析

场景: `new #2`——#2=CONSTANT_Class, name="java/lang/String", loader=Bootstrap。JVM: "我加载过 String 吗？"——`SystemDictionary::resolve_instance_class_or_null(Symbol* name, Handle class_loader, TRAPS)`。

**resolve_instance_class_or_null** (`systemDictionary.cpp:200-800`):
- Step 1: `dictionary()->find(loader, name)` → O(1) hashtable lookup→如果找到→return Klass*
- Step 2: 如果未找到→`load_instance_class(name, loader, THREAD)`→ClassLoader::load_classfile→ClassFileParser→InstanceKlass
- Step 3: `define_instance_class(klass, THREAD)` → 1) check ClassLoader constraints→2) allocate KlassID→3) `dictionary()->add_klass(name, loader, klass)`→4) update ClassLoaderData
- [C++: ClassLoader 约束——类 A loaded by L1→A 的常量池引用类 B。如果 L1 加载 B 同时 L2 也加载 B——两个 B 是不同的类。SystemDictionary 检测: 如果 B 已经在另一个 loader 下→不是 constraint 违反——约束只防止**同一 loader 下同名不同版本**]
- [JVM Spec: §5.3 Creation and Loading — 类加载的第 1 阶段 (loading)→第 2 阶段 (linking→verify+prepare+resolve)→第 3 阶段 (initializing)]

**constraints 机制** (`systemDictionary.cpp:900-1200`):
- `check_constraints(name, loader, klass)`: 检查是否有其他 loader 已经用同名加载了不同的类→如果同名且定义加载器不同→不是约束违反 (这是类隔离——由 per-loader dictionary 保证)
- 真正的约束: 同一 loader 下同名但来自不同 .class 文件 (不同版本 jar conflict)→`LinkageError`

### 2. Dictionary — per-ClassLoader

**Dictionary::find** (`dictionary.cpp:50-200`):
- `find(loader, class_name)`: `Hashtable<Symbol*, Klass*>`→key=class_name, value=Klass*
- per loader: 每个 ClassLoader 有自己的 Dictionary——加载的类隔离保证
- [C++: Dictionary 的 ProtectionDomainEntry——每个 entry 绑定 ProtectionDomain——`SystemDictionary::validate_protection_domain()`→check permission。ProtectionDomain 来自 CodeSource (文件路径+签名证书)]

---

### 核心悬念

**"同一个 `java/lang/String`——Bootstrap loader 下是 `String`——自定义 loader 下不是同一个类。"** — SystemDictionary + per-loader Dictionary 实现 Java 的类型隔离和类版本控制。下一个: ClassLoader——双亲委派。

> → [05-classloader-hierarchy.md](05-classloader-hierarchy.md)
