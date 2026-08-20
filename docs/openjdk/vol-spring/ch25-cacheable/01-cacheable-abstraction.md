# 为什么 `@Cacheable` 能把方法调用“截住”并复用结果：Spring 缓存抽象的 execute 模板方法与后端解耦

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring `@Cacheable` / `@CacheEvict` / `@CachePut` 主线：`@EnableCaching` 如何注册 `CacheInterceptor`，`CacheAspectSupport.execute()` 这套模板方法如何固定“先查缓存、再执行方法、最后写缓存”的生命周期，`CacheManager` 与 `KeyGenerator` 又如何把物理存储和 key 生成与业务代码解耦，以及 `condition` / `unless`、`sync` 这些边界语义在哪里求值。

## 为什么 `@Cacheable` 不是“缓存几个返回值”，而是“把方法调用放进一条固定的缓存生命周期”

前面 `@Async` 和 `@Scheduled` 已经展示了 Spring 如何用 BPP + AOP 拦截方法。

`@Cacheable` 同样是一个典型方法拦截场景：

- 方法上写好注解
- 调用时被拦截
- 拦截器决定是走缓存还是执行方法

但 `@Cacheable` 和 `@Async` 有本质区别：

- `@Async` 改变的是“方法在哪里执行”
- `@Cacheable` 改变的是“方法是否真的要被执行一次”

也就是说，缓存抽象真正要组织的是：

- 什么时候查缓存
- 什么时候执行方法
- 什么时候把结果写回缓存

这三个时机如果散落在每个业务方法里，应用代码就会被缓存逻辑污染，也无法在换缓存后端时保持稳定。

第一层问题是：**Spring 缓存抽象必须把方法调用的“缓存生命周期”固定成骨架，同时把“缓存放哪里”留给可替换策略。**

这是整篇最关键的一层。

因为 `@Cacheable` 的价值并不在于“能用”，而在于：

- 同一套注解可以跑在本地 `ConcurrentMapCacheManager` 上
- 也可以跑在 Caffeine、Redis 等不同后端上
- 业务方法本身完全不需要关心后端是谁

这种解耦之所以成立，正是因为有模板方法层的存在。

第二层问题是：**缓存 key 生成不能简单等于方法名，否则不同参数会被同一个缓存条目污染。**

`getUser(1)` 和 `getUser(2)` 必须命中不同的缓存条目。

也就是说，key 生成必须至少包含方法参数，否则会返回完全错误的缓存结果。Spring 的默认生成器按参数生成 key，开发者也可以用 SpEL 指定。

第三层问题是：**`@CacheEvict`、`@CachePut` 和 `@Cacheable` 不是三个孤立注解，它们的执行时机是同一条模板骨架里的固定位置。**

这说明：

- 缓存清理可能在方法执行前，也可能在成功后
- 缓存写入通常依赖方法返回值
- 这些时机差异由“是否依赖返回值”决定

因此，本文真正要回答的问题不是“`@Cacheable` 注解怎么用”，而是：

**为什么 Spring 缓存抽象必须被拆成“固定 execute 模板方法 + 可替换 CacheManager / KeyGenerator 策略”，才能让缓存生命周期、物理存储和 key 生成彼此解耦？**

## 先看失败方案：为什么不能在业务方法里直接做缓存、把 key 设成方法名、把所有注解用同一个时机

### 失败方案一：在每个方法里手工做缓存的查、执行、写回

这种写法表面上最直接：

```java
User u = cache.get(id);
if (u == null) {
    u = queryDb(id);
    cache.put(id, u);
}
return u;
```

问题在于：

- 每个方法都要重复这套样板
- 缓存逻辑和业务逻辑强耦合
- 换缓存后端时，所有业务方法都要跟着改

Spring 之所以用拦截器和模板方法，就是为了把“缓存的查/执行/写回”整体抽出去，让业务方法只保留真正的业务逻辑。

### 失败方案二：缓存 key 直接用方法名

如果所有调用都用同一个 key，例如方法名，那么：

- `getUser(1)` 第一次查询后把结果放进 key "getUser"
- `getUser(2)` 直接命中同一个 key，返回用户 1 的数据

这是非常危险的错误缓存。

所以 Spring 的默认 key 必须包含参数，这也是为什么默认 `SimpleKeyGenerator` 会按参数生成 key。

### 失败方案三：`@Cacheable`、`@CachePut`、`@CacheEvict` 都用同一个时机

