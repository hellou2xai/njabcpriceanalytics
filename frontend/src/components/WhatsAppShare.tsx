import { useEffect, useState } from 'react';
import { shareOnWhatsApp, loadShareContent, DEFAULT_SHARE_MESSAGE, DEFAULT_SHARE_URL, type ShareContent } from '../lib/share';

// WhatsApp brand glyph (lucide doesn't ship brand logos). Green by default.
export function WhatsAppIcon({ size = 18, color = '#25D366' }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={color} aria-hidden="true"
      style={{ flexShrink: 0 }}>
      <path d="M19.05 4.91A9.82 9.82 0 0 0 12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.004c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01zM12.04 20.15h-.003a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.23 8.23 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.16.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.51.11-.11.25-.29.37-.43.13-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.11-.22-.17-.47-.29z" />
    </svg>
  );
}

/** Shared "Share via WhatsApp" trigger. Pass a className for the host context. */
export default function WhatsAppShareButton({
  className, label = 'Share via WhatsApp', showLabel = true, title, iconSize = 18, source,
}: {
  className?: string; label?: string; showLabel?: boolean; title?: string; iconSize?: number; source?: string;
}) {
  // Preload the (admin-editable) copy so the click handler stays synchronous
  // and the WhatsApp window is not blocked as a popup.
  const [content, setContent] = useState<ShareContent>({ message: DEFAULT_SHARE_MESSAGE, url: DEFAULT_SHARE_URL });
  useEffect(() => { loadShareContent().then(setContent); }, []);
  return (
    <button type="button" className={className}
      onClick={() => shareOnWhatsApp(content.message, content.url, source)} title={title ?? label}>
      <WhatsAppIcon size={iconSize} />
      {showLabel && <span>{label}</span>}
    </button>
  );
}
