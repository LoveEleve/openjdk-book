# 域 07: 类加载器与链接 — 知识规划

> 源码路径: java.base/share/classes/java/lang/ClassLoader.java(3,061 行) + jdk/internal/loader/(9 文件:BuiltinClassLoader/ClassLoaders/BootLoader/URLClassPath/Loader/Resource/ClassLoaderValue)
> 源码量: ~10 文件 / ~8,000 行 | 非巨型域
> 写作层: Layer 2(前置: 域 03 对象系统;反射域 04 的加载基础)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| ClassLoader.java (3061) | **双亲委派核心**: loadClass(String, boolean)(571): findLoadedClass(576)→parent.loadClass(581)→findClass(594);parent 字段(243,final) | High |
| ClassLoader.java | **findClass 契约**: findClass(723)默认抛 ClassNotFoundException——子类覆写点 | High |
| ClassLoader.java | **defineClass 链**: defineClass(byte[],off,len)(806)→defineClass2 native(1122);类文件字节→Class 对象的边界 | High |
| ClassLoader.java | **已加载查询**: findLoadedClass(1283)→findLoadedClass0 native(1289);类只能加载一次的保证 | Medium |
| ClassLoader.java | **构造与命名**: ClassLoader(String, ClassLoader)(435)、parent 指定(437);system/platform class loader 语义(157) | Medium |
| ClassLoader.java | **资源加载**: getResource(→parent 委派)/getResources/loadClass 的资源侧 | Medium |
| jdk/internal/loader/ClassLoaders.java | **内建三层**: BootClassLoader(111)/PlatformClassLoader(126)/AppClassLoader(151)——JDK11 替代 sun.misc.Launcher;getSystemClassLoader 返回 AppClassLoader | High |
| jdk/internal/loader/BuiltinClassLoader.java | **模块+类路径加载**: loadClass(576)/loadClassOrNull(590,委派父类后查模块/classpath)→findClassOnClassPathOrNull(533/566/621)→defineClass(680);模块化加载路径 | High |
| jdk/internal/loader/BootLoader.java | **启动加载器**: getBootstrapClassPath、模块图像(jimage)访问 | Medium |
| jdk/internal/loader/URLClassPath.java | **资源路径搜索**: findResource(291)/getResource(310);JarLoader(702,jar 索引/JarFile 缓存)/FileLoader(1205,目录);资源加载性能 | High |
| jdk/internal/loader/Loader/Resource | 资源封装: URL/字节/输入流 | Low |
| jdk/internal/loader/ClassLoaderValue | 类加载器键值缓存(类似 ThreadLocal,加载器维度) | Low |

*12 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 双亲委派模型(loadClass 三步骤) | 1 (ClassLoader) | 面试必考;框架自定义加载器基础 |
| P1 | 内建三层加载器 | 3 (ClassLoaders/BuiltinClassLoader/BootLoader) | 面试高频(三层职责、模块化影响);生产排查 ClassNotFound |
| P1 | defineClass 边界 | 1 (ClassLoader) | 面试常问(字节码→类) |
| P2 | URLClassPath 资源加载 | 1 (URLClassPath) | 生产(资源/SPI 加载原理) |
| P2 | 资源委派 | 1 (ClassLoader) | 面试偶尔(getResource 委派) |
| P3 | ClassLoaderValue/Resource/Loader | 3 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 双亲委派模型 | 面试必考(流程+为什么安全+怎么打破);框架(SPI/热部署/隔离) |
| 🔴 Deep | 内建三层加载器与模块化 | 面试高频(JDK9+ 变化、PlatformClassLoader 新增);生产(ClassNotFound/NoClassDefFound 排查) |
| 🟡 Working | defineClass 与字节码→类 | 面试常问(自定义加载器怎么写) |
| 🟡 Working | URLClassPath 资源搜索 | 生产(资源冲突排查) |
| 🟢 Surface | ClassLoaderValue/Loader | 使用层 |

## 04 聚类

### 依赖图(域内)
```
ClassLoader(基类,委派模型) ←── BuiltinClassLoader(内建实现) ←── BootClassLoader/PlatformClassLoader/AppClassLoader
BuiltinClassLoader ──→ URLClassPath(JarLoader/FileLoader 资源搜索)
ClassLoader(defineClass) ──→ VM 类定义(native)
BootLoader(启动加载器) ←── ClassLoaders 初始化
```

### 教学顺序与文章拆分(3 篇)

1. **双亲委派模型与加载流程** — loadClass 三步骤、findClass/defineClass 契约、自定义 ClassLoader 写法、findLoadedClass 语义
2. **JDK11 内建加载器体系** — Boot/Platform/App 三层、ClassLoaders 初始化、BuiltinClassLoader 的模块+classpath 双路径、getSystemClassLoader
3. **资源加载与打破委派** — URLClassPath(JarLoader/FileLoader)、getResource 委派、SPI 与线程上下文加载器、热部署/隔离思路

> 前置: 域 03、04(Class 对象与反射读取)。跨层: defineClass0/1 的 JVM 实现(内部卷 07-classfile-classloader);类初始化时机(域 04 forName 关联);模块系统(内部卷 06-jpms-modules)
