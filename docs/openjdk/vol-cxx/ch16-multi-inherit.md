# 多重继承、虚继承与 RTTI

HotSpot 的 Metadata 层级从一个普通的 `Metadata` 根类出发，经过 `MetaspaceObj` 再到具体的 `Klass`。Klass 自身更有 `InstanceKlass → InstanceRefKlass` 等六层继承。尽管 HotSpot **刻意避免 C++ 多重继承**，但理解多重/virtual 继承的内存影响对于理解 JVM 为何这样设计至关重要——这不是"学了没用的语法"，而是"知道代价才理解设计决策"。

## HotSpot 源码切入点：Metadata 的单继承链

```cpp
// jdk11u-copy/src/hotspot/share/oops/klass.hpp 第 78 行
class Klass : public Metadata { ... };

// jdk11u-copy/src/hotspot/share/oops/instanceKlass.hpp 第 86 行
class InstanceKlass : public Klass { ... };

// 继承链（全部是单继承）：
// Metadata → MetaspaceObj → ConstantPool
// Metadata → Klass → InstanceKlass → InstanceRefKlass
```

HotSpot 的类层次全部使用**单继承**。注释（`klass.hpp:172`）说 `Klass` 通过 `_layout_helper` 字段区分 7 种子类——这是 JVM 自建的 O(1) 类型判断，替代了 C++ 的 `dynamic_cast`（O(n) 遍历继承树）。为什么 JVM 团队宁可手动实现类型标记也不依赖 C++ RTTI？读完本章你就知道答案。

## 多继承下的对象布局：每个基类子对象一个 vptr

```cpp
class Base1 {
public:
    int b1_data = 0x11111111;
    virtual void f1() { }
    virtual ~Base1() = default;
};

class Base2 {
public:
    int b2_data = 0x22222222;
    virtual void f2() { }
    virtual ~Base2() = default;
};

class Derived : public Base1, public Base2 {
public:
    int d_data = 0x33333333;
    void f1() override { }
    void f2() override { }
};
```

**Derived 对象内存布局（x86_64）：**

```
低地址
┌─────────────────────┐ ← &d = Base1* = Derived*  (所有指向同一地址)
│  vptr_Base1         │  8 bytes → 指向 Base1 的 vtable（Derived 版本）
├─────────────────────┤  offset 8
│  b1_data = 0x1111.. │  4 bytes
├─────────────────────┤
│  padding            │  4 bytes  ← 对齐到 8 字节
├─────────────────────┤  offset 16 ← = sizeof(Base1)
│  vptr_Base2         │  8 bytes → 指向 Base2 的 vtable（Derived 版本）
├─────────────────────┤  offset 24
│  b2_data = 0x2222.. │  4 bytes
├─────────────────────┤
│  d_data  = 0x3333.. │  4 bytes
├─────────────────────┤
│  padding            │  4 bytes  ← 尾部对齐
└─────────────────────┘

sizeof(Derived) = 8+4+4 + 8+4+4 + 4 = 40 字节
```

**核心发现：**
- 基类按声明顺序排列：`class Derived : public Base1, public Base2` → Base1 在前
- 每个有虚函数的基类保留自己的 vptr：Derived 内部有**两个** vptr
- 基类子对象严格嵌入——不是"合并成一个大对象"，是整体嵌入

## this 指针调整（thunk 机制）

```cpp
Derived d;
Base1* pb1 = &d;   // pb1 = &d（无须调整，Base1 在偏移 0）
Base2* pb2 = &d;   // pb2 = (Base2*)((char*)&d + sizeof(Base1))
                   //      = &d + 16 字节  ← 编译期计算偏移
```

当通过 `Base2*` 调用 `f2()` 时，`this` 指向的是 Base2 子对象（偏移 16 处），但 `Derived::f2()` 的实现可能访问 `d_data`（需要 this 指向派生类起始地址）。

**解决方案：thunk（跳板函数）。** 编译器在 Base2 的 vtable 中不放 `&Derived::f2()`，而是放一个 thunk 的地址：

```asm
; thunk to Derived::f2 —— 在 Base2 的 vtable slot 0 中
thunk_to_Derived_f2:
    sub  rdi, 16        ; this -= sizeof(Base1)，调整到 Derived 起始
    jmp  Derived::f2    ; 跳到真正实现
```

完整调用链：

```
pb2->f2()
  → 读 pb2->vptr → Base2 vtable[0]
  → vtable[0] = thunk_to_Derived_f2
  → thunk: sub rdi, 16  (调整 this)
  → jmp Derived::f2     (this 已指向 Derived 起始)
```

**vtable 的 offset_to_top：**

