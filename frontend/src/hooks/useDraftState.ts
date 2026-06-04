import { useEffect, useState } from 'react';

const PREFIX = 'lpb_draft:';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * Drop-in replacement for useState that mirrors its value into sessionStorage.
 *
 * Why: the app is a React Router SPA. Navigating (incl. the Back button)
 * unmounts the page component, which throws away all plain useState — so any
 * details a user typed into a form but hadn't yet saved are lost. Persisting
 * the draft to sessionStorage lets the form re-hydrate when it remounts.
 *
 * sessionStorage (not localStorage) is deliberate: a draft is per-tab and
 * auto-clears when the tab closes, so abandoned drafts never linger forever.
 * On a successful save, call clearDrafts(prefix) so the saved entity doesn't
 * reappear as a stale draft.
 */
export function useDraftState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() =>
    read(key, typeof initial === 'function' ? (initial as () => T)() : initial),
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* private-mode / quota — non-fatal, the form still works in-memory */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/** Remove every persisted draft whose key starts with `prefix` (e.g. 'stores:'). */
export function clearDrafts(prefix: string) {
  try {
    const full = PREFIX + prefix;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(full)) sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}
