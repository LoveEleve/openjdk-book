# 17-threads/04-interface-support 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 interfaceSupport 如何用 RAII 守卫把状态切换、safepoint 检查、Handle 区协议与异常/挂起收尾绑定在每次进出 VM 的边界上

## 1. 核心困惑

**线程从 Java 进入 VM、从 VM 回 native、或者在 VM 里阻塞时，为什么不能手写几行 `set_thread_state()` 就完事？为什么 HotSpot 要把这件事包装成一组 RAII 守卫类？这些守卫到底在构造/析构时替我们补了哪些协议动作？**

## 2. 一句话顿悟

**interfaceSupport 的核心不是“省代码”，而是把状态切换、栈可 walk、safepoint 检查、Handle 区边界和异步异常/挂起收尾捆成不可漏的 RAII 协议。调用方只声明一个 `ThreadInVMfromNative`/`ThreadToNativeFromVM`/`ThreadBlockInVM`，真正的线程状态机三拍和收尾逻辑都在构造/析构里强制发生。**

## 3. 结构

1. 开场：每次进出 VM 都要付状态转换税
2. 两个误解：只是样板代码 / 手动 set state 就行
3. 守卫家族与四种方向
4. 出 VM / 进阻塞：为什么要 make_walkable
5. HandleMark / NoHandleMark 与入口宏
6. 自挂起与特殊退出条件为什么总在析构处理
7. 收网

## 4. 证据清单

- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:82-148`
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:185-337`
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:407-600`
- `src/hotspot/share/runtime/handles.hpp:273-310`
- `src/hotspot/share/runtime/handles.inline.hpp:107-112`
- `src/hotspot/share/runtime/thread.cpp:2415-2461`
- `src/hotspot/share/runtime/thread.cpp:2479`

## 5. 完成后 review

- 能否复述“RAII 把状态协议绑死在边界上”
- 是否讲清四种方向与两个变体守卫
- 是否讲清 `make_walkable` / `handle_special_runtime_exit_condition` 的位置
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验