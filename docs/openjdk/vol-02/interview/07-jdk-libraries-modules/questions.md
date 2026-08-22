# 07 · JDK 类库、模块与运行时资源：深度题目

## 1. `System.getProperties()` 为什么要经过一层 libjava 的 native 骨架，而不是全交给 HotSpot 或散在每个 native 方法里？

Java 层看起来普通的系统属性、native 异常、路径转换，为什么集中落在 `libjava` 这层？

回答必须覆盖：

- libjava 与 HotSpot 的职责边界：libjava 是 JDK 原生库，不是 HotSpot；
- `JNU_ThrowXxx` 如何把 native 错误统一翻成 Java 异常；
- `JNU_NewStringPlatform` 如何按 `sun.jnu.encoding` 把平台字节串转成 Java String；
- `System.initProperties` 在启动早期如何一次性采集 OS/用户/locale/路径信息；
- 如果不收敛到 libjava，错误语义、编码策略、平台细节会怎样碎片化。

追问：为什么 libjava 的错误翻译和字符串转换必须统一，而不能让每个 native 方法自己 `ThrowNew`/`NewStringUTF`？`JNU_*` 与 `JVM_*` 的分工是什么？

源码入口：`java.base/share/native/libjava/jni_util.c:51`、`java.base/share/native/libjava/System.c:38`、`java.base/share/native/libjava/System.c:166`。

## 2. 为什么找类要先读 ZIP 尾巴而不是从头顺扫 JAR？

`ClassLoader.findClass("com/foo/Bar")` 走 native JAR 读取时，为什么先解析 END 定位 Central Directory，再建立哈希索引，而不是从头扫过去？

回答必须覆盖：

- ZIP 尾部的 END 记录定位 Central Directory；
- Central Directory 集中了文件名、方法、尺寸、LOCAL 偏移；
- 打开时建一次索引，后续 findClass 变成哈希命中；
- 为什么 LOCAL 头和数据偏移要拖到第一次真正读取时才计算；
- 顺扫方案的 O(n) 成本在类加载反复访问下如何放大。

追问：为什么“打开时把 LOCAL 头和数据偏移全部提前算完”这个更彻底的方案也不被采用？懒计算 LOCAL 头省下了什么、代价是什么？

源码入口：`java.base/share/native/libzip/zip_util.c:568`、`java.base/share/native/libzip/zip_util.c:966`、`java.base/share/native/libzip/zip_util.c:713`。

## 3. 传统 Socket 和 NIO SocketChannel 为什么会在 native 层走出两条相反的路线？

同样是一条 TCP，为什么 `new Socket()` 要用 `poll(2)` 自己在 native 层补超时，而 `SocketChannel + Selector` 把 `EINPROGRESS` 交给 epoll 等待就绪？

回答必须覆盖：

- 阻塞式 Socket 的“等到有结论再回来”语义需要 native 自己补超时；
- NIO SocketChannel 的“现在做不到就返回未完成”语义需要非阻塞 socket + Selector；
- `IOS_UNAVAILABLE/IOS_INTERRUPTED` 如何把内核未完成状态翻译给上层；
- epoll 如何统一等待就绪；
- 为什么两套语义不能互相替代，而是各选了一套 nat接口。

追问：为什么 NIO 不直接把 Socket 也做成阻塞 + 后台线程，而是始终用非阻塞 + Selector？`NET_Timeout`/`poll` 和 epoll 各在什么场景更合适？

源码入口：`java.base/unix/native/libnio/ch/Net.c:306`、`java.base/linux/native/libnio/ch/EPoll.c:59`、`java.base/linux/native/libnet/linux_close.c:394`。

## 4. `jimage` 为什么不用 ZIP，而用定制模块镜像？

JDK 的 `jimage` 模块文件为什么不是 ZIP 的一种变体？它的二进制布局和 ZIP 的 Central Directory 思路有什么本质不同？

回答必须覆盖：

- jimage 的头部与 item 表布局；
- 为什么模块化后 JDK 需要一个快速、可随机访问、按模块组织的资源索引；
- jimage 与 ZIP/JAR 的查找与解压成本差异；
- 为什么模块系统选择 jimage 而不是复用 libzip；
- JDK 11 中 `jrt:/` 文件系统如何由 jimage 支撑。

