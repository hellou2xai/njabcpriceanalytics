/**
 * SearchLensTools — the camera-lens + voice buttons that sit inside a search
 * bar, plus the MobileLens overlay. Shared by the Products search bar and the
 * Celr Home search bar so both get the same Amazon-style photo / barcode /
 * voice search.
 *
 * Gating (per product decisions): the camera LENS shows on TOUCH devices only
 * (phones + tablets/iPads: ≤1023px OR a coarse pointer, so landscape iPads
 * count); the VOICE mic shows on every device that supports the Web Speech API,
 * including desktop. `onResult(query)` is called with a barcode, a
 * vision-identified product, or a voice transcript — the page then runs its
 * normal search with it.
 */
import { useRef, useState } from 'react';
import { Camera, Mic } from 'lucide-react';
import MobileLens from './MobileLens';
import { useIsMobile } from '../hooks/useIsMobile';

export default function SearchLensTools({ onResult }: { onResult: (query: string) => void }) {
  const [lensOpen, setLensOpen] = useState(false);
  const [listening, setListening] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recogRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRec = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : undefined;
  const isMobile = useIsMobile();
  const isTouchDevice = isMobile || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);

  const startVoice = () => {
    if (!SpeechRec) return;
    try {
      const r = new SpeechRec();
      r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onresult = (ev: any) => { const t = ev?.results?.[0]?.[0]?.transcript?.trim(); if (t) onResult(t); };
      r.onend = () => setListening(false);
      r.onerror = () => setListening(false);
      recogRef.current = r; setListening(true); r.start();
    } catch { setListening(false); }
  };
  const stopVoice = () => { try { recogRef.current?.stop?.(); } catch { /* noop */ } setListening(false); };

  if (!isTouchDevice && !SpeechRec) return null;
  return (
    <>
      <span className="products-hero-tools">
        {isTouchDevice && (
          <button type="button" className="products-hero-tool" aria-label="Search by photo or barcode"
            title="Search by photo or barcode" onClick={() => setLensOpen(true)}>
            <Camera size={20} />
          </button>
        )}
        {SpeechRec && (
          <button type="button" className={`products-hero-tool${listening ? ' is-live' : ''}`}
            aria-label="Voice search" title="Voice search"
            onClick={() => (listening ? stopVoice() : startVoice())}>
            <Mic size={20} />
          </button>
        )}
      </span>
      {isTouchDevice && (
        <MobileLens open={lensOpen} onClose={() => setLensOpen(false)} onResult={onResult} />
      )}
    </>
  );
}
