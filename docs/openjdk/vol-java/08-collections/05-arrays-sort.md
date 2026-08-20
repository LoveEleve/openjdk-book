# Arrays 与排序：同样叫 sort，为什么 JDK 要走两条完全不同的路

> 本文基于 JDK 11 `Arrays`、`DualPivotQuicksort`、`TimSort` 源码。重点讨论对象与基本类型排序分流、`binarySearch`、`copyOf` 与 `parallelSort` 的工程取舍；不展开完整证明、`ForkJoinPool` 细节和所有 companion class 的全部实现。本文讨论的是 JDK 11 `Arrays` 在排序与复制上的工程分流，不把这里的 DPQ/TimSort 取舍、未排序前提和并行阈值策略外推成所有数组库都必须遵守的统一规范。
> **前置依赖**：[ArrayList 与动态数组](01-arraylist.md)、[System.arraycopy 与运行时复制](../03-object-system/02-system-runtime.md)
> **后续**：[Collections 工具与包装器](06-collections.md)

## 真正该先问的，不是“JDK 用了什么排序”，而是“为什么不统一”

很多人第一次背 `Arrays.sort`，会记住两个结论：

- 基本类型数组走双轴快排；
- 对象数组走 TimSort。

这两个事实没错，但如果只停在“题库答案”，就会漏掉最关键的一层：**为什么同样叫 `sort`，JDK 不统一用一种算法？**

原因很简单，也非常工程化：不同数据类型对排序的要求并不一样。

- 基本类型排序只关心值本身，稳定性几乎没有业务意义；
- 对象排序经常要保留“相等键的原有次序”，稳定性会直接影响多关键字排序结果；
- 对象比较本身往往比基本类型比较更贵，更值得利用“数据已经部分有序”这类现实信息。

JDK 没有为了“接口名字统一”而强行走一条算法路线，而是直接按数据语义分流。这正是 `Arrays` 这一章真正值得学的东西：**同名 API 背后，不同数据会触发不同的工程优化目标。**

## 一、基本类型排序为什么优先走 Dual-Pivot Quicksort

### `Arrays.sort(int[])` 的入口非常直接

JDK 11 的 `Arrays.sort(int[])` 几乎没有绕路：

```java
// Arrays.java:146-148
public static void sort(int[] a) {
    DualPivotQuicksort.sort(a, 0, a.length - 1, null, 0, 0);
}
```

这说明基本类型数组排序的公开入口就是把任务交给 `DualPivotQuicksort`。但这还只是第一层表象。

### JDK 11 的 DPQ 不是“纯快排”，而是一条混合工程路径

`DualPivotQuicksort` 里一开始就把多个阈值常量摆出来了：

```java
// DualPivotQuicksort.java:58-85
/**
 * The maximum number of runs in merge sort.
 */
private static final int MAX_RUN_COUNT = 67;

/**
 * If the length of an array to be sorted is less than this
 * constant, Quicksort is used in preference to merge sort.
 */
private static final int QUICKSORT_THRESHOLD = 286;

/**
 * If the length of an array to be sorted is less than this
 * constant, insertion sort is used in preference to Quicksort.
 */
private static final int INSERTION_SORT_THRESHOLD = 47;

private static final int COUNTING_SORT_THRESHOLD_FOR_BYTE = 29;
private static final int COUNTING_SORT_THRESHOLD_FOR_SHORT_OR_CHAR = 3200;
```

这几行已经说明一个关键信息：JDK 11 的基本类型排序并不是“永远双轴快排到底”，而是按数组规模、数据类型和局部结构，动态切换不同路径。

也就是说，正确的理解不是：

```text
基本类型排序 = 纯双轴快排
```

而是：

```text
基本类型排序
   → 以 Dual-Pivot Quicksort 为主干
   → 小数组时切插入排序
   → 某些值域小的类型会切计数排序
   → 大数组且近乎有序时还会利用 run 走归并路径
```

### 小数组为什么不硬上快排

在 `sort(int[] ...)` 的内部实现里，JDK 11 第一件事就是看规模：

```java
// DualPivotQuicksort.java:102-107
static void sort(int[] a, int left, int right,
                 int[] work, int workBase, int workLen) {
    // Use Quicksort on small arrays
    if (right - left < QUICKSORT_THRESHOLD) {
        sort(a, left, right, true);
        return;
    }
```

更小的数组还会继续走向插入排序阈值。原因不是复杂度课本变了，而是工程上常数更重要：数组很小时，递归分区、pivot 选择和多层逻辑的固定成本，反而可能比简单排序更贵。

