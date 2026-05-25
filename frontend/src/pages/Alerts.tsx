import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { alerts, type Alert } from '../lib/api';
import {
  CheckCheck, Clock, BadgeDollarSign, Combine, TrendingDown, Tag, Target,
  ClipboardCheck, TrendingUp, CalendarClock, BellOff,
} from 'lucide-react';

// Per-category label + icon. Intent (opportunity / risk) comes from the payload.
const CAT: Record<string, { label: string; icon: typeof Clock }> = {
  expiring:       { label: 'Time-sensitive deals', icon: Clock },
  rip:            { label: 'RIP rebates', icon: BadgeDollarSign },
  combo:          { label: 'Combo bundles', icon: Combine },
  clearance:      { label: 'Clearance / closeouts', icon: Tag },
  price_drop:     { label: 'Price drops', icon: TrendingDown },
  target_hit:     { label: 'Target price hit', icon: Target },
  order_check:    { label: 'Check your draft orders', icon: ClipboardCheck },
  buy_now:        { label: 'Buy now (rises next month)', icon: CalendarClock },
  wait:           { label: 'Cheaper next month', icon: CalendarClock },
  lost_deal:      { label: 'Lost discounts', icon: TrendingUp },
  price_increase: { label: 'Price increases', icon: TrendingUp },
};

// Where each category opens, with the relevant filter pre-applied, so the user
// can act on the details.
const CAT_LINK: Record<string, string> = {
  expiring: '/',
  rip: '/rip-products',
  combo: '/combos',
  clearance: '/clearance',
  price_drop: '/analytics?tab=movers-down',
  target_hit: '/watchlist',
  order_check: '/orders',
  buy_now: '/analytics?tab=movers-up',
  wait: '/analytics?tab=movers-down',
  lost_deal: '/analytics?tab=lost-discounts',
  price_increase: '/analytics?tab=movers-up',
};

function AlertCard({ a, onOpen }: { a: Alert; onOpen: (a: Alert) => void }) {
  const meta = CAT[a.alert_type] ?? { label: a.alert_type.replace(/_/g, ' '), icon: Clock };
  const Icon = meta.icon;
  const intent = a.payload?.intent ?? 'opportunity';
  const items = a.payload?.items ?? [];
  const count = a.payload?.count ?? items.length;
  const read = !!a.read;
  const shown = items.slice(0, 3);   // fixed number of lines so every tile matches
  return (
    <div className={`alert-card intent-${intent} ${read ? 'read' : 'unread'}`}
      onClick={() => onOpen(a)} title="Open the details">
      <div className="alert-card-head">
        <span className="alert-card-title"><Icon size={16} /> {a.message}</span>
        <span className="alert-cat-chip">{meta.label}</span>
      </div>
      <ul className="alert-items">
        {shown.map((it, i) => (
          <li key={i}>
            <span className="ai-name">{it.label}</span>
            {it.detail && <span className="ai-detail">{it.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="alert-foot">
        <span className="alert-foot-more">{count > shown.length ? `+${count - shown.length} more` : ''}</span>
        <span className="alert-foot-link">View details &rarr;</span>
      </div>
    </div>
  );
}

export default function AlertsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['alerts'], queryFn: () => alerts.get() });

  // Auto-refresh the digest whenever the page is opened. No manual button.
  const generateMut = useMutation({
    mutationFn: alerts.generate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['unread-alerts'] });
    },
  });
  useEffect(() => { generateMut.mutate(); /* eslint-disable-next-line */ }, []);

  const markAll = useMutation({
    mutationFn: alerts.markAllRead,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['unread-alerts'] });
    },
  });
  const markRead = useMutation({
    mutationFn: (id: number) => alerts.markRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['unread-alerts'] });
    },
  });

  const all = data ?? [];
  const opps = all.filter(a => (a.payload?.intent ?? 'opportunity') === 'opportunity');
  const risks = all.filter(a => a.payload?.intent === 'risk');
  // Clicking a tile marks it read and opens its source with filters applied.
  const onOpen = (a: Alert) => {
    if (!a.read) markRead.mutate(a.id);
    navigate(CAT_LINK[a.alert_type] ?? '/');
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Alerts</h2>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
            <CheckCheck size={14} /> Mark all read
          </button>
        </div>
      </div>
      <p className="page-sub">
        Updated automatically. {opps.length} opportunit{opps.length === 1 ? 'y' : 'ies'}, {risks.length} watch-out{risks.length === 1 ? '' : 's'}.
      </p>

      {isLoading && all.length === 0 ? (
        <p className="text-muted">Checking for alerts…</p>
      ) : all.length === 0 ? (
        <div className="alert-empty"><BellOff size={20} /> You are all caught up. New alerts appear here automatically.</div>
      ) : (
        <>
          <div className="section-label">Opportunities · don&apos;t miss these</div>
          {opps.length === 0
            ? <p className="text-muted" style={{ fontSize: 13 }}>Nothing time-sensitive right now.</p>
            : <div className="alert-grid">{opps.map(a => <AlertCard key={a.id} a={a} onOpen={onOpen} />)}</div>}

          <div className="section-label" style={{ marginTop: 22 }}>Watch-outs · avoid a mistake</div>
          {risks.length === 0
            ? <p className="text-muted" style={{ fontSize: 13 }}>No issues found.</p>
            : <div className="alert-grid">{risks.map(a => <AlertCard key={a.id} a={a} onOpen={onOpen} />)}</div>}
        </>
      )}
    </div>
  );
}
