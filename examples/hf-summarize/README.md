# hf-summarize — abstractive summarization, sold per call over x402

Wraps [`sshleifer/distilbart-cnn-6-6`](https://huggingface.co/sshleifer/distilbart-cnn-6-6)
(apache-2.0, ~460MB) as a Noosphere compute container. Buyers send long
English text and get a few-sentence summary.

See [hf-sentiment](../hf-sentiment/README.md) for the full golden-path guide;
only the specifics differ:

```bash
docker build -t hf-summarize:latest examples/hf-summarize
```

Input / output:

```jsonc
// request body (>= 20 chars, truncated at ~6000)
{ "text": "Long article text ..." }
// -> output: plain-text summary
"The article describes ..."
```

Suggested service block:

```jsonc
{
  "name": "summarize",
  "containerId": "hf-summarize",
  "settlement": "direct",
  "network": "eip155:181228",
  "schemes": ["exact"],
  "x402Price": "5000",
  "inputSchema": {
    "type": "object", "required": ["text"],
    "properties": { "text": { "type": "string", "minLength": 20, "maxLength": 6000 } }
  },
  "description": "Abstractive summarization (distilbart-cnn-6-6), per call"
}
```

Note: `transformers<5` is pinned in the Dockerfile — transformers v5 removed
the seq2seq pipeline tasks (summarization/translation).
