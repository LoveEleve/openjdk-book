# C++ 语法速查

阅读 HotSpot 源码时需要理解的 C++ 语言特性。按在 vol-01 中首次出现的顺序排列。

> 每一篇只讲源码中真实出现的语法，不讲教科书里的完整定义。这是速查手册——读完一段源码看不懂某行 C++ 语法时，回到这里查。

## 已覆盖

| 章 | 内容 | 首次出现在 |
|----|------|-----------|
| 01 | 模板类与模板参数 / 默认模板参数 / 内联与类外定义 | vol-01 ch03 eventlog_init |
| 02 | 嵌套模板类 / StackObj / CHeapObj | vol-01 ch03 eventlog_init |
| 03 | 构造函数与初始化列表 / 初始化顺序 | vol-01 ch03 eventlog_init |
| 04 | struct 与 class / 默认访问控制 | vol-01 ch03 eventlog_init |
| 05 | 虚函数与纯虚函数详解 / vtable 分发 / 多态 | vol-01 ch03 eventlog_init |
| 06 | RAII 模式 / MutexLockerEx / ResourceMark / HandleMark / StackObj | vol-01 ch03 eventlog_init |
| 07 | 宏与预处理器 / CHECK 宏 / THROW_MSG / #ifdef ASSERT | vol-01 ch03 eventlog_init |
| 08 | 可变参数 (va_list / ...) / jio_vsnprintf / ATTRIBUTE_PRINTF | vol-01 ch03 eventlog_init |
| 09 | 友元与访问控制详解 / 双向 friend / private 继承 | vol-01 ch03 eventlog_init |
