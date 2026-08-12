# 01. ZIP 文件读取 — JAR 里的类怎么被找到

> **前置依赖**:[38-perfdata/01 — PerfData 架构](openjdk/vol-02/38-perfdata/01-perfdata.md):观测通道收官后进入"输入"侧——JVM 读类文件的第一站;vol-tools 已演示 javap 读 JAR 里的类
> → **后续**:[02 — jimage](02-jimage.md)(JDK 自己的镜像格式)
> 关联域: 07-classfile-classloader(类加载器消费 ZIP 入口)、43-nio-net(JAR 协议)、12-ci(编译前的字节码来源)

## 几毫秒从 JAR 里捞出一个类

`ClassLoader.findClass("com.foo.Bar")` 要在 your-app.jar 里定位 `com/foo/Bar.class` 并读出字节码。JAR 就是 ZIP: 文件名到数据位置的映射关系集中在文件**末尾**的 Central Directory(目录区)里。JVM 侧负责读 ZIP 的是原生库 libzip 的 `zip_util.c`(纯 C,1658 行)——打开时解析目录区、建立哈希表,查找时 O(1) 命中,读取时按需解压。这篇拆开这条管道: 打开建表(ZIP_Open → readCEN)、哈希查找(ZIP_GetEntry)、惰性定位与解压(ZIP_ReadEntry)。

## 1. 打开: 目录在文件末尾,哈希表在内存里

### ZIP_Open_Generic: 先查缓存

打开 ZIP 的第一步是查缓存(`ZIP_Open_Generic`,zip_util.c:772-788): 已打开的 `jzfile` 挂在全局链表 `zfiles` 上,按文件名 + `lastModified` + 引用计数判断能否复用(`ZIP_Get_From_Cache`,:798-833)——同一个 JAR 被多个类加载器/多次访问时,目录区只解析一次。缓存 miss 才真正打开文件,进入 `ZIP_Put_In_Cache` → `readCEN`(:895)。

### findEND: 从尾巴往前找目录

ZIP 的目录区(END + CEN)在文件**末尾**——这是 ZIP 的设计精髓: 可以在尾部追加条目而不重写整个文件。`findEND`(zip_util.c:329-386)从末尾分块倒着扫,找 END 头的签名 `PK\005\006`(扫描上限 `END_MAXLEN = 0xFFFF + ENDHDR`,:300);找到 END 头后读出三个关键值——CEN 的总长/偏移/条目数(`ENDSIZ/ENDOFF/ENDTOT`),就能定位到 Central Directory。

### readCEN: 遍历目录区,建链式哈希表

`readCEN`(zip_util.c:568 起)从 END 给出的偏移读整段 CEN,逐条解析(每条 = 固定头 CENHDR + 名字 + 扩展 + 注释)。解析结果进两个结构(:692-744,截取核心,逐字):

```cpp
// zip_util.c:692-744(截取核心,逐字)
    total = (knownTotal != -1) ? knownTotal : total;
    entries  = zip->entries  = calloc(total, sizeof(entries[0]));
    tablelen = zip->tablelen = ((total/2) | 1); // Odd -> fewer collisions
    table    = zip->table    = malloc(tablelen * sizeof(table[0]));
    ...
    for (j = 0; j < tablelen; j++)
        table[j] = ZIP_ENDCHAIN;
    ...
        /* Record the CEN offset and the name hash in our hash cell. */
        entries[i].cenpos = cenpos + (cp - cenbuf);
        entries[i].hash = hashN((char *)cp+CENHDR, nlen);

        /* Add the entry to the hash table */
        hsh = entries[i].hash % tablelen;
        entries[i].next = table[hsh];
        table[hsh] = i;
```

