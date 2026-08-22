# 04. 线程从 Java 进入 VM——这一瞬间怎么保证安全?— interfaceSupport

> **前置依赖**:[17-threads/02 — JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md):ThreadStateTransition 的转换三拍在这里被 RAII 类套用;[17-threads/03 — Thread-SMR](openjdk/vol-02/17-threads/03-thread-smr-handshake.md):ThreadInVMForHandshake 是 Handshake 的执行上下文;[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):safepoint 检查点的消费者
> → **后续**:域 18 Safepoint(safepoint 怎么叫所有线程停住)
> 关联域: 17-threads(线程)、18-safepoint、27-jni(JNI 状态转换的消费方)

线程执行 `new Object()`、`synchronized` 或 JNI 调用，都会从 Java 代码进到 VM 内部再出来——每次进出都要改 `_thread_state`、做序列化、查 safepoint。漏一次：线程停在错误状态，GC 可能扫到一半的栈，直接崩。

JVM 里没有 `finally`，而 HotSpot 的答案不是“让每个调用点都自己记住顺序”，而是 **RAII 守卫**：一组在构造时进 VM、析构时出 VM 的类，全部定义在 `interfaceSupport.inline.hpp`。本篇要回答的核心问题是：

1. 为什么每次进出 VM 不能手写几行 `set_thread_state()` 就完事？
2. `ThreadInVMfromNative` / `ThreadToNativeFromVM` / `ThreadBlockInVM` 这些守卫各自替调用点背了什么协议？
3. 为什么“特殊退出条件”（异步异常、挂起、critical native 解锁）总是放到守卫析构里收尾？

答案先压成一句话：**interfaceSupport 的核心不是“省代码”，而是把状态切换、栈可 walk、safepoint 检查、Handle 区边界和异步异常/挂起收尾捆成不可漏的 RAII 协议。调用方只声明一个守卫对象，真正的线程状态机三拍和收尾逻辑都在构造/析构里强制发生。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：这些守卫只是样板代码封装

如果它们只是为了少写几行 `trans_from_native(_thread_in_vm)` 之类的样板代码，那确实可以用普通 helper 函数替代。

问题在于，状态转换在 JVM 里不是一个“单次函数调用”，而是一整个协议：

- 先写 trans 状态;
- 再做状态序列化;
- 再检查 safepoint;
- 某些路径还要 `make_walkable`;
- 出 VM 时还要查特殊退出条件；
- 入口宏还要顺手处理 HandleMark / NoHandleMark。

这些动作不应该依赖调用者“记得写对顺序”。RAII 的价值就是：**只要作用域结束，不管是正常返回还是异常退栈，析构一定会跑。**

### 误解二：手动 `set_thread_state()` 就行

这比上一种更危险。单纯 `set_thread_state(_thread_in_vm)` 并没有：

- trans 状态的可见性;
- `block_if_requested()` 的 safepoint 检查;
- 栈锚点的 walkable 处理;
- Handle 区边界的清理;
- 异步异常 / 外部挂起的补发。

所以 interfaceSupport 不是“把状态写得更优雅”，而是把这些协议动作绑成**不可漏的边界行为**。

---

## 2. 守卫家族：四种方向，两种变体

先把宏与守卫的关系点透：`JNI_ENTRY` / `JVM_ENTRY` / `JRT_ENTRY` 这些入口宏，并不是“展开后自己手写状态切换”，而是直接在宏展开里把相应的守卫对象压到 C++ 栈上，让构造/析构自动执行状态协议。

### 进 VM 的两个入口

从 Java 代码进 VM 与从 native 代码回 VM，是两个不同的类(interfaceSupport.inline.hpp:224-274):

```cpp
// interfaceSupport.inline.hpp:224-274(截取核心,逐字)
class ThreadInVMfromJava : public ThreadStateTransition {
 public:
  ThreadInVMfromJava(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_from_java(_thread_in_vm);
  }
  ~ThreadInVMfromJava()  {
    if (_thread->stack_yellow_reserved_zone_disabled()) {
      _thread->enable_stack_yellow_reserved_zone();
    }
    trans(_thread_in_vm, _thread_in_Java);
    if (_thread->has_special_runtime_exit_condition()) _thread->handle_special_runtime_exit_condition();
  }
};

class ThreadInVMfromNative : public ThreadStateTransition {
 public:
  ThreadInVMfromNative(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_from_native(_thread_in_vm);
  }
  ~ThreadInVMfromNative() {
    trans_and_fence(_thread_in_vm, _thread_in_native);
  }
};
```

