# 02. 为什么 JDK 自己不用 ZIP？— `jimage` 模块镜像

> **版本边界**：本文基于 `OpenJDK 11u / libjimage / Linux / x86_64`。这里讨论的是 JDK 9+ 的 `lib/modules` 镜像在运行时怎样被打开、定位和读取：前置索引、完美哈希、`memory_map_image`、资源读取与资源压缩头。本文站在运行时读镜像的视角，不展开 `jlink` 构建器内部怎样生成这份镜像。
>
> **前置依赖**：[01 — 为什么找一个类要先去读 ZIP 尾巴？— JAR 的原生读取路径](01-zip.md)
> → **后续**：[42-core-native/01 — JNI 工具层与系统属性](../42-core-native/01-jni-system.md)

上一章已经把 JAR/ZIP 这条路讲清楚了：打开时先从文件尾找到 Central Directory，读出整包目录，再在运行时内存里建一张哈希索引；后续按名字查条目时靠缓存、哈希预筛和 CEN 原文验证把成本压下来；真正的 LOCAL 头和压缩流则尽量拖到最后一刻才碰。

这条路径已经很不错了。

但它有一个绕不过去的前提：**运行时打开 ZIP 之后，仍然要先“为这个包建一份查找索引”。** 就算这份索引很轻，就算它只建一次，它仍然是一次运行时成本。

而 JDK 自己的基础模块集合恰恰很特殊：

- 它是高度稳定的；
- 它在每次启动都会被大量访问；
- 它几乎是只读镜像，不像第三方 JAR 那样随时替换；
- 资源集合在构建期就已经全部已知。

这就逼出本篇最该回答的问题：**既然上一章的 ZIP/JAR 路径已经能靠 CEN + 哈希表 + 惰性读取把查找成本压下来，JDK 为什么还要单独发明 jimage？它到底把哪些运行时成本提前搬到了构建期，为什么这会让 JDK 自己的模块镜像比 ZIP 更合适？**

先把答案压成一句话：**jimage 不是“另一个压缩包格式”，而是把 JDK 自己当成近乎只读镜像来组织：ZIP 把目录放尾部、运行时打开时再建哈希，jimage 则在构建阶段就把整套前置索引、完美哈希和字符串去重表算好。运行时打开镜像时，HotSpot 主要是在映射一份已经预排好的查找结构；查找资源时不再构建索引，而是直接用 redirect table 驱动的最小完美哈希定位，再用 verify 作最后保险。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：继续用 ZIP，只要把缓存做得更积极一点

这是最自然的第一反应。

既然 ZIP 已经有 Central Directory，运行时也已经会建哈希索引，那为什么不继续沿用 JAR/ZIP？无非就是多做一点缓存：JDK 自己的那些基础模块反复访问得多，那就让 `jzfile` 缓得更久、哈希表复用得更激进，不就行了。

这个想法的问题在于，它只优化了“同一个 ZIP 多次打开”的成本，却没有消掉 ZIP 这条路径的根本前提：**运行时第一次打开时，仍然必须从尾部找目录，再为这个包现建一份索引。**

对于第三方 JAR，这笔成本很合理，因为 ZIP 本来就是通用归档格式，你无法要求构建方替 JVM 预先算好一套只服务 HotSpot 的内部索引。但 JDK 自己的基础模块不是这种处境。它们是 JDK 发布物的一部分，构建时就已经知道全集，也知道运行时将以“按名字频繁查找资源”的方式访问。

这时继续坚持 ZIP 的通用性，就等于让运行时一次又一次承担本可以在构建期做掉的工作。

换句话说，**ZIP 路径已经把运行时成本压得不错，但它仍然是一条“运行时先建目录索引，再开始查”的通用格式路径。** 对 JDK 自己的镜像，这还不够激进。

所以第一种朴素方案失败，不是因为 ZIP 不够能用，而是因为它还保留了本可前置到构建期的运行时索引成本。

### 朴素方案二：那就用 jimage，但运行时照样临时建索引

