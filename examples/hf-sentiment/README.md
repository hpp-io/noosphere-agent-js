# Sell a HuggingFace model in ~10 minutes (golden path)

This example wraps a HuggingFace model (`distilbert-base-uncased-finetuned-sst-2-english`,
sentiment analysis) as a Noosphere compute container and sells it per-call over
**x402** — buyers pay USDC.e, you receive to your wallet, no on-chain setup required.

## The one contract your container must satisfy

```
POST /computation   body: { "input": "<raw>", ...buyer JSON fields }
  -> { "output": "<string>" }
```

That's it. The agent handles payment (402 challenge → verify → settle), input
validation, and job tracking. See [app.py](./app.py) — ~30 lines.

## 1. Build the image

```bash
cd examples/hf-sentiment
docker build -t hf-sentiment:latest .
# (optional) push to your registry: docker tag + docker push
```

## 2. Register it in `config.json`

```jsonc
{
  "containers": [
    { "id": "hf-sentiment", "name": "hf-sentiment",
      "image": "hf-sentiment:latest", "port": "8090" }
  ],
  "x402Seller": {
    "enabled": true,
    "payTo": "0xYourReceivingWallet",
    "facilitators": { "eip155:181228": "https://facilitator-sepolia.hpp.io" },
    "defaultAsset": {
      "eip155:181228": {
        "address": "0x401eCb1D350407f13ba348573E5630B83638E30D",
        "extra": { "name": "Bridged USDC", "version": "2" }
      }
    },
    "services": [
      {
        "name": "sentiment",
        "containerId": "hf-sentiment",
        "settlement": "direct",
        "network": "eip155:181228",
        "schemes": ["exact"],
        "x402Price": "5000",
        "inputSchema": {
          "type": "object", "required": ["text"],
          "properties": { "text": { "type": "string" } }
        },
        "description": "Sentiment analysis (distilbert sst-2), per call"
      }
    ]
  }
}
```

Notes:
- `containerId` is any unique string for direct x402 selling. (Selling via the
  on-chain subscription rail additionally requires the canonical container hash.)
- `x402Price` is in atomic USDC.e units — `"5000"` = 0.005 USDC.e per call.
- `payTo` just receives funds; the seller never custodies or signs payments.

## 3. Run

```bash
npm run init    # once: create keystore (shows your addresses)
npm run agent   # starts the container + paid route
```

Your service is now live at `POST /paid/compute/sentiment`.

## 4. A buyer pays and calls

Any x402 client works. Using `@x402/fetch`:

```ts
const paidFetch = wrapFetchWithPayment(fetch, client);
const r = await paidFetch("https://<your-host>/paid/compute/sentiment", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "I love this product" }),
});
// -> { jobId, service: "sentiment", output: "POSITIVE (0.9998)" }
```

Invalid input (e.g. missing `text`) is rejected with 400 **before** payment —
the buyer is never charged for a request your model can't serve. If your model
errors, the agent returns 502 and the payment is not settled.

## Adapting to your own model

Change two things in [app.py](./app.py):
1. The `pipeline(...)` call — any HF task/model (`text-generation`,
   `summarization`, `translation`, an image model, or your own fine-tune).
2. The input/output mapping in `computation()` — read the fields your
   `inputSchema` declares, return a string (or JSON-encode richer output).

Rebuild, update `inputSchema`/price in config, restart. Done.
