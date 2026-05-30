import { useRef, useState, useEffect } from 'react';
import { Sparkles, Send, AlertCircle } from 'lucide-react';
import type { AiUsage } from '../lib/api';

// Any AI answer the panel can render must carry a human-readable `answer` and
// token/cost `usage`. Everything page-specific (e.g. catalog filters) rides
// along on the same object and is handled by the page via `onApply`.
export interface AiAnswerBase {
  answer: string;
  usage: AiUsage;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  usage?: AiUsage;
  error?: boolean;
}

interface Props<R extends AiAnswerBase> {
  /** How to get an answer for a question. Page supplies its own endpoint. */
  send: (question: string) => Promise<R>;
  /** Apply the structured answer to the page (filter the screen, etc.). */
  onApply?: (result: R) => void;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  /** Example prompts shown before the first message. */
  suggestions?: string[];
}

const fmtCost = (usd: number) =>
  usd === 0 ? '$0.00' : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`;

/**
 * Reusable AI chat assistant panel. Page-agnostic: drop it onto any screen,
 * give it a `send` function (its backend) and an `onApply` callback (what to do
 * with the answer). It owns the conversation UI, the loading state, and the
 * per-message + running token/cost accounting.
 */
export default function AiAssistantPanel<R extends AiAnswerBase>({
  send, onApply, title = 'AI Assistant', subtitle, placeholder = 'Ask a question…', suggestions = [],
}: Props<R>) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Running session totals across every answer in this panel.
  const totalIn = messages.reduce((s, m) => s + (m.usage?.input_tokens ?? 0), 0);
  const totalOut = messages.reduce((s, m) => s + (m.usage?.output_tokens ?? 0), 0);
  const totalCost = messages.reduce((s, m) => s + (m.usage?.cost_usd ?? 0), 0);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await send(q);
      setMessages(m => [...m, { role: 'assistant', text: res.answer, usage: res.usage }]);
      onApply?.(res);
    } catch (e) {
      setMessages(m => [...m, {
        role: 'assistant', error: true,
        text: `Sorry — that request failed (${e instanceof Error ? e.message : 'unknown error'}).`,
      }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ai-assistant-panel" aria-label={title}>
      <div className="ai-assistant-head">
        <div className="ai-assistant-title">
          <Sparkles size={16} /> <span>{title}</span>
        </div>
        {subtitle && <div className="ai-assistant-subtitle">{subtitle}</div>}
        <div className="ai-assistant-totals" title="Tokens and estimated cost spent in this conversation">
          Session: {(totalIn + totalOut).toLocaleString()} tokens · {fmtCost(totalCost)}
        </div>
      </div>

      <div className="ai-assistant-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-assistant-empty">
            <p>Ask in plain English and I’ll change the screen to match.</p>
            {suggestions.length > 0 && (
              <div className="ai-assistant-suggestions">
                {suggestions.map(s => (
                  <button key={s} type="button" className="ai-assistant-suggestion"
                          onClick={() => ask(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ai-msg-${m.role}${m.error ? ' ai-msg-error' : ''}`}>
            {m.error && <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />}
            <div className="ai-msg-body">
              <div className="ai-msg-text">{m.text}</div>
              {m.usage && (
                <div className="ai-msg-usage" title={`Model: ${m.usage.model}`}>
                  {m.usage.enabled
                    ? <>↑ {m.usage.input_tokens.toLocaleString()} in · ↓ {m.usage.output_tokens.toLocaleString()} out · <strong>{fmtCost(m.usage.cost_usd)}</strong></>
                    : <>keyword fallback · no tokens · $0.00</>}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="ai-msg ai-msg-assistant">
            <div className="ai-msg-body"><div className="ai-typing"><span /><span /><span /></div></div>
          </div>
        )}
      </div>

      <form className="ai-assistant-input" onSubmit={e => { e.preventDefault(); ask(input); }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder={placeholder}
          rows={2}
          disabled={busy}
        />
        <button type="submit" className="btn btn-sm" disabled={busy || !input.trim()} aria-label="Send">
          <Send size={15} />
        </button>
      </form>
    </aside>
  );
}
