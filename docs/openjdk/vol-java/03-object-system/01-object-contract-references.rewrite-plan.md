# 03-object-system/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 Object、Reference、Cleaner 实现；不把 HotSpot 对象头细节外推成 Java 规范。
> 目标：从 HashSet key 失效与资源泄漏事故出发，解释 Object 契约、finalize 与引用处理的共同边界。

## 1. 读者困惑

- Object 的方法为什么既有 native 又有 Java 实现？
- equals/hashCode 为什么不是两个独立方法？
- 对象放入 HashSet 后修改字段，为什么可能再也删不掉？
- finalize 为什么会拖慢回收，Cleaner 又解决了什么？
- Soft/Weak/PhantomReference 到底差在哪里？

## 2. 一句话顿悟

**Object 提供的是对象身份与通用契约；集合正确性依赖 equals/hashCode 稳定，资源正确性不能依赖 finalize，而引用类型把“对象是否继续存活”和“死亡后是否通知 Java”拆成了不同强度。**

## 3. 旧稿问题

- 旧稿按 Object 六方法、hash 契约、finalize、四种引用平铺，缺少“对象身份/值契约/资源生命周期”主线。
- Object 方法 native/Java 的差异没有围绕“Java 层表达不了什么”展开。
- finalize 与 Cleaner 只列优缺点，缺少资源泄漏事故和引用处理时序。
- 四种引用的强度梯度容易写成背诵表，需要用状态机与队列角色解释。

## 4. 理解路径

### 第一节：HashSet key 事故——Object 契约不是形式主义

- equals/hashCode 不一致与可变 key 失败。
- 总图：身份/值 → hash 定位 → equals 确认。
- Object 六方法先不全部列，先引出契约。

### 第二节：Object 六方法——哪些能力必须下沉到 JVM

- getClass/hashCode/clone/finalize native 与 equals/toString Java 实现。
- 逐段回答：对象头、随机身份、位级拷贝为何 Java 侧不能直接表达。
- 失败方案：用地址当 hash、用普通 Java 复制替代 clone。

### 第三节：finalize 资源事故——为什么对象死了资源还没释放

- Finalizer 队列与线程延迟。
- 清理时机、不复现、吞异常、复活风险。
- Cleaner/try-with-resources 替代路径。

### 第四节：四种引用——对象死亡如何被通知

- Reference 状态图：active → pending → inactive。
- 强/软/弱/虚的存活语义。
- ReferenceHandler、ReferenceQueue、Cleaner 的角色箭头。
- 失败方案：用弱引用代替所有缓存、用 PhantomReference 读取对象。

### 第五节：收网——对象契约与生命周期边界

- 值对象：equals/hashCode 稳定。
- 资源对象：显式关闭优先。
- 引用对象：弱/软/虚只控制可达性与通知，不提供业务所有权。

## 5. 失败方案清单

1. 重写 equals 不重写 hashCode。
2. 对象入 HashSet 后修改参与 hash 的字段。
3. 用内存地址假设 hashCode 永久等于地址。
4. 用 finalize 作为文件/Socket/堆外内存的及时释放机制。
5. 用 WeakReference 当作强缓存或用 PhantomReference.get 读取对象。

## 6. 误解清单

1. `final`/native 是 Object 方法分类的全部解释——错误，应看语言层与 JVM 状态边界。
2. hashCode 相等就代表 equals 相等——错误。
3. finalize 在 GC 时立刻执行——错误，存在队列与线程延迟。
4. Cleaner 保证立即清理——错误，显式 close 仍是首选。
5. PhantomReference 能拿到 referent——错误，get 恒为 null，只用于死亡通知。

## 7. 证据清单

- `Object.java:72/109/157/222/245/558`：六方法。
- `Reference.java:151/161/171/190`：referent、队列、Handler。
- `Cleaner.java:131/173`：Cleaner 创建与清理。
- `String`/HashSet 行为作为集合事故背景。

## 8. 版本与边界

- 基于 JDK 11；finalize 在 JDK 9 起 deprecated，但 JDK 11 仍存在。
- Cleaner 是 Java 层引用处理机制，不等于立即资源释放保证。
- 对象头/hash/GC reachability 的底层细节属于 HotSpot 当前实现，不等于 Java API 规范全部内容。

## 9. 验收标准

- 以 HashSet key 事故开场，不先列六个方法。
- 至少展开五个失败方案。
- 必须有引用状态文字图与角色时序。
- 明确区分 equals/hashCode、finalize/Cleaner、soft/weak/phantom。
- 删除代码后主线仍成立，锚点/禁用词/版本边界全绿。
