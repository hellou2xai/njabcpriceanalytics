// Centered spinner + message for pages whose data takes a moment to load.
export default function DataLoading({ label = 'Data refreshing…' }: { label?: string }) {
  return (
    <div className="data-loading" role="status" aria-live="polite">
      <span className="data-loading-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
