/** Orders screen walkthrough. The header and create form always render, even
 * with zero orders, so the ready anchor (.orders-header) is reliable; table and
 * row steps fall back to a centred popover when the list is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Orders: every purchase order',
    body: 'A record of every order, whether still in progress or already sent. Most orders arrive here from the Cart, but you can also start one directly with the form up here. <b>Why it helps:</b> one place to track everything you have bought.' },
  { element: '.orders-header .inline-form', title: 'Start an order here',
    before: () => scrollIntoView('.orders-header'),
    body: 'Name it (optional), pick a <b>distributor</b>, add a <b>sales rep</b> if you have one, then <b>Create Order</b>. There is one open order per distributor and rep, so creating for a pair you already have open just reopens it. <b>Why it helps:</b> no duplicate orders for the same supplier.' },
  { element: '.tab-bar', title: 'Orders, or every order line',
    before: () => scrollIntoView('.tab-bar'),
    body: 'The first tab lists orders; the second, <b>All Order Lines</b>, flattens every product across all orders into one table, grouped by distributor and rep. <b>Why it helps:</b> check a product across orders at once.' },
  { element: '.filter-bar', title: 'Filter by status',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Switch between <b>All</b>, <b>In Progress</b> (draft), <b>Submitted</b> (sent to the rep), and <b>Archived</b>. The count on the right tells you how many orders match. <b>Why it helps:</b> see just the orders at the stage you care about.' },
  { element: '.table-container', title: 'Your orders',
    before: () => scrollIntoView('.table-container'),
    savings: '💰 Totals already net of RIP rebates',
    body: 'Each row is an order: its ID, name, distributor, rep, total and status, plus when it was created and last updated. The total already reflects RIP savings on the lines. <b>Why it helps:</b> everything you have ordered, in one list.' },
  { element: '.table-container th.sortable', title: 'Sort any column',
    before: () => scrollIntoView('.table-container'),
    body: 'Click a sortable header to order by ID, name, distributor, total, status, or date. <b>Why it helps:</b> find the biggest order or the most recent one fast.' },
  { element: '.tag', title: 'Status at a glance',
    before: () => scrollIntoView('.tag'),
    body: 'A coloured badge shows whether an order is <b>in progress</b>, <b>submitted</b>, or <b>archived</b>. <b>Why it helps:</b> spot what still needs sending.' },
  { element: '.table-container tbody tr.clickable', title: 'Open an order to manage it',
    before: () => scrollIntoView('.table-container tbody tr.clickable'),
    body: 'Click a row to open the order and see all its line items, then <b>reopen</b> a submitted order for edits and re-submit it as a new revision, or re-share the PDF. <b>Why it helps:</b> a sent order is still editable and traceable, with your rep kept in sync.' },
  { element: '.table-toolbar', title: 'Export the list',
    before: () => scrollIntoView('.table-toolbar'),
    savings: '📄 Hand a clean order to your rep',
    body: 'Export the orders table to a file from here, and inside an open order you can produce a PDF to send to your distributor. <b>Why it helps:</b> turn an order into a document you can share or file.' },
  { element: '.filter-bar', title: 'Keep the list tidy',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Archive old orders so In Progress stays clean, and reach them again any time via the <b>Archived</b> filter. <b>Why it helps:</b> the working list stays short without losing history.' },
  { element: '.orders-header', title: 'That’s Orders',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Create an order, track it by status, drill into the lines, reopen and re-share, with the maths attached. <b>Why it helps:</b> the full ordering loop, from cart to confirmed, on one screen.' },
];

export const launchOrdersTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/orders', '.orders-header', STEPS);
