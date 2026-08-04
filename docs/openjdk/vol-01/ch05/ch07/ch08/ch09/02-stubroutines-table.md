# 前置概念：StubRoutines —— stub 入口点的全局索引表

> **本文定位**：背景知识文章。你要理解的是 StubRoutines 类本身——它不是什么复杂对象，它就是一张**约二十个 `static address` 字段的表**。每个字段存一个 stub 的入口地址，字段名告诉你这个入口是干什么的（`_call_stub_entry`、`_forward_exception_entry`……），类型 `address = unsigned char*` 告诉你它存的是一个内存地址。
>
> 本文是一本电子书的章节——不限制长度。每一行源码都被拆开。
>
> **前置依赖**：上篇文章 `01-stub-what-is.md` 已经解释了 stub 是什么、address 是什么。读完上一篇文章的读者知道"stub 是一段机器码，入口用 address 表示"。
>
> **阅读提示**：本文不涉及 BufferBlob、CodeCache、initialize1()——那些是后面文章的主题。本文只回答一个问题：**StubRoutines 这张表里存了什么？怎么读？怎么写？**

---

## 1. AllStatic + friend —— 读和写的权限分开

### 1.1 不能实例化——只有全局变量

```cpp
// stubRoutines.hpp:78
class StubRoutines : public AllStatic {
  friend class StubGenerator;  // 只有 StubGenerator 可以给 static 字段赋值
```

`AllStatic` 是一个空标记类——它删掉了所有构造函数，任何试图 `new StubRoutines()` 的代码都编译报错。这很好理解：这张表是全局唯一的，不需要对象——全 JVM 进程只有一份。

**为什么不直接用全局变量？**

```cpp
// 如果这样写：
extern address _call_stub_entry;
extern address _forward_exception_entry;
```

任何 `.cpp` 文件都可以读写这些字段。你不知道谁在改、什么时候改的。

HotSpot 的方案：

```cpp
class StubRoutines : public AllStatic {
  friend class StubGenerator;  // 写权限：只有 StubGenerator
 private:
  static address _call_stub_entry;
 public:
  static CallStub call_stub() { ... }  // 读权限：所有子系统通过访问器读
};
```

- `friend class StubGenerator`：只有 StubGenerator（在 `generate_initial()` 中）能直接写这些字段
- `private` 字段 + `public` 访问器：外部只能通过 `StubRoutines::call_stub()` 获取值——这是只读的

### 1.2 为什么 StubGenerator 需要 friend 权限

因为这些字段是被 `generate_initial()` 赋值的：

```cpp
// stubGenerator_x86_64.cpp:5883-5884
StubRoutines::_call_stub_entry =
  generate_call_stub(StubRoutines::_call_stub_return_address);
```

如果 StubGenerator 不是 friend，编译报错（访问 private 字段）。如果字段是 public，任何地方都能写——这不是设计意图：入口点只在初始化阶段写入一次。

---

## 2. StubRoutines 里存了什么？—— 按用途分类

每个 stub 入口点是同一个类型：

```cpp
static address _xxx_entry;   // address = unsigned char*
```

本文只讲 `initialize1()` 负责的那些字段——它们在源码中显式初始化为 NULL（`stubRoutines.cpp:47-71`）。还有一些字段（如 arraycopy）初始就指向 C++ 的慢速兜底函数、或是 `initialize2()` 之后才填充——那些不在本文范围。

### 2.1 调用入口——call_stub 相关

```cpp
static address _call_stub_return_address;  // frame.inline.hpp:45 用于判断 entry_frame
static address _call_stub_entry;           // C → Java 的唯一入口
```

call_helper 通过 `StubRoutines::call_stub()` 获取 `_call_stub_entry`，强转成 `CallStub` 函数指针后调用。`_call_stub_return_address` 是 call_stub 内部 `call rcx` 之后的第一条指令地址，用于帧类型判定。

### 2.2 异常相关桩

```cpp
static address _forward_exception_entry;               // 编译代码异常回溯
static address _catch_exception_entry;                 // 巨型方法异常捕获
static address _throw_StackOverflowError_entry;        // 栈溢出抛出
static address _throw_delayed_StackOverflowError_entry;// 延迟栈溢出
```

编译代码遇到异常时，跳到 `_forward_exception_entry`，由 forward_exception 桩保存编译帧、跳回 C++ 异常处理器。

### 2.3 原子操作桩

```cpp
static address _atomic_xchg_entry;         // lock xchg  — 原子交换
static address _atomic_xchg_long_entry;
static address _atomic_cmpxchg_entry;      // lock cmpxchg — CAS
static address _atomic_cmpxchg_byte_entry;
static address _atomic_cmpxchg_long_entry;
static address _atomic_add_entry;          // lock add  — 原子加
static address _atomic_add_long_entry;
static address _fence_entry;               // 内存屏障
```

JVM 不能用 C++ 的 `std::atomic`——需要裸 `lock` 前缀指令加精确控制的内存屏障。每个桩只有 3-10 条指令，是 StubRoutines 中最简单的入口。

### 2.4 其他桩（本文不展开）

arraycopy 桩（`_jbyte_arraycopy`、`_jint_arraycopy` 等）、数学 intrinsic（`_dsin`、`_dcos` 等）、CRC 桩（`_updateBytesCRC32`）等——有些由 `initialize2()` 填充，有些根据 JVM 参数条件生成。这些字段的初始化不在本文范围。

---

## 3. 读写流

### 3.1 谁写——StubGenerator，唯一一次

初始化代码（后续文章会讲生成过程）做的是：

```cpp
StubRoutines::_forward_exception_entry = generate_forward_exception();
StubRoutines::_call_stub_entry = generate_call_stub(...);
StubRoutines::_atomic_xchg_entry = generate_atomic_xchg();
// ... 17+ 行赋值
```

每行做两件事：生成一段 x86 机器码，把入口地址填入 StubRoutines。

### 3.2 谁读——JVM 的各个子系统

| 谁读 | 读什么 | 什么时候 |
|------|--------|---------|
| 解释器（`call_helper`） | `call_stub()` | 每次调用 Java 方法 |
| 编译代码 | `forward_exception_entry()` | 异常发生时 |
| JVM 运行时 | `atomic_xchg_entry()` 等 | 需要原子操作时 |
| GC / 栈遍历 | `returns_to_call_stub(addr)` | 扫描线程栈时 |
| `System.arraycopy()` | `jbyte_arraycopy()` 等 | 每次数组拷贝 |

所有读者都通过 `public` 访问器方法（如 `call_stub()`）获取值——不能直接写字段。

---

## 4. 总结

| 知识点 | 解释 |
|--------|------|
| AllStatic | 不能实例化——这张表是全局唯一的，不需要对象 |
| friend class StubGenerator | 只有 StubGenerator 能写字段——init 阶段赋一次值，之后只读 |
| 字段全是 address | `unsigned char*`——指向对应 stub 第一条指令的内存地址 |
| 初始值 | initialize1() 负责的字段全是 NULL（`stubRoutines.cpp:47-71`），执行前不可用 |
| 读取方 | JVM 所有子系统通过 `public` 访问器获取入口点——不能直接写 |

> **关键认知**：StubRoutines 不是复杂的数据结构，不是对象图，没有方法调用链。它就是一张**无锁的全局只读表**——二十多个 `unsigned char*` 字段，每个字段的名字告诉你入口的用途，值告诉你入口在哪块内存中。初始化写一次，之后 JVM 所有组件只读。

**接下来**：`03-bufferblob-create.md` 会解释这些 address 指向的那块内存在哪、怎么分配和管理。
