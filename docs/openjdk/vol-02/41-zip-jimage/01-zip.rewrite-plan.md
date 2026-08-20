# 41-zip-jimage/01-zip 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JVM 从 JAR 里找一个类时，为什么必须先从文件尾巴读完整个 Central Directory 并建立内存索引，而不是像普通文件那样顺着文件头一路扫；同时讲清 libzip 如何把“打开、查找、读取、解压”拆成递进惰性的几层

## 1. 选题判断

现稿已有较强事实基础：
- `findEND` / `readCEN`
- `entries[] + table[]` 链式哈希
- `ZIP_GetEntry` 的单条目缓存
- `ZIP_GetEntryDataOffset` 的惰性 `pos`
- `InflateFully` 与 `inflateInit2(-MAX_WBITS)`

但当前正文还是比较“打开 → 查找 → 读取”的源码顺序罗列。真正该打穿的读者困惑更集中：

**JAR 明明就是一堆文件拼在一起，JVM 为了找一个 `com/foo/Bar.class`，为什么不顺着 ZIP 头一路扫过去，而是先去文件尾巴找 END/CEN，再额外建一张哈希表？这是不是太重了？而且为什么连 LOCAL 头都不在打开时读完，还要拖到第一次真正读内容时再算数据偏移？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**libzip 读取 JAR 的核心不是“把 ZIP 文件顺序解析一遍”，而是先把文件尾部的 Central Directory 当成整包目录，打开时只做一次建表，之后所有类查找都变成“哈希命中目录项 → 按需验证名字 → 第一次读取时再碰 LOCAL 头和压缩流”。HotSpot 之所以愿意在打开时付出一次目录解析成本，是为了把后续海量 `findClass` 的代价压到接近 O(1)。**

## 3. 总图

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

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么找一个类要先去读文件尾巴

目标约 1200 字。

- 从 `ClassLoader.findClass("com.foo.Bar")` 切入
- 点出反直觉：不是从文件头扫，而是先去文件末尾找目录区
- 埋主线：JVM 不是按“顺序读压缩包”思路工作，而是先建一张包内地图

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. 每次查类都顺着 ZIP 顺序扫到目标条目
2. 打开时把每个条目的 LOCAL 头和数据偏移都一次性算完

结论：
- 第一种把 `findClass` 变成 O(n)
- 第二种把打开成本和页面触碰提前到根本用不到的条目上

### 第三节：打开阶段——为什么 END/CEN 在尾部反而更适合做目录

目标约 2200 字。

- `findEND` 逆向扫描 `PK\005\006`
- END 给出 CEN 长度/偏移/总数
- `readCEN` 只读目录区，不碰数据区
- 说明 ZIP 的“目录在尾部”如何让追加和索引分离成为可能

### 第四节：建表——为什么内存索引只存 `hash + next + cenpos`

目标约 2200 字。

- `entries[]`、`table[]`
- `tablelen = (total/2) | 1`
- 不存完整名字，只存 CEN 偏移和 hash
- 解释“目录区是地图，哈希表是地图索引”
- 路标：记住打开时建的是‘查找索引’，不是把所有 entry 对象都实例化

### 第五节：查找阶段——为什么要三层命中链路

目标约 1900 字。

- `ZIP_GetEntry`
- 最近释放条目的单缓存
- 哈希桶链预筛 + `newEntry` 读 CEN 验名
- 锁的作用边界
- 强调哈希不是裁决，CEN 原文才是最终裁决

### 第六节：读取阶段——为什么连数据偏移都要惰性计算

目标约 2200 字。

- `entry->pos` 初始为负的 LOC 位置
- `ZIP_GetEntryDataOffset` 第一次读才去看 LOCAL 头
- `This speeds up javac by a factor of 10...` 那段注释
- 解释“惰性”不是偷懒，而是避免无用页面触碰

### 第七节：解压阶段——为什么 libzip 把 STORED 和 DEFLATED 明确分流

目标约 1700 字。

- `ZIP_Read` 直读
- `InflateFully`
- `inflateInit2(&strm, -MAX_WBITS)` 的 raw deflate 语义
- 说明查找和解压是两个阶段，不要混成“打开 JAR 就顺手解压”

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. JVM 是否每次找类都顺序扫整个 JAR
2. 哈希命中是否就等于找到真实条目
3. 打开 JAR 时是否会把所有 LOCAL 头都读一遍
4. `jzentry cache` 是否缓存整个 ZIP 条目集合
5. 解压是否发生在打开或查找阶段

## 5. 失败方案必须写进正文

1. 每次查类都顺序扫 ZIP 全文件
2. 打开时就把每个 entry 的 LOCAL 头和数据偏移一次性算完
3. 把哈希命中误解成最终裁决，而不是 CEN 原文验证前的预筛

## 6. 证据清单

- `src/java.base/share/native/libzip/zip_util.c:329`：`findEND`
- `src/java.base/share/native/libzip/zip_util.c:436`：`hashN`
- `src/java.base/share/native/libzip/zip_util.c:568`：`readCEN`
- `src/java.base/share/native/libzip/zip_util.c:694`：`tablelen = ((total/2) | 1)`
- `src/java.base/share/native/libzip/zip_util.c:737`：记录 `cenpos` 与 `hash`
- `src/java.base/share/native/libzip/zip_util.c:772`：`ZIP_Open_Generic`
- `src/java.base/share/native/libzip/zip_util.c:798`：`ZIP_Get_From_Cache`
- `src/java.base/share/native/libzip/zip_util.c:844`：`ZIP_Put_In_Cache`
- `src/java.base/share/native/libzip/zip_util.c:1133`：`ZIP_FreeEntry`
- `src/java.base/share/native/libzip/zip_util.c:1163`：`ZIP_GetEntry`
- `src/java.base/share/native/libzip/zip_util.c:1265`：`ZIP_GetEntryDataOffset`
- `src/java.base/share/native/libzip/zip_util.c:1271`：延迟读取 LOCAL 头的性能注释
- `src/java.base/share/native/libzip/zip_util.c:1300`：`ZIP_Read`
- `src/java.base/share/native/libzip/zip_util.c:1365`：`InflateFully`
- `src/java.base/share/native/libzip/zip_util.c:1380`：`inflateInit2(&strm, -MAX_WBITS)`
- `src/java.base/share/native/libzip/zip_util.h:225`：`entries / table / cache`
- `src/java.base/share/native/libzip/zip_util.h:242`：`ZIP_ENDCHAIN`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / libzip / Linux / x86_64`
- 本篇聚焦 JAR/ZIP 的原生读取路径，不展开 URLClassPath 与 Java 层 JarFile 细节
- `USE_MMAP` 只在必要处点到，不深挖全量 mmap 策略演变
- 不把 ZIP64 全展开，只在 readCEN 中点“支持但有边界”
- 下一篇如果切到 jimage，要把 ZIP 和 jimage 的设计差异钩出来

## 8. 完成后 review

- 删除代码后，能否复述“打开时先建目录索引，读取时再惰性碰 LOCAL 和数据流”
- 是否清楚区分打开、查找、读取、解压四个阶段
- 是否至少完整推演了两个失败方案，而不是直接顺源码罗列函数
- 是否把哈希预筛 vs CEN 原文验证的边界讲清楚
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
