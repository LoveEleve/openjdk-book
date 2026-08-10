# 域 30: JVM Entry Points — 知识规划

> 源码: prims/jvm.* + nativeLookup.* + stackwalk.* + runtime/javaCalls.* + reflection.* + share/include/jvm.h | 17文件 | 🟡 大域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jvm.h (1342行) + jvm.cpp | **JVM_* Entry Points**: ~200 JVM_* 函数(JVM_StartThread/JVM_CurrentTimeMillis/JVM_GetSystemPackage等), JDK侧通过 `JVM_` 前缀调用的原生入口, JVM_DefineClass/JVM_FindLoadedClass等 | High |
| javaCalls.hpp/cpp | **JavaCalls — C++→Java 调用桥**: call_virtual/call_static/call_special, JavaCallArguments(打包参数), JavaCallWrapper(TRAPS setup, thread state transition), invoke Java method from C++ | High |
| nativeLookup.hpp/cpp | **NativeLookup — native方法查找**: lookup(JNINativeMethod table or java_lang_ClassLoader), native_function_lookup, JNI_OnLoad/JNI_OnUnload support, register_native_methods | High |
| reflection.hpp/cpp + reflectionUtils.hpp/cpp | **Reflection — java.lang.reflect 实现**: getCallerClass, getDeclaredMethods/Fields/Constructors, invoke(Method), newInstance(Constructor), Field get/set。内部实现用 Unsafe 底层访问 | Medium |
| stackwalk.hpp/cpp | **StackWalk — JVM_GetStackTrace 实现**: StackFrameStream fill → StackFrameInfo(bci, method), filter reflection/MH frames, JVM_GetCallerClass | Medium |
| perf.cpp + jvm_misc.hpp | **PerfData 入口**: JVM_GetManagement support, miscellaneous JVM utils | Low |

*6 知识点*

## 02 聚合 — P1/P2/P3

### P1
| KP | 出现文件 |
|----|---------|
| JVM_* Entry Points (JDK→JVM bridge) | jvm.cpp, jvm.h, javaClasses.hpp(Java层类对应) |

### P2
| KP | 出现文件 |
|----|---------|
| JavaCalls (C++→Java) | javaCalls.*, jvm.cpp(callsites), jni.cpp(相关) |
| Reflection (java.lang.reflect) | reflection.*, reflectionUtils.*, jvm.cpp(JVM_* reflection helpers) |

### P3
| KP | 文件 |
|----|------|
| StackWalk | stackwalk.* |
| NativeLookup | nativeLookup.* |

## 03 深度分类

### 🔴 Deep (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| JVM_* Entry Points + jvm.h 接口 | JDK 和 JVM 的唯一桥梁——所有 `System.currentTimeMillis()` / `Thread.start()` 最终都通过 JVM_* 函数进入 JVM。jvm.h 声明了全部 ~200 个 JVM_* 函数——这是 JDK 编译时链接的公共接口。每个新 JDK 版本可能添加新的 JVM_* 入口 |
| JavaCalls — C++ 调用 Java 方法 | JVM 最常用的向下调用桥——GC/Deopt/JVMTI/JNI 都会用 JavaCalls 从 C++ 调 Java 方法。call_static(method, args, THREAD) → ThreadInVMfromJava(状态切换) → JavaCallWrapper(setup)→method invocation→return value。支持 with result+without result+with exception 三种调用模式 |

### 🟡 Working (2 KP)
| KP | 说明 | 为什么 🟡 |
|----|------|------|
| Reflection 实现 | getCallerClass + invoke + newInstance — java.lang.reflect 的 JVM 侧支持 | 是 thin wrapper 于 JavaCalls + Field access——自身无独立复杂逻辑 |
| StackWalk | JVM_GetStackTrace + GetCallerClass——用 vframeStream(域24)遍历栈 | 是 vframeStream 的 consumer——逻辑主要在于 frame filter |

### 🟢 Surface (2 KP)
| KP | 说明 |
|----|------|
| NativeLookup | JNI native 方法查找——thin wrapper on JNI function table |
| PerfData + jvm_misc | Management support + utils |

## 04 聚类 — 3篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | JVM Entry Points | "`System.currentTimeMillis()` 怎么进入 JVM？" |
| 2 | JavaCalls + NativeLookup | "C++ 怎么调用 Java 方法？native 方法怎么找到？" |
| 3 | Reflection + StackWalk | "`Method.invoke()` 在 JVM 里怎么实现？" |
