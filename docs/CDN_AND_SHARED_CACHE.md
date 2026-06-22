# Shared pricing cache + Cloudflare edge caching

Two changes that let the app scale past a single uvicorn worker and offload
repeat read traffic to Cloudflare.

## 1. Shared pricing cache (build once, share across workers)

**Problem.** The pricing data is materialised from Postgres into a local DuckDB
file (`user_data/pricing_*.duckdb`, ~224 MB). Each uvicorn worker is a separate
process and used to build its **own** file at boot. The build spikes to GBs, so
N workers = N concurrent multi-GB builds → the box OOMed **even at idle** (a
4-CPU instance defaulting `WEB_CONCURRENCY=4` meant ~4 simultaneous builds).

**Fix** (`backend/pricing_cache.py`):
- **Cross-process build lock** (`user_data/pricing_build.lock`, `O_CREAT|O_EXCL`,
  30-min stale reclaim): only ONE process builds at a time. The others wait and
  then adopt the finished file — no duplicate builds.
- **Atomic publish**: the build writes a hidden `.building_*.duckdb` temp and
  `os.replace()`s it into its versioned name, so a worker never opens a
  half-written file.
- **Pointer file** (`user_data/pricing_current`) names the active cache. Every
  worker reads it (throttled to every ~3 s on the hot path), so a reload in ANY
  worker propagates to all of them within seconds — `db._get_pool()` rebuilds
  its read-only connections when the path changes. No restart needed.
- `build_pricing_cache(force=False)` adopts an already-published file (boot /
  first use); `force=True` (admin reload, new monthly data) always rebuilds and
  republishes the pointer.

**Memory after the fix:** one build (~2 GB transient) regardless of worker
count; each worker then memory-maps the same 224 MB file read-only, and the OS
page cache shares those pages across workers.

**Scaling workers.** `Dockerfile` pins `--workers ${UVICORN_WORKERS:-1}`. With
the shared cache it is now safe to raise `UVICORN_WORKERS` (e.g. 2–3 on the
8 GB / 4-CPU Pro Plus instance) via the Render dashboard for more concurrency —
only the first worker builds; the rest adopt the pointer. Boot footprint stays
~one build + N × (shared 224 MB mmap + per-conn query memory, capped by
`DUCKDB_MEMORY_LIMIT`, default 512 MB).

Tunables (env): `DUCKDB_BUILD_MEMORY_LIMIT` (2 GB), `DUCKDB_BUILD_THREADS` (2),
`DUCKDB_BUILD_LOCK_WAIT` (600 s), `DUCKDB_MEMORY_LIMIT` (512 MB),
`DUCKDB_TEMP_DIR` (spill dir).

## 2. Cloudflare edge caching

**App side (done).** User-independent boards opt INTO edge caching via
`backend/http_cache.public_conditional`, which now emits:

```
Cache-Control: public, max-age=120, s-maxage=300, stale-while-revalidate=900
ETag: W/"<hash of pricing-file + query key>"
```

- `s-maxage=300` is the **shared-cache** TTL — Cloudflare serves repeat hits
  from the edge for 5 min without waking the origin worker.
- `stale-while-revalidate=900` lets the edge serve a slightly stale board while
  it refreshes in the background.
- The `ETag` is keyed on the pricing-cache file path, so a reload changes it →
  the next edge revalidation refetches. Correctness is preserved; worst case is
  a few minutes of edge staleness after a monthly reload.

Endpoints opted in (all verified user-independent / gated against per-user
data): `/api/analytics/*` boards (price-movers), `/api/deals/*`
(discounts, clearance, combos, RIP/time-sensitive), the user-independent
`/api/catalog` search + facets, and the `/api/compare` boards (non-admin).

**Default-deny safety net** (`backend/main.py` middleware): every other `/api/*`
response that did NOT opt in is stamped `Cache-Control: private, no-store`, so a
broad Cloudflare "Cache Everything" rule can never cache auth / cart / lists /
watchlist / orders / assistant responses. **Do not** remove this before turning
on a Cache-Everything rule.

**Cloudflare config (operational — set in the dashboard):**
1. Proxy the app hostname through Cloudflare (orange cloud).
2. Static assets (`/assets/*`) are already `immutable`; default CF caching
   serves them from the edge — no rule needed.
3. To edge-cache the API boards, add a **Cache Rule** for the API host/path that
   sets **"Eligible for cache" / Cache Everything** and **"Respect origin
   cache-control / Use origin TTL"**. Because the app emits `s-maxage` only on
   safe responses and `private, no-store` everywhere else, CF will cache exactly
   the board responses and skip all user data.
4. Leave "Cache by query string" at default (cache by full URL) so different
   `edition`/`wholesaler`/filter combinations cache separately.
5. Do **not** add the `Authorization` header to the cache key — board responses
   are identical regardless of caller, and keying on the token would defeat the
   cache.

Verify after enabling: `curl -sI https://nj.celr.ai/api/deals/discounts` should
show `cf-cache-status: HIT` on the second call and the `s-maxage` header; a
user endpoint like `/api/cart` should show `cf-cache-status: DYNAMIC` (bypassed)
and `cache-control: private, no-store`.
