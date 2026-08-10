# 02. ricochet frame 怎么传参数？— x86 Adapter Stubs

> 🟡 Working | 1 KP 中的平台适配
> 读者处境: MH 调用时参数类型可能与 target method 不匹配——需要 adapter(asType/permuteArguments/spreadArguments)。这些 adapter 通过在 ricochet frame 中重新排列参数来实现。

### 1. "ricochet frame — MH 专用调用帧"

场景: MH 调用链中需要传递 call-site 参数→adapter 参数→target 参数。ricochet frame 是 MH 专用的栈帧格式——一层层传递自变量而不新建 Java frame。

**Ricochet frame 结构** (`cpu/x86/methodHandles_x86.cpp:40-200`):
```
method handle invocation frame:
  [caller args] [MethodHandle*] [MemberName*] [shuffled args for adapter]
  → adapter executes: shuffle args to callee format
  → callee frame: normal compiled/interpreter frame
```
- 源码: `methodHandles_x86.cpp:40-200` + `methodHandles_x86.hpp:30-100`
- 关键设计: Ricochet frame 不是标准 Java frame——它是 MH 的临时帧格式——参数按照 MH adapter chain 需要的格式排列。每一次 adapter hop 可能重排 args→然后转移到下一个。最终 frame 的格式是 callee method 的标准 calling convention
- [x86: rbp 在 ricochet frame 中指向特殊的 MethodHandle 标的帧头——包含 MethodHandle* + MemberName* + 下一个 adapter 的 target。每个 adapter 的参数可以通过 `mov reg,[rbp+offset]` 在帧中定位]

### 2. "argument shuffling — 参数重排"

场景: `mh.asType(newType)` → 需要 permute/collect/spread 参数→x86 adapter stub 逐参数 copy 到新位置。

**argument shuffle** (`methodHandles_x86.cpp:200-500`):
```
argument shuffling:
  1. 解析旧的参数位置(在 ricochet frame 中的 offset)
  2. 解析新的参数位置(在 callee frame 中的 location)
  3. 逐参数 copy via mov 指令:
     - 盒子拆封(boxed→unboxed): 读字段 + 加载到寄存器
     - 类型转换(int→long): sign extend via movsxd
     - 合并(spread/collect): 重新排列数组
  4. update frame: set next MethodHandle in chain
```
- 源码: `methodHandles_x86.cpp:200-500` + `methodHandles.hpp:180-250` adapter 注册
- [x86: argument shuffling 是纯 mov 序列——每个参数 2-3 条指令。没有分支、没有函数调用、没有 L1 miss——因为参数在 ricochet frame 中连续排列→L1 cache line hit 率极高。C2 可以进一步优化:如果 adapter chain 是已知的→compose 所有 shuffling into one→eliminate intermediate moves]

### 3. "adapter 类型"

**MH adapters** (`methodHandles.hpp:100-180`):
```
asType         → 类型转换(int→double)
permuteArguments → 参数重排
asCollector    → 收集 varargs→array
asSpreader     → 展开 array→varargs
guardWithTest  → if-guard(true→target1, false→target2)
filterReturn   → 返回值变换
```
- 源码: `methodHandles.hpp:100-180` adapter 类型声明 + `methodHandles.cpp:600-900` registration
- 每个 adapter 在 x86 stub 中有对应的 hand-written assembly 或 C2 generated code

---

### 核心悬念

**"x86 ricochet frame 用专用栈帧格式传递 MH 参数——argument shuffling 是纯 mov 序列(C2 可 compose 消除)。"** — 下一篇: 域30 JVM Entry Points。

> → 域30 JVM Entry Points
