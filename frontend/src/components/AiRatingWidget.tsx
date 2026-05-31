import { useState, useEffect, useRef } from 'react';
import { ThumbsUp, ThumbsDown, Check, X } from 'lucide-react';
import { aiFeedback } from '../lib/api';

interface Props {
  /** Which assistant surface ("celar", "global-dock", "catalog", ...). */
  surface: string;
  /** The user's question that produced this answer (best-effort, optional). */
  question?: string;
  /** The assistant's reply text (markdown is fine, stored as-is). */
  answer: string;
  /** Model id from usage, for the admin rollup. */
  model?: string | null;
  /** Page the user was on when they rated. Defaults to window.location.pathname. */
  page?: string;
}

/**
 * Per-reply rating: thumbs-up logs "good" immediately. Thumbs-down opens a
 * small popup asking what went wrong and submits both rating + details once
 * the user clicks Send. The choice persists for the lifetime of this widget;
 * an already-rated reply shows a quiet "Thanks" line.
 */
export default function AiRatingWidget({ surface, question, answer, model, page }: Props) {
  const [rated, setRated] = useState<null | 'good' | 'bad'>(null);
  const [badOpen, setBadOpen] = useState(false);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pageNow = page ?? (typeof window !== 'undefined' ? window.location.pathname : undefined);

  // Focus the textarea when the popup opens; close on Esc / outside click.
  useEffect(() => {
    if (!badOpen) return;
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBadOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setBadOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [badOpen]);

  const submit = async (rating: 'good' | 'bad', detailsText?: string) => {
    setSending(true); setError(null);
    try {
      await aiFeedback.submit({
        surface, rating, question, answer,
        details: detailsText, page: pageNow,
        model: model ?? undefined,
      });
      setRated(rating);
      if (rating === 'bad') { setBadOpen(false); setDetails(''); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save rating');
    } finally {
      setSending(false);
    }
  };

  if (rated === 'good') {
    return <div className="ai-rate ai-rate-done"><Check size={12} /> Thanks for the feedback</div>;
  }
  if (rated === 'bad') {
    return <div className="ai-rate ai-rate-done"><Check size={12} /> Thanks, we'll use this to improve</div>;
  }

  return (
    <div className="ai-rate">
      <span className="ai-rate-label">Was this helpful?</span>
      <button type="button" className="ai-rate-btn" title="Good answer"
              aria-label="Rate this answer good"
              onClick={() => submit('good')} disabled={sending}>
        <ThumbsUp size={13} />
      </button>
      <button type="button" className="ai-rate-btn ai-rate-btn-bad" title="Needs work"
              aria-label="Rate this answer bad"
              onClick={() => { setBadOpen(true); setError(null); }} disabled={sending}>
        <ThumbsDown size={13} />
      </button>
      {error && <span className="ai-rate-error">{error}</span>}

      {badOpen && (
        <div className="ai-rate-popup" ref={popupRef} role="dialog" aria-label="Tell us what went wrong">
          <div className="ai-rate-popup-head">
            <strong>What was wrong with this answer?</strong>
            <button type="button" className="ai-rate-popup-close" aria-label="Close" onClick={() => setBadOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={details}
            onChange={e => setDetails(e.target.value)}
            placeholder="Wrong number, missing context, off-topic, slow... anything you'd flag."
            rows={3}
            maxLength={2000}
          />
          <div className="ai-rate-popup-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setBadOpen(false)} disabled={sending}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary"
                    onClick={() => submit('bad', details.trim() || undefined)} disabled={sending}>
              {sending ? 'Sending...' : 'Send feedback'}
            </button>
          </div>
          {error && <div className="ai-rate-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
