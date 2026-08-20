# 01-build-attach 重写规划

> 状态：本轮按一轮闭环执行；保留该 plan 作为后续二轮 consistency pass 的工件
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“构建步骤 + 最短命令”重写成一篇围绕“第一次上手 async-profiler 时，为什么真正要先解决的是能不能拿到一个自包含的 `asprof` 并把它挂进目标 JVM；以及 `make`、PID 选择、`-d`、`start/stop` 这几步各自在帮你跨什么使用层门槛”的面向用户机制文章

## 1. 读者困惑

- 第一次上手 async-profiler 时，真正的第一步到底是什么：看源码、学事件，还是先把工具跑起来？
- 为什么仓库强调先 `make` 出 `build/bin/asprof`，这说明了什么部署姿势？
- 为什么只给一个 PID 或应用名，`asprof` 就能把 agent 挂进去并开始采样？
- `-d 30 <pid>` 和 `start/stop` 两种工作流分别适合什么现场？
- `.html` 输出为什么看起来像只是换个文件名，实际上却已经在决定消费链？
- attach 失败、动态 attach 限制、容器或 chroot 边界为什么在上手阶段就必须先承认？

## 2. 一句话顿悟

**第一次使用 async-profiler 时，真正要先跨过的门槛不是“采样器内部怎么工作”，而是“能不能拿到一个尽量自包含的 `asprof`，定位对目标 JVM，并用最短命令完成 attach + 采样 + 停止 + 输出这一条闭环”；`make`、PID 目标写法、`-d`、`start/stop` 和输出文件名，都是在把这条闭环压成最短可用路径。**

## 3. 总图

```text
源码目录
  → make
    → build/bin/asprof
      → 选定目标 JVM（PID / jps / 应用名）
        → attach 并采样
          → start/stop 或 -d
            → text / html / jfr 输出
```

## 4. 关键边界

- 本篇是面向上手者的“先跑起来”文章，不展开 `main.cpp` / `run_jattach()` / `arguments.cpp` 的内部实现细节；只提前守住使用层必须知道的边界。
- `build/bin/asprof` 体现的是“可单独分发的 native 工具”姿势，不是 IDE/Java 先行插件模型。
- `-d` 是把 attach + start + sleep + stop + dump 压成一条最短工作流，不等于唯一用法。
- `start/stop` 更适合已知问题窗口的交互式场景；`-d` 更适合一次性抓取或新手上手。
- `.html` 输出不只是文件路径，已经在决定 flame graph 消费链。
- attach / 权限 / 容器 / chroot / 运行时 attach 限制属于上手阶段就要承认的系统边界，不应误解为单纯命令语法问题。

## 5. 本轮重写主线

1. 用“第一次上手时先别看 `recordSample()`，先把工具和 attach 路跑通”开场。
2. 否定：先学内部机制再试命令、`make` 只是构建细节、`-d` 和 `start/stop` 只是两种写法没有场景差异、`.html` 只是后缀。
3. 先讲 `make -> build/bin/asprof` 说明的自包含部署姿势。
4. 再讲目标 JVM 的几种定位方式和“attach 已被入口压缩掉”的使用事实。
5. 再讲 `-d` vs `start/stop` 两种工作流的不同适用场景。
6. 最后把输出文件后缀、动态 attach 和容器/chroot 边界拉回“上手闭环”这一主线。
