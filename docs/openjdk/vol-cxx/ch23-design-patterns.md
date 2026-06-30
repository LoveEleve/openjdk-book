# C++ 设计模式在 HotSpot 中的实现

HotSpot 是 GoF 设计模式在 C++ 工业级项目中的最佳展示场。它不是按照教条"套用"模式，而是在解决具体架构问题时自然地选择了这些模式——你用这些模式来读源码，源码验证你对模式的理解。

本章覆盖 HotSpot 中 6 个高频出现的设计模式，每个模式都从 JVM 的真实代码片段出发。

## 单例（Singleton）

### HotSpot 实际代码：Universe

HotSpot 的 `Universe` 类是 GC 堆管理系统的主入口，全局只有一份：

```cpp
// jdk11u/src/hotspot/share/memory/universe.hpp 第 96-150 行
class Universe: AllStatic {
  friend class VMStructs;
  static CollectedHeap* _collectedHeap;
  static Klass* _typeArrayKlassObjs[T_VOID+1];
  static intptr_t _non_oop_bits;
  // ...

public:
  static CollectedHeap* heap() { return _collectedHeap; }
  static Klass* boolArrayKlassObj();
  static Klass* intArrayKlassObj();
  // ...
  static void initialize_heap();
};
```

`Universe` 继承 `AllStatic`——一个将所有构造/析构函数设为 `=delete` 的类，禁止任何实例化：

```cpp
// jdk11u/src/hotspot/share/memory/allocation.hpp
class AllStatic {
private:
  AllStatic()  = delete;
  ~AllStatic() = delete;
};
```

因此 Universe 是"纯静态方法 + 静态数据"的零实例单例——没有对象、没有虚函数表、全局一拍即达。

### 传统懒汉式的线程安全问题

传统 C++ 单例的懒汉实现存在经典的 DCLP（Double-Checked Locking Pattern）问题：

```cpp
// 非线程安全版本
class OldSingleton {
    static OldSingleton* instance_;
    static OldSingleton* get() {
        if (!instance_)                    // 线程 A 读到 null
            instance_ = new OldSingleton;  // 线程 B 也在执行——双重创建！
        return instance_;
    }
};
```

即使加锁，在 C++11 之前也不安全——编译器/CPU 可能重排指令，导致构造未完成就被赋值给 instance_。

### C++11 Magic Statics 方案

C++11 §6.7.4 规定函数内 static 局部变量的初始化是线程安全的（编译器生成隐藏的 guard 变量 + 互斥锁）：

```cpp
class SafeSingleton {
public:
    static SafeSingleton& get() {
        static SafeSingleton instance;  // C++11：编译器保证线程安全
        return instance;
    }
private:
    SafeSingleton() = default;
    SafeSingleton(const SafeSingleton&) = delete;
    SafeSingleton& operator=(const SafeSingleton&) = delete;
};
```

### 为什么 HotSpot 不用 static local？

答案在于 **初始化顺序的确定性**。HotSpot 的 GC 初始化有严格的顺序依赖——`Universe::initialize_heap()` 必须在 Metaspace 初始化之后、klass 注册之前调用。static local 的初始化时机由首次调用点决定，在多版本 GC 配置和多平台环境下可能导致初始化顺序的不确定性。

AllStatic 单例则完全不同——所有静态成员在 `universe_init()` 中**显式初始化**，调用顺序完全受控：

```cpp
// thread.cpp → init_globals()
jint init_globals() {
    // ... 前置模块初始化 ...
    jint status = universe_init();     // 显式初始化 Universe 的静态成员
    if (status != JNI_OK) return status;
    // ... 后续模块依赖 Universe 已初始化 ...
}
```

> *详细讲解参见 C++ 教程: [C++设计模式实现中的 Singleton 部分](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-18-C++设计模式实现.md)*

## 工厂方法（Factory Method）

### GC 算法工厂

HotSpot 中有 6+ 种 GC 实现（Serial/Parallel/G1/CMS/Z/Epsilon）。GC 选择通过工厂方法完成：

