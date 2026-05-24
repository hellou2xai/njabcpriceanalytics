import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { orders } from '../lib/api';
import { distributorName } from '../lib/distributors';

interface AddToOrderButtonProps {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  qtyCases?: number;
  qtyUnits?: number;
}

export default function AddToOrderButton({
  productName,
  wholesaler,
  upc,
  unitVolume,
  qtyCases = 1,
  qtyUnits = 0,
}: AddToOrderButtonProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [showNewInput, setShowNewInput] = useState(false);
  const [newName, setNewName] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: allOrders } = useQuery({
    queryKey: ['orders', 'draft'],
    queryFn: () => orders.list('draft'),
    enabled: open,
    staleTime: 30_000,
  });

  const addLineMut = useMutation({
    mutationFn: (orderId: number) =>
      orders.addLine(orderId, {
        product_name: productName,
        wholesaler,
        upc,
        unit_volume: unitVolume,
        qty_cases: qtyCases,
        qty_units: qtyUnits,
      }),
    onSuccess: (_data, orderId) => {
      const orderName = allOrders?.find((o) => o.id === orderId)?.name ?? 'Order';
      triggerFlash(orderName);
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  // Only orders for this product's distributor (or unassigned) are valid targets.
  const validOrders = (allOrders ?? []).filter(o => !o.distributor || o.distributor === wholesaler);

  const createOrderMut = useMutation({
    mutationFn: (name: string) => orders.create({ name, distributor: wholesaler }),
    onSuccess: async (result) => {
      await orders.addLine(result.id, {
        product_name: productName,
        wholesaler,
        upc,
        unit_volume: unitVolume,
        qty_cases: qtyCases,
        qty_units: qtyUnits,
      });
      triggerFlash(newName || 'New Order');
      qc.invalidateQueries({ queryKey: ['orders'] });
      setNewName('');
      setShowNewInput(false);
    },
  });

  const triggerFlash = useCallback((orderName: string) => {
    setOpen(false);
    setFlash(`Added to ${orderName}!`);
    setTimeout(() => setFlash(null), 3000);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowNewInput(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus input when "New Order" is clicked
  useEffect(() => {
    if (showNewInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showNewInput]);

  const handleNewOrderSubmit = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    createOrderMut.mutate(trimmed);
  };

  if (flash) {
    return <span className="add-order-flash">{flash}</span>;
  }

  return (
    <div className="add-order-btn" ref={wrapperRef}>
      <button
        className="btn-icon"
        title="Add to order"
        onClick={() => setOpen((v) => !v)}
        style={{ color: 'var(--accent)' }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="add-order-dropdown">
          {validOrders.length > 0 ? (
            validOrders.map((order) => (
              <button
                key={order.id}
                className="add-order-item"
                onClick={() => addLineMut.mutate(order.id)}
                disabled={addLineMut.isPending}
              >
                <span style={{ flex: 1 }}>{order.name}</span>
                {order.division && (
                  <span className="tag tag-blue" style={{ fontSize: 10 }}>
                    {order.division}
                  </span>
                )}
              </button>
            ))
          ) : (
            <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
              No open order for {distributorName(wholesaler)}. Create one below.
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 2, paddingTop: 2 }}>
            {showNewInput ? (
              <div style={{ display: 'flex', gap: 4, padding: '6px 10px' }}>
                <input
                  ref={inputRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNewOrderSubmit();
                    if (e.key === 'Escape') {
                      setShowNewInput(false);
                      setNewName('');
                    }
                  }}
                  placeholder="Order name..."
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    fontSize: 12,
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text)',
                    outline: 'none',
                  }}
                />
                <button
                  className="btn"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={handleNewOrderSubmit}
                  disabled={createOrderMut.isPending || !newName.trim()}
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                className="add-order-item"
                onClick={() => setShowNewInput(true)}
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                New Order
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
