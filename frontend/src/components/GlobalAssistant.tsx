import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import AiAssistantPanel from './AiAssistantPanel';
import { assistant } from '../lib/api';
import type { AssistantResponse } from '../lib/api';
import { useAssistantActions, describeActions } from '../lib/useAssistantActions';

// App-wide AI assistant: a floating launcher on every page that opens an OVERLAY
// drawer (slides over content — never reflows the page). Uses the Celar engine,
// so it answers questions AND performs actions (cart / favorites / lists) from
// anywhere. Memory + per-answer cost come from the shared panel.
const SUGGESTIONS = [
  'Cheapest tequila with a RIP rebate',
  'Add 2 cases of the cheapest prosecco to my cart',
  'Save the cheapest cabernet to favorites',
  'Which distributor has the most discounts?',
];

export default function GlobalAssistant() {
  const [open, setOpen] = useState(false);
  const { runActions } = useAssistantActions();
  const location = useLocation();

  // The dedicated full page and the font sandbox have their own assistant UI;
  // don't stack a second one there.
  if (location.pathname === '/assistant' || location.pathname === '/admin/catalog-font-test') {
    return null;
  }

  return (
    <>
      {!open && (
        <button className="global-assistant-fab" onClick={() => setOpen(true)}
                title="Ask Celar AI Assistant" aria-label="Open Celar AI Assistant">
          <Sparkles size={20} />
        </button>
      )}
      {open && (
        <>
          <div className="global-assistant-scrim" onClick={() => setOpen(false)} />
          <div className="global-assistant-drawer">
            <AiAssistantPanel<AssistantResponse>
              title="Celar AI Assistant"
              subtitle="Ask anything — or have me add to cart, favorites or a list."
              placeholder="Ask or speak…"
              storageKey="global_assistant"
              open
              onOpenChange={(v) => setOpen(v)}
              suggestions={SUGGESTIONS}
              send={(question, history) => assistant.ask(question, history)}
              onApply={(res) => { if (res.actions?.length) runActions(res.actions); }}
              describeResult={(res) => describeActions(res.actions)}
            />
          </div>
        </>
      )}
    </>
  );
}
