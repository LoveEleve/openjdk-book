# 运行时类型识别与 C++ 转型

阅读 HotSpot 源码时你会注意到两件事：第一，C++ 四种 cast 操作符散布在代码各处；第二，JVM 编译时带 `-fno-rtti` 标志——它故意禁用了 `dynamic_cast` 和 `typeid`。本章从这四条操作符出发，深入 RTTI 的内部机制，最终回答"为什么 HotSpot 不依赖 RTTI 却能实现更高效的类型判断"。

## C++ 四种转型操作符

C++ 把 C 语言的一个 `(T)expr` 拆成四种命名操作符，每种有不同的语义限制和危险等级。

### static_cast——编译期安全转换

最常用的 cast，对应编译期可以合理判断的转换：

```cpp
// 1. 基本类型转换（等价于 C 的 (int)d）
double d = 3.14;
int i = static_cast<int>(d);         // 截断小数

// 2. void* → T* 恢复类型
void* vp = &d;
double* dp = static_cast<double*>(vp);

// 3. 向上转型（派生类→基类，安全）
Derived derived;
Base* base = static_cast<Base*>(&derived);

// 4. 显式调用 explicit 构造函数
class Widget { explicit Widget(int size) {} };
Widget w = static_cast<Widget>(10);
```

关键限制：**static_cast 不做运行时类型检查。**以下代码能编译但行为未定义：

```cpp
class Base { virtual ~Base() {} };
class Derived : public Base { public: void extra() {} };
class Other : public Base {};

Base* b = new Other;
Derived* d = static_cast<Derived*>(b);  // 编译通过！
d->extra();                              // 未定义行为——b 实际是 Other
```

C 风格转型 `(T)expr` 的本质是按优先级顺序尝试：static_cast → static_cast+const_cast → reinterpret_cast → reinterpret_cast+const_cast。一条 C cast 可能悄悄做了四次 fallback，副作用难以追踪。这也是 C++ 拆分 cast 的核心动机——让每一条转型的意图和危险等级在代码中可见。

### dynamic_cast——运行时类型检查

专为多态类（有虚函数）的向下转型设计：

```cpp
class Animal { virtual ~Animal() {} };
class Dog : public Animal { void fetch() {} };
class Cat : public Animal { void climb() {} };

void process(Animal* animal) {
    Dog* dog = dynamic_cast<Dog*>(animal);  // 运行时类型检查
    if (dog) {
        dog->fetch();  // 安全——已确认是 Dog
    }
    // 引用版本：失败时抛 std::bad_cast
    try {
        Cat& cat = dynamic_cast<Cat&>(*animal);
        cat.climb();
    } catch (const std::bad_cast& e) { }
}
```

**dynamic_cast 的运行时开销分析：**

```
RTTI 在 vtable 中的布局：

  对象                         虚函数表                         type_info
  ┌───────────┐               ┌────────────────┐            ┌──────────────┐
  │ vptr ──────┼──────────────>│ slot -1: offset │            │ - type_info*  │
  │ data...    │               │ slot -2: type_info* ────────>│ - name()     │
  │ ...        │               │ slot 0:  ~Base  │            │ - before()   │
  └───────────┘               │ slot 1:  speak  │            │ - hash_code()│
                               │ ...             │            └──────────────┘
                               └────────────────┘
```

1. 每个多态类的 vtable 里嵌入一个 `type_info*` 指针（~8 字节）
2. `dynamic_cast<Derived*>(base)` 运行时遍历继承树，对每个基类执行字符串比较
3. 复杂度 **O(继承深度)**——每次比较都需要字符串匹配，比虚函数调用的直接查表慢一个数量级

> *详细讲解参见 C++ 教程: [C++基础-类型增强与类型转换](../../my-openjdk/cpp/stage0-基础语法/C++基础-类型增强与类型转换.md)*

### const_cast——唯一能去除 const 的转型

唯一合法用途：给不接受 `const` 的 C API 传参数：

