# C++ 性能优化

HotSpot 是性能极致优化的产物。解释器、C1/C2 JIT 编译器、GC——每一条代码路径都是毫秒级甚至微秒级敏感的。理解 C++ 性能优化的核心原理，才能理解 HotSpot 的设计选择——为什么 C2 编译器用 switch 分发而不用虚函数表、为什么 G1 GC 用 SATB 队列避免锁竞争、为什么 TLAB 用指针碰撞分配而非 `malloc`。

## 阿姆达尔定律：优化的理论上限

在动手优化之前，先理解阿姆达尔定律——它给出了任何局部优化的整体收益上限：

```
        1
S = ──────────      S = 总体加速比
    (1-P) + P/N       P = 被优化部分的执行时间占比
                      N = 被优化部分的加速比
```

| 热点占比 P | 该部分加速 2 倍 | 该部分加速 10 倍 | 该部分加速无穷 |
|-----------|:---:|:---:|:---:|
| 10% | 1.05x | 1.10x | 1.11x |
| 50% | 1.33x | 1.82x | 2.00x |
| 80% | 1.67x | 3.57x | 5.00x |
| 95% | 1.90x | 6.89x | 20.00x |

**核心教训：** 即使把某部分优化到"不花任何时间"，整体加速比也不会超过 `1/(1-P)`。花一天优化一个只占 2% 的函数，不如花一小时用 `perf` 找到真正占 50% 的热点。优化第一步不是写代码，是测量。

## 性能优化技术全景表

```
优化层次      技术                       收益量级     适用场景
─────────────────────────────────────────────────────────────────
算法层        复杂度降级（O(n²)→O(n log n)）  10-1000x    热点函数
数据布局      缓存友好（SoA/AoS 选择）         2-10x      数据密集计算
内存分配      预分配 + reserve() + 对象池      2-10x      频繁分配
移动语义      避免深拷贝                      1-1000x    大对象传递/返回
分支预测      likely/unlikely + PGO          1-5x       热路径分支
去虚拟化      final/CRTP/std::variant         1-100x     热循环虚函数
编译器优化    -O3/-flto/-march=native         1-3x       整体
并行化       多线程 + 无锁数据结构             1-Nx       可并行的计算
```

> 原则：**先算法层，再数据层，最后指令层。** 换一个更好的算法比微调汇编有效得多——但优化必须从 profiling 数据出发，而不是凭直觉。

## 虚函数调用的真实开销

虚函数的主要开销**不在于多出来的一两条指令**，而在于**丧失内联机会**。

```
普通函数调用（可内联）：              虚函数调用（无法内联）：
call known_address                   mov  rax, [rdi]        # 1. 从对象读 vtable 指针
                                     call [rax + offset]    # 2. 间接跳转
                                                             # 3. 无法内联——最大损失
直接跳转，1 条指令                   间接跳转，3+ 条指令
分支预测友好                          分支预测可能失败
编译器可跨函数优化                      编译器无法跨虚函数边界优化
```

**开销构成：**

| 开销项 | 数量级 | 说明 |
|--------|--------|------|
| 间接跳转指令 | ~1-2 ns | 比直接调用多一次内存读取 |
| 分支预测失败 | ~10-20 cycles | 初次调用或多态交替时 |
| **无法内联** | **10-100x** | 热循环中小函数——丢失编译器最优化的最大机会 |

**HotSpot 中的应对：C2 JIT 编译器用 switch 分发而非虚函数。**

C2 编译器的 `PhaseIdealLoop`、`PhaseCCP` 等 Pass 不是通过虚函数调用的——它们是一个 `switch` 语句按顺序分派：

```cpp
// jdk11u-copy/src/hotspot/share/opto/compile.cpp 中的编译 Pass 分派（简化逻辑）
// 实际实现通过 Compile::Optimize() 中的顺序调用完成

void Compile::Optimize() {
    // Phase 1: Remove useles nodes
    PhaseRemoveUseless rem_useless(igvn);
    // Phase 2: Iterative GVN
    PhaseIterGVN igvn(initial_gvn);
    // Phase 3: Loop optimizations
    PhaseIdealLoop ideal_loop(igvn, ...);
    // ... 共 20+ 个 Pass，不使用虚函数，全部是直接调用
}
```

这不是 switch vs vtable 的全或无选择——而是**针对已知的、封闭的优化 Pass 集合**，直接调用比虚函数分发更快（编译器可以内联、可以做过程间优化）。虚函数适合开放集合（插件系统），直接调用适合封闭集合（编译器优化 Pass）。

## 缓存友好与缓存行

现代 CPU 的缓存层级（x86_64 典型）：

