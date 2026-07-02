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

类比：你在草稿纸（HandleArea）上抄了一个 Java 堆上的地址。GC 来的时翻这张草稿纸，把过期的地址划掉改写成新地址。

### 2.2 HandleMark —— 草稿纸上的"到这了"

`handles.cpp:122-141`：

- **构造**：记录 HandleArea 的当前状态——当前 chunk（`_chunk`）、水位线（`_hwm`）、容量上限（`_max`）。把自己链入 `Thread::_last_handle_mark` 链表。
- **析构**：回滚 Arena 到保存的位置。砍掉多分配的 chunk，`_hwm`/`_max` 回滚——HandleMark 期间分配的所有 Handle 全部失效。

类比：在草稿纸上画一条横线。写代码时 Handle 不断增加（线以下内容越来越多），出作用域时 HandleMark 析构——从线开始的内容全撕掉。

`_last_handle_mark` 是 `Thread` 的一个字段（`HandleMark*`），记录当前线程的 HandleMark 栈顶。每个 HandleMark 构造时做两件事：
1. 把当前 `thread->_last_handle_mark` 存到自己的 `_previous_handle_mark`
2. 把 `thread->_last_handle_mark` 改为指向自己

析构时相反——`thread->_last_handle_mark = _previous_handle_mark`。这就形成了一个**栈式链表**——后进先出，新 Mark 在上面，旧 Mark 在下面。

`Thread::Thread()` 构造函数里 `set_last_handle_mark(NULL)` 只是 C++ 安全实践——不让指针有未定义的初始值。紧随其后的 `new HandleMark(this)` 把 NULL 替换为第一个 Mark——这个 Mark 的 `_previous_handle_mark` 就是 NULL，表示"下面没有更早的横线了"。

> **为什么必须在 product 构建保留 `_last_handle_mark` 链？** `ResourceMark` 也维护 `_previous_resource_mark` 链，但只在 `DEBUG_ONLY` 里——product 直接删掉。`HandleMark` 保留了它，不是功能必须（回滚靠 `_chunk/_hwm/_max`，不需要链），而是防御性的：HandleArea 涉及 GC 根扫描——如果 Arena 回滚出错导致 GC 误删活对象，JVM 直接 crash。保留 `_last_handle_mark` 链能帮助在 hs_err 文件里追查 HandleMark 嵌套是否不平衡。

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

## 3. JNIHandleBlock —— 跨 native 边界的 local ref

### 3.0 从一个具体场景开始理解

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

### 3.1 JNIHandleBlock 是什么

`jniHandles.hpp:132-168` 定义，继承 `CHeapObj<mtInternal>`，固定 32 槽的 oop 数组块，链表结构。

#### 每个块都有的字段

- `oop _handles[32]` —— `oop` 就是 `oopDesc*`，每个槽位存一个**堆上 Java 对象的地址**。GC 移动对象后直接更新这个槽位里的地址值。注意这里存的是 `oop`（一层指针 `oopDesc*`），不是 `oop*`（两层指针 `oopDesc**`）——这和 Handle 体系不同：Handle 通过槽位间接访问（双层），JNIHandleBlock 直接受 GC 写更新（单层）。
- `int _top` —— 已用槽位索引（0~32），类似栈顶指针。每分配一个 JNI local ref，`_top++`
- `JNIHandleBlock* _next` —— 链表下一块。32 槽不够用时扩展新块，串成链表

#### 仅链表首块使用的字段

以下字段只在链表第一个块中才有意义——注释里说"Having two types of blocks complicates the code and the space overhead in negligible"：与其为"普通块"和"首块"定义两个类，不如所有块都带上这些字段，非首块的浪费忽略不计。

- `JNIHandleBlock* _last` —— 链表尾块指针。首块用它 O(1) 找到链尾，新块直接挂到 `_last->_next`，不用遍历链表
- `JNIHandleBlock* _pop_frame_link` —— `PushLocalFrame`/`PopLocalFrame` 时用。Push 时记下当前 `_top` 所在的块，Pop 时直接回滚到这个块，`_top` 以上的槽位全部释放
- `oop* _free_list` —— 空闲槽位链表，**重建时一次性扫描串联，不是在删除时立即串联**。`DeleteLocalRef` 释放 slot 时只做一件事——把槽位写入 `NULL`，不碰 `_free_list`。真正串联发生在 `allocate_handle` 发现分配失败且 `_free_list == NULL` 时：调 `rebuild_free_list()`（`jniHandles.cpp:548`）遍历所有已分配槽位，发现 `*handle == NULL` 的就强转为 `(oop)_free_list` 写入槽位（侵入式链表），链头挂在 `_free_list`。下次 `allocate_handle` 优先从 `_free_list` 取。
- `int _allocate_before_rebuild` —— 重建 `_free_list` 之后还能从空闲链表分配多少次。举个例子：`_top` 到了 32（满），期间用户调了 3 次 `DeleteLocalRef` 删掉槽位 3、7、15。JVM 扫描全部 32 个槽位，发现 3 个空闲的，重建 `_free_list`，同时把 `_allocate_before_rebuild` 设为 3。接下来 3 次 `allocate_handle` 从 `_free_list` 链头取（-1），计数器归零后下一次分配时再触发重建扫描——如果没空闲槽位就扩展新块。
- `size_t _planned_capacity` —— 当前 JNI 帧计划需要的槽位数。native 代码可以主动调 `env->EnsureLocalCapacity(N)` 告诉 VM"我这个函数需要 N 个 local ref"。JVM 把 `_planned_capacity` 设为 N，如果当前块不够空间，**现在就扩展**足够多的新块——一次性完成，省得后面每次 `allocate_handle` 失败时再逐个扩。类比：进考场前老师说"你要多少草稿纸"，一次给全，不用写到一半举手。