```cpp
void legacy_c_api(char* str) { printf("legacy: %s\n", str); }

void wrapper(const char* str) {
    legacy_c_api(const_cast<char*>(str));  // 安全前提：API 不会修改 str
}
```

危险示例——修改真正的 const 变量是未定义行为：

```cpp
const int ci = 100;
int* p = const_cast<int*>(&ci);
// *p = 200;  // 未定义行为！ci 可能被放在只读内存段
```

### reinterpret_cast——位级别的重新解释

不做任何类型检查，只把比特位按另一种类型解释：

```cpp
// 合法用途：序列化——把对象看作字节序列
void write_int_to_file(std::ofstream& fs, int value) {
    fs.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

// 正确替代方案：用 intptr_t 保平台中立
int x = 42;
intptr_t addr = reinterpret_cast<intptr_t>(&x);  // 指针→整数
int* px = reinterpret_cast<int*>(addr);           // 整数→指针
```

reinterpret_cast 的风险：平台依赖（32/64位指针大小不同）、对齐问题、违反严格别名规则。HotSpot 中使用 `CAST_TO_FN_PTR` 宏包装这种转换，提供编译期检查。

### 四种 cast 决策表

| 需求 | 正确的 cast | 说明 |
|------|-----------|------|
| 数值类型转换（double→int） | `static_cast` | 编译期安全 |
| 基类指针→派生类指针（需检查） | `dynamic_cast` | 运行时类型检查 |
| void* → T* 恢复类型 | `static_cast` | 编译期安全 |
| 去除 const 调用 C API | `const_cast` | 仅在不修改数据时 |
| 查看对象内存字节表示 | `reinterpret_cast` | 谨慎，注意严格别名 |
| 整数→指针（底层编程） | `reinterpret_cast` | 避免，除非系统编程 |

## RTTI 基础

RTTI（Runtime Type Information）是 C++ 运行时类型识别机制，包含两个核心工具：`typeid` 运算符和 `dynamic_cast`。

### typeid 运算符

```cpp
#include <typeinfo>

class Base { virtual ~Base() {} };
class Derived : public Base {};

Base* pb = new Derived;
std::cout << typeid(*pb).name() << std::endl;  // 输出 "7Derived"（GCC 实现相关）
std::cout << typeid(pb).name() << std::endl;   // 输出 "P4Base"（pb 是 Base*）
```

关键规则：`typeid(*指针)` 对多态类执行运行时查询（查 vtable 中的 type_info），`typeid(指针)` 只返回静态类型。对非多态类，`typeid` 只返回静态类型（因为没有 vtable）。

### type_info 类

```cpp
class type_info {
public:
    virtual ~type_info();
    bool operator==(const type_info& rhs) const;  // 类型相同？
    bool operator!=(const type_info& rhs) const;
    bool before(const type_info& rhs) const;      // 类型排序（实现定义）
    const char* name() const;                     // 类型名（实现定义）
    size_t hash_code() const;                     // 哈希值（C++11）
private:
    type_info(const type_info&) = delete;          // 不可拷贝
};
```

### RTTI 的编译时和运行时开销

```
每个多态类的 type_info 开销（GCC/Clang 实现）：

  type_info 节点结构（典型 ~40-56 字节）：
  ┌──────────────────┐
  │ vptr (8 bytes)   │──→ type_info 的虚函数表
  │ mangled name*    │──→ 类名（如 "7Derived"）  
  │ parent* 指针     │──→ 基类链（用于 before() 排序）
  │ hash 缓存        │
  └──────────────────┘

  HotSpot 有上千个多态类
  → 启动时 type_info 节点初始化 ≈ 上千个 × ~48 字节 = ~50KB+ 纯开销
  → dynamic_cast 热路径上每次调用遍历继承树 + 字符串比较
```

## HotSpot 为什么 `-fno-rtti`

