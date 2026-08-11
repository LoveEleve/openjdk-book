# 域 00 工具下载地址清单(换机器部署用)

> 2026-08-11 | 用途: 工具二进制不入库(GitHub 100MB 限制),本清单记录全部下载地址——新机器按此下载,参考 `tools/README.md` 部署
> 本地已下载副本: `outlines/00-jvm-tools/tools/`(不入库,直接复制目录即可,免下载)

## 清单

| # | 工具 | 版本 | 大小 | 下载地址 | 备注 |
|---|---|---|---|---|---|
| 1 | **JDK 21**(JMC 必需) | TencentKona 21.0.12 b1 | 213MB | `https://mirrors.tencent.com/repository/generic/konajdk/21/0/12/linux-x86_64/b1/TencentKona-21.0.12.b1-jdk_linux-x86_64.tar.gz` | 必须校验完整性(`tar -tzf`);此前 131MB 中断下载不可用;备用: `github.com/adoptium/temurin21-binaries/releases` |
| 2 | **MAT** | 1.16.1 | 95MB | `https://www.eclipse.org/downloads/download.php?file=/mat/1.16.1/rcp/MemoryAnalyzer-1.16.1.20250109-linux.gtk.x86_64.zip&r=1` | 需 `-H "User-Agent: Mozilla/5.0"`;**选 x86_64 非 aarch64**;目录页: `download.eclipse.org/mat/1.16.1/rcp/`;备用镜像: `mirrors.tuna.tsinghua.edu.cn/eclipse/mat/` |
| 3 | **JITWatch** | 1.5.0 | 47MB | `https://github.com/AdoptOpenJDK/jitwatch/releases/download/1.5.0/jitwatch-ui-1.5.0-shaded-linux-x64.jar` | JavaFX,需 GUI |
| 4 | **VisualVM** | 2.1.10 | 23MB | `https://github.com/oracle/visualvm/releases/download/2.1.10/visualvm_2110.zip` | 解压即用 |
| 5 | **GCViewer** | 1.37 | 0.6MB | `https://sourceforge.net/projects/gcviewer/files/gcviewer-1.37.jar/download` | `java -jar` |
| 6 | **FlameGraph 脚本** | master | 13MB | `git clone --depth 1 https://github.com/brendangregg/FlameGraph.git` | 火焰图聚合原理 |
| 7 | **perf** | 6.6.119 | 系统包 | `yum install -y perf`(TencentOS/通用 Linux) | 内核采样 |

## 部署速查(详见 `tools/README.md`)

```bash
# JDK 21
tar -xzf TencentKona-21.0.12.b1-jdk_linux-x86_64.tar.gz -C /opt/codev/
# jmc.ini 加(-vmargs 之前):
#   -vm
#   /opt/codev/TencentKona-21.0.12.b1/bin/java

# MAT
unzip MemoryAnalyzer-1.16.1.20250109-linux.gtk.x86_64.zip -d /opt/tools/
# 命令行: PATH 含 JDK21 + DISPLAY 下 ParseHeapDump.sh <dump> org.eclipse.mat.api:suspects

# 其他
unzip visualvm_2110.zip -d /opt/tools/
cp jitwatch-ui-*.jar gcviewer-1.37.jar /opt/tools/
cp -r FlameGraph /opt/tools/
```

## 常见下载失败处理(踩坑档案 11/12 号坑)

1. MAT 返回 HTML → 加 UA 头或换 download.php 分发 URL
2. 下载"完成"但损坏 → `unzip -t` / `tar -tzf` 校验,重下
3. GitHub 慢 → 换镜像(腾讯云/清华)

> JDK 17 自带工具(jcmd/jfr/jmap/jhsdb/jstack/jstat/javap/jconsole/jimage/jlink/jdeps/jfr 等 14 个)无需下载