```cpp
// jdk11u/src/hotspot/share/gc/shared/gcConfig.cpp 第 46-75 行
GCArguments* GCConfig::arguments() {
  return _gc_arguments;   // 由 select_gc() 设置的工厂产物
}

void GCConfig::select_gc() {
  // 根据 JVM 参数（-XX:+UseG1GC 等）选择 GC
  if (UseZGC) {
    _gc_arguments = new ZArguments();
    return;
  }
  if (UseG1GC) {
    _gc_arguments = new G1Arguments();
    return;
  }
  if (UseParallelGC) {
    _gc_arguments = new ParallelArguments();
    return;
  }
  // 默认 Serial GC
  _gc_arguments = new SerialArguments();
}
```

`GCArguments` 中的 `create_heap()` 是工厂方法的核心——根据选定的 GC 创建正确的 `CollectedHeap` 子类：

```cpp
// jdk11u/src/hotspot/share/gc/shared/gcArguments.hpp 第 33-57 行
class GCArguments {
public:
  virtual CollectedHeap* create_heap() = 0;  // 纯虚工厂方法
  // ...
};

class G1Arguments : public GCArguments {
public:
  CollectedHeap* create_heap() override {
    return new G1CollectedHeap(this);
  }
};
```

### JIT 编译器工厂

HotSpot 的 JIT 编译器同样通过工厂方法创建：

```cpp
// jdk11u/src/hotspot/share/compiler/compileBroker.cpp
void CompileBroker::compilation_init() {
  // C1 编译器工厂
  if (UseCompiler1) {
    _compilers[0] = make_C1();    // 工厂方法
  }
  // C2 编译器工厂
  if (UseCompiler2) {
    _compilers[1] = make_C2();
  }
}

AbstractCompiler* make_C1() {
  return new Compiler();     // C1 客户端编译器
}

AbstractCompiler* make_C2() {
  return new C2Compiler();   // C2 服务端编译器
}
```

C++ 中工厂方法的标准形态是：**返回基类指针（unique_ptr<Base> 或裸指针），具体子类在工厂内部构造，调用者只依赖抽象接口。**

## 策略模式（Strategy）

### BarrierSet——GC 写屏障的策略接口

写屏障是 GC 最核心的性能机制——每次引用写入都要经过屏障检查。不同 GC 有不同的屏障实现：

```cpp
// jdk11u/src/hotspot/share/gc/shared/barrierSet.hpp 第 44-90 行
class BarrierSet : public CHeapObj<mtGC> {
public:
  // 策略接口——各 GC 子类实现
  virtual void write_ref_field_pre(oop* field, oop new_val) {}  // 写前屏障
  virtual void write_ref_array_pre(oop* dst, int length) {}

  // GC 特有行为
  virtual bool is_a(BarrierSet::Name bsn) = 0;  // 判断屏障类型
};
```

具体策略（每个 GC 一个）：

```
BarrierSet（抽象策略接口）
├── CardTableBarrierSet —— CMS/Parallel GC 用卡表标记跨代引用
├── G1BarrierSet —— G1 GC 的 SATB（快照标记）+ 红区屏障
├── ZBarrierSet —— ZGC 的彩色指针屏障（load barrier）
├── ShenandoahBarrierSet —— Shenandoah 的 Brooks 指针屏障
└── ModRefBarrierSet —— Serial GC 的简单记忆集屏障
```

`CardTableBarrierSet` 的核心实现：

```cpp
// barrierSet.inline.hpp
void CardTableBarrierSet::write_ref_field_pre(oop* field, oop new_val) {
  // 在引用写入前，标记跨代引用的卡表条目
  *byte_map_base(card_for(field)) = CardTable::dirty_card_val();
}
```

运行时在 GC 初始化时设置全局 BarrierSet 指针：

```cpp
// universe.cpp → initialize_heap()
BarrierSet* barrier_set = BarrierSet::make_barrier_set();
// 运行时决定使用 CardTableBarrierSet 还是 G1BarrierSet
```

### 与模板方法模式的区别

**策略模式** = 组合 + 接口指针。`CollectedHeap` 持有 `BarrierSet*`，运行时替换屏障策略。

**模板方法模式** = 继承 + 虚函数。基类定义算法骨架，子类实现步骤。

这两个模式在 HotSpot 中各有主场。策略用于需要运行时替换的场景（GC 屏障、编译器选择），模板方法用于算法框架不变的场景（GC 收集流程、CodeBlob 代码块族）。

## 模板方法（Template Method）

### CollectedHeap::collect()——所有 GC 的算法骨架