- **`ThreadInVMfromJava`**：构造时 `trans_from_java(_thread_in_vm)`，析构时恢复黄页栈保护区、`trans(_thread_in_vm, _thread_in_Java)`，再检查特殊退出条件；
- **`ThreadInVMfromNative`**：构造时 `trans_from_native(_thread_in_vm)`（带 safepoint 检查），析构时 `trans_and_fence(_thread_in_vm, _thread_in_native)`。

这里很重要的一点是：从 Java 回 Java 用的是 `trans`，从 VM 回 native 用的是 `trans_and_fence`，因为后者必须保证离开 VM 时状态对外可见且经过带 handler 的序列化路径。

### 出 VM 的两个出口

VM → native 的守卫是 **`ThreadToNativeFromVM`**，不是流传说法里的 “ThreadInNativeFromVM”：

```cpp
// interfaceSupport.inline.hpp:277-294(截取核心,逐字)
class ThreadToNativeFromVM : public ThreadStateTransition {
 public:
  ThreadToNativeFromVM(JavaThread *thread) : ThreadStateTransition(thread) {
    assert(!thread->owns_locks(), "must release all locks when leaving VM");
    thread->frame_anchor()->make_walkable(thread);
    trans_and_fence(_thread_in_vm, _thread_in_native);
    if (_thread->has_special_runtime_exit_condition()) _thread->handle_special_runtime_exit_condition(false);
  }

  ~ThreadToNativeFromVM() {
    trans_from_native(_thread_in_vm);
    assert(!_thread->is_pending_jni_exception_check(), "Pending JNI Exception Check");
  }
};
```

- 离开 VM 前必须 `make_walkable`，让 GC/stack walker 能走这条栈；
- 然后 `trans_and_fence(_thread_in_vm, _thread_in_native)`；
- 还要处理特殊退出条件；
- 回来时用 `trans_from_native(_thread_in_vm)`。

**`ThreadBlockInVM`** 是阻塞专用版：进入阻塞前同样 `make_walkable`，然后 `trans_and_fence(_thread_in_vm, _thread_blocked)`；醒来后再从 `_thread_blocked` 回 `_thread_in_vm`。这就是 monitor wait、sleep、park 等路径里的状态护栏。

### 两个变体

另外源码里还有 `ThreadInVMfromUnknown` 这种兜底适配器：它用于少数“当前线程若恰好是 `_thread_in_native` 就临时转进 VM、否则什么也不做”的场景，不属于常规 Java↔VM↔native 四向转换主线，所以正文只把它当边界说明，不当主角展开。

- **`ThreadInVMForHandshake`**：给 Handshake 用，构造时直接进 `_thread_in_vm`，析构时 `transition_back()` 恢复**原状态**；
- **`ThreadInVMfromJavaNoAsyncException`**：和 `ThreadInVMfromJava` 类似，但析构不处理异步异常，只处理 suspend。它用在某些不能容忍 deopt/async exception 的路径上。

所以守卫家族真正覆盖的是四种方向（进 VM / 出 VM / 阻塞 / 握手借道）加两个特殊边界（恢复原状态 / 不处理异步异常）。

---

## 3. 出 VM / 进阻塞：为什么必须先 `make_walkable`

很多人会以为状态切换的重点只是 `_thread_state`。其实 `ThreadToNativeFromVM` 和 `ThreadBlockInVM` 里最容易被忽视的一步是:

```cpp
thread->frame_anchor()->make_walkable(thread);
```

这一步的意义是：**一旦线程不再继续以“正常 Java 执行流”往前跑，GC 和 stack walker 仍然必须能从锚点把这条栈走下来。**

