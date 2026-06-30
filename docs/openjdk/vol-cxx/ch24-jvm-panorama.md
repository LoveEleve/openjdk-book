# JVM 中的 C++ 全景分析

这是 vol-cxx 的终极收官章节。前面 23 章分散地讲解了宏、RAII、虚函数、友元、设计模式等独立知识点——本章将它们串联成一张完整的 JVM C++ 全景地图。读完本章后，你应该能在阅读 HotSpot 任何一行 C++ 代码时，理解它背后的设计决策。

> *详细讲解参见 C++ 教程: [JVM中的C++全景分析](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-12-JVM中的C++全景分析.md)*

## HotSpot 的 C++ 版本选择

HotSpot 的 C++ 版本演进非常保守——主体是 C++98，逐步引入 C++11/14：

| 时间 | JDK 版本 | C++ 标准 | 关键变化 |
|------|---------|---------|---------|
| 1999-2006 | JDK 1.3-6 | C++98 | 主体代码建立，禁用 RTTI/异常/STL |
| 2011 | JDK 7 | C++98 + 部分 C++03 | HotSpot 内部自建替代品成熟 |
| 2014 | JDK 8 | C++98 | Lambda 引入但仅在部分模块中使用 |
| 2017 | JDK 9 | C++11 | -std=c++11 成为默认 |
| 2018 | JDK 11 | C++11 | 开始使用 nullptr、auto、range-for |
| 2021 | JDK 17 | C++14 | constexpr、make_unique 逐步引入 |

**核心原则：逐步现代化但不激进。** `switch` 分发仍优于 `std::function + lambda`，裸指针仍优于 `unique_ptr`（因为 Handle 体系已经提供了更好的 GC 安全方案）。

## HotSpot 不使用异常的完整替代链路

HotSpot 编译时带 `-fno-exceptions`，意味着 `throw`/`try`/`catch` 全部不可用。JVM 必须自己构建错误处理系统，其替代链路是：

```
用户错误/内部错误
  ↓
THROW_MSG / CHECK 宏 ← 异常传播
  ↓
guarantee / assert    ← 条件检查
  ↓
fatal / ShouldNotReachHere  ← 不可恢复错误
  ↓
report_vm_error       ← 错误报告（hs_err 文件）
  ↓
os::abort             ← 进程终止
```

### THROW_MSG 宏——最常用的异常传播

```cpp
// exceptions.hpp
#define THROW_MSG(name, message)                    \
  { Exceptions::_throw_msg(THREAD_AND_LOCATION, name, message); return; }

// 使用
if (bad_condition) {
  THROW_MSG(vmSymbols::java_lang_InternalError(), "bad thing");
}
```

`THROW_MSG` 设置当前线程的待处理异常并立即返回。它不做栈展开——由调用者通过 CHECK 宏逐层检查。

### CHECK 宏——无异常的返回检查

```cpp
// exceptions.hpp
#define CHECK              THREAD); if (HAS_PENDING_EXCEPTION) return       ; (void)(0
#define CHECK_(result)     THREAD); if (HAS_PENDING_EXCEPTION) return result; (void)(0
#define CHECK_0            CHECK_(0)
#define CHECK_NULL         CHECK_(NULL)
#define CHECK_false        CHECK_(false)

// 使用——在函数调用尾部传入
int result = some_function(args, CHECK_0);
// 展开为：
// int result = some_function(args, THREAD);
// if (HAS_PENDING_EXCEPTION) return 0;
```

这个机制的精妙之处在于 `(void)(0`——它吃掉调用者提供的分号，让整条宏展开后始终是一个逻辑单元。

### guarantee / assert / fatal

```cpp
// debug.hpp
#define guarantee(p, ...)  \
  if (!(p)) { report_vm_error(__FILE__, __LINE__, "guarantee(" #p ")", __VA_ARGS__); }

#ifdef ASSERT
#define assert(p, ...)     \
  if (!(p)) { report_assertion_failure(__FILE__, __LINE__, "assert(" #p ")", __VA_ARGS__); }
#else
#define assert(p, ...)     // release 构建中完全消失
#endif

#define fatal(...)         report_fatal(__FILE__, __LINE__, __VA_ARGS__)
```

