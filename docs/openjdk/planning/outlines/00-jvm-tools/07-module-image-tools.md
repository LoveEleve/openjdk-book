# 07. 翻开 JDK 的"箱子" — jimage/jlink/jdeps 模块与镜像工具

> 🟢 工具域 | 工具: jimage/jlink/jdeps/jdeprscan/jmod | 关联 JVM 域: 41-zip-jimage、07-classfile、48-utilities、40-launcher
> 读者处境: 你要写 JVM 运行时怎么加载类库(域 41/07)——先亲手翻 JDK 镜像、做最小运行时、画依赖图。
> 新增: 2026-08-11 v3(48 域覆盖矩阵补缺——域 41 此前无任何工具素材)

### 1. "JDK 镜像里到底有什么" — jimage 查看

场景: `lib/modules` 是 JDK 运行时的核心,先看看它的结构。

- `jimage list <jdk>/lib/modules`: 列出模块内容(实测: java.base 模块的类/资源清单)
- `jimage extract --dir <out> <jdk>/lib/modules`: 解包模块镜像
- `jimage info`: 镜像头信息(格式版本/资源计数)
- [Java: 域 41——`modules` 文件是紧凑格式镜像,启动时由 CDS/JIMAGE 解析(域 11/41 交叉);与 ZIP(JAR)格式对照]

关键设计: **镜像 ≠ JAR**: jimage 是 JVM 启动专用格式(常驻内存映射),JAR 是打包格式——`jimage` 工具是观察域 41 内部格式的唯一直接窗口。

### 2. "自己组一个最小 JDK" — jlink

场景: 生产镜像瘦身/定制运行时,看 jlink 怎么剪。

- `jlink --add-modules java.base,java.logging --output /tmp/mini-jdk`: 组装最小运行时(实测可用)
- `jlink --list-plugins`: 插件清单(压缩/去重/打包)
- 与域 41 的关系: jlink 生成的就是 jimage 格式镜像——"镜像的制造者"
- 对照: `-XX:+UseAppCDS`(域 11 CDS)共享的也是类似的镜像/归档思想

### 3. "依赖图" — jdeps/jdeprscan

场景: 一个 jar 依赖了哪些模块?用了哪些废弃 API?

- `jdeps -s app.jar`: 模块级依赖摘要(域 07 的模块系统实证)
- `jdeps --print-module-deps`: 完整依赖集(直接输入 jlink!)
- `jdeprscan app.jar`: 废弃 API 扫描(域 48)
- 写作素材: 模块依赖图是域 07(模块系统)文章的标准插图;jdeps 输出 → jlink 输入的闭环是"模块化工具链"主线

关键设计: **jdeps→jlink 闭环**: jdeps 分析出依赖 → jlink 组装最小运行时——同一个模块图(域 07)的"读"和"写"两端,是模块系统工具链的最佳教材。

### 4. "对照与写作素材"

- **三工具关系**: jimage(读镜像)/jlink(写镜像)/jdeps(读依赖)——域 41 三视角
- **与 launch 对照**: `java --list-modules`(域 40)vs jimage list(域 41)——运行期 vs 镜像期
- **与 async-profiler 对照**: 无直接对照;域 41 在 async-profiler 里无对应(纯 JDK 构建期格式)
- 写作素材: 域 41(镜像格式)、域 07(模块系统)、域 48(工具链)

生产注意: jlink 生成的最小运行时缺模块不可运行时补——与 Arthas/async-profiler 无依赖,纯 JDK 构建期主题。

---

跨域桥: 镜像格式 = 域 41;模块系统 = 域 07;启动加载 = 域 11/40;工具链 = 域 48。