第二个也很自然的想法是：好，我接受要一个新格式。那 jimage 也未必非得在构建时把一切算死。完全可以像 ZIP 那样：运行时打开镜像后，临时把里面的目录区扫一遍，建哈希表，再开始查。

这个方案等于把 jimage 做成“换了一层皮的 ZIP”，问题是它会直接失去 jimage 最核心的价值：**JDK 之所以值得单独有一个镜像格式，恰恰是因为它能把运行时索引构建这件事彻底挪出热路径。**

JDK 基础镜像和普通 JAR 的差异，不只是“访问频率更高”，而是“资源全集在构建期完全可知，而且部署后近乎只读”。这意味着它可以预先支付更高的打包成本，换运行时更直接的查找结构。

如果运行时还要像 ZIP 一样临时建哈希，那你只是把“通用归档格式”换成了“专用归档格式”，却没有换掉最重要的读取哲学。

所以第二种方案失败的根本原因是：**jimage 的意义不在换头部魔数，而在把索引构建从运行时转移到构建时。**

这两个失败方案合起来，正好引出 jimage 的正式思路：**让运行时尽可能像在映射并消费一份已经排好索引的镜像，而不是在现场整理一份目录。**

## 打开阶段：为什么 jimage 像映射磁盘镜像，不像打开压缩包

先看打开时发生了什么。

`ImageFileReader::open()` 的动作非常克制：

- 只读打开文件；
- 取文件大小；
- 读 `ImageHeader` 并校验 magic 与主次版本；
- 算出 index 大小；
- 直接把文件映射进地址空间；
- 然后按 header 给出的长度字段，把映射区切成四段。`src/java.base/share/native/libjimage/imageFile.cpp:369`

这一串动作里最值得注意的是：**它完全没有“先顺扫目录、再运行时建表”的阶段。**

打开 jimage 时，运行时真正做的更像是：确认这是一块合法镜像，然后把其中已经排布好的索引结构映射出来。

### 头部为什么只有少数几个字段，却决定了一切

`ImageHeader` 的关键作用不是保存业务元数据，而是告诉运行时：

- 这是不是 jimage（`IMAGE_MAGIC = 0xCAFEDADA`）；
- 版本是否匹配；
- 表长是多少；
- locations 区和 strings 区有多大。`src/java.base/share/native/libjimage/imageFile.hpp:443`

一旦这些信息成立，`index_size()` 就能把整个索引区长度算出来：

```cpp
sizeof(ImageHeader) + table_length() * sizeof(u4) * 2 + locations_size() + strings_size()
```

`src/java.base/share/native/libjimage/imageFile.hpp:437`

然后 `open()` 里再顺着这套长度关系把四段地址切出来：redirect table、offsets table、location bytes、string bytes。`src/java.base/share/native/libjimage/imageFile.cpp:369`

这说明 jimage 打开阶段最大的设计特点是：**索引布局是前置且自描述的，运行时只需要按头部长度切片，不需要自己发明索引结构。**

### `memory_map_image`：同一份格式，两种运行时策略

另一个很有代表性的设计是 `memory_map_image`。源码直接定义：

```cpp
bool ImageFileReader::memory_map_image = sizeof(void *) == 8;
```

`src/java.base/share/native/libjimage/imageFile.cpp:44`

而 `map_size()` 又把这个开关翻译成两种策略：

- 64 位：映射整个文件；
- 否则：只映射索引区。`src/java.base/share/native/libjimage/imageFile.hpp:493`

这一步特别值得停一下，因为它说明 jimage 的“镜像感”不是非黑即白的。它并不是无条件要求所有平台都全文件 mmap，而是明确承认：

- 64 位地址空间宽裕，可以用虚拟地址换掉一批后续系统调用；
- 32 位地址空间紧张时，至少保证索引前置且常驻，正文再按需读。

也就是说，**被前置和固定下来的首先是索引结构；正文如何映射，是平台资源条件下的第二层选择。**

