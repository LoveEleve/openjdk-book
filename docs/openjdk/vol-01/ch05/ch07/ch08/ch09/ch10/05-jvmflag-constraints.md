# JVMFlagConstraintList -- JVM 启动参数的编译期约束系统

> **跳过提示**：本文讲解的是 JVM 启动时检查参数组合是否合法（如 `ConcGCThreads <= ParallelGCThreads`）。它属于 `universe_init` 调用的一个环节，但和 OopStorage、ClassLoaderData 等运行时核心机制不同——只在启动时执行一次，JVM 启动完就不再使用。对运行时机制感兴趣的读者可以跳过本文，不影响后续文章的理解。

universe_init 在堆和 Metaspace 初始化完成后调用 `check_constraints(AfterMemoryInit)` 验证参数约束。本文揭示 JVM 如何在 800+ 个参数之间建立跨参数约束 -- 从参数声明中的 `constraint(func, type)` 一行字，到宏展开链生成的 `JVMFlagConstraint_size_t` 对象，到 `check_constraints` 的 O(n) 遍历，最终决定 JVM 能否启动。

**前置知识**：C++ 预处理器宏（`#define` 连接符号）、函数指针 typedef、虚函数多态、JVM flag 的 `product(size_t, name, value, doc)` 声明语法。

## Layer 1: 设计动机 -- 为什么要"约束"，光靠 range() 不够

JVM 有 800+ 个启动参数。简单的数值范围检查（"MaxHeapSize 不得小于 0"）通过 flag 声明宏的 `range(min, max)` 字段即可处理。

问题出在**跨参数约束** -- 一个 flag 的合法性依赖另一个 flag 的值：

- `ConcGCThreads` 不能大于 `ParallelGCThreads`（并发线程数超过并行线程数无意义）
- `MaxHeapSize` 被 `heap_alignment` 整除后的值不能溢出 `max_uintx`
- `SurvivorRatio` 换算出的 survivor 空间大小不能超过 `MaxHeapSize / space_alignment`
- `SoftRefLRUPolicyMSPerMB * (MaxHeapSize / M)` 不能溢出 `max_uintx`

这些约束的共同特征是**两个或多个 flag 之间有关联**。`range(min, max)` 只能看单个 flag 的绝对值，处理不了 flag1 < flag2 这种关系。

JVM 的方案是：每个特殊约束写一个独立的 C 函数，通过**编译期宏注册**绑定到目标 flag 上，在三个预定义时机**分阶段验证**。

关键问题是**为什么是编译期注册，而不是运行时动态添加**？

编译期注册意味着所有约束在 `init()` 中一次性创建完毕，之后只读不写。这带来三个好处：

1. **类型安全**：`_ptr` 指向 flag 的内存地址，flag 值变化后约束自动使用最新值 -- 不需要每次检查都查找 flag 名
2. **无锁只读**：`check_constraints` 只遍历数组读指针，不需要锁
3. **分阶段不变**：AtParse / AfterErgo / AfterMemoryInit 三次检查面对的是同一套约束对象，只按类型筛选

---

## Layer 2: 怎么把约束函数绑定到 flag 上

### 2.1 HotSpot 的 flag 不是普通 C++ 变量

如果 `MaxHeapSize` 是一个普通的 C++ `size_t` 变量，给它绑定一个约束函数很简单——在变量声明旁边写一行 `register_constraint(&MaxHeapSize, checkFunc)` 就行。

但 HotSpot 的 flag 不是这样声明的。它们集中在 `gc_globals.hpp` 等头文件中，用宏声明：

```cpp
product(size_t, MaxHeapSize, ScaleForWordSize(96*M),
        "Maximum heap size (in bytes)")
```

`product`、`size_t`、`MaxHeapSize`——这看起来像函数调用，实际是预处理器指令。`product` 是一个宏，定义在 `jvmFlag.hpp` 中。每个 flag 是一个宏表条目，所有 flag 汇总在 `VM_FLAGS(...)` 这个超大宏中统一处理。

这种设计的原因：800+ 个 flag 如果各自是独立变量，JVM 启动时需要写 800+ 次 `if (strcmp(arg, "MaxHeapSize") == 0) ...` 来做参数解析。用宏表集中管理后，`Arguments::parse_argument` 只需要遍历宏表一次，宏展开自动生成解析代码。

### 2.2 约束函数：签了名、拿了值、返回对错

约束是一个 C 函数。以 `MaxHeapSizeConstraintFunc` 为例：

