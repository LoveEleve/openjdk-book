# 15-c2-compiler/08-c2-library-calls 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 为什么在 Parse 期接管 intrinsic 方法语义，以及 String/Math/Unsafe/Thread/System intrinsic 如何仍回到统一 Ideal Graph 后端

## 1. 核心困惑

**为什么有些 Java/native 方法根本不按普通调用编？Intrinsic 到底替换掉了什么？它是更快的 call，还是直接改变了编译器理解这个方法的方式？**

## 2. 一句话顿悟

**intrinsic 不是给普通调用加速，而是 C2 在 Parse 期根据 `intrinsic_id()` 决定“这次不按原方法体或原生调用理解”，改由 `LibraryCallKit` 直接生成更适合优化和匹配的 Ideal Graph 子结构；生成之后仍回到 IGVN/CCP/EA/LoopOpts/Matcher/RA/Output 统一管线。**

## 3. 结构

1. 开场：为什么有些方法不按普通调用编
2. 两个误解：更快的普通调用 / 后期才识别 intrinsic
3. `intrinsic_id` → `LibraryCallKit`
4. `try_to_inline` 语义分发器
5. String / Math / Unsafe / Thread / System 典型族
6. intrinsic 回到统一管线
7. 收网

## 4. 证据清单

- `src/hotspot/share/opto/compile.cpp:150-165`
- `src/hotspot/share/opto/library_call.cpp:349-408`
- `src/hotspot/share/opto/library_call.cpp:519-592`
- `src/hotspot/share/opto/library_call.cpp:1294-1325`
- `src/hotspot/share/opto/library_call.cpp:1873-1921`
- `src/hotspot/share/opto/library_call.cpp:2868-2912`

## 5. 完成后 review

- 能否复述 intrinsic 是 Parse 期语义接管
- 是否讲清 intrinsic 仍回到统一后端管线
- 是否覆盖 String/Math/Unsafe/Thread/System 典型差异
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验