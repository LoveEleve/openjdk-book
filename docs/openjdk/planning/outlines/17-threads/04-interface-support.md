# 04. 线程从 Java 进入 VM——这一瞬间怎么保证安全？— interfaceSupport

> 🔴 Deep | 4 KP 中的状态守卫
> 读者处境: 线程执行 Java→VM 转换——这一瞬间发生了线程状态变更、内存屏障、safepoint 检查。如果状态写错了→GC 在错误的状态扫描栈→VM crash。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/17-threads/04 已按真实源码成文~190 行,本大纲为规划期产物,机制描述以文章为准):
> - **"ThreadInVMfromJava(interfaceSupport.inline.hpp:68-78) 用 trans_and_fence" 错**: 真实 :224-237——构造 `trans_from_java(_thread_in_vm)`(:227,Java→VM 不阻塞);析构=enable_stack_yellow_reserved_zone 恢复(:230-232)+**trans** 回(:233)+handle_special_runtime_exit_condition(:235)
> - **"ThreadInNativeFromVM 类名" 不存在(编造)**: VM→native 的守卫是 **ThreadToNativeFromVM**(:277-294)——make_walkable(:283)+trans_and_fence 出(:284)+special condition(:286),析构 trans_from_native 回(:290);大纲把方向写反了
> - **"ThreadBlockInVM 析构调 cross_modify_fence" 编造**: :297-309 无任何 fence;真实特点=**make_walkable(:302,注释 'Once we are blocked vm expects stack to be walkable')**+trans_and_fence(:303/:306);jdk11u 无 cross_modify_fence 于此处
> - **变体(大纲未提)**: ThreadInVMForHandshake(:185-222,03 篇 Handshake 上下文: 构造 make_walkable+set _thread_in_vm :215,析构 transition_back 恢复原状态 :188-204);ThreadInVMfromJavaNoAsyncException(:315-337,不处理异步异常——处理就得 deopt,注释 :325-330,只处理挂起 :334-335)
> - **"_suspend_flags 位值" 对**(thread.hpp:259-271): external_suspend=0x20000000/ext_suspended=0x40000000/deopt_suspend=0x10000000/has_async_exception=0x1/critical_native_unlock=0x2/trace_flag=0x4;注释避开符号位(:260-261,CR 6398077);**java_suspend_self 在 thread.cpp:2415-2461**(大纲 "thread.cpp:1507-1536" 错): walkable 断言(:2424-2426)/SR_lock(:2428)/**双层 wait**(外层 while is_external_suspend 等请求清空 :2451,内层 while is_ext_suspended 等 resume :2456-2457,注释 'change the stack out from under it' :2442-2450)
> - **宏落点(大纲"转换点"示例多为编造)**: 真实=JNI_ENTRY 宏套 ThreadInVMfromNative(interfaceSupport.inline.hpp:515-522)/JRT_ENTRY 套 ThreadInVMfromJava(:468-474)/IRT_ENTRY 套 ThreadInVMfromJavaNoAsyncException(:460-466);JRT_ENTRY 用于 InterpreterRuntime::monitorenter 等运行时服务
> - 悬念指向域 18 Safepoint(safepoint 怎么叫所有线程停住)✓

### 1. "RAII 是我最好的朋友" — 四种守卫类

场景: 线程从 Java 进 VM（如分配对象、加锁）——必须把 `_thread_state` 从 `_thread_in_Java` 改成 `_thread_in_vm`。但离开 VM 时必须改回来。忘记改回来→线程永久在 VM 状态→safepoint 永远认为它 blocked→ 无法完成 GC。

**四种 RAII 守卫** (`interfaceSupport.inline.hpp:60-150`):
```
ThreadInVMfromJava    → Java→VM 专用
ThreadInVMfromNative  → 从 native 回 VM 专用
ThreadBlockInVM       → VM 中阻塞(等待锁/IO)专用
ThreadInNativeFromVM  → VM→native(JNI) 专用
```
- [C++: RAII = Resource Acquisition Is Initialization——构造函数获取/转变资源，析构函数释放/转变回。C++ 没有 finally 块，RAII 是安全释放的唯一保证。如果抛异常→栈展开→析构函数仍调用]
- 源码: `interfaceSupport.inline.hpp:60-150` 四种类的完整定义——都继承 `ThreadStateTransition` 基类，复用的构造/析构模式

**ThreadInVMfromJava 实现** (`interfaceSupport.inline.hpp:68-78`):
```cpp
class ThreadInVMfromJava : public ThreadStateTransition {
 public:
  ThreadInVMfromJava(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_and_fence(_thread_in_Java, _thread_in_vm);
  }
  ~ThreadInVMfromJava() {
    trans_and_fence(_thread_in_vm, _thread_in_Java);
    if (_thread->has_special_runtime_exit_condition()) {
      _thread->handle_special_runtime_exit_condition();
    }
  }
};
```
- 关键设计: 析构时检查 `has_special_runtime_exit_condition()` —— async exception、deopt suspend、external suspend。这些"特殊条件"需要线程在 `_thread_in_Java` 状态下处理——不能延迟到 next transition
- [C++: 析构的顺序: (1) trans_and_fence 回 Java→线程可见→safepoint 可以停了。(2) 检查特殊条件——如果在 destructor 中抛异常→下一个 transition 被跳过→safepoint 间隙过长]

**ThreadBlockInVM 实现** (`interfaceSupport.inline.hpp:109-119`):
```cpp
class ThreadBlockInVM : public ThreadStateTransition {
 public:
  ThreadBlockInVM(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_and_fence(_thread_in_vm, _thread_blocked);
  }
  ~ThreadBlockInVM() {
    trans_and_fence(_thread_blocked, _thread_in_vm);
    OrderAccess::cross_modify_fence();
  }
};
```
- 关键设计: `cross_modify_fence()` 是不同的 fence——在 blocked→VM 转换后刷新 CPU 流水线=在 safepoint 中其他线程改了代码(nmethod flushes/patch IC)。非必须但防止过时的 speculatively executed instructions
- [x86: `cross_modify_fence()` = `cpuid` 或 `serializing instruction`——serialize 是比 mfence 更强的 barrier——刷新整个指令流水线]

**ThreadInNativeFromVM** (`interfaceSupport.inline.hpp:139-147`):
```cpp
class ThreadInNativeFromVM : public ThreadStateTransition {
 public:
  ThreadInNativeFromVM(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_and_fence(_thread_in_vm, _thread_in_native);
  }
  ~ThreadInNativeFromVM() {
    trans_and_fence(_thread_in_native, _thread_in_vm);
  }
};
```
- 关键设计: native→VM 入口不需要 safepoint check——线程在 native 状态→safepoint 不需要等它。但回 VM 时可能遇到 pending safepoint→线程阻塞在 entry 处

### 2. "别让它挂起来" — Suspend/Resume 自挂机制

场景: JVMTI 需要挂起一个线程（StopThread 前先 suspend）——但 JVM 不能强制挂起（可能在持有锁），只能让线程自愿停。

**自挂起模式** (`thread.hpp:255-275`):
```
_suspend_flags:
  _external_suspend = 0x20000000  // 别的线程叫我挂起
  _ext_suspended    = 0x40000000  // 我已挂起
  _deopt_suspend    = 0x10000000  // 为了 deopt 挂起我
```
- 流程: 线程在 Transition 的析构中检查 `is_external_suspend()`→true→self suspend(获取 SR_lock→wait)
- [C++: 自挂起避免了"异步挂起"的危险——线程可能在 IRQ handler 中、持有 spinlock、或在 non-preemptible kernel context。Java→VM transition 后线程自愿检查 flag——总是在安全点挂起]
- 源码: `thread.cpp:1507-1536` `java_suspend_self()` — 检查 _suspend_flags → SR_lock->wait() → 自挂起

**SR_lock** (`thread.hpp:256`):
```
Monitor* _SR_lock;  // Suspend/Resume lock
```
- 用于自挂起线程 wait 和被挂起线程 notify 的同步
- 外部线程调 `java_suspend(thread)`→设置 `_external_suspend`→不阻塞立即返回
- Target 线程在下次 Transition 析构中检查→`SR_lock->wait()` 自我挂起

### 3. "25 个转换点——都在哪？"

场景: JVM 代码中每次进入 VM 都要套 ThreadInVMfromJava——漏了一个就可能导致状态泄露。

**典型转换点**:
```
解释器: TemplateTable::invokevirtual → ThreadInVMfromJava
JIT stubs: c2i adapter → ThreadInVMfromJava at entry
JNI: jni_CallStaticVoidMethod → ThreadInVMfromNative
Runtime: InterpreterRuntime::monitorenter → ThreadInVMfromJava
GC alloc: CollectedHeap::obj_allocate → ThreadInVMfromJava
Locking: ObjectSynchronizer::fast_enter → ThreadInVMfromJava
JVMTI: JvmtiEnv::GetThreadState → ThreadInVMfromNative
```
- 关键设计: 每个 VM entry 点都必须配对——进入 VM 的代码和离开 VM 的代码配对。但有些 VM 操作嵌套（如 VM 中分配再进 JNI）→需要 `ThreadInNativeFromVM` 转换——同一个线程可以在多个状态间切换

---

### 核心悬念

**"interfaceSupport 的 RAII 守卫——ThreadInVMfromJava/ThreadInVMfromNative/ThreadBlockInVM/ThreadInNativeFromVM——保证线程状态永远不会泄露。析构时的自挂检查让别的线程可以安全地要求它 '停一下'。"** — 下一篇: 域18 Safepoint——safepoint 怎么叫所有线程停住。

> → 域18 Safepoint
