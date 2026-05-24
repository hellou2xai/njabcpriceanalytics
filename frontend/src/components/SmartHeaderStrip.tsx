import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { stores as storesApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

/**
 * Store greeting header. Reads the real signed-in user and their first store
 * (name + license) from the stores feature. No fabricated figures. An optional
 * rightSlot (e.g. the distributor filter) sits on the right of the bar.
 */
export default function SmartHeaderStrip({ rightSlot }: { rightSlot?: ReactNode }) {
  const { user } = useAuth();
  const { data: stores } = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });
  const store = stores?.[0];
  const storeName = store?.name ?? user?.full_name ?? user?.email ?? 'there';
  const license = store?.license_number;

  return (
    <header className="smart-header">
      <div className="smart-header-greet">
        <h2 className="smart-header-title">
          Welcome back, {storeName}{license ? <span className="smart-header-lic"> ({license})</span> : null}.
        </h2>
        <p className="smart-header-sub">{todayLabel()}</p>
      </div>
      {rightSlot && <div className="smart-header-right">{rightSlot}</div>}
    </header>
  );
}
