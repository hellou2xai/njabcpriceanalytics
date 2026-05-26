const PLACEHOLDER = '/no-image.svg';

interface Props {
  src?: string | null;
  alt: string;
  size?: number;
}

/**
 * Product image thumbnail. Renders the Go-UPC image straight from the R2 CDN
 * (edge- and browser-cached, immutable), lazy-loaded with fixed dimensions so
 * there is no layout shift. Falls back to the generic "Image Not Found"
 * placeholder when there is no image or the URL fails to load.
 */
export default function ProductThumb({ src, alt, size = 44 }: Props) {
  return (
    <img
      src={src || PLACEHOLDER}
      alt={alt}
      loading="lazy"
      decoding="async"
      width={size}
      height={size}
      onError={e => {
        const el = e.currentTarget as HTMLImageElement;
        if (!el.src.endsWith(PLACEHOLDER)) el.src = PLACEHOLDER;
      }}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: '#fff',
        flexShrink: 0,
        padding: 2,
      }}
    />
  );
}
