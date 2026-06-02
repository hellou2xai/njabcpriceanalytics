import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Send, Mic, MicOff, AlertCircle, Trash2, PanelRightClose, ShoppingCart, Check, ExternalLink } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { assistant, cart as cartApi } from '../lib/api';
import type { AssistantChart as ChartSpec, AiUsage, CatalogAiAction, CatalogAiProduct, AssistantRipCluster } from '../lib/api';
import { useProductQuickView } from './ProductQuickView';
import AssistantChart from './AssistantChart';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import FavoriteButton from './FavoriteButton';
import AiRatingWidget from './AiRatingWidget';
import AssistantComparisonTable from './AssistantComparisonTable';
import { distributorName } from '../lib/distributors';
import { useAssistantActions, describeActions } from '../lib/useAssistantActions';
import { useResultCount } from '../lib/resultCount';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  charts?: ChartSpec[];
  products?: CatalogAiProduct[];
  // Per-cluster "Add Case Mix to Cart" buttons rendered above the markdown
  // answer. Empty / absent means the assistant didn't touch any RIP this turn.
  ripClusters?: AssistantRipCluster[];
  chips?: string[];
  usage?: AiUsage;
  error?: boolean;
  // When the assistant drove the screen, we wait for the page to report how many
  // rows matched and then splice that exact count into the message text.
  awaitingCount?: boolean;
  screenBase?: string;   // pathname (no query) the count must belong to
  navTs?: number;        // when we navigated; ignore counts reported before this
  // Surfaced on standalone Assistant page: the chat stays put and renders a
  // hyperlink the user clicks to open the result on the target page.
  screenPath?: string;
  screenLabel?: string;
}

const CONVOS_KEY = 'celar_convos_v1';

