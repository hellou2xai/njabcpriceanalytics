const BASE = import.meta.env.VITE_API_URL ?? '';

export const TOKEN_KEY = 'lpb_auth_token';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData bodies must NOT carry an explicit Content-Type — the browser sets
  // the multipart boundary itself. JSON bodies keep the application/json header.
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    // Session expired or missing. Drop the stale token and return to login,
    // unless we're already on an auth call (those report their own errors).
    if (!path.startsWith('/api/auth/')) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem('lpb_auth_user');
      window.location.reload();
    }
    throw new Error(`API 401: ${await res.text()}`);
  }
  if (!res.ok) {
    // Surface FastAPI's {"detail": "..."} message when present.
    const text = await res.text();
    let msg = `API ${res.status}: ${text}`;
    try {
      const detail = JSON.parse(text)?.detail;
      if (detail) msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    } catch { /* not JSON, keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---- Catalog ----
export interface RipSheetTier {
  unit: string | null;       // "Case(s)", "Bottle(s)", ...
  qty: number | null;        // buy quantity to unlock
  amount: number;            // rebate $ per unit
  from_date: string | null;
  to_date: string | null;
  description: string | null;
}

// MI "Top <Category>" rails for the /discover page. Each rail carries the query
// params that filter the Products grid (spirit_category for spirits, grapes/q
// for wine) and are also used to fetch the rail's top products.
export interface MiRail {
  label: string;
  params: Record<string, string>;
  revenue: number;
}
export interface MiTopCategories {
  spirits: MiRail[];
  wine: MiRail[];
}

// One precomputed Discover deal card, read straight from the deal_grid table
// (backend/precompute_deals.py). Every value is already computed — the admin page
// renders these directly, no client-side pricing math.
export interface DealGridCard {
  edition: string; product_key: string;
  upc?: string | null; product_name: string; display_name?: string | null;
  brand?: string | null; spirit_category?: string | null; product_type?: string | null;
  geo_varietal?: string | null;
  unit_volume?: string | null; unit_qty?: string | null; pack?: number | null; vintage?: string | null;
  primary_wholesaler?: string | null; wholesalers?: string | null; n_distributors?: number | null;
  dist_item_no?: string | null; dist_item_name?: string | null;
  mi_volume?: number | null; image_url?: string | null;
  frontline_case_price?: number | null; one_cs_case_price?: number | null; effective_case_price?: number | null;
  btl_1cs?: number | null; btl_best_qd?: number | null; btl_best_qd_rip?: number | null;
  rip_qty?: number | null; rip_amount?: number | null; rip_per_case?: number | null;
  rip_code?: string | null; rip_is_ts?: boolean | null; rip_from?: string | null; rip_to?: string | null;
  rip_unit?: string | null; rip_cases?: number | null;
  qd_qty?: number | null; qd_save_per_case?: number | null; qd_total?: number | null;
  qd_unit?: string | null; qd_cases?: number | null;
  has_rip?: boolean | null; has_qd?: boolean | null; has_both?: boolean | null; is_time_sensitive?: boolean | null;
  net_discount?: number | null; discount_pct?: number | null;
}

export const catalog = {
  search: (params: Record<string, unknown>) =>
    request<{ total: number; items: Product[]; corrected_query?: string | null }>(`/api/catalog/search${qs(params)}`),
  newItems: (params?: Record<string, unknown>) =>
    request<NewItemsResponse>(`/api/catalog/new-items${qs(params ?? {})}`),
  product: (wholesaler: string, name: string, opts?: { edition?: string; upc?: string; unit_volume?: string; unit_qty?: string; vintage?: string; rip_code?: string }) =>
    request<{ product: Product; discount_tiers: DiscountTier[]; rip_tiers: RipTier[]; enrichment: ProductEnrichment | null; ai_blurb: string | null }>(
      `/api/catalog/product/${encodeURIComponent(wholesaler)}/${encodeURIComponent(name)}${qs(opts ?? {})}`
    ),
  editions: () => request<Edition[]>('/api/catalog/editions'),
  // New precomputed deal grid (Discover Deals Admin — reads deal_grid directly).
  discoverDeals: (params: Record<string, unknown>) =>
    request<{ edition: string; count: number; items: DealGridCard[]; error?: string }>(`/api/catalog/discover-deals${qs(params)}`),
  topCategories: () =>
    request<MiTopCategories>('/api/catalog/top-categories'),
  categories: (params?: Record<string, unknown>) =>
    request<Category[]>(`/api/catalog/categories${qs(params ?? {})}`),
  facets: (params?: Record<string, unknown>) =>
    request<CatalogFacets>(`/api/catalog/facets${qs(params ?? {})}`),
  // Mobile lens search: identify a beverage from a camera photo (Claude vision)
  // and get back the best search query to run.
  lens: (image: string) =>
    request<{ query: string | null; error?: string }>(`/api/catalog/lens`, {
      method: 'POST', body: JSON.stringify({ image }),
    }),
  priceComparison: (params?: Record<string, unknown>) =>
    request<PriceComparisonResponse>(`/api/catalog/price-comparison${qs(params ?? {})}`),
  crossDistributor: (params?: Record<string, unknown>) =>
    request<CrossDistributorResponse>(`/api/catalog/cross-distributor${qs(params ?? {})}`),
  crossDistributorCombined: (params?: Record<string, unknown>) =>
    request<CrossDistributorResponse>(`/api/catalog/cross-distributor-combined${qs(params ?? {})}`),
  distributorExclusive: (params?: Record<string, unknown>) =>
    request<DistributorExclusiveResponse>(`/api/catalog/distributor-exclusive${qs(params ?? {})}`),
  qaAnomalies: (params?: Record<string, unknown>) =>
    request<QAReport>(`/api/catalog/qa/anomalies${qs(params ?? {})}`),
  priceHistory: (wholesaler: string, name: string, opts?: { upc?: string; unit_volume?: string; unit_qty?: string; vintage?: string }) =>
    request<{ history: PricePoint[]; stats: PriceStats }>(
      `/api/catalog/price-history/${encodeURIComponent(wholesaler)}/${encodeURIComponent(name)}${qs(opts ?? {})}`
    ),
  productBreakdown: (wholesaler: string, name: string, opts?: { upc?: string; unit_volume?: string; unit_qty?: string; vintage?: string }) =>
    request<{ editions: ProductBreakdownEdition[] }>(
      `/api/catalog/product-breakdown/${encodeURIComponent(wholesaler)}/${encodeURIComponent(name)}${qs(opts ?? {})}`
    ),
  ripSiblings: (wholesaler: string, ripCode: string, opts?: { edition?: string; exclude_upc?: string; exclude_name?: string; exclude_vintage?: string }) =>
    request<{ edition: string | null; rip_code: string; items: Product[]; tiers?: RipSheetTier[] }>(
      `/api/catalog/rip-siblings/${encodeURIComponent(wholesaler)}/${encodeURIComponent(ripCode)}${qs(opts ?? {})}`
    ),
  // Every UPC that is the SAME product across sizes (spirits: enrichment /
  // catalog-name core grouping; wine: returns [] -> caller groups by name).
  productVariantUpcs: (wholesaler: string, name: string, opts?: { upc?: string }) =>
    request<{ upcs: string[]; core: string | null; edition: string | null; mode?: string }>(
      `/api/catalog/product-variant-upcs/${encodeURIComponent(wholesaler)}/${encodeURIComponent(name)}${qs(opts ?? {})}`
    ),
  aiQuery: (question: string, history?: AiChatTurn[]) =>
    request<CatalogAiResponse>('/api/catalog/ai-query', {
      method: 'POST',
      body: JSON.stringify({ question, history }),
    }),
};

// One prior turn of a conversation, sent back to the assistant for memory.
export interface AiChatTurn { role: 'user' | 'assistant'; content: string }

// ---- Celar AI Assistant (full page): Q&A + charts + actions ----
export interface AssistantChart {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  labels: (string | number)[];
  series: { name?: string; data: number[] }[];
}
export interface AssistantRipCluster {
  rip_code: string;
  wholesaler: string;
  label: string;            // 'Allied RIP 112074'
  member_count: number;     // distinct SKUs in the Case Mix
  description?: string | null;
  // Deep link into the Catalog page filtered to this cluster's UPCs (with
  // group_by_rip on), so the user can jump from chat to the catalog view of
  // the same Case Mix in one click. NULL when the cluster has no resolvable
  // members for the deep link.
  catalog_url?: string | null;
}

export interface AssistantResponse {
  answer: string;             // markdown (chart fences already stripped server-side)
  charts: AssistantChart[];
  actions: CatalogAiAction[];
  products: CatalogAiProduct[];   // surfaced products, rendered as actionable cards
  // One entry per RIP cluster surfaced this turn. The chat renders an "Add
  // Case Mix to Cart" button per cluster (the full member list is resolved
  // server-side via cart.addByRip, not shipped in the response).
  rip_clusters?: AssistantRipCluster[];
  // When set, the assistant drove the SCREEN: navigate here (page shows the data)
  // and keep the chat message to a one-line confirmation.
  screen?: { path: string; label: string } | null;
  usage: AiUsage;
}
export const assistant = {
  ask: (question: string, history?: AiChatTurn[], page?: string, pagePath?: string, pageQuery?: string) =>
    request<AssistantResponse>('/api/assistant/ask', {
      method: 'POST',
      body: JSON.stringify({ question, history, page, page_path: pagePath, page_query: pageQuery }),
    }),
};

// ---- CELR.AI Assistant chat history (server-side, per user) ----
// Lightweight list row (no message bodies) used by the history panel.
export interface ChatSessionMeta {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}
// Full session: meta + the transcript. Messages are stored/returned verbatim
// as the UI's message objects (role/text plus charts/products/usage), so the
// caller casts them to its own Msg type.
export interface ChatSessionFull extends ChatSessionMeta {
  messages: unknown[];
}
export const assistantSessions = {
  list: () => request<ChatSessionMeta[]>('/api/assistant/sessions'),
  create: () => request<ChatSessionMeta>('/api/assistant/sessions', { method: 'POST' }),
  get: (id: number) => request<ChatSessionFull>(`/api/assistant/sessions/${id}`),
  // Persist the whole transcript; pass title only when (re)deriving the label.
  save: (id: number, messages: unknown[], title?: string) =>
    request<{ status: string }>(`/api/assistant/sessions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ messages, title }),
    }),
  rename: (id: number, title: string) =>
    request<{ status: string }>(`/api/assistant/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  remove: (id: number) =>
    request<{ status: string }>(`/api/assistant/sessions/${id}`, { method: 'DELETE' }),
};

// ---- AI assistant rating (thumbs up/down on each reply) ----
export interface AiFeedbackIn {
  surface: string;                 // 'celar' | 'global-dock' | 'catalog' | ...
  rating: 'good' | 'bad';
  question?: string;
  answer?: string;
  details?: string;                // user-typed reason on a Bad rating
  page?: string;
  model?: string;
  user_agent?: string;
}
export const aiFeedback = {
  submit: (body: AiFeedbackIn) =>
    request<{ status: string }>('/api/ai-feedback', {
      method: 'POST',
      body: JSON.stringify({ ...body, user_agent: navigator.userAgent }),
    }),
};

// Token + dollar accounting returned with every AI assistant answer.
export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  model: string;
  cost_usd: number;
  enabled: boolean;
}
// A product the assistant resolved server-side for an action to act on.
// When the assistant returns 3+ products, the backend enriches each row with
// `discount_tiers` / `rip_tiers` / `tiers` so the chat can render a full
// side-by-side comparison table. Frontline price is included so the table
// can show list/effective/savings columns.
export interface AssistantTier {
  source: 'discount' | 'rip';
  qty: number;
  unit: string;
  amount: number;
  save_per_case?: number | null;
  price_after?: number | null;
  description?: string | null;
}
export interface CatalogAiProduct {
  product_name: string;
  wholesaler: string;
  upc?: string | null;
  abg_sku?: string | null;
  unit_volume?: string | null;
  unit_qty?: string | null;
  unit_type?: string | null;
  vintage?: string | null;
  effective_case_price?: number | null;
  frontline_case_price?: number | null;
  edition?: string | null;
  tiers?: AssistantTier[];
  discount_tiers?: AssistantTier[];
  rip_tiers?: AssistantTier[];
  // 3-month sparkline history (1-case-discount + best-RIP).
  price_3mo?: Price3moBlock[] | null;
  // Next-edition data for the this->next pricing sparkline.
  next_tiers?: AssistantTier[];
  next_effective_case_price?: number | null;
  // Deal-radar: month-over-month change (prior vs current edition) + best time to
  // buy. Attached to every product result by backend deal_compare.
  rip_now?: number | null;
  rip_prior?: number | null;
  rip_change?: 'gained' | 'lost' | 'up' | 'down' | 'same' | 'none';
  casedisc_now?: number | null;
  casedisc_prior?: number | null;
  disc_change?: 'gained' | 'lost' | 'up' | 'down' | 'same' | 'none';
  combo_now?: boolean;
  combo_prior?: boolean;
  combo_change?: 'gained' | 'lost' | 'up' | 'down' | 'same' | 'none';
  best_buy_window?: string | null;
  best_buy_saving?: number | null;
}
export type CatalogAiActionType = 'add_to_cart' | 'update_quantity' | 'add_to_favorites' | 'add_to_list' | 'remove_from_cart' | 'swap_distributor' | 'submit_order' | 'reorder' | 'message_rep' | 'set_order_note' | 'assign_rep' | 'create_rep';
export interface CatalogAiAction {
  type: CatalogAiActionType;
  cases: number;
  bottles: number;
  list_name?: string | null;
  products: CatalogAiProduct[];
  note?: string | null;
  // swap_distributor only: replace cart items from one distributor with the other.
  from_distributor?: string | null;
  to_distributor?: string | null;
  rip_code?: string | null;
  swap_upcs?: string[] | null;
  // reorder only: the past order to copy back into the cart.
  order_id?: number | null;
  // message_rep only: email a sales rep a free-text question.
  rep_id?: number | null;
  message?: string | null;
  // set_order_note only: header note for the order at `distributor`.
  distributor?: string | null;
  order_note?: string | null;
  // create_rep only: a new sales rep to create + assign to `distributor`.
  rep_name?: string | null;
  rep_email?: string | null;
  rep_phone?: string | null;
}
export interface CatalogAiResponse {
  answer: string;
  q: string;
  filters: {
    hasRip?: boolean | null;
    hasDiscount?: boolean | null;
    inCombo?: boolean;
    priceTrend?: 'drop' | 'increase' | null;
    divisions: string[];
    categories: string[];
    brands: string[];
    sizes: string[];
    priceMin?: number | null;
    priceMax?: number | null;
  };
  sort: 'product_name' | 'frontline_case_price' | 'effective_case_price';
  order: 'asc' | 'desc';
  actions: CatalogAiAction[];
  usage: AiUsage;
}

// ---- Web price search (retail pricing from nearby stores) ----
export interface WebSearchResult {
  title: string | null; price: string | null; extracted_price: number | null;
  store: string | null; link: string | null; thumbnail: string | null;
  rating: number | null; reviews: number | null; delivery: string | null;
}
export interface WebSearchLink { label: string; url: string; why: string }
export interface WebInfoResult { title: string | null; snippet: string | null; link: string | null; source: string | null }
export interface WebSearchResponse {
  query: string; is_wine: boolean; vintage: string | null; unit_volume: string | null;
  location: string | null; live: boolean;
  results: WebSearchResult[]; links: WebSearchLink[];
  info_links: WebSearchLink[]; info_results: WebInfoResult[];
  note: string;
}
export const websearch = {
  product: (params: Record<string, unknown>) =>
    request<WebSearchResponse>(`/api/websearch/product${qs(params)}`),
};

export interface ProductBreakdownEdition {
  edition: string;
  upc: string;
  vintage: string | null;
  unit_volume: string;
  rip_code: string | null;
  frontline_case_price: number;
  frontline_unit_price: number | null;
  best_case_price: number | null;
  effective_case_price: number | null;
  best_discount_per_case: number;
  best_rip_per_case: number;
  total_save_per_case: number;
  has_discount: boolean;
  has_rip: boolean;
  discount_tiers: { qty: number; unit: string; amount: number }[];
  rip_tiers: { qty: number; unit: string; amount: number; save_per_case: number }[];
  // Deepest quantity-discount bracket for the card sticker (RIP excluded).
  best_qd?: {
    cases: number | null;        // cases to unlock the best QD
    case_price: number;          // best case price
    bottle_price: number | null; // best per-bottle cost
    save_per_case: number;       // $/case saved vs frontline
    total_cost: number | null;   // cases * case_price
    total_save: number | null;   // cases * save_per_case
  } | null;
}

// Go-UPC enrichment for a product (image + canonical details), matched by UPC.
export interface ProductEnrichment {
  name: string | null;
  brand: string | null;
  category: string | null;
  category_path: string[] | null;
  description: string | null;
  region: string | null;
  specs: Record<string, string> | null;
  ean: string | null;
  code_type: string | null;
  barcode_url: string | null;
  inferred: boolean;
  image_url: string | null;
  image_source: string | null;
}

// ---- Analytics ----
export const analytics = {
  dashboard: (params?: Record<string, unknown>) =>
    request<DashboardKPIs>(`/api/analytics/dashboard${qs(params ?? {})}`),
  priceMovers: (params?: Record<string, unknown>) =>
    request<PriceMover[]>(`/api/analytics/price-movers${qs(params ?? {})}`),
  priceMoverEditions: (direction: 'up' | 'down') =>
    request<string[]>(`/api/analytics/price-mover-editions?direction=${direction}`),
  lifecycle: (params?: Record<string, unknown>) =>
    request<LifecycleEvent[]>(`/api/analytics/lifecycle${qs(params ?? {})}`),
  crossSource: (params?: Record<string, unknown>) =>
    request<CrossSourceLink[]>(`/api/analytics/cross-source${qs(params ?? {})}`),
  categoryTrends: (params?: Record<string, unknown>) =>
    request<CategoryTrend[]>(`/api/analytics/category-trends${qs(params ?? {})}`),
};

// ---- QA (agentic data-quality scan) ----
export interface QaFinding {
  check: string;
  severity: 'high' | 'medium' | 'low';
  wholesaler: string;
  product_name: string;
  upc: string | null;
  unit_volume: string | null;
  vintage: string | null;
  variance_pct: number | null;
  observed: Record<string, unknown>;
  root_cause: string;
  root_cause_detail: string;
  evidence: Record<string, unknown>;
  suggested_fix: string;
}
export interface QaSummary {
  total: number;
  by_severity: Record<string, number>;
  by_root_cause: Record<string, number>;
  by_check?: Record<string, number>;
}
export interface QaScan {
  threshold: number;
  generated_at: string;
  wholesaler?: string | null;
  checks_run?: string[];
  summary: QaSummary;
  findings: QaFinding[];
}
export const qa = {
  scan: (params?: Record<string, unknown>) =>
    request<QaScan>(`/api/qa/scan${qs(params ?? {})}`),
  summary: (params?: Record<string, unknown>) =>
    request<Omit<QaScan, 'findings'>>(`/api/qa/summary${qs(params ?? {})}`),
};

// ---- Deals ----
export const deals = {
  discounts: (params?: Record<string, unknown>) =>
    request<Product[]>(`/api/deals/discounts${qs(params ?? {})}`),
  clearance: (params?: Record<string, unknown>) =>
    request<Product[]>(`/api/deals/clearance${qs(params ?? {})}`),
  combos: (params?: Record<string, unknown>) =>
    request<Combo[]>(`/api/deals/combos${qs(params ?? {})}`),
  comboIndex: () =>
    request<{ items: { wholesaler: string; upc: string; upc_norm: string; combo_code: string }[] }>(
      '/api/deals/combo-index'),
  rips: (params?: Record<string, unknown>) =>
    request<RipPromo[]>(`/api/deals/rips${qs(params ?? {})}`),
  ripProducts: (params?: Record<string, unknown>) =>
    request<{ total: number; items: RipProduct[] }>(`/api/deals/rip-products${qs(params ?? {})}`),
  timeSensitive: (params?: Record<string, unknown>) =>
    request<TimeSensitiveDeal[]>(`/api/deals/time-sensitive${qs(params ?? {})}`),
};

// ---- Compare Prices (2-3 distributors, common UPCs only) ----
export interface CompareOption {
  wholesaler: string;
  edition: string | null;
  products: number;
}

export interface ComparePrice {
  upc: string | null;
  edition: string;
  product_name: string;
  item_no?: string | null;   // distributor's own catalogue number (Allied/Fedway)
  frontline: number | null;
  after_qd: number | null;
  effective: number | null;
  btl_effective: number | null;
  rip_savings: number | null;
  // $/case the best QD takes off list (null when there's no QD).
  qd_save?: number | null;
  // Prices are computed LIVE for today. qd_time_sensitive = the deal driving
  // Best QD is a dated promo that ENDS this month (window active now), so the
  // buyer should know it won't last. deal_window carries its dates + status.
  qd_time_sensitive?: boolean;
  deal_window?: { from: string | null; to: string | null; status: WindowStatus } | null;
  has_discount: boolean;
  has_rip: boolean;
  // Prior-edition price layers (present only when fetched with months=2), for
  // the two-month Price Comparison view.
  prev?: {
    edition: string | null;
    frontline: number | null;
    after_qd: number | null;
    effective: number | null;
    btl_effective: number | null;
  } | null;
}

export interface CompareRow {
  match_key: string;
  edition?: string;                 // representative monthly edition (comment key)
  has_comment?: boolean;            // an admin flagged/commented this row
  comment?: string | null;          // the admin comment (admin only)
  verified?: boolean;               // admin confirmed this match for the pair (admin only)
  upc_norm: string;
  size_key: string;
  product_name: string;
  product_type: string | null;
  brand: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_volume_std?: string | null;   // standardized size bucket (750ML, 1.75L, ...)
  unit_type: string | null;
  vintage: string | null;
  upc: string | null;
  prices: Record<string, ComparePrice>;
  winner_frontline: string | null;
  winner_after_qd: string | null;
  winner_effective: string | null;
  spread: number | null;
  spread_pct: number | null;
  deal_flip: boolean;
  // At least one distributor's live price rides on a dated deal that ENDS this
  // month — surfaced so the buyer knows today's price won't last.
  has_expiring?: boolean;
}

export interface CompareSummary {
  common_products: number;
  wins_effective: Record<string, number>;
  wins_frontline: Record<string, number>;
  ties: number;
  deal_flips: number;
  total_spread: number;
  top_spreads: { product_name: string; spread: number | null; winner: string | null; unit_volume: string | null }[];
  by_type: Record<string, Record<string, number>>;
  insights: string[];
}

export interface CompareResponse {
  wholesalers: string[];
  editions: Record<string, string>;
  prev_editions?: Record<string, string>;
  next_available?: boolean;          // a next-month edition is loaded for some distributor
  month_mode?: string;               // 'cur' | 'next' — which month the board compared at
  pair?: string;                     // sorted slugs identifying this comparison (verified key)
  total_common: number;
  cases?: number;
  volume_basis?: 'at_volume' | 'best_deal';
  rows: CompareRow[];
  summary: CompareSummary;
}

export interface CompareLadder {
  product_name: string | null;
  upc: string | null;
  edition: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  vintage: string | null;
  abv_proof?: string | null;     // proof / ABV — distinguishes e.g. cask-strength SKUs
  product_type?: string | null;
  abg_sku?: string | null;   // distributor's own item number (Allied ABG / Fedway)
  abg_item_name?: string | null;  // distributor's own item NAME (Allied sheet name)
  frontline: number | null;
  after_qd: number | null;
  effective: number | null;
  tiers: CatalogTier[];
}

export const compare = {
  options: () => request<CompareOption[]>('/api/compare/options'),
  products: (params: Record<string, unknown>) =>
    request<CompareResponse>(`/api/compare/products${qs(params)}`),
  // Admin: add/replace (or clear, with empty comment) a row comment. A commented
  // row is hidden by the default High-confidence filter.
  setRowComment: (body: { edition: string; match_key: string; comment: string; product_name?: string | null }) =>
    request<{ status: string }>('/api/compare/row-comment', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Admin: mark/clear a row as verified (the two matched items look correct) for
  // this exact (edition, pair). Header/pair-specific, admin-only.
  setRowVerified: (body: { edition: string; pair: string; match_key: string; verified: boolean; product_name?: string | null }) =>
    request<{ status: string }>('/api/compare/row-verified', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  tiers: (params: Record<string, unknown>) =>
    request<{ wholesalers: string[]; ladders: Record<string, CompareLadder> }>(
      `/api/compare/tiers${qs(params)}`),
  // Summary grid as an .xlsx download (same filters as products()).
  exportXlsx: async (params: Record<string, unknown>): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/compare/export${qs(params)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },
  rips: (params: Record<string, unknown>) =>
    request<CompareRipResponse>(`/api/compare/rips${qs(params)}`),
  qds: (params: Record<string, unknown>) =>
    request<CompareQDResponse>(`/api/compare/qds${qs(params)}`),
  price360: (params: Record<string, unknown>) =>
    request<Price360Response>(`/api/compare/price360${qs(params)}`),
  rateshop: (params: Record<string, unknown>) =>
    request<RateShopResponse>(`/api/compare/rateshop${qs(params)}`),
  basket: (source: string) =>
    request<BasketResponse>(`/api/compare/basket?source=${source}`),
  editionOptions: (wholesaler: string) =>
    request<EditionOptions>(`/api/compare/editions/options?wholesaler=${wholesaler}`),
  editions: (params: Record<string, unknown>) =>
    request<EditionCompareResponse>(`/api/compare/editions${qs(params)}`),
  // Sparkline (price_3mo) for a batch of UPCs — the comparison card view's
  // visible page only. Returns { upc: Price3moBlock[] }.
  editionSparklines: (wholesaler: string, upcs: string[]) =>
    request<Record<string, Price3moBlock[]>>(
      `/api/compare/editions/sparklines?wholesaler=${encodeURIComponent(wholesaler)}&upcs=${encodeURIComponent(upcs.join(','))}`),
  bestRips: (params?: Record<string, unknown>) =>
    request<BestRipResponse>(`/api/compare/best-rips${qs(params)}`),
  bestQd: (params?: Record<string, unknown>) =>
    request<BestQdResponse>(`/api/compare/best-qd${qs(params)}`),
};

// ---- Best RIPs board (Allied / Fedway / Opici) ----
export interface BestRipTier {
  buy_label: string | null;        // '2 cs' / '3 btl' — the qualifying buy
  cases: number | null;            // physical cases to unlock
  code: string | null;
  unit: string | null;
  rebate_per_case: number | null;  // RIP-only $/case
  total_rebate: number | null;     // cases * rebate_per_case (the '/$100' in '2C / $100')
  after_qd_per_case: number | null;// list - QD at this volume (net of QD, before RIP)
  price_after: number | null;      // after QD + this RIP
  needed_for_purchase: number | null; // cases * after_qd_per_case — cash you put down
  rip_profit_pct: number | null;   // rebate / needed * 100 — return on cash down
  window_status: string | null;
  is_time_sensitive: boolean;
  from_date: string | null;
  to_date: string | null;
}
export interface BestRipDist {
  carried: boolean;                // false = doesn't stock this SKU at all
  has_rip: boolean;                // false = carries the SKU but no RIP this edition
  rip_code: string | null;
  frontline: number | null;
  case_mix: number | null;
  deepest_rebate: number | null;
  deepest_at_cases: number | null;
  min_cases: number | null;
  best_profit_pct: number | null;
  active_days: number | null;
  expires_in_days: number | null;
  has_time_sensitive: boolean;
  tiers: BestRipTier[];
  unit_qty: string | null;
  unit_volume: string | null;
  item_no?: string | null;           // distributor item number (Fedway/Allied) for availability search
}
export interface BestRipTrend {
  this: number | null;             // deepest full-month rebate $/cs, this calendar month
  last: number | null;             // ... last month
  next: number | null;             // ... next month (null until loaded)
  this_ed: string;                 // YYYY-MM for each slot, for labels
  last_ed: string;
  next_ed: string;
  best: 'this' | 'last' | 'next' | null;  // where the better RIP is (null = no comparison)
}
export interface BestRipRow {
  match_key: string;
  edition: string;                 // YYYY-MM this card's RIP is from
  upc_norm: string;
  size_key: string;
  product_name: string;
  product_type: string | null;
  brand: string | null;
  vintage: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_type: string | null;
  upc: string | null;
  image_url: string | null;        // Go-UPC product image (R2 CDN)
  dists: Record<string, BestRipDist>;
  ripping: string[];               // distributors that file a RIP
  missing: string[];               // carry the SKU, no RIP this edition
  not_carried: string[];           // don't stock the SKU at all
  best_distributor: string | null; // highest RIP profit %
  best_profit_pct: number | null;
  profit_delta: number | null;     // winner's lead over the runner-up (pp)
  profit_gap: number | null;       // spread between RIPing distributors (pp)
  deepest_rebate: number | null;
  timing_differs: boolean;
  quantity_differs: boolean;
  differs: boolean;
  soonest_expiry: number | null;   // days to the nearest dated RIP ending
  rip_trend: BestRipTrend;
}
export interface BestRipResponse {
  wholesalers: string[];
  months: string[];                // selected editions shown
  available_months: string[];      // all loaded editions, newest first
  total: number;
  rows: BestRipRow[];
}

// ---- Best QD board (quantity discounts; Allied / Fedway / Opici) ----
// A QD is a straight price cut at a volume threshold (no rebate comes back),
// so the headline metric is the discount % off the list case price.
export interface BestQdTier {
  buy_label: string | null;        // '2 cs' / '3 btl' — the qualifying buy
  cases: number | null;            // physical cases to unlock
  code: string | null;
  unit: string | null;
  discount_per_case: number | null;// $/case off the list case price
  price_after: number | null;      // list case price after this discount
  price_after_btl: number | null;  // that, per bottle
  discount_pct: number | null;     // discount_per_case / frontline * 100 — % off list
  total_save: number | null;       // cases * discount_per_case at the qualifying buy
  window_status: string | null;
  is_time_sensitive: boolean;
  from_date: string | null;
  to_date: string | null;
}
export interface BestQdDist {
  carried: boolean;                // false = doesn't stock this SKU at all
  has_qd: boolean;                 // false = carries the SKU but no QD this edition
  frontline: number | null;
  deepest_discount: number | null; // deepest $/case at any volume
  deepest_at_cases: number | null;
  min_cases: number | null;        // fewest cases to unlock any QD
  best_discount_pct: number | null;
  active_days: number | null;
  expires_in_days: number | null;
  has_time_sensitive: boolean;
  tiers: BestQdTier[];
  unit_qty: string | null;
  unit_volume: string | null;
  item_no?: string | null;           // distributor item number (Fedway/Allied) for availability search
}
export interface BestQdTrend {
  this: number | null;             // deepest full-month QD $/cs, this calendar month
  last: number | null;             // ... last month
  next: number | null;             // ... next month (null until loaded)
  this_ed: string;                 // YYYY-MM for each slot, for labels
  last_ed: string;
  next_ed: string;
  best: 'this' | 'last' | 'next' | null;  // where the better QD is (null = no comparison)
}
export interface BestQdRow {
  match_key: string;
  edition: string;                 // YYYY-MM this card's QD is from
  upc_norm: string;
  size_key: string;
  product_name: string;
  product_type: string | null;
  brand: string | null;
  vintage: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_type: string | null;
  upc: string | null;
  image_url: string | null;        // Go-UPC product image (R2 CDN)
  dists: Record<string, BestQdDist>;
  discounting: string[];           // distributors that file a QD
  missing: string[];               // carry the SKU, no QD this edition
  not_carried: string[];           // don't stock the SKU at all
  best_distributor: string | null; // deepest discount %
  best_discount_pct: number | null;
  discount_delta: number | null;   // winner's lead over the runner-up (pp)
  discount_gap: number | null;     // spread between discounting distributors (pp)
  deepest_discount: number | null;
  timing_differs: boolean;
  quantity_differs: boolean;
  differs: boolean;
  soonest_expiry: number | null;   // days to the nearest dated QD ending
  qd_trend: BestQdTrend;
}
export interface BestQdResponse {
  wholesalers: string[];
  months: string[];                // selected editions shown
  available_months: string[];      // all loaded editions, newest first
  total: number;
  rows: BestQdRow[];
}

// ---- Edition comparison ----
export interface EditionOptions {
  wholesaler: string; editions: string[];
  default_newer: string | null; default_older: string | null; single_edition: boolean;
}
export interface EditionRow {
  ident: string;
  status: 'both' | 'added' | 'removed';
  comparable: boolean;
  product_name: string;
  unit_volume: string | null;
  unit_qty: string | null;
  unit_type: string | null;
  product_type: string | null;
  upc: string | null;
  dist_item_no?: string | null;
  // Distributor catalogue number for the wholesale availability search
  // (dist_item_no for Fedway, abg_sku for Allied — resolved server-side).
  item_no?: string | null;
  net_a_case?: number | null;
  net_b_case?: number | null;
  net_a_btl?: number | null;
  net_b_btl?: number | null;
  net_delta_case: number | null;
  net_delta_pct?: number | null;
  net_delta_btl?: number | null;
  frontline_a?: number | null;
  frontline_b?: number | null;
  invoice_a?: number | null;
  invoice_b?: number | null;
  rip_a?: number | null;
  rip_b?: number | null;
  layers: string[];
  // Go-UPC thumbnail (attached server-side by UPC) for the card view.
  image_url?: string | null;
  vintage?: string | number | null;
  // 3-month sparkline blocks, lazy-loaded for the visible card page only via
  // compare.editionSparklines (merged into the row client-side).
  price_3mo?: Price3moBlock[] | null;
}
export interface EditionCompareResponse {
  wholesaler: string;
  single_edition: boolean;
  note?: string;
  older?: string;
  newer?: string;
  editions?: string[];
  scope?: string;
  total?: number;
  summary?: { rose: number; fell: number; unchanged: number; added: number; removed: number; rip_changed: number; not_comparable: number };
  rows?: EditionRow[];
}

// ---- Price 360 (holistic per-product net-cost label) ----
// ---- Basket rate shopping (optimal split vs single-sourcing) ----
export interface BasketLine {
  product_name: string;
  unit_volume: string | null;
  qty: number;
  upc: string | null;
  prices: Record<string, number>;
  best_w: string | null;
  best_net: number | null;
  current_w: string;
  no_match: boolean;
  saving_vs_current?: number;
}
export interface BasketResponse {
  found: boolean;
  source: string;
  note?: string;
  line_count?: number;
  split_total?: number;
  split_distributors?: string[];
  current_total?: number;
  saving_vs_current?: number;
  best_single?: { wholesaler: string; total: number; covered: number; covers_all: boolean } | null;
  saving_vs_single?: number | null;
  single_source?: { wholesaler: string; total: number; covered: number; covers_all: boolean }[];
  lines?: BasketLine[];
}

// ---- Rate Shop (clarity-first: net-at-volume + conditions + break-even) ----
export interface RateShopCondition { type: string; text: string }
export interface RateShopOffer {
  wholesaler: string;
  edition: string | null;
  product_name: string | null;
  upc: string | null;
  sku: string | null;
  frontline_case: number | null;
  frontline_btl: number | null;
  net_case: number | null;
  net_btl: number | null;
  savings_case: number;
  savings_pct: number;
  applied_kind: string | null;
  applied_code: string | null;
  timing: { dir: 'drop' | 'rise'; next_case: number; delta: number } | null;
  conditions: RateShopCondition[];
  stretch: { to_cases: number; extra_per_case: number; price_after: number } | null;
  case_mix: number | null;
  single_sku: boolean;
  compliance: { flags: string[]; pre_approval: boolean };
  abv_proof: string | null;
  qd_tiers: Price360Tier[];
  rip_tiers: Price360Tier[];
  rank: number;
  is_winner: boolean;
}
export interface RateShopResponse {
  found: boolean;
  note?: string;
  cases?: number;
  size_key?: string;
  proof_warning?: boolean;
  available_sizes?: { match_key: string; size_key: string; unit_volume: string | null; unit_qty: string | null; vintage: string | null; n_distributors: number }[];
  product?: { product_name: string; upc: string | null; unit_volume: string | null; unit_qty: string | null; unit_type: string | null; abv_proof: string | null; product_type: string | null; brand: string | null };
  tie?: boolean;
  verdict?: string;
  breakeven?: { from: number; to: number | null; winner: string | null }[];
  curve?: { cases: number; net: Record<string, number | null>; winner: string | null }[];
  offers?: RateShopOffer[];
}

export interface Price360Tier {
  cases_to_unlock: number | null;
  buy_label: string | null;
  code: string | null;
  raw_qty: number | null;
  unit: string | null;
  save_per_case: number | null;
  price_after: number | null;
  price_after_btl: number | null;
  window_status: string | null;
  is_time_sensitive: boolean;
  from_date: string | null;
  to_date: string | null;
}
export interface Price360Offer {
  wholesaler: string;
  edition: string | null;
  product_name: string | null;
  upc: string | null;
  frontline_case: number | null;
  frontline_btl: number | null;
  invoice_case: number | null;
  invoice_btl: number | null;
  net_case: number | null;
  net_btl: number | null;
  next_net_case: number | null;   // next month's effective case price, when loaded
  rip_rebate_full: number;
  rip_rebate_credited: number;
  savings_case: number;
  savings_pct: number;
  reachability: { status: string; likelihood: number; credited_rebate: number; qualifying: number | null; typical: number | null };
  divergence: boolean;
  compliance: { flags: string[]; pre_approval: boolean };
  case_mix: number | null;
  single_sku: boolean;
  abv_proof: string | null;
  unit_volume: string | null;
  unit_qty: string | null;
  qd_tiers: Price360Tier[];
  rip_tiers: Price360Tier[];
  full_month: boolean;
  value_score: number;
  score_breakdown: { net_cost: number; savings: number; stability: number; compliance: number; weights: Record<string, number> };
  rank: number;
  is_winner: boolean;
  rebate_misleads: boolean;
}
export interface Price360Response {
  found: boolean;
  note?: string;
  match?: string;
  product?: {
    product_name: string; upc: string | null; unit_volume: string | null;
    unit_qty: string | null; unit_type: string | null; abv_proof: string | null; product_type: string | null; brand: string | null;
  };
  comparability?: string;
  proof_warning?: boolean;
  reach_mode?: string;
  weights?: Record<string, number>;
  tie?: boolean;
  n_winners?: number;
  size_key?: string;
  available_sizes?: { match_key: string; size_key: string; unit_volume: string | null; unit_qty: string | null; vintage: string | null; n_distributors: number }[];
  offers?: Price360Offer[];
}

// ---- Compare RIPs (RIP outcome across 2-3 distributors) ----
export interface RipTierRow {
  cases_to_unlock: number | null;
  buy_label: string | null;
  code: string | null;
  raw_qty: number | null;
  unit: string | null;
  rebate_per_case: number | null;
  total_rebate: number | null;   // the SHEET's total rebate $ at this tier (whole, authoritative)
  price_after: number | null;
  window_status: string | null;
  is_time_sensitive: boolean;
  from_date: string | null;
  to_date: string | null;
  // Case-credit model (FOUNDATION 3.4.1): set only when a half-case rule
  // matched. cases_to_unlock / buy_label above already reflect the REAL
  // physical buy-in; these fields let the UI explain why it differs from
  // raw_qty.
  case_credit?: number | null;
  split_pack?: number | null;
  split_credit?: number | null;
}
export interface CompareRipDist {
  frontline: number | null;
  item_no?: string | null;          // distributor's own catalogue number (Fedway / Allied ABG)
  edition?: string | null;          // source edition (for the next-month label)
  next_net_case?: number | null;    // next month's effective case price, when loaded
  abv_proof: string | null;
  vintage: string | null;       // this distributor's own vintage (4-digit), for the card
  landed_at_n: number | null;
  landed_at_1: number | null;
  rip_at_1: number | null;
  rip_at_n: number | null;
  rip_btl_at_1: number | null;
  rip_btl_at_n: number | null;
  min_cases: number | null;
  case_mix: number | null;
  is_combination: boolean;
  // richer comparison metrics
  deepest_rebate: number | null;        // best $/cs rebate at any volume
  deepest_at_cases: number | null;      // cases to reach it
  active_days: number | null;           // days this month a RIP is live
  expires_in_days: number | null;       // urgency; null = durable / nothing live
  has_time_sensitive: boolean;          // a dated/time-limited window exists
  has_upcoming: boolean;                // a deeper RIP starts later this month
  total_rebate_at_n: number | null;     // total $ back at the chosen volume
  effective_pct: number | null;         // rebate as % of list
  pre_approval: boolean;                // NJ ABC statute flag
  compliance_flags: string[];
  unlock_cases: number | null;          // cases to unlock the first RIP tier
  unlock_investment: number | null;     // cash you put down to buy those cases
  unlock_rebate_total: number | null;   // money back at that first tier
  rip_gaps: { from: string; to: string; days: number }[];
  rip_tiers: RipTierRow[];
  rip_code: string | null;
  product_name: string | null;
  upc: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_type: string | null;
}
export interface RipBreakeven { from: number; to: number | null; winner: string | null }
export interface RipCurvePoint { cases: number; landed: Record<string, number | null>; winner: string | null }
export interface CompareRipRow {
  match_key: string;
  upc_norm: string;
  size_key: string;
  product_name: string;
  product_type: string | null;
  vintage: string | null;
  brand: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_type: string | null;
  proof_match: boolean;
  dists: Record<string, CompareRipDist>;
  winner_at_n: string | null;
  spread_at_n: number | null;
  left_on_table: number | null;   // total $ overpaid at the chosen volume vs cheapest
  breakeven: RipBreakeven[];
  curve: RipCurvePoint[];
  flips: boolean;
  has_difference: boolean;
  data_anomaly: boolean;          // same UPC, very different list prices = likely pack mismatch
  anomaly_reason: string;
  timing_differs: boolean;        // distributors differ on rebate timing (dated vs all-month)
  quantity_differs: boolean;      // distributors differ on cases needed to unlock
  rip_terms_differ: boolean;      // RIP terms differ (investment to unlock / mix / qty)
  better_terms_tie: boolean;      // price ~tie but RIP terms differ (same price, better terms)
  verdict: { pick: string | null; text: string };
}
export interface CompareRipResponse {
  wholesalers: string[];
  editions: Record<string, string>;
  month_mode?: string;              // 'cur' | 'next' — which month the board compared at
  next_available?: boolean;         // a next-month edition is loaded for some distributor
  cases: number;
  total_common: number;
  rows: CompareRipRow[];
  summary: {
    common_rip_products: number;
    wins_at_n: Record<string, number>;
    ties: number;
    flips: number;
    least_money: Record<string, number>;
    most_active_days: Record<string, number>;
    most_case_mix: Record<string, number>;
    anomalies_hidden: number;
    insights: string[];
  };
}

// ---- Compare QD (quantity-discount outcome across 2-3 distributors) ----
// A QD is cash off the buy price TODAY (no rebate comes back later), so there's
// ONE discount ladder per product (no RIP code, no mix-to-qualify, no combo).
// Mirrors the RIP shapes above with QD-flavoured field names.
export interface QDTierRow {
  cases_to_unlock: number | null;
  buy_label: string | null;
  code: string | null;
  raw_qty: number | null;
  unit: string | null;
  rebate_per_case: number | null;   // PER-CASE discount $ off list at this tier
  total_rebate: number | null;      // the SHEET's per-tier amount (== per-case for a 1-tier QD)
  price_after: number | null;       // list case price after this discount
  window_status: string | null;
  is_time_sensitive: boolean;
  from_date: string | null;
  to_date: string | null;
  case_credit?: number | null;
  split_pack?: number | null;
  split_credit?: number | null;
}
export interface CompareQDDist {
  frontline: number | null;
  item_no?: string | null;
  edition?: string | null;
  next_net_case?: number | null;
  abv_proof: string | null;
  vintage: string | null;
  landed_at_n: number | null;       // buy price/case after best QD at N cases
  landed_at_1: number | null;       // buy price/case after a 1-case QD (the headline)
  qd_at_1: number | null;           // per-case discount at 1 case
  qd_at_n: number | null;           // per-case discount at N cases
  qd_btl_at_1: number | null;
  qd_btl_at_n: number | null;
  min_cases: number | null;
  deepest_discount: number | null;  // best $/cs discount at any volume
  deepest_at_cases: number | null;
  active_days: number | null;
  expires_in_days: number | null;
  has_time_sensitive: boolean;
  has_upcoming: boolean;
  total_discount_at_n: number | null;
  effective_pct: number | null;     // discount as % of list
  unlock_cases: number | null;      // cases to unlock the first QD tier
  unlock_investment: number | null; // cash to buy those cases (= discounted price)
  unlock_savings: number | null;    // $ saved at that first tier
  qd_tiers: QDTierRow[];
  product_name: string | null;
  upc: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_type: string | null;
}
export interface QDBreakeven { from: number; to: number | null; winner: string | null }
export interface QDCurvePoint { cases: number; landed: Record<string, number | null>; winner: string | null }
export interface CompareQDRow {
  match_key: string;
  upc_norm: string;
  size_key: string;
  product_name: string;
  product_type: string | null;
  vintage: string | null;
  brand: string | null;
  unit_qty: string | null;
  unit_volume: string | null;
  unit_type: string | null;
  proof_match: boolean;
  dists: Record<string, CompareQDDist>;
  winner_at_n: string | null;
  spread_at_n: number | null;
  left_on_table: number | null;
  breakeven: QDBreakeven[];
  curve: QDCurvePoint[];
  flips: boolean;
  has_difference: boolean;
  data_anomaly: boolean;
  anomaly_reason: string;
  timing_differs: boolean;
  quantity_differs: boolean;
  qd_outcome_differs: boolean;      // the discount ladder (or its timing) differs
  verdict: { pick: string | null; text: string };
}
export interface CompareQDResponse {
  wholesalers: string[];
  editions: Record<string, string>;
  month_mode?: string;
  next_available?: boolean;
  cases: number;
  total_common: number;
  rows: CompareQDRow[];
  summary: {
    common_qd_products: number;
    wins_at_n: Record<string, number>;
    ties: number;
    flips: number;
    least_money: Record<string, number>;
    most_active_days: Record<string, number>;
    most_deepest: Record<string, number>;
    anomalies_hidden: number;
    insights: string[];
  };
}

// ---- Beta feedback ----
export interface FeedbackItem {
  id: number;
  user_id: number | null;
  user_email: string | null;
  kind: string | null;
  message: string;
  page: string | null;
  user_agent: string | null;
  created_at: string;
  attachments?: { url: string; key: string; name?: string }[];
}

export const feedback = {
  // Multipart: text + optional screenshots (stored in R2 server-side).
  submit: (data: { message: string; kind?: string; page?: string; user_agent?: string; screenshots?: File[] }) => {
    const fd = new FormData();
    fd.append('message', data.message);
    if (data.kind) fd.append('kind', data.kind);
    if (data.page) fd.append('page', data.page);
    if (data.user_agent) fd.append('user_agent', data.user_agent);
    for (const f of data.screenshots ?? []) fd.append('screenshots', f, f.name);
    return request<{ status: string; screenshots: number }>('/api/feedback', { method: 'POST', body: fd });
  },
  list: () => request<FeedbackItem[]>('/api/feedback'),                       // admin-only
  remove: (id: number) => request<{ status: string }>(`/api/feedback/${id}`, { method: 'DELETE' }),
};

// ---- Admin ----
export interface AdminStats {
  counts: Record<string, number>;
  feedback_by_kind: { kind: string; n: number }[];
}
export interface AdminUser {
  id: number;
  email: string;
  full_name: string | null;
  phone?: string | null;
  activated: number;
  tos_accepted_at?: string | null;
  created_at: string;
  orders: number;
  stores: number;
  is_admin: boolean;
}

export interface ShareEvent {
  id: number;
  user_email: string | null;
  channel: string | null;
  source: string | null;
  page: string | null;
  created_at: string;
}

export interface AdminUserDetail {
  user: AdminUser & { activated: number; phone?: string | null; tos_accepted_at?: string | null };
  orders: Record<string, unknown>[];
  stores: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  watchlist: Record<string, unknown>[];
  feedback: Record<string, unknown>[];
}

export const admin = {
  stats: () => request<AdminStats>('/api/admin/stats'),
  users: () => request<AdminUser[]>('/api/admin/users'),
  userDetail: (id: number) => request<AdminUserDetail>(`/api/admin/users/${id}`),
  detail: (entity: string) => request<Record<string, unknown>[]>(`/api/admin/detail/${entity}`),
  activateUser: (id: number) => request<{ status: string }>(`/api/admin/users/${id}/activate`, { method: 'POST' }),
  deactivateUser: (id: number) => request<{ status: string }>(`/api/admin/users/${id}/deactivate`, { method: 'POST' }),
  deleteUser: (id: number) => request<{ status: string }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  reloadPricing: () => request<{ status: string; counts: Record<string, number> }>('/api/admin/reload-pricing', { method: 'POST' }),
  // Admin: upload / replace a product's image (stored in R2, overlaid live).
  uploadProductImage: (upc: string, file: File) => {
    const fd = new FormData();
    fd.append('upc', upc);
    fd.append('file', file);
    return request<{ upc: string; image_url: string }>('/api/admin/product-image', { method: 'POST', body: fd });
  },
  // CELR Product Number curation (docs/CELR_PRODUCT_NUMBER_DESIGN.md)
  celrFamilies: (q = '', limit = 50) =>
    request<CelrFamily[]>(`/api/admin/celr/families?q=${encodeURIComponent(q)}&limit=${limit}`),
  celrFamily: (cpn: number) => request<CelrFamilyDetail>(`/api/admin/celr/family/${cpn}`),
  celrMerge: (from_cpn: number, into_cpn: number) =>
    request<{ status: string; into_cpn: number; note: string }>('/api/admin/celr/merge',
      { method: 'POST', body: JSON.stringify({ from_cpn, into_cpn }) }),
  celrUnmerge: (cpn: number) =>
    request<{ status: string; note: string }>('/api/admin/celr/unmerge',
      { method: 'POST', body: JSON.stringify({ cpn }) }),
  celrSplit: (upc_norm: string, header_name?: string) =>
    request<{ status: string; new_cpn: number; celr_product_number: string; note: string }>('/api/admin/celr/split',
      { method: 'POST', body: JSON.stringify({ upc_norm, header_name }) }),
  generateBlurbs: (limit = 50) =>
    request<BlurbGenerateResult>(`/api/admin/blurbs/generate?limit=${limit}`, { method: 'POST' }),
  aiUsage: (params?: { from_date?: string; to_date?: string }) =>
    request<AiUsageReport>(`/api/admin/ai-usage${qs(params ?? {})}`),
  aiFeedback: (params?: { from_date?: string; to_date?: string; rating?: 'good' | 'bad'; surface?: string }) =>
    request<AiFeedbackReport>(`/api/ai-feedback/admin${qs(params ?? {})}`),
  aiFeedbackDelete: (id: number) =>
    request<{ status: string }>(`/api/ai-feedback/${id}`, { method: 'DELETE' }),
};

export interface AiFeedbackPerSurface {
  surface: string;
  good: number;
  bad: number;
  total: number;
}
export interface AiFeedbackRow {
  id: number;
  created_at: string;
  user_email: string;
  surface: string;
  rating: 'good' | 'bad';
  question: string | null;
  answer: string | null;
  details: string | null;
  page: string | null;
  model: string | null;
}
export interface AiFeedbackReport {
  per_surface: AiFeedbackPerSurface[];
  totals: { good?: number; bad?: number; total?: number };
  recent: AiFeedbackRow[];
}

export interface AiUsageRow {
  user_email: string;
  questions: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}
export interface AiUsageRecent {
  created_at: string; user_email: string; surface: string; question: string;
  model: string | null; input_tokens: number; output_tokens: number; cost_usd: number;
}
export interface AiUsageReport {
  per_user: AiUsageRow[];
  totals: { questions?: number; input_tokens?: number; output_tokens?: number; total_tokens?: number; cost_usd?: number };
  recent: AiUsageRecent[];
}

export interface BlurbGenerateResult {
  key_present: boolean;
  client_ok: boolean;
  limit: number;
  candidates?: number;
  deal_written?: number;
  mover_down_written?: number;
  mover_up_written?: number;
  product_written?: number;
  pg_deal_total?: number;
  pg_mover_total?: number;
  pg_product_total?: number;
  // Surface errors (if any) so the admin sees them inline.
  candidates_error?: string;
  deal_error?: string;
  mover_error?: string;
  product_error?: string;
  pg_error?: string;
}

export interface TimeSensitiveDeal {
  wholesaler: string;
  // Edition (YYYY-MM) the deal applies to; surfaced by the API so the
  // card's MonthEffectiveSparkline popover can label its two months.
  edition?: string | null;
  // Vintage year (or 'NV'). Same UPC is reused across vintages and
  // pack sizes, so the card calls it out next to the brand / size.
  vintage?: string | null;
  // Full Discount + RIP tier ladder for this month and next, attached by
  // the backend via attach_promotion_tiers so the popover renders the
  // same Frontline / Discount / RIP / Best breakdown the Catalog row uses.
  tiers?: CatalogTier[];
  next_tiers?: CatalogTier[];
  // Next-edition headline figures from the same Catalog enrichment path.
  next_case_price?: number | null;
  next_effective_case_price?: number | null;
  // Product type, surfaced so the card can decide whether the multi-
  // vintage sticker applies (vintage only matters on wine / sparkling /
  // vermouth rows).
  product_type?: string | null;
  // For wines / sparkling / vermouth: the list of distinct vintages of
  // the same SKU listed in the same edition. Empty when there's only
  // one vintage on file.
  vintages_available?: string[];
  product_name: string;
  product_type: string | null;
  unit_volume: string | null;
  unit_qty: string | null;
  upc: string | null;
  brand: string | null;
  from_date: string | null;
  to_date: string | null;
  days_to_expire: number | null;
  frontline_case_price: number | null;
  effective_case_price: number | null;
  total_savings_per_case: number | null;
  discount_pct: number | null;
  rip_savings?: number | null;
  has_rip?: boolean;
  has_discount?: boolean;
  has_closeout?: boolean;
  deal_kind: string;
  image_url?: string | null;       // from Go-UPC enrichment
  ai_blurb?: string | null;         // pre-generated AI explanation
}

// ---- Intelligence ----
export const intelligence = {
  buySignals: (params?: Record<string, unknown>) =>
    request<BuySignal[]>(`/api/intelligence/buy-signals${qs(params ?? {})}`),
  buySheet: (params?: Record<string, unknown>) =>
    request<BuySheet>(`/api/intelligence/buy-sheet${qs(params ?? {})}`),
  missedOpportunities: (params?: Record<string, unknown>) =>
    request<MissedOpps>(`/api/intelligence/missed-opportunities${qs(params ?? {})}`),
};

// ---- User State ----
export const watchlist = {
  get: () => request<WatchlistItem[]>('/api/watchlist'),
  add: (item: Partial<WatchlistItem>) =>
    request('/api/watchlist', { method: 'POST', body: JSON.stringify(item) }),
  remove: (id: number) => request(`/api/watchlist/${id}`, { method: 'DELETE' }),
  setTargetPrice: (id: number, price: number) =>
    request(`/api/watchlist/${id}/target-price`, { method: 'PUT', body: JSON.stringify(price) }),
  setNotes: (id: number, notes: string) =>
    request(`/api/watchlist/${id}/notes`, { method: 'PUT', body: JSON.stringify(notes) }),
};

export interface CloseoutFlag {
  id: number; user_id: number; product_name: string; wholesaler: string;
  upc?: string | null; unit_volume?: string | null; unit_qty?: string | null; note?: string | null;
  status: 'open' | 'reviewed' | 'actioned' | 'dismissed'; created_at: string;
  user_email?: string | null;
}

export const closeout = {
  mine: () => request<CloseoutFlag[]>('/api/closeout-flags'),
  add: (item: { product_name: string; wholesaler: string; upc?: string; unit_volume?: string; unit_qty?: string; note?: string }) =>
    request<{ status: string }>('/api/closeout-flags', { method: 'POST', body: JSON.stringify(item) }),
  remove: (id: number) => request<{ status: string }>(`/api/closeout-flags/${id}`, { method: 'DELETE' }),
  // admin review
  all: (status?: string) =>
    request<{ flags: CloseoutFlag[]; counts: Record<string, number> }>(
      `/api/admin/closeout-flags${status ? `?status=${status}` : ''}`),
  setStatus: (id: number, status: string) =>
    request<{ status: string }>(`/api/admin/closeout-flags/${id}/status`,
      { method: 'PUT', body: JSON.stringify({ status }) }),
  adminRemove: (id: number) =>
    request<{ status: string }>(`/api/admin/closeout-flags/${id}`, { method: 'DELETE' }),
};

export const orders = {
  list: (status?: string) => request<Order[]>(`/api/orders${qs({ status })}`),
  plan: (status?: string) => request<PlanOrder[]>(`/api/orders/plan${qs({ status })}`),
  create: (data: { name: string; notes?: string; division?: string; distributor?: string; sales_rep_id?: number | null }) =>
    request<{ id: number; status: string }>('/api/orders', { method: 'POST', body: JSON.stringify(data) }),
  get: (id: number) => request<{ order: Order; lines: OrderLine[] }>(`/api/orders/${id}`),
  detail: (id: number) => request<{ order: Order; lines: OrderLine[] }>(`/api/orders/${id}`),
  update: (id: number, data: Partial<Order>) =>
    request(`/api/orders/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => request(`/api/orders/${id}`, { method: 'DELETE' }),
  addLine: (orderId: number, line: Partial<OrderLine>) =>
    request(`/api/orders/${orderId}/lines`, { method: 'POST', body: JSON.stringify(line) }),
  addCombo: (orderId: number, body: { wholesaler: string; combo_code: string }) =>
    request<{ added: number; combo_code: string }>(`/api/orders/${orderId}/add-combo`, { method: 'POST', body: JSON.stringify(body) }),
  updateStatus: (id: number, status: string) =>
    request(`/api/orders/${id}/status`, { method: 'PUT', body: JSON.stringify(status) }),
  updateLine: (orderId: number, lineId: number, data: Partial<OrderLine>) =>
    request(`/api/orders/${orderId}/lines/${lineId}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeLine: (orderId: number, lineId: number) =>
    request(`/api/orders/${orderId}/lines/${lineId}`, { method: 'DELETE' }),
  clone: (id: number) => request<{ id: number }>(`/api/orders/${id}/clone`, { method: 'POST' }),
  copyWatchlist: (id: number) => request<{ copied: number }>(`/api/orders/${id}/copy-watchlist`, { method: 'POST' }),
  scorecard: (id: number) => request<OrderScorecard>(`/api/intelligence/order-scorecard/${id}`),
  // Submit (or re-submit) the order and email the PO to the sales rep. On a
  // re-submit, pass a revision and whether to send a cancellation of the prior.
  submit: (id: number, data?: { revision?: number; send_cancellation?: boolean }) =>
    request<SubmitResult>(`/api/orders/${id}/submit`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  // Reopen a submitted order back to draft so it can be revised.
  reopen: (id: number) => request<{ status: string; revision: number }>(`/api/orders/${id}/reopen`, { method: 'POST' }),
  // Fetch the PO PDF as a Blob (sends the auth header), for the in-app preview.
  // Pass a revision to preview a specific revision number.
  pdfBlob: async (id: number, revision?: number): Promise<Blob> => {
    const q = revision != null ? `?revision=${revision}` : '';
    const res = await fetch(`${BASE}/api/orders/${id}/pdf${q}`, { headers: { ...authHeaders() } });
    if (!res.ok) throw new Error(`Could not load PDF (${res.status})`);
    return res.blob();
  },
};

// ---- Lists (named product collections) + Cart ----
export interface ProductList {
  id: number; name: string; item_count: number; created_at: string; updated_at: string;
}
export interface ListItem {
  id: number; list_id: number; product_name: string; wholesaler: string;
  upc?: string | null; abg_sku?: string | null; unit_volume?: string | null; combo_code?: string | null;
  notes?: string | null; image_url?: string | null;
  // Catalogue pricing attached server-side from the latest CPL (same data the
  // cart lines carry), so Lists can show real price columns.
  unit_qty?: number | string | null; unit_type?: string | null; vintage?: number | string | null;
  frontline_case_price?: number | null; frontline_unit_price?: number | null;
  effective_case_price?: number | null; effective_unit_price?: number | null;
  total_savings_per_case?: number | null;
  // Latest CPL rip_code for this UPC, attached server-side so the Lists UI
  // can sub-group lines by RIP rebate the same way the cart does.
  rip_code?: string | null;
  // The buyer's chosen RIP program for this line (a UPC can sit under several
  // rebates that don't stack); null = default. Carried into the cart.
  rip_choice?: string | null;
  // Full deal tiers (same attach as the cart) so Lists can show each line's
  // RIP programs and let the buyer pick one.
  tiers?: CatalogTier[];
  has_discount?: boolean; has_rip?: boolean;
  // No-RIP "avoid these days" windows between dated RIP windows.
  rip_gaps?: { from: string; to: string; days: number }[];
  deal_windows?: { kind: 'QD' | 'RIP'; qty?: number | null; unit?: string | null; from: string; to: string; eff: number | null; save: number | null }[];
  // Every distributor carrying the SAME item (UPC grid + name fallback) for the
  // inline "change distributor" picker — same shape the cart lines carry.
  comparison?: OfferRow[];
  alt_status?: AltStatus | null;
  // Quantity on the list line (lists carry qty too), drives eligible RIP.
  qty_cases?: number | null; qty_units?: number | null;
  // Eligible RIP rebate at the line's current quantity (money back later).
  rip_back_later?: RipBackLater | null;
}
export interface ListDetail { id: number; name: string; created_at: string; updated_at: string; items: ListItem[]; }

// Why a line has no switchable distributor (drives the always-on picker's note):
// the same UPC is carried elsewhere only at a DIFFERENT vintage, or not at all.
export interface AltStatus {
  kind: 'vintage_mismatch' | 'none';
  houses?: { wholesaler: string; vintage?: string | null }[];
}

export interface CartItem {
  id: number; product_name: string; wholesaler: string;
  upc?: string | null; abg_sku?: string | null; unit_volume?: string | null; unit_type?: string | null; combo_code?: string | null;
  qty_cases: number; qty_units: number;
  sales_rep_id?: number | null; sales_rep_name?: string | null;
  saved_for_later: number; image_url?: string | null; notes?: string | null;
  // Catalogue pricing + deal tiers (so the cart shows the same deal info).
  frontline_case_price?: number | null; frontline_unit_price?: number | null;
  effective_case_price?: number | null; effective_unit_price?: number | null;
  unit_qty?: number | string | null; vintage?: number | string | null;
  has_discount?: boolean; has_rip?: boolean;
  // Closeout/clearance: a one-time deep cut on a product being discontinued —
  // buy now, it won't be offered again.
  has_closeout?: boolean;
  discount_pct?: number | null; total_savings_per_case?: number | null;
  // Date-aware "live now" RIP overlay (see Product). On a cart/order line the
  // reference date is the needed-by date when set, else today.
  live_effective_case_price?: number | null;
  live_rip_amt?: number | null;
  live_better_than_month?: boolean | null;
  tiers?: CatalogTier[];
  rip_gaps?: { from: string; to: string; days: number }[];
  deal_windows?: { kind: 'QD' | 'RIP'; qty?: number | null; unit?: string | null; from: string; to: string; eff: number | null; save: number | null }[];
  // True only while the whole bundle is still in the cart (combo pricing applies).
  combo_intact?: boolean;
  // Buy-or-Wait timing (from deal_compare): the EFFECTIVE (net) price now vs the
  // next edition. best_buy_window starts with "wait → <month>" when next month is
  // cheaper (best_buy_saving = $/cs you'd save by waiting), or "now" when it's the
  // best time (best_buy_saving = $/cs the price RISES next month, so buy now).
  best_buy_window?: string | null;
  best_buy_saving?: number | null;
  next_edition?: string | null;
  // Combo discovery: this product is a member of a combo. savings/pct come from
  // the combo SHEET's own total_savings (not recomputed); great = pct >= 10%.
  combo_suggestion?: {
    combo_code: string; pack_price?: number | null; savings: number;
    pct: number; great: boolean; label?: string | null;
  } | null;
  // Another SIZE of the same product (same CELR family) is a better buy.
  //  - 'upgrade'       : a bigger bottle at ~the same QD price per bottle — more
  //                      volume for nearly the same money (per_btl vs this_per_btl,
  //                      vol_pct more volume).
  //  - 'cheaper_per_l' : a size that's cheaper per litre (pct cheaper).
  size_swap?: {
    kind: 'upgrade' | 'cheaper_per_l';
    size?: string | null; upc: string; per_l: number; this_per_l: number;
    per_btl?: number; this_per_btl?: number; vol_pct?: number; pct?: number;
  } | null;
  // RIP rebate code this line currently rolls up under (enriched from the
  // catalogue at GET time; null when the product has no RIP).
  rip_code?: string | null;
  // The buyer's chosen RIP program for this line (a UPC can sit under several
  // rebates that don't stack); null = default (the CPL row's own code).
  rip_choice?: string | null;
  // Batch tagging: items added together as one send (a RIP cluster from the
  // catalog or AI) share a batch_id and label. NULL = added as a single
  // ungrouped product. See cart.addBatch().
  batch_id?: string | null;
  batch_label?: string | null;
  batch_source?: string | null;
  // Smart cart: the full per-distributor comparison (every house that carries
  // this SKU in its edition, incl each one's own RIP), cheapest-net first, from
  // the precomputed sku_offer grid. Drives the in-place distributor dropdown.
  comparison?: OfferRow[];
  // When there's no switchable house: why (carried elsewhere only at a different
  // vintage, or not at all) — drives the always-on picker's note.
  alt_status?: AltStatus | null;
  // Ranked, stacked money-saving suggestions for THIS line. One row each in the
  // UI; Apply fires `action`.
  suggestions?: LineSuggestion[];
  // Eligible RIP rebate ("money back later") at the line's CURRENT quantity —
  // per-case rate of the highest tier the qty qualifies for × the line's cases.
  rip_back_later?: RipBackLater | null;
}

// Eligible RIP rebate for a line at its chosen quantity (money back later).
export interface RipBackLater {
  per_case: number;
  per_bottle?: number | null;
  total: number;          // per_case × cases (+ per_bottle × loose bottles)
  tier_qty: number;       // qualifying quantity of the tier that's been reached
  tier_unit: 'case' | 'btl' | string;
  code: string;           // RIP program code
}

// One distributor's offer for a SKU within an edition (precomputed sku_offer).
export interface OfferRow {
  edition: string;
  wholesaler: string;
  upc?: string | null;
  display_name?: string | null;
  product_name?: string | null;
  unit_volume?: string | null;
  unit_qty?: string | null;
  item_no?: string | null;
  frontline_case_price?: number | null;
  after_qd_case_price?: number | null;
  // Realistic single-case price (list − the 1-case QD); what the picker shows.
  case_1cs_price?: number | null;
  effective_case_price?: number | null;
  btl_effective?: number | null;
  qd_save_per_case?: number | null;
  rip_savings?: number | null;
  // Per-case RIP rebate at this distributor (post-QD price − net), for the
  // cross-distributor RIP comparison shown in the picker.
  rip_per_case?: number | null;
  has_discount?: boolean;
  has_rip?: boolean;
  rip_code?: string | null;
  net_rank?: number;
  is_cheapest_net?: boolean;
  n_distributors?: number;
  spread_net?: number | null;
}

// A normalized, one-click money-saving suggestion attached to a cart line.
export interface LineSuggestion {
  kind: 'alt_distributor' | 'qd_tier' | 'rip_tier' | 'rip_program' | 'case_mix' | 'buy_before';
  headline: string;
  detail?: string | null;
  delta_per_case?: number | null;
  delta_total?: number | null;
  expires_on?: string | null;
  rank?: number;
  line_ids?: number[];
  // The exact call the UI fires on Apply. null = informational only.
  action?: { endpoint: string; method: 'PUT' | 'POST'; payload: Record<string, unknown> } | null;
}

export interface CartPayload {
  items: CartItem[];
  group_notes: Record<string, string>;
  savings?: { captured_total: number; opportunity_total: number; protection_total: number };
}

export interface CartBatchItemIn {
  product_name: string;
  wholesaler: string;
  upc?: string | null;
  unit_volume?: string | null;
  combo_code?: string | null;
  qty_cases?: number;
  qty_units?: number;
}

// ---- Analyze for Savings (cart + lists) ----
export interface SavingsRec {
  type: 'tier_gap' | 'case_mix' | 'buy_before' | 'swap' | 'better_rip';
  kind?: 'qd' | 'rip';
  line_id?: number;
  line_ids?: number[];
  product_name?: string;
  members?: string[];
  wholesaler?: string;
  upc?: string | null;
  abg_sku?: string | null;
  unit_volume?: string | null;
  unit_type?: string | null;
  unit_qty?: string | number | null;
  vintage?: string | number | null;
  rip_code?: string;
  description?: string | null;
  current_cases?: number;
  target_qty?: number;
  add_cases?: number;
  new_case_price?: number | null;
  save_per_case?: number;
  qd_save_per_case?: number;   // QD portion of a (stacked) RIP-tier saving
  rip_save_per_case?: number;  // RIP portion
  rebate_amount?: number;
  roi_pct?: number;
  extra_savings?: number;
  // buy_before
  current_price?: number;
  next_price?: number;
  rise_per_case?: number;
  total_rise?: number;
  // swap
  from_wholesaler?: string;
  to_wholesaler?: string;
  other_price?: number;
  total_savings?: number;
  // better_rip: the line's UPC sits under several RIP programs and a
  // different one pays more at the same quantity.
  current_rip_code?: string;
  better_rip_code?: string;
  save_per_case_current?: number;
  save_per_case_better?: number;
  // case_mix: quantities are CASE CREDITS (a half-case qualifier is pooled
  // at 0.5 per physical case) when true.
  credit_based?: boolean;
  window_status?: string | null;
  days_to_expire?: number | null;
  // Month-over-month context (digest only): how this item's best per-case
  // savings compares to last edition.
  mom?: { dir: 'new' | 'up' | 'down' | 'same'; delta: number; text: string };
  // Set when the recommended deal is a PARTIAL-month (time-sensitive) RIP — only
  // valid on these dates, so the buyer must act within the window.
  partial?: {
    from_date?: string | null;
    to_date?: string | null;
    window_status?: WindowStatus | null;
    days_to_expire?: number | null;
    time_sensitive?: boolean;
  };
}
export interface SavingsAnalysis {
  captured_total: number;
  opportunity_total: number;
  protection_total: number;
  line_count: number;
  recommendations: SavingsRec[];
}

// ---- What's New for You (personalized monthly digest) ----
export interface DigestCard {
  product_name: string;
  wholesaler: string;
  upc?: string | null;
  abg_sku?: string | null;
  unit_volume?: string | null;
  unit_qty?: string | number | null;
  vintage?: string | number | null;
  image_url?: string | null;
  frontline_case_price?: number | null;
  effective_case_price?: number | null;
  has_rip: boolean;
  has_discount: boolean;
  rip_code?: string | null;
  rip_gaps?: { from: string; to: string; days: number }[];
  deal_windows?: { kind: 'QD' | 'RIP'; qty?: number | null; unit?: string | null; from: string; to: string; eff: number | null; save: number | null }[];
  price_3mo?: Price3moBlock[] | null;
  sources: string[];
  change_detail: string;
  change_amount: number;
  intent: 'opportunity' | 'risk' | 'info';
}
export interface WhatsNew {
  edition: string | null;
  prev_edition: string | null;
  next_edition: string | null;
  tracked_count: number;
  savings: SavingsAnalysis;
  sections: Record<string, DigestCard[]>;
}
export const digest = {
  whatsNew: () => request<WhatsNew>('/api/whats-new'),
};

export const lists = {
  list: () => request<ProductList[]>('/api/lists'),
  analyze: (id: number) => request<SavingsAnalysis>(`/api/lists/${id}/analyze`),
  create: (name: string) => request<ProductList>('/api/lists', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id: number, name: string) => request(`/api/lists/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  remove: (id: number) => request(`/api/lists/${id}`, { method: 'DELETE' }),
  get: (id: number) => request<ListDetail>(`/api/lists/${id}`),
  addItem: (id: number, item: Partial<ListItem>) =>
    request(`/api/lists/${id}/items`, { method: 'POST', body: JSON.stringify(item) }),
  removeItem: (id: number, itemId: number) =>
    request(`/api/lists/${id}/items/${itemId}`, { method: 'DELETE' }),
  updateItem: (id: number, itemId: number, data: { notes?: string; rip_choice?: string | null; qty_cases?: number; qty_units?: number }) =>
    request(`/api/lists/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeItems: (id: number, itemIds: number[]) =>
    request(`/api/lists/${id}/items/delete`, { method: 'POST', body: JSON.stringify({ item_ids: itemIds }) }),
  // Switch a list line to another distributor carrying the same item; returns the
  // refreshed list so the row re-renders at the target's price.
  switchDistributor: (id: number, itemId: number, wholesaler: string) =>
    request<ListDetail>(`/api/lists/${id}/items/${itemId}/switch-distributor`,
      { method: 'POST', body: JSON.stringify({ wholesaler }) }),
};

export const cart = {
  get: () => request<CartPayload>('/api/cart'),
  analyze: () => request<SavingsAnalysis>('/api/cart/analyze'),
  groupNote: (wholesaler: string, note: string) =>
    request('/api/cart/group-note', { method: 'POST', body: JSON.stringify({ wholesaler, note }) }),
  // Returns the freshly enriched cart so the caller can show per-line
  // comparison + suggestions immediately, no follow-up fetch.
  add: (item: Partial<CartItem>) =>
    request<{ status: string; cart: CartPayload }>('/api/cart', { method: 'POST', body: JSON.stringify(item) }),
  // Move ONE line to another distributor IN PLACE (same row, new house),
  // preserving quantity. Returns the enriched cart.
  switchDistributor: (id: number, wholesaler: string) =>
    request<{ status: string; line_id: number; cart: CartPayload }>(
      `/api/cart/${id}/switch-distributor`, { method: 'POST', body: JSON.stringify({ wholesaler }) }),
  // Apply a normalized LineSuggestion.action verbatim (PUT/POST to its endpoint).
  applySuggestion: (action: { endpoint: string; method: 'PUT' | 'POST'; payload: Record<string, unknown> }) =>
    request(action.endpoint, { method: action.method, body: JSON.stringify(action.payload) }),
  // Add N items as ONE labelled batch. They stay grouped in the cart (a
  // second send of the same cluster produces a separate batch instead of
  // merging into the first). Returns the generated batch_id.
  addBatch: (body: { batch_label: string; batch_source: string; items: CartBatchItemIn[] }) =>
    request<{ added: number; batch_id: string; batch_label: string; batch_source: string }>(
      '/api/cart/add-batch', { method: 'POST', body: JSON.stringify(body) }),
  removeBatch: (batch_id: string) =>
    request<{ removed: number; batch_id: string }>(`/api/cart/batch/${encodeURIComponent(batch_id)}`, { method: 'DELETE' }),
  // Resolve a (wholesaler, rip_code) Case Mix server-side and add every
  // member as one labelled batch. Used by the AI's per-cluster button.
  addByRip: (body: { wholesaler: string; rip_code: string; qty_cases_per_item?: number }) =>
    request<{ added: number; batch_id: string | null; batch_label: string; batch_source: string; message?: string }>(
      '/api/cart/add-by-rip', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: number, data: { qty_cases?: number; qty_units?: number; sales_rep_id?: number | null; saved_for_later?: boolean; notes?: string; rip_choice?: string | null }) =>
    request(`/api/cart/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => request(`/api/cart/${id}`, { method: 'DELETE' }),
  // One-command distributor swap: replace cart items from one distributor with
  // the same products (matched by UPC) at another, preserving quantities.
  swapDistributor: (body: { from_distributor: string; to_distributor: string; rip_code?: string; upcs?: string[] }) =>
    request<{ swapped: { from: string; to: string }[]; not_carried: string[]; skipped_no_upc: string[]; message: string }>(
      '/api/cart/swap-distributor', { method: 'POST', body: JSON.stringify(body) }),
  // Bulk flip saved_for_later on N lines in one round-trip. Powers
  // "Save all for later" / "Move all to cart" on RIP group headers.
  bulkSaveForLater: (ids: number[], saved: boolean) =>
    request<{ updated: number; saved: boolean }>('/api/cart/bulk-save-for-later',
      { method: 'POST', body: JSON.stringify({ ids, saved }) }),
  clear: (scope: 'active' | 'saved' | 'all' = 'active') =>
    request<{ removed: number; scope: string }>(`/api/cart/clear?scope=${scope}`,
      { method: 'POST' }),
  assignRep: (wholesaler: string, sales_rep_id: number | null) =>
    request('/api/cart/assign-rep', { method: 'POST', body: JSON.stringify({ wholesaler, sales_rep_id }) }),
  fromList: (list_id: number, item_ids?: number[]) =>
    request<{ count: number }>('/api/cart/from-list', { method: 'POST', body: JSON.stringify({ list_id, item_ids }) }),
  fromCombo: (wholesaler: string, combo_code: string, qty = 1) =>
    request<{ added: number }>('/api/cart/from-combo', { method: 'POST', body: JSON.stringify({ wholesaler, combo_code, qty }) }),
  send: () => request<{ sent: number; skipped_no_rep: number; orders: { order_id: number; rep_name: string; lines: number; emailed: boolean; to: string | null }[] }>('/api/cart/send', { method: 'POST' }),
  reorder: (order_id: number) => request<{ added: number; order_name?: string; error?: string }>('/api/cart/reorder', { method: 'POST', body: JSON.stringify({ order_id }) }),
};

export interface SubmitResult {
  status: string;
  emailed: boolean;
  cancelled: boolean;
  to: string | null;
  rep_name: string | null;
  revision: number;
  is_revision: boolean;
  reason: 'no_rep_email' | 'email_disabled' | null;
}

export interface AllNote {
  source: 'product' | 'watchlist' | 'order' | 'order_line';
  id: number;
  note: string;
  product_name: string | null;
  wholesaler: string | null;
  order_id: number | null;
  title: string;
  created_at: string;
}

export const notes = {
  list: () => request<UserNote[]>('/api/notes'),
  all: () => request<AllNote[]>('/api/notes/all'),
  standalone: () => request<UserNote[]>('/api/notes/standalone'),
  forProduct: (wholesaler: string, productName: string) =>
    request<UserNote[]>(`/api/notes/${encodeURIComponent(wholesaler)}/${encodeURIComponent(productName)}`),
  add: (note: { note: string; product_name?: string; wholesaler?: string; title?: string; color?: string }) =>
    request<{ id: number }>('/api/notes', { method: 'POST', body: JSON.stringify(note) }),
  update: (id: number, data: { note?: string; title?: string; color?: string }) =>
    request(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => request(`/api/notes/${id}`, { method: 'DELETE' }),
};

export const alerts = {
  get: (params?: Record<string, unknown>) =>
    request<Alert[]>(`/api/alerts${qs(params ?? {})}`),
  unreadCount: () => request<{ unread: number }>('/api/alerts/unread-count'),
  generate: () => request('/api/alerts/generate', { method: 'POST' }),
  markRead: (id: number) => request(`/api/alerts/${id}/read`, { method: 'PUT' }),
  markAllRead: () => request('/api/alerts/mark-all-read', { method: 'PUT' }),
};

export interface Todo {
  id: number;
  title: string;
  note: string | null;
  due_date: string | null;
  status: 'open' | 'done';
  product_name: string | null;
  wholesaler: string | null;
  upc: string | null;
  abg_sku?: string | null;
  unit_volume: string | null;
  source_page: string | null;
  created_at: string;
  completed_at: string | null;
}
export const todos = {
  list: () => request<Todo[]>('/api/todos'),
  create: (data: {
    title: string; note?: string; due_date?: string;
    product_name?: string; wholesaler?: string; upc?: string; unit_volume?: string; source_page?: string;
  }) => request<{ id: number }>('/api/todos', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { title?: string; note?: string; due_date?: string; status?: 'open' | 'done' }) =>
    request(`/api/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => request(`/api/todos/${id}`, { method: 'DELETE' }),
};

export interface ActivityEventIn {
  type: 'pageview' | 'action';
  path?: string;
  label?: string;
  duration_ms?: number;
  meta?: Record<string, unknown>;
}
export interface ActivitySummary {
  days: number;
  totals: { events: number; pageviews: number; actions: number; users: number; sessions: number; total_ms: number };
  screens: { path: string; label: string | null; views: number; total_ms: number; users: number }[];
  actions: { label: string; count: number }[];
}
export interface ActivityUserRow {
  user_id: number | null;
  user_email: string;
  pageviews: number;
  actions: number;
  sessions: number;
  total_ms: number;
  last_active: string;
}
export interface ActivityUserDetail {
  user_id: number;
  totals: { total_ms: number; pageviews: number; actions: number; first_seen: string | null; last_active: string | null };
  screens: { path: string; label: string | null; views: number; total_ms: number }[];
  recent: { event_type: string; path: string | null; label: string | null; duration_ms: number | null; created_at: string }[];
}
export const activity = {
  // Fire-and-forget. keepalive lets it survive a page unload; never throws or
  // triggers the 401 redirect, so tracking can't disrupt the user.
  track: (batch: { session_id?: string; user_agent?: string; events: ActivityEventIn[] }) => {
    try {
      fetch(`${BASE}/api/activity/track`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(batch),
      }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  },
  adminSummary: (days = 30) => request<ActivitySummary>(`/api/activity/admin/summary?days=${days}`),
  adminUsers: (days = 30) => request<ActivityUserRow[]>(`/api/activity/admin/users?days=${days}`),
  adminUserDetail: (id: number, days = 90) => request<ActivityUserDetail>(`/api/activity/admin/user/${id}?days=${days}`),
};

export const salesReps = {
  list: () => request<SalesRep[]>('/api/sales-reps'),
  add: (rep: Omit<SalesRep, 'id'>) =>
    request<{ id: number }>('/api/sales-reps', { method: 'POST', body: JSON.stringify(rep) }),
  update: (id: number, rep: Partial<Omit<SalesRep, 'id'>>) =>
    request(`/api/sales-reps/${id}`, { method: 'PUT', body: JSON.stringify(rep) }),
  remove: (id: number) => request(`/api/sales-reps/${id}`, { method: 'DELETE' }),
  message: (id: number, message: string) =>
    request<{ sent: boolean; rep_name?: string; to?: string; error?: string }>(`/api/sales-reps/${id}/message`, { method: 'POST', body: JSON.stringify({ message }) }),
};

export interface Division { id: number; name: string; distributor?: string | null }
export const divisions = {
  list: () => request<Division[]>('/api/divisions'),
  add: (name: string, distributor?: string) =>
    request<{ id: number }>('/api/divisions', { method: 'POST', body: JSON.stringify({ name, distributor }) }),
  remove: (id: number) => request(`/api/divisions/${id}`, { method: 'DELETE' }),
};

// ---- Auth ----
export interface AuthUser { id: number; email: string; full_name?: string | null; is_admin?: boolean }
export interface AuthResponse { token: string; user: AuthUser }
export interface ActivationRequired { status: 'activation_required'; email: string }

// ---- Admin-editable settings ----
export const settings = {
  getShareMessage: () => request<{ message: string; url: string }>('/api/settings/share-message'),
  updateShareMessage: (data: { message: string; url?: string }) =>
    request<{ message: string; url: string }>('/api/settings/share-message', { method: 'PUT', body: JSON.stringify(data) }),
};

// ---- Share tracking ----
export const share = {
  track: (data: { channel?: string; source?: string; page?: string; user_agent?: string }) =>
    request('/api/share/track', { method: 'POST', body: JSON.stringify(data) }),
  events: () => request<ShareEvent[]>('/api/share/events'),
};

// ---- Cookie / consent log ----
export const consent = {
  record: (data: {
    anon_id?: string; analytics: boolean; marketing: boolean;
    decision?: string; policy_version?: string; page?: string; user_agent?: string;
  }) => request('/api/consent', { method: 'POST', body: JSON.stringify(data) }),
};

export const auth = {
  signup: (data: { email: string; password: string; phone: string; full_name?: string }) =>
    request<AuthResponse | ActivationRequired>('/api/auth/signup', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { email: string; password: string }) =>
    request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  updateProfile: (data: { full_name?: string; email?: string }) =>
    request<{ user: AuthUser }>('/api/auth/profile', { method: 'PUT', body: JSON.stringify(data) }),
  changePassword: (data: { new_password: string }) =>
    request<{ status: string }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
  activate: (token: string) =>
    request<AuthResponse>('/api/auth/activate', { method: 'POST', body: JSON.stringify({ token }) }),
  resendActivation: (email: string) =>
    request<{ status: string }>('/api/auth/resend-activation', { method: 'POST', body: JSON.stringify({ email }) }),
  forgotPassword: (email: string) =>
    request<{ status: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token: string, new_password: string) =>
    request<{ status: string }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, new_password }) }),
};

// ---- Stores ----
export interface Store {
  id: number;
  name: string;
  place_id?: string | null;
  formatted_address?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  phone?: string | null;
  lat?: number | null;
  lng?: number | null;
  license_number?: string | null;
  notes?: string | null;
}
export type StoreInput = Omit<Store, 'id'>;

export interface StorePrediction {
  place_id: string; description: string | null;
  main_text: string | null; secondary_text: string | null;
}
export interface StoreLookupResponse {
  enabled: boolean; predictions: StorePrediction[]; note: string | null;
}
export interface PlaceDetails {
  place_id: string; name: string | null; formatted_address: string | null;
  street: string | null; city: string | null; state: string | null;
  postal_code: string | null; country: string | null; phone: string | null;
  lat: number | null; lng: number | null;
}

export const stores = {
  list: () => request<Store[]>('/api/stores'),
  lookup: (q: string) => request<StoreLookupResponse>(`/api/stores/lookup${qs({ q })}`),
  placeDetails: (placeId: string) => request<PlaceDetails>(`/api/stores/place/${encodeURIComponent(placeId)}`),
  create: (data: Partial<StoreInput> & { name: string }) =>
    request<{ id: number }>('/api/stores', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<StoreInput> & { name: string }) =>
    request(`/api/stores/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => request(`/api/stores/${id}`, { method: 'DELETE' }),
};

// ---- Types ----
export interface Product {
  wholesaler: string;
  edition: string;
  upc: string;
  // Allied (ABG) item number, attached server-side for allied rows only.
  abg_sku?: string | null;
  // Distributor's own item NAME (fuller, un-abbreviated). Populated for Allied
  // from the Wine Chateau/ABG source; null when no proper name is available
  // (e.g. Fedway), in which case the abbreviated CPL product_name is shown.
  abg_item_name?: string | null;
  product_name: string;
  product_type: string;
  unit_qty: string;
  unit_volume: string;
  // New Items: the edition (YYYY-MM) this SKU was first introduced in. Present
  // only when the row was fetched with introduced_within_months (New Items page).
  introduced_edition?: string | null;
  frontline_case_price: number;
  frontline_unit_price: number;
  best_case_price: number;
  best_unit_price: number;
  effective_case_price: number;
  has_discount: boolean;
  has_rip: boolean;
  has_closeout: boolean;
  discount_pct: number;
  total_savings_per_case: number;
  // Date-aware "live now" RIP overlay (see backend pricing.attach_live_rip).
  // effective_case_price is the stable whole-month price; these reflect the
  // best RIP active on the reference date (default today, or ?as_of=). When a
  // currently-active partial-window RIP beats the month price,
  // live_better_than_month is true and live_effective_case_price < effective.
  live_effective_case_price?: number | null;
  live_rip_amt?: number | null;
  live_better_than_month?: boolean | null;
  rip_code?: string;
  combo_code?: string;
  // RIP rebate grouping (catalog only — populated when sorting/grouping by
  // Case Mix RIP). rip_group_code is the RIP-sheet code this UPC belongs to;
  // rip_cpl_mismatch is true when the CPL row's rip_code isn't among the
  // codes the RIP sheet says this UPC qualifies under (stale CPL → "check
  // with sales rep" sticker).
  rip_group_code?: string | null;
  rip_group_count?: number | null;
  rip_cpl_mismatch?: boolean | null;
  // Every RIP code this UPC qualifies under in the RIP sheet (a single UPC
  // can stack across multiple rebates). rip_group_code is the primary one
  // used for clustering / sort; the UI also shows a sticker per entry here
  // so the buyer sees every rebate the SKU is eligible for.
  rip_all_codes?: string[] | null;
  brand?: string;
  // Family grouping for the Products list: a product's differently-named sizes
  // share product_group; product_display is the clean family title.
  product_group?: string | null;
  product_display?: string | null;
  // Go-UPC enrichment product name (clean, canonical, keyed by THIS row's UPC).
  // Used as the per-SKU display name in the ungrouped Products view.
  enrichment_name?: string | null;
  // Canonical LLM geo/varietal enrichment (backend/taxonomy.py). Origin chain
  // country -> region -> subregion, plus grape(s), wine colour, spirit style.
  geo_country?: string | null;
  geo_region?: string | null;
  geo_subregion?: string | null;
  geo_varietal?: string | null;
  geo_color?: string | null;
  geo_style?: string | null;
  // CELR Product Number ("CELR-000123"): the persistent FAMILY identity
  // spanning sizes/vintages/distributors (docs/CELR_PRODUCT_NUMBER_DESIGN.md).
  celr_product_number?: string | null;
  discount_1_qty?: string | null;
  discount_1_amt?: number | null;
  discount_2_qty?: string | null;
  discount_2_amt?: number | null;
  discount_3_qty?: string | null;
  discount_3_amt?: number | null;
  discount_4_qty?: string | null;
  discount_4_amt?: number | null;
  discount_5_qty?: string | null;
  discount_5_amt?: number | null;
  tiers?: CatalogTier[];
  // No-RIP "avoid these days" windows between dated RIP windows.
  rip_gaps?: { from: string; to: string; days: number }[];
  deal_windows?: { kind: 'QD' | 'RIP'; qty?: number | null; unit?: string | null; from: string; to: string; eff: number | null; save: number | null }[];
  // Last 3 EXISTING editions (1-case-discount + best-RIP prices + per-edition
  // tiers) for the two-line 3-month sparkline (pricing.attach_price_3mo).
  price_3mo?: Price3moBlock[] | null;
  // Same shape as `tiers` but computed against next month's edition, so the
  // catalog row sparkline popover can show Frontline / After Discount /
  // RIP tiers for both months.
  next_tiers?: CatalogTier[];
  next_case_price?: number | null;
  next_effective_case_price?: number | null;
  better_month?: 'Same' | 'This Month' | 'Next Month' | null;
  // Distinct vintages of the same SKU listed in the same edition (wines /
  // sparkling / vermouth only; empty otherwise). Lets the card render a
  // "Multiple vintages" sticker.
  vintages_available?: string[];
  // Edition (YYYY-MM) the item was introduced in, set by /catalog/new-items.
  introduced_edition?: string | null;
  // Go-UPC product image (R2 CDN URL), attached per row by the list endpoints.
  image_url?: string | null;
  // Vintage year. One barcode can cover several vintages (each priced
  // differently), so vintage is part of what makes a row distinct.
  vintage?: string | number | null;
  // Unused now (kept for back-compat); duplicates are collapsed server-side.
  dup_upc?: boolean;
  // True when the SAME product is carried by 2+ distributors (not a placeholder
  // barcode). distributor_count is how many carry it; multi_distributor_names
  // is the sorted list of slugs so the UI can spell out who.
  multi_distributor?: boolean;
  distributor_count?: number;
  multi_distributor_names?: string[];
  // AI-generated short blurb attached by /api/deals/discounts when present.
  ai_blurb?: string | null;
  // Savings source labels ("CPL discount", "RIP", "Closeout") and the
  // computed better-month tag for the discount.
  discount_source?: string[];
}

export interface NewItemsResponse {
  total: number;
  limit: number;
  offset: number;
  current_ym: string;
  window_start: string | null;
  months: { edition: string; count: number }[];
  items: Product[];
}

// A tier's validity-window status relative to a reference date (default today).
//   whole_month : full calendar month(s); part of the always-on monthly price
//   evergreen   : no dated window; always applies
//   active      : dated window that contains the reference date (live now)
//   upcoming    : dated window that starts after the reference date
//   expired     : dated window that ended before the reference date
export type WindowStatus = 'whole_month' | 'evergreen' | 'active' | 'upcoming' | 'expired';

// Fields stamped on every tier so the UI can badge Active now / Starts DD MMM /
// Expires in N days. from_date/to_date are ISO 'YYYY-MM-DD' or null.
export interface TierWindow {
  from_date?: string | null;
  to_date?: string | null;
  window_status?: WindowStatus | null;
  days_to_expire?: number | null;
}

export interface CatalogTier extends TierWindow {
  source: 'discount' | 'rip';
  qty: number;
  unit: string;
  amount: number;
  save_per_case: number;
  // RIP tiers only: the RIP rebate portion alone (without the stacked
  // CPL discount that auto-applies at this qty). Used as the per-row
  // savings figure shown in the popover so a 1cs RIP row shows the $6
  // rebate, not "$6 + stacked discount − deepest discount".
  rip_only_save_per_case?: number | null;
  stacked_disc_per_case?: number | null;
  price_after: number | null;
  btl_price_after?: number | null;
  save_per_bottle?: number | null;
  roi_pct: number;
  description?: string | null;
  code?: string | null;   // RIP code this tier belongs to (for grouping by program)
  // True when this tier's source row (CPL row for discount tiers, RIP sheet
  // row for RIP tiers) has a PARTIAL-month validity window — i.e. the deal
  // is time-sensitive. derive.py excludes those from effective_case_price
  // and has_discount; the modal/popover still surfaces the tier so the buyer
  // sees the promo exists, but the UI renders it with a "TS" marker.
  is_time_sensitive?: boolean;
  // Case-credit model (FOUNDATION 3.4.1) — present only when a half-case
  // rule matched this SKU: one physical case counts `case_credit` toward
  // this case-unit tier, so the REAL buy-in is `qualified_cases` physical
  // cases. split_pack/split_credit describe an allowed sub-case split
  // (e.g. a 3-bottle split of a 6-pack earning 0.5 case credit).
  case_credit?: number | null;
  qualified_cases?: number | null;
  split_pack?: number | null;
  split_credit?: number | null;
}

// One edition's block in the 3-month sparkline history (pricing.attach_price_3mo).
// disc1_price = case price after the 1-case (entry) CPL discount, no RIP.
// rip_price   = best effective price (best RIP applied) that edition.
export interface Price3moBlock {
  edition: string | null;
  frontline: number | null;
  frontline_unit_price?: number | null;   // source single-bottle price (CPL sheet)
  disc1_price: number | null;
  rip_price: number | null;
  tiers: CatalogTier[];
  // True when this block is the next-month preview (loaded early). It plots on
  // the sparkline + tooltip, but the current-month ladder/stickers skip it.
  future?: boolean;
}

export interface DiscountTier extends TierWindow {
  tier: number;
  quantity: string;
  amount_per_case: number;
  price_after: number;
  roi_pct: number;
}

export interface RipTier extends TierWindow {
  qty: number;
  unit: string;
  amount: number;
  per_case_savings: number;
  per_bottle_savings?: number | null;
  price_after: number;
  btl_price_after?: number | null;
  bundle_cost: number;
  roi_pct: number;
  code?: string | null;   // RIP code this tier belongs to (one UPC, several programs)
  description: string | null;
  is_time_sensitive?: boolean;
}

export interface Edition { wholesaler: string; edition: string; item_count: number }
export interface Category { product_type: string; count: number }

export interface PriceComparisonRow {
  wholesaler: string;
  upc: string;
  product_name: string;
  product_type: string;
  unit_volume: string;
  unit_qty?: string | null;
  curr_edition: string;
  next_edition: string;
  curr_case_price: number | null;
  next_case_price: number | null;
  curr_effective_case_price: number | null;
  next_effective_case_price: number | null;
  curr_has_rip: boolean;
  next_has_rip: boolean;
  curr_has_discount: boolean;
  next_has_discount: boolean;
  curr_discount_pct: number | null;
  next_discount_pct: number | null;
  curr_best_discount: number | null;
  next_best_discount: number | null;
  curr_rip_savings: number | null;
  next_rip_savings: number | null;
  curr_total_savings: number | null;
  next_total_savings: number | null;
  delta: number;
  delta_pct: number;
  effective_delta: number | null;
  effective_delta_pct: number | null;
}
export interface PriceComparisonResponse {
  current_ym: string;
  next_ym: string;
  total: number;
  items: PriceComparisonRow[];
}

export interface CrossDistributorRow {
  upc_norm: string;
  a_upc: string;
  b_upc: string;
  product_name: string;
  b_product_name: string;
  unit_volume: string;
  unit_qty: number | null;
  product_type: string;
  a_vintage: string | null;
  b_vintage: string | null;
  a_case: number | null;
  b_case: number | null;
  a_btl_frontline: number | null;
  b_btl_frontline: number | null;
  a_effective: number | null;
  b_effective: number | null;
  a_effective_per_bottle: number | null;
  b_effective_per_bottle: number | null;
  a_rip_savings: number | null;
  b_rip_savings: number | null;
  a_has_discount: boolean;
  b_has_discount: boolean;
  a_has_rip: boolean;
  b_has_rip: boolean;
  savings: number;
  savings_pct: number;
  cheaper: string;
}
export interface DistributorExclusiveRow {
  wholesaler: string;
  edition: string;
  upc: string;
  upc_norm: string;
  product_name: string;
  product_type: string;
  unit_volume: string;
  unit_qty: number | null;
  frontline_case_price: number | null;
  effective_case_price: number | null;
  has_discount: boolean;
  has_rip: boolean;
  discount_pct: number | null;
  rip_savings: number | null;
  effective_per_bottle: number | null;
}
export interface QACheck {
  count_returned: number;
  limit: number;
  rows: Record<string, unknown>[];
}
export interface QAReport {
  edition_checked: string;
  checks: Record<string, QACheck>;
  totals: Record<string, number>;
}

export interface DistributorExclusiveResponse {
  distributor: string;
  compared_to: string;
  edition: string;
  compared_edition: string;
  total: number;
  items: DistributorExclusiveRow[];
}

export interface CrossDistributorResponse {
  distributor_a: string;
  distributor_b: string;
  edition_a: string;
  edition_b: string;
  total: number;
  items: CrossDistributorRow[];
}

export interface FacetBucket { key: string; count: number }
export interface CatalogFacets {
  total: number;
  has_rip: number; no_rip: number;
  has_discount: number; no_discount: number;
  has_closeout: number; no_closeout: number;
  has_combo: number; no_combo: number;
  divisions: FacetBucket[];
  categories: FacetBucket[];
  brands: FacetBucket[];
  sizes: FacetBucket[];
  unit_kinds?: FacetBucket[];   // Bottle / Can / Keg buckets
  // Canonical origin / grape facets from the LLM geo enrichment.
  countries?: FacetBucket[];
  regions?: FacetBucket[];
  grapes?: FacetBucket[];
  spirit_categories?: FacetBucket[];   // Whiskey/Vodka/Tequila/... (spirits only)
}
export interface PricePoint {
  edition: string;
  vintage: string | null;
  frontline_case_price: number;
  best_case_price: number;
  effective_case_price: number;
  discount_pct: number;
}
export interface PriceStats {
  min_price: number; max_price: number; avg_price: number;
  current_price: number; editions_count: number; trend: string;
}

export interface DashboardKPIs {
  total_items: number; active_discounts: number; clearance_items: number;
  active_rips: number; total_savings_pool: number; avg_case_price: number;
  price_drops: number; price_increases: number;
}

export interface PriceMover {
  wholesaler: string; edition: string; product_name: string; product_type: string;
  unit_volume: string; vintage: string | null; case_price: number; prev_case_price: number;
  case_delta: number; case_delta_pct: number; direction: string;
  upc?: string | null; brand?: string | null; unit_qty?: string | null;
  effective_case_price?: number | null;
  has_rip?: boolean; has_discount?: boolean;
  image_url?: string | null;
  ai_blurb?: string | null;
  validity?: 'current_only' | 'next_only' | 'both';
  cur_edition?: string | null;
  next_edition?: string | null;
  next_case_price?: number | null;
  // Per-transition deltas + match flags. `headline_period` says which of the
  // two transitions the card should put in the big number (we pick whichever
  // direction-matching transition has the larger |effective Δ%|).
  // case_price / prev_case_price / next_case_price are the EFFECTIVE prices
  // (list − all discounts − best RIP). The frontline_* counterparts let the
  // card surface a list-price story alongside.
  cur_match?: boolean;
  next_match?: boolean;
  cur_delta?: number | null;
  cur_delta_pct?: number | null;
  next_delta?: number | null;
  next_delta_pct?: number | null;
  headline_period?: 'cur' | 'next';
  frontline_prev_case_price?: number | null;
  frontline_case_price?: number | null;
  frontline_next_case_price?: number | null;
  frontline_cur_delta?: number | null;
  frontline_cur_delta_pct?: number | null;
  frontline_next_delta?: number | null;
  frontline_next_delta_pct?: number | null;
  // Tier ladders for this month and next, attached by attach_promotion_tiers.
  tiers?: CatalogTier[];
  next_tiers?: CatalogTier[];
  // 3-month sparkline history (1-case-discount + best-RIP).
  price_3mo?: Price3moBlock[] | null;
  // Distinct vintages of the same SKU listed in the same edition (wines /
  // sparkling / vermouth only; empty otherwise).
  vintages_available?: string[];
}

export interface LifecycleEvent {
  wholesaler: string; edition: string; product_name: string; event_type: string;
}

export interface CrossSourceLink {
  wholesaler_a: string; product_name_a: string; case_price_a: number;
  wholesaler_b: string; product_name_b: string; case_price_b: number;
  name_similarity: number; price_delta: number; upc_match: boolean;
}

export interface CategoryTrend {
  product_type: string; edition: string; avg_change_pct: number;
  items: number; increases: number; decreases: number;
}

// CELR Product Number registry (admin curation screens).
export interface CelrFamily {
  cpn: number; header_name?: string | null; brand?: string | null;
  product_type?: string | null; alias_of?: number | null; upc_count?: number;
}
export interface CelrFamilyDetail extends CelrFamily {
  family_key?: string; merged_in?: number[];
  upcs: {
    upc_norm: string;
    listings: { wholesaler: string; product_name: string; unit_volume?: string | null; unit_qty?: number | string | null }[];
  }[];
}

export interface ComboComponent {
  product_name: string | null;
  upc: string | null;
  // Bottle size from the CPL (joined by UPC server-side), e.g. '750ML'.
  unit_volume?: string | null;
  // Set server-side: the parent combo's wholesaler and (for allied) the ABG SKU.
  wholesaler?: string | null;
  abg_sku?: string | null;
  qty_per_pack: string | null;
  frontline_price_each: number | null;
  combo_price_each: number | null;
  // GROUND TRUTH: product_name is the combo SHEET's item. priced_as names the
  // catalog row we priced against when it differs (transparent, never a swap).
  priced_as?: string | null;
}
// Worth-it economics computed server-side (deals.compute_combo_economics):
// combo pack price vs the individual LIST price and the realistic ONE-CASE
// price (list − 1-case discount), priced by UPC and summed. Same numbers the
// AI assistant uses. `advertised_savings` = the distributor's claimed savings
// (often inflated) so the UI can show advertised-vs-effective.
export interface ComboEconomicsComponent {
  product_name: string | null; upc: string | null; unit_volume?: string | null;
  vintage?: string | null;
  cases?: number | null; price_unit?: 'bottle' | 'case' | null;
  combo_each?: number | null; best_separate_each?: number | null;
  has_separate_deal?: boolean;
  combo_cost?: number | null; best_separate_cost?: number | null; frontline_cost?: number | null;
  // GROUND TRUTH: product_name is the COMBO SHEET's item. When we priced it
  // against a catalog row with a different name, priced_as names that row (so
  // pricing is transparent, never a silent substitution).
  sheet_name?: string | null; sheet_frontline_each?: number | null;
  priced_as?: string | null;
}
export interface ComboEconomics {
  unit?: 'bottle' | 'case' | null;
  combo_cost?: number | null;
  advertised_savings?: number | null;
  separate_best_total?: number | null;   // one-case total
  frontline_total?: number | null;        // individual/list total
  save_vs_separate?: number | null;       // effective (vs one-case)
  save_vs_frontline?: number | null;      // vs list
  pct_vs_separate?: number | null;
  verdict?: 'worth_it' | 'marginal' | 'buy_separately' | 'unknown' | 'volume_ladder';
  is_volume_ladder?: boolean;
  min_save_pct?: number | null; max_save_pct?: number | null;
  any_component_missing_price?: boolean;
  components_total?: number; components_priced?: number;
  unverified_reason?: string | null;
  // Trust signal: every combo-sheet item must be confirmable in the CPL by
  // semantic name + price. needs_verify is true (with the offending item names in
  // unverified_items) when one or more could not be confirmed.
  needs_verify?: boolean;
  unverified_items?: string[];
  components?: ComboEconomicsComponent[];
}
export interface Combo {
  combo_code: string; product_name: string;
  combo_pack_price: number; total_savings: number;
  wholesaler: string; upc?: string | null; comments?: string | null; edition?: string;
  components?: ComboComponent[]; item_count?: number;
  next_combo_pack_price?: number | null; next_total_savings?: number | null;
  availability?: 'continues' | 'ending' | 'new'; recommendation?: string;
  valid_from?: string | null; valid_through?: string | null;
  next_valid_from?: string | null; next_valid_through?: string | null;
  economics?: ComboEconomics;
  // Mix-and-match VOLUME deals (e.g. Shore Point Sun Crunch): instead of a
  // fixed bundle, you mix any member and the per-case price drops with volume.
  is_volume_ladder?: boolean;
  volume_members?: { product_name: string | null; upc: string | null }[] | null;
  volume_tiers?: {
    min_units: number; list_each: number; combo_each: number;
    save_each: number | null; save_pct: number | null;
  }[] | null;
}

export interface RipPromo {
  rip_code: string; rip_description: string; rip_amt_1: number;
  wholesaler: string; edition: string;
}

export interface RipProduct {
  /** Every RIP code this UPC qualifies under per the RIP sheet (a UPC stacked
   * across multiple rebates carries all of them). Sorted ascending so the
   * chip cluster reads stable. */
  rip_codes?: string[];
  wholesaler: string; upc: string;
  abg_sku?: string | null;
  rip_number: string | null;
  product_name: string; product_type: string;
  unit_qty: string; unit_volume: string;
  curr_edition: string | null;
  next_edition: string | null;
  source: 'discount' | 'rip';
  rip_unit: string | null;
  rip_qty: number;

  // Per-side RIP validity window (RIP-source tiers only) so the sparkline
  // popover badges this tier Active now / Expires in N days / Starts DD MMM.
  curr_window_status?: WindowStatus | null;
  curr_from_date?: string | null;
  curr_to_date?: string | null;
  curr_days_to_expire?: number | null;
  next_window_status?: WindowStatus | null;
  next_from_date?: string | null;
  next_to_date?: string | null;
  next_days_to_expire?: number | null;

  curr_case_price: number | null;
  curr_btl_price: number | null;
  curr_has_discount: boolean;
  curr_discount_pct: number;
  curr_rip_code: string | null;
  curr_rip_amt: number | null;
  curr_save_per_case: number | null;
  curr_effective_case_price: number | null;
  curr_effective_btl_price: number | null;
  curr_gp_pct: number | null;

  next_case_price: number | null;
  next_btl_price: number | null;
  next_has_discount: boolean;
  next_discount_pct: number;
  next_rip_code: string | null;
  next_rip_amt: number | null;
  next_save_per_case: number | null;
  next_effective_case_price: number | null;
  next_effective_btl_price: number | null;
  next_gp_pct: number | null;

  rip_save_per_case: number;
  has_discount: boolean;
  discount_pct: number;
  // 3-month sparkline history (1-case-discount + best-RIP).
  price_3mo?: Price3moBlock[] | null;
  // True when this UPC was found in the RIP sheet but has no matching CPL
  // row, so list/effective prices are unknown. The UI shows a "Check with
  // sales rep" sticker; add-to-cart still works using UPC + name.
  needs_rep_verify?: boolean;
  brand?: string | null;
  image_url?: string | null;
}

export interface BuySignal extends Product {
  signal: string; reason: string; case_delta_pct: number; direction: string;
}

export interface BuySheet {
  market_summary: { direction: string; total_items: number; price_drops: number; price_increases: number; total_savings_pool: number };
  sections: Record<string, BuySignal[]>;
  section_counts: Record<string, number>;
}

export interface MissedOpps {
  total_opportunities: number; total_savings_missed: number;
  clearance_count: number; items: Product[];
}

export interface WatchlistItem {
  id: number; product_name: string; wholesaler: string;
  upc?: string; abg_sku?: string | null; unit_volume?: string; target_price?: number; notes?: string;
  image_url?: string | null;
}

export interface Order {
  id: number; name: string; status: string; notes?: string;
  division?: string; created_at: string; updated_at?: string;
  distributor?: string | null; sales_rep_id?: number | null;
  revision?: number;
  // Date the buyer plans to place this order against (ISO YYYY-MM-DD). When
  // set, lines re-price against it: a RIP active on that date drives the
  // line's best rebate, not just today's. Null = price as today.
  needed_by_date?: string | null;
  total?: number;
}

export interface PlanOrder extends Order {
  lines: (OrderLine & { line_invoice?: number })[];
}

export interface UserNote {
  id: number; product_name: string | null; wholesaler: string | null; note: string;
  title?: string | null; color?: string | null;
  deleted?: number; created_at: string; updated_at?: string;
}

export interface OrderRipTier extends TierWindow {
  tier: string;
  tier_cases: number;
  save_amount: string;
  case_price?: string | null;
  btl_price?: string | null;
}

export interface OrderLine {
  id: number; order_id: number; product_name: string; wholesaler: string;
  upc?: string; abg_sku?: string | null; unit_volume?: string;
  qty_cases: number; qty_units: number;
  selected_discount_tier?: number;
  combo_code?: string | null;
  retail_price?: number | null;
  // Extended fields from enriched API
  description?: string | null;
  size?: string | null;
  pack?: number | null;
  category?: string | null;
  brand?: string | null;
  divisions?: string | null;
  case_cost?: number | null;
  btl_cost?: number | null;
  has_rip?: boolean;
  rip_tiers?: OrderRipTier[];
  best_rip_save?: string | null;
  line_invoice?: string | null;
  line_rip_rebate?: string | null;
  line_effective?: string | null;
  is_closeout?: boolean;
  notes?: string | null;
}

export interface OrderScorecard {
  order_id: number; score: number; grade: string;
  metrics: { discount_capture: number; category_diversity: number; clearance_urgency: number; price_timing: number };
  recommendations: string[];
}

export interface AlertItem { label: string; wholesaler?: string; detail?: string }
export interface AlertPayload { intent?: 'opportunity' | 'risk'; count?: number; items?: AlertItem[] }
export interface Alert {
  id: number; alert_type: string; product_name: string | null; wholesaler: string | null;
  edition: string; message: string; priority: number; read: boolean | number;
  payload?: AlertPayload;
}

export interface SalesRep {
  id: number; name: string; division?: string; email?: string; phone?: string;
  distributor?: string;
}

// ---- Celr AI Agents (admin-only) ----

export interface AgentRun {
  id: number; ym: string; trigger_source: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
  mode: 'auto' | 'manual';
  stage: 'scout' | 'sourcing' | 'gate' | 'proposed' | 'staged' | null;
  batch_id: string | null; candidates: number; lines_kept: number;
  lines_vetoed: number; est_total_usd: number; est_savings_usd: number;
  input_tokens: number; output_tokens: number; cost_usd: number;
  duration_ms: number; summary: string | null; error: string | null;
  current_action: string | null;
  created_at: string; finished_at: string | null;
}

export interface AgentRunDetailRow extends AgentRun {
  scout_json?: string | null; plan_json?: string | null; gated_json?: string | null;
  proposal_json?: string | null;
}

export interface AgentProposalLine {
  upc: string; product_name: string; chosen_wholesaler: string; cases: number;
  effective_case_price: number; alt_wholesaler: string | null;
  alt_effective_price: number | null; savings_vs_alt: number | null;
  rip_code: string | null; sourcing_note: string; gp_pct?: number | null;
  bottles_per_case?: number | null;
  reason_code?: string | null; scout_rationale?: string | null;
  rip?: { rip_code: string; description?: string; earned_rebate?: number | null;
          earned_per_case?: number | null; note?: string;
          next_tier?: { buy_qty: number; unit: string; rebate: number;
                        more_needed?: number | null } | null } | null;
  timing?: { verdict: 'buy_now' | 'wait' | 'neutral' | 'no_forecast';
             explain: string; price_now: number;
             price_next_month: number | null; price_last_month: number | null } | null;
  pos?: { units_per_day?: number; on_hand_units?: number | null;
          days_of_cover?: number | null; unit_retail?: number | null } | null;
  all_sources?: { wholesaler: string; effective_case_price: number }[];
  explain_steps?: { title: string; text: string }[];
  staged?: boolean;
}

export interface AgentStep {
  seq: number; agent: string; kind: 'llm_turn' | 'tool_call' | 'phase';
  name: string; status: 'ok' | 'error'; model: string | null;
  input_tokens: number; output_tokens: number; cache_read_tokens: number;
  cache_write_tokens: number; cost_usd: number; duration_ms: number;
  detail: Record<string, unknown> | null; created_at: string;
}

export interface AgentConfig {
  scout_model: string; sourcing_model: string; max_turns: number;
  max_candidates: number; max_cases_per_line: number; min_gp: number;
  max_run_tokens: number;
  pricing_per_mtok: Record<string, { input: number; output: number }>;
  env_overrides: string[];
}

export interface PosRow {
  upc: string; product_name: string; category: string;
  units_per_day?: number; days_of_cover?: number | null;
  unit_retail?: number; on_hand_units?: number | null;
  last_sale?: string; lifetime_units?: number; still_available?: boolean;
  wholesaler?: string | null; effective_case_price?: number;
  bottles_per_case?: number; has_rip?: boolean; has_discount?: boolean;
}

export interface PosSummary {
  store: { id: number; name: string; city?: string; state?: string } | null;
  months: { ym: string; revenue: number; units: number }[];
  totals: { skus?: number; first_sale?: string; last_sale?: string; units?: number; revenue?: number };
  last_feed: { source: string; kind: string; period_end: string; rows_ingested: number; created_at: string } | null;
}

export const agents = {
  startRun: () => request<{ status: string }>('/api/agents/procurement/run', { method: 'POST' }),
  startStep: () => request<{ status: string }>('/api/agents/procurement/step', { method: 'POST' }),
  advanceStep: (runId: number) => request<{ status: string }>(`/api/agents/procurement/runs/${runId}/step`, { method: 'POST' }),
  abandonRun: (runId: number) => request<{ status: string }>(`/api/agents/procurement/runs/${runId}/abandon`, { method: 'POST' }),
  addToCart: (runId: number, upcs?: string[]) =>
    request<{ status: string; batch_id: string; lines: number; remaining: number }>(
      `/api/agents/procurement/runs/${runId}/add-to-cart`,
      { method: 'POST', body: JSON.stringify(upcs?.length ? { upcs } : {}) }),
  runs: (limit = 25) => request<{ runs: AgentRun[] }>(`/api/agents/procurement/runs${qs({ limit })}`),
  runDetail: (id: number) => request<{ run: AgentRunDetailRow; steps: AgentStep[] }>(`/api/agents/procurement/runs/${id}`),
  config: () => request<AgentConfig>('/api/agents/procurement/config'),
  posSummary: () => request<PosSummary>('/api/agents/pos/summary'),
  posVelocity: (limit = 50) => request<{ rows: PosRow[] }>(`/api/agents/pos/velocity${qs({ limit })}`),
  posLowStock: (days = 14, limit = 50) => request<{ rows: PosRow[] }>(`/api/agents/pos/low-stock${qs({ days_threshold: days, limit })}`),
  posLapsed: (days = 60, limit = 50) => request<{ rows: PosRow[] }>(`/api/agents/pos/lapsed${qs({ lapsed_days: days, limit })}`),
};
