# 对象内存布局与 vtable

HotSpot 的 Metadata 体系（`Klass`、`Method`、`ConstMethod`）高度依赖精细的内存布局控制。InstanceKlass 在 `instanceKlass.hpp:51-58` 的注释中详细描述了其尾部嵌入数组（Java vtable、oop-map）的内存布局——这种"结构体末尾变长数组"的设计要求对 C++ 对象内存模型有精确理解。本章从 `sizeof` 的底层机制出发，揭示对象在内存中的真实形态。

## HotSpot 源码切入点：Metadata 的内存布局意识

HotSpot 中 `Metadata` 是所有元数据对象的根基类。看 `InstanceKlass` 的内存布局说明：

```cpp
// jdk11u-copy/src/hotspot/share/oops/instanceKlass.hpp 第 51-58 行
// 注：注释描述了 InstanceKlass 内存中尾部的嵌入数组布局
//  [EMBEDDED Java vtable]           ← 大小 = vtable_len * sizeof(Method*)
//  [EMBEDDED nonstatic oop-map]     ← 大小可变
//  [EMBEDDED implementor]           ← 仅接口类
```

这种布局要求精确知道 Klass 基类的大小、对齐、vptr 位置——因为这些决定嵌入数组从哪个偏移开始。`Klass::vtable()` 方法用 `((address)this + size())` 计算 vtable 起始地址，如果 `sizeof(Klass)` 算错，整个 Java vtable 偏移就错了。

## 空类大小 = 1：对象标识的最底层保障

```cpp
class Empty { };
static_assert(sizeof(Empty) == 1, "Empty must be 1 byte");
```

C++ 标准要求每个完整对象有唯一地址。如果 `sizeof(Empty) == 0`，连续声明两个 Empty 对象会共享同一地址——破坏了对象标识语义：

```cpp
Empty a, b;
// 如果 sizeof(Empty) == 0：&a == &b ← 这违背了"不同对象不同地址"
assert(&a != &b);  // 标准要求此行必须通过
```

编译器给空类分配 1 字节的"占位符"。这 1 字节不存储任何有意义数据，纯粹满足地址唯一性要求。

**空基类优化（EBO）：** 派生类中的空基类子对象不占空间：

```cpp
class Empty { };
class Derived : public Empty { int x; };
static_assert(sizeof(Derived) == 4);  // Empty 被"压缩"——不是 5 字节
```

HotSpot 中大量使用 EBO。例如 `StackObj` 不带数据成员，继承它不会增加子类大小。如果 EBO 不存在，每个继承 StackObj 的类都会多浪费至少 1 字节。

## 成员排列：声明顺序 = 内存顺序，但 padding 干预

```cpp
class Foo {
    char  a;   // offset 0, 1 byte
    int   b;   // offset 4, 4 bytes (offset 4 = 对齐到 int 边界)
    short c;   // offset 8, 2 bytes
};
// sizeof(Foo) = 12（不是 1 + 4 + 2 = 7）

// 实际布局（x86_64）：
// offset 0    : a (1 byte)
// offset 1-3  : *** padding 3 bytes ***  ← 对齐到 int(4) 边界
// offset 4-7  : b (4 bytes)
// offset 8-9  : c (2 bytes)
// offset 10-11: *** padding 2 bytes ***  ← 尾部对齐到最大对齐值 (4)
```

对齐规则：
- 每个成员偏移量必须能被该成员的**对齐值**整除（对齐值 = min(8, sizeof(T))）
- 对象总大小必须能被最大对齐值整除（保证 `T arr[2]` 中 arr[1] 正确对齐）
- `alignof(Foo) = max(alignof(成员1), alignof(成员2), ...)`

调整声明顺序可减少 padding：

```cpp
class Bar {
    int   b;   // offset 0, 4 bytes
    short c;   // offset 4, 2 bytes
    char  a;   // offset 6, 1 byte
};
// sizeof(Bar) = 8（从 12 降到 8）
// padding 仅 1 byte（offset 7）
```

## vptr 的位置与策略

对有虚函数的类，vptr 放在对象最前面（偏移 0）：

```
Base 对象（有虚函数, x86_64）：
┌─────────────────┐  offset 0
│ vptr → vtable   │  8 bytes
├─────────────────┤  offset 8
│ data member 1   │  N bytes
├─────────────────┤
│ ...             │
└─────────────────┘
```

