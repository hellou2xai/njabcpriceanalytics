import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import FavoriteButton from './FavoriteButton';
import CloseoutFlagButton from './CloseoutFlagButton';
import './RowActions.css';

interface Props {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  unitQty?: string;
  qtyCases?: number;
}

/**
 * The one reusable row action bar — Add to cart, Add to list, Favorite,
 * Mark as closeout — used on every comparison surface (Compare Prices,
 * Compare RIPs, Price 360, Edition Comparison) so the actions are identical
 * everywhere. Stops click propagation so using an action never toggles the
 * row's expand state.
 */
export default function RowActions({ productName, wholesaler, upc, unitVolume, unitQty, qtyCases = 1 }: Props) {
  return (
    <div className="row-actions" onClick={e => e.stopPropagation()}>
      <AddToCartButton productName={productName} wholesaler={wholesaler} upc={upc} unitVolume={unitVolume} qtyCases={qtyCases} />
      <AddToListButton productName={productName} wholesaler={wholesaler} upc={upc} unitVolume={unitVolume} />
      <FavoriteButton productName={productName} wholesaler={wholesaler} upc={upc} unitVolume={unitVolume} />
      <CloseoutFlagButton productName={productName} wholesaler={wholesaler} upc={upc} unitVolume={unitVolume} unitQty={unitQty} />
    </div>
  );
}
