# 27-jni/01-handle-system 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 jobject 为什么不是裸 oop 指针，而是间接引用（handle），以及三层引用（local/global/weak）各自的生命周期、存储方式和失效机制

## 1. 选题判断

现稿已有很强事实基础：
- `JNIHandles::make_local` / `make_global` / `make_weak_global`
- `JNIHandleBlock` 的 `_handles` / `_top` / `_next` / `_free_list`
- `allocate_handle` 四段分配 + `rebuild_free_list` 启发式
- `is_jweak` / `jweak_ptr` / `jobject_ptr`
- `resolve_impl` 无锁读槽
- OopStorage 作为 global/weak 仓库
- `reset handle block` 的 assembler 实现

但现稿仍偏"本地引用一节 + 全局/弱全局一节 + resolve 一节"的机制并列。真正该打穿的读者困惑更集中：

**jobject 在 native 代码里看起来像个指针，但 GC 移动对象后指针就悬空了——JVM 怎么解决这个问题？本地引用、全局引用、弱全局引用是不是只是"生命周期不同"而已，底层用了同一套存储？**

## 2. 一句话顿悟

**jobject 不是裸 oop 指针，而是间接引用（handle）——指向一个存放 oop 的槽，GC 移动对象时更新槽里的 oop，handle 本身不变。三层引用不只是"生命周期不同"，底层使用了两套完全不同的存储：本地引用存于线程本地 JNIHandleBlock 链（32 槽一块，_top 清零整体失效），全局/弱全局引用存于 OopStorage 仓库（独立于线程，显式分配/释放）。**

## 3. 总图

