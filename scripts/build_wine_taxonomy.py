"""Crawl wine-searcher's region pages into a canonical wine-region taxonomy.

Output: backend/data/wine_regions.json  ->  { country: [region/appellation, ...] }

This is the controlled vocabulary every wine product is classified INTO, so the
facets don't fragment ("Napa" vs "Napa Valley"). wine-searcher is the authority
for country + region SPELLINGS; subregion depth and grape synonyms are layered
on by the model afterwards. Polite sequential crawl with a small delay.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.parse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
BASE = "https://www.wine-searcher.com/regions-"

# The 11 global-nav country links repeated on every page (noise to strip).
_NAV = {"argentina", "australia", "chile", "france", "germany", "italy",
        "new zealand", "portugal", "south africa", "spain", "usa"}

# From /regions: the 114 nodes minus the dozen that are really a country's
# region (bordeaux/burgundy/...), leaving the country level to crawl.
_SUBREGION_NODES = {"bordeaux", "burgundy", "california", "tuscany", "champagne",
                    "piedmont", "rhone", "south australia", "veneto", "rioja",
                    "douro", "mendoza"}

COUNTRIES = [
    "argentina", "australia", "chile", "france", "germany", "italy",
    "new zealand", "portugal", "south africa", "spain", "usa", "albania",
    "armenia", "austria", "azerbaijan", "belarus", "belgium",
    "bosnia-herzegovina", "bulgaria", "crimea", "croatia", "cyprus",
    "czech republic", "denmark", "estonia", "finland", "georgian republic",
    "greece", "hungary", "iceland", "ireland", "kosovo", "latvia",
    "liechtenstein", "lithuania", "luxembourg", "malta", "moldova",
    "montenegro", "netherlands", "norway", "poland", "romania", "russia",
    "serbia", "slovakia", "slovenia", "sweden", "switzerland", "turkey",
    "uk", "ukraine", "canada", "mexico", "bolivia", "brazil", "colombia",
    "ecuador", "peru", "uruguay", "venezuela", "china", "india", "indonesia",
    "israel", "japan", "jordan", "kazakhstan", "lebanon", "myanmar", "nepal",
    "philippines", "south korea", "sri lanka", "syria", "thailand", "vietnam",
    "algeria", "egypt", "madagascar", "mauritius", "morocco", "namibia",
    "tanzania", "tunisia", "zimbabwe",
]


def _fetch(slug: str) -> str | None:
    url = BASE + urllib.parse.quote_plus(slug)
    try:
        r = subprocess.run(
            ["curl", "-s", "--compressed", "-A", UA,
             "-H", "Accept-Language: en-US,en;q=0.9",
             "-H", "Accept: text/html", "--max-time", "30", url],
            capture_output=True, timeout=40)
        html = r.stdout.decode("utf-8", "replace")
        if len(html) < 5000 or "Access Denied" in html[:2000]:
            print(f"  ! {slug}: blocked/short ({len(html)} bytes)")
            return None
        return html
    except Exception as e:  # noqa
        print(f"  ! {slug}: {e}")
        return None


def _regions_from(html: str, self_slug: str) -> list[str]:
    from collections import OrderedDict
    out: list[str] = []
    for h in OrderedDict.fromkeys(re.findall(r'href="(/regions-[^"]+)"', html)):
        nm = urllib.parse.unquote_plus(h.replace("/regions-", ""))
        nm = re.sub(r"\s*\[[^\]]*\]", "", nm)        # drop "[piemonte]" alt spell
        nm = re.split(r"[#?]", nm)[0].strip()         # drop tab/anchor fragments
        low = nm.lower()
        if not nm or low in _NAV or low == self_slug.lower():
            continue
        if low not in (x.lower() for x in out):
            out.append(nm)
    return out


def main() -> None:
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "backend", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "wine_regions.json")

    tax: dict[str, list[str]] = {}
    for i, c in enumerate(COUNTRIES, 1):
        html = _fetch(c)
        if not html:
            continue
        regions = [r for r in _regions_from(html, c) if r.lower() not in _NAV]
        tax[c] = regions
        print(f"[{i}/{len(COUNTRIES)}] {c}: {len(regions)} regions")
        time.sleep(0.4)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(tax, f, indent=1, ensure_ascii=False, sort_keys=True)
    total = sum(len(v) for v in tax.values())
    print(f"\nWROTE {out_path}: {len(tax)} countries, {total} region/appellation nodes")


if __name__ == "__main__":
    main()
