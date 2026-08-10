# 域 41: ZIP & JIMAGE — 知识规划

> 源码: libzip/ + libjimage/ | 17文件/~5400行(不含第三方zlib) | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| libzip/zip_util.c (1658行) | **ZIP 文件读入**: ZIP_Open/ZIP_GetEntry/ZIP_ReadEntry, 支持 compressed/deflated, 随机访问 per-entry, class loading 数据源 | High |
| libjimage/imageFile.cpp | **JIMAGE 格式**: java.base 模块预编译镜像, ImageFileReader(find_class/read_resource), 直接内存映射(mmap)访问, 快速 class lookup | High |
| libjimage/imageDecompressor.cpp | **JIMAGE 解压**: preloaded class data 可选压缩 | Medium |
| libzip/zlib/ (第三方, 不计) | zlib 压缩库 | — |

## 02 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | ZIP 文件读取 | "一个 JAR 文件怎么被 ZIP_GetEntry 访问？class loading 怎么从中提取字节码？" |
| 2 | JIMAGE 模块镜像 | "java.base 模块的 classes 怎么从 .jimage 文件中高速读取？" |
