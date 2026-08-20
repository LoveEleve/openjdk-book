# 为什么事务“提交成功后才发 MQ”是安全的：`TransactionSynchronization` 的 5 个回调钩子与提交时序

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 事务同步主线：`TransactionSynchronizationManager` 如何用 ThreadLocal 管理当前线程的同步器集合，`TransactionSynchronization` 的 5 个回调钩子在 `AbstractPlatformTransactionManager.commit/rollback` 中的精确触发顺序，以及为什么 `afterCommit` 和 `afterCompletion` 的分离是“事务成功后发消息不丢失”这一经典模式的基石。

## 为什么一个方法只要注册了事务同步器，就能在“提交成功那一刻”做某件事

前面几篇已经覆盖了事务主链、传播行为、失效场景和异常翻译。但还有一个 Spring 事务里非常实用、也经常被窄化理解的机制：**事务同步**。

你一定见过或写过类似代码：

```java
TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
    @Override
    public void afterCommit() {
        mqSender.send("order.paid", orderId);
    }
});
```

这句代码想要表达的是：**只有当数据库事务真的提交成功之后，才去发消息。**

为什么它能做到这一点？因为 Spring 在 `AbstractPlatformTransactionManager.commit` 的成功路径里，明确保留了 `triggerAfterCommit` 这个回调点。而它之所以可靠，是因为它发生在 `doCommit`（真正的 `conn.commit()`）之后，而不是之前。

第一层问题是：**`TransactionSynchronizationManager` 用 ThreadLocal 保存当前线程的事务同步器集合，它和事务连接绑定在同一线程上。**

- `registerSynchronization(...)` 把同步器放进当前线程的集合
- `getSynchronizations()` 取出并排序后执行回调
- `clearSynchronization()` 在事务收尾时清空

这延续了前面“事务即线程本地资源”的设计：同步器也绑定在当前线程，跨线程就失效。

第二层问题是：**5 个回调钩子不是平行关系，它们分别站在提交/回滚的不同时点。**

Spring 的 `TransactionSynchronization` 接口定义了 5 个回调：

- `beforeCommit(readOnly)`：事务提交前一瞬
- `beforeCompletion()`：事务完成前、清理之前
- `afterCommit()`：事务提交确认成功后
- `afterCompletion(status)`：事务完成时，无论成功还是失败
- `flush()`：用于 Hibernate 这类需要 flush 的持久化技术

如果不区分这些回调，就无法表达“只有成功才做”和“无论成败都做”两种完全不同的语义。

第三层问题是：**触发顺序不是同级的，而是有严格次序的调用链。**

`commit` 路径的精确顺序是：

```text
triggerBeforeCommit
   -> triggerBeforeCompletion
   -> doCommit (真正提交)
   -> triggerAfterCommit
   -> triggerAfterCompletion(STATUS_COMMITTED)
```

该顺序意味着：

- `beforeCommit` 在真正提交前执行，抛异常可以中止提交
- `afterCommit` 在 `conn.commit()` 成功之后执行，是“提交成功后必须做”的唯一正确时点

如果只提供一个回调：

- 在提交前做会失败（提交前就执行了，可能事务最终还是回滚）
- 在完成时做无法区分成功失败

因此 `afterCommit` 与 `afterCompletion` 的分离，正是“事务成功后发 MQ 不丢失”这一经典模式的基石。

因此，本文真正要回答的问题不是“TransactionSynchronization 有哪几个方法”，而是：

**Spring 如何用 ThreadLocal 管理同步器集合，并用 `triggerBefore/After` 回调链在提交和回滚路径上精确地表达“成功/失败/无论如何”三种时机？**

## 先看失败方案：为什么不能“方法返回后直接发消息”“把所有收尾都放一个回调”“把发消息放在提交前”

### 失败方案一：方法返回后直接发消息

如果方法返回后立即发消息，事务可能还没提交，甚至可能回滚。这样消息发出去了，但数据库里没有对应数据，造成业务不一致。

