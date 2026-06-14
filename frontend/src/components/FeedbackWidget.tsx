import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquarePlus, X, Bug, Lightbulb, Paperclip, Mic, MicOff } from 'lucide-react';
import { feedback } from '../lib/api';

const MAX_SHOTS = 6;

// Small, non-intrusive "BETA" sticker. pointer-events:none so it never blocks
// anything underneath it. `inApp` shifts it to the top of the main content
// (just right of the sidebar) so it doesn't sit on top of the logo; the public
// landing badge stays in the top-left corner.
export function BetaBadge({ inApp = false }: { inApp?: boolean }) {
  return <div className={`beta-badge${inApp ? ' in-app' : ''}`} title="This app is in beta">BETA</div>;
}

// ---- Draggable position for the Feedback FAB ----
const FAB_W = 124, FAB_H = 40, MARGIN = 16, DRAG_THRESHOLD = 4;
const PANEL_W = 420;   // wider feedback panel; also dragged by its header
const POS_KEY = 'feedback_fab_pos';
interface Pos { x: number; y: number }

function clampPos(x: number, y: number): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - FAB_W - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - FAB_H - MARGIN);
  return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) };
}
function clampPanel(x: number, y: number): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - PANEL_W - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - 80 - MARGIN);  // keep header reachable
  return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) };
}
// Default: bottom-LEFT (per request), replacing the old bottom-right anchor.
function defaultPos(): Pos { return clampPos(MARGIN, window.innerHeight - FAB_H - MARGIN); }

// Pull image files out of a paste/drop DataTransfer. A clipboard screenshot
// (Win+Shift+S, macOS Cmd+Shift+4) usually arrives in `items` (getAsFile), not
// `files`, so we read BOTH and dedupe — relying on `files` alone misses pastes.
function extractImages(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const push = (f: File | null) => {
    if (f && f.type.startsWith('image/')) {
      const key = `${f.name}|${f.size}|${f.type}`;
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
  };
  for (const f of Array.from(dt.files || [])) push(f);
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file') push(it.getAsFile());
  }
  return out;
}