## 查找阶段：为什么 redirect table 是构建期算好的完美哈希

如果说上一节回答的是“打开时为什么不用再建索引”，那这一节回答的就是：**运行时既然不建索引，那查找到底靠什么。**

答案就是 jimage 的 redirect table，也就是构建期就算好的最小完美哈希索引。

### `ImageStrings::find`：运行时不是建哈希，而是消费哈希

`ImageStrings::find()` 的注释先给了一个很重要的限定：结果是“the index where the name should be”，而且“result still needs validation for precise match (false positive.)”。`src/java.base/share/native/libjimage/imageFile.cpp:72`

这句话已经把 jimage 查找的哲学说得很清楚：**运行时不是从零开始建哈希表，而是在消费一张构建期已经准备好的 redirect table。**

查找逻辑本身也很紧凑：

- 先算一遍基本 hash；
- 对 table length 取模定位槽；
- 看 redirect 槽值：
  - `0`：没找到；
  - `< 0`：`-1 - value` 就是真正索引；
  - `> 0`：这个值不是结果，而是一个新的 seed，要带着它重新算 hash 再取模。`src/java.base/share/native/libjimage/imageFile.cpp:75`

这和上一章 ZIP 运行时的链式哈希有本质区别。

ZIP 的运行时做法是：

- 先建 table；
- 冲突了就链表继续走；
- 命中 hash 后再读 CEN 逐条核验。

jimage 的做法则是：

- 构建期先把冲突解决方案算进 redirect table；
- 运行时只做“按这张重定向表取一步或重算一步”；
- 不再自己维护链表冲突结构。

所以 jimage 查找真正前置到构建期的，不只是“目录区放前面”，而是**连冲突处理策略本身都预先烘焙进了镜像。**

### 这不是普通哈希表，而是“冲突求解表”

这张表最容易被误解成“只是另外一种哈希桶数组”。

其实它的重点不在“数组”本身，而在于：槽位里的值不总是索引，有时是一个重新哈希的种子。也就是说，redirect table 干的不是单纯记录结果，而是在编码“**这个名字落进此槽后，下一步该怎么消解碰撞**”。

所以运行时看到的不是哈希链，而是一份“构建器已经帮你算好的冲突求解脚本”。

这才是它比 ZIP 运行时建表更进一步的地方。

### 为什么仍然要 `verify_location`

讲到这里最容易冒出的误解就是：既然是最小完美哈希，那 runtime 拿到索引是不是就该无条件相信它？

源码恰恰提醒我们不要这么想。

`verify_location()` 会把路径按 `/module/parent/base.extension` 拆开，再逐段和字符串表里的属性比对，最后只有到串尾正好结束才算真命中。`src/java.base/share/native/libjimage/imageFile.cpp:483`

这层 verify 为什么仍然存在？因为完美哈希保证的是“构建时那一组已知资源名”的冲突可控，不代表任意输入字符串都天然无歧义。运行时查询方可以传任何名字进来，`find()` 给的是“这个名字应该落到哪个索引槽去”，但最终仍要由属性表内容确认“你是不是要找的那个完整路径”。

所以本节最该记住的一句话是：**完美哈希负责快定位，`verify_location` 负责最后裁决。**

这和上一章“ZIP 里 hash 负责快，CEN 原文负责准”是一种同构关系，只不过 jimage 把快定位这部分做得更前置、更极端。

## 读取资源：为什么 mmap、压缩头和解压器栈能同时存在

到这里很多人会自然以为：既然 jimage 把索引前置、还经常 mmap 全文件，那它是不是就等于“所有资源都能零拷贝直接拿到”？

事情没这么简单。

### `get_resource`：索引前置，不等于正文永不加工

`ImageFileReader::get_resource()` 先从 `ImageLocation` 里取出三个关键属性：

- 偏移；
- 未压缩大小；
- 压缩大小。`src/java.base/share/native/libjimage/imageFile.cpp:533`