```cpp
JVMFlag::Error MaxHeapSizeConstraintFunc(size_t value, bool verbose) {
  JVMFlag::Error status = MaxSizeForHeapAlignment("MaxHeapSize", value, verbose);
  if (status == JVMFlag::SUCCESS) {
    status = CheckMaxHeapSizeAndSoftRefLRUPolicyMSPerMB(value, SoftRefLRUPolicyMSPerMB, verbose);
  }
  return status;
}
```

参数只有两个：`value`（flag 的当前值）和 `verbose`（是否打印错误信息）。返回值是 `JVMFlag::SUCCESS` 或 `JVMFlag::VIOLATES_CONSTRAINT`。

函数不需要知道 flag 叫什么名字——`value` 就是值。它也不关心这个值是从命令行来的还是 ergonomics 调整的。它只管一件事：给定这个值，合法还是不合法。

### 2.3 从声明到注册：不做字符串匹配

约束系统的一个核心设计是：**约束对象存 flag 的内存地址，而不是 flag 的名字。**

如果存储名字（`"MaxHeapSize"`），每次 check_constraints 时都需要从名字反向查 flag 值——这又变成了字符串匹配，回到了第 1 层的问题。

存储地址后，约束对象的 `_ptr` 是一个 C++ 指针，直接指向 `MaxHeapSize` 这个全局变量的内存位置。无论 `MaxHeapSize` 被命令行改成 1G、又被 ergonomics 调成 2G——`_ptr` 始终指向同一个地址，`*_ptr` 总是最新值。

具体来说：约束函数签名是 `JVMFlagConstraintFunc_size_t`（一个函数指针类型），约束对象是 `JVMFlagConstraint_size_t`（一个包装类）：

```
约束对象内部:
  _ptr       → &MaxHeapSize（指针）
  _constraint → MaxHeapSizeConstraintFunc（函数指针）

apply() 调用时:
  *_ptr → 读到 MaxHeapSize 的当前值
  _constraint(value, verbose) → 调用约束函数检查
```

封装在这个子类里——不在基类——因为每个 flag 类型（size_t、int、uint 等）有独立的函数签名和独立的 `_ptr` 类型。C++98 没有可变模板，只能用 8 个独立子类。

### 2.4 启动时一次性注册

`JVMFlagConstraintList::init()` 在所有 flag 表上跑一遍宏展开。每个 flag 的宏条目会展开为一行函数调用——给有约束的创建对象，无约束的跳过。

注册发生在 JVM 启动的极早期——比参数解析还早。这是时序要求决定的：`Arguments::parse_argument` 开始解析命令行参数时，约束对象必须已经全部就位——因为 AtParse 阶段的约束检查在解析过程中同步触发。

注册完成后，`_constraints` 列表不再变化——之后只读不写。这就是为什么 `check_constraints` 可以用 O(n) 遍历而不用考虑并发写入。

---

## Layer 3: 8 种约束子类 + 1 个基类 -- 类型安全的指针间接层

### 3.1 基类 JVMFlagConstraint

```cpp
class JVMFlagConstraint : public CHeapObj<mtArguments> {
private:
  const char* _name;                    // flag 名称，只用作字符串标识
  ConstraintType _validate_type;        // AtParse / AfterErgo / AfterMemoryInit

public:
  JVMFlagConstraint(const char* name, ConstraintType type);
  const char* name() const { return _name; }
  ConstraintType type() const { return _validate_type; }

  virtual JVMFlag::Error apply(bool verbose = true) {
    ShouldNotReachHere(); return JVMFlag::ERR_OTHER;
  }
  virtual JVMFlag::Error apply_bool(bool, bool) { ShouldNotReachHere(); ... }
  virtual JVMFlag::Error apply_int(int, bool)   { ShouldNotReachHere(); ... }
  // ... 剩下 5 个同样的 apply_* 虚函数
};
```

基类的 8 个虚函数全部是 `ShouldNotReachHere()` -- 如果调到了基类的实现，说明类型不匹配，在 debug 版本下会触发断言终止。

### 3.2 一个子类的模式 -- 以 `JVMFlagConstraint_size_t` 为例

```cpp
class JVMFlagConstraint_size_t : public JVMFlagConstraint {
  JVMFlagConstraintFunc_size_t _constraint;  // 约束函数指针
  const size_t* _ptr;                        // 指向 flag 值内存地址的指针

public:
  JVMFlagConstraint_size_t(const char* name, const size_t* ptr,
                           JVMFlagConstraintFunc_size_t func,
                           ConstraintType type)
    : JVMFlagConstraint(name, type)
    , _constraint(func), _ptr(ptr) {}

  JVMFlag::Error apply(bool verbose) {        // override 基类的 apply()
    size_t value = *_ptr;                     // 从 flag 内存读取当前值
    return _constraint(value, verbose);        // 传给约束函数
  }
};
```

