# 篇：01 ACL 权限控制：用户、规则与命令类别

- 域：`R-32 ACL 权限控制`
- 卷：`vol-redis`
- 目标：回答 Redis 6.0 的 ACL 如何实现用户隔离、default 用户权限、ACL 规则。

## 前置依赖

- HARD：已读 `R-26 命令执行全流程`（知道 `processCommand` 中 ACL 检查点）。

## 读者问题

1. `default` 用户有什么权限？
2. `ACL SETUSER` 怎么创建用户和设置规则？
3. `acl_categories` 怎么用位标志控制命令类别？
4. 命令执行时 ACL 检查在哪一步？

## 主结论

ACL 是 Redis 6.0 引入的权限控制系统，用 **用户（user）+ 规则（ACL rule）+ 命令类别（acl_categories 位标志）** 三层结构实现权限隔离。

## 结构设计

1. 困惑开场：为什么需要 ACL
2. default 用户与 ACL 初始化
3. ACLSetUser 规则语法
4. acl_categories 位标志
5. processCommand 中的 ACL 检查点
6. 失败路径
7. 收网与下篇桥接

## 必须回填的源码锚点

- `src/acl.c:20` `user *DefaultUser`
- `src/acl.c:1407` `ACLCreateDefaultUser()`
- `src/acl.c:1272` `ACLSetUser()`（用户规则设置）
- `src/acl.c:75`-`:81` `acl_categories` 位标志
- `src/server.c:3970` `authRequired()`（ACL 检查点）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
