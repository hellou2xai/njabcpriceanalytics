import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Split, Store } from 'lucide-react';
import { compare } from '../lib/api';
import { distributorName } from '../lib/distributors';
import './BasketView.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);

/**
 * Basket rate shopping — prices the buyer's whole cart (or favorites) across
 * distributors at each line's quantity, and shows the optimal SPLIT (each line
 * from its cheapest supplier) vs single-sourcing the order.
 */
export default function BasketView() {
  const [source, setSource] = useState<'cart' | 'favorites'>('cart');
  const { data, isLoading } = useQuery({
    queryKey: ['basket', source],
    queryFn: () => compare.basket(source),
  });

  return (
    <div className="bv">
      <div className="bv-source">
        <button className={`rs-modebtn${source === 'cart' ? ' on' : ''}`} onClick={() => setSource('cart')}>Cart</button>
        <button className={`rs-modebtn${source === 'favorites' ? ' on' : ''}`} onClick={() => setSource('favorites')}>Favorites</button>
      </div>

      {isLoading && <p>Pricing your {source}…</p>}
      {data && !data.found && (
        <div className="cmp-empty">
          {data.note ?? 'Nothing to compare.'} {source === 'cart' && <>Add products to your <Link to="/cart">cart</Link> first.</>}
        </div>
      )}

      {data?.found && (
        <>
          {/* headline numbers */}
          <div className="bv-cards">
            <div className="bv-card bv-card-hero">
              <div className="bv-card-n">{money(data.split_total)}</div>
              <div className="bv-card-l"><Split size={13} style={{ verticalAlign: '-2px' }} /> optimal split — {data.line_count} lines across {data.split_distributors?.map(distributorName).join(' + ')}</div>
            </div>
            <div className="bv-card">
              <div className={`bv-card-n ${(data.saving_vs_current ?? 0) > 0 ? 'bv-pos' : ''}`}>{money(data.saving_vs_current)}</div>
              <div className="bv-card-l">saved vs your cart as-is ({money(data.current_total)})</div>
            </div>
            {data.best_single && (
              <div className="bv-card">
                <div className="bv-card-n">{money(data.best_single.total)}</div>
                <div className="bv-card-l">cheapest single-source ({distributorName(data.best_single.wholesaler)}) — split saves {money(data.saving_vs_single)} more</div>
              </div>
            )}
          </div>

          {/* per-line: who's cheapest */}
          <div className="table-container">
            <table className="dense-table bv-table">
              <thead><tr><th>Product</th><th>Qty</th><th>Buy from</th><th>Net/cs</th><th>Line total</th><th>Save vs cart</th><th></th></tr></thead>
              <tbody>
                {data.lines!.map((l, i) => (
                  <tr key={i} className={l.no_match ? 'bv-nomatch' : ''}>
                    <td className="bv-prod">{l.product_name}<span className="cmp-size">{l.unit_volume}</span></td>
                    <td className="bv-num">{l.qty} cs</td>
                    <td>
                      {l.no_match ? <span className="text-muted">— not found</span> : (
                        <span className="bv-winner"><Store size={11} /> {distributorName(l.best_w!)}
                          {l.best_w !== l.current_w && <span className="bv-switch" title={`Currently from ${distributorName(l.current_w)}`}>switch</span>}
                        </span>
                      )}
                    </td>
                    <td className="bv-num">{l.no_match ? '–' : money(l.best_net)}</td>
                    <td className="bv-num">{l.no_match ? '–' : money((l.best_net ?? 0) * l.qty)}</td>
                    <td className="bv-num">{(l.saving_vs_current ?? 0) > 0.005 ? <span className="bv-pos">{money(l.saving_vs_current)}</span> : '—'}</td>
                    <td className="bv-num bv-opts" title={Object.entries(l.prices).map(([w, p]) => `${distributorName(w)} $${p.toFixed(2)}`).join(' · ')}>
                      {Object.keys(l.prices).length > 1 ? `${Object.keys(l.prices).length} options` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bv-foot">
            Net cost per line is the true landed cost at that line's quantity (best qualifying QD/RIP).
            Splitting means more than one invoice — weigh it against your rep relationships and delivery minimums.
          </div>
        </>
      )}
    </div>
  );
}