```
L1 Cache   ~1 ns     █
L2 Cache   ~4 ns     ██
L3 Cache   ~12 ns    ███
主内存      ~100 ns   ████████████████████████████   ← 差 100 倍
```

CPU 从内存读取数据不是按字节读，而是按**缓存行（64 字节）**整块加载。这意味着：

```cpp
// 缓存友好：顺序遍历
int arr[1024*1024];
for (int i = 0; i < N; ++i) sum += arr[i];
// 每 64 字节 (16 个 int) 才 miss 一次 → ~6% miss rate

// 缓存不友好：大跨度跳跃
for (int i = 0; i < N; i += 256) sum += arr[i];
// 每次访问都是不同的 cache line → ~100% miss rate → 3-5x 慢
```

### AoS vs SoA 选择

AoS（Array of Structures）面向对象：`struct Particle { float x,y,z,vx,vy,vz; }; Particle parts[N];`——更新所有 x 坐标时，每次加载 64 字节但只用 4 字节。SoA（Structure of Arrays）数据驱动：`struct { vector<float> x,y,z,vx,vy,vz; } parts;`——更新 x 时，64 字节全是 x 数据。**量化差异：** 单字段更新 SoA 比 AoS 快 3.2x。

### False Sharing——多线程的隐形杀手

```cpp
struct ThreadData {
    std::atomic<int> counter_a;  // 线程 A 频繁写入
    std::atomic<int> counter_b;  // 线程 B 频繁写入
    // counter_a 和 counter_b 在同一个 64 字节 cache line 内——互相"踩脚"！
};

// 结果：A 写 counter_a → B 的 cache line 失效
//       B 写 counter_b → A 的 cache line 失效
// 性能下降 10-50 倍
```

**解决方案：**

```cpp
struct ThreadData {
    alignas(64) std::atomic<int> counter_a;
    alignas(64) std::atomic<int> counter_b;
    // 或使用 C++17:
    // alignas(std::hardware_destructive_interference_size)
};
```

HotSpot 中 `OrderAccess` 和 `Atomic` 类精心控制内存屏障，避免不必要的缓存同步——这正是把 false sharing 控制在设计层面。

## 分支预测与 likely/unlikely 宏

现代 CPU 是高度流水线化的——遇到条件分支时，CPU 必须**猜测**走哪条路径。猜错了就是流水线冲刷：

```
分支预测失败代价：~10-20 个时钟周期（3-7 ns @ 3GHz）
对比：一条简单指令 ~0.3 ns
       失败代价 ≈ 10-20x normal
```

**likely/unlikely 宏帮助编译器优化代码布局：**

```cpp
// HotSpot 中的定义（见 globalDefinitions.hpp）
#define likely(x)   __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)

// 使用模式：
if (unlikely(error_occurred)) {  // 错误处理路径——冷分支
    handle_error();              // 编译器将此代码移到函数末尾
}
// 热路径紧随其后——紧凑排列，提高 I-Cache 利用率

if (likely(ptr != nullptr)) {    // 正常路径——热分支
    ptr->process();              // 紧跟条件判断之后
}
```

**C++20 标准化为语言属性：**

```cpp
if (error_occurred) [[unlikely]] {  // C++20 标准写法
    handle_error();
}
```

### 代码布局的汇编证据

```cpp
int test_likely(int* ptr) {
    if (__builtin_expect(ptr != nullptr, 1)) return *ptr;
    return -1;
}

int test_without(int* ptr) {
    if (ptr != nullptr) return *ptr;
    return -1;
}
```

```asm
# GCC -O2 生成的汇编对比

# test_likely（带 likely）：
test_likely:
    test   rdi, rdi
    je     .L_cold           # ptr == nullptr → 跳转到函数末尾的冷分支
    mov    eax, [rdi]        # 热路径：直接返回——指令连续，cache line 友好
    ret
.L_cold:
    mov    eax, -1           # 冷路径被放到函数末尾
    ret

# test_without（无提示）：
test_without:
    test   rdi, rdi
    je     .L_fallback       # 跳转目标紧挨着热路径
    mov    eax, [rdi]
    ret
.L_fallback:                  # 紧挨着热路径——不是最优布局
    mov    eax, -1
    ret
```

`likely` 版本将冷分支移到函数末尾，热路径指令紧凑排列，提高了指令缓存利用率。CPU 分支预测器的默认"不跳转"猜测与 likely 语义一致——进一步减少预测失败。

## 移动语义的性能收益

移动语义的本质是"偷资源指针"——深拷贝 O(n) 变指针转移 O(1)：

