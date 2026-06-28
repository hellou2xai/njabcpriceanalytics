import { Search, Tag, TrendingUp, ArrowLeftRight, ShoppingCart, BarChart2, Sparkles } from 'lucide-react';
import AssistantChat from '../components/AssistantChat';

const CAPABILITIES = [
  { icon: Search,         label: 'Price lookup',    desc: 'Find products by name, brand, barcode or category' },
  { icon: Tag,            label: 'Deals and combos', desc: 'Best discounts and distributor combo offers' },
  { icon: TrendingUp,     label: 'RIP rebates',      desc: 'Monthly rebate programs and tier analysis' },
  { icon: ArrowLeftRight, label: 'Compare prices',   desc: 'Cross-distributor price and savings comparison' },
  { icon: ShoppingCart,   label: 'Cart actions',     desc: 'Add products, case mixes or RIP batches to cart' },
  { icon: BarChart2,      label: 'Price trends',     desc: '3-month pricing history and drop or increase alerts' },
];

const SUGGESTIONS = [
  'What are the best bourbon deals this month?',
  "Compare Tito's Vodka across all distributors",
  'Which Fedway products have RIP rebates?',
  'Show me the biggest price drops this month',
  'What combos include Johnnie Walker?',
  "What's the cheapest way to buy Jack Daniels 750ML?",
];

export default function CelarAssistant() {
  return (
    <div className="celar-page">
      <aside className="celar-sidebar" aria-label="Celar AI sidebar">
        <div className="celar-sidebar-brand">
          <span className="celar-spark celar-sidebar-spark"><Sparkles size={20} /></span>
          <div>
            <div className="celar-sidebar-title">CELR.AI</div>
            <div className="celar-sidebar-sub">NJ ABC catalog assistant</div>
          </div>
        </div>

        <div className="celar-sidebar-section">
          <div className="celar-sidebar-label">What I can do</div>
          <div className="celar-caps">
            {CAPABILITIES.map(c => (
              <div key={c.label} className="celar-cap">
                <span className="celar-cap-icon"><c.icon size={14} /></span>
                <div className="celar-cap-body">
                  <div className="celar-cap-title">{c.label}</div>
                  <div className="celar-cap-desc">{c.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="celar-sidebar-section">
          <div className="celar-sidebar-label">Try asking</div>
          <ul className="celar-sidebar-prompts">
            {SUGGESTIONS.map(s => (
              <li key={s} className="celar-sidebar-prompt">{s}</li>
            ))}
          </ul>
        </div>
      </aside>

      <div className="celar-main">
        <AssistantChat suggestions={SUGGESTIONS} />
      </div>
    </div>
  );
}
