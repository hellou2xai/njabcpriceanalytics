/** To-Do screen walkthrough. The board and columns always render; card-level
 * steps centre gracefully when a column is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'To-Do: never lose a follow-up',
    body: 'A simple board so nothing slips. Capture “come back to this” against a product or as a standalone task, with a due date. The button up here adds a new task.' },
  { element: '.todo-board', title: 'A board, bucketed by week',
    before: () => scrollIntoView('.todo-board'),
    body: 'Tasks sort themselves into columns by due date, so the most urgent are always on the left. <b>Why it helps:</b> your week, ordered for you.' },
  { element: '.todo-col-head', title: 'Past: overdue and waiting',
    before: () => scrollIntoView('.todo-board'),
    body: 'The first column is <b>Past</b>: anything overdue stays here, in red, until you deal with it. <b>Why it helps:</b> overdue work cannot hide.' },
  { element: '.todo-col-title', title: 'This week, next week, and beyond',
    body: 'The remaining buckets are This week, Next week, In 2 weeks, and 3+ weeks / Later, each labelled with its dates.' },
  { element: '.todo-col-count', title: 'How much is in each bucket',
    body: 'A count on each column tells you the load at a glance.' },
  { element: '.todo-card', title: 'A task card',
    before: () => scrollIntoView('.todo-card'),
    body: 'Each card carries its title, an optional note, the due date, and a link to the product it came from. <b>Why it helps:</b> all the context to act, on the card.' },
  { element: '.todo-icon-btn.done', title: 'Tick it done',
    before: () => scrollIntoView('.todo-card'),
    body: 'The tick marks a task done and moves it to the Done list below. <b>Why it helps:</b> clear it without losing the record.' },
  { element: '.todo-icon-btn.danger', title: 'Edit or delete',
    body: 'The pencil edits a task (title, note, due date); the bin removes it. <b>Why it helps:</b> keep the board tidy and current.' },
  { element: '.todo-due', title: 'The due date',
    before: () => scrollIntoView('.todo-due'),
    body: 'Each card shows when it is due; overdue dates turn red. <b>Why it helps:</b> urgency is obvious.' },
  { element: '.todo-source', title: 'Straight back to the product',
    before: () => scrollIntoView('.todo-source'),
    body: 'When a task came from a product, the card links back to it. You create these by right-clicking any product anywhere and choosing <b>Add to To-Do</b>.' },
  { element: '.todo-board', title: 'Drag to reschedule',
    body: 'Grab a card and drop it in another week; its due date moves with it. <b>Why it helps:</b> rescheduling is one drag, no forms.' },
  { element: '.orders-header', title: 'Add a task',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Use <b>New To-Do</b> here for a standalone task, the <b>+</b> on a column to add one due that week, or right-click a product anywhere. <b>Why it helps:</b> capture it the moment you think of it.' },
  { element: '.todo-done-list', title: 'Done, but not forgotten',
    before: () => scrollIntoView('.todo-done-list'),
    body: 'Finished tasks collect here, so you have a record and can reopen one if needed. That’s the whole loop: capture, schedule, do, done.' },
];

export const launchTodoTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/todo', '.todo-board', STEPS);