然后它按 `compressed_size` 是否为 0 分两条路：

- 如果压缩了：
  - `memory_map_image` 为真时，直接拿 `get_data_address() + offset` 作为压缩数据指针；
  - 否则先 `read_at` 读进临时缓冲；
  - 再交给 `ImageDecompressor::decompress_resource(...)`。`src/java.base/share/native/libjimage/imageFile.cpp:533`
- 如果没压缩：直接 `read_at` 把正文读到目标缓冲。`src/java.base/share/native/libjimage/imageFile.cpp:533`

这段逻辑非常值得停一下，因为它说明 jimage 前置的是“查找结构”，不是“所有资源正文都自动零成本”。

换句话说：**索引可以被映射并直接定位，正文是否零拷贝还要看是否压缩、看当前映射策略、看读取分支。**

### `ResourceHeader`：压缩资源不是裸 deflate，而是自带“快递单”

压缩资源进入解压器前，前面还有一层 `ResourceHeader`。它记录：

- magic；
- 当前压缩块大小；
- 解压后大小；
- 解压器名字在字符串表里的偏移；
- 配置偏移；
- `is_terminal`。`src/java.base/share/native/libjimage/imageDecompressor.hpp:56`

这就说明 jimage 里的压缩资源不是“所有条目统一走一个固定 deflate 算法”，而是**每个资源自己带着一张解压说明单**。

### 为什么支持“解压器栈”

`imageDecompressor.hpp` 的注释非常关键：同一个资源可以被多次压缩，形成一栈解压器；运行时会在循环里不断解，直到没有更多头为止。`src/java.base/share/native/libjimage/imageDecompressor.hpp:68`

真正执行这件事的是 `ImageDecompressor::decompress_resource()`：它会循环读取一个 `ResourceHeader`，如果 magic 对上，就按 header 里的解压器名字找到对应实现，解完一层后继续检查下一层；直到没有头为止，最后再把最终结果 memcpy 到调用方缓冲。`src/java.base/share/native/libjimage/imageDecompressor.cpp:142`

这段逻辑很有设计味道，因为它告诉我们：**jimage 的“镜像感”不等于“正文都不压缩”，而是“索引和定位路径被前置和标准化，正文压缩策略则继续保留逐资源的灵活性”。**

所以这一节最该记住的一句话是：**jimage 优化的是“先找到谁”，不是强行把“资源正文永远原样摆着”写死。**

## 布局与 ZIP 的总对比：为什么一个前置索引，一个尾部目录

现在终于能把 jimage 和上一章的 ZIP 放在一张图里正面对比了。

### ZIP 的运行时哲学：通用归档 + 现场建索引

ZIP/JAR 的核心哲学是：

- 文件格式先服务通用归档；
- 目录放尾部；
- 运行时打开时再解析 CEN；
- 再现场建立适合查找的哈希结构；
- LOCAL 和解压成本继续按需推迟。

这条路对通用压缩包非常合理，因为 ZIP 的生产者并不天然知道 JVM 会怎样消费它。

### jimage 的运行时哲学：镜像 + 前置索引

jimage 则完全相反：

- 索引布局在文件前部；
- redirect table、offsets、location bytes、strings 一开始就排好；
- `index_size()` 一算，运行时就知道整块索引长什么样；
- 查找时直接吃构建期算好的完美哈希；
- 资源正文按需要再读、再解。`src/java.base/share/native/libjimage/imageFile.hpp:437`

这就是为什么我说 jimage 不是“更快的 ZIP”，而是“**把运行时索引构建成本前置到构建时**”。

### 字符串表去重：这份镜像甚至连路径都不想反复存

jimage 的字符串表也很能体现这种镜像思路。资源路径不是每个条目各自带完整名字，而是拆成 module、parent、base、extension 等属性，再按偏移引用字符串表中的去重片段。运行时 `verify_location()` 正是在把这些属性重新拼成路径语义。`src/java.base/share/native/libjimage/imageFile.cpp:483`