如果三种注解不区分时机，缓存生命周期会非常不可预期。

例如：

- 缓存写入可能发生在一个方法即使抛异常也不该缓存的时候
- 缓存清理可能发生在方法成功前，导致方法抛出异常时缓存已被错误清空

因此 Spring 必须把它们放到模板方法固定骨架的不同位置，再由每个注解的属性决定是否依赖方法返回值。

## `@Cacheable` 主线的最小总图

```text
@EnableCaching
   -> CachingConfigurationSelector
   -> ProxyCachingConfiguration
   -> CacheInterceptor (implements MethodInterceptor)
   -> CacheAspectSupport.execute(...)
   -> processCacheEvicts (beforeInvocation)
   -> findCachedValue
   -> evaluate (invoke operation + collect put requests)
   -> processCacheEvicts (afterInvocation)
```

## 一、`@EnableCaching`：与 `@EnableAsync` 相同的导入模式，产出不同的拦截器

`@EnableCaching` 通过 `@Import(CachingConfigurationSelector)` 导入缓存配置，最终注册 `CacheInterceptor`。

这里最值得强调的一点是：

- `@EnableAsync` 注册 `AsyncAnnotationBeanPostProcessor` 来创建异步代理
- `@EnableCaching` 注册 `CacheInterceptor`（实现 AOP MethodInterceptor）来拦截缓存方法

这两者走的是同样的“注解驱动 + AOP 拦截”模式，但实现方式不同：

- 异步核心在 `BeanPostProcessor` + Advisor
- 缓存核心在 `CacheAspectSupport` 的模板方法和缓存操作上下文

因此，`@EnableCaching` 真正做的不是打开一个缓存开关，而是：

**把缓存拦截器安装进 AOP 代理体系，让带缓存注解的方法在调用时进入缓存执行管线。**

## 二、`CacheAspectSupport.execute()`：缓存生命周期的模板方法

`CacheInterceptor.invoke()` 会把目标方法调用交给继承的 `CacheAspectSupport.execute(...)`。

`execute()` 不只是“查一下缓存再调方法”，而是一套模板骨架，固定了缓存操作的生命周期顺序：

1. 解析当前方法的缓存操作上下文
2. 处理 `beforeInvocation=true` 的清理
3. 查找 `@Cacheable` 的缓存值
4. 命中则返回，未命中进入评估
5. 执行目标方法
6. 收集并执行新的缓存写入请求
7. 处理方法成功后的清理

这套模板最重要的价值是：

- **把“什么时候查、什么时候执行、什么时候写”固定成骨架**
- 而“缓存在哪里、key 怎么生成”留给策略

也就是说，业务代码不需要关心缓存后端的实现差异。

## 三、`CacheManager` 与 `KeyGenerator`：物理存储与 key 生成的策略解耦

`CacheManager` 解决“缓存在哪里”：

- `ConcurrentMapCacheManager` 本地内存
- Caffeine
- Redis
- 各种自定义缓存

`CacheResolver` 根据缓存名解析出实际 `Cache`。

`KeyGenerator` 解决“缓存条目如何区分”：

- 默认按参数生成 key
- 可以用 `@Cacheable(key = "#id")` 自定义

一个 `@Cacheable(value = "users", key = "#id")` 可以不改业务代码地切换后端，因为后端差异全部被 `CacheManager` 隔离。

这也是缓存抽象最大的设计价值：

**模板方法层固定生命周期，策略层决定物理存储和 key 生成。**

## 四、`@Cacheable` 的命中 / 未命中分流

调用 `userService.getUser(1)` 时：

- `findCachedValue()` 遍历 `@Cacheable` 操作
- 通过 `condition` 和 key 计算缓存 key
- 调用 `cache.doGet(key)` 查找

命中：

- 直接返回缓存值
- 不执行目标方法

未命中：

- 进入 `evaluate`
- 执行目标方法
- 收集写入请求并写回缓存

第一次查询 userId=1 走 DB，第二次 userId=1 命中缓存。

关键点在于，这个分流不是业务代码里的 if/else，而是模板方法里的固定位置。

## 五、`@CacheEvict` 与 `@CachePut`：时机差异由“是否依赖返回值”决定

`@CachePut` 总是执行方法并缓存结果，不检查缓存是否存在，所以它依赖返回值。

