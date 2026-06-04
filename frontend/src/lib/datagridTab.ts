// Open (or reuse) the single "data grid" browser tab for an assistant deeplink.
//
// A STABLE window name is the trick: the first click opens a new tab, and every
// later click reuses + focuses that same tab instead of piling up tabs. The
// reuse is a full navigation, so the prior page's in-memory React state is
// cleared — but the grid's filters now live in the URL (Catalog URL-sync), so
// the prior view sits in that tab's history and the Back button restores it
// with no data lost.
//
// Returns false if the browser blocked the popup, so the caller can fall back
// to an in-app navigation.
const DATAGRID_TAB = 'celr-datagrid';

export function openDataGridTab(path: string): boolean {
  try {
    const url = window.location.origin + path;
    const w = window.open(url, DATAGRID_TAB);
    if (w) { w.focus(); return true; }
  } catch { /* popup blocked / sandboxed — fall through to caller's fallback */ }
  return false;
}
