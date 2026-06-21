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
records = []          # (endpoint, ms, ok, status, half, is304)  appended under lock
_lock = threading.Lock()
login_lat = []
login_fail = 0
# Shared conditional-GET cache (mimics a CDN/browser): URL -> ETag. On a repeat
# the client sends If-None-Match and the server returns a cheap 304 before doing
# any work, which is the whole point of Phase 1 caching.
_etags = {}
_etag_lock = threading.Lock()


def hit(sess, label, method, url, **kw):
    params = kw.get("params") or {}
    key = (method, url, tuple(sorted((str(k), str(v)) for k, v in params.items())))
    hdrs = dict(kw.pop("headers", {}) or {})
    with _etag_lock:
        et = _etags.get(key)
    if et:
        hdrs["If-None-Match"] = et
    kw["headers"] = hdrs
    t = time.time()
    ok, status, is304 = False, "ERR", False
    try:
        r = sess.request(method, url, timeout=45, **kw)
        status = r.status_code
        ok = r.status_code < 400
        is304 = r.status_code == 304
        if r.status_code == 200 and r.headers.get("ETag"):
            with _etag_lock:
                _etags[key] = r.headers["ETag"]
    except Exception as e:  # noqa: BLE001
        status = type(e).__name__
    ms = (time.time() - t) * 1000
    half = 0 if (time.time() - _t0) < (DURATION / 2 + 3) else 1
    with _lock:
        records.append((label, ms, ok, status, half, is304))
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

    # Warm the shared ETag cache once (mimics a populated CDN/edge) so the
    # concurrent run measures the CACHED steady state — repeat reads return cheap
    # 304s — instead of a cold-miss heavy-query burst. Set WARM=0 for a cold run.
    global _t0
    if os.getenv("WARM", "1").lower() in ("1", "true", "yes", "on"):
        try:
            wt = requests.post(f"{API}/api/auth/login", json={"email": EMAIL, "password": PW},
                               timeout=45).json().get("token")
            ws = requests.Session()
            ws.headers["Authorization"] = f"Bearer {wt}"
            for q in SEARCHES:
                hit(ws, "search(text)", "GET", f"{API}/api/catalog/search",
                    params={"q": q, "limit": 60, "sort": "product_name", "order": "asc", "images_first": "true"})
                hit(ws, "facets", "GET", f"{API}/api/catalog/facets", params={"q": q})
            for u in UPCS:
                hit(ws, "search(include_tiers)", "GET", f"{API}/api/catalog/search",
                    params={"upcs": u, "include_tiers": "true", "limit": 50})
            with _lock:
                records.clear()        # don't count warm-up in the measured window
            print(f"warmed {len(_etags)} ETags\n")
        except Exception as e:  # noqa: BLE001
            print("warm-up skipped:", e)

    _t0 = time.time()
    start = time.time()
    with ThreadPoolExecutor(max_workers=USERS) as ex:
        list(ex.map(user, range(USERS)))
    wall = time.time() - start

    from collections import Counter
    n = len(records)
    errs = [r for r in records if not r[2]]
    hits304 = [r for r in records if r[5]]
    login_line = (f"Logins: {USERS - login_fail}/{USERS} ok | login p50={pct(login_lat,50):.0f}ms "
                  f"p95={pct(login_lat,95):.0f}ms max={max(login_lat or [0]):.0f}ms")
    req_line = (f"Requests: {n} in {wall:.1f}s = {n / wall:.1f} req/s | "
                f"errors: {len(errs)} ({100*len(errs)/max(n,1):.1f}%) | "
                f"304 cache-hits: {len(hits304)} ({100*len(hits304)/max(n,1):.1f}%)")
    print(login_line)
    print(req_line + "\n")

    rows = []
    hdr = f"{'endpoint':<26}{'n':>6}{'p50':>8}{'p95':>8}{'p99':>8}{'max':>8}{'304%':>7}{'err%':>7}"
    print(hdr)
    for label in ["search(text)", "search(include_tiers)", "cart", "facets"]:
        lat = [r[1] for r in records if r[0] == label]
        if not lat:
            continue
        e = [r for r in records if r[0] == label and not r[2]]
        h = [r for r in records if r[0] == label and r[5]]
        line = (f"{label:<26}{len(lat):>6}{pct(lat,50):>8.0f}{pct(lat,95):>8.0f}"
                f"{pct(lat,99):>8.0f}{max(lat):>8.0f}{100*len(h)/len(lat):>6.0f}%{100*len(e)/len(lat):>6.1f}%")
        print(line)
        rows.append(line)

    h0 = [r[1] for r in records if r[4] == 0]
    h1 = [r[1] for r in records if r[4] == 1]
    drift = f"Latency drift: first-half p95={pct(h0,95):.0f}ms -> second-half p95={pct(h1,95):.0f}ms"
    print("\n" + drift)
    estat = dict(Counter(str(r[3]) for r in errs)) if errs else {}
    if estat:
        print("Error statuses:", estat)
    result = "CLEAN" if not errs else f"{len(errs)} errors"
    print("\nRESULT:", result)

    # Append to the markdown log next to the screenshots.
    md = os.path.join(os.path.dirname(__file__), "load_results.md")
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with open(md, "a", encoding="utf-8") as f:
        f.write(f"\n## {USERS} users x {DURATION:.0f}s — {ts}\n\n")
        f.write(f"- {login_line}\n- {req_line}\n- {drift}\n")
        if estat:
            f.write(f"- Error statuses: {estat}\n")
        f.write("\n```\n" + hdr + "\n" + "\n".join(rows) + "\n```\n")
    print("appended ->", md)


if __name__ == "__main__":
    main()
