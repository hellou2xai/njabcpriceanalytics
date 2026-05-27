/** Orders screen walkthrough. Row-level steps centre gracefully when there are
 * no orders yet. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Orders: every purchase order',
    body: 'A record of every order, whether still in progress or already sent. Most orders arrive here from the Cart, but you can also start one directly with the form up here.' },
  { element: '.filter-pill', title: 'Filter by status',
    before: () => scrollIntoView('.filter-pill'),
    body: 'Switch between <b>All</b>, <b>In Progress</b>, <b>Submitted</b>, and <b>Archived</b>. <b>Why it helps:</b> see just the orders at the stage you care about.' },
  { element: '.filter-bar', title: 'How many, at this status',
    body: 'The count tells you how many orders match the current filter.' },
  { element: '.tab-bar', title: 'Orders, or every order line',
    before: () => scrollIntoView('.tab-bar'),
    body: 'The first tab lists orders; the second, <b>All Order Lines</b>, flattens every product across all orders into one table. <b>Why it helps:</b> check a product across orders at once.' },
  { element: '.table-container', title: 'Your orders',
    before: () => scrollIntoView('.table-container'),
    body: 'Each row is an order: its number, distributor, rep, status and total. Click a row to open it. <b>Why it helps:</b> everything you have ordered, in one list.' },
  { element: '.tag', title: 'Status at a glance',
    before: () => scrollIntoView('.tag'),
    body: 'A coloured badge shows whether an order is a <b>draft</b>, <b>submitted</b>, or <b>archived</b>. <b>Why it helps:</b> spot what still needs sending.' },
  { element: '.num', title: 'Totals, rebate and margin',
    before: () => scrollIntoView('.num'),
    body: 'Each order shows its total, the rebate you earn back, and your margin. <b>Why it helps:</b> judge the value of an order at a glance.' },
  { element: '.table-container', title: 'Open an order to manage it',
    body: 'Open an order to <b>reopen</b> it for edits and re-submit as a new revision, <b>cancel</b> it, or <b>re-share the PDF</b>. <b>Why it helps:</b> a sent order is still editable and traceable, with your rep kept in sync.' },
  { element: '.orders-header', title: 'Start an order here too',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Name an order, pick a <b>distributor</b> and <b>sales rep</b>, and Create. The reps come from your Configuration. <b>Why it helps:</b> a quick manual order when you are not building one in the Cart.' },
  { element: '.filter-pill', title: 'Keep the list tidy',
    before: () => scrollIntoView('.filter-pill'),
    body: 'Archive old orders so In Progress stays clean, and reach them again any time via the Archived filter.' },
  { element: '.table-container', title: 'One source of truth',
    before: () => scrollIntoView('.table-container'),
    body: 'Sent from the Cart or built here, every order lands in this list with its rebate and margin worked out. <b>Why it helps:</b> nothing about an order is lost or guessed.' },
  { element: '.orders-header', title: 'That’s Orders',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Track, filter, reopen and re-share, with the maths attached. <b>Why it helps:</b> manage what you have bought as confidently as what you are about to.' },
];

export const launchOrdersTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/orders', '.orders-header', STEPS);