8 种子类：`_bool` / `_int` / `_intx` / `_uint` / `_uintx` / `_uint64_t` / `_size_t` / `_double`，代码结构完全一致。唯一的差异是 `_ptr` 的类型（`const bool*` vs `const size_t*` vs ...）和构造函数/`apply()` 中的类型参数。

### 3.3 为什么需要 8 个几乎一样的类

这是 C++98 的强制选择。原因有两个：

1. **`_ptr` 必须知道指向的类型**：`*_ptr` 解引用需要编译器知道返回值的 C++ 类型。`const void*` 无法直接解引用。
2. **约束函数必须知道参数类型**：`ConcGCThreadsConstraintFunc(uint value, ...)` 和 `MaxHeapSizeConstraintFunc(size_t value, ...)` 的参数类型不同，函数指针签名也不同。

如果用 C++11 的可变模板，可以写成 `JVMFlagConstraint<T>` 一个模板类。但 HotSpot 的 C++ 标准长期停留在 C++98，只能用宏 + 手写 8 个类来模拟模板。

约束函数指针也定义了 8 种 typedef：

```cpp
typedef JVMFlag::Error (*JVMFlagConstraintFunc_bool)(bool, bool);
typedef JVMFlag::Error (*JVMFlagConstraintFunc_int)(int, bool);
// ... 6 个类似的
```

### 3.4 `_ptr` 间接层的作用

`_ptr` 不是存 flag 值的副本，而是存指向 flag **实际内存地址**的指针。这个设计让约束系统自动适应 flag 值的变化：

- 用户通过 `-XX:MaxHeapSize=1g` 修改 flag 后，`*_ptr` 自动反映新值
- `Arguments::apply_ergo()` 调整 heap size 后，`*_ptr` 也自动反映调整后的值
- 每次 `apply()` 都是实时读取，不需要"刷新约束"的步骤

---

## Layer 4: check_constraints 的 O(n) 遍历 -- 为什么不过滤，为什么不全检查

### 4.1 顺序校验

```cpp
bool JVMFlagConstraintList::check_constraints(
    JVMFlagConstraint::ConstraintType type) {
  guarantee(type > _validating_type,
            "Constraint check is out of order.");
  _validating_type = type;
  // ...
```

`_validating_type` 初始值是 `AtParse(0)`。第一次检查 `AfterErgo(1)` 时，`1 > 0` 通过，`_validating_type` 更新为 1。但如果之后代码"后退"检查 `AtParse(0)`，`0 > 1` 失败，`guarantee` 在 debug 版本下直接终止。

这防止了时序错误：AfterMemoryInit 的约束函数依赖堆的创建结果，如果它在堆创建之前被调用，访问 `Universe::heap()` 会得到未定义行为。

### 4.2 全量遍历 -- 不提前终止

```cpp
  bool status = true;
  for (int i = 0; i < length(); i++) {
    JVMFlagConstraint* constraint = at(i);
    if (type != constraint->type()) continue;
    if (constraint->apply(true) != JVMFlag::SUCCESS)
      status = false;
  }
  return status;
```

两个设计决策：

**不提前终止**：即使某个约束返回 `VIOLATES_CONSTRAINT`，循环仍然继续。原因是用户经常同时违反多个约束（例如 `-XX:ConcGCThreads=100 -XX:ParallelGCThreads=4 -XX:MaxHeapSize=999999999T`），一次性打印所有错误信息比"修一个弹一个"高效。

**线性 `length()` 次检查**：`check_constraints` 只在一轮启动中调用 3 次（AtParse / AfterErgo / AfterMemoryInit），全局约束总数约 50-80 个。`50 * 3 = 150` 次 `strcmp` + 函数调用对于 JVM 启动的总耗时（数秒）而言可以忽略。复杂的索引结构（hash / 分组表）反而增加维护成本。

### 4.3 `find_if_needs_check` -- flag set 时的按需检查

除了批量检查，单个 flag 在运行时被 `FLAG_SET_*` 修改时也需要检查约束：

```cpp
JVMFlagConstraint* JVMFlagConstraintList::find_if_needs_check(
    const char* name) {
  JVMFlagConstraint* constraint = find(name);
  if (constraint &&
      (constraint->type() <= _validating_type)) {
    return constraint;
  }
  return NULL;
}
```

