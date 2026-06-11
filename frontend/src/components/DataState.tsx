import { AlertTriangle, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';

// Shared fetch-failure state. Pair with react-query: isError -> <ErrorState retry={refetch} />
export function ErrorState({ message, retry }: { message?: string; retry?: () => void }) {
  return (
    <div className="data-error" role="alert">
      <AlertTriangle size={22} />
      <div className="data-error-title">Couldn't load this data</div>
      <div>{message || 'Something went wrong talking to the server. Check your connection and try again.'}</div>
      {retry && <button className="btn" onClick={() => retry()}>Retry</button>}
    </div>
  );
}

// Shared zero-results state, so a filtered-to-nothing table never renders blank.
export function EmptyState({
  title = 'No results',
  children,
  action,
}: { title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="data-empty">
      <SearchX size={22} aria-hidden="true" />
      <div className="data-empty-title">{title}</div>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}
