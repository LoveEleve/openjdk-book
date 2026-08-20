# 01-agent-jvmti 重写规划

> 状态：正文已重写，deep review 修订中
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Agent_OnLoad/OnAttach + JVMTI 回调清单”重写成一篇围绕“同一个 native agent 如何适配 bootstrap 与 attach 两种 JVM 时机，并把能力、回调、通知和晚期 VM 设施分层接起来”的机制文章

## 1. 读者困惑

- 为什么 `-agentpath` 和运行期 attach 不能共用完全相同的启动时序？
- 为什么注册 callback 后还要单独开启 notification？
- 为什么 `Agent_OnAttach` 可以直接 run，而 `Agent_OnLoad` 要等 VMInit？
- `ready()` 为什么不能在所有路径一开始就调用？
- HotSpot/OpenJ9 的 capability 组合为什么不完全相同？
- 类重定义后 method ID 为什么还要重新维护？

## 2. 一句话顿悟

**async-profiler 把 bootstrap 与 attach 的共同部分收进 `VM::init`，但用 `attach` 时序开关区分“现在能不能碰 VMStructs/函数表”；能力声明、callback 注册、notification 启用和 `ready()` 晚期设施是四层不同动作，重定义 hook 则负责在 method ID 失效后按受影响类补建索引。**

## 3. 总图

```text
attach：Agent_OnAttach → VM::init(true) → ready → capabilities/callbacks/notifications → bind/IDs/events → run
bootstrap：Agent_OnLoad → VM::init(false) → capabilities/callbacks/notifications → VMInit → ready/IDs → conditional run
旁路：native app → VM::tryAttach → VM::init(true)
```

## 4. 版本与边界

- 当前源码实现；不把 capabilities 当成所有 JVM 都相同的规范保证。
- `_global_args._preloaded` 来自预加载路径；Agent_OnLoad 可能跳过再次 parse。
- `AddCapabilities`、`SetEventCallbacks`、多处 `SetEventNotificationMode` 的返回值当前没有在这里逐项检查。
- `ClassFileLoadHook` callback 注册不等于 notification 已开；Instrument start 时准备 target 后才启用。
- `ready()` 没有错误返回，不把它写成完整成功保证。
- redefine/retransform hook 只对成功调用后的受影响 class 重新加载 method IDs。

## 5. 结构大纲

### 第一节：同一个 agent，为什么要两套时序

bootstrap 等 VMInit，attach 可直接 run；预加载参数边界。

### 第二节：`VM::init` 铺四层线

ready、capabilities、callbacks、notifications 的顺序与边界。

### 第三节：回调注册不等于事件启用

基础 notifications、ObjectSampler/LockTracer、ClassFileLoadHook 的按需启停。

### 第四节：`ready()` 为什么是晚期设施

VMStructs、signal handlers、JVMTI function table 与重定义保护。

### 第五节：method ID 为什么要在重定义后补建

成功调用、受影响类逐个处理，不做全量重扫。

### 第六节：收网与旁路

VMInit delayed start、VM::tryAttach、AP-1/AP-2/AP-3 桥接。

## 6. 证据清单

- `src/vmEntry.cpp:226-309`
- `src/vmEntry.cpp:312-341`
- `src/vmEntry.cpp:344-359`
- `src/vmEntry.cpp:416-464`
- `src/vmEntry.cpp:467-517`
- `src/zInit.cpp:57-62`
- `src/instrument.cpp:1084-1110`

## 7. 完成后检查

1. 总图是否同时表达 bootstrap/attach 两条时序。
2. 是否明确 capability/callback/notification/ready 四层边界。
3. 是否写清 OpenJ9 capability 差异与当前返回值检查边界。
4. 是否说明 ClassFileLoadHook 按需启停。
5. 删除代码后主线是否仍成立，锚点、链接、结构标记和禁用词检查通过。
