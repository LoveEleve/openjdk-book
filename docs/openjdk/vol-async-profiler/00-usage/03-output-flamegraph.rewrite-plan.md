# 03-output-flamegraph 重写规划

> 状态：本轮按一轮闭环执行；保留该 plan 作为后续二轮 consistency pass 的工件
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“格式列表 + 火焰图读法”重写成一篇围绕“同一份样本为什么要先分清消费方，再决定输出格式；以及 flamegraph / collapsed / jfr / otlp 各自服务谁、适合什么工作流”的面向用户机制文章

## 1. 读者困惑

- 同一份采样结果为什么不能只固定输出成一种格式？
- flamegraph、collapsed、tree、jfr、otlp 分别是给谁看的，什么时候该选哪一个？
- 为什么 `.html` 更像最终展示物，而 `.jfr` 更像可再消费档案？
- `jfrconv` / `jfr-converter.jar` 在工作流里补的是哪一层缺口？
- flame graph 的横向宽度到底表示什么，为什么不是时间顺序？
- `reverse` / `inverted` / `minwidth` 为什么在使用层就必须先分清边界？

## 2. 一句话顿悟

**async-profiler 的输出格式不是文件后缀装饰，而是消费契约：flamegraph/tree 面向人类浏览器视图，collapsed/flat/traces 面向终端和脚本，JFR 面向 JFR 生态与离线转换，OTLP 面向可观测平台；先分清“谁要消费结果”，才能知道该直接出 HTML、保留 JFR，还是走转换链。**

## 3. 总图

```text
同一份采样样本
  → 先问消费方是谁
    ├─ 人类浏览器视图 → flamegraph / tree / html
    ├─ 终端/脚本       → collapsed / flat / traces
    ├─ JFR 生态 / 离线分析 → jfr
    └─ 可观测平台       → otlp

服务器现场
  → 低开销采集
    → JFR 存档
      → 本地 jfrconv / jfr-converter.jar
        → html / collapsed / heatmap / otlp
```

## 4. 关键边界

- 本篇是面向使用者的“消费层决策”文章，不重讲 AP-5 的内部实现细节；只引用那些对使用语义必须提前守住的边界。
- `.html` / `flamegraph` / `tree` 的核心价值是交互式人类浏览，不是通用交换格式。
- `collapsed` / `flat` / `traces` 更适合脚本、终端和二次加工，不等于比 HTML 更“底层正确”。
- `jfr` 既是输出格式，也是离线分析链路的桥；它适合服务器采样、本地渲染、比较和复用。
- `otlp` 面向 OTel / 可观测平台，不是 Prometheus 文本，也不是 JFR 的另一层包装。
- flame graph 横向宽度表示样本/计数占比，不是执行时间线顺序。
- `reverse` 与 `inverted` 不是一回事；`minwidth` 是输出阶段视觉裁剪，不是采样期丢样。

## 5. 本轮重写主线

1. 用“结果不是固定对象，而是不同消费方需要不同协议”开场。
2. 否定：所有场景统一用一种输出、把 flamegraph/JFR/文本栈混成一类、把火焰图横向宽度当时间线。
3. 先按消费方划分格式，而不是先按命令行选项罗列。
4. 再讲“服务器采样、本地分析”的 JFR→converter 工作流。
5. 最后讲火焰图的基本读法和 `reverse/inverted/minwidth` 的用户层边界。
6. 收网时把格式选择压回“先决定给谁看，再决定输出什么”。
