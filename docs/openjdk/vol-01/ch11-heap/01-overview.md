# 第11章：G1CollectedHeap —— 堆创建全景

> 本章全景介绍 G1CollectedHeap::initialize() 的 18 步序列：6 个 mmap 映射、Card Table、BOT、HeapRegion、HRManager。为什么 8GB 堆需要 ~300MB 辅助内存？

TODO
