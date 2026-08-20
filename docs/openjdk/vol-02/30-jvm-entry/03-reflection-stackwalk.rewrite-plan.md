# 30-jvm-entry/03-reflection-stackwalk 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 `Method.invoke` 的最后一跳（JVM_InvokeMethod → Reflection::invoke_method → invoke 五段）与栈遍历（JVM_GetCallerClass / StackWalker）的机制

## 1. 选题判断

现稿已有很强事实基础：
- `JVM_InvokeMethod` → `Reflection::invoke_method` → `invoke` 五段
- `JVM_GetCallerClass` + `security_next` 跳过三类内部帧
- `StackWalker` 分页取帧 + 隐藏帧双轨过滤

但现稿仍偏"反射调用一节 + GetCallerClass 一节 + StackWalker 一节"的机制并列。真正该打穿的读者困惑更集中：

**Java 侧 `Method.invoke(obj, args)` 的完整链路是什么？`JVM_InvokeMethod` 拿到参数后怎么解析、怎么打包、怎么调 JavaCalls？`JVM_GetCallerClass` 为什么能跳过 `Method.invoke` 的反射帧？StackWalker 的隐藏帧过滤到底是 hotspot 做还是 Java 侧做？**

## 2. 一句话顿悟

**`Method.invoke` 的最后一跳是 `JVM_InvokeMethod` → `Reflection::invoke_method`（slot 编号定位方法）→ `invoke` 五段（方法解析 → 参数个数 → 拆箱/扩宽/打包 → JavaCalls → InvocationTargetException 包装）。`JVM_GetCallerClass` 用 `security_next` 跳过三类内部帧后交出调用者类。StackWalker 隐藏帧**双轨过滤**：hotspot 滤 `@Hidden`（LambdaForm），Java 侧滤反射帧。**

## 3. 总图

```text
Method.invoke(obj, args)
  ↓ DelegatingMethodAccessorImpl
  ↓ NativeMethodAccessorImpl.invoke0 (native)
  ↓ JVM_InvokeMethod
  ↓ Reflection::invoke_method (slot 定位)
  ↓ invoke 五段
    1. 方法解析（klass/static/virtual/interface）
    2. 参数个数检查
    3. 拆箱 + 扩宽 + 打包进 JavaCallArguments
    4. JavaCalls::call
    5. InvocationTargetException 包装 / 装箱

JVM_GetCallerClass
  └─ security_next 跳过 reflect/MethodHandle/LambdaForm 帧

StackWalker
  ├─ 分页: fetchFirstBatch → JVM_CallStackWalk
  ├─ 续批: fetchNextBatch → JVM_MoreStackWalk
  └─ 过滤: hotspot 滤 @Hidden, Java 侧滤反射帧
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"Method.invoke 的完整链路"

目标约 1000 字。

- 从完整链路展开（Java → 委托 → native → JVM）
- 点出：反射调用不是一步到位的，Java 侧有 access check 体系
- 埋主线：JVM 侧的 invoke 五段

### 第二节：两个朴素方案为什么都不对

目标约 1200 字。

必须推演：
1. 每次反射调用都重新解析方法名（不，用 slot 编号直接定位）
2. 反射调用不做访问检查（Java 侧已做，JVM 侧只组装调用）

结论：
- slot 编号定位比名字解析快
- 访问检查在 Java 侧，JVM 侧只提供调用者身份

### 第三节：反射调用——JVM_InvokeMethod → invoke 五段

目标约 2500 字。

- `JVM_InvokeMethod`（jvm.cpp:3571-3593）
- `Reflection::invoke_method`（reflection.cpp:1257-1280）
- `invoke` 五段（:1072-1255）
- access check 在 Java 侧

### 第四节：JVM_GetCallerClass——谁是调用者

目标约 1800 字。

- `JVM_GetCallerClass`（jvm.cpp:706-742）
- `security_next` 跳过三类内部帧（reflect/MethodHandle/LambdaForm）
- `@CallerSensitive` 注解

### 第五节：StackWalker——分页取帧 + 双轨过滤

目标约 2200 字。

- `JVM_CallStackWalk`（jvm.cpp:552-578）
- `JVM_MoreStackWalk`（jvm.cpp:580-601）
- 隐藏帧过滤：hotspot 滤 `@Hidden`（stackwalk.cpp:123-137），Java 侧滤反射帧
- 分页自适应批大小

### 第六节：误解澄清与收网

目标约 1200 字。

## 5. 失败方案

1. 每次反射调用都重新解析方法名
2. 反射调用不做访问检查

## 6. 证据清单

- `src/hotspot/share/prims/jvm.cpp:3571-3593`：`JVM_InvokeMethod`
- `src/hotspot/share/prims/jvm.cpp:706-742`：`JVM_GetCallerClass`
- `src/hotspot/share/prims/jvm.cpp:552-578`：`JVM_CallStackWalk`
- `src/hotspot/share/prims/jvm.cpp:580-601`：`JVM_MoreStackWalk`
- `src/hotspot/share/runtime/reflection.cpp:1257-1280`：`invoke_method`
- `src/hotspot/share/runtime/reflection.cpp:1072-1255`：`invoke`
- `src/hotspot/share/runtime/stackwalk.cpp:332-360`：`StackWalk::walk`
- `src/hotspot/share/runtime/stackwalk.cpp:108-145`：`fill_in_frames`
- `src/hotspot/share/runtime/stackwalk.hpp:133-135`：`skip_hidden_frames`

## 7. 完成后 review

- 删除代码后，能否复述"JVM 侧的 invoke 五段"
- 是否讲清 security_next 跳过三类帧
- 是否讲清隐藏帧双轨过滤
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验