```cpp
// jdk11u/src/hotspot/share/gc/shared/collectedHeap.hpp 第 49-90 行
class CollectedHeap : public CHeapObj<mtInternal> {
public:
  // 模板方法：GC 入口（算法骨架）
  void collect(GCCause::Cause cause) {
    // 1. 公共前置逻辑
    EventMark m("GC (%s)", GCCause::to_string(cause));

    // 2. 调用具体 GC 的收集实现
    do_collection(cause);     // ← 虚函数——子类实现

    // 3. 公共后置逻辑
    post_collection();
  }

protected:
  // 子类实现具体的 GC 行为
  virtual void do_collection(GCCause::Cause cause) = 0;
  virtual void post_collection() {}
};
```

每个 GC 子类自己实现 `do_collection()`：

```
CollectedHeap::collect()             ← 模板方法（固定框架）
  ├── G1CollectedHeap::do_collection()      ← G1: Region 复制 + 并发标记
  ├── GenCollectedHeap::do_collection()     ← Serial/CMS: 分代收集
  ├── ParallelScavengeHeap::do_collection()  ← Parallel: 并行收集
  ├── ZCollectedHeap::do_collection()        ← ZGC: 彩色指针 + 并发标记
  └── ShenandoahHeap::do_collection()        ← Shenandoah: Brooks 指针
```

模板方法的本质：**基类定义"做什么"的框架，子类实现"怎么做"的细节。**调用者只调 `collect()`，虚函数表自动分发到正确的 GC 实现。

## 适配器（Adapter）

### outputStream 体系——适配不同输出目标

HotSpot 不能使用 `std::ostream`（它依赖全局状态和 C++ 异常），而是自建了 `outputStream` 抽象接口 + 多种具体适配器：

```cpp
// jdk11u/src/hotspot/share/utilities/ostream.hpp 第 50-120 行
class outputStream : public ResourceObj {
public:
  virtual void write(const char* s, size_t len) = 0;
  virtual void flush() = 0;
  // 打印格式化的方法...
  void print_cr(const char* format, ...) ATTRIBUTE_PRINTF(2, 3);
};
```

具体适配器：

```
outputStream（抽象接口）
├── defaultStream / tty    —— 适配 FILE*：stdout/stderr
├── stringStream           —— 适配 char[]：内存缓冲区
├── fileStream             —— 适配 fd：写入文件
├── bufferedStream         —— 适配内存+延迟 flush
├── xmlStream              —— 适配 XML 格式输出
└── networkStream          —— 适配 socket：网络日志
```

每一个子类都把 outputStream 的统一接口"适配"到不同的底层目标：

```cpp
// stringStream —— 把 char[] 适配成 outputStream 接口
class stringStream : public outputStream {
  char* _buffer;
  size_t _written;
  size_t _capacity;
public:
  void write(const char* s, size_t len) override {
    if (_written + len > _capacity) expand(len);
    memcpy(_buffer + _written, s, len);
    _written += len;
  }
  char* as_string() const { return _buffer; }
};
```

HotSpot 中 `tty->print_cr("Hello")` 等价于 `fprintf(stdout, "Hello\n")`，但 tty 可以全局替换为任何 outputStream 子类——比如同时输出到 stdout 和日志文件。

### JNIHandleBlock——JNI 引用到 GC Handle 的适配器

```cpp
// jdk11u/src/hotspot/share/runtime/jniHandles.hpp
class JNIHandleBlock : public CHeapObj<mtInternal> {
  // 适配器：JNI 本地引用（jobject）↔ GC 可追踪的 oop*
  static oop resolve_jobject(jobject handle);
  static jobject make_local(oop obj);
  static jobject make_global(Handle obj);
  static jobject make_weak_global(Handle obj);
};
```

对外暴露 JNI 的 `jobject` 语义，对内转换成 GC 安全点可追踪的 Handle 语义。适配器模式在这里统一了两套不同的引用语义。

## 观察者（Observer）

### VM_Operation 与 SafepointSynchronize

HotSpot 的 VM_Operation 体系实现了一种强约束的观察者模式——VM 操作在安全点被调度执行：

