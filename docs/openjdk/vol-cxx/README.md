# C++ 语法速查

阅读 HotSpot 源码时需要理解的 C++ 语言特性。这是 **速查索引**——每个条目列出 HotSpot 中的真实代码片段，并标注对应「C++ 技术专家学习路线」（[my-openjdk/cpp](https://github.com/LoveEleve/my-openjdk/blob/main/cpp/README.md)）中哪一篇有完整讲解。

> **和 C++ 教程的关系：** 这里不讲全套语法——那是 C++ 教程（37 篇，4 个 stage）的工作。这里只做两件事：告诉你在 HotSpot 源码的第几行看到了什么语法，以及去 C++ 教程的哪一篇补课。

## 已覆盖

### 语言特性层（ch01-ch14）

| 章 | HotSpot 语法点 | 源码位置 | C++ 教程对应章节 |
|----|-------------|---------|---------------|
| 01 | 模板类与模板参数 / 默认模板参数 | `formatBuffer.hpp` FormatBuffer\<bufsz\> | Stage1-1.5 模板与泛型编程 |
| 02 | 嵌套模板类 / StackObj / CHeapObj | `events.hpp` EventLogBase::EventRecord | Stage1-1.1 class与封装（嵌套类） |
| 03 | 构造函数与初始化列表 / 初始化顺序 | `events.hpp` EventLogBase 构造函数 | Stage1-1.2 构造析构与RAII |
| 04 | struct 与 class / 默认访问控制 | `events.hpp` EventRecord / EventLogBase | Stage1-1.1 class与封装 |
| 05 | 虚函数与纯虚函数 / vtable 分发 / 多态 | `events.hpp` EventLog::print_log_on()=0 | Stage1-1.3 继承与虚函数 |
| 06 | RAII 模式 / MutexLockerEx / ResourceMark | `mutexLocker.hpp` MutexLockerEx | Stage1-1.2 构造析构与RAII |
| 07 | 宏与预处理器 / CHECK 宏 / THROW_MSG | `exceptions.hpp` CHECK 宏定义 | Stage3-3.11 JVM头文件必备：宏惯用法 |
| 08 | 可变参数 va_list / jio_vsnprintf | `events.hpp` Events::log() | Stage3-3.11 JVM头文件必备：宏惯用法 |
| 09 | 友元与访问控制 / 双向 friend | `events.hpp` friend class Events | Stage1-1.1 class与封装 |
| 10 | 运算符重载 / operator-> / safe bool | `oopsHierarchy.hpp` oop 类 | Stage1-14 操作符重载实战 |
| 11 | 异常处理与 noexcept / guarantee 宏 | `debug.hpp` guarantee/fatal | Stage3-17 异常处理与异常安全 |
| 12 | 智能指针 / Handle 体系 | `handles.hpp` Handle 类 | Stage0-14 动态内存分配 + Stage1-04 C++11新特性全解 |
| 13 | 移动语义与右值引用 / 完美转发 | `handles.hpp` Handle 类 | Stage1-04 C++11新特性全解 + Stage1-13 引用与const |
| 14 | Lambda 表达式与闭包 / std::function | `gcClosure.hpp` GC Closure | Stage1-04 C++11新特性全解 |

### 对象模型层（ch15-ch17）

| 章 | HotSpot 语法点 | 源码位置 | C++ 教程对应章节 |
|----|-------------|---------|---------------|
| 15 | 对象内存布局 / vtable / padding | `klass.hpp` Klass 类 | Stage2-06 对象内存布局与vtable |
| 16 | 多重继承与虚继承 / RTTI / thunk | `klass.hpp` InstanceKlass 继承链 | Stage2-07 多重继承虚继承RTTI |
| 17 | Rule of 3/5/0 / NRV / placement new | `allocation.hpp` StackObj/CHeapObj | Stage2-08 构造语义与内存管理 |

### 标准库与工程实践层（ch18-ch20）

| 章 | HotSpot 语法点 | 源码位置 | C++ 教程对应章节 |
|----|-------------|---------|---------------|
| 18 | STL 容器与算法 / HotSpot 为什么不用 | `growableArray.hpp` GrowableArray | Stage3-09 STL容器与算法 + Stage3-21 标准库进阶 |
| 19 | C++11 并发 / atomic / 内存序 | `orderAccess.hpp` OrderAccess | Stage3-10 C++并发编程 |
| 20 | 性能优化 / 缓存友好 / 分支预测 | `globalDefinitions.hpp` likely/unlikely | Stage3-11 性能优化实战 |

### 架构全景层（ch21-ch24）

| 章 | HotSpot 语法点 | 源码位置 | C++ 教程对应章节 |
|----|-------------|---------|---------------|
| 21 | 运行时类型识别 / 四种转型 / -fno-rtti | `klass.hpp` layout_helper() | Stage0-12 类型增强与类型转换 + Stage2-07 |
| 22 | C/C++ 互操作 / extern "C" / JNI ABI | `jni.h` JNI 函数表 | Stage3-16 C与C++互操作全解 |
| 23 | 设计模式 / 策略/模板方法/工厂/单例 | `collectedHeap.hpp` BarrierSet | Stage3-18 C++设计模式实现 |
| 24 | JVM 中的 C++ 全景分析（终章） | 全卷知识点串联 | Stage3-12 JVM中的C++全景分析 |

## 卷结构分层

```
基础语法层:    ch01-ch04, ch07-ch08（模板/构造/类/宏/可变参数）
语言特性层:    ch05, ch09-ch14（虚函数/友元/运算符/异常/智能指针/移动/lambda）
内存模型层:    ch15-ch17（对象布局/多重继承/构造语义）
工程实践层:    ch06, ch18-ch20（RAII/STL/并发/性能）
架构全景层:    ch21-ch24（类型系统/C互操作/设计模式/JVM全景）
```

## C++ 教程体系

```
Stage 0 (15篇) ─→ Stage 1 (8篇) ─→ Stage 2 (3篇) ─→ Stage 3 (11篇)
 基础语法          C++11核心          对象模型深度       工程实践
```

> 每篇教程的结构：前置知识检查 → 核心知识 → 底层原理 → JVM 源码实战 → 练习题

## 按章浏览

**语言特性层**
- [ch01 模板类与模板参数](ch01-crypto-type.md)
- [ch02 嵌套模板类](ch02-nested-template.md)
- [ch03 构造函数与初始化列表](ch03-ctor-init-list.md)
- [ch04 struct 与 class](ch04-struct-vs-class.md)
- [ch05 虚函数与纯虚函数](ch05-virtual-inheritance.md)
- [ch06 RAII 模式](ch06-raii.md)
- [ch07 宏与预处理器](ch07-macro.md)
- [ch08 可变参数](ch08-va-list.md)
- [ch09 友元与访问控制](ch09-friend.md)
- [ch10 运算符重载](ch10-operator-overload.md)
- [ch11 异常处理与 noexcept](ch11-exception.md)
- [ch12 智能指针与 Handle 体系](ch12-smart-pointer.md)
- [ch13 移动语义与右值引用](ch13-move-semantics.md)
- [ch14 Lambda 表达式与闭包](ch14-lambda.md)

**对象模型层**
- [ch15 对象内存布局与 vtable](ch15-obj-layout.md)
- [ch16 多重继承、虚继承与 RTTI](ch16-multi-inherit.md)
- [ch17 Rule of 3/5/0 与构造语义](ch17-rule-of-five.md)

**标准库与工程实践层**
- [ch18 STL 容器与算法](ch18-stl.md)
- [ch19 C++11 并发与内存模型](ch19-concurrency.md)
- [ch20 C++ 性能优化](ch20-performance.md)

**架构全景层**
- [ch21 运行时类型识别与 C++ 转型](ch21-runtime-types.md)
- [ch22 C 与 C++ 互操作](ch22-c-interop.md)
- [ch23 C++ 设计模式在 HotSpot 中的实现](ch23-design-patterns.md)
- [ch24 JVM 中的 C++ 全景分析](ch24-jvm-panorama.md)
