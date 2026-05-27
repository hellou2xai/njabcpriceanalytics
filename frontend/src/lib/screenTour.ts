/**
 * Per-screen walkthrough runner (driver.js).
 *
 * Unlike the whole-app guided tour (see guidedTour.ts), this runs a focused tour
 * of the screen the user is already on. Steps stay on one page; they don't change
 * routes. Each step can carry a `before` hook that drives the real UI first (type
 * a search, open the filter panel, scroll a row into view, turn on a filter) so
 * that whatever the step points at is actually on screen. WalkMe/Pendo style.
 *
 * If a step's element isn't found, driver.js shows the popover centred instead of
 * breaking, so the tour always completes.
 */
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

export interface ScreenStep {
  element?: string;
  title: string;
  body: string;
  /** Optional UI prep run when this step is reached (await-able). */
  before?: () => void | Promise<void>;
}

export function waitForEl(sel?: string, timeout = 4000): Promise<void> {
  return new Promise(resolve => {
    if (!sel) { setTimeout(resolve, 200); return; }
    const start = Date.now();
    const tick = () => {
      if (document.querySelector(sel) || Date.now() - start > timeout) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Set the value of a React-controlled input/textarea and fire its onChange. */
export function setReactValue(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!el) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Scroll the first match into the middle of the viewport, if it exists. */
export function scrollIntoView(sel: string) {
  const el = document.querySelector(sel);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
}

export { sleep };

export async function runScreenTour(steps: ScreenStep[], onCleanup?: () => void) {
  const prep = async (step?: ScreenStep) => {
    if (!step) return;
    if (step.before) { try { await step.before(); } catch { /* best effort */ } }
    await waitForEl(step.element);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drv = driver({
    showProgress: true,
    allowClose: true,
    overlayColor: 'rgba(15, 23, 42, 0.55)',
    stagePadding: 6,
    popoverClass: 'celr-tour',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Done',
    steps: steps.map(s => ({ element: s.element, popover: { title: s.title, description: s.body } })),
    onNextClick: async (_el: Element | undefined, _step: unknown, opts: any) => {
      await prep(steps[(opts.state.activeIndex ?? 0) + 1]);
      opts.driver.moveNext();
    },
    onPrevClick: async (_el: Element | undefined, _step: unknown, opts: any) => {
      await prep(steps[(opts.state.activeIndex ?? 0) - 1]);
      opts.driver.movePrevious();
    },
    onDestroyed: () => { try { onCleanup?.(); } catch { /* ignore */ } },
  });

  await prep(steps[0]);
  drv.drive();
}

/**
 * Launch a screen tour from anywhere: navigate to the page, wait for a stable
 * element to render, then run the steps. Used by the Tours dashboard tiles.
 */
export async function launchScreenTour(
  navigate: (path: string) => void,
  route: string,
  readySelector: string,
  steps: ScreenStep[],
  onCleanup?: () => void,
) {
  if (window.location.pathname !== route) navigate(route);
  await waitForEl(readySelector, 8000);
  await sleep(350);
  runScreenTour(steps, onCleanup);
}
