import { useState } from 'react';
import { MessageSquarePlus, X, Bug, Lightbulb } from 'lucide-react';
import { feedback } from '../lib/api';

// Small, non-intrusive "BETA" sticker. pointer-events:none so it never blocks
// anything underneath it.
export function BetaBadge() {
  return <div className="beta-badge" title="This app is in beta">BETA</div>;
}

// Floating "Feedback" button on every page. The user types a note; their
// account, the current page, and the browser are attached automatically.
export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'bug' | 'idea'>('bug');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!open) {
    return (
      <button className="feedback-fab" onClick={() => setOpen(true)}
              title="Submit a bug or improvement suggestion">
        <MessageSquarePlus size={18} />
        <span>Feedback</span>
      </button>
    );
  }

  return (
    <div className="feedback-panel" role="dialog" aria-label="Submit feedback">
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
