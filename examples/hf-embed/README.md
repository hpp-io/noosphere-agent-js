# hf-embed — sentence embeddings, sold per call over x402

Wraps [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
(apache-2.0, ~91MB) as a Noosphere compute container. Buyers send text, get a
384-dim normalized embedding — a drop-in building block for semantic search,
RAG and similarity, priced per call in USDC.e.

See [hf-sentiment](../hf-sentiment/README.md) for the full golden-path guide;
only the specifics differ:

```bash
docker build -t hf-embed:latest examples/hf-embed
```

Input / output:

```jsonc
// request body
{ "text": "How do I reset my password?" }
// -> output (JSON string)
{ "model": "all-MiniLM-L6-v2", "dim": 384, "embedding": [0.0123, -0.0456, ...] }
```

Suggested service block:

```jsonc
{
  "name": "embed",
  "containerId": "hf-embed",
  "settlement": "direct",
  "network": "eip155:181228",
  "schemes": ["exact"],
  "x402Price": "1000",
  "inputSchema": {
    "type": "object", "required": ["text"],
    "properties": { "text": { "type": "string", "minLength": 1, "maxLength": 5000 } }
  },
  "description": "Sentence embedding (all-MiniLM-L6-v2, 384-dim), per call"
}
```
