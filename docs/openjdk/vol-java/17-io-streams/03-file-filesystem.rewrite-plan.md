# 17-io-streams/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `File`、`java.io.FileSystem`、`java.io.UnixFileSystem`、`FileDescriptor`。本文聚焦 `File` 的路径抽象、FileSystem 委托、exists/create/delete/list/mkdirs 等行为，以及 fd 作为 OS 句柄影子的资源边界；NIO Path/Files 生态仅点到为止。
> 目标：把“File 与平台文件系统”改写成一篇围绕“File 不是已经打开的文件，也不是已经存在的磁盘实体，而是一段待委托给平台文件系统解释的路径；真正触盘和平台差异都躲在 FileSystem 后面”的机制文章。

## 1. 读者困惑

- `new File("a.txt")` 到底做了什么，为什么它明明像“文件对象”，却可能指向一个根本不存在的路径？
- `exists()` / `length()` / `createNewFile()` 为什么看起来像 File 自己会操作磁盘，实际却要继续委托别人？
- `createNewFile()` 为什么能做到“已存在则失败”的原子创建，而不是 Java 先 `exists` 再创建？
- `listFiles()` 和 `list()` 有什么关系，为什么删除目录常常失败？
- `FileDescriptor` 为什么和 `File` 不是一回事，为什么“不关流”最后会耗尽操作系统资源？

## 2. 一句话顿悟

**`File` 的第一身份不是“文件实体”而是“路径抽象”：构造时主要在做路径规范化和拼接，不触碰磁盘；真正的存在性、长度、原子创建、删除和目录列举，都通过 `FileSystem` 抽象下沉到平台实现。与此同时，真正稀缺的操作系统资源并不是 `File` 对象本身，而是 `FileDescriptor` 背后的 fd 句柄，所以“关闭流”是在释放 OS 资源，而不只是释放一个 Java 对象。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `File` 是路径抽象而非已存在文件实体、`FileSystem` 负责平台委托、`createNewFile` 的原子语义与目录删除陷阱。
- 已把 `FileDescriptor` 从 `File` 抽象里单独拎出来讲资源边界，这个视角是对的。
- 已把下一步序列化和文件内容/路径语义分开，篇章边界合理。

### 必须重写

- 旧稿偏 API 条目，需要先建立总问题：为什么 File 看起来像文件，实际先只是路径。
- FileSystem / UnixFileSystem 的关系要讲成“平台解释层”，而不是几条委托 API 罗列。
- 目录操作和删除失败要更明确地回到“File 不做递归语义”的失败方案上。
- FileDescriptor 要和“真正触盘的是流/描述符，不是 File 路径对象”这条线更紧地绑在一起。

## 4. 理解路径

### 第一节：从“new File 会不会触盘”开场

用最常见误解开场：很多人把 `new File(...)` 当成“打开了一个文件”。指出真正问题：它只是把路径字符串规范化、组合、保存下来，甚至连文件是否存在都不知道。

### 第二节：File 为什么首先只是路径抽象

证据：
- `File.java:148`：类定义
- `File.java:155`：平台文件系统单例 `fs`
- `File.java:516`：`getPath()`
- `File.java:576`：`getAbsoluteFile()`

主线：
- File 对象保存的是路径表示，而不是已打开文件句柄。
- 相对路径、绝对路径、规范化都还是路径层操作，不等于磁盘 I/O。
- 这解释了为什么构造 File 往往不失败：此时根本还没问系统“这个路径存不存在”。

### 第三节：为什么真正触盘的都要委托给 FileSystem

证据：
- `FileSystem.java:34`：抽象类定义
- `FileSystem.java:52/58/65/99`：`normalize/prefixLength/resolve`
- `File.java:823`：`exists()`
- `File.java:989`：`length()`
- `File.java:1029`：`createNewFile()`
- `UnixFileSystem.java:250`：`getBooleanAttributes0`
- `UnixFileSystem.java:261`：`getLength`
- `UnixFileSystem.java:266`：`createFileExclusively`

主线：
- File 把路径交给 FileSystem 去解释和操作，Java 层保持统一 API，平台层负责真正实现。
- UnixFileSystem 的 native 方法说明“存在性、长度、独占创建”都属于平台事实，不是 File 自己凭空知道的。
- `createNewFile` 的原子性来自底层 `createFileExclusively`，不是 Java 层先查再建。

