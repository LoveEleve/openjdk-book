# Redis 6.0 的 ACL 怎么实现用户隔离

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十六篇，回答 ACL 的用户/规则/命令类别三层权限模型。

## 为什么"ACL 就是密码"这个理解会把权限控制读浅

很多人第一次用 Redis ACL，觉得它就是一个密码认证，`AUTH password` 验证通过就能用所有命令。

但 Redis 6.0 的 ACL 不是"一个密码管所有"——它是 **用户（user）+ 规则（ACL rule）+ 命令类别（acl_categories 位标志）** 的三层权限模型。每个用户有独立的密码、命令白名单、key 白名单和频道白名单。

## 一、default 用户与 ACL 初始化

`DefaultUser`（`src/acl.c:20`）是全局默认用户，所有未认证的客户端默认以 `default` 用户身份运行。

`ACLCreateDefaultUser()`（`src/acl.c:1407`）创建 default 用户，默认拥有全部权限（`+@all`）。`requirepass` 配置实际上设置的是 default 用户的密码（`server.c:2795` `ACLUpdateDefaultUserPassword`）。

## 二、ACLSetUser 规则

`ACLSetUser()`（`src/acl.c:1272`）用字符串规则设置用户权限：

- `+@<category>` / `-@<category>`：允许/禁止某个命令类别（如 `+@string`、`-@admin`）
- `+<command>` / `-<command>`：允许/禁止单个命令（如 `+SET`、`-FLUSHALL`）
- `~<pattern>` / `*`：允许访问的 key 模式（如 `~cache:*`）
- `&<pattern>` / `*`：允许的频道模式（发布订阅）
- `on` / `off`：启用/禁用用户
- `>password`：设置密码

## 三、acl_categories 位标志

命令类别（`@string`、`@list`、`@set`、`@admin`、`@keyspace` 等）用 `acl_categories` 位标志表示（`src/acl.c:75`-`81`）。每个命令注册时指定它属于哪些类别，每个用户通过 `+@string` / `-@admin` 控制整类命令的权限。

## 四、processCommand 中的 ACL 检查

`processCommand()`（`src/server.c:3970`）中 `authRequired(c)` 检查客户端是否已验证。验证通过后，具体命令的 ACL 权限在 `ACLCheckAllPerm`（`src/server.c:3987`）中检查（在 `lookupCommand` 之后、`call` 之前）。

## 五、失败路径

### 1. default 用户被误删

`ACL DELUSER default` 删除了 default 用户，但未创建其他用户，导致所有连接被拒绝。`ACL SAVE` 前需确保至少有一个可用的管理员用户。

### 2. 权限配置错误导致服务不可用

`ACL SETUSER myuser -@all +@string` 只允许 string 命令，但 `MSET` 等命令可能被归类到其他类别，导致功能异常。

## 到这里，R-32 真正立住的是"用户+规则+命令类别三层权限模型"

如果只看表面，ACL 被读成"一个密码"。

更稳的理解方式应该是：

1. `DefaultUser` 默认有全部权限，`requirepass` 设置的是 default 用户密码
2. `ACLSetUser` 用字符串规则配置用户权限
3. `acl_categories` 位标志按命令类别控制权限
4. `processCommand` 中 `authRequired` 检查认证

## 下篇桥接

R-11 Bitmap 将展开位图操作的内存结构。
