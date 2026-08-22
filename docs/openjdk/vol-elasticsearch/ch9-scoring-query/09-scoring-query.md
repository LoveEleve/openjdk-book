# ES 怎么用 BM25 打分，自定义 Query 怎么扩展 Lucene

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第九篇，回答打分与 Query 重写。

## 困惑：为什么搜 "hello" 分数比搜 "world" 高的文档排在前面？

排名的依据是相关性打分。ES 默认用 BM25 算法。这套算法怎么配置、怎么实现、怎么被自定义 Query 扩展？

## 分层拆解

### 1. BM25 相似度配置

`index/similarity/SimilarityProviders.java:255`：

```java
public static LegacyBM25Similarity createBM25Similarity(Settings settings, IndexVersion indexCreatedVersion) {
    float k1 = settings.getAsFloat("k1", 1.2f);
    float b = settings.getAsFloat("b", 0.75f);
    ...
    return new LegacyBM25Similarity(k1, b, discountOverlaps);
}
```

- `k1`（词频饱和因子）默认 1.2：控制词频对打分的贡献率
- `b`（文档长度归一化因子）默认 0.75：控制文档长度对打分的惩罚
- 可通过 `index.similarity.bm25.k1` / `index.similarity.bm25.b` 配置

### 2. LegacyBM25Similarity：ES 的相似度实现

`lucene/similarity/LegacyBM25Similarity.java:35`：

```java
public final class LegacyBM25Similarity extends Similarity {
    private final float k1;
    private final float b;
    ...
}
```

`k1=1.2, b=0.75` 是 BM25 的经典默认值（Lucene 的 `BM25Similarity` 也是这两个值）。ES 用 `LegacyBM25Similarity` 保持与旧版本的打分兼容。

BM25 的核心公式：
$$score = \sum_t IDF(t) \cdot \frac{f(t,d) \cdot (k_1+1)}{f(t,d) + k_1 \cdot (1 - b + b \cdot \frac{|d|}{avgdl})}$$

- 词频饱和：f 越大贡献越大，但被 k1 限制（避免词频过高主导）
- 文档长度归一化：|d|/avgdl 让长文档的词频被惩罚

### 3. SimilarityService：相似度服务

`index/similarity/SimilarityService.java` 管理索引的相似度配置，为每类字段分配合适的相似度实现（BM25/boolean/scripted 等）。

### 4. 自定义 Query 扩展

`lucene/queries/BinaryDocValuesRangeQuery.java:30`：

```java
public final class BinaryDocValuesRangeQuery extends Query {
    ...
    public Weight createWeight(IndexSearcher searcher, ScoreMode scoreMode, float boost) throws IOException {
        return new ConstantScoreWeight(this, boost) {
            // 实现 scorer() 迭代 doc_id
        };
    }
}
```

自定义 Query 通过重写 `createWeight()` 返回自定义 `Weight`，`Weight.scorer()` 生成 `Scorer` 迭代器。这就是 ES 在 `lucene/queries/` 包中扩展 Lucene 查询的方式——`BinaryDocValuesRangeQuery`（DocValues 范围查询）、`Lucene` 其他自定义 Query 都遵循这个模式。

## 失败路径

- k1/b 配置错误 → 打分不符合预期（k1 太大词频过度主导，b 太大长文档过度惩罚）
- 自定义 Query 的 `createWeight` 未实现 scorer → 查询无法迭代 doc_id
- Similarity 不匹配 → 搜索用 A 相似度，索引用 B 相似度，分数不还原

## 收网

BM25 是 ES 默认相关度算法，通过 `SimilarityProviders.createBM25Similarity()`（L255）配置，`k1=1.2, b=0.75`。`LegacyBM25Similarity` 实现 ES 对 Lucene Similarity 的定制。自定义 Query 通过重写 `createWeight()` 扩展 Lucene 查询能力。

## 下篇桥接

E-12 Lucene 集成层。
ENDOFFILE