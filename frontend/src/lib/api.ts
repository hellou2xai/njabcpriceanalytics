const BASE = import.meta.env.VITE_API_URL ?? '';

export const TOKEN_KEY = 'lpb_auth_token';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
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
export const catalog = {
  search: (params: Record<string, unknown>) =>
    request<{ total: number; items: Product[]; corrected_query?: string | null }>(`/api/catalog/search${qs(params)}`),
  newItems: (params?: Record<string, unknown>) =>
    request<NewItemsResponse>(`/api/catalog/new-items${qs(params ?? {})}`),
  product: (wholesaler: string, name: string, opts?: { edition?: string; upc?: string; unit_volume?: string; unit_qty?: string; vintage?: string }) =>
    request<{ product: Product; discount_tiers: DiscountTier[]; rip_tiers: RipTier[]; enrichment: ProductEnrichment | null; ai_blurb: string | null }>(
      `/api/catalog/product/${encodeURIComponent(wholesaler)}/${encodeURIComponent(name)}${qs(opts ?? {})}`
    ),
  editions: () => request<Edition[]>('/api/catalog/editions'),
  categories: (params?: Record<string, unknown>) =>
    request<Category[]>(`/api/catalog/categories${qs(params ?? {})}`),
  facets: (params?: Record<string, unknown>) =>
    request<CatalogFacets>(`/api/catalog/facets${qs(params ?? {})}`),
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
  ripSiblings: (wholesaler: string, ripCode: string, opts?: { edition?: string; exclude_upc?: string }) =>
    request<{ edition: string | null; rip_code: string; items: Product[] }>(
      `/api/catalog/rip-siblings/${encodeURIComponent(wholesaler)}/${encodeURIComponent(ripCode)}${qs(opts ?? {})}`
    ),
};

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
}

export const feedback = {
  submit: (data: { message: string; kind?: string; page?: string; user_agent?: string }) =>
    request<{ status: string }>('/api/feedback', { method: 'POST', body: JSON.stringify(data) }),
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
  generateBlurbs: (limit = 50) =>
    request<BlurbGenerateResult>(`/api/admin/blurbs/generate?limit=${limit}`, { method: 'POST' }),
};

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
  upc?: string | null; unit_volume?: string | null; combo_code?: string | null;
  notes?: string | null; image_url?: string | null;
  // Latest CPL rip_code for this UPC, attached server-side so the Lists UI
  // can sub-group lines by RIP rebate the same way the cart does.
  rip_code?: string | null;
}
export interface ListDetail { id: number; name: string; created_at: string; updated_at: string; items: ListItem[]; }

export interface CartItem {
  id: number; product_name: string; wholesaler: string;
  upc?: string | null; unit_volume?: string | null; combo_code?: string | null;
  qty_cases: number; qty_units: number;
  sales_rep_id?: number | null; sales_rep_name?: string | null;
  saved_for_later: number; image_url?: string | null; notes?: string | null;
  // Catalogue pricing + deal tiers (so the cart shows the same deal info).
  frontline_case_price?: number | null; frontline_unit_price?: number | null;
  effective_case_price?: number | null; effective_unit_price?: number | null;
  unit_qty?: number | string | null;
  has_discount?: boolean; has_rip?: boolean;
  discount_pct?: number | null; total_savings_per_case?: number | null;
  tiers?: CatalogTier[];
  // True only while the whole bundle is still in the cart (combo pricing applies).
  combo_intact?: boolean;
  // RIP rebate code this line currently rolls up under (enriched from the
  // catalogue at GET time; null when the product has no RIP).
  rip_code?: string | null;
}

export const lists = {
  list: () => request<ProductList[]>('/api/lists'),
  create: (name: string) => request<ProductList>('/api/lists', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id: number, name: string) => request(`/api/lists/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  remove: (id: number) => request(`/api/lists/${id}`, { method: 'DELETE' }),
  get: (id: number) => request<ListDetail>(`/api/lists/${id}`),
  addItem: (id: number, item: Partial<ListItem>) =>
    request(`/api/lists/${id}/items`, { method: 'POST', body: JSON.stringify(item) }),
  removeItem: (id: number, itemId: number) =>
    request(`/api/lists/${id}/items/${itemId}`, { method: 'DELETE' }),
  removeItems: (id: number, itemIds: number[]) =>
    request(`/api/lists/${id}/items/delete`, { method: 'POST', body: JSON.stringify({ item_ids: itemIds }) }),
};

export const cart = {
  get: () => request<{ items: CartItem[]; group_notes: Record<string, string> }>('/api/cart'),
  groupNote: (wholesaler: string, note: string) =>
    request('/api/cart/group-note', { method: 'POST', body: JSON.stringify({ wholesaler, note }) }),
  add: (item: Partial<CartItem>) => request('/api/cart', { method: 'POST', body: JSON.stringify(item) }),
  update: (id: number, data: { qty_cases?: number; qty_units?: number; sales_rep_id?: number | null; saved_for_later?: boolean; notes?: string }) =>
    request(`/api/cart/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => request(`/api/cart/${id}`, { method: 'DELETE' }),
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
  product_name: string;
  product_type: string;
  unit_qty: string;
  unit_volume: string;
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
  next_case_price?: number | null;
  next_effective_case_price?: number | null;
  better_month?: 'Same' | 'This Month' | 'Next Month' | null;
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

export interface CatalogTier {
  source: 'discount' | 'rip';
  qty: number;
  unit: string;
  amount: number;
  save_per_case: number;
  price_after: number | null;
  btl_price_after?: number | null;
  save_per_bottle?: number | null;
  roi_pct: number;
  description?: string | null;
}

export interface DiscountTier {
  tier: number;
  quantity: string;
  amount_per_case: number;
  price_after: number;
  roi_pct: number;
}

export interface RipTier {
  qty: number;
  unit: string;
  amount: number;
  per_case_savings: number;
  per_bottle_savings?: number | null;
  price_after: number;
  btl_price_after?: number | null;
  bundle_cost: number;
  roi_pct: number;
  description: string | null;
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

export interface ComboComponent {
  product_name: string | null;
  upc: string | null;
  qty_per_pack: string | null;
  frontline_price_each: number | null;
  combo_price_each: number | null;
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
}

export interface RipPromo {
  rip_code: string; rip_description: string; rip_amt_1: number;
  wholesaler: string; edition: string;
}

export interface RipProduct {
  wholesaler: string; upc: string;
  rip_number: string | null;
  product_name: string; product_type: string;
  unit_qty: string; unit_volume: string;
  curr_edition: string | null;
  next_edition: string | null;
  source: 'discount' | 'rip';
  rip_unit: string | null;
  rip_qty: number;

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
  upc?: string; unit_volume?: string; target_price?: number; notes?: string;
  image_url?: string | null;
}

export interface Order {
  id: number; name: string; status: string; notes?: string;
  division?: string; created_at: string; updated_at?: string;
  distributor?: string | null; sales_rep_id?: number | null;
  revision?: number;
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

export interface OrderRipTier {
  tier: string;
  tier_cases: number;
  save_amount: string;
  case_price?: string | null;
  btl_price?: string | null;
}

export interface OrderLine {
  id: number; order_id: number; product_name: string; wholesaler: string;
  upc?: string; unit_volume?: string;
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
