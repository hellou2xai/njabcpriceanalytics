// WhatsApp share. Opens the visitor's own WhatsApp (mobile app or WhatsApp Web)
// with the message prefilled via the official click-to-share link, so they pick
// the recipient and send it themselves. No backend, no Business API.
//
// The copy is editable by an admin from the Admin page (stored server-side via
// /api/settings/share-message). These constants are the fallback used before
// that loads or if the request fails.

import { settings, share as shareApi } from './api';

export const DEFAULT_SHARE_URL = 'https://nj.celr.ai';

export const DEFAULT_SHARE_MESSAGE =
  'What takes you 50+ hours a month, CELR.ai shows in seconds:\n' +
  '• Real price + discount on every item\n' +
  '• Which RIPs and rebates you qualify for\n' +
  '• Buy now or wait for next month\n' +
  '• Deals about to expire\n' +
  'All in one screen. Free during early access:';

export type ShareContent = { message: string; url: string };

// Module-level cache so the several share buttons share one fetch.
let cached: ShareContent | null = null;
let inflight: Promise<ShareContent> | null = null;

export function loadShareContent(): Promise<ShareContent> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = settings.getShareMessage()
      .then(c => { cached = { message: c.message || DEFAULT_SHARE_MESSAGE, url: c.url || DEFAULT_SHARE_URL }; return cached; })
      .catch(() => ({ message: DEFAULT_SHARE_MESSAGE, url: DEFAULT_SHARE_URL }));
  }
  return inflight;
}

// Let the admin editor refresh the cache after a save.
export function setShareContentCache(c: ShareContent) { cached = c; inflight = null; }

function composeText(message: string, url: string): string {
  return `${message.trim()} ${url.trim()}`.trim();
}

// Log the click (user or anonymous, with timestamp) for the admin view. Fire
// and forget, and only AFTER window.open so the popup stays in the user gesture.
function trackShare(source?: string) {
  try {
    shareApi.track({
      channel: 'whatsapp', source,
      page: window.location.pathname, user_agent: navigator.userAgent,
    });
  } catch { /* never block sharing on tracking */ }
}

export function shareOnWhatsApp(
  message: string = DEFAULT_SHARE_MESSAGE, url: string = DEFAULT_SHARE_URL, source?: string,
) {
  const text = composeText(message, url);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  trackShare(source);
}

// Share using whatever copy is cached (loaded by a mounted share button),
// falling back to the defaults. Kept synchronous so window.open is not blocked.
export function shareOnWhatsAppCached(source?: string) {
  const c = cached ?? { message: DEFAULT_SHARE_MESSAGE, url: DEFAULT_SHARE_URL };
  shareOnWhatsApp(c.message, c.url, source);
}
