# CDS（类数据共享）— 文章大纲

> vol-03 · 域 21 · 🟡 B | 拓扑排序 #21（vol-03 末域）
> 依赖：OOPs + Metaspace（元数据存储）+ 类加载机制（CDS 拦截类加载过程加速启动）
>
> **→ 从 G1 GC**：GC 负责回收，但每次 JVM 启动都要重新加载 `java.lang.Object`——1000 个微服务实例 = 1000 次重复的 class 解析。CDS 把这个过程 dump 成 mmap 文件。
>
> **→ 卷 04**：对象模型、内存管理、GC 全都好了。但 Java 类怎么从 `.class` 文件变成 JVM 里的 `InstanceKlass`？类加载与执行引擎篇见。

## 叙事计划

**开篇场景**：每次 JVM 启动都要加载 `java.lang.String`、`java.lang.Object` 这些核心类——解析 class 文件、创建 InstanceKlass、填充常量池。如果 1000 个 JVM 实例同时启动（微服务场景），这些一模一样的操作要重复 1000 次。CDS 的答案：把"加载完的类元数据"dump 成一个归档文件，后续 JVM 启动直接 mmap 进来——跳过 class 解析。

**第一层：归档格式——FileMapInfo**

`FileMapInfo`（`filemap.hpp:171`）管理归档文件。格式：魔数 `0xF00BABA2`（`:37`）→ `FileMapHeader`（版本号、CRC 校验、空间布局）→ `_space[]` 数组（RO/RW/MC/metadata 等空间）。`open_for_read()` 打开归档时校验：魔数匹配、版本匹配（`validate_header_impl`）、classpath 条目匹配（`validate_shared_path_table`）——任一步失败 → `UseSharedSpaces = false`。

**第二层：SharedClassPathEntry——运行时 classpath 校验**

`SharedClassPathEntry`（`:46`）存储 dump 时每个 classpath 条目的元数据：路径名、timestamp、filesize、manifest。运行时 JVM 重新遍历 classpath，逐条对照——如果任何一个 jar 被更新了（timestamp 变了），CDS 归档失效。这是为了防止"归档里的 `String.class` 是旧版本但新 classpath 里是新的"。

**第三层：MetaspaceShared——dump 和 map 的桥梁**

`MetaspaceShared`（`metaspaceShared.hpp:51`）管理归档的运行时映射。`preload_and_dump()` 在 `-Xshare:dump` 时运行——先加载全部核心类，把它们的 InstanceKlass/Method/ConstantPool dump 到归档文件。运行时 `map_archives()` 用 `mmap` 把归档文件映射到预留地址空间（`_shared_rs`）——同一个归档文件可以被多个 JVM 进程共享（OS 的 page cache 让多个 mmap 指向同一物理页）。

**第四层：AppCDS——应用类也能共享**

JDK11 的 AppCDS（JEP 310）允许应用类也参与共享。`-XX:DumpLoadedClassList` 生成类列表，`-Xshare:dump -XX:SharedClassListFile` 创建包含应用类的归档。注意：AppCDS 需要 `-XX:+UnlockCommercialFeatures`（JDK11 是商业特性）。

**设计权衡**

一、mmap 共享 vs 重新解析。mmap 跳过 class 文件解析——启动时间大幅减少。代价是归档文件和 classpath 严格绑定——任何 jar 更新都会让归档失效。

二、静态归档 vs 动态归档。JDK11 是静态归档（需要先 dump），JDK13+ 支持动态归档（运行时自动创建）。JDK11 应用需要手动 dump。

> **注**：`UseSharedSpaces=true` 是编译期默认，但运行时如果归档文件不存在（如本裁剪版 jdk11u）→ `open_for_read()` 失败 → `fail_continue()` → 动态设 `UseSharedSpaces = false`。生产 JDK 的 `$JAVA_HOME/lib/server/classes.jsa` 默认存在——CDS 在生产环境生效。

## 核心悬念

**JVM 启动时怎么跳过 `java.lang.Object` 的 class 解析——不是缓存，是把解析完的 Klass 二进制 dump 成 mmap 文件，下次启动直接映射到内存？**

## 预估

1 篇，4 层递进，预估 1800-2400 行。

**→ 卷 04**：CDS 让类加载更快——但它不改变"类加载完后 JVM 怎么执行代码"的核心问题。字节码怎么变成 CPU 指令？ClassFile 篇见。
