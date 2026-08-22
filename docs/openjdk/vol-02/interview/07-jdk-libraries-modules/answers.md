# 07 · JDK 类库、模块与运行时资源：专家答案锚点

## 1. libjava 是 Java 世界前的共同翻译层，不是 HotSpot 也不应散落在每个 native 方法中

`libjava` 是 JDK 的原生库，不是 HotSpot 的一部分。它的职责是把 OS 世界的原始数据和错误语义翻译成 Java 世界能消费的对象、字符串和异常。`JNU_ThrowXxx` 工具层（`java.base/share/native/libjava/jni_util.c:51`）把 native 错误统一翻成 Java 异常，`JNU_NewStringPlatform` 按 `sun.jnu.encoding` 处理编码转换，`System.initProperties`（`System.c:166`）在启动早期一次性采集平台属性。

如果不收敛到 libjava，每个 native 方法各自调用 `ThrowNew`/`NewStringUTF`，就会出现错误语义、编码策略和平台细节碎片化。`JNU_*` 是 libjava 层的工具，`JVM_*` 是 HotSpot 对外接口，`JNI` 是通用通道——三者分工不同。

## 2. ZIP 的 Central Directory 是“类加载的目录页”，哈希索引让 findClass 摊还常数

ZIP 文件尾部 END 记录定位 Central Directory（`zip_util.c:568`）。`readCEN` 建立哈希索引，后续 findClass 走哈希命中，不再顺扫全文件。LOCAL 头和数据偏移拖到第一次真正读取时才计算（`readCENHeader` 及相关逻辑，`zip_util.c:966`），因为不少条目可能从不会被实际读取。

顺扫方案在类加载反复访问同一个 JAR 的场景下会退化为 O(n)，而哈希索引 + 懒计算 LOCAL 头让打开成本与查询成本分离。

## 3. 传统 Socket 和 NIO 在 native 层的语义差异决定了相反的路线

传统 `Socket` 要求“等到有结论再回来”，所以 native 层用 `poll(2)` 补超时（`linux_close.c:394` 的 `NET_Connect`/`NET_Timeout`）。NIO `SocketChannel` 要求“现在做不到就返回未完成”，所以 socket 保持非阻塞模式，把 `EINPROGRESS` 翻译成 `IOS_UNAVAILABLE` 上抛给 Selector（`Net.c:306` 的 `connect0`），再由 epoll 统一等待就绪（`EPoll.c:59` 的 `EPoll_create`）。

两套语义不能互相替代，因为阻塞式 API 的调用方不接受“未完成”的返回值，而 NIO 选择器依赖统一事件循环来驱动。

## 4. jimage 是模块化后的定制资源索引，不是 ZIP 变体

`jimage` 文件由头部和 item 表组成（`jimage.cpp:60`），支持快速随机访问和按模块组织资源索引。模块化后 JDK 需要一个比 ZIP 更快的、可随机访问的、按模块名定位的资源索引，因为 startup 时 `jrt:/` 文件系统需要频繁查询。

如果换成 ZIP 结构，`jrt:/` 文件系统的查询会失去快速随机访问和按模块名定位的优势，增加启动期类加载延迟。

## 5. 模块访问控制不得不在 Java 镜像、VM 元数据和包级条目三层中分开

`ModuleEntry`（`moduleEntry.hpp:60`）记录 reads/open/patched 等模块级状态，`PackageEntry`（`packageEntry.hpp:44`）管理包级 export/open。Java 镜像 `java.lang.Module`（`Module.java:451`）是外层 API 视图。

`--add-reads` 改变模块可读边，`--add-exports` 改变包链接可见性，`--add-opens` 改变反射开放。`Module.isExported` 不检查 caller 是否 reads，因此不能单独用于完整模块访问判定。VM linkage 和 Java reflection 的检查调用点不同（`reflection.cpp:491`）。

## 6. JNI / JVM_* / JNU_* 三条通道分别服务不同抽象层次

JNI 是所有 native 方法的通用入口。`JVM_*` 是 JDK 内部专用通道（`jvm.h:38`），libjava 在编译期直接取 `&JVM_CurrentTimeMillis`，不走 JNI 运行时查找。`JNU_*` 是 libjava 内部的工具层，封装错误翻译、字符串转换和属性采集。

`System.currentTimeMillis` 走 `JVM_*` 而非 JNI 表，因为它极高频且不需要 JNI 的状态转换开销。`JNU_*` 与 `JVM_*` 的调用链在同一个 native 方法中叠在一起是常见的——例如 `System.getProperties` 先通过 `JVM_*` 获取 VM 信息，再用 `JNU_*` 工具翻译成 Java 属性表。

## 7. 所有 native 通道共同构成 Java 世界与 OS/VM 之间的统一翻译层

JNI、`JVM_*`、`JNU_*`、libzip、libnio、jimage 看似分散，但它们共同遵循一条原则：输入输出都是 Java 能消费的语义（异常、String、属性、文件路径、socket 状态），而非把 OS 或 HotSpot 的细节直接上抛。

这一层收敛在 `libjava/libnet/libnio/libzip/libjimage` 这些共享原生库中，而不是散落在每个 native 调用点。这样既降低了重复处理错误/编码/平台分支的成本，也让 Java 层 API 保持与底层实现解耦。从“Java API → JNI/JVM_*/JNU_* → OS/VM 原语”的完整链路构成了 JDK 的原生翻译协议。

## 评分锚点

- **合格**：能说清 libjava 与 HotSpot 的边界、JNI/JVM_*/JNU_* 的区别、ZIP 读取顺序。
- **良好**：能解释 jimage 与 ZIP 的差异、模块访问分层、传统 Socket 与 NIO 的 native 层差异。
- **专家级**：能用“Java 世界与 OS/VM 之间的统一翻译层”这一主线，把 libjava 工具层、JVM_* 通道、libzip/libnio/jimage 的所有 native 入口串起来。