这和 ZIP 里每个条目完整存名字的做法形成了鲜明对比：ZIP 更通用，jimage 更像为“稳定全集 + 高频查找”量身优化的专用镜像。

## 到这里为止，主线其实只发生了四件事

如果前面信息不少，这里先把整件事压回四步：

1. jimage 在构建期就把运行时要用的前置索引和完美哈希结构算好；
2. 运行时打开时主要是在校验并映射这份已排布好的索引，而不是现场建表；
3. 查找时靠 redirect table 快定位，再由 `verify_location` 做最后裁决；
4. 正文读取和解压仍然按需发生，只是它们建立在一条更短、更稳定的索引路径上。

只要这四步还在脑子里，`memory_map_image`、redirect table、`ResourceHeader` 这些名字就不会再像零散组件。

## 常见误解澄清

### 误解一：jimage 只是“更快的 ZIP”

不对。

它的核心不是把 ZIP 的每一步都做快一点，而是把“运行时先建索引”这件事整体搬到构建期。格式哲学就已经变了。

### 误解二：mmap 全文件在所有平台都默认

不是。

当前实现里 `memory_map_image` 与位数直接相关：64 位默认映射全文件，32 位则退回“只映射索引区”。`src/java.base/share/native/libjimage/imageFile.cpp:44`、`src/java.base/share/native/libjimage/imageFile.hpp:493`

### 误解三：完美哈希意味着完全不需要 verify

也不是。

`ImageStrings::find()` 自己就写明结果仍需 validation；最终路径匹配还是靠 `verify_location()` 分段核对。`src/java.base/share/native/libjimage/imageFile.cpp:72`、`src/java.base/share/native/libjimage/imageFile.cpp:483`

### 误解四：jimage 不支持压缩

不对。

它只是把“如何查到资源”优化成镜像式索引，不代表正文都必须裸放。压缩资源仍然带 `ResourceHeader`，并可通过解压器栈逐层展开。`src/java.base/share/native/libjimage/imageDecompressor.hpp:56`

### 误解五：未压缩资源总能零拷贝

不能这么说。

当前 `get_resource()` 里，压缩资源在 `memory_map_image` 为真时可以直接把映射区地址交给解压器；未压缩资源则仍走 `read_at` 到调用方缓冲。`src/java.base/share/native/libjimage/imageFile.cpp:533`

## 收网：jimage 的本质，是把 ZIP 在运行时做的索引工作前置到构建时

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
ZIP/JAR
  运行时打开时
    ├─ 先找尾部目录(CEN)
    ├─ 再建哈希表
    └─ 条目读取时惰性碰 LOCAL / 解压

jimage
  构建时(jlink)
    ├─ 先算前置索引
    ├─ 先算完美哈希 redirect table
    └─ 先做字符串去重与资源属性编码

  运行时打开时
    ├─ 校验头部
    ├─ mmap 全文件或索引区
    ├─ 切出 redirect / offsets / location / strings 四段
    └─ 查找时直接 find + verify_location
```

把它再压成三句话：

- ZIP 把通用性放在前面，所以运行时仍要自己解析目录并建查找索引。
- jimage 把 JDK 镜像当成构建期已知、运行期近乎只读的资源全集，所以把索引和冲突求解前置到构建时。
- 运行时因此不再“为镜像建索引”，而是在消费一份已经预排好的查找结构；正文读取和解压则继续按需发生。

所以 JDK 之所以不继续把自己装进 ZIP，并不是因为 ZIP 不能用。

真正的原因是：**JDK 自己的模块镜像稳定、封闭、访问频繁，值得用一个专用格式把“运行时建索引”这笔成本彻底消掉。** 这正是 jimage 相对 ZIP 的根本胜负手。

从这里再往下，就离开“文件格式”这个主题，转到 JVM 与平台交界处另一批更底层的 native 基础设施了。

> → [42-core-native/01 — JNI 工具层与系统属性](../42-core-native/01-jni-system.md)