| 宏 | 生效范围 | 失败行为 |
|----|---------|---------|
| `assert` | Debug only | 报告错误 + 断点 |
| `guarantee` | 所有构建 | 报告 vm error + 终止 |
| `fatal` | 所有构建 | 无条件终止 |
| `ShouldNotReachHere` | Debug only | 断言失败 |

> *详细讲解参见: [ch07 宏体系](../../openjdk/vol-cxx/ch07-macro.md)*

## HotSpot 不使用 STL 的完整替代体系

| STL 组件 | HotSpot 替代品 | 文件位置 |
|---------|---------------|---------|
| `std::vector<T>` | `GrowableArray<T>` | utilities/growableArray.hpp |
| `std::unordered_map` | `Hashtable` / `ResourceHash` | classfile/placeholders.hpp |
| `std::list` | `LinkedList` | utilities/linkedlist.hpp |
| `std::string` | `Symbol` / `const char*` | oops/symbol.hpp |
| `std::queue` | `Queue<T>` | utilities/queue.hpp |
| `std::ostream` | `outputStream` 体系 | utilities/ostream.hpp |
| `std::unique_ptr` | `Handle / HandleMark` | runtime/handles.hpp |
| `std::shared_ptr` | 不需要（GC 追踪替代引用计数） | — |

### GrowableArray——HotSpot 的 vector

```cpp
// utilities/growableArray.hpp
template <typename E> class GrowableArray : public GenericGrowableArray {
  int _len;
  E   _data[0];  // 柔性数组——数据紧跟对象头

public:
  GrowableArray(int initial_size = 2, bool on_C_heap = false);

  int  length() const { return _len; }
  E    at(int i) const { return _data[i]; }
  void push(const E& elem);
  E    pop();
  void appendAll(const GrowableArray<E>* l);
};
```

与 std::vector 对比：GrowableArray 可选 C-heap 或 Arena 分配，vector 只有 C-heap。GrowableArray 的柔性数组成员让对象和数据在连续内存中，减少一次指针跳转。

### Hashtable 和 ResourceHash

```cpp
// classfile/placeholders.hpp
class Hashtable : public BasicHashtable<mtClass> {
  // 自建的哈希表——集成 NMT 追踪
};

// 高性能场景用的 ResourceHash
template<typename K>
class ResourceHashtable : public ResourceObj {
  // Arena 分配的哈希表——批量释放
};
```

## 宏体系全景表

HotSpot 的宏按用途分为 5 类：

### 一、调试宏

| 宏 | 定义 | 作用 |
|----|------|------|
| `guarantee(p, ...)` | `if (!(p)) { report_vm_error(...); }` | 运行时条件检查（release 也生效） |
| `assert(p, ...)` | `#ifdef ASSERT` 有效 | debug 专用条件检查 |
| `fatal(...)` | `report_fatal(...)` | 无条件致命错误 |
| `ShouldNotReachHere()` | `fatal(...)` 包装 | 标记逻辑不可达代码 |
| `ShouldNotCallThis()` | `fatal(...)` 包装 | 标记禁止调用的函数 |

### 二、错误处理宏

| 宏 | 机制 | 作用 |
|----|------|------|
| `THROW_MSG` | 设置 pending exception + return | 异常抛出 |
| `CHECK` / `CHECK_0` / `CHECK_NULL` | 检查 pending exception | 异常传播 |
| `THREAD_AND_LOCATION` | `THREAD, __FILE__, __LINE__` | 错误位置标注 |

### 三、平台抽象宏

| 宏 | 作用 |
|----|------|
| `ATTRIBUTE_PRINTF(fmt, vargs)` | 编译时格式字符串检查 |
| `CAST_TO_FN_PTR` | 安全地将地址转为函数指针 |
| `align_up/size` / `is_aligned` | 跨平台对齐宏 |

### 四、惯用法宏

