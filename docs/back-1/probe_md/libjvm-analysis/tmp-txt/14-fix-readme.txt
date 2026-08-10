Fix 3 review gaps in 14-zip-jimage/README.md (68/70).

## Gap 1: 04-Jar-Nesting spec — add specific source files
In §四 04 doc spec, replace "主要是 Java 层" with specific paths:
- java/net/JarURLConnection.java — runtime JAR URL handling
- jdk/nio/zipfs/ZipFileSystem.java — JDK 13+ zipfs provider
- Spring Boot's org.springframework.boot.loader.LaunchedURLClassLoader
- Spring Boot's org.springframework.boot.loader.jar.Handler

## Gap 2: Add ASCII on-disk byte layout diagrams
In §一, add visual byte layout:

ZIP:
```
[LOC header][filename][compressed data] ... entries
[CEN header][filename][metadata] ... directory entries
[END header][total entries][CEN offset]
```

jimage:
```
[Magic: 0xCAFEDADA][Version: 1.0]
[Redirect Table][Location Table][String Table][Resource Data]
Location Table entry: [offset:u8][uncompressed_size:u4][flags:u4]
```

## Gap 3: Timing table — distinguish SSD vs HDD
In §一 timing table, add SSD row:
- SSD: Central Directory read ~0.05ms
- HDD: Central Directory read ~0.2-0.5ms
- Cloud (AWS EBS gp3): ~0.1ms
