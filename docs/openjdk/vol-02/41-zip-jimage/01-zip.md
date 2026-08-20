# 01. 为什么找一个类要先去读 ZIP 尾巴？— JAR 的原生读取路径

> **版本边界**：本文基于 `OpenJDK 11u / libzip / Linux / x86_64`。这里讨论的是 HotSpot 通过 `libzip` 从 JAR/ZIP 中定位和读取条目的原生路径：如何在打开时解析 Central Directory、如何建立查找索引、如何在第一次真正读取时再计算 LOCAL 头后的数据偏移，以及如何按需解压。Java 层 `JarFile` / `URLClassPath` 的细节不在本文展开。
>
> **前置依赖**：[38-perfdata/02 — 为什么有些 PerfData 不在事件现场更新？— `StatSampler`](../38-perfdata/02-stat-sampler.md)
> → **后续**：[02 — `JIMAGE` 模块镜像](02-jimage.md)

如果你把一个类放进 `your-app.jar`，那么 `ClassLoader.findClass("com.foo.Bar")` 最后当然要在压缩包里找到 `com/foo/Bar.class`，再把那段字节读出来。本文不展开中间 Java 层 `JarFile`/`ZipFile`/native bridge 的衔接细节，而是直接站在最底层 `libzip` 视角看“native 侧到底怎样把这个条目找出来”。

但一旦你顺着 OpenJDK 的原生路径往下追，很快就会撞上一个很反直觉的事实：native 侧不是从 ZIP 文件开头一路扫到目标条目，而是先跑到文件尾巴去找 END，再据此定位 Central Directory，接着还会在内存里额外建一张哈希表。甚至连条目真实数据偏移都不在打开时算完，而是拖到第一次真正读取时才去碰 LOCAL 头。

这就逼出本篇最该回答的问题：**JAR 明明就是一堆文件拼在一起，JVM 为了找一个 `com/foo/Bar.class`，为什么不顺着 ZIP 头一路扫过去，而是先去文件尾巴找 END/CEN，再额外建一张哈希表？这是不是太重了？而且为什么连 LOCAL 头都不在打开时读完，还要拖到第一次真正读内容时再算数据偏移？**

先把答案压成一句话：**libzip 读取 JAR 的核心不是“把 ZIP 文件顺序解析一遍”，而是先把文件尾部的 Central Directory 当成整包目录，打开时只做一次建表，之后所有类查找都变成“哈希命中目录项 → 按需验证名字 → 第一次读取时再碰 LOCAL 头和压缩流”。HotSpot 之所以愿意在打开时付出一次目录解析成本，是为了把后续海量 `findClass` 从顺序扫描压成基于哈希链的摊还常数级查找。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：每次找类都顺着 ZIP 文件顺序扫过去

这是最直觉的第一反应。

JAR 既然就是 ZIP，那就像遍历普通归档文件一样：每次要找 `com/foo/Bar.class`，就从头顺着每个条目扫过去，看到同名条目就停。

这个方案功能上当然能工作，但它在 JVM 的实际使用模式下几乎注定会变慢。

因为类加载不是“一辈子只找一次条目”。同一个 JAR 可能会被：

- 启动期连续找几十、几百个类；
- 多个类加载器反复访问；
- 工具链（比如编译器、反射、资源读取）频繁命中。

如果每次查找都从 ZIP 头顺扫一遍，那么一次 `findClass` 就会退化成 O(n)；当一个 JAR 有成百上千个条目时，JVM 找的不是一个类，而是在反复做“顺序扫描整个包目录”这件事。

这就像每次去图书馆找一本书，都不查目录卡，而是从第一排书架一路往后翻。一次也许还能忍，几十次就完全不划算了。

ZIP 恰好给了一个现成的“目录卡”——Central Directory。既然整包的文件名、方法、尺寸、LOCAL 偏移等摘要信息已经集中放在尾部目录区，那最合理的做法就是：**打开时先把目录区读出来，建立一份只服务查找的索引，后面按名字查条目时不再顺扫全文件。**

所以第一种朴素方案失败，不是因为 ZIP 不能顺扫，而是因为 JVM 的真实访问模式决定了顺扫成本会被一遍又一遍放大。

### 朴素方案二：那就打开时把所有 LOCAL 头和数据偏移都一次性算完

第二个很自然的想法是：好，我承认要先读目录区建索引。那既然都已经在打开时遍历 CEN 了，不如更进一步，把每个条目的 LOCAL 头也顺手读掉，把真实数据偏移一次性全算好。这样后面读取内容就更省事。