所以这里体现的是一个很典型的 JDK 思路：**理论上更“高级”的算法，不一定在所有规模下都更划算。**

### 大数组时还会先检测是否“几乎有序”

真正容易被忽略的，是 DPQ 并不死磕“无脑分区”。它会先扫描 run，也就是一段段天然升序或降序的局部有序片段：

```java
// DualPivotQuicksort.java:117-147
// Check if the array is nearly sorted
for (int k = left; k < right; run[count] = k) {
    while (k < right && a[k] == a[k + 1])
        k++;
    if (k == right) break;
    if (a[k] < a[k + 1]) {
        while (++k <= right && a[k - 1] <= a[k]);
    } else if (a[k] > a[k + 1]) {
        while (++k <= right && a[k - 1] >= a[k]);
        for (int lo = run[count] - 1, hi = k; ++lo < --hi; ) {
            int t = a[lo]; a[lo] = a[hi]; a[hi] = t;
        }
    }
    if (run[count] > left && a[run[count]] >= a[run[count] - 1]) {
        count--;
    }
    if (++count == MAX_RUN_COUNT) {
        sort(a, left, right, true);
        return;
    }
}
```

这段代码表达的思想非常现代：真实数据不一定是纯随机的。它可能已经有不少局部有序段，如果能利用这些 run，就没必要完全按随机数据最坏方式处理。

后面一旦走到归并工作区，就说明它已经不再是“单纯双轴快排”，而是进入了另一条更适合近乎有序数据的路径：

```java
// DualPivotQuicksort.java:175-215
int[] b;
int ao, bo;
int blen = right - left;
if (work == null || workLen < blen || workBase + blen > work.length) {
    work = new int[blen];
    workBase = 0;
}
if (odd == 0) {
    System.arraycopy(a, left, work, workBase, blen);
    b = a;
    bo = 0;
    a = work;
    ao = workBase - left;
} else {
    b = work;
    ao = 0;
    bo = workBase - left;
}

for (int last; count > 1; count = last) {
    for (int k = (last = 0) + 2; k <= count; k += 2) {
        int hi = run[k], mi = run[k - 1];
        for (int i = run[k - 2], p = i, q = mi; i < hi; ++i) {
            if (q >= hi || p < mi && a[p + ao] <= a[q + ao]) {
                b[i + bo] = a[p++ + ao];
            } else {
                b[i + bo] = a[q++ + ao];
            }
        }
        run[++last] = hi;
    }
```

因此，JDK 11 的 DPQ 更准确的说法应该是：**以双轴快排为主线，但为了真实数据和常数因子做了大量混合优化。**

### 基本类型为什么可以接受“不稳定”

这条路线之所以成立，还有一个前提：基本类型排序通常不需要稳定性。

对对象来说，“两个元素比较结果相等，但它们本身是不同对象”很常见；对 `int` 来说，两个值一样就是一样，稳定不稳定通常没有业务区别。

所以基本类型排序可以更自由地追求：

- 更低的比较和交换常数；
- 更好的缓存表现；
- 更激进的分区和阈值混合。

## 二、对象排序为什么改走 TimSort

### `Arrays.sort(Object[])` 入口一开始就强调稳定性

JDK 11 的对象排序入口是另一条完全不同的路：

```java
// Arrays.java:1245-1249
public static void sort(Object[] a) {
    if (LegacyMergeSort.userRequested)
        legacyMergeSort(a);
    else
        ComparableTimSort.sort(a, 0, a.length, null, 0, 0);
}
```

而它紧接着就把稳定性和自适应性写进了文档：

```java
// Arrays.java:1271-1282
 * <p>This sort is guaranteed to be <i>stable</i>:  equal elements will
 * not be reordered as a result of the sort.
 *
 * <p>Implementation note: This implementation is a stable, adaptive,
 * iterative mergesort that requires far fewer than n lg(n) comparisons
 * when the input array is partially sorted, while offering the
 * performance of a traditional mergesort when the input array is
 * randomly ordered.  If the input array is nearly sorted, the
 * implementation requires approximately n comparisons.  Temporary
 * storage requirements vary from a small constant for nearly sorted
 * input arrays to n/2 object references for randomly ordered input
 * arrays.
```

这段注释几乎已经把对象排序选 TimSort 的理由全说完了：

- 稳定；
- 自适应；
- 最坏边界可靠；
- 真实数据越接近有序，收益越明显。

### TimSort 的目标本来就和对象排序特别合拍

