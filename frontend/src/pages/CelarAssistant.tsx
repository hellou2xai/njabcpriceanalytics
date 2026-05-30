import AssistantChat from '../components/AssistantChat';

// Dedicated full-page Celar AI Assistant. The conversation itself lives in the
// shared AssistantChat component (also used by the dockable side panel), so
// formatting — markdown, charts, product cards, voice, cost — is identical.
export default function CelarAssistant() {
  return (
    <div className="celar-page">
      <AssistantChat />
    </div>
  );
}