**为什么放在偏移 0？** 编译器不需要知道对象实际类型就能从固定偏移读 vptr。所有有虚函数的类（不管继承几层），vptr 都在同一个位置——这简化了虚函数调用的代码生成。

单继承下，派生类和基类共享同一个 vptr：

```
Derived 对象（单继承）：
┌──────────────────┐  offset 0  ← 唯一 vptr，指向 Derived vtable
│ vptr → vtable    │
├──────────────────┤  offset 8
│ 基类成员 b_val    │
├──────────────────┤  offset 12
│ 派生类成员 d_val  │
└──────────────────┘
sizeof(Derived) = 16
```

**关键事实：** `(Base*)&derived == (void*)&derived`。基类指针和派生类指针指向同一地址，因为基类子对象在最前面。

## vtable 结构：两个"负偏移"入口

vtable 是一个函数指针数组，编译期生成，存储在只读数据段（`.data.rel.ro`）：

```
vtable 布局（GCC/Itanium C++ ABI）：
┌─────────────────────────────────┐
│ vtable[-2]: offset_to_top (0)  │  ← 虚基类相关（单继承始终为 0）
├─────────────────────────────────┤
│ vtable[-1]: type_info*         │  ← RTTI 信息指针
├─────────────────────────────────┤  ← vptr 指向这里！
│ vtable[0]:  第一个虚函数地址     │  ← 按声明顺序排列
├─────────────────────────────────┤
│ vtable[1]:  第二个虚函数地址     │
├─────────────────────────────────┤
│ vtable[2]:  第三个虚函数地址     │
├─────────────────────────────────┤
│ ...                             │
└─────────────────────────────────┘
```

vptr 指向 `vtable[0]`（第一个虚函数），**不是** vtable 起始地址。`vtable[-1]` 和 `vtable[-2]` 需要负偏移访问——只有编译器知道它们的存在。

## 单继承虚函数调用：两次指针解引用

```cpp
class Base {
 public:
  int b_val;
  virtual void f() { }
  virtual void g() { }
};

class Derived : public Base {
 public:
  int d_val;
  void f() override { }       // 重写：覆盖 slot 0
  virtual void k() { }        // 新增：追加到 slot 2
};
```

vtable 对比：

```
Base vtable:                      Derived vtable:
┌──────────────────┐              ┌──────────────────┐
│ offset_to_top: 0 │              │ offset_to_top: 0 │
├──────────────────┤              ├──────────────────┤
│ type_info(Base)  │              │ type_info(Derived)│
├──────────────────┤ ← vptr       ├──────────────────┤ ← vptr
│ &Base::f()       │ slot 0       │ &Derived::f()    │ slot 0 ← 被覆盖
├──────────────────┤              ├──────────────────┤
│ &Base::g()       │ slot 1       │ &Base::g()       │ slot 1 ← 继承
└──────────────────┘              ├──────────────────┤
                                  │ &Derived::k()    │ slot 2 ← 新增
                                  └──────────────────┘
```

虚函数调用 `ptr->f()` 被编译为：

```
// 1. 取 vptr（对象首 8 字节）
void** vptr = *(void***)ptr;
// 2. 从 vtable 中取 slot 0 的函数指针
void (*func)() = (void(*)())vptr[0];
// 3. 间接调用
func(ptr);  // 传入 this
```

对应 x86_64 汇编：

```asm
; ptr->f() 的完整调用序列
mov rax, [rdi]          ; 1) 从对象首地址取 vptr → rax
mov rax, [rax]          ; 2) 从 vtable 取 slot 0 的函数地址 → rax
call rax                ; 3) 间接调用
```

**开销量化：**

| 调用类型 | 指令数 | 内存访问 | 可内联 |
|---------|--------|---------|--------|
| 直接调用 `obj.f()` | 1 (call imm) | 0 | 是 |
| 虚函数调用 `ptr->f()` | 3 (mov, mov, call) | 2 | 否 |

真正的开销不是多两条指令，而是**不可内联**和**分支预测困难**——CPU 无法预测通过 `call rax` 跳往哪个地址。

编译期确定 slot 偏移，运行期查表分发。编译器知道 f 是第一个虚函数对应 slot 0，但不知道 vptr 指向哪张表——直到执行时。

## 三种对象模型：为什么 C++ 选了混合方案

