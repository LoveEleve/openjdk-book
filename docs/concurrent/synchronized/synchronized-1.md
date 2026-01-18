# Synchronized浅析（1）：管程与 synchronized
## 管程概念
在之前的文章中,我简要的提到过管程的概念,管程概念的提出主要是为了降低开发者的难度,不需要在手动的利用低级的原语来保证代码的安全性,开发者只需要调用管程保留给我们的接口即可,而不需要关系内部具体的实现了。

在这里一个管程应该包含哪些部分呢？

1. 共享资源：条件判断
2. 操作函数：暴露给开发者调用的外部接口
3. 条件变量：

> 为什么需要条件变量？因为单纯的互斥是不够的，在某些情况下,某个线程进入到管程后发现继续往下执行的某些条件不满足,那么这个时候应该怎么办呢？如果不释放锁,那么很有可能造&#x6210;**<font style="color:rgb(216,57,49);">死锁</font>**
>
> 1. 以生产者消费者举例：生产线程获取了容器的访问权限(其他生产线程或者消费线程无法访问容器),当生产线程想要put元素的时候发现容器满了,这个时候如果不释放锁,那么消费者线程无法进行消费「也即生产者等待消费者获取锁并且take元素，而消费者在等待生产者释放锁」,这样就造成了死锁
>
> 既然这样，那当条件不满足的时候将锁释放了不就可以了吗?
>
> + 直接释放锁可以避免上面的问题，但是这又可能会造成另外一个问题：**<font style="color:rgb(216,57,49);">活锁</font>**(性能下降)
>
> 活锁：锁的竞争者很长一段时间内都无法获取锁进入到临界区
>
> 线程进入管程是不公平的,并不是FIFO,在上面的场景中,释放锁的生产者线程很可能会再次获取锁,这根本没有意义，因为它所等待的条件并没有被满足，它只能再次释放锁
>

所以基于上面两点：就引入了条件变量的概念 - 当获取锁的线程发现继续往下执行的条件不满足时,就释放锁并且阻塞在该条件变量上。

上面就是管程的一些基本概念,而基于管程又存在多种模型(目前最主流的就是MESA模型)&#x20;

## MESA模型
当线程挂起时,通常会进入到队列中等待,在管程的实现中,通常包含两种队列 - 入口队列和等待队列，入口队列中存储的是那些获取锁失败的线程，而等待队列中存储的则是获取锁成功后由于条件不满足而阻塞的线程(当然这里需要先释放锁)

这里就有一个问题：当生产者线程在等待队列中等待时,此时消费者消费了元素,也即满足了条件,这个时候需要去唤醒生产者线程吗？

基于这点就产生了不同的管程模型,这里会简单的介绍MESA模型,该模型也是目前主流的管程实现模型。

该模型的做法为：当条件被其他持有锁线程满足时,并不会直接去唤醒等待队列中的线程，而是选择将其从等待队列中移动到入口队列，然后与其他线程重新竞争。（从这里可以看出，AQS就是典型的MESA模型的具体实现）

这里在wiki中有做介绍(下面这张图是隐式条件变量管程的工作图),而synchronized就是这种实现(synchronized并不像AQS一样，可以显式的声明条件变量)

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=OGE4MWJhZDBkZjE0YTQ2NTYxNGI4ZGY2ODllMTc3MTFfS2l0OFNBV1dGOENLUE5tQXVwcUFhY3ExMmhkWmxIeUtfVG9rZW46S3pramIwU21xb0JWVjJ4S2VPbmNRWEFvbmNjXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

## synchronized
### 前言
前面说了管程有几个非常重要的部分：共享资源(具体来说是作为能否进入管程的条件)，方法，以及等待队列

先来看下ReentrantLock的是否包含这三部分：

1. 共享资源：state(AQS中的state)  
当state=0的时候代表锁还在,多个线程会竞争的设置这个值为1，只有设置成功的才会进入到管程中，而失败的则会进入到入口队列中「对应着AQS中的Node head,Node tail」
2. 方法：lock.lock()/unlock()/...
3. 等待队列：ConditionObject「Node firstWaiter,Node lastWaiter」

那么在研究synchronized的时候同样需要搞明白下面这些问题：方法就不用了,因为synchronized是内置锁,没有暴露的方法,暴露的是synchronized本身

1. 多个线程竞争的共享资源到底是什么?
2. 入口队列在哪里？
3. 等待队列在哪里?&#x20;
4. synchronized是不是MESA模型的一种实现呢?



### 使用
synchronized关键字有两种用法：方法 和 代码块

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NGU3Y2Q4OTM0N2NkNjQ2ODliMzdhNjJiZjhlN2JkZGFfYVo0dWs0Q05KcWRxYTdnUGVaR0RzN3EzSWpZTnZFOEJfVG9rZW46TFVlWGI2Z256b3VVVTB4aGt5RmNMT3NTbjBmXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

+ 简单示例

```java
public class SyncDemo {
    public static void main(String[] args) throws InterruptedException {
        SyncDemo object = new SyncDemo();
        synchronized (SyncDemo.class){
            System.out.println("synchronized (SyncDemo.class)");
        }
        synchronized (object){
            System.out.println("synchronized (object)");
        }
    }

    public synchronized void test(){
        System.out.println("instance method");
    }
    public synchronized static void test2(){
        System.out.println("static method");
    }
}

// 和ReentrantLock对比一下
public class RLDemo {
    public static void main(String[] args) {
        ReentrantLock lock = new ReentrantLock();
        try{
            lock.lock(); // 获取锁
            // todo
        }catch (Exception e){
            e.printStackTrace();
        }finally {
            lock.unlock(); // 释放锁
        }
    }
}
```

可以看到,ReentrantLock是使用lock()和unlock()来进行加锁和释放锁的,但是从synchronized的使用来看,根本看不出来synchronized做了什么。

需要将java代码转化为字节码后再来看：

```java
javac SyncDemo.java
javap -c -v SyncDemo.class
public class SyncDemo {
    public static void main(String[] args) throws InterruptedException {
    }

    public synchronized void test(){
        System.out.println("instance method");
    }
    public synchronized static void test2(){
        System.out.println("static method");
    }
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=Y2U0NjkzMDYzNWNhNTdjNjY1MzBiMTlmNjUzYWQ2N2RfN1JjYkM3QjFGQ3RzazZEOW15eFRzY09nMWNsM0FnNVZfVG9rZW46QXFrU2JGaDVsb2FsSmd4dE9WOGNTaVZ0blZnXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

可以看到对于方法来说,是在方法的flags上打上了ACC_SYNCHRONIZED标识,如果想要知道该标识是如何起作用的,则还需要进一步的探究当jvm执行方法的时候是如何处理这个标签的(关于jvm执行方法的原理,后续会单独出文章来讲解)

在这里直接简要地看一下jvm的源码

```cpp
case method_entry: {
    THREAD->set_do_not_unlock_if_synchronized(true);
    // Lock method if synchronized.
    if (METHOD->is_synchronized()) {
     // oop rcvr = locals[0].j.r;
     oop rcvr;
     if (METHOD->is_static()) { // 如果方法是静态的,则获取类对象
          rcvr = METHOD->constants()->pool_holder()->java_mirror();
        } else { // 否则获取局部变量表上的第一个元素 - 这个其实就是this,就是获取调用这个方法的实例对象
          rcvr = LOCALS_OBJECT(0);
        }
        
     // ...
    }
}

// METHOD->is_synchronized() 判断方法是否加锁,就是通过flag来判断的
bool is_synchronized() const                   
{ 
    return access_flags().is_synchronized();
}
```

> 这里看的是解释器的代码,并且可以看到在真正执行方法内部的逻辑之前,确实会对ACC_SYNCHRONIZED进行处理,并且这里还可以得到一个很重要的消息,那就是当方法是静态方法时,获取的对象是java_mirror对象,而方法是实例方法时,获取的则是实例对象(this/调用该方法的对象)
>

继续再看下当synchronized作用在代码块时的字节码

```java
public class SyncDemo {
    public static void main(String[] args) throws InterruptedException {
    }
    public void test(){
        synchronized (this){
        }
    }
    public void test2(){
        synchronized (SyncDemo.class){
        }
    }
}
/*
    可以看到这里当synchronized修饰不同的代码块时,生成的字节码也是不同的
    但是主要集中在下面几个字节码
*/
// 静态对象(静态代码块)
0: ldc           #2                  // class com/wjcoder/juc/SyncDemo
2: dup
3: astore_1
4: monitorenter
5: aload_1
6: monitorexit
 
//实例对象(实例代码块)
0: aload_0
1: dup
2: astore_1
3: monitorenter
4: aload_1
5: monitorexit
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NDIzYTM5OTY3NGQwNTdkY2IzMjk4YWFiNWYzY2M1MWJfbzRJS3JFUU5GMUJ4dEZvdUxGejB2T1d6TzlnZlRVMTNfVG9rZW46SDAxR2I4ZmU2bzI3MnV4N1lGZ2NkNVdEbnVmXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

下面就介绍一下这几个字节码

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NzdjODFhNGFlYzVjM2QyYTEwNTY0ZDU2ZTBiYmI2NWJfWnY2ZWU3S096VndsRU52NW1TQnZFY0pidHNkaWFXTW9fVG9rZW46SzJmU2JNcjBRb3ZYa014ZmpKZmNaTlIwbkViXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

从字节码的简单介绍来看下上面两个代码块都干了什么