`TimSort` 自己的类注释也开宗明义：

```java
// TimSort.java:29-36
 * A stable, adaptive, iterative mergesort that requires far fewer than
 * n lg(n) comparisons when running on partially sorted arrays, while
 * offering performance comparable to a traditional mergesort when run
 * on random arrays.  Like all proper mergesorts, this sort is stable and
 * runs O(n log n) time (worst case).  In the worst case, this sort requires
 * temporary storage space for n/2 object references; in the best case,
 * it requires only a small constant amount of space.
```

为什么这和对象排序特别合拍？因为对象排序最常见的两个现实需求，恰好就是 TimSort 最擅长服务的：

1. 相等键要保序，也就是稳定性；
2. 真实对象数组常常不是随机乱序，而是已经局部有序。

比如：

- 数据库结果按时间先排过一次，再按优先级重排；
- 日志、订单、任务列表天然带有大段已排序区间；
- 比较器本身代价不低，更应该避免不必要的比较。

### TimSort 从一开始就在找 run

TimSort 不是“先假设完全乱序，再无差别分治”。它的出发点就是：先看看数组里已经存在多少可利用的有序段。

它还专门定义了最小合并 run 长度：

```java
// TimSort.java:63-80
/**
 * This is the minimum sized sequence that will be merged.  Shorter
 * sequences will be lengthened by calling binarySort.  If the entire
 * array is less than this length, no merges will be performed.
 *
 * This constant should be a power of two.  It was 64 in Tim Peter's C
 * implementation, but 32 was empirically determined to work better in
 * this implementation.
 */
private static final int MIN_MERGE = 32;
```

数组很小时，甚至先走一个 mini-TimSort：

```java
// TimSort.java:214-220
int nRemaining  = hi - lo;
if (nRemaining < 2)
    return;

// If array is small, do a "mini-TimSort" with no merges
if (nRemaining < MIN_MERGE) {
    int initRunLen = countRunAndMakeAscending(a, lo, hi, c);
```

这说明 TimSort 的思路不是“从 0 开始制造秩序”，而是“先识别已有秩序，再尽量顺着它做最少工作”。

### 对象排序真正看重的，不只是复杂度表

如果只盯着 O(n log n)` 这类课本复杂度，可能会误以为“既然都能做到对数级，选谁都差不多”。但对对象排序来说，稳定性和现实数据的局部有序性，往往比表面复杂度更重要。

所以对象排序走 TimSort，不是因为它“比快排更高级”，而是因为它更符合对象排序的真实语义和数据特征。

## 三、两条路线不是高低之分，而是优化目标不同

到这里要特别防止另一种误解：既然 TimSort 有稳定性、最坏 O(n log n)`，是不是它全面更强，只是 JDK 出于历史原因还给基本类型保留快排？

答案不是。

JDK 的分流恰恰说明没有一种排序能同时把所有目标都做到最优。

```text
基本类型排序
   → 稳定性无业务意义
   → 追求速度、分区效率、缓存友好
   → 可以大胆选 DPQ 混合路径

对象排序
   → 稳定性有业务意义
   → 比较器更贵，数据更可能部分有序
   → 更值得选 TimSort
```

因此，JDK 的设计不是“谁更高级”，而是“谁更适合当前数据语义”。这也是理解 `Arrays.sort` 最重要的那层抽象。

## 四、`binarySearch` 为什么快，但前提极其苛刻

### JDK 把前提直接写进了契约里

二分查找的入口很短：

```java
// Arrays.java:1866-1867
public static int binarySearch(int[] a, int key) {
    return binarySearch0(a, 0, a.length, key);
}
```

但它的文档紧接着就强调了最关键的一句：**区间必须预先排好序，否则结果未定义。**

```java
// Arrays.java:1874-1879
 * The range must be sorted (as
 * by the {@link #sort(int[], int, int)} method)
 * prior to making this call.  If it
 * is not sorted, the results are undefined.  If the range contains
 * multiple elements with the specified value, there is no guarantee which
 * one will be found.
```

