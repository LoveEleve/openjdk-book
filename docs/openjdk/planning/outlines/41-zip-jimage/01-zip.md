# 01. ZIP 文件读取 — Central Directory + hash lookup

> 🔴 Deep | ZIP 访问全管道
> 读者处境: `ClassLoader.getResourceAsStream("com/foo/Bar.class")` — 这个 class 文件是藏在 your-app.jar 里面的。JVM 怎么在几毫秒内从几 MB 的 JAR 中定位并读出 500 字节的 class？
>
> ⚠️ 写作期修正(2026-08-12, vol-02/41-zip-jimage/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"线性探测 h=(h+1)%total" 编造**: 真实是**链式哈希**(readCEN zip_util.c:742-744 `entries[i].next = table[hsh]; table[hsh] = i` 头插;ZIP_GetEntry :1163-1222 沿 next 链,先比 32 位 hash 再 newEntry 读 CEN 验证名字)+ **最近释放条目缓存**(zip->cache,zip_util.h:230 "we cache the most recently freed jzentry",ZIP_FreeEntry :1133-1146 延迟释放)+ **ZIP_Lock**(JVM_RawMonitorEnter,:62)锁
> - **"慢路径 ZIP_FindEntry 遍历 entries[] 线性扫描" 编造**: ZIP_FindEntry(:1430-1445)只是 ZIP_GetEntry 的包装(返回 size/nameLen)
> - **"if method==DEFLATED" 错**: 判据是 **csize==0 → STORED**(newEntry :1062 `csize = (CENHOW(cen)==STORED) ? 0 : CENSIZ(cen)`;ZIP_ReadEntry :1457-1478);DEFLATED 走 InflateFully(:1365-1428): inflateInit2(&strm,-MAX_WBITS) 原始 deflate + 4096 块 ZIP_Read + inflate(Z_PARTIAL_FLUSH)
> - **deflateInit2Wrapper(:1581)是压缩侧**,inflate 不走它(大纲把它放 Read 小节错)
> - **ZIP_Open_Generic(:772-788)有缓存层**: ZIP_Get_From_Cache(:798,zfiles 链表+lastModified+refs)→miss→ZIP_Put_In_Cache→readCEN(:895);findEND :329-386(END_MAXLEN=0xFFFF+ENDHDR :300,扫描上限);ENDTOT 是 2 字节(entries 超 65535 时 knownTotal 递归 readCEN :713)
> - hashN=31 多项式(:436-441,与 String.hashCode 同款);tablelen=(total/2)|1(:694 注释 "Odd -> fewer collisions")✓
> - ZIP_GetEntryDataOffset 惰性计算 ✓(:1265-1289,pos 负数编码 -(locpos+locoff) newEntry :1065,注释 "speeds up javac by a factor of 10")
> - 源码位置: **/data/workspace/jdk11u/src/java.base/share/native/libzip/zip_util.c**(JDK 侧非 hotspot,1658 行)

### 1. "ZIP_Open — parse Central Directory → hash table"

场景: `ClassLoader` 首次打开 `rt.jar` 或 `your-app.jar` — ZIP_Open 解析 ZIP Central Directory→建立 hash table → O(1) per-entry 查找。

**ZIP_Open 流程** (`zip_util.c:772-800 + 568-650`):
```
ZIP_Open_Generic("rt.jar", &msg, O_RDONLY, 0) (zip_util.c:772)
  → readFullyAt(fd, endbuf, ENDHDR, len-ENDHDR) — 读 ZIP End Header(最后22字节)
  → findEND → 定位 CEN offset — Central Directory 在文件末尾区域
  → readCENHeader(zip, cenpos, bufsize) (zip_util.c:966-985) — 读 CEN 头部
  → readCEN(zip, knownTotal) (zip_util.c:568-700) — 遍历全部 CEN entries:
      逐 entry: 读 CENSIZE→CENHDR→CENNAM(文件名)→CENEXT(扩展)→CENCOM(注释)
      tablelen = (total/2) | 1 — hash table 大小为 entry 数的一半，强制奇数
      分配 entries[] 和 table[]，遍历 CEN 逐 entry 插入 hash table
[C++: zip_util.c 1658行——纯C实现, ZIP CEN(Central Directory) 是 ZIP 格式核心数据结构]
```
- 源码: `zip_util.c:772-800` (ZIP_Open_Generic) + `zip_util.c:568-650` (readCEN hash table 建立)

- 关键设计: ZIP 格式的 **Central Directory 放在文件末尾**——不是文件头。这是 ZIP 的设计精髓: zip 文件可以在尾部追加 entry 而不需要重写整个文件。`findEND` 从末尾向后扫描 0xFFFF 字节找 `PK\005\006`(END header signature)→读出 CEN offset→seek 到 CEN 位置→解析所有 entry。**hash table 大小 = total/2 | 1**(`zip_util.c:694`)——减半后强制奇数以减少 hash 碰撞(odd-sized 表避免与 2^n 模产生周期性冲突)。

### 2. "ZIP_GetEntry — hash → CEN → jzentry"

场景: `ClassLoader.findClass("com.foo.Bar")` → 转换为路径 `com/foo/Bar.class` → ZIP_GetEntry 在 hash table 中查找。

**Hash lookup** (`zip_util.c:1163-1260`):
```
ZIP_GetEntry(zip, "com/foo/Bar.class") (zip_util.c:1163)
  → hash(name) % total → h = hash_index
  → while (zip->entries[h].name != NULL):
      if strcmp(zip->entries[h].name, name) == 0 → return &zip->entries[h]
      else: h = (h + 1) % total  // linear probing
  → 未找到 → 返回 NULL(goto 慢路径:ZIP_FindEntry → 扫描 CEN 原始数组)
```
- 源码: `zip_util.c:1163-1220` (ZIP_GetEntry hash lookup) + `zip_util.c:1430-1445` (ZIP_FindEntry 慢路径)

- 关键设计: 双层查找——**快路径**(hash table O(1), 直接定位到 jzentry 的 entries[] 索引) → **慢路径**(hash 表未初始化(totabl=0)或 hash 冲突溢出时走 ZIP_FindEntry → 遍历完整的 entries[] 数组线性扫描)。hash table 只有在 `readCEN` 成功后才建立——如果 CEN 未完整解析则不建 hash 表。

### 3. "ZIP_ReadEntry — seek → inflate → return bytes"

场景: ZIP_GetEntry 找到 entry→ClassLoader 调用 ZIP_ReadEntry 读取实际字节码。压缩的 class 文件需要 inflate 解压。

**Read + inflate** (`zip_util.c:1447-1580`):
```
ZIP_ReadEntry(zip, entry, buf, entryname) (zip_util.c:1447)
  → readFullyAt(zfd, buf, size, entry->data_offset) // seek to entry data
  → if entry->method == DEFLATED:
      z_stream strm; inflateInit2(&strm, -MAX_WBITS)
      inflate(&strm, Z_FINISH) // 解压到 buf
      inflateEnd(&strm)
  → return raw bytes
```
- 源码: `zip_util.c:1447-1530` (ZIP_ReadEntry → seek + inflate) + `zip_util.c:1581-1600` (deflateInit2Wrapper)

- 关键设计: entry 的 **实际 data offset 是惰性计算的**(`zip_util.c:1276-1288` ZIP_GetEntryDataOffset)。entry->pos 初始存负值 `-(locpos + locoff)`——指向 Local File Header 位置。首次 ZIP_Read 时调用 ZIP_GetEntryDataOffset: `readFullyAt(fd, loc, LOCHDR, -(entry->pos))` 读 LOCHDR→解析 LOCNAM(文件名长度)+LOCEXT(扩展字段长度)→计算 `entry->pos = (-entry->pos) + LOCHDR + LOCNAM(loc) + LOCEXT(loc)` 转为正的 data offset。这是 **惰性求值优化**——避免了打开 ZIP 文件时触摸所有 LOC header 的虚拟内存页(注释称"提速 javac 10 倍于慢文件系统")。ZIP 支持两种压缩方法: `entry->csize==0`→STORED(直接读) vs `entry->csize>0`→DEFLATED(`InflateFully` at `zip_util.c:1365-1403` 逐块读→`inflateInit2(&strm, -MAX_WBITS)` 原始 deflate 模式, 无zlib/gzip header)。

---

### 核心悬念

**"ZIP_Open 解析 Central Directory→pair name→offset 建立 hash table(ZIP_GetEntry O(1) find)→ZIP_ReadEntry seek data_offset→if DEFLATED→inflate→return raw class bytes。"** — 下一篇: JIMAGE——JDK 专用 class 镜像，mmap→Minimal Perfect Hashing→零拷贝解压。

> → [02-jimage.md](02-jimage.md)
