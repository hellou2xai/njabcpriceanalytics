/** Notes screen walkthrough. The composer always renders; the sticky grid and
 * the feed centre gracefully when there are no notes yet. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.tracker-header', title: 'Notes: everything you jot, in one place',
    body: 'Two things live here: quick <b>sticky notes</b> you write up top, and a single <b>feed</b> of every note you have added anywhere, on a product, a favourite, or an order.' },
  { element: '.sticky-composer-title', title: 'Give a note a title',
    before: () => scrollIntoView('.sticky-composer-title'),
    body: 'An optional heading so a sticky is easy to scan later.' },
  { element: '.sticky-composer-text', title: 'Write the note',
    body: 'Type anything: a reminder, a price you were quoted, a question for a rep. <b>Why it helps:</b> a fast scratchpad that does not get lost.' },
  { element: '.sticky-swatches', title: 'Colour it, then add',
    body: 'Pick one of six colours to group notes by meaning, then add it. <b>Why it helps:</b> colour-code at a glance.' },
  { element: '.sticky-grid', title: 'Your sticky notes',
    before: () => scrollIntoView('.sticky-grid'),
    body: 'Stickies you write sit here as a board. <b>Why it helps:</b> your quick thoughts, always in view.' },
  { element: '.sticky-note', title: 'Edit, delete, or turn into a task',
    before: () => scrollIntoView('.sticky-note'),
    body: 'On a sticky you can edit it, delete it, or convert it into a <b>To-Do</b> with a due date. <b>Why it helps:</b> a note can become an action.' },
  { element: '.filter-bar', title: 'The feed of every note',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Below the stickies is a feed of every note you have written across the app. Filter it by source: <b>Products</b>, <b>Favourites</b>, or <b>Orders</b>.' },
  { element: 'input[placeholder="Search notes..."]', title: 'Search your notes',
    body: 'Search across every note by its title and text. <b>Why it helps:</b> find that thing you wrote weeks ago.' },
  { element: '.notes-feed', title: 'One feed, everything together',
    before: () => scrollIntoView('.notes-feed'),
    body: 'Product notes, favourite notes and order notes, all in one stream, newest first. <b>Why it helps:</b> nothing you noted is stranded on another screen.' },
  { element: '.note-source', title: 'Straight back to the source',
    before: () => scrollIntoView('.note-source'),
    body: 'Each feed entry shows where it came from and links back to it, the product, favourite or order. <b>Why it helps:</b> one click back to the context.' },
  { element: '.tracker-header', title: 'That’s Notes',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Jot a sticky here, or add a note from any product, favourite or order, and it all collects in one searchable place. <b>Why it helps:</b> nothing gets lost.' },
];

export const launchNotesTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/notes', '.tracker-header', STEPS);
