# C++11 并发与内存模型

HotSpot JVM 是并发编程的极致产物。GC 线程、JIT 编译线程、Service Thread、VM Thread 全部并发运行。HotSpot 使用自己的并发原语（`OrderAccess`、`Atomic` 封装），但设计理念与 C++11 标准库完全一致——理解 C++11 并发库，就能理解 HotSpot 为什么那样设计。

## HotSpot 的并发全景

JVM 内部运行着多种并发线程，它们通过精心设计的同步机制协作：

```
HotSpot 线程模型（OS 原生线程 1:1）：
┌──────────────────────────────────────────────────┐
│  JavaThread (多个)                               │
│  执行 Java 字节码，每个 Java Thread 对应一个     │
├──────────────────────────────────────────────────┤
│  VMThread (唯一)                                 │
│  执行 VM 操作（GC、类加载、去优化等）             │
│  所有 JavaThread 必须在安全点（safepoint）停止   │
├──────────────────────────────────────────────────┤
│  ConcurrentGCThread / G1ConcurrentRefineThread   │
│  并发垃圾回收，与 Java 线程同时运行               │
├──────────────────────────────────────────────────┤
│  CompilerThread                                  │
│  JIT 编译热点方法                                 │
├──────────────────────────────────────────────────┤
│  ServiceThread                                   │
│  JVMTI、低内存检测、字符串去重                   │
├──────────────────────────────────────────────────┤
│  WatcherThread                                   │
│  定时任务（偏向锁撤销、周期性任务）               │
└──────────────────────────────────────────────────┘
```

## std::thread：线程的现代化封装

从 C pthread 到 C++ thread 的质变：

```cpp
#include <thread>
#include <iostream>

// pthread 方式（C 风格）
// pthread_create(&tid, NULL, func, &arg);  // void* 无类型安全

// C++11 方式：任意可调用对象 + 类型安全参数
void worker(int id, const std::string& msg) {
    std::cout << "[" << id << "] " << msg << std::endl;
}

int main() {
    // 方式 1：函数指针
    std::thread t1(worker, 1, "hello");

    // 方式 2：lambda（最常用）
    std::thread t2([](int x) {
        std::cout << x * x << std::endl;
    }, 42);

    // 方式 3：函数对象（仿函数）
    struct Task {
        void operator()(int x) const { std::cout << x << std::endl; }
    };
    std::thread t3(Task{}, 100);

    t1.join();  // 等待线程结束
    t2.join();
    t3.join();
}
```

### join vs detach

```cpp
std::thread t([] { /* 工作 */ });

t.joinable();  // 检查是否可以 join/detach
t.join();      // 等待线程结束，回收资源
// 或者
t.detach();    // 线程独立运行，与 thread 对象解绑

// 危险！如果 thread 对象析构时既未 join 也未 detach
// → std::terminate() 被调用 → 进程终止
```

### thread_local：每个线程的独立副本

```cpp
thread_local int tls_counter = 0;  // 每个线程独立的 counter

void thread_func(int id) {
    tls_counter = id;              // 修改自己线程的副本
    // 不需要加锁——每个线程访问的是自己的变量
}

// 典型用法：线程级缓存、线程级统计
thread_local thread_local std::string thread_name;  // C++14
```

HotSpot 中 `JavaThread` 有大量线程局部数据（如 ResourceArea、HandleArea），就是通过 TLS（Thread Local Storage）实现的——不过 HotSpot 用的是自己的 TLS 机制而不是 `thread_local` 关键字（因为需要支持 C++98）。

## std::mutex 与 RAII 锁守卫

C pthread 的痛点：必须手动配对 `lock/unlock`，任何提前 return 或异常都会跳过 unlock。

```cpp
#include <mutex>

std::mutex mtx;
int counter = 0;

// lock_guard：简单场景——不可手动解锁
void increment_guard() {
    std::lock_guard<std::mutex> lock(mtx);
    counter++;
    // 离开作用域自动解锁——即使这里 return/抛异常
}

// unique_lock：灵活场景——可延迟加锁、提前解锁
void increment_unique() {
    std::unique_lock<std::mutex> lock(mtx, std::defer_lock);  // 先不加锁
    // ... 做一些不需要锁的事 ...
    lock.lock();       // 手动加锁
    counter++;
    lock.unlock();     // 提前解锁
    // ... 锁外的操作 ...
    // 析构时如果还持有锁，自动解锁
}
```

**三个构造策略：**

