# grpc-java：protoc 代码生成与 `*Grpc` 骨架 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch02-codegen-builders`
- 篇：`01 protoc 代码生成与 *Grpc 骨架`
- 对应主题：`G-INT-1 protoc 代码生成与 *Grpc 骨架`
- 文章类型：生成代码与装配桥篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面四篇已经把 grpc-java 的运行时主干讲清了，但用户实际接触到的入口并不是 `ClientCallImpl` 或 `ServerCallImpl`，而是 `.proto` 生成出来的 `*Grpc`、Stub、`ImplBase`、`bindService()`；这些生成代码到底是怎样把“IDL 契约”装进前面已经建立的运行时主线里的？
- 一句话顿悟：`protoc-gen-grpc-java` 生成的 `*Grpc` 文件并不是样板噪音，而是 grpc-java 最关键的装配桥：它先把 `.proto` 方法稳定编成 `MethodDescriptor`，再生成 async/blocking/future 三类 stub 入口、`AsyncService`/`ImplBase` 服务端骨架，以及 `MethodHandlers` / `bindService()` 把应用实现接回 `ServerCalls` 与 `ClientCalls` 主线。
- 文章边界：本篇只讲 protobuf codegen 这一层怎样把 `.proto` 契约装到 grpc-java 运行时主线；重点解释 `compiler/`、golden 产物、`TestServiceGrpc` 这类生成骨架、`ProtoUtils.marshaller`、stub 工厂、`AsyncService`、`ImplBase`、`MethodHandlers`、`bindService()`；不重讲前四篇运行时细节，不展开 Spring 集成或 xDS。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道 stub / channel / client call 主线。
- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道服务端 `ServerCallImpl / ServerCalls` 主线。
- 至少知道 `.proto` 是 gRPC Java 最常见的服务定义入口。

### SOFT

- protobuf-lite 差异只点到，不把 Android / lite 生态全展开。
- 只做 protobuf codegen，不扩展到“其他 IDL 适配方式”。

### NAV

- 后续篇可接：`ManagedChannelBuilder / ServerBuilder` 装配层。
- 后续篇可接：Marshaller / ProtoUtils / 消息对象桥。

## 一句话困惑

为什么 grpc-java 用户写的是 `.proto`、拿到的是 `*Grpc`、Stub 和 `ImplBase`，但最终却能无缝接上前面已经讲过的客户端调用主线和服务端运行时主线？

## 一句话顿悟

grpc-java 的 codegen 真正做的不是“多生成几个类”，而是把 `.proto` 契约稳定压成一份运行时装配骨架：方法描述符是契约地基，stub 是客户端入口壳，`AsyncService`/`ImplBase` 是服务端应用入口，`MethodHandlers` / `bindService()` 再把它们精确接回 `ClientCalls`、`ServerCalls` 和 `MethodDescriptor` 主线。

## 读者理解路径

1. 先否定“生成代码只是样板”这种低估。
2. 建立最小总图：`.proto -> protoc-gen-grpc-java -> MethodDescriptor -> Stub / ImplBase -> bindService() -> 前四篇运行时主线`。
3. 解释 method descriptor 为什么必须先成为静态骨架。
4. 解释 async/blocking/future stub 为什么是 codegen 层而不是运行时临时拼装。
5. 解释 `AsyncService` / `ImplBase` 为什么是服务端入口桥，而不是单纯模板代码。
6. 解释 `MethodHandlers` / `bindService()` 怎样把“方法号/调用类型”路由回 `ServerCalls`。
7. 最后收束到：codegen 层不是主线外壳，而是用户契约进入 grpc-java 运行时的装配桥。

## 失败方案推演

### 失败方案一：生成代码只是重复样板，理解 runtime 时可以整体跳过

- 这会解释不了：
- `.proto` 方法怎样变成 `MethodDescriptor`
- 为什么有 async/blocking/future 三类 stub
- 服务端 `ImplBase` 怎样最终接到 `bindService()` 和 `ServerCalls`
- 也就是说，跳过 codegen 层会让“用户入口 -> runtime 主线”之间出现断桥。

### 失败方案二：`*Grpc` 文件只是 API 皮肤，不承担运行时语义

- 这会低估：
- `MethodDescriptor.MethodType`
- marshaller 选择
- `safe` / `idempotent` 等方法属性
- `AsyncService` / `MethodHandlers` 的分派关系
- 所以它不是皮肤，而是契约骨架。

### 失败方案三：服务端生成代码只是方便继承 `ImplBase`

