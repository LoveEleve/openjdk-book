# 为什么 Redis 不直接用 C 字符串，要自己造一个 SDS

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第二篇，回答 SDS 为什么不用 C 字符串，以及 5 种 header 如何做内存分级。

## 为什么"SDS 就是带了长度的 char *"这个理解会把 SDS 读浅

很多人第一次看 SDS 源码，觉得它就是一个"带了 len 字段的 char *"：

```c
struct sdshdr8 {
    uint8_t len;
    uint8_t alloc;
    unsigned char flags;
    char buf[];
};
```

这当然不是错，但这样理解，就没看到 SDS 真正的设计精髓：**SDS 不是"更聪明的 char *"，而是"带 header 的连续内存块"。** `sds` 本身就是一个 `char *`，指向 `buf[]`，但 `buf` 前面紧贴着一个 header 结构体。`__packed__` 属性取消编译器的对齐填充，让 header 和 buf 在内存中连续排列，没有任何空隙。

也就是说，SDS 不是"char * 加长度"，而是 **"header + buf" 在同一次 malloc 分配的内存块里**。

## 一、SDS 的内存布局：`sds = char *` 指向 buf

关键代码在：

- `src/sds.h:20` `typedef char *sds;`

SDS 的 `sds` 类型就是 `char *`。它指向 `buf[]` 的第一个字符。那么 `len`、`alloc`、`flags` 存在哪里？

答案在 `SDS_HDR` 宏：

- `src/sds.h:61` `#define SDS_HDR(T,s) ((struct sdshdr##T *)((s)-(sizeof(struct sdshdr##T))))`

这个宏把 `sds` 指针（`char *`）**向后**减去 header 的大小，得到 header 结构体的起始地址。也就是说，`sds` 指针指向的是 `buf[]`，但 `buf` 前面紧跟着 `sdshdr8`（或对应的 header）。

```text
低地址                    高地址
+----------+---+---+---+-------+
| sdshdrN  |len|alc|fg|  buf  |
|          |   |   |  |  ...  |
+----------+---+---+---+-------+
^                        ^
|                        |
sh (sdshdrN*)           s (char*) = sds
```

## 二、5 种 sdshdr：内存分级

关键代码在：

- `src/sds.h:24`-`:47` sdshdr5/8/16/32/64 结构体
- `src/sds.h:53`-`:57` SDS_TYPE_5/8/16/32/64

```c
struct sdshdr5 {
    unsigned char flags; /* 3 lsb of type, 5 msb of string length */
    char buf[];
};
struct sdshdr8 {
    uint8_t len;         /* used */
    uint8_t alloc;       /* excluding the header and null terminator */
    unsigned char flags; /* 3 lsb of type, 5 unused bits */
    char buf[];
};
struct sdshdr16 { uint16_t len; uint16_t alloc; unsigned char flags; char buf[]; };
struct sdshdr32 { uint32_t len; uint32_t alloc; unsigned char flags; char buf[]; };
struct sdshdr64 { uint64_t len; uint64_t alloc; unsigned char flags; char buf[]; };
```

5 种 header 覆盖的字符串长度范围：

| header | len 类型 | 最大长度 | header 大小 | 用途 |
|--------|---------|---------|:----------:|------|
| sdshdr5 | 5 bit | 31 | 1 字节 | 只读，不用于追加 |
| sdshdr8 | uint8_t | 255 | 3 字节 | 小字符串 |
| sdshdr16 | uint16_t | 64K | 5 字节 | 中字符串 |
| sdshdr32 | uint32_t | 4G | 9 字节 | 大字符串 |
| sdshdr64 | uint64_t | 2^64 | 17 字节 | 极大字符串 |

`sdshdr5` 和其他的不同——它没有 `len` 和 `alloc` 字段，只有 `flags`。长度编码在 `flags` 的高 5 位中，`SDS_TYPE_5_LEN(f) = (f) >> SDS_TYPE_BITS`（`src/sds.h:62`）。这意味着它无法记录剩余空间，所以 `_sdsMakeRoomFor()` 中 `if (type == SDS_TYPE_5) type = SDS_TYPE_8`（`src/sds.c:244`）。

## 三、`sdsReqType()`：创建时选择 header

关键代码在 `src/sds.c` 的 `sdsReqType()`（约 14 行 inline 函数）：

```c
static inline char sdsReqType(size_t string_size) {
    if (string_size < 1<<5)   return SDS_TYPE_5;
    if (string_size < 1<<8)   return SDS_TYPE_8;
    if (string_size < 1<<16)  return SDS_TYPE_16;
    if (string_size < 1ll<<32) return SDS_TYPE_32;
    return SDS_TYPE_64;
}
```

创建入口 `_sdsnewlen()`（`src/sds.c:81`）调用它。但注意：`_sdsnewlen` 中有一个特殊处理——空字符串（`initlen = 0`）会被强制提升到 `sdshdr8`，因为空字符串通常是为了后续追加，`sdshdr5` 不适合追加。

## 四、`__packed__`：取消对齐，连续内存

`struct __attribute__ ((__packed__))` 告诉编译器不要对结构体字段做对齐填充。如果没有 `__packed__`，`sdshdr8` 的 `uint8_t len` 和 `uint8_t alloc` 后面可能会被补上空字节。

