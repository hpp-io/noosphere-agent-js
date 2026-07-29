# crypto-sanctions-screen — screen crypto wallet addresses against the public
# OFAC SDN sanctioned digital-currency address list.
#
# Contract: POST /computation { "input": "<raw>", ...parsed-json-fields }
#           -> { "output": "<string>" }
#
# Buyer sends {"address": "0x..."} or {"addresses": ["...", ...]}. Returns, per
# address, whether it EXACTLY matches an OFAC-listed sanctioned address, with the
# currency + sanctioned entity. This is a screening aid against a public list —
# NOT legal advice or a compliance determination.

import json

from fastapi import FastAPI, Request

app = FastAPI()

with open("data.json", "r", encoding="utf-8") as f:
    _DATA = json.load(f)
_META = _DATA["meta"]
_ADDRS = _DATA["addresses"]

DISCLAIMER = (
    "Screening aid against the public OFAC SDN digital-currency address list; "
    "exact-match only, not fuzzy. Not legal advice or a compliance determination. "
    "Verify against the authoritative OFAC source before acting."
)
MAX_BATCH = 100


def _norm(addr: str) -> str:
    a = addr.strip()
    return a.lower() if a.startswith("0x") else a


def _screen(addr: str) -> dict:
    if not isinstance(addr, str) or not addr.strip():
        return {"address": addr, "error": "empty address"}
    hit = _ADDRS.get(_norm(addr))
    if hit:
        return {
            "address": addr,
            "sanctioned": True,
            "currency": hit["currency"],
            "entity": hit["entity"],
        }
    return {"address": addr, "sanctioned": False}


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()
    addresses = body.get("addresses")
    if addresses is None:
        one = body.get("address") or body.get("input")
        addresses = [one] if one else []
    if not isinstance(addresses, list) or not addresses:
        return {"output": "error: provide 'address' (string) or 'addresses' (array)"}
    addresses = addresses[:MAX_BATCH]

    results = [_screen(a) for a in addresses]
    return {
        "output": json.dumps(
            {
                "source": _META["source"],
                "listDate": _META["listDate"],
                "listCount": _META["count"],
                "results": results,
                "anySanctioned": any(r.get("sanctioned") for r in results),
                "disclaimer": DISCLAIMER,
            }
        )
    }


@app.get("/health")
async def health():
    return {"ok": True, "listCount": _META["count"], "listDate": _META["listDate"]}