const money = (v?: number | null) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const fmtCost = (usd: number) => (usd === 0 ? '$0.00' : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`);
const modelLabel = (m?: string | null): string => {
  if (!m) return '';
  const s = m.toLowerCase();
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('opus')) return 'Opus';
  return m;
};

type SpeechRec = { lang: string; interimResults: boolean; continuous: boolean;
  start: () => void; stop: () => void; onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null; onend: (() => void) | null };
function getSpeechRecognition(): (new () => SpeechRec) | null {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

// No prepopulated prompts by default — the empty state shows a generic
// capabilities message instead. Per-screen suggestion chips can be passed in
// later via the `suggestions` prop.
const DEFAULT_SUGGESTIONS: string[] = [];

interface Props {
  subtitle?: string;
  suggestions?: string[];
  /** When provided, a close button shows in the header (docked side panel). */
  onClose?: () => void;
  /** Current screen label, sent so the assistant prioritizes relevant tools. */
  pageContext?: string;
  /** Current screen route, so a UPC filters this page in place (not Catalog). */
  pagePath?: string;
  /** Current grid query string (e.g. "?region=california"), so a follow-up
   *  question composes filters instead of dropping the prior scope. */
  pageQuery?: string;
}

/**
 * The full Celar conversation: markdown answers, charts, actionable product
 * cards, voice, multi-turn memory, per-answer model + cost. Shared by the
 * dedicated page and the dockable side panel so formatting is identical.
 */
export default function AssistantChat({ subtitle, suggestions = DEFAULT_SUGGESTIONS, onClose, pageContext, pagePath, pageQuery }: Props) {
  // Per-page chat memory: keep a SEPARATE conversation per screen, keyed by the
  // page path (falls back to the label / 'global'). Switching pages shows that
  // page's own thread, and the history sent to the model is that page's only.
  const pageKey = pagePath || pageContext || 'global';
  // Standalone Ask page (no grid beside the chat) → product results render as the
  // rich interactive table (clickable name → modal + this→next sparkline).
  const isStandalone = !pagePath;
  // Persist conversations to localStorage so the thread survives the user
  // clicking through to a results page and back. Hydrate lazily on mount.
  const [convos, setConvos] = useState<Record<string, Msg[]>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(CONVOS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, Msg[]>) : {};
    } catch { return {}; }
  });
  // Persist on every change. Quick-and-dirty: localStorage call is synchronous
  // but the messages array is small (per-page transcripts), so it's fine.
  useEffect(() => {
    try { window.localStorage.setItem(CONVOS_KEY, JSON.stringify(convos)); }
    catch { /* quota or private mode — silently drop */ }
  }, [convos]);
  const messages = convos[pageKey] ?? [];
  const setMessages = useCallback((u: Msg[] | ((prev: Msg[]) => Msg[])) => {
    setConvos(c => ({ ...c, [pageKey]: typeof u === 'function' ? (u as (p: Msg[]) => Msg[])(c[pageKey] ?? []) : u }));
  }, [pageKey]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const { runActions } = useAssistantActions();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const { value: resultCount } = useResultCount();
  const { open: openQuickView } = useProductQuickView();
  // Override ReactMarkdown's <a> so links of the form
  //   quickview://{wholesaler}/{upc}?n={name}&v={volume}
  // open the product modal in-place instead of navigating away. Backend's RIP
  // template emits one of these per row in the Full Case Mix table.
  const mdComponents = useMemo(() => ({
    a: (props: { href?: string; children?: React.ReactNode }) => {
      const href = props.href ?? '';
      if (href.startsWith('quickview://')) {
        return (
          <a
            href="#"
            className="celar-md-quickview"
            onClick={e => {
              e.preventDefault();
              try {
                const u = new URL(href);
                const ws = decodeURIComponent(u.hostname || '');
                const upc = decodeURIComponent((u.pathname || '/').slice(1));
                const name = u.searchParams.get('n') ?? '';
                const vol = u.searchParams.get('v') ?? undefined;
                if (ws && name) {
                  openQuickView(name, ws, undefined, {
                    upc: upc || undefined, unitVolume: vol,
                  });
                }
              } catch { /* malformed quickview URL — ignore */ }
            }}
          >{props.children}</a>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer">{props.children}</a>;
    },
  }), [openQuickView]);

  const totalIn = messages.reduce((s, m) => s + (m.usage?.input_tokens ?? 0), 0);
  const totalOut = messages.reduce((s, m) => s + (m.usage?.output_tokens ?? 0), 0);
  const totalCost = messages.reduce((s, m) => s + (m.usage?.cost_usd ?? 0), 0);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // When the page the assistant drove reports its matched-row count, splice the
  // exact count into the confirmation message (so the chat and the grid always
  // agree). Only patches a message still awaiting a count whose screen matches
  // the report and whose navigation happened before the report.
  useEffect(() => {
    if (!resultCount) return;
    setMessages(prev => {
      let changed = false;
      const next = prev.map(m => {
        if (m.awaitingCount && m.screenBase === resultCount.path
            && resultCount.ts >= (m.navTs ?? 0)) {
          changed = true;
          const n = resultCount.count.toLocaleString();
          return { ...m, awaitingCount: false, text: `${m.text}\n\n**${n} result${resultCount.count === 1 ? '' : 's'} shown.**` };
        }
        return m;
      });
      return changed ? next : prev;
    });
  }, [resultCount, setMessages]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    const history = messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.text }));
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await assistant.ask(q, history, pageContext, pagePath, pageQuery);
      const chips = describeActions(res.actions as CatalogAiAction[]);
      const drove = !!res.screen?.path;
      const screenBase = drove ? res.screen!.path.split('?')[0] : undefined;
      // Standalone (dedicated /celar page) = no pagePath. There we DO NOT
      // auto-navigate; we keep the user in the chat and surface a hyperlink
      // on the message that opens the filtered target page when clicked.
      // The docked side panel keeps its in-place behaviour (auto-navigate,
      // which on that mode is a same-page URL filter swap).
      const isStandalone = !pagePath;
      // On standalone, keep the charts + product cards so the user sees the
      // actual data on /celar (there's no grid alongside). Docked mode keeps
      // the lean one-line confirmation since the page itself shows the data.
      setMessages(m => [...m, {
        role: 'assistant', text: res.answer,
        charts: drove && !isStandalone ? [] : res.charts,
        products: drove && !isStandalone ? [] : res.products,
        ripClusters: drove && !isStandalone ? [] : (res.rip_clusters ?? []),
        chips, usage: res.usage,
        // awaitingCount needs an actual navigation to fire — only set in the
        // docked case where we do navigate.
        awaitingCount: drove && !isStandalone,
        screenBase,
        navTs: drove && !isStandalone ? Date.now() : undefined,
        screenPath: drove ? res.screen!.path : undefined,
        screenLabel: drove ? res.screen!.label : undefined,
      }]);
      if (drove && !isStandalone) navigate(res.screen!.path);
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
      if (err === 'aborted') { setListening(false); return; }  // user/restart — not an error
      setVoiceError(
        err === 'not-allowed' || err === 'service-not-allowed'
          ? 'Microphone is blocked. Click the address-bar mic/site icon, allow the microphone for this site, then try again.'
          : err === 'no-speech' ? "Didn't catch that — tap the mic and speak again."
          : err === 'audio-capture' ? 'No microphone detected. Check your mic, then try again.'
          : err === 'network' ? 'Voice recognition needs an internet connection — check your network and retry.'
          : err === 'language-not-supported' ? 'This browser build does not support the speech language.'
          : `Voice input unavailable (${err || 'unknown'}). You can type instead.`
      );
      setListening(false);
    };
    rec.onend = () => { setListening(false); const t = transcriptRef.current.trim(); if (t) ask(t); };
    recogRef.current = rec; setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  const qCount = messages.filter(m => m.role === 'user').length;

  return (
    <div className="assistant-chat">
      <header className="celar-head">
        <div className="celar-head-title">
          <span className="celar-spark"><Sparkles size={18} /></span>
          <div>
            <h2>Celar AI Assistant</h2>
            <p>{subtitle ?? 'Ask about your catalog — pricing, deals, distributors. Answers come with charts and can take actions.'}</p>
          </div>
        </div>
        <div className="celar-head-right">
          <span className="celar-session" title="Tokens and estimated cost this conversation">
            {(totalIn + totalOut).toLocaleString()} tokens · <strong>{fmtCost(totalCost)}</strong>
          </span>
          {messages.length > 0 && (
            <button className="celar-head-btn celar-clear-chat" title="Clear chat"
                    aria-label="Clear chat" onClick={() => setMessages([])}>
              <Trash2 size={14} /> Clear chat
            </button>
          )}
          {onClose && (
            <button className="celar-head-btn" title="Hide assistant" aria-label="Hide assistant" onClick={onClose}>
              <PanelRightClose size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="celar-thread" ref={listRef}>
        {messages.length === 0 && (
          <div className="celar-empty">
            <div className="celar-empty-icon"><Sparkles size={28} /></div>
            <h3>How can I help?</h3>
            <p>
              I work with your catalog pricing data. I can search and filter products, compare prices
              across distributors, break down discounts and RIP rebates, surface deals and price trends,
              and act on results — add to cart, favorites or lists. Ask in plain English, or use the mic.
            </p>
            {suggestions.length > 0 && (
              <div className="celar-suggestions">
                {suggestions.map(s => (
                  <button key={s} className="celar-suggestion" onClick={() => ask(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`celar-msg celar-msg-${m.role}${m.error ? ' celar-msg-error' : ''}`}>
            <div className="celar-avatar" aria-hidden="true">
              {m.role === 'assistant' ? (m.error ? <AlertCircle size={15} /> : <Sparkles size={14} />) : 'You'}
            </div>
            <div className="celar-bubble">
              {m.role === 'assistant'
                ? <div className="celar-md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text}</ReactMarkdown></div>
                : <div className="celar-usertext">{m.text}</div>}
              {m.role === 'assistant' && m.ripClusters && m.ripClusters.length > 0 && (
                <RipClusterActions clusters={m.ripClusters} />
              )}
              {m.charts?.map((c, ci) => <AssistantChart key={ci} spec={c} />)}
              {m.products && m.products.length > 0 && (isStandalone || m.products.length >= 3) ? (
                // Rich decision-pack comparison table (product, distributor, size,
                // vintage, list /cs, eff /cs, savings %, every CPL + RIP tier, row
                // actions). On the standalone Ask page it ALSO gets clickable
                // product names (→ Product Modal) and a this→next pricing
                // sparkline per row, and is used for ANY product list (not just
                // 3+). The Catalog deep-link below is suppressed (table has its own).
                <AssistantComparisonTable
                  products={m.products}
                  screenPath={m.screenPath}
                  screenLabel={m.screenLabel}
                  standalone={isStandalone}
                />
              ) : m.products && m.products.length > 0 ? (
                <div className="celar-products">
                  {m.products.map((p, pi) => (
                    <div key={pi} className="celar-product-card">
                      <div className="celar-product-main">
                        <div className="celar-product-name">{p.product_name}</div>
                        <div className="celar-product-sub">
                          {[p.unit_volume, distributorName(p.wholesaler), p.vintage && p.vintage !== '0' ? `Vintage ${p.vintage}` : null]
                            .filter(Boolean).join(' · ')}
                        </div>
                        <div className="celar-product-price">
                          <strong>{money(p.effective_case_price ?? p.frontline_case_price)}</strong>/cs
                          {p.frontline_case_price != null && p.effective_case_price != null && p.effective_case_price < p.frontline_case_price && (
                            <span className="celar-product-was">{money(p.frontline_case_price)}</span>
                          )}
                        </div>
                      </div>
                      <div className="celar-product-actions">
                        <FavoriteButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
                        <AddToCartButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} qtyCases={1} qtyUnits={0} />
                        <AddToListButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {/* 1–2 product results still get the legacy single-link footer.
                  The 3+ branch above renders its own footer inside the table. */}
              {m.screenPath && !(m.products && m.products.length > 0 && (isStandalone || m.products.length >= 3)) && (
                <div className="celar-screen-link">
                  <Link to={m.screenPath} className="celar-screen-link-btn">
                    Open {m.screenLabel || 'result'} →
                  </Link>
                </div>
              )}
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
              {m.role === 'assistant' && !m.error && (
                <AiRatingWidget
                  surface={pagePath ? 'global-dock' : 'celar'}
                  question={i > 0 && messages[i - 1]?.role === 'user' ? messages[i - 1].text : undefined}
                  answer={m.text}
                  model={m.usage?.model}
                  page={pagePath}
                />
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
        {qCount > 0 && qCount % 4 === 0 && (
          <div className="celar-pro-nudge">
            💡 For store-specific answers — your real sell-through, on-hand stock and suggested order
            quantities — turn on <strong>Pro</strong>. Mention it in your question for tailored buying guidance.
          </div>
        )}
        {voiceError && !listening && <div className="celar-voice-error">{voiceError}</div>}
        {listening && <div className="celar-listening">● Listening… speak now</div>}
        <form className="celar-composer" onSubmit={e => { e.preventDefault(); ask(input); }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
            placeholder={listening ? 'Listening…' : 'Ask or speak…'}
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
        <p className="celar-disclaimer">Answers use your live catalog data. Cost is shown per message. AI can make mistakes, please verify important information.</p>
      </div>
    </div>
  );
}


/**
 * One button per RIP cluster the assistant surfaced this turn. Clicking sends
 * the WHOLE Case Mix (resolved server-side via /api/cart/add-by-rip) into the
 * cart as one labelled batch. Sending the same cluster twice produces TWO
 * separate batches in the cart, not a merged one — per the user rule.
 */
function RipClusterActions({ clusters }: { clusters: AssistantRipCluster[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const mut = useMutation({
    mutationFn: async (c: AssistantRipCluster) =>
      cartApi.addByRip({ wholesaler: c.wholesaler, rip_code: c.rip_code }),
    onSuccess: (_, c) => {
      qc.invalidateQueries({ queryKey: ['cart'] });
      const key = `${c.wholesaler}|${c.rip_code}`;
      setAdded(s => ({ ...s, [key]: true }));
      setTimeout(() => setAdded(s => ({ ...s, [key]: false })), 2000);
    },
  });
  return (
    <div className="celar-rip-actions">
      {clusters.map(c => {
        const key = `${c.wholesaler}|${c.rip_code}`;
        const flash = added[key];
        return (
          <div key={key} className="celar-rip-action-pair">
            <button
              className="btn btn-sm celar-rip-action"
              disabled={mut.isPending}
              onClick={() => mut.mutate(c)}
              title={`Add every product in ${c.label} to the cart as one batch (${c.member_count} items).`}
            >
              {flash
                ? (<><Check size={13} /> Added as batch</>)
                : (<><ShoppingCart size={13} /> Add {c.label} to Cart ({c.member_count})</>)}
            </button>
            {c.catalog_url && (
              <button
                className="btn btn-sm celar-rip-action celar-rip-action-deeplink"
                onClick={() => navigate(c.catalog_url!)}
                title={`Open ${c.label} in the Catalog page (${c.member_count} items, grouped by RIP).`}
              >
                <ExternalLink size={13} /> Open {c.label} in Catalog
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
