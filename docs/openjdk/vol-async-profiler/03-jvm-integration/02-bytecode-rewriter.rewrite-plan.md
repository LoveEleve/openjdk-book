# 02-bytecode-rewriter 重写规划

> 状态：deep review 完成，待修订同步
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“手写字节码改写器功能说明”重写成一篇围绕“只插几条指令，为什么会牵动整套 class 文件偏移、验证和失败回退”的机制文章

## 1. 读者困惑

- native profiler 为什么还要改 Java 字节码？
- 为什么方法入口/出口插入几条指令后，跳转、异常表、局部变量和 StackMapTable 都要一起修？
- 普通 instrumentation 与 latency 插桩到底是不是同一条改写路径？
- relocation table 为什么不能用一个固定偏移替代？
- 改写失败时，JVM 会不会收到半成品 class？
- ClassFileLoadHook 的回调注册、notification 启用、target 匹配和 retransform 是怎样串起来的？

## 2. 一句话顿悟

**BytecodeRewriter 的核心不是“插入几条 Java 指令”，而是维护一张旧 bytecode offset 到新 offset 的 relocation table，并让跳转、异常、行号、局部变量和 StackMapTable 共用这张映射；成功才把 JVMTI 分配的新 class bytes 交回 JVM，失败则释放缓冲并放弃改写。**

## 3. 总图

```text
Instrument::start
  → 准备 target/method + 开启 ClassFileLoadHook notification
    → ClassFileLoadHook
      → BytecodeRewriter
        ├─ 普通入口插桩
        └─ latency 入口/出口插桩
          → relocation_table
            → jumps / exception / line / local / StackMap 修正
              → 成功交回新 class bytes
              → 失败释放并跳过改写
```

## 4. 版本与边界

- 基于当前 C++ 手写 class-file rewriter 实现，不外推为完整 ASM 替代品。
- 普通改写和 latency 改写共用 Code/attribute 修正框架，但插入内容和扫描路径不同。
- `relocation_table` 是 offset 修正事实源，不把实现简化成“所有后续地址加固定常数”。
- `rewrite()` 失败时当前实现释放 JVMTI buffer，不把错误 class bytes 返回给 JVM。
- ClassFileLoadHook 只服务 instrumentation/latency 路径，不代表 CPU/alloc/lock/wall 都依赖字节码改写。

## 5. 结构大纲

### 第一节：只插几条指令，为什么会变成 class-file 级事故

建立跳转/异常/验证数据全部依赖 offset 的困惑。

### 第二节：ClassFileLoadHook 如何把“目标匹配”接到 rewriter

补 `Instrument::start` 与 `ClassFileLoadHook` 的真实触发边界。

### 第三节：普通插桩与 latency 插桩为什么不是同一段代码

入口 `invokestatic` vs nanoTime/local slot/return instrumentation。

### 第四节：relocation_table 为什么是单一事实源

第一遍改写与映射、第二遍 jump 修正、Code attributes 修正。

### 第五节：StackMapTable 为什么最容易让改写失败

frame offset、local slot、verification type、BAD_FULL_FRAME。

### 第六节：失败回退与 JVM 交付边界

Allocate/Deallocate、新 class bytes 只有成功才交回，Result 警告。

### 第七节：收网与采样主路径边界

插桩是调用驱动观察，不是周期采样替代。

## 6. 证据清单

- `src/instrument.cpp:310-375`
- `src/instrument.cpp:425-504`
- `src/instrument.cpp:507-669`
- `src/instrument.cpp:672-895`
- `src/instrument.cpp:1084-1110`
- `src/instrument.cpp:1236-1255`

## 7. 完成后检查

1. 删除代码后仍能复述“插入 → 映射 → 修正 → 成功交付/失败回退”。
2. 至少展开 4 个失败方案或误解。
3. 区分普通 instrumentation 与 latency 改写。
4. 不把 relocation table 写成固定偏移或严格“两遍不写出”的实现。
5. 明确 ClassFileLoadHook notification/target/retransform 时序。
6. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