| 策略 | 构造行为 | 场景 |
|------|---------|------|
| （默认） | 立即 lock | 标准临界区保护 |
| `std::defer_lock` | 不加锁 | 延迟到需要时再加锁 |
| `std::try_to_lock` | 尝试获取，不阻塞 | 非阻塞操作 |
| `std::adopt_lock` | 接收已锁的 mutex | 通过已有锁管理释放 |

HotSpot 等价物是 `MutexLockerEx`（详见 vol-cxx ch06-RAII）。

## std::atomic：原子操作与无锁编程

### 基础原子操作

```cpp
#include <atomic>

std::atomic<int> counter(0);

// 原子递增（等价于 counter.fetch_add(1)）
counter++;  // 线程安全，无需 mutex

// 常用原子操作
int old = counter.load();               // 原子读取
counter.store(42);                      // 原子写入
int old = counter.exchange(100);        // 原子交换，返回旧值
int old = counter.fetch_add(5);         // 原子加，返回旧值
int old = counter.fetch_sub(3);         // 原子减

// CAS 循环——无锁编程的基石
void cas_example(std::atomic<int>& value) {
    int expected = value.load();
    int desired;
    do {
        desired = expected + 1;
        // compare_exchange_weak: 如果 value == expected，写入 desired
        //   否则 expected = value（更新为实际值）
        // "weak" 版本可能虚假失败，性能更好，适合循环内
    } while (!value.compare_exchange_weak(expected, desired));
}
```

### memory_order：控制内存可见性顺序

原子操作默认使用最严格的内存序 `seq_cst`（顺序一致性）。在性能关键场景中，可以用更宽松的内存序减少同步开销。

| memory_order | 保证 | 典型场景 |
|-------------|------|---------|
| `relaxed` | 只保证原子性，无顺序约束 | 纯计数器、ID 生成器 |
| `acquire` | 读之后的操作不能被重排到这个读之前 | 读 flag（消费者侧） |
| `release` | 写之前的操作不能被重排到这个写之后 | 写 flag（生产者侧） |
| `acq_rel` | acquire + release | RMW 操作（如 CAS 循环） |
| `seq_cst` | 全局顺序一致（默认，最重） | 需要严格顺序保证 |

**acquire-release 经典范式：生产者-消费者通过原子 flag 同步：**

```cpp
std::atomic<bool> ready(false);
int data = 0;  // 普通变量，不是 atomic

// 生产者线程
void producer() {
    data = 42;                                    // (1) 写数据
    ready.store(true, std::memory_order_release); // (2) 发布 flag
}

// 消费者线程
void consumer() {
    while (!ready.load(std::memory_order_acquire)); // (3) 获取 flag
    assert(data == 42);                             // (4) 断言成立！
}
```

**为什么 assertion 成立？** 由于 `release`-`acquire` 配对，(1) 和 (2) 之间的 happens-before 关系传递到 (3) 和 (4)：生产者侧的 `data = 42` 对消费者侧在读到 `ready == true` 后可见。

### relax 的正确使用场景

```cpp
std::atomic<uint64_t> request_id(0);

uint64_t next_id() {
    // 只需要递增保证唯一，不关心与其他变量的顺序
    return request_id.fetch_add(1, std::memory_order_relaxed);
}

// 错误示范——relaxed 不保证跨变量同步
// data.store(42, relaxed);
// flag.store(true, relaxed);  // 另一个线程可能先看到 flag=true，data 是旧值
```

## happens-before：并发正确性的核心

`happens-before` 是 C++11 内存模型的基石——它定义了"一个线程的写操作何时能被另一个线程看到"。

**建立 happens-before 的三种方式：**

1. **sequenced-before（线程内顺序）**：同一线程内前一条语句 happens-before 后一条
2. **synchronizes-with（跨线程同步）**：mutex 的 `unlock()` synchronizes-with 下一个 `lock()`；atomic 的 `release` 写 synchronizes-with 同一变量的 `acquire` 读
3. **传递性**：如果 A happens-before B 且 B happens-before C，则 A happens-before C

```
通过 mutex 建立 happens-before：

线程 A                            线程 B
data = 42;  (A)                   
    │ sequenced-before             
    ▼                              
mtx.unlock()  (B) ──────────synchronizes-with──→ mtx.lock()  (C)
                                                      │ sequenced-before
                                                      ▼
                                                  read(data);  (D)
                                                      

A happens-before D → D 肯定能看到 data = 42
```

**没有 happens-before 关系 = 数据竞争（data race）= 未定义行为。** 这是用 `std::atomic` 或 `std::mutex` 保护所有共享数据的根本原因——不是"应该"，而是"必须"。

## std::condition_variable：生产者-消费者

条件变量解决"等待某个条件成立"的问题——线程进入睡眠，条件满足时被唤醒。