```cpp
// do-while(0) 包装——让多语句宏安全嵌入 if-else
#define SWAP(a, b) do { auto tmp = a; a = b; b = tmp; } while (0)

// ## 令牌拼接——批量生成平台相关变量
#define define_pd_global(type, name, value) const type pd_##name = value;
```

### 五、特性开关宏

```cpp
#if INCLUDE_G1GC
#define G1GC_ONLY(code) code
#else
#define G1GC_ONLY(code)
#endif

// 同类开关：JVMTI_ONLY、COMPILER1_PRESENT、COMPILER2_PRESENT、
//           LP64_ONLY、ASSERT、DEBUG_ONLY、LINUX_ONLY 等
```

> *详细讲解参见: [ch07 宏与预处理器](../../openjdk/vol-cxx/ch07-macro.md)*

## 静态方法模式

HotSpot 大量使用全局类静态函数胜于对象成员函数。这不是因为程序员不会写成员函数——而是 JVM 的特殊限制：

```cpp
Universe::initialize_heap();          // 堆初始化
ObjectSynchronizer::quick_enter();    // 快速加锁入口
CodeCache::initialize();              // 代码缓存初始化
SymbolTable::create_table();          // 符号表创建
SystemDictionary::resolve_or_null();  // 类型解析
```

### 为什么偏爱静态方法？

**原因 1：NoHeap 限制。** 在 GC 初始化完成之前不能创建 C++ 对象（没有堆可用）。静态方法不需要 this 指针，可以在任何时刻调用。

**原因 2：初始化顺序可控。** 静态方法的执行顺序由调用方控制。成员函数需要先构造对象，而 JVM 启动时的构造顺序极其复杂且不可简单依赖构造器。

**原因 3：单例替代。** `Universe::heap()` 是一个静态方法，返回全局唯一的 `CollectedHeap*`。这比 `CollectedHeap::get_instance()` 更直接——不需要维护 instance 变量和线程安全的初始化。

这种模式的设计哲学是：**JVM 不是一个"程序"而是一个"运行时"——它的模块不是对象，而是子系统。**

## 三种内存分配策略全景

| 分配策略 | 基类 | 内存来源 | 生命周期 | 典型使用者 |
|---------|------|---------|---------|-----------|
| StackObj | `StackObj` | 栈上 | 作用域结束 | MutexLockerEx、ResourceMark、HandleMark |
| CHeapObj | `CHeapObj<mtFlag>` | C malloc | 显式 delete | CollectorPolicy、Compiler、Thread |
| ResourceObj | `ResourceObj` | Arena | ResourceMark 析构 | 临时字符串、临时数组、解析阶段对象 |

### 自动路由机制

```cpp
// 不同基类的 operator new 自动路由到不同分配器

// CHeapObj → C-heap
template <MEMFLAGS F>
void* CHeapObj<F>::operator new(size_t size) throw() {
    return AllocateHeap(size, F);  // → os::malloc
}

// ResourceObj → Arena
void* ResourceObj::operator new(size_t size) throw() {
    return resource_allocate_bytes(size);  // → Arena::Amalloc
}

// StackObj → 栈上（不定义 operator new——new 在 private）
class StackObj {
private:
    void* operator new(size_t) throw();  // 禁止堆分配
};

// MetaspaceObj → Metaspace
void* MetaspaceObj::operator new(size_t size, ClassLoaderData* loader, ...) throw();
```

**StackObj 的设计精妙之处：** 通过将 `operator new` 声明为 `private`，编译器在 `new StackObj` 处直接报错——把"不应该做的事"变成"做不到的事"（ch06 RAII 的核心设计）。

> *详细讲解参见: [ch06 RAII 中的 StackObj 部分](../../openjdk/vol-cxx/ch06-raii.md)*

## Handle 体系全景

### 为什么需要 Handle

Java 对象（oop）可能在 GC 中移动。如果 C++ 代码直接持有裸 oop 指针，GC 移动对象后指针变成悬垂指针。Handle 是解决方案——它通过双重间接引用让 GC 能更新所有引用：

```
线程 → HandleArea → Handle → oop* → Java 对象

   GC 移动对象时：
   1. GC 复制对象到新位置
   2. 更新 Handle 内部的 oop* 指向新地址
   3. Handle 本身不移动
```

