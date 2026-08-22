# vol-redis R-32 ACL 权限控制 — note

## 本篇主张

- ACL 不是"一个密码"，而是 **用户 + 规则 + 命令类别（acl_categories 位标志）** 的三层权限模型。
- `DefaultUser` 默认有全部权限，`requirepass` 设置的是 default 用户密码。
- `ACLSetUser` 用字符串规则配置用户权限（+@category / -@command / ~key / &channel / on/off / >password）。
- `processCommand` 中 `authRequired` 检查认证，`ACLCheckAllCommand` 检查命令权限。

## 本篇边界

- 不展开 `ACLAuth` / `AUTH` 的完整认证流程。
- 不展开 `ACL LOG` / `ACL CAT` 等管理命令的完整实现。

## 下篇桥接

- R-11 Bitmap 将展开位图操作的内存结构。
