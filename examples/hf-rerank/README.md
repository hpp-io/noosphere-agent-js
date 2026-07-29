# hf-rerank — search-result reranking, sold per call over x402

Wraps [`cross-encoder/ms-marco-MiniLM-L6-v2`](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)
(apache-2.0, ~91MB) as a Noosphere compute container. Buyers send a query plus
candidate documents and get them scored/ranked by relevance — the standard
second stage of a retrieval pipeline (pairs well with [hf-embed](../hf-embed)).

See [hf-sentiment](../hf-sentiment/README.md) for the full golden-path guide;
only the specifics differ:

```bash
docker build -t hf-rerank:latest examples/hf-rerank
```

Input / output:

```jsonc
// request body (max 32 documents per call)
{ "query": "refund policy", "documents": ["Doc A ...", "Doc B ...", "Doc C ..."] }
// -> output (JSON string), best match first
{ "model": "ms-marco-MiniLM-L6-v2", "results": [
  { "index": 1, "score": 7.21 }, { "index": 0, "score": -2.4 }, ...
] }
```

Suggested service block:

```jsonc
{
  "name": "rerank",
  "containerId": "hf-rerank",
  "settlement": "direct",
  "network": "eip155:181228",
  "schemes": ["exact"],
  "x402Price": "1000",
  "inputSchema": {
    "type": "object", "required": ["query", "documents"],
    "properties": {
      "query": { "type": "string", "minLength": 1, "maxLength": 1000 },
      "documents": {
        "type": "array", "minItems": 1, "maxItems": 32,
        "items": { "type": "string", "minLength": 1, "maxLength": 2000 }
      }
    }
  },
  "description": "Query-document reranking (ms-marco cross-encoder), per call"
}
```
