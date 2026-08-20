# 13-jit-framework/01-compile-broker-queue 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释“解释器/策略层决定值得编译”之后，为什么还需要一整套 CompileBroker + CompileQueue + CompileTask + CompilerThread 体系，才能把“编译意愿”稳定地变成真正的异步编译执行

## 1. 选题判断

现稿已经覆盖了很多关键事实：
- `CompileTask` 字段与 compile reason
- `CompileQueue` 双队列
- `compiler_thread_loop`
- `invoke_compiler_on_method`
- stale task / dynamic compiler threads / code cache backpressure

但当前结构仍偏“部件说明书”：先讲 CompileTask，再讲队列，再讲执行段。读者未必真正抓住最核心的问题：

**解释器计数溢出、策略层说“该编了”之后，为什么不能直接在原线程里调 C1/C2 编译？为什么还要引入会排队、会过期、会被代码缓存反向制约、还可能动态增减线程的一整套 CompileBroker 流水线？**

这才是本篇最该打穿的困惑。

## 2. 一句话顿悟

**“该不该编”只是一个意愿，不是一个可立即执行的动作。JIT 编译本身很重、很慢、会占 code cache、会和类卸载/重定义并发，还要让应用线程继续跑解释器。因此 HotSpot 把编译做成一条异步流水线：解释器和策略层只生产请求，CompileBroker 把请求包装成可过期的任务，按编译器层级分流进队列，由专用编译线程在资源允许时消费，最后再把结果回装进 CodeCache。**

## 3. 总图

```text
解释器 / policy 层
  └─ 产出：这个方法“值得编译”

CompileBroker
  ├─ 包装成 CompileTask
  ├─ 分流到 C1 / C2 队列
  ├─ 允许任务在排队时变旧/过期
  ├─ 由 CompilerThread 异步消费
  └─ 受 CodeCache 容量反向制约

执行段
  ├─ push_jni_handle_block
  ├─ 创建 ciEnv
  ├─ 调 C1/C2 compile_method
  └─ post_compile / wrapper 收尾
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——策略都说“该编了”，为什么不立刻编

目标约 1300 字。

- 从解释器计数溢出与 `CompilationPolicy::event()` 开场
- 点出“编译意愿”与“真正编译动作”不是一回事
- 引出三个现实约束：慢、会过期、受资源制约

### 第二节：三个朴素办法为什么不行

目标约 2000 字。

必须推演：
1. 让触发线程同步编译
2. 所有编译请求进一个简单 FIFO 队列
3. 任务一旦入队就必须编到底

结论：
- 同步编译会把应用线程卡死在重活上
- 简单 FIFO 不适应 tiered / 热点变化
- 排队期间世界会变，旧任务必须允许作废

### 第三节：`CompileTask`——为什么“编译请求”必须被包装成任务对象

目标约 1900 字。

- `CompileTask` 字段
- `CompileReason`
- `can_become_stale`
- `compile_id`
- 任务不是“方法名 + 级别”这么简单，而是一次编译尝试的完整档案

### 第四节：为什么任务允许过期——“值得编译”不是不可撤销的命令

目标约 1700 字。

- `select_for_compilation`
- `is_unloaded`
- stale task / `remove_and_mark_stale` / `purge_stale_tasks`
- 强调请求生成后到真正执行前，方法、热度、类加载世界都可能改变

### 第五节：队列——为什么是双队列 + policy 选任务，而不是简单 FIFO

目标约 2000 字。

- `CompileQueue` 结构
- `_c1_compile_queue` / `_c2_compile_queue`
- `queue->get()` 里调 policy `select_task`
- `purge_stale_tasks`
- 讲清“入队是 FIFO，出队不一定按入队顺序”

### 第六节：编译线程——为什么需要专用 JavaThread 来消费任务

目标约 1900 字。

- `compiler_thread_loop`
- 第一个线程初始化 `ciObjectFactory`
- 动态增减编译线程
- 编译线程作为 JavaThread，可以 safepoint / 被 GC 阻塞
- 讲清“异步编译”的真实含义

### 第七节：执行段——一条任务如何真正变成一次编译

目标约 2200 字。

- `invoke_compiler_on_method`
- `push_jni_handle_block`
- `ciEnv ci_env(task)`
- `comp->compile_method`
- `post_compile`
- `CompileTaskWrapper` 析构收尾
- 把 12-ci 域和 broker 串起来

### 第八节：CodeCache 反压——为什么编译流水线会被产物空间反向卡住

目标约 1500 字。

- `queue->get()` 等待与 stop condition
- `should_compile_new_jobs`
- 代码缓存满时暂停/关闭编译
- 说明编译不是无限制生产线

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. `CompilationPolicy` 是否直接执行编译
2. 队列是否只是简单 FIFO
3. 任务入队后是否一定会被编
4. 编译线程是不是普通 native worker
5. `ciEnv` 是在哪里真正创建的

## 5. 失败方案必须写进正文

1. 触发线程自己同步编译
2. 所有任务进一个普通 FIFO 队列
3. 任务一旦入队就不能取消/过期

## 6. 证据清单

- `share/compiler/compileTask.hpp:36-59`：CompileTask 与 compile reasons
- `share/compiler/compileTask.hpp:79-103`：关键字段
- `share/compiler/compileTask.hpp:124-133`：`can_become_stale`
- `share/compiler/compileTask.cpp:40-55` / `:61-78`：allocate/free
- `share/compiler/compileTask.cpp:81-127`：initialize
- `share/compiler/compileTask.cpp:137-151`：`select_for_compilation`
- `share/compiler/compileBroker.hpp:76-123`：CompileQueue
- `share/compiler/compileBroker.hpp:125-132`：CompileTaskWrapper
- `share/compiler/compileBroker.hpp:179-180` / `:238-269` / `:252-257`：broker 关键接口
- `share/compiler/compileBroker.cpp:430-479`：`CompileQueue::get`
- `share/compiler/compileBroker.cpp:482-503`：`purge_stale_tasks`
- `share/compiler/compileBroker.cpp:525-533`：`remove_and_mark_stale`
- `share/compiler/compileBroker.cpp:546-549`：按级别选队列
- `share/compiler/compileBroker.cpp:1790-1889`：`compiler_thread_loop`
- `share/compiler/compileBroker.cpp:2062-2231`：`invoke_compiler_on_method`

## 7. 必须明确的边界

- 基于 JDK 11u 的 tiered compilation 框架
- 本篇聚焦 broker/queue/runtime，不深入阈值算法本身（放到下一篇 `TieredThresholdPolicy`）
- 不展开 JVMCI 特殊等待路径，只作为 blocking 编译的一个边角说明
- 不展开 `nmethod` 安装细节，本篇停在“任务消费”这一层

## 8. 完成后 review

- 删除代码后，能否复述“CompileBroker 解决的是把编译意愿变成可调度、可过期、受资源约束的异步执行”
- 是否把任务、队列、线程、执行段都收回到同一个动机上
- 是否清楚讲明：谁生产请求、谁包装、谁排队、谁消费、谁可能取消
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
