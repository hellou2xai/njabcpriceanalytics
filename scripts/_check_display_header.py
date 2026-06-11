import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.celr import display_header

cases = [
    ("Benziger Family Winery Cabernet Sauvignon, Sonoma County, 2008", "Wine",
     "Benziger Family Winery Cabernet Sauvignon, Sonoma County"),
    ("Joseph Drouhin Gevrey Chambertin 2023", "Wine",
     "Joseph Drouhin Gevrey Chambertin"),
    ("Archimedes Francis Coppola Alexander Cabernet 2018 Rated 91WA", "Wine",
     "Archimedes Francis Coppola Alexander Cabernet Rated 91WA"),
    ("2019 Caymus Cabernet", "Wine", "Caymus Cabernet"),
    ("Old Forester 1910 Whisky Row", "Spirits", "Old Forester 1910 Whisky Row"),
    ("1792 Small Batch Bourbon", "Spirits", "1792 Small Batch Bourbon"),
    ("Jim Beam Orange Kentucky Straight Bourbon Whiskey", "Spirits",
     "Jim Beam Orange Kentucky Straight Bourbon Whiskey"),
    ("Coppola Diamond Collection Prosecco", "Sparkling Wine",
     "Coppola Diamond Collection Prosecco"),
    ("", "Wine", ""),
    (None, None, ""),
]
ok = True
for name, t, want in cases:
    got = display_header(name, t)
    mark = "ok" if got == want else "FAIL"
    if got != want:
        ok = False
    print(f"  {mark}  {name!r} [{t}] -> {got!r} (want {want!r})")
print("ALL OK" if ok else "FAILURES")
sys.exit(0 if ok else 1)
