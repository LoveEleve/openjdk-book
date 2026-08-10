# 01. ZIP 文件读取

> 读者处境: `ClassLoader.getResourceAsStream("foo.properties")` → 底层 ZIP_GetEntry→ZIP_ReadEntry→解压→返回 bytes。

**ZIP 访问** (`libzip/zip_util.c:50-800`):
```
ZIP_Open("app.jar") → parse ZIP central directory
ZIP_GetEntry("foo.properties") → locate entry offset
ZIP_ReadEntry(entry, buf) → if compressed→inflate→return raw bytes
```
- 源码: `libzip/zip_util.c:50-800`

---

### 核心悬念

**"ZIP_GetEntry 用 Central Directory 实现 O(1) random access per entry。"** — 下一篇: JIMAGE。

> → [02-jimage.md](02-jimage.md)
