# 前置概念：HotSpot 的三套 Handle 体系

在阅读 `Thread::Thread()` 构造函数的"内存管理"段之前，需要先理解 HotSpot 里三套互相独立但经常并肩出现的 Handle 概念。如果不知道它们"为什么要存在"，构造函数里那些 `set_active_handles(NULL)` 和 `_metadata_handles` 看起来就是无意义的噪声。

---

## 1. 起点：oop 和 Metadata 的生存环境不同

HotSpot 内部有两类"Java 对象的 C++ 指针"：

**oop**（ordinary object pointer）是 Java 对象在 GC 堆上的指针，裸类型是 `oopDesc*`。GC 会移动堆里的 oop（copy/compaction），移动后原来的裸指针就悬空了——谁还拿着旧地址谁崩溃。

**Metadata***（`Method*`、`ConstantPool*` 等）是类元数据在 Metaspace 上的指针。Metaspace 不在 GC 堆里，GC 不会移动里面的对象。但有另一种威胁：JVMTI 的 `RedefineClasses`（热类替换）可能回收旧版本的元数据。

这个区别导致了两条完全不同的保护路径：

| | oop | Metadata |
|---|---|---|
| 在哪 | GC 堆 | Metaspace |
| 谁管理 | GC（移动/回收） | RedefineClasses（替换旧版本） |
| 威胁 | GC 后原地址悬空 | RedefineClasses 后对象被删 |
| 保护机制 | 双层间接（Handle → 槽位 → oop） | 引用列表（push 到数组 → 打标 → 阻止回收） |

---

## 2. HandleArea / HandleMark / Handle —— oop 的三件套

### 2.1 HandleArea —— GC 会翻看的"草稿纸"

`handles.hpp:173`：

```cpp
class HandleArea : public Arena {
  oop* allocate_handle(oop obj);  // 分配一个 oop 大小的槽位，写入 obj
  void oops_do(OopClosure* f);    // GC 遍历所有槽位，更新被移动的 oop
};
```

