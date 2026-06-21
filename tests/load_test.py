"""Concurrent-user load simulation against the live app.

Spawns USERS threads. Each logs in (the logins happen as a burst), then loops a
realistic workflow with human think-time for DURATION seconds: text search ->
view a couple products (include_tiers, the heavy path) -> open cart -> facets.

Reports per-endpoint latency percentiles + error rate, and first-half vs
second-half latency so degradation under sustained load is visible.

  USERS=50 DURATION=30 python tests/load_test.py

Defaults: 50 users, 30s. Override via env. Targets PROD (CELR_WEB/API).
WARNING: this loads PRODUCTION and can briefly degrade it for real users.
"""
import os
import time
import statistics
import threading
from concurrent.futures import ThreadPoolExecutor

import requests

API = os.getenv("CELR_API", os.getenv("CELR_WEB", "https://nj.celr.ai")).rstrip("/")
EMAIL = os.getenv("CELR_EMAIL", "sambit.tripathy@gmail.com")
PW = os.getenv("CELR_PW", "Cuttack10!")
USERS = int(os.getenv("USERS", "50"))
DURATION = float(os.getenv("DURATION", "30"))
THINK = float(os.getenv("THINK", "0.5"))  # seconds between actions per user

SEARCHES = ["vodka", "tito", "casamigos", "1792 bourbon", "grey goose", "whiskey",
            "tequila", "wine", "bourbon", "absolut"]
UPCS = ["82000812128", "80660001203", "80686007326", "860010300046", "80480990107"]

_t0 = time.time()
records = []          # (endpoint, ms, status_ok, half)  appended under lock
_lock = threading.Lock()
login_lat = []
login_fail = 0


def hit(sess, label, method, url, **kw):
    t = time.time()
    ok, status = False, "ERR"
    try:
        r = sess.request(method, url, timeout=45, **kw)
        status = r.status_code
        ok = r.status_code < 400
    except Exception as e:  # noqa: BLE001
        status = type(e).__name__
    ms = (time.time() - t) * 1000
    half = 0 if (time.time() - _t0) < (DURATION / 2 + 3) else 1
    with _lock:
        records.append((label, ms, ok, status, half))
    return ok


def user(idx):
    global login_fail
    sess = requests.Session()
    t = time.time()
    try:
        r = sess.post(f"{API}/api/auth/login", json={"email": EMAIL, "password": PW}, timeout=45)
        tok = r.json().get("token") if r.ok else None
    except Exception:
        tok = None
    with _lock:
        login_lat.append((time.time() - t) * 1000)
        if not tok:
            login_fail += 1
    if not tok:
        return
    sess.headers["Authorization"] = f"Bearer {tok}"
    i = idx
    deadline = _t0 + DURATION
    while time.time() < deadline:
        q = SEARCHES[i % len(SEARCHES)]
        u = UPCS[i % len(UPCS)]
        hit(sess, "search(text)", "GET", f"{API}/api/catalog/search",
            params={"q": q, "limit": 60, "sort": "product_name", "order": "asc", "images_first": "true"})
        time.sleep(THINK)
        hit(sess, "search(include_tiers)", "GET", f"{API}/api/catalog/search",
            params={"upcs": u, "include_tiers": "true", "limit": 50})
        time.sleep(THINK)
        hit(sess, "cart", "GET", f"{API}/api/cart")
        time.sleep(THINK)
        hit(sess, "facets", "GET", f"{API}/api/catalog/facets", params={"q": q})
        time.sleep(THINK)
        i += 7


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    k = min(len(s) - 1, int(round((p / 100) * (len(s) - 1))))
    return s[k]


def main():
    print(f"== Load test: {USERS} concurrent users x {DURATION:.0f}s vs {API} ==")
    print("WARNING: loading PRODUCTION. Watch the Render memory/CPU graph.\n")
    start = time.time()
    with ThreadPoolExecutor(max_workers=USERS) as ex:
        list(ex.map(user, range(USERS)))
    wall = time.time() - start

    n = len(records)
    errs = [r for r in records if not r[2]]
    print(f"Logins: {USERS - login_fail}/{USERS} ok | login p50={pct(login_lat,50):.0f}ms "
          f"p95={pct(login_lat,95):.0f}ms max={max(login_lat or [0]):.0f}ms")
    print(f"Requests: {n} in {wall:.1f}s = {n / wall:.1f} req/s | "
          f"errors: {len(errs)} ({100*len(errs)/max(n,1):.1f}%)\n")

    print(f"{'endpoint':<26}{'n':>6}{'p50':>8}{'p95':>8}{'p99':>8}{'max':>8}{'err%':>7}")
    for label in ["search(text)", "search(include_tiers)", "cart", "facets"]:
        lat = [r[1] for r in records if r[0] == label]
        e = [r for r in records if r[0] == label and not r[2]]
        if not lat:
            continue
        print(f"{label:<26}{len(lat):>6}{pct(lat,50):>8.0f}{pct(lat,95):>8.0f}"
              f"{pct(lat,99):>8.0f}{max(lat):>8.0f}{100*len(e)/len(lat):>6.1f}%")

    # Degradation: first half vs second half latency (all endpoints).
    h0 = [r[1] for r in records if r[4] == 0]
    h1 = [r[1] for r in records if r[4] == 1]
    print(f"\nLatency drift: first-half p95={pct(h0,95):.0f}ms -> second-half p95={pct(h1,95):.0f}ms")

    # Error status breakdown.
    if errs:
        from collections import Counter
        c = Counter(str(r[3]) for r in errs)
        print("Error statuses:", dict(c))
    print("\nRESULT:", "CLEAN" if len(errs) == 0 else f"{len(errs)} errors — see above")


if __name__ == "__main__":
    main()
