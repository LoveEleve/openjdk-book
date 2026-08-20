# 27-jni/02-jni-fast-path 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JNI Get<Primitive>Field 的普通路径为什么慢（~200 cycles），快路径凭什么把 200 cycles 压到 ~30、以及它是怎么保证"投机读"安全的

## 1. 选题判断

现稿已有很强事实基础：
- `DEFINE_GETFIELD` 宏展开的普通路径
- `JNI_QUICK_ENTRY` 状态转换 + resolve + fieldID 翻译 + JVMTI probe
- `quicken_jni_functions` 启动时替换函数表
- `JNI_FastGetField` stub 生成代码
- `_safepoint_counter` 奇偶协议
- 信号处理器兜底投机读

但当前正文仍偏"普通路径一节 + 快路径一节 + counter 协议一节 + 信号处理器一节"的机制并列。真正该打穿的读者困惑更集中：

**读一个 int 字段逻辑上就是"解引用 + 读 4 字节"的事，为什么普通 JNI 走了 ~200 cycles？快路径凭什么叫"投机"——读完后怎么知道 GC 没动对象？信号处理器怎么知道读错了？**

## 2. 一句话顿悟

**快路径的"投机"不是乱猜，而是用 safepoint counter 的奇偶语义做门票：counter 偶数时没有 safepoint，先读字段（投机），再读一次 counter 校验——如果两次值相同，说明整个读窗口里没有 GC 移动对象。读错了也不怕，信号处理器捕获 SIGSEGV 后查 pc 地址表，把执行流改到慢路径重做。**

## 3. 总图

```text
普通路径 (每次 ~200 cycles)
  JNI_QUICK_ENTRY
    ├─ thread_from_jni_environment → ThreadInVMfromNative (safepoint check)
    ├─ resolve_non_null(obj)       → handle 解引用
    ├─ from_instance_jfieldID      → fieldID 译 offset + 校验
    ├─ JVMTI should_post_field_access → probe
    └─ Fieldname_field(offset)     → 真正读 4 字节

快路径 (启动时替换函数表)
  stub 入口
    ├─ 读 safepoint_counter → 奇数 → tail jump 到普通路径
    ├─ 偶数 → 投机读字段
    ├─ 再读 counter → 相等 → return 结果
    └─ 不等 → tail jump 到普通路径

  SIGSEGV 兜底
    └─ 信号处理器查 speculative_load_pclist
         → 找到对应慢路径入口 → 跳转重做
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——读个 int 怎么会要 200 cycles

目标约 1000 字。

- 从"逻辑上就是解引用+读 4 字节"切入
- 点出：JNI 每次调用都要经过状态转换、handle 解析、fieldID 翻译、JVMTI 检查
- 埋主线：快路径用"投机 + 校验"绕过这些开销

### 第二节：两个朴素方案为什么都不对

目标约 1200 字。

必须推演：
1. 直接读裸 oop 指针（GC 移动后悬空，不安全）
2. 每次读都加锁保护（性能开销远大于问题本身）

结论：
- 间接引用不可省，但 safepoint counter 可以在不额外加锁的前提下验证"没被移动"

### 第三节：普通路径——慢在哪

目标约 1800 字。

- `DEFINE_GETFIELD` 宏（jni.cpp:2082-2106）
- `JNI_QUICK_ENTRY` 状态转换 + safepoint 检查（interfaceSupport.inline.hpp:532-540）
- `resolve_non_null` / `from_instance_jfieldID` / `should_post_field_access`
- 大头在调用框架，不在读字段本身

### 第四节：快路径——用 counter 做门票的投机读

目标约 2500 字。

- `quicken_jni_functions` 五条件（jni.cpp:3829-3873）
- 8 个 Get，没有 Object/Static
- 生成 stub 的整体流程（jniFastGetField.hpp:31-55）
- x86_64 生成代码（jniFastGetField_x86_64.cpp:75-141）
- 数据依赖代替 lfence
- try_resolve_jobject_in_native（barrierSetAssembler_x86.cpp:213-217）
- fieldID 右移 2 位（jfieldIDWorkaround.hpp:28-60）
- speculative_load_pclist 登记（jniFastGetField.cpp:28-39）

### 第五节：为什么偶数就安全——counter 协议

目标约 1500 字。

- `_safepoint_counter` 奇偶语义（safepoint.hpp:112-118）
- begin 加 1 变奇数，end 加 1 回偶数
- Threads_lock 全程持有保证 race freedom
- 两次 counter 相等 = 整个窗口无 safepoint

### 第六节：谁给投机读兜底——信号处理器

目标约 1200 字。

- SIGSEGV/SIGBUS 时查 speculative_load_pclist（os_linux_x86.cpp:494-501）
- 命中则改到对应的慢路径入口
- 说明"读错不可怕，可怕的是读错还不知道"

### 第七节：误解澄清与收网

目标约 1200 字。

至少回答：
1. 快路径是否修改了 JNI 语义
2. 为什么没有 GetObjectField 快路径
3. 投机读失败时会不会崩
4. counter 回绕是否可能
5. 是什么条件会让快路径整体失效

## 5. 失败方案必须写进正文

1. 直接读裸 oop 指针（GC 移动后悬空）
2. 每次读都加锁保护（性能开销远大于问题）

## 6. 证据清单

- `src/hotspot/share/prims/jni.cpp:2082-2106`：`DEFINE_GETFIELD` 宏
- `src/hotspot/share/prims/jni.cpp:3829-3873`：`quicken_jni_functions`
- `src/hotspot/share/prims/jniFastGetField.hpp:31-55`：stub 逻辑注释
- `src/hotspot/share/prims/jniFastGetField.hpp:57-67`：`JNI_FastGetField` 类
- `src/hotspot/share/prims/jniFastGetField.cpp:28-39`：`speculative_load_pclist` / `find_slowcase_pc`
- `src/hotspot/cpu/x86/jniFastGetField_x86_64.cpp:75-141`：stub 生成代码
- `src/hotspot/share/runtime/safepoint.hpp:112-118`：`_safepoint_counter` 协议
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:532-540`：`JNI_QUICK_ENTRY`
- `src/hotspot/share/prims/jfieldIDWorkaround.hpp:28-60`：fieldID 编码
- `src/hotspot/os/linux/os_linux_x86.cpp:494-501`：信号处理器兜底
- `src/hotspot/cpu/x86/gc/g1/g1BarrierSetAssembler_x86.cpp:213-217`：`try_resolve_jobject_in_native`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 JNI Get<Primitive>Field 快路径，不展开 Set 系列（无快路径）
- 不展开 safepoint 的完整编排（18-01 已讲）
- 不展开 JVMTI 字段访问钩子完整实现
- 下一篇若讲 JNI Check，应自然承接"快路径在 Check 模式下失效"

## 8. 完成后 review

- 删除代码后，能否复述"快路径用 counter 奇偶做门票，投机读字段后校验"
- 是否讲清普通路径的慢在哪几步
- 是否讲清为什么偶数 counter 就能保证字段没被移动
- 是否讲清信号处理器怎么给投机读兜底
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验