这个方案比第一种更聪明，但它同样忽略了一个事实：**“打开 JAR”不等于“马上会读其中每个条目的内容”。**

很多时候，打开一个 JAR 之后，真正会被读出来的只是一小部分条目；大量条目终其一生都只会参与“名字查找”，不会进入“正文读取”。如果你在打开时把所有 LOCAL 头都扫一遍，就等于把原本只在命中条目上发生的 IO 和页面触碰，提前摊到了所有条目身上。

而 `libzip` 的源码注释甚至把这个权衡说得很重：`ZIP_GetEntryDataOffset` 之所以延迟去读 LOCAL 头，就是为了避免在初始化 `jzentry` 对象时碰到含 LOCAL 头的虚拟内存页；在非常慢的文件系统上，这能让 `javac` 提速一个数量级。`src/java.base/share/native/libzip/zip_util.c:1265`

所以第二种方案的问题不在于“多做一点准备工作也许没坏处”，而在于：**它把原本只该为真正命中条目支付的成本，提前强加给了整包所有条目。**

这两个失败方案合起来，正好引出 `libzip` 的正式思路：**打开时只建立目录索引；命中条目时才按需验证和读取；真正的数据偏移也尽量拖到最后一刻再算。**

## 打开阶段：为什么 END/CEN 在尾部反而更适合做目录

先看打开时到底做了什么。

入口是 `ZIP_Open_Generic`。它的动作很克制：

- 先试 `ZIP_Get_From_Cache(name, ...)`；
- 如果缓存没命中，再真正打开文件并走 `ZIP_Put_In_Cache(...)`。`src/java.base/share/native/libzip/zip_util.c:772`

也就是说，连“打开 ZIP”这件事 HotSpot 都不愿意每次重来。只要同一个 JAR 还在缓存里，目录区解析和建表成本就尽量只付一次。

### 为什么先查 `zfiles` 缓存

`ZIP_Get_From_Cache` 会在全局 `zfiles` 链表里按文件名、`lastModified` 和引用计数查可复用的 `jzfile`。`src/java.base/share/native/libzip/zip_util.c:798`

这一步的意义很简单但很关键：JAR 打开后的“最贵动作”不是拿到一个文件描述符，而是后续的目录区解析和索引构建。既然这些结构都挂在 `jzfile` 里，那复用同一个 `jzfile` 就等于复用了整张目录索引。

所以打开阶段第一层优化不是 ZIP 格式本身，而是“**同一个包尽量只解析一次目录**”。

### 为什么 ZIP 的目录偏偏放在尾部

真正进入文件后，`readCEN` 先做的不是读头，而是调用 `findEND` 去尾部找 END 头。`src/java.base/share/native/libzip/zip_util.c:568`

`findEND` 的逻辑是从文件尾部分块倒着扫，寻找 `PK\005\006` 这个 END 签名；找到后再验证和拷贝 END 头。`src/java.base/share/native/libzip/zip_util.c:329`

第一次接触 ZIP 时，这种“先读尾巴”的路线很容易让人觉得别扭。但从目录设计角度看，它其实很合理。

因为 Central Directory 本来就是整包的总目录：

- 条目数；
- 目录区长度；
- 目录区偏移；
- 各条目自己的摘要头。

把它放在尾部的好处是，打包器可以一路写本地条目，最后再统一收尾写目录；读取方则可以通过 END 一次反向跳到目录区，拿到“整包的地图”，而不必像 TAR 那样靠顺扫一路发现条目。

所以“目录在尾部”不是 ZIP 的怪癖，而是它支持“**先写正文、最后补全目录；读时先拿目录、再按目录回找正文**”的关键设计。

### `readCEN`：先把目录区当成地图整体读进来

`readCEN` 在拿到 END 之后，会读出：

- CEN 总长度；
- CEN 偏移；
- 总条目数。`src/java.base/share/native/libzip/zip_util.c:568`

接着它会根据这些信息把整段 CEN 读进来。这里还顺带处理了 ZIP64 的边界，但本篇不深挖 ZIP64 细节，只要记住：**真正用来建索引的不是 LOCAL 头，而是 CEN 目录区。**

这一步最值得记住的不是字段名，而是视角切换：HotSpot 打开 JAR 时不是在“准备读一个压缩文件流”，而是在“**先把这整个包的目录拿到手**”。

## 建表：为什么内存索引只存 `hash + next + cenpos`

拿到整个目录区之后，`readCEN` 并没有急着把每个条目都展开成完整对象，而是只为查找建立一层轻量索引。

核心代码是这一段：