逻辑：先通过 `find()` 在约束列表中检索该 flag，然后检查约束类型是否 <= 当前已验证的阶段。如果 `_validating_type` 已经是 `AfterMemoryInit(2)`，所有约束类型都 <= 2，即任何约束都可以被检查。

这个函数有 8 个调用点 -- `jvmFlag.cpp` 中的 `apply_constraint_and_check_range_bool` / `_int` / `_uint` 等函数。每个函数处理一种 flag 类型，通过 `apply_bool()` / `apply_int()` 等类型化虚函数调用约束。

---

## Layer 5: AfterMemoryInit -- 依赖堆的约束为什么必须等

### 5.1 三个检查时机的依赖链

```
AtParse(0)  -- flag 被解析时立即检查
 只能看 flag 自身的绝对值

AfterErgo(1) -- Arguments::apply_ergo() 之后
 可以看其他 flag 的值（ergo 调整已生效）

AfterMemoryInit(2) -- universe_init 中堆/Metaspace 之后
 可以看 堆大小 / Metaspace 实际值 / TLAB 值
```

### 5.2 SurvivorRatioConstraintFunc -- 直接访问堆对象

```cpp
JVMFlag::Error SurvivorRatioConstraintFunc(uintx value, bool verbose) {
  if (FLAG_IS_CMDLINE(SurvivorRatio) &&
      (value > (MaxHeapSize /
       Universe::heap()->collector_policy()->space_alignment()))) {
    JVMFlag::printError(verbose,
      "SurvivorRatio (" UINTX_FORMAT ") must be less than or equal to "
      "ergonomic SurvivorRatio maximum (" SIZE_FORMAT ")\n",
      value,
      (MaxHeapSize /
       Universe::heap()->collector_policy()->space_alignment()));
    return JVMFlag::VIOLATES_CONSTRAINT;
  }
  return JVMFlag::SUCCESS;
}
```

`Universe::heap()` 返回 `CollectedHeap*` -- 这个对象在 `Universe::initialize_heap()` 中通过 `GCConfig::arguments()->create_heap()` 创建。堆没创建时，`heap()` 返回 NULL。

`space_alignment()` 的值取决于具体的 GC 策略：G1 返回 `HeapRegion::GrainBytes`，Parallel 返回 `os::vm_allocation_granularity()`。在没有 `CollectorPolicy` 对象之前，这个值不可知。

**WHY：为什么 `SurvivorRatio > MaxHeapSize / space_alignment` 是非法的？**

`SurvivorRatio` 决定了新生代中 survivor 区的大小比例。survivor 区大小约等于 `MaxHeapSize / (SurvivorRatio + 2)`。`SurvivorRatio` 太大意味着 survivor 区太小 -- 当小到连一个 `space_alignment` 对齐的字节数都不够时，survivor 区无法分配。

### 5.3 TLABWasteIncrementConstraintFunc -- 依赖 TLAB 的初始化值

```cpp
JVMFlag::Error TLABWasteIncrementConstraintFunc(uintx value, bool verbose) {
  if (UseTLAB) {
    size_t refill_waste_limit =
        Thread::current()->tlab().refill_waste_limit();
    if (refill_waste_limit > (max_uintx - value)) {
      // 溢出检查
      return JVMFlag::VIOLATES_CONSTRAINT;
    }
  }
  return JVMFlag::SUCCESS;
}
```

`refill_waste_limit()` 的值来自 `ThreadLocalAllocBuffer::startup_initialization()`。如果 TLAB 没初始化，`_refill_waste_limit` 为 0，溢出检查失去意义。这个约束必须在 AfterMemoryInit 检查。

### 5.4 作为对比 -- 为什么 MaxHeapSizeConstraintFunc 能在 AfterErgo 检查

```cpp
JVMFlag::Error MaxHeapSizeConstraintFunc(size_t value, bool verbose) {
  JVMFlag::Error status =
      MaxSizeForHeapAlignment("MaxHeapSize", value, verbose);
  if (status == JVMFlag::SUCCESS) {
    status = CheckMaxHeapSizeAndSoftRefLRUPolicyMSPerMB(
        value, SoftRefLRUPolicyMSPerMB, verbose);
  }
  return status;
}
```

`MaxSizeForHeapAlignment` 只是做位运算：`(max_uintx - alignment) & ~(alignment-1)`，判断 value 是否超过对齐上限。`CheckMaxHeapSizeAndSoftRefLRUPolicyMSPerMB` 检查 `(MaxHeapSize / M) * SoftRefLRUPolicyMSPerMB` 是否溢出 -- 两个 flag 值都是已知的，不依赖任何运行时结构。