`afterCommit` 存在的意义，就是给“事务真正提交成功之后”提供回调点。

### 失败方案二：把所有收尾动作都放一个回调

如果只用一个回调，就无法区分：

- 只有在事务成功时才应该做的动作（发消息）
- 无论成败都要做的动作（清理资源）

Spring 用 `afterCommit` 和 `afterCompletion` 区分这两种语义。

### 失败方案三：把发消息放在 `beforeCommit`

`beforeCommit` 在事务真正提交前执行。如果此时发消息，事务随后回滚，消息也白发了。需要在 `afterCommit` 里发，才能确保消息只在事务成功后才被触发。

## 事务同步机制的最小总图

```text
@Transactional method
   -> TransactionSynchronizationManager.initSynchronization
   -> 业务方法内 registerSynchronization
   -> ThreadLocal<Set<TransactionSynchronization>>
   -> commit:
      -> triggerBeforeCommit
      -> triggerBeforeCompletion
      -> doCommit (conn.commit())
      -> triggerAfterCommit
      -> triggerAfterCompletion(COMMITTED)
   -> rollback:
      -> triggerBeforeCompletion
      -> doRollback
      -> triggerAfterCompletion(ROLLED_BACK)
   -> clearSynchronization
```

## 一、`TransactionSynchronizationManager`：用 ThreadLocal 管理同步器集合

`TransactionSynchronizationManager` 内部有一个 `ThreadLocal<Set<TransactionSynchronization>>`，用来保存当前线程注册的所有同步器。

它提供几个核心方法：

- `initSynchronization`：事务开始时初始化当前线程的同步集合
- `registerSynchronization`：业务代码注册自己的同步器
- `getSynchronizations`：取出同步集合，并按 @Order 排序
- `clearSynchronization`：事务结束时清空

因为它是 ThreadLocal，所以同步器绑定在当前线程上。跨线程调用注册事务同步器时，新线程拿不到当前线程的同步集合，这一点和前面事务连接的线程绑定一致。

## 二、5 个回调钩子的语义

`TransactionSynchronization` 定义了 5 个回调：

### `beforeCommit(readOnly)`

在真正提交前执行。此时事务尚未提交，如果回调抛异常，会中止提交并走 `doRollbackOnCommitException`。

适用场景：乐观锁版本校验，希望在提交前做最后的检查。

### `beforeCompletion()`

在真正提交前被调用，作为提交动作之前的最后准备。要注意，它发生在 `doCommit` 之前，但它本身不参与“是否提交”的决策；真正能够通过抛异常中止提交的回调是 `beforeCommit`。`beforeCompletion` 主要用于做与提交结果无关的清理或准备工作。

### `afterCommit()`

在 `conn.commit()` 成功之后执行，是“事务确认成功”的那个回调点。

适用场景：发消息、发事件、刷新缓存、调用外部系统。

### `afterCompletion(status)`

在事务完成时执行，无论成功还是失败。

适用场景：清理资源、释放锁、埋点记录。

### `flush()`

用于 Hibernate 这类需要显式 flush 的持久化技术。

## 三、commit 路径的精确顺序

`commit` 的完整顺序是：

```text
triggerBeforeCommit
   -> triggerBeforeCompletion
   -> doCommit（真正提交数据库）
   -> triggerAfterCommit
   -> triggerAfterCompletion(STATUS_COMMITTED)
```

其中 `doCommit` 是真正的 `conn.commit()`。

设计要点：

- `beforeCommit` 在提交前，抛异常会中止提交
- `afterCommit` 在提交成功之后，是“成功后必须做”的唯一时点
- `afterCompletion` 始终执行，无论最终状态是 COMMITTED 还是 ROLLED_BACK

## 四、rollback 路径的顺序

`rollback` 的完整顺序是：

```text
triggerBeforeCompletion
   -> doRollback
   -> triggerAfterCompletion(STATUS_ROLLED_BACK)
```

rollback 路径不会调用 `beforeCommit` 和 `afterCommit`。因此，只有 `afterCompletion` 会在任何结局都执行。

