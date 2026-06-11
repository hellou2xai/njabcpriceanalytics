/**
 * The RIP / QD pill used on every deal line (catalog deal ladder, compare
 * ladders, savings analysis, product cards). One component so the label and
 * styling can't drift between pages. `label` overrides the default text for
 * special cases like "Case Mix".
 */
export default function TierBadge({ kind, label }: { kind: 'rip' | 'qd'; label?: string }) {
  return <span className={`prod-deal-badge prod-deal-${kind}`}>{label ?? kind.toUpperCase()}</span>;
}
