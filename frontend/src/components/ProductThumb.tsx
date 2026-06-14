import { useEffect, useState } from 'react';

const PLACEHOLDER = '/no-image.svg';

interface Props {
  src?: string | null;
  alt: string;
  size?: number;
  // When true and a REAL image exists, clicking enlarges it in a lightbox.
  expandable?: boolean;
}

/**
 * Product image thumbnail. Renders the Go-UPC image straight from the R2 CDN
 * (edge- and browser-cached, immutable), lazy-loaded with fixed dimensions so
 * there is no layout shift. Falls back to the generic "Image Not Found"
 * placeholder when there is no image or the URL fails to load.
 *
 * With `expandable`, a real image becomes click-to-enlarge: it opens a centered
 * lightbox (click anywhere or Esc to close). The thumbnail sits inside clickable
 * cards/links elsewhere, so the click is stopped from bubbling/navigating.
 */
export default function ProductThumb({ src, alt, size = 44, expandable = false }: Props) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const hasImg = !!src && !broken;
  const canExpand = expandable && hasImg;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const img = (
    <img
      src={src || PLACEHOLDER}
      alt={alt}
      loading="lazy"
      decoding="async"
      width={size}
      height={size}
      onError={() => setBroken(true)}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        borderRadius: 6,
        background: 'transparent',
        flexShrink: 0,
        padding: 2,
        cursor: canExpand ? 'zoom-in' : undefined,
      }}
    />
  );

  if (!canExpand) return img;

  return (
    <>
      <button
        type="button"
        className="prod-thumb-zoom"
        title="Click to enlarge"
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        style={{ border: 0, background: 'transparent', padding: 0, cursor: 'zoom-in', lineHeight: 0 }}
      >
        {img}
      </button>
      {open && (
        <div
          className="prod-thumb-lightbox"
          onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}
          role="dialog"
          aria-label={alt}
          style={{
            position: 'fixed', inset: 0, zIndex: 4000,
            background: 'rgba(15, 23, 42, 0.78)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24, cursor: 'zoom-out',
          }}
        >
          <img
            src={src || PLACEHOLDER}
            alt={alt}
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: 'min(92vw, 720px)', maxHeight: '88vh',
              objectFit: 'contain', borderRadius: 10,
              background: '#fff', padding: 12,
              boxShadow: '0 20px 60px rgba(0,0,0,0.45)', cursor: 'default',
            }}
          />
        </div>
      )}
    </>
  );
}
