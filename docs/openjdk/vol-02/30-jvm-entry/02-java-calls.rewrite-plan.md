# 30-jvm-entry/02-java-calls 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JVM 内部 C++ 侧怎么调 Java 方法——JavaCalls 的三个语义入口、参数怎么安全传（GC 安全）、调用瞬间线程状态怎么切，以及 NativeLookup 的名字生成与类加载器分流

## 1. 选题判断

现稿已有很强事实基础：
- `JavaCalls::call_virtual` / `call_special` / `call_static`
- `JavaCallArguments` 延迟解析 oop + `_value_state` 标记
- `call_helper` 十步执行管线
- `JavaCallWrapper` 状态切换与 handle 块切换
- `NativeLookup` 名字生成 + 类加载器分流

但现稿仍偏"三个入口一节 + 参数打包一节 + call_helper 十步一节 + NativeLookup 补全一节"的机制并列。真正该打穿的读者困惑更集中：

**JVM 内部 C++ 侧怎么调 Java 方法？参数怎么传（从打包到调用之间可能经历 GC，裸 oop 会悬空怎么办）？调用瞬间线程状态怎么从 VM 切回 Java？为什么 safepoint 里不能调 Java 代码？**

## 2. 一句话顿悟

**JavaCalls 是 JVM 内部调用 Java 的统一通道：先按语义解析出方法（call_virtual/special/static），参数只记 handle 地址（不记裸 oop），最后一刻才解析成 oop——因为从打包到调用之间可能经过 GC。调用瞬间 JavaCallWrapper 做状态切换 native→Java，call_stub 从解释器入口进（已编译则 i2c 跳转）。safepoint 里不能调 Java 代码，因为所有 Java 线程都停着，无人可执行。**

## 3. 总图

```text
JavaCalls::call_virtual/special/static
  ↓ LinkResolver 解析出 methodHandle
  ↓ JavaCalls::call → call_helper
    ├─ !is_at_safepoint 断言
    ├─ CheckJNICalls 参数校验
    ├─ compile_if_required (13 域)
    ├─ 入口 = from_interpreted_entry (i2c 跳编译)
    ├─ 栈守卫
    ├─ JavaCallWrapper (状态切换 + handle 块切换)
    ├─ StubRoutines::call_stub() 执行
    └─ vm_result 跨 GC 保存返回值

NativeLookup 补齐
  ├─ 名字生成: Java_ + 类名 + _ + 方法名 (+ __签名)
  └─ 查找: 特殊表 → dlsym(libjava) → ClassLoader.findNative → JVMTI 前缀
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"C++ 侧怎么调 Java 方法"

目标约 1000 字。

- 从"JVM 内部也要调 Java"切入（thread_entry、反射、GC 回调）
- 点出：参数要在 GC 中安全传递、状态要在调用瞬间切换
- 埋主线：JavaCalls 是统一通道，三个语义入口汇到一个 call_helper

### 第二节：两个朴素方案为什么都不对

目标约 1200 字。

必须推演：
1. 每次调用都先自己解析方法地址（不经过 LinkResolver，语义错误）
2. 参数打包时直接传裸 oop（GC 移动后悬空）

结论：
- LinkResolver 保证语义正确，JavaCallArguments 延迟解析保证 GC 安全

### 第三节：三个入口，一个底层

目标约 1800 字。

- `call_virtual`（javaCalls.cpp:188-201）
- `call_special`（:227）
- `call_static`（:262）
- 注意：没有 `call_dynamic`（大纲有误）
- 全部汇到 `call`(:337)→`call_helper`(:346)

### 第四节：参数打包——只记 handle，不碰裸 oop

目标约 1800 字。

- `JavaCallArguments`（javaCalls.hpp:76+）
- `_value_state` 四种标记（:158-163）
- `push_oop` 注释（:104-108）
- `parameters()` 最后一刻解析（javaCalls.cpp:505-517）

### 第五节：call_helper——十步执行管线

目标约 2500 字。

- 四断言（:349-352）
- 参数校验 / 空方法 / 编译触发
- 入口选择：`from_interpreted_entry`（:390）
- 栈守卫 + JavaCallWrapper（:420）
- `StubRoutines::call_stub()`（:442）
- 结果回写 + `vm_result`（:447-462）

### 第六节：NativeLookup 补全——名字生成与查找分流

目标约 2000 字。

- 名字生成三件套（nativeLookup.cpp:165-222）
- 查找顺序：特殊表 → dlsym(libjava) → ClassLoader.findNative → JVMTI 前缀
- 特殊表 7 条（:263）

### 第七节：误解澄清与收网

目标约 1200 字。

## 5. 失败方案

1. 每次调用自己解析方法地址
2. 参数打包时直接传裸 oop

## 6. 证据清单

- `src/hotspot/share/runtime/javaCalls.hpp:76-163`：`JavaCallArguments`
- `src/hotspot/share/runtime/javaCalls.hpp:158-163`：`_value_state` 枚举
- `src/hotspot/share/runtime/javaCalls.hpp:229-269`：`JavaCalls` 类
- `src/hotspot/share/runtime/javaCalls.cpp:54-119`：`JavaCallWrapper` 构造/析构
- `src/hotspot/share/runtime/javaCalls.cpp:188-201`：`call_virtual`
- `src/hotspot/share/runtime/javaCalls.cpp:346-475`：`call_helper`
- `src/hotspot/share/runtime/javaCalls.cpp:505-517`：`parameters()`
- `src/hotspot/share/prims/nativeLookup.cpp:165-222`：名字生成
- `src/hotspot/share/prims/nativeLookup.cpp:253-297`：`lookup_style` 分流
- `src/hotspot/share/prims/nativeLookup.cpp:263`：特殊表 7 条

## 7. 完成后 review

- 删除代码后，能否复述"JavaCalls 是统一通道、参数延迟解析保证 GC 安全"
- 是否讲清三大入口和 call_helper 十步
- 是否讲清 safepoint 断言
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验