- `entries = calloc(total, sizeof(entries[0]))`
- `tablelen = ((total/2) | 1)`
- `table = malloc(tablelen * sizeof(table[0]))`
- 每个 entry 记录 `cenpos` 和 `hash`
- 再按 `hash % tablelen` 头插进哈希桶链。`src/java.base/share/native/libzip/zip_util.c:568`

### 为什么 `entries[]` 不存完整名字

这可能是整篇最容易被忽略、但最有设计味道的地方。

`entries[]` 里每个 `jzcell` 真正保存的核心并不多：

- `hash`
- `next`
- `cenpos`。`src/java.base/share/native/libzip/zip_util.h:225`

也就是说，它并没有把完整文件名复制进哈希表，更没有在打开阶段就把每个条目的完整 `jzentry` 都实例化出来。

这说明 `libzip` 打开时建的不是“完整对象缓存”，而是“**最小足够查找索引**”。

为什么这么做？因为打开阶段最重要的目标不是“以后拿到条目就一步到位”，而是“尽量便宜地把名字查找从 O(n) 压到接近 O(1)”。

为此，最值钱的信息只有三样：

- 这个目录项的名字 hash；
- 同桶冲突时往哪跳；
- 真要进一步核验时，该回到 CEN 的哪个偏移读原文。

完整名字留在 CEN 缓冲里或者后续再按需读取，比在内存索引层到处复制一份更省空间，也推迟了无用解析。

所以这里的权衡非常明确：**打开时只把“查找必要的最小索引”常驻在内存里，真正的条目细节留到命中后再展开。**

### `tablelen = ((total/2) | 1)` 想解决什么

`tablelen` 不是简单取 `total` 或 2 的幂，而是 `(total/2) | 1`。源码还在旁边注了句 `Odd -> fewer collisions`。`src/java.base/share/native/libzip/zip_util.c:694`

这说明 `libzip` 在这里追求的不是教科书式“低负载因子哈希表”，而是一种很务实的折中：

- 哈希表桶数只取条目数的大约一半，省内存；
- 冲突用链式解决，在理想负载因子视角下平均每桶大约 2 个条目；
- 取奇数，尽量减少某些低位模式导致的聚集。

换句话说，它不是在为一个超高并发、超低延迟的泛型哈希库做优化，而是在为“ZIP 目录索引”做足够好的专用结构。

### 目录区是地图，哈希表是地图索引

如果把这一层压成一句好记的话，那就是：**Central Directory 是整包地图，`entries[] + table[]` 是这张地图的查找索引。**

这也解释了为什么打开阶段看起来“先付了一次建表成本”却仍然值得：因为之后几乎所有按名字找条目的操作，都会靠这张索引把成本收回来。

## 查找阶段：为什么要三层命中链路

有了索引之后，真正的热路径是 `ZIP_GetEntry(zip, name)`。`src/java.base/share/native/libzip/zip_util.c:1163`

这段逻辑最有意思的地方在于：它不是单一命中路径，而是三层递进。

### 第一层：先试单条目缓存

`ZIP_FreeEntry` 在释放条目时，不是直接 free 掉当前条目，而是把它塞进 `jzfile->cache`，再真正 free 掉上一个缓存项。`src/java.base/share/native/libzip/zip_util.c:1133` 头文件注释也写得很明白：`we cache the most recently freed jzentry`。`src/java.base/share/native/libzip/zip_util.h:230`

随后 `ZIP_GetEntry` 每次查找都会先看这个单条目缓存：如果缓存里的名字和当前要找的名字相等，直接命中返回。`src/java.base/share/native/libzip/zip_util.c:1178`

这条优化看起来朴素，却非常贴近真实访问模式：同一个类路径、资源路径或元信息条目经常在短时间内被重复触碰。与其每次都重新走哈希链和 CEN 解析，不如先给“最近释放的那个条目”一个免费回头客机会。

### 第二层：哈希桶链预筛

缓存没命中，才进入真正的哈希表查找：

- 先算 `hashN(name, name_len)`；
- 从 `table[hsh % tablelen]` 拿到桶头；
- 沿 `next` 链走下去。`src/java.base/share/native/libzip/zip_util.c:1163`

这一步仍然不是最终裁决，它只是用 32 位哈希把绝大多数不相关项先筛掉。

### 第三层：命中 hash 后，回到 CEN 读原文名字核验

真正重要的是，hash 相等后 `libzip` 并不会就此认定“找到了这个条目”。它会：