这些是**纯算术约束**，不依赖任何运行时初始化（堆、Metaspace、TLAB），所以能在更早的 AfterErgo 检查。AfterMemoryInit 存在的意义就是为那些"不得不等到运行时结构就绪"的约束提供一个第三时机。

---

## Layer 6: 约束失败会怎样 -- JVM 不启动，但不崩溃

### 6.1 失败传播链

```
check_constraints(AfterMemoryInit)
  constraint->apply(true) 返回 VIOLATES_CONSTRAINT
  status = false
  return false

universe_init()  Line 705
  if (!check_constraints(AfterMemoryInit)) {
    return JNI_EINVAL;    // -1
  }

init_globals() / universe_post_init()
  jint status = universe_init();
  if (status != JNI_OK) return status;

Threads::create_vm()
  // 阶段 6
  if (!universe_post_init()) {
    vm_exit_during_initialization();
  }
```

关键点：`check_constraints` 返回 `false` 后，`universe_init` 返回 `JNI_EINVAL(-1)`。这不是 JVM 崩溃 -- 是 **JVM 拒绝启动**。进程退出时的错误信息由约束函数内部的 `JVMFlag::printError` 打印，而不是由 `check_constraints` 框架打印。

### 6.2 错误信息的产生位置

每一个约束函数的实现中都有两部分：

```cpp
if (check_fails) {
  JVMFlag::printError(verbose, "Specific error message");
  return JVMFlag::VIOLATES_CONSTRAINT;
}
return JVMFlag::SUCCESS;
```

`printError` 将错误信息写入 `tty`（标准错误输出），然后返回 `VIOLATES_CONSTRAINT`。框架层（`check_constraints`）不干涉错误信息的内容 -- 因为只有约束函数知道**为什么**不合法（溢出了？cross flag 关系？对齐问题？），框架只知道**是否**合法。

### 6.3 不重试

```cpp
*canTryAgain = false;
```

约束失败与内存不足不同。内存不足换用 serial GC 后重试有时会成功，但约束失败说明参数组合本质上非法 -- 重试一万次也是同样的结果。所以 JVM 不进入重试循环，直接退出。

---

## 0. 源码清单

| 文件 | 行号 | 内容 |
|------|------|------|
| `jvmFlagConstraintList.hpp` | 42-49 | 8 种约束函数指针 typedef |
| `jvmFlagConstraintList.hpp` | 51-82 | JVMFlagConstraint 基类 + ConstraintType 枚举 |
| `jvmFlagConstraintList.hpp` | 84-99 | JVMFlagConstraintList 静态容器类 |
| `jvmFlagConstraintList.cpp` | 43-200 | 8 种子类实现 |
| `jvmFlagConstraintList.cpp` | 202-241 | `emit_constraint_*` 两套重载（NOP + 注册） |
| `jvmFlagConstraintList.cpp` | 244-331 | `EMIT_CONSTRAINT_PRODUCT_FLAG` 宏 + `init()` |
| `jvmFlagConstraintList.cpp` | 333-367 | `find()` / `find_if_needs_check()` / `check_constraints()` |
| `jvmFlagConstraintsGC.cpp` | 83-95 | `ConcGCThreadsConstraintFunc` -- 跨参数约束 |
| `jvmFlagConstraintsGC.cpp` | 329-336 | `MaxHeapSizeConstraintFunc` -- AfterErgo 约束 |
| `jvmFlagConstraintsGC.cpp` | 405-419 | `TLABWasteIncrementConstraintFunc` |
| `jvmFlagConstraintsGC.cpp` | 421-433 | `SurvivorRatioConstraintFunc` |
| `gc_globals.hpp` | 600-700 | 带 `constraint()` 声明的 flag |
| `universe.cpp` | 705 | `check_constraints(AfterMemoryInit)` 调用点 |
| `jvmFlag.cpp` | 1018-1364 | `apply_constraint_and_check_range_*` -- flag set 时的约束检查 |

---

## 总结：五层模型

| 层 | 职责 | 关键实现 |
|----|------|---------|
| 声明层 | 在 flag 定义处声明约束 | `product(...) constraint(func, type)` |
| 宏展开层 | 编译期生成注册代码 | `EMIT_CONSTRAINT_PRODUCT_FLAG -> emit_constraint_*` |
| 子类层 | 类型安全存储函数指针 + flag 地址 | `JVMFlagConstraint_size_t::_ptr` + `_constraint` |
| 列表层 | 存储全部约束对象 | `GrowableArray<JVMFlagConstraint*>` + `add()` |
| 检查层 | 分阶段遍历执行 | `check_constraints(type)` -- 筛选 + 全量执行 |
