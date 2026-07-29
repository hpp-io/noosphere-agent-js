# crypto-sanctions-screen — OFAC address screening, sold per call over x402

Screens crypto wallet addresses against the **public OFAC SDN** (Specially
Designated Nationals) sanctioned digital-currency address list. Buyers send an
address (or a batch) and get, per address, whether it exactly matches a
sanctioned address — with the currency and the sanctioned entity.

Why an agent pays for this: a language model **cannot** know or look up the OFAC
list; this is a data service over public-but-curated data, directly useful to
payment/on-chain agents ("is it safe to pay/trade this address?"). The list is
baked into the image at build time, so there is no runtime network dependency.

> **Not legal advice.** This is a screening aid: exact-match against a public
> list, which may lag the authoritative source. It is not a compliance
> determination. Verify against OFAC before acting.

## Data source

Authoritative OFAC SDN "Advanced" XML:
`https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml`
Parsed at build time by [parse_ofac.py](./parse_ofac.py) into `data.json`
(~950 addresses across ~18 chains: BTC/XBT, ETH, TRX, USDT, …). Rebuild the
image to refresh (OFAC updates irregularly).

## Build

```bash
docker build -t crypto-sanctions-screen:latest examples/crypto-sanctions-screen
```

## Input / output

```jsonc
// single
{ "address": "0x8589427373D6D84E98730D7795D8f6f8731FDA16" }
// or batch (max 100)
{ "addresses": ["0x8589...", "TNiq9A...", "1abc..."] }

// -> output (JSON string)
{
  "source": "OFAC SDN — Digital Currency Addresses",
  "listDate": "2026-07-27",
  "listCount": 947,
  "results": [
    { "address": "0x8589...", "sanctioned": true, "currency": "ETH", "entity": "..." }
  ],
  "anySanctioned": true,
  "disclaimer": "Screening aid ... not a compliance determination."
}
```

EVM (`0x…`) addresses match case-insensitively; other chains match exactly.

## Suggested service block

```jsonc
{
  "name": "sanctions-screen",
  "containerId": "crypto-sanctions-screen",
  "settlement": "direct",
  "network": "eip155:181228",
  "schemes": ["exact"],
  "x402Price": "2000",
  "inputSchema": {
    "type": "object",
    "properties": {
      "address": { "type": "string", "minLength": 8, "maxLength": 128 },
      "addresses": {
        "type": "array", "minItems": 1, "maxItems": 100,
        "items": { "type": "string", "minLength": 8, "maxLength": 128 }
      }
    },
    "anyOf": [{ "required": ["address"] }, { "required": ["addresses"] }]
  },
  "description": "Screen crypto addresses against the public OFAC SDN sanctions list (screening aid, not legal advice), per call"
}
```
