import { PackageSearch, ExternalLink } from 'lucide-react';
import { distributorName } from '../lib/distributors';
import { isWholesaleDistributor, searchTermFor, openAvailability } from '../lib/wholesaleLink';

interface Props {
  /** Item's distributor slug. The button only renders for 'allied' / 'fedway'. */
  wholesaler?: string | null;
  /** CELR item name — used as the keyword fallback when no item number maps. */
  name?: string | null;
  /** Distributor item number (CELR `abg_sku`), preferred precise search term. */
  itemNumber?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * "Check <Allied|Fedway> availability" — opens that distributor's ordering
 * portal search in a new tab, prefilled with the item number (precise) or the
 * item name (keyword fallback). The merchant is logged into the portal under
 * their OWN credentials and checks stock there; nothing flows back to CELR.
 *
 * Renders ONLY for Allied/Fedway items (the two distributors with a portal we
 * deep-link); returns null for every other distributor.
 */
export default function AvailabilityButton({ wholesaler, name, itemNumber, size = 'sm', className }: Props) {
  if (!isWholesaleDistributor(wholesaler)) return null;
  const term = searchTermFor(itemNumber, name);
  const precise = itemNumber != null && String(itemNumber).trim() !== '';
  const label = distributorName(wholesaler);
  const iconSize = size === 'md' ? 15 : 13;
  return (
    <button
      type="button"
      className={`availability-btn availability-btn-${size}${className ? ` ${className}` : ''}`}
      disabled={!term}
      title={term
        ? `Open ${label}'s portal search for this item (${precise ? `item #${String(itemNumber).trim()}` : 'by name'}). You check stock on ${label} with your own login.`
        : `No ${label} item number or name to search`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); openAvailability(wholesaler, itemNumber, name); }}
    >
      <PackageSearch size={iconSize} />
      <span>Check {label}</span>
      <ExternalLink size={iconSize - 2} className="availability-btn-ext" />
    </button>
  );
}