```java
1.synchronized (this){}
aload_0: 将局部变量表索引0位置上的引用加载到操作数栈上「栈顶」(对于非静态方法来说,局部变量表默认第一个索引存储的就是this引用)
dup:复制栈顶的元素「现在栈上有两个this引用」
astore_1:将操作数栈顶的引用存储到局部变量表索引为1的位置上去
monitorenter:从操作数栈顶弹出对象引用(就是this引用)
2.synchronized(SyncDeno.class)
同理,不过此时monitorenter弹出的则是class对象(类对象)
```

经过上面的分析可以知道，synchronized起作用其实是依赖monitorenter和monitorexit这两条字节码指令的,

和ReentrantLock一样,它是依赖lock.lock()和lock.unlock()这两个方法来工作的,在之前的文章中讲解过lock()是如何保证同一时刻只有一个线程获取锁成功的「基本原理就是CAS设置state的值,CAS能够保证同一时刻有且只有一个线程能够设置成功」，那么在这里想要知道synchronized是如何保证线程安全的，那么答案应该就在monitorenter字节码中了。

除此之外还有另外一个现象,那就是monitorenter依赖一个对象(这个对象可能是实例对象「this」，或者是类对象)。

这里猜测一下,我们在上面讨论的管程中的共享资源在这里是否就是这个对象,但是在reetrantLock的实现中,cas的是一个state

> CAS(硬件提供的原子操作技术支持),其特点就是只能操作一个变量(或者说是一个内存地址),
>
> 那么在synchronized中,操作的是对象的什么属性呢？是整个对象都替换掉吗？还是对象中有专门的属性来代表对象锁呢？在jvm中对象到底是以什么样的形式存在呢？
>

### jvm相关
-- 简单介绍一下

```cpp
//share/oops/instanceOop.hpp
/*
    An instanceOop is an instance of a Java Class
    Evaluating "new HashTable()" will create an instanceOop.
    这段注释位于instanceOop.hpp类中
        - 一个instanceOop是Java类的实例(这不就是对象的概念吗？类是对象的模版,对象是类的实例)
        - 当执行new HashTable()的时候将会创建一个instanceOop对象(在jvm)中
    那么在java中创建一个对象时,在jvm中将会创建一个instanceOop对象
    下面看一下这个类的继承体系
*/
typedef class oopDesc*                    oop; // 顶层父类
typedef class   instanceOopDesc*            instanceOop; // 普通对象
typedef class     stackChunkOopDesc*          stackChunkOop; // jdk21支持协程,暂时不做了解
typedef class   arrayOopDesc*               arrayOop; // 数组对象
typedef class     objArrayOopDesc*            objArrayOop;
typedef class     typeArrayOopDesc*           typeArrayOop; 
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NmJiYTA0ZWNlOGNkZjM0OTVkZTM2Y2M4NjM1MWE3ZDhfcmp0UEU3d2drbHBIbmVhWWpxSkUxQVI0eEZicXNIRlVfVG9rZW46WEh1U2Ixelh6b1ZCeTZ4TEUzcmNpSTJobjhlXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

> 在面向对象的编程语言中,为什么要有继承呢？主要是为了复用,父类通常具有的是其子类都需要的功能,所以首先看一下顶级父类里面都有什么
>

```cpp
/*
share/oops/oop.hpp
下面看下核心属性:
*/
class oopDesc {
// ..
private:
    volatile markWord _mark;  // 标记字
    union _metadata { // 元数据
    Klass*      _klass;
    narrowKlass _compressed_klass;
    } _metadata;
    
    // ..
}
// 返回对象头的大小,这里使用的就是oopDesc,并且oopDesc内部就只有两个字段
// 所以从这个方法就可以知道:对象头 = markWord + metadata
// size of object header, aligned to platform wordSizestatic constexpr int header_size() { 
  return sizeof(oopDesc)/HeapWordSize; 
} 
```

从上面可以看出,对象头的组成部分是由oopdesc中的markword + metadata构成的,而metadata的内容已经很明显了,就是指向klass(这个对象所属的类在jvm中的实体,在这里暂时不讨论)。下面就看下markword中都有什么

```cpp
/*
    share/oops/markword.hpp/markWord
    这里是基于openjdk21的
//  64 bits:
//  --------
//  unused:25 hash:31 -->| unused_gap:1  age:4  unused_gap:1  lock:2 (normal object)

//  - the two lock bits are used to describe three states: locked/unlocked and monitor.
      两个锁标识位用来描述3种状态:加锁/未加锁 和重量级锁
//
//    [ptr             | 00]  locked             ptr points to real header on stack (stack-locking in use) 指针指向栈上的真实头部(栈锁正在使用)
//    [header          | 00]  locked             locked regular object header (fast-locking in use) 锁定的常规对象头(快速锁正在使用) - 新轻量级锁的实现(暂时不深入了解)
//    [header          | 01]  unlocked           regular object header(常规对象头) 
//    [ptr             | 10]  monitor            inflated lock (header is swapped out) 膨胀锁(头部被交换出去)
//    [ptr             | 11]  marked             used to mark an object (用于标记对象)
//    [0 ............ 0| 00]  inflating          inflation in progress (stack-locking in use) 膨胀中(用于栈锁)
//
//    We assume that stack/thread pointers have the lowest two bits cleared. 我们假设栈/线程指针的最低两位已经清零
//
//  - INFLATING() is a distinguished markword value of all zeros that is
//    used when inflating an existing stack-lock into an ObjectMonitor.
//    See below for is_being_inflated() and INFLATING().
      INFLATING()是一个特殊的markword,它的值为全0
      用于将现有的栈锁膨胀为ObjectMonitor时使用
*/

// 下面在简单的看一下openjdk11的注释 可以看到,在这里jdk11还存在着偏向锁
//  unused:25 hash:31 -->| unused:1   age:4    biased_lock:1 lock:2 (normal object)
//  JavaThread*:54 epoch:2 unused:1   age:4    biased_lock:1 lock:2 (biased object)
//  PromotedObject*:61 --------------------->| promo_bits:3 ----->| (CMS promoted object)
//  size:64 ----------------------------------------------------->| (CMS free block)
```

在上面举例了jdk21和jdk11,可以看到,不同版本的openjdk,markword的位起到的作用已经发生了变化，但是我觉得最重要的就是掌握核心：

1. 多个线程cas的共享资源到底是什么？
2. 条件变量在哪里？
3. 入口队列,等待队列在哪里？
4. 获取锁和释放锁都干了什么？
5. 线程是怎么阻塞/唤醒的？

在进入到monitorenter之前,首先看一下一个初始对象的对象头是什么样的

```java
// 下面分析基于jdk21
/*
<dependencies>
<dependency>
    <groupId>org.openjdk.jol</groupId>
    <artifactId>jol-core</artifactId>
    <version>0.17</version>
</dependency>
</dependencies>
*/
public class SyncDemo {
    public static void main(String[] args) {
        Object object = new Object();
        System.out.println(ClassLayout.parseInstance(object).toPrintable());
    }
}
// out put 从这里可以看出,一个对象至少占用16字节的大小,此时处于上面注释中所说的regular object header状态,也即普通对象头
// 0x0000000000000001_00000e80_00000000(16个字节)
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x0000000000000001 (non-biasable; age: 0)
  8   4        (object header: class)    0x00000e80 // 压缩指针
 12   4        (object alignment gap)    
Instance size: 16 bytes
```

下面再来看一下monitorenter字节码

+ monitorenter

```cpp
/*
    bytecodeInterpreter.cpp # monitorenter
*/
CASE(_monitorenter): {
    /*
        获取操作数栈顶的对象引用(实例对象/类对象)
        此时对象的状态为普通状态：
        也即:0x0000000000000001_00000e80_00000000
    */
    oop lockee = STACK_OBJECT(-1); 
    // find a free monitor or one already allocated for this object
    // if we find a matching object then we need a new monitor
    // since this is recursive enter
    BasicObjectLock* limit = istate->monitor_base();
    BasicObjectLock* most_recent = (BasicObjectLock*) istate->stack_base();
    BasicObjectLock* entry = nullptr;
    while (most_recent != limit ) {
      if (most_recent->obj() == nullptr) entry = most_recent;
      else if (most_recent->obj() == lockee) break;
      most_recent++;
    }
    // ....
}
```

这里引入了一个新的类 - BasicObjectLock,看下这个类的作用是什么

```cpp
/*
    // A BasicObjectLock associates a specific Java object with a BasicLock.
        一个BasicObjectLock对象将一个特定的java对象与一个BasicLock关联起来
    // It is currently embedded in an interpreter frame.
        它嵌入在解释器栈帧中(说明这是线程独占的,并且是解释器栈)
*/
class BasicObjectLock {
 private:
  BasicLock _lock;                                    // the lock, must be double word aligned 
  oop       _obj;                                     // object holds the lock; 锁对象
}

