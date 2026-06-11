import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Combine, RefreshCw, Scissors, Search, Undo2 } from 'lucide-react';
import { admin, type CelrFamily } from '../lib/api';
import { useDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import DataLoading from '../components/DataLoading';
import { ErrorState, EmptyState } from '../components/DataState';
import { distributorName } from '../lib/distributors';

const fmtCpn = (n: number) => `CELR-${String(n).padStart(6, '0')}`;

/**
 * Admin curation for the CELR Product Number registry
 * (docs/CELR_PRODUCT_NUMBER_DESIGN.md): search families, inspect their
 * member barcodes/listings, merge wrong splits (alias table, reversible)
 * and split out reused barcodes. Changes apply on the next pricing reload,
 * so the header offers the existing reload button.
 */
export default function AdminCelrProducts() {
  const qc = useQueryClient();
  const { promptText, confirm } = useDialog();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const { data: families, isLoading, isError, refetch } = useQuery({
    queryKey: ['celr-families', q],
    queryFn: () => admin.celrFamilies(q, 100),
  });
  const { data: detail } = useQuery({
    enabled: selected != null,
    queryKey: ['celr-family', selected],
    queryFn: () => admin.celrFamily(selected as number),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['celr-families'] });
    qc.invalidateQueries({ queryKey: ['celr-family'] });
  };
  const merge = useMutation({
    mutationFn: (v: { from: number; into: number }) => admin.celrMerge(v.from, v.into),
    onSuccess: (r) => { invalidate(); toast.success(`Merged into ${fmtCpn(r.into_cpn)}. ${r.note}`); },
    onError: (e) => toast.error(String(e)),
  });
  const unmerge = useMutation({
    mutationFn: (cpn: number) => admin.celrUnmerge(cpn),
    onSuccess: (r) => { invalidate(); toast.success(`Unmerged. ${r.note}`); },
    onError: (e) => toast.error(String(e)),
  });
  const split = useMutation({
    mutationFn: (upc: string) => admin.celrSplit(upc),
    onSuccess: (r) => { invalidate(); toast.success(`Split to ${r.celr_product_number}. ${r.note}`); },
    onError: (e) => toast.error(String(e)),
  });
  const reload = useMutation({
    mutationFn: admin.reloadPricing,
    onSuccess: () => toast.success('Pricing cache reloaded. Curation changes are live.'),
    onError: (e) => toast.error(String(e)),
  });

  const askMerge = async (fam: CelrFamily) => {
    const t = await promptText({
      title: `Merge ${fmtCpn(fam.cpn)} into…`,
      message: `"${fam.header_name ?? ''}" will become an alias of the target family. Reversible via Unmerge.`,
      placeholder: 'Target CELR number, e.g. CELR-003873 or 3873',
      confirmText: 'Merge',
    });
    if (!t) return;
    const m = /([0-9]{1,9})\s*$/.exec(t.trim());
    if (!m) { toast.error('Could not read a CELR number from that input.'); return; }
    merge.mutate({ from: fam.cpn, into: parseInt(m[1], 10) });
  };

  return (
    <div className="page">
      <div className="orders-header">
        <h2>CELR Products</h2>
        <button className="btn btn-secondary" disabled={reload.isPending}
          title="Rebuild the pricing cache so merges/splits show in the app"
          onClick={() => reload.mutate()}>
          <RefreshCw size={15} /> {reload.isPending ? 'Reloading…' : 'Reload pricing cache'}
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: 0, maxWidth: 760 }}>
        One CELR Product Number = one product family across sizes, vintages and distributors.
        Merge families the matcher split; split out barcodes that mix different products.
        Changes apply after a pricing reload.
      </p>

      <div className="search-bar">
        <Search size={15} style={{ color: 'var(--text-muted)' }} />
        <input type="text" placeholder="Search by name, brand, or CELR number…"
          value={q} onChange={e => { setQ(e.target.value); setSelected(null); }} />
        <span className="search-count">{families?.length ?? 0} families shown</span>
      </div>

      {isLoading && <DataLoading label="Loading families…" />}
      {isError && <ErrorState retry={() => refetch()} />}
      {!isLoading && !isError && (families?.length ?? 0) === 0 && (
        <EmptyState title="No families match">Try a brand, part of a product name, or a CELR number.</EmptyState>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {(families?.length ?? 0) > 0 && (
          <div className="panel" style={{ padding: 0, flex: '1 1 480px', minWidth: 380, overflow: 'hidden' }}>
            <table>
              <thead>
                <tr><th>CELR #</th><th>Family</th><th>Brand</th><th>Type</th>
                  <th style={{ textAlign: 'right' }}>UPCs</th><th></th></tr>
              </thead>
              <tbody>
                {families!.map(f => (
                  <tr key={f.cpn} className="clickable"
                      style={selected === f.cpn ? { background: 'var(--accent-weak)' } : undefined}
                      onClick={() => setSelected(f.cpn)}>
                    <td className="cart-cell-code">{fmtCpn(f.cpn)}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 360 }}>
                      {f.header_name}
                      {f.alias_of != null && (
                        <span className="win-badge win-expired" style={{ marginLeft: 6 }}
                          title={`Merged into ${fmtCpn(f.alias_of)}`}>→ {fmtCpn(f.alias_of)}</span>
                      )}
                    </td>
                    <td>{f.brand || '–'}</td>
                    <td>{f.product_type || '–'}</td>
                    <td style={{ textAlign: 'right' }}>{f.upc_count}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-secondary btn-sm" title="Merge this family into another"
                          onClick={() => askMerge(f)}><Combine size={13} /></button>
                        {f.alias_of != null && (
                          <button className="btn btn-secondary btn-sm" title="Undo this merge"
                            onClick={async () => {
                              if (await confirm({ title: `Unmerge ${fmtCpn(f.cpn)}?`, message: 'It becomes its own family again.', confirmText: 'Unmerge' }))
                                unmerge.mutate(f.cpn);
                            }}><Undo2 size={13} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detail && (
          <div className="panel" style={{ padding: 14, flex: '1 1 380px', minWidth: 340 }}>
            <h3 style={{ margin: '0 0 2px' }}>{detail.header_name}</h3>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
              {fmtCpn(detail.cpn)}{detail.brand ? ` · ${detail.brand}` : ''}{detail.product_type ? ` · ${detail.product_type}` : ''}
              {detail.alias_of != null && <> · merged into <strong>{fmtCpn(detail.alias_of)}</strong></>}
              {(detail.merged_in?.length ?? 0) > 0 && <> · absorbs {detail.merged_in!.map(fmtCpn).join(', ')}</>}
            </div>
            {detail.upcs.map(u => (
              <div key={u.upc_norm} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="cart-cell-code">{u.upc_norm}</span>
                  <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
                    title="Move this barcode out into its own new family"
                    onClick={async () => {
                      if (await confirm({ title: `Split UPC ${u.upc_norm} out of this family?`, message: 'It gets a fresh CELR number. Use when a barcode mixes different products.', confirmText: 'Split' }))
                        split.mutate(u.upc_norm);
                    }}><Scissors size={12} /> Split</button>
                </div>
                {u.listings.map((l, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    {distributorName(l.wholesaler)} · {l.product_name}{l.unit_volume ? ` · ${l.unit_volume}` : ''}
                  </div>
                ))}
                {u.listings.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Not on the current price lists.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
