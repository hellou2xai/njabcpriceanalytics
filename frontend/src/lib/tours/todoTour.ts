/** To-Do screen walkthrough. The weekly Kanban board (.todo-board) always renders,
 * even with no tasks, so the anchors resolve on an empty page too. Card-level steps
 * centre gracefully when every column is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Your To-Do board',
    body: 'Everything you promised yourself to follow up on, laid out by week. <b>Why it helps:</b> nothing slips through the cracks while you work the price book.' },
  { element: '.orders-header .btn', title: 'Add a to-do',
    body: 'Click <b>New To-Do</b> to jot down a task. You can also right-click any product anywhere in the app and pick <b>Add to To-Do</b>, which carries the product across with it. <b>Why it helps:</b> capture the follow-up the moment you spot it.' },
  { element: '.todo-board', title: 'Five weekly buckets',
    before: () => scrollIntoView('.todo-board'),
    body: 'The board runs left to right: <b>Past</b> for anything overdue, then <b>This week</b>, <b>Next week</b>, <b>In 2 weeks</b>, and <b>3+ weeks / Later</b>. Tasks sort themselves in by due date. <b>Why it helps:</b> you see what is due now versus what can wait.' },
  { element: '.todo-col.past', title: 'Overdue never hides',
    before: () => scrollIntoView('.todo-col.past'),
    savings: '⏱️ Overdue follow-ups stay in your face',
    body: 'The <b>Past</b> column keeps overdue cards in view, in red, until you finish them. It is not a drop target, because you cannot schedule something into the past. <b>Why it helps:</b> a missed deal stays loud, not buried.' },
  { element: '.todo-col-head', title: 'Each column header',
    before: () => scrollIntoView('.todo-col-head'),
    body: 'Every week shows its name, a <b>+</b> to add a card straight into that week, and a count of what is in it. The line below spells out the exact dates the column covers. <b>Why it helps:</b> add to the right week without opening a date picker.' },
  { element: '.todo-card', title: 'A task card',
    before: () => scrollIntoView('.todo-card'),
    body: 'Each card shows the task, any note, its due date, and (if it came from a product) a link back to that product. Overdue cards are flagged. <b>Why it helps:</b> the full context of the follow-up at a glance.' },
  { element: '.todo-card .todo-icon-btn.done', title: 'Mark it done',
    before: () => scrollIntoView('.todo-card'),
    savings: '✅ One click clears a follow-up',
    body: 'The check button marks a card done and drops it into the <b>Done</b> list at the bottom. The pencil edits it (title, note, due date); the trash deletes it. <b>Why it helps:</b> close out work without losing the record of it.' },
  { element: '.todo-source', title: 'Jump back to the product',
    before: () => scrollIntoView('.todo-source'),
    body: 'When a card was made from a product, that footer opens the product Quick View so you can act on the deal there and then. <b>Why it helps:</b> from a reminder to the actual price in one click.' },
  { element: '.todo-card.sticky', title: 'Drag to reschedule',
    before: () => scrollIntoView('.todo-card'),
    savings: '📅 Drag a card to push it to another week',
    body: 'Cards are draggable. Drop one onto a different week and it reschedules to the start of that week automatically. <b>Why it helps:</b> reshuffle your plan without typing a single date.' },
  { element: '.todo-done-list', title: 'Done, and reopenable',
    before: () => scrollIntoView('.todo-done-list'),
    body: 'Finished tasks collect in the <b>Done</b> list. Use the loop button to reopen one if it comes back, or the trash to clear it for good. <b>Why it helps:</b> a clean board, with a paper trail you can undo.' },
  { element: '.todo-board', title: 'That’s the To-Do board',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Capture follow-ups, sort them by week, drag to replan, and tick them off. <b>Why it helps:</b> the price book moves fast, and this keeps your next moves in order.' },
];

export const launchTodoTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/todo', '.todo-board', STEPS);
