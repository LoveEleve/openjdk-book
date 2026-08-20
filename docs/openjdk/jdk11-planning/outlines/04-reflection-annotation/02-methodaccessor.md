# 02. 反射调用 — MethodAccessor 三层体系与"反射为什么慢"

> 🔴 Deep | 域 04 反射与注解第 2 篇 | Layer 2
> 读者处境: 面试必问"反射为什么慢、怎么优化";生产框架(Spring/MyBatis)千万次反射调用——JVM 的膨胀机制(inflation)一次讲透。

### 1. "invoke 的完整链路？" — Delegating → Native → Generated 三层

场景: `method.invoke(obj, args)` 一行代码,JVM 实际走了几步?

- `Method.java:552` `invoke()` → checkAccess(`Method.java:558`)→ 读 volatile `methodAccessor`(`Method.java:562`)→ `ma.invoke(obj, args)`(566)
- 第一层: `DelegatingMethodAccessorImpl`(`jdk/internal/reflect/DelegatingMethodAccessorImpl.java:33`)— 纯转发,保持目标可替换
- 第二层: `NativeMethodAccessorImpl` — 走 **JNI native 调用**(首次使用)
- 第三层: `GeneratedMethodAccessor` — **运行时生成的字节码类**直接调用(无 JNI 边界)
- 关键设计 (斜体): *为什么要 Delegating 垫一层?为了"运行时换实现"——启动时 native 慢但生成快,热身后换成生成的字节码;委托层让切换对 Method.invoke 透明*
- [C++: JNI 调用边界(call_stub/JavaCalls,内部卷 27-jni);native 慢的根源: 参数 boxing 检查+JNI 封装]

### 2. "多少次要膨胀？" — inflationThreshold 与计数器

场景: 面试"反射多少次之后变快?"——阈值是多少?

- `jdk/internal/reflect/NativeMethodAccessorImpl.java:49` — `if (++numInvocations > ReflectionFactory.inflationThreshold())` → 触发生成
- `jdk/internal/reflect/ReflectionFactory.java:88` — `private static int inflationThreshold = 15;`
- 阈值可调: `-Dsun.reflect.inflationThreshold=N`(生产可调)
- 生成调用: `ReflectionFactory.java:189` `newMethodAccessor` — 默认 `new NativeMethodAccessorImpl`(211,预热 native 路径);设 `-Dsun.reflect.noInflation=true` 时直接 `generateMethod`(205-207,跳过 native 期)
- 关键设计 (斜体): *15 次的取舍: 反射调用次数少(native 可接受)vs 次数多(生成字节码摊薄成本);生成类只包含"本方法"——每次方法生成一个类,类加载本身有成本*
- `jdk/internal/reflect/MethodAccessorGenerator.java:39` — generateMethod(68)/generateConstructor(87)— 字节码组装(ConstantPool/ByteVector 手工构造 class 文件,类比 ASM)
- 面试点: "反射慢 vs 直接调用差多少?"——生成后差距小一个数量级内;真正慢的是参数 boxing、可见性检查、以及**不命中膨胀阈值前的 native 调用**

### 3. "字段访问也是生成的吗？" — FieldAccessor 与 Unsafe 直读

场景: Field.get/set 的性能与优化——字段访问的 accessor 体系

- `Field.java:81-83` — fieldAccessor/overrideFieldAccessor(两套: 默认与 setAccessible 后)
- 字段访问器两族(无字节码生成路径): `FieldAccessorImpl`(通用)vs `Unsafe*FieldAccessorImpl` 系列(30+ 文件,由 `UnsafeFieldAccessorFactory.newFieldAccessor` 创建,`jdk/internal/reflect/UnsafeFieldAccessorFactory.java:32`)— 用 **Unsafe 按偏移直读字段**,绕开可见性检查(这也是字段访问比方法调用快的原因)
- 关键设计 (斜体): *字段访问两条路: 生成字节码(慢启动快运行)vs Unsafe 偏移(启动快,但受模块强封装限制);setAccessible(true) 后走 override 分支,跳过检查——这就是"setAccessible 提高反射性能"的原因*
- [C++: 域 32 Unsafe(objectFieldOffset 机制)展开]

### 4. "invoke 的代价清单" — 反射性能全景

场景: 生产性能优化的完整认知——反射开销都花在哪

- ① 可见性检查(checkAccess: 调用者/类/模块)— **未 setAccessible 时**每次 invoke 都查(`Method.java:556` `if (!override)`)
- ② 参数 boxing/数组展开(Object[] args)
- ③ 方法分派: 生成前 native 边界,生成后字节码直接 call
- ④ 异常包装: InvocationTargetException
- 优化手段: 缓存 Method/Field 对象、setAccessible(true)、阈值调优、或改 MethodHandle(域外,invokedynamic 体系)
- 关键设计 (斜体): *框架的反射优化三板斧: 缓存成员对象(省对象创建)+ setAccessible(省检查)+ 批量调用摊薄膨胀成本——Spring 的 ResolvableType/MyBatis 的 MetaClass 都是这个思路*

---

### 核心悬念

反射能调用成员,还能**凭空创造类**——`Proxy.newProxyInstance` 生成 `$Proxy0` 字节码,让接口在运行时有了实现。Spring AOP 的秘密: 下一篇 动态代理与访问控制。

> → [03-proxy-access.md](03-proxy-access.md)
