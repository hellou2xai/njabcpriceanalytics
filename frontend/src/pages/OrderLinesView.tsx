import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { orders, salesReps } from '../lib/api';
import type { PlanOrder, OrderLine } from '../lib/api';
import { distributorName } from '../lib/distributors';
import RipTierCell from '../components/RipTierCell';
import {
  fmt, parseNum, getBestSave, computeLineInvoice, computeLineRebate, computeLineEffective, computeGp,
} from '../lib/orderMath';

/**
 * All order lines, grouped by distributor then sales rep / order, showing the
 * same rich per-line data as the Order Detail table (read-only).
 */
export default function OrderLinesView({ status }: { status?: string }) {
  const { data: plan, isLoading } = useQuery({
    queryKey: ['orders', 'plan', status || 'all'],
    queryFn: () => orders.plan(status || 'all'),
  });
  const { data: reps } = useQuery({ queryKey: ['sales-reps'], queryFn: salesReps.list });
  const repName = (id?: number | null) => reps?.find(r => r.id === id)?.name ?? 'No rep';

  const groups = useMemo(() => {
    const m = new Map<string, PlanOrder[]>();
    for (const o of plan ?? []) {
      const key = o.distributor || '—';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(o);
    }
    return Array.from(m.entries());
  }, [plan]);

  const grandTotal = (plan ?? []).reduce((s, o) => s + (o.total ?? 0), 0);

  if (isLoading) return <p className="text-muted" style={{ padding: '8px 0' }}>Loading...</p>;
  if ((plan ?? []).length === 0) {
    return (
      <div className="notes-empty">
        <p>No orders to show.</p>
        <p className="text-muted" style={{ fontSize: 13 }}>Create an order and add products; it'll appear here grouped by distributor and rep.</p>
      </div>
    );
  }

  return (
    <>
      <div className="plan-grand">
        <span>Total across these orders</span>
        <strong className="num">{fmt(grandTotal)}</strong>
      </div>

      {groups.map(([dist, ords]) => {
        const distTotal = ords.reduce((s, o) => s + (o.total ?? 0), 0);
        return (
          <section key={dist} className="plan-dist">
            <div className="plan-dist-head">
              <h3>{dist === '—' ? 'No distributor set' : distributorName(dist)}</h3>
              <span className="num">{fmt(distTotal)}</span>
            </div>

            {ords.map(o => (
              <div key={o.id} className="plan-order">
                <div className="plan-order-head">
                  <div>
                    <strong>{o.name}</strong>
                    <span className="plan-order-rep"> · {repName(o.sales_rep_id)} · {o.status}</span>
                  </div>
                  <div className="plan-order-right">
                    <span className="num plan-order-total">{fmt(o.total ?? 0)}</span>
                    <Link to={`/orders/${o.id}`} className="plan-order-open">Open <ChevronRight size={14} /></Link>
                  </div>
                </div>
                {o.lines.length === 0 ? (
                  <p className="plan-empty">No line items yet.</p>
                ) : (
                  <div className="table-container">
                    <table className="plan-lines">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th className="hide-md">Brand</th>
                          <th style={{ textAlign: 'right' }}>Case Cost</th>
                          <th>RIP by Case</th>
                          <th style={{ textAlign: 'right' }}>After RIP</th>
                          <th style={{ textAlign: 'center' }}>Cases</th>
                          <th style={{ textAlign: 'center' }}>Btls</th>
                          <th className="hide-md" style={{ textAlign: 'right' }}>Line Invoice</th>
                          <th className="hide-md" style={{ textAlign: 'right' }}>Line RIP</th>
                          <th style={{ textAlign: 'right' }}>Line Effective</th>
                          <th className="hide-lg" style={{ textAlign: 'right' }}>Retail/btl</th>
                          <th className="hide-lg" style={{ textAlign: 'right' }}>GP% (deal / list)</th>
                          <th className="hide-lg">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.lines.map((l: OrderLine) => {
                          const known = l.case_cost != null;
                          const caseCost = parseNum(l.case_cost);
                          const bestSave = getBestSave(l);
                          const afterRip = caseCost - bestSave;
                          const lineReb = computeLineRebate(l);
                          const gp = computeGp(l);
                          const pack = l.pack || 0;
                          const gpTone = (g: number) => g >= 25 ? 'var(--green)' : g >= 15 ? 'var(--yellow)' : 'var(--red)';
                          return (
                            <tr key={l.id}>
                              <td>
                                <div>{l.description || l.product_name}</div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  {l.size || l.unit_volume || ''}{l.pack ? ` / ${l.pack}pk` : ''}
                                </div>
                              </td>
                              <td className="hide-md" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.brand || '—'}</td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                                {known ? <div style={{ lineHeight: 1.25 }}>
                                  <div>{fmt(caseCost)}</div>
                                  {pack > 1 && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmt(caseCost / pack)}/btl</div>}
                                </div> : '—'}
                              </td>
                              <td><RipTierCell tiers={l.rip_tiers} qtyCases={l.qty_cases || 0} /></td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: bestSave > 0 ? 'var(--green)' : undefined }}>
                                {known ? <div style={{ lineHeight: 1.25 }}>
                                  <div>{fmt(afterRip)}</div>
                                  {pack > 1 && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{fmt(afterRip / pack)}/btl</div>}
                                </div> : '—'}
                              </td>
                              <td style={{ textAlign: 'center' }}>{l.qty_cases || 0}</td>
                              <td style={{ textAlign: 'center' }}>{l.qty_units || 0}</td>
                              <td className="hide-md" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{known ? fmt(computeLineInvoice(l)) : '—'}</td>
                              <td className="hide-md" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: '#b45309', fontWeight: lineReb > 0 ? 700 : 400 }}>{known ? fmt(lineReb) : '—'}</td>
                              <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--green)', fontWeight: 700 }}>{known ? fmt(computeLineEffective(l)) : '—'}</td>
                              <td className="hide-lg" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{l.retail_price != null ? fmt(l.retail_price) : '—'}</td>
                              <td className="hide-lg" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                                {gp.deal == null ? <span className="text-muted">—</span> : (
                                  <div style={{ lineHeight: 1.2 }}>
                                    <div style={{ color: gpTone(gp.deal), fontWeight: 700 }}>{gp.deal.toFixed(1)}%</div>
                                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>list {gp.full!.toFixed(1)}%</div>
                                  </div>
                                )}
                              </td>
                              <td className="hide-lg" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.notes || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
