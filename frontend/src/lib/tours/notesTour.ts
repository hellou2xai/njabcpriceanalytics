/** Notes screen walkthrough. The composer always renders, so the ready anchor
 * resolves even with no notes yet; the sticky grid and the feed centre
 * gracefully when they are empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.tracker-header', title: 'My Notes',
    body: 'Two things live on this screen: quick <b>sticky notes</b> you write up top, and a single <b>feed</b> of every note you have left anywhere, on a product, a favorite, or an order. <b>Why it helps:</b> everything you jotted down, in one place.' },
  { element: '.sticky-composer', title: 'Write a sticky note',
    before: () => scrollIntoView('.sticky-composer'),
    body: 'This is the composer. Add a heading, type the note, pick a colour, then hit <b>Add note</b>. <b>Why it helps:</b> a fast scratchpad that does not get lost in your inbox.' },
  { element: '.sticky-composer-title', title: 'Give it a title',
    before: () => scrollIntoView('.sticky-composer-title'),
    body: 'An optional heading so the sticky is easy to scan later, like "Allied rep" or "Q3 Macallan". <b>Why it helps:</b> you find the right note at a glance.' },
  { element: '.sticky-composer-text', title: 'Type the note',
    body: 'Anything goes: a reminder, a price you were quoted, a question for a rep. <b>Why it helps:</b> capture the thought the second you have it.' },
  { element: '.sticky-swatches', title: 'Colour-code it',
    before: () => scrollIntoView('.sticky-swatches'),
    body: 'Pick one of six colours to group notes by meaning, then add the note. <b>Why it helps:</b> sort your thinking by colour at a glance.' },
  { element: '.sticky-grid', title: 'Your sticky board',
    before: () => scrollIntoView('.sticky-grid'),
    body: 'Every sticky you write sits here as a board, newest in view. <b>Why it helps:</b> your quick thoughts stay in front of you.' },
  { element: '.sticky-note', title: 'Edit, delete, or make it a task',
    before: () => scrollIntoView('.sticky-note'),
    body: 'On a sticky you can edit it, recolour it, delete it, or convert it into a <b>To-Do</b> with a due date. <b>Why it helps:</b> a note can turn straight into an action.' },
  { element: '.filter-bar', title: 'The feed of everything you wrote',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Below the stickies is a feed of every note you have left across the app. Filter it by source: <b>Products</b>, <b>Favorites</b>, <b>Orders</b>, or order lines. <b>Why it helps:</b> see only the notes you care about right now.' },
  { element: 'input[placeholder="Search notes..."]', title: 'Search your notes',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Search across every note by its title and text. <b>Why it helps:</b> find that thing you wrote weeks ago in seconds.' },
  { element: '.notes-feed', title: 'One stream, everything together',
    before: () => scrollIntoView('.notes-feed'),
    body: 'Product notes, favorite notes, and order notes, all in one stream, newest first, each tagged with where it came from and linking back to it. <b>Why it helps:</b> nothing you noted is stranded on another screen.' },
  { element: '.tracker-header', title: 'That’s Notes',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Jot a sticky here, or add a note from any product, favorite, or order, and it all collects in one searchable place. <b>Why it helps:</b> every note you write ends up somewhere you can find it.' },
];

export const launchNotesTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/notes', '.sticky-composer', STEPS);