这句话不是客套提醒，而是性能契约的一部分。因为二分查找之所以能在 O(log n)` 时间里定位，就是建立在“左边整体更小、右边整体更大”这个全局有序前提上。

如果 JDK 先替你验证数组是否有序，那这个 API 就不再是二分查找本来的成本模型了。

### 二分内部根本不做防呆检查

JDK 的内部实现也完全遵守这个契约：

```java
// Arrays.java:1909-1925
private static int binarySearch0(int[] a, int fromIndex, int toIndex,
                                 int key) {
    int low = fromIndex;
    int high = toIndex - 1;

    while (low <= high) {
        int mid = (low + high) >>> 1;
        int midVal = a[mid];

        if (midVal < key)
            low = mid + 1;
        else if (midVal > key)
            high = mid - 1;
        else
            return mid;
    }
    return -(low + 1);
}
```

它只管信任前提、执行二分，然后用返回值表达“找到”或“应该插入的位置”。未排序时，它不会替你喊停，只会按错误前提给出错误结果。

所以 `binarySearch` 的正确使用心智应该是：

```text
先确保已排序
   → 再二分

如果前提不成立
   → 速度优势保不住
   → 结果也不可信
```

## 五、`copyOf` 为什么是复制边界，而不是共享视图

### 这个 API 同时承担扩容、截断和防御性复制

`copyOf` 表面上像一个简单工具方法，实际上它把三件非常常见的数组需求统一起来了：

- 扩容；
- 截断；
- 复制一份新数组，隔离原始存储。

对象数组版本的入口很短：

```java
// Arrays.java:3688-3690
public static <T> T[] copyOf(T[] original, int newLength) {
    return (T[]) copyOf(original, newLength, original.getClass());
}
```

```java
// Arrays.java:3716-3724
@HotSpotIntrinsicCandidate
public static <T,U> T[] copyOf(U[] original, int newLength, Class<? extends T[]> newType) {
    T[] copy = ((Object)newType == (Object)Object[].class)
        ? (T[]) new Object[newLength]
        : (T[]) Array.newInstance(newType.getComponentType(), newLength);
    System.arraycopy(original, 0, copy, 0,
                     Math.min(original.length, newLength));
    return copy;
}
```

这里最重要的不是“它调用了 `System.arraycopy`”，而是：**返回的是一份新的数组。** 这意味着后续对返回数组的修改，不会反向污染原数组。

### 超出的部分怎么补，全按数组类型来

对象数组补 `null`，基本类型补零值。比如 byte 数组版本：

```java
// Arrays.java:3727-3748
/**
 * Copies the specified array, truncating or padding with zeros (if necessary)
 * so the copy has the specified length.
 */
public static byte[] copyOf(byte[] original, int newLength) {
    byte[] copy = new byte[newLength];
    System.arraycopy(original, 0, copy, 0,
                     Math.min(original.length, newLength));
    return copy;
}
```

这也是为什么 `copyOf` 很适合出现在：

- 容量扩展；
- API 边界防御性复制；
- 需要把一段已有数据“封成独立数组”的场景。

它不是 view，也不是共享窗口；它就是一份新数组。

## 六、`parallelSort` 为什么不对所有数组都默认开并行

### JDK 先把“不值得并行”的情况挡掉

很多人看到并行排序，会下意识觉得“多核当然更快”。JDK 11 没这么乐观。

它一开始就定义了一个最小粒度阈值：

```java
// Arrays.java:76-82
/**
 * The minimum array length below which a parallel sorting
 * algorithm will not further partition the sorting task.
 */
