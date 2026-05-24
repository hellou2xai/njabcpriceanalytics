import { useProductQuickView } from './ProductQuickView';

interface Props {
  code: string;
  productName: string;
  wholesaler: string;
}

export default function ProductLink({ code, productName, wholesaler }: Props) {
  const { open } = useProductQuickView();

  return (
    <span
      className="product-link"
      onClick={e => { e.stopPropagation(); open(productName, wholesaler); }}
    >
      {code}
    </span>
  );
}