```cpp
#include <mutex>
#include <condition_variable>
#include <queue>

std::mutex mtx;
std::condition_variable cv;
std::queue<int> q;
bool done = false;

// 消费者
void consumer(int id) {
    while (true) {
        std::unique_lock<std::mutex> lock(mtx);
        // 带谓词的 wait：自动处理虚假唤醒（spurious wakeup）
        cv.wait(lock, []{ return !q.empty() || done; });

        if (done && q.empty()) break;

        int item = q.front(); q.pop();
        lock.unlock();  // 处理 item 前就解锁，减少锁竞争

        process(item);
    }
}

// 生产者
void producer(int id) {
    for (int i = 0; i < 100; i++) {
        {
            std::lock_guard<std::mutex> lock(mtx);
            q.push(i);
        }
        cv.notify_one();  // 唤醒一个消费者
    }
}
```

**虚假唤醒（spurious wakeup）**：操作系统可能在条件不满足时虚假唤醒线程。因此 `wait` 必须用**带谓词的版本**（等价于 `while(!pred) wait()`），永远不要用不带谓词的 `wait()`。

## std::future / std::promise / std::async：异步任务

```cpp
#include <future>
#include <iostream>

int compute(int x) {
    std::this_thread::sleep_for(std::chrono::seconds(1));  // 模拟耗时
    return x * x;
}

int main() {
    // std::async：启动异步计算
    auto fut1 = std::async(std::launch::async, compute, 42);
    auto fut2 = std::async(std::launch::async, compute, 100);

    // 主线程继续做其他事
    do_something_else();

    // get() 阻塞等待结果；如果异常，在此重新抛出
    int r1 = fut1.get();
    int r2 = fut2.get();
    std::cout << r1 << ", " << r2 << std::endl;
}
```

promise/future 的关系：

```
┌─────────────┐    共享状态    ┌─────────────┐
│   promise   │ ────────────► │   future    │
│ set_value() │               │   get()     │
└─────────────┘               └─────────────┘
一个线程通过 promise 设置值      另一个线程通过 future 获取

std::packaged_task：打包可调用对象，执行后自动设置 promise
std::async：最方便——自动创建线程 + promise + future
```

## HotSpot 的 OrderAccess 与 C++ 内存序对应

HotSpot 有自己的内存屏障封装 `OrderAccess`，其语义与 C++11 内存序精确对应：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/orderAccess.hpp

// HotSpot 的 load_acquire  → std::memory_order_acquire
inline T OrderAccess::load_acquire(const volatile T* p);

// HotSpot 的 store_release → std::memory_order_release
inline void OrderAccess::release_store(volatile T* p, T v);

// HotSpot 的 fence         → std::atomic_thread_fence(std::memory_order_seq_cst)
inline void OrderAccess::fence();
```

HotSpot 典型使用场景——安全点（safepoint）协议的同步：

```cpp
// 线程 A（VMThread）设置安全点请求
SafepointSynchronize::_state = _synchronizing;    // (1)
OrderAccess::fence();                             // 全屏障
// 线程 B（JavaThread）检查安全点
if (SafepointSynchronize::_state != _not_synchronized) {
    // 进入安全点...
}
// 线程 B 的 load_acquire 保证看到 VMThread 的写入
```

C++11 等价写法：

```cpp
std::atomic<int> safepoint_state(_not_synchronized);
// 线程 A
safepoint_state.store(_synchronizing, std::memory_order_release);
// 线程 B
if (safepoint_state.load(std::memory_order_acquire) != _not_synchronized) { }
```

### 汇编验证：x86 上的内存屏障

x86 的 TSO（Total Store Order）模型让 acquire/release 在 x86 上**几乎免费**：

```asm
; std::atomic<int>::store(x, std::memory_order_release)
    mov DWORD PTR [rdi], esi

; std::atomic<int>::load(std::memory_order_acquire)
    mov eax, DWORD PTR [rdi]

; std::atomic<int>::fetch_add(1, std::memory_order_seq_cst)
    lock xadd DWORD PTR [rdi], 1    ; lock 前缀 = 全屏障
