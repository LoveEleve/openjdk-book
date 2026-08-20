# 15-c2-compiler/08-c2-library-calls 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 intrinsic 为什么不是“更快的普通调用”，而是编译器在 Parse 期直接接管某些方法语义，用专用理想图子结构替换原始调用

## 1. 选题判断

现稿已经有较好的事实基础：
- `Compile::find_intrinsic`
- `LibraryCallKit::try_to_inline`
- String/Math/Unsafe/Thread/System 几类典型 intrinsic
- 与 StubRoutines、runtime call、Matcher 的衔接

但当前正文仍偏“按家族分类罗列能力”。真正该打穿的读者困惑应该更集中：

**为什么有些 Java 方法根本不会按“字节码 -> 普通调用 -> 后续优化”这条路走，而是在 Parse 期就被 C2 直接按语义接管？intrinsic 替换掉的到底是什么，换来的又不只是“更快一点的调用”吗？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**intrinsic 不是给普通调用加速，而是一次语义级接管：当 `find_intrinsic` 认出某个方法在受支持集合里，C2 就不再把它当成“要按原方法体或 native 调用去执行”的普通调用，而是直接在 Parse 期用 `LibraryCallKit` 生成更适合优化的理想图子结构。后面这批节点仍然回到同一套 IGVN/EA/Matcher/RA 管线，所以 intrinsic 真正改变的是“问题的表示方式”，不只是调用成本。**

## 3. 总图

```text
普通调用
  do_call -> call_generator -> 普通 CallNode / 递归 Parse

intrinsic 调用
  do_call -> find_intrinsic -> LibraryCallKit::try_to_inline
                                ├─ 成功：生成专用 Ideal 图子结构
                                └─ 失败：回退普通调用

之后统一进入
  IGVN / CCP / EA / LoopOpts / Matcher / RA / Output
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么有些方法根本不按普通调用编

目标约 1300 字。

- 从 `Math.sin` / `System.arraycopy` / `Unsafe.allocateInstance` 开场
- 点出：它们的区别不是“更快调用”，而是调用语义本身被换了
- 埋下主线：intrinsic = Parse 期语义接管

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. intrinsic 只是把 JNI/native/Java 调用做快一点
2. intrinsic 是优化后期才识别出来的特殊节点

结论：
- intrinsic 改写的是问题表示，不只是调用成本
- 它发生在 Parse/`do_call` 决策链上，而不是后期打补丁

### 第三节：机制——从 `intrinsic_id` 到 `LibraryCallKit`

目标约 2000 字。

- `Compile::find_intrinsic`
- lazy cache / `make_vm_intrinsic`
- `LibraryCallKit::try_to_inline` 的 switch 分发
- 成功/失败回退路径
- 讲清 intrinsic 与普通 call generator 的关系

### 第四节：String intrinsics——为什么字符串扫描适合“语义级替换”

目标约 2100 字。

- `inline_string_indexOf` / compareTo / equals
- `Matcher::match_rule_supported`
- 专用节点 vs 普通循环
- compact strings 的编码分派
- 说明 intrinsic 不是直接发 SIMD，而是先换成更适合匹配的图

### 第五节：Math intrinsics——为什么有些变成节点，有些仍然是 runtime_math

目标约 1900 字。

- `inline_math_native`
- dsin/dcos/dexp/dpow 走 runtime_math + StubRoutines/SharedRuntime
- sqrt/abs/ceil/floor 走 `Matcher::match_rule_supported`
- `pow(x,2.0)->x*x`
- 强调 “intrinsic != 总是一条机器指令”

### 第六节：Unsafe / Thread / System——为什么这些也是语义级接管

目标约 2200 字。

- `inline_unsafe_allocate`
- `generate_current_thread`
- `inline_native_time_funcs`
- 为什么 `allocateInstance`/`currentThread`/`nanoTime` 不适合按普通方法或普通 JNI 调用理解
- 统一回“接管语义”主线

### 第七节：intrinsic 不是后门——它仍然走统一优化/匹配/发码管线

目标约 1500 字。

- intrinsic 生成的仍是普通 Ideal 节点
- 后续照常进入 IGVN/EA/Matcher/RA
- 与 macro nodes、Runtime calls、StubRoutines 的边界
- 解释为什么这种设计能把 intrinsic 融进主优化链路

### 第八节：误解清单与收网

目标约 1200 字。

至少回答：
1. intrinsic 是否只是“更快的普通调用”
2. 所有 Math intrinsic 是否都直接变成单条机器指令
3. `System.nanoTime` 是否等于直接读 TSC
4. `Unsafe.allocateInstance` 是否只是绕过 `<init>` 这么简单
5. intrinsic 是否绕开后续优化/匹配/发码阶段

## 5. 失败方案必须写进正文

1. 把 intrinsic 理解成普通调用的微优化
2. 把 intrinsic 理解成优化后期才识别的特殊节点
3. 把所有 intrinsic 都理解成“直接一条机器指令”

## 6. 证据清单

- `share/opto/compile.cpp:150-166`：`find_intrinsic`
- `share/opto/library_call.cpp:519-608`：`LibraryCallKit::try_to_inline`
- `share/opto/library_call.cpp:1294-1334`：`inline_string_indexOf`
- `share/opto/library_call.cpp:1873-1942`：`inline_math_native`
- `share/opto/library_call.cpp:2868-2913`：`inline_unsafe_allocate` / `inline_native_time_funcs`
- `share/opto/library_call.cpp:1093-1100`：`generate_current_thread`
- `share/opto/library_call.cpp:771-773`：`nanoTime` / `allocateInstance` 分发

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前 intrinsic 实现
- 本篇聚焦“为什么/何时/如何接管语义”，不把每个 intrinsic 家族都扩成子专题
- StubRoutines / SharedRuntime 只在必要时点到，不深挖实现
- 某些 intrinsic 受平台与 CPU 特性门控，要明确这种边界

## 8. 完成后 review

- 删除代码后，能否复述“intrinsic 是 Parse 期的语义接管，而不是更快的普通调用”
- 是否把 String/Math/Unsafe/System 几类都收回到同一个主线问题上
- 是否明确 intrinsic 仍然走统一后续优化/匹配/发码管线
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