## 五、为什么 `afterCommit` 与 `afterCompletion` 必须分离

如果只提供一个回调：

- 放在提交前：执行的时机太早，事务可能随后被回滚
- 放在提交后：无法区分“成功”和“失败”，接收方不知道事务到底成没成

分离之后：

- `afterCommit` 只在提交成功时触发，适合“成功了才做”的动作
- `afterCompletion` 在任何结局都触发，适合“无论如何都做”的动作

这种分离正是“事务成功后发 MQ 不丢失”模式的基石。

## 六、嵌套事务中的同步回调时机

在 `REQUIRES_NEW` 场景下，每个事务层级都有独立的同步集合。内层同步器在**内层提交时**触发，外层同步器在**外层提交时**触发。

在纯 `REQUIRED` 嵌套场景下，内层共享外层事务，回调只在最外层提交时触发一次。

这解释了为什么“外层成功、内层已提交”时，同步回调的时序容易混淆——它们并不总在某一个时间点统一触发。

## 七、关于 `@TransactionalEventListener`

`@TransactionalEventListener(phase = AFTER_COMMIT)` 建立在整套 `TransactionSynchronization` 回调机制之上：`AFTER_COMMIT` 由同步器的 `afterCommit()` 回调处理，`AFTER_ROLLBACK` 和 `AFTER_COMPLETION` 由 `afterCompletion(status)` 处理。如果事务回滚，`AFTER_COMMIT` 事件不会被发布。

因此 `@TransactionalEventListener` 比手动注册 `TransactionSynchronization` 更简洁，但底层依赖的仍是这套 5 回调机制。

## 八、几个最容易错的判断

### 1. 事务方法返回后，同步器就会立即执行回调

不成立。

回调在 `commit` / `rollback` 内部的生命周期时点触发，而不是方法返回时。

### 2. `afterCommit` 和 `afterCompletion` 只在提交时都执行

不成立。

`afterCommit` 只在提交成功时执行；`afterCompletion` 在任何结局都执行。

### 3. 在 `beforeCommit` 里发消息是安全的

不成立。

`beforeCommit` 在事务真正提交前执行，如果随后回滚，消息就白发了。

### 4. 嵌套事务中，内层方法返回时同步器就会触发

不准确。

`REQUIRES_NEW` 内层在自身提交时触发；纯 `REQUIRED` 嵌套只在最外层提交时触发一次。

### 5. `@TransactionalEventListener` 是另一套独立机制

不准确。

它建立在 `TransactionSynchronization` 回调机制之上，是对 5 回调机制的封装。

## 收网：`TransactionSynchronization` 统一的不是“再发一次通知”，而是“在提交/回滚的精确时点表达三种不同语义”

现在可以回到开头的问题：为什么事务“提交成功后才发 MQ”是安全的？

因为 Spring 用 `TransactionSynchronizationManager` 的 ThreadLocal 管理同步器集合，在 `AbstractPlatformTransactionManager.commit` 的成功路径中明确保留了 `triggerAfterCommit` 回调点：

```text
triggerBeforeCommit
   -> triggerBeforeCompletion
   -> doCommit
   -> triggerAfterCommit
   -> triggerAfterCompletion
```

`afterCommit` 在真正 `conn.commit()` 成功之后执行，因此“只有事务真正提交成功才发消息”这一语义被精确落实。

因此，这篇真正该带走的结论是：

**Spring 把事务后动作问题从“什么时候发消息、什么时候清理资源”提升成了“用 ThreadLocal 管理同步器集合，并用 commit/rollback 路径上的 5 个回调钩子精确表达成功、失败与无论如何三类时机”的声明式事务同步协议。**

这也为下一篇打下了基础：既然事务主链、传播、异常翻译、事务同步都讲透了，那 `JdbcTemplate` 是如何一层层封装 JDBC 样板代码，把 `SQLException` 自动翻译进 `DataAccessException` 体系的？

下一篇进入 Spring 的 `JdbcTemplate` 模板方法主线。