# 14 · JVMCI、Graal 与替代编译器路径：深度题目

> 本组题目属于设计对比题。当前 OpenJDK 11u 源码树未完整包含 `share/jvmci/` 和 `jdk.internal.vm.ci` 模块，因此不绑定本地 `file:line` 精确引用。题目中提到的类和入口路径以 HotSpot 源码与 JDK 公开接口为准。

## 1. JVMCI 为什么不是“把 Graal 编译结果塞进 nmethod”这么简单？

JVMCI 让 Graal 作为替代编译器接入 HotSpot。为什么 HotSpot 不能只给 Graal 一个“方法字节码，给我编译结果”，而是需要 JVMCI runtime、`JVMCICompiler`、`HotSpotCompiledCode`、`InstalledCode` 和 `CodeInstaller` 一套完整协议？

回答必须覆盖：

- JVMCI 不是 Graal 对 HotSpot 的调用接口，而是 HotSpot 对 Graal 的编译请求与结果接入协议；
- `JVMCICompiler` 在 HotSpot 的 `CompileBroker` 编译链中作为 `AbstractCompiler` 子类存在；
- 编译结果需要经过 `CodeInstaller` 的重新布置才能进入 CodeCache；
- `InstalledCode` 对象作为 Java 侧的编译结果句柄，与 nmethod 之间通过 `_jvmci_installed_code` 弱全局引用相连；
- 反优化 / 卸载时 nmethod 通过 `maybe_invalidate_installed_code` 通知 Java 侧 `InstalledCode` 对象失效。

追问：如果把 Graal 的编译结果直接 mmap 进 CodeCache 而不经过 `CodeInstaller` 的 relocation 和 OopMap 整备，会在哪个运行时路径上最先出问题？

## 2. JVMCI 编译线程与 C1/C2 编译线程在 HotSpot 中是什么关系？

JVMCI 有自己的编译线程管理，但编译请求仍然通过 `CompileBroker` 提交。这条路径与 C1/C2 的编译链路有什么关键差异？

回答必须覆盖：

- `UseJVMCICompiler` 启用后，JVMCI 编译级别的 `CompLevel_full_optimization` 语义与 C2 的对应关系；
- `CompileBroker` 对 JVMCI 编译请求的分配与对 C1/C2 的不同；
- `JVMCICompiler::compile_method` 的入口语义；
- 编译结果如何通过 `install_code` / `CodeInstaller` 进入 HotSpot 的 CodeCache；
- 失败路径与回退协议：JVMCI 编译失败时 VM 如何回退到 C1/C2。

追问：如果 JVMCI 编译线程数远多于 C2 编译线程数，最容易出现的是 CodeCache 挤占还是编译质量下降？如果 JVMCI 编译请求失败率异常高，HotSpot 如何避免无限重试？

## 3. `HotSpotCompiledCode` 与 `HotSpotResolvedJavaMethod` 为什么是 JVMCI 的核心桥接对象？

JVMCI 的 Java 侧（Graal）和 HotSpot 侧之间为什么不直接传递 `Method*` 或 `nmethod*`，而是通过 `HotSpotResolvedJavaMethod` 和 `HotSpotCompiledCode` 这类封装对象？

回答必须覆盖：

- `HotSpotResolvedJavaMethod` 封装了 HotSpot 的 `Method*`，但对外暴露的是 Java 安全的方法元数据视图；
- `HotSpotCompiledCode` 封装了编译结果，经过 `CodeInstaller` 翻译成 nmethod 可接受的布局；
- 为什么 Graal 不能直接访问 HotSpot 的 C++ 对象；
- 这些封装对象如何通过 JNI/JVMCI 通道实现跨语言生命周期管理；
- 从 Graal 编译结果到 nmethod 落地的完整组装链。

追问：如果 Graal 直接操作 `Method*` 指针，会在 GC 或 safepoint 期间遇到什么风险？`HotSpotResolvedJavaMethod` 的生命周期是否与 `Method*` 的 GC 可达性绑定？

## 4. `InstalledCode` 对象为什么是 Java 侧的 nmethod 句柄，而不是直接返回 `nmethod*`？

Graal 编译完成后得到的是一个 `HotSpotCompiledCode` 对象（包含编译后的机器码和元数据），HotSpot 侧通过 `CodeInstaller` 安装后得到一个 `nmethod*`。但 JVMCI 层选择用 Java 侧的 `InstalledCode` 对象作为编译结果的使用者句柄。为什么多这一层？

回答必须覆盖：

- `InstalledCode` 是 Java 对象，持有 `InstalledCode.address`（指向 nmethod 的起始地址）和 `entryPoint`；
- 当 nmethod 被 anti-compile 或卸载时，`maybe_invalidate_installed_code` 把 `address` 和 `entryPoint` 清 0；
- 为什么 Java 侧通过 `InstalledCode` 调用比通过 `nmethod*` 更安全（对 GC、卸载、反优化更友好）；
- 弱全局引用 `_jvmci_installed_code` 与 nmethod 生命周期如何绑定；
- 如果 `InstalledCode` 的 `address` 已被清 0，Java 侧调用时会发生什么。

追问：如果 `InstalledCode` 对象被 GC 回收了但 nmethod 还在 CodeCache 里，会有什么后果？如果 nmethod 被卸载了但 `InstalledCode` 还活着，Java 侧如何感知这个变化？

## 5. Graal 与 C2 在编译同一段 Java 方法时，谁更可能生成更短的代码或更快的执行路径？

这不是一个“谁更好”的面试题，而是追问“两种编译器各自的核心差异是什么、为什么这些差异会导向不同的编译结果”。

回答必须覆盖：

- C2 基于 Ideal Graph，以 `Node + Type + IGVN` 驱动全局图优化，侧重确定性收敛；
- Graal 基于结构化图（Sea-of-Nodes 变体），以可插拔的 Phase 链驱动，侧重可组合性；
- 为什么 C2 在某些场景下更擅长消除循环和分配，而 Graal 在其他场景下更能利用编译期常量；
- 为什么 Graal 的 Phase 架构更容易对接新的分析/优化，也更容易被不同的编译器前端复用；
- 为什么“哪个更快”往往取决于具体方法形态、HotSpot 版本和 workload。

追问：如果 Graal 的 phase 链与 C2 的 phase 链在同一个 workload 上得到不同强度的优化，可能性最大的差异来源是什么？是 IR 表达力、后端降级策略还是编译预算分配？

## 6. JVMCI 的“替代编译器”路径对 HotSpot 的维护意味着什么，而不是“多了一个编译器”？

JVMCI 不是简单地给 HotSpot 加一个编译器选项，而是引入了一条新的编译器接入协议。它对 HotSpot 的维护、版本演进和测试策略意味着什么？

回答必须覆盖：

- JVMCI 让 HotSpot 的编译链（CompileBroker → AbstractCompiler → CodeCache）变成可插拔的；
- 为什么 JVMCI 的接口定义比 C1/C2 的内部接口更稳定、更窄；
- 当 Graal 中存在 bug 时，HotSpot 的错误归于边界（JVMCI 层 vs Graal 层）；
- 为什么 JVMCI 的维护成本不来自“多一种编译器”，而来自“多一条外部编译器接入协议”；
- 为什么 JVMCI / Graal 在某些 JDK 版本中不再是默认或替代编译器（如 JDK 16+ 的 Graal 被移出发行版）。

追问：如果将 C2 也通过 JVMCI 暴露，会失去哪些 HotSpot 已有的优化机会？如果替代编译器不止 Graal 一个，JVMCI 的接口设计还能支持几种不同的编译器后端？