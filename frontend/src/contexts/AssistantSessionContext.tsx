import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assistantSessions } from '../lib/api';
import type {
  ChatSessionMeta, AssistantChart as ChartSpec, AiUsage,
  CatalogAiProduct, AssistantRipCluster,
} from '../lib/api';

/**
 * Shared CELR.AI Assistant conversation store.
 *
 * The assistant lives in two places — the dedicated /assistant page and the
 * app-wide docked panel — and both must show the SAME continuous thread (a
 * single global conversation, not one per screen). This provider holds that
 * one active conversation plus the user's saved-chat history, and persists
 * everything SERVER-SIDE so history follows the user across devices/logins.
 *
 * Persistence is debounced: the whole transcript is saved as a JSON blob a
 * short moment after the last change. A brand-new chat isn't written to the
 * server until its first message, so the history list never fills with empty
 * "New chat" rows.
 */

// One message in the transcript — the exact object the chat renders. Stored and
// restored verbatim so reopening a session brings back charts/products too.
export interface AssistantMsg {
  role: 'user' | 'assistant';
  text: string;
  charts?: ChartSpec[];
  products?: CatalogAiProduct[];
  ripClusters?: AssistantRipCluster[];
  chips?: string[];
  usage?: AiUsage;
  error?: boolean;
  awaitingCount?: boolean;
  screenBase?: string;
  navTs?: number;
  screenPath?: string;
  screenLabel?: string;
}

interface Ctx {
  sessions: ChatSessionMeta[];
  activeId: number | null;
  activeTitle: string;
  messages: AssistantMsg[];
  loading: boolean;
  setMessages: (u: AssistantMsg[] | ((prev: AssistantMsg[]) => AssistantMsg[])) => void;
  newChat: () => Promise<void>;
  openSession: (id: number) => Promise<void>;
  renameSession: (id: number, title: string) => Promise<void>;
  deleteSession: (id: number) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

const AssistantSessionContext = createContext<Ctx | null>(null);

const ACTIVE_KEY = 'celr_active_session';
const SAVE_DELAY = 700;

function deriveTitle(msgs: AssistantMsg[]): string {
  const u = msgs.find(m => m.role === 'user' && m.text?.trim());
  if (!u) return 'New chat';
  const t = u.text.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

export function AssistantSessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeTitle, setActiveTitle] = useState('New chat');
  const [messages, setMessagesState] = useState<AssistantMsg[]>([]);
  const [loading, setLoading] = useState(false);