/*
    这里又引入了BasicLock类，可以看到这个类的作用就记录对象头的markWord的
*/
class BasicLock {
 private:
  volatile markWord _displaced_header;
}
```

继续看下解释器栈帧的结构，可以看到在线程栈帧中存在一块monitor区域,这里就存放着一些预先创建好的monitor对象(BasicObjectLock对象)

```cpp
// frame_x86.hpp
// ------------------------------ Asm interpreter ----------------------------------------
// Layout of asm interpreter frame:
//    [expression stack      ] * <- sp
//    [monitors              ]   \
//     ...                        | monitor block size
//    [monitors              ]   /
//    [monitor block size    ]
//    [byte code pointer     ]                   = bcp()                bcp_offset
//    [pointer to locals     ]                   = locals()             locals_offset
//    [constant pool cache   ]                   = cache()              cache_offset
//    [methodData            ]                   = mdp()                mdx_offset
//    [klass of method       ]                   = mirror()             mirror_offset
//    [Method*               ]                   = method()             method_offset
//    [last sp               ]                   = last_sp()            last_sp_offset
//    [old stack pointer     ]                     (sender_sp)          sender_sp_offset
//    [old frame pointer     ]   <- fp           = link()
//    [return pc             ]
//    [oop temp              ]                     (only for native calls)
//    [locals and parameters ]
//                               <- sender sp
// ------------------------------ Asm interpreter ----------------------------------------
```

此时的结构如下：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ODA0NDg4ODBhYzIxYmNlNWJhNTU3ZTI5ZDQ4MTJiODZfQjlNamJ1czZjczdwZTFXQXNvd3RHa0htbWYydUJWaldfVG9rZW46SEVENGI5a0tib1ozbG54OG5ocmNsbzZnbkpmXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

继续看代码

```cpp
/*
    bytecodeInterpreter.cpp # monitorenter
*/
CASE(_monitorenter): {
    /*
        获取操作数栈顶的对象引用(实例对象/类对象)
        此时对象的状态为普通状态：
        也即:0x0000000000000001(markword)
    */
    oop lockee = STACK_OBJECT(-1); 
    // find a free monitor or one already allocated for this object
    // if we find a matching object then we need a new monitor
    // since this is recursive enter
    BasicObjectLock* limit = istate->monitor_base(); // 获取monitor block的起始地址 - 
    BasicObjectLock* most_recent = (BasicObjectLock*) istate->stack_base(); // 获取栈地址 - ，在[begin,end]之间就存放着一个个的BasicObjectLock对象
    BasicObjectLock* entry = nullptr;
    // 从上往下找,此时的结构为：所有的BasicObjectLock对象内部的_lock和_obj属性都是null的
    // 那么此时找到的就是最后一个BasicObjectLock对象,并且将其赋值给entry
    while (most_recent != limit ) {
      if (most_recent->obj() == nullptr) entry = most_recent;
      else if (most_recent->obj() == lockee) break;
      most_recent++;
    }
    // ....
}
```

此时的结构为:

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZDc2YjhjY2FiZWJhOGZhNDQzNDRmNjVkMzY4Y2NkMjJfNkU0YnhNeGJtMDI0NUNkSTkyMEpyRlFzRVhjSVJUVUNfVG9rZW46Q3B4MmJjS3Nlb0hndlF4bEhpV2MycEhRbm0yXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

```cpp
  CASE(_monitorenter): {
    oop lockee = STACK_OBJECT(-1); 
    CHECK_NULL(lockee);
    BasicObjectLock* limit = istate->monitor_base();
    BasicObjectLock* most_recent = (BasicObjectLock*) istate->stack_base();
    BasicObjectLock* entry = nullptr;
    while (most_recent != limit ) {
      if (most_recent->obj() == nullptr) entry = most_recent;
      else if (most_recent->obj() == lockee) break;
      most_recent++;
    }
    // -- 
    // 此时的entry指向栈帧中的最后一个monitor对象
    if (entry != nullptr) {
      entry->set_obj(lockee); // 保存锁对象
      // traditional lightweight locking 经典的轻量级锁实现(因为在jdk21中废弃了偏向锁并且引入了新轻量级锁)
      // 从这里就可以看出,不管是轻量级锁还是偏向锁,都不是synchronized的核心(jdk21出现了新轻量级锁,后续可能还会变化)
      /*
            markWord set_unlocked() const {
                // static const uintptr_t unlocked_value   = 1;
                return markWord(value() | unlocked_value);
              }
            下面这行代码就是获取一个原始的markword值（保留当前对象的对象头中markword的hash值,age值,但是要将锁状态设置为无锁状态）
            displaced = 0x0000000000000001(markword) - 在这里前面全为0,但是实际上可能还会有hash,age等属性(因为当前对象并没有hash值,也没有经历垃圾回收)
      */
      markWord displaced = lockee->mark().set_unlocked();
      // 设置到entry#lock属性中
      entry->lock()->set_displaced_header(displaced);
     // ..
    }
```

此时的结构为:

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YTBjNGUyYmRmYzgxZmVmZDQyMGE3OGExMDFkYWFiMTJfbjNOdU01NHRhSUg4MFNjRDVreVZocE80NDA1c0NTR0ZfVG9rZW46UGZYUWI2NXNTb21qZXl4WXI1SGNoN1AyblRnXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

```cpp
if (entry != nullptr) {
  entry->set_obj(lockee);
  markWord displaced = lockee->mark().set_unlocked();
  entry->lock()->set_displaced_header(displaced);
  bool call_vm = (LockingMode == LM_MONITOR); // 是否直接使用重量级锁 - 默认为false,如果想要看synchronized的核心原理,那么把这个值当为true即可
  bool inc_monitor_count = true;
  /*
      markWord::from_pointer(entry)：将entry的地址转为markWord
      这里有个问题: 为什么直接设置entry给markword就可以了呢? 换句话说为什么entry的最后两bit位一定是0呢？
      在BasicObjectLock中有这样一段注释：
      BasicLock _lock;    // the lock, must be double word aligned,必须是double word对齐的(在64位上,双字代表的是8字节,那么内存地址的最后3bit一定是0)
   //    [ptr             | 00]  locked              ptr points to real header on stack (stack-locking in use) 
      lockee->cas_set_mark(xx):cas的更新锁对象的markword为entry的地址
      这里也和注释对应起来了,假设为此时没有竞争,那么这里是能够设置成功的,返回的就是displaced,那么这里是不会进入到if分支
  */
  if (call_vm || lockee->cas_set_mark(markWord::from_pointer(entry), displaced) != displaced) {
    // ...
  }
  
  // 增加计数
  if (inc_monitor_count) {
    THREAD->inc_held_monitor_count();
  }
}
```

此时的结构为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZmQ3NDJkOTBhNzA4NDlmZjcyN2FjNGY4OGIxZmZlYmRfYU84U1RUUGozMGsyZzFBWnpFcmZIV1NlaVdJanozVVBfVG9rZW46RHRkbWJqU1R4b3M5Q1N4N0V0MGNrTVpTbk9NXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

到这里就结束了，线程加锁就成功了

验证一下：

```java
public class Main {
    public static void main(String[] args) {
        Object object = new Object();
        synchronized (object){ // get stack lock(thin lock)
            System.out.println(ClassLayout.parseInstance(object).toPrintable());
        }
        // 释放锁后,状态会是什么样的呢？
        System.out.println(ClassLayout.parseInstance(object).toPrintable());
    }
}
/*
    out put - 1
    markWord:最后的一个字节是8:1000(最后3bit一定是0)
*/
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007fa28a20f8e8 (thin lock: 0x00007fa28a20f8e8)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes

/*
    jhsdb验证:
        - 首先控制台会输出对象的markWord:0x00007fa28a20f8e8
        - jps:得到pid(568187)
        - jhsdb clhsdb --pid 568187 (这里进入到交互式界面)
        - mem 0x00007fa28a20f8e8/2 (查看0x00007fa28a20f8e8地址开始的2个内存地址的值),输出内容如下：
            hsdb> mem 0x00007fa28a20f8e8/2
                  0x00007fa28a20f8e8: 0x0000000000000001 （这不就是dispalced吗?）
                  0x00007fa28a20f8f0: 0x0000000640e7c030 （不出意外的话,这应该指向的就是test.object）
            再来验证一下 0x0000000640e7c030 这个值(指向锁对象)
            hsdb> mem 0x0000000640e7c030/2
                  0x0000000640e7c030: 0x00007fa28a20f8e8 (这不就是指向栈中的BasicObjectLock吗?)
                  0x0000000640e7c038: 0x0000000000000e80 (不出意外的话这里应该指向的就是类对象了)
            可以看到,目前和上图是保持一致的
*/
public class Test {
    private Object object = new Object();
    public static void main(String[] args) throws IOException {
        Test test = new Test();
        synchronized (test.object){
            System.out.println(ClassLayout.parseInstance(test.object).toPrintable());
            System.in.read();
        }
    }
}
```

可以看到,轻量级锁的开销很小,并没有什么很重的操作,而通常的锁基本上都是支持锁重入的(除了StampedLock),那么下面再来看下轻量级锁是如何处理重入的?

```cpp
public static void main(String[] args) {
    Object object = new Object();
    synchronized (object){ // get stack lock(thin lock)
        System.out.println(ClassLayout.parseInstance(object).toPrintable());
        synchronized (object){ // 锁重入
            System.out.println(ClassLayout.parseInstance(object).toPrintable());
        }
    }
    // 释放锁后,状态会是什么样的呢？
    System.out.println(ClassLayout.parseInstance(object).toPrintable());
}

// out put 
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f14132d68d8 (thin lock: 0x00007f14132d68d8)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes
Space losses: 0 bytes internal + 4 bytes external = 4 bytes total

java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f14132d68d8 (thin lock: 0x00007f14132d68d8)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes
```

继续再看monitonenter

```cpp
/*
    前提:这里是在对同一个对象加锁(test.object)
*/
CASE(_monitorenter): {
    oop lockee = STACK_OBJECT(-1); // 获取操作数栈顶的对象引用(test.object)
    BasicObjectLock* limit = istate->monitor_base();
    BasicObjectLock* most_recent = (BasicObjectLock*) istate->stack_base();
    BasicObjectLock* entry = nullptr;
    /*
        在这里会继续从most_recent开始遍历,不过由于之前在栈帧上已经有一个BasicObjectLock了
        其结构为:
            BasicObjectLock
                - displaced
                - _obj(指向test_object)
         当这里指向完毕后:
             entry:指向一个空的BasicObjectLock对象
             most_recent:指向之前创建的BasicObejectLock
    */
    while (most_recent != limit ) {
      if (most_recent->obj() == nullptr) entry = most_recent;
      else if (most_recent->obj() == lockee) break;
      most_recent++;
    }
   // ...
}
```

此时的结构变为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NWZiZDkwYjllNWJjNjIxNDc0ZGMzMzg4YzNlYzhlN2VfbFFybkhBTkl0Q3Y2VDdlWW8yM3VkdTl3QUFFMWlrczZfVG9rZW46SEEwZ2JITGdPbzFlNm94Nnk0UWNsTkFlbmpmXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

继续看代码：

```cpp
  CASE(_monitorenter): {
    // ....
    
    if (entry != nullptr) {
      entry->set_obj(lockee); // 将对象引用保存在entry._obj中 
      markWord displaced = lockee->mark().set_unlocked(); //此时为: 0x00007f14132d68d9(0x00007f14132d68d8 | 01)
      entry->lock()->set_displaced_header(displaced); // 保存在entry._lock中
      // --
      bool call_vm = (LockingMode == LM_MONITOR);
      bool inc_monitor_count = true;
       /*
          BasicObjectLock: entry
              - _lock:0x00007f14132d68d9
              _ _obj:test.object引用
          BasicObjectLock: most_recent(0x00007f14132d68d8)
              - _lock:0x0000000000000001
              - _obj:test.object引用
          test.object:
              - markWord:0x00007f14132d68d8
          
          现在想要对test.object上锁,也是想要cas将entry设置给object对象头,但是此时的displaced和object.mark不一样
          displayed:0x00007f14132d68d9
          object.mark:0x00007f14132d68d8
          那么会进入到这个if分支,回忆一下ReentrantLock是如何判断锁重入的？在AQS中专门使用了一个字段来记录此时获取锁的线程对象
          在这里如何判断上一个获取轻量级锁的线程是否是当前线程呢?
      */
      if (call_vm || lockee->cas_set_mark(markWord::from_pointer(entry), displaced) != displaced) {
        // Is it simple recursive case?
        if (!call_vm && THREAD->is_lock_owned((address) displaced.clear_lock_bits().to_pointer())) {
          entry->lock()->set_displaced_header(markWord::from_pointer(nullptr));
        } else {
          inc_monitor_count = false;
          CALL_VM(InterpreterRuntime::monitorenter(THREAD, entry), handle_exception);
        }
      }
      if (inc_monitor_count) {
        THREAD->inc_held_monitor_count();
      }
      UPDATE_PC_AND_TOS_AND_CONTINUE(1, -1);
    }
```

这里是如何判断锁重入的呢?这里涉及到进程和线程的概念,在linux中,线程是共享地址空间的,也即每个线程的线程栈是处于不同的虚拟地址空间的(线程有私有的数据和共享的数据)

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=OTE2YmQwYzBjNzQ5MzIyNTQ5YWQwOTJkMDAzYjA2MzhfWnFNb3RFQm9MNnhlZGp3cU9Db3k5Wk5HOTlFYVpxVXVfVG9rZW46WW1vcmJZTGxPb2JicTF4V0s5NGNTRU81blJjXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

```cpp
/*
  BasicObjectLock: entry
      - _lock:0x00007f14132d68d9
      _ _obj:test.object引用
  BasicObjectLock: most_recent(0x00007f14132d68d8)
      - _lock:0x0000000000000001
      - _obj:test.object引用
  test.object:
      - markWord:0x00007f14132d68d8
      
    应该怎么判断是否是重入锁呢? 如果此时能够判断出most_recent是属于当前线程栈帧的不就可以了吗？
    那么怎么获取呢？
    entry._lock 是通过 test.object(most_entry) | 01 来获取的,那么在这里清楚最后的无锁标志位不就可以了 (但是为什么不直接用test.object呢?)
    下面来看代码
*/
(address) displaced.clear_lock_bits().to_pointer()// 清除标志位并且转为指针
THREAD->is_lock_owned()  // return _stack_base > adr && adr >= stack_end;
// 很显然,当前的场景是满足的,那么看下确定是锁重入后,然后做了什么？
 if (!call_vm && THREAD->is_lock_owned((address) displaced.clear_lock_bits().to_pointer())) {
              entry->lock()->set_displaced_header(markWord::from_pointer(nullptr)); // 将entry._lock设置为nullptr
 }
```

此时的结构为: 在线程栈上有两个BasicObjectLock了

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MWQ3ODMzNTk2MTBmYzBkMzc4Mjk1ZmEzOTJlYWUwMTFfU0V4aEpCaU9hTW1nT1ptRVFxaEV2RHd3ZVlkcll2VlNfVG9rZW46SHZzeGJ5OEZxb2pVVWJ4SXF2QmNyaFVKbkFmXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

下面来验证

```java
//上面代码的输出结果
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f14132d68d8 (thin lock: 0x00007f14132d68d8)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes

java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f14132d68d8 (thin lock: 0x00007f14132d68d8)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes

/*
    jps:630212 Test
    jhsdb clhsdb --pid 630212
    hsdb> mem 0x00007f14132d68d8/2
          0x00007f14132d68d8: 0x0000000000000001(displaced)
          0x00007f14132d68e0: 0x0000000640e7c080(指向test.object)
    如果第一个BasicObjectLock的地址为 0x00007f14132d68d8,那么第二个的地址应该是多少呢？0x00007f14132d68c8
    hsdb> mem 0x00007f14132d68c8/2
          0x00007f14132d68c8: 0x0000000000000000(nullptr)
          0x00007f14132d68d0: 0x0000000640e7c080(指向test.object)
对应上了
*/
```

偏向锁,轻量级锁（或者是jdk21中的新轻量级锁）都不是synchronized的核心，都只是jvm的优化手段,下面就看下当另外一个线程来获取的时候(产生了竞争),会是什么样的。

下面的这段代码,执行多次会有不同的执行结果

```java
public class Test {
    private Object object = new Object();
    public static void main(String[] args) throws IOException, InterruptedException {
        Test test = new Test();
        new Thread(()->{
            System.out.println("0==="+ClassLayout.parseInstance(test.object).toPrintable());
            synchronized (test.object){
                System.out.println("1==="+ClassLayout.parseInstance(test.object).toPrintable());
                try {
                    Thread.sleep(10);
                    System.out.println("2==="+ClassLayout.parseInstance(test.object).toPrintable());
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        },"thread-1").start();
        new Thread(()->{
            synchronized (test.object){
                System.out.println("exit thread-2");
                System.out.println("3==="+ClassLayout.parseInstance(test.object).toPrintable());
            }
        },"thread-2").start();

        System.in.read();
    }
}

// out put -1 有一种情况是这样的,这里会涉及到轻量级锁的释放逻辑
3===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f1b304d9830 (thin lock: 0x00007f1b304d9830)
  
0===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x0000000000000001 (non-biasable; age: 0)
1===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f1b305d9828 (thin lock: 0x00007f1b305d9828)
  
2===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f1b305d9828 (thin lock: 0x00007f1b305d9828)
  
// out put -2
0===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f14d152e830 (thin lock: 0x00007f14d152e830)
  
/*
    要想营造出,thread-1持有着轻量级锁,然后thread-2也来获取锁的场景,需要修改一下代码
        - 在这里保证thread-1先获取到锁,并且一直没有释放锁(并不是永久阻塞)
        - 然后thread-2再来获取锁(获取锁失败)
*/
public class SyncDemo {
    public static void main(String[] args) throws IOException, InterruptedException {
        Test test = new Test();
        new Thread(()->{
            System.out.println("0==="+ ClassLayout.parseInstance(test.object).toPrintable());
            synchronized (test.object){
                System.out.println("1==="+ClassLayout.parseInstance(test.object).toPrintable());
                try {
                    Thread.sleep(3000);
                    System.out.println("2==="+ClassLayout.parseInstance(test.object).toPrintable());
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        },"thread-1").start();
        // ---->
        Thread.sleep(1000);
        new Thread(()->{
            synchronized (test.object){
                System.out.println("3==="+ClassLayout.parseInstance(test.object).toPrintable());
            }
        },"thread-2").start();

        System.in.read();
    }
}
//out put 重量级锁出现了,下面就来看下锁是如何从轻量级变为重量级的
0===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x0000000000000001 (non-biasable; age: 0)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes
Space losses: 0 bytes internal + 4 bytes external = 4 bytes total

1===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f303952e828 (thin lock: 0x00007f303952e828)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes
Space losses: 0 bytes internal + 4 bytes external = 4 bytes total

2===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f2f98000ff2 (fat lock: 0x00007f2f98000ff2)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes
Space losses: 0 bytes internal + 4 bytes external = 4 bytes total

3===java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007f2f98000ff2 (fat lock: 0x00007f2f98000ff2)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes
```

在看重量级锁相关的代码之前,看下轻量级锁释放的代码

此时的结构为:该场景为轻量级锁重入

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YjQxNWZkMzBkZTM4YjEzYTQ3NmEzOTg3OTNkYzdmOWJfVUZMY1lHeVdiSWhFc1VvWmh3eGdQbHMxRXZaSzB4ekRfVG9rZW46VUQ5TGJEckdSb0szbkJ4ZWhiT2NMN0dnbk9oXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

monitorexit

```cpp
/*
    使用上面这张图来讲解:轻量级锁重入的场景
        - 从上往下依次遍历每一个BasicObjectLock,因为每重入一次就会使用一个entry
        - 如果找到了某个entry._obj = lockee(锁对象)，那么还需要继续判断
            - 该entry._lock.displace_header == nullptr，那么说明是锁重入,此时只需要将该entry._obj 设置为 nullptr即可
                - 减少锁计数,然后执行下一个字节码即可(锁释放成功)
            - 该entry._lock.displace_header != nullptr，那么说明这是最早加的一个轻量级锁了(同样也是最后一个了)
                - 那么首先将该entry._obj 设置为 nullptr
                - 然后将lockee(锁对象)的markword复原(设置为entry._lock.displaced_header - 这里面保存的就是锁对象最开始的markword)
                - 减少锁计数,然后执行下一个字节码即可(锁释放成功)
    问题是：在下面的#1中,也即上面的第二步,是很可能复原失败的,这是因为存在锁膨胀,后续再补充
*/
CASE(_monitorexit): {
    oop lockee = STACK_OBJECT(-1); // 获取锁对象
    CHECK_NULL(lockee);
    BasicObjectLock* limit = istate->monitor_base(); 
    BasicObjectLock* most_recent = (BasicObjectLock*) istate->stack_base();
    while (most_recent != limit ) {
      if ((most_recent)->obj() == lockee) { 
        BasicLock* lock = most_recent->lock(); 
        markWord header = lock->displaced_header(); 
        most_recent->set_obj(nullptr); 

        bool dec_monitor_count = true;
        bool call_vm = (LockingMode == LM_MONITOR); // 默认为false
        if (header.to_pointer() != nullptr || call_vm) { 
          markWord old_header = markWord::encode(lock);
          if (call_vm || lockee->cas_set_mark(header, old_header) != old_header) { // #1
             // ... 产生了锁竞争
          }
        }
        // 如果是重入,那么只是减少计数而已(因为这个entry._obj在上面被设置为nullptr了,相当于成功释放了)
        if (dec_monitor_count) {
          THREAD->dec_held_monitor_count();
        }
        UPDATE_PC_AND_TOS_AND_CONTINUE(1, -1); // 执行下一条字节码 - 相当于释放锁成功了
      }
      most_recent++;
    }
  }
```

此时线程栈的结构变为:

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MjI0YThiNjQ3MmE2ZTM0OWRmMjEzOGQxYmIyNmExZWJfdG8zeVIwMUVCZjJRamo5VGFkZ0NuTEo3TlVTUEZRYVFfVG9rZW46SGhsV2JQdGpjb0N2Uk94dnpWRGN0MUo1bkNoXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

下面再来看下锁竞争的逻辑：此时的结构背景为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=M2EwNTIyY2YxYTc1ZWY2YzUxYjAyOGYyMGExYTdmMzNfOUt5TlZlcnFkZlRKTFlOcnZJSEh6MVZraTJsRTRNSlRfVG9rZW46V1lCZWJEMVZab3owaUJ4NWJvU2NXY21PbkFoXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

再次进入到monitorenter中

```cpp
/*
    注意：此时是另外一个线程(thread-2)在执行这段代码,而该线程的线程栈中的monitor block区域内是全部都是空的BasicObjectLock对象
    entry
        _obj = test.object
        _lock = displaced = 0x00007f9ce982e828 | 01 = 0x00007f9ce982e829 != 0x00007f9ce982e828
    那么在这里：
        - cas失败: 因为displaced!=0x00007f9ce982e828
        - is_lock_owned():也判断失败-因为是不同线程(不在thread-2线程栈范围内)
        - 此时就会进入到InterpreterRuntime::monitorenter(THREAD, entry) - 这个entry是thread-2的entry
    // --->
    这个是背景,object.markword此时指向的是thread-1线程栈上的BasicObjectLock
     /*
          BasicObjectLock: most_recent(0x00007f9ce982e828)
              - _lock:0x0000000000000001
              - _obj:test.object引用
          test.object:
              - markWord:0x00007f9ce982e828
      */
     
if (entry != nullptr) {
  entry->set_obj(lockee);
  markWord displaced = lockee->mark().set_unlocked();
  entry->lock()->set_displaced_header(displaced);
  bool call_vm = (LockingMode == LM_MONITOR);
  bool inc_monitor_count = true;
  if (call_vm || lockee->cas_set_mark(markWord::from_pointer(entry), displaced) != displaced) {
    if (!call_vm && THREAD->is_lock_owned((address) displaced.clear_lock_bits().to_pointer())) {
      entry->lock()->set_displaced_header(markWord::from_pointer(nullptr));
    } else {
      inc_monitor_count = false;
      CALL_VM(InterpreterRuntime::monitorenter(THREAD, entry), handle_exception);
    }
  }
}
```

当判断出当前锁对象已经被其他线程持有轻量级锁时,就会进入到InterpreterRuntime::monitorenter()方法中

```cpp
/*
    参数:
        - thread-2
        entry
            _obj = test.object
            // 可以看到,thread-2线程栈中的entry保存着thread-1线程栈中entry的地址(是经过｜操作运算过的)
            _lock = displaced = 0x00007f9ce982e828 | 01 = 0x00007f9ce982e829 != 0x00007f9ce982e828 
*/
JRT_ENTRY_NO_ASYNC(void, InterpreterRuntime::monitorenter(JavaThread* current, BasicObjectLock* elem)) 
  Handle h_obj(current, elem->obj()); // 获取对象句柄,这里将对象引用再做了一层包装(oxa「handle」 -> oxb -> java对象 )「这是为gc服务的」
  ObjectSynchronizer::enter(h_obj, elem->lock(), current);
JRT_END
```

对象句柄:

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NzJlMjQ2YmNmYTAxNThlZWZhYWE4MDI1NjA1OGNmODNfTU9MeFFVSTJMdFFVSlUwYVNrQ21IYnhxWUhPZ1l5TGVfVG9rZW46SHFDdmJyMmo0b3hQc1B4YlpOMGNtS0x0bjRkXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

```cpp
/*
    ObjectSynchronizer::enter(h_obj, elem->lock(), current);
        - h_obj：持有test.object(锁对象)的引用
        - elem->lock:entry._lock(存储的是0x00007f9ce982e828 | 01)
        - current:当前线程(thread-2)
*/
void ObjectSynchronizer::enter(Handle obj, BasicLock* lock, JavaThread* current) {
   // 不允许锁对象为基本类型..
  if (obj->klass()->is_value_based()) {
    handle_sync_on_value_based_class(obj, current);
  }

  current->inc_held_monitor_count();

  if (!useHeavyMonitors()) {
    if (LockingMode == LM_LIGHTWEIGHT) {
      // 新轻量级锁的处理,忽略
    } 
    else if (LockingMode == LM_LEGACY) {  // 传统轻量级锁
    /*
      获取锁对象的markword,这里可能存在两种情况：
         - thread-1已经将轻量级锁释放了,那么此时锁对象的markword为0x0000000000000001(无锁状态) - 场景1
            - 如果是这种状态:那么is_neutral()将会返回true
               - 设置BasicLock的displaced_header为mark(无锁mark)
               - cas设置锁对象的markword为BasicLock的地址(因为BasicLock是BasicObjectLock的第一个属性,所以两者地址相同)
               - 设置成功,那么直接返回,上锁成功
               - 此时就是轻量级锁
         - thread-1可能正在释放轻量级锁/依旧持有轻量级锁：那么此时锁对象的markword = 0x00007f9ce982e828(指向thread-1线程栈中的BasicObjectLock)
            - 那么mark.is_neutral() = false
            - 继续判断是否是轻量级锁重入,在这里也不是,不满足
         - 此时已经可以判断出处于锁竞争了
            - 设置thread-2线程栈中的entry._lock.displaced_header =  3 (这只是一个占位符,是什么值不重要,但是不能为0(避免与重入锁混淆))
    */
      markWord mark = obj->mark();  
      if (mark.is_neutral()) { // 无锁
        lock->set_displaced_header(mark);
        if (mark == obj()->cas_set_mark(markWord::from_pointer(lock), mark)) {
          return;
        }
      } else if (mark.has_locker() &&  // 轻量级锁重入
                 current->is_lock_owned((address) mark.locker())) {
        lock->set_displaced_header(markWord::from_pointer(nullptr));
        return;
      }
      // 占位符
      lock->set_displaced_header(markWord::unused_mark());
    }
  }
  // -->
  // 否则,产生了锁竞争,那么进入到膨胀流程
  while (true) {
    ObjectMonitor* monitor = inflate(current, obj(), inflate_cause_monitor_enter);
    if (monitor->enter(current)) {
      return;
    }
  }
}
```

在这里先总结一部分的代码：可以看出轻量级锁在线程交替执行时，能够起到很好的优化效果,因为此时并没有重量级操作(没有看到什么系统调用的发生)

此时的结构为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NWZhNTZjM2NlZGFjZTBkZTQ5ZWI2MTg5MDIyNmE3ZTVfSTFUYkk3eWxmZFpPT21ieVRTeUlhTHB5YUJoM0lFMmhfVG9rZW46QjI2d2JnazE1b0NrcUR4bUhsWGM4eVBObjNiXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

但是如果T-1并没有释放轻量级锁,或者正在释放,但是还没有完全释放,那么此时的结果为:

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NmMzZGI5MDhmMTQ0YzgyYTJlNjU4NWQ1YjE3Mzk4OGJfRll1V091STVoM0k2bWswRkJ3dk9Ic1JQNFJzdlJsbVBfVG9rZW46T1VJUmI5RFhqb3R3NjB4dkQ2R2NCenQ2bkt4XzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

下面进入到膨胀的流程:

+ inflate()

```cpp
  while (true) {
    ObjectMonitor* monitor = inflate(current, obj(), inflate_cause_monitor_enter);
    if (monitor->enter(current)) {
      return;
    }
  }
  
  // 下面只介绍了当前的场景：轻量级锁 - 重量级锁的过程
ObjectMonitor* ObjectSynchronizer::inflate(Thread* current, oop object,const InflateCause cause) 
{
  for (;;) {
    const markWord mark = object->mark_acquire(); // 获取锁对象的markword - 此时应该指向的是thread-1线程栈中的entry
    if (LockingMode == LM_LEGACY && mark.has_locker()) {
      ObjectMonitor* m = new ObjectMonitor(object); // 创建一个ObjectMonitor对象 - 这个是核心
      markWord cmp = object->cas_set_mark(markWord::INFLATING(), mark); // 将锁对象的markword设置为INFLATING状态(此时thread-1再释放锁的时候将会进入到exit流程)
      // .. 
      // 从BasicLock中读取原始对象头的markword(对象头的最初状态 - 0x0000000000000001)
      markWord dmw = mark.displaced_mark_helper(); 
      // 设置到objectMonitor中(objectMonitor.header字段保存着锁对象的最初状态 - 一定是无锁状态)
      m->set_header(dmw);
      // 设置objectMonitor.owner字段为BasicLock(指向thread-1线程栈中的entry/BasicLock)
      m->set_owner_from(nullptr, mark.locker());
      // 设置锁对象的markword为 &objectMonitor | 10 - (重量级锁)
      object->release_set_mark(markWord::encode(m));
      // 将当前objectMonitor加入到链表中(用于全局管理)
      _in_use_list.add(m);
      // 返回当前创建的objectMonitor对象
      return m;
    }
  }
}
}
```

此时的结构为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=Nzk0YWViNjFlNmFjN2NhZjRmOGU1MzdjYjNlYmYzYTFfMXJqc3pLTXYwYlJmdnZ1OEdTc3hMQWZKeUlCS3ZLVW5fVG9rZW46VVFCSWJJQkxrb2pwYXB4STk4UWNIN2ZGbldoXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

在进入到锁膨胀的逻辑之前,再回过头来看下轻量级锁的释放流程

此时的状态为上图

```cpp
CASE(_monitorexit): {

// ...
/*
    这里是轻量级锁在释放锁的时候,执行cas将锁对象的markword从entry设置为原始值(无锁)失败的场景
    为什么会失败?是因为thread-2正在膨胀,它会将对象的对象头设置为INFLATING/ObjectMonitor
    此时就会进入到InterpreterRuntime::monitorexit(most_recent)
*/
  if (call_vm || lockee->cas_set_mark(header, old_header) != old_header) {
    // restore object for the slow case
    most_recent->set_obj(lockee);
    dec_monitor_count = false;
    InterpreterRuntime::monitorexit(most_recent);
  }
// ...
}

// InterpreterRuntime::monitorexit(most_recent)
JRT_LEAF(void, InterpreterRuntime::monitorexit(BasicObjectLock* elem))
  oop obj = elem->obj(); // 获取锁对象
  // ...
  ObjectSynchronizer::exit(obj, elem->lock(), JavaThread::current()); 
  elem->set_obj(nullptr);
JRT_END

/*

    ObjectSynchronizer::exit(oop object, BasicLock* lock, JavaThread* current)
        - obj：锁对象
        - BasicLock:thread-1线程栈上的entry对应的BasicLock
        - current：当前线程,thread-1
*/
void ObjectSynchronizer::exit(oop object, BasicLock* lock, JavaThread* current) {

    if (!useHeavyMonitors()){
        markWord mark = object->mark(); // 获取此时对象的对象头 - 应该为INFLATING / ObjectMonitor | 10
        if (LockingMode == LM_LIGHTWEIGHT){...} // 新轻量级锁的逻辑,暂时不关注
        else if (LockingMode == LM_LEGACY){ // 传统轻量级锁实现
         markWord dhw = lock->displaced_header(); // 获取displaced_header - 原始对象头信息,如果等于0,只有重入时才会出现,直接返回
         if (dhw.value() == 0){
             return;
         }
         if (mark == markWord::from_pointer(lock)) { 
         // 否则不是重入轻量级锁,那么判断当前锁对象的markword是否还是指向thread-1线程栈上的entry
         // 如果还是,那么cas将锁对象的对线头设置为原始的对象头(通常是无锁状态)即可
             if (object->cas_set_mark(dhw, mark) == mark) {
                  return;
               }
         }
        } 
    }

// .... 但是现在要看的场景都不满足上面这些,因为thread-2正在膨胀,已经将锁对象的markword 设置为了ObjectMonitor | 10
    /*
        这里是持有轻量级锁的线程进行膨胀时调用的,但是由于一个对象只对应一个ObjectMonitor,
        所以在这里,thread-1会直接返回thread-2创建的monitor对象
        ObjectMonitor* ObjectSynchronizer::inflate(Thread* current, oop object,
                                           const InflateCause cause) {
            if (mark.has_monitor()) {
                      ObjectMonitor* inf = mark.monitor();
                      //...
                      return inf; // 直接返回了已有的objectMonitor对象
            }
}                               
    
    */
    ObjectMonitor* monitor = inflate(current, object, inflate_cause_vm_internal);
    monitor->exit(current); // 然后调用ObjectMonitor#exit()方法
}

//  monitor->exit(current)


void ObjectMonitor::exit(JavaThread* current, bool not_suspended) {
  void* cur = owner_raw(); // 获取monitor中的owner,此时指向的是thread-1线程栈上的entry
  if (current != cur) { // 如果不等于线程
    if (LockingMode != LM_LIGHTWEIGHT && current->is_lock_owned((address)cur)) {
      set_owner_from_BasicLock(cur, current);  // Convert from BasicLock* to Thread*. 那么将BasicLock转为线程(thread-1)
      _recursions = 0; // 锁重入设置为0
    } else {
      return;
    }
  }
  // 如果是锁重入,那么递减锁计数返回即可
  if (_recursions != 0) {
    _recursions--;        // this is simple recursive enter
    return;
  }

for (;;) {

  release_clear_owner(current); // 否则,是真的要释放锁了,那么将minitor的_owner设置为nullptr,代表没有线程持有这个monitor
  OrderAccess::storeload(); // 保证可见性

  // ..... 省略唤醒的代码逻辑
}
```

可以看到,轻量级锁在释放锁的过程中,会将objectMonitor的_owner从BasicLock(BasicObjectLock)设置为thread（持有轻量级锁的线程），然后再设置为nullptr(前提是thread-1没有锁重入)。这就代表了锁已经释放了

下面再来看下锁膨胀的逻辑：

```cpp
// monitor->enter(current)
/*
    到这里可以总结一下:为什么thread-2在锁膨胀的时候,要获取锁对象的markword(此时还是指向thread-1的entry中的)
    然后将其设置到_owner中,
    这是用来表示当前是哪个线程在持有轻量级锁,从轻量级锁的释放锁可以看到,
    在释放的时候会将objectmonitor的_owner字段从BasicObjectLock设置为thread-1,
    如果是真的释放(而不存在锁重入的情况)，那么最终会将_owner设置为nullptr，代表此时没有线程持有锁对象
    
    换句话说：如果thread-1一直不释放锁,那么objectMonitor的_owner会一直指向thread-1线程栈中的entry
    
    现在的重点是：看下thread-2到底是如何被阻塞的,队列在哪里?
*/
bool ObjectMonitor::enter(JavaThread* current) {
      // #1 优化操作,在锁膨胀的过程中,尝试将_owner从nullptr设置为当前线程(thread-2)
      // 如果设置成功了,那么代表thread-1已经释放锁了,那么这里直接返回就可以了,获取锁成功了
      void* cur = try_set_owner_from(nullptr, current); 
      if (cur == nullptr) { 
        return true;
      }
        // 锁重入逻辑
      if (cur == current) {
        _recursions++;
        return true;
      }
      //持有轻量级锁的线程,自己膨胀为重量级锁,展示不关注
      if (LockingMode != LM_LIGHTWEIGHT && current->is_lock_owned((address)cur)){}
      // #2 优化操作：在锁膨胀过程中,会使用自旋进行优化,期待thread-1在这段时间内能够释放锁，这样就避免了重量级开销
      if (TrySpin(current) > 0) {
          return true;
      }
      { // Change java thread status to indicate blocked on monitor enter.
      // 更新Java线程状态为:JavaThreadStatus::BLOCKED_ON_MONITOR_ENTER
      // 通过thread.getState()看到的就是BLOCK
        JavaThreadBlockedOnMonitorEnterState jtbmes(current, this); 
        current->set_current_pending_monitor(this); // 设置当前线程(thread-2)正在等待的锁对象
        OSThreadContendState osts(current->osthread()); // 设置osThread的状态(这里会涉及到线程模型 - 暂时不关注)
        for (;;) {
          ExitOnSuspend eos(this);
          {
            // 设置Java线程的状态为_thread_blocked,对外部不可见
            ThreadBlockInVMPreprocess<ExitOnSuspend> tbivs(current, eos, true /* allow_suspend */);
            // 准备阻塞
            EnterI(current);
            // ...
 }
 }
}
```

+ 阻塞操作：EnterI()

```cpp
void ObjectMonitor::EnterI(JavaThread* current) {
  /*
      阻塞前的尝试
          - 尝试直接获取锁
          - 尝试自旋
  */
  if (TryLock (current) > 0) {
    return;
  }
  if (try_set_owner_from(DEFLATER_MARKER, current) == DEFLATER_MARKER) {
    return;
  }
  if (TrySpin (current) > 0) {
    return;
  }
  // --- 到这里,thread-1还是没有将objectMonitor的_owner设置为nullptr(还是指向thread-1线程栈中的BasicObjectLock)
  ObjectWaiter node(current); // 创建ObjectWaiter节点,这是一个stackObj
  current->_ParkEvent->reset(); // 重置ParkEvent,避免之前的unpark()影响到阻塞操作
  node._prev   = (ObjectWaiter*) 0xBAD; // 设置为魔数变量,_cxq是一个单链表,是不会使用prev指针的(用于调试)
  node.TState  = ObjectWaiter::TS_CXQ; //标记节点的状态,代表该节点即将在或者已经在_cxq队列中了
  ObjectWaiter* nxt;
  for (;;) {
    /*
        下面这两行代码是用于cas将上面创建的 ObjectWaiter 节点插入到 _cxq队列
        如果成功了,那么直接break
        否则:在这里选择尝试重新获取锁,如果成功了,那么直接返回,否则继续for(;;)循环,直到成功的插入到_cxq队列中
    */
    node._next = nxt = _cxq; 
    if (Atomic::cmpxchg(&_cxq, nxt, &node) == nxt) break;
    // Interference - the CAS failed because _cxq changed.  Just retry.
    // As an optional optimization we retry the lock.
    if (TryLock (current) > 0) {
      assert(_succ != current, "invariant");
      assert(owner_raw() == current, "invariant");
      assert(_Responsible != current, "invariant");
      return;
    }
  } // end for
  
  /*
      nxt == nullptr:当前节点是_cxq的第一个节点
      _EntryList = nullptr:此时还没有该队列
      那么让当前线程成为_Responsible线程
      - _Responsible线程的作用是什么？
  */
    if (nxt == nullptr && _EntryList == nullptr) {
    // Try to assume the role of responsible thread for the monitor.
    // CONSIDER:  ST vs CAS vs { if (Responsible==null) Responsible=current }
    Atomic::replace_if_null(&_Responsible, current);
    }
  int nWakeups = 0;
  int recheckInterval = 1;
      // for(;;)死循环
  for (;;) {
      // 再次尝试获取锁,因为马上就要阻塞了
    if (TryLock(current) > 0) break;
    /*
        _ParkEvent：每个线程都有且仅有一个_ParkEvent对象(定义在Thread.hpp中「C++中的线程类」)
    
    */
       // park self 如果当前线程是_Responsible线程,那么阻塞recheckInterval时间(默认为1s)
    if (_Responsible == current) {
      current->_ParkEvent->park((jlong) recheckInterval);
      // Increase the recheckInterval, but clamp the value.增加时间
      recheckInterval *= 8;
      if (recheckInterval > MAX_RECHECK_INTERVAL) {
        recheckInterval = MAX_RECHECK_INTERVAL;
      }
    } else { // 否则是普通线程,那么永久阻塞
      current->_ParkEvent->park();
    }
    
    // ...
}
}

/*
    线程阻塞的原理 - park(),和 ReentrantLock + condition 很类型
    这里涉及要另外一个重要的类：PlatformEvent
      // 在前面执行过current->_ParkEvent->reset(),将这个值设置为了0,代表线程不可运行
      volatile int _event;       // Event count/permit: -1, 0 or 1 许可证(线程是否可以正常运行)
      // 代表线程是否正在阻塞
      volatile int _nParked;     // Indicates if associated thread is blocked: 0 or 1
      // 锁资源 + 条件变量(这里就到了OS层面了)
      pthread_mutex_t _mutex[1]; // Native mutex for locking
      pthread_cond_t  _cond[1];  // Native condition variable for blocking  
      可以看到,到这里线程就阻塞了
*/
void PlatformEvent::park() {       // AKA "down()"
  int v;
  for (;;) {
    v = _event; // 默认是0
    // cas的将_event由0设置为-1（为什么要cas呢？因为释放锁的线程可能会cas将_event从0设置为1）
    if (Atomic::cmpxchg(&_event, v, v - 1) == v) break;
  }
  // 如果 old _event = 0(当前场景就是),那么获取mutex锁
  if (v == 0) { // Do this the hard way by blocking ...
    int status = pthread_mutex_lock(_mutex);
    ++_nParked; // 将 _nParked 递增（代表线程在阻塞）
    while (_event < 0) {
      status = pthread_cond_wait(_cond, _mutex); // 阻塞在条件变量_cond上
    }
    --_nParked;
    _event = 0;
    status = pthread_mutex_unlock(_mutex);
    OrderAccess::fence();
  }
}
```

到目前为止,已经知道了两个比较关键的点：

1. 共享资源是对象(更具体点是对象头中的markword)
2. 入口队列是objectMonitor中的_cxq队列(这是一个单链表)

此时的结构应该为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZDUzOGJiNmZjZTZkODJhNGUxOWFkN2Y5NTEwMGUxMGRfekJZZWRuOGJieUVOOXU0dENkdFhRUVBza2xWNkp2NW5fVG9rZW46QURORWJiUTE4b3NRV1R4NGRpNWNXM21WbnViXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

下面尝试验证一下：

```java
public class BlockDemo {
    static volatile int i = 0;
    public static void main(String[] args) throws Exception{
        Test test = new Test();
        Object lock = test.object;
        new Thread(()->{
            synchronized (lock) {
                System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                for (;;){
                    try {
                        Thread.sleep(10000);
                        // thread-1线程获取锁后一直不释放锁
                        System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                        System.in.read();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }
            }
        },"thread-1").start();
        
        Thread.sleep(3000);
        new Thread(()->{
            System.out.println("thread-2 start");
            synchronized (lock){
                System.out.println("thread-2 get the lock");
            }
        }).start();
    }
}

// out put
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007fead2e24828 (thin lock: 0x00007fead2e24828)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes

thread-2 start
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x00007fea500630b2 (fat lock: 0x00007fea500630b2) // markWord = ObjectMonitor | 10(2)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)    
Instance size: 16 bytes

// 从上面可以获取到objectMonitor的地址：0x00007fea500630b0

```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NzE5ZDViMjU4M2M0NGI2NzU1MGIyOTJkYmEzYzQyMDZfRXc4RXdXendNNVg3MWp5eGY3cGFxbGxxakNkQUZMSXJfVG9rZW46UW9VRGJQWFhub2xSSWR4OGhTWWMzdmh5blJnXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

并且此时thread-2的状态为**BLOCKED**

```java
Thread.State state = thread.getState();
System.out.println(state); // BLOCKED - 代表当前线程正在等待synchronized锁
```

下面就看下当thread-1释放轻量级锁的时候,是如何唤醒thread-2的

```cpp
/*
    回到释放锁的逻辑:
    void ObjectSynchronizer::exit(oop object, BasicLock* lock, JavaThread* current) {
    {
        // ...
        monitor->exit(current);
        // ...
    }
*/
// monitor->exit(current);
void ObjectMonitor::exit(JavaThread* current, bool not_suspended) {
    void* cur = owner_raw(); // 获取锁对象的markword所对应的_owner(此时指向的是thread-1线程栈上的entry)
    // 如果_owner不等于当前线程(这是必然的,因为此时正在执行释放锁的操作,在下面才会将_owner从entry设置为thread-1)
    if (current != cur){
        // 非新轻量级锁逻辑 && _owner所指向的entry在当前线程的线程栈上(BasicObjectLock)
        if (LockingMode != LM_LIGHTWEIGHT && current->is_lock_owned((address)cur)) {
            // 将_owner从BasicObjectLock设置为thread-1
            set_owner_from_BasicLock(cur, current);  // Convert from BasicLock* to Thread*.
            // 锁计数设置为0
            _recursions = 0;
        }
    }
    // 如果锁计数不等于0,那么代表是轻量级锁重入,递减锁计数,然后返回即可,释放锁成功
     if (_recursions != 0) {
        _recursions--;        // this is simple recursive enter
        return;
      }
  _Responsible = nullptr; // 将_Responsible设置为nullptr(leader线程)
  /**==========走到这里,说明是真的要释放了(非锁重入逻辑)=========**/
  for (;;) {
      release_clear_owner(current); // 将_owner设置为nullptr,如果thread-2此时在自旋,那么就能成功的获取到锁
      OrderAccess::storeload(); // 保证在上面执行的内存操作对其他线程可见
      // 如果_EntryList和_cxq都为null,那么直接返回即可,没有线程需要被唤醒
      // _succ != nullptr 继承人线程是什么?
      // 这里涉及到了另外一个核心的队列:_EntryList,前面在学习管程的时候,说过只有一个入口队列
      // 那这个队列的作用是什么呢？
      if ((intptr_t(_EntryList)|intptr_t(_cxq)) == 0 || _succ != nullptr) {
          return;
      }
      
      // 走到这里说明,_EntryList或者_cxq中存在等待节点
      // 那么为了能够线程安全的操作ObjectMonitor中的属性,在这里需要重新获取锁
      // 如果失败,那么返回即可,说明已经被其他线程获取了锁,这说明synchronized是非公平的
      // 如果成功,那么继续执行唤醒的操作
      if (try_set_owner_from(nullptr, current) != nullptr) {
       return;
       }
       
       ObjectWaiter* w = nullptr;
       w = _EntryList; 
       // 如果_EntryList不为nullptr(也即有元素),那么直接执行唤醒逻辑(ExitEpilog()),并不会迁移_cxq链表(除非_EntryList中的节点线程都被唤醒了)
        if (w != nullptr) {
          ExitEpilog(current, w);
          return;
        }
       w = _cxq; // 保存_cxq的引用,_cxq存储的是获取synchronized失败的线程节点(每一个线程对应一个ObjectWaiter对象)
      for (;;) {
          // cas的将_cxq设置为null
          ObjectWaiter* u = Atomic::cmpxchg(&_cxq, w, (ObjectWaiter*)nullptr);
          if (u == w) break; // 结束该小的for()循环
          w = u;
        }
    /*
        下面这段代码是将_cxq(单向链表 - 头插法) 转变为 _entryList(双向链表 - 依旧保持头插法)
        为什么只需要变化_prev呢？因为_cxq的next本来就是关联好的
        当下面这段代码执行完毕后,_cxq中的节点就被移动到了_entryList中了
    */
        _EntryList = w;
        ObjectWaiter* q = nullptr;
        ObjectWaiter* p;
        for (p = w; p != nullptr; p = p->_next) {
          p->TState = ObjectWaiter::TS_ENTER;
          p->_prev = q;
          q = p;
        }
        w = _EntryList;
        if (w != nullptr) {
          // 唤醒线程
          ExitEpilog(current, w);
          return;
        }   
      
  }
}
```

可以看到上面的逻辑主要为：

1. 如果objectMonitor上存在_entryList链表,那么进入到唤醒逻辑(不会将_cxq中的等待节点移动到_entryList)
2. 否则,_entryList为nullptr，那么一次性将_cxq中的等待节点迁移到_entryList中

下面在来看下线程是如何被唤醒的

```cpp
/*
    ExitEpilog(current, w)
        - current:当前线程
        - w:_entryList链表
*/
void ObjectMonitor::ExitEpilog(JavaThread* current, ObjectWaiter* Wakee) {
  // 设置即将唤醒的线程
  _succ = Wakee->_thread;
  // 获取ObejctWaiter中的ParkEvent(这对应的是线程的ParkEvent,在创建ObjectWaiter就设置好的)
  ParkEvent * Trigger = Wakee->_event;
  Wakee  = nullptr; // 设置为nullptr
  release_clear_owner(current); // 将_owner字段设置为nullptr
  OrderAccess::fence();
  Trigger->unpark(); // 唤醒操作
}

/*
    正常情况下:
        - _event = -1
        _ _uparked = 1
*/
void PlatformEvent::unpark() {
    // cas将_event设置为1,并且返回旧值(这里是无条件设置,而不是cas)
    // 如果old _event >=0,那么直接返回即可,这代表线程不在阻塞状态
    if (Atomic::xchg(&_event, 1) >= 0) return;
    int status = pthread_mutex_lock(_mutex);
    int anyWaiters = _nParked;
    status = pthread_mutex_unlock(_mutex);
    if (anyWaiters != 0) {
    // 唤醒
    status = pthread_cond_signal(_cond);
    }
}

// 当线程醒来后,并且成功强到锁后（cas的将objectMonitor._owner设置为当前线程）
// 在EnterI()的末尾 会调用UnlinkAfterAcquire(current, &node);
void ObjectMonitor::UnlinkAfterAcquire(JavaThread* current, ObjectWaiter* currentNode) {
    // 线程节点在_entryList中,直接移除,因为只有持有锁的线程才能操作_entryList
    if (currentNode->TState == ObjectWaiter::TS_ENTER) {
        ObjectWaiter* nxt = currentNode->_next;
        ObjectWaiter* prv = currentNode->_prev;
        if (nxt != nullptr) nxt->_prev = prv;
        if (prv != nullptr) prv->_next = nxt;
        if (currentNode == _EntryList) _EntryList = nxt;
    }else{ // 线程节点还在_cxq中，同样也要移除,不过需要通过cas
    // ...
    }

}
```

现在来简单总结一下工作原理：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=OTgxYWFiNmM4ZjQwMjk3YjA5Njc2MjNlOWE0ZmE1YmJfaVNpdnRHZzFwSEh6bG9PTkFJYzdaNEo5NDBYaVpxdTRfVG9rZW46WWhLa2JmS1Yyb013R2R4UktvTWNQd2J1bkJlXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)

上面标红的是非常重要的,其中_owner的作用很重要，因为它是重量级锁的共享资源(说对象头有点太宽泛了)

1. 当处于轻量级锁时,每个线程的共享资源是对象头（markWord），线程再想要加锁的时候,会判断对象头是否处于无锁状态，如果是，自己cas设置对象头指向自己线程栈中的BasicObjectLock即可
2. 如果cas失败，那么再判断是否是重入的，怎么判断的？这里涉及到进程和线程的内存布局,线程是共享进程的内存空间的，所以不同的线程所属的线程栈的虚拟地址是不重复的，所以这里可以通过BasicObjectLock的地址来判断是否是重入



+ 重量级锁的共享资源：对象头 -> objectMonitor._owner

否则一旦确定存在竞争，则立即进入到膨胀过程，轻量级锁不存在自旋操作，但是在锁膨胀的过程中则存在着大量的自旋

而对于重量级锁来说，共享资源是什么呢？具体点，ObjectMonitor(每个重量级锁对象有一个)中的_owner字段，最开始的时候指向持有轻量级锁的线程栈上的BasicObjectLock，其他线程在膨胀的时候会不断的尝试将该值从entry设置为current（但是只要轻量级锁线程没有释放锁，那么就不会为nullptr）



入口队列很明显就是_cxq了，但是这里为什么需要_entryList呢?

```cpp
"We use two distinct lists to improve the odds of a constant-time dequeue operation after acquisition (in the ::enter() epilogue) and to reduce heat on the list ends."
翻译：我们使用两个独立的链表来提高获取锁后常量时间出队的可能性,并且减少链表端点的竞争热度
```

回顾ReentrantLockd,它是只用了一个队列的,那么这会出现一个什么样的问题呢？

A线程持有锁，其他线程需要插入到队列(入口队列)中进行等待，大量的cas双向链表的操作,由于cas的特点是只能保证单变量的原子性，但是双向链表有next和prev两个变量啊，如何保证正确性呢?「在真实实现中,是每个线程都将自己的prev链接到tail节点，然后cas设置tail.next = 自己的节点，只有设置成功的才算插入成功」，而唤醒的线程同样也要操作链表，

换句话说：插入和删除都在一个双向链表中，并且充斥着大量的cas(cas是有性能损耗的)



而synchronized采用获取锁失败时,所有的线程都cas的插入的单链表_cxq中,单链表的cas比双向链表的cas简单多了。

然后持有锁的线程再释放的时候,会将_cxq中的节点移动到_entryList,

然后唤醒第一个等待节点，然后等待节点将自己从_entryList中移除，只有持有锁的线程才会去操作_entryList

没有并发竞争问题。从而大大的提高了性能。

> 当然synchronized内部还有很多优化实现....暂时没能力去了解了
>



验证一下_cxq和_entryList的存在

```java
package com.wjcoder;

import org.openjdk.jol.info.ClassLayout;

/**
 * 在下面这个案例中,应该得到的结果是：
    - 并且可以看到thread-2先阻塞,但是却是thread-3先获取到锁,这也验证了上面逻辑的正确性
      因为线程节点每次都插入到头节点，并且唤醒的时候也是从头节点开始唤醒的
 *  - 在objectMonitor的_entryList存储的是thread_2
 *  - 在_cxq中存储的则是thread_4
 */
public class CxqAndEntryListDeno {
    public static void main(String[] args) {
        Object lock = new Object();
        Thread thread_1 = new Thread(() -> {
            System.out.println(ClassLayout.parseInstance(lock).toPrintable());
            synchronized (lock) {
                Tools.readLine();
                System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                System.out.println("thread-1 exit");
            }
        });
        thread_1.start();
        Tools.sleep(3);
        Thread thread_2 = new Thread(() -> {
            synchronized (lock) {
                System.out.println("thread-2 get the lock");
                System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                Tools.readLine();
                System.out.println("thread-2 exit");
            }
        });
        thread_2.start();
        Tools.sleep(3);
        Thread thread_3 = new Thread(() -> {
            synchronized (lock) {
                System.out.println("thread_3 get the lock");
                System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                Tools.readLine();
                System.out.println("thread_3 exit");
            }
        });
        thread_3.start();

        Tools.sleep(20);
        Thread thread_4 = new Thread(() -> {
            System.out.println("thread_4 start");
            synchronized (lock) {
                System.out.println("thread_3 get the lock");
                System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                Tools.readLine();
                System.out.println("thread_3 exit");
            }
        });
        thread_4.start();


    }
}

```

验证成功

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YzBlYzNhZTE1M2JmMmM5MDlkODgyNGZjNzQyYmEyYTdfQmxVbnpmTkdZdFdXU0FmVGNRaTNBU1lhMUNlbUxJZVZfVG9rZW46UkxVUWJ4SGF3b0NHckx4aU5LTmNITjh6blBjXzE3Njg2NTYyMTA6MTc2ODY1OTgxMF9WNA)
