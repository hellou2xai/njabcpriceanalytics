"""Claude disambiguation for the hard matches.

When semantic + price scoring leaves a Fedway item ambiguous, hand Claude the
item and its candidate UPC rows and let it pick the one that is the SAME physical
product (or none). Batched to keep it efficient; returns a chosen UPC per item.
"""
import json
import os
import re

import anthropic

MODEL = os.getenv("CROSSWALK_LLM_MODEL", "claude-sonnet-4-6")
_client = None


def _api_key():
    # allow a dedicated key for this job, else fall back to the shared one
    return os.getenv("CROSSWALK_ANTHROPIC_KEY") or os.environ["ANTHROPIC_API_KEY"]


def _cli():
    global _client
    if _client is None:
        # bounded so one slow request can't stall the whole pass
        _client = anthropic.Anthropic(api_key=_api_key(), timeout=60.0, max_retries=2)
    return _client


PROMPT = """You match distributor price-book items to a product catalogue by UPC.

For each Fedway item I give you, choose which candidate is the SAME physical \
product (same brand, same product, same size). Names are written differently on \
each side (abbreviations, word order, vintages) so judge by meaning, not spelling. \
The frontline case price is a strong signal: the right candidate usually has a \
similar wholesale case price. If no candidate is the same product, return null.

Return ONLY a JSON array, one object per item, in the same order:
[{"id": <item id>, "upc": "<chosen upc or null>", "confidence": "high|medium|low"}]

Items:
{payload}
"""


def _fmt(item):
    cands = "\n".join(
        f'    - upc={c["upc"]} | "{c["name"]}" | {c["size_ml"]}ml | '
        f'case ${c["case_price"]} | {c["wholesaler"]}'
        for c in item["candidates"]
    )
    return (f'  id={item["id"]}: "{item["name"]}" | {item["size_ml"]}ml | '
            f'case ${item["case_price"]}\n{cands}')


def disambiguate(batch):
    """batch: list of {id, name, size_ml, case_price, candidates:[{upc,name,size_ml,
    case_price,wholesaler}]}. Returns {id: (upc|None, confidence)}."""
    if not batch:
        return {}
    payload = "\n".join(_fmt(it) for it in batch)
    msg = _cli().messages.create(
        model=MODEL, max_tokens=2000,
        messages=[{"role": "user", "content": PROMPT.replace("{payload}", payload)}],
    )
    text = "".join(b.text for b in msg.content if b.type == "text")
    # the model often adds a preamble and ```json fences; pull the JSON array out
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return {}
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return {}
    out = {}
    for o in arr:
        upc = o.get("upc")
        if upc in ("null", "", "None"):
            upc = None
        out[o.get("id")] = (upc, o.get("confidence", "low"))
    return out
