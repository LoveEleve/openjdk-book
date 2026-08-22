# vol-redis R-32 ACL 权限控制 — review notes

## 事实审

- 已核对 `src/acl.c:20`（`user *DefaultUser` 全局默认用户），正文成立。
- 已核对 `src/acl.c:1407`（`ACLCreateDefaultUser()` 创建 default 用户），正文成立。
- 已核对 `src/acl.c:1272`（`ACLSetUser()` 用户规则设置），正文成立。
- 已核对 `src/acl.c:75`-`:81`（`acl_categories` 位标志），正文成立。
- 已核对 `src/server.c:3970`（`authRequired()` ACL 检查点）、`:3987`（`ACLCheckAllPerm` 命令权限检查），正文成立。
- 已核对 `src/server.c:2795`（`ACLUpdateDefaultUserPassword(server.requirepass)` requirepass 设置 default 用户密码），正文成立。

## 因果审

- default 用户默认有全部权限，正文成立。
- `requirepass` 设置的是 default 用户密码，正文成立。
- `acl_categories` 位标志按命令类别控制权限，正文成立。
- `processCommand` 中 authRequired 检查认证，正文成立。

## 结构审

- 从"ACL 不是密码"困惑开场，再落到 default 用户、规则语法、位标志、检查点，主线集中。

## 读者审

- 读完应能回答：default 用户有什么权限。
- 读完应能回答：ACLSetUser 的规则语法。
- 读完应能回答：acl_categories 怎么控制权限。
- 读完后能自然进入 R-11 Bitmap。

## 边界审

- 本篇没有展开 AUTH 完整认证流程。
- R-11 Bitmap 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-26 命令执行全流程（HARD）。
- 后续桥接：R-11 Bitmap。

## 结论

R-32 已完成四件套的事实回填与六层审查，D 层经典混淆补深全部完成。
