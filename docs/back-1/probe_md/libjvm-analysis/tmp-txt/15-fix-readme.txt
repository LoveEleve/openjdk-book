Fix 3 review gaps in 15-core-native/README.md (65/70 → target 68+). Edit existing file only.

## Gap 1: Add memmove vs memcpy design decision (二.1)
After the "100x faster" quantified counterfactual for arraycopy native, add a new decision:

"Why memmove not memcpy? Java spec says arraycopy 'copies as though to a temporary array first' — meaning overlapping source and destination must work correctly. memcpy is undefined behavior on overlap (C standard: 'memory areas must not overlap'). memmove handles overlap by checking direction (src < dst → copy backwards) before the same vectorized copy loop. Overhead: ~1% for non-overlapping case — the direction check is 1 CPU branch — acceptable for the correctness guarantee."

## Gap 2: Rewrite doc core questions as problems (四 01+02)
In §四:
- 01 core question: change from expositional to problem-framed. New: "Class.forName('com.example.Foo') 在 OSGi/模块系统中抛出 CNFE 但 Foo.class 编译正常——caller-classloader 陷阱。Class.forName 用的是**调用者的** ClassLoader，不是当前线程的 context ClassLoader。这个微妙的差异是 OSGi ClassNotFoundException 的 #1 根源。"
- 02 core question: change similarly. New: "Docker 容器中 Runtime.availableProcessors() 返回 64 而不是 2——GC 线程数错误导致 STW 暂停 10 倍于预期。JDK 10+ 增加了 cgroup 感知——但在 JDK 8/9 中，JVM 错误地读取了宿主机的 CPU 数。"

## Gap 3: Add quantified counterfactuals to 二.4 and 二.6
- 二.4 (String.intern): After "StringTable 在 metaspace 中"，add: "如果将 StringTable 放在 Java 堆：每次 intern() 需要 3 次 JNI 穿越（lookup→insert→return），每次 oop↔jstring 包装 ~50ns → 3×50ns = ~150ns per intern。在 metaspace 中：CAS 原子操作 ~10ns → ~15x faster。这就是为什么 StringTable 不能放在 Java 堆——intern 的热路径需要 JVM 内部级别的延迟。"
- 二.6 (forName classloader): After "forName0 使用 CALLER 的 classloader"，add: "如果使用 context classloader：RPC 框架可以从调用者的 classloader 上下文中加载任意类 → Java sandbox 安全边界被打破。使用 caller 的 classloader：调用栈中最接近的代码决定了可用的类——符合 Java 的栈内省安全模型。"