`@CacheEvict` 默认在方法成功后清理缓存，也可以用 `beforeInvocation=true` 提前清理。

为什么要区分时机？

- 清理操作如果并不依赖方法结果，用 `beforeInvocation=true` 可以在方法失败前就把缓存清掉，防止失败后缓存残留
- 写入操作依赖返回值，只能在方法执行后收集和写入

所以：

- `beforeInvocation=true` 的 evict 在方法执行前处理
- 依赖返回值的 put / afterInvocation evict 在 `evaluate` 内处理

## 六、`condition` 与 `unless`：两个不同阶段的过滤条件

`condition` 是方法执行前判断：

- 满足条件才查缓存、才可能缓存
- 不满足则跳过缓存检查，直接执行方法且不缓存

`unless` 是方法执行后判断：

- 只有拿到 `#result` 才能判断
- 不满足则跳过缓存存储，但方法已经执行

一个常见的例子：

```java
@Cacheable(value = "users", key = "#id", unless = "#result == null")
```

返回值是 null 时不写缓存，所以下次调用仍会查询 DB。

这两个关键点是 Spring 缓存语义的常见陷阱，必须用“执行前 / 执行后”来区分。

## 七、`sync=true`：缓存穿透与并发保护

`@Cacheable(sync = true)` 会在缓存访问上增加同步语义，让：

- 缓存穿透时只有一个线程真正执行方法
- 其他线程等待结果并复用缓存

这是对高并发场景常见穿透问题的防护。

但固定 submit 时需要注意，`sync` 的语义依赖后端 Cache 是否支持原子性的 load-if-absent。不是所有 Cache 实现都具备相同的并发填充语义。

## 八、为什么这篇必须放在 `@Async` 之后

`@Cacheable` 与 `@Async` 共享了很多基础设施模式：

- 通过 `@Enable*` 导入配置
- 通过 AOP 拦截器包装方法调用
- 通过执行器或缓存管理器解耦物理层

但 `@Cacheable` 引入了新的模板生命周期（查缓存 → 执行 → 写缓存），这与 `@Async` 的“提交任务 → 立即返回”完全不同。放在 `@Async` 之后，读者能先理解 AOP 拦截器和注解驱动的通用模式，再理解缓存执行模板的专门逻辑。

## 九、几个最容易错的判断

### 1. `@Cacheable` 会自动缓存所有方法

不成立。

只有方法上的缓存操作被拦截，且缓存逻辑需要 `CacheManager` 和 key 生成配合才能成立。

### 2. 缓存 key 直接用方法名就行

不成立。

必须包含参数，否则不同参数会命中同一错误缓存条目。

### 3. `@CachePut` 会先检查缓存再执行方法

不成立。

它总是执行方法并缓存结果，不跳过执行。

### 4. `condition` 和 `unless` 都是方法执行后判断

不成立。

`condition` 在执行前判断，`unless` 在执行后判断并依赖 `#result`。

### 5. `sync=true` 保证任何缓存后端都具备相同并发填充行为

需谨慎。

`sync` 依赖后端缓存是否支持原子 load-if-absent 语义。

## 收网：`@Cacheable` 统一的不是“缓存几个返回值”，而是“缓存生命周期模板 + 物理存储/键生成策略解耦”

现在可以回到开头的问题：为什么 `@Cacheable` 不能直接在业务方法里做缓存？

因为 Spring 真正要解决的不是“缓存几个返回值”，而是：

- 缓存查、执行、写回的生命周期如何固定成骨架
- 缓存后端如何通过 `CacheManager` 解耦
- key 生成如何通过 `KeyGenerator` 和解耦
- 清理和写入时机如何由模板方法定义

所以 Spring 的缓存主线可以压缩成：

```text
@EnableCaching
   -> CacheInterceptor
   -> CacheAspectSupport.execute(...) 模板方法
   -> CacheManager / CacheResolver 物理存储
   -> KeyGenerator 缓存键生成
   -> @Cacheable / @CacheEvict / @CachePut 操作分发
```

因此，这篇真正该带走的结论不是“Spring 支持 `@Cacheable`”，而是：

**Spring 把缓存问题从“怎么在方法里缓存返回值”提升成了“缓存查、执行、写回生命周期与存储/key 生成策略解耦”的容器级抽象。**

这也就解答了为什么同一个 `@Cacheable` 注解可以从单机到分布式切换，而业务代码却被完整保留。