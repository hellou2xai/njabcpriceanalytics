/** Configuration screen walkthrough. Shorter than the others (it is a simple
 * setup screen). Switches tabs via auto-actions so each section is on screen. */
import { launchScreenTour, waitForEl, type ScreenStep } from '../screenTour';

function clickTab(label: string) {
  const tab = Array.from(document.querySelectorAll('.tab-bar .tab'))
    .find(t => t.textContent?.trim() === label) as HTMLButtonElement | undefined;
  tab?.click();
}

const STEPS: ScreenStep[] = [
  { element: 'h2', title: 'Configuration: set up once',
    body: 'A little setup that powers the rest of the app: who your sales reps are, your divisions, and your stores. <b>Why it helps:</b> orders route to the right people automatically.' },
  { element: '.tab-bar', title: 'Three things to set up',
    body: 'Three tabs: <b>Sales Reps</b>, <b>Divisions</b>, and <b>Stores</b>. We will look at each.' },
  { element: '.inline-form', title: 'Add your sales reps',
    before: async () => { clickTab('Sales Reps'); await waitForEl('.inline-form', 2000); },
    body: 'Add each rep with their <b>distributor</b>, <b>division</b>, and crucially their <b>email</b>. <b>Why it helps:</b> the cart groups your order by rep and emails each their purchase order.' },
  { element: '.inline-form', title: 'The email is the key field',
    body: 'A rep’s email is where their order’s PO is sent when you hit “Send All Orders to Reps”. <b>Why it helps:</b> no email, no automatic send, so fill it in.' },
  { element: '.inline-form', title: 'Divisions',
    before: async () => { clickTab('Divisions'); await waitForEl('.inline-form', 2000); },
    body: 'Divisions are buckets within a distributor (for example a wine division and a spirits division). Reps belong to a division. <b>Why it helps:</b> route orders to the right desk inside a big distributor.' },
  { element: '.store-form, .store-grid, .tab-bar', title: 'Stores',
    before: async () => { clickTab('Stores'); await waitForEl('.store-form, .store-grid', 2000); },
    body: 'Register your stores with their address and licence. <b>Why it helps:</b> orders and records are tied to the right location.' },
  { element: 'h2', title: 'That’s the setup',
    before: () => { clickTab('Sales Reps'); window.scrollTo({ top: 0, behavior: 'auto' }); },
    body: 'Do this once and the Cart, Orders and emails all just work. Come back any time a rep, division or store changes. <b>Why it helps:</b> five minutes here saves friction on every order.' },
];

export const launchConfigurationTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/configuration', '.tab-bar', STEPS);