HotSpot 编译时显式关闭 RTTI（`-fno-rtti`），用三个理由说明这项决策：

### 理由 1：启动开销不可接受

JVM 的类体系（Klass 及其 7 个子类、CollectedHeap 族、Compiler 族等）有上千个多态类。如果开启 RTTI，每个类的 type_info 节点在程序启动时初始化——对于 JVM 这种每次启动只为执行几毫秒至几秒用户代码的系统，几千个 type_info 节点的初始化是纯浪费。

### 理由 2：dynamic_cast 在热路径不可接受

虚函数调用的开销是 **2 次指针解引用**（对象→vtable→函数指针），而 dynamic_cast 需要遍历继承树、对每个祖先做字符串比较。在 GC 标记路径、解释器循环、JIT 编译热路径中，这种 O(n) 开销根本不可接受。

### 理由 3：自建类型系统提供 O(1) 替代

HotSpot 不依赖编译器生成的 type_info，而是用自己的虚函数链实现 O(1) 的类型查询：

```cpp
// jdk11u/src/hotspot/share/oops/klass.hpp — 用虚函数替代 dynamic_cast
class Klass : public Metadata {
public:
  // 每个子类重写一个，返回 true，其余返回 false
  virtual bool oop_is_instance()     const { return false; }
  virtual bool oop_is_instanceMirror() const { return false; }
  virtual bool oop_is_instanceRef()  const { return false; }
  virtual bool oop_is_array()        const { return false; }
  virtual bool oop_is_objArray()     const { return false; }
  virtual bool oop_is_typeArray()    const { return false; }
};

// instanceKlass.hpp — InstanceKlass 重写自己的判断函数
class InstanceKlass : public Klass {
public:
  bool oop_is_instance() const { return true; }
};
```

调用 `klass->oop_is_instance()` 是**一次虚函数调用 = 2 次解引用**，时间复杂度 O(1)。而等价的 `dynamic_cast<InstanceKlass*>(klass)` 需要遍历继承树——O(继承深度)。

### HotSpot 的完整替代方案

HotSpot 用三层机制完全替代 RTTI：

**1. Klass::layout_helper() 编码类型信息——O(1) 查询：**

`layout_helper()` 是一个 int32_t 值，将 Klass 的类型编码在比特位中。不需要虚函数调用，直接按位判断。

**2. Metadata 的 is_metadata() / is_klass() / is_method() 虚函数链：**

```cpp
// jdk11u/src/hotspot/share/oops/metadata.hpp
class Metadata : public MetaspaceObj {
public:
  virtual bool is_metadata() const { return true; }
  virtual bool is_klass()    const { return false; }
  virtual bool is_method()   const { return false; }
};

class Klass : public Metadata {
  bool is_klass() const { return true; }
};

class Method : public Metadata {
  bool is_method() const { return true; }
};
```

**3. 自建 kind() 枚举——编译期宏 + 运行时枚举分发：**

```cpp
// klass.hpp
enum KlassKind {
  InstanceKlassKind,
  InstanceRefKlassKind,
  InstanceMirrorKlassKind,
  InstanceClassLoaderKlassKind,
  TypeArrayKlassKind,
  ObjArrayKlassKind
};
```

这三种机制的组合让 HotSpot 在零 RTTI 开销的前提下实现了比 `dynamic_cast` 更高效的类型分发。

> *详细讲解参见 C++ 教程: [JVM中的C++全景分析](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-12-JVM中的C++全景分析.md)*

## GDB 验证：RTTI 开销可视化

用 GDB 可以看到 RTTI 在程序中的实际痕迹：

```bash
$ g++ -std=c++11 -Wall -g -frtti -o rtti_test rtti_test.cpp
$ gdb ./rtti_test

(gdb) info types
# 列出所有 type_info 节点——每个多态类一个

(gdb) ptype Derived
# 显示类型信息——包括基类和虚函数表

(gdb) info symbol 0x5555555580d0
# 查看 type_info 地址在 .rodata 段中的位置
```