`SDS_HDR_VAR` 宏（`src/sds.h:60`）用类型名拼接从 `sds` 反推 header 指针：

```c
#define SDS_HDR_VAR(T,s) struct sdshdr##T *sh = (void*)((s)-(sizeof(struct sdshdr##T)));
```

`sizeof(struct sdshdr8)` 在 `__packed__` 下 = 3 字节（1+1+1），没有对齐填充。`sds` 指针减去 3，精确得到 header 的起始地址。

## 五、`sdshdr5` 的陷阱：追加即升级

`sdshdr5` 只有 `flags` 字段，没有 `alloc`。这意味着 `sdsavail()` 无法知道还有多少空余空间。所以 `_sdsMakeRoomFor()` 中一旦发现类型是 `SDS_TYPE_5`，立即提升到 `SDS_TYPE_8`：

```c
if (type == SDS_TYPE_5) type = SDS_TYPE_8;
```

升级后，原来的 `sdshdr5` 内存被释放，新的 `sdshdr8` 被分配。这就是为什么 `sdsReqType` 在创建时允许 `SDS_TYPE_5`，但 `_sdsMakeRoomFor` 会把它升级。

## 六、预分配策略：`_sdsMakeRoomFor()`

关键代码在 `src/sds.c:217`-`260`：

```c
sds _sdsMakeRoomFor(sds s, size_t addlen, int greedy) {
    size_t avail = sdsavail(s);
    if (avail >= addlen) return s;  /* 空间够，直接返回 */

    len = sdslen(s);
    newlen = len + addlen;
    if (greedy == 1) {
        if (newlen < SDS_MAX_PREALLOC)  /* 1MB */
            newlen *= 2;                /* 翻倍 */
        else
            newlen += SDS_MAX_PREALLOC; /* 加 1MB */
    }
    // 然后根据 newlen 重新计算 type，分配或 realloc 内存
}
```

`SDS_MAX_PREALLOC` 定义在 `src/sds.h:13`，值为 `1024*1024`（1MB）。

预分配策略解决了什么问题？如果没有预分配，每次 `sdscat` 都要 `realloc`，O(n^2)。有了预分配，N 次追加的均摊复杂度降到 O(1)。

## 七、二进制安全：`sdscatlen()`

关键代码在 `src/sds.c:463`-`469`：

```c
sds sdscatlen(sds s, const void *t, size_t len) {
    size_t curlen = sdslen(s);
    s = sdsMakeRoomFor(s, len);
    memcpy(s + curlen, t, len);
    sdssetlen(s, curlen + len);
    s[curlen + len] = '\0';  /* 保留 \0 结尾，兼容 C 函数 */
    return s;
}
```

`memcpy` 的 `len` 是显式传入的，不依赖 `\0` 作为结束符。所以 SDS 可以存储任意二进制数据（包括中间有 `\0` 的）。最后的 `s[curlen + len] = '\0'` 只是为了兼容 C 函数（如 `printf`），不是语义边界。

## 八、扩容时的 header 升级

`_sdsMakeRoomFor()` 中，如果 `newlen` 增长后超出了当前 header 类型能表示的范围，`sdsReqType` 返回更大的 header 类型。此时有两种情况：

1. **同类型**（`oldtype == type`）：`s_realloc_usable` 在原地扩容，header 不变。
2. **不同类型**（`oldtype != type`）：`s_malloc_usable` 新分配 + `memcpy` 迁移数据 + `s_free` 旧内存，header 升级。

升级后 `s[-1] = type` 更新 flags 字段，`SDS_HDR` 宏在新的 header 类型下工作。

## 九、失败路径

### 1. OOM

`_sdsnewlen` 和 `_sdsMakeRoomFor` 中 `malloc`/`realloc` 返回 NULL 时，函数返回 NULL。调用方需要检查返回值。

### 2. size_t 溢出

`_sdsMakeRoomFor` 中 `assert(newlen > len)` 捕获 size_t 溢出。`newlen + 1` 也可能溢出，但 `assert(hdrlen + newlen + 1 > reqlen)` 确保不溢出。

### 3. header 类型漂移

`sdshdr5` 追加后升级到 `sdshdr8`。如果 `sdsReqType` 和 `_sdsMakeRoomFor` 中的类型判断不一致，可能导致 header 类型漂移。

## 到这里，R-4 真正立住的是"SDS 是带 header 的连续内存块"

如果只看表面，SDS 被读成"带了 len 的 char *"。

更稳的理解方式应该是：

1. `sds` 就是 `char *`，指向 `buf[]`，但 `buf` 前面紧贴着 header
2. 5 种 header 覆盖不同长度区间，`sdshdr5` 只有 1 字节，`sdshdr64` 有 17 字节
3. `__packed__` 取消对齐，确保 header 和 buf 连续排列
4. `sdshdr5` 不适用于追加，追加时自动升级到 `sdshdr8`
5. 预分配策略让 N 次追加的均摊复杂度降到 O(1)
6. SDS 是二进制安全的，长度由显式参数控制，不以 `\0` 为终点

## 下篇桥接

R-3 Dict 将展开另一种数据结构——哈希表的渐进式 rehash、SipHash、双表结构和扩容/缩容阈值。