#### 静态成员（全局共享）

- `static JNIHandleBlock* _block_free_list`（`jniHandles.cpp:346 = NULL`）—— 全局空闲块池。没有 `init()` 函数，程序启动时自动零初始化为 NULL。`allocate_block()`（`jniHandles.cpp:364-405`）按以下顺序尝试：

  ```
  allocate_block(thread):
  1. thread->free_handle_block() != NULL  → 拿线程本地缓存（无锁）
  2. 持全局锁，_block_free_list != NULL  → 从全局池拿
  3. 全局池也是 NULL                    → new JNIHandleBlock()
       └─ CHeapObj<mtInternal>::operator new → malloc
  ```

  **第一次分配时**，`_free_handle_block`（线程的"空闲块缓存"）是 NULL（构造函数刚设的），全局池也是 NULL（静态零初始化）。所以第 1、2 步都跳过，直接走第 3 步：`new JNIHandleBlock()`，底层调用 `malloc`。分配后的块**不进 `_free_handle_block`（空闲缓存）**——它直接挂到 `_active_handles` 上（`main_thread->set_active_handles(allocate_block())`），进入"正在使用"状态。注意 Thread 有**两个**私有槽：`_active_handles`（正在用的块链表）和 `_free_handle_block`（1 个空闲块缓存），别搞混。此后当这个块被 `release_block()` **释放**时，才根据 `thread` 参数决定：`thread != NULL` → 进 `_free_handle_block`（抽屉备用）；`thread == NULL` → 进全局池。
- `static int _blocks_allocated` —— 调试用计数器，记录一共分配了多少个块

存储位置是 **C-Heap**（`malloc/free`），不是 HandleArea 的 Chunk。

### 3.2 HandleArea 的 Handle vs JNIHandleBlock 的 local ref

这是最容易混淆的概念。两者的相似点：都是 GC 安全的 oop 间接引用，都参与 `Thread::oops_do()` 的 GC 根扫描。区别：

| | HandleArea 的 Handle | JNIHandleBlock 的 local ref |
|---|---|---|
| 谁创建 | VM 内部代码 `Handle(thread, obj)` | JNI 函数（如 FindClass、NewObject） |
| 存储 | HandleArea（Arena，Chunk 池） | C-Heap（malloc/free） |
| 内存管理 | **RAII**：HandleMark 析构回滚 | **显式**：DeleteLocalRef 或 native 返回释放帧 |
| 用处 | VM 内部 C++ 代码操作 oop | Java 调 native 时跨边界传 `jobject` |
| GC 扫描 | `HandleArea::oops_do()` | JNIHandleBlock 链表 `oops_do()` |

一句话：Handle 是 VM 写给自己看的草稿，JNIHandleBlock 是 VM 和 native 代码之间的传话本。

### 3.3 allocate_block / release_block

`allocate_block()`（jniHandles.cpp:364-405）：先检查 `thread->free_handle_block()`——命中无锁取走；未命中持全局锁取；全局也空 `new JNIHandleBlock()`。

`release_block()`（jniHandles.cpp:408-415）：块挂到 `thread->free_handle_block()` 头，下次本线程无锁复用。

### 3.4 为什么只缓存 1 个块

大多数 JNI 调用链的生命周期是：进入 native → 分配 local ref → 返回 → 释放块。同一线程连续两帧可以无锁复用这一个缓存块，不需要囤积。第二帧如果命中缓存（大概率），免去锁竞争；如果需要更多块，走全局分配。

### 3.5 JNIHandleBlock 是线程私有的

每个 `Thread` 对象持有自己的一套 JNIHandleBlock 链：

- `_active_handles`（`thread.hpp:301`）—— 本线程正在使用的 JNIHandleBlock 链表头，线程私有
- `_free_handle_block`（`thread.hpp:304`）—— 本线程的空闲块缓存（单块），线程私有

有一个全局池 `JNIHandleBlock::_block_free_list`（静态成员，`jniHandles.cpp:346`）作为后备——声明为 `static`，程序启动时自动零初始化：

```cpp
JNIHandleBlock* JNIHandleBlock::_block_free_list = NULL;
```

