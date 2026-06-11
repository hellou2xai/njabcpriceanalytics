import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for modals/popovers: on open, move focus inside; while
 * open, keep Tab cycling within the container; on close, restore focus to
 * the element that opened it.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter(el => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !node.contains(cur))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || !node.contains(cur))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [ref, active]);
}