- 调 `newEntry(zip, zc, ACCESS_RANDOM)`；
- 读出该 `cenpos` 对应的条目头和名字；
- 最后再用 `equals(ze->name, ..., name, name_len)` 做真名比较。`src/java.base/share/native/libzip/zip_util.c:1192`

这一步非常关键，因为它说明哈希表在这里从头到尾都只是**预筛层**，不是最终真相来源。最终裁决永远是 CEN 原文里的真实名字。

这就保证了正确性不会绑死在哈希函数上：哈希碰撞了，最多多走几步链、多做几次 CEN 解析，不会把错误名字认成正确条目。

所以查找阶段最该记住的一句话是：**哈希负责快，CEN 原文负责准。**

## 读取阶段：为什么连数据偏移都要惰性计算

查到条目后，很多人会下意识以为“那正文偏移应该已经知道了”。

`libzip` 在这里偏偏还留了一手惰性。

### 为什么不能只信 CEN 里的额外字段长度

`ZIP_GetEntryDataOffset` 的注释把问题说得很清楚：ZIP 规范明确允许 LOCAL 头里的 extra data size 和 CEN 里的 extra data size 不同，虽然 JDK 自己一般不生产这种 ZIP，但读取方不能假设它们一样。`src/java.base/share/native/libzip/zip_util.c:1265`

这意味着：**如果你想知道条目数据正文到底从文件哪个偏移开始，最终还是得去看 LOCAL 头。**

### 既然终归要看 LOCAL，为什么不在打开时一次看完

答案也直接写在同一段注释里：延迟去读 LOCAL，是为了避免在初始化 `jzentry` 对象时触碰包含 LOCAL 头的虚拟内存页；在慢文件系统上，这样能让 `javac` 快一个数量级。`src/java.base/share/native/libzip/zip_util.c:1271`

这就是 `entry->pos` 初始为什么故意存成负数的原因。它一开始不是“已经算好的数据偏移”，而是“LOCAL 头位置的负编码”。只有第一次真正调用 `ZIP_GetEntryDataOffset` 时，才：

- 读出 LOCAL 头；
- 校验 `LOCSIG`；
- 再用 `LOCHDR + LOCNAM + LOCEXT` 算出真正数据偏移；
- 把 `entry->pos` 改成正数。`src/java.base/share/native/libzip/zip_util.c:1265`

所以这一步的精髓不在于负号这个小技巧本身，而在于它把“**查到条目**”和“**真的触碰该条目的正文位置**”明确拆成了两个阶段。

这条惰性边界，是整篇最重要的设计感之一。

## 解压阶段：为什么查找和解压要故意分开

到这里才轮到真正的数据读取和解压。

`ZIP_Read` 负责按偏移把压缩或未压缩的原始数据读出来。它先通过 `ZIP_GetEntryDataOffset` 算出正文起点，再做范围检查和 `readFullyAt`。`src/java.base/share/native/libzip/zip_util.c:1300`

而真正的解压则留给 `InflateFully`。`src/java.base/share/native/libzip/zip_util.c:1365`

### STORED 和 DEFLATED 为什么明确分流

在 `jzentry`/libzip 这一层，未压缩条目和压缩条目已经被区别对待：当前实现用 `csize == 0` 作为“未压缩条目”的内部约定；否则就还得走 zlib 解压路径。这个约定来自 `newEntry` 生成 `jzentry` 时对 `STORED`/`DEFLATED` 的折算，不该直接外推成 ZIP 格式层本身就这样编码。

这说明 `libzip` 从设计上就没把“找到条目”和“把内容展开”混成一件事，而是把它们分成：

- 目录查找；
- LOCAL 校验与数据定位；
- 原始字节读取；
- 必要时再解压。

这样做的好处很直接：并不是每次条目访问都一定要把压缩流解出来；一些场景只需要元信息、名字、尺寸或目录项本身。把阶段拆开，才能把成本延迟到真正需要的那一刻。

### `inflateInit2(&strm, -MAX_WBITS)` 想说明什么

`InflateFully` 里那句 `inflateInit2(&strm, -MAX_WBITS)` 很容易被当成“zlib 用法细节”一眼略过。其实它很值得提一下，因为它告诉我们 `libzip` 在这里读的不是带 zlib/gzip 包装头的通用压缩流，而是 ZIP 条目里的 raw deflate 数据。`src/java.base/share/native/libzip/zip_util.c:1380`

这恰好再次提醒我们：JAR 读取路径并不是“交给某个高层压缩库自动帮我理解一切”，而是一条清清楚楚按 ZIP 规范各层边界手动推进的原生管道。

所以这一节最该记住的一句话是：**打开不是解压，查到条目也不是已经读出内容；真正触碰压缩流是最后一步。**