- 出 VM 去 native 时，线程虽然还活着，但已经不再持续执行 Java 字节码；
- 进 blocked 时，线程会睡在 monitor / park / sleep 上；
- 如果这时世界停下来，VM 仍然可能需要遍历它的 Java 栈。

所以 `make_walkable` 不是附属动作，而是“我接下来不继续跑 Java 了，但我的栈仍要能被别人走”的边界声明。

---

## 4. HandleMark / NoHandleMark：入口宏还在替你守另一条边界

状态切换只是 interfaceSupport 的一半。另一半是 **Handle 区边界**。

`VM_ENTRY_BASE` / `VM_ENTRY_BASE_FROM_LEAF` 这些宏在 `interfaceSupport.inline.hpp` 里会自动安上：

- `HandleMarkCleaner`
- `NoHandleMark` / `ResetNoHandleMark`

这说明 interfaceSupport 不是只管 `_thread_state`。它还顺手保证：

- 进入 VM 代码后，局部 Handle 的分配/回收边界正确；
- 某些 leaf 场景不允许创建 Handle；
- 从 leaf 回普通 VM 入口时需要先重置 `NoHandleMark` 约束。

所以 interfaceSupport 真正包的是**一整套边界协议**：线程状态、栈可 walk、Handle 生命周期、以及退出时的补发动作。

---

## 5. 为什么“特殊退出条件”总放在析构里处理

几乎所有守卫类的析构里都会碰到一句：

```cpp
if (_thread->has_special_runtime_exit_condition())
  _thread->handle_special_runtime_exit_condition(...)
```

这不是偶然。

### `_suspend_flags` 里的东西为什么要等到边界处理

外部挂起请求、异步异常、critical native 解锁等条件，本质上都要求线程在**一个安全边界**上自愿处理，而不是在任意时刻被强塞进来。

比如：

- 如果线程正持有 VM 锁，不能立刻挂起；
- 如果线程正处在 native/VM 切换中，不能立刻抛 async exception；
- 如果线程刚从 blocked 醒来，要先恢复到稳定状态再决定后续。

把这些动作放在析构里，就是在利用 C++ 作用域边界：**这正是“我已经安全离开某个运行区间”的时刻。**

### 为什么 RAII 是唯一稳妥做法

如果把这些处理交给调用者自己记住“在 return 前补一刀”，一旦中途有异常、早返回、`CHECK` 宏跳转，最容易漏掉的就是这一步。RAII 的意义就在于：**只要作用域结束，析构必跑；只要析构必跑，补发动作就不可能漏。**

---

## 6. 误解澄清与收网

1. **interfaceSupport 只是把状态切换写得更优雅吗?** 不是。它把状态切换、栈 walkable、Handle 边界和特殊退出条件捆成一套不可漏的协议。
2. **`ThreadInVMfromJava` 和 `ThreadInVMfromNative` 只是 from-state 不同吗?** 不止。它们使用的底层 transition 形式不同，析构时的收尾也不同。
3. **`ThreadToNativeFromVM` 只是把状态改成 native 吗?** 不止。它还要求不持 VM 锁，并且先 `make_walkable`。
4. **`ThreadBlockInVM` 只是一个 blocked 标记吗?** 不是。它是“我要睡了，但我的栈仍要能被 safepoint/stack walker 正确遍历”的完整协议。
5. **特殊退出条件为什么不立刻处理?** 因为它们必须等线程走到安全边界再自愿处理，析构正是这个边界。

把这一篇压成三句话：

- **interfaceSupport 把线程状态协议绑成 RAII 守卫**，保证进/出 VM、阻塞、握手借道这些边界动作不会漏。
- **`make_walkable` 和 HandleMark 边界与 `_thread_state` 同等重要**，它们一起决定线程在 safepoint / GC / stack walk 眼里是不是安全。
- **析构里的 `handle_special_runtime_exit_condition` 不是收尾小事，而是外部挂起、异步异常和 critical native 解锁进入线程的唯一安全边界。**

17 域到这里闭合：线程层次、状态机、SMR/Handshake、interfaceSupport 四块都讲完了。下一站按全书主线进入域 18——Safepoint 本身：谁发起、怎么等、怎么判断所有线程都停稳。

> → 域 18 Safepoint