private static final int MIN_ARRAY_SORT_GRAN = 1 << 13;
```

`parallelSort(int[])` 的入口也非常务实：

```java
// Arrays.java:675-685
public static void parallelSort(int[] a) {
    int n = a.length, p, g;
    if (n <= MIN_ARRAY_SORT_GRAN ||
        (p = ForkJoinPool.getCommonPoolParallelism()) == 1)
        DualPivotQuicksort.sort(a, 0, n - 1, null, 0, 0);
    else
        new ArraysParallelSortHelpers.FJInt.Sorter
            (null, a, new int[n], 0, n, 0,
             ((g = n / (p << 2)) <= MIN_ARRAY_SORT_GRAN) ?
             MIN_ARRAY_SORT_GRAN : g).invoke();
}
```

也就是说，只要满足下面任一条件，它就直接退回串行排序：

- 数组太小，不值得拆；
- 公共线程池并行度只有 1，根本没法有效并起来。

这说明 JDK 对并行排序的态度非常明确：**并行不是默认红利，而是大任务规模下才值得支付的额外工程成本。**

### 因为并行排序不只是“多几个线程”

JDK 文档也把它说得很直白：并行排序本质上是 sort-merge，先拆段、各自排序，再合并，并且需要额外工作区和 `ForkJoinPool.commonPool()`。

```java
// Arrays.java:693-702
 * @implNote The sorting algorithm is a parallel sort-merge that breaks the
 * array into sub-arrays that are themselves sorted and then merged. When
 * the sub-array length reaches a minimum granularity, the sub-array is
 * sorted using the appropriate {@link Arrays#sort(int[]) Arrays.sort}
 * method. If the length of the specified array is less than the minimum
 * granularity, then it is sorted using the appropriate {@link
 * Arrays#sort(int[]) Arrays.sort} method. The algorithm requires a working
 * space no greater than the size of the specified range of the original
 * array. The {@link ForkJoinPool#commonPool() ForkJoin common pool} is
```

所以 `parallelSort` 的成本结构是：

```text
收益
   → 大数组可利用多核

代价
   → 任务拆分
   → 合并
   → 额外工作区
   → 竞争 commonPool 资源
```

这就是为什么“并行不总是更快”不是一句经验，而是 JDK 源码级别写死的阈值决策。

## 九、五个最容易混掉的边界：`sort` 同名不等于同路，DPQ 不是纯快排，TimSort 不是全面更强，`binarySearch` 不是会自检排序，`copyOf` 也不是视图

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`Arrays.sort` 同名不等于同一条算法路径。JDK 本来就在按数据语义分流：基本类型和对象排序面对的稳定性、比较成本、现实数据形态都不一样，所以它们不该被强行压成一套实现。

第二，Dual-Pivot Quicksort 也不是“两个 pivot 的纯快排定义”就讲完了。JDK 11 里的基本类型排序实际上是一条混合工程路径：小数组切插入排序，某些值域还会切计数排序，近乎有序时甚至会利用 run 走归并路线。

第三，TimSort 更不是“因为高级所以全面更强”。它真正适合的是对象排序那类需要稳定性、又经常带着局部有序现实数据的场景；如果把它抽离这些语义优势，只剩抽象复杂度比较，就会看错 JDK 分流的真正动机。

第四，`binarySearch` 也不是“快，所以 JDK 顺手会先帮你确认数组有序”。它正因为把已排序前提完全交给调用方，才能保住 O(log n)` 的查询成本。未排序时不报错而直接未定义，不是疏忽，而是性能契约的一部分。

第五，`copyOf` 更不是共享视图。它的意义就是明确复制出一份新数组，并在扩容时补默认值、在截断时切掉尾部。只要把它误当成视图，就会在封装边界和后续修改可见性上立刻出错。

把这五条边界记稳，`Arrays` 这一篇就不会重新塌回“记住两个排序算法名字”这种表面印象。它真正想讲的是：JDK 为什么愿意在同名 API 背后维护多条实现路线，以及这些路线分别在守什么语义边界。

## 收网：`Arrays` 的设计核心不是工具多，而是每个工具都把目标写得很清楚

现在回到这篇文章最开始的问题：为什么同样叫 `Arrays.sort`，JDK 要走两条完全不同的路？

因为排序从来不是“只要把顺序排出来就行”。不同数据对稳定性、比较代价、局部有序性和额外空间的要求不同。JDK 的分流，正是在承认这一点。

- 基本类型排序走 DPQ 混合路径，因为它更重视速度和工程常数，稳定性通常没有业务价值；
- 对象排序走 TimSort，因为稳定性和真实数据的部分有序性都很重要；
- `binarySearch` 借助排序前提换取 O(log n)` 速度；
- `copyOf` 用真实复制换取边界隔离和统一扩缩容语义；
- `parallelSort` 用阈值控制并行开销，避免“多线程一定更快”的幻觉。

把整篇压成一张图，就是：

```text
Arrays.sort
   ├── 基本类型 → Dual-Pivot Quicksort 混合路径
   └── 对象     → TimSort（稳定 + 自适应）

Arrays.binarySearch
   → 依赖“已排序”契约换速度

Arrays.copyOf
   → 返回新数组，承担扩容/截断/防御性复制

Arrays.parallelSort
   → 只在规模足够大时才值得并行
```

实际使用里，先记住四条：

1. **对象与基本类型走不同排序算法，不是历史偶然，而是语义需求不同。**
2. **`binarySearch` 快，是因为它严格信任“数组已排序”这个前提。**
3. **`copyOf` 返回的是新数组，不是共享视图。**
4. **`parallelSort` 不是默认更快，它受阈值、工作区和 commonPool 资源共同约束。**

下一篇进入 `Collections`：数组工具讲完之后，回到集合层的通用算法和三大包装器，看看为什么 `unmodifiable`、`synchronized`、`checked` 会成为防御式编程的常驻角色。

> → 下一篇：[Collections 工具与包装器](06-collections.md)
