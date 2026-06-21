import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Check } from 'lucide-react';
import { cart as cartApi } from '../lib/api';

interface Props {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  // Pack (bottles/case) + vintage complete the SKU identity, so the cart prices
  // the exact item the buyer clicked — never a same-barcode pack/vintage sibling.
  unitQty?: string;
  vintage?: string;
  qtyCases?: number;
  qtyUnits?: number;
}

/**
 * The "+" in the catalogue Order column: adds the product to the server cart
 * with the row's current quantities. The cart groups items by sales rep.
 */
export default function AddToCartButton({ productName, wholesaler, upc, unitVolume, unitQty, vintage, qtyCases = 0, qtyUnits = 0 }: Props) {
  const qc = useQueryClient();
  const [added, setAdded] = useState(false);
  const add = useMutation({
    // Default to 1 case when the caller hasn't set any quantity — adding a line
    // with 0 cases / 0 bottles is never intended (the buyer wants the product).
    mutationFn: () => {
      const cs = qtyCases || 0, un = qtyUnits || 0;
      return cartApi.add({
        product_name: productName, wholesaler, upc, unit_volume: unitVolume,
        unit_qty: unitQty, vintage,
        qty_cases: cs === 0 && un === 0 ? 1 : cs, qty_units: un,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cart'] });
      setAdded(true);
      setTimeout(() => setAdded(false), 1200);
    },
  });
  return (
    <button
      type="button"
      className={`btn btn-sm add-to-cart-btn${added ? ' is-added' : ''}`}
      title="Add to cart"
      onClick={e => { e.stopPropagation(); add.mutate(); }}
      disabled={add.isPending}
    >
      {added ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add to cart</>}
    </button>
  );
}
