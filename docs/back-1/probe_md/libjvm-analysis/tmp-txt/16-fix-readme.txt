Fix 2 review gaps in 16-nio-network/README.md (68/70). Edit existing file only.

## Gap 1: Docs 04/05 — add version range + source files

### 04-Selector-Thread-Model: add JDK epoll bug version range
In §四 04 doc spec, after "JDK epoll bug 100% CPU spin", add:
"(影响范围: Linux kernel <2.6.27 的 event-poll.c 中 ep_remove 函数在删除最后一个就绪事件时未清除 event item→epoll_wait 返回0而非阻塞。JDK 6-8 RecycledSelector 模式(主 Selector 短暂取消注册又重新注册 Key)极易触发此 bug。JDK 9+ 已修复——EPollArrayWrapper 在 epollCtl DEL 前先清除 eventpoll 内事件。)"

### 05-Socket-Options: add inline source files
In §四 05 doc spec, add after existing description:
"源文件: Net.c (setsockopt wrapper), PlainSocketImpl.c (socket option defaults), SdpProvider.c (InfiniBand Sockets Direct Protocol)"

## Gap 2: §〇 — add C-language preamble for Java-only readers

After terminology table (before §一), insert "C 导航" mini-section:

"**C 导航——开始读源码前需要认识的 4 个模式:**

这 4 个 C 模式贯穿整个 16 阶段——认识它们，代码就透明了。

1. **jlong_to_ptr(addr)** — Java long → native pointer 转换。DirectBuffer.address() 返回 long → 在 C 层转为 void* → 传给 read(fd, ptr, len)。本质上是一个 cast: `(void*)(uintptr_t)jlong_val`。Java 无指针 → 用 long 表示内存地址。

2. **#if defined(__linux__)** — 平台条件编译。同一个 .c 文件可能包含 Linux/MacOS/Windows 三个版本的内核调用。`#if defined(__linux__)` 块中是 epoll/sendfile64 等 Linux 专属代码。

3. **errno + JNU_ThrowIOExceptionWithLastError** — OS 错误转 Java 异常。当 read() 返回 -1 → 检查 errno (全局错误码) → EAGAIN (11: try again, 非阻塞 socket 的正常状态) vs ECONNRESET (104: connection reset) → JNU_ThrowIOExceptionWithLastError 抛出对应 IOException。

4. **JNI_ENTRY static jint → JNI_END** — Java→native 入口宏。JNI_ENTRY 隐藏了 Parameter Marshalling (提取 jclass/jfield/jmethod), JNI_END 隐藏了 Return value wrapping。详细见 09-native-interface。"

---

## Verification: these additions are prose-only (no line numbers to break), confirm file length increases