```
Base1 视角的 vtable:                Base2 视角的 vtable:
┌──────────────────────────┐       ┌──────────────────────────┐
│ offset_to_top = 0        │       │ offset_to_top = -16      │ ← this 到完整对象顶部的偏移
├──────────────────────────┤       ├──────────────────────────┤
│ type_info(Derived)       │       │ type_info(Derived)       │
├──────────────────────────┤       ├──────────────────────────┤
│ &Derived::f1             │       │ &thunk → Derived::f2     │ ← thunk 而非直接指针
├──────────────────────────┤       ├──────────────────────────┤
│ &Derived::~Derived       │       │ &thunk → ~Derived        │
└──────────────────────────┘       └──────────────────────────┘
```

**汇编验证 thunk：**

```bash
$ g++ -std=c++17 -g -O0 -S -o mi_layout.s mi_layout.cpp
$ grep -A 3 "thunk" mi_layout.s
# 或
$ objdump -d mi_layout | grep -A 5 "sub.*rdi.*0x10"
```

## 菱形继承问题与虚继承

普通多继承中，如果两个基类来自同一祖先，派生类会出现**两份**祖先子对象：

```cpp
class Animal { int age_; virtual void speak() = 0; };

class Mammal : public Animal { int fur_color_; };
class Bird   : public Animal { int wingspan_; };

class Platypus : public Mammal, public Bird { };

// Platypus 中有两份 age_！一份在 Mammal::Animal，一份在 Bird::Animal
// Animal* pa = &p;  // 编译错误！ambiguous——两个合法的 Animal 子对象
```

**虚继承解决：** 用 `virtual` 关键字让所有路径共享同一个虚基类子对象。

```cpp
class Mammal : virtual public Animal { ... };
class Bird   : virtual public Animal { ... };
class Platypus : public Mammal, public Bird { ... };
```

**虚继承后的对象布局（GCC/Clang, x86_64）：**

```
低地址
┌──────────────────────┐ ← &p, Mammal*
│  vptr_Mammal         │ 8 bytes  → Mammal 的 vtable
├──────────────────────┤
│  vbptr_Mammal ───────┼──→ Mammal 虚基类偏移表
│                      │    ┌──────────────────┐
│                      │    │ offset_to_Animal │  ← 指向末尾的 Animal
│                      │    └──────────────────┘
├──────────────────────┤
│  fur_color_          │ 4 bytes
├──────────────────────┤
│  padding             │ 4 bytes
├──────────────────────┤  ← Bird* (偏移 16)
│  vptr_Bird           │ 8 bytes  → Bird 的 vtable
├──────────────────────┤
│  vbptr_Bird ─────────┼──→ Bird 虚基类偏移表
│                      │    ┌──────────────────┐
│                      │    │ offset_to_Animal │  ← 指向末尾的 Animal
│                      │    └──────────────────┘
├──────────────────────┤
│  wingspan_           │ 4 bytes
├──────────────────────┤
│  beak_length_ (新增)  │ 4 bytes
├──────────────────────┤ ← Animal* (偏移 32，唯一一份)
│  vptr_Animal         │ 8 bytes
├──────────────────────┤
│  age_                │ 4 bytes
├──────────────────────┤
│  padding             │ 4 bytes
└──────────────────────┘

sizeof(Platypus) = 48 字节
```

**关键特征：**
- 虚基类 Animal 放在对象**末尾**（不是开头）
- Mammal 和 Bird 各有一个 **vbptr**（Virtual Base Pointer），指向各自的偏移表
- 访问 Animal 成员需要：读 vbptr → 读偏移量 → `this + offset` → 访问（2-3 条指令，普通继承只需 1 条）

**虚继承开销对比：**

| | 普通多继承 | 虚继承 |
|---|---|---|
| 基类子对象数 | 每路径一份（重复） | 共享一份 |
| 额外指针 | 无 | 每虚继承路径一个 vbptr (8B) |
| 访问虚基类成员 | `mov [this+8], val` | `mov rax, vbptr; add rax, [rax]; mov [this+rax+8], val` |
| 构造语义 | 直接基类构造 | 最派生类负责构造 |

**虚继承构造语义：** 虚基类必须由**最派生类**负责构造。在 `Platypus` 的构造函数中，编译器插入代码构造 `Animal`——`Mammal` 和 `Bird` 的构造函数中对 `Animal` 的初始化参数**被忽略**。这是编译器的隐式行为，不注意就会导致初始化值不符合预期。

## dynamic_cast 实现原理

`dynamic_cast` 是 C++ 唯一的**运行时类型安全转换**。底层的实现依赖 vtable 中的 type_info：

```
dynamic_cast<Derived*>(base_ptr):
  → 读取 base_ptr 指向对象的 vptr
  → 访问 vptr[-1] = type_info 指针
  → 比较 type_info 是否匹配目标类型
  → 不匹配？遍历继承树向上搜索（通过 vtable 中的基类信息）
  → 找到后通过 offset_to_top 计算指针调整量
  → 找不到？返回 nullptr（指针版）或抛 std::bad_cast（引用版）
```