### Handle / HandleMark / HandleArea 三层结构

```
线程 (JavaThread)
  ├── _handle_area (HandleArea*)  ← Arena 分配器
  ├── _last_handle_mark           ← HandleMark 链表
  │
  HandleArea (Arena 子类)
  │   - _hwm      水位线
  │   - _chunk    当前 chunk
  │
  HandleMark (RAII 守卫)
  │   - 构造：保存 HandleArea 水位线
  │   - 析构：回滚到保存的水位线
  │
  Handle (oop* 的包装)
  │   - _handle = &oop_in_arena
  │   - operator() 返回 oop
```

### HandleMark 使用模式

```cpp
void function() {
  HandleMark hm(thread);                 // 保存水位线
  Handle h1(thread, some_oop);           // 在 HandleArea 分配
  Handle h2(thread, another_oop);
  // 使用 h1、h2——GC 安全点中可以安全移动 oop
}  // hm 析构：回滚水位线，释放 h1、h2
```

HandleMark 的析构是 **O(1) 的批量释放**——不是逐个 free Handle，而是直接回滚 Arena 水位线。这是 Arena 分配器的核心性能优势。

> *详细讲解参见: [ch06 RAII 中的 HandleMark 部分](../../openjdk/vol-cxx/ch06-raii.md)*

## Klass 层级全景

```
                          Metadata  ← MetaspaceObj（Metaspace 分配）
                             │
                          Klass（抽象基类——定义虚函数接口）
                         ┌───┴───────────┐
                         │               │
                   InstanceKlass      ArrayKlass
                  ┌───┼───┐              ├──────────┐
                  │   │   │              │          │
           Instance  Instance   Instance  TypeArray  ObjArray
           MirrorKlass RefKlass ClassLoader  Klass    Klass
```

| Klass 子类 | 对应 Java 类型 | 特殊行为 |
|-----------|--------------|---------|
| `InstanceKlass` | 普通类（String、HashMap） | 标准实例布局 |
| `InstanceRefKlass` | 引用类型（Soft/Weak/Phantom） | GC 特殊处理 referent 字段 |
| `InstanceMirrorKlass` | Class 对象 | 静态字段存储、`java.lang.Class` |
| `InstanceClassLoaderKlass` | ClassLoader | 维护已加载类列表 |
| `TypeArrayKlass` | 基本类型数组（int[]） | 固定元素大小、无引用遍历 |
| `ObjArrayKlass` | 对象数组（String[]） | 元素是 oop，GC 需遍历 |

oop/klass 二分设计是 HotSpot 的核心架构决策——每个 Java 对象不携带 C++ 虚函数表（节省 8 字节/对象），而是通过 `oop->klass()` 转发到共享的 Klass 实例：

```
  Java 对象 (oop)              Klass 元数据
  ┌──────────────┐            ┌─────────────────┐
  │ mark word    │            │ layout_helper   │
  │ klass* ──────┼───────────>│ name (Symbol*)  │
  │ fields...    │            │ vtable 指针 ───>│ [虚函数表]
  └──────────────┘            │ is_instance()=true│
   无虚函数，轻量              └─────────────────┘
                               有虚函数，C++ 多态分发
```

> *详细讲解参见: [ch09 友元中的 Klass 部分](../../openjdk/vol-cxx/ch09-friend.md)*

## HotSpot 五大 C++ 设计原则

### 1. 零成本抽象

所有 C++ 抽象在优化编译后无运行时开销。`StackObj` 禁止 new 的检查发生在编译期——release 二进制中 `private: operator new` 不占任何空间。虚函数调用虽然比直接调用多 1 次解引用，但这是实现 oop/klass 二分设计必须付出的代价。

### 2. 显式胜于隐式

不依赖隐式转换、隐式析构、隐式异常。`CHECK_0` 明确标注"此调用可能失败"，比 C++ try-catch 的隐式栈展开更符合 JVM 对控制流的精确控制需求。

### 3. 时间换空间