```

x86 天然保证 "load-load、load-store、store-store" 的顺序，只有 "store-load" 才需要屏障。`release` 写只是普通 `mov`，`acquire` 读也是普通 `mov`——它们在 x86 上零额外指令。只有 `seq_cst` 的 RMW 操作才需要 `lock` 前缀。

这和 ARM（弱内存序）形成对比——ARM 上 `acquire` 需要 `ldar` 指令，`release` 需要 `stlr` 指令。这就是 C++ 抽象的威力：同一份源代码，编译器根据目标平台插入正确的屏障指令。

### x86 TSO 模型为什么 acquire/release 几乎免费

```
x86 TSO 保证（硬件自动提供）：
 ✅ Load-Load 顺序：    不会把后面的 load 重排到前面的 load 之前
 ✅ Load-Store 顺序：   不会把后面的 store 重排到前面的 load 之前
 ✅ Store-Store 顺序：  不会把后面的 store 重排到前面的 store 之前
 ❌ Store-Load 顺序：   可能把后面的 load 重排到前面的 store 之前
                         → 需要 mfence/lock 前缀

acquire 语义：后续 load/store 不能重排到 acquire 之前
  → 在 x86 上：只需要保证 Store-Load 和 Load-Load
  → 而 Load-Load 和 Load-Store 已由硬件保证
  → 结论：acquire load = 普通 mov（无额外指令）

release 语义：之前的 load/store 不能重排到 release 之后  
  → 在 x86 上：只需要保证 Store-Store 和 Load-Store
  → Store-Store 和 Load-Store 已由硬件保证
  → 结论：release store = 普通 mov（无额外指令）

只有 seq_cst (RMW) 需要 Store-Load 屏障 → lock 前缀
```

## ABA 问题与带 tag 的原子指针解决方案

无锁编程中，CAS 循环面临 ABA 问题：一个值从 A 变成 B，又变回 A——CAS 无法区分它是否被修改过。

```cpp
// ABA 问题示例（简化）
std::atomic<Node*> head;

void pop_with_aba() {
    Node* old_head = head.load();
    do {
        if (old_head == nullptr) return;
    } while (!head.compare_exchange_weak(old_head, old_head->next));
    // 在 old_head 和 head->next 之间，head 可能被其他线程：
    // pop 了 old_head → push 了新节点 → 又 push 回了 old_head
    // → CAS 成功，但 old_head->next 已经失效！
    delete old_head;  // 可能 double free！
}
```

**解决方案：带 tag 的指针——DCAS（Double-Word CAS）**

x86_64 的 `cmpxchg16b`（128 位 CAS）可以原子地比较并交换 16 字节——用高 64 位作为 tag（版本号），低 64 位作为指针。

```cpp
// 带 tag 的原子指针（在支持 128-bit CAS 的平台上）
struct TaggedPtr {
    void* ptr;
    uint64_t tag;
};

std::atomic<TaggedPtr> head;

void push_with_tag(Node* node) {
    TaggedPtr old = head.load();
    TaggedPtr desired;
    do {
        node->next = (Node*)old.ptr;
        desired = {node, old.tag + 1};  // 指针 + 新 tag
    } while (!head.compare_exchange_weak(old, desired));
    // 即使 ptr 回到旧值，tag 也变了 → CAS 正确失败
}
```

在 x86_64 上，`std::atomic<TaggedPtr>` 如果 `sizeof(TaggedPtr) == 16` 且平台支持 lock-free 128-bit CAS，编译器会自动生成 `lock cmpxchg16b` 指令。`std::atomic::is_lock_free()` 可运行时检查。

## 小结 Checklist

- [ ] std::thread 接受任意可调用对象（函数/lambda/functor），参数类型安全
- [ ] thread 不可拷贝（= 唯一所有权），可移动；析构前必须 join 或 detach
- [ ] lock_guard 简单 RAII 锁，unique_lock 支持 defer/try/adopt + 手动 unlock
- [ ] atomic 保证原子性和内存序；volatile 只禁止编译器优化，不保证线程安全
- [ ] memory_order 五级：relaxed（纯原子）→ release/acquire（成对同步）→ seq_cst（全局顺序）
- [ ] acquire-release 配对保证 release 之前的所有写入对 acquire 之后的读取可见
- [ ] happens-before = sequenced-before + synchronizes-with + 传递性——无此关系 = 数据竞争
- [ ] condition_variable 必须用带谓词的 wait() 处理虚假唤醒
- [ ] async/future/promise 提供标准化的异步任务模型：启动 → 返回 → 获取结果/异常
- [ ] x86 TSO 使 acquire/release 零指令开销（只需普通 mov）；seq_cst RMW 才需 lock 前缀
- [ ] ABA 问题用带 tag 的原子指针解决——利用 128-bit CAS（lock cmpxchg16b）

> *详细讲解参见 C++ 教程: [C++11 新特性全解](../../../my-openjdk/cpp/stage1-C++11基础/C++高级-04-C++11新特性全解.md)*
> *详细讲解参见 C++ 教程: [C++11 并发编程](../../../my-openjdk/cpp/stage3-标准库与工程/C++高级-10-C++并发编程.md)*