在 C++ 发展史上出现了三种对象模型设计：

**1. 简单对象模型：** 每个对象存储所有成员的指针（包括数据成员和函数成员）。

```
问题：一万个 Point 对象存一万份函数指针——函数代码只有一份，空间浪费巨大。
```

**2. 表格驱动模型：** 对象存储两个指针——指向成员表、指向函数表。

```
问题：额外需要一个成员表指针（8 字节），且访问数据成员多一次间接。
```

**3. C++ 对象模型（实际采用）：** 数据成员直接在对象内，虚函数才走 vptr。

| 成员类型 | 存储位置 | 每对象开销 |
|---------|---------|-----------|
| non-static data member | 对象内部 | sizeof(member) |
| static data member | 全局数据段（.data/.bss） | 0 |
| member function（非虚） | 代码段（.text） | 0 |
| virtual function | 代码段 + vtable 一项 | 0（但 vptr 8 字节） |
| vptr | 对象内部（偏移 0） | 8 字节 |

HotSpot 中 oop/Klass 二分法的设计动机正是基于这个模型（`klass.hpp:58-64` 注释）：

```
// One reason for the oop/klass dichotomy in the implementation is
// that we don't want a C++ vtbl pointer in every object.  Thus,
// normal oops don't have any virtual functions.
```

如果每个 Java 对象都带一个 8 字节 vptr，一个 1000 万对象的堆浪费 80 MB。oop 不设虚函数，vptr 只出现在 Klass 中——数万 Klass vs 数千万 oop，空间收益显著。

## 构造函数不能是虚函数的根本原因

语法上 C++ 不允许构造函数声明为 `virtual`。根本原因不是"语法不允许"，而是**vptr 在构造函数执行过程中逐步建立**——在对象构造完成前，vptr 还不指向最终 vtable：

```
Derived 对象的构造过程与 vptr 变化：
时间线                 vptr 指向
────────────────────────────────
1. 进入 Derived()      (未初始化)
2. 编译器调用 Base()    ← 设为 Base vtable
3. 执行 Base() 函数体   ← Base vtable
4. Base() 返回          ← Base vtable
5. 初始化 Derived 成员  ← Base vtable
6. 进入 Derived() 体    ← 编译器插码：更新为 Derived vtable
7. Derived() 返回       ← Derived vtable
```

如果在构造函数中调用虚函数，vptr 指向当前构造层次对应的 vtable——调用的是**当前类版本**，而不是最终派生类的版本。这实际上是**安全机制**：如果此时走多态调用派生类版本，派生类成员尚未初始化，必然触发未定义行为。

这条规则贯穿 HotSpot：Klass 的构造链中严格避免在构造期间做虚函数派发。JVM 选择用 `_layout_helper` 整数标记（编译期确定的常量）替代运行时 RTTI 查询，部分原因就是不依赖 vptr 的初始状态。

## GDB 验证：从源码到内存

测试代码 `vtable_demo.cpp`：

```cpp
class Base {
public:
    long b_val = 0x4242424242424242;
    virtual void f() { printf("Base::f\n"); }
    virtual void g() { printf("Base::g\n"); }
    virtual ~Base() = default;
};

class Derived : public Base {
public:
    long d_val = 0x4444444444444444;
    void f() override { printf("Derived::f\n"); }
    virtual void h() { printf("Derived::h\n"); }
};
```

**GDB 验证步骤：**

```bash
$ g++ -std=c++11 -g -O0 -fdump-class-hierarchy -o vtable_demo vtable_demo.cpp
$ gdb ./vtable_demo

(gdb) p sizeof(Base)
$1 = 24            # vptr(8) + b_val(8) + padding(8)

(gdb) p sizeof(Derived)
$2 = 32            # Base(24) + d_val(8)

# 查看对象原始内存（用特殊值标记，便于识别）
(gdb) p/x &d
$3 = 0x7fffffffe060

(gdb) x/4gx 0x7fffffffe060
0x7fffffffe060: 0x0000555555557d98  ← vptr 指向 Derived vtable
0x7fffffffe068: 0x4242424242424242  ← b_val
0x7fffffffe070: 0x4444444444444444  ← d_val
0x7fffffffe078: 0x0000000000000000  ← padding

# 逐字节查看空类
(gdb) p sizeof(Empty)
$4 = 1

# 查看 vtable 完整内容
(gdb) info vtbl d
vtable for 'Derived' (7 entries):
  0: offset_to_top = 0
  1: typeinfo for Derived
  2: Derived::f()          ← slot 0: 重写
  3: Base::g()             ← slot 1: 继承
  4: Derived::~Derived()   ← 析构
  5: Derived::h()          ← slot 3: 新增

# 验证虚函数调用的两次间接
(gdb) disassemble main
# 找 ptr->f() 对应的指令
# → mov rax, [rdi]
# → mov rax, [rax]
# → call rax

# 用 objdump 确认 vtable 在只读段
$ objdump -t vtable_demo | grep vtable
0000000000003d60  w  O .data.rel.ro._ZTV7Derived ...
#                                  ^ .data.rel.ro = 只读数据段

# 用 -fdump-class-hierarchy 查看编译器生成的布局
$ cat vtable_demo.cpp.*.class | head -30
# 输出每个类的大小、对齐、vptr 位置、vtable 条目
```