// Floating "Feedback" button on every page. Draggable (drop anywhere, position
// is remembered); a plain click opens the form. The user types a note; their
// account, the current page, and the browser are attached automatically.
export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'bug' | 'idea'>('bug');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shots, setShots] = useState<File[]>([]);
  const [listening, setListening] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const voiceBaseRef = useRef('');
  const voiceSupported = typeof window !== 'undefined'
    && !!((window as unknown as Record<string, unknown>).SpeechRecognition
       || (window as unknown as Record<string, unknown>).webkitSpeechRecognition);

  const addShots = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imgs.length) setShots(prev => [...prev, ...imgs].slice(0, MAX_SHOTS));
  }, []);

  // Paste an image ANYWHERE while the form is open (not just in the textarea) —
  // so a screenshot copied to the clipboard attaches even if focus moved. Only
  // image pastes are intercepted; pasting text into the comment box is untouched.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const imgs = extractImages(e.clipboardData);
      if (imgs.length) { e.preventDefault(); addShots(imgs); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, addShots]);

  // Voice comment -> text, transcribed in the browser (Web Speech API, the same
  // engine the assistant uses). Dictation APPENDS to whatever is typed.
  const toggleVoice = useCallback(() => {
    if (listening) { recRef.current?.stop(); return; }
    const W = window as unknown as Record<string, new () => {
      lang: string; interimResults: boolean; continuous: boolean;
      start: () => void; stop: () => void;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: (() => void) | null; onend: (() => void) | null;
    }>;
    const SR = W.SpeechRecognition || W.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    setMessage(m => { voiceBaseRef.current = m.trim() ? m.trim() + ' ' : ''; return m; });
    rec.onresult = (e) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setMessage(voiceBaseRef.current + txt);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening]);

  const [pos, setPos] = useState<Pos | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  const [panelPos, setPanelPos] = useState<Pos | null>(null);
  const panelDrag = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  // Anchor the panel near the FAB the first time it opens; clear on close so it
  // re-anchors next time. While open the header can drag it anywhere.
  useEffect(() => {
    if (!open || !pos) { setPanelPos(null); return; }
    setPanelPos(prev => prev ?? clampPanel(
      Math.min(pos.x, window.innerWidth - PANEL_W - MARGIN),
      Math.max(MARGIN, pos.y - 360)));
  }, [open, pos]);

  useEffect(() => {
    let initial: Pos | null = null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) { const p = JSON.parse(raw); if (typeof p?.x === 'number' && typeof p?.y === 'number') initial = p; }
    } catch { /* ignore */ }
    const start = initial ?? defaultPos();
    setPos(clampPos(start.x, start.y));
  }, []);
  useEffect(() => {
    const onResize = () => setPos(p => (p ? clampPos(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!pos) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y, moved: false };
  }, [pos]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) { d.moved = true; setDragging(true); }
    if (d.moved) setPos(clampPos(d.baseX + dx, d.baseY + dy));
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
    if (d && !d.moved) {
      setOpen(true);   // a tap that never moved = a click
    } else if (d?.moved) {
      setPos(p => { if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* */ } } return p; });
    }
    setDragging(false);
  }, []);

  const submit = async () => {
    const msg = message.trim();
    if ((!msg && shots.length === 0) || sending) return;
    if (listening) { recRef.current?.stop(); }
    setSending(true);
    setError(null);
    try {
      await feedback.submit({
        message: msg,
        kind,
        page: window.location.pathname + window.location.search,
        user_agent: navigator.userAgent,
        screenshots: shots,
      });
      setDone(true);
      setMessage('');
      setShots([]);
      setTimeout(() => { setOpen(false); setDone(false); }, 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send. Please try again.');
    } finally {
      setSending(false);
    }
  };

  // The open panel can be dragged by its header, independent of the FAB.
  const onPanelDown = (e: React.PointerEvent) => {
    if (!panelPos) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panelDrag.current = { sx: e.clientX, sy: e.clientY, bx: panelPos.x, by: panelPos.y };
  };
  const onPanelMove = (e: React.PointerEvent) => {
    const d = panelDrag.current;
    if (!d) return;
    setPanelPos(clampPanel(d.bx + (e.clientX - d.sx), d.by + (e.clientY - d.sy)));
  };
  const onPanelUp = (e: React.PointerEvent) => {
    panelDrag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  if (!pos) return null;

  if (!open) {
    return (
      <button
        className="feedback-fab"
        style={{ left: pos.x, top: pos.y, right: 'auto', bottom: 'auto', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to move · click to submit a bug or suggestion">
        <MessageSquarePlus size={18} />
        <span>Feedback</span>
      </button>
    );
  }

  return (
    <div className="feedback-panel" role="dialog" aria-label="Submit feedback"
         style={panelPos
           ? { left: panelPos.x, top: panelPos.y, right: 'auto', bottom: 'auto' }
           : { left: -9999, top: -9999 }}>
      <div className="feedback-panel-head feedback-panel-drag"
           onPointerDown={onPanelDown} onPointerMove={onPanelMove} onPointerUp={onPanelUp}
           style={{ cursor: dragging ? 'grabbing' : 'move', touchAction: 'none' }}
           title="Drag to move">
        <strong>Submit a bug or suggestion</strong>
        <button className="feedback-close" onClick={() => setOpen(false)}
                onPointerDown={e => e.stopPropagation()} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      {done ? (
        <div className="feedback-thanks">Thanks. Your note went to the team.</div>
      ) : (
        <>
          <div className="feedback-kind">
            <button type="button" className={`feedback-kind-btn ${kind === 'bug' ? 'active' : ''}`}
                    onClick={() => setKind('bug')}>
              <Bug size={14} /> Bug
            </button>
            <button type="button" className={`feedback-kind-btn ${kind === 'idea' ? 'active' : ''}`}
                    onClick={() => setKind('idea')}>
              <Lightbulb size={14} /> Idea
            </button>
          </div>
          <textarea
            className="feedback-text"
            placeholder={kind === 'bug'
              ? 'What went wrong? Type, paste a screenshot, or tap the mic to speak.'
              : 'What would make this better? Type, paste a screenshot, or speak.'}
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={6}
            autoFocus
          />
          {/* Screenshot thumbnails (remove with the ×). */}
          {shots.length > 0 && (
            <div className="feedback-shots">
              {shots.map((f, i) => (
                <span className="feedback-shot" key={i} title={f.name}>
                  <img src={URL.createObjectURL(f)} alt={f.name} />
                  <button type="button" className="feedback-shot-x"
                    onClick={() => setShots(s => s.filter((_, j) => j !== i))} aria-label="Remove">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={e => { addShots(e.target.files); if (fileRef.current) fileRef.current.value = ''; }} />
          {error && <div className="feedback-error">{error}</div>}
          <div className="feedback-tools">
            <button type="button" className="feedback-tool"
              disabled={shots.length >= MAX_SHOTS}
              onClick={() => fileRef.current?.click()}
              title={shots.length >= MAX_SHOTS ? `Up to ${MAX_SHOTS} screenshots` : 'Attach a file, or just paste a screenshot (Ctrl/Cmd+V) anywhere in this form'}>
              <Paperclip size={14} /> Screenshot
            </button>
            {voiceSupported && (
              <button type="button" className={`feedback-tool ${listening ? 'is-rec' : ''}`}
                onClick={toggleVoice} title={listening ? 'Stop dictation' : 'Speak your comment'}>
                {listening ? <MicOff size={14} /> : <Mic size={14} />}
                {listening ? 'Listening…' : 'Speak'}
              </button>
            )}
          </div>
          <div className="feedback-actions">
            <span className="feedback-hint">Sent with your account and current page.</span>
            <button className="btn btn-sm" disabled={(!message.trim() && shots.length === 0) || sending} onClick={submit}>
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