没有专门的 `init()` 函数——它一开始就是空的。`allocate_block()` 先拿线程的空闲块缓存、再试着从全局池拿、实在没有才 `new JNIHandleBlock()`。块用完后通过 `release_block(thread, block)` 归还：如果 `thread != NULL`，缓存到线程本地；如果 `thread == NULL`（如线程退时），挂回全局池。**全局池没有容量上限**——是 C-Heap 上的单链表，释放多少块就能存多少块。

**与 Thread 构造函数的关系**：HotSpot 的线程模型中，每个能执行 JNI 调用的线程都**必须**拥有一个 `_active_handles` 链表，这样 GC 才能扫描它的 local ref。但 Thread 构造函数执行时线程还没启动——OS 层没附着、栈边界未知、任何 JNI 函数都调不了——所以设置为 NULL 是合理的。

真正给主线程分配第一个 JNIHandleBlock 的时机在 `Threads::create_vm()` 第 6 步：

```cpp
main_thread->set_active_handles(JNIHandleBlock::allocate_block());
```

`allocate_block()` 从线程的空闲块缓存或全局池拿一个块，挂到 `_active_handles` 上。此后主线程调任何 JNI 函数时，返回的 `jobject` 都会写入这个块。如果 32 槽用完，`allocate_handle()` 自动扩展新块（`_next` 链接）。

### 3.6 构造时为什么都是 NULL

`thread.cpp:234-236`：

```cpp
set_active_handles(NULL);
set_free_handle_block(NULL);
set_last_handle_mark(NULL);
```

三行都是 NULL——线程刚出生，还不能执行 JNI 调用，全局池里的块也不能直接挂给一个没附着的线程。此处只是 C++ 安全实践：所有指针在使用前显式初始化。

---

## 4. methodHandle / constantPoolHandle —— Metadata 的保护机制

### 4.0 先理解"Metadata 是什么"

Java 程序里的每一个类，在 JVM 内部由以下 C++ 对象在 Metaspace 中表示：

- `InstanceKlass` —— 类的"定义"：这个类有哪些字段、哪些方法、父类是谁
- `Method` —— 类里每个方法的字节码、JIT 编译后的机器码、异常表
- `ConstantPool` —— 类常量池：存字符串、类引用、方法引用等

举个例子：

```java
public class Foo {
    public int add(int a, int b) {
        return a + b;
    }
}
```

`Foo` 加载后，Metaspace 里有三个 Metadata 对象：一个 `InstanceKlass`（Foo 类的定义）、一个 `Method`（`add` 方法的信息）、一个 `ConstantPool`（Foo 类的常量池）。

### 4.1 问题：RedefineClasses 会替换旧版本

HotSpot 支持 **RedefineClasses**——不需要重启 JVM，运行时替换类的新版本。JVMTI 工具（如 IDE 的"Hot Swap"）会调用它。

当 RedefineClasses 把 `Foo.add` 换成新版本：
- Metaspace 里会出现一个**新的 `Method` 对象**（新版本的 `add`）
- 旧的 `Method` 对象需要被回收

**问题来了**：如果某个线程此刻正好在执行旧的 `add` 方法，它的 C++ 调用栈上有 `Method*` 指针指向旧的方法对象——直接把旧的 `Method` 回收掉，那个线程就崩溃了。

这就是 `_metadata_handles` 存在的理由：**登记"哪些 Metadata 对象正在被某个线程引用"，RedefineClasses 来回收时先检查登记表，看看有没有人还拿着。**

### 4.2 为什么不共用 HandleArea

### 4.3 GrowableArray<Metadata*>(30, true) 的含义

`thread.cpp:233`：

```cpp
set_metadata_handles(new (ResourceObj::C_HEAP, mtClass) GrowableArray<Metadata*>(30, true));
```

逐项拆解：
- `GrowableArray<Metadata*>`：HotSpot 自己的动态数组（类似 `std::vector`，但 HotSpot 避免 STL）
- `30`：初始容量（大多数线程持有 0~3 个 handle，30 是首次扩容前的一次性开销）
- `true`：`on_C_heap` 标志——数据缓冲区用 `malloc` 在 C-Heap 上分配，不是 ResourceArea

**为什么必须是 C-Heap？** Metadata handle 的生命周期贯穿整个线程——只要线程还活着，它持有的 `methodHandle` 就不能被 ResourceMark 回收。如果存 ResourceArea 上，一次 `ResourceMark` 析构就全没了。

### 4.4 methodHandle 和 constantPoolHandle

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

### 4.5 RedefineClasses 的完整 6 步

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
set_active_handles(NULL);                            // 传话本（第 6 步才分配首块）
set_free_handle_block(NULL);                         // 传话本缓存（无锁复用优化）
```

三套体系各自独立，但都在 `Thread::oops_do()` 中被 GC 统一遍历——GC 不关心 oop 是在 HandleArea 还是 JNIHandleBlock 里，遍历所有根找活对象。
Handle 是 VM 写给自己看的草稿