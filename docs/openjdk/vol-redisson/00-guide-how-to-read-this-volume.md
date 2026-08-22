# 先读这一篇：怎样阅读这卷 Redisson 源码分析

> 本文是卷级导读，回答这卷到底在讲什么、为什么这样排。

## 这卷不是 API 手册

这卷真正要建立的是 **从 Config 配置到分布式锁的完整客户端实现主线**。7 篇正文按"核心 → 扩展"组织。

## 推荐阅读路线

1. **R-1 连接管理**：先理解 `Redisson.create(config)` 四层初始化链路
2. **R-4 命令执行**：理解 CommandAsyncService 怎么发送 RESP 命令
3. **R-2 RLock**：最常用功能——分布式锁的 Lua 加锁 + Watchdog 续期
4. **R-3 Codec**：理解数据怎么序列化
5. **R-5 RMap**：分布式映射 + 近缓存 + 回写数据库
6. **R-6 Spring Cache**：@Cacheable 的 Redisson 实现
7. **R-7 基础数据结构**：RBucket / RAtomicLong / RSemaphore

## 每篇的结构

每篇包含四个文件：rewrite-plan（规划）、正文 .md（分析）、note（主张+边界+桥接）、review-notes（六层审查）。

## 如果你想快速了解

只读每篇的 `.note.md`。

## 如果你想深入源码

读每篇正文 `.md`，含完整锚点引用。

## 本卷在体系中的位置

本卷是 Java 客户端框架，与 vol-redis（服务器内部实现）互补。RLock 的 Lua 脚本复用 vol-redis 的脚本执行语义。