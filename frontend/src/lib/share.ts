// WhatsApp share. Opens the visitor's own WhatsApp (mobile app or WhatsApp Web)
// with the message prefilled via the official click-to-share link, so they pick
// the recipient and send it themselves. No backend, no Business API.

// The shared link must use a valid TLS cert. The custom domain (nj.celr.ai)
// currently serves a self-signed cert, so we share the Render URL.
export const APP_SHARE_URL = 'https://njabc-price-analytics.onrender.com';

export const SHARE_MESSAGE =
  'What takes you 50+ hours a month, CELR.ai shows in seconds:\n' +
  '• Real price + discount on every item\n' +
  '• Which RIPs and rebates you qualify for\n' +
  '• Buy now or wait for next month\n' +
  '• Deals about to expire\n' +
  `All in one screen. Free during early access: ${APP_SHARE_URL}`;

export function shareOnWhatsApp() {
  const url = `https://wa.me/?text=${encodeURIComponent(SHARE_MESSAGE)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}