**性能：** `dynamic_cast` 是 O(n)，n = 继承深度和广度。HotSpot 的 `_layout_helper` 则是 O(1) 整数比较：

```cpp
// HotSpot 自建类型判断（klass.hpp:245-248）
bool Klass::is_instance_klass() const {
  return layout_helper() < 1;   // O(1) 整数比较
}

// 对比 C++ RTTI 方案（O(n) 遍历继承树）
// bool is_instance = dynamic_cast<InstanceKlass*>(k) != nullptr;
```

这就是为什么 JVM 团队选择自建类型系统而不是用 `dynamic_cast`——在类加载验证路径和 GC 标记阶段，每微秒都重要。

## typeid 的实现

`typeid(*ptr)` 获取运行时类型信息同样依赖 vtable：

```
typeid(*ptr):
  → 解引用 ptr 获取对象
  → 读对象偏移 0 处的 vptr
  → 访问 vptr[-1] = &type_info
  → 返回 type_info 引用
```

**关键：** `typeid` 只对**多态类型**（有虚函数的类）进行运行时查询。对非多态类型，`typeid` 返回的是**静态类型**——编译器在编译期就决定了。

```cpp
class NonPoly { };                // 无虚函数 → 非多态
NonPoly* np = new NonPoly();
typeid(*np).name();               // 返回 "NonPoly"（静态类型，不查 vtable）
typeid(np).name();                // 返回 "NonPoly*"（指针的静态类型）

class Poly { virtual ~Poly() = default; };
Poly* pp = new Poly();
typeid(*pp).name();               // 运行时查 vtable → 返回 "Poly"
```

**name() 的 mangling：** GCC 的 `type_info::name()` 返回 mangled name，用 `c++filt -t` 解码：

```bash
$ echo "_Z7Derived" | c++filt -t
Derived
```

**RTTI 开销：** 每个多态类增加一个 type_info 指针（8 字节在 vtable[-1]）。`dynamic_cast` 的运行时开销来自遍历继承树——链表式结构中最多 O(n)，虚继承中涉及 DAG 遍历。

## sizeof 陷阱：多继承下不可加性

```cpp
class A { virtual void f() { } int a; };    // sizeof = 16 (vptr 8 + a 4 + pad)
class B { virtual void g() { } int b; };    // sizeof = 16
class C : public A, public B { int c; };    // sizeof = 40
// 40 ≠ 16 + 16 + 4 = 36 → 每个基类有独立 vptr，不共享
```

**多态数组遍历陷阱（最常见 bug）：**

```cpp
Derived arr[3];                           // arr[0], arr[1], arr[2] 各 24 字节
Base* p = arr;                             // 隐式向上转型

// p + 1 = (char*)p + sizeof(Base)  = p + 16 字节
// 但 arr[1] 实际在 p + 24 字节处！
// p[1] 指向了 arr[0] 内部垃圾位置 → 未定义行为
// sizeof(*p) = sizeof(Base) = 16（编译期静态类型，不是实际的 24）
```

正确做法：用 `std::vector<Base*>` 存储指针数组，而非基类指针指向派生类数组。

## GDB 验证多继承和 RTTI

测试代码 `mi_layout.cpp`：

```cpp
class Base1 {
public:
    int b1_data = 0x11111111;
    virtual void f1() { printf("Base1::f1, this=%p\n", this); }
    virtual ~Base1() = default;
};

class Base2 {
public:
    int b2_data = 0x22222222;
    virtual void f2() { printf("Base2::f2, this=%p\n", this); }
    virtual ~Base2() = default;
};

class Derived : public Base1, public Base2 {
public:
    int d_data = 0x33333333;
    void f1() override { printf("Derived::f1, this=%p\n", this); }
    void f2() override { printf("Derived::f2, this=%p\n", this); }
};
```

**GDB 验证步骤：**

