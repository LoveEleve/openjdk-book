# 域 29: MethodHandles — 知识规划

> 源码: hotspot/share/prims/methodHandles.* + cpu/x86/methodHandles_x86.* | 4文件/2500行 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| methodHandles.hpp/cpp | **MethodHandles — invokeExact/invoke**: MH 调用链(methodHandle→LambdaForm→compiled entry), resolve_invoke, MethodHandle 适配器(asType/asCollector/asSpreader/guardWithTest), LambdaForm compilation to nmethod, MethodHandleNatives 注册 | High |
| cpu/x86/methodHandles_x86.hpp/cpp | **x86 MethodHandle stubs**: invokeExact/invoke adapter(ricochet frame setup), argument shuffling, MH adapter stubs(spread/collect/fold/insertArguments/permuteArguments), member_name resolution | High |

*2 知识点*

## 02 聚合 — P1/P2/P3

### P1
| KP | 出现文件 |
|----|---------|
| MethodHandle invoke + LambdaForm | methodHandles.*(share), cpu/x86/methodHandles_x86*(x86) |

### P2
| KP | 出现文件 |
|----|---------|
| Adapter 系统(asType/asCollector...) | methodHandles.cpp(java-side registration via MethodHandleNatives) |

### P3
无

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| MethodHandle invokeExact → LambdaForm → compiled entry | invokeExact 没有 JNI 过渡——MH 调用通过 ricochet frame(MethodHandle 专用调用帧)→argument shuffling→LambdaForm(字节码级的适配器)→C2/JIT 编译成 nmethod。非虚直接调用——不经过反射——>50x faster than java.lang.reflect。核心链路: Java code→invokeExact→method handle → member name→LambdaForm→JIT compiled entry |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| x86 Adapter Stubs | argument shuffling via ricochet frame, caller→callee adapter 转换 |

### 🟢 Surface
| KP | 说明 |
|----|------|
| MH 适配器注册 | Java-side via MethodHandleNatives.registerNatives |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | MethodHandle invoke 链路 | "invokeExact 怎么做到 50x faster than reflection？" |
| 2 | x86 Adapter stubs | "ricochet frame 怎么传递参数？argument shuffling 怎么实现？" |
