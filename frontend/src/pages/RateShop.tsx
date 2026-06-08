import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ShoppingBag, Crown, TrendingUp, Clock, Layers as MixIcon, FileText, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { compare } from '../lib/api';
import type { RateShopOffer, RateShopCondition } from '../lib/api';
import { distributorName, skuLabel } from '../lib/distributors';
import BasketView from '../components/BasketView';
import ProductSearchBox from '../components/ProductSearchBox';
import RowActions from '../components/RowActions';
import './ComparePrices.css';
import './Price360.css';
import './RateShop.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const pct = (v?: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
// total discount off the list price for a tier — always correlates with the
// price shown (RIP-alone amounts mismatched it when a QD stacked on some rows).
const offList = (frontline?: number | null, after?: number | null) =>
  (frontline != null && after != null && frontline - after > 0.005) ? `−${money(frontline - after)}` : '—';
const ACCENTS = ['#16a34a', '#2563eb', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#65a30d'];

const condIcon = (t: string) =>
  t === 'window' ? <Clock size={11} /> : t === 'combo' ? <MixIcon size={11} />
  : t === 'invoice' ? <FileText size={11} /> : t === 'preapproval' ? <AlertTriangle size={11} />
  : null;

/** Break-even band: which distributor is cheapest across volume. */
function BreakevenBand({ ranges, accent }: { ranges: { from: number; to: number | null; winner: string | null }[]; accent: Record<string, string> }) {
  const segs = ranges.filter(r => r.winner);
  if (segs.length < 2) return null;
  const maxTo = Math.max(...segs.map(s => s.to ?? s.from + 4));
  return (
    <div className="rs-band">
      <div className="rs-band-title">Who's cheapest as you buy more</div>
      <div className="rs-band-track">
        {segs.map((s, i) => {
          const to = s.to ?? maxTo;
          const w = ((to - s.from + 1) / (maxTo)) * 100;
          const col = s.winner === 'tie' ? 'var(--text-muted)' : accent[s.winner!] ?? 'var(--accent)';
          return (
            <div key={i} className="rs-band-seg" style={{ flexGrow: w, background: `color-mix(in srgb, ${col} 18%, transparent)`, borderColor: col }}>
              <span className="rs-band-lbl" style={{ color: col }}>
                {s.winner === 'tie' ? 'Tie' : distributorName(s.winner!)}
              </span>
              <span className="rs-band-range">{s.from}{s.to ? `–${s.to}` : '+'} cs</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Side-by-side net $/case at each volume breakpoint, both distributors,
 *  cheapest highlighted per row — the RIP/QD outcome aligned by quantity. */
function TierCompare({ offers, curve, accent, cases }: {
  offers: RateShopOffer[]; curve: { cases: number; net: Record<string, number | null>; winner: string | null }[];
  accent: Record<string, string>; cases: number;
}) {
  const slugs = offers.map(o => o.wholesaler);
  if (slugs.length < 2 || curve.length < 2) return null;
  return (
    <div className="rs-tc">
      <div className="rs-tc-title">Landed $/case at each volume — side by side (incl. QD + RIP)</div>
      <div className="table-container">
        <table className="dense-table rs-tc-table">
          <thead>
            <tr>
              <th>Buy</th>
              {slugs.map(w => <th key={w} style={{ color: accent[w] }}>{distributorName(w)}</th>)}
              <th>Cheapest</th>
            </tr>
          </thead>
          <tbody>
            {curve.map(pt => {
              const vals = slugs.map(w => pt.net[w]).filter((v): v is number => typeof v === 'number');
              const lo = vals.length ? Math.min(...vals) : null;
              return (
                <tr key={pt.cases} className={pt.cases === Math.ceil(cases) ? 'rs-tc-here' : ''}>
                  <td>{pt.cases} cs{pt.cases === Math.ceil(cases) ? ' ◄ you' : ''}</td>
                  {slugs.map(w => {
                    const v = pt.net[w];
                    const win = lo != null && typeof v === 'number' && Math.abs(v - lo) < 0.005;
                    return <td key={w} className={`rs-tc-num${win ? ' rs-tc-win' : ''}`}>{v == null ? '–' : money(v)}</td>;
                  })}
                  <td>{pt.winner && pt.winner !== 'tie' ? <span style={{ color: accent[pt.winner], fontWeight: 700 }}>{distributorName(pt.winner)}</span> : <span className="text-muted">tie</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OfferCard({ o, accent, cases, unitVolume, unitQty, onProduct }: {
  o: RateShopOffer; accent: Record<string, string>; cases: number;
  unitVolume?: string; unitQty?: string; onProduct: (n: string, w: string) => void;
}) {
  const [open, setOpen] = useState(true);   // price breakdown expanded by default
  return (
    <div className={`rs-card${o.is_winner ? ' rs-win' : ''}`} style={o.is_winner ? { borderColor: accent[o.wholesaler] } : undefined}>
      <div className="rs-rank" style={{ color: o.is_winner ? accent[o.wholesaler] : undefined }}>
        {o.is_winner ? <Crown size={18} /> : `#${o.rank}`}
      </div>
      <div className="rs-main">
        <div className="rs-dist">
          <button className="rs-distname" onClick={() => onProduct(o.product_name ?? '', o.wholesaler)}>{distributorName(o.wholesaler)}</button>
          <span className="rs-cpl" title="CPL period (source edition) — the price traces to this file">{o.edition}</span>
          {o.is_winner && <span className="rs-best">Best at {cases} cs</span>}
        </div>
        <div className="rs-headline">
          <span className="rs-net" style={{ color: o.is_winner ? accent[o.wholesaler] : undefined }}>{money(o.net_case)}<span className="rs-unit">/case</span></span>
          {o.frontline_case != null && o.frontline_case !== o.net_case && <span className="rs-front">{money(o.frontline_case)}</span>}
        </div>
        <div className="rs-netbtl">{money(o.net_btl)}/bottle net{o.savings_case > 0 ? ` · saves ${money(o.savings_case)}/cs (${pct(o.savings_pct)})` : ''}</div>
        <div className="rs-ids">
          {o.upc && <span title="UPC barcode">UPC {o.upc}</span>}
          {o.sku && <span title={`${distributorName(o.wholesaler)} item number`}>· {skuLabel(o.wholesaler)} {o.sku}</span>}
        </div>
        {o.timing && (
          <div className={`rs-timing rs-timing-${o.timing.dir}`} title="Based on next month's effective price for this product">
            {o.timing.dir === 'drop'
              ? <>↓ drops to ~{money(o.timing.next_case)}/cs next month — consider waiting</>
              : <>↑ rises to ~{money(o.timing.next_case)}/cs next month — buy now</>}
          </div>
        )}

        {/* conditions — what you must do to capture this price */}
        <div className="rs-conds">
          <span className="rs-conds-lbl">To get this:</span>
          {o.conditions.length === 0 && <span className="rs-cond rs-cond-base">no conditions (base price)</span>}
          {o.conditions.map((c: RateShopCondition, i) => (
            <span key={i} className={`rs-cond rs-cond-${c.type}`}>{condIcon(c.type)}{c.text}</span>
          ))}
          {o.applied_kind && <span className="rs-applied">{o.applied_kind}{o.applied_code ? ` ${o.applied_code}` : ''}</span>}
        </div>

        {/* stretch nudge */}
        {o.stretch && o.stretch.extra_per_case > 0.005 && (
          <div className="rs-stretch">
            <TrendingUp size={12} /> Stretch to <strong>{o.stretch.to_cases} cs</strong> → {money(o.stretch.price_after)}/cs
            (save <strong>{money(o.stretch.extra_per_case)}/cs</strong> more)
          </div>
        )}

        <div className="rs-actions">
          <RowActions productName={o.product_name ?? ''} wholesaler={o.wholesaler} upc={o.upc ?? undefined}
            unitVolume={unitVolume} unitQty={unitQty} qtyCases={cases} />
          {(o.qd_tiers.length + o.rip_tiers.length) > 0 && (
            <button className="rs-detailtoggle" onClick={() => setOpen(s => !s)}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} price breakdown
            </button>
          )}
        </div>

        {open && (
          <table className="rs-tiers">
            <thead><tr><th></th><th>buy</th><th title="Total off the list price">off list/cs</th><th>/case</th><th>/bottle</th></tr></thead>
            <tbody>
              <tr><td><span className="rs-tb rs-tb-base">BASE</span></td><td>—</td><td className="rs-tsave">—</td><td><strong>{money(o.frontline_case)}</strong></td><td>{money(o.frontline_btl)}</td></tr>
              {o.qd_tiers.map((t, i) => <tr key={`q${i}`}><td><span className="rs-tb rs-tb-qd">QD</span></td><td>{t.buy_label ?? `${t.cases_to_unlock} cs`}</td><td className="rs-tsave">{offList(o.frontline_case, t.price_after)}</td><td><strong>{money(t.price_after)}</strong></td><td>{money(t.price_after_btl)}</td></tr>)}
              {o.rip_tiers.map((t, i) => <tr key={`r${i}`}><td><span className="rs-tb rs-tb-rip">RIP</span>{t.code && <span className="rs-tcode" title="RIP program code — rows sharing a code are tiers of the same deal">{t.code}</span>}</td><td>{t.buy_label ?? `${t.cases_to_unlock} cs`}</td><td className="rs-tsave">{offList(o.frontline_case, t.price_after)}</td><td><strong>{money(t.price_after)}</strong></td><td>{money(t.price_after_btl)}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const sizeLabel = (s: { unit_qty: string | null; unit_volume: string | null; vintage: string | null }) =>
  `${s.unit_qty ?? '?'} × ${s.unit_volume ?? '?'}${s.vintage ? ` · ${s.vintage}` : ''}`;

/** One product's rate-shop result block (its own size state + query). */
function ProductResult({ match, label, cases, onRemove, goToProduct }: {
  match: string; label: string; cases: number; onRemove: () => void; goToProduct: (n: string, w?: string) => void;
}) {
  const [size, setSize] = useState('');
  useEffect(() => { setSize(''); }, [match]);
  const { data, isLoading, error } = useQuery({
    queryKey: ['rateshop', match, cases, size],
    queryFn: () => compare.rateshop({ match, cases, size: size || undefined }),
    enabled: !!match,
  });
  const accent = useMemo(() => {
    const m: Record<string, string> = {};
    (data?.offers ?? []).forEach((o, i) => { m[o.wholesaler] = ACCENTS[i % ACCENTS.length]; });
    return m;
  }, [data]);

  return (
    <div className="rs-result">
      {isLoading && <p>Rate shopping {label}…</p>}
      {!!error && <p className="text-red">Failed: {String((error as Error).message)}</p>}
      {data && !data.found && <div className="cmp-empty">{data.note ?? `No match for "${label}".`} <button className="rs-remove-link" onClick={onRemove}>remove</button></div>}
      {data?.found && data.product && (
        <>
          <div className="rs-product">
            <span className="rs-pname" onClick={() => goToProduct(data.product!.product_name)}>{data.product.product_name}</span>
            <span className="rs-meta">{data.product.unit_qty} × {data.product.unit_volume}{data.product.abv_proof ? ` · ${data.product.abv_proof}` : ''}{data.product.product_type ? ` · ${data.product.product_type}` : ''}</span>
            <span className="rs-conf" title="All offers are the same barcode + size — directly comparable">🟢 verified match</span>
            <button className="rs-remove" onClick={onRemove} title="Remove this product">✕</button>
          </div>
          {(data.available_sizes?.length ?? 0) > 1 && (
            <div className="p360-sizes">
              <span className="p360-sizes-lbl">Size:</span>
              {data.available_sizes!.map(s => (
                <button key={s.match_key} className={`p360-sizechip${(data.size_key ?? '') === s.size_key ? ' on' : ''}`}
                  onClick={() => setSize(s.size_key)} title={`${s.n_distributors} distributors`}>{sizeLabel(s)}</button>
              ))}
            </div>
          )}
          {data.verdict && <div className="rs-verdict">💡 {data.verdict}</div>}
          <BreakevenBand ranges={data.breakeven ?? []} accent={accent} />
          <TierCompare offers={data.offers!} curve={data.curve ?? []} accent={accent} cases={cases} />
          <div className="rs-offers">
            {data.offers!.map(o => (
              <OfferCard key={o.wholesaler} o={o} accent={accent} cases={cases}
                unitVolume={data.product!.unit_volume ?? undefined} unitQty={data.product!.unit_qty ?? undefined} onProduct={goToProduct} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function RateShop() {
  const [params, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [products, setProducts] = useState<{ match: string; label: string }[]>(() => {
    const ps = params.getAll('p');
    if (ps.length) return ps.map(m => ({ match: m, label: m }));
    const m = params.get('match');
    return m ? [{ match: m, label: m }] : [];
  });
  const [input, setInput] = useState('');
  const [cases, setCases] = useState(parseInt(params.get('cases') ?? '5', 10) || 5);
  const [mode, setMode] = useState<'product' | 'basket'>(params.get('mode') === 'basket' ? 'basket' : 'product');

  useEffect(() => {
    const next = new URLSearchParams();
    if (mode === 'basket') next.set('mode', 'basket');
    products.forEach(p => next.append('p', p.match));
    if (cases !== 5) next.set('cases', String(cases));
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [products, cases, mode]);

  const goToProduct = (name: string, w?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${w ? `&wholesaler=${w}` : ''}`);
  const addProduct = (match: string, label?: string) => {
    const v = match.trim();
    if (v && !products.some(p => p.match === v)) setProducts(ps => [...ps, { match: v, label: (label || v).trim() }]);
    setInput('');
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); addProduct(input); };

  return (
    <div className="page">
      <div className="cmp-head"><h2><ShoppingBag size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Rate Shop</h2></div>

      <div className="rs-modes">
        <button className={`rs-modebtn${mode === 'product' ? ' on' : ''}`} onClick={() => setMode('product')}>By product</button>
        <button className={`rs-modebtn${mode === 'basket' ? ' on' : ''}`} onClick={() => setMode('basket')}>My order (basket)</button>
      </div>

      {mode === 'basket' && <BasketView />}

      {mode === 'product' && <>
        {/* one control box: add products + the quantity that applies to all */}
        <div className="rs-control">
          <form className="rs-search" onSubmit={submit}>
            <ProductSearchBox value={input} onChange={setInput}
              onSelect={p => addProduct(p.upc || p.product_name, p.product_name)}
              onSubmit={() => addProduct(input)}
              placeholder="Add a product to rate-shop — e.g. Glenlivet 12, Tito's, a barcode…" autoFocus />
            <button className="btn" type="submit">Add</button>
          </form>
          <div className="rs-qty-inline">
            <label>Buying&nbsp;<strong>{cases}</strong>&nbsp;case{cases !== 1 ? 's' : ''} of each</label>
            <input type="range" min={1} max={50} value={cases} onChange={e => setCases(parseInt(e.target.value, 10))} />
            <div className="rs-qty-quick">
              {[1, 2, 5, 10, 25].map(n => <button key={n} className={`rs-qchip${cases === n ? ' on' : ''}`} onClick={() => setCases(n)}>{n}</button>)}
            </div>
          </div>
          {products.length > 0 && (
            <div className="rs-chips">
              {products.map(p => (
                <span key={p.match} className="rs-pchip">{p.label}
                  <button onClick={() => setProducts(ps => ps.filter(x => x.match !== p.match))} title="Remove">✕</button>
                </span>
              ))}
              {products.length > 1 && <button className="rs-clearall" onClick={() => setProducts([])}>clear all</button>}
            </div>
          )}
        </div>

        {products.length === 0 && (
          <div className="cmp-empty">
            Add one or more products to find the genuinely cheapest distributor for each <strong>at the quantity you actually buy</strong>.
            Every QD and RIP is reduced to one true landed cost per case — with the exact conditions to capture each price, where the
            winner flips as you buy more, and a nudge when stretching a case or two unlocks a deeper rebate.
          </div>
        )}

        {products.map(p => (
          <ProductResult key={p.match} match={p.match} label={p.label} cases={cases}
            onRemove={() => setProducts(ps => ps.filter(x => x.match !== p.match))} goToProduct={goToProduct} />
        ))}
      </>}
    </div>
  );
}