| 操作 | 100 字节 string | 1 MB string | 100万元素 vector\<int\> |
|------|:---:|:---:|:---:|
| 拷贝 | ~50 ns | ~50 μs | ~2 ms |
| 移动 | ~5 ns | ~5 ns | ~5 ns |
| 加速比 | ~10x | ~10,000x | ~400,000x |

移动的代价是**常数时间**——只拷贝几个指针。大对象传递/返回、vector 扩容、swap 中自动受益。**`noexcept` 是关键：** `std::vector` 在扩容时只有在移动构造函数标记为 `noexcept` 时才使用移动——否则退化为拷贝。自定义类实现移动构造/赋值时务必加 `noexcept`。

```cpp
std::vector<std::string> vec;
vec.push_back(std::string("temp"));  // 移动！临时对象
std::vector<int> create_huge() {
    std::vector<int> v(1000000);
    return v;  // 自动移动或 RVO，零拷贝
}
```

## 内联与 RVO/NRVO

内联远不止省一条 `call`：将函数体展开到调用点后，编译器可以做常量折叠（编译期常量直接求值）、死代码消除（未用分支完全移除）、跨函数寄存器分配优化。**编译器自主决策**——`inline` 关键字只是建议（现代编译器基本忽略），真正起作用的是将函数定义放在头文件中让调用点可见。

### RVO/NRVO——返回值零开销

```cpp
// RVO：return std::string("hello"); → 直接在调用方栈帧构造
// NRVO：return result; （具名局部变量） → 同样直接在调用方构造
// 错误：return std::move(result); → 阻碍 NRVO！
// C++17 强制 copy elision——RVO 从优化变为语言保证
```
## 编译器优化选项

| 选项 | 作用 | 典型收益 |
|------|------|:---:|
| `-O2` | 标准优化：内联、常量传播、死代码消除、循环优化 | 基线 |
| `-O3` | 在 -O2 基础上增加更激进的循环展开、函数克隆 | +5-20% |
| `-march=native` | 针对当前 CPU 生成指令（AVX、SSE4.2 等） | +5-30% |
| `-flto` | 链接时优化：跨编译单元内联和优化 | +5-15% |
| `-fno-exceptions` | 禁用异常——HotSpot 使用此选项，减少 unwind table | 二进制减小 |

**实际效果：** `-O2` + `-march=native` + `-flto` 的组合通常比 `-O0` 快 2-5x，比 `-O2` 单独快 10-50%。

## HotSpot 的性能基础设施

### 1. OrderAccess 和 Atomic——内存屏障控制

```cpp
// jdk11u-copy/src/hotspot/share/runtime/orderAccess.hpp

// 读屏障：保证 barrier 之后的读操作不会重排到 barrier 之前
inline void OrderAccess::loadload()  { __asm__ volatile ("lfence" ::: "memory"); }
// 写屏障：保证 barrier 之前的写操作全部完成
inline void OrderAccess::storestore(){ __asm__ volatile ("sfence" ::: "memory"); }
// 全屏障：保证读写操作的顺序
inline void OrderAccess::fence()     { __asm__ volatile ("mfence" ::: "memory"); }

// Atomic 操作：CAS（Compare-And-Swap）
// Atomic::cmpxchg(期望值, 目标地址, 新值) → x86 上编译为 lock cmpxchg
```

HotSpot 在 GC 写入屏障、锁实现、并发数据结构中精确控制内存屏障——比 C++11 的 `std::atomic` 更细粒度（可以单独使用 loadload/storestore 而非默认的 seq_cst）。

### 2. ResourceMark——批量 Arena 释放

这不是性能优化，这是**性能模型**——用 O(1) 的回滚替代 N 次 O(1) 的释放：

```cpp
// jdk11u-copy/src/hotspot/share/memory/resourceArea.hpp 第 73-164 行
class ResourceMark : public StackObj {
    ~ResourceMark() {
        reset_to_mark();  // 析构时 O(1) 回滚水位线——所有中间分配自动归还
    }
};

// 使用模式：
{
    ResourceMark rm;                       // 1. 保存 Arena 水位线
    int* arr = NEW_RESOURCE_ARRAY(int, 1000);   // 分配 1
    char* buf = NEW_RESOURCE_ARRAY(char, 4096); // 分配 2
    // ... 更多分配 ...
}  // 2. rm 析构：一次操作回滚所有分配——O(1) vs O(N)
```

### 3. 热点路径避免虚函数

C2 编译器不用虚函数分发 Pass：Pass 是封闭集合（20+ 个已知），switch 跳转表 + 内联函数体比虚函数间接调用更快。跳转目标来自编译期确定的表，分支预测也比虚函数调用更可预测。

### 4. C2 Ideal Graph 优化

