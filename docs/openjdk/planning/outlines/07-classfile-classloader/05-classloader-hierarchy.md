# 05. ClassLoader — 双亲委派与三层加载

> 🟡 Working | 15 KP 中的 2 个机制
> 读者处境: `Class.forName("com.example.Foo")`——JVM 怎么知道去哪找 Foo.class？委托链。

### 1. 双亲委派 — Bootstrap → Platform → App

场景: App ClassLoader 收到加载 `java.lang.String` 的请求——自己加载？不——`parent.loadClass(name)`→Platform→再向上→Bootstrap——Bootstrap 在 rt.jar/modules 中找到 String→返回之前加载的 Klass*。

**三层 ClassLoader 层次** (`classLoader.cpp:100-500`):
- Bootstrap: C++ 实现 (不是 Java ClassLoader 实例)——parent=null——加载 rt.jar (`-Xbootclasspath/a`)
- Platform: 加载 jdk.* modules——`ClassLoaders::platformClassLoader()`
- App: 加载 classpath——`ClassLoaders::appClassLoader()`
- [C++: Bootstrap 是 C++ 函数—`ClassLoader::load_classfile()`——不是 Java `ClassLoader.loadClass()`。`findBootstrapClass()` 查 SystemDictionary (loaded classes)→如果无→`loadZipJar()` (扫描 JAR)→ClassFileParser]
- [JVM Spec: §5.3.3 Loading Using the Bootstrap Class Loader — Bootstrap loader 的搜索路径: `-Xbootclasspath/a` + 运行时 image (`lib/modules`)]

**双亲委派实现** (`classLoader.cpp:100-200`):
- `load_class(Symbol* name, TRAPS)`: 1) `find_loaded_class()`→2) `parent->load_class()`→3) `find_class()` (自己加载)
- 安全模型: 核心类 (java.lang.*) 必须由 Bootstrap 加载——不能被 App loader 加载——防止 `java.lang.String` 被替换为恶意版本

### 2. ClassLoaderData — 元数据生命周期

**CLD GC** (`classLoaderData.cpp:100-300`):
- 每个 ClassLoader 对应一个 CLD——管理该 loader 加载的全部 Klass/Method/Symbol
- `_klasses`: InstanceKlass 链表——GC roots 由此出发
- [C++: ClassLoader GC——ClassLoader 被回收→`ClassLoaderDataGraph::do_unloading()` 遍历 CLD 链表→清理死 CLD→`CLD::unload()`→释放所有 Klass/Method/Symbol→回收 Metaspace。`_keep_alive`: JNI reference to Java ClassLoader→防止 GC 过早回收]

---

### 核心悬念

**"为什么 `Class.forName("java.lang.String")` 不会从 App loader 加载？"** — 双亲委派——先问父 loader。Bootstrap 已加载 String→返回已有 Klass*。这是 Java 安全模型的基石——核心类不可替换。下一篇: Modules——Java 9 在 ClassLoader 之上加了模块访问控制。

> → [06-jpms-modules.md](06-jpms-modules.md)