对比打开/关闭 RTTI 时的二进制大小差异：

```bash
$ g++ -std=c++11 -fno-rtti -o noretti rtti_test.cpp
$ g++ -std=c++11 -frtti -o withrtti rtti_test.cpp
$ ls -la noretti withrtti
# 30+ 个多态类时，.rodata 段差异可达数 KB
```

对于只有几个多态类的程序，RTTI 开销可以忽略。但对于 HotSpot 这样上千个多态类的系统，累积的 type_info 节点和运行时字符串比较开销就是需要认真对待的设计决策。

## static_cast 和 dynamic_cast 的汇编对比

```bash
$ cat > cast_asm.cpp << 'EOF'
class Base { virtual ~Base() {} };
class Derived : public Base {};

Base* bp = new Derived;

Derived* test_static() {
    return static_cast<Derived*>(bp);   // 向下转型——无运行时检查
}

Derived* test_dynamic() {
    return dynamic_cast<Derived*>(bp);  // 向下转型——运行时检查
}
EOF

$ g++ -std=c++11 -O2 -S -o - cast_asm.cpp
```

关键汇编差异：
- **static_cast 向下转型**：一条 `mov` 指令（纯编译期偏移调整）
- **dynamic_cast 向下转型**：调用 `__dynamic_cast` 运行时函数，涉及 RTTI 查找和字符串比较
- **虚函数调用**：`mov rax, [obj]; call [rax + offset]`——2 次解引用

这就是 HotSpot 用虚函数替代 dynamic_cast 的核心原因——虚函数调用是 2 次解引用，dynamic_cast 是完整遍历+比较，差距在 5 倍以上。

## 四种转型与 HotSpot 实际使用

HotSpot 对四种 cast 的实际偏好：

| cast | HotSpot 使用频率 | 典型场景 |
|------|-----------------|---------|
| `static_cast` | 高 | 数值转换、void*→T*、向上转型 |
| `reinterpret_cast` | 中 | `CAST_TO_FN_PTR`、对象内存查看 |
| `const_cast` | 极低 | 仅在必须兼容 C API 时 |
| `dynamic_cast` | 零 | `-fno-rtti` 编译，不存在此操作 |

HotSpot 中 `CAST_TO_FN_PTR` 宏实际展开为 `reinterpret_cast`：

```cpp
// globalDefinitions.hpp
#define CAST_TO_FN_PTR(func_type, value) \
    reinterpret_cast<func_type>(value)

// 使用：_call_stub_entry 是地址，转为函数指针类型
static CallStub call_stub() {
    return CAST_TO_FN_PTR(CallStub, _call_stub_entry);
}
```

> *详细讲解参见 C++ 教程: [C++关键字精讲](../../my-openjdk/cpp/stage1-C++11基础/C++高级-15-C++关键字精讲.md)（static/const 部分与转型密切相关）*

## 关键自查清单

- [ ] 四种 cast 分别的应用场景和危险等级是什么？
- [ ] static_cast 向下转型为什么不安全？dynamic_cast 如何解决？
- [ ] dynamic_cast 指针版本失败返回 nullptr，引用版本失败抛 std::bad_cast——为什么有这种差异？
- [ ] RTTI 的运行时开销来自哪两个环节？type_info 节点占用多少内存？
- [ ] HotSpot 为什么 -fno-rtti？三个核心理由是什么？
- [ ] HotSpot 用什么机制替代 dynamic_cast？比较两者 O(n) vs O(1) 性能差异？
- [ ] C 风格转型 (T)expr 按什么优先级尝试？为什么应该避免？
- [ ] const_cast 的唯一合法使用场景是什么？修改真正的 const 变量有何后果？
- [ ] reinterpret_cast 在什么情况下合法使用？有哪些平台依赖风险？
- [ ] 能用 GDB 验证 static_cast 和 dynamic_cast 的汇编差异吗？关键区别在哪？
