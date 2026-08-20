# 域 04: 反射与注解 — 知识规划

> 源码路径: java.base/share/classes/java/lang/Class.java(4,032 行) + java/lang/reflect/(33 文件) + java/lang/annotation/(13 文件) + jdk/internal/reflect/(71 文件) + sun/reflect/(annotation/generics/misc)
> 源码量: ~120 文件 / ~21,000 行 | 非巨型域
> 写作层: Layer 2(前置: 域 03 对象系统、07 类加载)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Class.java (4032) | **forName 加载**: forName(String)(312)→forName0 native;按类名触发类加载(initialize 标志控制是否初始化) | High |
| Class.java | **ReflectionData 缓存**: `private static class ReflectionData`(2941)+ SoftReference 缓存 declaredFields/methods/constructors;字段/方法数组的懒加载+快照 | High |
| Class.java | **成员获取**: getMethods(1899)/getDeclaredMethods(2304)/getDeclaredConstructors(2352)→native getDeclaredMethods0(3406);public 过滤与父类合并(Reflection.filterMethods,3166) | High |
| Class.java | **类型判断**: isInstance native(626)、isAssignableFrom、isPrimitive(708)、isInterface、getSuperclass | Medium |
| Class.java | **newInstance**: 传统构造路径(535),JDK11 走 getConstructor0+ConstructorAccessor | Medium |
| Class.java | **注解读取**: getAnnotation(3649)/getAnnotationsByType(3670)/getDeclaredAnnotation(3692)/getDeclaredAnnotations(3713)→AnnotationParser.parseAnnotations(3758) | High |
| Method.java (reflect) | **invoke 链路**: invoke(552)→methodAccessor(85,volatile)→acquireMethodAccessor(150 分享逻辑) | High |
| Field.java (reflect) | **字段访问**: fieldAccessor(81)/overrideFieldAccessor(83);get/set 走 FieldAccessor | High |
| Constructor.java | **newInstance 链路**: newInstance(475)→acquireConstructorAccessor(518) | High |
| AccessibleObject.java | **访问控制**: setAccessible(183)→setAccessible0(185,native 检查模块/包访问);JDK9+ 模块强封装 | High |
| Proxy.java (1126) | **动态代理**: Proxy.newProxyInstance → ProxyGenerator 生成字节码(ProxyGenerator.java 单独文件)→ defineClass | High |
| InvocationHandler.java (95) | **代理回调接口**: invoke(proxy, method, args) | Medium |
| jdk/internal/reflect/ | **MethodAccessor 体系**: MethodAccessorGenerator(39,generateMethod 68/generateConstructor 87,运行时生成字节码)、DelegatingMethodAccessorImpl(33,委托层)、NativeConstructorAccessorImpl(54,首次 native→升级生成)、Unsafe*FieldAccessorImpl(Unsafe 直读字段,避开 getter) | High |
| AnnotationParser.java (sun/reflect/annotation) | **注解字节解析**: parseAnnotations(65)→parseAnnotations2(111)→parseAnnotation2(121)——从 class 文件 annotation 字节流解析 | High |
| sun/reflect/generics | **泛型签名解析**: GenericSignatureFormatError 体系,签名→Type 树(ParameterizedType/TypeVariable) | Medium |
| java/lang/annotation/ (13) | **注解元模型**: Retention(策略)/Target(作用域)/Inherited(继承)/Repeatable(重复)/Documented/Native + Annotation 接口 | High |

*16 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 成员访问与 ReflectionData 缓存 | 5 (Class/Method/Field/Constructor/Executable) | 面试重头(反射慢的原因、缓存) |
| P1 | MethodAccessor 生成体系 | 10+ (jdk.internal.reflect 生成器/委托/native/Unsafe 族) | 面试"反射为什么慢"的完整答案;生产性能优化 |
| P1 | 动态代理 | 3 (Proxy/ProxyGenerator/InvocationHandler) | 面试必考(代理原理);框架核心(Spring AOP/MyBatis mapper) |
| P1 | 注解读取与解析 | 4 (Class/AnnotationParser/AnnotationSupport/annotation 元模型) | 面试高频(注解原理);框架核心(Spring 注解驱动) |
| P2 | 访问控制与模块 | 2 (AccessibleObject/ReflectUtil) | 面试偶尔(JDK9 模块封装、setAccessible 失败) |
| P2 | 泛型签名解析 | 5 (generics 树) | 面试低频;Type 体系(Spring 泛型注入) |
| P3 | Class 类型判断族 | 3 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | MethodAccessor 三层(委托/native/生成)与 invoke 链路 | 面试"反射为什么慢/怎么优化"必考;框架反射调用性能是核心问题 |
| 🔴 Deep | 动态代理生成 | 面试必考(JDK 代理 vs CGLIB);Spring AOP 基础 |
| 🔴 Deep | 注解读取链(AnnotationParser) | 面试常问(注解怎么被解析的);框架注解驱动机制 |
| 🟡 Working | ReflectionData 缓存 | 面试偶尔(反射结果缓存);生产(多次反射的优化) |
| 🟡 Working | 访问控制(模块/包) | JDK9+ 面试点(强封装、--add-opens) |
| 🟢 Surface | 泛型签名解析 | 面试低频;Type 树使用层 |
| 🟢 Surface | Class 类型判断族 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
Class(元数据入口) ←── ReflectionData 缓存(成员快照)
Class ──持有── Method/Field/Constructor(成员对象)
Method/Field/Constructor ──持有── Accessor(委托→native→生成)
AccessibleObject(访问控制) ←── Method/Field/Constructor/Executable 基类
AnnotationParser(字节解析) ←── Class 注解读取
Proxy ←── ProxyGenerator(字节码生成) + InvocationHandler(回调)
sun/reflect/generics(签名解析) ←── Type 体系
```

### 教学顺序与文章拆分(4 篇)

1. **Class 对象与成员获取** — forName 加载、ReflectionData 缓存、getMethods/getDeclaredFields 的 native 边界与过滤
2. **反射调用: MethodAccessor 体系与性能** — invoke 链路、三层 accessor(委托/native/字节码生成)、Unsafe 字段访问、"反射为什么慢"
3. **动态代理与访问控制** — Proxy 生成流程、ProxyGenerator 字节码、InvocationHandler;setAccessible 与模块封装
4. **注解体系** — 元模型(Retention/Target/Repeatable)、AnnotationParser 解析链、运行时注解读取、框架注解驱动原理

> 前置: 域 03(对象模型)、07(类加载,Class 对象来自加载)。跨层: 成员 native 方法(JVM JavaCalls);AnnotationParser 读取 class 文件注解属性(内部卷 07-classfile);Proxy 字节码生成与 ASM 对比(域外工具)
