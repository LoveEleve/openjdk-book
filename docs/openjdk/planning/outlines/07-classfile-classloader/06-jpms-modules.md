# 06. Modules (JPMS) — Java 9 的模块化革命

> 🟡 Working | 15 KP 中的 1 个核心机制
> 读者处境: Java 8 以前——`public class` 对所有人可见。Java 9+——除非 `exports`——不可见。这是怎么实现的？

### 1. ModuleEntry + PackageEntry

场景: `module java.base { exports java.lang; }`——module-info.class→ClassFileParser→`ModuleEntry` 对象→模块图。非导出包的 `public class`——外部模块无法访问。

**ModuleEntry** (`moduleEntry.hpp:40-100`):
- `_name`: module 名 (Symbol*)
- `_reads`: 可读模块列表 (`Array<ModuleEntry*>`)
- `_exports`: `Array<PackageEntry*>`——被导出的包
- `_uses`: 服务使用 (`Array<Klass*>`——`ServiceLoader` 发现的服务接口)
- [JVM Spec: §5.3.6 Modules and Layers — ModuleLayer 嵌套+模块图。Boot layer 是根→java.base 在最底层]

**PackageEntry 导出控制** (`packageEntry.hpp` + `modules.cpp:250-450`):
- `PackageEntry::is_exported_to(ModuleEntry* m)`: 检查此包是否对模块 m 导出
- Qualified export: `exports com.foo.internal to com.foo.tests`——只对特定模块——其他模块 `IllegalAccessError`
- Unqualified export: `exports com.foo.api`——对所有模块
- [C++: `--add-exports java.base/sun.misc=ALL-UNNAMED`——JVM option 覆盖导出——JDK 内部 API 的唯一访问途径。启动时解析→`ModuleEntry::set_has_default_read_edges()`→add to _reads]

### 2. Modules 与 ClassLoader

**ModuleLayer + ClassLoader**:
- 模块图在 ClassLoader 之上——一个 ClassLoader 可加载多个模块——但一个模块**不能**被多个 ClassLoader 加载
- [C++: `ModuleEntry::can_read(ModuleEntry* m)`——检查 `_reads` 列表。类加载时 check: 被引用类所在的 module→当前 module 的 can_read→否→IllegalAccessError。ClassLoader 的可见性 (parent delegation) 先被 module 的可读性过滤]

---

### 核心悬念

**"`public class`——Java 9 以后不一定对外部可见。ModuleEntry + PackageEntry 在 ClassLoader 之上加了一层模块访问控制。"** — `--add-exports` 是 JDK 内部 API 的唯一访问途径。下一篇: javaClasses——核心类镜像。

> → [07-javaclasses-core-mirrors.md](07-javaclasses-core-mirrors.md)
