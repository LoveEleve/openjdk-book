# clinit — 类初始化机制

> 纯源码分析，基于 OpenJDK 11 slowdebug
> 源文件：instanceKlass.cpp (initialize_impl, L922-1076)

---

## 零、解决什么问题

> static int x = computeValue() 中的 computeValue() 什么时候执行？多线程同时触发怎么办？clinit 里抛异常怎么办？

**clinit = 类的静态构造器。** 保证三点：1) 线程安全——只有一个线程执行 2) 只执行一次——init_state=fully_initialized 后再也不执行 3) 父类优先——子类 clinit 前父类必须完成

---

## 一、状态机

```
allocated(0) -- loaded(1) -- linked(2) -- being_initialized(3) -- fully_initialized(4)
                                                                -- initialization_error(5)
```

---

## 二、initialize_impl() 完整源码

> instanceKlass.cpp:922-1076, 155行, 严格遵循 JVMS 11步骤

```cpp
void InstanceKlass::initialize_impl(TRAPS) {
  HandleMark hm(THREAD);
  link_class(CHECK);                              // Step 0: 确保已链接

  // Step 1: 获取 init_lock
  Handle h_init_lock(THREAD, init_lock());
  ObjectLocker ol(h_init_lock, THREAD, h_init_lock() != NULL);
  Thread *self = THREAD;

  // Step 2: 等待其他线程的初始化
  while(is_being_initialized() && !is_reentrant_initialization(self)) {
    ol.waitUninterruptibly(CHECK);               // wait 等待
  }

  // Step 3: 递归初始化检测 - 同一线程在clinit中再次触发自己
  if (is_being_initialized() && is_reentrant_initialization(self)) {
    return;  // is_reentrant_initialization() = (_init_thread == self)
  }

  // Step 4: 已初始化-直接返回
  if (is_initialized()) { return; }

  // Step 5: 初始化错误-抛 NoClassDefFoundError
  if (is_in_error_state()) {
    THROW_MSG(vmSymbols::java_lang_NoClassDefFoundError(), className);
  }

  // Step 6: CAS 抢初始化权
  set_init_state(being_initialized);              // atomic state transition!
  set_init_thread(self);                          // 记录执行线程(死锁检测用)

  // Step 7: 初始化父类+父接口
  if (!is_interface()) {
    Klass* super_klass = super();
    if (super_klass != NULL && super_klass->should_be_initialized()) {
      super_klass->initialize(THREAD);            // 递归: 父类先clinit
    }
    if (!HAS_PENDING_EXCEPTION && has_nonstatic_concrete_methods()) {
      initialize_super_interfaces(THREAD);        // 父接口
    }
    if (HAS_PENDING_EXCEPTION) {                   // 父类失败-传播
      Handle e(THREAD, PENDING_EXCEPTION);
      CLEAR_PENDING_EXCEPTION;
      set_initialization_state_and_notify(initialization_error, THREAD);
      THROW_OOP(e());
    }
  }

  // Step 8: 执行 clinit 方法
  call_class_initializer(THREAD);
  // call_class_initializer 内部:
  //   methodHandle clinit(THREAD, class_initializer());
  //   if (clinit != NULL) JavaCalls::call_static(&result, ik, "clinit", "()V", CHECK);

  // Step 9: 成功 - fully_initialized + 唤醒等待线程
  if (!HAS_PENDING_EXCEPTION) {
    set_initialization_state_and_notify(fully_initialized, CHECK);
    return;
  }

  // Step 10-11: 失败 - initialization_error + 唤醒等待线程
  Handle e(THREAD, PENDING_EXCEPTION);
  CLEAR_PENDING_EXCEPTION;
  set_initialization_state_and_notify(initialization_error, THREAD);
  THROW_OOP(e());                                  // ExceptionInInitializerError
}
```

### 2.1 set_init_state() - 状态转换验证 (L3762-3768)

```cpp
void InstanceKlass::set_init_state(ClassState state) {
  bool good_state = is_shared() ? (_init_state <= state)  // 共享类允许原地踏步
                                : (_init_state < state);   // 非共享类必须严格递增
  assert(good_state || state == allocated, "illegal state transition");
  assert(_init_thread == NULL, "should be cleared before state change");
  _init_state = (u1)state;
}
```

### 2.2 set_initialization_state_and_notify() - 完成+唤醒

```cpp
void InstanceKlass::set_initialization_state_and_notify(ClassState state, TRAPS) {
  Handle h_init_lock(THREAD, init_lock());
  ObjectLocker ol(h_init_lock, THREAD);
  set_init_thread(NULL);              // 清除执行线程
  set_init_state(state);              // fully_initialized 或 initialization_error
  ol.notify_all(CHECK);               // 唤醒所有 wait 的线程
}
```

---

## 三、死锁检测：_init_thread 重入机制

```
场景: 线程T1正在执行类X的clinit
  X.clinit 中调用了 new Y()
  Y的父类是X - Y初始化前需先初始化X
  
  initialize_impl(X) 被递归调用:
  Step 2: is_being_initialized() == true
  check: is_reentrant_initialization(self) - _init_thread == T1 - true!
  Step 3: return (不等待, 不报错, 直接返回继续)

与PlaceholderTable循环检测的区别:
  PlaceholderTable.check_seen_thread: 加载阶段循环(A加载中需要B, B需要A - ClassCircularityError)
  _init_thread检查: 初始化阶段重入 - 同一线程 - 直接返回(正常行为)
```

---

## 四、GDB 验证

```gdb
break InstanceKlass::initialize_impl
commands
  silent
  printf "initialize_impl: %s, state=%d\n", name()->as_C_string(), _init_state
  continue
end

break instanceKlass.cpp:988
commands
  silent
  printf "  -> set_init_state(being_initialized), thread=%p\n", self
  continue
end
```