## 到这里为止，主线其实只发生了四件事

如果前面信息有点多，这里先立一个路标，把整件事压回四步：

1. 打开 JAR 时先从尾部拿到 Central Directory，把整包目录读出来；
2. 用 `entries[] + table[]` 建立“名字哈希 → CEN 偏移”的查找索引；
3. 查找条目时先走缓存和哈希预筛，真正命中后再回 CEN 验证原名；
4. 读取正文时再惰性碰 LOCAL 头，必要时才进入 deflate 解压。

只要这四步还在脑子里，`findEND`、`readCEN`、`ZIP_GetEntryDataOffset` 这些名字就不会再像一串散函数。

## 常见误解澄清

### 误解一：JVM 每次找类都顺序扫整个 JAR

不是。

真正的顺序扫描主要发生在首次打开时读取 CEN 建索引；后续按名字找类走的是缓存 + 哈希表 + CEN 原文验证，不会每次从 ZIP 开头线性扫一遍。`src/java.base/share/native/libzip/zip_util.c:568`、`src/java.base/share/native/libzip/zip_util.c:1163`

### 误解二：哈希命中就等于找到真实条目

不对。

哈希只是预筛。真正裁决仍然要回到 `newEntry` 读出的 CEN 名字，再做 `equals` 比较。碰撞只会多走几步链，不会直接误判。`src/java.base/share/native/libzip/zip_util.c:1192`

### 误解三：打开 JAR 时会把所有 LOCAL 头都读一遍

不会。

`ZIP_GetEntryDataOffset` 就是把这一步故意延迟到第一次真正读条目内容时才做，目的是减少无用页面触碰和慢文件系统上的打开成本。`src/java.base/share/native/libzip/zip_util.c:1265`

### 误解四：`jzentry cache` 缓存的是整个 ZIP 条目集合

不是。

它只是 `jzfile` 上“最近释放的那个 `jzentry`”的单条目缓存，用来给热点回头客一个便宜命中路径。`src/java.base/share/native/libzip/zip_util.h:230`、`src/java.base/share/native/libzip/zip_util.c:1133`

### 误解五：解压发生在打开或查找阶段

也不是。

打开阶段主要读目录区、建索引；查找阶段主要做名字定位与验证；真正触碰压缩流是在读取正文时，必要时才走 `InflateFully`。`src/java.base/share/native/libzip/zip_util.c:1365`

## 收网：libzip 的本质，是“先拿目录地图，再按需回找正文”

现在再回头看开头那个问题，答案已经能收成一张总图了。

```text
打开 JAR
  ZIP_Open_Generic
    ├─ 先查 zfiles cache
    └─ miss 后 readCEN
         ├─ findEND    : 从文件尾找 END
         ├─ 定位 CEN   : 得到目录区长度/偏移/条目数
         └─ 建索引     : entries[] + table[]

查找条目
  ZIP_GetEntry(name)
    ├─ 先看单条目 cache
    ├─ 哈希桶链预筛
    └─ 命中后 newEntry 读 CEN 验证真实名字

读取内容
  ZIP_GetEntryDataOffset
    └─ 第一次读才算 LOCAL 头后的真实数据偏移
  ZIP_Read / InflateFully
    ├─ STORED   -> 直读
    └─ DEFLATED -> 原始 deflate 流解压
```

把它再压成三句话：

- HotSpot 打开 JAR 时最先拿的不是正文，而是整包目录，也就是 Central Directory。
- 它在内存里常驻的不是完整条目对象，而是“哈希 + 链接 + CEN 偏移”这类最小查找索引。
- 真正的正文偏移和解压成本都会被推迟到最后一刻，只有命中条目时才支付。

所以 JVM 之所以愿意“为找一个类先去读 ZIP 尾巴”，不是因为它喜欢绕路。

恰恰相反，是因为它很清楚：**类查找是高频动作，正文读取是低频动作；目录索引值得提前建，LOCAL 头和数据流则应该尽量晚碰。** 这就是 libzip 在 JAR 场景下的核心优化哲学。

下一篇就顺着这条线继续往前走。JAR/ZIP 已经靠“尾部目录 + 哈希索引 + 按需解压”把通用压缩包做到了足够能用，但 JDK 自己运行所需的类并不满足于“足够能用”。它们要的是更像镜像、可预计算、甚至更适合内存映射的格式。为什么 JDK 9 之后要引入 jimage，而不是继续全靠 ZIP？下一篇展开。

> → [02-jimage.md](02-jimage.md)
