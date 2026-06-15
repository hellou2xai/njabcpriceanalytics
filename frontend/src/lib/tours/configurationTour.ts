/** Configuration screen walkthrough. A setup screen with three tabs (Sales Reps,
 * Divisions, Stores); each step switches to the right tab so its anchor is on
 * screen, then points at the real add-form or list. */
import { launchScreenTour, scrollIntoView, waitForEl, type ScreenStep } from '../screenTour';

function clickTab(label: string) {
  const tab = Array.from(document.querySelectorAll('.tab-bar .tab'))
    .find(t => t.textContent?.trim() === label) as HTMLButtonElement | undefined;
  tab?.click();
}

const STEPS: ScreenStep[] = [
  { element: '.page > h2', title: 'Configuration: set up once',
    body: 'A little setup that powers the rest of the app: your sales reps, your divisions, and your stores. <b>Why it helps:</b> orders route to the right people and places automatically.' },
  { element: '.tab-bar', title: 'Three things to set up',
    before: () => scrollIntoView('.tab-bar'),
    body: 'Three tabs run across the top: <b>Sales Reps</b>, <b>Divisions</b>, then <b>Stores</b>. We will walk each one. <b>Why it helps:</b> everything below the tabs is your own master data.' },
  { element: '.inline-form', title: 'Add your sales reps',
    before: async () => { clickTab('Sales Reps'); await waitForEl('.inline-form', 2000); scrollIntoView('.inline-form'); },
    body: 'Add each rep with their <b>distributor</b>, their <b>division</b>, and an <b>email</b>. Pick the distributor first and the Division list fills in. <b>Why it helps:</b> the cart groups your order by rep, so each rep gets only their lines.' },
  { element: '.inline-form input[type="email"]', title: 'The email is the key field',
    before: () => scrollIntoView('.inline-form'),
    savings: '📧 No email, no automatic send',
    body: 'A rep’s email is where their purchase order goes when you hit <b>Send All Orders to Reps</b> from the cart. <b>Why it helps:</b> fill it in once and ordering is one click, not a round of forwarding.' },
  { element: '.table-container', title: 'Your saved reps',
    before: () => scrollIntoView('.table-container'),
    body: 'Reps you add show in this table; the row actions let you <b>edit</b> or <b>delete</b> any of them. <b>Why it helps:</b> keep the list current as people join or move distributor.' },
  { element: '.inline-form', title: 'Divisions',
    before: async () => { clickTab('Divisions'); await waitForEl('.inline-form', 2000); scrollIntoView('.inline-form'); },
    body: 'Divisions are buckets within one distributor (for example Wine, Spirits, or Beer). Pick the distributor, name the division, then tag reps with it. <b>Why it helps:</b> route orders to the right desk inside a large distributor.' },
  { element: '.config-chips, .inline-form', title: 'Divisions you have added',
    before: () => scrollIntoView('.config-chips, .inline-form'),
    body: 'Saved divisions appear as chips, each tagged with its distributor; the bin icon removes one. <b>Why it helps:</b> a quick, visual view of how your distributors are split up.' },
  { element: '.store-form, .store-grid, .tab-bar', title: 'Stores',
    before: async () => { clickTab('Stores'); await waitForEl('.store-form, .store-grid', 2000); scrollIntoView('.store-form, .store-grid'); },
    savings: '📍 More stores, sharper analytics',
    body: 'Add every store you own. Start typing the name and it looks up the address, licence and phone for you. <b>Why it helps:</b> the more stores you register, the more granular your pricing and deal analytics get.' },
  { element: '.store-grid, .store-form', title: 'Your stores',
    before: () => scrollIntoView('.store-grid, .store-form'),
    body: 'Each store shows as a card with its address and licence; edit or delete it from the card. <b>Why it helps:</b> orders and records stay tied to the right location.' },
  { element: '.page > h2', title: 'That’s the setup',
    before: () => { clickTab('Sales Reps'); window.scrollTo({ top: 0, behavior: 'auto' }); },
    body: 'Do this once and the Cart, Orders and rep emails all just work. Come back any time a rep, division or store changes. <b>Why it helps:</b> five minutes here saves friction on every order you place.' },
];

export const launchConfigurationTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/configuration', '.tab-bar', STEPS);
