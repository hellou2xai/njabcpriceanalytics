import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ShoppingBag, Crown, TrendingUp, Clock, Layers as MixIcon, FileText, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { compare } from '../lib/api';
import type { RateShopOffer, RateShopCondition } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import RowActions from '../components/RowActions';
import './ComparePrices.css';
import './Price360.css';
import './RateShop.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const pct = (v?: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
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

function OfferCard({ o, accent, cases, unitVolume, unitQty, onProduct }: {
  o: RateShopOffer; accent: Record<string, string>; cases: number;
  unitVolume?: string; unitQty?: string; onProduct: (n: string, w: string) => void;
}) {
  const [open, setOpen] = useState(false);
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
            <thead><tr><th></th><th>buy</th><th>/case</th><th>/bottle</th></tr></thead>
            <tbody>
              <tr><td><span className="rs-tb rs-tb-base">BASE</span></td><td>—</td><td><strong>{money(o.frontline_case)}</strong></td><td>{money(o.frontline_btl)}</td></tr>
              {o.qd_tiers.map((t, i) => <tr key={`q${i}`}><td><span className="rs-tb rs-tb-qd">QD</span></td><td>{t.cases_to_unlock} cs</td><td><strong>{money(t.price_after)}</strong></td><td>{money(t.price_after_btl)}</td></tr>)}
              {o.rip_tiers.map((t, i) => <tr key={`r${i}`}><td><span className="rs-tb rs-tb-rip">RIP</span></td><td>{t.cases_to_unlock} cs</td><td><strong>{money(t.price_after)}</strong></td><td>{money(t.price_after_btl)}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function RateShop() {
  const [params, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [match, setMatch] = useState(params.get('match') ?? '');
  const [input, setInput] = useState(params.get('match') ?? '');
  const [cases, setCases] = useState(parseInt(params.get('cases') ?? '5', 10) || 5);
  const [size, setSize] = useState(params.get('size') ?? '');

  useEffect(() => {
    const next = new URLSearchParams();
    if (match) next.set('match', match);
    if (cases !== 5) next.set('cases', String(cases));
    if (size) next.set('size', size);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [match, cases, size]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['rateshop', match, cases, size],
    queryFn: () => compare.rateshop({ match, cases, size: size || undefined }),
    enabled: !!match,
  });

  const goToProduct = (name: string, w?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${w ? `&wholesaler=${w}` : ''}`);
  const submit = (e: React.FormEvent) => { e.preventDefault(); setSize(''); setMatch(input.trim()); };

  const accent = useMemo(() => {
    const m: Record<string, string> = {};
    (data?.offers ?? []).forEach((o, i) => { m[o.wholesaler] = ACCENTS[i % ACCENTS.length]; });
    return m;
  }, [data]);
  const sizeLabel = (s: { unit_qty: string | null; unit_volume: string | null; vintage: string | null }) =>
    `${s.unit_qty ?? '?'} × ${s.unit_volume ?? '?'}${s.vintage ? ` · ${s.vintage}` : ''}`;

  return (
    <div className="page">
      <div className="cmp-head"><h2><ShoppingBag size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Rate Shop</h2></div>

      <form className="rs-search" onSubmit={submit}>
        <ProductSearchBox value={input} onChange={setInput}
          onSelect={p => { setSize(''); setMatch(p.upc || p.product_name); }}
          onSubmit={() => { setSize(''); setMatch(input.trim()); }}
          placeholder="What are you buying? — e.g. Glenlivet 12, Tito's, a barcode…" autoFocus />
        <button className="btn" type="submit">Rate shop</button>
      </form>

      {!match && (
        <div className="cmp-empty">
          Find the genuinely cheapest distributor for a product <strong>at the quantity you actually buy</strong>.
          Every QD and RIP is reduced to one true landed cost per case, ranked cheapest first — with the exact
          conditions to capture each price, where the winner flips as you buy more, and a nudge when stretching
          a case or two unlocks a deeper rebate.
        </div>
      )}

      {!!match && (
        <div className="rs-qty">
          <label>I'm buying&nbsp;<strong>{cases}</strong>&nbsp;case{cases !== 1 ? 's' : ''}</label>
          <input type="range" min={1} max={50} value={cases} onChange={e => setCases(parseInt(e.target.value, 10))} />
          <div className="rs-qty-quick">
            {[1, 2, 5, 10, 25].map(n => (
              <button key={n} className={`rs-qchip${cases === n ? ' on' : ''}`} onClick={() => setCases(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}

      {!!match && isLoading && <p>Rate shopping…</p>}
      {!!error && <p className="text-red">Failed: {String((error as Error).message)}</p>}
      {data && !data.found && <div className="cmp-empty">{data.note ?? 'No product matched.'}</div>}

      {data?.found && data.product && (
        <>
          <div className="rs-product">
            <span className="rs-pname" onClick={() => goToProduct(data.product!.product_name)}>{data.product.product_name}</span>
            <span className="rs-meta">{data.product.unit_qty} × {data.product.unit_volume}{data.product.abv_proof ? ` · ${data.product.abv_proof}` : ''}{data.product.product_type ? ` · ${data.product.product_type}` : ''}</span>
            <span className="rs-conf" title="All offers are the same barcode + size — directly comparable">🟢 verified match</span>
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
