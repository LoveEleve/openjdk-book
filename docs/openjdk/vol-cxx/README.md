# C++ 语法速查

阅读 HotSpot 源码时需要理解的 C++ 语言特性。这是 **速查索引**——每个条目列出 HotSpot 中的真实代码片段，并标注对应「C++ 技术专家学习路线」（[my-openjdk/cpp](https://github.com/LoveEleve/my-openjdk/blob/main/cpp/README.md)）中哪一篇有完整讲解。

> **和 C++ 教程的关系：** 这里不讲全套语法——那是 C++ 教程（37 篇，4 个 stage）的工作。这里只做两件事：告诉你在 HotSpot 源码的第几行看到了什么语法，以及去 C++ 教程的哪一篇补课。

## 已覆盖

| 章 | HotSpot 语法点 | 源码位置 | C++ 教程对应章节 |
|----|-------------|---------|---------------|
| 01 | 模板类与模板参数 / 默认模板参数 | `formatBuffer.hpp` FormatBuffer\<bufsz\> | Stage1-1.5 模板与泛型编程 |
| 02 | 嵌套模板类 / StackObj / CHeapObj | `events.hpp` EventLogBase::EventRecord | Stage1-1.1 class与封装（嵌套类） |
| 03 | 构造函数与初始化列表 / 初始化顺序 | `events.hpp` EventLogBase 构造函数 | Stage1-1.2 构造析构与RAII |
| 04 | struct 与 class / 默认访问控制 | `events.hpp` EventRecord / EventLogBase | Stage1-1.1 class与封装 |
| 05 | 虚函数与纯虚函数 / vtable 分发 / 多态 | `events.hpp` EventLog::print_log_on()=0 | Stage1-1.3 继承与虚函数 |
| 06 | RAII 模式 / MutexLockerEx / ResourceMark | `mutexLocker.hpp` MutexLockerEx | Stage1-1.2 构造析构与RAII |
| 07 | 宏与预处理器 / CHECK 宏 / THROW_MSG | `exceptions.hpp` CHECK 宏定义 | Stage3-3.11 JVM头文件必备：前置声明与宏惯用法 |
| 08 | 可变参数 va_list / jio_vsnprintf | `events.hpp` Events::log() | Stage3-3.11 JVM头文件必备：宏惯用法 |
| 09 | 友元与访问控制 / 双向 friend | `events.hpp` friend class Events | Stage1-1.1 class与封装 |
| 10 | 运算符重载 / operator-> / safe bool | `oopsHierarchy.hpp` oop 类 | Stage1-14 操作符重载实战 |
| 11 | 异常处理与 noexcept / guarantee 宏 | `debug.hpp` guarantee/fatal | Stage3-17 异常处理与异常安全 |
| 13 | 移动语义与右值引用 / 完美转发 | `handles.hpp` Handle 类 | Stage1-04 C++11新特性全解 |

## C++ 教程体系

```
Stage 0 (15篇) ─→ Stage 1 (8篇) ─→ Stage 2 (3篇) ─→ Stage 3 (11篇)
 基础语法          C++11核心          对象模型深度       工程实践
```

> 每篇教程的结构：前置知识检查 → 核心知识 → 底层原理 → JVM 源码实战 → 练习题

## 按章浏览

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
- [ch13 移动语义与右值引用](ch13-move-semantics.md)
