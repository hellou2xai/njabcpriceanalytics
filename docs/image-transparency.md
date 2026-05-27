# Product image transparency — migration record & runbook

A record of the one-time job that made the catalog product images transparent,
so we can audit or undo it later.

## What was done (2026-05-27)

Product photos from Go-UPC are JPEGs/PNGs with a **white background baked in**,
which looked like white boxes in dark mode. We removed the background and
repointed the app at the transparent versions.

Pipeline (`scripts/transparent_images.py`, default run):
1. **Backed up** every object in the R2 bucket (`celrimages`) to the local
   `image_backup/` folder (originals, untouched — ~4.6 GB, gitignored).
2. **Removed the background** with `rembg` (u2net) → RGBA PNG.
3. **Uploaded** each transparent PNG to a **new key** under the `t1/` prefix
   (e.g. `products/80686007630.jpg` → `t1/products/80686007630.png`). New keys
   are required because originals are served with an immutable 1-year
   `Cache-Control`, so overwriting them would not refresh caches.
4. **Repointed** `product_enrichment.image_url` (live Render DB) from
   `/products/<base>.<ext>` to `/t1/products/<base>.png` (`--repoint-db`).
5. **Reloaded** the live pricing cache.

**Scope:** 20,942 images processed / ~20,957 enriched rows repointed.
Affected keys are listed in `docs/image-transparency-manifest.txt`.

## Safety / what is preserved

- **Originals are never deleted.** They remain on R2 under their original keys
  **and** in the local `image_backup/` folder.
- The transparent versions live at separate `t1/` keys, so both exist side by side.
- Therefore this is fully reversible by repointing the DB.

## Re-run for new images (e.g. after a future enrichment batch)

```
python scripts/transparent_images.py                      # backup + bg-remove + upload (resumable)
python scripts/transparent_images.py --repoint-db --database-url "<render external url>?sslmode=require"
# then reload the live cache (Admin -> Reload pricing, or POST /api/admin/reload-pricing)
```

## Revert (point the app back to the original white-background images)

```
python scripts/transparent_images.py --revert-db --database-url "<render external url>?sslmode=require"
# then reload the live cache
```

`--revert-db` re-lists the bucket to restore each product's original key/extension,
and sets `image_url` back from the `t1/...png` URL to the original. The transparent
`t1/` PNGs stay on R2, so a later re-`--repoint-db` is a no-op data-wise.

## Notes

- Cache reload (owner/admin): `POST /api/admin/reload-pricing` with a Bearer
  token, or the Admin page "Reload pricing" button. A Render redeploy also
  rebuilds the cache.
- `rembg` + `onnxruntime` are required for processing (not for repoint/revert).
- The local `image_backup/` and `howto.md` are gitignored; the manifest and
  scripts are tracked.