- 这会漏掉 `bindService()`、`MethodHandlers`、默认 `asyncUnimplemented*` 行为。
- 真正值钱的是：生成代码把应用实现精确接回 `ServerCalls` 主线，而不是只给你一个基类。

### 失败方案四：blocking / future / async stub 是运行时层自己临时长出来的

- 这会忽略 codegen 层其实已经预留了不同调用风格入口。
- 运行时当然统一走 `ClientCall`，但表面 API 的类型化入口是在 `*Grpc` 骨架里生成出来的。

## 必须澄清的误解

1. `*Grpc` 不是噪音文件，而是 `.proto` 契约进入 runtime 的桥。
2. `MethodDescriptor` 不是运行时偶然拼出来的，而是 codegen 骨架最先稳定下来的契约描述。
3. `AsyncService` / `ImplBase` 不是“继承方便一点”的模板，而是服务端应用入口桥。
4. `MethodHandlers` / `bindService()` 不是琐碎 glue code，而是调用类型分派的关键节点。
5. lite / full protobuf 不是只差依赖名，连 marshaller 骨架都不同。

## 文章结构与字数预算

1. 困惑开场：为什么不能跳过生成代码层（800-1000 字）
2. 最小总图：`.proto` 怎样接到前四篇 runtime 主线（1200-1600 字）
3. `MethodDescriptor` 骨架：codegen 如何先稳定契约地基（1800-2400 字）
4. Stub 工厂：async/blocking/future 三类入口怎样生成出来（1800-2400 字）
5. `AsyncService` / `ImplBase`：服务端骨架怎样把应用接口接进 runtime（1800-2400 字）
6. `MethodHandlers` / `bindService()`：真正的 dispatch glue 怎样成立（1800-2400 字）
7. lite/full codegen 差异与 `ProtoUtils/ProtoLiteUtils`（1200-1600 字）
8. 收网总结：生成代码层为什么是 grpc-java 完整卷不可缺的一环（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `README.md:99`
- `README.md:232`
- `compiler/README.md:1`
- `compiler/README.md:37`
- `compiler/src/test/golden/TestService.java.txt:14`
- `compiler/src/test/golden/TestService.java.txt:20`
- `compiler/src/test/golden/TestService.java.txt:274`
- `compiler/src/test/golden/TestService.java.txt:335`
- `compiler/src/testLite/golden/TestService.java.txt:11`
- `compiler/src/testLite/golden/TestService.java.txt:37`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:12`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:18`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:267`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:332`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:917`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:999`

## 测试证据清单

- `compiler/src/test/golden/TestService.java.txt`：full protobuf 生成骨架的黄金样本。
- `compiler/src/testLite/golden/TestService.java.txt`：lite protobuf 生成骨架的黄金样本。
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:267`：stub 工厂形态在真实生成产物里的样子。
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:332`：`AsyncService` 默认未实现行为。
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:917`：`MethodHandlers` 怎样按方法号把调用接回 `ServerCalls`。
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:999`：`bindService()` 怎样把所有方法装成 `ServerServiceDefinition`。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇只覆盖 protobuf codegen 主路径，不扩展到其他 IDL/自定义 binding。
- golden 文件用于说明 codegen 骨架结构；真实生成产物以 `interop-testing` 中现成 `*Grpc` 文件作双重对照。
- lite/full 差异只讲最关键的 marshaller 与骨架区别，不扩展到 Android 平台全景。

## 与其他篇的边界

### 本篇要讲清

- `.proto` 如何落成 `*Grpc` 骨架。
- `MethodDescriptor` 怎样成为契约地基。
- Stub / `AsyncService` / `ImplBase` / `MethodHandlers` / `bindService()` 怎样把用户入口接回前四篇 runtime 主线。
- lite/full protobuf 生成骨架差异。

### 本篇不深讲

- `ManagedChannelBuilder` / `ServerBuilder` 运行时配置装配。
- `Marshaller` / `ProtoUtils` 的更深消息对象桥专题。
- Spring / Boot / Cloud 集成层。
- xDS / services / diagnostics 生产层。

## 写作后检查

- [ ] 开篇先抓“为什么不能跳过生成代码层”，而不是直接列生成结构。
- [ ] 至少展开 3 个失败方案，且包含“*Grpc 不是样板噪音”。
- [ ] 明确给出 `.proto -> *Grpc -> runtime 主线` 总图。
- [ ] 不把本篇写成 generated file 字段罗列文。
- [ ] 不把这篇顺手扩成 builder 装配层。
- [ ] 删除代码块后，读者仍能复述 codegen 为什么是 runtime 装配桥。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