**可证伪断言**：

| # | 断言 | 验证 | 预期 |
|---|------|------|:---:|
| 1 | clinit 只执行一次 | break initialize_impl - 同一类只触发一次 | 一次 fully_initialized |
| 2 | _init_state linked(2)->being(3)->fully(4) | 三次 p _init_state | 2->3->4 |
| 3 | clinit异常 -> _init_state=initialization_error(5) | 构造抛异常的静态块测试 | 5 |
| 4 | 第二个线程发现 being_initialized 时 wait | break step2 的 while | waitUninterruptibly 调用 |
| 5 | 重入检测: _init_thread==self 时直接返回 | break step3 | 不等待直接返回 |

---

## 五、设计原理：3 项核心决策

### 6.1 为什么用 6 状态机（allocated→loaded→linked→being_initialized→fully_initialized→initialization_error）而不是 4 状态？

3 种通常的"简单"状态（unloaded→loaded→initialized）无法处理以下场景：

1. **being_initialized 是必需的中间态** — 多线程同时触发初始化时，必须有一个"正在初始化"的中间态，其他线程才能 wait()。如果从 loaded 直接跳到 fully_initialized（无中间态），其他线程看到"还没初始化"就会尝试自己初始化 → 多次执行 `<clinit>`。

2. **initialization_error 是必需的错误态** — `<clinit>` 可能抛出异常。如果错误后回到 allocated/loaded → 其他线程会再次尝试初始化 → 无限异常循环。需要专门的"错误"状态来永久记录"这个类初始化失败了"。

3. **linked 需要独立于 loaded** — 验证（verify）需要读取字节码，而字节码在 linked 之前的 being_initialized 是不可能的。同时，`<clinit>` 中可能调用静态方法，这些方法必须先通过链接解析（resolve）。因此 loaded→linked→being_initialized 是一个严格顺序。

### 6.2 为什么 `<clinit>` 使用 init_lock（每个类一个对象锁）而不是 SystemDictionary_lock（全局锁）？

**死锁避免是首要原因**。`<clinit>` 执行期间，代码可能触发其他类的加载：

```
Thread T1:
  init_lock(A) → A.<clinit>() 中调用 new B()
    → B needs loading → SystemDictionary_lock → Load B
    → B.<clinit>() 中调用 A.someMethod()
      → A needs init → init_lock(A) 等待... ← 死锁!
```

如果 `<clinit>` 持有 `SystemDictionary_lock`，上述场景瞬间死锁 —— B 的加载也需要 `SystemDictionary_lock`，但 T1 已持有。

而 init_lock 是**每个类一个的对象锁**：
- T1 持有 `init_lock(A)`，可以安全地触发 B 的加载（B 加载需要 `SystemDictionary_lock`，不冲突）
- 如果 B 的 `<clinit>` 又触发 A，T1 的 `_init_thread == self` 检测直接返回（重入检测），不阻塞

**粒度优势**：全局锁 → 所有类初始化串行化（每秒只能初始化 1 个类）；每类锁 → N 个类可以并行初始化（只要它们不互相依赖）。

### 6.3 为什么 ThreadBlockInVM 在 clinit 的 wait() 中？

`waitUninterruptibly()` 是阻塞操作（等待正在初始化类的线程完成）。如果直接用 `ObjectLocker.wait()`：
- 当前线程处于 `_thread_in_vm` 状态
- 该线程占用了 GC safepoint 槽位
- GC 需要的 safepoint 必须等所有线程退出 VM → 可能等数秒

`ThreadBlockInVM` 在 `wait()` 前将线程状态从 `_thread_in_vm` 切换为 `_thread_blocked`：
- GC safepoint 不再需要等待此线程 → safepoint 达成立即可达
- `wait()` 结束后状态恢复为 `_thread_in_vm`
- **保证：即使 clinit 初始化耗时 60 秒（如加载加密库），GC 仍能按时执行**

---

## 六、总结

### 数据结构
- **_init_state(u1)**: 6态状态机, 关键三态: linked->being_initialized->fully_initialized
- **_init_thread(Thread*)**: 记录clinit执行线程, 用于死锁检测(重入防护)
- **init_lock**: 对象锁, 保证状态转换原子性 + wait/notify 协调

### 算法
- **CAS抢初始化权**: linked->being_initialized 原子转换, 只有一个线程成功
- **等待-通知**: 其他线程 waitUninterruptibly() - 完成 notify_all 唤醒
- **递归重入防护**: _init_thread==self - 直接返回(不等待自己)
- **父类优先**: super->initialize() 递归 - 父类先clinit
- **错误传播**: 父类/接口失败 - 本类设 error - ExceptionInInitializerError

---

## 源文件清单

| 文件 | 关键内容 |
|------|---------|
| `instanceKlass.cpp` | initialize_impl() — clinit 主逻辑 |
| `thread.cpp` | Thread 状态管理 |

## 可证伪断言

| # | 断言 | 验证 | 预期 |
|---|------|------|:---:|
| 1 | `<clinit>` 线程安全通过 `_init_state` 状态机 + `_init_thread` 保证 | 源码 `instanceKlass.cpp` | CAS + wait/notify |
| 2 | 状态机：allocated(0)→loaded(1)→linked(2)→being_initialized(3)→fully_initialized(4)→err(5) | 源码 `instanceKlass.hpp` | 6 状态 |
| 3 | 父类先于子类初始化：`super->initialize()` 递归调用 | 源码 | 递归 |
| 4 | 同一线程重入时 `_init_thread == self` 直接返回（不等待自己） | 源码 | self check |
| 5 | 初始化失败后类标记为 initialization_error(5)，不可恢复 | 源码 | error=5 |
