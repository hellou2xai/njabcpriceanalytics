import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Target, Crown, AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react';
import { compare } from '../lib/api';
import type { Price360Offer } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import './ComparePrices.css';
import './Price360.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const pct = (v?: number | null) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

const REACH_LABEL: Record<string, string> = {
  likely: 'Reachable', partial: 'Partly reachable', unreachable: 'Unreachable',
  unknown: 'No order history', no_rip: 'No RIP',
};

function OfferCard({ offer, onProduct, tie }: { offer: Price360Offer; onProduct: (n: string, w: string) => void; tie: boolean }) {
  const o = offer;
  const reach = o.reachability;
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
          <span className="p360-net">{money(o.net_case)}<span className="p360-unit">/case</span></span>
          {o.frontline_case != null && o.frontline_case !== o.net_case && (
            <span className="p360-front">{money(o.frontline_case)}</span>
          )}
        </div>
        <div className="p360-netbtl">{money(o.net_btl)}/bottle net</div>
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
      </div>

      {/* value score — breakdown + RIP tiers shown by default */}
      <div className="p360-score">
        <div className="p360-scorebtn" title="Composite value score (0–100, fixed published weights)">
          <span className="p360-scoreval">{o.value_score.toFixed(0)}</span>
          <span className="p360-scorelbl">value score <Info size={9} /></span>
        </div>
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
        {o.rip_tiers.length > 0 && (
          <div className="p360-tierwrap">
            <div className="p360-tierhdr">RIP tiers — buy → rebate → net/cs</div>
            <table className="p360-tiers">
              <tbody>
                {o.rip_tiers.map((t, i) => (
                  <tr key={i}>
                    <td>{t.cases_to_unlock ?? t.raw_qty} cs</td>
                    <td className="text-green">−{money(t.rebate_per_case)}</td>
                    <td>{money(t.price_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
  const [collapsed, setCollapsed] = useState(false);   // distributors open by default

  useEffect(() => {
    const next = new URLSearchParams();
    if (match) next.set('match', match);
    if (reach !== 'soft') next.set('reach', reach);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [match, reach]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['price360', match, reach],
    queryFn: () => compare.price360({ match, reach_mode: reach }),
    enabled: !!match,
  });

  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  const submit = (e: React.FormEvent) => { e.preventDefault(); setMatch(input.trim()); };

  return (
    <div className="page">
      <div className="cmp-head">
        <h2><Target size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Price 360</h2>
      </div>

      <form className="p360-search" onSubmit={submit}>
        <ProductSearchBox
          value={input}
          onChange={setInput}
          onSelect={p => setMatch(p.upc || p.product_name)}
          onSubmit={() => setMatch(input.trim())}
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

      {!!match && isLoading && <p>Building the 360 label…</p>}
      {!!error && <p className="text-red">Failed: {String((error as Error).message)}</p>}
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

          {data.tie && !collapsed && (
            <div className="p360-tienote">
              <Info size={14} /> {data.n_winners} distributors are tied at the same net cost
              (${data.offers!.find(o => o.is_winner)?.net_case?.toFixed(2)}/cs) — they're equally
              the best buy. Pick on service, delivery or rep relationship.
            </div>
          )}

          {!collapsed && <div className="p360-howto">
            Each card is one distributor's offer. <strong>Net cost</strong> (big number) is the true
            cost per case after every layer — frontline minus single-case discount, quantity discounts
            and RIP rebates — with rebates you're unlikely to reach discounted by your order history.
            <strong> Invoice</strong> is the legal cost basis (discounts only); the gap to Net is the RIP
            rebate. The <strong>value score</strong> (right) is net-cost-dominant: 70 net cost · 15 savings ·
            10 stability · 5 compliance. The <strong>RIP tiers</strong> show what you pay per case at each
            buy-quantity. Lowest net cost wins.
          </div>}
          {!collapsed && (
            <div className="p360-offers">
              {data.offers!.map(o => <OfferCard key={o.wholesaler + o.rank} offer={o} onProduct={goToProduct} tie={!!data.tie} />)}
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
