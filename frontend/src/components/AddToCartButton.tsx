import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Check } from 'lucide-react';
import { cart as cartApi } from '../lib/api';

interface Props {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  qtyCases?: number;
  qtyUnits?: number;
}

/**
 * The "+" in the catalogue Order column: adds the product to the server cart
 * with the row's current quantities. The cart groups items by sales rep.
 */
export default function AddToCartButton({ productName, wholesaler, upc, unitVolume, qtyCases = 0, qtyUnits = 0 }: Props) {
  const qc = useQueryClient();
  const [added, setAdded] = useState(false);
  const add = useMutation({
    mutationFn: () => cartApi.add({
      product_name: productName, wholesaler, upc, unit_volume: unitVolume,
      qty_cases: qtyCases, qty_units: qtyUnits,
    }),
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
      {added ? <><Check size={15} /> Added</> : <><Plus size={15} /> Add to cart</>}
    </button>
  );
}