```text
jobject 不是裸 oop 指针，是 handle

本地引用 (local)
  JavaThread._active_handles -> JNIHandleBlock 链
  32 槽/块，_top 计数
  分配：last block top -> free list -> next block -> rebuild/append
  失效：native 返回时 _top 清零（整体失效，不是逐个释放）
  PushLocalFrame/PopLocalFrame：显式帧边界

全局引用 (global)
  OopStorage (JNI Global)
  显式 NewGlobalRef/DeleteGlobalRef
  GC 时作为根遍历

弱全局引用 (weak)
  OopStorage (JNI Weak)
  地址 +1 做 tag 位 (is_jweak = handle & 1)
  写入用 ON_PHANTOM_OOP_REF 通道
  GC 的 WeakProcessor 清 NULL

resolve: 无锁读槽
  is_jweak -> jweak_ptr (地址 -1) 走 phantom 通道
  else -> jobject_ptr (直接 reinterpret_cast) 走普通通道
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"jobject 不可能是裸 oop 指针"

目标约 1100 字。

- 从"native 代码拿到的 jobject 是什么"切入
- 点出：GC 移动对象后裸 oop 指针会悬空，所以 jobject 必须是间接引用
- 埋主线：三层引用不是一套存储的三种权限，而是两套存储各管各的

### 第二节：两个朴素方案为什么都不对

目标约 1400 字。

必须推演：
1. jobject = 裸 oop 指针（GC 移动后悬空，无法安全解引用）
2. 本地引用可以逐个释放（native 返回时整体重置 _top 比逐个释放快一个量级）

结论：
- 间接引用是唯一安全的方案
- 批次失效是性能关键设计

### 第三节：本地引用——线程行李里的 JNIHandleBlock 链

目标约 2400 字。

- `JNIHandleBlock` 32 槽/块（jniHandles.hpp:136-151）
- `make_local` 入块（jniHandles.cpp:52-61）
- `allocate_handle` 四段分配（jniHandles.cpp:481-546）
- `rebuild_free_list` 启发式（:548-575）
- 失效：`_top` 清零，不是逐个释放（templateInterpreterGenerator_x86.cpp:1163-1166）
- 参数也是本地引用：编译代码 `object_move`（sharedRuntime_x86_64.cpp:1157-1180），解释器 `pass_object`（interpreterRT_x86_64.cpp:214-260）
- `PushLocalFrame`/`PopLocalFrame`（jni.cpp:746-783）

### 第四节：全局与弱全局引用——OopStorage 仓库

目标约 2200 字。

- `JNIHandles::initialize` 建两个 OopStorage（jniHandles.cpp:203-210）
- `make_global`（jniHandles.cpp:101-122）
- `destroy_global`（:168-175）
- `make_weak_global`：地址 +1 做 tag（:125-146）
- `is_jweak` 位测试（inline.hpp:34-38）
- OopStorage 结构：Block + 使用位图 + 分配/释放协议（oopStorage.hpp:37-73）
- `weak_oops_do` 清 NULL（jniHandles.cpp:weak_oops_do）

### 第五节：resolve——无锁读槽

目标约 1400 字。

- `resolve_impl`（inline.hpp:52-66）
- 普通 jobject 槽永不 null（null 已规范化为 null jobject）
- jweak 走 phantom 通道
- `assert(!current_thread_in_native())`：必须在 VM 状态下读

### 第六节：误解澄清与收网

目标约 1300 字。

至少回答：
1. jobject 是否可以当作裸 oop 指针使用
2. 本地引用失效是否逐个释放
3. 全局引用和弱全局引用是否同一套存储
4. jweak 是否有独立的数据结构
5. resolve 是否加锁

## 5. 失败方案必须写进正文

1. jobject = 裸 oop 指针（GC 移动后悬空）
2. 本地引用逐个释放（整体清零 _top 即可）
3. 全局/弱全局引用用同一套存储（两个独立 OopStorage）

## 6. 证据清单

- `src/hotspot/share/runtime/jniHandles.hpp:132-151`：`JNIHandleBlock` 布局
- `src/hotspot/share/runtime/jniHandles.hpp:63-66`：`weak_tag_size` / `weak_tag_alignment` / `weak_tag_value`
- `src/hotspot/share/runtime/jniHandles.cpp:52-61`：`make_local`
- `src/hotspot/share/runtime/jniHandles.cpp:101-122`：`make_global`
- `src/hotspot/share/runtime/jniHandles.cpp:125-146`：`make_weak_global`
- `src/hotspot/share/runtime/jniHandles.cpp:168-175`：`destroy_global`
- `src/hotspot/share/runtime/jniHandles.cpp:203-210`：`initialize` 建两个仓库
- `src/hotspot/share/runtime/jniHandles.cpp:481-546`：`allocate_handle`
- `src/hotspot/share/runtime/jniHandles.cpp:548-575`：`rebuild_free_list`
- `src/hotspot/share/runtime/jniHandles.inline.hpp:34-38`：`is_jweak`
- `src/hotspot/share/runtime/jniHandles.inline.hpp:52-66`：`resolve_impl`
- `src/hotspot/share/runtime/jniHandles.inline.hpp:97-102`：`destroy_local`
- `src/hotspot/share/gc/shared/oopStorage.hpp:37-73`：OopStorage 设计注释
- `src/hotspot/share/gc/shared/oopStorage.cpp:410-477`：`allocate`
- `src/hotspot/share/gc/shared/oopStorage.cpp:675-682`：`release`
- `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:1157-1180`：`object_move`
- `src/hotspot/cpu/x86/interpreterRT_x86_64.cpp:214-260`：`pass_object`
- `src/hotspot/cpu/x86/templateInterpreterGenerator_x86.cpp:1163-1166`：reset handle block

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 JNI Handle 系统，不展开 OopStorage 的完整并发协议（25-06 已讲共享层）
- 不展开 JNI 函数表、状态转换细节（17-04 已讲）
- 下一篇若讲 JNI Fast Path，应自然承接"resolve 是高频入口"

## 8. 完成后 review

- 删除代码后，能否复述"jobject 是间接引用，GC 移动时更新槽不更新 handle"
- 是否讲清本地引用/全局引用/弱全局引用的存储差异
- 是否讲清本地引用失效是整体 _top 清零
- 是否讲清 jweak 靠地址 +1 tag 位区分
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验