HandleArea 就是一个 Arena 分配器（Chunk 初始 `tiny_size`）。Arena 的"撞针分配"和 Chunk/ChunkPool 的完整机制已在 [3.6 节 chunkpool_init](#/openjdk/vol-01/ch03/06-main-thread-create?id=chunkpool_init) 中详细讲解——本节不重复撞针和 Chunk 链表，只聚焦 HandleArea 在 GC oop 扫描中特有的角色。

每次 `allocate_handle(obj)` 从 Arena 分配一块 `sizeof(oop)` 的内存，把 oop 写进去，返回这块内存的地址——就是"槽位"。

GC 时，GC 调用 `HandleArea::oops_do()` 遍历所有 Chunk 里所有已分配的槽位，逐个调 `OopClosure`。如果槽位里那个 oop 被 GC 移动了，槽位里的指针就被原地更新为新地址——手里拿着槽位地址的代码永远通过槽位间接访问，始终拿到最新地址。

![Arena → Chunk → oop* 槽位 → JAVA HEAP 关系](assets/handle-double-indirection.png)

类比：你在草稿纸（HandleArea）上抄了一个 Java 堆上的地址。GC 来的时翻这张草稿纸，把过期的地址划掉改写成新地址。

### 2.2 HandleMark —— 草稿纸上的"到这了"

`handles.cpp:122-141`：

- **构造**：记录 HandleArea 的当前状态——当前 chunk（`_chunk`）、水位线（`_hwm`）、容量上限（`_max`）。把自己链入 `Thread::_last_handle_mark` 链表。
- **析构**：回滚 Arena 到保存的位置。砍掉多分配的 chunk，`_hwm`/`_max` 回滚——HandleMark 期间分配的所有 Handle 全部失效。

类比：在草稿纸上画一条横线。写代码时 Handle 不断增加（线以下内容越来越多），出作用域时 HandleMark 析构——从线开始的内容全撕掉。

### 2.3 Handle —— 指向槽位的指针

`handles.hpp:64`：

```cpp
class Handle {
  oop* _handle;                            // 指向 HandleArea 里的一个 oop 槽位
  Handle(Thread* thread, oop obj);         // 在 HandleArea 里分配槽位
  oop operator()() const { return *_handle; }  // 始终读到 GC 后最新的地址
};
```

Handle 只存一个 `_handle` 字段——指向 HandleArea 中那个 oop 槽位。用 `h()` 取值时做 `*_handle`——GC 如果更新了槽位内容，取到的就是新地址。

核心原理是**双层间接**：`raw_oop → 槽位 → Handle`。GC 更新中间的槽位，Handle 不直接持有 oop，永远不会悬空。

### 2.4 完整生命周期示例

```cpp
// 不安全——裸 oop
void unsafe() {
  oop obj = java_lang_String::create(...);
  // >>> GC 发生 → obj 指向的地址被移动 → obj 是旧地址
  obj->set_xxx(...);   // 崩溃
}

// 安全——Handle 保护
void safe() {
  HandleMark hm;                              // ①画线
  Handle obj(THREAD, java_lang_String::create(...));
  // ② new String → oop 在堆上，槽位在 HandleArea，_handle 指向槽位
  // >>> GC 发生 → HandleArea::oops_do() 更新槽位 → *_handle 是新地址
  obj()->set_xxx(...);                        // ③ 安全
  // ④ HandleMark 析构 → Arena 回滚 → _handle 指向的内存回收
}
```

### 2.5 三者类比

- **HandleArea** = 草稿纸（GC 翻看的 oop 地址登记簿）
- **HandleMark** = 纸上画的横线（"写到这了"，析构时撕掉线下内容）
- **Handle** = 写在纸上的一个地址（通过槽位间接访问，GC 后槽位内容被更新）
- **Thread** = 每人一张草稿纸（`_handle_area`）、一叠横线（`_last_handle_mark` 链表）

---

## 3. methodHandle / constantPoolHandle —— Metadata 的保护机制

### 3.1 为什么不共用 HandleArea

oop Handle 用 HandleArea 是因为 GC 要遍历槽位更新指针。但 Metaspace 里的 Metadata 不会被 GC 移动——GC 根本不扫描 Metaspace。所以不需要 HandleArea 的"GC 遍历更新"能力。

metadata handle 需要的保护是另一个方向：**不让 RedefineClasses 把"正在被人引用"的旧版本 Metadata 回收掉**。所以它用一个**数组**来存引用，而不是 Arena 槽位。

### 3.2 GrowableArray<Metadata*>(30, true) 的含义

`thread.cpp:233`：

```cpp
set_metadata_handles(new (ResourceObj::C_HEAP, mtClass) GrowableArray<Metadata*>(30, true));
```

逐项拆解：
- `GrowableArray<Metadata*>`：HotSpot 自己的动态数组（类似 `std::vector`，但 HotSpot 避免 STL）
- `30`：初始容量（大多数线程持有 0~3 个 handle，30 是首次扩容前的一次性开销）
- `true`：`on_C_heap` 标志——数据缓冲区用 `malloc` 在 C-Heap 上分配，不是 ResourceArea

**为什么必须是 C-Heap？** Metadata handle 的生命周期贯穿整个线程——只要线程还活着，它持有的 `methodHandle` 就不能被 ResourceMark 回收。如果存 ResourceArea 上，一次 `ResourceMark` 析构就全没了。

### 3.3 methodHandle 和 constantPoolHandle

`handles.hpp:133-168` 用宏展开：

```cpp
class methodHandle : public StackObj {
  Method* _value;   // 直接存 Metad ata* 裸指针（不是槽位！）
  Thread* _thread;  // 创建它的线程
};
```

与 oop Handle（存 `_handle` 指向 HandleArea 槽位）不同，metadata handle **直接存裸指针到 `_value`**——Metaspace 里的对象不会移动，不需要双层间接。

构造时（`handles.inline.hpp:55-71`）：

```cpp
methodHandle::methodHandle(Method* obj) : _value(obj), _thread(Thread::current()) {
  _thread->metadata_handles()->push((Metadata*)obj);  // 推入保活数组
}
```

把 `Metadata*` push 到线程的 `_metadata_handles` 数组里。拷贝构造也会 push，析构时 `remove()` 从数组里拿掉自己。

类比：图书馆（Metaspace）不搬书，但管理员（RedefineClasses）会下架旧版书。你把借书卡放进"正在使用"箱（`_metadata_handles`）——管理员来回收时看到卡在箱子里，就不下架这本书。

### 3.4 RedefineClasses 的完整 6 步

```
java.lang.instrument.redefineClasses()
  → JVMTI → VM_RedefineClasses::doit()（需要在 safepoint）
```

1. **进入 Safepoint**：所有 Java 线程停在安全点。
2. **`MetadataOnStackMark` 构造**：调用 `Threads::metadata_handles_do(Metadata::mark_on_stack)`，遍历所有线程的 `_metadata_handles` 数组。
3. **打标记**：对每个 `Metadata*` 调 `m->set_on_stack(true)`。`Method` 用 `_access_flags` 的 bit，`ConstantPool` 用 `_flags` 字段。
4. **RedefineClasses 做替换**：检查每个旧 Metadata 的 `_on_stack` 标志——`true`（有人引用）→ 保留；`false`（无人引用）→ 安全替换。
5. **`MetadataOnStackMark` 析构**：遍历所有被打标记的 Metadata，逐个 `set_on_stack(false)` 恢复。
6. **退出 Safepoint**。

| | GC（移动对象） | RedefineClasses（回收元数据） |
|---|---|---|
| handle 存储 | HandleArea（Arena 分配） | `_metadata_handles`（C-Heap GrowableArray） |
| handle 生命周期 | 随 HandleMark 析构释放 | 跨越 ResourceMark，线程活着就一直有效 |
| 保护实现在 | `HandleArea::oops_do()` 被 GC 调用 | `set_on_stack(true)` 被 RedefineClasses 读取 |

---

## 4. JNIHandleBlock —— 跨 native 边界的 local ref

### 4.0 从一个具体场景开始理解

你写了一段 Java 代码：

```java
public class Foo {
    static native String getName(Object obj);  // JNI native 方法
}
```

这个 `getName` 的 C 实现（`Foo.c`）大概是：

```c
JNIEXPORT jstring JNICALL Java_Foo_getName(JNIEnv *env, jclass cls, jobject obj) {
    // obj 就是 Java 那边传过来的 Object
    // env->FindClass(...) 返回一个 jclass
    // 这些 jobject/jclass 是"JNI local ref"
    return env->NewStringUTF("hello");
}
```

**问题来了**：`obj`（`jobject`）本质上是一个指向 Java 堆上对象的指针（oop）。但在 native 代码执行期间，GC 随时可能发生——如果 GC 把这个 Java 对象移动了，`obj` 就变成了悬空指针。

HotSpot 需要找一个地方把"当前 native 帧正在用的 oop"**登记**起来，这样 GC 来了可以：
1. 找到这些 oop（标记为 GC 根，不被回收）
2. 移动后更新登记处的内容

这个地方就是 **JNIHandleBlock**——JNI 调用的"传话本"。

### 4.1 JNIHandleBlock 是什么

`jniHandles.hpp:137-153` 定义，固定 32 槽的 oop 数组块，链表结构：

- `_handles[32]` —— oop 数组
- `_top` —— 已用槽位索引（0~32），类似栈顶
- `_next` —— 链表下一块（32 槽不够时扩展）
- `_free_list` —— 空闲槽位链表（DeleteLocalRef 释放的 slot 可复用）

存储位置是 **C-Heap**（`malloc/free`），不是 HandleArea 的 Chunk。

### 4.2 HandleArea 的 Handle vs JNIHandleBlock 的 local ref

这是最容易混淆的概念。两者的相似点：都是 GC 安全的 oop 间接引用，都参与 `Thread::oops_do()` 的 GC 根扫描。区别：

| | HandleArea 的 Handle | JNIHandleBlock 的 local ref |
|---|---|---|
| 谁创建 | VM 内部代码 `Handle(thread, obj)` | JNI 函数（如 FindClass、NewObject） |
| 存储 | HandleArea（Arena，Chunk 池） | C-Heap（malloc/free） |
| 内存管理 | **RAII**：HandleMark 析构回滚 | **显式**：DeleteLocalRef 或 native 返回释放帧 |
| 用处 | VM 内部 C++ 代码操作 oop | Java 调 native 时跨边界传 `jobject` |
| GC 扫描 | `HandleArea::oops_do()` | JNIHandleBlock 链表 `oops_do()` |

一句话：Handle 是 VM 写给自己看的草稿，JNIHandleBlock 是 VM 和 native 代码之间的传话本。

### 4.3 allocate_block / release_block

`allocate_block()`（jniHandles.cpp:364-405）：先检查 `thread->free_handle_block()`——命中无锁取走；未命中持全局锁取；全局也空 `new JNIHandleBlock()`。

`release_block()`（jniHandles.cpp:408-415）：块挂到 `thread->free_handle_block()` 头，下次本线程无锁复用。

### 4.4 为什么只缓存 1 个块

大多数 JNI 调用链的生命周期是：进入 native → 分配 local ref → 返回 → 释放块。同一线程连续两帧可以无锁复用这一个缓存块，不需要囤积。第二帧如果命中缓存（大概率），免去锁竞争；如果需要更多块，走全局分配。

### 4.5 构造时为什么都是 NULL

`thread.cpp:234-236`：

```cpp
set_active_handles(NULL);
set_free_handle_block(NULL);
set_last_handle_mark(NULL);
```

三行都是 NULL——线程刚出生，还不能执行 JNI 调用（OS 层还没附着），HandleArea 也是空的。`_active_handles` 在 Stage 4 第 6 步 `set_active_handles(JNIHandleBlock::allocate_block())` 才赋真值，`_last_handle_mark` 在紧随三行之后的 `new HandleMark(this)`（thread.cpp:246）立即被第一个 Mark 覆盖。此处只是 C++ 安全实践：所有指针在使用前显式初始化。

---

## 5. 完整体系总结

回到 `Thread::Thread()` 构造函数的代码，现在每行都有含义了：

```cpp
// ===== HandleArea 系：VM 内部 oop 操作 =====
set_resource_area(new (mtThread)ResourceArea());     // 草稿纸（见第 2 节 chunkpool_init）
set_handle_area(new (mtThread) HandleArea(NULL));    // 另一张更小的草稿纸

// ===== HandleMark 系：水位线 =====
set_last_handle_mark(NULL);                          // 横线链表头（马上被 new HandleMark 覆盖）
new HandleMark(this);                                // 第一条横线——"从这开始算"

// ===== Metadata 系：方法/常量池保护 =====
set_metadata_handles(new GrowableArray<Metadata*>(30, true));  // 借书卡登记箱

// ===== JNI 系：跨 native 边界的 local ref =====
set_active_handles(NULL);                            // 每个 native 帧的 oop 登记表（第 6 步才分配首块）
set_free_handle_block(NULL);                         // 登记表缓存（无锁复用优化）
```

三套体系各自独立，但都在 `Thread::oops_do()` 中被 GC 统一遍历——GC 不关心 oop 是在 HandleArea 还是 JNIHandleBlock 里，遍历所有根找活对象。