  // Refs mirror state so the debounced save always reads the latest values
  // without being re-created on every keystroke.
  const messagesRef = useRef<AssistantMsg[]>([]);
  const activeIdRef = useRef<number | null>(null);
  const titleRef = useRef('New chat');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    try { setSessions(await assistantSessions.list()); } catch { /* ignore */ }
  }, []);

  // The single writer to the server. Serialised via savingRef so two debounce
  // ticks can't double-create a session; a change during a save re-arms it.
  const persist = useCallback(async () => {
    const msgs = messagesRef.current;
    if (!msgs.length) return;                 // never persist an empty chat
    if (savingRef.current) { dirtyRef.current = true; return; }
    savingRef.current = true;
    try {
      let id = activeIdRef.current;
      const derived = deriveTitle(msgs);
      // Send a title only while the session still wears the auto label, so a
      // manual rename is never clobbered by a later message.
      const titleToSend = (!titleRef.current || titleRef.current === 'New chat') ? derived : undefined;
      if (id == null) {
        const created = await assistantSessions.create();
        id = created.id;
        activeIdRef.current = id;
        setActiveId(id);
        try { localStorage.setItem(ACTIVE_KEY, String(id)); } catch { /* */ }
      }
      await assistantSessions.save(id, msgs, titleToSend);
      if (titleToSend) { titleRef.current = titleToSend; setActiveTitle(titleToSend); }
      await refreshSessions();
    } catch {
      // Leave dirty so the next change retries; a transient failure shouldn't
      // lose the transcript (it's still in memory).
    } finally {
      savingRef.current = false;
      if (dirtyRef.current) { dirtyRef.current = false; scheduleSave(); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { persist(); }, SAVE_DELAY);
  }, [persist]);

  // Set messages WITHOUT scheduling a save — used when loading/clearing a
  // session so opening an old chat doesn't immediately rewrite it.
  const applyMessages = useCallback((next: AssistantMsg[]) => {
    messagesRef.current = next;
    setMessagesState(next);
  }, []);

  // Public setter the chat uses: updates state and arms the debounced save.
  const setMessages = useCallback((u: AssistantMsg[] | ((prev: AssistantMsg[]) => AssistantMsg[])) => {
    setMessagesState(prev => {
      const next = typeof u === 'function' ? (u as (p: AssistantMsg[]) => AssistantMsg[])(prev) : u;
      messagesRef.current = next;
      return next;
    });
    scheduleSave();
  }, [scheduleSave]);

  // Flush any pending/in-progress save for the CURRENT session before we switch
  // away, so unsaved edits aren't lost when changing threads.
  const flushSave = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    dirtyRef.current = false;
    await persist();
  }, [persist]);

  const newChat = useCallback(async () => {
    await flushSave();
    activeIdRef.current = null;
    titleRef.current = 'New chat';
    setActiveId(null);
    setActiveTitle('New chat');
    applyMessages([]);
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* */ }
  }, [flushSave, applyMessages]);

  const openSession = useCallback(async (id: number) => {
    if (id === activeIdRef.current) return;
    await flushSave();
    setLoading(true);
    try {
      const full = await assistantSessions.get(id);
      activeIdRef.current = id;
      titleRef.current = full.title || 'New chat';
      setActiveId(id);
      setActiveTitle(full.title || 'New chat');
      applyMessages((full.messages as AssistantMsg[]) ?? []);
      try { localStorage.setItem(ACTIVE_KEY, String(id)); } catch { /* */ }
    } catch {
      /* leave current thread as-is on failure */
    } finally {
      setLoading(false);
    }
  }, [flushSave, applyMessages]);

  const renameSession = useCallback(async (id: number, title: string) => {
    const clean = title.trim() || 'New chat';
    try {
      await assistantSessions.rename(id, clean);
      if (id === activeIdRef.current) { titleRef.current = clean; setActiveTitle(clean); }
      await refreshSessions();
    } catch { /* ignore */ }
  }, [refreshSessions]);

  const deleteSession = useCallback(async (id: number) => {
    try {
      await assistantSessions.remove(id);
      if (id === activeIdRef.current) {
        // Dropped the open chat — fall back to a fresh empty thread.
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        dirtyRef.current = false;
        activeIdRef.current = null;
        titleRef.current = 'New chat';
        setActiveId(null);
        setActiveTitle('New chat');
        applyMessages([]);
        try { localStorage.removeItem(ACTIVE_KEY); } catch { /* */ }
      }
      await refreshSessions();
    } catch { /* ignore */ }
  }, [refreshSessions, applyMessages]);

  // On mount: load the history list and restore the last-open conversation so
  // it survives a full page reload (within the SPA the provider never unmounts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await assistantSessions.list();
        if (cancelled) return;
        setSessions(list);
        const raw = (() => { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } })();
        const lastId = raw ? Number(raw) : NaN;
        if (Number.isFinite(lastId) && list.some(s => s.id === lastId)) {
          const full = await assistantSessions.get(lastId);
          if (cancelled) return;
          activeIdRef.current = lastId;
          titleRef.current = full.title || 'New chat';
          setActiveId(lastId);
          setActiveTitle(full.title || 'New chat');
          applyMessages((full.messages as AssistantMsg[]) ?? []);
        }
      } catch { /* start with an empty new chat */ }
    })();
    return () => { cancelled = true; };
  }, [applyMessages]);

  return (
    <AssistantSessionContext.Provider value={{
      sessions, activeId, activeTitle, messages, loading,
      setMessages, newChat, openSession, renameSession, deleteSession, refreshSessions,
    }}>
      {children}
    </AssistantSessionContext.Provider>
  );
}

export function useAssistantSession(): Ctx {
  const ctx = useContext(AssistantSessionContext);
  if (!ctx) throw new Error('useAssistantSession must be used within AssistantSessionProvider');
  return ctx;
}