```bash
$ g++ -std=c++17 -g -O0 -o mi_layout mi_layout.cpp
$ gdb ./mi_layout

(gdb) p sizeof(Derived)
$1 = 40

# 逐字节查看对象内存
(gdb) p/x &d
$2 = 0x7fffffffe0a0

(gdb) x/5gx 0x7fffffffe0a0
0x7fffffffe0a0: 0x0000555555557d70  ← vptr_Base1
0x7fffffffe0a8: 0x0000000011111111  ← b1_data (4B) + padding (4B)
0x7fffffffe0b0: 0x0000555555557db0  ← vptr_Base2
0x7fffffffe0b8: 0x3333333322222222  ← b2_data(低4) + d_data(高4)
0x7fffffffe0c0: 0x0000000000000000  ← padding

# 验证 this 指针调整（编译期）
(gdb) p (Derived*)0x7fffffffe0a0
$3 = (Derived *) 0x7fffffffe0a0

(gdb) p (Base2*)0x7fffffffe0a0       # 编译器自动计算偏移
$4 = (Base2 *) 0x7fffffffe0b0         # = 0x7fffffffe0a0 + 16

# 查看两个 vtable
(gdb) info vtbl d
# 显示所有 vtable 条目，包括 thunk 信息

# 查看 Base2 vtable 中的 offset_to_top
(gdb) x/3gx *(void**)0x7fffffffe0b0  # 从 vptr_Base2 指向的 vtable[0] 开始
# vtable[-2] = offset_to_top (应为负值)
(gdb) p/x *(long*)(*(void**)0x7fffffffe0b0 - 16)
# 输出 -16（从 Base2 子对象到完整对象顶部的偏移）

# 验证虚函数调用时的 thunk
(gdb) break 'Derived::f2()'
(gdb) continue
# 当 pb2->f2() 进入断点时
(gdb) p this
$5 = (Derived * const) 0x7fffffffe0a0  ← this 已被 thunk 调整回 Derived 起始

# 验证 dynamic_cast 实现
(gdb) break __dynamic_cast
(gdb) continue
# 进入 GCC 的 __dynamic_cast 内部实现观察遍历过程

# 查看 type_info
(gdb) p typeid(*pb1).name()
$6 = "7Derived"                       # mangled name

# 零地址技巧查看成员偏移
(gdb) p &((Derived*)0)->b1_data
$7 = (int *) 0x8                      # b1_data 在 this+8
(gdb) p &((Derived*)0)->b2_data
$8 = (int *) 0x18                     # b2_data 在 this+24（跳过 Base1）
(gdb) p &((Base2*)0)->b2_data
$9 = (int *) 0x8                      # Base2 视角：b2_data 在 +8（偏移不变）
```

**查看编译器类层次：**

```bash
$ g++ -std=c++17 -fdump-class-hierarchy -c mi_layout.cpp
$ cat mi_layout.cpp.*.class
# 输出每个 vtable 的条目、offset_to_top、基类列表
```

## HotSpot 为何刻意避免 C++ 多重继承

回顾 HotSpot 的继承链设计：

| 类层次 | 设计 | 原因 |
|--------|------|------|
| Metadata → MetaspaceObj → ConstantPool | 单继承 | 可控的内存布局 |
| Metadata → Klass → InstanceKlass → ... | 单继承 | vptr 在偏移 0，计算简单 |
| Klass 子类区分 | `_layout_helper` 整数标记 | O(1) 替代 O(n) 的 dynamic_cast |

JVM 团队做出了明确的设计选择：
1. **避免多继承的多个 vptr**：InstanceKlass 末尾有 Java vtable 嵌入数组，用 `(address)this + size()` 计算起始偏移。如果存在多个 vptr（多继承），`sizeof(Klass)` 中包含未知个数的 vptr，尾部数组起始计算复杂。
2. **避免虚继承的 vbptr 间址**：GC 在标记阶段频繁调用 `Klass::oop_is_instance()` 等方法，每次虚基类成员访问多 2 条指令就是性能瓶颈。
3. **自建 RTTI**：`_layout_helper` 是编译期常量，0 次内存访问就能判断类型——对比 `dynamic_cast` 的 O(n) 遍历，差异是指数级的。

"知道多继承的代价"和"理解 JVM 为什么不用它"是同一枚硬币的两面。

## 关键自查清单

- [ ] 能画出多继承下 `Derived` 对象的完整内存布局（标注每个 vptr 和成员）
- [ ] 能解释为什么 `Base2* pb2 = &d` 需要 this 调整（偏移 = sizeof(Base1)）
- [ ] 理解 thunk 的作用：vtable 中存 thunk 而非直接函数地址，调整 this 后 jmp
- [ ] 能解释菱形继承问题（两份祖先子对象）及虚继承的解决方案（共享一份）
- [ ] 能画出虚继承下的对象布局（vbptr + vbase offset table + 虚基类在末尾）
- [ ] 能对比普通继承和虚继承的成员访问开销（1 指令 vs 2-3 指令）
- [ ] 理解 dynamic_cast 实现：vptr → type_info → 比较/遍历继承树 → 调整指针
- [ ] 理解 typeid 多态类型的查表路径：vptr[-1] → type_info
- [ ] 能解释 sizeof 在多态场景的陷阱（静态类型 vs 动态类型）
- [ ] 能说出 HotSpot 为什么自建类型系统而不是用 C++ RTTI

> *详细讲解参见 C++ 教程: [C++高级-07-多重继承虚继承RTTI](../../../my-openjdk/cpp/stage2-对象模型深度/C++高级-07-多重继承虚继承RTTI.md)*