### 第四节：目录 API 为什么会暴露“你以为它会递归，其实不会”的语义落差

证据：
- `File.java:1137`：`list()`
- `File.java:1257`：`listFiles()`
- `File.java:1390`：`mkdirs()`
- `File.java:1056`：`delete()`

主线：
- `listFiles()` 本质是在 `list()` 的结果上继续包成 `File[]`，不是新的底层目录协议。
- `mkdirs()` 是逐级创建父目录；`delete()` 只删文件或空目录，不帮你递归清空。
- 这说明 File API 名字看着朴素，但行为边界必须靠语义细读，不能脑补“它应该帮我做更多”。

### 第五节：FileDescriptor 为什么才是“真正稀缺资源”的 Java 影子

证据：
- `FileDescriptor.java:48`：类定义
- `FileDescriptor.java:50`：`fd`
- `FileDescriptor.java:150/158/167`：标准输入输出错误描述符
- `FileDescriptor.java:176`：`valid()`

主线：
- File 是路径抽象，FileDescriptor 才是操作系统打开文件/管道/终端句柄的 Java 影子。
- 流对象最终围绕 fd 工作，fd 才是有上限的稀缺 OS 资源。
- 因此“关闭流”不是礼貌问题，而是在释放真正会耗尽的外部资源。

## 5. 失败方案清单

1. 把 `new File(...)` 当成“已经打开文件”或“已经验证存在”的动作。
2. 用 `exists()` + `createNewFile()` 试图自己手搓原子创建语义。
3. 看到 `delete()` 就默认它会递归删除整棵目录树。
4. 把 `listFiles()` 当成和 `list()` 完全不同层级的系统调用。
5. 以为只要 File 对象被 GC 了，底层文件描述符资源就自动没问题。

## 6. 误解清单

1. File 对象天然代表一个真实存在的文件或目录。
2. 路径规范化、本地绝对路径解析和磁盘 IO 是同一类操作。
3. Java 层 `createNewFile()` 的原子性主要来自先检查 exists。
4. 删除目录失败多半是权限问题，而不是目录本身非空。
5. FileDescriptor 只是一个历史遗留类，和现代 File/流关系不大。

## 7. 证据清单

- `File.java:148`：类定义
- `File.java:155`：`fs`
- `File.java:516`：`getPath()`
- `File.java:576`：`getAbsoluteFile()`
- `File.java:823`：`exists()`
- `File.java:989`：`length()`
- `File.java:1029`：`createNewFile()`
- `File.java:1056`：`delete()`
- `File.java:1137`：`list()`
- `File.java:1257`：`listFiles()`
- `File.java:1390`：`mkdirs()`
- `FileSystem.java:34`：抽象类定义
- `FileSystem.java:52/58/65/99`：路径相关抽象方法
- `UnixFileSystem.java:34`：类定义
- `UnixFileSystem.java:85/103/138`：路径处理
- `UnixFileSystem.java:250`：`getBooleanAttributes0`
- `UnixFileSystem.java:261`：`getLength`
- `UnixFileSystem.java:266`：`createFileExclusively`
- `FileDescriptor.java:48`：类定义
- `FileDescriptor.java:50`：`fd`
- `FileDescriptor.java:150/158/167`：标准描述符
- `FileDescriptor.java:176`：`valid()`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 `java.io.File` 旧体系的路径与平台委托语义，不展开 `java.nio.file.Path/Files` 全景替代方案。
- UnixFileSystem 用作平台实现示例，不外推为所有平台都如此。
- 不把文件描述符资源管理扩成完整 Cleaner/finalizer 专题，只讲到“为何必须关闭流”。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“File 为什么先只是路径抽象 → 真正触盘操作为什么都要委托给 FileSystem / UnixFileSystem → createNewFile 的原子性从哪来 → 目录相关 API 为什么容易和递归语义混淆 → FileDescriptor 为什么才是 OS 资源影子”。
- 必须把 File 和 FileDescriptor 的边界讲清。
- 必须自然收束 17 域并衔接 18 域序列化。
