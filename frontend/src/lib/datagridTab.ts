// Open (or reuse) the single "data grid" browser tab for an assistant deeplink.
//
// Behaviour:
//  - First click  → opens a new tab.
//  - Later clicks while it's open → reuse + focus that SAME tab (full load, so
//    the prior in-memory state clears; the grid's filters live in the URL, so
//    Back in that tab restores the prior view with no data lost).
//  - If the user CLOSED that tab → the next click opens a fresh one.
//
// We keep a live window reference and check `.closed` rather than relying only
// on a named target: after a named window is closed, some browsers don't
// reliably reopen via window.open(url, name) alone, which left the link dead
// once the tab had been closed. The name is still passed as a fallback for when
// our reference is lost (e.g. the chat tab was reloaded).
const DATAGRID_TAB = 'celr-datagrid';
let gridWin: Window | null = null;

export function openDataGridTab(path: string): boolean {
  try {
    const url = window.location.origin + path;
    if (gridWin && !gridWin.closed) {
      // Live tab — navigate it in place and surface it.
      try { gridWin.location.href = url; }
      catch { gridWin = window.open(url, DATAGRID_TAB); }  // cross-doc edge case
      gridWin?.focus();
      return !!gridWin;
    }
    // No tab yet, or the user closed it → open a fresh one.
    gridWin = window.open(url, DATAGRID_TAB);
    if (gridWin) { gridWin.focus(); return true; }
  } catch { /* popup blocked / sandboxed — caller falls back to in-app nav */ }
  return false;
}
