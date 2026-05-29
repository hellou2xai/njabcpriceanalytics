/**
 * "Multiple vintages" sticker for wine / sparkling / vermouth cards on the
 * Promotions pages. Shown when the backend has flagged that the same
 * product (name + size, same edition) is listed under more than one
 * vintage; tooltip enumerates them so the buyer knows the row's price
 * compare wasn't done against a different vintage of the same SKU.
 */
interface Props {
  vintages: string[] | null | undefined;
  // The vintage the headline row IS, so we can highlight it in the
  // tooltip and badge.
  currentVintage?: string | null;
}

export default function VintageSticker({ vintages, currentVintage }: Props) {
  if (!vintages || vintages.length < 2) return null;
  const cur = currentVintage ? String(currentVintage).replace(/\.0+$/, '') : null;
  const others = vintages.filter(v => v && (!cur || v !== cur));
  const title = cur
    ? `This row's vintage is ${cur}. Other vintages on file for the same product: ${others.join(', ')}. Price comparisons are vintage-aware so the row was matched against the same vintage in the other edition.`
    : `Vintages on file for the same product: ${vintages.join(', ')}.`;
  return (
    <span className="vintage-sticker" title={title}>
      🍇 {vintages.length} vintages
    </span>
  );
}
