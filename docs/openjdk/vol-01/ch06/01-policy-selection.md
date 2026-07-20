# 6.1 编译策略选择 + CICompilerCount ergonomics

上一章 [4.5](#/openjdk/vol-01/ch04/05-trivial-merged) 讲完了 `invocationCounter_init()`——初始化了每个 `JavaThread` 的调用计数器和回边计数器，设置了 `CompileThreshold`（x86 C2 = 10000）等阈值。计数器溢出时会触发编译请求，但用 C1 还是 C2、用多少个编译线程、如何调度——这些取决于编译策略。

`init_globals()` 第 106 行的 `compilationPolicy_init()` 就是选择这个策略并设置 CICompilerCount：

```cpp
/* === src/hotspot/share/runtime/init.cpp:101 === */

jint init_globals() {
  HandleMark hm;
  management_init();          // 103
  bytecodes_init();           // 104
  classLoader_init1();        // 105
  compilationPolicy_init();   // 106  -- 本节
  codeCache_init();           // 107
```

---

## compilationPolicy_init() 全貌

```cpp
/* === src/hotspot/share/runtime/compilationPolicy.cpp:61 === */

void compilationPolicy_init() {
  CompilationPolicy::set_in_vm_startup(DelayCompilationDuringStartup);

  switch(CompilationPolicyChoice) {
  case 0:
    CompilationPolicy::set_policy(new SimpleCompPolicy());
    break;
  case 1:
#ifdef COMPILER2
    CompilationPolicy::set_policy(new StackWalkCompPolicy());
#else
    Unimplemented();
#endif
    break;
  case 2:
#ifdef TIERED
    CompilationPolicy::set_policy(new TieredThresholdPolicy());
#else
    Unimplemented();
#endif
    break;
  }
  CompilationPolicy::policy()->initialize();
}
```

JDK 11 标准构建里同时包含 C1 和 C2 编译器。源码 `macros.hpp:327-330` 中，两个编译器同时存在时定义 `TIERED` 宏：

```cpp
/* === src/hotspot/share/utilities/macros.hpp:327 === */
#ifdef COMPILER1
#ifdef COMPILER2
  #define TIERED
#endif
```

有了 `TIERED`，`trueInTiered` 宏（`globals.hpp:49`）求值为 `true`，`c2_globals_x86.hpp:42` 中 `TieredCompilation` 的默认值就是 `true`。启用 Tiered 后，`CompilerConfig::set_tiered_flags()`（`compilerDefinitions.cpp:199`）把 `CompilationPolicyChoice` 从 0 改到 2：

```cpp
/* === src/hotspot/share/compiler/compilerDefinitions.cpp:199 === */
  if (FLAG_IS_DEFAULT(CompilationPolicyChoice)) {
    FLAG_SET_DEFAULT(CompilationPolicyChoice, 2);   // 强制 TieredThresholdPolicy
  }
```

所以 `CompilationPolicyChoice` 是一个内部 flag——用户不需要也不应该手动设。Tiered 时自动设为 2，非 Tiered 时保持默认 0。Case 1（`StackWalkCompPolicy`）在标准 JDK 11 里不会执行——因为 Choice 永远不会是 1。

实际路径：**Choice 2 -> `TieredThresholdPolicy` -> `initialize()`**。

---

## new TieredThresholdPolicy() 创建了什么

`TieredThresholdPolicy` 的继承关系（`tieredThresholdPolicy.hpp:165` + `compilationPolicy.hpp:40`）：

```
CHeapObj<mtCompiler>          // 堆分配对象，NMT 跟踪类型 mtCompiler
  CompilationPolicy           // 抽象基类，定义虚函数接口
    NonTieredCompPolicy       // 非 Tiered 基类（Simple/StackWalk）
    TieredThresholdPolicy     // Tiered 策略（本节）
```

`TieredThresholdPolicy` 直接从 `CompilationPolicy` 继承，不走 `NonTieredCompPolicy`。`CHeapObj<mtCompiler>` 意味着 `new TieredThresholdPolicy()` 在 C 堆上分配内存（和 `new` 一个普通 C++ 对象一样），不是 HotSpot 的 ResourceArea 或 Java 堆。`mtCompiler` 是 NMT（Native Memory Tracking）的分类标签。

### 构造函数和实例字段

`tieredThresholdPolicy.hpp:165-253`，对象创建时的状态：

```cpp
/* === src/hotspot/share/runtime/tieredThresholdPolicy.hpp:165 === */

class TieredThresholdPolicy : public CompilationPolicy {
  jlong _start_time;          // 策略初始化时间戳
  int _c1_count, _c2_count;   // C1/C2 编译器线程数
  double _increase_threshold_at_ratio;  // code cache 满时阈值缩放系数
  // ...
public:
  TieredThresholdPolicy() : _start_time(0), _c1_count(0), _c2_count(0) { }
```

`new TieredThresholdPolicy()` 创建的对象只有这 4 个实例字段，全部初始化为 0。此时的 `_c1_count` 和 `_c2_count` 还不知道该用多少个编译器线程——这些都靠后面的 `initialize()` 填充。

`initialize()` 末尾（`tieredThresholdPolicy.cpp:240-263`）：

```cpp
  set_c1_count(MAX2(count / 3, 1));           // _c1_count 从 0 变为实际值
  set_c2_count(MAX2(count - c1_count(), 1));  // _c2_count 从 0 变为实际值
  set_increase_threshold_at_ratio();           // _increase_threshold_at_ratio = 100/(100-50) = 2.0
  set_start_time(os::javaTimeMillis());        // _start_time 从 0 变为当前毫秒时间戳
```

这 4 个字段后续被 `compiler_count()`、`threshold_scale()`、`is_old()` 等方法读出——整个 JVM 运行期间，编译策略决策都依赖这 4 个运行时状态。

### set_policy() 存到哪

`compilationPolicy.hpp:41` 和 `compilationPolicy.cpp:56`：

```cpp
// compilationPolicy.hpp:41
class CompilationPolicy : public CHeapObj<mtCompiler> {
  static CompilationPolicy* _policy;    // 静态字段——全局唯一的策略对象指针
  // ...
  static void set_policy(CompilationPolicy* policy) { _policy = policy; }
  static CompilationPolicy* policy()                { return _policy; }
};

// compilationPolicy.cpp:56
CompilationPolicy* CompilationPolicy::_policy;  // 静态字段定义，初始为 NULL
```

`set_policy(new TieredThresholdPolicy())` 做的事情：

1. `new TieredThresholdPolicy()` 在 C 堆上分配一个 `TieredThresholdPolicy` 对象
2. `set_policy()` 把对象指针赋给 `CompilationPolicy::_policy`——一个**类级别的静态字段**

不是存到线程局部变量、不是存到 `Universe`、不是存到 `Thread`。是 `CompilationPolicy` 类自己的静态字段。整个 JVM 进程只有一个 `_policy`，后续所有需要编译策略决策的地方都通过 `CompilationPolicy::policy()` 获取这个指针。

这是策略模式 + 单例模式——编译策略是全局唯一的，`CompilationPolicy` 基类定义了纯虚函数接口（`event()`、`initialize()`、`select_task()` 等 10 个纯虚函数），`TieredThresholdPolicy` 提供了 Tiered 版本的具体实现。

```cpp
CompilationPolicy::policy()->initialize();   // 基类指针调虚函数，实际执行 TieredThresholdPolicy::initialize()
```

`policy()` 返回 `_policy` 指针（编译时类型是 `CompilationPolicy*`），通过虚函数表找到 `TieredThresholdPolicy::initialize()` 执行。

---

## set_in_vm_startup：启动期间推迟编译

```cpp
CompilationPolicy::set_in_vm_startup(DelayCompilationDuringStartup);
```

`DelayCompilationDuringStartup`（product flag，默认 `true`）控制 JVM 启动期间是否推迟编译。设为 true 时 `_in_vm_startup = true`，所有编译请求被抑制。

JVM 启动时要加载几千个类（`java.lang.Object`、`java.lang.String` 等），类的 `<clinit>` 静态初始化也会触发大量调用。这些调用如果立即触发 C1/C2 编译，编译线程抢 CPU 和内存，反而拖慢启动。

启动完成后 `compilationPolicy_completed_vm_startup()` 被调用（在 `compileBroker_init` 末尾），把 `_in_vm_startup` 置 false。

---

## TieredThresholdPolicy::initialize()：计算编译器线程数

`new TieredThresholdPolicy()` 创建的对象只有 4 个初始化为 0 的字段。`initialize()` 的任务是填充它们——根据 CPU 核数算出一共多少个编译器线程，C1 分配几个、C2 分配几个。

先看完整的 `initialize()`：

```cpp
/* === src/hotspot/share/runtime/tieredThresholdPolicy.cpp:202 === */

void TieredThresholdPolicy::initialize() {
  int count = CICompilerCount;
  bool c1_only = TieredStopAtLevel < CompLevel_full_optimization;

#ifdef _LP64
  if (CICompilerCountPerCPU会开启时) {
    // 公式：log2(n) * log2(log2(n)) * 3/2
    count = MAX2(log_cpu * loglog_cpu * 3 / 2, 2);
    // ... code cache 容量验证 ...
  }
#else
  // 32 位系统强制 3 个线程
  count = 3;
#endif

  // C1:C2 拆分
  set_c1_count(MAX2(count / 3, 1));
  set_c2_count(MAX2(count - c1_count(), 1));

  // 平台调优
  FLAG_SET_DEFAULT(InlineSmallCode, 2000);   // x86

  // 记录时间戳和阈值缩放系数
  set_increase_threshold_at_ratio();
  set_start_time(os::javaTimeMillis());
}
```

函数只做三件事：
1. 计算总编译线程数 `count`
2. 拆分为 `_c1_count` 和 `_c2_count`
3. 设置 `_start_time`、`_increase_threshold_at_ratio` 和 `InlineSmallCode`

---

### 第一步：计算 `count`

```cpp
  int count = CICompilerCount;
  bool c1_only = TieredStopAtLevel < CompLevel_full_optimization;
```

`count` 初始值为 `CICompilerCount` flag 的当前值。如果用户用 `-XX:CICompilerCount=N` 显式指定了，这个值就是用户给的 N。`c1_only` 判断是否禁用 C2——`TieredStopAtLevel`（默认 4）小于 4 时 C2 不参与。

接下来，如果用户没有显式指定 `CICompilerCount`，JVM 用公式自动算。这段只在 64 位系统上生效：

```cpp
#ifdef _LP64
  if (FLAG_IS_DEFAULT(CICompilerCountPerCPU) && FLAG_IS_DEFAULT(CICompilerCount)) {
    FLAG_SET_DEFAULT(CICompilerCountPerCPU, true);
  }
  if (CICompilerCountPerCPU) {
```

只有当用户既没有设 `CICompilerCountPerCPU` 也没有设 `CICompilerCount` 时才走下面的公式。这是标准 JDK 11 的默认状态——用户不需要调任何参数。

**公式**：

```cpp
    int log_cpu = log2_int(os::active_processor_count());
    int loglog_cpu = log2_int(MAX2(log_cpu, 1));
    count = MAX2(log_cpu * loglog_cpu * 3 / 2, 2);
```

`log2_int(x)` 返回 x 的二进制对数，向下取整。`os::active_processor_count()` 返回操作系统看到的可用 CPU 数——在容器里就是分配的 vCPU 数，不是物理 CPU 数。

看一下不同核数下的结果：

| CPU 核数 | log2(n) | log2(log2(n)) | 乘积 * 3/2 | count |
|---------|---------|--------------|-----------|-------|
| 2 | 1 | 0 -> 1 | 1.5 -> 2 | 2 |
| 4 | 2 | 1 | 3 | 3 |
| 8 | 3 | 1 | 4.5 -> 4 | 4 |
| 16 | 4 | 2 | 12 | 12 |
| 32 | 5 | 2 | 15 | 15 |

注释 `Simple log n seems to grow too slowly for tiered` 解释了为什么不用更简单的 `log2(n)-1`：16 核时 `log2(16)-1 = 3` 个线程，但 Tiered 下 C1 和 C2 同时跑，3 个线程根本不够——12 个线程（4 C1 + 8 C2）才能并行处理编译队列。

以本机为例——96 核的服务器：

```
log2(96)  = int(6.58) = 6
log2(log2(96)) = log2(6) = int(2.58) = 2
count = 6 * 2 * 3/2 = 18

C1: 18/3 = 6 个线程
C2: 18-6 = 12 个线程
```

96 核只分配了 18 个编译线程（6 C1 + 12 C2）。如果不用 `* loglog` 因子只用 `log2(n)`——`count = 6 * 3/2 = 9`，9 个线程对 96 核来说偏少。如果用线性增长——96 个线程，code cache 只有 48MB 根本装不下 96 个编译缓冲。

公式的设计目标：核数越多时增速越缓——核数翻倍线程数不会翻倍。从 16 核到 96 核（6 倍），线程只从 12 增到 18（1.5 倍）。这种亚线性增长在高核数机器上避免编译线程抢占过多 CPU 留给业务逻辑。

**code cache 容量验证**：

code cache 是 JVM 里一段预留的本地内存区域，专门存放 JIT 编译后生成的机器码。C1 或 C2 编译一个 Java 方法时，在 code cache 里分配一块空间，把翻译出来的 x86 指令写进去。`ReservedCodeCacheSize`（x86_64 默认 48MB）是这个区域的最大容量。

每个编译线程编译时要先拿一块 CodeBuffer——一块临时的内存缓冲区，在里面生成机器码，编译完成后把内容拷贝到 code cache 并释放 CodeBuffer。所以同时运行的编译线程数不能超过 "code cache 剩余空间 / 每个编译器的 CodeBuffer 大小"——不然所有线程同时拿 CodeBuffer 会撑爆 code cache。

ch07 会详细展开 code cache 的三段堆结构、flag 组合和扩容机制。这里只需要理解为什么编译线程数要受它约束。

公式算出的 `count` 还要经过 code cache 容量检查：

```cpp
    size_t c1_size = Compiler::code_buffer_size();        // C1 编译缓冲大小
    size_t c2_size = C2Compiler::initial_code_buffer_size(); // C2 编译缓冲大小
    size_t buffer_size = c1_only ? c1_size : (c1_size/3 + 2*c2_size/3);
```

`buffer_size` 是一个编译线程需要的平均 buffer 大小。C1:C2 线程比是 1:2，所以用 `c1_size * 1/3 + c2_size * 2/3` 做加权平均——不是精确值，是估计。

```cpp
    int max_count = (ReservedCodeCacheSize - (CodeCacheMinimumUseSpace DEBUG_ONLY(* 3))) / (int)buffer_size;
    if (count > max_count) {
      count = MAX2(max_count, c1_only ? 1 : 2);
    }
    FLAG_SET_ERGO(intx, CICompilerCount, count);
```

`max_count` = code cache 能容纳的最大编译线程数。`ReservedCodeCacheSize`（x86_64 C2 默认 48MB）减去最小保留空间（`CodeCacheMinimumUseSpace`，400KB，debug 乘以 3 即 1.2MB），除以单个编译器的 buffer 大小。

如果公式算出的线程数超过 code cache 容量，裁剪到不超过，但最少保留 2 个（C1 和 C2 各至少 1 个）。`FLAG_SET_ERGO` 写入最终的 `CICompilerCount`。

至此 `count` 的值确定下来了。以本机 96 核为例——公式算出 18，code cache 容量检查通过（48MB 的 code cache 足够容纳 18 个编译缓冲），`count = 18` 被 `FLAG_SET_ERGO` 写入 `CICompilerCount`。后续 `_c1_count` 和 `_c2_count` 就从这个值拆分。

---

### 第二步：C1:C2 拆分

```cpp
  if (c1_only) {
    set_c1_count(count);          // _c1_count = count，全部给 C1
  } else {
    set_c1_count(MAX2(count / 3, 1));           // _c1_count = count/3（至少 1）
    set_c2_count(MAX2(count - c1_count(), 1));   // _c2_count = 剩余（至少 1）
  }
```

正常 Tiered 模式：`count/3` 给 C1，剩下给 C2。本机 96 核 `count=18`，所以 `_c1_count = 18/3 = 6`，`_c2_count = 18-6 = 12`。count=4 时 `_c1_count=1`、`_c2_count=3`。最少各保留 1 个。

C2 线程占比约 2/3——C2 编译一个方法需要几秒到几十秒，C1 只需要几十到几百毫秒。C2 队列积压时，更多 C2 线程才能并行处理。

`c1_only` 模式（`TieredStopAtLevel < 4`）只分 C1 线程，C2 不参与。

---

### 第三步：填充剩余字段

```cpp
  set_increase_threshold_at_ratio();   // _increase_threshold_at_ratio = 100/(100-50) = 2.0
  set_start_time(os::javaTimeMillis()); // _start_time = 当前时间戳
}
```

`_increase_threshold_at_ratio` 和 `_start_time` 是构造函数中初始化为 0 的最后两个字段。前者在 6.2 的 `threshold_scale()` 中用到——code cache 快满时用于指数级提升 C1 阈值。后者记录策略初始化时间，后续判断方法"存在多久"时用到。

另外 `initialize()` 还顺带做了一个平台内联参数设置（`InlineSmallCode = 2000`，x86），这个和编译器线程数无关，是 Tiered 策略顺便做的平台适配。

`compilationPolicy_init()` 到此结束。`_in_vm_startup = true`（启动期间抑制编译），`_policy` 指向 `TieredThresholdPolicy` 对象，`_c1_count = 6`、`_c2_count = 12`，编译策略就绪。

策略选好了、编译线程数定了。下一节 [6.2](#/openjdk/vol-01/ch06/02-thresholds) 展开 Tiered 模式的 5 级阈值体系——方法从解释器到 C2 的逐级升级条件、编译器队列反馈如何动态调整阈值、code cache 满时的指数级抑制。