Arena + ResourceMark 模式用极少量内存泄漏（几十毫秒的 STW GC 承受几微秒的 Arena 泄漏）换取 O(1) 的批量释放。TLAB 用每个线程预分配一块 Eden 区域换取无锁分配的性能。

### 4. 编译时验证

用 `=delete` 禁止不合规代码：StackObj 禁止 new/delete，AllStatic 禁止构造/析构，禁止拷贝的 RAII 守卫。这些约束在编译时执行，不产生任何运行时开销。

### 5. 有限现代化

C++11/14 引入遵循"好过旧方案才换"原则。`nullptr` 替代 `NULL`（类型安全），`auto` 减少冗长类型声明，但 `std::function + lambda` 还不替代虚函数分发——因为在 GC 热路径上虚函数表的确定性能优于 function 的类型擦除开销。

## vol-cxx 全景知识图谱

```
    vol-cxx 速查索引卷 —— 24 章完整知识地图
    ═══════════════════════════════════════════════

  基础语法层：C++ 核心语法 + HotSpot 用法
  ┌─────────────────────────────────────────────┐
  │ ch01-ch04        模板、构造、类、继承         │
  │ ch07-ch08        宏与预处理器、可变参数       │
  └─────────────────────────────────────────────┘
                       │
  内存模型层：对象在内存中如何布局
  ┌─────────────────────────────────────────────┐
  │ ch15-ch17        对象布局、继承构造语义       │
  │                  vtable/vptr 底层实现        │
  └─────────────────────────────────────────────┘
                       │
  语言特性层：C++ 的现代特性在 JVM 中的使用
  ┌─────────────────────────────────────────────┐
  │ ch05             虚函数与多态                │
  │ ch09-ch14        友元、运算符重载、异常      │
  │                  智能指针、移动语义、lambda  │
  └─────────────────────────────────────────────┘
                       │
  工程实践层：JVM 用了什么、没用什么、为什么
  ┌─────────────────────────────────────────────┐
  │ ch06             RAII 三件套                 │
  │ ch18-ch20        STL 替代体系、并发编程      │
  │                  性能优化技巧                │
  └─────────────────────────────────────────────┘
                       │
  架构全景层：串起所有知识点
  ┌─────────────────────────────────────────────┐
  │ ch21             运行时类型识别与 C++ 转型   │
  │ ch22             C++ 与 Java/C 互操作        │
  │ ch23             设计模式全景                │
  │ ch24 ★           JVM 中的 C++ 全景分析      │
  └─────────────────────────────────────────────┘
```

每一层依赖上一层——看不懂宏（ch07）就读不懂 CHECK 宏的异常传播（ch24），不理解 RAII（ch06）就无法欣赏 HandleMark 的设计（ch24），不掌握虚函数（ch05）就看不懂 Klass 体系的多态分发（ch24）。

## 关键自查清单

- [ ] HotSpot 的 C++ 版本演进时间线是什么？为什么更新这么保守？
- [ ] HotSpot 禁用了哪些 C++ 特性？每个禁用项的替代方案是什么？
- [ ] THROW_MSG → guarantee → fatal → report_vm_error → os::abort 的完整链路是否清楚？
- [ ] CHECK 宏如何实现异常传播？`(void)(0` 在其中的作用是什么？
- [ ] GrowableArray 替代 std::vector，Hashtable 替代 std::map——它们的核心差异是什么？
- [ ] 五类宏（调试/错误/平台/惯用法/开关）的代表宏和用途是否全部记住？
- [ ] 为什么 HotSpot 大量使用静态方法而非对象成员函数？
- [ ] StackObj / CHeapObj / ResourceObj 的 operator new 分别走到哪个分配器？
- [ ] Handle 的双重间接引用是如何工作的？为什么 GC 需要 Handle？
- [ ] Klass 层级完整结构（Metadata → Klass → InstanceKlass → ...）是什么？
- [ ] oop/klass 二分设计的动机是什么？每个对象节省了多少开销？
- [ ] 五大设计原则（零成本/显式/时空/编译期/有限现代化）各对应哪个具体设计？
- [ ] 能从全景知识图谱中定位任意 C++ 知识点对应的章节吗？
