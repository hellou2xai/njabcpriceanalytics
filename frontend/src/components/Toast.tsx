import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info';
type ToastItem = { id: number; kind: ToastKind; message: string };

type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    // Keep at most 4 on screen so a burst of failures can't bury the page.
    setToasts(t => [...t.slice(-3), { id, kind, message }]);
    window.setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3800);
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    success: m => push('success', m),
    error: m => push('error', m),
    info: m => push('info', m),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
            aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
          >
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
