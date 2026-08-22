# 17-threads/03-thread-smr-handshake 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 Thread-SMR 如何在读侧无锁保护 JavaThread 指针、写侧延迟删除线程对象，以及 Handshake 如何只让单个目标线程安全执行闭包

## 1. 核心困惑

**线程 B 退出了，线程 A 手里还握着它的 `JavaThread*` 怎么办？为什么不能在 `JavaThread::exit()` 里直接 `delete this`？`ThreadsListHandle` 真正保护的是什么？Handshake 和 safepoint 又是什么关系——是“缩小版停世界”还是完全不同的协议？**

## 2. 一句话顿悟

**Thread-SMR 用不可变 `ThreadsList` 快照 + 每线程 hazard pointer 保护“我正在看这些 JavaThread*”；删除方不改旧快照，只造新版本并把旧版本延迟回收，退出线程对象则等所有保护解除才真删。Handshake 则是同一时代的另一条轻量协议：不需要停全部线程，只让一个目标线程在安全状态下执行闭包。**

## 3. 结构

1. 开场：线程退出了，别人怎么不 crash
2. 两个误解：ThreadsList 是链表 / Handshake 是缩小版 safepoint
3. 读侧：ThreadsList + hazard pointer
4. 写侧：smr_delete 与 delete_notify 双检查唤醒
5. Handshake：线程自办与 VMThread 代办
6. 收网

## 4. 证据清单

- `src/hotspot/share/runtime/threadSMR.hpp:37-116`
- `src/hotspot/share/runtime/threadSMR.hpp:158-373`
- `src/hotspot/share/runtime/threadSMR.cpp:384-427`
- `src/hotspot/share/runtime/threadSMR.cpp:471-509`
- `src/hotspot/share/runtime/threadSMR.cpp:944-1010`
- `src/hotspot/share/runtime/thread.cpp:208-213`
- `src/hotspot/share/runtime/handshake.hpp:35-101`
- `src/hotspot/share/runtime/handshake.cpp:417-516`
- `src/hotspot/share/runtime/safepointMechanism.cpp:91-92`

## 5. 完成后 review

- 能否复述“不变快照 + tagged hazard ptr + 延迟删除”
- 是否讲清 `_to_delete_list` 装的是旧快照不是线程
- 是否讲清 Handshake 的两条执行路径
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验