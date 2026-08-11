# 域 46 SA Postmortem — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. SRE/运维 (2问)

1. JVM crash→core dump→`jhsdb jmap --core core.dump`→为什么 SA 不需要 JVM 还在运行就能读 Java heap？core file 里的 heap 和 live JVM 中的 heap 一样吗？
2. `ptrace(PTRACE_ATTACH)` 会停止目标 JVM——生产环境中 `jhsdb jstack <pid>` 会让 JVM STW 多久？

## 2. 安全研究者 (2问)

3. `ptrace(PTRACE_PEEKDATA)` 可以读目标进程的任意内存——SA 需要 root 权限吗？`/proc/sys/kernel/yama/ptrace_scope` 怎么限制？
4. SA 从 core dump 中提取 Java heap——如果 JVM 使用 `-XX:+UseG1GC`→GC 压缩后 heap 中的 dead objects 还在 core dump 中吗？

## 3. 框架/工具开发者 (2问)

5. SA 用 ELF `.dynsym` 找 JVM 符号——如果我的 JVM 用 `strip libjvm.so`→SA 还能工作吗？`debuginfo-install` 怎么修复？
6. Core dump 中 `add_map_info` 按 vaddr 排序——为什么用链表而不是红黑树？200+ segments 的 lookup O(n) 会不会太慢？

## 4. 性能工程师 (1问)

7. `ptrace(PTRACE_PEEKDATA)` 每次读 8 bytes——读取 16KB Java stack frame 需要 2048 次 ptrace 系统调用——性能瓶颈在哪里？

## 5. 架构师 (1问)

8. SA 是独立进程——为什么不用 JVM TI agent(in-process) 代替 ptrace？in-process agent 不是更快且不需要 debug symbols？