- `entries[]` 是**扁平数组**,每个单元只存两样东西: `cenpos`(该条目在 CEN 里的偏移,读到文件里再按需解析)和 `hash`(名字的 32 位哈希);
- `table[]` 是哈希桶数组,`tablelen = (total/2) | 1`——**条目数的一半再强制奇数**(注释原文 "Odd -> fewer collisions"): 一半的负载因子留足冲突余量,奇数避免与 2 的幂取模产生周期性聚集;
- 冲突用**链式**(separate chaining): 新条目头插进桶的链表(`entries[i].next = table[hsh]; table[hsh] = i`)——注意没有存名字!真正的名字比对发生在查找时按 `cenpos` 现读 CEN 验证。哈希函数是 31 多项式(`hashN`,zip_util.c:436-441,`h = 31*h + *s++`)——和 Java `String.hashCode` 同款。

**关键设计 (斜体)**: *哈希表只存"偏移 + 哈希"不存名字,是"空间换延迟"的权衡: 打开时只需遍历目录区一遍,O(1) 内存装下全部条目;名字的完整内容(可能几 KB)留到命中时再按需从文件读。目录区是 ZIP 的"地图",哈希表是这张地图的索引。*

## 2. 查找: 链式哈希 + 单条目缓存

`ZIP_GetEntry`(zip_util.c:1163-1215)是热路径,有三个加速层次(截取核心):

```cpp
// zip_util.c:1163-1222(截取核心,省略尾段)
ZIP_GetEntry(jzfile *zip, const char *name)
{
    // length of the entry name being searched for
    const jint name_len =  (jint) strlen(name);
    const unsigned int hsh = hashN(name, name_len);
    jint idx;
    jzentry *ze = 0;

    ZIP_Lock(zip);
    if (zip->total == 0) {
        goto Finally;
    }

    idx = zip->table[hsh % zip->tablelen];

    /* Check the cached entry first */
    ze = zip->cache;
    if (ze && equals(ze->name, ze->nlen, name, name_len)) {
        /* Cache hit!  Remove and return the cached entry. */
        zip->cache = 0;
        ZIP_Unlock(zip);
        return ze;
    }
    ze = 0;

    /*
     * Search down the target hash chain for a cell whose
     * 32 bit hash matches the hashed name.
     */
    while (idx != ZIP_ENDCHAIN) {
        jzcell *zc = &zip->entries[idx];

        if (zc->hash == hsh) {
            /*
             * OK, we've found a ZIP entry whose 32 bit hashcode
             * matches the name we're looking for.  Try to read
             * its entry information from the CEN.  If the CEN
             * name matches the name we're looking for, we're
             * done.
             */
            ze = newEntry(zip, zc, ACCESS_RANDOM);
            if (ze && equals(ze->name, ze->nlen, name, name_len)) {
                break;
            }
            ...
        }
        idx = zc->next;
    }
Finally:
    ZIP_Unlock(zip);
    return ze;
}
```

- **① 单条目缓存**: `zip->cache` 存着**最近释放的条目**——`ZIP_FreeEntry` 把释放的条目放进缓存、真正 free 掉上一个(zip_util.c:1133-1146,zip_util.h:230 注释原文 "we cache the most recently freed jzentry")。查找时先检查缓存,命中就免去一次 `newEntry`(重新读 CEN + 分配);
- **② 链式哈希**: 沿 `table[hsh % tablelen]` 的 next 链走,先比 32 位 `hash`(廉价筛掉绝大多数),命中 hash 后 `newEntry` 按 `cenpos` **现读 CEN 段**、解析出完整名字再 `equals` 验证——哈希碰撞但名字不同时继续沿链走;
- **③ 锁**: 全程在 `ZIP_Lock`(JVM 原生监视器,zip_util.c:62)保护下——多个线程共享同一个 jzfile 时查找与缓存替换互斥。

**关键设计 (斜体)**: *查名字的"最终裁决"是读文件里的 CEN 原文,哈希只是预筛——这保证了正确性不依赖哈希的质量(哈希错了最多多走几步,不会误判);单条目缓存则把"同一类反复加载"的常见模式降到零 CEN 解析成本。*

## 3. 读取: 惰性定位 + 按需解压

### 数据偏移: 打开时不碰,第一次读才算

