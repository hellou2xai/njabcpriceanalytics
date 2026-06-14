import { useRef, useState, useEffect, useCallback } from 'react';
import { Sparkles, Send, AlertCircle, X, PanelRightOpen, Trash2, Mic, MicOff } from 'lucide-react';
import type { AiUsage } from '../lib/api';
import AiRatingWidget from './AiRatingWidget';

// Minimal typing for the Web Speech API (not in lib.dom for all targets).
type SpeechRec = { lang: string; interimResults: boolean; continuous: boolean;
  start: () => void; stop: () => void; onresult: ((e: any) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null };
function getSpeechRecognition(): (new () => SpeechRec) | null {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

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
  chips?: string[];
  error?: boolean;
}

interface Props<R extends AiAnswerBase> {
  /** How to get an answer. Receives the question and prior turns (for memory). */
  send: (question: string, history: { role: 'user' | 'assistant'; content: string }[]) => Promise<R>;
  /** Apply the structured answer to the page (filter the screen, etc.). */
  onApply?: (result: R) => void;
  /** Optional: short labels describing what the answer applied, shown as chips. */
  describeResult?: (result: R) => string[];
  title?: string;
  subtitle?: string;
  placeholder?: string;
  /** Example prompts shown before the first message. */
  suggestions?: string[];
  /** Show the collapse control + remember open/closed state. Default true. */
  collapsible?: boolean;
  /** localStorage namespace for the open/closed preference. */
  storageKey?: string;
  /** Controlled open state. When provided, the parent owns show/hide (e.g. to
   *  coordinate a resize splitter); otherwise the panel manages it internally. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Surface tag for AI rating logging (e.g. 'catalog'). */
  ratingSurface?: string;
}

const fmtCost = (usd: number) =>
  usd === 0 ? '$0.00' : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`;

// Short, friendly model name for the per-answer cost line.
export const modelLabel = (m?: string | null): string => {
  if (!m) return '';
  const s = m.toLowerCase();
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('opus')) return 'Opus';
  return m;
};

/**
 * Reusable AI chat assistant panel. Page-agnostic: drop it onto any screen,
 * give it a `send` function (its backend) and an `onApply` callback (what to do
 * with the answer). It owns the conversation UI, collapse/expand, the loading
 * state, and the per-message + running token/cost accounting.
 */
export default function AiAssistantPanel<R extends AiAnswerBase>({
  send, onApply, describeResult,
  title = 'AI Assistant', subtitle, placeholder = 'Ask a question…', suggestions = [],
  collapsible = true, storageKey = 'ai_assistant', open: openProp, onOpenChange,
  ratingSurface,
}: Props<R>) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [internalOpen, setInternalOpen] = useState<boolean>(() => {
    if (!collapsible) return true;
    return localStorage.getItem(`${storageKey}_open`) !== 'false';
  });
  const isControlled = openProp !== undefined;
  const open = isControlled ? !!openProp : internalOpen;
  const listRef = useRef<HTMLDivElement>(null);

  const setOpenPersist = useCallback((v: boolean) => {
    if (isControlled) { onOpenChange?.(v); return; }   // parent owns the state
    setInternalOpen(v);
    try { localStorage.setItem(`${storageKey}_open`, String(v)); } catch { /* quota */ }
  }, [isControlled, onOpenChange, storageKey]);

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
    // Build conversation history from prior turns so the assistant remembers
    // context (memory). Errors are excluded; capped to recent turns server-side.
    const history = messages
      .filter(m => !m.error)
      .map(m => ({ role: m.role, content: m.text }));
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await send(q, history);
      const chips = describeResult?.(res) ?? [];
      setMessages(m => [...m, { role: 'assistant', text: res.answer, usage: res.usage, chips }]);
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

  // ---- Voice input (Web Speech API). Mic hidden when unsupported. ----
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recogRef = useRef<SpeechRec | null>(null);
  const transcriptRef = useRef('');   // accumulate across result events
  const voiceSupported = !!getSpeechRecognition();

  const toggleVoice = () => {
    if (busy) return;
    const SR = getSpeechRecognition();
    if (!SR) { setVoiceError('Voice input is not supported in this browser. Try Chrome or Edge.'); return; }
    if (listening) { try { recogRef.current?.stop(); } catch { /* */ } return; }
    setVoiceError(null);
    transcriptRef.current = '';
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e: any) => {
      let finalText = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      transcriptRef.current = (finalText || interim).trim();
      setInput(transcriptRef.current);
    };
    rec.onerror = (e: any) => {
      const err = e?.error || '';
      setVoiceError(
        err === 'not-allowed' || err === 'service-not-allowed'
          ? 'Microphone access is blocked. Allow mic permission for this site (address-bar icon), then try again.'
          : err === 'no-speech' ? "Didn't catch that — tap the mic and speak again."
          : err === 'audio-capture' ? 'No microphone found.'
          : 'Voice input failed. Please type instead.'
      );
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      const t = transcriptRef.current.trim();
      if (t) ask(t);   // hands-free: speak, then auto-send
    };
    recogRef.current = rec;
    setListening(true);
    try { rec.start(); }
    catch { setListening(false); setVoiceError('Could not start voice input. Please type instead.'); }
  };

  // Collapsed: a slim, sticky rail that re-opens the panel.
  if (collapsible && !open) {
    return (
      <button className="ai-assistant-rail" onClick={() => setOpenPersist(true)}
              aria-label={`Open ${title}`} title={`Open ${title}`}>
        <PanelRightOpen size={18} />
        <span className="ai-assistant-rail-label"><Sparkles size={13} /> {title}</span>
      </button>
    );
  }

  return (
    <aside className="ai-assistant-panel" aria-label={title}>
      <div className="ai-assistant-head">
        <div className="ai-assistant-head-top">
          <div className="ai-assistant-title">
            <span className="ai-assistant-spark"><Sparkles size={15} /></span>
            <span>{title}</span>
          </div>
          <div className="ai-assistant-actions">
            {messages.length > 0 && (
              <button type="button" className="ai-assistant-iconbtn ai-assistant-clearchat" title="Clear chat"
                      aria-label="Clear chat" onClick={() => setMessages([])}>
                <Trash2 size={14} /> Clear chat
              </button>
            )}
            {collapsible && (
              <button type="button" className="ai-assistant-iconbtn" title="Close assistant"
                      aria-label="Close assistant" onClick={() => setOpenPersist(false)}>
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        {subtitle && <div className="ai-assistant-subtitle">{subtitle}</div>}
        <div className="ai-assistant-totals" title="Tokens and estimated cost spent in this conversation">
          <span className="ai-assistant-totals-dot" /> {(totalIn + totalOut).toLocaleString()} tokens · {fmtCost(totalCost)} this session
        </div>
      </div>

      <div className="ai-assistant-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-assistant-empty">
            <div className="ai-assistant-empty-icon"><Sparkles size={22} /></div>
            <p className="ai-assistant-empty-lead">Ask in plain English</p>
            <p className="ai-assistant-empty-sub">I’ll update the screen to match your question.</p>
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
            {m.role === 'assistant' && (
              <span className="ai-msg-avatar" aria-hidden="true">
                {m.error ? <AlertCircle size={14} /> : <Sparkles size={13} />}
              </span>
            )}
            <div className="ai-msg-body">
              <div className="ai-msg-text">{m.text}</div>
              {m.chips && m.chips.length > 0 && (
                <div className="ai-msg-chips">
                  {m.chips.map((c, ci) => <span key={ci} className="ai-chip">{c}</span>)}
                </div>
              )}
              {m.usage && (
                <div className="ai-msg-usage" title={`Model: ${m.usage.model}`}>
                  {m.usage.enabled
                    ? <>↑ {m.usage.input_tokens.toLocaleString()} · ↓ {m.usage.output_tokens.toLocaleString()} · <strong>{fmtCost(m.usage.cost_usd)}</strong> · <span className="ai-model-chip">{modelLabel(m.usage.model)}</span></>
                    : <>keyword fallback · no tokens · $0.00</>}
                </div>
              )}
              {m.role === 'assistant' && !m.error && (
                <AiRatingWidget
                  surface={ratingSurface ?? (storageKey || 'panel')}
                  question={i > 0 && messages[i - 1]?.role === 'user' ? messages[i - 1].text : undefined}
                  answer={m.text}
                  model={m.usage?.model}
                />
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="ai-msg ai-msg-assistant">
            <span className="ai-msg-avatar" aria-hidden="true"><Sparkles size={13} /></span>
            <div className="ai-msg-body"><div className="ai-typing"><span /><span /><span /></div></div>
          </div>
        )}
      </div>

      {(() => {
        const qCount = messages.filter(m => m.role === 'user').length;
        return qCount > 0 && qCount % 4 === 0 ? (
          <div className="ai-pro-nudge">
            💡 For store-specific answers — your real sell-through, on-hand stock and suggested order
            quantities — turn on <strong>Pro</strong>. Add it to your question for tailored buying guidance.
          </div>
        ) : null;
      })()}
      {listening && <div className="ai-assistant-listening">● Listening… speak now</div>}
      {voiceError && !listening && <div className="ai-assistant-voice-error">{voiceError}</div>}
      <form className="ai-assistant-input" onSubmit={e => { e.preventDefault(); ask(input); }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder={listening ? 'Listening…' : placeholder}
          rows={1}
          disabled={busy}
        />
        {voiceSupported && (
          <button type="button" className={`ai-assistant-mic${listening ? ' is-listening' : ''}`}
                  onClick={toggleVoice} disabled={busy}
                  aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                  title={listening ? 'Stop voice input' : 'Speak your request'}>
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        <button type="submit" className="ai-assistant-send" disabled={busy || !input.trim()} aria-label="Send" title="Send">
          <Send size={16} />
        </button>
      </form>
    </aside>
  );
}
