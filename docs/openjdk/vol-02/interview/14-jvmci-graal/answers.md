# 14 · JVMCI、Graal 与替代编译器路径：专家答案锚点

## 1. JVMCI 是一套完整的编译请求与结果接入协议，不只是“编译结果交换”

JVMCI 包含多个层次：`JVMCICompiler` 作为 `AbstractCompiler` 子类接入 `CompileBroker` 编译链；`HotSpotCompiledCode` 承载编译结果但必须经过 `CodeInstaller` 的 relocation 和 OopMap 整理才能进入 CodeCache；`InstalledCode` 在 Java 侧作为 nmethod 的句柄，通过 `_jvmci_installed_code` 弱全局引用与 nmethod 绑定。

如果 Graal 的编译结果不经过 `CodeInstaller` 而直接进入 CodeCache，会缺少 OopMap、relocation 和异常表等 nmethod 必须携带的元数据，导致 GC 扫栈、反优化和异常处理无法正常工作。

## 2. JVMCI 编译线程复用 CompileBroker 框架，但出口不同

`CompileBroker` 在分派编译请求时，对于 `UseJVMCICompiler` 启用的环境，对 `CompLevel_full_optimization` 级别的请求交给 `JVMCICompiler::compile_method`。JVMCI 侧有自己的线程池管理，但请求队列和回退协议仍由 `CompileBroker` 控制。

编译结果返回后，`install_code` 通过 `CodeInstaller` 把 Graal 的输出翻译成 nmethod 的布局、OopMap 和 relocation，再进入 CodeCache。如果 JVMCI 编译失败，HotSpot 可以回退到 C1 或不再请求更高编译级别。

## 3. `HotSpotResolvedJavaMethod` 和 `HotSpotCompiledCode` 是跨语言边界的安全封装

Graal 运行在 Java 侧，不能直接操作 HotSpot 的 C++ `Method*` 或 `nmethod*`。`HotSpotResolvedJavaMethod` 封装了 `Method*`，但对外暴露的是类型安全的 Java 方法元数据视图（如字节码、常量池、异常表），而不会暴露 C++ 指针。

`HotSpotCompiledCode` 则是 Graal 编译结果的封装，经过 `CodeInstaller` 层翻译成 nmethod 可接受的格式。如果 Graal 直接持有一个裸 `Method*`，在 GC 搬移元数据或 safepoint 期间，这个指针可能变成悬垂指针。

## 4. `InstalledCode` 为 Java 侧提供了编译结果的安全句柄

`InstalledCode` 是 Java 对象，持有 `address`（指向 nmethod 起始地址）和 `entryPoint`。当 nmethod 被反优化或卸载时，`nmethod::maybe_invalidate_installed_code` 会清除这两个字段，让 Java 侧后续调用时能感知 nmethod 已经失效。

这样就避免了 Java 侧持有一个已经失效的 `nmethod*` 并继续跳入的后果。如果 `InstalledCode` 被 GC 回收了而 nmethod 还在，不会造成直接问题，但 Java 侧失去了通过 `InstalledCode` 调用该编译版本的能力；如果 nmethod 被卸载了而 `InstalledCode` 还活着，`address` 和 `entryPoint` 已经被清 0，Java 侧调用时通过 `isValid()` 检查即可发现。

## 5. Graal 与 C2 的差异来自 IR 结构和 Phase 组织方式，不是“谁更好”

C2 基于 Ideal Graph 的确定性优化（`Node + Type + IGVN`），偏向于在有限次迭代中收敛到全局最优形状。Graal 基于结构化 Sea-of-Nodes 变体，Phase 链可插拔，在编译实验性优化和快速原型方面更灵活。

具体性能差异往往取决于 workload：C2 在某些循环展开、分配消除和路径敏感优化上有长期积累的经验；Graal 在某些场景下能利用更灵活的 Phase 组织和编译期常量推导。但这不是“C2 永远不好”或“Graal 永远更快”的结论，而是编译器设计哲学与工程投入在不同场景下的不同表现。

## 6. JVMCI 把 HotSpot 的编译链变成可插拔接口，维护成本来自协议边界

JVMCI 引入的不是“多一个编译器”，而是“多一条外部编译器接入协议”。这使 `CompileBroker` 的编译链变成可插拔的，但同时也要求 HotSpot 维护一个稳定的、比 C1/C2 内部接口更窄的接入边界。

当 Graal 中存在 bug 时，错误归属在 JVMCI 层与 Graal 层之间比 C1/C2 内部更清晰，因为 JVMCI 的接口边界是定义好的。但 Java 侧与 C++ 侧之间的 JVMCI 通道本身也需要维护，包括 `HotSpotResolvedJavaMethod` 的封装、`CodeInstaller` 的 relocation 和 OopMap 翻译，以及 `InstalledCode` 与 nmethod 的生命周期联动。这就是 JVMCI 的主要维护成本来源。JDK 16+ 将 Graal 移出默认发行版，不是因为 JVMCI 协议有问题，而是因为 Graal 的独立发布和更新节奏更适合作为外部插件。

## 评分锚点

- **合格**：能说出 JVMCI 是 HotSpot 与 Graal 之间的桥，Graal 是替代 C2 的编译器。
- **良好**：能解释 `JVMCICompiler`、`CodeInstaller`、`InstalledCode` 在编译链中的角色，以及为什么不能直接传递 `nmethod*`。
- **专家级**：能用“编译链可插拔化、跨语言边界安全封装、nmethod 生命周期同步”这条主线，把 JVMCI 的协议层次、Graal 与 C2 的差异、以及 JVMCI 的维护代价说清楚。