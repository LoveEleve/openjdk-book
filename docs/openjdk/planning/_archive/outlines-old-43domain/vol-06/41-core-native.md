# Core Native (libjava.so) — 文章大纲

> vol-06 · 域 41 · 🟡 B | JDK Native | 基于 Pass 0+1
> Pass 1 产出：7 基本元素 / 5 标记问题
>
> **→ 从 ZIP/JIMAGE**：字节读完了——但 Java 程序的每一秒都在调 `Object.hashCode`/`System.identityHashCode`/`String.intern`。这些 native 方法在 libjava.so 中——每个只有 2-5 行 C 代码，却是 Java 运行时最高的调用频率。

## 概念依赖

先修：OOPs（markOop hash 位）、StringTable（`String.intern` 的内部化）、JNI（JNI 函数注册机制）。

## 叙事计划

**开篇场景**：`map.put(key, value)` → `key.hashCode()` → `Object.hashCode()` → native → `Object.c:43` 的函数指针表 → `JVM_IHashCode` → 读 `markOop` hash 位。每秒数十亿次调用——每次只有 2 条 C 指令。为什么这么快？因为走了 JVM 内建快速通道。

**第一层：Object.c 的函数指针表——"一次注册，永远直接跳"**

`Object.c:43`：
```c
{"hashCode", "()I", (void *)&JVM_IHashCode},
```
`registerNatives`(`:51`) 在 JNI 初始化时一次性注册所有 native 方法——Java 调 `Object.hashCode()` 时 JVM 直接 `jmp` 到 `JVM_IHashCode`——不经过 `JNIEnv->CallVoidMethod` 的层层包装。每个 native 方法手动维护指针表——代价是一次性的维护开销。

**第二层：五个核心 native 方法**

- `System.identityHashCode` → `System.c:54` → `JVM_IHashCode` → 读 `markOop` identity hash。关键：如果 mark word 被偏向锁占用（biased lock pattern），hash 需要从 `BiasedLocking::revoke_and_rebias` 中恢复——hashCode 和 Synchronization 有意外的深度耦合。

- `System.arraycopy` → **注意：不在 libjava.so 的 Array.c 中！** `System.arraycopy` 的 native 入口在 HotSpot `jvm.cpp` → `JVM_ArrayCopy` → `TypeArrayKlass::copy_array`/`ObjArrayKlass::copy_array` → `memmove` + card mark。Array.c 只含 `java.lang.reflect.Array` 的反射 get/set。

- `String.intern` → `String.c:30` → `JVM_InternString` → `StringTable::intern()`（域 17 详述）。2 行代码。

- `Throwable.fillInStackTrace` → `Throwable.c:47` → `JVM_FillInStackTrace` → 遍历整个栈帧链（method+BCI+line number）。Spring Boot 80 层栈 → ~1μs——这是异常昂贵的根因。返回值是 `this` 自身（`:44` 注释）——支持 `throw e.fillInStackTrace()` 链式调用。

- `System.initProperties` → `System.c:166` → `java_props_md.c` → 读 `/proc/version`/`/proc/self/exe`/`locale`/`LD_LIBRARY_PATH`。这是 JVM 启动中唯一读 `/proc` 的时刻——所有 Java 系统属性从这里来。

**第三层：jni_util.c + 平台层**

`jni_util.c` 提供 JNI 类型转换（`jstring→char*`）、异常检查、method ID 缓存——libjava 所有 native 方法共用。`unix/native/libjava/` 平台层含 `java_props_md.c`(系统属性)、`ProcessImpl_md.c`(fork+exec)、`io_util_md.c`(平台 I/O)。

## 核心悬念

**`Object.hashCode()` 到 `markOop` 只经过 2 条 C 指令——Object.c 的函数指针表让 JVM 直接跳转，跳过 JNI 的全部包装。但 hashCode 和偏向锁有超预期的耦合——了解这个耦合是理解"JVM 为什么废弃偏向锁(JDK15)"的关键。**

→ 下一域：memmove 极快——但 epoll Selector 怎么工作？NIO Network 篇。

## 预估

1 篇，3 层递进，1800-2400 行。