追问：如果把 JDK 的 `lib/modules` 换成 ZIP 结构，启动期 `jrt:/` 文件系统的查询会失去什么优势？

源码入口：`java.base/share/native/libjimage/jimage.cpp:60`、`java.base/share/native/libjimage/endian.cpp:40`。

## 5. `java.lang.reflect.Module`、`ModuleEntry`、`PackageEntry` 三层为什么要分开？

模块访问控制为什么不能只靠 Java 侧 `Module.isExported`，也不能只靠 VM 侧 `ModuleEntry`？

回答必须覆盖：

- Java 镜像 `java.lang.Module` 与 VM 侧 `ModuleEntry` 的镜像/元数据关系；
- `ModuleEntry` 记录 reads/open/patched 等模块级状态；
- `PackageEntry` 管理包级 export/open；
- VM linkage 与 Java reflection 的检查调用点不同；
- `--add-reads`/`--add-exports`/`--add-opens` 各自改哪一层。

追问：如果只查 `Module.isExported` 而不检查 caller 是否 reads，会绕过哪道门？为什么模块的“读”关系和“包开放”必须拆开存储？

源码入口：`share/classfile/moduleEntry.hpp:60`、`share/classfile/packageEntry.hpp:44`、`java.base/share/classes/java/lang/Module.java:453`、`share/runtime/reflection.cpp:491`。

## 6. Java 类库底层 native 库为什么需要 `JNU_*`/`JVM_*`/`JNI` 三种不同通道，它们分别服务谁？

`libjava` 里既有 `JNU_*` 工具，也调用 `JVM_*`，而这些都建立在 JNI 函数表之上。为什么需要区分？

回答必须覆盖：

- JNI 是任何 native 方法的通用入口（`JNIEnv*->functions`）；
- `JVM_*` 是 JDK 内部专用通道（libjava 编译期取址，如 `JVM_CurrentTimeMillis`）；
- `JNU_*` 是 libjava 内部的工具层，封装“错误翻译、字符串转换、属性采集”等复用逻辑；
- 为什么性能敏感方法（currentTimeMillis、arraycopy）走 `JVM_*` 而非通用 JNI 表；
- 这三条通道如何在一次普通 API 调用中协作。

追问：为什么 `System.currentTimeMillis` 在 libjava 里编译期取 `&JVM_CurrentTimeMillis`，而普通 native 方法却走 JNI 动态解析？`JNU_*` 与 `JVM_*` 的调用链叠在一起会怎样？

源码入口：`share/include/jvm.h:38`、`java.base/share/native/libjava/System.c:25`、`java.base/share/native/libjava/jni_util.c:44`、`share/prims/jvm.cpp:271`。

## 7. Java 类库的 native 边界合起来，如何形成一个“从 Java API 到 OS/VM 原语”的统一翻译层？

这么多 native 通道（JNI、JVM_*、JNU_*、libzip、libnio、jimage）看似分散，它们如何共同构成 Java 世界与 OS/VM 之间的稳定翻译协议？

回答必须覆盖：

- 每种通道的输入输出都是“Java 能消费的语义”（异常、String、属性、文件路径、socket 状态）；
- native 层负责把 OS 的原始数据/错误翻译成 Java 语义，而不是把 HotSpot 或 OS 细节上抛；
- 统一翻译层降低了每个 native 方法重复处理错误/编码/平台分支的成本；
- 为什么这些通道都在 `libjava/libnet/libnio/libzip/libjimage` 这些共享原生库中收敛，而非散落在调用点；
- 从“Java API → JNI/JVM_*/JNU_* → OS/VM 原语”的完整链路。

追问：如果一个 native 方法绕过 libjava 工具层直接调 `NewStringUTF` 拼接平台路径，最可能在哪类编码/路径问题上出错？为什么“统一翻译层”是 JDK 原生库的稳定设计而非过度设计？

源码入口：`java.base/share/native/libjava/jni_util.c:44`、`share/include/jvm.h:38`、`java.base/share/native/libzip/zip_util.c:568`、`java.base/linux/native/libnio/ch/EPoll.c:60`。