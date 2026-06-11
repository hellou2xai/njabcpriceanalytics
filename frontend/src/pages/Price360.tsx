import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Target, Crown, AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react';
import { compare } from '../lib/api';
import type { Price360Offer } from '../lib/api';
import { distributorName, priceUnitWord, perUnitNoun, isKegUnit } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import RowActions from '../components/RowActions';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './ComparePrices.css';
import './Price360.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const pct = (v?: number | null) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
// Total off the list price for a tier — always equals frontline − price_after, so it
// can never contradict the displayed price (a deeper price always shows a bigger off).
const offList = (frontline?: number | null, after?: number | null) =>
  (frontline != null && after != null && frontline - after > 0.005)
    ? <span className="p360-tsave"> −{money(frontline - after)}</span> : null;

const REACH_LABEL: Record<string, string> = {
  likely: 'Reachable', partial: 'Partly reachable', unreachable: 'Unreachable',
  unknown: 'No order history', no_rip: 'No RIP',
};

function OfferCard({ offer, onProduct, tie, unitVolume, unitQty, unitType }: {
  offer: Price360Offer; onProduct: (n: string, w: string) => void; tie: boolean;
  unitVolume?: string; unitQty?: string; unitType?: string;
}) {
  const o = offer;
  const caseWord = priceUnitWord(unitVolume, unitType);
  const unitNoun = perUnitNoun(unitVolume, unitType);
  const keg = isKegUnit(unitVolume, unitType);
  const reach = o.reachability;
  const [showScore, setShowScore] = useState(false);   // breakdown hidden by default
  return (
    <div className={`p360-card${o.is_winner ? ' p360-win' : ''}`}>
      <div className="p360-rank">
        {o.is_winner ? <Crown size={18} /> : `#${o.rank}`}
      </div>
      <div className="p360-main">
        <div className="p360-dist">
          <button className="p360-distname" onClick={() => onProduct(o.product_name ?? '', o.wholesaler)}>
            {distributorName(o.wholesaler)}
          </button>
          <span className="p360-cpl" title="CPL period (source edition)">{o.edition}</span>
          {o.is_winner && <span className="p360-best">{tie ? 'Tied best buy' : 'Best buy'}</span>}
        </div>
        {/* headline: net cost dominant */}
        <div className="p360-headline">
          <span className="p360-net">{money(o.net_case)}<span className="p360-unit">/{caseWord}</span></span>
          {!keg && <span className="p360-netbtl">{money(o.net_btl)}<span className="p360-unit">/{unitNoun} net</span></span>}
          {o.frontline_case != null && o.frontline_case !== o.net_case && (
            <span className="p360-front">{money(o.frontline_case)}</span>
          )}
        </div>
        {/* secondary: savings (never dominant) */}
        {o.savings_case > 0 && (
          <div className="p360-savings">saves {money(o.savings_case)}/cs · {pct(o.savings_pct)} vs frontline</div>
        )}
        {o.rebate_misleads && (
          <div className="p360-mislead"><AlertTriangle size={11} /> bigger rebate, but costs more</div>
        )}

        {/* invoice vs economic */}
        <div className="p360-layers">
          <span title="Legal cost basis — discounts only, never lowered by rebates">
            Invoice <strong>{money(o.invoice_case)}</strong>
          </span>
          <span title="Economic net cost — after RIP rebates (reachability-adjusted)">
            Net <strong>{money(o.net_case)}</strong>
          </span>
          {o.divergence && <span className="p360-diverge" title="Net cost is below invoice because a RIP rebate applies — invoice is the legal basis, net is the economic cost">RIP-adjusted</span>}
        </div>

        {/* chips */}
        <div className="p360-chips">
          <span className={`p360-chip reach-${reach.status}`} title={
            reach.qualifying ? `Needs ${reach.qualifying} cases; you typically buy ${reach.typical ?? '?'}` : ''}>
            {REACH_LABEL[reach.status] ?? reach.status}
            {reach.status === 'partial' && ` ${Math.round(reach.likelihood * 100)}%`}
          </span>
          <span className="p360-chip">{o.single_sku ? 'Single SKU' : `Mix ${o.case_mix}`}</span>
          {o.compliance.pre_approval && (
            <span className="p360-chip p360-flag" title={o.compliance.flags.join('; ')}>
              <AlertTriangle size={10} /> Pre-approval
            </span>
          )}
        </div>

        <div className="p360-actions">
          <RowActions
            productName={o.product_name ?? ''}
            wholesaler={o.wholesaler}
            upc={o.upc ?? undefined}
            unitVolume={unitVolume}
            unitQty={unitQty}
          />
        </div>
      </div>

      {/* value score — breakdown is collapsed by default (tap the score) */}
      <div className="p360-score">
        <button className="p360-scorebtn" onClick={() => setShowScore(s => !s)}
          title="Composite value score (0–100, fixed published weights). Tap for the breakdown.">
          <span className="p360-scoreval">{o.value_score.toFixed(0)}</span>
          <span className="p360-scorelbl">value score {showScore ? <ChevronDown size={9} /> : <Info size={9} />}</span>
        </button>
        {showScore && (
          <div className="p360-scorebreak">
            <div title="How close this is to the cheapest net cost in the set (70% of the score — net cost is authoritative)">
              Net cost <b>{o.score_breakdown.net_cost}</b>/{o.score_breakdown.weights.net_cost}</div>
            <div title="Reachability-adjusted savings vs frontline (15%)">
              Savings <b>{o.score_breakdown.savings}</b>/{o.score_breakdown.weights.savings}</div>
            <div title="Full-month RIP scores higher than a dated/expiring one (10%)">
              Stability <b>{o.score_breakdown.stability}</b>/{o.score_breakdown.weights.stability}</div>
            <div title="Full marks unless the RIP needs NJ-ABC pre-approval (5%)">
              Compliance <b>{o.score_breakdown.compliance}</b>/{o.score_breakdown.weights.compliance}</div>
          </div>
        )}
        {/* full labeled price breakdown — Base / QD / RIP, case + bottle */}
        <div className="p360-tierwrap">
          <div className="p360-tierhdr">Price breakdown · {unitQty} × {unitVolume}</div>
          <table className="p360-tiers">
            <thead>
              <tr><th></th><th>buy</th><th>/{caseWord}</th><th>/{unitNoun}</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="p360-tb p360-tb-base">BASE</span></td>
                <td>—</td>
                <td><strong>{money(o.frontline_case)}</strong></td>
                <td>{money(o.frontline_btl)}</td>
              </tr>
              {o.qd_tiers.map((t, i) => (
                <tr key={`q${i}`}>
                  <td><span className="p360-tb p360-tb-qd">QD</span></td>
                  <td>{t.buy_label ?? `${t.cases_to_unlock} cs`}</td>
                  <td><strong>{money(t.price_after)}</strong>{offList(o.frontline_case, t.price_after)}</td>
                  <td>{money(t.price_after_btl)}</td>
                </tr>
              ))}
              {o.rip_tiers.map((t, i) => (
                <tr key={`r${i}`}>
                  <td><span className="p360-tb p360-tb-rip">RIP</span>{t.code ? <span className="p360-tcode" title="RIP program code — rows sharing a code are tiers of the same deal">{t.code}</span> : null}</td>
                  <td>{t.buy_label ?? `${t.cases_to_unlock} cs`}</td>
                  <td><strong>{money(t.price_after)}</strong>{offList(o.frontline_case, t.price_after)}</td>
                  <td>{money(t.price_after_btl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function Price360() {
  const [params, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [match, setMatch] = useState(params.get('match') ?? '');
  const [input, setInput] = useState(params.get('match') ?? '');
  const [reach, setReach] = useState(params.get('reach') ?? 'soft');
  const [size, setSize] = useState(params.get('size') ?? '');   // size_key (blank = most-carried)
  const [collapsed, setCollapsed] = useState(false);   // distributors open by default

  useEffect(() => {
    const next = new URLSearchParams();
    if (match) next.set('match', match);
    if (reach !== 'soft') next.set('reach', reach);
    if (size) next.set('size', size);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [match, reach, size]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['price360', match, reach, size],
    queryFn: () => compare.price360({ match, reach_mode: reach, size: size || undefined }),
    enabled: !!match,
  });

  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  const submit = (e: React.FormEvent) => { e.preventDefault(); setSize(''); setMatch(input.trim()); };

  const sizeLabel = (s: { unit_qty: string | null; unit_volume: string | null; vintage: string | null }) =>
    `${s.unit_qty ?? '?'} × ${s.unit_volume ?? '?'}${s.vintage ? ` · ${s.vintage}` : ''}`;

  return (
    <div className="page">
      <div className="cmp-head">
        <h2><Target size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Price 360</h2>
      </div>

      <form className="p360-search" onSubmit={submit}>
        <ProductSearchBox
          value={input}
          onChange={setInput}
          onSelect={p => { setSize(''); setMatch(p.upc || p.product_name); }}
          onSubmit={() => { setSize(''); setMatch(input.trim()); }}
          placeholder="Search a product (smart search) — e.g. Campari, Tito's, Absolut 80…"
          autoFocus
        />
        <button className="btn" type="submit">Show 360</button>
        <label className="p360-reach">
          Rebates:
          <select value={reach} onChange={e => setReach(e.target.value)} title="How to value rebates you may not reach">
            <option value="soft">Soft (by likelihood)</option>
            <option value="hard">Hard (zero if unreachable)</option>
            <option value="off">Full value</option>
          </select>
        </label>
      </form>

      {!match && (
        <div className="cmp-empty">
          Search a product to see its true cost across every distributor — all price
          layers (frontline, discount, quantity tiers, RIP) reduced to one effective
          <strong> net cost</strong> per case and per bottle, ranked cheapest first.
          Invoice cost (the legal basis) is kept separate from economic net cost, and
          rebates you're unlikely to reach are discounted by your order history.
        </div>
      )}

      {!!match && isLoading && <DataLoading label="Building the 360 label…" />}
      {!!match && !!error && <ErrorState message={String((error as Error).message)} retry={() => refetch()} />}
      {data && !data.found && <div className="cmp-empty">{data.note ?? 'No product matched.'}</div>}

      {data?.found && data.product && (
        <>
          {/* product on top — its distributor offers collapse below (open by default) */}
          <button className="p360-product" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
            <span className="p360-pname" onClick={e => { e.stopPropagation(); goToProduct(data.product!.product_name); }}>
              {data.product.product_name}
            </span>
            <span className="p360-meta">
              {data.product.unit_qty} × {data.product.unit_volume}
              {data.product.abv_proof ? ` · ${data.product.abv_proof}` : ''}
              {data.product.product_type ? ` · ${data.product.product_type}` : ''}
            </span>
            <span className="p360-comparable">Directly comparable</span>
            {data.proof_warning && (
              <span className="p360-proofwarn" title="Distributors filed different proof/ABV for this barcode — verify it's the same item">
                <AlertTriangle size={12} /> proof differs across distributors
              </span>
            )}
            <span className="p360-count">{data.offers!.length} distributor{data.offers!.length !== 1 ? 's' : ''}</span>
          </button>

          {(data.available_sizes?.length ?? 0) > 1 && (
            <div className="p360-sizes">
              <span className="p360-sizes-lbl">Size:</span>
              {data.available_sizes!.map(s => (
                <button key={s.match_key}
                  className={`p360-sizechip${(data.size_key ?? '') === s.size_key ? ' on' : ''}`}
                  onClick={() => setSize(s.size_key)}
                  title={`${s.n_distributors} distributor${s.n_distributors !== 1 ? 's' : ''}`}>
                  {sizeLabel(s)}
                </button>
              ))}
            </div>
          )}

          {data.tie && !collapsed && (
            <div className="p360-tienote">
              <Info size={14} /> {data.n_winners} distributors are tied at the same net cost
              (${data.offers!.find(o => o.is_winner)?.net_case?.toFixed(2)}/cs) — they're equally
              the best buy. Pick on service, delivery or rep relationship.
            </div>
          )}

          {!collapsed && <div className="p360-howto">
            <div><strong>Net cost</strong> — the true cost per case after every layer (frontline − single-case discount − quantity discounts − RIP rebates), with rebates you're unlikely to reach discounted by your order history. Lowest wins.</div>
            <div><strong>Invoice</strong> — the legal cost basis (discounts only); the gap to Net is the RIP rebate.</div>
            <div><strong>Value score</strong> — net-cost-dominant: 70 net cost · 15 savings · 10 stability · 5 compliance.</div>
            <div><strong>RIP tiers</strong> — what you pay per case at each buy-quantity.</div>
          </div>}
          {!collapsed && (
            <div className="p360-offers">
              {data.offers!.map(o => <OfferCard key={o.wholesaler + o.rank} offer={o} onProduct={goToProduct}
                tie={!!data.tie} unitVolume={data.product!.unit_volume ?? undefined} unitQty={data.product!.unit_qty ?? undefined} unitType={data.product!.unit_type ?? undefined} />)}
            </div>
          )}

          <div className="p360-foot">
            Net cost is authoritative — offers rank by reachability-adjusted effective net cost,
            lowest first. Score weights (fixed, published): net cost {data.weights?.net_cost},
            savings {data.weights?.savings}, stability {data.weights?.stability},
            compliance {data.weights?.compliance}. Every figure traces to its distributor's CPL period shown on each card.
          </div>
        </>
      )}
    </div>
  );
}