C2 在 `PhaseIdealLoop` 等 Pass 中做循环不变式外提、循环展开、强度削减——等价于 `-O3` 优化但在 JIT 运行时做，能利用运行时 profiling 数据。节点类型通过继承表达（`AddNode`、`MulNode`、`LoadNode`），但 Pass 分派不走虚函数。

### 5. TLAB——对象分配极致优化

```cpp
// jdk11u-copy/src/hotspot/share/gc/shared/threadLocalAllocator.hpp
inline HeapWord* ThreadLocalAllocBuffer::allocate(size_t size) {
    HeapWord* obj = _top;
    HeapWord* new_top = obj + size;
    if (new_top <= _end) {
        _top = new_top;       // 碰指针——比 malloc 快 100x+
        return obj;
    }
    return NULL;  // TLAB 满，走慢路径
}
```

TLAB 把 ~100 ns 的 `malloc` 变成 ~1 ns 的指针加法+比较。HotSpot 中 99%+ 的对象分配走 TLAB——"减少动态内存分配"的终极实践。

## 汇编验证：虚函数调用 vs 普通函数调用

```cpp
class Base { public: virtual int value() const { return 0; } };
class Derived : public Base { public: int value() const override { return 42; } };

int direct_call(const Base& b) { return b.value(); }   // 引用→可内联
int virtual_call(Base* b)      { return b->value(); }  // 指针→走vtable
```

```bash
g++ -std=c++11 -O2 -g -c vcall_test.cpp -o vcall_test.o
objdump -d -M intel vcall_test.o
```

```asm
# direct_call（通过引用调用，编译器知道是 Base）：
direct_call:
    mov    eax, 0           # 编译器内联了 Base::value()，直接返回 0
    ret

# virtual_call（通过指针调用，编译器不知道实际类型）：
virtual_call:
    mov    rax, QWORD PTR [rdi]     # 1. 从对象读 vtable 指针
    mov    rax, QWORD PTR [rax]     # 2. 从 vtable 第一条目读函数指针
    jmp    rax                       # 3. 间接跳转到函数体
    # 注意：用的是 jmp 而不是 call——尾调用优化

# normal_call（普通函数）：
normal_call:
    mov    eax, 42           # 直接返回常量
    ret
```

**关键差异：**
- `direct_call`：编译器知道 `b` 的静态类型是 `Base&`，可以直接内联 `Base::value()` 返回 `0`。
- `virtual_call`：编译器不知道 `b` 指向 `Base` 还是 `Derived`，必须走 vtable 间接调用——多了两次内存读取 + 一次间接跳转。即使函数体只是 `return 42;`，也无法内联。
- 如果在热循环中调用 100 万次，虚函数版本可能慢 10-100x。

> *详细讲解参见 C++ 教程: [性能优化实战](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-11-性能优化实战.md)*
>
> *LLVM/libc++ 风格的 RVO/NRVO 技术参见 C++ 教程: [STL 容器与算法](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-09-STL容器与算法.md)*（string 移动语义章节）

## 关键自查清单

- [ ] 能写出阿姆达尔定律公式并计算"把 60% 代码加速 5 倍的整体收益"
- [ ] 能解释虚函数调用的真实开销——不在于多几条指令，而在于丧失内联机会
- [ ] 能画出缓存行（64 字节）加载的示意图——顺序访问 vs 大跨度跳跃的 miss rate 差异
- [ ] 能区分 AoS 和 SoA 的适用场景——什么情况下 SoA 能带来 3x+ 的加速
- [ ] 能解释 false sharing 的问题机制（多线程共享 cache line → 互相失效）和解决方案（alignas）
- [ ] 理解 likely/unlikely 的代码布局优化——冷分支移到函数末尾，热路径紧凑排列
- [ ] 能说清移动语义的性能收益——大对象传递/返回时 O(n) 拷贝变 O(1) 指针转移
- [ ] 知道为什么移动构造函数必须标记 noexcept（否则 vector 扩容退化为拷贝）
- [ ] 理解 RVO/NRVO 的原理——编译器直接在调用方栈帧构造返回值，零开销
- [ ] 知道为什么 `return std::move(result)` 是错的——阻碍 NRVO
- [ ] 能区分 `-O2`、`-O3`、`-march=native`、`-flto` 各自的作用和典型收益
- [ ] 理解 HotSpot 的 ResourceMark 为什么是性能基础设施——O(1) 回滚替代 N 次 O(1) 释放
- [ ] 知道 TLAB 的指针碰撞分配为什么比 malloc 快 100x+——单次指针加法 vs 复杂分配器
- [ ] 能在汇编层面区分虚函数调用（两次 load + 间接 jmp）和普通调用（直接 ret 常量）