找到条目后,数据在文件哪里?ZIP 规范允许 LOCAL 头的扩展字段长度与 CEN 里的记录不同,所以数据偏移**不能信 CEN,必须读 LOCAL 头才能确定**。这个计算被推迟到第一次读(`ZIP_GetEntryDataOffset`,zip_util.c:1265-1289,截取核心):

```cpp
// zip_util.c:1265-1289(截取核心,逐字)
ZIP_GetEntryDataOffset(jzfile *zip, jzentry *entry)
{
    /* The Zip file spec explicitly allows the LOC extra data size to
     * be different from the CEN extra data size, although the JDK
     * never creates such zip files.  Since we cannot trust the CEN
     * extra data size, we need to read the LOC to determine the entry
     * data offset.  We do this lazily to avoid touching the virtual
     * memory page containing the LOC when initializing jzentry
     * objects.  (This speeds up javac by a factor of 10 when the JDK
     * is installed on a very slow filesystem.)
     */
    if (entry->pos <= 0) {
        unsigned char loc[LOCHDR];
        if (readFullyAt(zip->zfd, loc, LOCHDR, -(entry->pos)) == -1) {
            zip->msg = "error reading zip file";
            return -1;
        }
        ...
        entry->pos = (- entry->pos) + LOCHDR + LOCNAM(loc) + LOCEXT(loc);
    }
    return entry->pos;
}
```

`entry->pos` 初始是**负数**: `-(zip->locpos + locoff)`(newEntry,zip_util.c:1065)——LOC 头的文件位置取负存起来。第一次读时读出 LOCAL 头,加上 `LOCHDR + LOCNAM + LOCEXT` 变成正的数据偏移。注释点明了动机(原文 "We do this lazily to avoid touching the virtual memory page containing the LOC... This speeds up javac by a factor of 10 when the JDK is installed on a very slow filesystem")——**打开 JAR 时不读任何 LOCAL 头**,几百个条目的 JAR 就少碰几百个内存页。

### 读取与解压: STORED 直读,DEFLATED 逐块 inflate

`ZIP_ReadEntry`(zip_util.c:1447-1490)按压缩方式分流——判据是 **`csize == 0` 即 STORED**(newEntry 里 `csize = (CENHOW(cen) == STORED) ? 0 : CENSIZ(cen)`,:1062):

- **STORED**(未压缩): 分块 `ZIP_Read` 直读,不做任何处理;
- **DEFLATED**(压缩): `InflateFully`(zip_util.c:1365-1428)——`inflateInit2(&strm, -MAX_WBITS)` 用**原始 deflate 模式**(负窗口位 = 不要 zlib/gzip 头),然后循环: 4096 字节一块 `ZIP_Read` 压缩数据 → `inflate(&strm, Z_PARTIAL_FLUSH)` 解压进输出缓冲,直到流结束且输出长度等于 `entry->size`。

**关键设计 (斜体)**: *整条管道的"惰性"贯穿始终: 打开只解析目录索引,查找只信哈希预筛、命中才读 CEN,数据偏移到第一次读才算,LOCAL 头到解压前才碰——每一步都推迟到真正需要的那一刻。JAR 可能几 MB、几百个条目,但打开一个类只付出"哈希命中 + 一次 CEN 读 + 一次 LOCAL 读 + 解压"的代价。*

## 核心悬念

ZIP 管道到齐: 打开时 findEND 定位末尾目录区、readCEN 建"偏移+哈希"的链式哈希表;查找时单条目缓存 + 哈希预筛 + CEN 现读验证;读取时负数编码的惰性数据偏移、STORED 直读 / DEFLATED 原始流解压。但 JDK 自己运行所需的类不在 JAR 里——JDK 9 起用的是自己的镜像格式 jimage: 目录是**预计算的最小完美哈希**,文件可以 mmap,连解压都可以跳过。为什么 JDK 不直接用 ZIP?——下一篇: jimage——JDK 的镜像格式。

> → [02-jimage.md](02-jimage.md)
