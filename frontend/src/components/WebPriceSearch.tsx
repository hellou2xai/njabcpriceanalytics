import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin, ExternalLink, Search, X } from 'lucide-react';
import { catalog, websearch } from '../lib/api';
import { distributorName } from '../lib/distributors';

interface Target {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
}

interface Ctx { open: (t: Target) => void; close: () => void; }
const WebSearchCtx = createContext<Ctx>({ open: () => {}, close: () => {} });
export const useWebPriceSearch = () => useContext(WebSearchCtx);

export function WebPriceSearchProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const open = useCallback((t: Target) => setTarget(t), []);
  const close = useCallback(() => setTarget(null), []);
  return (
    <WebSearchCtx.Provider value={{ open, close }}>
      {children}
      {target && <WebSearchModal target={target} onClose={close} />}
    </WebSearchCtx.Provider>
  );
}

type GeoStatus = 'idle' | 'asking' | 'granted' | 'denied' | 'unavailable';

function WebSearchModal({ target, onClose }: { target: Target; onClose: () => void }) {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geo, setGeo] = useState<GeoStatus>('idle');

  // Resolve the exact SKU (vintage, type, pack, our wholesale price).
  const { data: detail } = useQuery({
    queryKey: ['product-detail', target.wholesaler, target.productName, target.upc, target.unitVolume],
    queryFn: () => catalog.product(target.wholesaler, target.productName, { upc: target.upc, unit_volume: target.unitVolume }),
  });
  const p = detail?.product;

  const askLocation = useCallback(() => {
    if (!('geolocation' in navigator)) { setGeo('unavailable'); return; }
    setGeo('asking');
    navigator.geolocation.getCurrentPosition(
      pos => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGeo('granted'); },
      () => setGeo('denied'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }, []);

  // Ask for location up front (the browser shows its own permission prompt).
  useEffect(() => { askLocation(); }, [askLocation]);

  const vintage = (p as { vintage?: string } | undefined)?.vintage;
  const { data, isLoading } = useQuery({
    enabled: !!p,
    queryKey: ['websearch', target.wholesaler, target.productName, p?.upc, p?.unit_volume, vintage, coords?.lat, coords?.lng],
    queryFn: () => websearch.product({
      product_name: target.productName,
      product_type: p?.product_type,
      vintage,
      unit_volume: p?.unit_volume,
      unit_qty: p?.unit_qty,
      upc: p?.upc,
      lat: coords?.lat,
      lng: coords?.lng,
    }),
  });

  const ourEffBtl = p && Number(p.unit_qty) > 0 ? p.effective_case_price / Number(p.unit_qty) : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Search size={18} />
          <h3 style={{ margin: 0 }}>Prices &amp; details on the web</h3>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          {target.productName}
          {data?.vintage && <span className="tag tag-blue" style={{ marginLeft: 8, fontSize: 11 }}>Vintage {data.vintage}</span>}
          {data?.unit_volume && <span style={{ marginLeft: 8 }}>· {data.unit_volume}</span>}
        </p>

        {/* Location + our price context */}
        <div className="web-search-bar">
          <span className={`web-geo web-geo-${geo}`}>
            <MapPin size={14} />
            {geo === 'asking' && 'Requesting your location…'}
            {geo === 'granted' && `Using your location${data?.location ? ` (${data.location})` : ''}`}
            {geo === 'denied' && 'Location off — results aren’t local. '}
            {geo === 'unavailable' && 'Geolocation not supported. '}
            {geo === 'idle' && 'Location not requested. '}
            {(geo === 'denied' || geo === 'unavailable' || geo === 'idle') && (
              <button className="btn-link" onClick={askLocation} type="button">Use my location</button>
            )}
          </span>
          {p && (
            <span className="web-our-price">
              Your wholesale: <strong>${p.effective_case_price?.toFixed(2)}/cs</strong>
              {ourEffBtl != null && <> · <strong>${ourEffBtl.toFixed(2)}/btl</strong></>}
            </span>
          )}
        </div>

        {data?.query && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Matched search: <strong>{data.query}</strong>
          </p>
        )}

        {isLoading && <p>Searching…</p>}

        {/* Live structured results (when a search provider is configured) */}
        {data && data.results.length > 0 && (
          <div className="web-results-grid">
            {data.results.map((r, i) => (
              <a key={i} className="web-result-card" href={r.link ?? '#'} target="_blank" rel="noreferrer">
                {r.thumbnail && <img src={r.thumbnail} alt="" className="web-result-img" />}
                <div className="web-result-body">
                  <div className="web-result-title" title={r.title ?? ''}>{r.title}</div>
                  <div className="web-result-meta">
                    <span className="web-result-price">{r.price ?? '—'}</span>
                    {r.store && <span className="text-muted"> · {r.store}</span>}
                  </div>
                  {(r.rating || r.delivery) && (
                    <div className="text-muted" style={{ fontSize: 11 }}>
                      {r.rating ? `★ ${r.rating}${r.reviews ? ` (${r.reviews})` : ''}` : ''}{r.rating && r.delivery ? ' · ' : ''}{r.delivery ?? ''}
                    </div>
                  )}
                </div>
              </a>
            ))}
          </div>
        )}

        {/* Always-available real listings (location-aware in the browser) */}
        {data && (
          <>
            <h4 style={{ marginBottom: 6 }}>Open live listings</h4>
            <div className="web-links">
              {data.links.map((l, i) => (
                <a key={i} className="web-link-card" href={l.url} target="_blank" rel="noreferrer">
                  <div className="web-link-head"><ExternalLink size={14} /> {l.label}</div>
                  <div className="web-link-why">{l.why}</div>
                </a>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{data.note}</p>

            {(data.info_results.length > 0 || data.info_links.length > 0) && (
              <>
                <h4 style={{ marginBottom: 6, marginTop: 16 }}>Additional details</h4>
                {data.info_results.length > 0 && (
                  <div className="web-info-results">
                    {data.info_results.map((r, i) => (
                      <a key={i} className="web-info-result" href={r.link ?? '#'} target="_blank" rel="noreferrer">
                        <div className="web-info-title">{r.title}</div>
                        {r.snippet && <div className="web-info-snippet">{r.snippet}</div>}
                        {r.source && <div className="web-info-source">{r.source}</div>}
                      </a>
                    ))}
                  </div>
                )}
                <div className="web-links">
                  {data.info_links.map((l, i) => (
                    <a key={i} className="web-link-card" href={l.url} target="_blank" rel="noreferrer">
                      <div className="web-link-head"><ExternalLink size={14} /> {l.label}</div>
                      <div className="web-link-why">{l.why}</div>
                    </a>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
