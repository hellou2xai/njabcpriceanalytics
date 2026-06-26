/**
 * MobileLens — full-screen camera "lens" search for the MOBILE Products search.
 *
 * Three ways to find a bottle without typing:
 *   - Take Picture and search: capture the live frame -> /api/catalog/lens
 *     (Claude vision reads the label) -> returns a query the page then searches.
 *   - Upload a photo: same vision path from the photo library.
 *   - Scan Barcode: decode a UPC/EAN off the live stream -> search that barcode.
 *
 * getUserMedia needs HTTPS (prod is). Barcode decoding uses the
 * `barcode-detector` ponyfill so it works on iOS Safari (no native
 * BarcodeDetector there). The component is rendered only on mobile.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, ScanBarcode, ImageUp, Loader2, X } from 'lucide-react';
import { BarcodeDetector } from 'barcode-detector/pure';
import { catalog } from '../lib/api';

type Props = { open: boolean; onClose: () => void; onResult: (query: string) => void };

const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] as const;

// Draw a source (video frame or image) to a downscaled JPEG data URL so the
// upload stays small (~100-300KB) and vision stays fast/cheap.
function toJpegDataUrl(src: CanvasImageSource, sw: number, sh: number, maxEdge = 1100): string {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(src, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.82);
}

export default function MobileLens({ open, onClose, onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);        // vision identify in flight
  const [scanning, setScanning] = useState(false); // barcode loop active
  const [ready, setReady] = useState(false);      // camera playing
  const [hint, setHint] = useState<string | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const stopCamera = useCallback(() => {
    scanRef.current = false;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // Start / stop the rear camera with the overlay's open state.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null); setBusy(false); setScanning(false); setReady(false); setHint(null);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
          if (!cancelled) setReady(true);   // -> auto-start barcode scan
        }
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        setError(name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow camera in your browser settings, or upload a photo instead.'
          : 'Couldn’t open the camera on this device. You can still upload a photo or scan a barcode.');
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, [open, stopCamera]);

  const close = useCallback(() => { stopCamera(); onClose(); }, [stopCamera, onClose]);

  // Run the vision identify on a data URL, then hand the query back to the page.
  const identify = useCallback(async (dataUrl: string) => {
    setBusy(true); setError(null); setHint('Identifying…');
    try {
      const { query } = await catalog.lens(dataUrl);
      if (query) { onResult(query); close(); }
      else { setError('Couldn’t read a label. Fill the frame with the bottle’s front label and try again.'); setHint(null); }
    } catch {
      setError('Something went wrong identifying that photo. Try again.'); setHint(null);
    } finally { setBusy(false); }
  }, [onResult, close]);

  const takePhoto = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) { setError('Camera isn’t ready yet.'); return; }
    identify(toJpegDataUrl(v, v.videoWidth, v.videoHeight));
  }, [identify]);

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => identify(toJpegDataUrl(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => setError('Couldn’t read that image.');
    img.src = URL.createObjectURL(file);
  }, [identify]);

  // Continuous barcode scan loop over the live video. Auto-runs as soon as the
  // camera is ready (no tap needed) and on every frame until a code is found.
  const stopScan = useCallback(() => {
    scanRef.current = false;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setScanning(false);
  }, []);
  const startScan = useCallback(() => {
    if (scanRef.current) return;
    if (!detectorRef.current) detectorRef.current = new BarcodeDetector({ formats: BARCODE_FORMATS as unknown as string[] });
    scanRef.current = true; setScanning(true);
    setHint('Point at a barcode to scan, or take a photo');
    const tick = async () => {
      if (!scanRef.current) return;
      const v = videoRef.current;
      if (v?.videoWidth) {
        try {
          const codes = await detectorRef.current!.detect(v);
          const raw = codes.find(c => c.rawValue)?.rawValue?.trim();
          if (raw) { scanRef.current = false; setScanning(false); onResultRef.current(raw); close(); return; }
        } catch { /* keep scanning */ }
      }
      if (scanRef.current) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [close]);

  // Auto-start scanning once the camera is live; pause it while a photo is
  // being identified, resume after.
  useEffect(() => {
    if (!open || !ready) return;
    if (busy) stopScan(); else startScan();
  }, [open, ready, busy, startScan, stopScan]);

  if (!open) return null;

  return (
    <div className="lens-overlay" role="dialog" aria-label="Lens search">
      <video ref={videoRef} className="lens-video" playsInline muted />
      <div className="lens-top">
        <button type="button" className="lens-icon-btn" onClick={close} aria-label="Close lens">
          <ArrowLeft size={22} />
        </button>
        <span className="lens-title"><Camera size={16} /> Lens</span>
        <button type="button" className="lens-icon-btn" onClick={close} aria-label="Close"><X size={20} /></button>
      </div>

      {scanning && <div className="lens-reticle" aria-hidden />}

      {(hint || error) && (
        <div className={`lens-hint${error ? ' lens-hint--err' : ''}`}>{error ?? hint}</div>
      )}

      {busy && (
        <div className="lens-busy"><Loader2 className="lens-spin" size={28} /> Identifying the bottle…</div>
      )}

      <div className="lens-bottom">
        <button type="button" className="lens-side-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          <ImageUp size={22} /><span>Upload</span>
        </button>
        <button type="button" className="lens-shutter" onClick={takePhoto} disabled={busy} aria-label="Take picture and search">
          {busy ? <Loader2 className="lens-spin" size={26} /> : <Camera size={28} />}
        </button>
        <button type="button" className={`lens-side-btn${scanning ? ' is-active' : ''}`}
          onClick={() => (scanning ? stopScan() : startScan())} disabled={busy}>
          <ScanBarcode size={22} /><span>{scanning ? 'Scanning…' : 'Scan'}</span>
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
        className="lens-file" onChange={onPickFile} />
    </div>
  );
}