```cpp
// jdk11u/src/hotspot/share/runtime/vmOperations.hpp 第 45-90 行
class VM_Operation : public CHeapObj<mtInternal> {
public:
  enum Mode {
    _safepoint,      // 需要全局安全点
    _no_safepoint,   // 不需要安全点
    _concurrent,     // 可并发执行
    _async_safepoint // 异步安全点
  };

  virtual void doit() = 0;       // 核心操作——各子类实现
  virtual bool doit_prologue() { return true; }   // 前置检查
  virtual bool doit_epilogue()  { return true; }  // 后置清理
  virtual const char* name() const = 0;

  // 调度时自动通知 VMThread
  void evaluate();
};

// 具体操作示例
class VM_GC_Operation : public VM_Operation {
  GCCause::Cause _cause;
  void doit() override {
    // GC 操作的具体实现
  }
};

class VM_PrintThreads : public VM_Operation {
  void doit() override {
    // 打印所有线程栈
  }
};
```

`SafepointSynchronize::begin()` 和 `SafepointSynchronize::end()` 扮演"发布者"角色——当安全点同步完成时通知所有等待的 VM 操作执行。

### GC Notification——GC 事件通知

```cpp
// jdk11u/src/hotspot/share/gc/shared/gcVMOperations.hpp
class VM_GC_Operation : public VM_Operation {
  void notify_gc_begin();
  void notify_gc_end();
};

// 通知链
void VM_GC_Operation::notify_gc_begin() {
  // 1. JFR 事件记录
  // 2. GC 日志输出
  // 3. JMX 通知
  // 4. PerfData 计数器更新
}
```

### JFR Events——Java 飞行记录器

JFR（Java Flight Recorder）是 HotSpot 的事件订阅系统：

```cpp
// jdk11u/src/hotspot/share/jfr/periodic/jfrThreadDumpEvent.cpp
class EventThreadDump : public JfrEvent {
  static void send_thread_dump_event() {
    // 向所有订阅者发布线程转储事件
  }
};
```

HotSpot 中 PerfData 计数器是"简陋版观察者"——不通过事件驱动，而是外部工具（jstat、jconsole）定期轮询共享内存中的计数器值。在 C++ 层面没有注册-回调机制，但 Java 层的 `java.lang.management` API 封装了定期轮询 + 变更通知的语义。

## HotSpot 设计模式总结表

| 模式 | 出现频率 | 关键类 | 设计偏好 |
|------|---------|--------|---------|
| 单例 | 极少 | Universe (AllStatic) | 全局变量替代，不用 static local |
| 工厂方法 | 广泛 | GCArguments、make_C1/C2 | allocator 类族、GC/JIT 选择 |
| 策略 | 核心 | BarrierSet 族、Compiler 族 | 运行时替换实现，通过全局指针 |
| 模板方法 | 主导 | CollectedHeap、CodeBlob | 继承 + 虚函数，算法框架固定 |
| 适配器 | 普遍 | outputStream 族、JNIHandles | 统一接口适配不同底层 |
| 观察者 | 中等 | VM_Operation、JFR Events | 安全点驱动的事件系统 |

HotSpot 的设计模式偏好非常清晰：
- **继承 + 虚函数** 是首选——Klass 体系、CollectedHeap 族、Compiler 族全部走这条路
- **组合 + 策略注入** 用于需要运行时替换的场景——BarrierSet、GCArguments
- **宏替代模板** 在需要批量代码生成处——宏比模板更可控（见 ch07 宏章节）
- **单例极少**——全局静态函数 + AllStatic 类在 JVM 中扮演了单例角色，但比传统单例更高效

> *详细讲解参见 C++ 教程: [C++设计模式实现](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-18-C++设计模式实现.md)*

## 关键自查清单

- [ ] HotSpot 的 Universe 用什么方式实现了单例？为什么不用 C++11 Magic Statics？
- [ ] GCArguments::create_heap() 是哪种设计模式？它解决了什么问题？
- [ ] BarrierSet 体系如何体现策略模式？运行时怎样切换策略？
- [ ] CollectedHeap::collect() 是模板方法模式——基类做了什么？子类做了什么？
- [ ] outputStream 有哪几种具体适配器？各自适配什么底层目标？
- [ ] 策略模式用组合+接口指针，模板方法用继承+虚函数——两者在 HotSpot 中各有什么主场？
- [ ] VM_Operation::doit() 是哪种模式的体现？SafepointSynchronize 在其中扮演什么角色？
- [ ] JNIHandleBlock 为什么是适配器？它适配了哪两套语义？
- [ ] 六种模式在 HotSpot 中的出现频率排序是什么？为什么单例最少？
- [ ] 能用 GDB 验证虚函数调用（模板方法）和策略注入（BarrierSet::write_ref_field_pre）的调用链差异吗？
