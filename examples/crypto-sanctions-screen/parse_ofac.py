# Build-time: download the authoritative OFAC SDN advanced XML, extract every
# sanctioned digital-currency address (+ currency + sanctioned party name), and
# bake a compact data.json into the image. No runtime network needed.
#
# Authoritative source (see README): OFAC SDN "Advanced" XML.

import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET

OFAC_URL = os.environ.get(
    "OFAC_SDN_URL",
    "https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml",
)
NS = "{https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML}"
XML_PATH = "/tmp/sdn_advanced.xml"
OUT_PATH = os.environ.get("OUT_PATH", "data.json")


def t(tag: str) -> str:
    return NS + tag


def download() -> None:
    print(f"[parse_ofac] downloading {OFAC_URL}", flush=True)
    req = urllib.request.Request(OFAC_URL, headers={"User-Agent": "hpp-x402-ofac-screen/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(XML_PATH, "wb") as f:
        f.write(r.read())
    print(f"[parse_ofac] downloaded {os.path.getsize(XML_PATH)} bytes", flush=True)


def publish_date() -> str:
    # DateOfIssue lives in the file header; read a small prefix.
    import re

    with open(XML_PATH, "r", encoding="utf-8", errors="ignore") as f:
        head = f.read(4000)
    m = re.search(r"<DateOfIssue.*?</DateOfIssue>", head, re.S)
    if not m:
        return ""
    blk = m.group(0)
    y = re.search(r"<Year>(\d+)</Year>", blk)
    mo = re.search(r"<Month>(\d+)</Month>", blk)
    d = re.search(r"<Day>(\d+)</Day>", blk)
    if y and mo and d:
        return f"{int(y.group(1)):04d}-{int(mo.group(1)):02d}-{int(d.group(1)):02d}"
    return ""


def parse() -> dict:
    # Pass 1: crypto FeatureTypeID -> currency ticker.
    crypto: dict[str, str] = {}
    for _, el in ET.iterparse(XML_PATH, events=("end",)):
        if el.tag == t("FeatureType"):
            s = el.text or ""
            if s.startswith("Digital Currency Address"):
                crypto[el.attrib.get("ID")] = s.split(" - ")[-1].strip()
            el.clear()
        if el.tag == t("DistinctParties"):
            el.clear()
            break

    # Pass 2: sanctioned parties -> crypto address features.
    addresses: dict[str, dict] = {}
    for _, el in ET.iterparse(XML_PATH, events=("end",)):
        if el.tag != t("Profile"):
            continue
        name = None
        for al in el.iter(t("Alias")):
            if al.attrib.get("Primary") == "true":
                vals = [v.text for v in al.iter(t("NamePartValue")) if v.text]
                if vals:
                    name = " ".join(vals)
                    break
        for feat in el.iter(t("Feature")):
            ftid = feat.attrib.get("FeatureTypeID")
            cur = crypto.get(ftid)
            if not cur:
                continue
            for vd in feat.iter(t("VersionDetail")):
                addr = (vd.text or "").strip()
                if not addr:
                    continue
                key = addr.lower() if addr.startswith("0x") else addr
                addresses[key] = {"address": addr, "currency": cur, "entity": name}
        el.clear()

    return {
        "meta": {
            "source": "OFAC SDN (Specially Designated Nationals) — Digital Currency Addresses",
            "sourceUrl": OFAC_URL,
            "listDate": publish_date(),
            "count": len(addresses),
        },
        "addresses": addresses,
    }


def main() -> None:
    download()
    data = parse()
    if data["meta"]["count"] == 0:
        print("[parse_ofac] ERROR: 0 addresses parsed — aborting build", file=sys.stderr)
        sys.exit(1)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.remove(XML_PATH)
    print(
        f"[parse_ofac] wrote {OUT_PATH}: {data['meta']['count']} addresses, "
        f"listDate={data['meta']['listDate']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
