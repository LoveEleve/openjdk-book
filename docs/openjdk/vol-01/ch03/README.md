# ch03 进度与下一步计划

> 更新日期：2026-06-30

## 已完成

| 文件 | 内容 | 状态 |
|------|------|------|
| 01-overview.md | 进程/线程模型、JNI_CreateJavaVM 入口 | ✅ |
| 02-threads-create-vm.md | create_vm 9 阶段骨架 | ✅ |
| 03-preamble-init.md | Stage 1 前置初始化 | ✅ |
| 04-args-parse.md | Stage 2 参数解析 | ✅ |
| 05-os-init2.md | Stage 3 OS 后初始化 + HotSpot 锁机制 | ✅ |

## 下一步：06-main-thread-create.md

**边界**：从 `_thread_list = NULL` 到 `ObjectMonitor::Initialize()` 结束（不含 `init_globals()`）。

**源码位置**：`thread.cpp` 中 `Threads::create_vm` 的这一段：

```c
// Initialize Threads state
_thread_list = NULL;
_number_of_threads = 0;
_number_of_non_daemon_threads = 0;

// Initialize global data structures and create system classes in heap
vm_init_globals();

#if INCLUDE_JVMCI
// ... (编译期跳过)
#endif

// Attach the main thread to this os thread
JavaThread* main_thread = new JavaThread();
main_thread->set_thread_state(_thread_in_vm);
main_thread->initialize_thread_current();
main_thread->record_stack_base_and_size();
main_thread->register_thread_stack_with_NMT();
main_thread->set_active_handles(JNIHandleBlock::allocate_block());

if (!main_thread->set_as_starting_thread()) { ... return JNI_ENOMEM; }

main_thread->create_stack_guard_pages();

// Initialize Java-Level synchronization subsystem
ObjectMonitor::Initialize();

// → 下一章: jint status = init_globals();
```

**重要性分层**：

| 步骤 | 重要度 | 说明 |
|------|--------|------|
| Threads 状态初始化 | ★ | 3 个静态成员赋值，一行带过 |
| `vm_init_globals()` | ★★ | 若干小函数初始化，需 MCP 探索后决定是树形图还是逐个展开 |
| JVMCI | 跳过 | `ifdef INCLUDE_JVMCI`，标准构建不编译 |
| `new JavaThread()` | ★★★ | 构造函数：Thread 初始化 + JavaThread 专有字段 |
| `initialize_thread_current()` | ★★ | TLS 绑定，衔接 Stage 1 的 `pthread_key_create` |
| `record_stack_base_and_size()` | ★★ | 读 `%rsp` 获取主线程栈边界 |
| `set_active_handles()` | ★ | JNI 局部引用块 |
| `set_as_starting_thread()` | ★ | 标记为主线程 |
| `create_stack_guard_pages()` | ★★★ | **核心**：`mprotect(PROT_NONE)` 画守卫页，衔接 Stage 2 的守卫区计算 |
| `ObjectMonitor::Initialize()` | ★★ | Java synchronized 的 PerfData 计数器注册 |

**写作要点**：

- `create_stack_guard_pages()` 是承接 Stage 2 的关键——Stage 2 算好了 `_stack_red_zone_size` 等四个值，这里真正调 `os::guard_memory()` → `mprotect(PROT_NONE)` 把保护页画到主线程栈上
- `initialize_thread_current()` 衔接 Stage 1 的 `ThreadLocalStorage::init()`（`pthread_key_create`）
- `ObjectMonitor::Initialize()` 只是 PerfData 计数器注册，不涉及 synchronized 的锁膨胀机制
- 行文风格延续 05-os-init2.md：骨架先行 → 重要度标注 → 小块代码 + 穿插解释 → 变量赋值表 → 跨章节衔接

## 后续章节规划

| 章节 | 文件 | 内容 |
|------|------|------|
| ch03/06 | main-thread-create.md | 主线程创建（本计划） |
| ch04/01 | init-globals.md | `init_globals()` —— Universe/Heap/SystemDictionary 初始化 |
