import { useRef, useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Send, Mic, MicOff, AlertCircle, Trash2 } from 'lucide-react';
import { assistant } from '../lib/api';
import type { AssistantChart as ChartSpec, AiUsage, CatalogAiAction } from '../lib/api';
import AssistantChart from '../components/AssistantChart';
import { useAssistantActions, describeActions } from '../lib/useAssistantActions';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  charts?: ChartSpec[];
  chips?: string[];
  usage?: AiUsage;
  error?: boolean;
}

type SpeechRec = { lang: string; interimResults: boolean; continuous: boolean;
  start: () => void; stop: () => void; onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null; onend: (() => void) | null };
function getSpeechRecognition(): (new () => SpeechRec) | null {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

const fmtCost = (usd: number) => (usd === 0 ? '$0.00' : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`);
const modelLabel = (m?: string | null): string => {
  if (!m) return '';
  const s = m.toLowerCase();
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('opus')) return 'Opus';
  return m;
};

const SUGGESTIONS = [
  'Break down the catalog by category with a chart',
  'Which distributor has the most products with a RIP rebate?',
  'Show the price history of Caymus Cabernet',
  'Add 2 cases of the cheapest prosecco to my cart',
];

export default function CelarAssistant() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const { runActions } = useAssistantActions();
  const listRef = useRef<HTMLDivElement>(null);

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
    const history = messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.text }));
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await assistant.ask(q, history);
      const chips = describeActions(res.actions as CatalogAiAction[]);
      setMessages(m => [...m, { role: 'assistant', text: res.answer, charts: res.charts, chips, usage: res.usage }]);
      if (res.actions?.length) runActions(res.actions);
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', error: true, text: `Sorry — that request failed (${e instanceof Error ? e.message : 'unknown error'}).` }]);
    } finally {
      setBusy(false);
    }
  };

  // ---- Voice ----
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recogRef = useRef<SpeechRec | null>(null);
  const transcriptRef = useRef('');
  const voiceSupported = !!getSpeechRecognition();
  const toggleVoice = () => {
    if (busy) return;
    const SR = getSpeechRecognition();
    if (!SR) { setVoiceError('Voice input needs Chrome or Edge.'); return; }
    if (listening) { try { recogRef.current?.stop(); } catch { /* */ } return; }
    setVoiceError(null); transcriptRef.current = '';
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e: any) => {
      let f = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) f += t; else interim += t;
      }
      transcriptRef.current = (f || interim).trim();
      setInput(transcriptRef.current);
    };
    rec.onerror = (e: any) => {
      const err = e?.error || '';
      setVoiceError(err === 'not-allowed' || err === 'service-not-allowed'
        ? 'Microphone blocked. Allow mic permission for this site, then try again.'
        : err === 'no-speech' ? "Didn't catch that — tap the mic and speak again." : 'Voice input failed.');
      setListening(false);
    };
    rec.onend = () => { setListening(false); const t = transcriptRef.current.trim(); if (t) ask(t); };
    recogRef.current = rec; setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  return (
    <div className="celar-page">
      <header className="celar-head">
        <div className="celar-head-title">
          <span className="celar-spark"><Sparkles size={18} /></span>
          <div>
            <h2>Celar AI Assistant</h2>
            <p>Ask about your catalog — pricing, deals, distributors. Answers come with charts and can take actions.</p>
          </div>
        </div>
        <div className="celar-head-right">
          <span className="celar-session" title="Tokens and estimated cost this conversation">
            {(totalIn + totalOut).toLocaleString()} tokens · <strong>{fmtCost(totalCost)}</strong>
          </span>
          {messages.length > 0 && (
            <button className="btn btn-sm btn-secondary" onClick={() => setMessages([])}>
              <Trash2 size={14} /> New chat
            </button>
          )}
        </div>
      </header>

      <div className="celar-thread" ref={listRef}>
        {messages.length === 0 && (
          <div className="celar-empty">
            <div className="celar-empty-icon"><Sparkles size={28} /></div>
            <h3>How can I help?</h3>
            <p>Ask in plain English or use the mic. I’ll answer with formatted text, charts, and can add to your cart, favorites or lists.</p>
            <div className="celar-suggestions">
              {SUGGESTIONS.map(s => (
                <button key={s} className="celar-suggestion" onClick={() => ask(s)} disabled={busy}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`celar-msg celar-msg-${m.role}${m.error ? ' celar-msg-error' : ''}`}>
            <div className="celar-avatar" aria-hidden="true">
              {m.role === 'assistant' ? (m.error ? <AlertCircle size={15} /> : <Sparkles size={14} />) : 'You'}
            </div>
            <div className="celar-bubble">
              {m.role === 'assistant'
                ? <div className="celar-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown></div>
                : <div className="celar-usertext">{m.text}</div>}
              {m.charts?.map((c, ci) => <AssistantChart key={ci} spec={c} />)}
              {m.chips && m.chips.length > 0 && (
                <div className="celar-chips">{m.chips.map((c, ci) => <span key={ci} className="ai-chip">{c}</span>)}</div>
              )}
              {m.usage && (
                <div className="celar-usage" title={`Model: ${m.usage.model}`}>
                  {m.usage.enabled
                    ? <>↑ {m.usage.input_tokens.toLocaleString()} · ↓ {m.usage.output_tokens.toLocaleString()} · <strong>{fmtCost(m.usage.cost_usd)}</strong> · <span className="ai-model-chip">{modelLabel(m.usage.model)}</span></>
                    : <>assistant offline · $0.00</>}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="celar-msg celar-msg-assistant">
            <div className="celar-avatar"><Sparkles size={14} /></div>
            <div className="celar-bubble"><div className="ai-typing"><span /><span /><span /></div></div>
          </div>
        )}
      </div>

      <div className="celar-composer-wrap">
        {(() => {
          const qCount = messages.filter(m => m.role === 'user').length;
          return qCount > 0 && qCount % 4 === 0 ? (
            <div className="celar-pro-nudge">
              💡 For store-specific answers — your real sell-through, on-hand stock and suggested order
              quantities — turn on <strong>Pro</strong>. Mention it in your question for tailored buying guidance.
            </div>
          ) : null;
        })()}
        {voiceError && !listening && <div className="celar-voice-error">{voiceError}</div>}
        {listening && <div className="celar-listening">● Listening… speak now</div>}
        <form className="celar-composer" onSubmit={e => { e.preventDefault(); ask(input); }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
            placeholder={listening ? 'Listening…' : 'Message Celar AI Assistant…'}
            rows={1}
            disabled={busy}
          />
          {voiceSupported && (
            <button type="button" className={`celar-mic${listening ? ' is-listening' : ''}`} onClick={toggleVoice} disabled={busy}
                    aria-label={listening ? 'Stop voice' : 'Voice input'} title={listening ? 'Stop' : 'Speak'}>
              {listening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          <button type="submit" className="celar-send" disabled={busy || !input.trim()} aria-label="Send"><Send size={18} /></button>
        </form>
        <p className="celar-disclaimer">Answers use your live catalog data. Cost is shown per message.</p>
      </div>
    </div>
  );
}
