import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquarePlus, X, Bug, Lightbulb } from 'lucide-react';
import { feedback } from '../lib/api';

// Small, non-intrusive "BETA" sticker. pointer-events:none so it never blocks
// anything underneath it. `inApp` shifts it to the top of the main content
// (just right of the sidebar) so it doesn't sit on top of the logo; the public
// landing badge stays in the top-left corner.
export function BetaBadge({ inApp = false }: { inApp?: boolean }) {
  return <div className={`beta-badge${inApp ? ' in-app' : ''}`} title="This app is in beta">BETA</div>;
}

// ---- Draggable position for the Feedback FAB ----
const FAB_W = 124, FAB_H = 40, MARGIN = 16, DRAG_THRESHOLD = 4;
const POS_KEY = 'feedback_fab_pos';
interface Pos { x: number; y: number }

function clampPos(x: number, y: number): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - FAB_W - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - FAB_H - MARGIN);
  return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) };
}
// Default: bottom-LEFT (per request), replacing the old bottom-right anchor.
function defaultPos(): Pos { return clampPos(MARGIN, window.innerHeight - FAB_H - MARGIN); }

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

  const [pos, setPos] = useState<Pos | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);

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
    if (!msg || sending) return;
    setSending(true);
    setError(null);
    try {
      await feedback.submit({
        message: msg,
        kind,
        page: window.location.pathname + window.location.search,
        user_agent: navigator.userAgent,
      });
      setDone(true);
      setMessage('');
      setTimeout(() => { setOpen(false); setDone(false); }, 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send. Please try again.');
    } finally {
      setSending(false);
    }
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

  // Anchor the panel to wherever the FAB was dropped: left-aligned with it,
  // growing upward from its bottom edge, clamped to the viewport.
  const panelLeft = Math.max(MARGIN, Math.min(pos.x, window.innerWidth - 330 - MARGIN));
  const panelBottom = Math.max(MARGIN, window.innerHeight - (pos.y + FAB_H));

  return (
    <div className="feedback-panel" role="dialog" aria-label="Submit feedback"
         style={{ left: panelLeft, bottom: panelBottom, right: 'auto', top: 'auto' }}>
      <div className="feedback-panel-head">
        <strong>Submit a bug or suggestion</strong>
        <button className="feedback-close" onClick={() => setOpen(false)} aria-label="Close">
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
              ? 'What went wrong, and what were you doing when it happened?'
              : 'What would make this better?'}
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={4}
            autoFocus
          />
          {error && <div className="feedback-error">{error}</div>}
          <div className="feedback-actions">
            <span className="feedback-hint">Sent with your account and current page.</span>
            <button className="btn btn-sm" disabled={!message.trim() || sending} onClick={submit}>
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
