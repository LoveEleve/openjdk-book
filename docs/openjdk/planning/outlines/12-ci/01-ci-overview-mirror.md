# 01. ciObject 镜像体系 — JIT 怎么看到 Java 类？

> 🔴 Deep | 11 KP 中的 3 个核心机制
> 读者处境: C2 编译 `String.length()`——它需要知道 String 的 `value` 字段在哪 (offset)。不能直接读 InstanceKlass——多了 C++ 虚函数和锁。ci 层是纯净的编译器镜像。

### 1. ci 层是什么 — 为什么需要镜像？

场景: JIT 编译器 (C1/C2) 运行在 safepoint 中——它需要读 Klass/Method/Field 的元数据——但 Klass 是 C++ 虚基类——每次 `klass->is_interface()` 是虚函数 dispatch。**编译器中大量重复调用——虚函数开销不可接受。且 Klass 可能被 GC 改变 (class redefine)。**

**ciObject 镜像** (`ciObject.hpp + ciKlass.hpp + ciMethod.hpp`):
- ciKlass: Klass 的编译器镜像——is_interface() 是普通 inline 方法——在 ciKlass 构造时一次性从 Klass 读取——存为 bool——后续全部 inline 查
- ciMethod: 方法镜像——bytecode/exception handler/vtable index——ciMethod 构造时一次性提取
- ciField: 字段镜像——offset/type/is_volatile/constant value——存为简单值
- [C++: ciObject 不是 oop——是 C2 的 C++ 对象——不需要 GC 扫描。在编译的 safepoint 中创建——编译后随 ciEnv destroy 释放。与 Klass 无继承关系——是纯数据 copy——零虚函数]
- [C++: ciObjectFactory 持有 `oop→ciObject` 映射——`GrowableArray<ciObject*>`。所以同一个 Klass 在多次编译中——总是返回同一个 ciKlass——`ciObjectFactory::get_metadata(klass)`→lookup→如果已有→return；没有→create ciKlass

### 2. ciKlass + ciMethod — 编译器的数据视图

**ciKlass** (`ciKlass.hpp.cpp` + `ciInstanceKlass.hpp.cpp`):
- `ciKlass::is_subtype_of(ciKlass* other)`: super class check——在 ci 层做——不调 Klass 虚函数——查缓存 subtype list
- `ciInstanceKlass::unique_concrete_method(ciMethod*)`: DFA (Dynamic Frequent Access)——在子类中查找单个具体实现的虚方法——inline 的前提
- [C++: DFA——若一个 interface 方法在所有子类中只有一个实现——可以 devirtualize 为 direct call——跳过 vtable。ciKlass 的 `_implementors` 列表记录——构造时从 SystemDictionary::find 获取]

**ciMethod** (`ciMethod.hpp.cpp`):
- `method_data()`: 返回 ciMethodData——MDO 的编译器端——invocation_counter/backedge_counter——决定编译层次
- `blocks()`: ciMethodBlocks——bytecode 基本块——从 bytecode 构建 CFG——ciTypeFlow 输入
- `instructions_size()`: Method 的 bytecode 长度——C2 的编译规模估算 (size_threshold)
- [C++: `ciMethod::is_c1_compilable()` / `is_c2_compilable()`——检查方法大小、MDO profiling 是否充足——返回 true→加入编译队列。ciMethod 构造时从 Method 一次性提取——后续编译中 CI 只查 ciMethod——不回头查 Method]

**ciField** (`ciField.hpp.cpp`):
- `is_constant()`: 字段是否 final+static——JIT 可以直接用常量值替代 field access
- `constant_value()`: 常量的 ciConstant——int/float/String/Class
- [C++: `ciField::will_link(method, bci)`——检查字段是否有链接错误 (NoSuchFieldError/IllegalAccessError)——预检——避免 JIT 编译后才发现链接失败——浪费编译]

---

### 核心悬念

**"C2 编译 `String.length()`——需要 value 字段 offset (is_constant=false)——ciField 在构造时一次性从 InstanceKlass::FieldInfo 提取 offset→存为 int→后续全部 inline 读——零虚函数、零锁、零 GC 干扰。"** — ciObjectFactory 缓存所有 ciObject——同一个 Klass 多次编译——返回同一个 ciKlass——减少镜像创建开销。下一个: ciTypeFlow——C2 怎么从字节码推导类型。

> → [02-ci-typeflow-escape.md](02-ci-typeflow-escape.md)