**验证 vptr 在偏移 0：**

```bash
(gdb) p (void**)0x7fffffffe060       # 对象首 8 字节 = vptr
$5 = (void **) 0x7fffffffe060

(gdb) p/x *(void**)0x7fffffffe060    # 读出 vptr 值
$6 = 0x555555557d98                  # 这个值应该等于 &(Derived vtable[0])

(gdb) p/x *(void**)0x555555557d98    # vtable[0] = 第一个虚函数
$7 = 0x5555555551e9

(gdb) info symbol 0x5555555551e9
Derived::f() in section .text        # 确认是 Derived::f
```

**构造期间 vptr 变化验证：**

```bash
(gdb) break 'Base::Base()'
(gdb) break 'Derived::Derived()'
(gdb) run

# 在 Base() 内
(gdb) p *(void**)this
$8 = 0x555555557d70    # vptr = Base vtable

# continue 到 Derived() 内
(gdb) p *(void**)this
$9 = 0x555555557d98    # vptr = Derived vtable ← 已更新
```

## HotSpot 中的实际影响

**Klass 层次的结构体大小计算：**

HotSpot 中 `Klass::size()` 返回 `_layout_helper & ~1`，依赖 `sizeof(Klass)` 包含 vptr 的事实。`InstanceKlass` 的 Java vtable 放在 Klass 尾部之后：

```
Klass 对象内存布局：
┌──────────────────────────────┐  offset 0
│ vptr → Klass vtable          │  8 bytes
├──────────────────────────────┤
│ ... Klass 字段 ...            │  sizeof(Klass) - 8
├──────────────────────────────┤
│ ... InstanceKlass 新增字段... │
├──────────────────────────────┤ ← Klass::vtable() 的计算起点
│ [EMBEDDED Java vtable]       │  vtable_len * sizeof(Method*)
├──────────────────────────────┤
│ [EMBEDDED nonstatic oop-map] │
└──────────────────────────────┘
```

如果 padding 计算错误（例如把 `int` 放 `double*` 前 vs 后），`sizeof(Klass)` 会变——Java vtable 的起始偏移就错了。这是 JVM 崩溃的典型原因，也是对 C++ 对象布局的**工程级要求**。

## 关键自查清单

- [ ] 能解释空类 sizeof = 1 的原因（对象标识 / 唯一地址）
- [ ] 能手动计算含成员变量的 struct 大小（padding / alignment）
- [ ] 能画出单继承下有虚函数的对象内存布局（vptr 在偏移 0）
- [ ] 能描述 vtable 的完整结构（vtable[-2], vtable[-1], vtable[0]...）
- [ ] 能手写虚函数调用的三部曲伪代码（取 vptr → 查 vtable[slot] → 间接调用）
- [ ] 能解释编译期确定 slot 偏移、运行期查表分发的分工
- [ ] 能说出三种对象模型的设计取舍（C++ 选混合方案的原因）
- [ ] 能描述构造函数执行过程中 vptr 的变化时间线
- [ ] 能解释为什么构造函数不能是虚函数（vptr 动态建立，安全机制）
- [ ] 能用 GDB 的 `info vtbl` / `x/nxg` / `info symbol` 验证 vtable 布局

> *详细讲解参见 C++ 教程: [C++高级-06-对象内存布局与vtable](../../../my-openjdk/cpp/stage2-对象模型深度/C++高级-06-对象内存布局与vtable.md)*
